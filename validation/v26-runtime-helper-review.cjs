'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(process.env.AI_LITERACY_RUNTIME_DIR || path.join(os.homedir(), '.ailiteracy-runtime'), 'repl');
const daemon = fs.readFileSync(root + '/daemon.cjs', 'utf8');
const parser = daemon.slice(daemon.indexOf('function statementSegments'), daemon.indexOf('async function execute'));
const compiler = vm.createContext({vm});
const planSource = vm.runInContext(parser + '\nplanSource;', compiler);
const snippet = fs.readFileSync(root + '/snippets/bootstrap-reuse.js', 'utf8');
const preflightSnippet = fs.readFileSync(root + '/snippets/preflight.js', 'utf8');
const report = {completed: true, entries: [], initialization_checked: 8, initialization_total: 8, catalog_total: 123, initialization_summary: {}, updated_at: 'fixture-time'};
const sourceSession = () => ({sessionId: 'ailiteracy-fixture1', outputDir: 'C:/fixture/output/ailiteracy-fixture1', profileDir: 'C:/fixture/profile', reportPath: 'C:/fixture/output/ailiteracy-fixture1/preflight.json', runSearch() {}, async preflight() {this.preflightCalls = (this.preflightCalls || 0) + 1; return report;}});
let tests = [];
async function runCase(name, configure, expectFailure) {
  let reads = [], creates = [], writes = 0;
  const fakeFiles = new Map();
  const context = {DAEMON_DIR: 'C:/fixture/repl', outputRoot: 'C:/fixture/output', skill: {VERSION: 'fixture-2.6.0'}, console: {log() {}},
    requireSkill(id) {if (id === 'node:path') return path; if (id === 'node:fs') return {existsSync: file => fakeFiles.has(file), readFileSync(file) {reads.push(file); return fakeFiles.get(file);}, writeFileSync() {writes++; throw new Error('Writes are forbidden in reuse fixtures');}}; throw new Error(id);},
    async createSession(options) {creates.push(options); return sourceSession();}};
  configure({context, fakeFiles});
  const sandbox = vm.createContext(context);
  let value, error;
  try {value = await new vm.Script(planSource(snippet)).runInContext(sandbox);} catch (failure) {error = failure;}
  if (Boolean(error) !== Boolean(expectFailure)) throw new Error(name + ': unexpected ' + (error?.message || 'success'));
  if (writes !== 0) throw new Error(name + ': wrote persistent state');
  if (expectFailure && creates.length) throw new Error(name + ': replaced state before rejecting');
  tests.push({name, passed: true, reads: reads.length, creates: creates.length, error: error?.message || null});
  return {context, value, reads, creates};
}
(async () => {
  const live = sourceSession();
  const existing = await runCase('existing session reuses object without file reads or createSession', ({context}) => {context.session = live;}, false);
  if (existing.context.session !== live || existing.reads.length || existing.creates.length || live.preflightCalls !== 1) throw new Error('Existing session was not preserved');
  const savedId = 'ailiteracy-fixture2';
  const idPath = path.join('C:/fixture/repl', 'session-id.txt');
  const outputDir = path.resolve('C:/fixture/output', savedId);
  const metadataPath = path.join(outputDir, 'session.json');
  const restored = await runCase('no object restores validated saved ID and metadata profile', ({fakeFiles}) => {fakeFiles.set(idPath, savedId); fakeFiles.set(metadataPath, JSON.stringify({session_id:savedId,browser:'chrome',profile_dir:'C:/fixture/profile'}));}, false);
  if (restored.creates.length !== 1 || restored.creates[0].sessionId !== savedId || restored.creates[0].outputDir !== outputDir || restored.creates[0].profileDir !== 'C:/fixture/profile') throw new Error('Wrong restored state');
  await runCase('invalid ID cannot traverse output root', ({fakeFiles}) => {fakeFiles.set(idPath, '../outside');}, true);
  await runCase('missing ID cannot create fictional recovery state', () => {}, true);
  await runCase('missing metadata cannot create fictional recovery state', ({fakeFiles}) => {fakeFiles.set(idPath, savedId);}, true);
  await runCase('mismatched metadata cannot replace session', ({fakeFiles}) => {fakeFiles.set(idPath, savedId); fakeFiles.set(metadataPath, JSON.stringify({session_id:'wrong',browser:'chrome',profile_dir:'C:/fixture/profile'}));}, true);
  await runCase('invalid existing object is preserved and rejected', ({context}) => {context.session = {};}, true);
  const startupSandbox = vm.createContext({session: sourceSession(), console: {log() {}}});
  const startup = await new vm.Script(planSource(preflightSnippet)).runInContext(startupSandbox);
  if (startup.initialization_total !== 8 || startup.catalog_total !== 123 || startup.recorded_entries !== 0) throw new Error('Startup and catalog counts were confused');
  tests.push({name: 'preflight reports actual 8-target startup separately from 123-entry catalog', passed: true});
  const result = {kind:'static-runtime-helper-review', edited_files:[root+'/README.md',root+'/snippets/preflight.js',root+'/snippets/bootstrap-reuse.js'], tests, passed:tests.length, failed:0, execution:'Offline mock session and filesystem using the actual daemon snippet parser; no live daemon requests.', live_daemon_modified:false, process_stopped:false, browser_stopped:false, cookies_or_profile_changed:false, module_refresh:'Installed files do not refresh the daemon-cached helper. A new Codex chat connected to the same old daemon still needs safe maintenance before using the new runner.'};
  fs.writeFileSync(path.join(__dirname, 'v26-runtime-helper-review.json'), JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({passed:result.passed,failed:result.failed,report:'validation/v26-runtime-helper-review.json'}));
})().catch(error => {console.error(error); process.exitCode=1;});
