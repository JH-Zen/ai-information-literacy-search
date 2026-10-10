'use strict';

// Independent behavioral review. Local fixture, own browser/profile only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { createSession, SearchSession } = require('../ai-literacy-search/scripts/browser.cjs');

(async () => {
  const run = fs.mkdtempSync(path.join(__dirname, 'forward-v24-run-'));
  const findings = [];
  let session;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://' + request.headers.host);
    const escapedQuery = (url.searchParams.get('q') || '').replace(/[<>&"]/g, '');
    let body = '<main id="results"><p id="echo">old-term</p><p>旧题专属证据：记录 Old Article 2025。</p></main>';
    if (url.pathname === '/search') body = '<form action="/generic-results" target="literacyResults"><label for="q">检索词</label><input id="q" name="q"><button id="submit" type="submit">检索</button></form><button id="late" onclick="setTimeout(()=>window.open(\'/result?q=old-term\',\'_blank\'),250)">迟到结果</button>';
    if (url.pathname === '/generic-results') body = `<main id="results"><p id="echo">${escapedQuery}</p><article><h2>${escapedQuery}：方法与案例</h2><p>作者：韩青；年份：2027；记录ID：R17。</p><a target="_blank" href="/generic-detail?q=${encodeURIComponent(escapedQuery)}&id=R17">查看详情</a></article></main>`;
    if (url.pathname === '/generic-detail') body = `<main id="detail"><p id="record-id">R17</p><p id="title">${escapedQuery}：方法与案例</p><p>作者：韩青；年份：2027。</p></main>`;
    response.writeHead(200, {'content-type': 'text/html;charset=utf-8'}).end('<!doctype html><title>本地权威检索库</title>' + body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    session = await createSession({sessionId: 'forward-review-' + Date.now(), outputDir: run,
      profileDir: path.join(run, 'profile'), headless: true, navigationTimeoutMs: 1000, maxPages: 3,
      catalog: [{id: 'official', name: 'Local database', url: base + '/search', domains: ['127.0.0.1']}]
    });
    await session.preflight();
    const page = await session.page('official');
    session.beginQuestion('old-question');
    const delayedPage = session.context.waitForEvent('page');
    await assert.rejects(() => session.transition('official', {
      questionId: 'old-question', fromPage: page, toRole: 'results', mode: 'popup', timeoutMs: 60,
      container: {css: '#results'}, ready: {css: '#results'}, match: {css: '#echo'}, query: 'old-term',
      trigger: current => current.locator('#late').click()
    }), /No fresh/);
    session.beginQuestion('new-question');
    const stalePopup = await delayedPage;
    await stalePopup.waitForLoadState('domcontentloaded');
    await session.observe(stalePopup);
    let staleAccepted = false;
    try {
      await session.captureEvidence(stalePopup, {questionId: 'new-question', name: 'Old popup', query: 'new-term',
        field: 'Title', locator: '#results', evidence: '旧题专属证据：记录 Old Article 2025。'});
      staleAccepted = true;
    } catch {}
    findings.push({id: 'unbound-delayed-popup', actual: staleAccepted ? 'old popup accepted for new question' : 'old popup rejected',
      passed: !staleAccepted, old_query: 'old-term', supplied_new_query: 'new-term', binding: session.life(stalePopup).binding});

    // Direct source pages loaded during a current question must not disappear
    // while their factual evidence is still pending.
    const manual = await session.context.newPage();
    await manual.goto(base + '/result?q=manual');
    await session.observe(manual);
    await page.close();
    const third = await session.context.newPage();
    await third.goto(base + '/result?q=third');
    await session.observe(third);
    const before = session.context.pages().filter(item => !item.isClosed()).map(item => item.url());
    try {const release = await session.reservePageSlot({protect: [third], needed: 1});release?.();} catch {}
    findings.push({id: 'unfinished-direct-page', actual: manual.isClosed() ? 'unbound pending evidence page evicted' : 'pending page preserved',
      passed: !manual.isClosed(), before, after: session.context.pages().filter(item => !item.isClosed()).map(item => item.url())});
    if (!stalePopup.isClosed()) await stalePopup.close();

    const newPrepared = {id: 'new-prepared', name: 'Local publisher', url: manual.url(), domains: ['127.0.0.1']};
    await session.addSource(newPrepared, {page: manual});
    let sourceConflict = null;
    try {
      new SearchSession({sessionId: session.sessionId, outputDir: run, profileDir: path.join(run, 'profile'),
        catalog: [{id: 'official', name: 'Local database', url: base + '/search', domains: ['127.0.0.1']}],
        recipeIndex: {sources: [newPrepared]}});
    } catch (error) {sourceConflict = error.message;}
    findings.push({id: 'promoted-source-restore', passed: sourceConflict === null, actual: sourceConflict || 'restored same session with newly prepared identical source'});

    const fourth = await session.context.newPage();
    await fourth.goto(base + '/result?q=fourth');
    await session.observe(fourth);
    try {const release = await session.reservePageSlot({protect: [third, fourth], needed: 1});release?.();} catch {}
    findings.push({id: 'current-official-page-pending', actual: manual.isClosed() ? 'registered current official page evicted before evidence save' : 'pending current official page preserved', passed: !manual.isClosed()});

    await session.close();
    const freshRun = path.join(run, 'fresh-task');
    const source = {id: 'official', name: 'Local database', url: base + '/search', domains: ['127.0.0.1']};
    const recipe = {id: 'official:record-lookup', source_id: 'official', task_kind: 'record-lookup', status: 'entry_verified', entry_url: source.url,
      transitions: {results: {mode: 'reuse-target', container: {css: '#results'}, ready: {css: '#results'}, match: {css: '#echo'}},
        detail: {mode: 'popup', container: {css: '#detail'}, ready: {css: '#detail'}, match: {css: '#record-id'}}}};
    session = await createSession({sessionId: 'forward-fresh-' + Date.now(), outputDir: freshRun, profileDir: path.join(freshRun, 'profile'), headless: true, maxPages: 3,
      catalog: [source], recipeIndex: {sources: [source]}, recipes: [recipe]});
    await session.preflight();
    const query = '交互检索评估-' + Date.now();
    const question = {id: 'fresh-entity', type: 'single', question: `查找“${query}”的目标记录题名。`, options: {A: '相似但错误题名', B: query + '：方法与案例'}};
    session.beginQuestion(question);
    const search = await session.page('official', {recipeId: recipe.id});
    await search.getByLabel('检索词', {exact: true}).fill(query);
    const results = await session.transition('official', {questionId: question.id, fromPage: search, toRole: 'results', recipeId: recipe.id, query,
      trigger: current => current.getByRole('button', {name: '检索', exact: true}).click()});
    assert.equal(results.status, 'ready');
    const matchedRecord = results.container.locator('article').filter({has: results.page.getByRole('heading', {name: question.options.B, exact: true})});
    assert.equal(await matchedRecord.count(), 1);
    assert.ok((await matchedRecord.innerText()).includes('作者：韩青；年份：2027；记录ID：R17。'));
    const detail = await session.transition('official', {questionId: question.id, fromPage: results.page, toRole: 'detail', recipeId: recipe.id, query, recordId: 'R17',
      trigger: () => matchedRecord.getByRole('link', {name: '查看详情', exact: true}).click()});
    const evidence = await session.captureEvidence(detail.page, {questionId: question.id, name: 'Local current official record', query, field: 'Title', locator: '#detail #title',
      target: detail.container.locator('#title'), evidence: question.options.B});
    const answer = session.saveAnswer(question, {id: question.id, question: question.question, type: 'single', status: 'verified', answer: [question.options.B], answer_labels: ['B'],
      explanation: '当前记录题名、作者、年份和ID均实查对应。', option_evaluations: [{label: 'A', text: question.options.A, verdict: 'refuted', reason: '与当前记录不同。'}, {label: 'B', text: question.options.B, verdict: 'supported', reason: '与当前详情一致。'}],
      sources: [evidence.source], needs_review: [], searched_at: new Date().toISOString()});
    assert.equal(answer.answer.status, 'verified');
    assert.equal(answer.answer.answer_labels[0], 'B');
    findings.push({id: 'unseen-entity-live-retrieval', passed: true, task: 'new parameter -> named result target -> scoped unique record -> detail popup -> actual evidence -> current option B',
      real_timing_seconds: answer.answer.timing.elapsed_seconds, confidence: answer.answer.confidence.score, pages: session.context.pages().length});
  } finally {
    await session?.close();
    server.close();
    const report = {kind: 'independent behavioral review on local HTTP fixtures', configured_max_pages: 3, default_max_pages: 5, run_dir: run, reviewed_at: new Date().toISOString(), findings};
    fs.writeFileSync(path.join(__dirname, 'forward-v24-review.json'), JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  }
})().catch(error => {process.stderr.write(error.stack + '\n'); process.exitCode = 1;});
