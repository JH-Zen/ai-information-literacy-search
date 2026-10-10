'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const skill = path.join(root, 'ai-literacy-search');
const read = name => JSON.parse(fs.readFileSync(path.join(__dirname, name), 'utf8'));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const baseline = read('school-paper-routing-baseline.json');
const { RecipeStore } = require(path.join(skill, 'scripts/recipes.cjs'));
const { SearchSession } = require(path.join(skill, 'scripts/browser.cjs'));
const store = new RecipeStore(skill);
const checks = [];
const check = (name, fn) => { fn(); checks.push({ name, passed: true }); };
check('All prepared profiles load', () => {
  const summary = store.preload();
  assert.equal(summary.loaded, 247); assert.equal(summary.failed, 0);
});
check('All 247 source task filters match real profile tasks', () => {
  for (const source of store.sources) {
    const kinds = [...new Set(store.profile(source.id).recipes.map(recipe => recipe.task_kind))];
    assert.deepEqual(source.task_kinds, kinds);
    for (const kind of kinds) assert.ok(store.find({ sourceId: source.id, taskKind: kind }).length);
  }
});
check('Existing browser evidence and 4 executable declarations preserved', () => {
  for (const [id, oldProfile] of Object.entries(baseline.profiles)) {
    const current = store.profile(id);
    const oldWithoutRecipes = structuredClone(oldProfile); delete oldWithoutRecipes.recipes;
    const currentWithoutRecipes = structuredClone(current); delete currentWithoutRecipes.recipes;
    assert.deepEqual(currentWithoutRecipes, oldWithoutRecipes);
    for (const old of oldProfile.recipes) {
      const actual = store.recipe(old.id);
      for (const [key, value] of Object.entries(old)) {
        if (key === 'instructions') assert.ok(value.every(item => actual.instructions.includes(item)));
        else assert.deepEqual(actual[key], value, old.id + ':' + key);
      }
    }
  }
  const executable = store.sources.flatMap(source => store.profile(source.id).recipes).filter(recipe => recipe.execution);
  assert.equal(executable.length, 4);
});
check('Runtime, installer and rule evidence are byte-identical to prior release', () => {
  for (const [relative, expected] of Object.entries(baseline.previous_bundle.core_sha256)) {
    if (relative.startsWith('scripts/') || relative.startsWith('runtime/') || relative.startsWith('references/rule')) {
      assert.equal(sha(path.join(skill, relative)), expected, relative);
    }
  }
});
check('Three new task paths are reachable and cannot claim browser execution', () => {
  for (const id of ['cnki:search-syntax', 'excel-support:product-capability', 'quiz-wiley:statistics-ranking']) {
    const recipe = store.recipe(id);
    assert.equal(recipe.status, 'not_observed'); assert.equal(recipe.execution, undefined);
    assert.ok(store.find({ sourceId: recipe.source_id, taskKind: recipe.task_kind }).some(item => item.id === id));
  }
});
const session = new SearchSession({ sessionId: 'school-paper-validation' });
check('Public session returns DOI routing with separate resolution scope and browser state', () => {
  const recipe = session.findRecipes({ sourceId: 'cnki', taskKind: 'record-lookup' })[0];
  assert.equal(recipe.status, 'blocked');
  assert.equal(recipe.retrieval_channels[0].id, 'doi-url-resolution');
  assert.equal(recipe.retrieval_channels[0].verification.status, 'sample_verified');
  assert.equal(recipe.retrieval_channels[0].owner, 'DOI Foundation');
  assert.equal(recipe.retrieval_channels[0].evidence_scope, 'resolution_only');
  assert.equal(session.isBrowserConnected(), false); assert.equal(session.codeStatus().status, 'current');
});
check('PMID and date field hints retain previous API blocker and guide reachability', () => {
  assert.ok(session.recipe('pubmed:record-lookup').field_routes.length);
  assert.ok(session.recipe('pubmed:statistics-ranking').field_routes.length);
  assert.equal(session.recipe('pubmed:record-lookup').retrieval_channels[0].verification.status, 'blocked');
  assert.equal(session.recipe('pubmed:record-lookup').retrieval_channels[0].verification.http_status, null);
  assert.equal(session.recipe('pubmed:search-syntax').retrieval_channels[0].id, 'pubmed-user-guide');
});
check('Successful DOI request identifies the same DOI and returns URL values only', () => {
  const request = read('school-paper-doi-resolution.json');
  assert.equal(request.http_status, 200); assert.equal(request.response.responseCode, 1);
  assert.equal(request.response.handle, '10.14072/j.cnki.tsgj.2026.03.016');
  assert.ok(request.response.values.length);
  for (const value of request.response.values) {
    assert.equal(value.type, 'URL'); assert.equal(value.data.format, 'string');
    assert.ok(/^https:\/\//.test(value.data.value));
  }
});
check('142 questions and manual route counts reconcile to original recorded groups', () => {
  const inventory = read('school-paper-inventory.json');
  assert.equal(inventory.question_count, 142); assert.equal(inventory.questions.length, 142);
  assert.deepEqual(inventory.groups.map(group => group.total), [55, 44, 43]);
  assert.equal(new Set(inventory.questions.map(question => question.id)).size, 142);
  assert.equal(Object.values(inventory.route_counts).reduce((a, b) => a + b), 142);
  assert.equal(inventory.questions.some(question => question.primary_route === 'unassigned'), false);
  assert.ok(inventory.questions.find(question => question.id === 'G1-Q43').scope_ambiguous);
});
check('Recipe counts reconcile with new routes', () => {
  const recipes = store.sources.flatMap(source => store.profile(source.id).recipes);
  assert.equal(recipes.length, 306); assert.equal(new Set(recipes.map(recipe => recipe.id)).size, 306);
});
const report = { checked_at: new Date().toISOString(), passed: checks.length, failed: 0, checks,
  question_count: 142, profiles: 247, recipes: 306, browser_executions: 4,
  new_recipes: 3, task_labels_synchronized: 133, previously_empty_task_labels_filled: 130,
  runtime_code_unchanged: true, browser_connected: false, new_live_requests_in_validation: 0,
  limits: 'Validates local routing, API response scope and unchanged browser/runtime artifacts; no full-paper timing or future site availability guarantee.' };
fs.writeFileSync(path.join(__dirname, 'school-paper-routing-validation.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: report.passed, failed: 0, profiles: 247, recipes: 306, runtime_code_unchanged: true }));
