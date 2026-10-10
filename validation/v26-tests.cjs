#!/usr/bin/env node
'use strict';

// Real Google Chrome + Playwright against controlled local HTTP fixtures.
// This reports local navigation/observation counts; no claim about live sites.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { createSession } = require('../ai-literacy-search/scripts/browser.cjs');

const runDir = fs.mkdtempSync(path.join(__dirname, 'v26-runner-run-'));
const report = { started_at: new Date().toISOString(), kind: 'real Google Chrome; direct Playwright; local parameterized runner fixtures', run_dir: runDir, tests: [] };
const sessions = [], requests = [];
let server, baseURL, sequence = 0;
const stamp = () => new Date().toISOString();
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const html = (title, body) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escape(title)}</title></head><body><h1>${escape(title)}</h1>${body}</body></html>`;
const freshQuery = label => `未见实体-${label}-${Date.now()}-${++sequence}`;

async function test(name, fn) {
  const started = Date.now();
  try { const detail = await fn(); report.tests.push({ name, passed: true, elapsed_ms: Date.now() - started, ...(detail ? { detail } : {}) }); process.stdout.write(`PASS ${name}\n`); }
  catch (error) { report.tests.push({ name, passed: false, elapsed_ms: Date.now() - started, error: error.stack || String(error) }); process.stdout.write(`FAIL ${name}: ${error.message}\n`); }
}

function form(mode) {
  const target = mode === 'popup' || mode === 'challenge' || mode === 'failure' || mode === 'changed' || mode === 'professional-missing' ? ' target="_blank"' : mode === 'reuse-target' ? ' target="runner-results"' : mode === 'iframe' ? ' target="runner-frame"' : '';
  const action = mode === 'challenge' ? '/challenge' : mode === 'failure' ? '/service-error' : mode === 'professional-missing' ? '/partial-results' : '/results';
  const fields = `<label for="query">${mode === 'changed' ? '变更字段' : '题名'}</label><input type="search" id="query" name="query"><label for="author">作者</label><input id="author" name="author"><label for="year">年份</label><input id="year" name="year"><label for="sort">排序</label><select id="sort" name="sort"><option value="">默认</option><option value="desc">年份降序</option><option value="asc">年份升序</option></select>`;
  const duplicated = mode === 'duplicate' ? '<label for="query2">题名</label><input type="search" id="query2" name="query2">' : '';
  const frame = mode === 'iframe' ? '<iframe id="runner-frame" name="runner-frame" src="/blank-frame" title="检索结果"></iframe>' : '';
  if (mode === 'ajax') return `<form id="search" onsubmit="event.preventDefault();const data=new URLSearchParams(new FormData(this));fetch('/fragment?'+data).then(r=>r.text()).then(text=>document.getElementById('result-host').innerHTML=text)">${fields}${duplicated}<button type="submit">检索</button></form><div id="result-host"></div>`;
  if (mode === 'delayed-popup') return `<form id="search" onsubmit="event.preventDefault();const data=new URLSearchParams(new FormData(this));setTimeout(()=>window.open('/results?'+data,'_blank'),170)">${fields}${duplicated}<button type="submit">检索</button></form>`;
  return `<form id="search" action="${action}"${target}>${fields}${duplicated}<button type="submit">检索</button></form>${frame}`;
}

function results(url, partial = false) {
  const query = url.searchParams.get('query') || '', author = url.searchParams.get('author') || '', year = url.searchParams.get('year') || '', sort = url.searchParams.get('sort') || 'default';
  let records = [{ id: 'NEW-2026', year: 2026, author: author || '新作者甲' }, { id: 'NEW-2023', year: 2023, author: author || '新作者乙' }];
  if (sort === 'asc') records.reverse();
  if (query === '正常无结果') records = [];
  const displayedQuery = partial ? query.match(/"([^"]+)"/)?.[1] || query : query;
  return `<section id="condition-echo"><output id="query-echo" data-query="${escape(query)}">${escape(displayedQuery)}</output><p id="filter-echo">作者=${escape(author)}；年份=${escape(year)}；排序=${escape(sort)}</p></section><main id="results" data-complete="true"><p id="result-count">找到${records.length}条结果。</p>${records.map(record => `<article class="record-row" data-record-id="${record.id}"><a class="record-link" target="_blank" href="/detail?id=${record.id}&query=${encodeURIComponent(query)}">${escape(query)}</a><span class="author">${escape(record.author)}</span><span class="year">${record.year}</span><span class="record-id">${record.id}</span></article>`).join('')}${records.length ? '' : '<p id="empty">没有符合条件的文献。</p>'}</main>`;
}

async function startServer() {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
    requests.push({ path: url.pathname, query: url.search, at: stamp() });
    let body, status = 200;
    if (url.pathname === '/home') body = html('数据库首页', `<a href="/search?mode=${escape(url.searchParams.get('mode') || 'popup')}">专业检索入口</a>`);
    else if (url.pathname === '/search') body = html('数据库检索', form(url.searchParams.get('mode') || 'popup'));
    else if (url.pathname === '/results') body = html('数据库检索结果', results(url));
    else if (url.pathname === '/partial-results') body = html('数据库不完整条件结果', results(url, true));
    else if (url.pathname === '/fragment') body = results(url);
    else if (url.pathname === '/challenge') body = html('安全验证', `<p>请完成人机验证</p><a id="verify-done" href="/results${escape(url.search)}">本地模拟验证完成</a>`);
    else if (url.pathname === '/service-error') { status = 503; body = html('503 Service Unavailable', '<p>检索服务暂时不可用。</p>'); }
    else if (url.pathname === '/detail') body = html('记录详情', `<main id="record"><p>${escape(url.searchParams.get('query') || '')}</p><p id="record-id">${escape(url.searchParams.get('id') || '')}</p></main>`);
    else body = html('空白frame', '<p>尚未检索。</p>');
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(body);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); baseURL = `http://127.0.0.1:${server.address().port}`;
}

function eventCounts(session) {
  const events = fs.readFileSync(session.eventsPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { observations: events.filter(event => event.event === 'page_observed').length, navigations: events.filter(event => event.event === 'navigation_completed').length, event_total: events.length };
}

function question(query, id = `question-${++sequence}`, extras = '') {
  return { id, type: 'single', question: `检索题名“${query}”的记录${extras}。`, options: { A: 'NEW-2026', B: 'NEW-2023' } };
}

function answer(q, labels, sources) {
  return { id: q.id, question: q.question, type: q.type, status: 'verified', answer_labels: labels, answer: labels.map(label => q.options[label]), explanation: '实际检索结果支持当前选项。', option_evaluations: Object.entries(q.options).map(([label, text]) => ({ label, text, verdict: labels.includes(label) ? 'supported' : 'refuted', reason: '根据本题实际记录字段核验。' })), sources, needs_review: [], searched_at: stamp() };
}

function buildRecipe(mode, source) {
  const frame = mode === 'iframe' ? { frame: '#runner-frame' } : {};
  return {
    id: `runner-${mode}`, source_id: source.id, status: 'query_verified', entry_url: `${baseURL}/search?mode=${mode}`,
    transitions: { results: { mode: ['challenge', 'failure', 'delayed-popup', 'duplicate', 'changed', 'professional-missing'].includes(mode) ? 'popup' : mode === 'ajax' ? 'same-page' : mode,
      container: { ...frame, css: '#results' }, ready: { ...frame, css: '#results[data-complete="true"]' }, match: { ...frame, css: '#condition-echo', match: 'contains' }, empty: { ...frame, css: '#empty' }, timeoutMs: 1600 } },
    execution: { version: 1, parameters: { query: { type: 'string', required: true }, author: { type: 'string', required: false }, year: { type: 'string', required: false }, sort: { type: 'string', required: false, evidenceValues: { desc: '年份降序', asc: '年份升序' } } },
      prepare: [{ action: 'fill', locator: { role: 'searchbox', name: '题名', exact: true }, parameter: 'query' }, { action: 'fill', locator: { label: '作者', exact: true }, parameter: 'author', omit: 'clear' }, { action: 'fill', locator: { label: '年份', exact: true }, parameter: 'year', omit: 'clear' }, { action: 'select', locator: { label: '排序', exact: true }, parameter: 'sort', omit: 'empty-option' }],
      submit: { action: 'click', locator: { role: 'button', name: '检索', exact: true } }, resetEntry: true, echoParameters: ['query', 'author', 'year', 'sort'] },
  };
}

async function makeSession(mode, options = {}) {
  const { professional = false, ...sessionOptions } = options;
  const id = `runner-${mode}-${++sequence}`, outputDir = path.join(runDir, id);
  const source = { id: 'testdb', name: '官方数据库本地测试', url: `${baseURL}/home?mode=${mode}`, domains: ['127.0.0.1'], kind: 'official_database' };
  const recipe = buildRecipe(mode, source);
  if (professional) { recipe.execution.queryMode = 'professional'; recipe.syntax = { fields: { TI: '篇名', AU: '作者' }, operators: ['AND', 'OR', 'NOT'] }; }
  if (mode === 'professional-missing') recipe.execution.echoParameters = [];
  const session = await createSession({ sessionId: id, outputDir, profileDir: path.join(outputDir, 'profile'), catalog: { sources: [source] }, recipeIndex: { version: '2.6.0', sources: [{ id: source.id, source_id: source.id, recipe_ids: [recipe.id] }] }, recipes: [recipe], headless: true, archive: true, screenshots: true, preflightSourceIds: [source.id], maxPages: 5, navigationTimeoutMs: 6000, ...sessionOptions });
  sessions.push(session); await session.preflight(); return { session, source, recipe, mode };
}

async function run(fixture, q, parameters, extra = {}) {
  fixture.session.beginQuestion(q);
  const parameterQuotes = Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key, key === 'sort' ? ({ desc: '年份降序', asc: '年份升序' }[value] || value) : value]));
  return fixture.session.runSearch(q, { recipeId: fixture.recipe.id, parameters, parameterQuotes, ...extra });
}

async function proof(fixture, q, result, excerpts) {
  const captured = await fixture.session.captureEvidenceBatch(result.page, { questionId: q.id, name: fixture.source.name, query: await result.page.locator('#query-echo').getAttribute('data-query'), field: '本题当前结果记录', locator: '#results', target: result.container, excerpts });
  assert.ok(captured.artifact.snapshot && captured.artifact.screenshot);
  return captured;
}

async function rejectedOrNeedsObservation(operation) {
  let result;
  try { result = await operation(); }
  catch (error) { return { status: 'rejected', reason: error.message }; }
  assert.ok(['needs_observation', 'blocked', 'failed'].includes(result.status), `unexpected successful result ${result.status}`); return result;
}

async function main() {
  await test('一调用处理新实体和当前author/year条件：不带旧样题值', async () => {
    const fixture = await makeSession('popup'); const query = freshQuery('组合条件'); const q = question(query, undefined, '，作者为新作者辛，年份为2026，按年份降序');
    const result = await run(fixture, q, { query, author: '新作者辛', year: '2026', sort: 'desc' });
    assert.equal(result.status, 'ready'); assert.equal(result.outcome, 'results'); assert.equal(result.binding.question_id, q.id);
    assert.equal(await result.page.locator('#query-echo').getAttribute('data-query'), query); assert.match(await result.page.locator('#filter-echo').innerText(), /作者=新作者辛；年份=2026；排序=desc/);
    assert.equal(await result.container.locator('.record-row').count(), 2); assert.equal(await result.container.locator('.record-row').first().getAttribute('data-record-id'), 'NEW-2026');
    fixture.session.completeQuestionPages(q.id); await fixture.session.close();
  });

  for (const mode of ['same-page', 'ajax', 'iframe', 'delayed-popup']) await test(`runner结果模式：${mode}`, async () => {
    const fixture = await makeSession(mode); const query = freshQuery(mode); const q = question(query); const result = await run(fixture, q, { query });
    assert.equal(result.status, 'ready'); assert.equal(result.binding.question_id, q.id); assert.equal(result.binding.role, 'results'); assert.equal(await result.container.locator('.record-row').count(), 2);
    if (mode === 'iframe') assert.equal(result.binding.frame_scoped, true);
    if (mode === 'ajax') assert.match(result.page.url(), /\/search\?mode=ajax$/);
    fixture.session.completeQuestionPages(q.id); await fixture.session.close();
  });

  await test('复用目标标签页绑定新题，未收到的optional条件清空', async () => {
    const fixture = await makeSession('reuse-target'); const firstQuery = freshQuery('第一题'), secondQuery = freshQuery('第二题');
    const firstQ = question(firstQuery, undefined, '，作者为作者旧甲，年份为2023'); const first = await run(fixture, firstQ, { query: firstQuery, author: '作者旧甲', year: '2023' });
    assert.equal(first.status, 'ready'); fixture.session.completeQuestionPages(firstQ.id);
    const secondQ = question(secondQuery); const second = await run(fixture, secondQ, { query: secondQuery });
    assert.equal(second.status, 'ready'); assert.equal(second.page, first.page); assert.equal(second.binding.question_id, secondQ.id);
    assert.equal(await second.page.locator('#query-echo').getAttribute('data-query'), secondQuery); assert.match(await second.page.locator('#filter-echo').innerText(), /作者=；年份=；排序=default/);
    fixture.session.completeQuestionPages(secondQ.id); await fixture.session.close();
  });

  await test('缺少必要query不提交检索', async () => {
    const fixture = await makeSession('popup'); const q = question(freshQuery('缺条件')); const before = requests.length;
    const result = await rejectedOrNeedsObservation(() => run(fixture, q, {})); assert.equal(requests.slice(before).filter(request => request.path === '/results').length, 0); assert.notEqual(result.status, 'ready'); await fixture.session.close();
  });

  await test('未声明的filter不提交检索，防止多余限制', async () => {
    const fixture = await makeSession('popup'); const query = freshQuery('额外条件'), q = question(query); const before = requests.length;
    const result = await rejectedOrNeedsObservation(() => run(fixture, q, { query, undisclosedLimit: '原题未给条件' })); assert.equal(requests.slice(before).filter(request => request.path === '/results').length, 0); assert.notEqual(result.status, 'ready'); await fixture.session.close();
  });

  await test('已声明但题干未给的year仍拒绝，不能从旧题添加条件', async () => {
    const fixture = await makeSession('popup'); const query = freshQuery('无年份'), q = question(query); const before = requests.length;
    const result = await rejectedOrNeedsObservation(() => run(fixture, q, { query, year: '1998' })); assert.equal(result.status, 'rejected'); assert.equal(requests.slice(before).filter(request => request.path === '/results').length, 0); await fixture.session.close();
  });

  await test('缺少本题parameterQuotes时拒绝，而不是按记忆填词', async () => {
    const fixture = await makeSession('popup'); const query = freshQuery('无摘录'), q = question(query); const before = requests.length;
    const result = await rejectedOrNeedsObservation(() => run(fixture, q, { query }, { parameterQuotes: {} })); assert.equal(result.status, 'rejected'); assert.equal(requests.slice(before).filter(request => request.path === '/results').length, 0); await fixture.session.close();
  });

  await test('上题query与quote不能应用到新的实体', async () => {
    const fixture = await makeSession('popup'); const query = freshQuery('当前题'), q = question(query); const before = requests.length;
    const result = await rejectedOrNeedsObservation(() => run(fixture, q, { query: '旧题实体乙' }, { parameterQuotes: { query: '旧题实体乙' } })); assert.equal(result.status, 'rejected'); assert.equal(requests.slice(before).filter(request => request.path === '/results').length, 0); await fixture.session.close();
  });

  await test('真实控件不唯一时停止，不能盲用nth或旧编号', async () => {
    const fixture = await makeSession('duplicate'); const query = freshQuery('非唯一'), q = question(query); const before = requests.length;
    const result = await rejectedOrNeedsObservation(() => run(fixture, q, { query })); assert.equal(requests.slice(before).filter(request => request.path === '/results').length, 0); assert.notEqual(result.status, 'ready'); await fixture.session.close();
  });

  await test('已确认query控件发生变化时停止并要求重新定位', async () => {
    const fixture = await makeSession('changed'); const query = freshQuery('控件变化'), q = question(query); fixture.session.beginQuestion(q);
    const before = requests.length; const result = await rejectedOrNeedsObservation(() => run(fixture, q, { query })); assert.notEqual(result.status, 'ready'); assert.equal(requests.slice(before).filter(request => request.path === '/results').length, 0); await fixture.session.close();
  });

  await test('正常零结果与搜索服务503失败区分', async () => {
    const emptyFixture = await makeSession('popup'), emptyQ = question('正常无结果'); const empty = await run(emptyFixture, emptyQ, { query: '正常无结果' });
    assert.equal(empty.status, 'ready'); assert.equal(empty.outcome, 'empty'); assert.equal(await empty.container.locator('.record-row').count(), 0); emptyFixture.session.completeQuestionPages(emptyQ.id); await emptyFixture.session.close();
    const failureFixture = await makeSession('failure'), failureQuery = freshQuery('失败'), failureQ = question(failureQuery); const failure = await rejectedOrNeedsObservation(() => run(failureFixture, failureQ, { query: failureQuery }));
    assert.notEqual(failure.status, 'ready'); assert.notEqual(failure.outcome, 'empty'); await failureFixture.session.close();
  });

  await test('结果页验证码保持断点，人工完成后恢复当前结果', async () => {
    const fixture = await makeSession('challenge'), query = freshQuery('验证恢复'), q = question(query); const result = await run(fixture, q, { query });
    assert.equal(result.status, 'blocked'); assert.equal(result.outcome, 'failed'); assert.ok(fixture.session.life(result.page).protected);
    await Promise.all([result.page.waitForURL(/\/results\?/), result.page.locator('#verify-done').click()]);
    const resumed = await fixture.session.resumeTransition('testdb', { role: 'results', questionId: q.id }); assert.equal(resumed.status, 'ready'); assert.equal(await resumed.page.locator('#query-echo').getAttribute('data-query'), query);
    fixture.session.completeQuestionPages(q.id); await fixture.session.close();
  });

  await test('同页有效快照复用：证据保存不重复读取完整DOM', async () => {
    const fixture = await makeSession('popup'), query = freshQuery('复用快照'), q = question(query); const result = await run(fixture, q, { query });
    assert.equal(result.status, 'ready'); const before = eventCounts(fixture.session); const originalSnapshot = result.observation.artifact;
    const captured = await proof(fixture, q, result, ['NEW-2026']); const after = eventCounts(fixture.session);
    assert.equal(captured.artifact.snapshot, originalSnapshot, 'unchanged result must reuse the captured observation'); assert.equal(after.observations, before.observations, 'evidence capture should not add a full page_observed stage');
    fixture.session.completeQuestionPages(q.id); await fixture.session.close(); return { observation_stages_added: after.observations - before.observations };
  });

  await test('同URL DOM变化时快照失效，必须重读当前正文', async () => {
    const fixture = await makeSession('popup'), query = freshQuery('DOM变动'), q = question(query); const result = await run(fixture, q, { query });
    const originalURL = result.page.url(), originalSnapshot = result.observation.artifact, before = eventCounts(fixture.session);
    await result.page.evaluate(() => { const span = document.createElement('span'); span.id = 'new-live-fact'; span.textContent = '新变化字段仅属于当前页面'; document.getElementById('results').append(span); });
    assert.equal(result.page.url(), originalURL); const captured = await proof(fixture, q, result, ['新变化字段仅属于当前页面']); const after = eventCounts(fixture.session);
    assert.notEqual(captured.artifact.snapshot, originalSnapshot); assert.ok(after.observations > before.observations); assert.match(fs.readFileSync(captured.artifact.snapshot, 'utf8'), /新变化字段仅属于当前页面/);
    fixture.session.completeQuestionPages(q.id); await fixture.session.close();
  });

  await test('URL、title或输入值变化时currentObservation重读，而不是复用旧快照', async () => {
    const fixture = await makeSession('popup'); const query = freshQuery('导航变化'), q = question(query); fixture.session.beginQuestion(q);
    const page = await fixture.session.page('testdb', { recipeId: fixture.recipe.id }); const first = await fixture.session.currentObservation(page, { name: 'first-current' });
    await page.evaluate(() => { document.title = '本题新的页面身份'; }); const titled = await fixture.session.currentObservation(page, { name: 'changed-title' }); assert.notEqual(titled.artifact, first.artifact); assert.equal(titled.title, '本题新的页面身份');
    await page.getByLabel('年份', { exact: true }).fill('2031'); const entered = await fixture.session.currentObservation(page, { name: 'changed-input' }); assert.notEqual(entered.artifact, titled.artifact);
    await page.goto(`${baseURL}/detail?id=CHANGED-DETAIL&query=${encodeURIComponent(query)}`); const navigated = await fixture.session.currentObservation(page, { name: 'changed-url' }); assert.notEqual(navigated.artifact, entered.artifact); assert.match(navigated.text, /CHANGED-DETAIL/); assert.equal(navigated.url, page.url()); await fixture.session.close();
  });

  await test('同页切换题目或attempt时缓存隔离，不能继承上题观察', async () => {
    const fixture = await makeSession('popup'); const query = freshQuery('隔离'), q = question(query); fixture.session.beginQuestion(q); const page = await fixture.session.page('testdb', { recipeId: fixture.recipe.id });
    const first = await fixture.session.currentObservation(page, { name: 'attempt-first' }); fixture.session.finishQuestion(q); fixture.session.beginQuestion(q); const nextAttempt = await fixture.session.currentObservation(page, { name: 'attempt-next' }); assert.notEqual(nextAttempt.artifact, first.artifact);
    fixture.session.beginQuestion(question(freshQuery('另一题'))); const nextQuestion = await fixture.session.currentObservation(page, { name: 'question-next' }); assert.notEqual(nextQuestion.artifact, nextAttempt.artifact); await fixture.session.close();
  });

  await test('网站脚本直接修改表单value而不派事件时缓存仍失效', async () => {
    const fixture = await makeSession('popup'); const query = freshQuery('脚本控件变化'), q = question(query); fixture.session.beginQuestion(q); const page = await fixture.session.page('testdb', { recipeId: fixture.recipe.id });
    const first = await fixture.session.currentObservation(page, { name: 'script-value-before' });
    await page.evaluate(() => { document.getElementById('year').value = '2097'; }); const valueChanged = await fixture.session.currentObservation(page, { name: 'script-value-after' }); assert.notEqual(valueChanged.artifact, first.artifact, 'native input property assignment must invalidate cached form state');
    await page.evaluate(() => { document.getElementById('sort').value = 'asc'; }); const selectionChanged = await fixture.session.currentObservation(page, { name: 'script-select-after' }); assert.notEqual(selectionChanged.artifact, valueChanged.artifact, 'native select property assignment must invalidate cached form state'); await fixture.session.close();
  });

  for (const mutation of ['replace-result', 'replace-with-challenge']) await test(`截图期间同页${mutation}：拒绝拼接旧摘录且不保存证据记录`, async () => {
    const fixture = await makeSession('ajax'); const query = freshQuery(mutation), q = question(query); const result = await run(fixture, q, { query }, { capture: false }); assert.equal(result.status, 'ready');
    const beforeRecords = fixture.session.evidence.length, originalScreenshot = result.page.screenshot;
    result.page.screenshot = async function (...args) {
      await this.evaluate(mutation => { if (mutation === 'replace-with-challenge') document.body.innerHTML = '<h1>安全验证</h1><p>请完成人机验证</p>'; else document.getElementById('results').textContent = '本题结果在截图期间已替换'; }, mutation);
      return originalScreenshot.apply(this, args);
    };
    try { await assert.rejects(() => fixture.session.captureEvidence(result.page, { questionId: q.id, name: fixture.source.name, query, field: '实际结果ID', locator: '#results', evidence: 'NEW-2026' }), /changed|navigated|验证|challenge/i); }
    finally { result.page.screenshot = originalScreenshot; }
    assert.equal(fixture.session.evidence.length, beforeRecords); const evidenceFile = path.join(fixture.session.outputDir, 'evidence.jsonl'); assert.ok(!fs.existsSync(evidenceFile) || !fs.readFileSync(evidenceFile, 'utf8').trim(), 'rejected capture must not append any local evidence records'); await fixture.session.close();
  });

  await test('截图期间iframe目标正文改变：父URL不变也拒绝旧证据', async () => {
    const fixture = await makeSession('iframe'); const query = freshQuery('frame取证变更'), q = question(query); const result = await run(fixture, q, { query }, { capture: false }); assert.equal(result.status, 'ready');
    const beforeRecords = fixture.session.evidence.length, originalScreenshot = result.page.screenshot, originalURL = result.page.url();
    result.page.screenshot = async function (...args) { await result.container.evaluate(element => { element.textContent = 'iframe正文在截图期间已更新'; }); return originalScreenshot.apply(this, args); };
    try { await assert.rejects(() => fixture.session.captureEvidence(result.page, { questionId: q.id, name: fixture.source.name, query, field: '实际frame结果ID', locator: 'iframe #results', target: result.container, evidence: 'NEW-2026' }), /changed|navigated/i); }
    finally { result.page.screenshot = originalScreenshot; }
    assert.equal(result.page.url(), originalURL); assert.equal(fixture.session.evidence.length, beforeRecords); await fixture.session.close();
  });

  await test('截图期间无关DOM变化但引用正文不变：仍可保存当前有效证据', async () => {
    const fixture = await makeSession('ajax'); const query = freshQuery('无关DOM'), q = question(query); const result = await run(fixture, q, { query }, { capture: false }); assert.equal(result.status, 'ready');
    const beforeRecords = fixture.session.evidence.length, originalScreenshot = result.page.screenshot;
    result.page.screenshot = async function (...args) { await this.evaluate(() => { const notice = document.createElement('aside'); notice.textContent = '网页无关公告已更新'; document.body.append(notice); }); return originalScreenshot.apply(this, args); };
    let captured;
    try { captured = await fixture.session.captureEvidence(result.page, { questionId: q.id, name: fixture.source.name, query, field: '实际结果ID', locator: '#results', evidence: 'NEW-2026' }); }
    finally { result.page.screenshot = originalScreenshot; }
    assert.equal(fixture.session.evidence.length, beforeRecords + 1); assert.equal(captured.source.evidence, 'NEW-2026'); assert.ok(fs.existsSync(captured.artifact.screenshot)); await fixture.session.close();
  });

  await test('截图期间结果query身份改变但引用还在：仍拒绝旧题证据', async () => {
    const fixture = await makeSession('ajax'); const query = freshQuery('query身份取证'), q = question(query); const result = await run(fixture, q, { query }, { capture: false }); assert.equal(result.status, 'ready');
    const beforeRecords = fixture.session.evidence.length, originalScreenshot = result.page.screenshot;
    result.page.screenshot = async function (...args) { await this.evaluate(() => { document.getElementById('query-echo').textContent = '截图期间切换到其他题查询'; }); return originalScreenshot.apply(this, args); };
    try { await assert.rejects(() => fixture.session.captureEvidence(result.page, { questionId: q.id, name: fixture.source.name, query, field: '实际结果ID', locator: '#results', evidence: 'NEW-2026' }), /changed|match|question|stale/i); }
    finally { result.page.screenshot = originalScreenshot; }
    assert.equal(fixture.session.evidence.length, beforeRecords); await fixture.session.close();
  });

  const professionalFixture = await makeSession('popup', { professional: true });
  const entity = freshQuery('专业式实体'), author = freshQuery('专业式作者');
  const professionalQuestion = { id: `professional-invalid-${++sequence}`, type: 'single', question: `按题名“${entity}”及作者“${author}”组合同题条件。`, options: { A: 'NEW-2026', B: 'NEW-2023' } };
  const malformed = {
    '前置运算符': `AND TI="${entity}"`, '尾置运算符': `TI="${entity}" AND`, '空分组': `() OR TI="${entity}"`,
    '缺闭括号': `(TI="${entity}"`, '多闭括号': `TI="${entity}")`, '缺运算符': `TI="${entity}" AU="${author}"`,
    '未确认运算符': `TI="${entity}" XOR AU="${author}"`, '未确认字段': `ZZ="${entity}"`,
  };
  for (const [name, expression] of Object.entries(malformed)) await test(`专业式拒绝${name}：未发出提交请求`, async () => {
    const before = requests.length; const result = await rejectedOrNeedsObservation(() => run(professionalFixture, professionalQuestion, { query: expression }, { expected: entity, parameterQuotes: { query: professionalQuestion.question } }));
    assert.equal(result.status, 'rejected'); assert.equal(requests.slice(before).filter(request => request.path === '/results').length, 0); return { expression, reason: result.reason };
  });
  for (const operator of ['AND', 'OR', 'NOT']) await test(`已确认双字段分组${operator}专业式：新实体实际提交且回显`, async () => {
    const q = { ...professionalQuestion, id: `professional-${operator}-${++sequence}`, question: `按${operator}组合题名“${entity}”及作者“${author}”。` }, expression = `(TI="${entity}" ${operator} AU="${author}")`;
    const result = await run(professionalFixture, q, { query: expression }, { expected: entity, parameterQuotes: { query: q.question } }); assert.equal(result.status, 'ready'); assert.match(result.data.conditions, new RegExp(operator)); assert.equal(await result.page.locator('#query-echo').getAttribute('data-query'), expression); assert.ok(result.sources.length); professionalFixture.session.completeQuestionPages(q.id);
  });
  await professionalFixture.session.close();

  await test('专业多字段第二条件缺少回显：保留实际结果页并拒绝作为成功证据', async () => {
    const fixture = await makeSession('professional-missing', { professional: true }), firstEntity = freshQuery('回显第一'), secondEntity = freshQuery('回显第二');
    const q = { id: `professional-echo-missing-${++sequence}`, type: 'single', question: `按AND组合题名“${firstEntity}”及作者“${secondEntity}”。`, options: { A: 'NEW-2026', B: 'NEW-2023' } }, expression = `TI="${firstEntity}" AND AU="${secondEntity}"`;
    const result = await run(fixture, q, { query: expression }, { expected: firstEntity, parameterQuotes: { query: q.question } }); assert.equal(result.status, 'needs_observation'); assert.equal(result.outcome, 'failed'); assert.ok(result.page); assert.match(result.page.url(), /\/partial-results\?/); assert.ok(result.binding); assert.doesNotMatch(await result.page.locator('#condition-echo').innerText(), new RegExp(secondEntity)); assert.equal(result.sources.length, 0); await fixture.session.close();
  });

  await test('多选与选项换序保存仍对应本题文字，无计时字段', async () => {
    const fixture = await makeSession('popup'), query = freshQuery('多选换序'); const q = { id: `multi-${++sequence}`, type: 'multiple', question: `检索题名“${query}”的结果，哪些记录ID真实存在？`, options: { A: 'NEW-2023', B: 'OLD-1999', C: 'NEW-2026' } };
    const result = await run(fixture, q, { query }); const captured = await proof(fixture, q, result, ['NEW-2023', 'NEW-2026']); const saved = fixture.session.saveAnswer(q, answer(q, ['A', 'C'], captured.sources));
    assert.equal(saved.answer.status, 'verified'); assert.deepEqual(saved.answer.answer, ['NEW-2023', 'NEW-2026']); assert.equal(Object.hasOwn(saved.answer, 'timing'), false); assert.doesNotMatch(fs.readFileSync(saved.markdownPath, 'utf8'), /本题用时|elapsed_seconds/); await fixture.session.close();
  });

  await test('相同当前检索任务：手工步骤与runner结果一致，记录真实调用与观察次数', async () => {
    const query = freshQuery('同任务对比'), q = question(query); const variants = {};
    for (const variant of ['manual', 'runner']) {
      const fixture = await makeSession('popup'); const beforeEvents = eventCounts(fixture.session), beforeRequests = requests.length; let result, highLevelCalls = 0;
      if (variant === 'manual') {
        fixture.session.beginQuestion(q);
        highLevelCalls++; const { page } = await fixture.session.page('testdb', { recipeId: fixture.recipe.id, withObservation: true });
        highLevelCalls++; result = await fixture.session.transition('testdb', { questionId: q.id, fromPage: page, toRole: 'results', recipeId: fixture.recipe.id, query,
          trigger: async () => { await page.getByRole('searchbox', { name: '题名', exact: true }).fill(query); await page.getByLabel('作者', { exact: true }).fill(''); await page.getByLabel('年份', { exact: true }).fill(''); await page.getByLabel('排序', { exact: true }).selectOption(''); await page.getByRole('button', { name: '检索', exact: true }).click(); }, timeoutMs: 1600 });
        highLevelCalls++; await fixture.session.recordSearch('testdb', { page: result.page, query, outcome: result.outcome });
        highLevelCalls++; await proof(fixture, q, result, ['NEW-2026']);
      } else { highLevelCalls++; result = await run(fixture, q, { query }); assert.ok(result.sources.length, 'one-call runner includes persisted evidence by default'); }
      assert.equal(result.status, 'ready'); const afterEvents = eventCounts(fixture.session);
      variants[variant] = { explicit_session_workflow_calls: highLevelCalls, observations: afterEvents.observations - beforeEvents.observations, fixture_document_requests: requests.slice(beforeRequests).filter(request => ['/home', '/search', '/results'].includes(request.path)).map(request => request.path), record_texts: await result.container.locator('.record-row').allTextContents() };
      fixture.session.completeQuestionPages(q.id); await fixture.session.close();
    }
    assert.deepEqual(variants.runner.record_texts, variants.manual.record_texts); assert.equal(variants.manual.explicit_session_workflow_calls, 4); assert.equal(variants.runner.explicit_session_workflow_calls, 1); assert.ok(variants.runner.observations <= variants.manual.observations); assert.ok(variants.runner.fixture_document_requests.length <= variants.manual.fixture_document_requests.length);
    const performance = { measured_at: stamp(), scope: 'local real Chrome, equivalent current query; preflight excluded; API orchestration count is instrumented by this test, not tool RPC timing', ...variants, caveat: 'These counts verify workflow steps removed. They do not predict live database or contest elapsed time.' };
    fs.writeFileSync(path.join(__dirname, 'v26-performance-tests.json'), JSON.stringify(performance, null, 2) + '\n', 'utf8'); return performance;
  });
}

(async () => {
  try { await startServer(); await main(); }
  catch (error) { report.tests.push({ name: 'v2.6运行器初始化', passed: false, error: error.stack || String(error) }); process.stderr.write(`${error.stack || error}\n`); }
  finally {
    for (const session of sessions.reverse()) { try { await session.close(); } catch (error) { report.cleanup_errors ||= []; report.cleanup_errors.push(String(error)); } }
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    report.finished_at = stamp(); report.passed = report.tests.filter(item => item.passed).length; report.failed = report.tests.filter(item => !item.passed).length;
    const file = path.join(__dirname, 'v26-tests.json'); fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n', 'utf8'); process.stdout.write(`Results: ${report.passed} passed, ${report.failed} failed. ${file}\n`); process.exitCode = report.failed ? 1 : 0;
  }
})();
