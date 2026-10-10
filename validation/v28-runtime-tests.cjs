'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const runtime = path.join(require('node:os').homedir(), '.ailiteracy-runtime', 'repl');
const skillEntry = path.join(require('node:os').homedir(), '.agents/skills/ai-literacy-search/scripts/browser.cjs');
const requireSkill = createRequire(skillEntry);
const skill = requireSkill(skillEntry);
const runDir = fs.mkdtempSync(path.join(__dirname, 'v28-runtime-run-'));
const daemon = fs.readFileSync(path.join(runtime, 'daemon.cjs'), 'utf8');
const parser = daemon.slice(daemon.indexOf('function statementSegments'), daemon.indexOf('async function execute'));
const planSource = vm.runInNewContext(parser + '\nplanSource;', { vm });
const prepare = fs.readFileSync(path.join(runtime, 'snippets', 'prepare.js'), 'utf8');
const bootstrap = fs.readFileSync(path.join(runtime, 'snippets', 'bootstrap.js'), 'utf8');
const report = { version: skill.VERSION, kind: 'Installed templates compiled with the actual persistent-daemon parser; test-owned visible Chrome, no daemon requests', tests: [] };
let live;
const context = vm.createContext({ skill, skillEntry, requireSkill, outputRoot: path.join(runDir, 'output'), DAEMON_DIR: runDir,
  structuredClone, console: { log() {} } });
fs.mkdirSync(path.join(runDir, 'snippets'));
fs.writeFileSync(path.join(runDir, 'snippets/bootstrap.js'), bootstrap);
const execute = code => new vm.Script(planSource(code)).runInContext(context);
async function test(name, fn) {
  try { await fn(); report.tests.push({ name, passed: true }); }
  catch (error) { report.tests.push({ name, passed: false, error: error.stack }); }
}
(async () => {
  try {
    await test('安装后的准备入口：一条请求初始化可见Chrome和247流程/6规则，只返回简短摘要', async () => {
      const summary = await execute(prepare); live = context.session;
      assert.equal(summary.status, 'ready'); assert.equal(summary.profiles_loaded, 247); assert.equal(summary.rules_loaded, 6);
      assert.equal(summary.browser_connected, true); assert.equal(summary.preflight_ran, false);
      assert.equal(live._launchCount, 1); assert.equal(live.context.pages().length, 1);
      assert.equal(live.context.pages()[0].url(), 'about:blank');
      assert.ok(JSON.stringify(summary).length < 1200); assert.equal(live.options.headless, false);
    });
    await test('连续准备及普通入口保持对象与连接；热准备没有再次读取引导脚本', async () => {
      const reads = [], original = fs.readFileSync;
      fs.readFileSync = function (file, ...args) { reads.push(String(file)); return original.call(this, file, ...args); };
      try {
        assert.equal((await execute(prepare)).status, 'ready'); assert.equal(reads.length, 0);
        assert.equal(context.session, live); assert.equal(live._launchCount, 1);
        const summary = await execute(bootstrap); assert.equal(summary.browser_connected, true);
        assert.equal(context.session, live); assert.equal(live._launchCount, 1);
      } finally { fs.readFileSync = original; }
    });
    await test('旧运行时在安装入口被明确拒绝，当前Chrome和会话不被替换', async () => {
      const current = context.skill;
      context.skill = { ...current, VERSION: '2.7.0' };
      try { await assert.rejects(execute(bootstrap), error => error.code === 'RELOAD_REQUIRED'); }
      finally { context.skill = current; }
      assert.equal(context.session, live); assert.equal(live.isBrowserConnected(), true); assert.equal(live._launchCount, 1);
    });
  } finally {
    await context.session?.close();
    report.passed = report.tests.filter(item => item.passed).length;
    report.failed = report.tests.length - report.passed;
    fs.writeFileSync(path.join(__dirname, 'v28-runtime-tests.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report)); process.exitCode = report.failed ? 1 : 0;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
