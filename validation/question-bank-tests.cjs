#!/usr/bin/env node
'use strict';

// Independent behavioral checks. This suite owns only its temporary bank and
// does not open browsers, call websites, or modify the shipped bank.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const skillRoot = path.resolve(__dirname, '../ai-literacy-search');
const { lookupQuestionBank, preloadQuestionBank } = require(path.join(skillRoot, 'scripts/question-bank.cjs'));
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-literacy-bank-validation-'));
const bankPath = path.join(temporaryRoot, 'references/question-bank.json');
fs.mkdirSync(path.dirname(bankPath), { recursive: true });
const report = { started_at: new Date().toISOString(), kind: 'local bank matching, provenance, key integrity, cache and answer-letter mapping', tests: [] };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
let serial = 0;

function entry(id, stem, type, options, labels, policy = 'stable', extras = {}) {
  return { id, base_id: id, title: stem, stem, type, options,
    answer_labels: labels, answer_texts: labels.map(label => options[label]), judge_answer: null,
    explanation: '原资料给出的标准答案，用于匹配当前题干及完整选项。', urls: [],
    source_kind: 'user_supplied_official_sample', reuse_policy: policy,
    line_start: 1, line_end: 8, issues: [], excerpt: `题干：${stem}\n答案：${labels.join('')}`,
    ...extras };
}

const stable = entry('T01', '一般布尔检索中，AND 运算取两个检索集合的哪一部分？（）', 'single', { A: '交集', B: '并集', C: '差集', D: '全集' }, ['A']);
const multiple = entry('T02', '下列哪些属于常用布尔检索运算符？（）', 'multiple', { A: 'AND', B: 'OR', C: 'NOT', D: 'ISBN' }, ['A', 'B', 'C']);
const judgment = entry('T03', 'DOI 是数字对象标识符。（）', 'judge', {}, [], 'stable', { judge_answer: true, answer_texts: ['正确'] });
const falseJudgment = entry('T04', 'ISSN 可以证明期刊内容质量。（）', 'judge', {}, [], 'stable', { judge_answer: false, answer_texts: ['错误'] });
const fixed = entry('T05', '在 NCBI Bookshelf 中找到《The Ethics of Human Enhancement: Understanding the Debate》，这本书的出版社是？（）', 'single', { A: 'Elsevier', B: 'Wiley', C: 'Cambridge University Press', D: 'Oxford University Press' }, ['D'], 'fixed_record');
const dynamic = entry('T06', '在 CNKI 中检索2015到2025年主题为“数字经济”的文献，发文量最多的作者是谁？（）', 'single', { A: '张甲', B: '王乙', C: '刘丙', D: '李丁' }, ['B'], 'dynamic');
const product = entry('T07', '在百度高级检索界面中，“关键词位置”可以选择哪些字段？（）', 'multiple', { A: '网页任何地方', B: '仅网页标题中', C: '仅 URL 中', D: '仅网页图片中' }, ['A', 'B', 'C'], 'product');
const calculation = entry('T08', '检索得到90篇文献，其中相关文献72篇，查准率是多少？（）', 'single', { A: '40%', B: '80%', C: '90%', D: '100%' }, ['B'], 'calculation');
const quoted = entry('T09', '使用检索式“alpha beta”查找固定题名时，以下哪项符合精确匹配条件？（）', 'single', { A: 'alpha beta', B: 'alphabeta', C: 'alpha', D: 'beta' }, ['A'], 'fixed_record');
const fixtures = [stable, multiple, judgment, falseJudgment, fixed, dynamic, product, calculation, quoted];

function bank(entries = fixtures) {
  return { version: 1, provenance: { file: 'fixtures/题库总表.md', name: '题库总表.md', sha256: hash('isolated user-provided key fixture'), verification: 'user_supplied_unverified', original_sources_verified: false },
    entries: clone(entries), entries_sha256: hash(JSON.stringify(entries)),
    summary: { base_questions: new Set(entries.map(row => row.base_id)).size, entries: entries.length } };
}
function writeBank(entries = fixtures, transform) {
  const value = bank(entries); if (transform) transform(value);
  fs.writeFileSync(bankPath, JSON.stringify(value, null, 2) + '\n'); return value;
}
function query(row = stable, patch = {}) {
  return { id: `bank-${++serial}`, type: row.type, question: row.stem, options: clone(row.options), ...patch };
}
function lookup(q, extra = {}) { return lookupQuestionBank(q, { root: temporaryRoot, ...extra }); }
function noAnswer(result) {
  assert.notEqual(result.status, 'matched');
  for (const key of ['answer_labels', 'answer_texts', 'judge_answer']) assert.equal(Object.hasOwn(result, key), false, `unverified result must not expose ${key}`);
}
function remapped(row) {
  const values = Object.values(row.options).reverse(), labels = Object.keys(row.options);
  return Object.fromEntries(labels.map((label, index) => [label, values[index]]));
}
async function test(name, fn) {
  try { const detail = await fn(); report.tests.push({ name, passed: true, ...(detail ? { detail } : {}) }); process.stdout.write(`PASS ${name}\n`); }
  catch (error) { report.tests.push({ name, passed: false, error: error.stack || String(error) }); process.stdout.write(`FAIL ${name}: ${error.message}\n`); }
}

async function main() {
  writeBank();
  await test('本地预加载统计区分可复用与需核验，真实题量从条目计算', () => {
    const loaded = preloadQuestionBank({ root: temporaryRoot });
    assert.equal(loaded.total, fixtures.length); assert.equal(loaded.base_questions, fixtures.length);
    assert.equal(loaded.eligible + loaded.review_required, fixtures.length); assert.deepEqual(loaded.failures, []);
  });
  await test('单选精确题干和完整选项直接返回当前答案文字', () => {
    const result = lookup(query()); assert.equal(result.status, 'matched');
    assert.deepEqual(result.answer_labels, ['A']); assert.deepEqual(result.answer_texts, ['交集']);
    assert.equal(result.candidates[0].match_kind, 'exact'); assert.equal(result.candidates[0].entry.id, stable.id);
    assert.ok(result.sources.length > 0);
  });
  await test('单选选项换序重新映射字母，不能沿用题库旧字母', () => {
    const result = lookup(query(stable, { options: remapped(stable) })); assert.equal(result.status, 'matched');
    assert.deepEqual(result.answer_labels, ['D']); assert.deepEqual(result.answer_texts, ['交集']);
  });
  await test('多选逐项按文字映射到当前选项集合', () => {
    const result = lookup(query(multiple, { options: remapped(multiple) })); assert.equal(result.status, 'matched');
    assert.deepEqual(result.answer_labels, ['B', 'C', 'D']); assert.deepEqual(new Set(result.answer_texts), new Set(['AND', 'OR', 'NOT']));
  });
  await test('正向判断题精确匹配保留布尔结论', () => {
    const result = lookup(query(judgment)); assert.equal(result.status, 'matched'); assert.equal(result.judge_answer, true);
    assert.deepEqual(result.answer_texts, ['正确']);
  });
  await test('反向判断题精确匹配不会把false当缺失答案', () => {
    const result = lookup(query(falseJudgment)); assert.equal(result.status, 'matched'); assert.equal(result.judge_answer, false);
    assert.deepEqual(result.answer_texts, ['错误']);
  });
  await test('判断选项换序按照当前正确错误文字映射字母', () => {
    const result = lookup(query(judgment, { options: { A: '错误', B: '正确' } }));
    assert.equal(result.status, 'matched'); assert.equal(result.judge_answer, true); assert.deepEqual(result.answer_labels, ['B']);
    noAnswer(lookup(query(judgment, { options: { A: '正确', B: '正确' } })));
  });
  await test('固定文献元数据的同题可以复用明确给出的标准答案', () => {
    const result = lookup(query(fixed)); assert.equal(result.status, 'matched'); assert.deepEqual(result.answer_texts, ['Oxford University Press']);
  });
  await test('动态排名即使原题命中也仅给候选与核验提示', () => {
    const result = lookup(query(dynamic)); assert.equal(result.status, 'needs_verification'); noAnswer(result);
  });
  await test('产品界面字段即使原题命中也需确认当前版本', () => {
    const result = lookup(query(product)); assert.equal(result.status, 'needs_verification'); noAnswer(result);
  });
  await test('计算题相同数据可复用，仍按当前文字返回80%', () => {
    const result = lookup(query(calculation, { options: remapped(calculation) })); assert.equal(result.status, 'matched'); assert.deepEqual(result.answer_texts, ['80%']); assert.deepEqual(result.answer_labels, ['C']);
  });
  await test('计算题数据变化不能复用历史数值答案', () => {
    const result = lookup(query(calculation, { question: calculation.stem.replace('72篇', '54篇') })); noAnswer(result);
  });
  await test('语义同类但不同题干只返回候选不自动授权答案', () => {
    const result = lookup(query(stable, { question: '在布尔检索中使用 AND 连接两个集合，其含义是什么？（）' })); noAnswer(result); assert.ok(['candidates', 'miss'].includes(result.status));
  });
  await test('题干否定词改变即使高度相似也不能直接回答', () => {
    noAnswer(lookup(query(stable, { question: stable.stem.replace('哪一部分', '不包含哪一部分') })));
  });
  await test('判断题否定词变化不能继承原判断', () => {
    noAnswer(lookup(query(judgment, { question: judgment.stem.replace(' 是', ' 不是') })));
  });
  await test('增加限定条件不能继承旧题答案', () => {
    noAnswer(lookup(query(stable, { question: stable.stem.replace('一般布尔检索中', '仅在知网专业检索中') })));
  });
  await test('固定文献实体改变不能继承旧出版社', () => {
    noAnswer(lookup(query(fixed, { question: fixed.stem.replace('The Ethics of Human Enhancement: Understanding the Debate', 'Another Book: A Different Record') })));
  });
  await test('年份变化与唯一标识变化保留其约束意义', () => {
    noAnswer(lookup(query(dynamic, { question: dynamic.stem.replace('2025年', '2024年') })));
    noAnswer(lookup(query(fixed, { question: fixed.stem.replace('Bookshelf', 'Bookshelf PMID: 2026') })));
  });
  await test('单选多选题型变化不能继承答案', () => { noAnswer(lookup(query(stable, { type: 'multiple' }))); });
  await test('单个选项替换不能按题干直接命中旧答案', () => {
    noAnswer(lookup(query(stable, { options: { ...stable.options, D: '空集' } })));
  });
  await test('选项删除不能把完整集合核验退化为部分匹配', () => {
    const options = clone(stable.options); delete options.D; noAnswer(lookup(query(stable, { options })));
  });
  await test('新增选项必须重新核验', () => { noAnswer(lookup(query(stable, { options: { ...stable.options, E: '补集' } }))); });
  await test('当前重复选项不能产生歧义答案映射', () => {
    noAnswer(lookup(query(stable, { options: { A: '交集', B: '交集', C: '差集', D: '全集' } })));
  });
  await test('全角字母与非语义空白规范化允许相同题匹配', () => {
    const result = lookup(query(stable, { question: '  ' + stable.stem.replace('AND', 'ＡＮＤ') + '  ', options: Object.fromEntries(Object.entries(stable.options).map(([label, text]) => [label, '  ' + text + '  '])) }));
    assert.equal(result.status, 'matched'); assert.deepEqual(result.answer_labels, ['A']);
  });
  await test('带引号的检索词中空白不能被随意删去', () => {
    noAnswer(lookup(query(quoted, { question: quoted.stem.replace('“alpha beta”', '“alphabeta”') })));
  });
  await test('更换布尔运算符不能继承原集合含义', () => {
    noAnswer(lookup(query(stable, { question: stable.stem.replace('AND', 'OR') })));
  });
  await test('不相关题返回miss且不泄露自动答案', () => {
    const result = lookup({ id: 'unrelated', type: 'single', question: '火星轨道的离心率测量值是什么？', options: { A: '一', B: '二' } });
    assert.equal(result.status, 'miss'); noAnswer(result);
  });
  await test('候选条目数受limit约束', () => {
    const result = lookup(query(stable, { question: '一般布尔检索中AND两个集合' }), { limit: 1 }); assert.ok(result.candidates.length <= 1); noAnswer(result);
  });
  await test('返回的条目副本污染不会改变缓存和后续答案', () => {
    const first = lookup(query()); first.candidates[0].entry.answer_labels = ['B']; first.candidates[0].entry.options.A = '错误内容';
    const second = lookup(query()); assert.equal(second.status, 'matched'); assert.deepEqual(second.answer_texts, ['交集']);
  });
  await test('连续第二题复用已预加载的题库，无重复正文文件读取', () => {
    lookup(query()); const original = fs.readFileSync; let bankReads = 0;
    fs.readFileSync = function (file, ...args) { if (path.resolve(String(file)) === bankPath) bankReads++; return original.call(this, file, ...args); };
    try {
      for (let index = 0; index < 10; index++) assert.equal(lookup(query(stable, { options: index % 2 ? remapped(stable) : clone(stable.options) })).status, 'matched');
    } finally { fs.readFileSync = original; }
    assert.equal(bankReads, 0); return { repeated_lookups: 10, question_bank_reads: bankReads };
  });
  await test('同题同选项的不同标准答案会报告冲突并停用直接答案', () => {
    const conflict = { ...clone(stable), id: 'T01-conflict', answer_labels: ['B'], answer_texts: ['并集'] };
    writeBank([stable, conflict]); const result = lookup(query()); assert.equal(result.status, 'needs_verification'); noAnswer(result); writeBank();
  });
  await test('资料已标记答案冲突的条目不能直接使用', () => {
    writeBank([{ ...clone(stable), issues: ['answer_marker_conflict'] }]); const result = lookup(query()); assert.equal(result.status, 'needs_verification'); noAnswer(result); writeBank();
  });
  await test('判断题null结论不能当作false返回', () => {
    writeBank([{ ...clone(judgment), judge_answer: null, issues: ['ambiguous_judgment'] }]); const result = lookup(query(judgment)); noAnswer(result); writeBank();
  });
  await test('答案字母与答案文字不一致拒绝直接回答', () => {
    writeBank([{ ...clone(stable), answer_texts: ['并集'] }]); noAnswer(lookup(query())); writeBank();
  });
  await test('答案引用不存在的选项字母拒绝直接回答', () => {
    writeBank([{ ...clone(stable), answer_labels: ['Z'], answer_texts: ['交集'] }]); noAnswer(lookup(query())); writeBank();
  });
  await test('提供的来源缺失不能声称可追溯标准答案', () => {
    writeBank(fixtures, value => { value.provenance = {}; }); noAnswer(lookup(query())); writeBank();
  });
  await test('文件原始来源不能被伪装为实时官方网页证据', () => {
    const result = lookup(query()); assert.equal(result.status, 'matched');
    assert.ok(JSON.stringify(result.sources).includes('题库总表.md'));
    assert.ok(!result.sources.some(source => source.kind === 'browser' || source.kind === 'live'));
  });
  await test('未更新完整性摘要的条目篡改使整库不可直接复用', () => {
    writeBank(fixtures, value => { value.entries[0].answer_labels = ['B']; value.entries[0].answer_texts = ['并集']; });
    const result = lookup(query()); assert.equal(result.status, 'needs_verification'); noAnswer(result); writeBank();
  });
  await test('热缓存后坏JSON不会回退到旧题库答案', () => {
    assert.equal(lookup(query()).status, 'matched'); fs.writeFileSync(bankPath, '{"entries":');
    const result = lookup(query()); assert.equal(result.status, 'needs_verification'); noAnswer(result); writeBank();
  });
  await test('热缓存后文件删除不会回退到旧题库答案', () => {
    assert.equal(lookup(query()).status, 'matched'); fs.unlinkSync(bankPath);
    const result = lookup(query()); assert.equal(result.status, 'needs_verification'); noAnswer(result); writeBank();
  });
  await test('重新写入的有效题库在下一次查询重建而不沿用旧答案', () => {
    assert.equal(lookup(query()).status, 'matched');
    const replacement = { ...clone(stable), answer_labels: ['B'], answer_texts: ['并集'] };
    writeBank([replacement]); const result = lookup(query()); assert.equal(result.status, 'matched'); assert.deepEqual(result.answer_texts, ['并集']); writeBank();
  });
  await test('无效输入不能依靠字符串相似度蒙混进入匹配', () => {
    for (const malformed of [null, undefined, 'AND', { question: '' }, { type: 'single', question: 'AND', options: 'ABCD' }]) assert.throws(() => lookup(malformed));
  });
  await test('生产题库预加载与双变体条目保留完整来源，不声称重新查站', () => {
    const loaded = preloadQuestionBank({ root: skillRoot }); assert.deepEqual(loaded.failures, []);
    const production = JSON.parse(fs.readFileSync(path.join(skillRoot, 'references/question-bank.json'), 'utf8'));
    assert.equal(loaded.total, production.entries.length); assert.equal(loaded.base_questions, new Set(production.entries.map(row => row.base_id)).size);
    assert.equal(loaded.eligible + loaded.review_required, loaded.total);
    assert.equal(production.provenance.original_sources_verified, false);
    const variant = production.entries.filter(row => row.base_id === 'M01'); assert.equal(variant.length, 2);
    assert.ok(variant.some(row => Object.values(row.options).some(text => /Word/i.test(text))));
    assert.ok(variant.some(row => Object.values(row.options).some(text => /水印/.test(text))));
    return { entries: loaded.total, base_questions: loaded.base_questions, eligible: loaded.eligible, review_required: loaded.review_required };
  });
  await test('会话题库检索无需浏览器且不创建每题落盘目录', () => {
    const { SearchSession } = require(path.join(skillRoot, 'scripts/browser.cjs'));
    const session = new SearchSession({ sessionId: 'bank-local-only', outputDir: path.join(temporaryRoot, 'not-created') });
    const production = JSON.parse(fs.readFileSync(path.join(skillRoot, 'references/question-bank.json'), 'utf8'));
    const row = production.entries.find(item => item.issues.length === 0 && ['stable', 'fixed_record', 'calculation'].includes(item.reuse_policy)); assert.ok(row);
    const result = session.lookupQuestionBank(query(row)); assert.equal(result.status, 'matched'); assert.equal(session.context, undefined);
    assert.equal(fs.existsSync(session.outputDir), false); assert.equal(session.archive, false); assert.equal(session.screenshots, false);
  });
  await test('生产题库全部可复用记录换序检查，需核验记录始终不输出直接答案', () => {
    const production = JSON.parse(fs.readFileSync(path.join(skillRoot, 'references/question-bank.json'), 'utf8'));
    const loaded = preloadQuestionBank({ root: skillRoot }); let matched = 0, review = 0;
    for (const row of production.entries) {
      const options = row.type === 'judge' ? {} : remapped(row);
      const result = lookupQuestionBank(query(row, { options }), { root: skillRoot });
      if (result.status === 'matched') {
        matched++; assert.ok(['stable', 'fixed_record', 'calculation'].includes(row.reuse_policy)); assert.deepEqual(row.issues, []);
        if (row.type === 'judge') { assert.equal(result.judge_answer, row.judge_answer); assert.equal(typeof result.judge_answer, 'boolean'); }
        else {
          const expected = new Set(row.answer_texts), actual = new Set(result.answer_texts); assert.deepEqual(actual, expected, row.id);
          assert.deepEqual(result.answer_labels.map(label => options[label]), result.answer_texts, row.id);
        }
      } else { review++; noAnswer(result); }
    }
    assert.equal(matched, loaded.eligible); assert.equal(review, loaded.review_required);
    return { remapped_matched_rows: matched, review_rows: review };
  });
}

main().catch(error => { report.fatal_error = error.stack || String(error); }).finally(() => {
  report.finished_at = new Date().toISOString(); report.passed = report.tests.filter(row => row.passed).length;
  report.failed = report.tests.filter(row => !row.passed).length + (report.fatal_error ? 1 : 0);
  fs.writeFileSync(path.join(__dirname, 'question-bank-tests.json'), JSON.stringify(report, null, 2) + '\n');
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
  process.stdout.write(`${report.passed} passed, ${report.failed} failed\n`); if (report.failed) process.exitCode = 1;
});
