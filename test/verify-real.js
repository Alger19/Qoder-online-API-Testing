#!/usr/bin/env node
/**
 * Live smoke test against the REAL Qoder upstream, driving the real page in a
 * real browser — the same path a person takes: open the page, type the PAT,
 * click 连接, create an Agent and an environment, then send a message.
 *
 *   QODER_PAT=pt-… node test/verify-real.js
 *   QODER_PAT=pt-… REGION=global node test/verify-real.js
 *   QODER_PAT=pt-… KEEP=1 node test/verify-real.js     # 不清理创建出来的资源
 *
 * The token is read from the environment and never printed. Anything this
 * script creates, it deletes again on the way out — unless KEEP=1.
 *
 * The upstream provider is sometimes overloaded, so a turn may take a while or
 * fail with a retry notice — this script reports exactly what happened instead
 * of hiding it.
 */

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const { chromium } = require('playwright');

const NODE = process.execPath;
const ROOT = path.join(__dirname, '..');
const PAGE = pathToFileURL(path.join(ROOT, 'public', 'index.html')).href;
const SHOTS = path.join(__dirname, 'screenshots');
const PORT = Number(process.env.PORT || 8787);
const SVC = `http://127.0.0.1:${PORT}`;
const REGION = process.env.REGION || 'cn';
const QUESTION = process.env.QUESTION || '你好，告诉我你能做什么。';
const TURN_WAIT_MS = Number(process.env.TURN_WAIT_MS || 150000);
const KEEP = process.env.KEEP === '1';
const TAG = process.env.TAG || `本地网页 demo ${new Date().toISOString().slice(5, 16).replace('T', ' ')}`;

const PAT = process.env.QODER_PAT || process.env.QODER_ACCESS_TOKEN
  || (() => {
    try { return JSON.parse(fs.readFileSync(path.join(ROOT, '.token'), 'utf8')).pat; } catch { return ''; }
  })();

if (!PAT) {
  console.error('缺少令牌。用法：QODER_PAT=pt-… node test/verify-real.js');
  process.exit(2);
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

async function until(page, fn, ms) {
  try { await page.waitForFunction(fn, null, { timeout: ms, polling: 200 }); return true; }
  catch { return false; }
}

const svcJson = async (p, init) => {
  const r = await fetch(`${SVC}${p}`, Object.assign({ headers: { Origin: 'null' } }, init || {}));
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

/**
 * Upstream refuses to delete an environment while any session references it —
 * and every conversation we had created one. Drop those sessions first. They
 * are conversation containers this very run produced, so removing them is safe.
 *
 * A session left mid-retry by an overloaded provider answers 409 ("Version or
 * state conflict"); we wait and try once more, then give up gracefully.
 */
async function dropSessionsUsing(envId) {
  const base = REGION === 'global' ? 'https://api.qoder.com' : 'https://api.qoder.com.cn';
  const h = { Authorization: `Bearer ${PAT}` };
  let ids = [];
  try {
    const j = await (await fetch(`${base}/api/v1/cloud/sessions`, { headers: h })).json();
    ids = (j.data || []).filter((s) => s.environment_id === envId).map((s) => s.id);
  } catch { return 0; }

  for (const id of ids) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = await fetch(`${base}/api/v1/cloud/sessions/${id}`, { method: 'DELETE', headers: h });
      if (r.ok) break;
      await sleep(2000 * attempt);
    }
  }
  return ids.length;
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const made = { agentId: '', envId: '' };

  // Start with no token: the page must be the one that supplies it.
  const svc = spawn(NODE, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), QODER_PAT: '', QODER_ACCESS_TOKEN: '' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  svc.stdout.on('data', (d) => process.stdout.write(`  [svc] ${d}`));
  svc.stderr.on('data', (d) => process.stderr.write(`  [svc] ${d}`));
  const cleanup = () => { try { svc.kill(); } catch {} };
  process.on('exit', cleanup);

  if (!(await waitFor(`${SVC}/api/health`))) {
    console.log('本地服务未启动');
    cleanup();
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newContext({ viewport: { width: 1120, height: 900 } }).then((c) => c.newPage());
  page.on('pageerror', (e) => console.log('  [page error]', e.message));
  page.on('dialog', (d) => d.accept());

  let failed = false;

  try {
    await page.goto(`${PAGE}?api=${SVC}`, { waitUntil: 'load' });
    await until(page, () => !document.getElementById('gate').hidden, 8000);
    console.log(`1. 页面已打开，等待输入令牌（区域：${REGION}）`);

    await page.selectOption('#region', REGION);
    await page.fill('#pat', PAT);              // typed in, exactly like a person
    await page.click('#connect');

    const entered = await until(page, () => !document.getElementById('chat').hidden, 40000);
    if (!entered) {
      const err = await page.textContent('#gateerr').catch(() => '');
      console.log(`2. 连接失败：${err}`);
      await page.screenshot({ path: path.join(SHOTS, 'live-连接失败.png') });
      failed = true;
      throw new Error('connect failed');
    }

    const badge = await page.textContent('#tokBadge');
    console.log(`2. 连接成功 · ${badge.trim()}`);
    const h = await svcJson('/api/health');
    console.log(`   账号里已有 Agent ${h.body.agents.length} 个、运行环境 ${h.body.environments.length} 个`);
    await page.screenshot({ path: path.join(SHOTS, 'live-已连接.png') });

    // ---------------------------------------------------------- model list
    console.log('3. 打开配置面板，读真实模型清单…');
    await page.click('#setupBtn');
    const gotModels = await until(page, () => document.getElementById('agModel').options.length > 2, 25000);
    if (!gotModels) {
      console.log('   拿不到模型清单');
      failed = true;
      throw new Error('no catalog');
    }
    const models = await page.$$eval('#agModel option', (os) => os.map((o) => o.textContent.trim()));
    console.log(`   模型 ${models.length} 个：${models.slice(0, 6).join('、')}${models.length > 6 ? ' …' : ''}`);
    const toolCount = await page.$$eval('#agTools input', (is) => is.length);
    console.log(`   工具 ${toolCount} 个`);

    // -------------------------------------------------------- create agent
    console.log(`4. 创建 Agent「${TAG}」…`);
    await page.fill('#agName', TAG);
    await page.fill('#agDesc', '由本地网页 demo 的真实链路验证创建，脚本结束时会自动删除。');
    await page.selectOption('#agModel', 'qfmodel');
    await page.evaluate(() => { const s = document.getElementById('agEffort'); if (s.options.length) s.value = 'low'; });
    await page.click('#agCreate');
    const agentMade = await until(page, () => {
      const n = document.getElementById('agNotice');
      return !n.hidden && n.textContent.includes('已创建');
    }, 40000);
    if (!agentMade) {
      console.log(`   创建失败：${await page.textContent('#agNotice')}`);
      failed = true;
      throw new Error('agent create failed');
    }
    const afterAgent = await svcJson('/api/health');
    made.agentId = (afterAgent.body.agents.find((a) => a.name === TAG) || {}).id || '';
    console.log(`   成功 · id=${made.agentId} · 已被自动选为当前 Agent=${afterAgent.body.agent === made.agentId}`);

    // ---------------------------------------------------- create environment
    const envName = `${TAG} env`;
    console.log(`5. 创建运行环境「${envName}」…`);
    await page.click('#tabEnv');
    await page.fill('#envName', envName);
    await page.click('#envCreate');
    const envMade = await until(page, () => {
      const n = document.getElementById('envNotice');
      return !n.hidden && n.textContent.includes('已创建');
    }, 40000);
    if (!envMade) {
      console.log(`   创建失败：${await page.textContent('#envNotice')}`);
      failed = true;
      throw new Error('environment create failed');
    }
    const afterEnv = await svcJson('/api/health');
    made.envId = (afterEnv.body.environments.find((e) => e.name === envName) || {}).id || '';
    console.log(`   成功 · id=${made.envId} · ready=${afterEnv.body.ready}`);
    await page.screenshot({ path: path.join(SHOTS, 'live-创建完成.png') });

    // --------------------------------------------------------------- chat
    await page.click('#setupClose');
    console.log(`6. 发送「${QUESTION}」，等待回答（最多 ${Math.round(TURN_WAIT_MS / 1000)} 秒）…`);
    const t0 = Date.now();
    await page.fill('#q', QUESTION);
    await page.click('#send');

    const answered = await until(page, () => {
      const b = Array.from(document.querySelectorAll('.row.bot .bubble'));
      const last = b[b.length - 1];
      if (!last) return false;
      const t = last.textContent.trim();
      if (!t || t === '…') return false;
      // An abort / error bubble is not an answer — don't count it as one.
      if (last.classList.contains('err')) return false;
      if (/已停止|已中断|等待超时/.test(t)) return false;
      return true;
    }, TURN_WAIT_MS);

    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const answer = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.row.bot .bubble')).pop();
      return b ? b.textContent.trim() : '';
    });
    const isErr = await page.evaluate(() => !!document.querySelector('.row.bot .bubble.err'));
    const statusText = await page.textContent('#status');
    await page.screenshot({ path: path.join(SHOTS, 'live-对话结果.png') });

    console.log(`7. ${answered ? '收到内容' : '没有收到内容'} · 用时 ${secs}s · 状态：${statusText}`);
    if (answer) console.log(`   回答：${answer.slice(0, 300)}`);
    console.log(`   结果：${isErr ? '失败（错误气泡）' : answered ? '成功' : '超时'}`);
    if (isErr || !answered) failed = true;
  } catch (err) {
    if (!failed) { console.log('   中断：' + err.message); failed = true; }
  } finally {
    // ------------------------------------------------------------- cleanup
    if (made.agentId || made.envId) {
      if (KEEP) {
        console.log(`8. 按 KEEP=1 保留：agent=${made.agentId} env=${made.envId}`);
      } else {
        console.log('8. 清理这次创建的资源…');
        let leftover = false;

        if (made.agentId) {
          const r = await svcJson(`/api/agents?id=${encodeURIComponent(made.agentId)}`, { method: 'DELETE' });
          console.log(`   删除 Agent ${made.agentId} → HTTP ${r.status}${r.body.code ? ' ' + r.body.message : ''}`);
          if (r.status !== 200) leftover = true;
        }

        if (made.envId) {
          let r = await svcJson(`/api/environments?id=${encodeURIComponent(made.envId)}`, { method: 'DELETE' });
          console.log(`   删除运行环境 ${made.envId} → HTTP ${r.status}${r.body.code ? ' ' + r.body.code : ''}`);

          if (r.status === 409 && r.body.code === 'in_use') {
            // Expected: our own conversation session pins it. Clear that, retry.
            console.log(`   它还被 ${r.body.sessions} 个会话引用着 —— 先删掉这些会话再试`);
            const n = await dropSessionsUsing(made.envId);
            console.log(`   已请求删除 ${n} 个会话`);
            r = await svcJson(`/api/environments?id=${encodeURIComponent(made.envId)}`, { method: 'DELETE' });
            console.log(`   再次删除运行环境 → HTTP ${r.status}${r.body.code ? ' ' + r.body.code : ''}`);
          }

          if (r.status !== 200) {
            const a = await svcJson('/api/environments/archive', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Origin: 'null' },
              body: JSON.stringify({ id: made.envId }),
            });
            console.log(`   仍删不掉，改为归档 → HTTP ${a.status}`);
            if (a.status !== 200) {
              console.log(`   归档也没成功：${a.body.message || ''}`);
              leftover = true;
            } else {
              console.log('   已归档：不再出现在列表里，记录仍在（上游在会话引用期间不允许硬删）');
            }
          }
        }

        const left = await svcJson('/api/health');
        const stillAgent = left.body.agents.some((a) => a.name === TAG);
        const stillEnv = left.body.environments.some((e) => e.name === `${TAG} env`);
        console.log(`   账号恢复原样：Agent ${left.body.agents.length} 个、运行环境 ${left.body.environments.length} 个` +
          (stillAgent || stillEnv ? ' —— 仍有残留，请人工检查' : '（列表里已无残留）'));
        if (stillAgent || stillEnv || leftover) failed = true;
      }
    }
    await browser.close();
    cleanup();
    await sleep(150);
    console.log(`\n结果：${failed ? '未完全通过' : '全部通过'}`);
    process.exit(failed ? 1 : 0);
  }
}

main().catch((err) => { console.error('验证器崩溃：', err); process.exit(1); });
