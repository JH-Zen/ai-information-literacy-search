'use strict';

// Offline fixtures only: no browser, network request, or claimed online result.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { SearchSession } = require('../scripts/browser.cjs');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const stamp = () => new Date().toISOString();
const inside = (root, child) => { const relative = path.relative(root, child); return !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); };
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-reuse-offline-'));
const url = 'https://fixtures.example.test/help/version-2026';
const config = { sessionId: 'offline-evidence-reuse', outputDir: path.join(temp, 'output'), runtimeDir: path.join(temp, 'runtime'), archive: true,
  catalog: [{ id: 'fixture', name: 'Offline fixture', url, domains: ['fixtures.example.test'] }], preflightSourceIds: ['fixture'] };
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value), 'utf8'); };
const question = id => ({ id, question: '示例平台2026版支持哪种检索字段？', type: 'single', options: { A: '示例字段', B: '题名' } });
const answer = (q, source, label = 'B') => ({ id: q.id, question: q.question, type: 'single', status: 'verified', answer: ['题名'], answer_labels: [label],
  explanation: '依据离线测试夹具的原始字段说明核对本题选项。', option_evaluations: Object.entries(q.options).map(([key, text]) => ({ label: key, text,
    verdict: key === label ? 'supported' : 'refuted', reason: '测试夹具说明支持题名，不支持示例字段。' })), sources: [source], needs_review: [], searched_at: stamp() });

try {
  const session = new SearchSession(config);
  session.report.entries = [{ source_id: 'fixture', availability: 'reachable', authorization: 'not_observed', search_ready: true }];
  session.persistReport();
  Object.defineProperty(session, 'context', { get() { throw new Error('Offline reuse must not access a browser context.'); } });
  session.start = () => { throw new Error('Offline reuse must not launch a browser.'); };
  const q1 = question('q1');
  q1.options = { A: '题名', B: '示例字段' };
  session.beginQuestion(q1);
  const text = '离线测试夹具：示例平台2026版支持题名检索，不支持示例字段。';
  const retrievedAt = '2026-10-01T00:00:00.000Z';
  const source = { name: 'Offline fixture help', url, query: '检索字段', field: '2026版检索字段', evidence: '支持题名检索，不支持示例字段', locator: 'body', retrieved_at: retrievedAt };
  const artifact = { storage: 'archive', snapshot: path.join(session.outputDir, 'snapshots', 'fixture.json'), screenshot: path.join(session.outputDir, 'snapshots', 'fixture.png'),
    target_text: path.join(session.outputDir, 'snapshots', 'fixture.target.json'), text_sha256: hash(text) };
  write(artifact.snapshot, { url, text, http_status: 200, observed_at: retrievedAt });
  write(artifact.target_text, { url, locator: 'body', text, captured_at: retrievedAt });
  fs.writeFileSync(artifact.screenshot, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lF8AAAAASUVORK5CYII=', 'base64'));
  const attempt = session.questionRecords.findLast(item => item.question_id === q1.id);
  const original = { kind: 'web', question_id: q1.id,
    provenance: { session_id: session.sessionId, question_fingerprint: attempt.fingerprint, attempt: attempt.attempt }, source, artifact };
  fs.appendFileSync(path.join(session.outputDir, 'evidence.jsonl'), JSON.stringify(original) + '\n', 'utf8');
  session.evidence.push(original);
  assert.equal(session.saveAnswer(q1, answer(q1, source, 'A')).answer.status, 'verified');

  const found = session.findEvidence({ text: '题名', url: 'version-2026' });
  assert.equal(found.length, 1);
  assert.equal(found[0].origin_question_id, 'q1');
  assert.deepEqual(found[0].source, source);
  assert.equal(JSON.stringify(found).includes('answer_labels'), false);
  assert.deepEqual(session.findEvidence({ text: '不存在的词' }), []);
  assert.throws(() => session.findEvidence({ limit: 0 }), /limit/);

  const reuseOptions = { source: found[0].source, freshness: 'versioned', scope: '同一示例平台、2026版本及检索字段；依据新选项文字重新映射字母。' };
  const q2 = question('q2');
  assert.throws(() => session.reuseEvidence(q2, reuseOptions), /Begin/);
  session.beginQuestion(q2);
  for (const freshness of ['live', 'dynamic', 'unknown']) assert.throws(() => session.reuseEvidence(q2, { ...reuseOptions, freshness }), /stable or versioned/);
  assert.throws(() => session.reuseEvidence(q2, { ...reuseOptions, scope: '' }), /Explain/);
  assert.throws(() => session.reuseEvidence({ ...q2, options: { A: '题名', B: '示例字段' } }, reuseOptions), /Begin/);
  assert.throws(() => session.reuseEvidence(q2, { ...reuseOptions, source: { ...source, evidence: '仅凭记忆的说明' } }), /No original/);
  const reused = session.reuseEvidence(q2, reuseOptions);
  assert.equal(reused.kind, 'reused_web');
  assert.equal(reused.source.retrieved_at, retrievedAt);
  assert.equal(reused.reuse.origin_question_id, 'q1');
  assert.equal(session.validateReusedEvidence(reused, q2).warning, undefined);
  assert.equal(session.saveAnswer(q2, answer(q2, reused.source)).answer.status, 'verified');
  session.beginQuestion(q2);
  const retried = session.reuseEvidence(q2, reuseOptions);
  assert.equal(retried.reuse.attempt, 2);
  assert.ok(session.validateReusedEvidence(reused, q2).warning, 'an earlier attempt must not certify the new attempt');
  assert.equal(session.saveAnswer(q2, answer(q2, retried.source)).answer.status, 'verified', 'saveAnswer must select the latest matching evidence attempt');

  const q3 = question('q3');
  session.beginQuestion(q3);
  session.reuseEvidence(q3, { ...reuseOptions, source: reused.source, freshness: 'stable' });
  const wrongLetter = session.saveAnswer(q3, answer(q3, source, 'A')).answer;
  assert.equal(wrongLetter.status, 'partial');
  assert.ok(wrongLetter.needs_review.some(item => item.includes('字母与选项文字')));

  const q4 = question('q4');
  session.beginQuestion(q4);
  const localSource = { ...source, locator: 'local-proof:fixture' };
  session.evidence.push({ kind: 'local_calculation', question_id: 'other', source: localSource, artifact: { proof: 'fixture' } });
  assert.throws(() => session.reuseEvidence(q4, { ...reuseOptions, source: localSource }), /No original/);
  const memoryOnly = { ...source, query: 'unrecorded-memory-only' };
  session.evidence.push({ question_id: 'memory', source: memoryOnly, artifact });
  assert.throws(() => session.reuseEvidence(q4, { ...reuseOptions, source: memoryOnly }), /session record file/);
  const originalTarget = fs.readFileSync(artifact.target_text);
  write(artifact.target_text, { url, locator: 'body', text: text + ' altered', captured_at: retrievedAt });
  assert.throws(() => session.reuseEvidence(q4, reuseOptions), /inconsistent/);
  assert.equal(session.findEvidence().length, 0);
  fs.writeFileSync(artifact.target_text, originalTarget);
  const excerptTamper = { ...source, evidence: '摘录没有出现在原始页面' };
  const badRecord = { question_id: 'bad', source: excerptTamper, artifact };
  session.evidence.push(badRecord);
  fs.appendFileSync(path.join(session.outputDir, 'evidence.jsonl'), JSON.stringify(badRecord) + '\n');
  assert.throws(() => session.reuseEvidence(q4, { ...reuseOptions, source: excerptTamper }), /inconsistent/);

  const saved = session.reuseEvidence(q4, reuseOptions);
  assert.ok(session.validateReusedEvidence({ ...saved, reuse: { ...saved.reuse, question_fingerprint: 'wrong' } }, q4).warning);
  assert.ok(session.validateReusedEvidence({ ...saved, reuse: { ...saved.reuse, origin_record_sha256: undefined } }, q4).warning);
  fs.appendFileSync(artifact.screenshot, 'damaged');
  assert.ok(session.validateReusedEvidence(saved, q4).warning);
  const damaged = session.saveAnswer(q4, answer(q4, source)).answer;
  assert.equal(damaged.status, 'partial', 'saveAnswer must invoke validateReusedEvidence for reused_web records');
  assert.ok(damaged.needs_review.some(item => item.includes('复用网站证据无效')));

  fs.writeFileSync(artifact.screenshot, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lF8AAAAASUVORK5CYII=', 'base64'));
  const reconstructed = new SearchSession(config);
  assert.equal(reconstructed.findEvidence({ text: '题名' }).length, 1, 'same output/session restores original evidence without Chrome');
  const q5 = question('q5');
  reconstructed.beginQuestion(q5);
  const final = reconstructed.reuseEvidence(q5, reuseOptions);
  assert.equal(final.reuse.origin_question_id, 'q1', 'reuse chains resolve directly to the original capture');
  fs.unlinkSync(artifact.target_text);
  assert.ok(reconstructed.validateReusedEvidence(final, q5).warning);
  assert.throws(() => reconstructed.reuseEvidence(q5, reuseOptions), /missing/);
  console.log('PASS: offline website evidence reuse, remapped choices, provenance/fingerprint/freshness guards, corruption downgrade, and session reconstruction.');
} finally {
  assert.ok(path.isAbsolute(temp) && inside(os.tmpdir(), temp) && path.basename(temp).startsWith('evidence-reuse-offline-'));
  fs.rmSync(temp, { recursive: true, force: true });
}
