'use strict';

// Independent narrow behavior checks. Public websites are not queried.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { createSession } = require('../ai-literacy-search/scripts/browser.cjs');
const { installLocalEvidence } = require('../ai-literacy-search/scripts/local-evidence.cjs');
const root = path.resolve(__dirname, '../ai-literacy-search');
const runDir = fs.mkdtempSync(path.join(__dirname, 'v25-routing-audit-run-'));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const normalize = value => String(value).normalize('NFKC').replace(/\s+/g, ' ').trim();
const identity = question => ({ id: question.id, fingerprint: hash(JSON.stringify(question)) });
const writeJSON = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); };
const report = { run_dir: runDir, fixture: 'Real Chrome against local HTTP; local numeric probes use a stub rule card to isolate input and option validation.', tests: [] };
async function check(name, fn) {
  try { const details = await fn(); report.tests.push({ name, passed: true, details }); }
  catch (error) { report.tests.push({ name, passed: false, error: error.stack }); }
}

class Probe {
  constructor(question) {
    this.sessionId = 'local-audit'; this.outputDir = path.join(runDir, question.id); this.archive = true;
    fs.mkdirSync(this.outputDir, { recursive: true });
    this.evidence = []; this.activeQuestion = { id: question.id, attempt: 1 };
    this.questionRecords = [{ question_id: question.id, fingerprint: identity(question).fingerprint, attempt: 1, completed: false }];
    this.timerRecords = this.questionRecords; // Compatibility while the no-timing update is in progress.
  }
  log() {}
  rememberEvidence() {} // This Probe isolates deterministic input validation; real receipt checks are in v27-tests.
}
installLocalEvidence(Probe, { root, stamp: () => new Date().toISOString(), hash, normalize, questionIdentity: identity, writeJSON, inside: (parent, file) => file.startsWith(parent + path.sep) });
Probe.prototype.ruleCard = () => ({ id: 'retrieval-metrics', name: 'Stub verified formula', url: 'https://example.com/formula', scope: 'formula', verified_at: '2026-10-09', claims: {} });

(async () => {
  let session, server;
  try {
    await check('calculation rejects explanatory or negated numeric options', async () => {
      const question = { id: 'non-numeric-option', type: 'single', question: '检索查准率是多少？', options: { A: '查准率不是80%', B: '40%', C: '60%' } };
      const warnings = new Probe(question).validateCalculationAnswer(question, { type: 'single', answer_labels: ['A'] }, [{ operation: 'retrieval-metrics', results: { recall: .4, precision: .8 } }]);
      assert.ok(warnings.length, 'A numeric token inside a contradictory statement must not authorize verified.');
      return { warnings };
    });
    await check('calculation rejects bare-number quotes without quantity roles', async () => {
      const question = { id: 'bare-number-input', type: 'single', question: '实际相关文献总数为180篇，检索得到90篇，其中相关文献为72篇。查准率是多少？', options: { A: '40%', B: '80%' } };
      // Swapped semantic denominators are mathematically plausible and all tokens exist.
      assert.throws(() => new Probe(question).calculate(question, { operation: 'retrieval-metrics', inputs: { relevantTotal: 90, retrieved: 180, relevantRetrieved: 72 }, inputQuotes: { relevantTotal: '90', retrieved: '180', relevantRetrieved: '72' } }), 'A bare number is not enough provenance to bind its semantic role.');
    });
    await check('pure numeric option calculation remains valid', async () => {
      const question = { id: 'pure-option', type: 'single', question: '检索查准率是多少？', options: { A: '80%', B: '40%', C: '60%' } };
      assert.deepEqual(new Probe(question).validateCalculationAnswer(question, { type: 'single', answer_labels: ['A'] }, [{ operation: 'retrieval-metrics', results: { recall: .4, precision: .8 } }]), []);
    });
    await check('option decimal width cannot invent an unrequested rounding rule', async () => {
      const question = { id: 'coarse-option', type: 'single', question: '检索查准率是多少？', options: { A: '1', B: '0.2', C: '0.4' } };
      const warnings = new Probe(question).validateCalculationAnswer(question, { type: 'single', answer_labels: ['A'] }, [{ operation: 'retrieval-metrics', results: { recall: .4, precision: .8 } }]);
      assert.ok(warnings.length, '0.8 is not 1 without a requested whole-number rounding rule.');
    });
    await check('metric labels cannot silently reverse tuple semantics', async () => {
      const question = { id: 'reversed-labels', type: 'single', question: '检索查全率、查准率分别是多少？', options: { A: '查准率=40%，查全率=80%', B: '20%，60%', C: '60%，20%' } };
      const warnings = new Probe(question).validateCalculationAnswer(question, { type: 'single', answer_labels: ['A'] }, [{ operation: 'retrieval-metrics', results: { recall: .4, precision: .8 } }]);
      assert.ok(warnings.length, 'A reversed explicit label must not be erased before matching the stem tuple.');
    });
    await check('actual school phrasing with collection and relevant hits stays calculable', async () => {
      const question = { id: 'school-wording', type: 'single', question: '某检索系统收录与主题A相关文献500篇，检索时查出320篇，其中完全符合要求的80篇，请问本次检索的查全率和查准率分别是多少？', options: { A: '0.16,0.25', B: '0.25,0.16' } };
      const captured = new Probe(question).calculate(question, { operation: 'retrieval-metrics', inputs: { relevantTotal: 500, retrieved: 320, relevantRetrieved: 80 }, inputQuotes: { relevantTotal: '某检索系统收录与主题A相关文献500篇', retrieved: '检索时查出320篇', relevantRetrieved: '其中完全符合要求的80篇' } });
      assert.equal(captured.proof.results.recall, .16); assert.equal(captured.proof.results.precision, .25);
    });

    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
      let body = '<h1>官方数据库检索</h1><a href="/help">官方帮助</a><button onclick="location.href=\'/results?q=fresh-topic\'">搜索</button>';
      if (url.pathname === '/results') body = '<h1>官方数据库结果</h1><main id="results"><p id="query">fresh-topic</p><p>fresh record</p><a href="/detail" target="_blank">记录详情</a></main><a href="/help">官方帮助</a>';
      if (url.pathname === '/detail') body = '<h1>官方记录详情</h1><main id="detail"><p id="record">record-1</p><p>old detail fact</p></main>';
      if (url.pathname === '/help') body = '<h1>官方帮助</h1><main id="help">AND 表示集合交集。</main>';
      res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-store' }).end('<!doctype html><html><head><meta charset="utf-8"><title>官方数据库</title></head><body>' + body + '</body></html>');
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    const outputDir = path.join(runDir, 'web');
    session = await createSession({ sessionId: 'v25-routing-audit', outputDir, profileDir: path.join(outputDir, 'profile'), headless: true, archive: true, screenshots: true, preflightSourceIds: ['site'], maxPages: 5, catalog: { sources: [{ id: 'site', name: '官方数据库', url: base + '/search', domains: ['127.0.0.1'] }] }, recipeIndex: { sources: [] }, recipes: [] });
    await session.preflight();
    const q1 = { id: 'previous-query', question: '查当前记录', type: 'single', options: { A: 'fresh record' } };
    session.beginQuestion(q1);
    const page = await session.page('site');
    await session.transition('site', { questionId: q1.id, fromPage: page, toRole: 'results', mode: 'same-page', container: { css: '#results' }, ready: { css: '#results' }, match: { css: '#query' }, expected: 'fresh-topic', trigger: target => target.getByRole('button', { name: '搜索' }).click() });
    const oldDetail = await session.transition('site', { questionId: q1.id, fromPage: page, toRole: 'detail', mode: 'popup', container: { css: '#detail' }, ready: { css: '#detail' }, match: { css: '#record' }, expected: 'record-1', trigger: target => target.getByRole('link', { name: '记录详情' }).click() });
    session.finishQuestion(q1); session.completeQuestionPages(q1.id);
    const q2 = { id: 'current-help', question: 'AND表示什么？', type: 'single', options: { A: '交集', B: '并集' } };
    session.beginQuestion(q2);
    await check('old result evidence remains blocked before official entry navigation', async () => {
      await assert.rejects(() => session.captureEvidence(page, { questionId: q2.id, name: '旧结果', query: 'fresh-topic', field: 'record', locator: '#results', target: page.locator('#results'), evidence: 'fresh record' }), /stale|another question|角色页|旧题/i);
    });
    await check('controlled official-help navigation detaches old result binding', async () => {
      const help = await session.page('site', { entryUrl: base + '/help' });
      assert.equal(help, page); assert.equal(help.url(), base + '/help');
      const captured = await session.captureEvidence(help, { questionId: q2.id, name: '官方帮助', query: 'AND', field: '官方帮助正文', locator: '#help', target: help.locator('#help'), evidence: 'AND 表示集合交集。' });
      assert.ok(fs.existsSync(captured.artifact.screenshot));
      assert.equal(session.life(help).binding, null, 'A result binding cannot describe a newly observed official help entry.');
      assert.equal(session.rolePages.get('site')?.has('results') || false, false);
      assert.equal(session.transitionStates.has('site:results'), false);
    });
    await check('official-help navigation does not release a separate old detail popup', async () => {
      assert.equal(session.rolePages.get('site')?.get('detail'), oldDetail.page);
      assert.equal(session.life(oldDetail.page).binding.question_id, q1.id);
      assert.equal(session.transitionStates.get('site:detail').page, oldDetail.page);
      await assert.rejects(() => session.captureEvidence(oldDetail.page, { questionId: q2.id, name: '旧详情', query: 'record-1', field: '记录详情', locator: '#detail', target: oldDetail.page.locator('#detail'), evidence: 'old detail fact' }), /stale|another question|角色页|旧题/i);
    });
  } catch (error) { report.tests.push({ name: 'audit setup', passed: false, error: error.stack }); }
  finally {
    if (session) await session.close().catch(() => {});
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    report.passed = report.tests.filter(item => item.passed).length; report.failed = report.tests.length - report.passed;
    writeJSON(path.join(__dirname, 'v25-routing-audit.json'), report);
    process.stdout.write(JSON.stringify(report, null, 2) + '\n'); process.exitCode = report.failed ? 1 : 0;
  }
})();
