#!/usr/bin/env node
'use strict';

// Direct Playwright + real Google Chrome fixtures. No external sites and no CLI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const { performance } = require('node:perf_hooks');
const { createSession, SearchSession } = require('../ai-literacy-search/scripts/browser.cjs');

const runDir = fs.mkdtempSync(path.join(__dirname, 'v24-browser-run-'));
const report = { started_at: new Date().toISOString(), kind: 'Google Chrome; direct Playwright; local parameterized search fixtures', run_dir: runDir, tests: [] };
const sessions = [];
const requests = [];
const fiveSiteTraffic = { active: 0, peak: 0, per_host: {} };
let server, baseURL, sequence = 0;
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const html = (title, body) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escape(title)}</title></head><body><h1>${escape(title)}</h1>${body}</body></html>`;
const freshQuery = label => `新实体-${label}-${Date.now()}-${++sequence}`;

async function test(name, fn) {
  const started = performance.now();
  try { const detail = await fn(); report.tests.push({ name, passed: true, elapsed_ms: Math.round(performance.now() - started), ...(detail ? { detail } : {}) }); process.stdout.write(`PASS ${name}\n`); }
  catch (error) { report.tests.push({ name, passed: false, elapsed_ms: Math.round(performance.now() - started), error: error.stack || String(error) }); process.stdout.write(`FAIL ${name}: ${error.message}\n`); }
}

function form(mode, q = '') {
  const target = mode === 'popup' || mode === 'challenge' || mode === 'union-empty' || mode === 'loading-popup' ? ' target="_blank"' : mode === 'reuse-target' ? ' target="fixture-results"' : mode === 'iframe' ? ' target="results-frame"' : '';
  const extra = mode === 'iframe' ? '<iframe id="results-frame" name="results-frame" src="/frame-empty" title="检索结果"></iframe>' : '';
  const action = mode === 'challenge' ? '/challenge-results' : mode === 'union-empty' ? '/union-results' : mode === 'loading-popup' ? '/loading-results' : '/results';
  const fields = `<label for="query">专业检索表达式</label><input type="search" id="query" name="q" value="${escape(q)}"><label for="year">年份</label><input id="year" name="year" value="2026"><label for="kind">资源类型</label><select id="kind" name="kind"><option value="journal">期刊</option><option value="thesis">学位论文</option></select><label for="sort">排序</label><select id="sort" name="sort"><option value="desc">年份降序</option><option value="asc">年份升序</option></select>`;
  if (mode === 'iframe-ajax') return '<iframe id="results-frame" src="/frame-ajax-entry" title="专业检索与结果"></iframe>';
  if (mode === 'frame-ajax-entry') return `<form id="professional" onsubmit="event.preventDefault();const data=new URLSearchParams(new FormData(this));fetch('/ajax-results?'+data).then(r=>r.text()).then(text=>document.getElementById('result-host').innerHTML=text)">${fields}<button>检索</button></form><div id="result-host"><output id="query-echo" data-query="上题条件">上题条件</output><main id="results">上题旧列表</main></div>`;
  if (mode === 'double-popup') return `<form id="professional" onsubmit="event.preventDefault();const data=new URLSearchParams(new FormData(this));window.open('/noise?'+data,'_blank');window.open('/results?'+data,'_blank');">${fields}<button>检索</button></form>`;
  if (mode === 'blank-popup' || mode === 'delayed-popup') {
    return `<form id="professional" onsubmit="event.preventDefault();const data=new URLSearchParams(new FormData(this));${mode === 'blank-popup' ? "const tab=window.open('about:blank','_blank');setTimeout(()=>tab.location='/results?'+data,120);" : "setTimeout(()=>window.open('/results?'+data,'_blank'),220);"}">${fields}<button>检索</button></form>${extra}`;
  }
  if (mode === 'ajax') {
    return `<form id="professional" onsubmit="event.preventDefault();const data=new URLSearchParams(new FormData(this));fetch('/ajax-results?'+data).then(r=>r.text()).then(text=>document.getElementById('result-host').innerHTML=text)">${fields}<button>检索</button></form><div id="result-host"></div>`;
  }
  return `<form id="professional" action="${action}"${target}>${fields}<button>检索</button></form>${extra}`;
}

function recordsMarkup(url) {
  const q = url.searchParams.get('q') || '';
  const year = url.searchParams.get('year') || '2026';
  const sort = url.searchParams.get('sort') || 'desc';
  const pageNo = Number(url.searchParams.get('page') || 1);
  let records = [{ id: 'R-2026', year: 2026, author: '作者甲' }, { id: 'R-2024', year: 2024, author: '作者乙' }, { id: 'R-2021', year: 2021, author: '作者丙' }];
  if (sort === 'asc') records.reverse();
  if (q === '合法零结果') records = [];
  const pageRecords = records.slice((pageNo - 1) * 2, pageNo * 2);
  const row = record => `<article class="result-row" data-record-id="${record.id}"><a class="record-link" target="_blank" href="/detail?id=${record.id}&q=${encodeURIComponent(q)}">同名文献</a><span class="record-id">${record.id}</span><span class="author">${record.author}</span><span class="year">${record.year}</span><span class="query-title">${escape(q)}</span></article>`;
  const next = new URLSearchParams(url.searchParams); next.set('page', '2');
  return `<output id="query-echo" data-query="${escape(q)}">${escape(q)}</output><p id="filter-echo">年份=${escape(year)}；资源类型=${escape(url.searchParams.get('kind') || 'journal')}；排序=${escape(sort)}；页码=${pageNo}</p><main id="results" data-complete="true"><p id="result-count">检索完成，找到 ${records.length} 条结果。</p>${pageRecords.map(row).join('')}${pageNo === 1 && records.length ? `<a id="next-page" href="/results?${escape(next)}">下一页</a>` : ''}</main>`;
}

async function makeSession(mode, options = {}) {
  const id = `fixture-${mode.replace(/[^a-z0-9-]/gi, '-')}-${++sequence}`;
  const outputDir = path.join(runDir, id);
  const source = { id: 'testdb', name: '本地官方数据库测试', url: `${baseURL}/entry?mode=${mode}`, domains: ['127.0.0.1'], kind: 'official_database', access: 'public' };
  const recipe = { id: `fixture-${mode}`, source_id: source.id, entry_url: source.url, status: 'query_verified', transitions: { results: { mode: mode === 'blank-popup' || mode === 'delayed-popup' || mode === 'challenge' ? 'popup' : mode === 'ajax' ? 'same-page' : mode, container: mode === 'iframe' ? { frame: '#results-frame', css: '#results' } : { css: '#results' }, ready: mode === 'iframe' ? { frame: '#results-frame', css: '#results' } : { css: '#results' }, match: mode === 'iframe' ? { frame: '#results-frame', css: '#query-echo' } : { css: '#query-echo' } }, detail: { mode: 'popup', container: { css: '#record' }, ready: { css: '#record' }, match: { css: '#record-id' } } } };
  const session = await createSession({ sessionId: id, outputDir, profileDir: path.join(outputDir, 'profile'), catalog: { sources: [source] }, recipeIndex: { version: '2.4.0', sources: [{ id: source.id, source_id: source.id, recipe_ids: [recipe.id] }] }, recipes: [recipe], headless: true, archive: true, screenshots: true, preflightSourceIds: [source.id], maxPages: 3, navigationTimeoutMs: 10000, ...options });
  sessions.push(session);
  await session.preflight();
  const search = await session.page(source.id);
  return { session, source, search, recipe };
}

function transitionOptions(questionId, page, query, mode, extra = {}) {
  return { questionId, fromPage: page, toRole: 'results', mode, query, filters: { year: '2026', kind: 'journal', sort: 'desc' }, timeoutMs: 2500, container: { css: '#results' }, ready: { css: '#results' }, match: async candidate => await candidate.locator('#query-echo').getAttribute('data-query') === query,
    trigger: async () => { await page.getByRole('searchbox', { name: '专业检索表达式' }).fill(query); await page.getByRole('button', { name: '检索', exact: true }).click(); }, ...extra };
}

const fixtureQuestion = id => ({ id, type: 'judge', question: `本地官方数据库页面与检索条件验证，题号${id}。`, options: {} });

function assertBinding(result, questionId, role = 'results') {
  assert.equal(result.status, 'ready');
  assert.equal(result.binding.source_id, 'testdb');
  assert.equal(result.binding.question_id, questionId);
  assert.equal(result.binding.role, role);
  assert.ok(Number.isInteger(result.binding.attempt) && result.binding.attempt >= 1);
  assert.ok(typeof result.binding.action_id === 'string' && result.binding.action_id.length);
  assert.ok(typeof result.binding.query_fingerprint === 'string' && result.binding.query_fingerprint.length);
  assert.ok(Number.isInteger(result.binding.doc_epoch));
  assert.ok(result.container && typeof result.container.locator === 'function');
  assert.ok(result.observation && result.observation.artifact && fs.existsSync(result.observation.artifact));
}

async function main() {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
    requests.push({ path: url.pathname, query: url.search, at: Date.now() });
    if (url.searchParams.get('five') === '1') {
      const host = url.hostname; const traffic = fiveSiteTraffic.per_host[host] ||= { active: 0, peak: 0, total: 0 }; traffic.active++; traffic.total++; traffic.peak = Math.max(traffic.peak, traffic.active); fiveSiteTraffic.active++; fiveSiteTraffic.peak = Math.max(fiveSiteTraffic.peak, fiveSiteTraffic.active);
      let finished = false; const done = () => { if (finished) return; finished = true; traffic.active--; fiveSiteTraffic.active--; }; res.once('finish', done); res.once('close', done);
      await new Promise(resolve => setTimeout(resolve, 400));
    } else await new Promise(resolve => setTimeout(resolve, 20));
    let body;
    if (url.pathname === '/entry') body = `<a href="/professional?mode=${escape(url.searchParams.get('mode') || 'popup')}">专业检索入口</a>` + form(url.searchParams.get('mode') || 'popup');
    else if (url.pathname === '/professional') body = form(url.searchParams.get('mode') || 'same-page');
    else if (url.pathname === '/frame-empty') body = '<main>等待检索。</main>';
    else if (url.pathname === '/frame-ajax-entry') body = form('frame-ajax-entry');
    else if (url.pathname === '/ajax-results') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(recordsMarkup(url)); return; }
    else if (url.pathname === '/results') body = '<a target="_blank" href="/detail?id=WRONG">同名文献</a>' + form('same-page', url.searchParams.get('q') || '') + recordsMarkup(url);
    else if (url.pathname === '/union-results') body = url.searchParams.get('q') === '合法零结果' ? `<output id="query-echo" data-query="合法零结果">合法零结果</output><main id="results" hidden>上一题的旧列表，找到 3 条。</main><main id="empty">检索完成，找到 0 条结果。</main>` : recordsMarkup(url) + '<main id="empty" hidden>上一题的零结果。</main>';
    else if (url.pathname === '/loading-results') {
      const query = url.searchParams.get('q') || '';
      body = `<output id="query-echo" data-query="${escape(query)}">${escape(query)}</output><main id="results" data-state="loading"><p>正在加载</p></main><nav id="pagination">第1页</nav><script>setTimeout(()=>{const result=document.getElementById('results');result.innerHTML='<article class="result-row" data-record-id="READY-2026"><span class="record-id">READY-2026</span><span class="author">已完成作者</span></article>';result.dataset.state='complete';},300)</script>`;
    }
    else if (url.pathname === '/challenge-results') {
      if (/(?:^|;\s*)verified=1(?:;|$)/.test(req.headers.cookie || '')) body = recordsMarkup(url);
      else body = `<p>安全验证：请完成验证码后继续访问。</p><label>验证码<input name="captcha"></label><button id="human-verify" onclick="document.cookie='verified=1;path=/';location.reload()">人工验证</button>`;
    }
    else if (url.pathname === '/detail') body = `<main id="record"><span id="record-id">${escape(url.searchParams.get('id'))}</span><p id="facts">已核验记录：${escape(url.searchParams.get('q'))}；记录标识 ${escape(url.searchParams.get('id'))}；年份 ${escape((url.searchParams.get('id') || '').slice(2))}。</p></main>${url.searchParams.get('late') === '1' ? '<script>setTimeout(()=>window.open("/noise?late=1","_blank"),400)</script>' : ''}`;
    else if (url.pathname === '/noise') body = '<main id="announcement">这是无关公告，不能作为检索结果。</main>';
    else body = '<main>不存在的测试入口。</main>';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(html('官方数据库检索测试', body));
  });
  server.listen(0, '0.0.0.0'); await once(server, 'listening');
  baseURL = `http://127.0.0.1:${server.address().port}`;

  await test('结果新标签页：提交前监听，绑定当前题与真实检索条件', async () => {
    const { session, search } = await makeSession('popup');
    const q = freshQuery('弹出'); const id = 'popup-unseen'; session.beginQuestion(fixtureQuestion(id));
    const result = await session.transition('testdb', transitionOptions(id, search, q, 'popup'));
    assertBinding(result, id); assert.notEqual(result.page, search);
    assert.equal(await session.page('testdb'), search, 'legacy API must retain the search page');
    assert.equal(await session.page('testdb', { role: 'results' }), result.page);
    assert.ok((await result.container.innerText()).includes(q));
    assert.ok(session.context.pages().length <= 3);
    await session.close(); return { query: q, source_role: result.binding.role };
  });

  await test('同页检索与第二题：条件更换后重新绑定，不返回上题结果', async () => {
    const { session, search } = await makeSession('same-page');
    const q1 = freshQuery('同页甲'); session.beginQuestion(fixtureQuestion('same-one'));
    const first = await session.transition('testdb', transitionOptions('same-one', search, q1, 'same-page')); assertBinding(first, 'same-one'); assert.equal(first.page, search);
    const q2 = freshQuery('同页乙'); session.beginQuestion(fixtureQuestion('same-two'));
    await assert.rejects(() => session.page('testdb', { role: 'results' }), 'old question binding cannot be reused');
    const second = await session.transition('testdb', transitionOptions('same-two', search, q2, 'same-page')); assertBinding(second, 'same-two');
    assert.notEqual(second.binding.query_fingerprint, first.binding.query_fingerprint); assert.notEqual(second.binding.action_id, first.binding.action_id);
    assert.equal(await second.page.locator('#query-echo').getAttribute('data-query'), q2);
    await session.close();
  });

  await test('AJAX原页更新：不靠URL变化确认结果，等待新容器及条件回显', async () => {
    const { session, search } = await makeSession('ajax'); const id = 'ajax-unseen'; const q = freshQuery('AJAX'); session.beginQuestion(fixtureQuestion(id)); const beforeURL = search.url();
    const result = await session.transition('testdb', transitionOptions(id, search, q, 'same-page')); assertBinding(result, id); assert.equal(result.page.url(), beforeURL); assert.ok((await result.container.innerText()).includes(q)); await session.close();
  });

  await test('命名target复用：第二次提交捕获既有结果页的新文档', async () => {
    const { session, search } = await makeSession('reuse-target'); const q1 = freshQuery('目标甲'); session.beginQuestion(fixtureQuestion('target-one'));
    const first = await session.transition('testdb', transitionOptions('target-one', search, q1, 'reuse-target')); assertBinding(first, 'target-one');
    const q2 = freshQuery('目标乙'); session.beginQuestion(fixtureQuestion('target-two'));
    const second = await session.transition('testdb', transitionOptions('target-two', search, q2, 'reuse-target')); assertBinding(second, 'target-two'); assert.equal(second.page, first.page); assert.ok(second.binding.doc_epoch > first.binding.doc_epoch);
    assert.equal(await second.page.locator('#query-echo').getAttribute('data-query'), q2); await session.close();
  });

  await test('iframe检索：定位已确认内嵌容器并保存该正文证据', async () => {
    const { session, search } = await makeSession('iframe'); const id = 'frame-unseen'; const q = freshQuery('框架'); session.beginQuestion(fixtureQuestion(id));
    const result = await session.transition('testdb', transitionOptions(id, search, q, 'iframe', { container: { frame: '#results-frame', css: '#results' }, ready: { frame: '#results-frame', css: '#results' }, match: async candidate => await candidate.frameLocator('#results-frame').locator('#query-echo').getAttribute('data-query') === q }));
    assertBinding(result, id); assert.equal(result.page, search); assert.ok((await result.container.innerText()).includes(q));
    const captured = await session.captureEvidence(search, { questionId: id, name: '本地官方数据库测试', query: q, field: '内嵌结果正文', locator: '#results-frame >> #results', target: result.container, evidence: '检索完成，找到 3 条结果。' });
    assert.ok(fs.existsSync(captured.artifact.target_text)); assert.equal(captured.source.query, q); await session.close();
  });

  await test('iframe内部AJAX：主页面与iframe网址不变，仍确认实际容器更新', async () => {
    const { session, search } = await makeSession('iframe-ajax'); const id = 'iframe-ajax-current'; const q = freshQuery('框架AJAX'); session.beginQuestion(fixtureQuestion(id));
    const frame = search.frameLocator('#results-frame'); await frame.locator('#results').waitFor(); const mainURL = search.url(); const frameURL = search.frames().find(item => item !== search.mainFrame()).url();
    const result = await session.transition('testdb', transitionOptions(id, search, q, 'iframe', { container: { frame: '#results-frame', css: '#results' }, ready: { frame: '#results-frame', css: '#results' }, match: async candidate => await candidate.frameLocator('#results-frame').locator('#query-echo').getAttribute('data-query') === q, trigger: async () => { await frame.getByRole('searchbox', { name: '专业检索表达式' }).fill(q); await frame.getByRole('button', { name: '检索', exact: true }).click(); } }));
    assertBinding(result, id); assert.equal(search.url(), mainURL); assert.equal(search.frames().find(item => item !== search.mainFrame()).url(), frameURL); assert.equal(result.page, search); assert.equal(result.outcome, 'results'); assert.ok((await result.container.innerText()).includes(q)); await session.close();
  });

  await test('about:blank中转：等最终官方页面再确认，不把空页当结果', async () => {
    const { session, search } = await makeSession('blank-popup'); const id = 'blank-unseen'; const q = freshQuery('空页'); session.beginQuestion(fixtureQuestion(id));
    const result = await session.transition('testdb', transitionOptions(id, search, q, 'popup')); assertBinding(result, id); assert.match(result.page.url(), /\/results\?/); assert.notEqual(result.observation.url, 'about:blank'); await session.close();
  });

  await test('条件回显不一致：拒绝将同域错误结果绑定到当前题', async () => {
    const { session, search } = await makeSession('popup'); const id = 'mismatch-unseen'; const q = freshQuery('请求'); session.beginQuestion(fixtureQuestion(id));
    await assert.rejects(() => session.transition('testdb', transitionOptions(id, search, q, 'popup', { timeoutMs: 800, trigger: async () => { await search.getByRole('searchbox').fill('错误条件'); await search.getByRole('button', { name: '检索', exact: true }).click(); } })));
    await assert.rejects(() => session.page('testdb', { role: 'results' }));
    const unmatched = session.context.pages().find(page => page !== search && page.url().includes('/results'));
    if (unmatched && !unmatched.isClosed()) {
      await assert.rejects(() => session.captureEvidence(unmatched, { questionId: id, name: '本地官方数据库测试', query: q, field: '未匹配结果', locator: '#results', target: unmatched.locator('#results'), evidence: '检索完成，找到 3 条结果。' }));
      await assert.rejects(() => session.recordSearch('testdb', { page: unmatched, query: q, filters: {}, outcome: 'results' }));
    }
    await session.close();
  });

  await test('非来源域弹窗：即使检索回显相同，也不能绑定成指定官方库', async () => {
    const { session, search } = await makeSession('popup'); const id = 'foreign-popup'; const q = freshQuery('跨域'); session.beginQuestion(fixtureQuestion(id));
    await search.locator('#professional').evaluate((form, url) => { form.action = url; }, `${baseURL.replace('127.0.0.1', '127.0.0.2')}/results`);
    await assert.rejects(() => session.transition('testdb', transitionOptions(id, search, q, 'popup', { timeoutMs: 800 })));
    await assert.rejects(() => session.page('testdb', { role: 'results' })); await session.close();
  });

  await test('旧容器与空操作：已有匹配文本不能冒充一次新检索', async () => {
    const { session, search } = await makeSession('same-page'); const id = 'stale-container'; const q = freshQuery('容器'); session.beginQuestion(fixtureQuestion(id));
    await session.transition('testdb', transitionOptions(id, search, q, 'same-page'));
    session.beginQuestion(fixtureQuestion('stale-container-next'));
    await assert.rejects(() => session.transition('testdb', transitionOptions('stale-container-next', search, q, 'same-page', { timeoutMs: 700, trigger: async () => {} })), 'the old matching container is not a new operation'); await session.close();
  });

  await test('旧题结果证据：切换题目后存在的真实正文不能借给下一题', async () => {
    const { session, search } = await makeSession('popup'); const q = freshQuery('旧题证据'); session.beginQuestion(fixtureQuestion('old-evidence')); const result = await session.transition('testdb', transitionOptions('old-evidence', search, q, 'popup'));
    session.beginQuestion(fixtureQuestion('new-evidence'));
    await assert.rejects(() => session.captureEvidence(result.page, { questionId: 'new-evidence', name: '本地官方数据库测试', query: q, field: '结果', locator: '#results', target: result.container, evidence: '检索完成，找到 3 条结果。' }));
    await assert.rejects(() => session.captureEvidence(result.page, { questionId: 'old-evidence', name: '本地官方数据库测试', query: q, field: '结果', locator: '#results', target: result.container, evidence: '检索完成，找到 3 条结果。' })); await session.close();
  });

  await test('上题延迟弹窗：题目切换后旧transition失效，不能污染新题角色', async () => {
    const { session, search } = await makeSession('delayed-popup'); const id = 'late-old'; const q = freshQuery('晚到'); session.beginQuestion(fixtureQuestion(id));
    const pending = session.transition('testdb', transitionOptions(id, search, q, 'popup', { timeoutMs: 900 }));
    const rejection = assert.rejects(pending);
    await search.waitForTimeout(80); session.beginQuestion(fixtureQuestion('late-current'));
    await rejection; await assert.rejects(() => session.page('testdb', { role: 'results' })); await session.close();
  });

  await test('同条件迟到弹窗：取消后的原文档拒绝新点击，重进已确认入口后恢复', async () => {
    const { session, search, recipe } = await makeSession('delayed-popup'); const q = freshQuery('相同条件'); session.beginQuestion(fixtureQuestion('same-race-old'));
    const pending = session.transition('testdb', transitionOptions('same-race-old', search, q, 'popup', { timeoutMs: 1000 })); const rejected = assert.rejects(pending);
    await search.waitForTimeout(70); session.beginQuestion(fixtureQuestion('same-race-current')); const currentAttempt = session.activeQuestion.attempt; await rejected;
    let clicked = false;
    await assert.rejects(() => session.transition('testdb', transitionOptions('same-race-current', search, q, 'popup', { trigger: async () => { clicked = true; await search.getByRole('button', { name: '检索', exact: true }).click(); } })));
    assert.equal(clicked, false, 'an uncertain old popup document must be rejected before another action');
    const fresh = await session.page('testdb', { recipeId: recipe.id }); assert.equal(fresh, search);
    const current = await session.transition('testdb', transitionOptions('same-race-current', fresh, q, 'popup')); assertBinding(current, 'same-race-current'); session.beginQuestion(fixtureQuestion('same-race-current')); assert.equal(session.activeQuestion.attempt, currentAttempt, 'navigation recovery must preserve the current attempt'); await session.close();
  });

  await test('结果容器限定与分页排序：同名导航链接不污染记录选取', async () => {
    const { session, search } = await makeSession('popup'); const id = 'scoped-records'; const q = freshQuery('记录'); session.beginQuestion(fixtureQuestion(id));
    const results = await session.transition('testdb', transitionOptions(id, search, q, 'popup')); assert.equal(await results.page.getByRole('link', { name: '同名文献', exact: true }).count(), 3); assert.equal(await results.container.getByRole('link', { name: '同名文献', exact: true }).count(), 2);
    const selected = results.container.locator('.result-row').nth(1); assert.equal(await selected.locator('.record-id').innerText(), 'R-2024');
    const detail = await session.transition('testdb', { questionId: id, fromPage: results.page, toRole: 'detail', mode: 'popup', query: q, filters: { record_id: 'R-2024' }, container: { css: '#record' }, ready: { css: '#record' }, match: async candidate => await candidate.locator('#record-id').innerText() === 'R-2024', trigger: async () => selected.getByRole('link', { name: '同名文献', exact: true }).click(), timeoutMs: 2500 }); assertBinding(detail, id, 'detail'); assert.equal(await session.page('testdb', { role: 'detail' }), detail.page); assert.equal(session.context.pages().length, 3);
    const evidence = await session.captureEvidence(detail.page, { questionId: id, name: '本地官方数据库测试', query: q, field: '详情记录ID', locator: '#record', target: detail.container, evidence: 'R-2024' }); assert.equal(evidence.source.evidence, 'R-2024');
    await detail.page.close();
    const page2 = await session.transition('testdb', { questionId: id, fromPage: results.page, toRole: 'results', mode: 'same-page', query: q, filters: { sort: 'desc', page: 2 }, container: { css: '#results' }, ready: { css: '#results' }, match: async candidate => (await candidate.locator('#filter-echo').innerText()).includes('页码=2'), trigger: async () => results.container.getByRole('link', { name: '下一页' }).click(), timeoutMs: 2500 }); assertBinding(page2, id); assert.equal(await page2.container.locator('.record-id').innerText(), 'R-2021'); await session.close();
  });

  await test('结果页验证码恢复：在被阻结果页验证后按断点重新确认', async () => {
    const { session, search } = await makeSession('challenge'); const id = 'result-challenge'; const q = freshQuery('验证码'); session.beginQuestion(fixtureQuestion(id));
    const blocked = await session.transition('testdb', transitionOptions(id, search, q, 'popup')); assert.equal(blocked.status, 'blocked'); assert.equal(blocked.outcome, 'failed'); assert.notEqual(blocked.page, search); assert.ok((await blocked.page.locator('body').innerText()).includes('安全验证'));
    await assert.rejects(() => session.captureEvidence(blocked.page, { questionId: id, name: '本地官方数据库测试', query: q, field: '阻碍页面', locator: 'body', target: blocked.page.locator('body'), evidence: '安全验证：请完成验证码后继续访问。' }));
    await Promise.all([blocked.page.waitForEvent('load'), blocked.page.getByRole('button', { name: '人工验证' }).click()]);
    const checked = await session.recheck('testdb', { role: 'results' }); assert.equal(checked.authorization, 'not_observed');
    const resumed = await session.resumeTransition('testdb', { role: 'results', questionId: id }); assertBinding(resumed, id); assert.equal(resumed.page, blocked.page); assert.equal(await resumed.page.locator('#query-echo').getAttribute('data-query'), q); await session.close();
  });

  await test('正常零结果：结果完成与条件回显齐全，和失败页分开', async () => {
    const { session, search } = await makeSession('popup'); const id = 'valid-empty'; const q = '合法零结果'; session.beginQuestion(fixtureQuestion(id));
    const result = await session.transition('testdb', transitionOptions(id, search, q, 'popup')); assertBinding(result, id); assert.equal(await result.container.locator('.result-row').count(), 0); assert.ok((await result.container.innerText()).includes('找到 0 条结果'));
    const checked = await session.recordSearch('testdb', { page: result.page, query: q, filters: {}, outcome: 'empty' }); assert.equal(checked.search_status, 'empty'); await session.close();
  });

  await test('隐藏旧结果与可见零结果联合容器：只选可见节点并区分empty/results', async () => {
    const { session, search } = await makeSession('union-empty'); const container = { css: '#results, #empty' };
    for (const [index, query] of ['合法零结果', freshQuery('联合正结果')].entries()) {
      const id = `union-visible-${index}`; session.beginQuestion(fixtureQuestion(id));
      const result = await session.transition('testdb', transitionOptions(id, search, query, 'popup', { container, ready: container, empty: { css: '#empty' } })); assertBinding(result, id); assert.equal(await result.page.locator('#results, #empty').count(), 2); assert.equal(await result.container.count(), 1); assert.equal(result.outcome, index === 0 ? 'empty' : 'results'); assert.equal(await result.container.getAttribute('id'), index === 0 ? 'empty' : 'results'); await result.page.close();
    }
    await session.close();
  });

  await test('当前query覆盖recipe样例expected：新题实查回显不沿用旧实体', async () => {
    const recipeId = 'fixture-old-expected'; const recipe = { id: recipeId, source_id: 'testdb', status: 'query_verified', transitions: { results: { mode: 'popup', container: { css: '#results' }, ready: { css: '#results' }, match: { css: '#query-echo', expected: '过期示例实体' } } } };
    const { session, search } = await makeSession('popup', { recipes: [recipe] }); const id = 'recipe-current-query'; const query = freshQuery('覆盖旧词'); session.beginQuestion(fixtureQuestion(id));
    const result = await session.transition('testdb', { questionId: id, fromPage: search, toRole: 'results', recipeId, query, filters: {}, trigger: async () => { await search.getByRole('searchbox').fill(query); await search.getByRole('button', { name: '检索', exact: true }).click(); }, timeoutMs: 2000 }); assertBinding(result, id); assert.equal(result.outcome, 'results'); assert.equal(await result.page.locator('#query-echo').getAttribute('data-query'), query); await session.close();
  });

  await test('已回显查询与分页仍在加载：等待真实完成标志后才接受记录', async () => {
    const recipeId = 'fixture-loading-completion'; const recipe = { id: recipeId, source_id: 'testdb', status: 'query_verified', transitions: { results: { mode: 'popup', container: { css: '#results' }, ready: { css: '#results[data-state="complete"]' }, match: { css: '#query-echo' } } } };
    const { session, search } = await makeSession('loading-popup', { recipes: [recipe] }); const id = 'loading-completion'; const query = freshQuery('真实完成'); session.beginQuestion(fixtureQuestion(id));
    const result = await session.transition('testdb', { questionId: id, fromPage: search, toRole: 'results', recipeId, query, filters: {}, trigger: async () => { await search.getByRole('searchbox').fill(query); await search.getByRole('button', { name: '检索', exact: true }).click(); }, timeoutMs: 2000 }); assertBinding(result, id); assert.equal(result.outcome, 'results'); assert.equal(await result.page.locator('#pagination').count(), 1); assert.equal(await result.container.getAttribute('data-state'), 'complete'); assert.equal(await result.container.locator('.record-id').innerText(), 'READY-2026'); assert.equal((await result.container.innerText()).includes('正在加载'), false); await session.close();
  });

  await test('专业流程参数化：未见实体、年份与筛选变化均使用本题输入', async () => {
    const { session, search, recipe } = await makeSession('popup'); assert.equal(session.recipe(recipe.id).source_id, 'testdb');
    const id = 'recipe-unseen'; const q = freshQuery('专业新题'); session.beginQuestion(fixtureQuestion(id));
    const result = await session.transition('testdb', { questionId: id, fromPage: search, toRole: 'results', recipeId: recipe.id, query: q, filters: { year: '2019', kind: 'thesis', sort: 'asc' }, trigger: async () => { await search.getByRole('searchbox').fill(q); await search.getByRole('textbox', { name: '年份' }).fill('2019'); await search.getByRole('combobox', { name: '资源类型' }).selectOption('thesis'); await search.getByRole('combobox', { name: '排序' }).selectOption('asc'); await search.getByRole('button', { name: '检索', exact: true }).click(); }, timeoutMs: 2500 }); assertBinding(result, id);
    assert.equal(await result.page.locator('#filter-echo').innerText(), '年份=2019；资源类型=thesis；排序=asc；页码=1'); assert.equal(await result.container.locator('.record-id').first().innerText(), 'R-2021'); await session.close();
  });

  await test('三标签页预留：受保护页面不够腾出名额时提交前拒绝', async () => {
    const { session, search } = await makeSession('popup'); const id = 'tab-reservation'; const q = freshQuery('名额'); session.beginQuestion(fixtureQuestion(id));
    const result = await session.transition('testdb', transitionOptions(id, search, q, 'popup'));
    await search.goto(`${baseURL}/challenge-results?q=未完成验证的检索页`); await session.observe(search, { name: 'search-human-verification' });
    const protectedPage = await session.context.newPage(); await protectedPage.goto(`${baseURL}/challenge-results?q=登录页`); await session.observe(protectedPage, { name: 'protected-human-verification' });
    assert.equal(session.context.pages().length, 3); let triggerCalled = false;
    await assert.rejects(() => session.transition('testdb', { questionId: id, fromPage: result.page, toRole: 'detail', mode: 'popup', query: q, filters: { record_id: 'R-2026' }, container: { css: '#record' }, ready: { css: '#record' }, match: async candidate => await candidate.locator('#record-id').innerText() === 'R-2026', trigger: async () => { triggerCalled = true; await result.container.locator('.result-row').first().getByRole('link').click(); }, timeoutMs: 900 }));
    assert.equal(triggerCalled, false, 'the browser action must not happen before room is reserved'); assert.equal(protectedPage.isClosed(), false); assert.equal(result.page.isClosed(), false); assert.equal(search.isClosed(), false); assert.ok(session.context.pages().length <= 3); await session.close();
  });

  await test('过期控件/重名：定位不再唯一时失败，不提交到另一个检索框', async () => {
    const { session, search } = await makeSession('same-page'); const id = 'ambiguous-control'; const q = freshQuery('控件'); session.beginQuestion(fixtureQuestion(id));
    await search.locator('body').evaluate(body => { const input = document.createElement('input'); input.type = 'search'; input.setAttribute('aria-label', '专业检索表达式'); body.append(input); });
    await assert.rejects(() => session.transition('testdb', transitionOptions(id, search, q, 'same-page')));
    assert.equal(new URL(search.url()).pathname, '/entry'); await assert.rejects(() => session.page('testdb', { role: 'results' })); await session.close();
  });

  await test('新实体与选项重排：字母跟随当前文字，证据独立且答案不计时', async () => {
    const { session, search } = await makeSession('popup'); const chosenLabels = [];
    for (const [index, options] of [{ A: '作者乙', B: '作者丙', C: '作者甲' }, { A: '作者甲', B: '作者丙', C: '作者乙' }].entries()) {
      const id = `unseen-reordered-${index}`; const q = freshQuery(`选项${index}`); const question = { id, type: 'single', question: `检索${q}，按年份降序，首条记录的作者是谁？`, options }; session.beginQuestion(question);
      const result = await session.transition('testdb', transitionOptions(id, search, q, 'popup')); const actualAuthor = await result.container.locator('.result-row').first().locator('.author').innerText(); const label = Object.keys(options).find(key => options[key] === actualAuthor); const captured = await session.captureEvidence(result.page, { questionId: id, name: '本地官方数据库测试', query: q, field: '降序首条记录作者', locator: '#results .result-row >> nth=0', target: result.container.locator('.result-row').first(), evidence: actualAuthor });
      const proposed = { id, question: question.question, type: question.type, status: 'verified', answer: [actualAuthor], answer_labels: [label], explanation: '已按当前题目条件读取实际结果列表首条作者字段。', option_evaluations: Object.entries(options).map(([key, text]) => ({ label: key, text, verdict: key === label ? 'supported' : 'refuted', reason: key === label ? `首条记录作者为${actualAuthor}。` : `首条记录作者为${actualAuthor}，与本项不符。` })), sources: [captured.source], needs_review: [], searched_at: new Date().toISOString() };
      const saved = session.saveAnswer(question, proposed); assert.equal(saved.answer.status, 'verified'); assert.deepEqual(saved.answer.answer_labels, [label]); assert.equal(saved.answer.answer[0], options[label]); assert.equal(Object.hasOwn(saved.answer, 'timing'), false); assert.doesNotMatch(fs.readFileSync(saved.markdownPath, 'utf8'), /本题用时/); assert.equal(fs.existsSync(path.join(session.outputDir, 'question-timers.json')), false); assert.ok(saved.answer.confidence.score >= 90); chosenLabels.push(label); await result.page.close();
    }
    assert.deepEqual(chosenLabels, ['C', 'A']); await session.close();
  });

  await test('同一点击双弹窗：核对结果身份并关闭无关公告页', async () => {
    const { session, search } = await makeSession('double-popup'); const id = 'double-popup'; const q = freshQuery('双弹'); session.beginQuestion(fixtureQuestion(id));
    const result = await session.transition('testdb', transitionOptions(id, search, q, 'popup')); assertBinding(result, id); assert.match(result.page.url(), /\/results\?/);
    assert.equal(session.context.pages().some(page => page.url().includes('/noise')), false, 'a nonmatching popup from this action must not remain as a result tab'); assert.ok(session.context.pages().length <= 3); await session.close();
  });

  await test('迟到第四页：隔离无绑定弹窗并保留当前结果和详情证据', async () => {
    const { session, search } = await makeSession('popup'); const id = 'late-fourth'; const q = freshQuery('第四页'); session.beginQuestion(fixtureQuestion(id)); const results = await session.transition('testdb', transitionOptions(id, search, q, 'popup'));
    const firstLink = results.container.locator('.result-row').first().getByRole('link'); await firstLink.evaluate(link => { link.href += '&late=1'; });
    const detail = await session.transition('testdb', { questionId: id, fromPage: results.page, toRole: 'detail', mode: 'popup', query: q, filters: { record_id: 'R-2026' }, container: { css: '#record' }, ready: { css: '#record' }, match: async candidate => await candidate.locator('#record-id').innerText() === 'R-2026', trigger: async () => firstLink.click(), timeoutMs: 2500 }); assertBinding(detail, id, 'detail');
    assert.equal(session.context.pages().length, 3); await detail.page.waitForTimeout(550);
    assert.ok(session.context.pages().length <= 3, 'an unsolicited fourth page must not persist'); assert.equal(results.page.isClosed(), false); assert.equal(detail.page.isClosed(), false); assert.equal(session.context.pages().some(page => page.url().includes('/noise')), false);
    const events = fs.readFileSync(session.eventsPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse); assert.ok(events.some(event => event.event === 'extra_unbound_popup_closed'), 'the delayed fourth page must have been observed and closed, not silently skipped by the fixture'); await session.close();
  });

  await test('默认五网站并行：五个真实标签页并发，自同域名仍串行', async () => {
    const id = `five-default-${++sequence}`; const outputDir = path.join(runDir, id); const catalog = { sources: Array.from({ length: 5 }, (_, i) => ({ id: `site-${i + 1}`, name: `并行网站${i + 1}`, url: `${baseURL.replace('127.0.0.1', `127.0.0.${i + 1}`)}/entry?mode=popup&five=1`, domains: [`127.0.0.${i + 1}`] })) };
    catalog.sources.push({ ...catalog.sources[0], id: 'same-host-sixth', url: catalog.sources[0].url + '&same=1' });
    const session = await createSession({ sessionId: id, outputDir, profileDir: path.join(outputDir, 'profile'), catalog, headless: true, archive: true, screenshots: true, preflightSourceIds: catalog.sources.map(source => source.id), recipeIndex: { version: '2.4.0', sources: [] }, recipes: [] }); sessions.push(session); assert.equal(session.maxPages, 5); const checked = await session.preflight();
    assert.equal(checked.completed, true); assert.equal(checked.entries.length, 6); assert.equal(checked.max_pages, 5); assert.equal(checked.max_parallel_sites, 5); assert.equal(fiveSiteTraffic.peak, 5, 'independent websites must really overlap five document requests'); assert.ok(Object.values(fiveSiteTraffic.per_host).every(host => host.peak === 1), 'a website cannot receive simultaneous checks'); await session.close(); return { peak_parallel_sites: fiveSiteTraffic.peak, per_host: fiveSiteTraffic.per_host };
  });

  await test('第五页正常预留、第六页保护：五个验证页面均保留且提交前拒绝', async () => {
    const id = `five-protected-${++sequence}`; const outputDir = path.join(runDir, id); const catalog = { sources: Array.from({ length: 5 }, (_, i) => ({ id: `protected-${i}`, name: `受保护数据库${i}`, url: `${baseURL}/entry?mode=popup&db=${i}`, domains: ['127.0.0.1'] })) };
    const session = await createSession({ sessionId: id, outputDir, profileDir: path.join(outputDir, 'profile'), catalog, headless: true, archive: true, screenshots: true, preflightSourceIds: catalog.sources.map(source => source.id), recipeIndex: { version: '2.4.0', sources: [] }, recipes: [] }); sessions.push(session); await session.preflight(); const pages = [];
    for (const source of catalog.sources) pages.push(await session.page(source.id)); assert.equal(session.maxPages, 5); assert.equal(new Set(pages).size, 5); assert.equal(session.context.pages().length, 5, 'the fifth task page must be available without closing the other four');
    session.beginQuestion(fixtureQuestion(id)); for (const [index, page] of pages.entries()) { await page.goto(`${baseURL}/challenge-results?q=待验证${index}`); await session.observe(page, { name: `five-protected-${index}` }); }
    let clicked = false; await assert.rejects(() => session.transition(catalog.sources[0].id, { questionId: id, fromPage: pages[0], toRole: 'results', mode: 'popup', query: '受保护第五页', container: { css: '#results' }, ready: { css: '#results' }, match: { css: '#query-echo' }, trigger: async () => { clicked = true; }, timeoutMs: 1000 }));
    assert.equal(clicked, false); assert.equal(session.context.pages().length, 5); assert.ok(pages.every(page => !page.isClosed()), 'manual verification and unfinished pages cannot be discarded to create a sixth task page'); await session.close();
  });

  await test('并发配置边界：1到5合法，0/6/非整数及错误类型拒绝', async () => {
    const source = { id: 'config', name: '并发配置测试', url: `${baseURL}/entry?mode=popup`, domains: ['127.0.0.1'] }; const options = maxPages => { const id = `max-pages-${++sequence}`; const outputDir = path.join(runDir, id); return { sessionId: id, outputDir, profileDir: path.join(outputDir, 'profile'), catalog: { sources: [source] }, recipeIndex: { version: '2.4.0', sources: [] }, recipes: [], maxPages }; };
    for (const maxPages of [1, 2, 3, 4, 5]) { const session = new SearchSession(options(maxPages)); assert.equal(session.maxPages, maxPages); assert.equal(session.report.max_pages, maxPages); assert.equal(session.report.max_parallel_sites, maxPages); }
    for (const maxPages of [0, 6, -1, 1.5, '5', false, null, NaN, Infinity]) assert.throws(() => new SearchSession(options(maxPages)));
    const defaultOptions = options(undefined); delete defaultOptions.maxPages; assert.equal(new SearchSession(defaultOptions).maxPages, 5);
  });

  await test('参数流程性能：相同新条件的旧入口探索与已确认专业入口结果相同', async () => {
    const rounds = [];
    for (let i = 0; i < 3; i++) {
      const query = freshQuery(`速度${i}`); const variants = {};
      for (const variant of ['explore', 'recipe']) {
        const id = `perf-${variant}-${i}-${++sequence}`; const outputDir = path.join(runDir, id);
        const entryURL = `${baseURL}/entry?mode=popup`, professionalURL = `${baseURL}/professional?mode=popup`;
        const source = { id: 'testdb', name: '专业入口性能测试', url: entryURL, domains: ['127.0.0.1'], kind: 'official_database', access: 'public' };
        const recipe = { id: 'professional-fixture', source_id: 'testdb', entry_url: professionalURL, status: 'query_verified', transitions: { results: { mode: 'popup', container: { css: '#results' }, ready: { css: '#results' }, match: { css: '#query-echo' } } } };
        const session = await createSession({ sessionId: id, outputDir, profileDir: path.join(outputDir, 'profile'), catalog: { sources: [source] }, recipeIndex: { version: '2.4.0', sources: [{ id: 'testdb', source_id: 'testdb', recipe_ids: [recipe.id] }] }, recipes: [recipe], headless: true, archive: true, screenshots: true, preflightSourceIds: [source.id] }); sessions.push(session); await session.preflight();
        const beforeRequests = requests.length; const started = performance.now(); session.beginQuestion(fixtureQuestion(id)); let page; let controlObservationStages;
        if (variant === 'explore') { page = await session.page('testdb', { withObservation: true }).then(value => value.page); const entry = page.getByRole('link', { name: '专业检索入口', exact: true }); await Promise.all([page.waitForURL(professionalURL), entry.click()]); await session.observe(page, { name: 'professional-after-exploration' }); controlObservationStages = 2; }
        else { page = await session.page('testdb', { recipeId: recipe.id, withObservation: true }).then(value => value.page); controlObservationStages = 1; }
        const result = await session.transition('testdb', transitionOptions(id, page, query, 'popup', { recipeId: variant === 'recipe' ? recipe.id : undefined }));
        const records = await result.container.locator('.record-row,.result-row').allTextContents(); const elapsedMs = Math.round((performance.now() - started) * 10) / 10;
        const documentRequests = requests.slice(beforeRequests).filter(request => ['/entry', '/professional', '/results'].includes(request.path));
        variants[variant] = { elapsed_ms: elapsedMs, navigation_requests: documentRequests.length, navigation_paths: documentRequests.map(request => request.path), explicit_control_observation_stages: controlObservationStages, record_texts: records };
        await session.close();
      }
      assert.deepEqual(variants.recipe.record_texts, variants.explore.record_texts, 'same conditions must return identical records'); assert.ok(variants.recipe.navigation_requests < variants.explore.navigation_requests, 'measured professional recipe must avoid the observed homepage navigation');
      rounds.push({ query, ...variants });
    }
    const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const performanceReport = { measured_at: new Date().toISOString(), scope: 'local real Chrome, first specialized query; startup preflight excluded; fixed same input per pair; 20ms fixture response delay', rounds, median_explore_ms: median(rounds.map(item => item.explore.elapsed_ms)), median_recipe_ms: median(rounds.map(item => item.recipe.elapsed_ms)), caveat: 'Local fixture measurements validate removed navigation/observation stages; they do not predict live public database or contest response times. Tool RPC roundtrips are not measured by this in-process script.' };
    fs.writeFileSync(path.join(__dirname, 'v24-performance-tests.json'), JSON.stringify(performanceReport, null, 2) + '\n', 'utf8'); return performanceReport;
  });

  report.requests = requests;
}

(async () => {
  try { await main(); }
  catch (error) { report.tests.push({ name: 'v2.4运行器初始化', passed: false, error: error.stack || String(error) }); process.stderr.write(`${error.stack || error}\n`); }
  finally {
    for (const session of sessions.reverse()) { try { await session.close(); } catch (error) { report.cleanup_errors ||= []; report.cleanup_errors.push(String(error)); } }
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    report.finished_at = new Date().toISOString(); report.passed = report.tests.filter(item => item.passed).length; report.failed = report.tests.filter(item => !item.passed).length;
    const file = path.join(__dirname, 'v24-browser-tests.json'); fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n', 'utf8'); process.stdout.write(`Results: ${report.passed} passed, ${report.failed} failed. ${file}\n`); process.exitCode = report.failed ? 1 : 0;
  }
})();
