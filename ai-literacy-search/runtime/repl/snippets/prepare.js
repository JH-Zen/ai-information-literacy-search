// One daemon request for “准备答题”. Existing valid objects are never replaced.
// First request reuses the ordinary constructor/health entry in this same invocation.
if (!globalThis.session) {
  var prepareFs = requireSkill('node:fs');
  var preparePath = requireSkill('node:path');
  var prepareBootstrap = prepareFs.readFileSync(preparePath.join(DAEMON_DIR, 'snippets', 'bootstrap.js'), 'utf8');
  globalThis.ailiteracyPrepareEntry = true;
  try {
    await eval('(async function () {\n' + prepareBootstrap + '\n})()');
  } finally {
    delete globalThis.ailiteracyPrepareEntry;
  }
}
if (typeof globalThis.session.prepare !== 'function') {
  var prepareApiError = new Error('RELOAD_REQUIRED: loaded runtime lacks session.prepare(). Refresh the Node runtime; preserve the current Chrome and session ID.');
  prepareApiError.code = 'RELOAD_REQUIRED';
  throw prepareApiError;
}
globalThis.sessionId = globalThis.session.sessionId;
var prepareResult = await globalThis.session.prepare();
prepareResult
