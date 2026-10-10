'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../ai-literacy-search/references/sites');
function update(id, build) {
  const file = path.join(root, id + '.json');
  const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const recipe of profile.recipes) if (recipe.status === 'query_verified' && recipe.query_input && recipe.submit) recipe.execution = build(recipe);
  fs.writeFileSync(file, JSON.stringify(profile, null, 2) + '\n');
}
update('vip', recipe => ({ version: 1, queryMode: 'professional', resetEntry: true,
  parameters: { query: { type: 'string', required: true } },
  guards: [
    { locator: { css: 'input[placeholder="开始日期"]' }, property: 'value', equals: '' },
    { locator: { css: 'input[placeholder="结束日期"]' }, property: 'value', equals: '' },
  ],
  prepare: [{ action: 'click', locator: recipe.mode_switch, ifHidden: recipe.query_input }, { action: 'fill', locator: recipe.query_input, parameter: 'query' }],
  submit: { action: 'click', locator: recipe.submit },
  scope: '本库已观察专业字段表达式；未实现页面筛选与指定排序时须回退观察，不静默省略题目限制。',
}));
update('npc-laws', recipe => ({ version: 1, queryMode: 'literal', resetEntry: true,
  parameters: { query: { type: 'string', required: true }, matchMode: { type: 'string', values: ['exact', 'fuzzy'], evidenceValues: { exact: '精确', fuzzy: '模糊' } } },
  prepare: [
    { action: 'fill', locator: recipe.query_input, parameter: 'query' },
    { action: 'check', locator: { label: '精确' }, when: { parameter: 'matchMode', value: 'exact' } },
    { action: 'check', locator: { label: '模糊' }, when: { parameter: 'matchMode', value: 'fuzzy' } },
  ],
  submit: { action: 'press', locator: recipe.query_input, key: recipe.submit.key },
  scope: '标题或标识查找及明确的精确/模糊模式；机构、日期、状态等筛选仍须按题核验。',
}));
update('standards-fulltext', recipe => ({ version: 1, queryMode: 'literal', resetEntry: true,
  parameters: { query: { type: 'string', required: true } },
  prepare: [{ action: 'fill', locator: recipe.query_input, parameter: 'query' }],
  submit: { action: 'click', locator: recipe.submit },
  scope: '标准号或名称查询；返回列表仍需核对语种、状态与版本，PDF任务不自动证明全文内容。',
}));
console.log('Prepared executable search recipes for VIP, NPC law database and national standards.');
