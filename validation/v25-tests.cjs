#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { once } = require('node:events');
const { SearchSession, createSession } = require('../ai-literacy-search/scripts/browser.cjs');

const runDir = fs.mkdtempSync(path.join(__dirname, 'v25-proof-run-'));
const report = {
  started_at: new Date().toISOString(), run_dir: runDir,
  local_test_setup: 'Construct SearchSession without Chrome; only the startup-complete state is mocked. This is not a live website preflight. Block HTTP, HTTPS and fetch during every local proof test.',
  web_test_setup: 'Separate real Google Chrome + direct Playwright against local HTTP fixtures; no public database queries.',
  tests: [],
};
const sessions = [];
let sequence = 0, server;
const stamp = () => new Date().toISOString();

async function test(name, fn) {
  const started = Date.now();
  try { const detail = await fn(); report.tests.push({ name, passed: true, elapsed_ms: Date.now() - started, ...(detail ? { detail } : {}) }); process.stdout.write(`PASS ${name}\n`); }
  catch (error) { report.tests.push({ name, passed: false, elapsed_ms: Date.now() - started, error: error.stack || String(error) }); process.stdout.write(`FAIL ${name}: ${error.message}\n`); }
}

function localSession(existing) {
  const id = existing?.sessionId || `local-proof-${++sequence}`;
  const outputDir = existing?.outputDir || path.join(runDir, id);
  const options = { sessionId: id, outputDir, profileDir: path.join(outputDir, 'profile'), maxPages: 5, archive: true, screenshots: true };
  const session = new SearchSession(options); sessions.push(session);
  if (!existing) {
    session.report.entries = session.preflightSources.map(source => ({ source_id: source.id, name: source.name, availability: 'reachable', identity: 'matched', authorization: 'not_observed', search_ready: true, search_status: 'untested', checked_at: stamp(), requested_url: source.url, final_url: source.url, snapshot: null, test_fixture: 'mock only; no website opened' }));
    session.persistReport();
  }
  assert.equal(session.report.completed, true); assert.equal(session.context, undefined);
  return session;
}

function answer(question, labels, sources, overrides = {}) {
  return {
    id: question.id, question: question.question, type: question.type || 'single', status: 'verified',
    answer_labels: labels, answer: labels.length ? labels.map(label => question.options[label]) : ['正确'],
    explanation: '依据本题原文、已核验规则或实际来源完成核验。',
    option_evaluations: Object.entries(question.options || {}).map(([label, text]) => ({ label, text, verdict: labels.includes(label) ? 'supported' : 'refuted', reason: labels.includes(label) ? '本题实际计算或证据支持本项。' : '本题实际计算或证据排除本项。' })),
    sources, needs_review: [], searched_at: stamp(), ...overrides,
  };
}

function assertNoTiming(saved, session) {
  assert.equal(Object.hasOwn(saved.answer, 'timing'), false);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(saved.jsonPath, 'utf8')), 'timing'), false);
  assert.doesNotMatch(fs.readFileSync(saved.markdownPath, 'utf8'), /本题用时|elapsed_seconds/);
  assert.equal(fs.existsSync(path.join(session.outputDir, 'question-timers.json')), false);
}

function metricsQuestion(id, metric = 'precision', values = { total: 180, retrieved: 90, relevant: 72 }, options) {
  const { total, retrieved, relevant } = values;
  return { id, type: 'single', question: `实际相关文献总数为${total}篇，检索得到${retrieved}篇，其中相关文献为${relevant}篇。该检索的${metric === 'recall' ? '查全率' : '查准率'}是多少？`, options: options || { A: '20%', B: '60%', C: '80%', D: '40%' } };
}

function metricsInput(values = { total: 180, retrieved: 90, relevant: 72 }) {
  return { operation: 'retrieval-metrics', inputs: { relevantTotal: values.total, retrieved: values.retrieved, relevantRetrieved: values.relevant }, inputQuotes: { relevantTotal: `实际相关文献总数为${values.total}篇`, retrieved: `检索得到${values.retrieved}篇`, relevantRetrieved: `其中相关文献为${values.relevant}篇` } };
}

function assertLocalProof(captured, questionId) {
  assert.ok(captured && captured.source && captured.proof && captured.artifact);
  assert.ok(captured.artifact.proof && fs.existsSync(captured.artifact.proof), 'the local deterministic proof must be persisted');
  assert.ok(['https:', 'http:'].includes(new URL(captured.source.url).protocol), 'the answer schema retains its official source URL');
  for (const key of ['name', 'url', 'query', 'field', 'evidence', 'locator', 'retrieved_at']) assert.ok(typeof captured.source[key] === 'string' && captured.source[key].trim());
  assert.ok(JSON.stringify(captured.proof).includes(questionId), 'the calculation must be bound to the actual question');
  assert.ok(!captured.artifact.screenshot, 'a pure calculation must not fake a browser screenshot');
}

async function localTests() {
  const networkCalls = [];
  const originals = { httpRequest: http.request, httpGet: http.get, httpsRequest: https.request, httpsGet: https.get, fetch: globalThis.fetch };
  const forbidden = name => (...args) => { networkCalls.push({ method: name, at: stamp() }); throw new Error(`Local proof test must not call ${name}.`); };
  http.request = forbidden('http.request'); http.get = forbidden('http.get'); https.request = forbidden('https.request'); https.get = forbidden('https.get'); globalThis.fetch = forbidden('fetch');
  try {
    await test('纯计算不启动Chrome：本题查准率/查全率来自真实题干数值', async () => {
      const session = localSession(); const question = metricsQuestion('precision-basic'); session.beginQuestion(question);
      const captured = await session.calculate(question, metricsInput()); assertLocalProof(captured, question.id);
      assert.equal(captured.proof.results.precision, 0.8); assert.equal(captured.proof.results.recall, 0.4); assert.equal(captured.proof.results.precisionPercent, 80); assert.equal(captured.proof.results.recallPercent, 40);
      const saved = session.saveAnswer(question, answer(question, ['C'], [captured.source])); assert.equal(saved.answer.status, 'verified'); assert.equal(saved.answer.answer[0], '80%'); assertNoTiming(saved, session); assert.equal(session.context, undefined);
    });

    await test('新数字与查全率：不沿用例题的数字或指标', async () => {
      const session = localSession(); const values = { total: 195, retrieved: 156, relevant: 117 }; const question = metricsQuestion('new-recall-values', 'recall', values, { A: '75%', B: '60%', C: '40%', D: '80%' }); session.beginQuestion(question);
      const captured = await session.calculate(question, metricsInput(values)); assert.equal(captured.proof.results.precisionPercent, 75); assert.equal(captured.proof.results.recallPercent, 60);
      const saved = session.saveAnswer(question, answer(question, ['B'], [captured.source])); assert.equal(saved.answer.status, 'verified'); assert.equal(saved.answer.answer[0], '60%');
    });

    await test('比例计算：小数百分比保持真实计算与当前选项映射', async () => {
      const session = localSession(); const question = { id: 'ratio-new-values', type: 'single', question: '参与任务共40人，完成任务17人。完成比例是多少（以百分比表示）？', options: { A: '25%', B: '42.5%', C: '57.5%', D: '75%' } }; session.beginQuestion(question);
      const captured = await session.calculate(question, { operation: 'ratio-percent', inputs: { part: 17, whole: 40 }, inputQuotes: { part: '完成任务17人', whole: '参与任务共40人' } }); assertLocalProof(captured, question.id); assert.equal(captured.proof.results.ratio, 0.425); assert.equal(captured.proof.results.percent, 42.5);
      const saved = session.saveAnswer(question, answer(question, ['B'], [captured.source])); assert.equal(saved.answer.status, 'verified'); assert.equal(saved.answer.answer[0], '42.5%');
    });

    await test('选项换序：同一计算必须使用本次字母与文字', async () => {
      const session = localSession(); const question = metricsQuestion('numeric-reordered', 'precision', undefined, { A: '80%', B: '40%', C: '20%', D: '60%' }); session.beginQuestion(question);
      const captured = await session.calculate(question, metricsInput()); const saved = session.saveAnswer(question, answer(question, ['A'], [captured.source])); assert.equal(saved.answer.status, 'verified'); assert.deepEqual(saved.answer.answer_labels, ['A']); assert.deepEqual(saved.answer.answer, ['80%']);
    });

    await test('错误答案不能用真实计算取证蒙混verified', async () => {
      const session = localSession(); const question = metricsQuestion('wrong-numeric-answer'); session.beginQuestion(question); const captured = await session.calculate(question, metricsInput());
      const saved = session.saveAnswer(question, answer(question, ['B'], [captured.source])); assert.equal(saved.answer.status, 'partial'); assert.ok(saved.answer.needs_review.length > 0); assert.ok(saved.answer.confidence.score < 90);
      const ambiguous = metricsQuestion('negative-wording-is-not-number', 'precision', undefined, { A: '不是80%', B: '80%', C: '60%', D: '40%' }); session.beginQuestion(ambiguous); const actual = await session.calculate(ambiguous, metricsInput());
      assert.equal(session.saveAnswer(ambiguous, answer(ambiguous, ['B'], [actual.source])).answer.status, 'partial', 'a numeric substring in a negated prose option is not a verified numeric choice');
    });

    await test('计算否定题：按题干反选错误值，不能把正确值当所选答案', async () => {
      const session = localSession(); const question = metricsQuestion('negative-numeric-answer', 'precision', undefined, { A: '80%', B: '80.0%', C: '60%', D: '80.00%' }); question.question = question.question.replace('是多少？', '的下列计算结果错误的是？'); session.beginQuestion(question); const captured = await session.calculate(question, metricsInput());
      const saved = session.saveAnswer(question, answer(question, ['C'], [captured.source])); assert.equal(saved.answer.status, 'verified');
      session.beginQuestion(question); const renewed = await session.calculate(question, metricsInput()); const wrongChoice = session.saveAnswer(question, answer(question, ['A'], [renewed.source])); assert.equal(wrongChoice.answer.status, 'partial');
    });

    await test('伪造数值与原文片段：模型输入和选项数字均不能替代题干', async () => {
      const session = localSession(); const question = metricsQuestion('fake-numeric-input'); session.beginQuestion(question);
      const alteredNumber = metricsInput(); alteredNumber.inputs.retrieved = 80; await assert.rejects(async () => session.calculate(question, alteredNumber));
      const alteredQuote = metricsInput(); alteredQuote.inputQuotes.retrieved = '检索得到90篇（这是新增假文本）'; await assert.rejects(async () => session.calculate(question, alteredQuote));
      const swappedRoles = metricsInput(); swappedRoles.inputs.relevantTotal = 90; swappedRoles.inputQuotes.relevantTotal = '检索得到90篇'; swappedRoles.inputs.retrieved = 180; swappedRoles.inputQuotes.retrieved = '实际相关文献总数为180篇'; await assert.rejects(async () => session.calculate(question, swappedRoles));
      const bareQuotes = metricsInput(); bareQuotes.inputQuotes = { relevantTotal: '180', retrieved: '90', relevantRetrieved: '72' }; await assert.rejects(async () => session.calculate(question, bareQuotes));
      const optionsOnly = { id: 'option-is-not-input', type: 'single', question: '请选择相应比例。', options: { A: '17', B: '40', C: '42.5%', D: '100%' } }; session.beginQuestion(optionsOnly);
      await assert.rejects(async () => session.calculate(optionsOnly, { operation: 'ratio-percent', inputs: { part: 17, whole: 40 }, inputQuotes: { part: '17', whole: '40' } }));
    });

    await test('除零与命中量边界：不产生无定义或不可能的检索指标', async () => {
      for (const [index, values] of [{ total: 0, retrieved: 0, relevant: 0 }, { total: 20, retrieved: 10, relevant: 11 }, { total: 10, retrieved: 20, relevant: 11 }, { total: 20, retrieved: -10, relevant: 1 }].entries()) {
        const session = localSession(); const question = metricsQuestion(`invalid-metrics-${index}`, 'precision', values); session.beginQuestion(question); await assert.rejects(async () => session.calculate(question, metricsInput(values)));
      }
      const session = localSession(); const question = { id: 'ratio-zero', type: 'single', question: '参与任务共0人，完成任务0人。完成比例是多少？', options: { A: '0%', B: '100%' } }; session.beginQuestion(question); await assert.rejects(async () => session.calculate(question, { operation: 'ratio-percent', inputs: { part: 0, whole: 0 }, inputQuotes: { part: '完成任务0人', whole: '参与任务共0人' } }));
    });

    await test('跨题计算证据：相同文字与数字不能借给另一个题号', async () => {
      const session = localSession(); const first = metricsQuestion('proof-owner'); session.beginQuestion(first); const captured = await session.calculate(first, metricsInput()); const next = { ...first, id: 'proof-other' }; session.beginQuestion(next);
      const saved = session.saveAnswer(next, answer(next, ['C'], [captured.source])); assert.equal(saved.answer.status, 'partial');
    });

    await test('同题新attempt：旧计算不能充当重新开始后的本题证据', async () => {
      const session = localSession(); const question = metricsQuestion('proof-new-attempt'); session.beginQuestion(question); const captured = await session.calculate(question, metricsInput()); assert.equal(session.saveAnswer(question, answer(question, ['C'], [captured.source])).answer.status, 'verified');
      session.beginQuestion(question); const saved = session.saveAnswer(question, answer(question, ['C'], [captured.source])); assert.equal(saved.answer.status, 'partial');
    });

    await test('计算proof文件篡改：摘要/内容失配时降低核验状态', async () => {
      const session = localSession(); const question = metricsQuestion('tampered-proof'); session.beginQuestion(question); const captured = await session.calculate(question, metricsInput()); const original = fs.readFileSync(captured.artifact.proof, 'utf8');
      const changed = JSON.parse(original); changed.results.precisionPercent = 60; fs.writeFileSync(captured.artifact.proof, JSON.stringify(changed) + '\n', 'utf8');
      try { const saved = session.saveAnswer(question, answer(question, ['C'], [captured.source])); assert.equal(saved.answer.status, 'partial'); } finally { fs.writeFileSync(captured.artifact.proof, original, 'utf8'); }
    });

    await test('旧会话元数据与本地proof恢复：未完成attempt和实际证据保留', async () => {
      const session = localSession(); const question = metricsQuestion('local-proof-resume'); session.beginQuestion(question); const captured = await session.calculate(question, metricsInput());
      const bindingPath = path.join(session.outputDir, 'session.json'); const binding = JSON.parse(fs.readFileSync(bindingPath, 'utf8')); binding.version = '2.4.0'; fs.writeFileSync(bindingPath, JSON.stringify(binding) + '\n', 'utf8');
      const reopened = localSession(session); const saved = reopened.saveAnswer(question, answer(question, ['C'], [captured.source])); assert.equal(saved.answer.status, 'verified'); assertNoTiming(saved, reopened); assert.equal(reopened.context, undefined);
    });

    await test('已核验布尔卡：限定claims应用，来源时间保留为备赛核验', async () => {
      const session = localSession(); const card = session.ruleCard('boolean-operators'); assert.ok(card && card.id === 'boolean-operators');
      const question = { id: 'boolean-local-rule', type: 'single', question: '一般布尔逻辑检索中，AND运算取两个检索集合的什么部分？', options: { A: '交集', B: '并集', C: '差集' } }; session.beginQuestion(question);
      const captured = await session.useRule(question, { ruleId: 'boolean-operators', claims: ['and'], application: '本题询问通用布尔AND的集合关系，使用已核验规则解释交集。' }); assertLocalProof(captured, question.id);
      const saved = session.saveAnswer(question, answer(question, ['A'], [captured.source])); assert.equal(saved.answer.status, 'verified');
      assert.ok(JSON.stringify(captured.proof).includes('boolean-operators')); assert.ok(captured.source.retrieved_at); assert.equal(captured.proof.rule_verified_at, card.verified_at); assert.equal(captured.proof.rule_url, card.url); assert.match(captured.source.name, /备赛核验规则/); report.rule_card_provenance = { source: captured.source, card };
    });

    await test('不存在或伪造claims：不能扩展已核验规则卡的边界', async () => {
      const session = localSession(); const question = { id: 'invalid-rule-claim', type: 'judge', question: 'AND是布尔检索的逻辑与。', options: {} }; session.beginQuestion(question);
      await assert.rejects(async () => session.useRule(question, { ruleId: 'not-a-verified-card', claims: ['and'], application: '伪造规则。' }));
      await assert.rejects(async () => session.useRule(question, { ruleId: 'boolean-operators', claims: ['and', 'invented-fulltext-access'], application: '把不存在的全文承诺塞进布尔规则。' }));
    });

    await test('动态统计claim：当前记录数量不属于已核验通用布尔卡', async () => {
      const session = localSession(); const question = { id: 'dynamic-count-needs-web', type: 'single', question: '截至今天，在中国知网主题字段检索人工智能 AND 信息素养，得到多少条记录？', options: { A: '100条', B: '200条', C: '300条' } }; session.beginQuestion(question);
      await assert.rejects(async () => session.useRule(question, { ruleId: 'boolean-operators', claims: ['current-record-count'], application: '当前统计值需要实际数据库检索，不是布尔卡提供的通用claim。' }));
    });

    await test('厂商版本claim：通用布尔卡没有当前版本运算优先级', async () => {
      const session = localSession(); const question = { id: 'vendor-version-needs-web', type: 'judge', question: '维普2026版专业检索中，AND、OR、NOT运算符优先级与题干列出顺序一致。', options: {} }; session.beginQuestion(question);
      await assert.rejects(async () => session.useRule(question, { ruleId: 'boolean-operators', claims: ['vip-2026-operator-precedence'], application: '通用卡不包含维普2026版专业检索优先级，需要查该厂商当前官方说明。' }));
    });

    await test('纯local测试网络实测：HTTP/HTTPS/fetch调用均为零', async () => { assert.deepEqual(networkCalls, []); return { network_calls: networkCalls.length, browser_started: false, mocked_startup_state: true }; });
  } finally { http.request = originals.httpRequest; http.get = originals.httpGet; https.request = originals.httpsRequest; https.get = originals.httpsGet; globalThis.fetch = originals.fetch; report.local_network_calls = networkCalls; }
}

async function webTests() {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
    const body = url.pathname === '/help' ? '<h1>数据库官方帮助</h1><main id="help"><p>AND用于取得同时满足条件的交集，OR用于并集，NOT用于排除指定集合。</p><p>当前帮助页提供规则说明，无搜索表单。</p></main>' : '<h1>数据库统计结果</h1><main id="results"><p id="query">当前查询：人工智能 AND 信息素养</p><p id="count">当前结果总数为137条。</p></main>';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>官方数据库测试</title></head><body>${body}</body></html>`);
  }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const baseURL = `http://127.0.0.1:${server.address().port}`;
  const id = `web-routing-${++sequence}`; const outputDir = path.join(runDir, id); const catalog = { sources: [{ id: 'help', name: '官方数据库帮助', url: `${baseURL}/help`, domains: ['127.0.0.1'] }, { id: 'stats', name: '官方数据库统计', url: `${baseURL}/stats`, domains: ['127.0.0.1'] }] };
  const session = await createSession({ sessionId: id, outputDir, profileDir: path.join(outputDir, 'profile'), catalog, recipes: [], recipeIndex: { version: '2.5.0', sources: [] }, headless: true, archive: true, screenshots: true, preflightSourceIds: catalog.sources.map(source => source.id) }); sessions.push(session); const checked = await session.preflight();
  await test('真实帮助页无表单：正常官方正文可直接核验，不强制执行搜索', async () => {
    const entry = checked.entries.find(item => item.source_id === 'help'); assert.equal(entry.availability, 'reachable'); assert.equal(entry.search_ready, false);
    const question = { id: 'real-help-without-search', type: 'single', question: '官方帮助中AND表示什么集合关系？', options: { A: '交集', B: '并集', C: '差集' } }; session.beginQuestion(question); const page = await session.page('help'); assert.equal(await page.getByRole('searchbox').count(), 0);
    const captured = await session.captureEvidence(page, { questionId: question.id, name: '官方数据库帮助', query: 'AND集合关系', field: '官方帮助正文', locator: '#help', target: page.locator('#help'), evidence: 'AND用于取得同时满足条件的交集' }); const saved = session.saveAnswer(question, answer(question, ['A'], [captured.source])); assert.equal(saved.answer.status, 'verified');
  });
  await test('当前数据库统计仍使用真实web证据：原截图proof流程保持兼容', async () => {
    const question = { id: 'real-web-current-count', type: 'single', question: '当前数据库页面检索人工智能 AND 信息素养返回多少条结果？', options: { A: '100条', B: '137条', C: '200条' } }; session.beginQuestion(question); const page = await session.page('stats'); const captured = await session.captureEvidence(page, { questionId: question.id, name: '官方数据库统计', query: '人工智能 AND 信息素养', field: '当前结果总数', locator: '#count', target: page.locator('#count'), evidence: '当前结果总数为137条。' }); assert.ok(fs.existsSync(captured.artifact.screenshot));
    const saved = session.saveAnswer(question, answer(question, ['B'], [captured.source])); assert.equal(saved.answer.status, 'verified'); assert.equal(saved.answer.answer[0], '137条');
  });
}

(async () => {
  try { await localTests(); await webTests(); }
  catch (error) { report.tests.push({ name: 'v2.5运行器初始化', passed: false, error: error.stack || String(error) }); process.stderr.write(`${error.stack || error}\n`); }
  finally {
    for (const session of sessions.reverse()) { if (session.context) try { await session.close(); } catch (error) { report.cleanup_errors ||= []; report.cleanup_errors.push(String(error)); } }
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    report.finished_at = stamp(); report.passed = report.tests.filter(item => item.passed).length; report.failed = report.tests.filter(item => !item.passed).length; const file = path.join(__dirname, 'v25-tests.json'); fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n', 'utf8'); process.stdout.write(`Results: ${report.passed} passed, ${report.failed} failed. ${file}\n`); process.exitCode = report.failed ? 1 : 0;
  }
})();
