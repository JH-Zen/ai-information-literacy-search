#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..', 'ai-literacy-search');
const index = JSON.parse(fs.readFileSync(path.join(root, 'references', 'search-index.json'), 'utf8'));
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'references', 'sources.json'), 'utf8'));
const examples = JSON.parse(fs.readFileSync(path.join(__dirname, 'recipe-input', 'questions.json'), 'utf8'));
const tests = [];
const test = (name, fn) => { try { const detail = fn(); tests.push({ name, passed: true, ...(detail ? { detail } : {}) }); process.stdout.write(`PASS ${name}\n`); } catch (error) { tests.push({ name, passed: false, error: error.stack || String(error) }); process.stdout.write(`FAIL ${name}: ${error.message}\n`); } };
const sources = new Map(index.sources.map(source => [source.id, source]));

function assertDescriptor(descriptor, label) {
  assert.ok(descriptor && typeof descriptor === 'object' && !Array.isArray(descriptor), `${label} needs a locator descriptor`);
  const keys = ['css', 'role', 'label', 'text', 'placeholder', 'testId'];
  assert.ok(keys.some(key => typeof descriptor[key] === 'string' && descriptor[key].trim()), `${label} lacks a concrete observed locator`);
  if (descriptor.scope) assertDescriptor(descriptor.scope, `${label}.scope`);
  if (descriptor.frame) assert.ok(typeof descriptor.frame === 'string' && descriptor.frame.trim(), `${label}.frame must refer to the observed frame selector`);
}

function assertStructuralDeclarations(value, profile, label) {
  const querySnapshot = profile.provenance?.audit?.query_snapshot;
  const detailSnapshot = profile.provenance?.audit?.detail_snapshot;
  const realSnapshot = (snapshot, kind) => {
    assert.ok(typeof snapshot === 'string' && snapshot.trim(), `${label}.${kind} needs an actual observation snapshot`);
    assert.ok(fs.existsSync(path.resolve(root, '..', snapshot)), `${label}.${kind} references a missing observation`);
  };
  const items = value.result_items;
  assert.ok(items && ['observed', 'pending'].includes(items.status), `${label}.result_items must explicitly distinguish observed and pending`);
  assert.ok(typeof items.notes === 'string' && items.notes.trim(), `${label}.result_items needs its observation limitation`);
  if (items.status === 'pending') assert.equal(items.locator, null, `${label} must not invent an unobserved result item locator`);
  else { assertDescriptor(items.locator, `${label}.result_items.locator`); realSnapshot(querySnapshot, 'result_items'); }
  for (const group of ['record_identity', 'detail_fields']) {
    const fields = value[group]; assert.ok(fields && ['observed', 'partial', 'pending'].includes(fields.status), `${label}.${group} needs an explicit observation status`); assert.ok(Array.isArray(fields.fields));
    if (fields.status === 'pending') assert.deepEqual(fields.fields, [], `${label}.${group} must not invent unobserved fields`);
    else { assert.ok(fields.fields.length, `${label}.${group} has no declared real fields`); realSnapshot(group === 'detail_fields' ? detailSnapshot : querySnapshot, group); }
    assert.equal(new Set(fields.fields.map(field => field.name)).size, fields.fields.length, `${label}.${group} repeats field names`);
    for (const field of fields.fields) {
      assert.ok(typeof field.name === 'string' && field.name.trim()); assert.ok(['observed', 'text_observed', 'pending'].includes(field.status));
      if (field.status === 'observed') assertDescriptor(field.locator, `${label}.${group}.${field.name}`);
      else assert.equal(field.locator, null, `${label}.${group}.${field.name} cannot pretend an unobserved CSS locator is verified`);
      if (fields.status === 'observed') assert.equal(field.status, 'observed', `${label}.${group} must remain partial when independent field selectors are pending`);
    }
  }
  const completion = value.completion;
  assert.ok(completion && ['observed', 'pending'].includes(completion.status), `${label}.completion needs an explicit status`); assert.ok(typeof completion.rule === 'string' && completion.rule.trim());
  for (const key of ['ready', 'empty', 'loading']) {
    assert.ok(Object.hasOwn(completion, key), `${label}.completion must explicitly declare ${key}`);
    if (completion.status === 'pending') assert.equal(completion[key], null, `${label}.completion cannot invent ${key} before observation`);
    else if (completion[key] !== null) assertDescriptor(completion[key], `${label}.completion.${key}`);
  }
  if (completion.status === 'observed') { assertDescriptor(completion.ready, `${label}.completion.ready`); realSnapshot(completion.snapshot, 'completion'); }
  if (value.status === 'query_verified') assert.equal(completion.status, 'observed', `${label} cannot claim query verification without a real completion marker`);
}

test('全259题任务映射：覆盖实际原册题号/年份/题型，未内置原题答案', () => {
  assert.equal(examples.length, 259); assert.equal(index.examples.total, examples.length); assert.equal(index.example_tasks.length, examples.length);
  const mapped = new Map(index.example_tasks.map(task => [task.example_id, task])); assert.equal(mapped.size, examples.length);
  for (const example of examples) {
    const task = mapped.get(example.id); assert.ok(task, `missing ${example.id}`); assert.equal(task.year, example.year); assert.equal(task.type, example.type); assert.ok(task.task_kind);
    assert.ok(Array.isArray(task.parameters)); assert.ok(task.parameters.every(parameter => typeof parameter === 'string' && parameter.length)); assert.ok(Array.isArray(task.source_ids)); assert.equal(task.source_ids.length, new Set(task.source_ids).size);
    for (const id of task.source_ids) assert.ok(sources.has(id), `${example.id} references unknown ${id}`);
    for (const key of ['answer', 'answer_labels', 'options', 'stem', 'question']) assert.equal(Object.hasOwn(task, key), false, `task mapping must not cache sample ${key}`);
    if (!task.source_ids.length) assert.ok(task.needs_official_source_selection === true || task.routing_status === 'client_required', `${example.id} needs dynamic official-source selection or an explicit official client workflow`);
  }
  return { examples: mapped.size, years: [...new Set(index.example_tasks.map(task => task.year))], task_kinds: [...new Set(index.example_tasks.map(task => task.task_kind))] };
});

test('完整目录与154入口：基础123保留，每个刷题册入口绑定唯一合并来源', () => {
  assert.equal(catalog.sources.length, 123); assert.equal(sources.size, index.sources.length); assert.equal(index.quiz_entries.length, 154); assert.equal(new Set(index.quiz_entries.map(entry => entry.entry_id)).size, 154);
  for (const source of catalog.sources) assert.ok(sources.has(source.id), `lost catalog source ${source.id}`);
  for (const entry of index.quiz_entries) { assert.ok(entry.name && entry.url); assert.ok(sources.has(entry.source_id), `unmapped quiz entry ${entry.entry_id}`); assert.ok(['http:', 'https:'].includes(new URL(entry.url).protocol)); }
  return { base_sources: catalog.sources.length, quiz_entries: index.quiz_entries.length, merged_sources: sources.size };
});

test('每站独立流程资产：安全文件路径、声明身份和实际观察状态齐全', () => {
  const seen = new Set(); const statuses = {}; const recipeStatuses = {};
  for (const source of index.sources) {
    assert.match(source.profile, /^references\/sites\/[a-z0-9-]+\.json$/); assert.equal(seen.has(source.profile), false); seen.add(source.profile);
    const file = path.join(root, source.profile); assert.ok(fs.existsSync(file), `missing ${file}`); const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(profile.source_id, source.id); assert.ok(Number.isFinite(Date.parse(profile.checked_at)), `${source.id} missing check timestamp`); assert.notEqual(profile.status, 'pending_observation', `${source.id} not yet actually inspected`);
    statuses[profile.status] = (statuses[profile.status] || 0) + 1;
    assert.ok(profile.entry && profile.entry.url && profile.entry.final_url, `${source.id} missing entry URL`);
    const audit = profile.provenance?.audit;
    assert.ok(audit && audit.browser === 'Google Chrome' && Number.isFinite(Date.parse(audit.checked_at)), `${source.id} missing actual Chrome audit provenance`);
    if (!audit.snapshot) {
      assert.equal(profile.status, 'blocked', `${source.id} cannot claim an observed entry without a snapshot`);
      assert.equal(profile.entry.status, 'network_error', `${source.id} missing snapshot for a page which did render`);
      assert.ok(Array.isArray(profile.blockers) && profile.blockers.length >= 1 && profile.blockers.length <= 3);
      assert.ok(profile.blockers.every((blocker, index) => blocker.kind === 'network_error' && blocker.attempt === index + 1 && typeof blocker.detail === 'string' && blocker.detail.includes('page.goto')), `${source.id} missing bounded real navigation-error details`);
    }
    assert.ok(Array.isArray(profile.controls), `${source.id} missing actual controls array`);
    assert.ok(Array.isArray(profile.recipes));
    assertStructuralDeclarations(profile, profile, `profile ${source.id}`);
    for (const recipe of profile.recipes) {
      assert.ok(recipe.id && recipe.source_id === source.id); recipeStatuses[recipe.status] = (recipeStatuses[recipe.status] || 0) + 1; assert.ok(Array.isArray(recipe.parameters));
      assertStructuralDeclarations(recipe, profile, `recipe ${recipe.id}`);
      if (recipe.status === 'query_verified') {
        const querySnapshot = profile.provenance?.audit?.query_snapshot;
        assert.ok(recipe.provenance?.query || recipe.query_validation || profile.provenance?.query || querySnapshot, `${recipe.id} claims query verification without query provenance`);
        if (querySnapshot) assert.ok(fs.existsSync(path.resolve(root, '..', querySnapshot)), `${recipe.id} missing actual query snapshot`);
      }
    }
  }
  return { site_profiles: seen.size, observation_statuses: statuses, recipe_statuses: recipeStatuses };
});

test('日常无固定预检：默认会话保留全目录并可直接答题', () => {
  const { SearchSession } = require('../ai-literacy-search/scripts/browser.cjs');
  const session = new SearchSession({ sessionId: 'asset-default-lean', outputDir: path.join(__dirname, 'asset-default-lean') });
  assert.deepEqual(session.preflightSourceIds, []);
  assert.equal(session.sources.length, index.sources.length);
  session.beginQuestion('asset-no-preflight');
  assert.equal(session.activeQuestion.id, 'asset-no-preflight');
  assert.equal(session.context, undefined);
});

const report = { checked_at: new Date().toISOString(), version: index.version, tests, passed: tests.filter(test => test.passed).length, failed: tests.filter(test => !test.passed).length };
const file = path.join(__dirname, 'v24-asset-tests.json'); fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n', 'utf8'); process.stdout.write(`Results: ${report.passed} passed, ${report.failed} failed. ${file}\n`); process.exitCode = report.failed ? 1 : 0;
