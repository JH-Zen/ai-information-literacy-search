#!/usr/bin/env node
'use strict';

// Real-browser regression tests. All web pages are served by this process;
// these tests do not query public websites or use Playwright CLI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');

const validationDir = __dirname;
const reportPath = path.join(validationDir, 'direct-browser-tests.json');
const runDir = fs.mkdtempSync(path.join(validationDir, 'direct-browser-run-'));
const profileDir = path.join(runDir, 'profile');
const results = [];
const report = {
  started_at: new Date().toISOString(),
  kind: 'real Google Chrome browser; local HTTP fixtures; direct Playwright JavaScript API',
  run_dir: runDir,
  node: process.version,
  tests: results,
};
const sessions = [];
let server;

async function test(name, fn) {
  const start = Date.now();
  try {
    const detail = await fn();
    results.push({ name, passed: true, elapsed_ms: Date.now() - start, ...(detail ? { detail } : {}) });
    process.stdout.write(`PASS ${name}\n`);
    return true;
  } catch (error) {
    results.push({ name, passed: false, elapsed_ms: Date.now() - start, error: error.stack || String(error) });
    process.stdout.write(`FAIL ${name}: ${error.message}\n`);
    return false;
  }
}

function html(title, body) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
}

function searchForm(action = '/results') {
  return `<form action="${action}" method="get"><label for="query">检索词</label><input id="query" name="q" type="search" placeholder="请输入检索词"><button type="submit">搜索</button></form>`;
}

function savedArtifactPaths(artifact) {
  if (typeof artifact === 'string') return fs.existsSync(artifact) ? [artifact] : [];
  if (!artifact || typeof artifact !== 'object') return [];
  return Object.values(artifact).flatMap(savedArtifactPaths);
}

function assertNoQuestionTiming(saved, session) {
  assert.equal(Object.hasOwn(saved.answer, 'timing'), false, 'saved answers must not expose per-question timing');
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(saved.jsonPath, 'utf8')), 'timing'), false);
  assert.doesNotMatch(fs.readFileSync(saved.markdownPath, 'utf8'), /本题用时|elapsed_seconds|计时起点/);
  assert.equal(fs.existsSync(path.join(session.outputDir, 'question-timers.json')), false, 'new sessions must not write the removed timer file');
}

const facts = '同一篇文献可以列出多个来源。平台是专搜学术资源的垂直搜索引擎。部分文献因机构订阅、授权或版权限制，无法直接获取全文。可以按照 GB/T 7714-2015 标准导出参考文献。只有开放获取或取得合法授权的文献，才可能免费获取全文。';
const factExcerpts = [
  '同一篇文献可以列出多个来源。',
  '平台是专搜学术资源的垂直搜索引擎。',
  '部分文献因机构订阅、授权或版权限制，无法直接获取全文。',
  '可以按照 GB/T 7714-2015 标准导出参考文献。',
];
const outOfViewFact = '页尾完整证据：检索到的文献不保证全文可免费取得。';

async function main() {
  const { createSession, SearchSession } = require('../ai-literacy-search/scripts/browser.cjs');
  assert.equal(typeof createSession, 'function', 'browser.cjs exports createSession');
  const traffic = { total: 0, active: 0, peak: 0, perHost: {}, requests: [] };
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    const host = url.hostname;
    traffic.total++;
    traffic.active++;
    traffic.peak = Math.max(traffic.peak, traffic.active);
    const byHost = traffic.perHost[host] ||= { active: 0, peak: 0, requests: 0 };
    byHost.active++;
    byHost.peak = Math.max(byHost.peak, byHost.active);
    byHost.requests++;
    traffic.requests.push({ host, path: url.pathname, query: url.search, at: new Date().toISOString() });
    let decremented = false;
    const finish = () => {
      if (decremented) return;
      decremented = true;
      traffic.active--;
      byHost.active--;
    };
    res.once('finish', finish);
    res.once('close', finish);
    // Delaying document responses makes concurrent navigations observable.
    await new Promise(resolve => setTimeout(resolve, 250));
    if (res.destroyed) return;
    let status = 200;
    let title = `测试权威数据库 ${url.pathname.slice(1)}`;
    let body = searchForm();
    if (url.pathname === '/search-error') body = searchForm('/query-error');
    if (url.pathname === '/challenge') {
      body = '<p>安全验证：请完成验证码后继续访问。</p><label>验证码<input name="captcha"></label><button>验证</button>';
    }
    if (url.pathname === '/waf') {
      title = 'WEB应用防火墙';
      body = '<p>当前正在对访问请求进行人机识别检测，请稍等片刻，即将为您加载访问页面 . . .</p>';
    }
    if (url.pathname === '/private') {
      if (!/(?:^|;\s*)campus_auth=1(?:;|$)/.test(req.headers.cookie || '')) {
        body = '<p>请先登录后检索。校园机构认证</p><form><label>用户名<input name="username"></label><label>密码<input type="password" name="password"></label><button>登录</button></form>';
      } else {
        body = '<p>校园机构授权成功，欢迎已登录用户。</p>' + searchForm();
      }
    }
    if (url.pathname === '/qr-access') {
      body = '<p>请先登录后检索。使用手机扫描二维码登录。</p><div role="img" aria-label="登录二维码">模拟二维码</div><button>刷新二维码</button>';
    }
    if (url.pathname === '/search-empty') body = searchForm('/results');
    if (url.pathname === '/results') {
      title = '测试权威数据库 检索结果';
      body = searchForm('/results') + (url.searchParams.get('q') === '不存在的测试词'
        ? '<main id="results"><p>检索完成，找到 0 条结果。没有找到相关记录。</p></main>'
        : '<main id="results"><p>检索完成，找到 1 条结果。</p><a href="/help">数据库官方帮助</a></main>');
    }
    if (url.pathname === '/query-error') {
      title = '检索服务错误';
      status = 503;
      body = '<main>检索服务暂时不可用。请求失败，请稍后重试。</main>';
    }
    if (url.pathname === '/http-error') {
      status = 503;
      // A stale form can remain visible on an error page; it must not make the
      // website appear ready for a successful search.
      body = '<p>服务暂时不可用，请稍后重试。</p>' + searchForm();
    }
    if (url.pathname === '/help') {
      title = '测试权威数据库 help';
      body = `<main><h2>数据库功能与全文获取</h2><p id="facts">${facts}</p></main>`;
    }
    if (url.pathname === '/long-help') {
      title = '测试权威数据库 长篇帮助';
      const paragraphs = Array.from({ length: 1800 }, (_, i) => `<p>帮助章节 ${i}：这是与检索结果无关的较长背景说明，用于验证完整正文取证以及返回视图的截断标记。</p>`).join('');
      const controls = Array.from({ length: 350 }, (_, i) => `<button type="button">帮助入口 ${i}</button>`).join('');
      body = `<main>${paragraphs}<p id="out-of-view-fact">${outOfViewFact}</p>${controls}</main>`;
    }
    if (url.pathname === '/frame-help') {
      title = '测试权威数据库 嵌入帮助';
      body = '<main><p>完整帮助位于下方内嵌文档。</p><iframe name="official-help" src="/frame-facts" title="官方帮助正文"></iframe></main>';
    }
    if (url.pathname === '/frame-facts') {
      title = '测试权威数据库 嵌入帮助正文';
      body = `<main><p id="frame-facts">${facts}</p></main>`;
    }
    if (['/entry-home', '/entry-home-restart'].includes(url.pathname)) {
      title = '测试权威数据库 首页';
      body = searchForm() + '<a href="/advanced">高级检索</a><a href="/advanced-jump">专业检索入口</a>';
    }
    if (url.pathname === '/advanced-jump') {
      res.writeHead(302, { Location: '/advanced-panel', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    if (['/advanced', '/advanced-panel'].includes(url.pathname)) {
      title = '测试权威数据库 专业检索';
      body = '<main id="professional"><p>请按字段构建专业检索表达式。</p><form action="/results"><label for="professional-expression">专业检索表达式</label><textarea id="professional-expression" name="q"></textarea><button type="submit">专业检索</button></form></main>';
    }
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html(title, body));
  });
  server.listen(0, '0.0.0.0');
  await once(server, 'listening');
  const port = server.address().port;
  const url = (host, pathname) => `http://${host}:${port}${pathname}`;
  const source = (id, host, pathname) => ({ id, name: `测试权威数据库 ${pathname.slice(1)}`, url: url(host, pathname), domains: [host], access: 'public', kind: 'official_database' });
  const catalog = { sources: [
    source('same-1', '127.0.0.1', '/search-1'),
    source('same-2', '127.0.0.1', '/search-2'),
    source('bad-search', '127.0.0.1', '/search-error'),
    source('captcha', 'localhost', '/challenge'),
    source('login', 'localhost', '/private'),
    source('qr-login', 'localhost', '/qr-access'),
    source('empty', '127.0.0.2', '/search-empty'),
    source('help', '127.0.0.2', '/help'),
    source('parallel-3', '127.0.0.3', '/search-3'),
    source('parallel-4', '127.0.0.4', '/search-4'),
    source('http-error', '127.0.0.4', '/http-error'),
    source('waf-200', '127.0.0.4', '/waf'),
    { ...source('wrong-identity', '127.0.0.5', '/search-identity'), domains: ['authority.invalid'] },
    source('advanced-entry', '127.0.0.6', '/entry-home'),
    source('advanced-restart', '127.0.0.6', '/entry-home-restart'),
  ] };
  report.fixture_source_count = catalog.sources.length;
  const session = await createSession({
    sessionId: 'direct-browser-fixture',
    outputDir: runDir,
    profileDir,
    catalog,
    archive: true, screenshots: true, preflightSourceIds: catalog.sources.map(source => source.id),
    maxPages: 3,
    headless: true,
    navigationTimeoutMs: 10000,
  });
  sessions.push(session);
  let preflight;
  const entry = (value, id) => value.entries.find(item => item.source_id === id);
  await test('Google Chrome：实际浏览器身份与启动记录一致', async () => {
    const page = session.context.pages()[0];
    const userAgent = await page.evaluate(() => navigator.userAgent);
    assert.match(userAgent, /(?:Headless)?Chrome\//);
    assert.doesNotMatch(userAgent, /Edg\//, 'the launch must use Google Chrome rather than Edge');
    const events = fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    const started = events.find(event => event.event === 'browser_started');
    assert.equal(started.channel, 'chrome');
    const isolated = new SearchSession({ sessionId: 'default-chrome-profile', outputDir: path.join(runDir, 'default-profile-check'), catalog });
    assert.equal(isolated.profileDir, path.join(isolated.runtimeDir, 'profiles', 'chrome', 'default-chrome-profile'), 'Chrome must have a profile namespace separate from the previous Edge sessions');
    return { user_agent: userAgent, channel: started.channel };
  });
  await test('生命周期起点：未做可选预检仍允许开始答题', async () => {
    assert.equal(typeof session.beginQuestion, 'function');
    session.beginQuestion('before-initialization');
    assert.equal(session.activeQuestion.id, 'before-initialization');
    session.finishQuestion('before-initialization');
  });
  const firstOK = await test('全目录自检：真实页面、入口、验证码与 HTTP 错误', async () => {
    const progress = [];
    preflight = await session.preflight({ onProgress: (...args) => progress.push(args) });
    assert.equal(preflight.completed, true);
    assert.equal(preflight.entries.length, catalog.sources.length);
    assert.equal(new Set(preflight.entries.map(item => item.source_id)).size, catalog.sources.length);
    assert.equal(entry(preflight, 'same-1').availability, 'reachable');
    assert.equal(entry(preflight, 'same-1').identity, 'matched');
    assert.equal(entry(preflight, 'same-1').search_ready, true);
    assert.equal(entry(preflight, 'same-1').search_status, 'untested');
    assert.equal(entry(preflight, 'captcha').authorization, 'challenge');
    assert.equal(entry(preflight, 'login').authorization, 'login_required');
    assert.equal(entry(preflight, 'qr-login').authorization, 'login_required');
    assert.equal(entry(preflight, 'qr-login').search_ready, false);
    assert.equal(entry(preflight, 'http-error').availability, 'http_error');
    assert.equal(entry(preflight, 'http-error').search_ready, false, 'an error page with a visible form must not be search-ready');
    assert.equal(entry(preflight, 'wrong-identity').identity, 'mismatch');
    assert.equal(entry(preflight, 'wrong-identity').search_ready, false, 'a page outside the source identity must not be search-ready');
    assert.ok(progress.length > 0, 'preflight publishes progress for a full catalogue');
    for (const item of preflight.entries) {
      assert.ok(item.final_url, `${item.source_id} records final URL`);
      assert.match(JSON.stringify(item), /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, `${item.source_id} records an ISO check timestamp`);
      assert.ok(savedArtifactPaths(item.artifact || item.snapshot).length > 0, `${item.source_id} saves a real page artifact`);
    }
    const navigationEvents = fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse).filter(event => event.event === 'navigation_completed');
    assert.ok(navigationEvents.length >= catalog.sources.length);
    assert.ok(navigationEvents.every(event => Number.isFinite(event.duration_ms) && event.duration_ms >= 0), 'navigation duration diagnostics must contain real finite measurements');
    return { entries: preflight.entries.length, progress_events: progress.length };
  });
  if (!firstOK) throw new Error('The full preflight failed; dependent checks cannot safely continue.');

  await test('首次页面观察复用：只读取一次，后续题目仍读取最新正文', async () => {
    const originalObserve = session.observe;
    let reads = 0;
    session.observe = async function (...args) { reads++; return originalObserve.apply(this, args); };
    try {
      const first = await session.page('same-1', { withObservation: true, compact: true, focus: ['检索词'] });
      assert.ok(first.page && typeof first.page.getByRole === 'function');
      assert.ok(first.observation.text.includes('检索词'));
      assert.ok(first.observation.controls.some(control => control.type === 'search'));
      assert.equal(reads, 1, 'opening the page and returning its observation must not read it twice');
      const freshText = '第二题已经更新：请使用当前搜索结果核验。';
      await first.page.locator('body').evaluate((body, text) => { body.append(document.createTextNode(text)); }, freshText);
      const second = await session.page('same-1', { withObservation: true, compact: true, focus: ['第二题'] });
      assert.equal(second.page, first.page, 'consecutive questions reuse the actual browser page');
      assert.equal(reads, 2, 'the second question must receive a fresh observation');
      assert.ok(second.observation.text.includes(freshText), 'old cached text must not hide new document content');
      assert.equal(await session.page('same-1'), first.page, 'the legacy method returns a native Playwright Page');
      assert.equal(reads, 2, 'the legacy reuse path must not add a redundant observation');
      return { first_page_reads: 1, second_question_reads: 1 };
    } finally { session.observe = originalObserve; }
  });

  await test('并发约束：网站内串行、最多三个导航并行', async () => {
    assert.ok(traffic.peak >= 2, `expected concurrent independent sites, observed ${traffic.peak}`);
    assert.ok(traffic.peak <= 3, `expected at most 3 simultaneous document requests, observed ${traffic.peak}`);
    for (const [host, counts] of Object.entries(traffic.perHost)) {
      assert.ok(counts.peak <= 1, `${host} had ${counts.peak} simultaneous requests`);
    }
    return { maximum_concurrent_documents: traffic.peak, per_host: traffic.perHost };
  });

  await test('第二题复用初始化：preflight 不重复发请求', async () => {
    const before = traffic.total;
    const cached = await session.preflight();
    assert.deepEqual(cached, preflight);
    assert.equal(traffic.total, before, 'second preflight must not navigate or query again');
    return { requests_before: before, requests_after: traffic.total };
  });

  await test('验证码阻碍：不得记录成成功查询或事实证据', async () => {
    const page = await session.page('captcha');
    await assert.rejects(() => session.recordSearch('captcha', { page, query: '检索词', filters: {}, outcome: 'empty', detail: 'This must be rejected: verification is still pending.' }));
    await assert.rejects(() => session.captureEvidence(page, {
      questionId: 'challenge-is-not-evidence', name: '安全验证', query: '检索词', field: '验证页',
      locator: 'body', target: page.locator('body'), evidence: '安全验证：请完成验证码后继续访问。',
    }));
  });

  await test('HTTP 200 防火墙等待页：人机识别阻碍不得作为搜索成功或官方事实', async () => {
    const initial = entry(preflight, 'waf-200');
    assert.equal(initial.http_status, 200, 'a WAF may return HTTP 200 instead of an HTTP error');
    assert.equal(initial.title, 'WEB应用防火墙');
    assert.equal(initial.authorization, 'challenge');
    assert.equal(initial.search_ready, false);
    const { page, observation } = await session.page('waf-200', { withObservation: true });
    const waitingText = '当前正在对访问请求进行人机识别检测，请稍等片刻，即将为您加载访问页面 . . .';
    assert.ok(observation.text.includes(waitingText));
    await assert.rejects(() => session.recordSearch('waf-200', { page, query: 'CSSCI来源期刊', filters: {}, outcome: 'results' }), /Login|challenge|error/i);
    await assert.rejects(() => session.captureEvidence(page, {
      questionId: 'waf-is-not-factual-evidence', name: 'WEB应用防火墙', query: 'CSSCI来源期刊', field: '等待页正文',
      locator: 'body', target: page.locator('body'), evidence: waitingText,
    }), /Login|challenge|error/i, 'the real observed text is an access obstacle, not answer evidence');
    await assert.rejects(() => session.addSource(source('waf-official-registration', '127.0.0.4', '/waf'), { page }), /Login|challenge|error/i, 'HTTP 200 alone cannot register the WAF as an official source');
    const checked = await session.preflight();
    assert.equal(entry(checked, 'waf-200').authorization, 'challenge');
    assert.equal(entry(checked, 'waf-200').search_status, 'untested');
    assert.equal(checked.completed, true, 'recording a blocked target still completes the access check');
    await page.close();
  });

  await test('入口正常但提交搜索失败：不得记作有效零结果', async () => {
    const page = await session.page('bad-search');
    const observation = await session.observe(page, { name: 'search-error-before-submit' });
    assert.ok(observation.text.includes('搜索'));
    assert.ok(Array.isArray(observation.controls) && observation.controls.length > 0);
    await page.getByRole('searchbox', { name: '检索词' }).fill('数据库全文');
    await Promise.all([
      page.waitForURL('**/query-error?*'),
      page.getByRole('button', { name: '搜索', exact: true }).click(),
    ]);
    assert.ok((await page.locator('body').innerText()).includes('检索服务暂时不可用'));
    await session.recordSearch('bad-search', { page, query: '数据库全文', filters: {}, outcome: 'failed', detail: 'HTTP 503 after submitting the observed form' });
    const current = await session.preflight();
    assert.equal(entry(current, 'bad-search').search_status, 'failed');
    assert.equal(entry(current, 'bad-search').availability, 'http_error');
    const refreshedError = await session.recheck('bad-search');
    assert.equal(refreshedError.availability, 'http_error', 'observing an existing error page must retain its actual HTTP status');
    assert.equal(refreshedError.http_status, 503);
    await assert.rejects(() => session.captureEvidence(page, {
      questionId: 'error-page-is-not-evidence', name: '检索服务错误', query: '数据库全文', field: '错误页正文',
      locator: 'main', target: page.locator('main'), evidence: '检索服务暂时不可用。请求失败，请稍后重试。',
    }), 'an HTTP 503 page is an access obstacle, not factual answer evidence');
  });

  await test('正常返回零结果：保留检索条件并记为 empty', async () => {
    const page = await session.page('empty');
    await session.observe(page, { name: 'empty-before-submit' });
    await page.getByRole('searchbox', { name: '检索词' }).fill('不存在的测试词');
    await Promise.all([
      page.waitForURL('**/results?*'),
      page.getByRole('button', { name: '搜索', exact: true }).click(),
    ]);
    assert.ok((await page.locator('#results').innerText()).includes('0 条结果'));
    await session.recordSearch('empty', { page, query: '不存在的测试词', filters: { field: '全部字段' }, outcome: 'empty', detail: 'The completed results page explicitly reports zero records.' });
    const current = await session.preflight();
    assert.equal(entry(current, 'empty').search_status, 'empty');
    assert.notEqual(entry(current, 'empty').search_status, entry(current, 'bad-search').search_status);
    assert.ok(JSON.stringify(entry(current, 'empty')).includes('不存在的测试词'), 'search query survives in the saved entry');
    assert.ok(JSON.stringify(entry(current, 'empty')).includes('全部字段'), 'observed search field survives in the saved entry');
  });

  await test('登录后恢复：只复查相关站点并重新识别检索入口', async () => {
    const page = await session.page('login');
    assert.ok((await page.locator('body').innerText()).includes('请先登录'));
    const before = traffic.requests.length;
    await page.context().addCookies([{ name: 'campus_auth', value: '1', url: url('localhost', '/'), expires: Math.floor(Date.now() / 1000) + 3600 }]);
    // A real user completes the login flow and reaches the authorised page.
    // Reload after installing the fixture cookie simulates that completion.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await session.recheck('login');
    const current = await session.preflight();
    assert.equal(entry(current, 'login').authorization, 'not_observed');
    assert.equal(entry(current, 'login').search_ready, true);
    const newRequests = traffic.requests.slice(before);
    assert.ok(newRequests.length > 0);
    assert.ok(newRequests.every(request => request.path === '/private'), 'recheck must only revisit the selected source');
    return { recheck_requests: newRequests.length };
  });

  const helpPage = await session.page('help');
  const beginEvidenceFixture = id => session.beginQuestion({ id, type: 'judge', question: `当前官方帮助正文取证验证，题号${id}。`, options: {} });
  const captureFixtureEvidence = async (page, options) => { beginEvidenceFixture(options.questionId); return session.captureEvidence(page, options); };
  const captureFixtureEvidenceBatch = async (page, options) => { beginEvidenceFixture(options.questionId); return session.captureEvidenceBatch(page, options); };
  const captured = async (question) => { session.beginQuestion(question); return session.captureEvidence(helpPage, {
    questionId: question.id,
    name: '测试权威数据库官方帮助',
    query: '全文获取 来源 参考文献导出',
    field: '官方帮助正文',
    locator: '#facts',
    target: helpPage.locator('#facts'),
    evidence: facts,
  }); };
  const makeAnswer = (question, sources, selectedLabels, options = {}) => ({
    id: question.id,
    question: question.question,
    type: question.type,
    status: 'verified',
    answer: selectedLabels.map(label => question.options[label]),
    answer_labels: selectedLabels,
    explanation: '根据实际打开的官方帮助核验全部选项，并按当前题目字母映射答案。',
    option_evaluations: Object.entries(question.options).map(([label, text]) => ({
      label, text, verdict: selectedLabels.includes(label) ? 'supported' : 'refuted',
      reason: selectedLabels.includes(label) ? '该选项符合本题要求。' : '该选项不符合本题要求。',
    })),
    sources,
    needs_review: [],
    searched_at: new Date().toISOString(),
    ...options,
  });
  const single = {
    id: 'single-negative', type: 'single', question: '关于本数据库，下列说法错误的是（）。',
    options: { A: '同一篇文献可以列出多个来源。', B: '平台是专搜学术资源的垂直搜索引擎。', C: '检索到的每篇文献均能直接获取全文。', D: '可以按照 GB/T 7714-2015 导出参考文献。' },
  };

  await test('真实正文取证：伪造摘录被拒绝，证据与快照落盘', async () => {
    await assert.rejects(() => captureFixtureEvidence(helpPage, { questionId: 'forged-fragment', name: '官方帮助', query: '不存在', field: '正文', locator: '#facts', target: helpPage.locator('#facts'), evidence: '这一句根本不存在于真实页面中。' }));
    const otherPage = await session.page('captcha');
    await assert.rejects(() => captureFixtureEvidence(helpPage, {
      questionId: 'wrong-page-locator', name: '数据库帮助', query: '验证', field: '正文', locator: 'body',
      target: otherPage.locator('body'), evidence: '安全验证：请完成验证码后继续访问。',
    }), 'a locator belonging to another page must not fabricate evidence at this page URL');
    const evidence = await captured(single);
    assert.equal(evidence.source.evidence, facts);
    assert.equal(evidence.source.url, helpPage.url());
    for (const field of ['name', 'url', 'query', 'field', 'evidence', 'locator', 'retrieved_at']) assert.ok(evidence.source[field]);
    assert.ok(evidence.artifact, 'captureEvidence records saved artifacts');
    const artifactPaths = savedArtifactPaths(evidence.artifact);
    assert.ok(artifactPaths.length > 0, 'evidence artifacts exist on disk');
    assert.ok(artifactPaths.some(artifactPath => /\.png$/i.test(artifactPath)), 'evidence includes a real browser screenshot');
  });

  await test('同页批量取证：四条摘录共用有效页面观察与一次截图', async () => {
    const originalObserve = session.observe;
    const originalScreenshot = helpPage.screenshot;
    let observations = 0;
    let screenshots = 0;
    session.observe = async function (...args) { observations++; return originalObserve.apply(this, args); };
    helpPage.screenshot = async function (...args) { screenshots++; return originalScreenshot.apply(this, args); };
    try {
      const batch = await captureFixtureEvidenceBatch(helpPage, {
        questionId: 'batch-four-excerpts', name: '测试权威数据库官方帮助', query: '来源 全文 引用',
        field: '官方帮助正文', locator: '#facts', target: helpPage.locator('#facts'), excerpts: factExcerpts,
      });
      assert.ok(observations <= 1, 'one current observation or a still-valid cached observation is sufficient for the whole batch');
      assert.equal(screenshots, 1);
      assert.equal(batch.sources.length, factExcerpts.length);
      assert.deepEqual(batch.sources.map(source => source.evidence), factExcerpts);
      for (const source of batch.sources) assert.equal(source.url, helpPage.url());
      const records = session.evidence.filter(record => record.question_id === 'batch-four-excerpts');
      assert.equal(records.length, factExcerpts.length);
      for (const record of records) assert.deepEqual(record.artifact, batch.artifact, 'each source must refer to the same real snapshot and screenshot');
      for (const field of ['snapshot', 'screenshot', 'target_text']) assert.ok(fs.existsSync(batch.artifact[field]));
      const target = JSON.parse(fs.readFileSync(batch.artifact.target_text, 'utf8'));
      for (const excerpt of factExcerpts) assert.ok(target.text.includes(excerpt));
      const events = fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
      const batchEvents = events.filter(event => event.event === 'evidence_batch_captured' && event.question_id === 'batch-four-excerpts');
      assert.equal(batchEvents.length, 1);
      assert.equal(batchEvents[0].count, factExcerpts.length);
      assert.ok(Number.isFinite(batchEvents[0].duration_ms) && batchEvents[0].duration_ms >= 0);
      const observationEvent = events.findLast(event => event.event === 'page_observed' && event.artifact === batch.artifact.snapshot);
      assert.ok(observationEvent && Number.isFinite(observationEvent.duration_ms) && observationEvent.duration_ms >= 0, 'observation duration must be measured independently of the overall question timer');
      return { excerpts: batch.sources.length, page_observations: observations, screenshots };
    } finally {
      session.observe = originalObserve;
      helpPage.screenshot = originalScreenshot;
    }
  });

  await test('批量取证完整性：任一伪造摘录整批拒绝，跨页定位器拒绝', async () => {
    const id = 'batch-forged-excerpt';
    const before = session.evidence.length;
    await assert.rejects(() => captureFixtureEvidenceBatch(helpPage, {
      questionId: id, name: '测试权威数据库官方帮助', query: '全文', field: '官方帮助正文',
      locator: '#facts', target: helpPage.locator('#facts'), excerpts: [factExcerpts[0], '这一句没有出现在权威帮助正文中。'],
    }));
    assert.equal(session.evidence.length, before, 'valid excerpts from a failed batch must not be partially committed');
    const stored = fs.readFileSync(path.join(runDir, 'evidence.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert.ok(stored.every(record => record.question_id !== id), 'failed batches must not write partial evidence records to disk');
    const otherPage = session.context.pages().find(page => page !== helpPage);
    assert.ok(otherPage, 'fixture has another real browser page');
    await assert.rejects(() => captureFixtureEvidenceBatch(helpPage, {
      questionId: 'batch-cross-page', name: '测试权威数据库官方帮助', query: '全文', field: '官方帮助正文',
      locator: 'body', target: otherPage.locator('body'), excerpts: [factExcerpts[0]],
    }));
    assert.equal(session.evidence.length, before);
  });

  await test('紧凑观察：明确截断返回视图，完整快照仍可核验视图外正文', async () => {
    await helpPage.goto(url('127.0.0.2', '/long-help'), { waitUntil: 'domcontentloaded' });
    try {
      const compact = await session.observe(helpPage, { name: 'compact-long-page', compact: true });
      assert.equal(compact.truncated.text, true);
      assert.equal(compact.truncated.aria, true);
      assert.equal(compact.truncated.controls, true);
      assert.ok(compact.text.length <= 5000);
      assert.ok(compact.aria.length <= 3000);
      assert.ok(compact.controls.length <= 80);
      assert.ok(compact.full_text_length > compact.text.length);
      assert.ok(compact.full_aria_length > compact.aria.length);
      assert.ok(compact.full_controls_count > compact.controls.length);
      assert.ok(!compact.text.includes(outOfViewFact), 'the test excerpt must be outside the compact return view');
      const fullSnapshot = JSON.parse(fs.readFileSync(compact.artifact, 'utf8'));
      assert.ok(fullSnapshot.text.includes(outOfViewFact), 'the saved snapshot must preserve the complete observed text');
      assert.equal(fullSnapshot.text.length, compact.full_text_length);
      assert.equal(fullSnapshot.aria.length, compact.full_aria_length);
      assert.equal(fullSnapshot.controls.length, compact.full_controls_count);
      const focused = await session.observe(helpPage, { name: 'compact-focus-page', compact: true, focus: ['页尾完整证据'] });
      assert.ok(focused.text.includes(outOfViewFact), 'observed keywords may focus the returned view without changing the full artifact');
      const evidence = await captureFixtureEvidence(helpPage, {
        questionId: 'compact-out-of-view-evidence', name: '测试权威数据库完整帮助', query: '全文授权', field: '帮助全文',
        locator: 'body', evidence: outOfViewFact,
      });
      assert.equal(evidence.source.evidence, outOfViewFact, 'capture must verify against full observed content rather than a compact preview');
      return { returned_text_length: compact.text.length, full_text_length: compact.full_text_length, full_controls_count: compact.full_controls_count };
    } finally { await helpPage.goto(url('127.0.0.2', '/help'), { waitUntil: 'domcontentloaded' }); }
  });

  await test('嵌入文档批量取证：同页 iframe 定位器保留完整目标正文', async () => {
    await helpPage.goto(url('127.0.0.2', '/frame-help'), { waitUntil: 'domcontentloaded' });
    try {
      const target = helpPage.frameLocator('iframe[name="official-help"]').locator('#frame-facts');
      await target.waitFor();
      const batch = await captureFixtureEvidenceBatch(helpPage, {
        questionId: 'batch-iframe', name: '测试权威数据库嵌入帮助', query: '全文 引用', field: '官方帮助内嵌正文',
        locator: 'iframe[name="official-help"] >> #frame-facts', target, excerpts: factExcerpts,
      });
      assert.deepEqual(batch.sources.map(source => source.evidence), factExcerpts);
      const snapshot = JSON.parse(fs.readFileSync(batch.artifact.snapshot, 'utf8'));
      const targetText = JSON.parse(fs.readFileSync(batch.artifact.target_text, 'utf8'));
      assert.equal(targetText.text, facts);
      assert.ok(!snapshot.text.includes(factExcerpts[0]), 'top-level innerText must not be confused with iframe target text');
      assert.equal(batch.sources[0].url, helpPage.url());
    } finally { await helpPage.goto(url('127.0.0.2', '/help'), { waitUntil: 'domcontentloaded' }); }
  });

  await test('批量取证跨文档：观察后页面导航不得拼接旧正文与新页面', async () => {
    const originalObserve = session.observe;
    const before = session.evidence.length;
    session.observe = async function (page, options) {
      const observation = await originalObserve.call(this, page, options);
      if (page === helpPage) await page.goto(url('127.0.0.2', '/help?document-changed=1'), { waitUntil: 'domcontentloaded' });
      return observation;
    };
    try {
      await assert.rejects(() => captureFixtureEvidenceBatch(helpPage, {
        questionId: 'batch-document-changed', name: '测试权威数据库官方帮助', query: '全文', field: '官方帮助正文',
        locator: '#facts', target: helpPage.locator('#facts'), excerpts: factExcerpts,
      }), 'same-looking content in a new document must not be mixed into one evidence capture');
      assert.equal(session.evidence.length, before);
    } finally {
      session.observe = originalObserve;
      await helpPage.goto(url('127.0.0.2', '/help'), { waitUntil: 'domcontentloaded' });
    }
  });

  await test('嵌入文档导航：取证期间同址 iframe 重载不得混用两个文档', async () => {
    await helpPage.goto(url('127.0.0.2', '/frame-help'), { waitUntil: 'domcontentloaded' });
    const target = helpPage.frameLocator('iframe[name="official-help"]').locator('#frame-facts');
    await target.waitFor();
    const originalObserve = session.observe;
    const before = session.evidence.length;
    session.observe = async function (page, options) {
      const observation = await originalObserve.call(this, page, options);
      if (page === helpPage) {
        const frame = page.frame({ name: 'official-help' });
        assert.ok(frame);
        await frame.goto(frame.url(), { waitUntil: 'domcontentloaded' });
      }
      return observation;
    };
    try {
      await assert.rejects(() => captureFixtureEvidenceBatch(helpPage, {
        questionId: 'batch-iframe-reloaded', name: '测试权威数据库嵌入帮助', query: '全文', field: '官方帮助内嵌正文',
        locator: 'iframe[name="official-help"] >> #frame-facts', target, excerpts: factExcerpts,
      }), 'same URL and identical text in a reloaded target iframe still belong to a new document');
      assert.equal(session.evidence.length, before);
    } finally {
      session.observe = originalObserve;
      await helpPage.goto(url('127.0.0.2', '/help'), { waitUntil: 'domcontentloaded' });
    }
  });

  await test('单选否定题：核查全部选项并保存当前字母和文字', async () => {
    await session.beginQuestion(single);
    const evidence = await captured(single);
    const saved = await session.saveAnswer(single, makeAnswer(single, [evidence.source], ['C']));
    assert.equal(saved.answer.status, 'verified');
    assert.deepEqual(saved.answer.answer_labels, ['C']);
    assert.deepEqual(saved.answer.answer, [single.options.C]);
    assert.ok(fs.existsSync(saved.jsonPath));
    assert.ok(fs.existsSync(saved.markdownPath));
    assert.equal(JSON.parse(fs.readFileSync(saved.jsonPath, 'utf8')).status, 'verified');
    assert.equal(saved.answer.confidence.score, 95);
    assert.equal(saved.answer.confidence.level, 'high');
    assert.ok(saved.answer.confidence.basis.trim());
    assertNoQuestionTiming(saved, session);
  });

  await test('多选逐项核查：完整答案通过，漏核查任一选项降级', async () => {
    const question = { id: 'multiple-complete', type: 'multiple', question: '下列哪些功能有官方帮助支持？', options: { A: '同一文献多个来源', B: '所有全文均可免费获取', C: '按 GB/T 7714-2015 导出引用', D: '无需授权即可获取全部全文' } };
    await session.beginQuestion(question);
    const evidence = await captured(question);
    const full = makeAnswer(question, [evidence.source], ['A', 'C']);
    const complete = await session.saveAnswer(question, full);
    assert.equal(complete.answer.status, 'verified');
    assert.equal(complete.answer.confidence.score, 95);
    assertNoQuestionTiming(complete, session);
    const incomplete = { ...question, id: 'multiple-missing-option' };
    const nextEvidence = await captured(incomplete);
    const candidate = makeAnswer(incomplete, [nextEvidence.source], ['A', 'C']);
    candidate.confidence = { score: 99, basis: '候选声称高置信度，但漏核查一个选项。' };
    candidate.option_evaluations = candidate.option_evaluations.filter(item => item.label !== 'D');
    const saved = await session.saveAnswer(incomplete, candidate);
    assert.notEqual(saved.answer.status, 'verified');
    assert.ok(saved.answer.needs_review.length > 0);
    assert.equal(saved.answer.confidence.score, 79, 'confidence must respect the final downgraded status');
    assert.equal(saved.answer.confidence.level, 'medium');
  });

  await test('选择题选项缺失：真实来源不能使不完整题目变成已核验', async () => {
    for (const type of ['single', 'multiple']) {
      const question = { id: `missing-options-${type}`, type, question: '关于全文获取，下列说法错误的是？', options: {} };
      const evidence = await captured(question);
      const proposed = makeAnswer(question, [evidence.source], [], { answer: ['检索到的每篇文献均能直接获取全文。'] });
      const saved = await session.saveAnswer(question, proposed);
      assert.notEqual(saved.answer.status, 'verified', `${type} with missing options cannot be fully verified`);
      assert.ok(saved.answer.needs_review.length > 0);
    }
  });

  await test('判断题条件限制：保留完整命题并核验错误结论', async () => {
    const question = { id: 'judge-condition', type: 'judge', question: '即使文献没有开放获取或机构授权，只要被数据库检索到，就一定可以免费获取全文。', options: {} };
    await session.beginQuestion(question);
    const evidence = await captured(question);
    const answer = makeAnswer(question, [evidence.source], [], {
      answer: ['错误'], answer_labels: [], option_evaluations: [],
      explanation: '该命题忽略开放获取或机构授权的条件。官方帮助明确部分文献受订阅、授权或版权限制，无法直接获取全文，因此不能保证免费获取。',
    });
    const saved = await session.saveAnswer(question, answer);
    assert.equal(saved.answer.status, 'verified');
    assert.deepEqual(saved.answer.answer, ['错误']);
    assert.equal(saved.answer.question, question.question);
    assert.equal(saved.answer.confidence.level, 'high');
    assertNoQuestionTiming(saved, session);
  });

  await test('选项重排：正确新字母通过，沿用旧字母与文字冲突降级', async () => {
    const question = { ...single, id: 'reordered-correct', options: { A: single.options.A, B: single.options.B, C: single.options.D, D: single.options.C } };
    const evidence = await captured(question);
    const saved = await session.saveAnswer(question, makeAnswer(question, [evidence.source], ['D']));
    assert.equal(saved.answer.status, 'verified');
    assert.deepEqual(saved.answer.answer_labels, ['D']);
    assert.deepEqual(saved.answer.answer, [single.options.C]);
    const staleQuestion = { ...question, id: 'reordered-stale-letter' };
    const nextEvidence = await captured(staleQuestion);
    const candidate = makeAnswer(staleQuestion, [nextEvidence.source], ['C'], { answer: [single.options.C] });
    const stale = await session.saveAnswer(staleQuestion, candidate);
    assert.notEqual(stale.answer.status, 'verified', 'stale letter C conflicts with the selected answer text');
  });

  await test('伪造或跨题证据：仅填写来源字段不能获得已核验状态', async () => {
    const question = { ...single, id: 'forged-source' };
    const fabricated = { name: '测试权威数据库官方帮助', url: helpPage.url(), query: '全文', field: '正文', evidence: facts, locator: '#facts', retrieved_at: new Date().toISOString() };
    const saved = await session.saveAnswer(question, makeAnswer(question, [fabricated], ['C']));
    assert.notEqual(saved.answer.status, 'verified');
    assert.ok(saved.answer.needs_review.length > 0);
  });

  const metricQuestion = id => ({ id, type: 'judge', question: '检索到文献就一定能免费获取全文。', options: {} });
  const metricAnswer = (question, options = {}) => makeAnswer(question, [], [], {
    status: 'unverified', answer: ['错误'], option_evaluations: [],
    explanation: '仅验证指标保存行为，尚未为此题捕获事实证据。', ...options,
  });

  await test('移除计时：忽略旧候选timing，答案不输出时间或创建计时文件', async () => {
    const question = metricQuestion('legacy-timing-ignored');
    const saved = await session.saveAnswer(question, metricAnswer(question, {
      timing: { started_at: '2000-01-01T00:00:00.000Z', finished_at: '2000-01-01T00:00:00.123Z', elapsed_seconds: 0.123, initialization_excluded: false },
    }));
    assertNoQuestionTiming(saved, session);
    const markdown = fs.readFileSync(saved.markdownPath, 'utf8');
    assert.match(markdown, /置信度/);
    assert.match(markdown, /30/);
    assert.doesNotMatch(markdown, /0\.123/);
  });

  await test('题目生命周期：同attempt复用、指纹约束、完成后重试且不存时间', async () => {
    const question = metricQuestion('attempt-reuse-and-retry');
    await session.beginQuestion(question);
    const firstAttempt = session.activeQuestion.attempt;
    await session.beginQuestion(question);
    assert.equal(session.activeQuestion.attempt, firstAttempt);
    assert.throws(() => session.beginQuestion({ ...question, question: '同题号被替换为不同题干。' }), 'an unfinished id cannot be rebound to different question text');
    const first = await session.saveAnswer(question, metricAnswer(question, {
      timing: { started_at: null, finished_at: '2000-01-01T00:00:00.000Z', elapsed_seconds: 0, initialization_excluded: false },
    }));
    assertNoQuestionTiming(first, session);
    const repeat = await session.saveAnswer(question, metricAnswer(question));
    assertNoQuestionTiming(repeat, session);
    assert.equal(session.questionRecords.findLast(record => record.question_id === question.id).attempt, firstAttempt, 'resaving a completed attempt does not invent another attempt');
    await session.beginQuestion(question);
    assert.equal(session.activeQuestion.attempt, firstAttempt + 1);
    const retry = await session.saveAnswer(question, metricAnswer(question));
    assertNoQuestionTiming(retry, session);
    const attempts = JSON.parse(fs.readFileSync(path.join(session.outputDir, 'question-attempts.json'), 'utf8'));
    assert.ok(attempts.records.some(record => record.question_id === question.id && record.attempt === firstAttempt + 1));
    for (const record of attempts.records) for (const key of ['started_at', 'finished_at', 'elapsed_seconds', 'initialization_excluded']) assert.equal(Object.hasOwn(record, key), false, `attempt state must not store ${key}`);
    return { first_attempt: firstAttempt, retry_attempt: firstAttempt + 1, timing_removed: true };
  });

  await test('置信度评级：所有状态默认值、上限、阈值与保留低估计', async () => {
    const cases = [
      ['verified', 95, 99, 'high'], ['partial', 65, 79, 'medium'],
      ['unverified', 30, 49, 'low'], ['blocked', 20, 49, 'low'], ['conflict', 40, 59, 'low'],
    ];
    for (const [status, expectedDefault, cap, level] of cases) {
      const question = metricQuestion(`confidence-default-${status}`);
      const sourceRecord = status === 'verified' ? (await captured(question)).source : null;
      const saved = await session.saveAnswer(question, metricAnswer(question, { status, sources: sourceRecord ? [sourceRecord] : [] }));
      assert.equal(saved.answer.status, status);
      assert.equal(saved.answer.confidence.score, expectedDefault);
      assert.equal(saved.answer.confidence.level, level);
      assert.ok(saved.answer.confidence.basis.trim());
      const capped = await session.saveAnswer(question, metricAnswer(question, {
        status, sources: sourceRecord ? [sourceRecord] : [], confidence: { score: 100, basis: '候选估计达到满分，应按最终证据状态限制。' },
      }));
      assert.equal(capped.answer.confidence.score, cap);
      const lowered = await session.saveAnswer(question, metricAnswer(question, {
        status, sources: sourceRecord ? [sourceRecord] : [], confidence: { score: 10, basis: '主动保留较低的证据估计。' },
      }));
      assert.equal(lowered.answer.confidence.score, 10, 'a low candidate estimate must not be raised to the default');
      assert.equal(lowered.answer.confidence.level, 'low');
    }
    for (const [score, level] of [[0, 'low'], [59, 'low'], [60, 'medium'], [89, 'medium'], [90, 'high']]) {
      const question = metricQuestion(`confidence-threshold-${score}`);
      const evidence = await captured(question);
      const saved = await session.saveAnswer(question, metricAnswer(question, { status: 'verified', sources: [evidence.source], confidence: { score, basis: '边界分数检查。' } }));
      assert.equal(saved.answer.confidence.score, score);
      assert.equal(saved.answer.confidence.level, level);
    }
  });

  await test('置信度输入：拒绝非整数、越界与非有限数', async () => {
    for (const [index, score] of [-1, 101, 50.5, NaN, Infinity, -Infinity, '95', null].entries()) {
      const question = metricQuestion(`confidence-invalid-${index}`);
      await assert.rejects(async () => session.saveAnswer(question, metricAnswer(question, { confidence: { score, basis: '非法输入。' } })));
    }
  });

  await test('已观察的专业入口直达：答题首次只访问深链，第二题鲜读当前正文', async () => {
    const entryURL = url('127.0.0.6', '/advanced');
    const initialSnapshot = JSON.parse(fs.readFileSync(entry(preflight, 'advanced-entry').snapshot, 'utf8'));
    assert.ok(initialSnapshot.controls.some(control => control.href === entryURL), 'the professional URL must come from the real preflight page, not a constructed guess');
    const before = traffic.requests.length;
    const first = await session.page('advanced-entry', { entryUrl: entryURL, withObservation: true, compact: true, focus: ['专业检索'] });
    assert.equal(first.page.url(), entryURL);
    assert.ok(first.observation.text.includes('专业检索表达式'));
    const navigations = traffic.requests.slice(before);
    assert.deepEqual(navigations.map(request => request.path), ['/advanced'], 'first question should skip the already-checked homepage');
    const freshText = '第二题专业入口当前结果：检索表达式已经改变。';
    await first.page.locator('#professional').evaluate((main, text) => { main.append(document.createTextNode(text)); }, freshText);
    const beforeSecond = traffic.requests.length;
    const second = await session.page('advanced-entry', { entryUrl: entryURL, withObservation: true, compact: true, focus: ['第二题专业入口'] });
    assert.equal(second.page, first.page);
    assert.ok(second.observation.text.includes(freshText), 'deep-link reuse must read the current document for each question');
    assert.equal(traffic.requests.length, beforeSecond, 'reusing the professional entry should not navigate again');
    return { first_question_navigations: navigations.length, second_question_navigations: 0 };
  });

  await test('专业入口验证：拒绝未观察同域链接、跨域、凭据和非 HTTP 入口', async () => {
    const before = traffic.requests.length;
    const rejected = [
      url('127.0.0.6', '/unseen-professional'),
      url('127.0.0.2', '/help'),
      `http://user:password@127.0.0.6:${port}/advanced`,
      'file:///C:/Windows/System32/drivers/etc/hosts',
    ];
    for (const entryUrl of rejected) {
      await assert.rejects(() => session.page('advanced-entry', { entryUrl, withObservation: true }), `reject unobserved or invalid official entry ${entryUrl}`);
    }
    assert.equal(traffic.requests.length, before, 'invalid entry URLs must be rejected before any browser navigation');
  });

  await test('专业入口重定向复用：绑定真实最终页面，第二题不反复跳转', async () => {
    const entryURL = url('127.0.0.6', '/advanced-jump');
    const before = traffic.requests.length;
    const first = await session.page('advanced-entry', { entryUrl: entryURL, withObservation: true, compact: true });
    assert.equal(first.page.url(), url('127.0.0.6', '/advanced-panel'));
    assert.deepEqual(traffic.requests.slice(before).map(request => request.path), ['/advanced-jump', '/advanced-panel']);
    const freshText = '重定向入口第二题：当前专业检索面板。';
    await first.page.locator('#professional').evaluate((main, text) => { main.append(document.createTextNode(text)); }, freshText);
    const beforeSecond = traffic.requests.length;
    const second = await session.page('advanced-entry', { entryUrl: entryURL, withObservation: true, compact: true, focus: ['重定向入口第二题'] });
    assert.equal(second.page, first.page);
    assert.equal(traffic.requests.length, beforeSecond, 'the requested URL may differ from the final URL without triggering repeated redirects');
    assert.ok(second.observation.text.includes(freshText));
    assert.equal(await session.page('advanced-entry'), first.page, 'legacy page(sourceId) still returns the native current Page');
  });

  await test('独立持久配置：关闭后重新启动仍保留模拟机构授权', async () => {
    const resumedQuestion = metricQuestion('attempt-across-restart');
    await session.beginQuestion(resumedQuestion);
    const previousAttempt = session.activeQuestion.attempt;
    await session.close();
    const reopened = await createSession({ sessionId: 'direct-browser-fixture', outputDir: runDir, profileDir, catalog, headless: true, archive: true, screenshots: true, preflightSourceIds: catalog.sources.map(source => source.id), navigationTimeoutMs: 10000 });
    sessions.push(reopened);
    assert.equal((await reopened.preflight()).completed, true);
    const page = await reopened.page('login');
    assert.ok((await page.locator('body').innerText()).includes('校园机构授权成功'));
    assert.equal(await page.locator('input[type=password]').count(), 0);
    const saved = await reopened.saveAnswer(resumedQuestion, metricAnswer(resumedQuestion));
    assertNoQuestionTiming(saved, reopened);
    assert.equal(reopened.questionRecords.findLast(record => record.question_id === resumedQuestion.id).attempt, previousAttempt);
    const repeat = await reopened.saveAnswer(resumedQuestion, metricAnswer(resumedQuestion));
    assertNoQuestionTiming(repeat, reopened);
    assert.equal(reopened.questionRecords.findLast(record => record.question_id === resumedQuestion.id).attempt, previousAttempt);
  });

  await test('专业入口跨进程恢复：由已保存自检链接直接进入官方深链', async () => {
    const reopened = sessions.at(-1);
    assert.notEqual(reopened, session);
    const entryURL = url('127.0.0.6', '/advanced');
    const persisted = await reopened.preflight();
    const snapshot = JSON.parse(fs.readFileSync(entry(persisted, 'advanced-restart').snapshot, 'utf8'));
    assert.ok(snapshot.controls.some(control => control.href === entryURL), 'restart fixture must rely on an untouched preflight snapshot link');
    const before = traffic.requests.length;
    const restored = await reopened.page('advanced-restart', { entryUrl: entryURL, withObservation: true, compact: true, focus: ['专业检索'] });
    assert.equal(restored.page.url(), entryURL);
    assert.ok(restored.observation.text.includes('专业检索表达式'));
    assert.deepEqual(traffic.requests.slice(before).map(request => request.path), ['/advanced'], 'restoring the session must not require revisiting its homepage');
  });

  await test('可见 Chrome 生命周期：自检结束后可连续两题真实搜索', async () => {
    const headedDir = path.join(runDir, 'headed-lifecycle');
    const headed = await createSession({
      sessionId: 'headed-lifecycle', outputDir: headedDir, profileDir: path.join(headedDir, 'profile'),
      archive: true, screenshots: true, preflightSourceIds: ['headed-search'],
      catalog: [source('headed-search', '127.0.0.1', '/search-empty')], headless: false, navigationTimeoutMs: 10000,
    });
    sessions.push(headed);
    const checked = await headed.preflight();
    assert.equal(checked.completed, true);
    // This call must still work after the last preflight worker has finished.
    // A persistent visible browser context used to exit when its last tab closed.
    const firstPage = await headed.page('headed-search');
    const firstObservation = await headed.observe(firstPage, { name: 'headed-question-one' });
    assert.ok(firstObservation.controls.some(control => control.type === 'search'));
    await firstPage.getByRole('searchbox', { name: '检索词' }).fill('数据库功能');
    await Promise.all([
      firstPage.waitForURL(next => next.pathname === '/results' && next.searchParams.get('q') === '数据库功能'),
      firstPage.getByRole('button', { name: '搜索', exact: true }).click(),
    ]);
    assert.ok((await firstPage.locator('#results').innerText()).includes('1 条结果'));
    await headed.recordSearch('headed-search', { page: firstPage, query: '数据库功能', filters: {}, outcome: 'results' });

    const secondPage = await headed.page('headed-search');
    const secondObservation = await headed.observe(secondPage, { name: 'headed-question-two' });
    assert.ok(secondObservation.text.includes('检索完成'));
    await secondPage.getByRole('searchbox', { name: '检索词' }).fill('不存在的测试词');
    await Promise.all([
      secondPage.waitForURL(next => next.pathname === '/results' && next.searchParams.get('q') === '不存在的测试词'),
      secondPage.getByRole('button', { name: '搜索', exact: true }).click(),
    ]);
    assert.ok((await secondPage.locator('#results').innerText()).includes('0 条结果'));
    await headed.recordSearch('headed-search', { page: secondPage, query: '不存在的测试词', filters: {}, outcome: 'empty' });
    assert.equal(entry(await headed.preflight(), 'headed-search').search_status, 'empty');
    await headed.close();
    return { headless: false, completed_searches: 2 };
  });
  const startupIds = ['cnki', 'wanfang', 'vip', 'duxiu', 'chaoxing-huiya', 'nstl', 'cssci', 'cscd'];
  const startupCatalog = {
    profile: { startup_preflight_source_ids: startupIds },
    sources: [...startupIds, 'official-later', 'official-extra'].map(id => source(id, '127.0.0.7', `/startup-${id}`)),
  };
  const scopedDir = path.join(runDir, 'eight-startup');
  const scopedOptions = { sessionId: 'eight-startup', outputDir: scopedDir, profileDir: path.join(scopedDir, 'profile'), catalog: startupCatalog, headless: true, archive: true, screenshots: true, preflightSourceIds: startupIds, navigationTimeoutMs: 10000 };
  let scopedSession;

  await test('默认启动范围：全部来源保留，无固定预检且可直接开始答题', async () => {
    const directory = path.join(runDir, 'default-eight-check');
    const defaults = new SearchSession({ sessionId: 'default-eight-check', outputDir: directory });
    const baseCatalog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'ai-literacy-search', 'references', 'sources.json'), 'utf8'));
    assert.equal(baseCatalog.sources.length, 123, 'the original authoritative source catalog must retain all 123 entries');
    assert.equal(defaults.catalogTotal, 123, 'the base catalog count/hash remains separate from prepared site extensions');
    for (const source of baseCatalog.sources) assert.ok(defaults.sources.some(item => item.id === source.id), `the remaining authoritative source ${source.id} must stay available`);
    const preparedIndex = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'ai-literacy-search', 'references', 'search-index.json'), 'utf8'));
    assert.equal(defaults.sources.length, new Set([...baseCatalog.sources, ...preparedIndex.sources].map(source => source.id)).size, 'every prepared official site stays available without changing the base catalog');
    assert.deepEqual(defaults.report.initialization_source_ids, []);
    assert.equal(defaults.report.catalog_total, 123);
    assert.equal(defaults.maxPages, 5, 'the default prepared-site session allows five task tabs');
    assert.equal(defaults.report.max_pages, 5);
    assert.equal(defaults.report.max_parallel_sites, 5);
    assert.equal(defaults.report.completed, true);
    assert.equal(defaults.report.entries.length, 0);
    defaults.beginQuestion('without-preflight');
    assert.equal(defaults.activeQuestion.id, 'without-preflight');
    assert.equal(defaults.context, undefined);
    return { catalog_total: defaults.catalogTotal, registry_total: defaults.sources.length, startup_targets: [] };
  });

  await test('显式任选八个预检目标：十库目录只导航指定来源，按目标计算进度', async () => {
    const before = traffic.requests.length;
    scopedSession = await createSession(scopedOptions);
    sessions.push(scopedSession);
    const progress = [];
    const checked = await scopedSession.preflight({ onProgress: update => progress.push(update) });
    const navigations = traffic.requests.slice(before);
    assert.deepEqual(navigations.map(request => request.path).sort(), startupIds.map(id => `/startup-${id}`).sort());
    assert.equal(checked.entries.length, 8);
    assert.equal(checked.catalog_total, 10);
    assert.equal(checked.initialization_total, 8);
    assert.equal(checked.initialization_checked, 8);
    assert.deepEqual(checked.initialization_source_ids, startupIds);
    assert.equal(checked.completed, true, 'eight checks complete initialization despite a larger catalog');
    assert.equal(progress.length, 8);
    assert.ok(progress.every(update => update.total === 8));
    assert.deepEqual(progress.map(update => update.completed).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.ok(checked.entries.every(item => item.startup_target === true));
    assert.ok(checked.initialization_summary && typeof checked.initialization_summary === 'object');
    assert.equal(entry(checked, 'official-later'), undefined);
    assert.equal(entry(checked, 'official-extra'), undefined);
    scopedSession.beginQuestion('eight-startup-ready');
    assert.equal(scopedSession.activeQuestion.id, 'eight-startup-ready');
    const markdown = fs.readFileSync(path.join(scopedDir, 'preflight.md'), 'utf8');
    assert.match(markdown, /8/);
    assert.match(markdown, /10/);
    return { navigated_sources: navigations.length, progress_total: progress.at(-1).total, catalog_total: checked.catalog_total };
  });

  await test('其他权威库按题访问：第九库记录检查但不扩大启动范围', async () => {
    assert.ok(scopedSession, 'the scoped session must have been created');
    const before = traffic.requests.length;
    const { page, observation } = await scopedSession.page('official-later', { withObservation: true });
    assert.equal(page.url(), url('127.0.0.7', '/startup-official-later'));
    assert.ok(observation.text.includes('检索词'));
    const checked = await scopedSession.preflight();
    assert.deepEqual(traffic.requests.slice(before).map(request => request.path), ['/startup-official-later']);
    assert.equal(checked.entries.length, 9);
    assert.equal(checked.initialization_checked, 8);
    assert.equal(entry(checked, 'official-later').startup_target, false);
    assert.equal(checked.completed, true);
    assert.deepEqual(checked.initialization_source_ids, startupIds);
    assert.equal(entry(checked, 'official-extra'), undefined);
    const beforeRecheck = traffic.requests.length;
    await scopedSession.recheck('official-later');
    assert.equal(traffic.requests.length, beforeRecheck, 'rechecking the open source reads its current page');
    assert.equal((await scopedSession.preflight()).completed, true);
    scopedSession.beginQuestion('after-on-demand');
    assert.equal(scopedSession.activeQuestion.id, 'after-on-demand');
    await page.close();
  });

  await test('可选目标名单校验：接受空名单，拒绝重复、未知及错误类型', async () => {
    for (const [index, preflightSourceIds] of [['cnki', 'cnki'], ['unknown-database'], 'cnki', [null]].entries()) {
      const invalidDir = path.join(runDir, `invalid-startup-${index}`);
      assert.throws(() => new SearchSession({ ...scopedOptions, sessionId: `invalid-startup-${index}`, outputDir: invalidDir, profileDir: path.join(invalidDir, 'profile'), preflightSourceIds }));
    }
    const overrideDir = path.join(runDir, 'explicit-startup-override');
    const overridden = new SearchSession({ ...scopedOptions, sessionId: 'explicit-startup-override', outputDir: overrideDir, profileDir: path.join(overrideDir, 'profile'), preflightSourceIds: ['official-extra'] });
    assert.deepEqual(overridden.report.initialization_source_ids, ['official-extra'], 'explicit IDs override the profile defaults');
    assert.equal(overridden.report.catalog_total, 10);
    const emptyDir = path.join(runDir, 'empty-startup-override');
    const empty = new SearchSession({ ...scopedOptions, sessionId: 'empty-startup-override', outputDir: emptyDir, profileDir: path.join(emptyDir, 'profile'), preflightSourceIds: [] });
    assert.deepEqual(empty.preflightSourceIds, []); assert.equal(empty.report.completed, true);
  });

  await test('目录外官方来源：仅当前真实页面注册并支持已核验证据', async () => {
    assert.equal(typeof scopedSession.addSource, 'function');
    const page = await scopedSession.context.newPage();
    await page.goto(url('127.0.0.8', '/help'));
    await scopedSession.observe(page, { name: 'official-publisher-observed' });
    const publisher = source('official-publisher', '127.0.0.8', '/help');
    await scopedSession.addSource(publisher, { page });
    assert.equal(scopedSession.source(publisher.id).url, publisher.url);
    const question = metricQuestion('registered-publisher-evidence');
    await scopedSession.beginQuestion(question);
    const evidence = await scopedSession.captureEvidence(page, {
      questionId: question.id, name: publisher.name, query: '全文获取', field: '官方帮助正文',
      locator: '#facts', target: page.locator('#facts'), evidence: factExcerpts[2],
    });
    const saved = await scopedSession.saveAnswer(question, metricAnswer(question, { status: 'verified', sources: [evidence.source], explanation: '已从实际读取的官方发布方正文核验：部分文献因授权或版权限制，无法直接取得全文。' }));
    assert.equal(saved.answer.status, 'verified', 'a registered primary publisher must not be downgraded merely for being outside the bundled catalog');
    assert.equal(saved.answer.confidence.level, 'high');
    assertNoQuestionTiming(saved, scopedSession);
    assert.ok(fs.existsSync(path.join(scopedDir, 'additional-sources.json')));
    const checked = await scopedSession.preflight();
    assert.equal(checked.completed, true);
    assert.deepEqual(checked.initialization_source_ids, startupIds);
    assert.equal(checked.catalog_total, 10, 'catalog_total describes the original bundled catalog');
    await page.close();
    return { answer_status: saved.answer.status, registered_id: publisher.id };
  });

  await test('官方来源身份约束：拒绝未观察、不同页、旧观察、错误域及访问障碍', async () => {
    const page = await scopedSession.context.newPage();
    try {
      await page.goto(url('127.0.0.9', '/help'));
      await assert.rejects(async () => scopedSession.addSource(source('unobserved-publisher', '127.0.0.9', '/help'), { page }), 'navigation alone is not an actual observed page');
      await scopedSession.observe(page, { name: 'publisher-before-negative-checks' });
      await assert.rejects(async () => scopedSession.addSource({ ...source('wrong-domain-publisher', '127.0.0.9', '/help'), domains: ['authority.invalid'] }, { page }));
      await assert.rejects(async () => scopedSession.addSource(source('wrong-url-publisher', '127.0.0.9', '/another-help'), { page }));
      const otherPage = await scopedSession.context.newPage();
      try {
        await otherPage.goto(url('127.0.0.9', '/help'));
        await assert.rejects(async () => scopedSession.addSource(source('different-page-publisher', '127.0.0.9', '/help'), { page: otherPage }), 'observing one Page cannot authorize a different Page at the same URL');
      } finally { await otherPage.close(); }
      await page.goto(url('127.0.0.9', '/help'));
      await assert.rejects(async () => scopedSession.addSource(source('stale-observation-publisher', '127.0.0.9', '/help'), { page }), 'even reloading the same URL invalidates the prior document observation');
      for (const [id, pathname] of [['publisher-challenge', '/challenge'], ['publisher-login', '/private'], ['publisher-error', '/http-error']]) {
        await page.goto(url('127.0.0.9', pathname));
        await scopedSession.observe(page, { name: id });
        await assert.rejects(async () => scopedSession.addSource(source(id, '127.0.0.9', pathname), { page }), 'a login, challenge or HTTP error is not a verified publisher page');
      }
    } finally { await page.close(); }
    assert.equal((await scopedSession.preflight()).completed, true);
  });

  await test('补充来源域名边界：拒绝父域、公共后缀及未观察子域名', async () => {
    const before = traffic.requests.length;
    const metadata = { id: 'domain-boundary-check', name: '官方帮助域名边界测试', url: 'https://docs.example.com.cn/help' };
    const exact = scopedSession.validateAdditionalSource(metadata);
    assert.deepEqual(exact.domains, ['docs.example.com.cn'], 'omitted domains derive only the current observed host');
    assert.deepEqual(scopedSession.validateAdditionalSource({ ...metadata, domains: ['docs.example.com.cn'] }).domains, exact.domains);
    for (const domains of [['com.cn'], ['example.com.cn'], ['sub.docs.example.com.cn'], ['docs.example.com.cn', 'other.example.com.cn']]) {
      assert.throws(() => scopedSession.validateAdditionalSource({ ...metadata, domains }), /domain.*equal|hostname/i, `the observation does not authorize ${domains.join(', ')}`);
    }
    assert.equal(traffic.requests.length, before, 'domain-boundary validation must not navigate to external hosts');
    assert.throws(() => scopedSession.source(metadata.id), /Unknown source/, 'metadata validation alone does not register a publisher');
  });

  await test('复用已绑定页面注册新来源：原来源下次必须重新导航到自身入口', async () => {
    const originalURL = url('127.0.0.7', '/startup-cnki');
    const originalPage = await scopedSession.page('cnki');
    assert.equal(originalPage.url(), originalURL);
    await originalPage.goto(url('127.0.0.8', '/help'));
    await scopedSession.observe(originalPage, { name: 'original-tab-new-official-publisher' });
    const publisher = source('official-moved-publisher', '127.0.0.8', '/help');
    await scopedSession.addSource(publisher, { page: originalPage });
    assert.equal(scopedSession.pages.has('cnki'), false, 'the reassigned Page must no longer be returned through the old source ID');
    assert.equal(await scopedSession.page(publisher.id), originalPage, 'the new publisher reuses the actual observed Page');
    const before = traffic.requests.length;
    const restored = await scopedSession.page('cnki', { withObservation: true });
    assert.equal(restored.page.url(), originalURL);
    assert.ok(restored.observation.text.includes('测试权威数据库 startup-cnki'));
    assert.deepEqual(traffic.requests.slice(before).map(request => request.path), ['/startup-cnki']);
    assert.notEqual(restored.page, originalPage, 'reading the original source must preserve the newly registered publisher page');
    assert.equal(originalPage.url(), publisher.url);
    assert.equal((await scopedSession.preflight()).completed, true);
    await restored.page.close();
    await originalPage.close();
  });

  await test('恢复会话：八库报告与补充官方来源保留，初始化零重复导航', async () => {
    await scopedSession.close();
    const before = traffic.requests.length;
    const reopened = await createSession(scopedOptions);
    sessions.push(reopened);
    scopedSession = reopened;
    assert.equal(reopened.source('official-publisher').url, url('127.0.0.8', '/help'));
    assert.equal((await reopened.preflight()).completed, true);
    assert.equal(traffic.requests.length, before, 'session restoration must reuse the completed eight-source initialization');
    assert.deepEqual(reopened.report.initialization_source_ids, startupIds);
    assert.equal(reopened.report.catalog_total, 10);
    const restored = await reopened.page('official-publisher', { withObservation: true });
    assert.ok(restored.observation.text.includes(factExcerpts[2]));
    assert.equal(entry(reopened.report, 'official-publisher').startup_target, false);
    assert.equal((await reopened.preflight()).completed, true);
    await restored.page.close();
  });

  await test('更换八库名单：保留旧证据，但条目总数不能冒充新目标已全部检查', async () => {
    await scopedSession.close();
    const changedIds = [...startupIds.slice(0, 7), 'official-extra'];
    const changed = new SearchSession({ ...scopedOptions, preflightSourceIds: changedIds });
    sessions.push(changed);
    assert.ok(changed.report.entries.length >= 8, 'existing genuine observations must survive a startup-list change');
    assert.equal(changed.report.completed, false, 'the unvisited new target remains pending even with more than eight saved entries');
    assert.equal(changed.report.initialization_checked, 7);
    assert.equal(changed.report.initialization_total, 8);
    assert.equal(entry(changed.report, 'cscd').startup_target, false);
    changed.beginQuestion('changed-startup-not-ready');
    assert.equal(changed.activeQuestion.id, 'changed-startup-not-ready', 'optional diagnostics cannot gate answer work');
    await changed.start();
    const before = traffic.requests.length;
    const progress = [];
    const checked = await changed.preflight({ onProgress: update => progress.push(update) });
    assert.deepEqual(traffic.requests.slice(before).map(request => request.path), ['/startup-official-extra']);
    assert.equal(checked.completed, true);
    assert.deepEqual(checked.initialization_source_ids, changedIds);
    assert.equal(entry(checked, 'official-extra').startup_target, true);
    assert.equal(progress.length, 1);
    assert.equal(progress[0].completed, 8);
    assert.equal(progress[0].total, 8);
    changed.beginQuestion('changed-startup-ready');
    assert.equal(changed.activeQuestion.id, 'changed-startup-ready');
    await changed.close();
  });

  report.fixture_traffic = { total_documents: traffic.total, maximum_concurrent_documents: traffic.peak };
}

(async () => {
  try {
    await main();
  } catch (error) {
    results.push({ name: '测试运行器与依赖初始化', passed: false, error: error.stack || String(error) });
    process.stderr.write(`${error.stack || error}\n`);
  } finally {
    for (const session of sessions.reverse()) {
      try { await session.close(); } catch (error) { report.cleanup_errors ||= []; report.cleanup_errors.push(String(error)); }
    }
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    report.finished_at = new Date().toISOString();
    report.passed = results.filter(result => result.passed).length;
    report.failed = results.filter(result => !result.passed).length;
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
    process.stdout.write(`Results: ${report.passed} passed, ${report.failed} failed. ${reportPath}\n`);
    process.exitCode = report.failed ? 1 : 0;
  }
})();
