#!/usr/bin/env node
/**
 * Mock upstream — a stand-in for the Agent API, used only by the test suite.
 * Lets us drive every path deterministically instead of waiting on a provider
 * that may be overloaded.
 *
 * Switch behaviour with:  POST /__mode  {"mode":"normal"}
 *   normal            -> thinking, then one final answer, then idle
 *   overload_then_ok  -> two retry notices, then the answer
 *   stall             -> heartbeat only, forever (never answers)
 *   reject_token      -> every request 401
 *   busy              -> the send endpoint returns 409
 *   empty_account     -> no agents / environments yet; creating still works
 *   create_fail       -> creating an agent or environment returns the real
 *                        validation-error envelope
 *   env_in_use        -> one environment is pinned by a live session, so the
 *                        real API refuses to delete it (409, "archive instead")
 *
 * Clear anything the tests created:  POST /__reset
 *
 * The resource lists are stateful on purpose: creating an agent must show up in
 * the next GET, or the page's create → refresh cycle cannot be tested.
 */

'use strict';

const http = require('http');

const PORT = Number(process.env.MOCK_PORT || 9911);
let MODE = 'normal';

/** sessionId -> Set<res>  (live SSE subscribers) */
const streams = new Map();
let sessionSeq = 0;
let newSeq = 0;

/** Everything the tests uploaded through the service, for assertions. */
const uploads = [];

/** The last user message we accepted — lets tests assert on content blocks. */
let lastMessage = null;

// Files the fake agent "produced". Scoped to the newest session, which is how
// the service decides what belongs to the turn that just finished.
const FILE_ID = 'file_mock_1';
const FILE_BODY = 'hello from the mock upstream\n';
const filesNow = () => [{
  id: FILE_ID,
  type: 'file',
  filename: 'mock-artifact.txt',
  size_bytes: Buffer.byteLength(FILE_BODY),
  mime_type: 'text/plain',
  created_at: '2026-09-21T12:00:00Z',
  downloadable: true,
  scope: { id: `sess_mock_${sessionSeq}`, type: 'session' },
  metadata: { original_filename: 'mock-artifact.txt', source: 'DeliverArtifacts' },
}];

// --- resource store --------------------------------------------------------

const SEED_AGENTS = [
  {
    id: 'agent_mock_1', name: 'Mock Agent 一号', description: '测试用一号',
    model: { id: 'qfmodel', context_window: 200000, effort: 'medium' },
    system: '你是测试用的一号助手。',
    tools: [{ type: 'agent_toolset_20260401', enabled_tools: ['Bash', 'Read'] }],
    mcp_servers: [],
  },
  {
    id: 'agent_mock_2', name: 'Mock Agent 二号', description: '测试用二号',
    model: { id: 'q37fmodel', context_window: 200000 },
    system: '', tools: [], mcp_servers: [],
  },
];

const SEED_ENVS = [
  {
    id: 'env_mock_1', name: 'mock-env-1', description: '',
    config: { type: 'cloud', networking: { type: 'unrestricted', allowed_hosts: [] } },
  },
  {
    id: 'env_mock_2', name: 'mock-env-2', description: '',
    config: { type: 'cloud', networking: { type: 'limited', allowed_hosts: [] } },
  },
];

/** Mirror of the real catalogue, including its awkward shapes: `auto` really
 *  does come back with no effort levels and no context-window list. */
const MODELS = [
  {
    id: 'auto', display_name: 'Auto', is_enabled: true, is_new: false, is_vl: true,
    price_factor: 0.5, max_input_tokens: 180000,
  },
  {
    id: 'qfmodel', display_name: 'Qwen3.8-Flash', is_enabled: true, is_new: true, is_vl: true,
    price_factor: 0, max_input_tokens: 180000, efforts: ['low', 'medium', 'xhigh'],
    default_effort: 'medium', default_context_window: 200000,
    available_context_windows: [200000, 400000, 1000000],
  },
  {
    id: 'q37fmodel', display_name: 'Qwen3.7-Flash', is_enabled: true, is_new: true, is_vl: true,
    price_factor: 0.1, max_input_tokens: 180000, default_context_window: 200000,
    available_context_windows: [200000, 400000, 1000000],
  },
];

let createdAgents = [];
let createdEnvs = [];
/** Deleting or archiving a seed resource must stick, or a re-list resurrects it. */
const removed = new Set();
const archived = new Set();

const visible = (arr) => arr.filter((r) => !removed.has(r.id) && !archived.has(r.id));
const agentsNow = () => visible((MODE === 'empty_account' ? [] : SEED_AGENTS).concat(createdAgents));
const envsNow = () => visible((MODE === 'empty_account' ? [] : SEED_ENVS).concat(createdEnvs));

/** In env_in_use mode this environment is pinned by a live session, so the real
 *  API refuses to delete it and points at archiving instead. */
const IN_USE_ENV = 'env_mock_1';
const sessionsUsing = (id) => (MODE === 'env_in_use' && id === IN_USE_ENV ? 1 : 0);

function frame(res, event, data) {
  res.write(`id: evt_${Math.random().toString(36).slice(2)}\n`);
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function unauth(res) {
  sendJson(res, 401, { code: 'TOKEN_INVALID', message: 'missing authorization token' });
}

/** The real API's validation envelope, verbatim. */
function invalid(res, message) {
  sendJson(res, 400, { error: { message, type: 'invalid_request_error' }, type: 'error' });
}

function broadcast(sessionId, event, data, delayMs) {
  const send = () => {
    const set = streams.get(sessionId);
    if (!set) return;
    for (const res of set) {
      try { frame(res, event, data); } catch {}
    }
  };
  if (delayMs) setTimeout(send, delayMs); else send();
}

/** The scripted turn, mirroring the real event order we observed upstream. */
function scriptTurn(sessionId, text) {
  broadcast(sessionId, 'session.status_running', { id: 'e1', type: 'session.status_running' });
  broadcast(sessionId, 'session.thread_status_running', {
    agent_name: 'Mock Agent', session_thread_id: 'sthr_mock', type: 'session.thread_status_running',
  });
  broadcast(sessionId, 'user.message', {
    content: [{ text, type: 'text' }], id: 'e2', type: 'user.message',
  });
  broadcast(sessionId, 'span.model_request_start', { id: 'e3', type: 'span.model_request_start' });

  if (MODE === 'stall') return; // heartbeats only from here on

  const answer = { content: [{ text: '我是 Mock Agent，一个用于测试的假上游。', type: 'text' }] };

  if (MODE === 'overload_then_ok') {
    const err = {
      error: { message: 'model provider queued the request', qoder_error_code: '10605', retry_status: { type: 'retrying' }, type: 'model_overloaded_error' },
      type: 'session.error',
    };
    broadcast(sessionId, 'session.error', err, 60);
    broadcast(sessionId, 'session.status_rescheduled', { type: 'session.status_rescheduled' }, 70);
    broadcast(sessionId, 'session.error', err, 120);
    broadcast(sessionId, 'session.status_rescheduled', { type: 'session.status_rescheduled' }, 130);
    broadcast(sessionId, 'agent.message', answer, 200);
  } else {
    broadcast(sessionId, 'agent.thinking', { type: 'agent.thinking' }, 30);
    broadcast(sessionId, 'agent.message', answer, 80);
  }

  broadcast(sessionId, 'span.model_request_end', {
    is_error: false, model_usage: { credits: 0.02 }, type: 'span.model_request_end',
  }, 220);
  broadcast(sessionId, 'session.thread_status_idle', {
    stop_reason: { type: 'end_turn' }, type: 'session.thread_status_idle',
  }, 230);
  broadcast(sessionId, 'session.status_idle', {
    stop_reason: { type: 'end_turn' }, type: 'session.status_idle',
  }, 240);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  if (url.pathname === '/__mode' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, mode: MODE });
    return;
  }

  if (url.pathname === '/__mode' && req.method === 'POST') {
    try { MODE = (JSON.parse(await readBody(req)) || {}).mode || MODE; } catch {}
    sendJson(res, 200, { ok: true, mode: MODE });
    return;
  }

  if (url.pathname === '/__reset' && req.method === 'POST') {
    createdAgents = [];
    createdEnvs = [];
    removed.clear();
    archived.clear();
    uploads.length = 0;
    sendJson(res, 200, { ok: true });
    return;
  }

  // Let the tests see what was actually uploaded (name + bytes).
  if (url.pathname === '/__uploads' && req.method === 'GET') {
    sendJson(res, 200, { uploads: uploads.map((u) => ({ filename: u.filename, body: u.body })) });
    return;
  }

  if (url.pathname === '/__last_message' && req.method === 'GET') {
    sendJson(res, 200, { message: lastMessage });
    return;
  }

  if (MODE === 'reject_token') return unauth(res);

  // --- catalogue -----------------------------------------------------------
  if (url.pathname === '/api/v1/cloud/models' && req.method === 'GET') {
    sendJson(res, 200, { data: MODELS, first_id: MODELS[0].id, has_more: false, next_page: null });
    return;
  }

  // --- agents --------------------------------------------------------------
  if (url.pathname === '/api/v1/cloud/agents' && req.method === 'GET') {
    const data = agentsNow();
    sendJson(res, 200, {
      data, first_id: data[0] ? data[0].id : null, has_more: false, next_page: null,
    });
    return;
  }

  if (url.pathname === '/api/v1/cloud/agents' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    if (!body.name) return invalid(res, "Field 'name' is required.");
    if (MODE === 'create_fail') {
      return invalid(res, "Field 'model.id' must be one of: auto, qfmodel, q37fmodel.");
    }
    const agent = {
      id: `agent_new_${++newSeq}`,
      archived_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      version: 1,
      type: 'agent',
      metadata: {},
      multiagent: null,
      skills: [],
      name: body.name,
      description: body.description || '',
      model: body.model || { id: 'auto' },
      system: body.system || '',
      tools: body.tools || [],
      mcp_servers: body.mcp_servers || [],
    };
    createdAgents.push(agent);
    sendJson(res, 200, agent);
    return;
  }

  const agentMatch = /^\/api\/v1\/cloud\/agents\/([^/]+)$/.exec(url.pathname);
  if (agentMatch && req.method === 'DELETE') {
    const id = agentMatch[1];
    const known = SEED_AGENTS.concat(createdAgents).some((a) => a.id === id);
    if (!known) {
      sendJson(res, 404, { error: { message: 'agent not found', type: 'not_found_error' }, type: 'error' });
      return;
    }
    createdAgents = createdAgents.filter((a) => a.id !== id);
    removed.add(id);
    sendJson(res, 200, { id, deleted: true });
    return;
  }

  // --- environments --------------------------------------------------------
  if (url.pathname === '/api/v1/cloud/environments' && req.method === 'GET') {
    const data = envsNow();
    sendJson(res, 200, {
      data, first_id: data[0] ? data[0].id : null, has_more: false, next_page: null,
    });
    return;
  }

  if (url.pathname === '/api/v1/cloud/environments' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    if (!body.name) return invalid(res, "Field 'name' is required.");
    const net = (body.config && body.config.networking) || {};
    if (MODE === 'create_fail') {
      return invalid(res, "Field 'config.networking.type' must be one of: limited, unrestricted, allowed_hosts.");
    }
    if (!['unrestricted', 'limited', 'allowed_hosts'].includes(net.type)) {
      return invalid(res, "Field 'config.networking.type' must be one of: limited, unrestricted, allowed_hosts.");
    }
    if (net.type === 'allowed_hosts' && !(net.allowed_hosts || []).length) {
      return invalid(res, "Field 'config.networking.allowed_hosts' must not be empty.");
    }
    const env = {
      id: `env_new_${++newSeq}`,
      archived_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      type: 'environment',
      metadata: {},
      name: body.name,
      description: body.description || '',
      config: {
        type: 'cloud',
        networking: Object.assign({ allow_mcp_servers: false, allow_package_managers: false, allowed_hosts: [] }, net),
        packages: { type: 'packages', apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] },
      },
    };
    createdEnvs.push(env);
    sendJson(res, 200, env);
    return;
  }

  const envArchiveMatch = /^\/api\/v1\/cloud\/environments\/([^/]+)\/archive$/.exec(url.pathname);
  if (envArchiveMatch && req.method === 'POST') {
    archived.add(envArchiveMatch[1]);
    sendJson(res, 200, { id: envArchiveMatch[1], archived: true });
    return;
  }

  const envMatch = /^\/api\/v1\/cloud\/environments\/([^/]+)$/.exec(url.pathname);
  if (envMatch && req.method === 'DELETE') {
    const id = envMatch[1];
    const pinned = sessionsUsing(id);
    if (pinned) {
      sendJson(res, 409, {
        error: {
          message: `Environment '${id}' is in use and cannot be deleted: ${pinned} session still reference it. Archive the environment instead.`,
          type: 'invalid_request_error',
        },
        type: 'error',
      });
      return;
    }
    createdEnvs = createdEnvs.filter((e) => e.id !== id);
    removed.add(id);
    sendJson(res, 200, { id, deleted: true });
    return;
  }

  // --- sessions ------------------------------------------------------------
  if (url.pathname === '/api/v1/cloud/sessions' && req.method === 'GET') {
    const data = sessionsUsing(IN_USE_ENV)
      ? [{
        id: 'sess_mock_pinned', type: 'session', status: 'idle',
        agent: { id: 'agent_mock_1', name: 'Mock Agent 一号' },
        environment_id: IN_USE_ENV,
      }]
      : [];
    sendJson(res, 200, { data, first_id: data[0] ? data[0].id : null, has_more: false, next_page: null });
    return;
  }

  if (url.pathname === '/api/v1/cloud/sessions' && req.method === 'POST') {
    await readBody(req);
    const id = `sess_mock_${++sessionSeq}`;
    sendJson(res, 200, { id, type: 'session', status: 'idle' });
    return;
  }

  // --- files: upload (browser -> service -> here) -------------------------
  if (url.pathname === '/api/v1/cloud/files' && req.method === 'POST') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const ct = String(req.headers['content-type'] || '');
    if (!/^multipart\/form-data/i.test(ct)) {
      sendJson(res, 400, {
        error: { message: 'Invalid multipart form or request too large.', type: 'invalid_request_error' },
        type: 'error',
      });
      return;
    }
    const named = /filename="([^"]*)"/.exec(raw.toString('latin1'));
    const name = named ? named[1] : 'upload.bin';
    // Enough parsing to assert on: everything between the headers and the closing boundary.
    const split = raw.indexOf('\r\n\r\n');
    const body = split >= 0
      ? raw.slice(split + 4).toString('utf8').replace(/\r\n--[^\r\n]*--\r\n\s*$/, '')
      : '';
    uploads.push({ filename: name, body });
    const id = `file_upload_${uploads.length}`;
    sendJson(res, 200, {
      id,
      type: 'file',
      filename: name,
      size_bytes: Buffer.byteLength(body),
      mime_type: /\.png$/i.test(name) ? 'image/png' : 'text/plain',
      created_at: '2026-09-21T12:00:00Z',
      downloadable: false,
      scope: null,
      metadata: {},
    });
    return;
  }

  // --- files the agent produced -------------------------------------------
  if (url.pathname === '/api/v1/cloud/files' && req.method === 'GET') {
    const data = filesNow();
    sendJson(res, 200, {
      data, first_id: data[0].id, last_id: data[0].id, has_more: false, next_page: null,
    });
    return;
  }

  // Stands in for the signed storage URL — no CORS headers, like the real host,
  // so the service genuinely has to relay it.
  if (/^\/__file\/[^/]+$/.test(url.pathname) && req.method === 'GET') {
    const id = url.pathname.slice('/__file/'.length);
    if (id !== FILE_ID) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(FILE_BODY),
    });
    res.end(FILE_BODY);
    return;
  }

  const fileMatch = /^\/api\/v1\/cloud\/files\/([^/]+)\/content$/.exec(url.pathname);
  if (fileMatch && req.method === 'GET') {
    const id = fileMatch[1];
    if (id !== FILE_ID) {
      sendJson(res, 404, { error: { message: 'file not found', type: 'not_found_error' }, type: 'error' });
      return;
    }
    sendJson(res, 200, {
      url: `http://127.0.0.1:${PORT}/__file/${encodeURIComponent(id)}`,
      expires_at: '2026-09-21T13:00:00Z',
    });
    return;
  }

  const streamMatch = /^\/api\/v1\/cloud\/sessions\/([^/]+)\/events\/stream$/.exec(url.pathname);
  if (streamMatch && req.method === 'GET') {
    const sid = streamMatch[1];
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders?.();
    res.write(': heartbeat\n\n');

    if (!streams.has(sid)) streams.set(sid, new Set());
    streams.get(sid).add(res);

    // IMPORTANT: clean up on res 'close', never req 'close' — an IncomingMessage
    // fires close as soon as its (empty) body completes, i.e. immediately.
    res.on('close', () => {
      const set = streams.get(sid);
      if (set) { set.delete(res); if (!set.size) streams.delete(sid); }
    });
    return;
  }

  const eventsMatch = /^\/api\/v1\/cloud\/sessions\/([^/]+)\/events$/.exec(url.pathname);
  if (eventsMatch && req.method === 'POST') {
    const sid = eventsMatch[1];
    const body = JSON.parse((await readBody(req)) || '{}');
    lastMessage = body;
    if (MODE === 'busy') {
      sendJson(res, 409, { code: 'CONFLICT', message: 'session busy' });
      return;
    }
    const text = (((body.events || [])[0] || {}).content || [{}])[0].text || '';
    sendJson(res, 200, { data: [{ type: 'user.message', content: [{ text, type: 'text' }] }] });
    // Answer only after the subscriber is registered.
    setTimeout(() => scriptTurn(sid, text), 40);
    return;
  }

  sendJson(res, 404, { message: 'mock: not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-upstream] listening on http://127.0.0.1:${PORT}  mode=${MODE}`);
});
