#!/usr/bin/env node
/**
 * Layer 3 verification: the real page, in a real browser, opened the way the
 * user opens it — from file://. Only a real browser enforces CORS, so this is
 * what proves the `Origin: null` path actually works.
 *
 *   node test/verify-ui.js
 *
 * Runs against the mock upstream so results are deterministic.
 */

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const { chromium } = require('playwright');

const NODE = process.execPath;
const ROOT = path.join(__dirname, '..');
const TOKEN_FILE = path.join(ROOT, '.token');
const PAGE = pathToFileURL(path.join(ROOT, 'public', 'index.html')).href;
const MOCK_PORT = 9911;
const SVC_PORT = 8790;
const DEAD_PORT = 8799; // nothing listens here
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const SHOTS = path.join(__dirname, 'screenshots');
// Deliberately unmistakable as a fake: this repo is public, and a string that
// merely looks like a token invites confusion (and secret-scanner noise).
const PAT = 'pt-FAKE-TEST-TOKEN-not-a-real-token';

// Where the service auto-saves what the agent produced, during this run only.
const DL_DIR = path.join(require('os').tmpdir(), `qoder-chat-ui-dl-${process.pid}`);

let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  \x1b[32mPASS\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? '  → ' + detail : ''}`); }
};
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

/** Bounded wait for a predicate evaluated in the page. Never hangs. */
async function until(page, fn, ms = 15000) {
  try { await page.waitForFunction(fn, null, { timeout: ms, polling: 120 }); return true; }
  catch { return false; }
}

// jsdom does no layout, so only a real browser catches the [hidden]-vs-display trap.
const shown = (page, id) =>
  page.evaluate((i) => getComputedStyle(document.getElementById(i)).display !== 'none', id);
const hidden = (page, id) =>
  page.evaluate((i) => getComputedStyle(document.getElementById(i)).display === 'none', id);

const setMode = (mode) => fetch(`${MOCK}/__mode`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }),
});
const resetMock = () => fetch(`${MOCK}/__reset`, { method: 'POST' });

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  try { fs.unlinkSync(TOKEN_FILE); } catch {}

  const mock = startProc('mock', [path.join('test', 'mock-upstream.js')], { MOCK_PORT });
  const svc = startProc('svc', ['server.js'], {
    PORT: SVC_PORT, QODER_API_BASE_OVERRIDE: MOCK, TURN_TIMEOUT_MS: 2500, QODER_PAT: '',
    // Auto-saved files go to a temp dir so a test run never writes into your project.
    DOWNLOAD_DIR: DL_DIR,
  });
  const cleanup = () => {
    try { mock.kill(); } catch {}
    try { svc.kill(); } catch {}
    try { fs.rmSync(DL_DIR, { recursive: true, force: true }); } catch {}
  };
  process.on('exit', cleanup);

  if (!(await waitFor(`${MOCK}/__mode`)) || !(await waitFor(`http://127.0.0.1:${SVC_PORT}/api/health`))) {
    console.log('服务未就绪，测试中止');
    cleanup();
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1120, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  [page error]', e.message));
  page.on('dialog', (d) => d.accept()); // the delete button asks for confirmation

  const url = (port) => `${PAGE}?api=http://127.0.0.1:${port}`;
  const rows = (sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);
  const names = (sel) => page.evaluate((s) =>
    Array.from(document.querySelectorAll(s)).map((n) => n.querySelector('.nm').textContent), sel);

  // ------------------------------------------------------ gate on first load
  console.log('\nfile:// 打开 · 要求先填令牌');
  {
    await page.goto(url(SVC_PORT), { waitUntil: 'load' });
    ok('显示令牌输入框', await shown(page, 'gate'));
    ok('对话区默认隐藏', await hidden(page, 'chat'));
    ok('配置面板默认隐藏', await hidden(page, 'setup'));
    ok('令牌输入框是密码类型',
      await page.evaluate(() => document.getElementById('pat').type === 'password'));
    ok('区域可选', await page.evaluate(() => document.getElementById('region').options.length >= 2));

    await page.screenshot({ path: path.join(SHOTS, '01-填写令牌.png') });
  }

  // ------------------------------------------------------------- bad token
  console.log('\n令牌被拒 · 停在输入框');
  {
    await setMode('reject_token');
    await page.fill('#pat', 'pt-wrong-region');
    await page.click('#connect');
    const errShown = await until(page, () => !document.getElementById('gateerr').hidden, 12000);
    ok('给出错误提示', errShown);
    const msg = errShown ? await page.textContent('#gateerr') : '';
    ok('提示指向区域或令牌', /区域|令牌/.test(msg), msg);
    ok('仍停在输入框', await shown(page, 'gate'));
    ok('没有进入对话界面', await hidden(page, 'chat'));
    ok('输入框内容保留（方便改正）', (await page.inputValue('#pat')) === 'pt-wrong-region');

    await page.screenshot({ path: path.join(SHOTS, '02-令牌错误.png') });
  }

  // ----------------------------------------------------------- good token
  console.log('\n填入正确 PAT · 进入对话');
  {
    await setMode('normal');
    await resetMock();
    await page.fill('#pat', PAT);
    await page.click('#connect');
    const entered = await until(page, () => !document.getElementById('chat').hidden, 15000);
    ok('连接后进入对话界面', entered, await page.textContent('#gateerr'));
    ok('输入区已隐藏', await hidden(page, 'gate'));
    ok('配置面板没有自己弹出来', await hidden(page, 'setup'));

    const badge = await page.textContent('#tokBadge');
    ok('顶部显示掩码令牌', /pt-moc/.test(badge) && /…/.test(badge), badge);
    ok('顶部不显示完整令牌', !badge.includes(PAT), badge);
    ok('顶部出现「配置」入口', await shown(page, 'setupBtn'));
    ok('令牌输入框已清空',
      await page.evaluate(() => document.getElementById('pat').value === ''));
    ok('agent 下拉已填充',
      await page.evaluate(() => document.getElementById('agentSel').options.length === 2));
    ok('environment 下拉已填充',
      await page.evaluate(() => document.getElementById('envSel').options.length === 2));

    const html = await page.content();
    ok('页面源码中不含令牌', !html.includes(PAT));

    await page.screenshot({ path: path.join(SHOTS, '03-已连接.png') });
  }

  // ------------------------------------------------------------ setup panel
  console.log('\n配置面板 · 模型清单与表单联动');
  {
    await page.click('#setupBtn');
    ok('配置面板打开了', await shown(page, 'setup'));
    ok('默认停在 Agent 标签', await shown(page, 'paneAgent'));
    ok('运行环境标签隐藏着', await hidden(page, 'paneEnv'));

    const loaded = await until(page, () => document.getElementById('agModel').options.length === 3, 12000);
    ok('模型下拉被真实清单填满', loaded,
      await page.evaluate(() => document.getElementById('agModel').options.length + ' 项'));
    ok('已有 Agent 列表列出了 2 个', (await rows('#agList .item')) === 2);
    ok('已有运行环境列表列出了 2 个', (await rows('#envList .item')) === 2);

    // qfmodel advertises effort levels + context windows: both pickers appear
    await page.selectOption('#agModel', 'qfmodel');
    ok('有档位的模型显示推理档位', await shown(page, 'agEffortWrap'));
    ok('档位下拉是真实的档位',
      await page.evaluate(() => Array.from(document.getElementById('agEffort').options).map((o) => o.value).join(',')) === 'low,medium,xhigh');
    ok('档位默认选中模型自己的默认值',
      (await page.inputValue('#agEffort')) === 'medium', await page.inputValue('#agEffort'));
    ok('显示上下文窗口选择', await shown(page, 'agCtxWrap'));
    ok('上下文窗口来自模型的能力',
      await page.evaluate(() => document.getElementById('agCtx').options.length === 3));
    ok('模型说明里写了 id 与输入上限',
      /qfmodel/.test(await page.textContent('#agModelMeta')) &&
      /180,000/.test(await page.textContent('#agModelMeta')),
      await page.textContent('#agModelMeta'));

    // auto has neither: both pickers must disappear rather than show empty boxes
    await page.selectOption('#agModel', 'auto');
    ok('没档位的模型隐藏档位选择', await hidden(page, 'agEffortWrap'));
    ok('没上下文列表的模型隐藏窗口选择', await hidden(page, 'agCtxWrap'));
    await page.selectOption('#agModel', 'qfmodel');

    ok('工具网格列出 11 个工具', (await rows('#agTools input')) === 11);
    ok('工具默认全选', (await rows('#agTools input:checked')) === 11);
    ok('工具带中文说明',
      (await page.textContent('#agTools')).includes('运行命令'),
      (await page.textContent('#agTools')).slice(0, 60));
    ok('工具计数显示 11/11', (await page.textContent('#agToolCount')) === '(11/11)');

    await page.click('#agAll');
    ok('「全不选」生效', (await rows('#agTools input:checked')) === 0);
    ok('计数跟着归零', (await page.textContent('#agToolCount')) === '(0/11)');
    await page.click('#agAll');
    ok('再点一次恢复全选', (await rows('#agTools input:checked')) === 11);

    // the doc's own step-1 payload, one click
    await page.click('#agPreset');
    ok('预设填入文档里的名字', (await page.inputValue('#agName')) === 'test');
    ok('预设选中文档里的模型', (await page.inputValue('#agModel')) === 'q37fmodel');
    ok('预设的上下文窗口是 200k', (await page.inputValue('#agCtx')) === '200000', await page.inputValue('#agCtx'));
    ok('预设的系统提示词来自文档',
      (await page.inputValue('#agSystem')).includes('通用助手'),
      (await page.inputValue('#agSystem')).slice(0, 40));

    await page.screenshot({ path: path.join(SHOTS, '04-配置面板.png') });
  }

  // ----------------------------------------------------------- create agent
  console.log('\n在页面上创建 Agent');
  {
    await page.fill('#agName', 'UI 创建的 Agent');
    await page.fill('#agDesc', '来自浏览器验证');
    await page.fill('#agSystem', '你是 UI 测试助手。');
    await page.selectOption('#agModel', 'qfmodel');
    await page.selectOption('#agEffort', 'low');
    await page.selectOption('#agCtx', '400000');
    await page.evaluate(() => {
      const i = document.querySelector('#agTools input[value="WebFetch"]');
      i.checked = false; i.dispatchEvent(new Event('change'));
    });
    ok('取消勾选后计数变 10/11', (await page.textContent('#agToolCount')) === '(10/11)');

    await page.click('#agCreate');
    const created = await until(page, () => {
      const n = document.getElementById('agNotice');
      return !n.hidden && n.textContent.includes('已创建');
    }, 15000);
    ok('页面给出创建成功提示', created, await page.textContent('#agNotice'));
    ok('提示里说明已自动选中',
      /自动选为当前/.test(await page.textContent('#agNotice')), await page.textContent('#agNotice'));

    ok('Agent 列表变成 3 个', (await rows('#agList .item')) === 3);
    ok('新 Agent 出现在列表里',
      (await names('#agList .item')).includes('UI 创建的 Agent'), JSON.stringify(await names('#agList .item')));
    ok('列表里标出「使用中」',
      (await page.textContent('#agList')).includes('使用中'), (await page.textContent('#agList')).slice(0, 200));
    ok('顶部下拉跟着更新',
      await page.evaluate(() => document.getElementById('agentSel').options.length === 3));
    ok('新建的 Agent 是当前选中的',
      await page.evaluate(() => document.getElementById('agentSel').selectedOptions[0].textContent === 'UI 创建的 Agent'),
      await page.evaluate(() => document.getElementById('agentSel').selectedOptions[0].textContent));
    ok('名字输入框被清空', (await page.inputValue('#agName')) === '');
    ok('新 Agent 的模型/档位写进了列表',
      (await page.textContent('#agList')).includes('qfmodel') &&
      (await page.textContent('#agList')).includes('档位 low'),
      (await page.textContent('#agList')).slice(0, 200));
  }

  // ------------------------------------------------------------ create env
  console.log('\n在页面上创建运行环境');
  {
    await page.click('#tabEnv');
    ok('切到运行环境标签', await shown(page, 'paneEnv'));
    ok('Agent 标签内容隐藏', await hidden(page, 'paneAgent'));
    ok('网络策略下拉是三个合法值',
      await page.evaluate(() => Array.from(document.getElementById('envNet').options).map((o) => o.value).join(','))
        === 'unrestricted,limited,allowed_hosts');
    ok('默认不受限', (await page.inputValue('#envNet')) === 'unrestricted');
    ok('不受限时不显示主机输入框', await hidden(page, 'envHostsWrap'));

    await page.selectOption('#envNet', 'allowed_hosts');
    ok('选了指定主机才出现输入框', await shown(page, 'envHostsWrap'));

    await page.fill('#envName', 'UI 创建的环境');
    await page.click('#envCreate');
    const failed = await until(page, () => {
      const n = document.getElementById('envNotice');
      return !n.hidden && n.classList.contains('bad');
    }, 12000);
    ok('一个主机都不填时页面给出错误', failed, await page.textContent('#envNotice'));
    ok('错误说清了缺什么', /主机/.test(await page.textContent('#envNotice')), await page.textContent('#envNotice'));

    await page.fill('#envHosts', 'api.example.com\n');
    await page.selectOption('#envNet', 'unrestricted');
    await page.click('#envCreate');
    const madeEnv = await until(page, () => {
      const n = document.getElementById('envNotice');
      return !n.hidden && n.textContent.includes('已创建');
    }, 15000);
    ok('创建运行环境成功', madeEnv, await page.textContent('#envNotice'));
    ok('运行环境列表变成 3 个', (await rows('#envList .item')) === 3);
    ok('新环境在列表里',
      (await names('#envList .item')).includes('UI 创建的环境'), JSON.stringify(await names('#envList .item')));
    ok('顶部环境下拉跟着更新',
      await page.evaluate(() => document.getElementById('envSel').options.length === 3));

    await page.screenshot({ path: path.join(SHOTS, '05-创建完成.png') });
  }

  // -------------------------------------------------- upstream says no
  console.log('\n上游拒绝创建时 · 页面照原样显示上游的理由');
  {
    await setMode('create_fail');
    await page.click('#tabAgent');
    await page.fill('#agName', '会被上游拒的');
    await page.click('#agCreate');
    const shown2 = await until(page, () => {
      const n = document.getElementById('agNotice');
      return !n.hidden && n.classList.contains('bad');
    }, 12000);
    ok('页面显示上游给出的原因', shown2, await page.textContent('#agNotice'));
    ok('原因是上游原文',
      /must be one of/.test(await page.textContent('#agNotice')), await page.textContent('#agNotice'));
    ok('失败后列表没变', (await rows('#agList .item')) === 3);
    ok('名字还在输入框里（方便改）', (await page.inputValue('#agName')) === '会被上游拒的');
    await setMode('normal');
    await page.fill('#agName', '');
  }

  // -------------------------------------------------------------- delete
  console.log('\n在页面上删除自己刚建的东西');
  {
    const before = await rows('#agList .item');
    await page.evaluate(() => {
      const rowsArr = Array.from(document.querySelectorAll('#agList .item'));
      const target = rowsArr.find((r) => r.querySelector('.nm').textContent === 'UI 创建的 Agent');
      target.querySelector('button.danger').click();
    });
    const gone = await until(page, () => document.querySelectorAll('#agList .item').length < 3, 12000);
    ok('删除后列表少了一个', gone, (await rows('#agList .item')) + ' 个');
    ok('列表变成 ' + (before - 1) + ' 个', (await rows('#agList .item')) === before - 1);
    ok('删掉的确实不在列表里',
      !(await names('#agList .item')).includes('UI 创建的 Agent'));
    ok('当前选中的 Agent 被换掉了',
      await page.evaluate(() => document.getElementById('agentSel').selectedOptions[0].textContent !== 'UI 创建的 Agent'));
  }

  // --------------------------------------------- environment still in use
  console.log('\n环境还被会话占用 · 页面得给出归档这条路');
  {
    await setMode('env_in_use');
    await page.click('#tabEnv');
    const before = await rows('#envList .item');
    await page.evaluate(() => {
      const list = Array.from(document.querySelectorAll('#envList .item'));
      const target = list.find((r) => r.querySelector('.nm').textContent === 'mock-env-1');
      target.querySelector('button.danger').click();
    });
    const warned = await until(page, () => {
      const n = document.getElementById('envNotice');
      return !n.hidden && n.classList.contains('warn');
    }, 15000);
    ok('页面没有假装删成功，而是给出警告', warned, await page.textContent('#envNotice'));
    const note = await page.textContent('#envNotice');
    ok('说清了是被对话会话占着', /会话引用/.test(note), note.slice(0, 120));
    ok('原样附上上游的原文', /is in use/.test(note), note.slice(0, 200));
    ok('列表没有变', (await rows('#envList .item')) === before);
    ok('给出了「改为归档」按钮',
      await page.evaluate(() => !!document.querySelector('#envNotice .acts button')),
      await page.evaluate(() => document.getElementById('envNotice').innerHTML.slice(0, 200)));

    await page.screenshot({ path: path.join(SHOTS, '06-环境被占用.png') });

    await page.evaluate(() => document.querySelector('#envNotice .acts button').click());
    const archived = await until(page, () => {
      const n = document.getElementById('envNotice');
      return !n.hidden && n.textContent.includes('已归档');
    }, 15000);
    ok('归档成功', archived, await page.textContent('#envNotice'));
    ok('归档后列表少了一个', (await rows('#envList .item')) === before - 1);
    ok('被归档的不在列表里',
      !(await names('#envList .item')).includes('mock-env-1'), JSON.stringify(await names('#envList .item')));
    ok('提示说明了归档的含义',
      /记录仍保留/.test(await page.textContent('#envNotice')), await page.textContent('#envNotice'));

    await setMode('normal');
  }

  // ----------------------------------------------------------------- chat
  console.log('\n关闭配置面板后对话');
  {
    await page.click('#setupClose');
    ok('配置面板关掉了', await hidden(page, 'setup'));

    await page.fill('#q', '你是谁？');
    await page.click('#send');

    const got = await until(page, () => {
      const b = Array.from(document.querySelectorAll('.row.bot .bubble'));
      return b.some((e) => e.textContent.includes('Mock Agent'));
    }, 20000);
    ok('页面上出现了回答', got);

    ok('用户消息已上屏',
      (await page.evaluate(() => document.querySelector('.row.me .bubble').textContent)) === '你是谁？');

    // Wait for the turn to close, not just for text — otherwise later
    // assertions race the stream.
    const done = await until(page, () => document.getElementById('status').textContent.includes('完成'), 20000);
    ok('状态显示完成', done, await page.textContent('#status'));
    ok('停止按钮回到隐藏', await hidden(page, 'stop'));

    await page.screenshot({ path: path.join(SHOTS, '07-正常对话.png') });
  }

  // ------------------------------------------------ files the agent produced
  console.log('\nAgent 产出的文件：卡片渲染 + 点击真的下载');
  {
    const shown = await until(page, () => document.querySelectorAll('.file').length > 0, 20000);
    ok('对话里自动出现文件卡片', shown, shown ? '' : '没等到 .file 元素');

    ok('显示文件名',
      (await page.textContent('.file .fname')).includes('mock-artifact.txt'),
      await page.textContent('.file .fname'));
    ok('显示文件大小',
      /\d+\s?B|\d+\.\d\s?KB/.test(await page.textContent('.file .fmeta')),
      await page.textContent('.file .fmeta'));
    ok('提示文件已自动存进项目子目录',
      /已自动存进/.test(await page.textContent('.files-h')),
      await page.textContent('.files-h'));

    const href = await page.getAttribute('.file .dl', 'href');
    ok('下载链接指向本机服务', /\/api\/files\/download\?id=/.test(href || ''), href);
    ok('链接带 download 属性',
      (await page.getAttribute('.file .dl', 'download')) === 'mock-artifact.txt',
      await page.getAttribute('.file .dl', 'download'));

    await page.screenshot({ path: path.join(SHOTS, '07b-文件卡片.png') });

    // Click it — the browser must receive a real attachment, not navigate.
    let download = null;
    try {
      [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 20000 }),
        page.click('.file .dl'),
      ]);
    } catch (e) { /* asserted below */ }

    ok('点击后真的触发下载', Boolean(download));
    // A cross-origin <a download> is not honoured, so if the service ever lost
    // its Content-Disposition this click would navigate the page away instead.
    ok('点击下载后页面没有被导航走', page.url().startsWith('file:'), page.url());
    if (download) {
      ok('保存的文件名就是原文件名',
        download.suggestedFilename() === 'mock-artifact.txt', download.suggestedFilename());
      const savedTo = path.join(require('os').tmpdir(), `qoder-dl-${Date.now()}.txt`);
      await download.saveAs(savedTo);
      const saved = fs.readFileSync(savedTo, 'utf8');
      ok('下载到本地的内容和上游一致',
        saved === 'hello from the mock upstream\n', JSON.stringify(saved));
      fs.unlinkSync(savedTo);
    }
  }

  // ------------------------------------------------ attach a file for the agent
  console.log('\n把本地文件交给 Agent 读');
  {
    const tmpFile = path.join(require('os').tmpdir(), 'qoder-attach-notes.txt');
    fs.writeFileSync(tmpFile, '这是要交给 Agent 看的笔记\n');

    await page.setInputFiles('#picker', tmpFile);
    const chip = await until(page, () => document.querySelectorAll('#attach .chip').length === 1, 12000);
    ok('选完文件出现附件条', chip);
    ok('附件条显示文件名',
      (await page.textContent('#attach .chip .cn')).includes('qoder-attach-notes.txt'),
      await page.textContent('#attach .chip .cn'));
    ok('文本文件被识别为「正文」',
      (await page.textContent('#attach .chip .cs')) === '正文',
      await page.textContent('#attach .chip .cs'));

    await page.fill('#q', '读一下这个');
    await page.click('#send');

    const shown = await until(page, () => {
      const rows = document.querySelectorAll('.row.me .bubble');
      const last = rows[rows.length - 1];
      return Boolean(last && last.textContent.includes('qoder-attach-notes.txt'));
    }, 15000);
    ok('我发出的气泡里列出了附件名', shown);

    const done = await until(page, () => document.getElementById('status').textContent.includes('完成'), 30000);
    ok('带附件这一轮正常结束', done, await page.textContent('#status'));
    // clearAttach() runs after ask() returns, which is slightly later than the
    // status line showing "完成" — so poll instead of asserting immediately.
    const cleared = await until(page, () => document.querySelectorAll('#attach .chip').length === 0, 15000);
    ok('发完附件条自动清空', cleared);

    await page.screenshot({ path: path.join(SHOTS, '07c-带附件对话.png') });
    fs.unlinkSync(tmpFile);
  }

  // -------------------------------------------------------- switch agent
  console.log('\n切换 Agent 会重置会话');
  {
    await page.selectOption('#agentSel', 'agent_mock_2');
    const cleared = await until(page, () => document.querySelectorAll('.row').length === 0, 5000);
    ok('切换后清空消息', cleared);
    ok('提示会话已重置', /重置/.test(await page.textContent('#status')), await page.textContent('#status'));
  }

  // ------------------------------------------------------- brand new account
  console.log('\n全新账号 · 连上就被引导去创建');
  {
    await setMode('empty_account');
    await resetMock();
    await page.click('#disconnect');
    await until(page, () => !document.getElementById('gate').hidden, 10000);
    await page.fill('#pat', PAT);
    await page.click('#connect');

    const auto = await until(page, () => !document.getElementById('setup').hidden, 15000);
    ok('缺配置时配置面板自动弹出', auto, await page.textContent('#gateerr'));
    ok('面板顶部说明了缺什么',
      /还缺/.test(await page.textContent('#setupNote')), await page.textContent('#setupNote'));
    ok('两个列表都是空的', (await rows('#agList .item')) === 0 && (await rows('#envList .item')) === 0);
    ok('空列表有占位说明',
      (await page.textContent('#agList')).includes('还没有'), (await page.textContent('#agList')).slice(0, 60));
    ok('输入框被禁用（还没配好）',
      await page.evaluate(() => document.getElementById('q').disabled === true));
    ok('发送按钮被禁用',
      await page.evaluate(() => document.getElementById('send').disabled === true));
    ok('对话区提示还差一步',
      (await page.textContent('#empty')).includes('还差一步'), await page.textContent('#empty'));

    await page.screenshot({ path: path.join(SHOTS, '08-空账号引导.png') });

    await page.fill('#agName', '第一个 Agent');
    await page.click('#agCreate');
    await until(page, () => document.querySelectorAll('#agList .item').length === 1, 12000);
    ok('建完 Agent 后列表有 1 个', (await rows('#agList .item')) === 1);
    ok('只建了 Agent 还禁着输入框',
      await page.evaluate(() => document.getElementById('q').disabled === true));
    ok('提示缺少运行环境',
      /运行环境/.test(await page.textContent('#setupNote')), await page.textContent('#setupNote'));

    await page.click('#tabEnv');
    await page.fill('#envName', '第一个环境');
    await page.click('#envCreate');
    const ready = await until(page, () => document.getElementById('q').disabled === false, 15000);
    ok('两样都建好后输入框解锁', ready, await page.textContent('#envNotice'));
    ok('发送按钮可用',
      await page.evaluate(() => document.getElementById('send').disabled === false));
    const st = await page.textContent('#status');
    ok('状态栏给出成功反馈', /已创建运行环境/.test(st), st);
    ok('状态栏不是报错样式',
      await page.evaluate(() => !document.getElementById('status').classList.contains('err')));

    await page.click('#setupClose');
    await page.fill('#q', '现在能聊了吗？');
    await page.click('#send');
    const chatted = await until(page, () => {
      const b = Array.from(document.querySelectorAll('.row.bot .bubble'));
      return b.some((e) => e.textContent.includes('Mock Agent'));
    }, 20000);
    ok('建完立刻就能对话', chatted);
    await setMode('normal');
  }

  // ------------------------------------------------------------ disconnect
  console.log('\n断开 · 回到输入框');
  {
    await page.click('#disconnect');
    const back = await until(page, () => !document.getElementById('gate').hidden, 10000);
    ok('断开后回到令牌输入框', back);
    ok('对话区隐藏', await hidden(page, 'chat'));
    ok('配置面板隐藏', await hidden(page, 'setup'));
    ok('顶部令牌徽标消失', await hidden(page, 'tokBadge'));
    ok('「配置」入口消失', await hidden(page, 'setupBtn'));
    ok('已保存的 .token 被清除', !fs.existsSync(TOKEN_FILE));
  }

  // -------------------------------------------------------- service down
  console.log('\n服务未启动');
  {
    await page.goto(url(DEAD_PORT), { waitUntil: 'load' });
    const warned = await until(page, () => !document.getElementById('gateerr').hidden, 10000);
    ok('提示连不上本地服务', warned, await page.textContent('#gateerr'));
    ok('指示灯变红',
      await page.evaluate(() => document.getElementById('dot').className.includes('bad')));

    await page.fill('#pat', 'pt-anything');
    await page.click('#connect');
    await sleep(900);
    ok('仍停在输入框', await shown(page, 'gate'));

    await page.screenshot({ path: path.join(SHOTS, '09-服务未启动.png') });
  }

  await browser.close();
  cleanup();
  await sleep(150);

  console.log(`\n结果：\x1b[32m${passed} 通过\x1b[0m，${failed ? `\x1b[31m${failed} 失败\x1b[0m` : '0 失败'}`);
  console.log(`截图：${SHOTS}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error('验证器崩溃：', err); process.exit(1); });
