'use strict';

// Actual SearchSession/runSearch; DOM/page methods are offline mocks. Deferred
// site locks exercise queued question attempts without starting any browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SearchSession, VERSION } = require('../ai-literacy-search/scripts/browser.cjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'v282-queue-offline-'));
const report = { helper_version: VERSION, started_at: new Date().toISOString(),
  kind: 'actual SearchSession/runSearch with mocked DOM/pages and deferred site locks', browser_started: false, network_used: false, tests: [] };
const source = { id: 'fixture', name: 'Offline queue fixture', url: 'https://fixtures.example.test/entry', domains: ['fixtures.example.test'] };
const key = 'example.test';
const recipe = { id: 'fixture:queued', source_id: source.id, status: 'query_verified', entry_url: source.url,
  transitions: { results: { match: { css: '#echo' } } },
  execution: { version: 1, queryMode: 'literal', parameters: { query: { type: 'string', required: true } }, prepare: [],
    submit: { action: 'click', locator: { css: '#submit' } }, echoParameters: ['query'] } };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function makeSession(name) {
  const session = new SearchSession({ sessionId: name, outputDir: path.join(temp, name), runtimeDir: path.join(temp, 'runtime'), catalog: [source],
    recipeIndex: { sources: [{ ...source, recipe_ids: [recipe.id] }] }, recipes: [recipe] });
  const calls = { page: 0, transition: 0, submit: 0, recordSearch: 0 };
  let echo = '';
  const locator = selector => ({ filter() { return this; }, count: async () => 1, isVisible: async () => true,
    innerText: async () => selector === '#echo' ? echo : '检索', click: async () => { calls.submit++; } });
  const page = { locator };
  const container = { innerText: async () => echo + '；离线结果记录', locator: () => ({ evaluateAll: async () => [] }) };
  Object.defineProperty(session, 'context', { get() { throw new Error('Queue fixtures must not access a browser context.'); } });
  session.start = () => { throw new Error('Queue fixtures must not launch Chrome.'); };
  session.page = async () => { calls.page++; session.observations.set(page, { observed: { http_status: 200 } }); return { page }; };
  session.currentObservation = async () => ({ http_status: 200 });
  session.classify = () => ({ authorization: 'not_observed', availability: 'reachable', identity: 'matched' });
  session.transition = async (sourceId, options) => {
    calls.transition++;
    await options.trigger();
    echo = options.query;
    if (session.holdTransition) await session.holdTransition(calls.transition);
    return { status: 'ready', outcome: 'results', page, container, observation: null, binding: { query: echo } };
  };
  session.recordSearch = async () => { calls.recordSearch++; };
  session.runLocks = new Map();
  const question = { id: name + '-question', question: '检索题名“当前题名”的记录。', type: 'single', options: { A: '记录甲', B: '记录乙' } };
  const options = { recipeId: recipe.id, parameters: { query: '当前题名' }, parameterQuotes: { query: '当前题名' }, capture: false };
  return { session, calls, question, options };
}
function assertStale(result, fixture) {
  assert.equal(result.status, 'needs_observation');
  assert.equal(result.outcome, 'failed');
  assert.match(result.reason, /older question or attempt/);
  assert.equal(result.page, null);
  assert.deepEqual(fixture.calls, { page: 0, transition: 0, submit: 0, recordSearch: 0 });
}
function assertExecuted(result, fixture, count = 1) {
  assert.equal(result.status, 'ready');
  assert.equal(result.outcome, 'results');
  assert.equal(result.data.conditions, '当前题名');
  assert.deepEqual(fixture.calls, { page: count, transition: count, submit: count, recordSearch: count });
}
async function test(name, fn) {
  let timer;
  try {
    const detail = await Promise.race([fn(), new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Offline queue fixture did not settle')), 3000); })]);
    report.tests.push({ name, passed: true, detail });
  }
  catch (error) { report.tests.push({ name, passed: false, error: error.stack || String(error) }); }
  finally { clearTimeout(timer); }
}
async function main() {
  await test('attempt 1 queued request cannot adopt attempt 2', async () => {
    const f = makeSession('stale-attempt'), gate = deferred();
    f.session.runLocks.set(key, gate.promise);
    const pending = f.session.runSearch(f.question, f.options);
    assert.equal(f.session.activeQuestion.attempt, 1);
    f.session.finishQuestion(f.question);
    assert.equal(f.session.beginQuestion(f.question).attempt, 2);
    gate.resolve();
    assertStale(await pending, f);
    assert.equal(f.session.runLocks.size, 0);
    return f.calls;
  });
  await test('completed current question prevents queued operations', async () => {
    const f = makeSession('stale-completed'), gate = deferred();
    f.session.runLocks.set(key, gate.promise);
    const pending = f.session.runSearch(f.question, f.options);
    f.session.finishQuestion(f.question);
    gate.resolve();
    assertStale(await pending, f);
    assert.equal(f.session.runLocks.size, 0);
    return f.calls;
  });
  await test('switching question prevents queued operations', async () => {
    const f = makeSession('stale-question'), gate = deferred();
    f.session.runLocks.set(key, gate.promise);
    const pending = f.session.runSearch(f.question, f.options);
    f.session.beginQuestion({ ...f.question, id: f.question.id + '-other' });
    gate.resolve();
    assertStale(await pending, f);
    assert.equal(f.session.runLocks.size, 0);
    return f.calls;
  });
  await test('same current attempt runs after site lock opens', async () => {
    const f = makeSession('current-attempt'), gate = deferred();
    f.session.runLocks.set(key, gate.promise);
    const pending = f.session.runSearch(f.question, f.options);
    assert.equal(f.calls.page, 0);
    assert.equal(f.session.beginQuestion(f.question).attempt, 1);
    gate.resolve();
    assertExecuted(await pending, f);
    assert.equal(f.session.runLocks.size, 0);
    return f.calls;
  });
  await test('rejected prior site lock does not poison current request', async () => {
    const f = makeSession('rejected-lock'), gate = deferred();
    f.session.runLocks.set(key, gate.promise);
    const pending = f.session.runSearch(f.question, f.options);
    gate.reject(new Error('offline previous operation failed'));
    assertExecuted(await pending, f);
    assert.equal(f.session.runLocks.size, 0);
    return f.calls;
  });
  await test('same-attempt requests serialize without deleting a newer lock', async () => {
    const f = makeSession('current-pair'), siteGate = deferred(), firstGate = deferred(), secondGate = deferred(), firstEntered = deferred(), secondEntered = deferred();
    f.session.holdTransition = async count => {
      (count === 1 ? firstEntered : secondEntered).resolve();
      await (count === 1 ? firstGate : secondGate).promise;
    };
    f.session.runLocks.set(key, siteGate.promise);
    const first = f.session.runSearch(f.question, f.options), second = f.session.runSearch(f.question, f.options);
    const latestLock = f.session.runLocks.get(key);
    assert.equal(f.session.activeQuestion.attempt, 1);
    siteGate.resolve();
    await firstEntered.promise;
    assert.equal(f.calls.page, 1);
    firstGate.resolve();
    const firstResult = await first;
    assert.equal(firstResult.status, 'ready');
    await secondEntered.promise;
    assert.equal(f.session.runLocks.get(key), latestLock);
    secondGate.resolve();
    assertExecuted(await second, f, 2);
    assert.equal(f.session.runLocks.size, 0);
    return f.calls;
  });
  await test('cancelled old attempt leaves newer queued attempt runnable', async () => {
    const f = makeSession('retry-pair'), siteGate = deferred(), newGate = deferred(), newEntered = deferred();
    f.session.runLocks.set(key, siteGate.promise);
    const old = f.session.runSearch(f.question, f.options);
    f.session.finishQuestion(f.question);
    f.session.beginQuestion(f.question);
    f.session.holdTransition = async () => { newEntered.resolve(); await newGate.promise; };
    const current = f.session.runSearch(f.question, f.options), latestLock = f.session.runLocks.get(key);
    siteGate.resolve();
    const oldResult = await old;
    assert.equal(oldResult.status, 'needs_observation');
    assert.equal(oldResult.outcome, 'failed');
    assert.equal(oldResult.page, null);
    await newEntered.promise;
    assert.equal(f.session.runLocks.get(key), latestLock);
    assert.deepEqual(f.calls, { page: 1, transition: 1, submit: 1, recordSearch: 0 });
    newGate.resolve();
    assertExecuted(await current, f);
    assert.equal(f.session.runLocks.size, 0);
    return f.calls;
  });
}
main().catch(error => { report.tests.push({ name: 'test setup', passed: false, error: error.stack || String(error) }); }).finally(() => {
  report.finished_at = new Date().toISOString();
  report.passed = report.tests.filter(test => test.passed).length;
  report.failed = report.tests.length - report.passed;
  report.status = report.failed ? 'failed' : 'passed';
  fs.writeFileSync(path.join(__dirname, 'v282-queue-tests.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  process.stdout.write(JSON.stringify(report) + '\n');
  const relative = path.relative(os.tmpdir(), temp);
  if (!relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(temp).startsWith('v282-queue-offline-')) fs.rmSync(temp, { recursive: true, force: true });
  if (report.failed) process.exitCode = 1;
});
