'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const source = path.resolve(__dirname, '../ai-literacy-search');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v29-bank-preparation-'));
const copy = path.join(directory, 'skill');
for (const name of ['scripts', 'references', 'runtime']) fs.cpSync(path.join(source, name), path.join(copy, name), { recursive: true });
const bankPath = path.join(copy, 'references/question-bank.json');
const original = fs.readFileSync(bankPath);
const bank = JSON.parse(original);
const { SearchSession, VERSION, lookupQuestionBank, preloadQuestionBank } = require(path.join(copy, 'scripts/browser.cjs'));
const outputDir = path.join(directory, 'output');
const session = new SearchSession({ sessionId: 'v29-integration', outputDir, profileDir: path.join(outputDir, 'profile'), prepareSourceIds: [] });
const report = { version: VERSION, kind: 'test-owned visible Chrome; local bank warmup, no source-site queries', tests: [] };
async function test(name, fn) {
  try { const detail = await fn(); report.tests.push({ name, passed: true, detail }); }
  catch (error) { report.tests.push({ name, passed: false, error: error.stack }); }
}
(async () => {
  try {
    await test('独立导出与会话接口在无Chrome时可本地查题库', () => {
      const e = bank.entries.find(entry => entry.id === 'A07');
      const q = { question: e.stem, type: e.type, options: e.options };
      assert.equal(lookupQuestionBank(q).status, 'matched'); assert.equal(session.lookupQuestionBank(q).status, 'matched');
      assert.equal(session.context, undefined); assert.equal(fs.existsSync(outputDir), false);
    });
    await test('准备调用加载题库，摘要与真实记录及可复用数一致', async () => {
      const summary = await session.prepare({ sourceIds: [] }), expected = preloadQuestionBank();
      assert.equal(summary.status, 'ready'); assert.equal(summary.bank_total, expected.total);
      assert.equal(summary.bank_eligible, expected.eligible); assert.equal(summary.bank_review_required, expected.review_required);
      assert.equal(summary.bank_total, 203); assert.equal(summary.bank_eligible, 57);
      assert.equal(summary.browser_connected, true); assert.equal(summary.sites_total, 0); assert.equal(summary.preflight_ran, false);
      assert.equal(session.context.pages()[0].url(), 'about:blank'); assert.equal(session.options.headless, false);
      assert.equal(summary.answer_labels, undefined);
      return { records: summary.bank_total, eligible: summary.bank_eligible, browser_starts: session._launchCount };
    });
    await test('连续准备和第二题直接命中缓存，无正文重复读取或新浏览器', async () => {
      const e = bank.entries.find(entry => entry.id === 'A07'), context = session.context;
      const q = { question: e.stem, type: e.type, options: { A: e.options.C, B: e.options.A, C: e.options.B, D: e.options.D } };
      const originalRead = fs.readFileSync, reads = [];
      fs.readFileSync = function(file, ...args) { if (String(file).endsWith('question-bank.json')) reads.push(file); return originalRead.call(this, file, ...args); };
      const started = performance.now();
      try {
        await session.prepare({ sourceIds: [] });
        for (let i = 0; i < 10; i++) assert.deepEqual(session.lookupQuestionBank(q).answer_labels, ['A']);
        assert.equal(reads.length, 0); assert.equal(session.context, context); assert.equal(session._launchCount, 1);
        return { cached_bank_reads: reads.length, local_ten_queries_ms: performance.now() - started };
      } finally { fs.readFileSync = originalRead; }
    });
    await test('题库完整性损坏时准备降级且不输出旧答案，修复后可恢复', async () => {
      try {
        const corrupt = JSON.parse(original); corrupt.entries[0].stem += 'changed'; fs.writeFileSync(bankPath, JSON.stringify(corrupt));
        const summary = await session.prepare({ sourceIds: [] });
        assert.equal(summary.status, 'partial'); assert.equal(summary.bank_total, 0);
        assert.ok(summary.failures.some(item => item.kind === 'question_bank'));
        const e = bank.entries.find(entry => entry.id === 'A07');
        assert.equal(session.lookupQuestionBank({ question: e.stem, type: e.type, options: e.options }).status, 'needs_verification');
        assert.equal(session._launchCount, 1);
      } finally { fs.writeFileSync(bankPath, original); }
      assert.equal((await session.prepare({ sourceIds: [] })).bank_total, 203);
    });
    await test('动态计数题预热后仍待实时核验，题库不写网页收据或每题文件', () => {
      const e = bank.entries.find(entry => entry.id === 'A03');
      const result = session.lookupQuestionBank({ question: e.stem, type: e.type, options: e.options });
      assert.equal(result.status, 'needs_verification'); assert.equal(result.answer_labels, undefined);
      assert.equal(result.candidates[0].source.verification, 'user_supplied_reported');
      assert.equal(session.evidence.length, 0); assert.equal(session.questionRecords.length, 0);
      assert.equal(session.archive, false); assert.equal(session.screenshots, false);
      assert.deepEqual(fs.readdirSync(outputDir), ['profile']);
    });
  } finally {
    await session.close(); report.passed = report.tests.filter(test => test.passed).length; report.failed = report.tests.length - report.passed;
    fs.writeFileSync(path.join(__dirname, 'v29-integration-tests.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report)); process.exitCode = report.failed ? 1 : 0;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
