#!/usr/bin/env node
'use strict';

// Compare evidence capture on one real Chrome page. Browser startup, catalogue
// preflight, navigation and model reasoning are outside the measured interval.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const { performance } = require('node:perf_hooks');
const { createSession } = require('../ai-literacy-search/scripts/browser.cjs');

const reportPath = path.join(__dirname, 'performance-tests.json');
const runDir = fs.mkdtempSync(path.join(__dirname, 'performance-browser-run-'));
const excerpts = [
  '同一篇文献可以列出多个来源。',
  '平台是专搜学术资源的垂直搜索引擎。',
  '部分文献因机构订阅、授权或版权限制，无法直接获取全文。',
  '可以按照 GB/T 7714-2015 标准导出参考文献。',
];
const report = {
  started_at: new Date().toISOString(),
  kind: 'real visible Google Chrome; local HTTP fixture; direct Playwright JavaScript API',
  scope: 'captureEvidence only: page observation, target reading, screenshot, local evidence writes',
  excludes: ['browser startup', 'catalogue preflight', 'navigation', 'model reasoning', 'public-site latency'],
  run_dir: runDir,
  node: process.version,
  repetitions: 5,
  samples: [],
};
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const rounded = value => Math.round(value * 100) / 100;
let session;
let server;

async function main() {
  server = http.createServer((req, res) => {
    if (req.url === '/favicon.ico') { res.writeHead(204).end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>测试权威数据库官方帮助</title></head><body><h1>测试权威数据库官方帮助</h1><main id="facts">${excerpts.map(excerpt => `<p>${excerpt}</p>`).join('')}</main></body></html>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const fixtureURL = `http://127.0.0.1:${server.address().port}/help`;
  session = await createSession({
    sessionId: 'performance-browser-fixture', outputDir: runDir, profileDir: path.join(runDir, 'profile'),
    catalog: [{ id: 'help', name: '测试权威数据库官方帮助', url: fixtureURL, domains: ['127.0.0.1'], access: 'public', kind: 'official_database' }],
    headless: false, navigationTimeoutMs: 10000,
  });
  await session.preflight();
  const { page } = await session.page('help', { withObservation: true, compact: true });
  const captureOptions = questionId => ({
    questionId, name: '测试权威数据库官方帮助', query: '来源 全文 引用', field: '官方帮助正文',
    locator: '#facts', target: page.locator('#facts'),
  });
  // Warm both paths before recording, including screenshot initialization.
  await session.captureEvidence(page, { ...captureOptions('warm-single'), evidence: excerpts[0] });
  await session.captureEvidenceBatch(page, { ...captureOptions('warm-batch'), excerpts });
  const originalObserve = session.observe;
  const originalScreenshot = page.screenshot;
  const counts = { observe: 0, screenshot: 0 };
  session.observe = async function (...args) { counts.observe++; return originalObserve.apply(this, args); };
  page.screenshot = async function (...args) { counts.screenshot++; return originalScreenshot.apply(this, args); };
  const measure = async (method, repetition) => {
    const before = { ...counts };
    const questionId = `benchmark-${method}-${repetition}`;
    const start = performance.now();
    let sources;
    if (method === 'single') {
      sources = [];
      for (const evidence of excerpts) {
        const captured = await session.captureEvidence(page, { ...captureOptions(questionId), evidence });
        sources.push(captured.source);
      }
    } else {
      sources = (await session.captureEvidenceBatch(page, { ...captureOptions(questionId), excerpts })).sources;
    }
    const elapsedMs = performance.now() - start;
    assert.deepEqual(sources.map(source => source.evidence), excerpts);
    const expectedOperations = method === 'single' ? 4 : 1;
    assert.equal(counts.observe - before.observe, expectedOperations);
    assert.equal(counts.screenshot - before.screenshot, expectedOperations);
    assert.equal(session.evidence.filter(record => record.question_id === questionId).length, 4);
    return { method, repetition, elapsed_ms: rounded(elapsedMs), page_observations: counts.observe - before.observe, screenshots: counts.screenshot - before.screenshot, excerpts: sources.length };
  };
  try {
    // Alternate ordering so warm cache or elapsed run time does not always
    // favour the same implementation.
    for (let repetition = 1; repetition <= report.repetitions; repetition++) {
      const methods = repetition % 2 ? ['single', 'batch'] : ['batch', 'single'];
      for (const method of methods) report.samples.push(await measure(method, repetition));
    }
  } finally {
    session.observe = originalObserve;
    page.screenshot = originalScreenshot;
  }
  const singleMedian = median(report.samples.filter(sample => sample.method === 'single').map(sample => sample.elapsed_ms));
  const batchMedian = median(report.samples.filter(sample => sample.method === 'batch').map(sample => sample.elapsed_ms));
  report.summary = {
    single_four_excerpts_median_ms: singleMedian,
    batch_four_excerpts_median_ms: batchMedian,
    capture_time_reduction_percent: rounded((1 - batchMedian / singleMedian) * 100),
    capture_speed_ratio: rounded(singleMedian / batchMedian),
    page_observations_per_question: { single: 4, batch: 1 },
    screenshots_per_question: { single: 4, batch: 1 },
    evidence_excerpts_per_question: { single: 4, batch: 4 },
    limitation: 'Local same-page capture result; this does not measure or promise an equal reduction in end-to-end question time.',
  };
  report.passed = true;
  process.stdout.write(`Four excerpts, median capture: single ${singleMedian} ms; batch ${batchMedian} ms; capture reduction ${report.summary.capture_time_reduction_percent}%.\n`);
}

(async () => {
  try { await main(); }
  catch (error) {
    report.passed = false;
    report.error = error.stack || String(error);
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  } finally {
    if (session) await session.close().catch(error => { report.cleanup_error = String(error); });
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    report.finished_at = new Date().toISOString();
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
    process.stdout.write(`Report: ${reportPath}\n`);
  }
})();
