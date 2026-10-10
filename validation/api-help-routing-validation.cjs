'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const skill = path.join(root, 'ai-literacy-search');
const read = relative => JSON.parse(fs.readFileSync(path.join(__dirname, relative), 'utf8'));
const baseline = read('api-help-routing-baseline.json');
const { RecipeStore } = require(path.join(skill, 'scripts/recipes.cjs'));
const { SearchSession } = require(path.join(skill, 'scripts/browser.cjs'));
const checks = [];
const check = (name, fn) => { fn(); checks.push({ name, passed: true }); };
const store = new RecipeStore(skill);
check('All prepared profiles load through actual RecipeStore', () => {
  const loaded = store.preload();
  assert.equal(loaded.indexed, 247); assert.equal(loaded.loaded, 247); assert.equal(loaded.failed, 0);
});
for (const [sourceId, original] of Object.entries(baseline.profiles)) {
  check(sourceId + ': browser observations, execution and identity preserved', () => {
    const actual = store.profile(sourceId);
    actual.recipes = actual.recipes.filter(recipe => original.recipes.some(item => item.id === recipe.id));
    delete actual.status_scope;
    for (let i = 0; i < actual.recipes.length; i++) {
      if (actual.recipes[i].retrieval_channels) actual.recipes[i].instructions.shift();
      delete actual.recipes[i].retrieval_channels;
      delete actual.recipes[i].status_scope;
    }
    assert.deepEqual(actual, original);
  });
}
check('Runtime and installer files are byte-identical to pre-update snapshot', () => {
  for (const [relative, expected] of Object.entries(baseline.runtime_hashes)) {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(skill, relative))).digest('hex');
    assert.equal(actual, expected, relative);
  }
});
const session = new SearchSession({ sessionId: 'api-help-routing-validation' });
check('Public session API returns only relevant task channels without connecting browser', () => {
  for (const [sourceId, kind, channelId] of [
    ['crossref', 'record-lookup', 'crossref-public-doi'],
    ['quiz-data-worldbank-org', 'record-lookup', 'worldbank-indicators-v2'],
    ['pubmed', 'record-lookup', 'pubmed-eutilities'],
    ['pubmed', 'search-syntax', 'pubmed-user-guide'],
    ['wanfang', 'search-syntax', 'wanfang-expression-guide'],
    ['cnki', 'official-guidance', 'cnki-helpcenter'],
    ['vip', 'search-syntax', 'vip-current-search-guide']]) {
    const matches = session.findRecipes({ sourceId, taskKind: kind });
    assert.equal(matches.length, 1);
    assert.equal(matches[0].retrieval_channels[0].id, channelId);
    assert.deepEqual(session.recipe(matches[0].id), matches[0]);
  }
  assert.equal(session.findRecipes({ sourceId: 'arxiv', taskKind: 'pdf-inspection' })[0].retrieval_channels, undefined);
  assert.equal(session.isBrowserConnected(), false);
  assert.equal(session.codeStatus().status, 'current');
});
check('Index task filters retain existing record routes and official World Bank API domain', () => {
  for (const sourceId of ['crossref', 'quiz-data-worldbank-org']) {
    assert.ok(store.sources.find(source => source.id === sourceId).task_kinds.includes('record-lookup'));
  }
  const worldbank = session.sources.find(source => source.id === 'quiz-data-worldbank-org');
  assert.ok(worldbank.domains.includes('api.worldbank.org'));
  assert.ok(worldbank.domains.includes('datahelpdesk.worldbank.org'));
});
check('Source/task reads retain independent API failures and observed browser status', () => {
  const crossref = store.recipe('crossref:record-lookup');
  assert.equal(crossref.status, 'blocked'); assert.equal(crossref.retrieval_channels[0].verification.status, 'sample_verified');
  assert.equal(store.recipe('pubmed:record-lookup').retrieval_channels[0].verification.http_status, null);
  assert.equal(store.recipe('arxiv:record-lookup').retrieval_channels[0].verification.http_status, 429);
  for (const id of ['wanfang:search-syntax', 'cnki:official-guidance']) {
    assert.deepEqual(store.recipe(id).retrieval_channels[0].supported_questions, []);
  }
});
check('VIP syntax lookup exposes official guide without a statistical browser execution', () => {
  const recipe = session.findRecipes({ sourceId: 'vip', taskKind: 'search-syntax' })[0];
  assert.equal(recipe.status, 'not_observed'); assert.equal(recipe.execution, undefined);
  assert.equal(recipe.retrieval_channels[0].verification.status, 'content_observed');
  assert.ok(store.sources.find(source => source.id === 'vip').task_kinds.includes('search-syntax'));
  assert.equal(store.recipe('vip:statistics-ranking').status, 'query_verified');
  assert.ok(store.recipe('vip:statistics-ranking').execution);
});
check('Returned channel objects cannot mutate prepared cached routes', () => {
  store.recipe('crossref:record-lookup').retrieval_channels[0].verification.status = 'mutated';
  session.findRecipes({ sourceId: 'pubmed', taskKind: 'record-lookup' })[0].retrieval_channels[0].endpoints.length = 0;
  assert.equal(store.recipe('crossref:record-lookup').retrieval_channels[0].verification.status, 'sample_verified');
  assert.equal(session.recipe('pubmed:record-lookup').retrieval_channels[0].endpoints.length, 3);
});
check('Original API evidence has matching identity/conditions, and failures contain no result', () => {
  const requests = read('api-help-crossref-pubmed.json').requests;
  const crossref = requests.find(request => request.source === 'Crossref');
  assert.equal(crossref.http_status, 200); assert.equal(crossref.response_fields.DOI, crossref.parameters.doi);
  assert.ok(crossref.response_fields.title[0]); assert.ok(crossref.retrieved_at);
  for (const pubmed of requests.filter(request => request.source === 'PubMed')) {
    assert.equal(pubmed.http_status, null); assert.equal(pubmed.response_fields == null, true);
  }
  const wb = read('api-help-worldbank-request.json');
  assert.equal(wb.http_status, 200); assert.equal(wb.response[0].sourceid, String(wb.query.source));
  assert.equal(wb.response[1][0].countryiso3code, wb.query.country);
  assert.equal(wb.response[1][0].indicator.id, wb.query.indicator);
  assert.equal(wb.response[1][0].date, wb.query.date);
  assert.equal(typeof wb.response[1][0].value, 'number');
  const arxiv = read('api-help-arxiv-request.json');
  assert.equal(arxiv.http_status, 429); assert.equal(arxiv.response, undefined);
});
const report = { checked_at: new Date().toISOString(), passed: checks.length, failed: 0, checks,
  profiles: 247, recipes: store.sources.reduce((total, source) => total + store.profile(source.id).recipes.length, 0),
  profiles_updated: Object.keys(baseline.profiles).length,
  recipes_with_channels: store.sources.flatMap(source => store.profile(source.id).recipes).filter(recipe => recipe.retrieval_channels).length,
  runtime_code_unchanged: true, browser_status_preserved: true, browser_connected: false,
  new_live_requests_issued_by_validation: 0,
  retained_prior_behavior_checks: 296, prior_behavior_checks_rerun: false,
  scope: 'Channel reachability, task filtering, original API evidence and unchanged runtime/browser observations; does not prove future website availability or Codex UI speed.' };
fs.writeFileSync(path.join(__dirname, 'api-help-routing-validation.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: report.passed, failed: 0, profiles: report.profiles, recipes: report.recipes,
  recipes_with_channels: report.recipes_with_channels, runtime_code_unchanged: true }));
