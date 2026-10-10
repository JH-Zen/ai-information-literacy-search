#!/usr/bin/env node
'use strict';

// Isolated cache checks. Fixtures are managed skill assets only; no Chrome,
// website queries, personal directories or installed copies are involved.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { FileAssetCache } = require('../ai-literacy-search/scripts/asset-cache.cjs');
const { RecipeStore } = require('../ai-literacy-search/scripts/recipes.cjs');
const { RuleStore, installLocalEvidence } = require('../ai-literacy-search/scripts/local-evidence.cjs');
const runDir = fs.mkdtempSync(path.join(__dirname, 'v28-cache-run-'));
const report = { version: '2.8.0', run_dir: runDir, started_at: new Date().toISOString(), tests: [] };
let sequence = 0, modified = 0;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const copy = value => structuredClone(value);

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'object' && !Buffer.isBuffer(data) ? JSON.stringify(data) : data);
  const timestamp = new Date(Date.now() + ++modified * 1000);
  fs.utimesSync(file, timestamp, timestamp);
}

function fixture() {
  const root = path.join(runDir, `fixture-${++sequence}`);
  const indexFile = path.join(root, 'references', 'search-index.json');
  const profileFile = id => path.join(root, 'references', 'sites', id + '.json');
  const profile = id => ({ version: '1', source_id: id, recipes: [{ id: `${id}:lookup`, source_id: id, task_kind: 'lookup', entry_url: `https://${id}.example.com`, selector: `#${id}` }] });
  const index = { version: '1', sources: ['alpha', 'beta'].map(id => ({ id, name: id, url: `https://${id}.example.com`, profile: `references/sites/${id}.json`, recipe_ids: [`${id}:lookup`] })) };
  write(indexFile, index);
  for (const source of index.sources) write(profileFile(source.id), profile(source.id));
  const rulesFile = path.join(root, 'references', 'rules.json');
  const artifactFile = id => path.join(root, 'references', 'rule-evidence', id + '.json');
  const evidence = id => ({ url: `https://${id}.example.com/help`, observed_at: '2026-10-10T00:00:00.000Z', excerpts: [`Verified claim for ${id}.`] });
  const card = id => ({ id, name: id, url: `https://${id}.example.com/help`, verified_at: '2026-10-10T00:00:00.000Z', status: 'verified', freshness: 'stable', scope: 'stable fact', exclusions: ['dynamic query'], claims: { fact: `${id} fact` }, artifacts: [{ path: `references/rule-evidence/${id}.json`, sha256: hash(fs.readFileSync(artifactFile(id))) }] });
  for (const id of ['alpha', 'beta']) write(artifactFile(id), evidence(id));
  const rules = { version: '1', rules: [card('alpha'), card('beta'), { id: 'draft', status: 'draft', freshness: 'stable' }] };
  write(rulesFile, rules);
  return { root, index, indexFile, profile, profileFile, rules, rulesFile, evidence, card, artifactFile };
}

function test(name, action) {
  try { const detail = action(); report.tests.push({ name, passed: true, ...(detail ? { detail } : {}) }); process.stdout.write(`PASS ${name}\n`); }
  catch (error) { report.tests.push({ name, passed: false, error: error.stack }); process.stdout.write(`FAIL ${name}: ${error.message}\n`); }
}

test('preload读取索引内全部流程与核验规则，不读取无索引文件', () => {
  const f = fixture(), outside = path.join(f.root, 'references', 'sites', 'not-indexed.json'); write(outside, 'broken json');
  const recipes = new RecipeStore(f.root), rules = new RuleStore(f.root);
  assert.deepEqual(recipes.preload(), { indexed: 2, loaded: 2, failed: 0, failures: [], index_sha256: recipes.hash });
  assert.deepEqual(rules.preload(), { indexed: 3, eligible: 2, loaded: 2, failed: 0, failures: [] });
  assert.equal(recipes.files.diagnostics().reads, 3); assert.equal(rules.files.diagnostics().reads, 3);
});

test('第二题缓存命中仅stat，无新增文件读取或hash；返回副本', () => {
  const f = fixture(), recipes = new RecipeStore(f.root), rules = new RuleStore(f.root); recipes.preload(); rules.preload();
  const recipeBefore = recipes.files.diagnostics(), ruleBefore = rules.files.diagnostics();
  const profile = recipes.profile('alpha'); profile.recipes[0].selector = '#forged';
  const recipe = recipes.recipe('alpha:lookup'); recipe.entry_url = 'https://forged.example.com';
  const card = rules.card('alpha'); card.claims.fact = 'forged'; card.artifacts[0].sha256 = '0'.repeat(64);
  assert.equal(recipes.find({ sourceId: 'alpha', taskKind: 'lookup' })[0].selector, '#alpha');
  assert.equal(rules.card('alpha').claims.fact, 'alpha fact');
  for (const [before, after] of [[recipeBefore, recipes.files.diagnostics()], [ruleBefore, rules.files.diagnostics()]]) {
    assert.equal(after.reads, before.reads); assert.equal(after.hashes, before.hashes); assert.ok(after.stats > before.stats); assert.ok(after.hits > before.hits);
  }
});

test('已缓存流程修改立即重载；其它网站仍命中', () => {
  const f = fixture(), recipes = new RecipeStore(f.root); recipes.preload(); const before = recipes.files.diagnostics().reads;
  const changed = f.profile('alpha'); changed.recipes[0].selector = '#new'; write(f.profileFile('alpha'), changed);
  assert.equal(recipes.recipe('alpha:lookup').selector, '#new'); assert.equal(recipes.recipe('beta:lookup').selector, '#beta');
  assert.equal(recipes.files.diagnostics().reads, before + 1);
});

test('损坏流程单站停用，不回退旧控件，不阻塞其它网站', () => {
  const f = fixture(), recipes = new RecipeStore(f.root); recipes.preload(); write(f.profileFile('alpha'), '{bad');
  const summary = recipes.preload(); assert.equal(summary.loaded, 1); assert.equal(summary.failed, 1); assert.equal(summary.failures[0].source_id, 'alpha');
  assert.throws(() => recipes.recipe('alpha:lookup')); assert.equal(recipes.recipe('beta:lookup').selector, '#beta');
  write(f.profileFile('alpha'), f.profile('alpha')); assert.equal(recipes.preload().loaded, 2);
});

test('修改后流程身份与重复recipe ID须重新校验', () => {
  const f = fixture(), recipes = new RecipeStore(f.root); recipes.preload(); const invalid = f.profile('alpha'); invalid.source_id = 'beta'; write(f.profileFile('alpha'), invalid);
  assert.throws(() => recipes.profile('alpha'), /identity/);
  invalid.source_id = 'alpha'; invalid.recipes.push(copy(invalid.recipes[0])); write(f.profileFile('alpha'), invalid); assert.throws(() => recipes.profile('alpha'), /unique/);
});

test('索引增删与流程重指向立即生效，旧recipe不再可用', () => {
  const f = fixture(), recipes = new RecipeStore(f.root); recipes.preload();
  const index = copy(f.index); index.sources = index.sources.filter(source => source.id !== 'beta'); index.sources.push({ id: 'gamma', profile: 'references/sites/gamma.json', recipe_ids: ['gamma:lookup'] });
  write(f.profileFile('gamma'), f.profile('gamma')); write(f.indexFile, index);
  assert.equal(recipes.preload().loaded, 2); assert.throws(() => recipes.recipe('beta:lookup'), /Unknown/); assert.equal(recipes.recipe('gamma:lookup').selector, '#gamma');
  const alias = f.profile('alpha'); alias.recipes[0].selector = '#repointed'; write(f.profileFile('alpha-alias'), alias); index.sources[0].profile = 'references/sites/alpha-alias.json'; write(f.indexFile, index);
  assert.equal(recipes.profile('alpha').recipes[0].selector, '#repointed');
});

test('损坏或已删除索引拒绝沿用旧目录，修复后恢复', () => {
  const f = fixture(), recipes = new RecipeStore(f.root); recipes.preload(); write(f.indexFile, { sources: [{ id: 'alpha' }, { id: 'alpha' }] });
  assert.equal(recipes.preload().failed, 1); assert.throws(() => recipes.recipe('alpha:lookup'), /unique/);
  fs.unlinkSync(f.indexFile); assert.throws(() => recipes.profile('alpha'));
  write(f.indexFile, f.index); assert.equal(recipes.preload().loaded, 2);
});

test('自定义内联recipes和recipeIndex保持兼容且不会读磁盘目录', () => {
  const inline = [{ id: 'custom:lookup', source_id: 'custom', task_kind: 'lookup' }];
  const store = new RecipeStore(path.join(runDir, 'missing-root'), { catalog: { sources: [] }, recipeIndex: { sources: [{ id: 'custom' }] }, recipes: inline });
  assert.equal(store.find({ sourceId: 'custom' }).length, 1); inline[0].id = 'mutated'; assert.equal(store.recipe('custom:lookup').id, 'custom:lookup');
  assert.equal(store.preload().loaded, 1); assert.equal(store.files.diagnostics().reads, 0);
});

test('证据同长度篡改并恢复mtime仍由ctime识别；单卡停用', () => {
  const f = fixture(), rules = new RuleStore(f.root); rules.preload(); const file = f.artifactFile('alpha'), stat = fs.statSync(file), raw = fs.readFileSync(file), tampered = Buffer.from(raw);
  const offset = tampered.indexOf('Verified'); tampered[offset] = 88; fs.writeFileSync(file, tampered); fs.utimesSync(file, stat.atime, stat.mtime);
  assert.throws(() => rules.card('alpha'), /changed/); assert.equal(rules.card('beta').claims.fact, 'beta fact');
  const summary = rules.preload(); assert.equal(summary.loaded, 1); assert.equal(summary.failed, 1); assert.equal(summary.failures[0].rule_id, 'alpha');
  write(file, raw); assert.equal(rules.card('alpha').claims.fact, 'alpha fact');
});

test('规则目录更新使旧卡内容失效；新核验卡从索引计数', () => {
  const f = fixture(), rules = new RuleStore(f.root); rules.preload();
  const catalog = copy(f.rules); catalog.rules[0].claims.fact = 'new alpha fact'; write(f.artifactFile('gamma'), f.evidence('gamma')); catalog.rules.push(f.card('gamma')); write(f.rulesFile, catalog);
  assert.equal(rules.card('alpha').claims.fact, 'new alpha fact'); assert.equal(rules.preload().eligible, 3); assert.equal(rules.preload().loaded, 3);
  catalog.rules[0].status = 'draft'; write(f.rulesFile, catalog); assert.throws(() => rules.card('alpha'), /unverified/); assert.equal(rules.preload().loaded, 2);
});

test('hash正确但原始观察URL不符仍停用，仅影响该卡', () => {
  const f = fixture(), rules = new RuleStore(f.root); rules.preload(); const observation = f.evidence('alpha'); observation.url = 'https://incorrect.example.com'; write(f.artifactFile('alpha'), observation);
  const catalog = copy(f.rules); catalog.rules[0].artifacts[0].sha256 = hash(fs.readFileSync(f.artifactFile('alpha'))); write(f.rulesFile, catalog);
  assert.throws(() => rules.card('alpha'), /provenance/); assert.equal(rules.preload().loaded, 1);
});

test('规则目录损坏后不得返回旧卡，修复后重新验证', () => {
  const f = fixture(), rules = new RuleStore(f.root); rules.preload(); write(f.rulesFile, '{bad'); assert.equal(rules.preload().loaded, 0); assert.throws(() => rules.card('alpha'));
  write(f.rulesFile, f.rules); assert.equal(rules.preload().loaded, 2);
});

test('缓存只允许管理目录内真实文件，禁止路径与符号链接逃逸', () => {
  const f = fixture(), cache = new FileAssetCache(); assert.throws(() => cache.load(f.rulesFile, { allowedRoot: path.join(f.root, 'references', 'sites') }), /escapes/);
  const link = path.join(f.root, 'references', 'sites', 'escaped'), outside = path.join(f.root, 'outside'); write(path.join(outside, 'record.json'), '{}'); fs.symlinkSync(outside, link, 'junction');
  assert.throws(() => cache.load(path.join(link, 'record.json'), { allowedRoot: path.join(f.root, 'references', 'sites') }), /escapes/);
});

test('相同路径目标真实路径改变重新读取，不复用旧内容', () => {
  const f = fixture(), cache = new FileAssetCache(), managed = path.join(f.root, 'references', 'sites');
  const first = path.join(managed, 'first'), second = path.join(managed, 'second'), alias = path.join(managed, 'alias'); write(path.join(first, 'record.json'), { value: 'first' }); write(path.join(second, 'record.json'), { value: 'second' });
  fs.symlinkSync(first, alias, 'junction'); const file = path.join(alias, 'record.json'); assert.equal(cache.load(file, { allowedRoot: managed, json: true }).value.value, 'first');
  fs.rmdirSync(alias); fs.symlinkSync(second, alias, 'junction'); assert.equal(cache.load(file, { allowedRoot: managed, json: true }).value.value, 'second'); assert.equal(cache.diagnostics().reads, 2);
});

test('session.preloadRules仅预加载本session资料，返回摘要不泄漏全部正文', () => {
  const f = fixture(); class Session {} installLocalEvidence(Session, { root: f.root }); const session = new Session();
  const summary = session.preloadRules(); assert.equal(summary.loaded, 2); assert.equal(Object.hasOwn(summary, 'rules'), false); assert.equal(session.ruleCard('alpha').id, 'alpha');
  assert.equal(Object.hasOwn(session, 'context'), false);
});

test('实际技能247站与6卡完整预载，后续规则调用零重复read/hash', () => {
  const root = path.join(__dirname, '..', 'ai-literacy-search'), recipes = new RecipeStore(root), rules = new RuleStore(root);
  const sites = recipes.preload(), cards = rules.preload(); assert.equal(sites.failed, 0); assert.equal(sites.loaded, sites.indexed); assert.equal(sites.indexed, 247); assert.equal(cards.failed, 0); assert.equal(cards.loaded, 6);
  const before = rules.files.diagnostics(); rules.card('boolean-operators'); rules.card('retrieval-metrics'); const after = rules.files.diagnostics(); assert.equal(after.reads, before.reads); assert.equal(after.hashes, before.hashes);
  return { site_profiles: sites.loaded, rule_cards: cards.loaded, repeated_rule_reads: after.reads - before.reads, repeated_rule_hashes: after.hashes - before.hashes };
});

test('冷加载与预热后同类题内部比较，预热请求减少read/hash', () => {
  const f = fixture(), runs = 40; let coldReads = 0, coldHashes = 0; const coldStart = performance.now();
  for (let i = 0; i < runs; i++) { const recipes = new RecipeStore(f.root), rules = new RuleStore(f.root); recipes.recipe('alpha:lookup'); rules.card('alpha'); coldReads += recipes.files.diagnostics().reads + rules.files.diagnostics().reads; coldHashes += recipes.files.diagnostics().hashes + rules.files.diagnostics().hashes; }
  const coldMs = performance.now() - coldStart, recipes = new RecipeStore(f.root), rules = new RuleStore(f.root); recipes.preload(); rules.preload(); const before = [recipes.files.diagnostics(), rules.files.diagnostics()]; const warmStart = performance.now();
  for (let i = 0; i < runs; i++) { recipes.recipe('alpha:lookup'); rules.card('alpha'); }
  const warmMs = performance.now() - warmStart, after = [recipes.files.diagnostics(), rules.files.diagnostics()]; const warmReads = after.reduce((total, metrics, i) => total + metrics.reads - before[i].reads, 0), warmHashes = after.reduce((total, metrics, i) => total + metrics.hashes - before[i].hashes, 0);
  assert.equal(warmReads, 0); assert.equal(warmHashes, 0); assert.ok(coldReads > warmReads); assert.ok(coldHashes > warmHashes);
  return { kind: 'local fixture asset access only; not model or browser latency', requests: runs, cold: { reads: coldReads, hashes: coldHashes, milliseconds: coldMs }, prepared: { reads: warmReads, hashes: warmHashes, milliseconds: warmMs } };
});

report.finished_at = new Date().toISOString(); report.passed = report.tests.filter(test => test.passed).length; report.failed = report.tests.filter(test => !test.passed).length;
const reportFile = path.join(__dirname, 'v28-cache-tests.json'); fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n'); process.stdout.write(`Results: ${report.passed} passed, ${report.failed} failed. ${reportFile}\n`); process.exitCode = report.failed ? 1 : 0;
