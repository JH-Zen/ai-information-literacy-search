'use strict';

// This importer treats the attachment as inert data. It never executes or fetches its contents.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SOURCE_DEFAULT = process.env.AI_LITERACY_QUESTION_BANK || path.join(__dirname, 'fixtures', '题库总表.md');
const DEST_DEFAULT = path.resolve(__dirname, '../ai-literacy-search/references/question-bank.json');
const HEADING = /^#{3,5}\s+([MABCO]\d{2})[\s\u3000]+(.+)$/u;
const OPTION = /^\s*-\s*(?:(\*\*[✔✓]\*\*|[✔✓])\s*)?([A-Z])[.、．]\s*(.+)$/u;
const ANSWER = /^\*\*(?:(官方版|平台版))?答案[：:]\s*(.*?)\*\*(.*)$/u;
const EXPLANATION = /^\*(?:(官方|平台))?解析\*[：:]\s*(.*)$/u;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const normalized = value => String(value).normalize('NFKC').replace(/\s+/gu, '').replace(/\\([*_[\]])/gu, '$1');
const renderedText = value => String(value).trim().replace(/\\([*_[\]])/gu, '$1');

// Reviewed against the supplied headings. UI features remain product scoped; database
// counts/rankings and mutable directory records remain dynamic even with a historical range.
const POLICY_IDS = {
  stable: 'A21 A45 B07 B14 C15 C28 C41 O45 O47',
  calculation: 'A07 B37 C46 O51',
  fixed_record: 'A02 A04 A05 A06 A09 A12 A13 A20 A22 A26 A27 A31 A32 A36 A48 B01 B03 B08 B18 B23 B36 B41 B42 B43 B45 B48 C07 C08 C09 C14 C19 C29 C30 C38 C47 C49 O01 O09 O10 O12 O14 O16 O19 O20 O21 O22 O23 O24 O25 O26 O27 O46 O52',
  dynamic: 'A03 A08 A10 A11 A14 A15 A16 A17 A18 A19 A41 A42 A49 B02 B04 B05 B09 B10 B12 B13 B16 B17 B19 B20 B25 B33 B39 B47 B49 C01 C03 C04 C05 C06 C11 C12 C13 C16 C17 C22 C25 C26 C27 C32 C35 C40 C43 O08 O11 O18 O28 O31 O32 O33 O34 O35 O44 O50 O53',
};
const policyById = new Map(Object.entries(POLICY_IDS).flatMap(([policy, ids]) => ids.split(' ').map(id => [id, policy])));
const POLICY_NOTES = {
  stable: '仅作为用户题库报告的概念与解析线索；相似题需重新理解当前条件与选项，不能按旧字母回答。',
  fixed_record: '只适用于同一记录、年份、版本和字段；实体或条件改变时只能复用查找方法，不能复用答案值。',
  dynamic: '计数、排名、状态或目录信息可能变化；题库答案仅为历史报告，按当前题目所需时点核验。',
  product: '产品功能、套餐、入口或界面可能变化；相似题可复用操作线索，当前版本及权限须适用。',
  calculation: '使用当前题内数据重新计算；可复用公式思路，不能沿用原题输出或答案字母。',
};

function classify(baseId, stem) {
  if (policyById.has(baseId)) return policyById.get(baseId);
  if (/数量|发文量|被引|最多|最高|最接近|当前|目前|最新|现行|排名|Open Projects|Last commit/u.test(stem)) return 'dynamic';
  return 'product';
}

function issue(entry, code, detail) {
  if (!entry.issues.includes(code)) entry.issues.push(code);
  if (detail) entry.issue_details.push({ code, detail });
}

function trueFalse(text) {
  const value = normalized(text);
  return value === '正确' ? true : value === '错误' ? false : null;
}

function extractUrls(text) {
  const matches = text.match(/https?:\/\/[^\s<>"'「」“”‘’（）()，。；]+/gu) || [];
  return [...new Set(matches.map(url => url.replace(/[。、；：\]}]+$/gu, '')))];
}

function parseBody(rows, mode) {
  const options = {};
  const optionRows = [];
  const marked = [];
  const answers = [];
  const explanationRows = [];
  const stemRows = [];
  const unparsed = [];
  let explanationActive = false;
  for (const row of rows) {
    const text = row.text;
    const opt = OPTION.exec(text);
    const answer = ANSWER.exec(text);
    const explanation = EXPLANATION.exec(text);
    if (/^\*\*题干\*\*[：:]/u.test(text)) {
      stemRows.push(row);
      explanationActive = false;
    } else if (opt) {
      if (Object.hasOwn(options, opt[2])) throw new Error(`duplicate_option:${opt[2]}:${row.line}`);
      options[opt[2]] = renderedText(opt[3]);
      optionRows.push(row);
      if (opt[1]) marked.push(opt[2]);
      explanationActive = false;
    } else if (answer) {
      answers.push({ ...row, mode: answer[1] === '官方版' ? 'official' : answer[1] === '平台版' ? 'platform' : null, raw: answer[2], suffix: answer[3] });
      explanationActive = false;
    } else if (explanation) {
      const kind = explanation[1] === '官方' ? 'official' : explanation[1] === '平台' ? 'platform' : null;
      if (!mode || !kind || kind === mode) explanationRows.push({ ...row, value: explanation[2] });
      explanationActive = !mode || !kind || kind === mode;
    } else if (!text.trim() || text === '---' || /^>\s*\*\*差异说明/u.test(text) || /^\*\*平台版（/u.test(text)) {
      explanationActive = false;
    } else if (explanationActive) {
      explanationRows.push({ ...row, value: text });
    } else {
      unparsed.push(row);
    }
  }
  return { options, optionRows, marked, answers, explanationRows, stemRows, unparsed };
}

function parseEntry(block, mode, inheritedType) {
  const body = parseBody(block.rows, mode);
  if (body.answers.length !== 1) throw new Error(`answer_count:${body.answers.length}`);
  const answer = body.answers[0];
  const stem = body.stemRows.length ? body.stemRows.map(row => row.text.replace(/^\*\*题干\*\*[：:]\s*/u, '')).join('\n') : block.title;
  const rawJudge = /^(正确|错误)(?:[（(](正确|错误)[）)])?$/u.exec(answer.raw.trim());
  const rawLabels = /^([A-Z]+)(?:[（(](正确|错误)[）)])?$/u.exec(answer.raw.trim());
  if (!rawJudge && !rawLabels) throw new Error(`malformed_answer:${answer.raw}`);
  const answerLabels = rawLabels ? [...rawLabels[1]] : [];
  if (new Set(answerLabels).size !== answerLabels.length) throw new Error(`duplicate_answer_label:${answer.raw}`);
  for (const label of answerLabels) if (!Object.hasOwn(body.options, label)) throw new Error(`missing_answer_option:${label}`);
  if (rawJudge && Object.keys(body.options).length) throw new Error('text_answer_with_options');
  const optionsJudge = Object.keys(body.options).length === 2 && Object.values(body.options).every(text => trueFalse(text) !== null);
  const type = rawJudge || inheritedType === 'judge' || optionsJudge ? 'judge' : inheritedType || (answerLabels.length > 1 ? 'multiple' : 'single');
  if (type === 'single' && answerLabels.length !== 1) throw new Error(`single_answer_count:${answerLabels.length}`);
  if (type === 'multiple' && !answerLabels.length) throw new Error('multiple_answer_empty');
  if (type === 'judge' && rawLabels && (answerLabels.length !== 1 || !optionsJudge)) throw new Error('invalid_judge_options');
  const policy = classify(block.baseId, stem);
  const entry = {
    id: mode ? `${block.baseId}:${mode}` : block.baseId,
    base_id: block.baseId,
    title: block.title,
    stem,
    type,
    options: body.options,
    answer_labels: answerLabels,
    answer_texts: rawJudge ? [rawJudge[1]] : answerLabels.map(label => body.options[label]),
    judge_answer: null,
    explanation: body.explanationRows.map(row => row.value).join('\n'),
    urls: [],
    source_kind: mode === 'official' || block.baseId.startsWith('O') ? 'user_supplied_official_sample' : 'user_supplied_platform_report',
    reuse_policy: policy,
    reuse_note: POLICY_NOTES[policy],
    line_start: block.start,
    line_end: block.end,
    answer_line: answer.line,
    option_lines: body.optionRows.map(row => row.line),
    explanation_lines: body.explanationRows.map(row => row.line),
    reported_answer: answer.raw,
    marked_labels: body.marked,
    issues: [],
    issue_details: [],
    excerpt: '',
  };
  const relevantRows = [...body.stemRows, ...body.optionRows, answer, ...body.explanationRows].sort((a, b) => a.line - b.line);
  entry.excerpt = [block.heading, ...relevantRows.map(row => row.text)].join('\n');
  entry.urls = extractUrls(entry.excerpt);
  if (rawJudge) {
    entry.judge_answer = trueFalse(rawJudge[1]);
    if (rawJudge[2] && rawJudge[1] !== rawJudge[2]) {
      issue(entry, 'ambiguous_judge_answer', `来源写作 ${answer.raw}，不选择其中任一结论。`);
      entry.judge_answer = null;
      entry.answer_texts = [rawJudge[1], rawJudge[2]];
    }
  } else if (type === 'judge') {
    entry.judge_answer = trueFalse(entry.answer_texts[0]);
    if (rawLabels[2] && trueFalse(rawLabels[2]) !== entry.judge_answer) {
      issue(entry, 'judge_label_text_conflict', `答案字母 ${answerLabels[0]} 对应“${entry.answer_texts[0]}”，括号却写“${rawLabels[2]}”。`);
      entry.judge_answer = null;
    }
  }
  if (body.marked.length && [...body.marked].sort().join('') !== [...answerLabels].sort().join('')) {
    issue(entry, 'answer_marker_conflict', `勾选 ${body.marked.join('')} 与答案 ${answerLabels.join('')} 不一致。`);
    if (type === 'judge') entry.judge_answer = null;
  }
  const reportedTexts = [...answer.suffix.matchAll(/([A-Z])「([^」]*)」/gu)];
  for (const [, label, text] of reportedTexts) {
    if (!answerLabels.includes(label) || !Object.hasOwn(body.options, label) || normalized(text) !== normalized(body.options[label])) {
      issue(entry, 'answer_text_conflict', `答案尾注 ${label}「${text}」与选项/答案字母不一致。`);
    }
  }
  if (reportedTexts.length && reportedTexts.map(match => match[1]).sort().join('') !== [...answerLabels].sort().join('')) {
    issue(entry, 'answer_text_labels_conflict', '答案尾注给出的字母集合与答案不一致。');
  }
  if (/如图|下图|图示/u.test(stem) && !/!\[[^\]]*\]\([^)]*\)/u.test(entry.excerpt)) {
    issue(entry, 'missing_figure_context', '题干依赖图示，但附件没有保留对应图。');
  }
  const explainedAnswer = /(?:可知|因此|所以)?答案(?:为|是)[：:]?\s*([A-Z]{1,8})(?![A-Za-z])/u.exec(entry.explanation);
  if (explainedAnswer && [...explainedAnswer[1]].sort().join('') !== [...answerLabels].sort().join('')) {
    issue(entry, 'explanation_answer_conflict', `解析写答案 ${explainedAnswer[1]}，标准答案为 ${answerLabels.join('')}。`);
  }
  if (!/(错误|不正确|不合适|不属于|不提供|不能|无法|不包括|不是|不支持)/u.test(stem)) {
    for (const label of answerLabels) if (new RegExp(`${label}\\s*选项(?:是|为)?错误`, 'u').test(entry.explanation)) {
      issue(entry, 'explanation_answer_conflict', `解析称所选 ${label} 选项错误，而题干要求正确项。`);
    }
  }
  if (block.baseId === 'B34' && /A是国标7714.*B为MLA.*C为APA/u.test(entry.explanation)) {
    issue(entry, 'citation_style_explanation_conflict', '解析的 APA、GB/T 7714、MLA 字母映射与实际选项格式不符；保留原文待核验。');
  }
  return { entry, unparsed: body.unparsed };
}

function importQuestionBank(source, filename = SOURCE_DEFAULT) {
  const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source, 'utf8');
  const text = bytes.toString('utf8').replace(/^\uFEFF/u, '');
  const lines = text.split(/\r?\n/u);
  const blocks = [];
  const metadataLines = new Set();
  const looseQuestionRows = [];
  let active = null;
  let inheritedType = null;
  function finish() {
    if (!active) return;
    while (active.rows.length && !active.rows.at(-1).text.trim()) active.rows.pop();
    active.end = active.rows.length ? active.rows.at(-1).line : active.start;
    blocks.push(active);
    active = null;
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const heading = HEADING.exec(line);
    if (heading) {
      finish();
      active = { baseId: heading[1], title: heading[2], heading: line, start: index + 1, rows: [], inheritedType };
    } else if (/^#{1,6}\s/u.test(line)) {
      finish();
      metadataLines.add(index + 1);
      if (/^#{3,4}\s+单选题/u.test(line)) inheritedType = 'single';
      else if (/^#{3,4}\s+多选题/u.test(line)) inheritedType = 'multiple';
      else if (/^#{3,4}\s+判断题/u.test(line)) inheritedType = 'judge';
      else inheritedType = null;
    } else if (active) {
      active.rows.push({ line: index + 1, text: line });
    } else {
      metadataLines.add(index + 1);
      if (OPTION.test(line) || ANSWER.test(line) || EXPLANATION.test(line)) looseQuestionRows.push({ line: index + 1, text: line });
    }
  }
  finish();
  const entries = [];
  const rejected = [];
  const orphanLines = [...looseQuestionRows];
  const seen = new Set();
  for (const block of blocks) {
    if (seen.has(block.baseId)) {
      rejected.push({ id: block.baseId, line: block.start, reason: 'duplicate_heading_id' });
      continue;
    }
    seen.add(block.baseId);
    if (block.baseId.startsWith('M')) {
      const split = block.rows.findIndex(row => /^\*\*平台版（/u.test(row.text));
      if (split < 0) {
        rejected.push({ id: block.baseId, line: block.start, reason: 'missing_platform_variant' });
        continue;
      }
      const sharedStem = block.rows.filter(row => /^\*\*题干\*\*[：:]/u.test(row.text));
      const officialExplanation = block.rows.filter(row => /^\*官方解析\*/u.test(row.text));
      const platformExplanation = block.rows.filter(row => /^\*平台解析\*/u.test(row.text));
      const variants = {
        official: [...block.rows.slice(0, split).filter(row => !EXPLANATION.test(row.text)), ...officialExplanation],
        platform: [...sharedStem, ...block.rows.slice(split + 1).filter(row => !EXPLANATION.test(row.text)), ...platformExplanation],
      };
      for (const [mode, rows] of Object.entries(variants)) {
        try {
          const parsed = parseEntry({ ...block, rows }, mode, 'multiple');
          entries.push(parsed.entry);
          orphanLines.push(...parsed.unparsed);
        } catch (error) { rejected.push({ id: `${block.baseId}:${mode}`, line: block.start, reason: error.message }); }
      }
    } else {
      try {
        const parsed = parseEntry(block, null, block.inheritedType);
        entries.push(parsed.entry);
        orphanLines.push(...parsed.unparsed);
      } catch (error) { rejected.push({ id: block.baseId, line: block.start, reason: error.message }); }
    }
  }
  // Introductory provenance, explanatory prose, headings and statistics are retained as
  // metadata rather than imported into an answer entry or interpreted as commands.
  const metadata = [...metadataLines].map(line => ({ line, text: lines[line - 1] }));
  const countBy = field => entries.reduce((counts, entry) => { counts[entry[field]] = (counts[entry[field]] || 0) + 1; return counts; }, {});
  const flagged = entries.filter(entry => entry.issues.length).map(entry => ({ id: entry.id, line: entry.line_start, issues: entry.issues }));
  return {
    version: 1,
    provenance: {
      file: path.resolve(filename).replace(/\\/gu, '/'),
      filename: path.basename(filename),
      name: path.basename(filename),
      sha256: sha256(bytes),
      verification: 'user_supplied_unverified',
      original_sources_verified: false,
      reported_sources: lines.filter(line => /^>\s*\*\*来源[一二]/u.test(line)),
      reported_unique_questions: 201,
      imported_source_lines: lines.length,
      metadata,
    },
    entries_sha256: sha256(JSON.stringify(entries)),
    entries,
    summary: {
      heading_questions: blocks.length,
      unique_questions: new Set(entries.map(entry => entry.base_id)).size,
      entries: entries.length,
      type_counts: countBy('type'),
      source_counts: countBy('source_kind'),
      policy_counts: countBy('reuse_policy'),
      flagged_entries: flagged.length,
      flagged,
      rejected_count: rejected.length,
      rejected,
      orphan_text_count: orphanLines.length,
      orphan_text: orphanLines,
    },
  };
}

function main() {
  const sourcePath = path.resolve(process.argv[2] || SOURCE_DEFAULT);
  const destination = path.resolve(process.argv[3] || DEST_DEFAULT);
  const bank = importQuestionBank(fs.readFileSync(sourcePath), sourcePath);
  if (bank.summary.rejected_count || bank.summary.orphan_text_count) {
    process.stderr.write(`${JSON.stringify(bank.summary, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(bank, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ destination, sha256: sha256(fs.readFileSync(destination)), ...bank.summary }, null, 2)}\n`);
}

module.exports = { importQuestionBank, extractUrls, classify, normalized, sha256 };
if (require.main === module) main();
