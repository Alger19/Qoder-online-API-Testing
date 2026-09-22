#!/usr/bin/env node
/**
 * Test suite for the local service. Every wait is bounded — nothing here can hang.
 *
 *   node test/run-tests.js
 *
 * Layer 1 (this file): our service's protocol, against a mock upstream.
 * Layer 3 (verify-ui.js): the real page in a real browser, opened from file://.
 */

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const NODE = process.execPath;
const ROOT = path.join(__dirname, '..');
const TOKEN_FILE = path.join(ROOT, '.token');
const MOCK_PORT = 9911;
const SVC_PORT = 8790;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const SVC = `http://127.0.0.1:${SVC_PORT}`;
// Deliberately unmistakable as a fake: this repo is public, and a string that
// merely looks like a token invites confusion (and secret-scanner noise).
const PAT = 'pt-FAKE-TEST-TOKEN-not-a-real-token';

// Where the service auto-saves what the agent produced, during this run only.
const DL_DIR = path.join(require('os').tmpdir(), `qoder-chat-dl-${process.pid}`);

let passed = 0, failed = 0;

function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`  \x1b[32mPASS\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? '  → ' + detail : ''}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { const r = await fetch(url); if (r.ok) return true; } catch {}
    await sleep(120);
  }
  return false;
}

function startProc(name, args, env) {
  const p = spawn(NODE, args, {
    cwd: ROOT,
    env: Object.assign({}, process.env, env || {}),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(`[${name}] ${d}`));
  p.stderr.on('data', (d) => process.env.VERBOSE && process.stderr.write(`[${name}] ${d}`));
  return p;
}

const post = (p, body, headers) => fetch(`${SVC}${p}`, {
  method: 'POST',
  headers: Object.assign({ 'Content-Type': 'application/json', Origin: 'null' }, headers || {}),
  body: body === undefined ? undefined : JSON.stringify(body),
});

/** Collect our service's SSE turn into an array of {event, data}. Bounded. */
async function collectTurn(cid, q, { origin = 'null', timeoutMs = 20000, attachments } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const events = [];
  try {
    const res = await fetch(`${SVC}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify(Object.assign({ cid, q }, attachments ? { attachments } : {})),
      signal: ac.signal,
    });
    if (!res.ok || !res.body) {
      return { status: res.status, events, body: await res.text().catch(() => '') };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let name = '';
        const data = [];
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) name = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        if (name && data.length) {
          let payload = {};
          try { payload = JSON.parse(data.join('\n')); } catch {}
          events.push({ event: name, data: payload });
        }
      }
    }
  } catch (err) {
    events.push({ event: '__harness_error', data: { message: err.message } });
  } finally {
    clearTimeout(timer);
  }
  return { status: 200, events };
}

const textOf = (ev) => ev.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
const notesOf = (ev) => ev.filter((e) => e.event === 'note').map((e) => e.data.text);
const errorsOf = (ev) => ev.filter((e) => e.event === 'error').map((e) => e.data);
const doneOf = (ev) => ev.filter((e) => e.event === 'done').map((e) => e.data);

const setMode = (mode) => fetch(`${MOCK}/__mode`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }),
});

async function main() {
  try { fs.unlinkSync(TOKEN_FILE); } catch {}

  const mock = startProc('mock', [path.join('test', 'mock-upstream.js')], { MOCK_PORT });
  const svc = startProc('svc', ['server.js'], {
    PORT: SVC_PORT,
    QODER_API_BASE_OVERRIDE: MOCK,
    TURN_TIMEOUT_MS: 2500, // keep the stall case quick
    // Auto-saved files go to a temp dir, so a test run never touches your project.
    DOWNLOAD_DIR: DL_DIR,
    QODER_PAT: '',        // start disconnected: the page must ask for a token
  });
  const cleanup = () => { try { mock.kill(); } catch {} try { svc.kill(); } catch {} };
  process.on('exit', cleanup);

  if (!(await waitFor(`${MOCK}/__mode`)) || !(await waitFor(`${SVC}/api/health`))) {
    console.log('服务未就绪，测试中止');
    cleanup();
    process.exit(1);
  }

  // ------------------------------------------------------- before connecting
  console.log('\n未连接状态');
  {
    const j = await (await fetch(`${SVC}/api/health`)).json();
    ok('health 报告未连接', j.connected === false, JSON.stringify({ connected: j.connected }));
    ok('health 不回传令牌', !JSON.stringify(j).includes(PAT));
    ok('health 列出可选区域', Array.isArray(j.regions) && j.regions.length >= 2, JSON.stringify(j.regions));
    // Region labels + console links are user-facing on purpose; what must never
    // appear is the API base, a bearer token, or a session id.
    ok('health 不含 API 基址', !JSON.stringify(j).includes('/api/v1'));
    ok('health 不含 session 标识', !/sess_/.test(JSON.stringify(j)));
  }
  {
    const r = await post('/api/ask', { cid: 'x', q: '你好' });
    const j = await r.json();
    ok('未连接时拒绝对话 401', r.status === 401, String(r.status));
    ok('拒绝理由指向鉴权', j.code === 'auth' && j.reason === 'not_connected', JSON.stringify(j));
  }

  // ------------------------------------------------------------ connecting
  console.log('\n填入 PAT 连接');
  {
    const r = await post('/api/connect', { pat: PAT, region: 'cn' });
    const j = await r.json();
    ok('连接成功', r.status === 200 && j.ok === true, JSON.stringify(j).slice(0, 200));
    ok('带回 agent 列表', Array.isArray(j.agents) && j.agents.length === 2, JSON.stringify(j.agents));
    ok('带回 environment 列表', Array.isArray(j.environments) && j.environments.length === 2);
    ok('默认选中第一个 agent', j.agent === 'agent_mock_1', j.agent);
    ok('响应里只有掩码令牌', typeof j.tokenHint === 'string' && !JSON.stringify(j).includes(PAT), j.tokenHint);
  }
  {
    const j = await (await fetch(`${SVC}/api/health`)).json();
    ok('health 转为已连接', j.connected === true);
    ok('health 仍不回传完整令牌', !JSON.stringify(j).includes(PAT), j.tokenHint);
  }
  ok('未勾选「记住」时不落盘', !fs.existsSync(TOKEN_FILE));
  {
    const r = await post('/api/connect', { pat: '' });
    ok('空令牌被拒 400', r.status === 400, String(r.status));
  }

  // ------------------------------------------------------- model catalogue
  console.log('\n模型清单（创建 Agent 用）');
  {
    const r = await fetch(`${SVC}/api/catalog`);
    const j = await r.json();
    ok('catalog 成功', r.status === 200 && j.ok === true, String(r.status));
    ok('带回模型列表', Array.isArray(j.models) && j.models.length === 3, JSON.stringify((j.models || []).map((m) => m.id)));
    ok('模型带展示名与倍率',
      j.models.some((m) => m.id === 'qfmodel' && m.name === 'Qwen3.8-Flash' && m.factor === 0));
    ok('模型带推理档位',
      ((j.models.find((m) => m.id === 'qfmodel') || {}).efforts || []).join(',') === 'low,medium,xhigh');
    ok('模型带上下文窗口',
      ((j.models.find((m) => m.id === 'q37fmodel') || {}).contexts || []).length === 3);
    ok('没有档位的模型如实留空',
      ((j.models.find((m) => m.id === 'auto') || {}).efforts || []).length === 0);
    ok('带回工具集类型', j.toolset && j.toolset.type === 'agent_toolset_20260401', JSON.stringify(j.toolset && j.toolset.type));
    ok('带回 11 个工具', (j.toolset.tools || []).length === 11, JSON.stringify(j.toolset.tools));
    ok('工具集含文档里的全部工具',
      ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'ImageSearch', 'ImageGen', 'DeliverArtifacts']
        .every((t) => j.toolset.tools.includes(t)));
    ok('带回网络策略取值',
      JSON.stringify(j.networking) === JSON.stringify(['unrestricted', 'limited', 'allowed_hosts']),
      JSON.stringify(j.networking));
    ok('catalog 不回传令牌', !JSON.stringify(j).includes(PAT));
    ok('catalog 不含上游域名', !JSON.stringify(j).includes('qoder.com'));
  }

  // ---------------------------------------------------- rejected connection
  console.log('\n令牌被拒 / 错误区域');
  {
    await setMode('reject_token');
    const r = await post('/api/connect', { pat: 'pt-wrong-region-token' });
    const j = await r.json();
    ok('被拒返回 401', r.status === 401, String(r.status));
    ok('提示提到区域或令牌', /区域|令牌/.test(j.message || ''), j.message);
    const h = await (await fetch(`${SVC}/api/health`)).json();
    ok('失败的连接不破坏已有连接', h.connected === true, JSON.stringify({ connected: h.connected }));
    await setMode('normal');
  }

  // ------------------------------------------------------------ create agent
  console.log('\n创建 Agent（文档 step 1）');
  let madeAgentId = '';
  {
    const r = await post('/api/agents', {
      name: '测试创建的 Agent', description: '来自测试', system: '你是测试助手。',
      model: 'qfmodel', effort: 'low', contextWindow: 400000,
      tools: ['Bash', 'Read', 'WebSearch'],
    });
    const j = await r.json();
    ok('创建成功', r.status === 200 && j.ok === true, JSON.stringify(j).slice(0, 200));
    madeAgentId = (j.created && j.created.id) || '';
    ok('上游真的建出了这个 Agent', /^agent_/.test(madeAgentId), madeAgentId);
    ok('列表里多了一个', (j.agents || []).length === 3, JSON.stringify((j.agents || []).map((a) => a.id)));
    ok('新建的被自动选为当前 Agent', j.agent === madeAgentId, JSON.stringify({ agent: j.agent, made: madeAgentId }));
    ok('列表里能按名字找到', (j.agents || []).some((a) => a.id === madeAgentId && a.name === '测试创建的 Agent'));
    ok('带回模型与档位',
      (j.agents || []).some((a) => a.id === madeAgentId && a.model === 'qfmodel' && a.effort === 'low'));
    ok('带回勾选的工具',
      (j.agents || []).some((a) => a.id === madeAgentId &&
        JSON.stringify(a.tools) === JSON.stringify(['Bash', 'Read', 'WebSearch'])));
    ok('创建后仍处于可用状态', j.ready === true);
    ok('创建响应不回传令牌', !JSON.stringify(j).includes(PAT));
  }
  {
    const r = await post('/api/agents', { name: '   ' });
    const j = await r.json();
    ok('空名字在本地就被拒 400', r.status === 400, String(r.status));
    ok('空名字不发往上游', j.code === 'bad_request' && /名字/.test(j.message || ''), JSON.stringify(j));
  }
  {
    const r = await post('/api/agents', { name: '带奇怪工具的 Agent', model: 'auto', tools: ['Bash', 'NotATool', 'rm'] });
    const j = await r.json();
    ok('不认识的工具名被丢掉',
      (j.created.tools || []).length === 1 && j.created.tools[0] === 'Bash', JSON.stringify(j.created.tools));
  }
  {
    await setMode('create_fail');
    const r = await post('/api/agents', { name: '触发的', model: 'bogus' });
    const j = await r.json();
    ok('上游校验错误透传给用户',
      r.status === 400 && /must be one of/.test(j.message || ''), JSON.stringify(j));
    ok('错误码是 bad_request', j.code === 'bad_request', JSON.stringify(j));
    await setMode('normal');
  }

  // ------------------------------------------------------ create environment
  console.log('\n创建运行环境（文档 step 2）');
  let madeEnvId = '';
  {
    const r = await post('/api/environments', { name: '测试运行环境', networking: 'unrestricted' });
    const j = await r.json();
    ok('创建成功', r.status === 200 && j.ok === true, JSON.stringify(j).slice(0, 200));
    madeEnvId = (j.created && j.created.id) || '';
    ok('上游真的建出了这个环境', /^env_/.test(madeEnvId), madeEnvId);
    ok('新建的被自动选为当前环境', j.environment === madeEnvId, JSON.stringify({ env: j.environment, made: madeEnvId }));
    ok('网络策略被记录', j.created.networking === 'unrestricted', j.created.networking);
  }
  {
    const r = await post('/api/environments', { name: '限制环境', networking: 'allowed_hosts', allowedHosts: [] });
    const j = await r.json();
    ok('选了"仅允许指定主机"却一个都不填 → 本地拒 400',
      r.status === 400 && /主机/.test(j.message || ''), JSON.stringify(j));
  }
  {
    const r = await post('/api/environments', {
      name: '限制环境', networking: 'allowed_hosts', allowedHosts: ['api.example.com', ' ', '*.github.com'],
    });
    const j = await r.json();
    ok('补上主机后创建成功', r.status === 200, JSON.stringify(j).slice(0, 160));
    ok('空白行被丢掉', JSON.stringify(j.created.allowedHosts) === JSON.stringify(['api.example.com', '*.github.com']),
      JSON.stringify(j.created.allowedHosts));
  }
  {
    const r = await post('/api/environments', { name: '乱填的', networking: 'bogus' });
    const j = await r.json();
    ok('非法网络策略回落为不受限', r.status === 200 && j.created.networking === 'unrestricted', JSON.stringify(j.created));
  }

  // ------------------------------------------------------------- normal turn
  console.log('\n正常一轮');
  {
    await setMode('normal');
    const { events } = await collectTurn('t-normal', '你好');
    ok('先发 ready', events[0] && events[0].event === 'ready');
    ok('拿到回答文本', textOf(events).includes('Mock Agent'), textOf(events));
    ok('done ok=true', doneOf(events).some((d) => d.ok === true));
    ok('没有 error', errorsOf(events).length === 0, JSON.stringify(errorsOf(events)));
    const order = events.map((e) => e.event);
    ok('ready 在 delta 之前', order.indexOf('ready') < order.indexOf('delta'), order.join(','));
    ok('done 收尾', order[order.length - 1] === 'done', order.join(','));
  }

  // ------------------------------------------------------------- produced files
  console.log('\nAgent 产出的文件：自动回传 + 下载到本地');
  {
    await setMode('normal');
    const { events } = await collectTurn('t-files', '帮我写一个文件');
    const filesEv = events.find((e) => e.event === 'files');
    ok('一轮结束会带回文件列表', Boolean(filesEv), events.map((e) => e.event).join(','));

    const list = (filesEv && filesEv.data && filesEv.data.files) || [];
    ok('只回传本轮会话的文件', list.length === 1 && list[0].filename === 'mock-artifact.txt',
      JSON.stringify(list.map((f) => f.filename)));
    ok('文件带大小', list[0] && list[0].size > 0, JSON.stringify(list[0] && list[0].size));
    ok('文件带会话归属', list[0] && /^sess_/.test(list[0].sessionId || ''),
      JSON.stringify(list[0] && list[0].sessionId));
    ok('files 在 done 之前', events.map((e) => e.event).indexOf('files')
      < events.map((e) => e.event).indexOf('done'), events.map((e) => e.event).join(','));

    // The download goes through the service, which relays the signed URL.
    const r = await fetch(`${SVC}/api/files/download?id=${encodeURIComponent(list[0].id)}`,
      { headers: { Origin: 'null' } });
    ok('下载返回 200', r.status === 200, String(r.status));
    const cd = r.headers.get('content-disposition') || '';
    ok('响应头要求浏览器另存', /attachment/.test(cd), cd);
    ok('响应头带原文件名', /mock-artifact\.txt/.test(decodeURIComponent(cd)), decodeURIComponent(cd));
    const body = await r.text();
    ok('内容是文件本身', body === 'hello from the mock upstream\n', JSON.stringify(body));

    // A file id that is not on the account must not be downloadable.
    const bad = await fetch(`${SVC}/api/files/download?id=file_does_not_exist`,
      { headers: { Origin: 'null' } });
    ok('不存在的文件返回 404', bad.status === 404, String(bad.status));

    const listed = await (await fetch(`${SVC}/api/files`, { headers: { Origin: 'null' } })).json();
    ok('文件列表接口返回数组', Array.isArray(listed.files), JSON.stringify(listed).slice(0, 120));
  }

  // ------------------------------------------------------------- auto-save
  console.log('\n产出文件自动存进 downloads/');
  {
    await setMode('normal');
    // Wipe the folder and its "already saved" index so this turn really writes.
    fs.rmSync(DL_DIR, { recursive: true, force: true });

    const { events } = await collectTurn('t-save', '帮我写个文件');
    const ev = events.find((e) => e.event === 'files');
    const saved = (ev && ev.data && ev.data.saved) || [];

    ok('事件带回已保存清单', saved.length === 1, JSON.stringify(saved));
    ok('保存路径是「文件夹/文件名」，不泄露绝对路径',
      saved[0] && !path.isAbsolute(saved[0].rel)
      && !String(saved[0].rel).startsWith('..')
      && String(saved[0].rel).endsWith('mock-artifact.txt'),
      JSON.stringify(saved[0] && saved[0].rel));
    const onDisk = saved[0] ? fs.readFileSync(saved[0].path, 'utf8') : '';
    ok('落盘内容和上游一致', onDisk === 'hello from the mock upstream\n', JSON.stringify(onDisk));

    // A second turn must not write a second copy of the same file.
    await collectTurn('t-save-2', '再写一次');
    const names = fs.existsSync(DL_DIR) ? fs.readdirSync(DL_DIR).filter((n) => n !== '.saved.json') : [];
    ok('同一个文件不会重复保存', names.length === 1, JSON.stringify(names));

    fs.rmSync(DL_DIR, { recursive: true, force: true });
  }

  // ------------------------------------------------- upload / attachments
  console.log('\n上传文件给 Agent 读');
  {
    await setMode('normal');

    const fd = new FormData();
    fd.append('file', new Blob(['col A,col B\n1,2\n'], { type: 'text/csv' }), 'data.csv');
    const up = await fetch(`${SVC}/api/upload`, { method: 'POST', body: fd, headers: { Origin: 'null' } });
    const upJ = await up.json();
    ok('上传返回 200', up.status === 200, String(up.status));
    ok('上传返回文件 id', /^file_/.test((upJ.file && upJ.file.id) || ''), JSON.stringify(upJ));
    ok('上传保留原文件名', upJ.file && upJ.file.filename === 'data.csv', JSON.stringify(upJ.file));

    const seen = await (await fetch(`${MOCK}/__uploads`)).json();
    const last = (seen.uploads || []).slice(-1)[0] || {};
    ok('上游收到文件名', last.filename === 'data.csv', JSON.stringify(last));
    ok('上游收到文件内容', (last.body || '').includes('col A,col B'), JSON.stringify(last.body));

    const bad = await fetch(`${SVC}/api/upload`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'null' }, body: '{}',
    });
    ok('非 multipart 上传被拒 400', bad.status === 400, String(bad.status));

    // An image is referenced by id; a text file has no reference mechanism, so
    // its contents must be inlined. Assert on what upstream actually received.
    const imgFd = new FormData();
    imgFd.append('file', new Blob(['fake-png-bytes'], { type: 'image/png' }), 'shot.png');
    const imgJ = await (await fetch(`${SVC}/api/upload`, {
      method: 'POST', body: imgFd, headers: { Origin: 'null' },
    })).json();

    await collectTurn('t-attach', '看看这些', {
      attachments: [
        { kind: 'image', name: 'shot.png', fileId: imgJ.file.id },
        { kind: 'text', name: 'notes.txt', text: '这是笔记正文' },
      ],
    });
    const got = await (await fetch(`${MOCK}/__last_message`)).json();
    const blocks = ((((got.message || {}).events) || [])[0] || {}).content || [];
    ok('消息含三个 block', blocks.length === 3, JSON.stringify(blocks.map((b) => b.type)));
    ok('图片走 image block 引用 file_id',
      blocks[0] && blocks[0].type === 'image'
      && blocks[0].source && blocks[0].source.type === 'file'
      && blocks[0].source.file_id === imgJ.file.id, JSON.stringify(blocks[0]));
    ok('文本文件被内联进 text block',
      blocks[1] && blocks[1].type === 'text' && blocks[1].text.includes('这是笔记正文'),
      JSON.stringify(blocks[1]).slice(0, 160));
    ok('问题排在最后', blocks[2] && blocks[2].text === '看看这些', JSON.stringify(blocks[2]));

    // A forged id must never reach upstream.
    await collectTurn('t-attach-bad', 'hi', {
      attachments: [{ kind: 'image', name: 'x.png', fileId: '../../etc/passwd' }],
    });
    const got2 = await (await fetch(`${MOCK}/__last_message`)).json();
    const b2 = ((((got2.message || {}).events) || [])[0] || {}).content || [];
    ok('非法 fileId 被丢弃', !JSON.stringify(b2).includes('etc/passwd'), JSON.stringify(b2));
    ok('丢光附件后仍带问题', b2.length === 1 && b2[0].text === 'hi', JSON.stringify(b2));

    // A question is no longer mandatory when a file is attached.
    await collectTurn('t-attach-only', '', {
      attachments: [{ kind: 'text', name: 'a.txt', text: 'x' }],
    });
    const got3 = await (await fetch(`${MOCK}/__last_message`)).json();
    const b3 = ((((got3.message || {}).events) || [])[0] || {}).content || [];
    ok('只有附件也能发（问题可空）', b3.length === 2 && b3[1].text === '请看附件。', JSON.stringify(b3));
  }

  // --------------------------------------------------------- overload retry
  console.log('\n上游过载后重试成功');
  {
    await setMode('overload_then_ok');
    const { events } = await collectTurn('t-overload', '你好');
    ok('出现重试提示', notesOf(events).some((n) => n.includes('重试')), JSON.stringify(notesOf(events)));
    ok('重试后仍拿到回答', textOf(events).includes('Mock Agent'));
    ok('重试不算失败', doneOf(events).some((d) => d.ok === true));
  }

  // --------------------------------------------------------------- stall
  console.log('\n上游静默 → 超时放弃');
  {
    await setMode('stall');
    const t0 = Date.now();
    const { events } = await collectTurn('t-stall', '你好', { timeoutMs: 15000 });
    const ms = Date.now() - t0;
    const errs = errorsOf(events);
    ok('发出 timeout 错误', errs.some((e) => e.code === 'timeout'), JSON.stringify(errs));
    ok('带明确 reason', errs.some((e) => e.reason === 'upstream_silent'), JSON.stringify(errs));
    ok('心跳没被当成内容', textOf(events) === '', textOf(events));
    ok('在阈值附近结束 (2.5~8s)', ms > 2400 && ms < 8000, ms + 'ms');
    ok('done ok=false', doneOf(events).some((d) => d.ok === false));
  }

  // ------------------------------------------------- token dies mid-flight
  console.log('\n轮次进行中令牌失效');
  {
    await setMode('reject_token');
    const { events } = await collectTurn('t-auth-fresh', '你好');
    const errs = errorsOf(events);
    ok('发出 auth 错误', errs.some((e) => e.code === 'auth'), JSON.stringify(errs));
    ok('提示指向区域或令牌', errs.some((e) => /区域|令牌/.test(e.message || '')), JSON.stringify(errs));
    await setMode('normal');
  }

  // ------------------------------------------------------------- 409 busy
  console.log('\n上游返回 409 会话占用');
  {
    await setMode('busy');
    const { events } = await collectTurn('t-busy', '你好');
    ok('发出 busy 错误', errorsOf(events).some((e) => e.code === 'busy'), JSON.stringify(errorsOf(events)));
    await setMode('normal');
  }

  // -------------------------------------------------------- selection & cids
  console.log('\n切换选择 / 每客户端独立会话');
  {
    const j = await (await post('/api/select', { agent: 'agent_mock_2', environment: 'env_mock_2' })).json();
    ok('可以切换 agent', j.agent === 'agent_mock_2', j.agent);
    ok('可以切换 environment', j.environment === 'env_mock_2', j.environment);

    const bad = await (await post('/api/select', { agent: 'agent_not_mine' })).json();
    ok('陌生 agent id 被忽略', bad.agent === 'agent_mock_2', bad.agent);
  }
  {
    await post('/api/select', { agent: 'agent_mock_1', environment: 'env_mock_1' });
    const a = await collectTurn('t-cid-a', 'A');
    const b = await collectTurn('t-cid-b', 'B');
    ok('两条独立会话都能拿到回答',
      textOf(a.events).includes('Mock Agent') && textOf(b.events).includes('Mock Agent'));
  }

  // ---------------------------------------------------------------- delete
  console.log('\n删除资源');
  {
    const made = await (await post('/api/agents', { name: '待删除的 Agent', model: 'auto' })).json();
    const id = made.created.id;
    const r = await fetch(`${SVC}/api/agents?id=${encodeURIComponent(id)}`, {
      method: 'DELETE', headers: { Origin: 'null' },
    });
    const j = await r.json();
    ok('删除成功', r.status === 200 && j.deleted === id, JSON.stringify(j).slice(0, 160));
    ok('删除后列表里没有了', !(j.agents || []).some((a) => a.id === id),
      JSON.stringify((j.agents || []).map((a) => a.id)));
  }
  {
    const r = await fetch(`${SVC}/api/agents?id=agent_not_mine`, {
      method: 'DELETE', headers: { Origin: 'null' },
    });
    ok('删除不在列表里的 Agent 被拒 400', r.status === 400, String(r.status));
  }
  {
    const made = await (await post('/api/environments', { name: '待删除的环境', networking: 'limited' })).json();
    const id = made.created.id;
    const r = await fetch(`${SVC}/api/environments?id=${encodeURIComponent(id)}`, {
      method: 'DELETE', headers: { Origin: 'null' },
    });
    const j = await r.json();
    ok('删除运行环境成功', r.status === 200 && j.deleted === id, JSON.stringify(j).slice(0, 160));
    ok('删除后列表里没有了', !(j.environments || []).some((e) => e.id === id));
  }
  {
    const r = await fetch(`${SVC}/api/agents?id=agent_mock_1`, {
      method: 'DELETE', headers: { Origin: 'https://evil.example.com' },
    });
    ok('外域不能删除资源 403', r.status === 403, String(r.status));
    const c = await fetch(`${SVC}/api/catalog`, { headers: { Origin: 'https://evil.example.com' } });
    ok('外域不能读模型清单 403', c.status === 403, String(c.status));
  }

  // -------------------------------------------- delete blocked by a session
  console.log('\n运行环境还被会话引用 · 删不掉，应当改为归档');
  {
    await setMode('env_in_use');
    const r = await fetch(`${SVC}/api/environments?id=env_mock_1`, {
      method: 'DELETE', headers: { Origin: 'null' },
    });
    const j = await r.json();
    ok('返回 409 而不是假装成功', r.status === 409, String(r.status));
    ok('错误码是 in_use', j.code === 'in_use', JSON.stringify(j));
    ok('告诉页面有几个会话占着', j.sessions === 1, JSON.stringify(j.sessions));
    ok('告诉页面可以归档', j.canArchive === true, JSON.stringify(j.canArchive));
    ok('原样带上上游的理由', /is in use/.test(j.message || ''), j.message);
  }
  {
    const r = await post('/api/environments/archive', { id: 'env_mock_1' });
    const j = await r.json();
    ok('归档成功', r.status === 200 && j.archived === 'env_mock_1', JSON.stringify(j).slice(0, 160));
    ok('归档后不再出现在列表里', !(j.environments || []).some((e) => e.id === 'env_mock_1'),
      JSON.stringify((j.environments || []).map((e) => e.id)));
    ok('其它环境没被牵连', (j.environments || []).some((e) => e.id === 'env_mock_2'));
    ok('归档响应不回传令牌', !JSON.stringify(j).includes(PAT));
  }
  {
    const r = await post('/api/environments/archive', { id: 'env_not_mine' });
    ok('归档不在列表里的环境被拒 400', r.status === 400, String(r.status));
  }
  {
    const r = await fetch(`${SVC}/api/environments/archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
      body: JSON.stringify({ id: 'env_mock_2' }),
    });
    ok('外域不能归档 403', r.status === 403, String(r.status));
  }
  {
    await setMode('normal');
    await fetch(`${MOCK}/__reset`, { method: 'POST' });
  }

  // ------------------------------------------------------- brand new account
  console.log('\n全新账号：连得上，但先要建东西');
  {
    await setMode('empty_account');
    await fetch(`${MOCK}/__reset`, { method: 'POST' });
    const r = await post('/api/connect', { pat: PAT, region: 'cn' });
    const j = await r.json();
    ok('空账号也能连上', r.status === 200 && j.connected === true, JSON.stringify(j).slice(0, 200));
    ok('标记为缺配置', j.needsSetup === true && j.ready === false,
      JSON.stringify({ needsSetup: j.needsSetup, ready: j.ready }));
    ok('列表确实是空的', j.agents.length === 0 && j.environments.length === 0);
    ok('没有默认选中任何东西', j.agent === '' && j.environment === '');
  }
  {
    const { events } = await collectTurn('t-not-ready', '你好', { timeoutMs: 10000 });
    ok('没配好时给出 setup 错误', errorsOf(events).some((e) => e.code === 'setup'),
      JSON.stringify(errorsOf(events)));
    ok('没配好时不产生任何回答', textOf(events) === '', textOf(events));
  }
  {
    const a = await (await post('/api/agents', { name: '空账号的第一个 Agent', model: 'auto', tools: ['Bash'] })).json();
    ok('空账号可以建 Agent', (a.agents || []).length === 1, JSON.stringify((a.agents || []).map((x) => x.id)));
    ok('只建了 Agent 还不算 ready', a.ready === false, JSON.stringify({ ready: a.ready }));
    const e = await (await post('/api/environments', { name: '空账号的第一个环境', networking: 'unrestricted' })).json();
    ok('再建好环境就 ready 了', e.ready === true,
      JSON.stringify({ ready: e.ready, agents: e.agents.length, envs: e.environments.length }));
    const t = await collectTurn('t-after-setup', '你好');
    ok('建完立刻就能对话', textOf(t.events).includes('Mock Agent'), textOf(t.events));
    await setMode('normal');
    await fetch(`${MOCK}/__reset`, { method: 'POST' });
  }

  // ------------------------------------------------------- remember / forget
  console.log('\n记住令牌 / 断开');
  {
    const r = await post('/api/connect', { pat: PAT, region: 'cn', remember: true });
    ok('勾选记住后连接成功', r.status === 200);
    ok('令牌写入 .token', fs.existsSync(TOKEN_FILE));
    if (fs.existsSync(TOKEN_FILE)) {
      const mode = fs.statSync(TOKEN_FILE).mode & 0o777;
      ok('.token 仅本人可读写 (0600)', mode === 0o600, '0' + mode.toString(8));
      const saved = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      ok('.token 记录了区域', saved.region === 'cn', JSON.stringify(saved.region));
    }
  }
  {
    const r = await post('/api/disconnect');
    ok('断开成功', r.status === 200);
    const j = await (await fetch(`${SVC}/api/health`)).json();
    ok('断开后状态为未连接', j.connected === false);
    ok('断开后清掉已保存令牌', !fs.existsSync(TOKEN_FILE));
    const ask = await post('/api/ask', { cid: 'y', q: '你好' });
    ok('断开后拒绝对话 401', ask.status === 401, String(ask.status));
  }

  // ------------------------------------------------------------ security
  console.log('\n安全边界');
  {
    const r = await fetch(`${SVC}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
      body: JSON.stringify({ cid: 'x', q: 'hi' }),
    });
    ok('外域 Origin 被拒 403', r.status === 403, String(r.status));
  }
  {
    const r = await fetch(`${SVC}/api/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
      body: JSON.stringify({ pat: PAT }),
    });
    ok('外域不能提交令牌 403', r.status === 403, String(r.status));
  }
  {
    const r = await fetch(`${SVC}/api/ask`, {
      method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'POST' },
    });
    ok('预检返回 204', r.status === 204, String(r.status));
    ok('预检带 Access-Control-Allow-Origin', !!r.headers.get('access-control-allow-origin'));
  }
  {
    const html = await (await fetch(`${SVC}/`)).text();
    ok('静态页可访问', html.includes('个人访问令牌'));
    ok('页面含创建 Agent 的入口', html.includes('创建 Agent'));
    ok('页面含创建运行环境的入口', html.includes('创建运行环境'));
    ok('页面不含上游域名', !html.includes('qoder.com.cn') && !html.includes('qoder.com'));
    ok('页面不含 session 标识', !/sess_/.test(html));
    ok('页面不持久化到 localStorage', !/localStorage\s*\./.test(html));
    ok('页面只把随机会话号放进 sessionStorage', /sessionStorage/.test(html) && !/\.setItem\([^)]*pat/i.test(html));
  }
  {
    const r = await fetch(`${SVC}/api/ask`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'null' }, body: 'not json',
    });
    ok('非法 JSON 返回 400', r.status === 400, String(r.status));
  }

  cleanup();
  await sleep(150);

  console.log(`\n结果：\x1b[32m${passed} 通过\x1b[0m，${failed ? `\x1b[31m${failed} 失败\x1b[0m` : '0 失败'}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error('测试运行器崩溃：', err); process.exit(1); });
