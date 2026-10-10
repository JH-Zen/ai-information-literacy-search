'use strict';

// Local calculation/save regressions. No browser, daemon, network, or online claim.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SearchSession, VERSION } = require('../ai-literacy-search/scripts/browser.cjs');
const startedAt = new Date().toISOString();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'v282-calculation-offline-'));
const session = new SearchSession({ sessionId: 'v282-calculation-offline', outputDir: path.join(temp, 'output'), runtimeDir: path.join(temp, 'runtime') });
Object.defineProperty(session, 'context', { get() { throw new Error('Local calculations must not read a browser context.'); } });
session.start = () => { throw new Error('Local calculations must not launch Chrome.'); };
const cases = [
  { name: 'explicit percent rounding', suffix: '查全率和查准率分别是多少？百分比保留两位小数。', options: { A: '33.33%、40.00%', B: '40.00%、33.33%' } },
  { name: 'Arabic decimal precision', suffix: '求查全率与查准率，百分比保留2位小数。', options: { A: '33.33%、40%', B: '33.34%、40%' } },
  { name: 'incorrect rounded selection', suffix: '查全率和查准率分别是多少？百分比保留两位小数。', options: { A: '33.33%、40%', B: '33.34%、40%' }, label: 'B', status: 'partial' },
  { name: 'unrounded option is not rounded answer', suffix: '求查全率和查准率，百分比保留两位小数。', options: { A: '33.33333333333333%、40%', B: '40%、33.33%' }, status: 'partial' },
  { name: 'no precision keeps strict comparison', suffix: '查全率和查准率分别是多少？', options: { A: '33.33%、40%', B: '40%、33.33%' }, status: 'partial' },
  { name: 'approximate wording does not invent precision', suffix: '查全率和查准率分别约为多少？', options: { A: '33.33%、40%', B: '40%、33.33%' }, status: 'partial' },
  { name: 'exact common request preserved', total: 160, retrieved: 80, suffix: '查全率和查准率分别是多少？', options: { A: '25%、50%', B: '50%、25%' } },
  { name: 'last explicit order overrides definitions', total: 160, retrieved: 80, prefix: '已知查全率用于衡量漏检情况，查准率用于衡量检出质量。', suffix: '请按查准率、查全率的顺序给出结果。', options: { A: '50%、25%', B: '25%、50%' } },
  { name: 'last explicit order rejects old order', total: 160, retrieved: 80, prefix: '已知查全率用于衡量漏检情况，查准率用于衡量检出质量。', suffix: '请按查准率、查全率的顺序给出结果。', options: { A: '50%、25%', B: '25%、50%' }, label: 'B', status: 'partial' },
  { name: 'prefix request order', total: 160, retrieved: 80, suffix: '求查准率和查全率。', options: { A: '50%、25%', B: '25%、50%' } },
  { name: 'result clause order', total: 160, retrieved: 80, suffix: '则查准率与查全率依次为：', options: { A: '50%、25%', B: '25%、50%' } },
  { name: 'single requested metric ignores definitions', prefix: '查全率与查准率是两种检索指标。', suffix: '查准率是多少？', options: { A: '40%', B: '33.33%' } },
  { name: 'aliases preserved', total: 160, retrieved: 80, suffix: '召回率和精确率分别为（ ）。', options: { A: '25%、50%', B: '50%、25%' } },
  { name: 'negative explicit metric result selection', suffix: '查准率的下列计算结果错误的是？', options: { A: '40%', B: '40.0%', C: '60%', D: '40.00%' }, label: 'C' },
  { name: 'negative explicit metric rejects correct-value choice', suffix: '查准率的下列计算结果错误的是？', options: { A: '40%', B: '40.0%', C: '60%', D: '40.00%' }, status: 'partial' },
  { name: 'positive explicit metric result selection', suffix: '查准率的下列计算结果正确的是？', options: { A: '40%', B: '60%' } },
  { name: 'positive explicit metric rejects wrong-value choice', suffix: '查准率的下列计算结果正确的是？', options: { A: '40%', B: '60%' }, label: 'B', status: 'partial' },
  { name: 'last reverse metric order in negative result request', total: 160, retrieved: 80, prefix: '已知查全率用于衡量漏检情况，查准率用于衡量检出质量。', suffix: '查准率、查全率的下列计算结果错误的是？', options: { A: '50%、25%', B: '25%、50%' }, label: 'B' },
  { name: 'negative reverse request rejects correct ordered values', total: 160, retrieved: 80, prefix: '已知查全率用于衡量漏检情况，查准率用于衡量检出质量。', suffix: '查准率、查全率的下列计算结果错误的是？', options: { A: '50%、25%', B: '25%、50%' }, status: 'partial' },
  { name: 'missing metrics stay unresolved', suffix: '检索效果如何？', options: { A: '33.33%、40%', B: '40%、33.33%' }, status: 'partial' },
  { name: 'definition is not an output request', suffix: '查全率和查准率分别是衡量覆盖程度和结果质量的指标。', options: { A: '33.33%、40%', B: '40%、33.33%' }, status: 'partial' },
  { name: 'ambiguous positional request stays unresolved', total: 160, retrieved: 80, prefix: '查全率用于衡量漏检，查准率用于衡量质量。', suffix: '上述两个指标分别是多少？', options: { A: '25%、50%', B: '50%、25%' }, status: 'partial' },
  { name: 'different precisions stay unresolved', suffix: '查全率保留两位小数，查准率保留一位小数。查全率和查准率分别是多少？', options: { A: '33.33%、40.0%', B: '40.0%、33.33%' }, status: 'partial' },
  { name: 'one metric precision does not cover both', retrieved: 90, suffix: '查全率保留两位小数。求查全率和查准率。', options: { A: '33.33%、44.44%', B: '44.44%、33.33%' }, status: 'partial' },
  { name: 'same explicit precision for each metric', retrieved: 90, suffix: '查全率保留两位小数，查准率保留两位小数。求查全率和查准率。', options: { A: '33.33%、44.44%', B: '44.44%、33.33%' } },
  { name: 'integer decimal precision', suffix: '求查全率和查准率，百分比保留0位小数。', options: { A: '33%、40%', B: '34%、40%' } },
  { name: 'decimal ratio precision', operation: 'ratio-percent', part: 1, whole: 3, suffix: '比例保留三位小数。', options: { A: '0.333', B: '0.334' } },
  { name: 'rounding boundary', operation: 'ratio-percent', part: 201, whole: 20000, suffix: '比例用百分比表示，保留两位小数。', options: { A: '1.01%', B: '1.00%' } },
  { name: 'rounding boundary wrong answer rejected', operation: 'ratio-percent', part: 201, whole: 20000, suffix: '比例用百分比表示，保留两位小数。', options: { A: '1.01%', B: '1.00%' }, label: 'B', status: 'partial' },
  { name: 'percent precision does not round raw ratio instead', suffix: '求查全率和查准率，百分比保留两位小数。', options: { A: '0.33、0.4', B: '0.4、0.33' }, status: 'partial' },
];

try {
  for (const [index, entry] of cases.entries()) {
    const operation = entry.operation || 'retrieval-metrics';
    const total = entry.total || 120, retrieved = entry.retrieved || 100, relevant = 40;
    const inputQuotes = operation === 'retrieval-metrics'
      ? { relevantTotal: `共有相关文献${total}篇`, retrieved: `本次检出${retrieved}篇`, relevantRetrieved: `其中相关${relevant}篇` }
      : { part: `其中${entry.part}个符合要求`, whole: `共有${entry.whole}个` };
    const data = operation === 'retrieval-metrics' ? `某库${inputQuotes.relevantTotal}，${inputQuotes.retrieved}，${inputQuotes.relevantRetrieved}。`
      : `某集合${inputQuotes.whole}，${inputQuotes.part}。`;
    const question = { id: `calculation-${index}`, type: 'single', question: (entry.prefix || '') + data + entry.suffix, options: entry.options };
    session.beginQuestion(question);
    const calculated = session.calculate(question, { operation, inputQuotes,
      inputs: operation === 'retrieval-metrics' ? { relevantTotal: total, retrieved, relevantRetrieved: relevant } : { part: entry.part, whole: entry.whole } });
    const label = entry.label || 'A';
    const saved = session.saveAnswer(question, { id: question.id, question: question.question, type: 'single', status: 'verified',
      answer: [question.options[label]], answer_labels: [label], explanation: '按当前题内输入计算，核对输出顺序及明确的小数位要求。',
      option_evaluations: Object.entries(question.options).map(([key, text]) => ({ label: key, text, verdict: key === label ? 'supported' : 'refuted', reason: '离线回归输入及当前选项。' })),
      sources: [calculated.source], needs_review: [], searched_at: new Date().toISOString() });
    assert.equal(saved.answer.status, entry.status || 'verified', entry.name);
    if (entry.status === 'partial') assert.ok(saved.answer.needs_review.some(message => message.startsWith('计算答案待核验：')), entry.name + ' must identify calculation uncertainty');
    else assert.deepEqual(saved.answer.needs_review, [], entry.name);
    assert.equal(saved.jsonPath, null);
    assert.equal(saved.markdownPath, null);
  }
  assert.equal(fs.existsSync(path.join(temp, 'output')), false, 'local memory evidence must not create answer archives');
  const report = { status: 'passed', cases: cases.length, passed: cases.length, failed: 0, helper_version: VERSION,
    started_at: startedAt, finished_at: new Date().toISOString(), tests: cases.map(entry => ({ name: entry.name, passed: true })),
    browser_started: false, network_used: false, archive_created: false };
  fs.writeFileSync(path.join(__dirname, 'v282-calculation-tests.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  process.stdout.write(JSON.stringify(report) + '\n');
} finally {
  const relative = path.relative(os.tmpdir(), temp);
  if (!relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(temp).startsWith('v282-calculation-offline-')) fs.rmSync(temp, { recursive: true, force: true });
}
