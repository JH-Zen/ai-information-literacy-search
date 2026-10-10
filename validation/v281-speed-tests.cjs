#!/usr/bin/env node
'use strict';

// Visible Chrome and local HTTP fixtures only. Request/read counts are measured
// directly; elapsed time on this machine does not predict public-site speed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const { performance } = require('node:perf_hooks');
const { SearchSession, VERSION } = require('../ai-literacy-search/scripts/browser.cjs');
const baselineEntry = path.join(__dirname, 'v281-baseline/ai-literacy-search/scripts/browser.cjs');
const BaselineSession = fs.existsSync(baselineEntry) ? require(baselineEntry).SearchSession : null;
const runtimeDir = process.env.AI_LITERACY_RUNTIME_DIR || path.join(os.homedir(), '.ailiteracy-runtime');
const runtimeRequire = createRequire(path.join(runtimeDir, 'package.json'));
runtimeRequire('playwright'); // Resolve exactly the configured pinned runtime.
const runDir = fs.mkdtempSync(path.join(__dirname, 'v281-speed-run-'));
const report = { started_at: new Date().toISOString(), helper_version: VERSION, run_dir: runDir,
  kind: 'visible Google Chrome; test-owned profiles; local HTTP fixtures; no public-site performance claim', tests: [] };
const sessions = [], requests = [], counts = { aria_reads: 0, inner_text_reads: 0, observations: 0 };
let server, baseURL, current, sequence = 0, locatorPrototype, originalAria, originalInnerText;
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const html = (title, body) => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${escape(title)}</title><body>${body}</body></html>`;
const snapshot = () => ({ ...counts, entry_requests: requests.filter(item => item.path === '/entry').length });
const delta = before => Object.fromEntries(Object.entries(snapshot()).map(([key, value]) => [key, value - before[key]]));
const source = () => ({ id: 'fixture', name: '本地官方检索测试', url: baseURL + '/entry?mode=nav', domains: ['127.0.0.1'] });
function results(url) {
  const query = url.searchParams.get('query') || '';
  const condition = `题名=${query}；作者=${url.searchParams.get('author') || ''}；年份=${url.searchParams.get('year') || ''}；排序=${url.searchParams.get('sort') || ''}`;
  return `<output id="condition-echo">${escape(condition)}</output><main id="results" data-complete="true">${query === '正常无结果' ? '<p id="empty">没有符合条件的文献。</p>' : `<article>${escape(query)}；记录标识 LIVE-2026；作者新作者甲。</article>`}</main>`;
}
function form(mode) {
  const fields = '<label for="query">题名</label><input type="search" id="query" name="query"><label for="author">作者</label><input id="author" name="author"><label for="year">年份</label><input id="year" name="year"><label for="sort">排序</label><select id="sort" name="sort"><option value="">默认</option><option value="desc">年份降序</option></select>';
  if (mode === 'bad-control') return '<h1>专业检索</h1><input type="search" aria-label="新的真实控件名称"><button>检索</button>';
  if (mode === 'heading-error') return `<p>${'正常导航文字。'.repeat(500)}</p><span id="service-error-label" hidden>检索服务错误</span><div role="heading" aria-level="1" aria-labelledby="service-error-label" style="min-height:20px"></div>`;
  if (mode === 'many-controls') return '<h1>专业检索</h1>' + fields + Array.from({ length: 81 }, (_, i) => `<button type="button">普通操作${i}</button>`).join('') + '<input type="password" aria-label="凭据输入">';
  if (mode === 'http-error') return '<h1>专业检索</h1>' + fields;
  if (mode === 'css') return `<style>@keyframes show-result{0%,99%{visibility:hidden}100%{visibility:visible}}#results{animation:show-result .45s step-end}</style><form onsubmit="event.preventDefault();fetch('/fragment?'+new URLSearchParams(new FormData(this))).then(r=>r.text()).then(t=>document.getElementById('result-host').innerHTML=t)">${fields}<button type="submit">检索</button></form><div id="result-host"></div>`;
  if (mode === 'late-challenge') return `<form onsubmit="event.preventDefault();document.getElementById('result-host').innerHTML='<output id=condition-echo>'+document.getElementById('query').value+'</output><main id=results>正在加载</main>';setTimeout(()=>document.body.innerHTML='<h1>安全验证</h1><p>请完成人机验证</p>',180)">${fields}<button type="submit">检索</button></form><div id="result-host"></div>`;
  if (mode === 'ajax') return `<h1>专业检索</h1><form onsubmit="event.preventDefault();fetch('/fragment?'+new URLSearchParams(new FormData(this))).then(r=>r.text()).then(t=>document.getElementById('result-host').innerHTML=t)">${fields}<button type="submit">检索</button></form><div id="result-host"></div>`;
  return `<h1>专业检索</h1><form action="/results">${fields}<button type="submit">检索</button></form>`;
}
function recipe(mode) {
  return { id: `fixture:${mode}`, source_id: 'fixture', status: 'query_verified', entry_url: `${baseURL}/entry?mode=${mode}`,
    transitions: { results: { mode: 'same-page', container: { css: '#results' }, ready: { css: '#results[data-complete="true"]' },
      match: { css: '#condition-echo', match: 'contains' }, empty: { css: '#empty' }, timeoutMs: 1600 } },
    execution: { version: 1, queryMode: 'literal', resetEntry: true,
      parameters: { query: { type: 'string', required: true }, author: { type: 'string' }, year: { type: 'string' }, sort: { type: 'string', evidenceValues: { desc: '年份降序' } } },
      prepare: [{ action: 'fill', locator: { role: 'searchbox', name: '题名', exact: true }, parameter: 'query' },
        { action: 'fill', locator: { label: '作者' }, parameter: 'author', omit: 'clear' },
        { action: 'fill', locator: { label: '年份' }, parameter: 'year', omit: 'clear' },
        { action: 'select', locator: { label: '排序' }, parameter: 'sort', omit: 'empty-option' }],
      submit: { action: 'click', locator: { role: 'button', name: '检索', exact: true } }, echoParameters: ['query', 'author', 'year', 'sort'] } };
}
function question(query, extra = '') { return { id: `speed-question-${++sequence}`, type: 'single', question: `检索题名“${query}”的记录${extra}。`, options: { A: 'LIVE-2026', B: 'OLD-1999' } }; }
async function run(session, mode, q, parameters, extra = {}) {
  const parameterQuotes = Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key, key === 'sort' ? '年份降序' : value]));
  return session.runSearch(q, { recipeId: `fixture:${mode}`, parameters, parameterQuotes, ...extra });
}
async function test(name, fn) {
  const started = performance.now();
  try { const detail = await fn(); report.tests.push({ name, passed: true, elapsed_ms: +(performance.now() - started).toFixed(1), ...(detail ? { detail } : {}) }); process.stdout.write(`PASS ${name}\n`); }
  catch (error) { report.tests.push({ name, passed: false, elapsed_ms: +(performance.now() - started).toFixed(1), error: error.stack || String(error) }); process.stdout.write(`FAIL ${name}: ${error.message}\n`); }
}
async function makeSession(SessionClass, label) {
  const outputDir = path.join(runDir, label), recipes = ['nav', 'ajax', 'bad-control', 'heading-error', 'http-error', 'many-controls', 'css', 'late-challenge'].map(recipe);
  const session = new SessionClass({ sessionId: label, outputDir, profileDir: path.join(outputDir, 'profile'), runtimeDir,
    catalog: { sources: [source()] }, recipeIndex: { sources: [{ ...source(), recipe_ids: recipes.map(item => item.id) }] }, recipes,
    headless: false, archive: false, screenshots: false, navigationTimeoutMs: 5000 });
  sessions.push(session);
  const originalObserve = session.observe;
  session.observe = async function (...args) { counts.observations++; return originalObserve.apply(this, args); };
  await session.start();
  const page = session.context.pages()[0];
  const agent = await page.evaluate(() => navigator.userAgent);
  assert.match(agent, /Chrome\//); assert.doesNotMatch(agent, /HeadlessChrome|Edg\//);
  if (!locatorPrototype) {
    locatorPrototype = Object.getPrototypeOf(page.locator('body'));
    originalAria = locatorPrototype.ariaSnapshot; originalInnerText = locatorPrototype.innerText;
    locatorPrototype.ariaSnapshot = function (...args) { counts.aria_reads++; return originalAria.apply(this, args); };
    locatorPrototype.innerText = function (...args) { counts.inner_text_reads++; return originalInnerText.apply(this, args); };
  }
  return session;
}
async function benchmark(SessionClass, label) {
  const session = await makeSession(SessionClass, label), before = snapshot(), started = performance.now(), perQuery = [];
  for (const mode of ['nav', 'nav', 'ajax', 'ajax']) {
    const query = `${label}-${mode}-${++sequence}`, q = question(query), countBefore = snapshot(), queryStarted = performance.now();
    const result = await run(session, mode, q, { query });
    assert.equal(result.status, 'ready'); assert.equal(result.outcome, 'results'); assert.ok(result.sources.length);
    perQuery.push({ mode, elapsed_ms: +(performance.now() - queryStarted).toFixed(1), ...delta(countBefore) });
    if (SessionClass === SearchSession) { assert.equal(perQuery.at(-1).entry_requests, 1); assert.equal(perQuery.at(-1).aria_reads, 0); }
    session.finishQuestion(q);
  }
  const measured = { elapsed_ms: +(performance.now() - started).toFixed(1), ...delta(before), queries: perQuery };
  await session.close(); return measured;
}
async function main() {
  await test('连续四题：离开入口及仍在入口每题只导航一次，正常runner零ARIA', async () => {
    const before = BaselineSession ? await benchmark(BaselineSession, 'baseline-280') : null;
    const after = await benchmark(SearchSession, 'current-281');
    report.benchmark = { measurement: 'four sequential local queries per version; in-process elapsed time; no Codex tool roundtrips or public-site prediction', before, after };
    assert.equal(after.entry_requests, 4); assert.equal(after.aria_reads, 0);
    if (before) { assert.ok(before.entry_requests > after.entry_requests); assert.ok(before.aria_reads > after.aria_reads); }
    return { before, after };
  });
  current = await makeSession(SearchSession, 'regressions');
  await test('同入口连续检索：省略作者、年份、排序时清除上题筛选', async () => {
    const firstQuery = '第一题筛选', first = question(firstQuery, '，作者为作者辛，年份为2026，按年份降序');
    assert.equal((await run(current, 'ajax', first, { query: firstQuery, author: '作者辛', year: '2026', sort: 'desc' }, { capture: false })).status, 'ready');
    current.finishQuestion(first);
    const query = '第二题仅题名', q = question(query), before = snapshot();
    const result = await run(current, 'ajax', q, { query }, { capture: false });
    assert.equal(result.status, 'ready'); assert.equal(delta(before).entry_requests, 1); assert.equal(delta(before).aria_reads, 0);
    const request = requests.findLast(item => item.path === '/fragment');
    assert.deepEqual(request.parameters, { query, author: '', year: '', sort: '' });
    assert.match(result.data.conditions, /作者=；年份=；排序=$/); current.finishQuestion(q); return delta(before);
  });
  await test('默认full/compact兼容，status快照不能替代full请求', async () => {
    const page = await current.page('fixture', { recipeId: 'fixture:nav' });
    const before = snapshot(), status = await current.observe(page, { detail: 'status' });
    assert.equal(status.detail, 'status'); assert.equal(status.aria, ''); assert.match(status.text, /专业检索/); assert.ok(status.controls.some(control => control.id === 'query'));
    assert.equal(delta(before).aria_reads, 0);
    const full = await current.currentObservation(page, { compact: true });
    assert.equal(full.detail, 'full'); assert.match(full.aria, /专业检索/); assert.equal(delta(before).aria_reads, 1); assert.ok(full.truncated);
    const beforeReuse = snapshot(); await current.currentObservation(page, { detail: 'full', compact: true });
    assert.equal(delta(beforeReuse).aria_reads, 0); await assert.rejects(() => current.observe(page, { detail: 'invalid' }), /detail/); return delta(before);
  });
  await test('status提取故障回退full，不静默返回空证据', async () => {
    const page = await current.page('fixture', { recipeId: 'fixture:nav' }), originalEvaluate = page.evaluate, before = snapshot();
    let calls = 0;
    page.evaluate = async function (...args) { if (++calls === 2) throw new Error('Injected status extraction failure'); return originalEvaluate.apply(this, args); };
    let observed;
    try { observed = await current.observe(page, { detail: 'status' }); } finally { page.evaluate = originalEvaluate; }
    assert.equal(observed.detail, 'full'); assert.match(observed.text, /专业检索/); assert.match(observed.aria, /专业检索/); assert.equal(delta(before).aria_reads, 1); return delta(before);
  });
  await test('登录、验证码、正文授权及403原页保留，不因resetEntry覆盖状态', async () => {
   const details = [];
   for (const [route, expected] of [['login', 'login_required'], ['challenge', 'challenge'], ['body-login', 'login_required'], ['denied', 'access_denied'], ['image-challenge', 'challenge'], ['image-challenge-empty-label', 'challenge'], ['image-challenge-ref', 'challenge'], ['title-challenge', 'challenge']]) {
    const page = current.pages.get('fixture'); await page.goto(baseURL + '/' + route, { waitUntil: 'domcontentloaded' });
    if (route === 'login') await page.getByLabel('用户名').fill('test-preserved-user');
    const query = `授权-${route}`, q = question(query), before = snapshot(), originalURL = page.url();
    const result = await run(current, 'nav', q, { query }, { capture: false });
    assert.equal(result.status, 'blocked'); assert.equal(result.reason, expected); assert.equal(page.url(), originalURL);
    assert.equal(delta(before).entry_requests, 0); if (!route.startsWith('image-challenge') && route !== 'title-challenge') assert.equal(delta(before).aria_reads, 0);
    else assert.ok(delta(before).aria_reads > 0, 'a complex heading must retain the full accessible-name fallback');
    if (route === 'login') assert.equal(await page.getByLabel('用户名').inputValue(), 'test-preserved-user');
    details.push({ route, ...delta(before) }); current.finishQuestion(q); await page.goto(baseURL + '/entry?mode=nav'); await current.observe(page, { detail: 'status' });
   }
   return details;
  });
  await test('HTTP503与长正文之后可见heading错误均拒绝执行提交', async () => {
   const details = [];
   for (const mode of ['http-error', 'heading-error']) {
    const q = question(`错误-${mode}`), before = snapshot();
    const result = await run(current, mode, q, { query: `错误-${mode}` }, { capture: false });
    assert.equal(result.status, 'needs_observation'); assert.equal(result.reason, 'http_error');
    if (mode === 'http-error') { assert.equal(result.observation.http_status, 503); assert.equal(delta(before).aria_reads, 0); }
    else { assert.ok(result.observation.full_text_length > 2000); assert.ok(delta(before).aria_reads > 0); assert.equal(result.observation.detail, 'full'); assert.match(current.observations.get(result.page).observed.aria, /检索服务错误/); }
    current.finishQuestion(q); details.push({ mode, ...delta(before) });
   }
   return details;
  });
  await test('超过compact上限的最后password仍阻塞inspect与runner', async () => {
    const page = current.pages.get('fixture'), fixtureSource = { ...source(), url: baseURL + '/entry?mode=many-controls' };
    const entry = await current.inspect(fixtureSource, page, { compact: true, detail: 'status' });
    assert.equal(entry.authorization, 'login_required'); assert.equal(current.life(page).protected, true);
    const query = '末尾password保护', q = question(query), before = snapshot();
    const result = await run(current, 'many-controls', q, { query }, { capture: false });
    assert.equal(result.status, 'blocked'); assert.equal(result.reason, 'login_required'); assert.equal(delta(before).entry_requests, 0);
    assert.ok(current.observations.get(page).observed.controls.length > 80); assert.ok(result.observation.truncated.controls);
    const measured = delta(before); current.finishQuestion(q); await page.goto(baseURL + '/entry?mode=nav'); await current.observe(page, { detail: 'status' }); return measured;
  });
  await test('失效控件回退needs_observation，原页可由默认full重新观察', async () => {
    const query = '控件变更', q = question(query), before = snapshot(), result = await run(current, 'bad-control', q, { query }, { capture: false });
    assert.equal(result.status, 'needs_observation'); assert.match(result.reason, /control/i); assert.ok(result.page); assert.equal(delta(before).aria_reads, 0);
    const full = await current.observe(result.page, { compact: true }); assert.match(full.aria, /新的真实控件名称/); current.finishQuestion(q); return delta(before);
  });
  await test('明确零结果仍ready/empty，旧题及新attempt绑定不能取证', async () => {
    const q = question('正常无结果'), result = await run(current, 'ajax', q, { query: '正常无结果' }, { capture: false });
    assert.equal(result.status, 'ready'); assert.equal(result.outcome, 'empty');
    current.finishQuestion(q); current.beginQuestion(q);
    await assert.rejects(() => current.captureEvidence(result.page, { questionId: q.id, name: source().name, query: '正常无结果', field: '零结果', locator: '#results', evidence: '没有符合条件的文献。' }), /blocked|stale|question|attempt/i);
    const next = question('另一题绑定'); current.beginQuestion(next);
    assert.throws(() => current.rolePage('fixture', 'results'), /question|bound|role/i); current.finishQuestion(next);
    return { old_attempt: result.binding.attempt, new_attempt: current.questionRecords.findLast(item => item.question_id === q.id).attempt };
  });
  await test('轮询CSS动画可见性，不缓存ready检查；最终重新解析同描述容器', async () => {
    const query = '动画可见结果', q = question(query); current.beginQuestion(q);
    const page = await current.page('fixture', { recipeId: 'fixture:css', resetEntry: true, detail: 'status' });
    await page.getByLabel('题名').fill(query);
    const originalResolve = current.resolveTarget, descriptor = { css: '#results' }; let resolutions = 0;
    current.resolveTarget = async function (p, spec) { if (spec === descriptor || JSON.stringify(spec) === JSON.stringify(descriptor)) resolutions++; return originalResolve.call(this, p, spec); };
    let result;
    try { result = await current.transition('fixture', { questionId: q.id, fromPage: page, toRole: 'results', mode: 'same-page',
      container: descriptor, ready: { ...descriptor }, match: { css: '#condition-echo', match: 'contains' }, expected: query, timeoutMs: 1800, observationDetail: 'status',
      trigger: async () => page.getByRole('button', { name: '检索', exact: true }).click() }); } finally { current.resolveTarget = originalResolve; }
    assert.equal(result.status, 'ready'); assert.ok(resolutions >= 3); current.finishQuestion(q); return { target_resolutions: resolutions };
  });
  await test('同一函数ready/container仍分别执行，不将自定义检查缓存', async () => {
    const query = '函数条件结果', q = question(query); current.beginQuestion(q);
    const page = await current.page('fixture', { recipeId: 'fixture:nav', resetEntry: true, detail: 'status' }); await page.getByLabel('题名').fill(query);
    let calls = 0, matches = 0; const target = p => { calls++; return p.locator('#results'); };
    const result = await current.transition('fixture', { questionId: q.id, fromPage: page, toRole: 'results', mode: 'same-page', container: target, ready: target,
      match: async p => { matches++; return (await p.locator('#condition-echo').innerText().catch(() => '')).includes(query); }, expected: query, timeoutMs: 1600,
      observationDetail: 'status', trigger: async () => page.getByRole('button', { name: '检索', exact: true }).click() });
    assert.equal(result.status, 'ready'); assert.ok(calls >= 3, 'ready, container and final container must each run'); assert.ok(matches >= 2); current.finishQuestion(q);
    return { target_function_calls: calls, match_function_calls: matches };
  });
  await test('轮询中变验证码时及时blocked，不能当作空结果', async () => {
    const query = '途中验证码', q = question(query), before = snapshot();
    const result = await run(current, 'late-challenge', q, { query }, { capture: false });
    assert.equal(result.status, 'blocked'); assert.equal(result.outcome, 'failed'); assert.equal(result.container, null); assert.equal(delta(before).aria_reads, 0);
    current.finishQuestion(q); return delta(before);
  });
}
(async () => {
  try {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
      requests.push({ path: url.pathname, parameters: Object.fromEntries(url.searchParams), at: new Date().toISOString() });
      let body, status = 200;
      if (url.pathname === '/entry') { const mode = url.searchParams.get('mode') || 'nav'; body = html('官方数据库', form(mode)); if (mode === 'http-error') status = 503; }
      else if (url.pathname === '/results') body = html('数据库检索结果', results(url));
      else if (url.pathname === '/fragment') body = results(url);
      else if (url.pathname === '/login') body = html('统一登录', '<label for="username">用户名</label><input id="username"><label for="password">密码</label><input type="password" id="password">');
      else if (url.pathname === '/challenge') body = html('安全验证', '<h1>安全验证</h1><p>请完成人机验证</p>');
      else if (url.pathname.startsWith('/image-challenge')) {
        const image = `<img alt="安全验证" width="16" height="16" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Crect width='16' height='16'/%3E%3C/svg%3E">`;
        const heading = url.pathname.endsWith('-ref') ? `<h1 aria-labelledby="challenge-name"><span id="challenge-name">${image}</span></h1>` : `<h1${url.pathname.endsWith('-empty-label') ? ' aria-label=""' : ''}>${image}</h1>`;
        body = html('数据库访问', `<p>${'正常页面内容。'.repeat(500)}</p>${heading}`);
      }
      else if (url.pathname === '/title-challenge') body = html('Query page', `<p>${'正常页面内容。'.repeat(500)}</p><h1 title="安全验证" style="width:200px;height:30px"></h1>`);
      else if (url.pathname === '/body-login') body = html('数据库访问', '<p>请先登录后检索</p>');
      else if (url.pathname === '/denied') { status = 403; body = html('数据库访问', '<p>权限不足</p>'); }
      else { status = 404; body = html('404', '<p>不存在</p>'); }
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(body);
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); baseURL = `http://127.0.0.1:${server.address().port}`;
    await main();
  } catch (error) { report.tests.push({ name: 'fixture initialization', passed: false, error: error.stack || String(error) }); process.stderr.write(String(error.stack || error) + '\n'); }
  finally {
    for (const session of sessions.reverse()) { try { await session.close(); } catch (error) { report.cleanup_errors ||= []; report.cleanup_errors.push(String(error)); } }
    if (locatorPrototype) { locatorPrototype.ariaSnapshot = originalAria; locatorPrototype.innerText = originalInnerText; }
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    report.finished_at = new Date().toISOString(); report.passed = report.tests.filter(item => item.passed).length; report.failed = report.tests.filter(item => !item.passed).length;
    const reportPath = path.join(__dirname, 'v281-speed-tests.json'); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(`Results: ${report.passed} passed, ${report.failed} failed. ${reportPath}\n`); process.exitCode = report.failed ? 1 : 0;
  }
})();
