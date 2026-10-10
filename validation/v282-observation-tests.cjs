#!/usr/bin/env node
'use strict';

// Real, visible Chrome with test-owned profiles and a loopback HTTP server.
// No connection to the user's browser, daemon, cookies or public websites.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { once } = require('node:events');
const { performance } = require('node:perf_hooks');
const currentModule = require('../ai-literacy-search/scripts/browser.cjs');
const baselineEntry = process.env.AI_LITERACY_BASELINE_BROWSER || path.join(os.homedir(), '.agents/skills/ai-literacy-search/scripts/browser.cjs');
const baselineModule = fs.existsSync(baselineEntry) ? require(baselineEntry) : null;
const baseline = baselineModule?.VERSION === '2.8.1' && baselineEntry !== path.resolve(__dirname, '../ai-literacy-search/scripts/browser.cjs') ? baselineModule : null;
const runtimeDir = process.env.AI_LITERACY_RUNTIME_DIR || path.join(os.homedir(), '.ailiteracy-runtime');
const runDir = fs.mkdtempSync(path.join(__dirname, 'v282-observation-run-'));
const report = { started_at: new Date().toISOString(), helper_version: currentModule.VERSION,
  baseline_version: baseline?.VERSION ?? null, baseline_entry: baseline ? baselineEntry : null,
  run_dir: runDir, kind: 'visible Google Chrome; separate test-owned profiles; local HTTP fixtures; counts are not public-site speed predictions', tests: [], comparisons: [] };
const sessions = [], requests = [], baselineMeasurements = new Map();
let server, baseURL, sequence = 0;
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const html = body => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>本地检索</title><body>${body}</body></html>`;
const source = () => ({ id: 'fixture', name: '本地检索测试', url: baseURL + '/entry', domains: ['127.0.0.1'] });
const question = value => ({ id: `observation-question-${++sequence}`, type: 'single', question: `检索题名“${value}”。`, options: { A: '当前记录', B: '旧记录' } });
const entryRequests = () => requests.filter(item => item === '/entry').length;
const snapshot = session => ({ revision_reads: session.testCounts.revision_reads, observations: session.testCounts.observations });
const delta = (session, before) => Object.fromEntries(Object.entries(snapshot(session)).map(([key, value]) => [key, value - before[key]]));

async function test(name, action) {
  const start = performance.now();
  try { const detail = await action(); report.tests.push({ name, passed: true, elapsed_ms: +(performance.now() - start).toFixed(1), ...(detail ? { detail } : {}) }); process.stdout.write(`PASS ${name}\n`); }
  catch (error) { report.tests.push({ name, passed: false, elapsed_ms: +(performance.now() - start).toFixed(1), error: error.stack || String(error) }); process.stdout.write(`FAIL ${name}: ${error.message}\n`); }
}

async function makeSession(module, label) {
  const fixtureSource = source();
  const recipe = { id: 'fixture:lookup', source_id: 'fixture', status: 'query_verified', entry_url: fixtureSource.url,
    transitions: { results: { mode: 'same-page', container: { css: '#results' }, ready: { css: '#results' },
      match: { css: '#echo', match: 'contains' }, timeoutMs: 1000 } },
    execution: { version: 1, queryMode: 'literal', resetEntry: true,
      parameters: { query: { type: 'string', required: true } },
      prepare: [{ action: 'fill', locator: { css: '#query' }, parameter: 'query' }],
      submit: { action: 'click', locator: { css: '#submit' } }, echoParameters: ['query'] } };
  const outputDir = path.join(runDir, label);
  const session = new module.SearchSession({ sessionId: label, outputDir, profileDir: path.join(outputDir, 'profile'), runtimeDir,
    catalog: { sources: [fixtureSource] }, recipeIndex: { sources: [{ ...fixtureSource, recipe_ids: [recipe.id] }] }, recipes: [recipe],
    headless: false, archive: false, screenshots: false, navigationTimeoutMs: 5000 });
  sessions.push(session);
  session.testCounts = { revision_reads: 0, observations: 0 };
  const originalRevision = session.observationRevision, originalObserve = session.observe;
  session.observationRevision = async function (...args) { this.testCounts.revision_reads++; return originalRevision.apply(this, args); };
  session.observe = async function (...args) { this.testCounts.observations++; return originalObserve.apply(this, args); };
  await session.start();
  const page = await session.page('fixture', { recipeId: 'fixture:lookup' });
  const agent = await page.evaluate(() => navigator.userAgent);
  assert.match(agent, /Chrome\//); assert.doesNotMatch(agent, /HeadlessChrome|Edg\//);
  session.testPage = page;
  return session;
}

async function mutateMarker(page, marker) {
  await page.evaluate(value => { document.getElementById('marker').textContent = value; }, marker);
}

async function seekCSS(page, finished = true) {
  return page.locator('#css-node').evaluate((element, end) => {
    for (const animation of document.getAnimations()) animation.currentTime = end ? 1000 : 0;
    return getComputedStyle(element).visibility;
  }, finished);
}

async function captureWithCSSChange(session, options) {
  const original = session.observationRevision; let calls = 0;
  session.observationRevision = async function (...args) {
    // Initial revision, cache validation, then final revision. Seek a real CSS
    // animation before the final check without changing any DOM attributes.
    if (++calls === 3) await seekCSS(session.testPage);
    return original.apply(this, args);
  };
  try { return await session.captureEvidenceBatch(session.testPage, options); }
  finally { session.observationRevision = original; }
}

const missCases = [
  { id: 'no-cache', prepare: session => session.observations.delete(session.testPage) },
  { id: 'status-to-full', initialDetail: 'status', finalDetail: 'full', prepare() {} },
  { id: 'new-question', prepare: session => session.beginQuestion(question('新题')) },
  { id: 'new-attempt', initialQuestion: true, prepare(session, q) { session.finishQuestion(q); session.beginQuestion(q); } },
  { id: 'document-epoch', async prepare(session) {
    const page = session.testPage, epoch = session.documentEpochs.get(page); await page.reload({ waitUntil: 'domcontentloaded' });
    assert.ok(session.documentEpochs.get(page) > epoch);
  } },
  { id: 'frame-epoch', async prepare(session) {
    const page = session.testPage, epoch = session.frameEpochs.get(page);
    const attached = page.waitForEvent('frameattached');
    await page.evaluate(url => { const frame = document.createElement('iframe'); frame.id = 'temporary-frame'; frame.src = url; document.body.append(frame); }, baseURL + '/frame');
    const frame = await attached; await frame.waitForLoadState('domcontentloaded');
    const detached = page.waitForEvent('framedetached'); await page.locator('#temporary-frame').evaluate(element => element.remove()); await detached;
    assert.equal(page.frames().length, 1); assert.ok(session.frameEpochs.get(page) > epoch);
  } },
  { id: 'iframe-present', async prepare(session) {
    const page = session.testPage, attached = page.waitForEvent('frameattached');
    await page.evaluate(url => { const frame = document.createElement('iframe'); frame.id = 'live-frame'; frame.src = url; document.body.append(frame); }, baseURL + '/frame');
    const frame = await attached; await frame.waitForLoadState('domcontentloaded');
    await session.observe(page, { detail: 'full' });
    // Only the child changes first: the top document's mutation stamp cannot
    // establish that an iframe observation is reusable.
    await frame.locator('#frame-marker').evaluate(element => { element.textContent = '子页面最新数据'; });
    assert.equal(await frame.locator('#frame-marker').innerText(), '子页面最新数据');
    assert.equal(page.frames().length, 2);
  } },
  { id: 'unstable-observation', prepare(session) { session.observations.get(session.testPage).stable = false; } },
];

async function measureMiss(session, item, expectedReads) {
  const page = session.testPage;
  session.activeQuestion = null;
  await page.goto(baseURL + '/entry', { waitUntil: 'domcontentloaded' });
  const q = item.initialQuestion ? question('重试题') : null;
  if (q) session.beginQuestion(q);
  await session.observe(page, { detail: item.initialDetail ?? 'full' });
  await item.prepare(session, q);
  const marker = `最新状态-${item.id}-${++sequence}`;
  await mutateMarker(page, marker);
  const before = snapshot(session), observed = await session.currentObservation(page, { detail: item.finalDetail ?? 'full' }), measured = delta(session, before);
  assert.equal(measured.revision_reads, expectedReads); assert.equal(measured.observations, 1);
  assert.ok(observed.text.includes(marker), 'must read the current document instead of stale cached text');
  if (item.finalDetail === 'full') assert.equal(observed.detail, 'full');
  return { ...measured, current_text_verified: true, frames: page.frames().length };
}

async function main() {
  if (baseline) {
    const old = await makeSession(baseline, 'baseline-281');
    await test('旧2.8.1基线复现：超过250控件后的密码未被完整观察捕获', async () => {
      const detail = [];
      for (const kind of ['links', 'buttons']) for (const mode of ['full', 'status']) {
        await old.testPage.goto(`${baseURL}/saturated?kind=${kind}&type=PASSWORD`, { waitUntil: 'domcontentloaded' });
        const observed = await old.observe(old.testPage, { detail: mode });
        assert.equal(observed.controls.length, 250); assert.ok(!observed.controls.some(control => control.type.toLowerCase() === 'password'));
        const authorization = old.classify(source(), observed, observed.http_status).authorization;
        assert.equal(authorization, 'not_observed'); detail.push({ kind, detail: mode, controls: observed.controls.length, authorization });
      }
      return detail;
    });
    for (const item of missCases) await test(`旧2.8.1基线：${item.id}需3次revision读取`, async () => {
      const measured = await measureMiss(old, item, 3); baselineMeasurements.set(item.id, measured); return measured;
    });
    await old.close();
  }
  const session = await makeSession(currentModule, 'current-observation'), page = session.testPage;
  for (const kind of ['links', 'buttons']) for (const detail of ['full', 'status']) await test(`${detail}：270个${kind}后TYPE=PASSWORD仍保留且runner不离开原页`, async () => {
    session.activeQuestion = null;
    await page.goto(`${baseURL}/saturated?kind=${kind}&type=PASSWORD`, { waitUntil: 'domcontentloaded' });
    const originalURL = page.url(), observed = await session.observe(page, { detail });
    assert.equal(observed.controls.length, 250); assert.equal(observed.controls[0].type, 'password');
    assert.ok(observed.controls.some(control => control.id === 'credential')); assert.ok(!Object.hasOwn(observed.controls[0], 'value'));
    assert.equal(session.classify(source(), observed, observed.http_status).authorization, 'login_required'); assert.equal(session.life(page).protected, true);
    const compact = await session.currentObservation(page, { detail, compact: true });
    assert.equal(compact.controls.length, 80); assert.equal(compact.controls[0].type, 'password');
    const query = `密码末尾-${kind}-${detail}`, q = question(query), requestsBefore = entryRequests();
    const result = await session.runSearch(q, { recipeId: 'fixture:lookup', parameters: { query }, parameterQuotes: { query }, capture: false });
    assert.equal(result.status, 'blocked'); assert.equal(result.reason, 'login_required'); assert.equal(page.url(), originalURL); assert.equal(entryRequests() - requestsBefore, 0);
    session.finishQuestion(q); return { full_controls: observed.controls.length, compact_controls: compact.controls.length, authorization: 'login_required', entry_navigations: 0 };
  });
  for (const detail of ['full', 'status']) await test(`${detail}：caller改写返回文本和password控件不能污染缓存或授权判断`, async () => {
    session.activeQuestion = null;
    await page.goto(baseURL + '/saturated?kind=links&type=password', { waitUntil: 'domcontentloaded' });
    const first = await session.observe(page, { detail }), raw = session.observations.get(page).observed;
    assert.notStrictEqual(first, raw); assert.notStrictEqual(first.controls, raw.controls); assert.notStrictEqual(first.controls[0], raw.controls[0]);
    first.title = '伪造标题'; first.text = '伪造正文'; first.controls[0].type = 'text'; first.controls[0].label = '伪造标签'; first.controls.length = 0;
    const before = snapshot(session), second = await session.currentObservation(page, { detail }), measured = delta(session, before);
    assert.equal(measured.revision_reads, 1); assert.equal(measured.observations, 0);
    assert.equal(second.title, '本地检索'); assert.notEqual(second.text, '伪造正文'); assert.equal(second.controls[0].type, 'password');
    assert.equal(second.controls[0].label, '凭据输入'); assert.equal(session.classify(source(), second, second.http_status).authorization, 'login_required');
    second.controls[0].type = 'search'; assert.equal(raw.controls[0].type, 'password'); return measured;
  });
  for (const item of missCases) await test(`优化后：${item.id}仅2次revision读取并取得当前页面`, async () => {
    const after = await measureMiss(session, item, 2), before = baselineMeasurements.get(item.id) ?? null;
    report.comparisons.push({ case: item.id, before, after }); return { before, after };
  });
  await test('可复用候选仍检查实时revision：新增password必须重新观察并阻塞', async () => {
    session.activeQuestion = null; await page.goto(baseURL + '/entry'); await session.observe(page, { detail: 'status' });
    await page.evaluate(() => { const input = document.createElement('input'); input.type = 'password'; input.id = 'new-credential'; document.body.append(input); });
    const before = snapshot(session), observed = await session.currentObservation(page, { detail: 'status' }), measured = delta(session, before);
    assert.equal(measured.revision_reads, 3); assert.equal(measured.observations, 1); assert.ok(observed.controls.some(control => control.id === 'new-credential'));
    assert.equal(session.classify(source(), observed, observed.http_status).authorization, 'login_required'); return measured;
  });
  await test('revision读取期间切换题目，读取后仍复核题目/attempt并取得最新数据', async () => {
    session.activeQuestion = null; await page.goto(baseURL + '/entry'); await session.observe(page, { detail: 'status' });
    const original = session.observationRevision, marker = '读取期间的新题状态'; let injected = false;
    session.observationRevision = async function (...args) { const revision = await original.apply(this, args); if (!injected) { injected = true; this.beginQuestion(question('读取期间新题')); await mutateMarker(page, marker); } return revision; };
    const before = snapshot(session); let observed;
    try { observed = await session.currentObservation(page, { detail: 'status' }); } finally { session.observationRevision = original; }
    const measured = delta(session, before); assert.equal(measured.revision_reads, 3); assert.equal(measured.observations, 1); assert.ok(observed.text.includes(marker)); return measured;
  });
  await test('revision读取期间新增iframe，读取后仍复核frame数量并重新观察', async () => {
    session.activeQuestion = null; await page.goto(baseURL + '/entry'); await session.observe(page, { detail: 'status' });
    const original = session.observationRevision, marker = '读取期间新增子页面'; let injected = false;
    session.observationRevision = async function (...args) {
      const revision = await original.apply(this, args);
      if (!injected) { injected = true; const attached = page.waitForEvent('frameattached');
        await page.evaluate(url => { const frame = document.createElement('iframe'); frame.src = url; document.body.append(frame); document.getElementById('marker').textContent = '读取期间新增子页面'; }, baseURL + '/frame');
        const frame = await attached; await frame.waitForLoadState('domcontentloaded'); }
      return revision;
    };
    const before = snapshot(session); let observed;
    try { observed = await session.currentObservation(page, { detail: 'status' }); } finally { session.observationRevision = original; }
    const measured = delta(session, before); assert.equal(measured.revision_reads, 3); assert.equal(measured.observations, 1); assert.equal(page.frames().length, 2); assert.ok(observed.text.includes(marker)); return measured;
  });
  for (const mode of ['body-login', 'aria-heading', 'nested-aria', 'nested-image', 'reference-image', 'pseudo-heading']) for (const detail of ['full', 'status']) await test(`${detail}：纯CSS显示${mode}后拒绝复用旧授权，runner保留原页`, async () => {
    session.activeQuestion = null; await page.goto(`${baseURL}/css?mode=${mode}`);
    const query = `CSS授权-${mode}-${detail}`, q = question(query); session.beginQuestion(q);
    const initial = await session.observe(page, { detail }), firstRevision = await session.observationRevision(page);
    assert.equal(session.classify(source(), initial, initial.http_status).authorization, 'not_observed');
    assert.equal(await seekCSS(page), 'visible');
    const finalRevision = await session.observationRevision(page);
    assert.equal(firstRevision.revision, finalRevision.revision); assert.equal(firstRevision.controls, finalRevision.controls);
    if (mode === 'body-login') assert.notEqual(firstRevision.renderedText, finalRevision.renderedText);
    else { assert.equal(firstRevision.renderedText, finalRevision.renderedText); assert.notEqual(firstRevision.renderedHeadings, finalRevision.renderedHeadings); }
    const originalURL = page.url(), beforeEntries = entryRequests();
    const result = await session.runSearch(q, { recipeId: 'fixture:lookup', parameters: { query }, parameterQuotes: { query }, capture: false });
    const expected = mode === 'body-login' ? 'login_required' : 'challenge';
    assert.equal(result.status, 'blocked'); assert.equal(result.reason, expected); assert.equal(page.url(), originalURL); assert.equal(entryRequests() - beforeEntries, 0);
    assert.equal(session.life(page).protected, true); session.finishQuestion(q);
    return { dom_revision_unchanged: true, authorization: expected, entry_navigations: 0, originally_observed_detail: initial.detail };
  });
  for (const detail of ['full', 'status']) await test(`${detail}：纯CSS隐藏正文后读取当前文本，静态页面仍只需1次revision即可复用`, async () => {
    session.activeQuestion = null; await page.goto(baseURL + '/css?mode=hide-evidence');
    const initial = await session.observe(page, { detail }); assert.match(initial.text, /可引用记录CSS-2026/);
    assert.equal(await seekCSS(page), 'hidden');
    const before = snapshot(session), current = await session.currentObservation(page, { detail }), changed = delta(session, before);
    assert.doesNotMatch(current.text, /可引用记录CSS-2026/); assert.equal(changed.revision_reads, 3); assert.equal(changed.observations, 1);
    const beforeReuse = snapshot(session); await session.currentObservation(page, { detail }); const reused = delta(session, beforeReuse);
    assert.equal(reused.revision_reads, 1); assert.equal(reused.observations, 0); return { changed, reused };
  });
  await test('纯CSS在观察before/after之间显示登录提示，不把不稳定快照标成可复用', async () => {
    session.activeQuestion = null; await page.goto(baseURL + '/css?mode=body-login');
    const original = session.observationRevision; let calls = 0;
    session.observationRevision = async function (...args) { if (++calls === 2) await seekCSS(page); return original.apply(this, args); };
    try { await session.observe(page, { detail: 'status' }); } finally { session.observationRevision = original; }
    assert.equal(session.observations.get(page).stable, false);
    const before = snapshot(session), current = await session.currentObservation(page, { detail: 'status' }), measured = delta(session, before);
    assert.equal(measured.revision_reads, 2); assert.equal(measured.observations, 1); assert.equal(session.classify(source(), current, current.http_status).authorization, 'login_required'); return measured;
  });
  await test('capture前纯CSS隐藏已缓存摘录，拒绝引用旧可见文本', async () => {
    session.activeQuestion = null; await page.goto(baseURL + '/css?mode=hide-evidence');
    const q = question('CSS证据隐藏'); session.beginQuestion(q); await session.observe(page, { detail: 'status' }); await seekCSS(page);
    const before = session.evidence.length;
    await assert.rejects(() => session.captureEvidenceBatch(page, { questionId: q.id, name: '本地检索', query: 'CSS证据隐藏', field: '记录', locator: 'body', excerpts: ['可引用记录CSS-2026'] }), /excerpt was not found/);
    assert.equal(session.evidence.length, before); session.finishQuestion(q); return { recorded_evidence: 0 };
  });
  for (const [mode, expectedError] of [['hide-evidence', /cited evidence changed/], ['aria-heading', /page became blocked/]]) await test(`capture期间纯CSS变化${mode}，保存前重新核验摘录和当前授权`, async () => {
    session.activeQuestion = null; await page.goto(`${baseURL}/css?mode=${mode}`);
    const q = question('CSS捕获期间'); session.beginQuestion(q); await session.observe(page, { detail: 'status' });
    const before = session.evidence.length, excerpts = [mode === 'hide-evidence' ? '可引用记录CSS-2026' : '原始数据'];
    await assert.rejects(() => captureWithCSSChange(session, { questionId: q.id, name: '本地检索', query: 'CSS捕获期间', field: '记录', locator: 'body', excerpts }), expectedError);
    assert.equal(session.evidence.length, before); session.finishQuestion(q); return { recorded_evidence: 0 };
  });
  await test('capture期间无关CSS广告出现，真实摘录未变仍可保存', async () => {
    session.activeQuestion = null; await page.goto(baseURL + '/css?mode=advert');
    const q = question('CSS无关广告'); session.beginQuestion(q); await session.observe(page, { detail: 'status' });
    const before = session.evidence.length;
    const captured = await captureWithCSSChange(session, { questionId: q.id, name: '本地检索', query: 'CSS无关广告', field: '记录', locator: 'body', excerpts: ['原始数据'] });
    assert.equal(captured.sources.length, 1); assert.equal(session.evidence.length, before + 1); assert.equal(captured.sources[0].evidence, '原始数据');
    session.finishQuestion(q); return { recorded_evidence: 1 };
  });
}

(async () => {
  try {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`); requests.push(url.pathname);
      if (url.pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
      let body;
      if (url.pathname === '/saturated') {
        const kind = url.searchParams.get('kind');
        body = '<h1>本地检索</h1><p id="marker">当前数据</p>' + Array.from({ length: 270 }, (_, i) => kind === 'buttons' ? `<button type="button">操作${i}</button>` : `<a href="#item-${i}">页面${i}</a>`).join('') + `<input TYPE="${escape(url.searchParams.get('type') || 'password')}" id="credential" aria-label="凭据输入">`;
      } else if (url.pathname === '/css') {
        const mode = url.searchParams.get('mode'), hiding = mode === 'hide-evidence';
        const animation = mode === 'pseudo-heading' ? '<style>@keyframes css-name{from{visibility:hidden}to{visibility:visible}}#css-node::before{content:"安全验证";animation:css-name 1s step-end both paused}</style>'
          : `<style>@keyframes css-toggle{from{visibility:${hiding ? 'visible' : 'hidden'}}to{visibility:${hiding ? 'hidden' : 'visible'}}}#css-node{animation:css-toggle 1s step-end both paused}</style>`;
        let content;
        if (mode === 'body-login') content = '<p id="css-node">请先登录后检索</p>';
        else if (mode === 'aria-heading') content = '<div role="heading" aria-level="2" aria-label="安全验证" id="css-node" style="width:200px;height:30px"></div>';
        else if (mode === 'nested-aria') content = '<h3 style="width:200px;height:30px"><span aria-label="安全验证" id="css-node" style="display:inline-block;width:100px;height:20px"></span></h3>';
        else if (mode === 'nested-image') content = `<h4 style="width:200px;height:30px"><img alt="安全验证" id="css-node" width="16" height="16" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Crect width='16' height='16'/%3E%3C/svg%3E"></h4>`;
        else if (mode === 'reference-image') content = `<h5 aria-labelledby="outside-name" style="width:200px;height:30px"></h5><span id="outside-name"><img alt="安全验证" id="css-node" width="16" height="16" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Crect width='16' height='16'/%3E%3C/svg%3E"></span>`;
        else if (mode === 'pseudo-heading') content = '<h6 id="css-node" style="width:200px;height:30px"></h6>';
        else if (hiding) content = '<p id="css-node">可引用记录CSS-2026</p>';
        else content = '<p id="css-node">广告位更新</p>';
        body = animation + '<h1>本地检索</h1><p id="marker">原始数据</p><input type="search" id="query" aria-label="题名"><button id="submit">检索</button>' + content;
      } else if (url.pathname === '/frame') body = '<p id="frame-marker">子页面原始数据</p>';
      else body = '<h1>本地检索</h1><p id="marker">原始数据</p><input type="search" id="query" aria-label="题名"><button id="submit">检索</button>';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(html(body));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); baseURL = `http://127.0.0.1:${server.address().port}`;
    await main();
  } catch (error) { report.tests.push({ name: 'fixture initialization', passed: false, error: error.stack || String(error) }); process.stderr.write(String(error.stack || error) + '\n'); }
  finally {
    for (const session of sessions.reverse()) { try { await session.close(); } catch (error) { report.cleanup_errors ||= []; report.cleanup_errors.push(String(error)); } }
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    report.finished_at = new Date().toISOString(); report.passed = report.tests.filter(item => item.passed).length; report.failed = report.tests.filter(item => !item.passed).length;
    const reportPath = path.join(__dirname, 'v282-observation-tests.json'); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(`Results: ${report.passed} passed, ${report.failed} failed. ${reportPath}\n`); process.exitCode = report.failed ? 1 : 0;
  }
})();
