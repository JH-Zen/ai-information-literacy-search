// Existing persistent daemon globals: skill, requireSkill, skillEntry, outputRoot, DAEMON_DIR.
// Ordinary browser-needed entry only. It does not prepare assets or check websites.
var bootstrapFs = requireSkill('node:fs');
var bootstrapPath = requireSkill('node:path');
var bootstrapInstalledMatch = bootstrapFs.readFileSync(skillEntry, 'utf8').match(/\bconst\s+VERSION\s*=\s*['"]([^'"]+)['"]/);
var bootstrapInstalledVersion = bootstrapInstalledMatch?.[1] || null;
if (!bootstrapInstalledVersion || skill.VERSION !== bootstrapInstalledVersion) {
  var bootstrapVersionError = new Error('RELOAD_REQUIRED: loaded helper ' + skill.VERSION +
    ' differs from installed ' + bootstrapInstalledVersion + '. Refresh the Node runtime; preserve the current Chrome and session.');
  bootstrapVersionError.code = 'RELOAD_REQUIRED';
  throw bootstrapVersionError;
}
var bootstrapExisting = globalThis.session;
var bootstrapIdPattern = /^ailiteracy-[A-Za-z0-9][A-Za-z0-9_-]{7,89}$/;
if (bootstrapExisting) {
  if (typeof bootstrapExisting.beginQuestion !== 'function' || !bootstrapIdPattern.test(bootstrapExisting.sessionId)
    || bootstrapExisting.browser !== 'chrome') throw new Error('The existing session object is invalid; preserve it for inspection.');
} else {
  var bootstrapIdFile = bootstrapPath.join(DAEMON_DIR, 'session-id.txt');
  var bootstrapId = bootstrapFs.existsSync(bootstrapIdFile)
    ? bootstrapFs.readFileSync(bootstrapIdFile, 'utf8').trim()
    : 'ailiteracy-' + requireSkill('node:crypto').randomUUID().slice(0, 8);
  if (!bootstrapIdPattern.test(bootstrapId)) throw new Error('Invalid recorded session ID; no browser or state was created.');
  var bootstrapRoot = bootstrapPath.resolve(outputRoot);
  var bootstrapOutput = bootstrapPath.resolve(bootstrapRoot, bootstrapId);
  if (bootstrapPath.dirname(bootstrapOutput) !== bootstrapRoot) throw new Error('Recorded session escapes the output root.');
  globalThis.session = new skill.SearchSession({sessionId: bootstrapId, outputDir: bootstrapOutput, browser: 'chrome'});
  if (!bootstrapFs.existsSync(bootstrapIdFile)) bootstrapFs.writeFileSync(bootstrapIdFile, bootstrapId, 'utf8');
}
if (typeof globalThis.session.codeStatus !== 'function') {
  var bootstrapApiError = new Error('RELOAD_REQUIRED: this session lacks current initialization APIs. Refresh the Node runtime; preserve Chrome and the session ID.');
  bootstrapApiError.code = 'RELOAD_REQUIRED';
  throw bootstrapApiError;
}
// prepare.js defers startup to prepare() so a launch failure remains a summary.
// Ordinary start() checks loaded-code identity and browser health before any launch.
if (!globalThis.ailiteracyPrepareEntry) await globalThis.session.start();
globalThis.sessionId = globalThis.session.sessionId;
var bootstrapResult = {
  sessionId: globalThis.session.sessionId,
  helper_version: skill.VERSION,
  installed_version: bootstrapInstalledVersion,
  browser_connected: globalThis.session.isBrowserConnected(),
  reused_live_session: Boolean(bootstrapExisting),
  preflight_ran: false
};
bootstrapResult
