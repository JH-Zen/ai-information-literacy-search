#!/usr/bin/env node
'use strict';

// Real headed Google Chrome, isolated managed assets/profile and local HTTP only.
// Preparation is measured separately from answering; these timings never enter
// answer payloads and are not a claim about Codex or public-site latency.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const { performance } = require('node:perf_hooks');
const os = require('node:os');

const originalRoot = path.resolve(__dirname, '../ai-literacy-search');
const runDir = fs.mkdtempSync(path.join(__dirname, 'v28-prepare-run-'));
const copiedRoot = path.join(runDir, 'managed-skill');
for (const directory of ['scripts', 'references', 'runtime']) fs.cpSync(path.join(originalRoot, directory), path.join(copiedRoot, directory), { recursive: true });
const { SearchSession, VERSION } = require(path.join(copiedRoot, 'scripts/browser.cjs'));
const indexed = JSON.parse(fs.readFileSync(path.join(copiedRoot, 'references/search-index.json'), 'utf8'));
const rules = JSON.parse(fs.readFileSync(path.join(copiedRoot, 'references/rules.json'), 'utf8'));
const runtimeDir = process.env.AI_LITERACY_RUNTIME_DIR || path.join(os.homedir(), '.ailiteracy-runtime');
const runtimeRequire = createRequire(path.join(runtimeDir, 'package.json'));
const chromium = runtimeRequire('playwright').chromium;
const launchOriginal = chromium.launchPersistentContext;
let launchCount = 0;
chromium.launchPersistentContext = function (...args) { launchCount++; return launchOriginal.apply(this, args); };
const report = { started_at: new Date().toISOString(), helper_version: VERSION, run_dir: runDir,
  kind: 'real visible Google Chrome, test-owned persistent profiles, local HTTP fixtures, isolated managed asset mutation', tests: [] };
const sessions = [], requests = [];
let server, baseURL, sequence = 0, prepared;

async function test(name, fn) {
  try { const detail = await fn(); report.tests.push({ name, passed: true, ...(detail ? { detail } : {}) }); process.stdout.write(`PASS ${name}\n`); }
  catch (error) { report.tests.push({ name, passed: false, error: error.stack || String(error) }); process.stdout.write(`FAIL ${name}: ${error.message}\n`); }
}
const fixtureSource = () => ({ id: 'fixture', name: '本地官方检索测试', url: baseURL + '/entry', domains: ['127.0.0.1'] });
function options(id, extra = {}) {
  const outputDir = path.join(runDir, id);
  return { sessionId: id, outputDir, profileDir: path.join(outputDir, 'profile'), runtimeDir,
    catalog: { sources: [fixtureSource()] }, recipeIndex: indexed, navigationTimeoutMs: 5000, ...extra };
}
function newSession(id = `prepare-${++sequence}`, extra = {}) {
  const created = new SearchSession(options(id, extra)); sessions.push(created); return created;
}
function question(id, optionText = { A: '交集', B: '并集' }) {
  return { id, type: 'single', question: '一般布尔检索中的AND运算取两个集合的什么部分？', options: optionText };
}
function proposed(q, labels, sources) {
  return { id: q.id, type: q.type, question: q.question, status: 'verified', answer_labels: labels,
    answer: labels.map(label => q.options[label]), explanation: '当前题干与实际证据支持选择的文字。',
    option_evaluations: Object.entries(q.options).map(([label, text]) => ({ label, text, verdict: labels.includes(label) ? 'supported' : 'refuted', reason: '根据当前题目逐项核验。' })),
    sources, needs_review: [], searched_at: new Date().toISOString() };
}
function trackedAssetReads(fn) {
  const original = fs.readFileSync, reads = [];
  fs.readFileSync = function (file, ...rest) {
    if (typeof file === 'string' && (file.includes(path.join('references', 'sites')) || file.includes(path.join('references', 'rule-evidence')) || file === path.join(copiedRoot, 'references/rules.json'))) reads.push(file);
    return original.call(this, file, ...rest);
  };
  try { const result = fn(); return { result, reads }; } finally { fs.readFileSync = original; }
}
function writeJSON(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); }
function recipe() {
  return { id: 'fixture:lookup', source_id: 'fixture', status: 'query_verified', entry_url: baseURL + '/entry',
    transitions: { results: { mode: 'same-page', container: { css: '#results' }, ready: { css: '#results[data-complete="true"]' }, match: { css: '#query-echo', match: 'contains' }, timeoutMs: 1500 } },
    execution: { version: 1, queryMode: 'literal', resetEntry: true, parameters: { query: { type: 'string', required: true } },
      prepare: [{ action: 'fill', locator: { role: 'searchbox', name: '题名', exact: true }, parameter: 'query' }],
      submit: { action: 'click', locator: { role: 'button', name: '检索', exact: true } }, echoParameters: ['query'] } };
}
async function runQuery(created, id, query) {
  const q = { id, type: 'single', question: `检索题名“${query}”的记录，标识是什么？`, options: { A: 'LIVE-2026', B: 'OLD-1999' } };
  const result = await created.runSearch(q, { recipeId: 'fixture:lookup', parameters: { query }, parameterQuotes: { query } });
  assert.equal(result.status, 'ready'); assert.equal(result.outcome, 'results');
  const saved = created.saveAnswer(q, proposed(q, ['A'], result.sources));
  assert.equal(saved.answer.status, 'verified'); return saved;
}

async function main() {
  await test('未准备的题内计算不启动Chrome，不输出计时或证据文件', async () => {
    const created = newSession('calculation-only'), beforeLaunch = launchCount, beforeRequests = requests.length;
    const q = { id: 'calculation-new', type: 'single', question: '实际相关文献总数为180篇，检索得到90篇，其中相关文献为72篇。查准率是多少？', options: { A: '40%', B: '80%' } };
    created.beginQuestion(q);
    const computed = created.calculate(q, { operation: 'retrieval-metrics', inputs: { relevantTotal: 180, retrieved: 90, relevantRetrieved: 72 }, inputQuotes: { relevantTotal: '实际相关文献总数为180篇', retrieved: '检索得到90篇', relevantRetrieved: '其中相关文献为72篇' } });
    const saved = created.saveAnswer(q, proposed(q, ['B'], [computed.source]));
    assert.equal(saved.answer.status, 'verified'); assert.deepEqual(saved.answer.answer, ['80%']); assert.equal(created.context, undefined);
    assert.equal(launchCount, beforeLaunch); assert.equal(requests.length, beforeRequests); assert.equal(Object.hasOwn(saved.answer, 'timing'), false);
    assert.equal(saved.jsonPath, null); assert.equal(saved.markdownPath, null); assert.equal(fs.existsSync(created.outputDir), false);
  });

  await test('首次并发prepare完整加载索引和规则，只启动一个可见Chrome且零网站查询', async () => {
    prepared = newSession('full-managed'); const beforeLaunch = launchCount, beforeRequests = requests.length;
    const summaries = await Promise.all(Array.from({ length: 6 }, () => prepared.prepare()));
    assert.equal(launchCount - beforeLaunch, 1); assert.equal(requests.length, beforeRequests);
    for (const summary of summaries) {
      assert.equal(summary.status, 'ready'); assert.equal(summary.helper_version, VERSION); assert.equal(summary.installed_version, VERSION);
      assert.equal(summary.browser_connected, true); assert.equal(summary.profiles_total, indexed.sources.length); assert.equal(summary.profiles_loaded, indexed.sources.length);
      assert.equal(summary.rules_total, rules.rules.length); assert.equal(summary.rules_loaded, rules.rules.length); assert.deepEqual(summary.failures, []); assert.equal(summary.preflight_ran, false);
    }
    assert.equal(prepared.context.pages().length, 1); assert.equal(prepared.context.pages()[0].url(), 'about:blank'); assert.deepEqual(prepared.preflightSourceIds, []);
    assert.equal(prepared.options.headless, false); assert.equal(prepared.archive, false); assert.equal(prepared.screenshots, false);
    const agent = await prepared.context.pages()[0].evaluate(() => navigator.userAgent); assert.match(agent, /Chrome\//); assert.doesNotMatch(agent, /HeadlessChrome|Edg\//);
    return { launched_browsers: 1, profiles: indexed.sources.length, rule_cards: rules.rules.length, website_queries: 0, headless: false };
  });

  await test('重复prepare复用Chrome和缓存，不增长标签或访问网站', async () => {
    const previous = prepared.context, pages = previous.pages(), beforeLaunch = launchCount, beforeRequests = requests.length;
    const summary = await prepared.prepare(); assert.equal(summary.reused_live_session, true); assert.equal(prepared.context, previous);
    assert.deepEqual(prepared.context.pages(), pages); assert.equal(launchCount, beforeLaunch); assert.equal(requests.length, beforeRequests); assert.equal(summary.preflight_ran, false);
    assert.equal(prepared.isBrowserConnected(), true); assert.equal(prepared.codeStatus().status, 'current');
  });

  await test('准备后按题读已缓存流程和规则：零正文重复读取，返回副本防止污染', async () => {
    const id = indexed.sources[0].id;
    const { result, reads } = trackedAssetReads(() => {
      const profile = prepared.recipeStore.profile(id), rule = prepared.ruleCard('boolean-operators');
      profile.test_injected = true; rule.claims.and = '篡改副本';
      return { profile: prepared.recipeStore.profile(id), rule: prepared.ruleCard('boolean-operators') };
    });
    assert.deepEqual(reads, []); assert.equal(result.profile.test_injected, undefined); assert.notEqual(result.rule.claims.and, '篡改副本');
    return { managed_asset_reads: reads.length };
  });

  await test('准备后第二题换序：复用规则且答案仍映射当前文字，无新增浏览器操作', async () => {
    const beforeRequests = requests.length, beforeLaunch = launchCount;
    const q = question('reordered-options', { A: '并集', B: '交集' }); prepared.beginQuestion(q);
    const used = prepared.useRule(q, { ruleId: 'boolean-operators', claims: ['and'], application: '题目仅要求通用AND集合含义；本题B选项为交集。' });
    const saved = prepared.saveAnswer(q, proposed(q, ['B'], [used.source]));
    assert.equal(saved.answer.status, 'verified'); assert.deepEqual(saved.answer.answer_labels, ['B']); assert.deepEqual(saved.answer.answer, ['交集']);
    assert.equal(Object.hasOwn(saved.answer, 'timing'), false); assert.equal(requests.length, beforeRequests); assert.equal(launchCount, beforeLaunch); assert.equal(saved.jsonPath, null);
  });

  await test('重复prepare保留登录验证页、表单、当前题attempt、角色绑定和内存证据', async () => {
    const q = question('human-verification'); prepared.beginQuestion(q);
    const page = await prepared.page('fixture'); await page.goto(baseURL + '/challenge'); await page.locator('#username').fill('test-owned-login');
    await prepared.context.addCookies([{ name: 'test_session', value: 'owned-only', url: baseURL, expires: Math.floor(Date.now() / 1000) + 3600 }]);
    const binding = { role: 'results', question_id: q.id, attempt: prepared.activeQuestion.attempt, status: 'blocked', document_epoch: prepared.documentEpochs.get(page) };
    prepared.bindRole('fixture', 'results', page, binding); prepared.life(page).protected = true;
    const used = prepared.useRule(q, { ruleId: 'boolean-operators', claims: ['and'], application: '当前验证不影响已有稳定AND规则卡。' });
    const active = { ...prepared.activeQuestion }, evidenceLength = prepared.evidence.length, beforeRequests = requests.length, context = prepared.context;
    const summary = await prepared.prepare(); assert.equal(summary.reused_live_session, true); assert.equal(prepared.context, context);
    assert.equal(page.isClosed(), false); assert.equal(page.url(), baseURL + '/challenge'); assert.equal(await page.locator('#username').inputValue(), 'test-owned-login');
    assert.deepEqual(prepared.activeQuestion, active); assert.equal(prepared.life(page).protected, true); assert.equal(prepared.life(page).binding, binding);
    assert.equal(prepared.evidence.length, evidenceLength); assert.ok(prepared.evidencePayload(prepared.evidence.at(-1)).proof); assert.equal(requests.length, beforeRequests);
    assert.equal((await prepared.context.cookies(baseURL)).find(cookie => cookie.name === 'test_session').value, 'owned-only');
    assert.equal(used.artifact.storage, 'memory');
  });

  await test('浏览器关闭后prepare从同一配置恢复Chrome和持久cookie，不错误复用旧页', async () => {
    const previousContext = prepared.context, previousProfile = prepared.profileDir, previousPage = previousContext.pages()[0], beforeLaunch = launchCount;
    await previousContext.close(); assert.equal(prepared.isBrowserConnected(), false);
    const summary = await prepared.prepare(); assert.equal(summary.status, 'ready'); assert.equal(summary.reused_live_session, false); assert.equal(summary.browser_connected, true);
    assert.equal(launchCount - beforeLaunch, 1); assert.notEqual(prepared.context, previousContext); assert.equal(prepared.profileDir, previousProfile); assert.equal(previousPage.isClosed(), true);
    assert.equal((await prepared.context.cookies(baseURL)).find(cookie => cookie.name === 'test_session').value, 'owned-only');
    for (const page of prepared.pages.values()) assert.equal(page.isClosed(), false);
    return { relaunched_browsers: 1, same_profile: true, persisted_fixture_cookie: true };
  });

  await test('start与prepare并发共享启动锁，只有一个有效浏览器', async () => {
    const created = newSession('mixed-concurrent'), beforeLaunch = launchCount;
    const values = await Promise.all([created.start(), created.prepare(), created.start(), created.prepare()]);
    assert.equal(launchCount - beforeLaunch, 1); assert.equal(created.isBrowserConnected(), true); assert.equal(values[1].status, 'ready'); assert.equal(values[3].status, 'ready');
    await created.close();
  });

  await test('Chrome启动障碍返回blocked与具体失败项，修复运行时后同会话可重新准备', async () => {
    const created = newSession('recover-missing-runtime', { runtimeDir: path.join(runDir, 'missing-runtime') }), beforeLaunch = launchCount;
    const blocked = await created.prepare(); assert.equal(blocked.status, 'blocked'); assert.equal(blocked.browser_connected, false);
    assert.ok(blocked.failures.some(item => item.kind === 'browser' && /runtime/i.test(item.message))); assert.equal(launchCount, beforeLaunch);
    assert.equal(blocked.profiles_loaded, indexed.sources.length); assert.equal(blocked.rules_loaded, rules.rules.length);
    created.runtimeDir = runtimeDir; const recovered = await created.prepare(); assert.equal(recovered.status, 'ready'); assert.equal(recovered.browser_connected, true);
    assert.equal(launchCount - beforeLaunch, 1); await created.close();
  });

  await test('来源目录与磁盘流程索引修改后仅刷新维护资料，不需浏览器或目录扫描', async () => {
    const created = newSession('disk-registry', { catalog: undefined, recipeIndex: undefined }), sourcesFile = path.join(copiedRoot, 'references/sources.json'), indexFile = path.join(copiedRoot, 'references/search-index.json');
    const originalSources = fs.readFileSync(sourcesFile, 'utf8'), originalIndex = fs.readFileSync(indexFile, 'utf8'), addedProfile = path.join(copiedRoot, 'references/sites/managed-fixture.json'), beforeLaunch = launchCount;
    try {
      const changedSources = JSON.parse(originalSources), entries = Array.isArray(changedSources) ? changedSources : changedSources.sources;
      entries[0].name += '（刷新测试）'; writeJSON(sourcesFile, changedSources);
      assert.equal(created.source(entries[0].id).name, entries[0].name);
      writeJSON(addedProfile, { source_id: 'managed-fixture', recipes: [] });
      const changedIndex = JSON.parse(originalIndex); changedIndex.sources.push({ id: 'managed-fixture', name: '维护列表新增本地站点', url: baseURL + '/entry', domains: ['127.0.0.1'], profile: 'references/sites/managed-fixture.json', recipe_ids: [] }); writeJSON(indexFile, changedIndex);
      assert.equal(created.source('managed-fixture').name, '维护列表新增本地站点'); assert.equal(created.recipeStore.profile('managed-fixture').source_id, 'managed-fixture');
      assert.equal(created.recipeStore.preload().indexed, indexed.sources.length + 1); assert.equal(created.context, undefined); assert.equal(launchCount, beforeLaunch);
    } finally { fs.writeFileSync(sourcesFile, originalSources); fs.writeFileSync(indexFile, originalIndex); fs.rmSync(addedProfile, { force: true }); }
  });

  await test('流程文件修改后prepare刷新缓存，损坏一站只使初始化partial', async () => {
    const entry = indexed.sources[0], file = path.join(copiedRoot, entry.profile), original = fs.readFileSync(file, 'utf8');
    try {
      const changed = JSON.parse(original); changed.test_revision = 'new-revision'; writeJSON(file, changed);
      const refreshed = await prepared.prepare(); assert.equal(refreshed.status, 'ready'); assert.equal(prepared.recipeStore.profile(entry.id).test_revision, 'new-revision');
      fs.writeFileSync(file, '{ broken profile JSON');
      const partial = await prepared.prepare(); assert.equal(partial.status, 'partial'); assert.equal(partial.browser_connected, true); assert.equal(partial.profiles_loaded, partial.profiles_total - 1);
      assert.ok(partial.failures.some(item => JSON.stringify(item).includes(entry.id))); assert.throws(() => prepared.recipeStore.profile(entry.id));
      assert.equal(prepared.ruleCard('boolean-operators').id, 'boolean-operators');
    } finally { fs.writeFileSync(file, original); }
    assert.equal((await prepared.prepare()).status, 'ready');
  });

  await test('规则证据被修改后prepare停用相应卡片，其他卡片继续可用并可修复', async () => {
    const target = rules.rules.find(card => card.id === 'boolean-operators'), file = path.join(copiedRoot, target.artifacts.find(item => item.path.endsWith('.json')).path), original = fs.readFileSync(file);
    try {
      fs.writeFileSync(file, Buffer.concat([original, Buffer.from('\nchanged evidence')]));
      const partial = await prepared.prepare(); assert.equal(partial.status, 'partial'); assert.equal(partial.rules_loaded, partial.rules_total - 1);
      assert.ok(partial.failures.some(item => JSON.stringify(item).includes('boolean-operators'))); assert.throws(() => prepared.ruleCard('boolean-operators'));
      assert.equal(prepared.ruleCard('retrieval-metrics').id, 'retrieval-metrics');
    } finally { fs.writeFileSync(file, original); }
    assert.equal((await prepared.prepare()).status, 'ready'); assert.equal(prepared.ruleCard('boolean-operators').id, 'boolean-operators');
  });

  await test('已加载代码与安装版本不同：明确reload_required，不重启或修改当前浏览器', async () => {
    const manifestFile = path.join(copiedRoot, 'runtime/package.json'), original = fs.readFileSync(manifestFile, 'utf8'), context = prepared.context, pages = context.pages(), beforeLaunch = launchCount, beforeRequests = requests.length;
    try {
      const changed = JSON.parse(original); changed.version = '99.0.0'; writeJSON(manifestFile, changed);
      const code = prepared.codeStatus(); assert.equal(code.status, 'reload_required'); assert.equal(code.helper_version, VERSION); assert.equal(code.installed_version, '99.0.0'); assert.ok(code.reason);
      const summary = await prepared.prepare(); assert.equal(summary.status, 'reload_required'); assert.equal(summary.helper_version, VERSION); assert.equal(summary.installed_version, '99.0.0');
      assert.equal(prepared.context, context); assert.deepEqual(context.pages(), pages); assert.equal(launchCount, beforeLaunch); assert.equal(requests.length, beforeRequests);
    } finally { fs.writeFileSync(manifestFile, original); }
    assert.equal(prepared.codeStatus().status, 'current');
  });

  await test('同版本脚本磁盘变更也要求刷新运行时，不能声称缓存代码已更新', async () => {
    const file = path.join(copiedRoot, 'scripts/browser.cjs'), original = fs.readFileSync(file, 'utf8');
    try {
      fs.writeFileSync(file, original + '\n// isolated installed-code drift\n');
      assert.equal(prepared.codeStatus().status, 'reload_required'); assert.equal((await prepared.prepare()).status, 'reload_required');
    } finally { fs.writeFileSync(file, original); }
    assert.equal(prepared.codeStatus().status, 'current');
  });

  await test('新运行时会话重建缓存，不继承未归档的内存证据', async () => {
    const created = newSession('reset-memory-only'); assert.equal(created.evidence.length, 0); assert.equal(created.questionRecords.length, 0);
    const summary = await created.prepare(); assert.equal(summary.status, 'ready'); assert.equal(summary.rules_loaded, rules.rules.length); assert.equal(created.evidence.length, 0); await created.close();
  });

  await test('动态检索在准备后仍实时执行；比较冷启动与已准备答题的真实库调用和耗时', async () => {
    const fixtureIndex = { sources: [{ ...fixtureSource(), recipe_ids: ['fixture:lookup'] }] }, settings = { recipeIndex: fixtureIndex, recipes: [recipe()] };
    const cold = newSession('benchmark-cold', settings), warm = newSession('benchmark-warm', settings), query = '此前样题未出现的新实体';
    let before = requests.length, beforeLaunch = launchCount, started = performance.now();
    await cold.start(); const coldAnswer = await runQuery(cold, 'cold-same-task', query);
    const coldMeasured = { answer_phase_ms: performance.now() - started, browser_starts: launchCount - beforeLaunch, document_requests: requests.slice(before).map(item => item.path), library_workflow_calls: 2 };
    started = performance.now(); const warmed = await warm.prepare(); const preparationMs = performance.now() - started; assert.equal(warmed.status, 'ready');
    before = requests.length; beforeLaunch = launchCount; started = performance.now(); const warmAnswer = await runQuery(warm, 'warm-same-task', query);
    const warmMeasured = { answer_phase_ms: performance.now() - started, browser_starts: launchCount - beforeLaunch, document_requests: requests.slice(before).map(item => item.path), library_workflow_calls: 1 };
    assert.deepEqual(coldMeasured.document_requests, ['/entry', '/results']); assert.deepEqual(warmMeasured.document_requests, ['/entry', '/results']);
    assert.equal(warmMeasured.browser_starts, 0); assert.deepEqual(coldAnswer.answer.answer, warmAnswer.answer.answer); assert.equal(Object.hasOwn(warmAnswer.answer, 'timing'), false);
    assert.equal(warmAnswer.jsonPath, null); assert.equal(warm.screenshots, false);
    report.benchmark = { measurement: 'one controlled local search per mode; in-process library wall time, not actual Codex tool roundtrips or public-site speed', preparation_ms: preparationMs, cold: coldMeasured, prepared: warmMeasured };
    await cold.close(); await warm.close(); return report.benchmark;
  });
}

(async () => {
  try {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
      requests.push({ path: url.pathname, query: url.search });
      const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
      let body;
      if (url.pathname === '/challenge') body = '<h1>安全验证</h1><p>请完成人机验证后继续</p><label for="username">用户名</label><input id="username"><button id="verify">验证</button>';
      else if (url.pathname === '/entry') body = '<h1>专业检索</h1><form action="/results"><label for="query">题名</label><input type="search" id="query" name="query"><button type="submit">检索</button></form>';
      else if (url.pathname === '/results') body = `<h1>检索结果</h1><output id="query-echo">${escape(url.searchParams.get('query') || '')}</output><main id="results" data-complete="true"><article class="record">${escape(url.searchParams.get('query') || '')}；记录标识 LIVE-2026；当前年份 2026。</article></main>`;
      else body = '<h1>本地测试</h1>';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>官方本地检索测试</title><body>${body}</body></html>`);
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); baseURL = `http://127.0.0.1:${server.address().port}`; await main();
  } catch (error) { report.tests.push({ name: 'v2.8验证初始化', passed: false, error: error.stack || String(error) }); process.stderr.write(String(error.stack || error) + '\n'); }
  finally {
    for (const created of sessions.reverse()) { try { await created.close(); } catch (error) { report.cleanup_errors ||= []; report.cleanup_errors.push(String(error)); } }
    chromium.launchPersistentContext = launchOriginal;
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    report.finished_at = new Date().toISOString(); report.passed = report.tests.filter(item => item.passed).length; report.failed = report.tests.filter(item => !item.passed).length;
    const file = path.join(__dirname, 'v28-tests.json'); writeJSON(file, report); process.stdout.write(`Results: ${report.passed} passed, ${report.failed} failed. ${file}\n`); process.exitCode = report.failed ? 1 : 0;
  }
})();
