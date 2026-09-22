#!/usr/bin/env node
/**
 * Qoder Chat — local backend service.
 *
 * The token never lives in the page. The user types their PAT into the page, it
 * travels to this process over loopback, and stays here. The page only ever gets
 * back a masked hint — no upstream URL, no session id, no token.
 *
 * Implements the documented Cloud Agents flow end to end:
 *
 *   1. create an Agent        POST /api/v1/cloud/agents
 *   2. create an Environment  POST /api/v1/cloud/environments
 *   3. open a Session         POST /api/v1/cloud/sessions
 *   4. send a message         POST /api/v1/cloud/sessions/{id}/events
 *   5. stream the reply       GET  /api/v1/cloud/sessions/{id}/events/stream
 *
 * Zero dependencies — Node stdlib only.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream');
const { Readable } = require('stream');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';

// A token is bound to a region; the same token returns 401 on the other one.
const REGIONS = {
  cn: { label: '中国站', apiBase: 'https://api.qoder.com.cn', console: 'https://qoder.cn' },
  global: { label: '国际站', apiBase: 'https://api.qoder.com', console: 'https://qoder.com' },
};

// Test/advanced hook: an explicit base URL overrides the region choice entirely.
// Deliberately NOT named QODER_API_BASE_URL — that name comes from the upstream
// docs, and honouring it here would silently defeat the region selector.
const API_BASE_OVERRIDE = (process.env.QODER_API_BASE_OVERRIDE || '').replace(/\/+$/, '');

const IDLE_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS || 120000);

// Looking up the files a turn produced is best-effort — it happens after the
// answer is already complete, and must never hold the turn open.
const FILE_LIST_TIMEOUT_MS = Number(process.env.FILE_LIST_TIMEOUT_MS || 8000);

// Whatever the agent produces is written here automatically, next to the code.
// Overridable so the test suite can write to a temp dir instead of your project.
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR
  ? path.resolve(process.env.DOWNLOAD_DIR)
  : path.join(__dirname, 'downloads');
const SAVED_INDEX = path.join(DOWNLOAD_DIR, '.saved.json');

// Upstream accepts only "text" and "image" content blocks, and says so itself:
//   "Only PNG/JPEG/WEBP/GIF are allowed in image blocks."
// Anything else has no reference mechanism at all — the only way to give the
// agent a text file is to inline its contents as a text block.
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;

const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 20 * 1024 * 1024);
const MAX_TEXT_ATTACHMENT_CHARS = Number(process.env.MAX_TEXT_ATTACHMENT_CHARS || 200000);
const MAX_ATTACHMENTS = 5;
const SAVE_TIMEOUT_MS = Number(process.env.SAVE_TIMEOUT_MS || 30000);

const PUBLIC_DIR = path.join(__dirname, 'public');
const TOKEN_FILE = path.join(__dirname, '.token');

// Step 1's tool set, verbatim from the docs. The API exposes no endpoint that
// enumerates it — /api/v1/cloud/tools and /toolsets both 404 — so this list is
// the one place a tool name is written down.
const TOOLSET_TYPE = 'agent_toolset_20260401';
const TOOLSET_TOOLS = [
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'ImageSearch', 'ImageGen', 'DeliverArtifacts',
];

// Legal values, taken from the API's own validation error:
//   Field 'config.networking.type' must be one of: limited, unrestricted, allowed_hosts.
const NETWORKING_TYPES = ['unrestricted', 'limited', 'allowed_hosts'];

const DEFAULT_SYSTEM = '你是一个通用助手，能够研究、写代码、运行命令，并使用工具端到端地完成任务。';

const CATALOG_TTL_MS = 5 * 60 * 1000;

const log = (msg) => console.log(`[qoder-chat] ${msg}`);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  region: 'cn',
  token: '',
  tokenHint: '',
  source: '', // 'input' | 'env' | 'file'
  agents: [],
  environments: [],
  agentId: '',
  environmentId: '',
};

/** A token was accepted — the page may open. */
const hasToken = () => Boolean(state.token);
/** A token plus a chosen agent and environment — a turn can actually run. */
const isReady = () => Boolean(state.token && state.agentId && state.environmentId);

function apiBase() {
  return API_BASE_OVERRIDE || REGIONS[state.region].apiBase;
}

function mask(t) {
  return t.length > 12 ? `${t.slice(0, 6)}…${t.slice(-4)}` : '***';
}

/** One session per browser tab, so two tabs never interleave into one chat. */
const sessions = new Map();
function resetSessions() { sessions.clear(); }

// ---------------------------------------------------------------------------
// Token persistence — off by default, opt-in, owner-only, git-ignored
// ---------------------------------------------------------------------------

function readTokenFile() {
  try {
    const j = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    if (j && typeof j.pat === 'string' && j.pat) {
      return { pat: j.pat, region: REGIONS[j.region] ? j.region : 'cn' };
    }
  } catch { /* absent or unreadable is fine */ }
  return null;
}

function writeTokenFile(pat, region) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ pat, region }, null, 2), { mode: 0o600 });
  try { fs.chmodSync(TOKEN_FILE, 0o600); } catch {}
}

function clearTokenFile() {
  try { fs.unlinkSync(TOKEN_FILE); } catch {}
}

function readDotEnv(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      out[m[1]] = v;
    }
  } catch {}
  return out;
}

const dotenv = readDotEnv(path.join(__dirname, '.env'));

// ---------------------------------------------------------------------------
// Upstream calls
// ---------------------------------------------------------------------------

class UpstreamError extends Error {
  constructor(message, body, status) {
    super(message);
    this.status = status || 0;
    this.body = typeof body === 'string' ? body.slice(0, 800) : JSON.stringify(body || {}).slice(0, 800);
  }
}

/** Raised before anything reaches the network. */
class InputError extends Error {
  constructor(message) { super(message); this.input = true; }
}

/** Pull the human-readable message out of an upstream error envelope. */
function upstreamMessage(body) {
  if (!body) return '';
  try {
    const j = typeof body === 'string' ? JSON.parse(body) : body;
    if (j && j.error && j.error.message) return String(j.error.message);
    if (j && j.message) return String(j.message);
  } catch {}
  return String(body).slice(0, 300);
}

/** Turn an upstream status into something a human can act on. */
function explain(status, body) {
  if (status === 400 || status === 422) {
    return {
      code: 'bad_request',
      reason: 'invalid_request',
      message: upstreamMessage(body) || `上游认为请求不合法（HTTP ${status}）。`,
    };
  }
  if (status === 401) {
    return {
      code: 'auth',
      reason: 'unauthorized',
      message: '令牌无效，或者令牌与所选服务区域不匹配——请确认区域选对了（中国站 / 国际站），并检查令牌是否已被撤销。',
    };
  }
  if (status === 403) {
    return {
      code: 'scope',
      reason: 'forbidden',
      message: '令牌被拒绝：它可能缺少 Cloud Agents 的权限范围。请在 Qoder 控制台重新创建一个带相应权限的令牌。',
    };
  }
  if (status === 404) {
    return { code: 'not_found', reason: 'not_found', message: '上游找不到该资源（HTTP 404）——它可能已经被删掉了。' };
  }
  if (status === 409) {
    return { code: 'busy', reason: 'conflict', message: '上游说这个资源正忙（HTTP 409）。' };
  }
  if (status === 429) {
    return { code: 'rate_limit', reason: 'too_many_requests', message: '请求过于频繁，被上游限流（HTTP 429）。稍后再试。' };
  }
  return {
    code: 'upstream',
    reason: `http_${status}`,
    message: `上游返回 HTTP ${status}。${upstreamMessage(body) || ''}`.trim(),
  };
}

async function upstream(token, method, pathname, body, opts) {
  const r = await fetch(`${apiBase()}${pathname}`, {
    method,
    headers: Object.assign(
      { Authorization: `Bearer ${token}` },
      body ? { 'Content-Type': 'application/json' } : {}
    ),
    body: body ? JSON.stringify(body) : undefined,
    signal: opts && opts.signal ? opts.signal : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new UpstreamError(`upstream ${method} ${pathname} → ${r.status}`, text, r.status);
  try { return JSON.parse(text); } catch { return {}; }
}

// ---------------------------------------------------------------------------
// Resources — list, create, delete
// ---------------------------------------------------------------------------

const LIST_AGENTS = '/api/v1/cloud/agents';
const LIST_ENVIRONMENTS = '/api/v1/cloud/environments';

// Undocumented in the API guide, but live: files the agent produced are listed
// here, each one carrying the session that produced it in `scope`.
const LIST_FILES = '/api/v1/cloud/files';

const shapeAgent = (a) => ({
  id: a.id,
  name: a.name || a.id,
  description: a.description || '',
  model: (a.model && a.model.id) || '',
  effort: (a.model && a.model.effort) || '',
  contextWindow: (a.model && a.model.context_window) || 0,
  system: a.system || '',
  tools: ((a.tools || [])[0] && (a.tools[0].enabled_tools || [])) || [],
});

const shapeEnvironment = (e) => ({
  id: e.id,
  name: e.name || e.id,
  description: e.description || '',
  networking: (e.config && e.config.networking && e.config.networking.type) || '',
  allowedHosts: (e.config && e.config.networking && e.config.networking.allowed_hosts) || [],
});

async function listAgents(token) {
  const j = await upstream(token, 'GET', LIST_AGENTS);
  return (j.data || []).map(shapeAgent);
}

async function listEnvironments(token) {
  const j = await upstream(token, 'GET', LIST_ENVIRONMENTS);
  return (j.data || []).map(shapeEnvironment);
}

const shapeFile = (f) => ({
  id: f.id,
  filename: f.filename || (f.metadata && f.metadata.original_filename) || f.id,
  size: Number(f.size_bytes || 0),
  mime: f.mime_type || '',
  createdAt: f.created_at || '',
  downloadable: Boolean(f.downloadable),
  // Every file we have seen is scoped to the session that produced it, which is
  // how we tell "this turn's output" apart from older runs.
  sessionId: f.scope && f.scope.type === 'session' ? f.scope.id : '',
  source: (f.metadata && f.metadata.source) || '',
});

/**
 * Files the agent has produced, newest first.
 *
 * Upstream quietly ignores every filter we tried (session_id, scope, order …),
 * so filtering happens here instead of hoping the query string works.
 */
async function listFiles(token, opts) {
  const j = await upstream(token, 'GET', LIST_FILES, undefined, opts);
  const all = (j.data || []).map(shapeFile);
  const sessionId = opts && opts.sessionId;
  const rows = sessionId ? all.filter((f) => f.sessionId === sessionId) : all;
  return rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/**
 * A short-lived signed URL. The browser cannot fetch it directly: the storage
 * host sends no CORS headers, so this has to be relayed through the service.
 */
async function fileDownloadUrl(token, id) {
  const j = await upstream(token, 'GET', `${LIST_FILES}/${encodeURIComponent(id)}/content`);
  if (!j || typeof j.url !== 'string' || !j.url) {
    throw new UpstreamError('上游没有返回下载链接', JSON.stringify(j || {}));
  }
  return j.url;
}

/**
 * Relay a browser multipart upload straight through to upstream.
 *
 * The body is never parsed here: the request is streamed on with its original
 * boundary intact, so whatever the browser produced reaches upstream verbatim.
 */
async function uploadFile(token, req) {
  const contentType = String(req.headers['content-type'] || '');
  if (!/^multipart\/form-data/i.test(contentType)) {
    throw new InputError('上传需要 multipart/form-data。');
  }
  const declared = Number(req.headers['content-length'] || 0);
  if (declared && declared > MAX_UPLOAD_BYTES) {
    throw new InputError(`文件太大（${Math.round(declared / 1048576)} MB），上限 ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB。`);
  }
  const r = await fetch(`${apiBase()}${LIST_FILES}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
    body: Readable.toWeb(req),
    duplex: 'half',
  });
  const text = await r.text();
  if (!r.ok) throw new UpstreamError(`upload → ${r.status}`, text, r.status);
  try { return JSON.parse(text); } catch { throw new UpstreamError('upload: bad JSON', text); }
}

// --- saving what the agent produced ----------------------------------------

/**
 * Files already written to disk. Without this, every later turn in the same
 * session would re-download the same file and append another copy.
 */
function readSavedIndex() {
  try {
    const j = JSON.parse(fs.readFileSync(SAVED_INDEX, 'utf8'));
    if (Array.isArray(j)) return new Set(j);
  } catch { /* first run, or unreadable — treat as empty */ }
  return new Set();
}

function writeSavedIndex(set) {
  try {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    fs.writeFileSync(SAVED_INDEX, JSON.stringify([...set], null, 2), { mode: 0o600 });
  } catch (err) { log(`could not record saved files: ${err.message}`); }
}

/** A filename that cannot escape DOWNLOAD_DIR and will not clobber an existing file. */
function uniqueTarget(filename) {
  const raw = String(filename || 'file').replace(/[\r\n"'\\/]/g, '_').trim();
  const base = raw.slice(0, 180) || 'file';
  const direct = path.join(DOWNLOAD_DIR, base);
  if (!fs.existsSync(direct)) return direct;
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  for (let i = 2; i < 500; i += 1) {
    const p = path.join(DOWNLOAD_DIR, `${stem}-${i}${ext}`);
    if (!fs.existsSync(p)) return p;
  }
  return path.join(DOWNLOAD_DIR, `${stem}-${Date.now()}${ext}`);
}

/**
 * Write the given files into the project's downloads/ folder.
 * Returns the ones that actually landed, with their local path.
 */
async function saveFilesToDisk(files) {
  if (!files || !files.length) return [];
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const saved = readSavedIndex();
  const landed = [];
  let changed = false;

  for (const f of files) {
    if (!f || saved.has(f.id)) continue;
    if (f.downloadable === false) continue;
    try {
      const signed = await fileDownloadUrl(state.token, f.id);
      const r = await fetch(signed, { signal: AbortSignal.timeout(SAVE_TIMEOUT_MS) });
      if (!r.ok) { log(`auto-save skipped ${f.filename}: HTTP ${r.status}`); continue; }
      const target = uniqueTarget(f.filename);
      const buf = Buffer.from(await r.arrayBuffer());
      fs.writeFileSync(target, buf);
      saved.add(f.id);
      changed = true;
      // `rel` is what the page shows: "<folder>/<name>", never an absolute path
      // and never a run of "../" that would leak where the project lives.
      landed.push({
        id: f.id,
        filename: f.filename,
        path: target,
        rel: path.join(path.basename(DOWNLOAD_DIR), path.relative(DOWNLOAD_DIR, target)),
        bytes: buf.length,
      });
    } catch (err) {
      log(`auto-save failed for ${f.filename}: ${err.message}`);
    }
  }

  if (changed) writeSavedIndex(saved);
  if (landed.length) log(`saved ${landed.length} file(s) to downloads/`);
  return landed;
}

// --- attachments -----------------------------------------------------------

const isImageName = (name) => IMAGE_EXT.test(String(name || ''));

/**
 * Keep only what upstream can actually accept. A file id must look like one
 * upstream issued; text is capped so a huge file cannot blow up the message.
 */
function sanitizeAttachments(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const a of raw.slice(0, MAX_ATTACHMENTS)) {
    if (!a || typeof a !== 'object') continue;
    const name = String(a.name || '').slice(0, 200) || 'file';
    if (a.kind === 'image') {
      const fileId = String(a.fileId || '');
      if (/^file_[A-Za-z0-9_-]+$/.test(fileId)) out.push({ kind: 'image', name, fileId });
    } else if (a.kind === 'text') {
      const text = String(a.text || '').slice(0, MAX_TEXT_ATTACHMENT_CHARS);
      if (text) out.push({ kind: 'text', name, text });
    }
  }
  return out;
}

/**
 * Turn a question plus attachments into upstream content blocks.
 *
 * Upstream allows exactly two block types, so a non-image file has no way to be
 * referenced — its contents are inlined as text instead.
 */
function buildContent(question, attachments) {
  const blocks = [];
  for (const a of attachments || []) {
    if (a.kind === 'image') {
      blocks.push({ type: 'image', source: { type: 'file', file_id: a.fileId } });
    } else if (a.kind === 'text') {
      blocks.push({ type: 'text', text: `附件「${a.name}」的内容：\n\`\`\`\n${a.text}\n\`\`\`` });
    }
  }
  const q = String(question || '').trim();
  if (q) blocks.push({ type: 'text', text: q });
  else if (blocks.length) blocks.push({ type: 'text', text: '请看附件。' });
  return blocks;
}

/**
 * How many upstream sessions still point at this environment.
 *
 * Upstream refuses to delete an environment while any session references it —
 * and every conversation we have had created one. So "the delete failed" almost
 * always means "you talked to this one"; saying so beats a bare 409.
 */
async function countSessionsUsing(environmentId) {
  try {
    const j = await upstream(state.token, 'GET', '/api/v1/cloud/sessions');
    return (j.data || []).filter((s) => s.environment_id === environmentId).length;
  } catch { return -1; }
}

async function refreshResources() {
  const [agents, environments] = await Promise.all([
    listAgents(state.token), listEnvironments(state.token),
  ]);
  state.agents = agents;
  state.environments = environments;
  if (!agents.some((a) => a.id === state.agentId)) state.agentId = agents.length ? agents[0].id : '';
  if (!environments.some((e) => e.id === state.environmentId)) {
    state.environmentId = environments.length ? environments[0].id : '';
  }
  return { agents, environments };
}

/**
 * The model catalogue. Not in the documented flow, but the API serves it and it
 * is what makes the "create an agent" form usable: real ids, real effort
 * levels, real context windows — instead of asking the user to guess.
 */
let catalogCache = { key: '', at: 0, data: null };

async function getCatalog() {
  const key = `${state.region}|${state.token.slice(-10)}`;
  if (catalogCache.key === key && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    return catalogCache.data;
  }
  const j = await upstream(state.token, 'GET', '/api/v1/cloud/models');
  const models = (j.data || []).map((m) => ({
    id: m.id,
    name: m.display_name || m.id,
    factor: Number(m.price_factor || 0),
    contexts: (m.available_context_windows && m.available_context_windows.length)
      ? m.available_context_windows : (m.default_context_window ? [m.default_context_window] : []),
    efforts: m.efforts || [],
    defaultEffort: m.default_effort || '',
    isNew: Boolean(m.is_new),
    isVl: Boolean(m.is_vl),
    maxInput: Number(m.max_input_tokens || 0),
  }));
  const data = {
    models,
    toolset: { type: TOOLSET_TYPE, tools: TOOLSET_TOOLS },
    networking: NETWORKING_TYPES,
    defaultSystem: DEFAULT_SYSTEM,
  };
  catalogCache = { key, at: Date.now(), data };
  return data;
}

function agentPayload(body) {
  const name = String((body && body.name) || '').trim();
  if (!name) throw new InputError('请给 Agent 起个名字。');
  if (name.length > 120) throw new InputError('Agent 名字太长了（上限 120 字符）。');

  const modelId = String((body && body.model) || '').trim() || 'auto';
  const model = { id: modelId };
  const ctx = Number((body && body.contextWindow) || 0);
  if (ctx > 0) model.context_window = ctx;
  const effort = String((body && body.effort) || '').trim();
  if (effort) model.effort = effort;

  const wanted = Array.isArray(body && body.tools) ? body.tools : [];
  const tools = TOOLSET_TOOLS.filter((t) => wanted.includes(t));

  return {
    name,
    description: String((body && body.description) || '').trim(),
    model,
    system: String((body && body.system) || '').trim() || DEFAULT_SYSTEM,
    tools: tools.length ? [{ type: TOOLSET_TYPE, enabled_tools: tools }] : [],
    mcp_servers: [],
  };
}

function environmentPayload(body) {
  const name = String((body && body.name) || '').trim();
  if (!name) throw new InputError('请给运行环境起个名字。');
  if (name.length > 120) throw new InputError('运行环境名字太长了（上限 120 字符）。');

  const requested = String((body && body.networking) || '').trim();
  const netType = NETWORKING_TYPES.includes(requested) ? requested : 'unrestricted';
  const networking = { type: netType };
  if (netType === 'allowed_hosts') {
    const hosts = Array.isArray(body && body.allowedHosts) ? body.allowedHosts : [];
    const cleaned = hosts.map((h) => String(h).trim()).filter(Boolean);
    if (!cleaned.length) throw new InputError('网络策略选了"仅允许指定主机"，至少要填一个主机。');
    networking.allowed_hosts = cleaned;
  }
  return { name, config: { type: 'cloud', networking } };
}

// ---------------------------------------------------------------------------
// Connect / disconnect
// ---------------------------------------------------------------------------

async function connect({ pat, region, remember }) {
  const token = String(pat || '').trim();
  if (!token) throw new InputError('请填入令牌。');
  const reg = REGIONS[region] ? region : 'cn';

  const previous = { region: state.region, token: state.token };
  state.region = reg;
  state.token = token; // so the probe below hits the right base URL

  // Probe both collections with the *candidate* token before adopting it. This
  // alone tells us whether the token is valid for this region.
  let agents, environments;
  try {
    [agents, environments] = await Promise.all([listAgents(token), listEnvironments(token)]);
  } catch (err) {
    state.region = previous.region;
    state.token = previous.token;
    throw err;
  }

  // An empty account is NOT an error any more: the page can create what it
  // needs, so we let the user in and flag that setup is still pending.
  state.token = token;
  state.tokenHint = mask(token);
  state.region = reg;
  state.agents = agents;
  state.environments = environments;
  state.agentId = agents.length ? agents[0].id : '';
  state.environmentId = environments.length ? environments[0].id : '';
  state.source = 'input';
  catalogCache = { key: '', at: 0, data: null };
  resetSessions();

  if (remember) {
    writeTokenFile(token, reg);
    state.source = 'file';
  } else {
    clearTokenFile();
  }
}

function disconnect() {
  state.token = '';
  state.tokenHint = '';
  state.agents = [];
  state.environments = [];
  state.agentId = '';
  state.environmentId = '';
  state.source = '';
  catalogCache = { key: '', at: 0, data: null };
  resetSessions();
  clearTokenFile();
}

/** Load a token at boot from env or the saved file. Failure is not fatal. */
async function bootConnect() {
  const envToken = process.env.QODER_PAT || process.env.QODER_ACCESS_TOKEN
    || dotenv.QODER_PAT || dotenv.QODER_ACCESS_TOKEN;
  const saved = readTokenFile();
  const candidate = envToken
    ? { pat: envToken, region: dotenv.QODER_REGION || 'cn', source: 'env' }
    : (saved ? Object.assign({ source: 'file' }, saved) : null);
  if (!candidate) {
    log('no token found — the page will ask for one');
    return;
  }
  try {
    await connect({ pat: candidate.pat, region: candidate.region, remember: candidate.source === 'file' });
    state.source = candidate.source;
    log(`token loaded from ${candidate.source}: ${state.tokenHint} · region=${state.region} · agents=${state.agents.length} · envs=${state.environments.length}`);
  } catch (err) {
    log(`stored token did not work (${err.message}) — the page will ask for one`);
  }
}

// ---------------------------------------------------------------------------
// Sessions & the turn
// ---------------------------------------------------------------------------

async function createSession() {
  const j = await upstream(state.token, 'POST', '/api/v1/cloud/sessions', {
    agent: state.agentId,
    environment_id: state.environmentId,
  });
  if (!j.id) throw new UpstreamError('session create: no id in response', '', 0);
  return j.id;
}

async function getSession(cid) {
  const existing = sessions.get(cid);
  if (existing) return existing;
  const id = await createSession();
  const s = { id, createdAt: Date.now(), busy: false };
  sessions.set(cid, s);
  return s;
}

// --- SSE parsing -----------------------------------------------------------

function parseFrame(raw, onEvent) {
  let name = '';
  const dataLines = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue; // heartbeat — alive, not content
    if (line.startsWith('event:')) name = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (!name || !dataLines.length) return;
  let payload;
  try { payload = JSON.parse(dataLines.join('\n')); } catch { payload = {}; }
  onEvent(name, payload);
}

function sseReader(stream, onEvent) {
  const decoder = new TextDecoder();
  let buf = '';
  return (async () => {
    for await (const chunk of stream) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        parseFrame(raw, onEvent);
      }
    }
  })();
}

function textOf(payload) {
  if (!payload) return '';
  if (typeof payload.content === 'string') return payload.content;
  if (Array.isArray(payload.content)) {
    return payload.content
      .filter((c) => c && (c.type === 'text' || typeof c.text === 'string'))
      .map((c) => c.text || '')
      .join('');
  }
  if (typeof payload.text === 'string') return payload.text;
  if (typeof payload.delta === 'string') return payload.delta;
  if (payload.delta && typeof payload.delta.text === 'string') return payload.delta.text;
  return '';
}

const NOTE = {
  running: 'Agent 开始工作',
  thinking: '正在思考',
  tool: '正在调用工具',
  rescheduled: '模型繁忙，正在重试',
};

async function runTurn({ cid, question, attachments, downstream }) {
  // The upstream reports one state transition through several event names (e.g.
  // session.status_running *and* session.thread_status_running), which all map to
  // the same human-facing note. Collapse runs of identical notes so the status
  // line does not flicker; any other event ends the run and lets it repeat later.
  let lastNote;
  const send = (event, data) => {
    if (event === 'note') {
      const text = data && data.text;
      if (text === lastNote) return;
      lastNote = text;
    } else {
      lastNote = undefined;
    }
    downstream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const ac = new AbortController();
  let session = null;
  let finished = false;
  let lastTraffic = Date.now();
  let idleTimer = null;
  const startedAt = Date.now();

  const finish = (ok, extra) => {
    if (finished) return;
    finished = true;
    if (idleTimer) clearInterval(idleTimer);
    if (session) session.busy = false;
    try { ac.abort(); } catch {}
    send('done', Object.assign({ ok, ms: Date.now() - startedAt }, extra || {}));
    try { downstream.end(); } catch {}
  };

  // Armed BEFORE anything leaves this process.
  idleTimer = setInterval(() => {
    if (Date.now() - lastTraffic > IDLE_TIMEOUT_MS) {
      send('error', {
        code: 'timeout',
        reason: 'upstream_silent',
        message: `等待超过 ${Math.round(IDLE_TIMEOUT_MS / 1000)} 秒没有任何进展，已放弃这一轮。`,
      });
      finish(false);
    }
  }, 1000);

  downstream.on('close', () => {
    if (finished) return;
    finished = true;
    if (idleTimer) clearInterval(idleTimer);
    if (session) session.busy = false;
    try { ac.abort(); } catch {}
  });

  send('ready', { session: 'ok' });

  if (!isReady()) {
    send('error', {
      code: 'setup',
      reason: hasToken() ? 'not_ready' : 'not_connected',
      message: hasToken()
        ? '还差一步：请先选好（或创建）一个 Agent 和运行环境。'
        : '还没有连接：请先填入个人访问令牌。',
    });
    finish(false);
    return;
  }

  // --- 0. Resolve this client's session ---
  const sess = await (async () => {
    try {
      return await getSession(cid);
    } catch (err) {
      if (!(err instanceof UpstreamError)) throw err;
      log(`session create failed: ${err.message}`);
      send('error', err.status
        ? explain(err.status, err.body)
        : { code: 'upstream', reason: 'session_create', message: `无法创建会话：${err.message}` });
      finish(false);
      return null;
    }
  })();
  if (!sess) return;
  session = sess;

  if (sess.busy) {
    send('error', { code: 'busy', reason: 'turn_in_progress', message: '这一路会话还在回答上一条消息，请等它结束。' });
    finish(false);
    return;
  }
  sess.busy = true;

  // --- 1. Subscribe BEFORE sending, or the whole turn can be missed ---
  let streamRes;
  try {
    streamRes = await fetch(`${apiBase()}/api/v1/cloud/sessions/${sess.id}/events/stream`, {
      headers: { Authorization: `Bearer ${state.token}`, Accept: 'text/event-stream' },
      signal: ac.signal,
    });
  } catch (err) {
    send('error', { code: 'network', reason: 'stream_unreachable', message: `连不上上游服务：${err.message}` });
    finish(false);
    return;
  }
  if (!streamRes.ok || !streamRes.body) {
    const body = await streamRes.text().catch(() => '');
    log(`stream rejected ${streamRes.status}: ${body.slice(0, 300)}`);
    send('error', Object.assign(explain(streamRes.status, body), { reason: `stream_${streamRes.status}` }));
    finish(false);
    return;
  }

  let streamed = '';
  let sawDelta = false;
  let errorSent = false;
  let credits = 0;
  // Upstream signals idle twice (session.* and session.thread_*); only the
  // first one should trigger the end-of-turn work.
  let idleHandled = false;

  const handleEvent = (name, payload) => {
    lastTraffic = Date.now();

    // --- answer text ---
    if (/_delta$/.test(name)) {
      const t = textOf(payload);
      if (t) { sawDelta = true; streamed += t; send('delta', { text: t }); }
      return;
    }
    if (name === 'agent.message') {
      const t = textOf(payload);
      if (t && !sawDelta) { streamed += t; send('delta', { text: t }); }
      else if (t && sawDelta && !t.startsWith(streamed)) { send('delta', { text: `\n${t}` }); streamed = t; }
      return;
    }

    // --- progress worth showing ---
    if (name === 'agent.thinking' || name === 'agent.thinking.delta') { send('note', { text: NOTE.thinking }); return; }
    if (/^(span\.)?tool_use$/.test(name) || /^tool\./.test(name)) {
      const label = payload && (payload.name || payload.tool_name);
      send('note', { text: label ? `正在调用工具：${label}` : NOTE.tool });
      return;
    }
    if (name === 'session.status_running' || name === 'session.thread_status_running') { send('note', { text: NOTE.running }); return; }
    if (name === 'session.status_rescheduled' || name === 'session.thread_status_rescheduled') { send('note', { text: NOTE.rescheduled }); return; }

    if (name === 'span.model_request_end' && payload && payload.model_usage) {
      credits += Number(payload.model_usage.credits || 0);
      return;
    }

    // --- failures ---
    if (name === 'session.error') {
      const err = (payload && payload.error) || {};
      if (err.retry_status && err.retry_status.type === 'retrying') { send('note', { text: NOTE.rescheduled }); return; }
      errorSent = true;
      send('error', {
        code: 'agent',
        reason: err.qoder_error_code || err.type || 'agent_error',
        message: err.message || 'Agent 返回了一个错误。',
      });
      return;
    }

    // --- completion ---
    if (name === 'session.status_idle' || name === 'session.thread_status_idle') {
      if (idleHandled) return;
      idleHandled = true;
      const extra = Object.assign(
        streamed ? { chars: streamed.length } : {},
        credits ? { credits } : {}
      );
      // The agent's output files only exist once it goes idle, so this is the
      // moment to look. Bounded: a slow or broken listing must never hold the
      // turn open, and finish() runs either way.
      void listFiles(state.token, {
        sessionId: sess.id,
        signal: AbortSignal.timeout(FILE_LIST_TIMEOUT_MS),
      }).then(async (files) => {
        if (!files || !files.length) return;
        // Whatever the agent produced is written next to the code automatically —
        // the user asked for this, so it must not require a click.
        const saved = await saveFilesToDisk(files).catch(() => []);
        if (!finished) send('files', { files, saved });
      }).catch((err) => {
        log(`file listing skipped: ${err.message}`);
      }).finally(() => {
        finish(!errorSent, extra);
      });
    }
  };

  const relaying = sseReader(streamRes.body, handleEvent).catch((err) => {
    if (!finished && err.name !== 'AbortError') log(`stream read error: ${err.message}`);
  });

  // --- 2. Send the user message ---
  try {
    const r = await fetch(`${apiBase()}/api/v1/cloud/sessions/${sess.id}/events`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [{ type: 'user.message', content: buildContent(question, attachments) }],
      }),
      signal: ac.signal,
    });
    lastTraffic = Date.now();
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      log(`send rejected ${r.status}: ${body.slice(0, 300)}`);
      if (r.status === 409) {
        sessions.delete(cid); // stale upstream turn — rebuild on retry
        send('error', { code: 'busy', reason: 'upstream_409', message: '会话正忙，已为你重置会话，请再发一次。' });
      } else {
        send('error', Object.assign(explain(r.status, body), { reason: `send_${r.status}` }));
      }
      finish(false);
      return;
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      send('error', { code: 'network', reason: 'send_failed', message: `发送失败：${err.message}` });
      finish(false);
    }
    return;
  }

  await relaying;
  if (!finished) finish(!errorSent, streamed ? { chars: streamed.length } : {});
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

function originAllowed(origin) {
  if (origin === undefined || origin === null || origin === '' || origin === 'null') return true; // page from disk
  try {
    const u = new URL(origin);
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
  } catch { return false; }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

/** Everything the page is allowed to know about the current connection. */
function statusPayload() {
  return {
    ok: true,
    service: 'qoder-chat',
    connected: hasToken(),
    ready: isReady(),
    needsSetup: hasToken() && !isReady(),
    tokenHint: state.tokenHint,
    source: state.source,
    region: state.region,
    regions: Object.entries(REGIONS).map(([k, v]) => ({ id: k, label: v.label, console: v.console })),
    agent: state.agentId,
    environment: state.environmentId,
    agents: state.agents,
    environments: state.environments,
    tools: TOOLSET_TOOLS,
    idleTimeoutMs: IDLE_TIMEOUT_MS,
  };
}

/** Shape an upstream failure into the {status, payload} the page expects. */
function failure(err, fallbackMessage) {
  if (err instanceof InputError) {
    return { status: 400, payload: { code: 'bad_request', reason: 'invalid_input', message: err.message } };
  }
  if (err instanceof UpstreamError) {
    if (err.status) return { status: err.status === 401 ? 401 : 400, payload: explain(err.status, err.body) };
    return { status: 400, payload: { code: 'upstream', reason: err.message, message: fallbackMessage || `上游调用失败：${err.message}` } };
  }
  throw err;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const origin = req.headers.origin;

  res.setHeader('Access-Control-Allow-Origin', origin && origin !== 'null' ? origin : 'null');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');

  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

  // Anything that isn't a local page gets a flat refusal — this is what stops a
  // random site in the user's browser from spending their quota.
  if (url.pathname.startsWith('/api/') && !originAllowed(origin)) {
    json(res, 403, { code: 'forbidden_origin', reason: 'forbidden_origin', message: '这个服务只服务本机页面。' });
    return;
  }

  const readJson = async (res2) => {
    try { return JSON.parse(await readBody(req)); } catch {
      json(res2, 400, { code: 'bad_request', message: '请求体不是合法 JSON。' });
      return null;
    }
  };

  // --- health / current status: liveness only, never the token ---
  if (url.pathname === '/api/health' && req.method === 'GET') {
    json(res, 200, statusPayload());
    return;
  }

  // --- connect with a user-supplied PAT ---
  if (url.pathname === '/api/connect' && req.method === 'POST') {
    const body = await readJson(res);
    if (!body) return;
    try {
      await connect({ pat: body.pat, region: body.region, remember: Boolean(body.remember) });
      log(`connected: ${state.tokenHint} · region=${state.region} · agents=${state.agents.length} · envs=${state.environments.length}`);
      json(res, 200, Object.assign(statusPayload(), { ok: true }));
    } catch (err) {
      const { status, payload } = failure(err, '连接失败。');
      log(`connect failed: ${err.message}`);
      json(res, status, payload);
    }
    return;
  }

  if (url.pathname === '/api/disconnect' && req.method === 'POST') {
    disconnect();
    log('disconnected, saved token cleared');
    json(res, 200, { ok: true });
    return;
  }

  // --- the model catalogue, for the "create an agent" form ---
  if (url.pathname === '/api/catalog' && req.method === 'GET') {
    if (!hasToken()) { json(res, 401, { code: 'auth', reason: 'not_connected', message: '还没有连接：请先填入个人访问令牌。' }); return; }
    try {
      json(res, 200, Object.assign({ ok: true }, await getCatalog()));
    } catch (err) {
      const { status, payload } = failure(err, '拿不到模型清单。');
      json(res, status, payload);
    }
    return;
  }

  // --- create / delete an Agent ---
  if (url.pathname === '/api/agents' && req.method === 'POST') {
    const body = await readJson(res);
    if (!body) return;
    if (!hasToken()) { json(res, 401, { code: 'auth', reason: 'not_connected', message: '还没有连接：请先填入个人访问令牌。' }); return; }
    try {
      const payload = agentPayload(body);
      const created = await upstream(state.token, 'POST', LIST_AGENTS, payload);
      await refreshResources();
      if (created && created.id) state.agentId = created.id; // use what we just made
      resetSessions();
      log(`agent created: ${payload.name} (${created && created.id})`);
      json(res, 200, Object.assign(statusPayload(), { ok: true, created: shapeAgent(created || {}) }));
    } catch (err) {
      const { status, payload } = failure(err, '创建 Agent 失败。');
      log(`agent create failed: ${err.message}`);
      json(res, status, payload);
    }
    return;
  }

  if (url.pathname === '/api/agents' && req.method === 'DELETE') {
    const id = url.searchParams.get('id') || '';
    if (!hasToken()) { json(res, 401, { code: 'auth', reason: 'not_connected', message: '还没有连接：请先填入个人访问令牌。' }); return; }
    if (!state.agents.some((a) => a.id === id)) {
      json(res, 400, { code: 'bad_request', reason: 'unknown_agent', message: '这个 Agent 不在当前账号的列表里。' });
      return;
    }
    try {
      await upstream(state.token, 'DELETE', `${LIST_AGENTS}/${encodeURIComponent(id)}`);
      await refreshResources();
      resetSessions();
      log(`agent deleted: ${id}`);
      json(res, 200, Object.assign(statusPayload(), { ok: true, deleted: id }));
    } catch (err) {
      const { status, payload } = failure(err, '删除 Agent 失败。');
      json(res, status, payload);
    }
    return;
  }

  // --- create / delete an Environment ---
  if (url.pathname === '/api/environments' && req.method === 'POST') {
    const body = await readJson(res);
    if (!body) return;
    if (!hasToken()) { json(res, 401, { code: 'auth', reason: 'not_connected', message: '还没有连接：请先填入个人访问令牌。' }); return; }
    try {
      const payload = environmentPayload(body);
      const created = await upstream(state.token, 'POST', LIST_ENVIRONMENTS, payload);
      await refreshResources();
      if (created && created.id) state.environmentId = created.id;
      resetSessions();
      log(`environment created: ${payload.name} (${created && created.id})`);
      json(res, 200, Object.assign(statusPayload(), { ok: true, created: shapeEnvironment(created || {}) }));
    } catch (err) {
      const { status, payload } = failure(err, '创建运行环境失败。');
      log(`environment create failed: ${err.message}`);
      json(res, status, payload);
    }
    return;
  }

  if (url.pathname === '/api/environments' && req.method === 'DELETE') {
    const id = url.searchParams.get('id') || '';
    if (!hasToken()) { json(res, 401, { code: 'auth', reason: 'not_connected', message: '还没有连接：请先填入个人访问令牌。' }); return; }
    if (!state.environments.some((e) => e.id === id)) {
      json(res, 400, { code: 'bad_request', reason: 'unknown_environment', message: '这个运行环境不在当前账号的列表里。' });
      return;
    }
    try {
      await upstream(state.token, 'DELETE', `${LIST_ENVIRONMENTS}/${encodeURIComponent(id)}`);
      await refreshResources();
      resetSessions();
      log(`environment deleted: ${id}`);
      json(res, 200, Object.assign(statusPayload(), { ok: true, deleted: id }));
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 409) {
        // Upstream's own words are the best explanation here, and it also tells
        // the user what to do instead — so pass them through and offer it.
        const n = await countSessionsUsing(id);
        log(`environment delete refused: still referenced by ${n} session(s)`);
        json(res, 409, {
          code: 'in_use',
          reason: 'environment_in_use',
          message: upstreamMessage(err.body) || '这个运行环境还被会话引用着，暂时删不掉。',
          sessions: n,
          canArchive: true,
        });
        return;
      }
      const { status, payload } = failure(err, '删除运行环境失败。');
      json(res, status, payload);
    }
    return;
  }

  // --- archive instead of delete: the way out when a resource is still in use ---
  if (url.pathname === '/api/environments/archive' && req.method === 'POST') {
    const body = await readJson(res);
    if (!body) return;
    if (!hasToken()) { json(res, 401, { code: 'auth', reason: 'not_connected', message: '还没有连接：请先填入个人访问令牌。' }); return; }
    const id = String(body.id || '');
    if (!state.environments.some((e) => e.id === id)) {
      json(res, 400, { code: 'bad_request', reason: 'unknown_environment', message: '这个运行环境不在当前账号的列表里。' });
      return;
    }
    try {
      await upstream(state.token, 'POST', `${LIST_ENVIRONMENTS}/${encodeURIComponent(id)}/archive`);
      await refreshResources();
      resetSessions();
      log(`environment archived: ${id}`);
      json(res, 200, Object.assign(statusPayload(), { ok: true, archived: id }));
    } catch (err) {
      const { status, payload } = failure(err, '归档运行环境失败。');
      json(res, status, payload);
    }
    return;
  }

  // --- choose which agent / environment to talk to ---
  if (url.pathname === '/api/select' && req.method === 'POST') {
    const body = await readJson(res);
    if (!body) return;
    if (body.agent && state.agents.some((a) => a.id === body.agent)) state.agentId = body.agent;
    if (body.environment && state.environments.some((e) => e.id === body.environment)) state.environmentId = body.environment;
    resetSessions(); // a different agent must not inherit the old conversation
    json(res, 200, Object.assign(statusPayload(), { ok: true }));
    return;
  }

  if (url.pathname === '/api/reset' && req.method === 'POST') {
    let cid = '';
    try { cid = (JSON.parse(await readBody(req)) || {}).cid || ''; } catch {}
    if (cid) sessions.delete(cid);
    json(res, 200, { ok: true });
    return;
  }

  // --- files the agent produced -------------------------------------------
  if (url.pathname === '/api/files' && req.method === 'GET') {
    if (!hasToken()) { json(res, 401, { code: 'auth', reason: 'not_connected', message: '还没有连接：请先填入个人访问令牌。' }); return; }
    // Narrowing to one tab's session is optional; without it we list everything.
    const cid = url.searchParams.get('cid') || '';
    const sessionId = cid && sessions.has(cid) ? sessions.get(cid).id : '';
    try {
      const files = await listFiles(state.token, { sessionId });
      json(res, 200, { ok: true, files });
    } catch (err) {
      const { status, payload } = failure(err, '读取文件列表失败。');
      json(res, status, payload);
    }
    return;
  }

  if (url.pathname === '/api/files/download' && req.method === 'GET') {
    const id = url.searchParams.get('id') || '';
    if (!hasToken()) { json(res, 401, { code: 'auth', reason: 'not_connected', message: '还没有连接：请先填入个人访问令牌。' }); return; }
    if (!id) { json(res, 400, { code: 'bad_request', reason: 'missing_id', message: '缺少文件 id。' }); return; }
    try {
      // Resolve the name from the account's own listing rather than trusting a
      // query parameter — this also proves the file belongs to this account.
      const meta = (await listFiles(state.token)).find((f) => f.id === id);
      if (!meta) { json(res, 404, { code: 'not_found', reason: 'unknown_file', message: '这个文件不在当前账号下。' }); return; }
      if (!meta.downloadable) { json(res, 409, { code: 'conflict', reason: 'not_downloadable', message: '这个文件目前不允许下载。' }); return; }

      const signed = await fileDownloadUrl(state.token, id);
      const r = await fetch(signed);
      if (!r.ok) { json(res, 502, { code: 'upstream', reason: 'download_failed', message: `文件下载失败（HTTP ${r.status}）。` }); return; }

      const safeName = String(meta.filename).replace(/[\r\n"']/g, '_');
      const headers = {
        'Content-Type': meta.mime || 'application/octet-stream',
        // Forces a real download and keeps non-ASCII names intact.
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`,
        'Cache-Control': 'no-store',
      };
      const len = r.headers.get('content-length');
      if (len) headers['Content-Length'] = len;
      res.writeHead(200, headers);
      pipeline(Readable.fromWeb(r.body), res, (err) => {
        if (err) log(`file download stream error: ${err.message}`);
      });
    } catch (err) {
      const { status, payload } = failure(err, '下载文件失败。');
      json(res, status, payload);
    }
    return;
  }

  // --- upload a file for the agent to read --------------------------------
  if (url.pathname === '/api/upload' && req.method === 'POST') {
    if (!hasToken()) { json(res, 401, { code: 'auth', reason: 'not_connected', message: '还没有连接：请先填入个人访问令牌。' }); return; }
    try {
      const created = await uploadFile(state.token, req);
      if (!created || !created.id) throw new UpstreamError('上传没有返回文件 id', JSON.stringify(created || {}));
      log(`uploaded: ${created.filename || '?'} (${created.id}, ${created.size_bytes || 0} B)`);
      json(res, 200, {
        ok: true,
        file: {
          id: created.id,
          filename: created.filename || '',
          size: Number(created.size_bytes || 0),
          mime: created.mime_type || '',
        },
      });
    } catch (err) {
      if (err instanceof InputError) {
        json(res, 400, { code: 'bad_request', reason: 'bad_upload', message: err.message });
        return;
      }
      const { status, payload } = failure(err, '上传文件失败。');
      json(res, status, payload);
    }
    return;
  }

  // --- the turn ---
  if (url.pathname === '/api/ask' && req.method === 'POST') {
    let payload;
    try { payload = JSON.parse(await readBody(req)); } catch { json(res, 400, { message: '请求体不是合法 JSON。' }); return; }
    const cid = String((payload && payload.cid) || '').slice(0, 128);
    const question = String((payload && payload.q) || '').trim().slice(0, 20000);
    const attachments = sanitizeAttachments(payload && payload.attachments);
    if (!cid) { json(res, 400, { code: 'bad_request', message: '缺少 cid。' }); return; }
    if (!question && !attachments.length) {
      json(res, 400, { code: 'bad_request', message: '说点什么，或者带上一个附件。' });
      return;
    }
    if (!hasToken()) {
      json(res, 401, { code: 'auth', reason: 'not_connected', message: '还没有连接：请先填入个人访问令牌。' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    try {
      await runTurn({ cid, question, attachments, downstream: res });
    } catch (err) {
      console.error('[qoder-chat] turn failed:', err && err.message);
      try {
        res.write(`event: error\ndata: ${JSON.stringify({ code: 'internal', reason: 'exception', message: `服务内部错误：${err && err.message}` })}\n\n`);
        res.write(`event: done\ndata: ${JSON.stringify({ ok: false })}\n\n`);
        res.end();
      } catch {}
    }
    return;
  }

  if (req.method === 'GET') { serveStatic(res, url.pathname); return; }
  res.writeHead(405, { 'Content-Type': 'text/plain' }).end('method not allowed');
});

server.listen(PORT, HOST, () => {
  console.log(`[qoder-chat] listening on http://${HOST}:${PORT}`);
  console.log(`[qoder-chat] open http://${HOST}:${PORT}/ — the page will ask for your PAT.`);
  bootConnect();
});

process.on('SIGINT', () => { console.log('\n[qoder-chat] bye'); process.exit(0); });
