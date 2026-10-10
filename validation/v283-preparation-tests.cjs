#!/usr/bin/env node
'use strict';

// Headed Chrome and local HTTP only. All browser contexts and profiles belong
// to this test run; the user's daemon and existing browser are never accessed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const crypto = require('node:crypto');

const originalRoot = path.resolve(__dirname, '../ai-literacy-search');
const reportFile = path.join(__dirname, 'v283-preparation-tests.json');
const report = { started_at: new Date().toISOString(),
  kind: 'actual SearchSession; visible test-owned Chrome; local HTTP fixtures; isolated asset copies',
  user_daemon_accessed: false, public_sites_requested: false, tests: [] };
const contexts = [], sessions = [], requests = [], blockedRequests = [];
let runDir, copiedRoot, server, baseURL, SearchSession, VERSION, chromium, launchOriginal;
let launchCount = 0, primary, restoreSeed = false, restoredPages = [];
const defaultIds = ['prep-one', 'prep-two', 'prep-three', 'prep-four', 'prep-five'];
const hashFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const writeJSON = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');

async function test(name, fn) {
  try {
    const detail = await fn();
    report.tests.push({ name, passed: true, ...(detail ? { detail } : {}) });
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    report.tests.push({ name, passed: false, error: error.stack || String(error) });
    process.stdout.write(`FAIL ${name}: ${error.message}\n`);
  }
}

function fixtureSource(id) {
  const route = id === 'failure' ? 'failure' : id === 'preflight-login' ? 'login/preflight' : 'site/' + id;
  return { id, name: `Test-owned ${id}`, url: `${baseURL}/${route}`,
    domains: ['127.0.0.1'] };
}
function newSession(id, overrides = {}) {
  const outputDir = path.join(runDir, id);
  const created = new SearchSession({ sessionId: id, outputDir,
    profileDir: path.join(outputDir, 'profile'),
    runtimeDir: process.env.AI_LITERACY_RUNTIME_DIR || path.join(os.homedir(), '.ailiteracy-runtime'),
    maxPages: 2, navigationTimeoutMs: 2500, ...overrides });
  sessions.push(created);
  return created;
}
function siteId(site) { return site.source_id || site.id; }
function assertSummary(summary, ids, { opened = 0, reused = 0, failed = 0 } = {}) {
  assert.equal(summary.browser_connected, true);
  assert.equal(summary.sites_total, ids.length);
  assert.equal(summary.sites_opened, opened);
  assert.equal(summary.sites_reused, reused);
  assert.equal(summary.sites_failed, failed);
  assert.equal(summary.sites_opened + summary.sites_reused + summary.sites_failed, summary.sites_total);
  assert.equal(summary.sites.length, ids.length);
  assert.deepEqual(summary.sites.map(siteId).sort(), [...ids].sort());
  for (const site of summary.sites) assert.ok(['opened', 'reused', 'failed'].includes(site.status));
  assert.equal(summary.sites.filter(site => site.status === 'opened').length, opened);
  assert.equal(summary.sites.filter(site => site.status === 'reused').length, reused);
  assert.equal(summary.sites.filter(site => site.status === 'failed').length, failed);
}
function preparationPage(id) {
  assert.ok(primary.preparationPages instanceof Map);
  const page = primary.preparationPages.get(id);
  assert.ok(page && !page.isClosed(), `Missing live preparation page: ${id}`);
  assert.equal(Boolean(primary.life(page).preparation), true);
  return page;
}
function assertPreparationsUnchanged(previous) {
  for (const [id, page] of previous) {
    assert.equal(page.isClosed(), false, `${id} closed`);
    assert.equal(primary.preparationPages.get(id), page, `${id} replaced`);
  }
}
function taskPages(session = primary) {
  const pages = session.taskPages();
  assert.ok(Array.isArray(pages));
  assert.ok(pages.every(page => !page.isClosed() && !session.life(page).preparation));
  return pages;
}

async function main() {
  await test('默认常用站名单包含5个有效唯一来源', async () => {
    const catalog = readJSON(path.join(originalRoot, 'references/sources.json'));
    const ids = catalog.profile.preparation_source_ids;
    assert.ok(Array.isArray(ids));
    assert.equal(ids.length, 5);
    assert.equal(new Set(ids).size, 5);
    assert.ok(ids.every(id => catalog.sources.some(source => source.id === id)));
    return { preparation_source_ids: ids, browser_started: false };
  });

  await test('首次并发start/prepare只启动一个可见Chrome且每站只打开一次', async () => {
    primary = newSession('shared-preparation');
    const beforeLaunch = launchCount, beforeRequests = requests.length;
    const pending = Array.from({ length: 6 }, () => primary.prepare());
    await Promise.all([primary.start(), ...pending, primary.start()]);
    const summaries = await Promise.all(pending);
    assert.equal(launchCount - beforeLaunch, 1);
    for (const summary of summaries) assertSummary(summary, defaultIds, { opened: 5 });
    assert.equal(primary.options.headless, false);
    for (const id of defaultIds) {
      const page = preparationPage(id);
      assert.equal(page.url(), fixtureSource(id).url);
      assert.equal(requests.slice(beforeRequests).filter(req => req.path === `/site/${id}`).length, 1);
    }
    assert.equal(primary.preparationPages.size, 5);
    assert.equal(taskPages().length, 0);
    const agent = await preparationPage('prep-one').evaluate(() => navigator.userAgent);
    assert.match(agent, /Chrome\//); assert.doesNotMatch(agent, /HeadlessChrome|Edg\//);
    return { browser_launches: 1, retained_common_pages: 5, task_limit: primary.maxPages };
  });

  await test('重复prepare保留人工登录页面、填写内容、当前URL和cookie', async () => {
    const page = preparationPage('prep-one'), context = primary.context;
    await page.goto(baseURL + '/login/one?return=edited#manual');
    await page.locator('#username').fill('test-owned-user');
    await page.locator('#password').fill('test-owned-password');
    await page.locator('#note').fill('keep manual input');
    await context.addCookies([{ name: 'v283_login', value: 'test-owned-only', url: baseURL,
      expires: Math.floor(Date.now() / 1000) + 3600 }]);
    const previous = new Map(primary.preparationPages), beforeRequests = requests.length, beforeLaunch = launchCount;
    const summary = await primary.prepare();
    assertSummary(summary, defaultIds, { reused: 5 });
    assert.equal(primary.context, context); assert.equal(launchCount, beforeLaunch);
    assert.equal(requests.length, beforeRequests); assertPreparationsUnchanged(previous);
    assert.equal(page.url(), baseURL + '/login/one?return=edited#manual');
    assert.equal(await page.locator('#username').inputValue(), 'test-owned-user');
    assert.equal(await page.locator('#password').inputValue(), 'test-owned-password');
    assert.equal(await page.locator('#note').inputValue(), 'keep manual input');
    assert.equal((await context.cookies(baseURL)).find(cookie => cookie.name === 'v283_login').value, 'test-owned-only');
  });

  await test('常用站被人工关闭后仅补该站，其余4站复用', async () => {
    const old = preparationPage('prep-three'), previous = new Map(primary.preparationPages);
    await old.close(); previous.delete('prep-three');
    const beforeRequests = requests.length, summary = await primary.prepare();
    assertSummary(summary, defaultIds, { opened: 1, reused: 4 });
    assert.notEqual(preparationPage('prep-three'), old); assertPreparationsUnchanged(previous);
    assert.deepEqual(requests.slice(beforeRequests).map(req => req.path), ['/site/prep-three']);
  });

  await test('releasePage收到常用登录页时不清空、不关闭、不改变填写', async () => {
    const page = preparationPage('prep-one'), url = page.url(), beforeRequests = requests.length;
    await primary.releasePage(page);
    assert.equal(page.isClosed(), false); assert.equal(page.url(), url);
    assert.equal(await page.locator('#note').inputValue(), 'keep manual input');
    assert.equal(Boolean(primary.life(page).preparation), true);
    assert.equal(primary.preparationPages.get('prep-one'), page);
    assert.equal(requests.length, beforeRequests);
    assert.notEqual(primary.parkingPage, page);
  });

  await test('prepare参数覆盖常用名单，空数组零开站并保留已有页面', async () => {
    const previous = new Map(primary.preparationPages), beforeRequests = requests.length;
    assertSummary(await primary.prepare({ sourceIds: ['prep-one', 'prep-two'] }), ['prep-one', 'prep-two'], { reused: 2 });
    assertSummary(await primary.prepare({ sourceIds: [] }), []);
    assert.equal(requests.length, beforeRequests); assertPreparationsUnchanged(previous);
    assert.equal(primary.isBrowserConnected(), true);
  });

  await test('题目任务另建页面而常用登录页保留，cookie由同context共享', async () => {
    const prep = preparationPage('prep-one'), previous = new Map(primary.preparationPages);
    const page = await primary.page('prep-one');
    assert.notEqual(page, prep); assert.equal(page.context(), primary.context);
    assert.equal(Boolean(primary.life(page).preparation), false);
    assert.equal(page.url(), fixtureSource('prep-one').url);
    assertPreparationsUnchanged(previous);
    assert.equal(prep.url(), baseURL + '/login/one?return=edited#manual');
    assert.equal((await page.context().cookies(baseURL)).find(cookie => cookie.name === 'v283_login').value, 'test-owned-only');
    assert.equal(taskPages().length, 1);
  });

  await test('5个常用页与2个任务名额并存，第三任务只淘汰任务页', async () => {
    const previous = new Map(primary.preparationPages), first = primary.pages.get('prep-one');
    const second = await primary.page('task-one');
    assert.equal(taskPages().length, 2); assert.equal(first.isClosed(), false);
    const third = await primary.page('task-two');
    assert.equal(third.isClosed(), false); assert.equal(taskPages().length, 2);
    assert.ok(first.isClosed() || second.isClosed()); assertPreparationsUnchanged(previous);
    assert.ok(primary.context.pages().length >= defaultIds.length + primary.maxPages);
    return { common_pages: 5, live_task_pages: 2 };
  });

  await test('人工常用页产生的popup继承常驻属性，不受总页数淘汰', async () => {
    const prep = preparationPage('prep-two'), previous = new Map(primary.preparationPages);
    const popupEvent = primary.context.waitForEvent('page');
    await prep.locator('#popup').click();
    const popup = await popupEvent; await popup.waitForLoadState('domcontentloaded');
    assert.equal(popup.isClosed(), false); assert.equal(Boolean(primary.life(popup).preparation), true);
    assert.equal(taskPages().includes(popup), false);
    assert.equal(await popup.locator('#username').count(), 1);
    await popup.locator('#username').fill('manual popup state');
    await primary.page('task-three');
    assert.equal(popup.isClosed(), false); assert.equal(await popup.locator('#username').inputValue(), 'manual popup state');
    assertPreparationsUnchanged(previous); assert.equal(taskPages().length, 2);
    await popup.close();
  });

  await test('单站导航失败返回partial，其他新站与原常用页仍保留', async () => {
    const previous = new Map(primary.preparationPages), context = primary.context;
    const summary = await primary.prepare({ sourceIds: ['prep-one', 'failure', 'prep-extra'] });
    assertSummary(summary, ['prep-one', 'failure', 'prep-extra'], { opened: 1, reused: 1, failed: 1 });
    assert.equal(summary.status, 'partial'); assert.equal(primary.context, context);
    assert.equal(primary.isBrowserConnected(), true); assertPreparationsUnchanged(previous);
    assert.equal(preparationPage('prep-extra').url(), fixtureSource('prep-extra').url);
    assert.equal(summary.sites.find(site => siteId(site) === 'failure').status, 'failed');
  });

  await test('构造prepareSourceIds覆盖catalog默认，单次prepare可再覆盖', async () => {
    const created = newSession('constructor-override', { prepareSourceIds: ['prep-two'] });
    const beforeRequests = requests.length;
    assertSummary(await created.prepare(), ['prep-two'], { opened: 1 });
    assert.equal(created.preparationPages.size, 1);
    assert.deepEqual(requests.slice(beforeRequests).map(req => req.path), ['/site/prep-two']);
    assertSummary(await created.prepare({ sourceIds: ['prep-four'] }), ['prep-four'], { opened: 1 });
    assertSummary(await created.prepare(), ['prep-two'], { reused: 1 });
    const context = created.context, pages = context.pages(), beforeEmpty = requests.length;
    assertSummary(await created.prepare({ sourceIds: [] }), []);
    assert.equal(created.context, context); assert.deepEqual(context.pages(), pages); assert.equal(requests.length, beforeEmpty);
    await created.close();
  });

  await test('恢复多个真实非空白页时不关闭、不重导航，零开站仍保持Chrome', async () => {
    // Chrome's restore-on-start preference varies by machine. Seed real pages
    // in the launch adapter before SearchSession receives the new context.
    // No page/context API is mocked, so _startBrowser processes real restored
    // tabs through its normal startup path deterministically.
    const previous = primary.context, beforeLaunch = launchCount;
    await previous.close(); restoreSeed = true;
    const summary = await primary.prepare({ sourceIds: [] });
    assertSummary(summary, []); assert.equal(summary.reused_live_session, false);
    assert.equal(launchCount - beforeLaunch, 1); assert.notEqual(primary.context, previous);
    assert.equal(restoredPages.length, 2);
    for (const [index, page] of restoredPages.entries()) {
      assert.equal(page.isClosed(), false); assert.equal(Boolean(primary.life(page).preparation), true);
      assert.equal(page.url(), baseURL + '/restored/' + (index + 1));
      assert.equal(await page.locator('#note').inputValue(), `restored state ${index + 1}`);
      assert.equal(taskPages().includes(page), false);
    }
    assert.equal(primary.isBrowserConnected(), true);
    assert.equal((await primary.context.cookies(baseURL)).find(cookie => cookie.name === 'v283_login').value, 'test-owned-only');
    return { real_nonblank_restore_fixtures: 2, restored_pages_closed: 0 };
  });

  await test('恢复后只借about:blank作为任务页，不覆盖非空白恢复页', async () => {
    const page = await primary.page('task-one');
    assert.ok(!restoredPages.includes(page)); assert.equal(Boolean(primary.life(page).preparation), false);
    assert.equal(page.url(), fixtureSource('task-one').url);
    for (const [index, restored] of restoredPages.entries()) {
      assert.equal(restored.isClosed(), false); assert.equal(restored.url(), baseURL + '/restored/' + (index + 1));
      assert.equal(await restored.locator('#note').inputValue(), `restored state ${index + 1}`);
    }
    assert.equal(primary.parkingPage === undefined || primary.parkingPage.isClosed() || primary.parkingPage.url() === 'about:blank', true);
    assert.equal(taskPages().length, 1);
  });

  await test('人工导航过的parking页转为常驻，acquirePage不将它重导航清空', async () => {
    // Obtain/release an ordinary spare page through the real allocator, then
    // simulate the human navigating its visible tab before the next task.
    const parked = await primary.acquirePage(); await primary.releasePage(parked);
    assert.equal(primary.parkingPage, parked); assert.equal(parked.url(), 'about:blank');
    await parked.goto(baseURL + '/manual-parking');
    await parked.locator('#note').fill('human-owned parking state');
    const page = await primary.page('task-two');
    assert.notEqual(page, parked); assert.equal(parked.isClosed(), false);
    assert.equal(parked.url(), baseURL + '/manual-parking');
    assert.equal(await parked.locator('#note').inputValue(), 'human-owned parking state');
    assert.equal(Boolean(primary.life(parked).preparation), true);
    assert.equal(taskPages().includes(parked), false); assert.equal(taskPages().length, 2);
  });

  await test('准备完成后浏览器持续连接，重复零开站不改变任何保留页', async () => {
    const context = primary.context, pages = context.pages(), urls = pages.map(page => page.url());
    const beforeRequests = requests.length, beforeLaunch = launchCount;
    assertSummary(await primary.prepare({ sourceIds: [] }), []);
    assert.equal(primary.context, context); assert.equal(primary.isBrowserConnected(), true);
    assert.deepEqual(context.pages(), pages); assert.deepEqual(context.pages().map(page => page.url()), urls);
    assert.equal(requests.length, beforeRequests); assert.equal(launchCount, beforeLaunch);
  });

  await test('满5个任务页的人工登录popup无tool transition时仍保留并转常驻', async () => {
    const previousLimit = primary.maxPages;
    primary.maxPages = 5;
    let popup;
    try {
      for (const id of ['task-one', 'task-two', 'task-three', 'task-four', 'task-five']) await primary.page(id);
      assert.equal(taskPages().length, 5); assert.equal(primary.activeTransitions.size, 0);
      const opener = primary.pages.get('task-one'), popupEvent = primary.context.waitForEvent('page');
      assert.equal(Boolean(primary.life(opener).preparation), false);
      await opener.locator('#popup').click();
      popup = await popupEvent; await popup.waitForLoadState('domcontentloaded');
      assert.equal(popup.isClosed(), false); assert.equal(Boolean(primary.life(popup).preparation), true);
      assert.equal(taskPages().length, 5); assert.equal(taskPages().includes(popup), false);
      await popup.locator('#username').fill('manual task-page SSO');
      assert.equal(await popup.locator('#username').inputValue(), 'manual task-page SSO');
      return { live_task_pages: 5, active_tool_transitions: 0, login_popup_retained: true };
    } finally {
      if (popup && !popup.isClosed()) await popup.close();
      for (const page of taskPages()) await page.close();
      primary.maxPages = previousLimit;
    }
  });

  await test('临时登录页releasePage通过实际授权分类保留URL和填写', async () => {
    const page = await primary.context.newPage();
    await page.goto(baseURL + '/login/temporary');
    await page.locator('#username').fill('temporary login state');
    assert.equal(Boolean(primary.life(page).preparation), false);
    const beforeRequests = requests.length;
    await primary.releasePage(page);
    assert.equal(page.isClosed(), false); assert.equal(page.url(), baseURL + '/login/temporary');
    assert.equal(await page.locator('#username').inputValue(), 'temporary login state');
    assert.equal(Boolean(primary.life(page).preparation), true);
    assert.equal(primary.life(page).protected, true); assert.notEqual(primary.parkingPage, page);
    assert.equal(requests.length, beforeRequests);
    await page.close();
  });

  await test('preflight遇到登录后为下一站新建任务页，原URL和表单不被覆盖', async () => {
    let loginPage, nextPage;
    await primary.preflight({ sourceIds: ['preflight-login', 'preflight-normal'], onProgress: async ({ entry }) => {
      if (entry.source_id === 'preflight-login') {
        loginPage = primary.context.pages().find(page => page.url() === fixtureSource('preflight-login').url);
        assert.ok(loginPage); await loginPage.locator('#username').fill('preflight human login');
        await loginPage.locator('#note').fill('do not reuse this page');
      } else if (entry.source_id === 'preflight-normal') {
        nextPage = primary.context.pages().find(page => page.url() === fixtureSource('preflight-normal').url);
        assert.ok(nextPage); assert.notEqual(nextPage, loginPage);
      }
    } });
    assert.ok(loginPage && nextPage); assert.equal(loginPage.isClosed(), false);
    assert.equal(loginPage.url(), fixtureSource('preflight-login').url);
    assert.equal(await loginPage.locator('#username').inputValue(), 'preflight human login');
    assert.equal(await loginPage.locator('#note').inputValue(), 'do not reuse this page');
    assert.equal(Boolean(primary.life(loginPage).preparation), true);
    assert.equal(primary.life(loginPage).protected, true); assert.notEqual(primary.parkingPage, loginPage);
    await loginPage.close();
  });

  await test('finishTransition额外外域SSO页由真实classify识别并保留', async () => {
    const previousLimit = primary.maxPages; primary.maxPages = 5;
    let fromPage, resultPage, extra;
    const q = { id: 'fixture-extra-sso', type: 'single', question: '检索测试记录SSO-CASE。', options: { A: '记录', B: '其他' } };
    primary.beginQuestion(q);
    const actionId = 'fixture-extra-sso-action';
    try {
      fromPage = await primary.page('transition-origin');
      const operation = { actionId, sourceId: 'transition-origin', questionId: q.id,
        attempt: primary.activeQuestion.attempt, fromPage, toRole: 'results', query: 'SSO-CASE',
        expected: 'SSO-CASE', filters: {}, options: { mode: 'popup',
          match: { css: '#echo' }, container: { css: '#results' } }, candidates: new Set() };
      // Keep the actual operation active while opening its candidate pages so
      // the human-popup branch cannot pre-mark the extra as preparation. This
      // targets finishTransition's own extra-page classification/cleanup path.
      primary.activeTransitions.set(actionId, operation);
      let event = primary.context.waitForEvent('page');
      await fromPage.evaluate(url => { window.open(url, '_blank'); }, baseURL + '/result');
      resultPage = await event; await resultPage.waitForLoadState('domcontentloaded');
      event = primary.context.waitForEvent('page');
      const foreignLoginURL = baseURL.replace('127.0.0.1', 'localhost') + '/login/extra-sso';
      await fromPage.evaluate(url => { window.open(url, '_blank'); }, foreignLoginURL);
      extra = await event; await extra.waitForLoadState('domcontentloaded');
      await extra.locator('#username').fill('extra foreign SSO state');
      assert.equal(Boolean(primary.life(extra).preparation), false);
      assert.equal(Boolean(primary.life(extra).protected), false);
      assert.equal(new URL(extra.url()).hostname, 'localhost');
      operation.candidates.add(resultPage); operation.candidates.add(extra);
      const result = await primary.finishTransition(operation, resultPage, 'ready');
      assert.equal(result.status, 'ready'); assert.equal(result.outcome, 'results');
      assert.equal(extra.isClosed(), false); assert.equal(extra.url(), foreignLoginURL);
      assert.equal(await extra.locator('#username').inputValue(), 'extra foreign SSO state');
      assert.equal(Boolean(primary.life(extra).preparation), true); assert.equal(primary.life(extra).protected, true);
      assert.equal(taskPages().includes(extra), false);
      return { result_domain: '127.0.0.1', extra_sso_domain: 'localhost', actual_extra_cleanup_path: true };
    } finally {
      primary.activeTransitions.delete(actionId); primary.finishQuestion(q);
      for (const page of [extra, resultPage, fromPage]) if (page && !page.isClosed()) await page.close();
      primary.maxPages = previousLimit;
    }
  });

  await test('未完成导航的about:blank SSO popup保留，而无opener空白页仍可释放', async () => {
    let opener, popup, rootBlank;
    const actionId = 'fixture-blank-sso-action';
    try {
      opener = await primary.page('task-one');
      primary.activeTransitions.set(actionId, { fromPage: opener });
      const event = primary.context.waitForEvent('page');
      await opener.evaluate(() => { window.open('about:blank', '_blank'); });
      popup = await event;
      assert.equal(popup.url(), 'about:blank'); assert.equal(await popup.opener(), opener);
      assert.equal(Boolean(primary.life(popup).preparation), false);
      assert.equal(await primary.preserveVerificationPage(popup), true);
      await primary.releasePage(popup);
      assert.equal(popup.isClosed(), false); assert.equal(popup.url(), 'about:blank');
      assert.equal(Boolean(primary.life(popup).preparation), true);
      assert.notEqual(primary.parkingPage, popup);
      rootBlank = await primary.context.newPage();
      assert.equal(await rootBlank.opener(), null);
      assert.equal(await primary.preserveVerificationPage(rootBlank), false);
      await primary.releasePage(rootBlank);
      assert.equal(Boolean(primary.life(rootBlank).preparation), false);
      assert.equal(rootBlank.isClosed() || primary.parkingPage === rootBlank, true);
      return { pending_blank_sso_retained: true, root_blank_still_releasable: true };
    } finally {
      primary.activeTransitions.delete(actionId);
      for (const page of [rootBlank, popup, opener]) if (page && !page.isClosed()) await page.close();
    }
  });

  await test('真实空正文页面不能排除未完成登录，release保留原页', async () => {
    const page = await primary.context.newPage();
    try {
      await page.goto(baseURL + '/empty-body');
      const observed = await primary.currentObservation(page, { detail: 'status', maintenance: true });
      assert.equal(observed.text.trim(), '');
      assert.equal(Boolean(primary.life(page).preparation), false);
      assert.equal(await primary.preserveVerificationPage(page), true);
      await primary.releasePage(page);
      assert.equal(page.isClosed(), false); assert.equal(page.url(), baseURL + '/empty-body');
      assert.equal(Boolean(primary.life(page).preparation), true);
      assert.notEqual(primary.parkingPage, page);
      return { actual_empty_dom_body: true, empty_body_retained: true };
    } finally { if (!page.isClosed()) await page.close(); }
  });
}

(async () => {
  try {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
      requests.push({ path: url.pathname, query: url.search });
      if (url.pathname === '/failure') { res.destroy(); return; }
      if (url.pathname === '/empty-body') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
          .end('<!doctype html><html><meta charset="utf-8"><title>Pending page</title><body></body></html>');
        return;
      }
      const login = url.pathname.startsWith('/login/') || url.pathname.startsWith('/popup');
      const body = url.pathname === '/result'
        ? '<h1>Local result</h1><main id="results"><output id="echo">SSO-CASE</output><article>Test-owned current record</article></main>'
        : `<h1>${login ? '登录 / Sign in' : 'Local fixture'}</h1>`
        + (login ? '<label for="username">用户名</label><input id="username"><label for="password">密码</label><input type="password" id="password">' : '')
        + '<label for="note">Working state</label><input id="note"><button id="popup" onclick="window.open(\'/popup\', \'_blank\')">Open helper window</button>';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        .end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Test-owned local site</title><body>${body}</body></html>`);
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); baseURL = `http://127.0.0.1:${server.address().port}`;
    runDir = fs.mkdtempSync(path.join(__dirname, 'v283-preparation-run-'));
    copiedRoot = path.join(runDir, 'managed-skill');
    for (const directory of ['scripts', 'references', 'runtime']) {
      fs.cpSync(path.join(originalRoot, directory), path.join(copiedRoot, directory), { recursive: true });
    }
    const originalCatalog = readJSON(path.join(copiedRoot, 'references/sources.json'));
    const allIds = [...defaultIds, 'prep-extra', 'failure', 'task-one', 'task-two', 'task-three',
      'task-four', 'task-five', 'preflight-login', 'preflight-normal', 'transition-origin'];
    writeJSON(path.join(copiedRoot, 'references/sources.json'), {
      profile: { ...originalCatalog.profile, preparation_source_ids: defaultIds, startup_preflight_source_ids: [] },
      sources: allIds.map(fixtureSource)
    });
    ({ SearchSession, VERSION } = require(path.join(copiedRoot, 'scripts/browser.cjs')));
    const runtimeDir = process.env.AI_LITERACY_RUNTIME_DIR || path.join(os.homedir(), '.ailiteracy-runtime');
    chromium = createRequire(path.join(runtimeDir, 'package.json'))('playwright').chromium;
    launchOriginal = chromium.launchPersistentContext;
    chromium.launchPersistentContext = async function (...args) {
      assert.ok(path.resolve(args[0]).startsWith(path.resolve(runDir) + path.sep), 'Only test-owned profiles may launch');
      assert.equal(args[1].headless, false);
      launchCount++;
      const context = await launchOriginal.apply(this, args); contexts.push(context);
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (['127.0.0.1', 'localhost'].includes(url.hostname) && url.port === String(server.address().port)) return route.continue();
        blockedRequests.push(url.origin); return route.abort();
      });
      if (restoreSeed) {
        restoreSeed = false; restoredPages = [];
        for (const index of [1, 2]) {
          const page = await context.newPage(); await page.goto(baseURL + '/restored/' + index);
          await page.locator('#note').fill('restored state ' + index); restoredPages.push(page);
        }
      }
      return context;
    };
    report.helper_version = VERSION; report.run_dir = runDir;
    report.managed_sources = ['scripts/browser.cjs', 'scripts/preparation.cjs', 'scripts/transitions.cjs', 'runtime/package.json']
      .map(relative => ({ path: path.join(originalRoot, relative), copied_sha256: hashFile(path.join(copiedRoot, relative)) }));
    await main();
  } catch (error) {
    report.tests.push({ name: 'test initialization', passed: false, error: error.stack || String(error) });
    process.stderr.write(String(error.stack || error) + '\n');
  } finally {
    // Never enumerate or terminate system Chrome processes; close only handles
    // obtained by our test-owned launch adapter.
    report.cleanup_errors = [];
    for (const context of [...new Set(contexts)].reverse()) {
      try { await context.close(); } catch (error) { report.cleanup_errors.push(String(error.message)); }
    }
    if (chromium && launchOriginal) chromium.launchPersistentContext = launchOriginal;
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    report.finished_at = new Date().toISOString(); report.browser_launches = launchCount;
    report.fixture_requests = requests; report.blocked_nonfixture_requests = blockedRequests;
    report.all_test_owned_browsers_closed = contexts.every(context => !context.browser()?.isConnected());
    report.passed = report.tests.filter(item => item.passed).length;
    report.failed = report.tests.filter(item => !item.passed).length;
    writeJSON(reportFile, report);
    process.stdout.write(`Results: ${report.passed} passed, ${report.failed} failed. ${reportFile}\n`);
    process.exitCode = report.failed || report.cleanup_errors.length ? 1 : 0;
  }
})();
