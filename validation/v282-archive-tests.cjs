#!/usr/bin/env node
'use strict';

// This test owns its Chrome/profile/HTTP server. All writes stay in validation;
// no existing browser, daemon, installed skill, login or package is changed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const skillRoot = path.resolve(process.env.AI_LITERACY_TEST_SKILL_ROOT || path.join(__dirname, '../ai-literacy-search'));
const { SearchSession, VERSION } = require(path.join(skillRoot, 'scripts/browser.cjs'));
const runtimeDir = process.env.AI_LITERACY_RUNTIME_DIR || path.join(os.homedir(), '.ailiteracy-runtime');
createRequire(path.join(runtimeDir, 'package.json'))('playwright');
const runDir = fs.mkdtempSync(path.join(__dirname, 'v282-archive-run-'));
const outputDir = path.join(runDir, 'session');
const report = { started_at: new Date().toISOString(), helper_version: VERSION, skill_root: skillRoot, run_dir: runDir,
  kind: 'isolated visible Chrome and local HTTP; archive target uniqueness, reuse and session restoration', tests: [] };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const helperBefore = hash(fs.readFileSync(path.join(skillRoot, 'scripts/browser.cjs')));
const sessions = [];
let server, baseURL, session, restored, capturedA, capturedB, page, firstBytes, firstSnapshot, sequence = 0;
const source = () => ({ id: 'fixture', name: '本地官方材料', url: baseURL + '/material', domains: ['127.0.0.1'] });
const options = extra => ({ sessionId: 'archive-regression', outputDir, profileDir: path.join(outputDir, 'profile'), runtimeDir,
  catalog: { sources: [source()] }, recipeIndex: { sources: [] }, recipes: [], archive: true, screenshots: false,
  headless: false, navigationTimeoutMs: 5000, ...extra });
const question = label => ({ id: `archive-question-${++sequence}`, type: 'multiple', question: `核验${label}中的Alpha与Beta段落。`, options: { A: 'Alpha excerpt', B: 'Beta excerpt' } });
const originalQuestion = question('同一页面两个字段');
function answer(q, sources) {
  return { id: q.id, type: q.type, question: q.question, status: 'verified', answer_labels: ['A', 'B'], answer: ['Alpha excerpt', 'Beta excerpt'],
    explanation: '本地实际页面分别包含当前两个段落。', option_evaluations: Object.entries(q.options).map(([label, text]) => ({ label, text, verdict: 'supported', reason: '实际页面原文包含该段落。' })),
    sources, needs_review: [], searched_at: new Date().toISOString() };
}
const inside = (root, file) => { const relative = path.relative(root, file); return !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); };
async function test(name, fn) {
  try { const detail = await fn(); report.tests.push({ name, passed: true, ...(detail ? { detail } : {}) }); process.stdout.write(`PASS ${name}\n`); }
  catch (error) { report.tests.push({ name, passed: false, error: error.stack || String(error) }); process.stdout.write(`FAIL ${name}: ${error.message}\n`); }
}
async function main() {
  session = new SearchSession(options()); sessions.push(session); await session.start();
  assert.equal(session.options.headless, false); session.beginQuestion(originalQuestion);
  page = await session.page('fixture', { withObservation: true, detail: 'status' }).then(opened => opened.page);
  const userAgent = await page.evaluate(() => navigator.userAgent); assert.match(userAgent, /Chrome\//); assert.doesNotMatch(userAgent, /HeadlessChrome/);
  await test('同一稳定快照连续两次capture保留各自target，不覆写前一批归档', async () => {
    capturedA = await session.captureEvidence(page, { questionId: originalQuestion.id, name: source().name, query: 'Alpha Beta', field: 'Alpha字段', locator: 'section#alpha', evidence: 'Alpha excerpt' });
    firstBytes = fs.readFileSync(capturedA.artifact.target_text); firstSnapshot = fs.readFileSync(capturedA.artifact.snapshot);
    capturedB = await session.captureEvidenceBatch(page, { questionId: originalQuestion.id, name: source().name, query: 'Alpha Beta', field: 'Beta字段', locator: 'section#beta', excerpts: ['Beta excerpt'] });
    assert.equal(capturedA.artifact.snapshot, capturedB.artifact.snapshot, 'the stable original observation should still be reused');
    assert.notEqual(capturedA.artifact.target_text, capturedB.artifact.target_text, 'each capture batch needs an independent target/provenance artifact');
    assert.deepEqual(fs.readFileSync(capturedA.artifact.target_text), firstBytes, 'later capture must preserve the first target bytes');
    assert.deepEqual(fs.readFileSync(capturedA.artifact.snapshot), firstSnapshot, 'shared snapshot bytes remain unchanged');
    const a = JSON.parse(firstBytes.toString('utf8')), b = JSON.parse(fs.readFileSync(capturedB.artifact.target_text, 'utf8'));
    assert.equal(a.locator, 'section#alpha'); assert.equal(b.locator, 'section#beta');
    assert.equal(a.captured_at, capturedA.source.retrieved_at); assert.equal(b.captured_at, capturedB.sources[0].retrieved_at);
    return { shared_snapshot: capturedA.artifact.snapshot, target_a: capturedA.artifact.target_text, target_b: capturedB.artifact.target_text, first_target_sha256: hash(firstBytes) };
  });
  await test('两批来源可同时保存答案，前一批不因第二次capture降级', async () => {
    assert.ok(capturedA && capturedB, 'both actual captures must exist');
    const records = session.evidence.filter(record => record.question_id === originalQuestion.id);
    assert.equal(records.length, 2);
    for (const record of records) assert.equal(session.validateWebEvidence(record, originalQuestion).warning, undefined);
    const saved = session.saveAnswer(originalQuestion, answer(originalQuestion, [capturedA.source, ...capturedB.sources]));
    assert.equal(saved.answer.status, 'verified'); assert.deepEqual(saved.answer.needs_review, []);
    assert.ok(inside(outputDir, saved.jsonPath)); assert.ok(inside(outputDir, saved.markdownPath)); return { status: saved.answer.status };
  });
  await test('后续题可分别复用两批原始来源，原始文件哈希与locator一致', async () => {
    assert.ok(capturedA && capturedB, 'both actual captures must exist'); const q = question('后续复用'); session.beginQuestion(q);
    const reused = [capturedA.source, ...capturedB.sources].map(source => session.reuseEvidence(q, { source, freshness: 'stable', scope: '本地测试材料和两个段落未改变；对象、字段及条件与本题一致。' }));
    for (const record of reused) assert.equal(session.validateReusedEvidence(record, q).warning, undefined);
    const saved = session.saveAnswer(q, answer(q, reused.map(record => record.source))); assert.equal(saved.answer.status, 'verified');
    assert.deepEqual(fs.readFileSync(capturedA.artifact.target_text), firstBytes); return { reused_originals: reused.map(record => record.reuse.origin_record_sha256) };
  });
  await test('同snapshot连续截图使用独立PNG路径，不覆写前一批截图', async () => {
    const realPng = await page.screenshot(), originalScreenshot = page.screenshot, q = question('两批截图归档'); session.beginQuestion(q);
    const savedPaths = [];
    // Keep genuine fixture PNG bytes while isolating the file-naming regression
    // from screenshot engines' transient style/DOM changes.
    page.screenshot = async function (settings) { savedPaths.push(settings.path); fs.writeFileSync(settings.path, realPng); return realPng; };
    let a, b, previous;
    try {
      a = await session.captureEvidence(page, { questionId: q.id, name: source().name, query: '独立截图验证', field: 'Alpha截图', locator: 'section#alpha', evidence: 'Alpha excerpt', screenshot: true });
      previous = fs.readFileSync(a.artifact.screenshot);
      b = await session.captureEvidence(page, { questionId: q.id, name: source().name, query: '独立截图验证', field: 'Beta截图', locator: 'section#beta', evidence: 'Beta excerpt', screenshot: true });
    } finally { page.screenshot = originalScreenshot; }
    assert.equal(a.artifact.snapshot, b.artifact.snapshot); assert.notEqual(a.artifact.screenshot, b.artifact.screenshot);
    assert.deepEqual(fs.readFileSync(a.artifact.screenshot), previous); assert.deepEqual(fs.readFileSync(b.artifact.screenshot), realPng);
    assert.deepEqual(savedPaths, [a.artifact.screenshot, b.artifact.screenshot]); assert.equal(savedPaths.length, new Set(savedPaths).size);
    assert.equal(session.saveAnswer(q, answer(q, [a.source, b.source])).answer.status, 'verified');
    return { shared_snapshot: a.artifact.snapshot, screenshot_a: a.artifact.screenshot, screenshot_b: b.artifact.screenshot, controlled_writer: 'actual local-page PNG bytes, no additional DOM mutations' };
  });
  await test('关闭独占浏览器后恢复归档，无需启动Chrome即可继续复用原始材料', async () => {
    await session.close(); restored = new SearchSession(options()); sessions.push(restored); assert.equal(restored.context, undefined);
    const found = restored.findEvidence({ text: 'Alpha Beta', limit: 10 }); assert.equal(found.length, 2);
    const q = question('恢复后的题目'); restored.beginQuestion(q);
    const reused = found.map(item => restored.reuseEvidence(q, { source: item.source, freshness: 'stable', scope: '同一会话归档恢复后的本地静态原文；段落对象、字段与本题相同。' }));
    for (const record of reused) assert.equal(restored.validateReusedEvidence(record, q).warning, undefined);
    assert.equal(restored.saveAnswer(q, answer(q, reused.map(record => record.source))).answer.status, 'verified');
    assert.equal(restored.context, undefined); return { found_originals: found.length, browser_restarted: false };
  });
  await test('恢复必须匹配原session/profile；测试输出不进入技能目录或发行包', async () => {
    assert.throws(() => new SearchSession(options({ sessionId: 'different-session' })), /different session|belongs/i);
    assert.throws(() => new SearchSession(options({ profileDir: path.join(outputDir, 'other-profile') })), /different session|belongs/i);
    for (const record of session.evidence.filter(record => record.kind === 'web')) {
      assert.ok(inside(outputDir, record.artifact.snapshot)); assert.ok(inside(outputDir, record.artifact.target_text));
      assert.ok(!inside(skillRoot, record.artifact.snapshot)); assert.ok(!inside(skillRoot, record.artifact.target_text));
    }
    assert.ok(inside(__dirname, runDir)); assert.equal(hash(fs.readFileSync(path.join(skillRoot, 'scripts/browser.cjs'))), helperBefore);
    return { output_root: outputDir, helper_unchanged: true, package_writes: false };
  });
}
(async () => {
  try {
    server = http.createServer((req, res) => {
      if (req.url === '/favicon.ico') { res.writeHead(204).end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end('<!doctype html><html><meta charset="utf-8"><title>本地官方材料</title><body><h1>本地官方材料</h1><section id="alpha">Alpha excerpt</section><section id="beta">Beta excerpt</section></body></html>');
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); baseURL = `http://127.0.0.1:${server.address().port}`; await main();
  } catch (error) { report.tests.push({ name: 'fixture initialization', passed: false, error: error.stack || String(error) }); process.stderr.write(String(error.stack || error) + '\n'); }
  finally {
    for (const item of sessions.reverse()) { try { await item.close(); } catch (error) { report.cleanup_errors ||= []; report.cleanup_errors.push(String(error)); } }
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    report.finished_at = new Date().toISOString(); report.passed = report.tests.filter(item => item.passed).length; report.failed = report.tests.filter(item => !item.passed).length;
    const reportPath = path.join(__dirname, 'v282-archive-tests.json'); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(`Results: ${report.passed} passed, ${report.failed} failed. ${reportPath}\n`); process.exitCode = report.failed ? 1 : 0;
  }
})();
