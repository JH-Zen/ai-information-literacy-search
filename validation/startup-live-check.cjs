'use strict';

// Real-site initialization check only. No searches, exam actions or login forms.
const fs = require('node:fs');
const path = require('node:path');
const { createSession, VERSION } = require('../ai-literacy-search/scripts/browser.cjs');

(async () => {
  const sessionId = 'eight-live-' + Date.now();
  const outputDir = path.join(__dirname, sessionId);
  const session = await createSession({ sessionId, outputDir, profileDir: path.join(outputDir, 'profile') });
  try {
    const report = await session.preflight({ onProgress: ({ completed, total, entry }) => {
      process.stdout.write(JSON.stringify({ checked: `${completed}/${total}`, source: entry.source_id, availability: entry.availability, authorization: entry.authorization }) + '\n');
    } });
    const result = { version: VERSION, checked_at: new Date().toISOString(), browser: session.browser,
      catalog_total: report.catalog_total, initialization_source_ids: report.initialization_source_ids,
      initialization_checked: report.initialization_checked, initialization_total: report.initialization_total,
      completed: report.completed, report: session.reportPath,
      entries: report.entries.map(({ source_id, final_url, availability, authorization, search_status, checked_at, snapshot }) => ({ source_id, final_url, availability, authorization, search_status, checked_at, snapshot })) };
    fs.writeFileSync(path.join(__dirname, 'eight-preflight-live-check.json'), JSON.stringify(result, null, 2) + '\n');
    process.stdout.write(JSON.stringify({ completed: result.completed, checked: result.initialization_checked, report: result.report }) + '\n');
  } finally { await session.close(); }
})().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
