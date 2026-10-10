#!/usr/bin/env node
'use strict';

// Behavioral checks with direct Playwright and real Google Chrome. Public
// websites are not queried; fixtures verify the evidence workflow itself.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { once } = require('node:events');
const { SearchSession, createSession } = require('../ai-literacy-search/scripts/browser.cjs');

const runDir = fs.mkdtempSync(path.join(__dirname, 'v27-lean-run-'));
const report = { started_at: new Date().toISOString(), kind: 'real visible Google Chrome; controlled local HTTP fixtures; no public database queries', run_dir: runDir, tests: [] };
const requests = [], sessions = [];
let baseURL, server, sequence = 0;
const stamp = () => new Date().toISOString();
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const html = (title, body) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escape(title)}</title></head><body><h1>${escape(title)}</h1>${body}</body></html>`;

async function test(name, fn) {
  try { const detail = await fn(); report.tests.push({ name, passed: true, ...(detail ? { detail } : {}) }); process.stdout.write(`PASS ${name}\n`); }
  catch (error) { report.tests.push({ name, passed: false, error: error.stack || String(error) }); process.stdout.write(`FAIL ${name}: ${error.message}\n`); }
}

function files(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(item => item.name === 'profile' ? [] : item.isDirectory() ? files(path.join(directory, item.name)) : [path.join(directory, item.name)]);
}

function noEvidenceFiles(session) {
  const remaining = files(session.outputDir);
  assert.deepEqual(remaining, [], 'memory mode must not write evidence, observations, answers, question attempts or events');
}

function source(id = 'help', endpoint = '/help') {
  return { id, name: `官方${id}本地测试`, url: `${baseURL}${endpoint}`, domains: ['127.0.0.1'], kind: 'official_database' };
}

function options(id, extra = {}) {
  const outputDir = path.join(runDir, id);
  return { sessionId: id, outputDir, profileDir: path.join(outputDir, 'profile'), catalog: { sources: [source(), source('other', '/other'), source('db', '/entry')] }, recipeIndex: { sources: [] }, recipes: [], navigationTimeoutMs: 5000, ...extra };
}

async function session(extra = {}) {
  const created = await createSession(options(`lean-${++sequence}`, extra)); sessions.push(created);
  created.screenshotCalls = 0;
  const instrument = page => { const screenshot = page.screenshot.bind(page); page.screenshot = (...args) => { created.screenshotCalls++; return screenshot(...args); }; };
  created.context.pages().forEach(instrument); created.context.on('page', instrument);
  return created;
}

function ruleQuestion(id = `question-${++sequence}`, optionsValue = { A: '交集', B: '并集' }) {
  return { id, type: 'single', question: '一般布尔逻辑检索中，AND运算取两个检索集合的什么部分？', options: optionsValue };
}

function answer(question, labels, sources) {
  return { id: question.id, question: question.question, type: question.type, status: 'verified', answer_labels: labels,
    answer: labels.map(label => question.options[label]), explanation: 'AND取两个集合的交集，实际官方帮助正文支持本题选项。',
    option_evaluations: Object.entries(question.options).map(([label, text]) => ({ label, text, verdict: labels.includes(label) ? 'supported' : 'refuted', reason: '依据当前题干与实际原始正文判断。' })), sources, needs_review: [], searched_at: stamp() };
}

async function capture(created, question = ruleQuestion()) {
  created.beginQuestion(question);
  const page = await created.page('help');
  const evidence = await created.captureEvidence(page, { questionId: question.id, name: created.source('help').name, query: 'AND集合关系', field: '通用布尔规则', locator: '#fact', target: page.locator('#fact'), evidence: 'AND用于取得两个检索集合的交集。' });
  return { question, page, ...evidence };
}

function recipe() {
  return { id: 'db:record-lookup', source_id: 'db', status: 'query_verified', entry_url: `${baseURL}/entry`,
    transitions: { results: { mode: 'same-page', container: { css: '#results' }, ready: { css: '#results[data-complete="true"]' }, match: { css: '#condition-echo', match: 'contains' }, empty: { css: '#empty' }, timeoutMs: 1400 } },
    execution: { version: 1, queryMode: 'literal', resetEntry: true, parameters: { query: { type: 'string', required: true } },
      prepare: [{ action: 'fill', locator: { role: 'searchbox', name: '题名', exact: true }, parameter: 'query' }],
      submit: { action: 'click', locator: { role: 'button', name: '检索', exact: true } }, echoParameters: ['query'] } };
}

async function run(created, query, id = `runner-question-${++sequence}`) {
  const q = { id, type: 'single', question: `查询题名“${query}”，以下哪一条记录实际存在？`, options: { A: 'NEW-2026', B: 'OLD-1999' } };
  return { question: q, result: await created.runSearch(q, { recipeId: 'db:record-lookup', parameters: { query }, parameterQuotes: { query } }) };
}

async function main() {
  await test('题内计算：无需预检、Chrome或网络，证明与答案仅在内存', async () => {
    const created = new SearchSession(options(`local-${++sequence}`)); sessions.push(created);
    const q = { id: 'numeric-no-external', type: 'single', question: '实际相关文献总数为180篇，检索得到90篇，其中相关文献为72篇。查准率是多少？', options: { A: '40%', B: '80%' } };
    const networkCalls = [], originals = { httpRequest: http.request, httpGet: http.get, httpsRequest: https.request, httpsGet: https.get, fetch: globalThis.fetch };
    const forbidden = name => () => { networkCalls.push(name); throw new Error(`unexpected ${name}`); };
    http.request = forbidden('http.request'); http.get = forbidden('http.get'); https.request = forbidden('https.request'); https.get = forbidden('https.get'); globalThis.fetch = forbidden('fetch');
    let computed, saved;
    try {
      created.beginQuestion(q);
      computed = created.calculate(q, { operation: 'retrieval-metrics', inputs: { relevantTotal: 180, retrieved: 90, relevantRetrieved: 72 }, inputQuotes: { relevantTotal: '实际相关文献总数为180篇', retrieved: '检索得到90篇', relevantRetrieved: '其中相关文献为72篇' } });
      saved = created.saveAnswer(q, answer(q, ['B'], [computed.source]));
    } finally { http.request = originals.httpRequest; http.get = originals.httpGet; https.request = originals.httpsRequest; https.get = originals.httpsGet; globalThis.fetch = originals.fetch; }
    assert.equal(computed.proof.results.precisionPercent, 80); assert.equal(saved.answer.status, 'verified'); assert.equal(created.context, undefined); assert.deepEqual(networkCalls, []); assert.equal(saved.jsonPath, null); assert.equal(saved.markdownPath, null); assert.equal(Object.hasOwn(saved.answer, 'timing'), false); noEvidenceFiles(created);
    return { network_calls: 0, browser_started: false, evidence_files: 0 };
  });

  await test('可见Chrome默认启动：零预检访问，历史profile八库配置也不触发导航', async () => {
    const catalog = { profile: { startup_preflight_source_ids: ['help', 'other', 'db'] }, sources: [source(), source('other', '/other'), source('db', '/entry')] };
    const before = requests.length, created = await session({ catalog });
    assert.equal(created.options.headless, false); assert.deepEqual(created.preflightSourceIds, []); assert.equal(requests.length, before); assert.equal(created.report.entries.length, 0); assert.equal(created.report.completed, true);
    const userAgent = await created.context.pages()[0].evaluate(() => navigator.userAgent); assert.match(userAgent, /Chrome\//); assert.doesNotMatch(userAgent, /HeadlessChrome|Edg\//);
    created.beginQuestion(ruleQuestion()); noEvidenceFiles(created); await created.close(); return { requested_documents: 0, headless: false, user_agent: userAgent };
  });

  await test('preflight空名单：不打开来源，不写报告，不挡答题', async () => {
    const created = new SearchSession(options(`empty-${++sequence}`)); sessions.push(created); const before = requests.length;
    const checked = await created.preflight({ sourceIds: [] }); assert.equal(requests.length, before); assert.equal(created.context, undefined); assert.deepEqual(checked.initialization_source_ids, []); assert.equal(checked.completed, true); created.beginQuestion(ruleQuestion()); noEvidenceFiles(created);
  });

  await test('实际网页文本：内存证据可verified，无PNG或JSON落盘', async () => {
    const created = await session(), captured = await capture(created), saved = created.saveAnswer(captured.question, answer(captured.question, ['A'], [captured.source]));
    assert.equal(saved.answer.status, 'verified'); assert.equal(captured.artifact.storage, 'memory'); assert.ok(captured.artifact.snapshot == null); assert.ok(captured.artifact.screenshot == null); assert.equal(created.screenshotCalls, 0); assert.match(captured.source.url, /\/help$/); assert.equal(saved.jsonPath, null); noEvidenceFiles(created); await created.close();
  });

  await test('同一官方规则新题换序：复用真实内存来源，零新增导航或截图', async () => {
    const created = await session(), captured = await capture(created); assert.equal(created.saveAnswer(captured.question, answer(captured.question, ['A'], [captured.source])).answer.status, 'verified');
    const before = requests.length, shotBefore = created.screenshotCalls, next = ruleQuestion('new-order', { A: '并集', B: '交集' }); created.beginQuestion(next);
    const found = created.findEvidence({ text: 'AND', url: '/help' }); assert.equal(found.length, 1);
    const reused = created.reuseEvidence(next, { source: found[0].source, freshness: 'stable', scope: '同一通用AND集合关系；来源明确覆盖交集，本次只更换选项顺序。' });
    const saved = created.saveAnswer(next, answer(next, ['B'], [reused.source])); assert.equal(saved.answer.status, 'verified'); assert.deepEqual(saved.answer.answer, ['交集']); assert.equal(requests.length, before); assert.equal(created.screenshotCalls, shotBefore); noEvidenceFiles(created); await created.close(); return { added_navigation: 0, added_screenshot: 0 };
  });

  await test('伪造内存record：复制来源和artifact不能冒充已登记receipt', async () => {
    const created = await session(), captured = await capture(created), real = created.evidence.findLast(item => item.question_id === captured.question.id);
    const fake = structuredClone(real); created.evidence.push(fake);
    const saved = created.saveAnswer(captured.question, answer(captured.question, ['A'], [captured.source])); assert.equal(saved.answer.status, 'partial'); assert.ok(saved.answer.needs_review.length); noEvidenceFiles(created); await created.close();
  });

  await test('已登记内存证据篡改：新摘录不能借真实receipt通过', async () => {
    const created = await session(), captured = await capture(created), record = created.evidence.findLast(item => item.question_id === captured.question.id);
    record.source.evidence = 'AND取并集。';
    const saved = created.saveAnswer(captured.question, answer(captured.question, ['B'], [structuredClone(record.source)])); assert.equal(saved.answer.status, 'partial'); assert.ok(saved.answer.needs_review.length); await created.close();
  });

  await test('同题新attempt：未经显式复用的旧网页证据不能verified', async () => {
    const created = await session(), captured = await capture(created); assert.equal(created.saveAnswer(captured.question, answer(captured.question, ['A'], [captured.source])).answer.status, 'verified');
    created.beginQuestion(captured.question); assert.equal(created.activeQuestion.attempt, 2);
    const saved = created.saveAnswer(captured.question, answer(captured.question, ['A'], [captured.source])); assert.equal(saved.answer.status, 'partial'); await created.close();
  });

  await test('跨题未显式复用：旧网页来源不能直接用于本题verified', async () => {
    const created = await session(), captured = await capture(created), next = ruleQuestion('unrebound-web-proof'); created.beginQuestion(next);
    const saved = created.saveAnswer(next, answer(next, ['A'], [captured.source])); assert.equal(saved.answer.status, 'partial'); await created.close();
  });

  await test('默认runner：一调用完成当前查询与文本证据，没有前置目录访问或截图', async () => {
    const before = requests.length, created = await session({ recipes: [recipe()] }), query = `新的检索实体${++sequence}`, { question, result } = await run(created, query);
    assert.equal(result.status, 'ready'); assert.equal(result.outcome, 'results'); assert.ok(result.sources.length); assert.equal(created.saveAnswer(question, answer(question, ['A'], result.sources)).answer.status, 'verified');
    assert.deepEqual(requests.slice(before).map(item => item.path), ['/entry', '/results']); assert.equal(created.screenshotCalls, 0); noEvidenceFiles(created); await created.close(); return { workflow_calls: 1, document_paths: ['/entry', '/results'], screenshots: 0 };
  });

  await test('可选preflight指定一站：其余库不访问，不写强制归档', async () => {
    const created = await session(), before = requests.length, checked = await created.preflight({ sourceIds: ['other'] });
    assert.deepEqual(requests.slice(before).map(item => item.path), ['/other']); assert.deepEqual(checked.initialization_source_ids, ['other']); assert.equal(checked.entries.length, 1); assert.equal(checked.completed, true); created.beginQuestion(ruleQuestion()); noEvidenceFiles(created); await created.close();
  });

  await test('正常零结果：有真实完成标志与条件回显，仍与错误区分', async () => {
    const created = await session({ recipes: [recipe()] }), { result } = await run(created, '不存在的文献');
    assert.equal(result.status, 'ready'); assert.equal(result.outcome, 'empty'); assert.equal(await result.container.locator('.record').count(), 0); assert.equal(created.screenshotCalls, 0); noEvidenceFiles(created); await created.close();
  });

  await test('服务失败：不把503错误页当作零结果', async () => {
    const created = await session({ recipes: [recipe()] }), { result } = await run(created, '服务失败');
    assert.notEqual(result.status, 'ready'); assert.notEqual(result.outcome, 'empty'); assert.equal(result.sources.length, 0); noEvidenceFiles(created); await created.close();
  });

  await test('可选archive文本模式：保存正文和答案，不要求截图才能verified', async () => {
    const created = await session({ archive: true }), captured = await capture(created), saved = created.saveAnswer(captured.question, answer(captured.question, ['A'], [captured.source]));
    assert.equal(saved.answer.status, 'verified'); assert.ok(fs.existsSync(captured.artifact.snapshot)); assert.ok(fs.existsSync(captured.artifact.target_text)); assert.ok(fs.existsSync(saved.jsonPath)); assert.ok(fs.existsSync(saved.markdownPath)); assert.equal(captured.artifact.screenshot, null); assert.equal(created.screenshotCalls, 0); assert.equal(files(created.outputDir).filter(file => file.endsWith('.png')).length, 0); await created.close();
  });

  await test('可选archive+screenshots：旧完整归档模式仍可保存真实PNG', async () => {
    const created = await session({ archive: true, screenshots: true }), captured = await capture(created), saved = created.saveAnswer(captured.question, answer(captured.question, ['A'], [captured.source]));
    assert.equal(saved.answer.status, 'verified'); assert.ok(fs.existsSync(captured.artifact.screenshot)); assert.equal(created.screenshotCalls, 1); assert.ok(files(created.outputDir).some(file => file.endsWith('.png'))); await created.close();
  });

  await test('screenshots需显式archive：禁止仅截图选项产生隐式落盘', async () => { assert.throws(() => new SearchSession(options('invalid-png', { screenshots: true })), /archive/i); });
}

(async () => {
  try {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
      requests.push({ path: url.pathname, query: url.search, at: stamp() });
      let body, status = 200;
      if (url.pathname === '/help' || url.pathname === '/other') body = html('数据库官方帮助', '<main><p id="fact">AND用于取得两个检索集合的交集。</p><p>OR用于并集，NOT用于排除指定集合。</p></main>');
      else if (url.pathname === '/entry') body = html('数据库检索', '<form action="/results"><label for="query">题名</label><input type="search" id="query" name="query"><button type="submit">检索</button></form>');
      else if (url.pathname === '/results') {
        const query = url.searchParams.get('query') || '', empty = query === '不存在的文献';
        if (query === '服务失败') { status = 503; body = html('503 Service Unavailable', '<p>检索服务暂时不可用。</p>'); }
        else body = html('数据库检索结果', `<div id="condition-echo">${escape(query)}</div><main id="results" data-complete="true">${empty ? '<p id="empty">没有符合条件的文献。找到0条结果。</p>' : `<article class="record">题名${escape(query)}；记录ID NEW-2026；年份2026。</article>`}</main>`);
      } else { status = 404; body = html('404', '<p>不存在的页面。</p>'); }
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(body);
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); baseURL = `http://127.0.0.1:${server.address().port}`;
    await main();
  } catch (error) { report.tests.push({ name: 'v2.7初始化', passed: false, error: error.stack || String(error) }); process.stderr.write(`${error.stack || error}\n`); }
  finally {
    for (const created of sessions.reverse()) { try { await created.close(); } catch (error) { report.cleanup_errors ||= []; report.cleanup_errors.push(String(error)); } }
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    report.finished_at = stamp(); report.passed = report.tests.filter(item => item.passed).length; report.failed = report.tests.filter(item => !item.passed).length;
    const file = path.join(__dirname, 'v27-tests.json'); fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n', 'utf8'); process.stdout.write(`Results: ${report.passed} passed, ${report.failed} failed. ${file}\n`); process.exitCode = report.failed ? 1 : 0;
  }
})();
