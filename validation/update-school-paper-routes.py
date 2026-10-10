"""Narrow routing changes from the user's school paper; no answers or runtime edits."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / 'ai-literacy-search'
read = lambda p: json.loads(p.read_text(encoding='utf-8-sig'))
write = lambda p, d: p.write_text(json.dumps(d, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
baseline_path = ROOT / 'validation/school-paper-routing-baseline.json'
if baseline_path.exists():
    raise RuntimeError('Original baseline already exists; inspect changes instead of overwriting it')
ids = ['cnki', 'excel-support', 'quiz-wiley', 'pubmed', 'crossref', 'unesco-students']
profiles = {s: read(SKILL / f'references/sites/{s}.json') for s in ids}
index = read(SKILL / 'references/search-index.json')
bundle = read(ROOT / 'validation/bundle-check.json')
write(baseline_path, {'profiles': profiles, 'index': index, 'previous_bundle': bundle})

def manual_recipe(source_id, kind, parameters, instructions, channels=None):
    value = {'id': f'{source_id}:{kind}', 'source_id': source_id, 'task_kind': kind,
        'status': 'not_observed', 'status_scope': 'browser',
        'parameters': parameters, 'instructions': instructions}
    if channels:
        value['retrieval_channels'] = channels
    return value

cnki = profiles['cnki']
help_channel = next(r for r in cnki['recipes'] if r['task_kind'] == 'official-guidance')['retrieval_channels']
cnki['recipes'].append(manual_recipe('cnki', 'search-syntax', ['resource_type', 'field', 'matching_mode', 'target_rule'],
    ['先按题目资源类型、篇名/第一作者等具体字段读知网当前帮助；精确/模糊、首页默认范围不能套维普或万方规则。指南当前正文未核验，相关缺口保留待核验。'], help_channel))
doi_request = read(ROOT / 'validation/school-paper-doi-resolution.json')
doi_channel = {'id': 'doi-url-resolution', 'kind': 'official-api', 'owner': 'DOI Foundation',
    'evidence_scope': 'resolution_only',
    'method': 'GET', 'url_template': 'https://doi.org/api/handles/{doi}?type=URL',
    'documentation': ['https://www.doi.org/the-identifier/resources/factsheets/doi-resolution-documentation'],
    'use_when': '已知DOI但缺少正确落地地址；已有正确官方记录时跳过解析，不先逐个探测元数据库。',
    'verification': {'status': 'sample_verified' if doi_request.get('http_status') == 200 and doi_request.get('response', {}).get('responseCode') == 1 else 'blocked',
        'checked_at': doi_request['finished_at'], 'http_status': doi_request.get('http_status'),
        'scope': '一条校赛给定DOI的URL解析；不验证期刊、作者或任何正文答案'},
    'field_paths': ['responseCode', 'handle', 'values[].type', 'values[].data.value'],
    'constraints': ['响应handle与本题DOI相符且responseCode成功；URL仅定位，需在目标记录读所问字段。',
        '多条URL没有默认排名含义，按官方身份与实际可读取字段选路。',
        '不从DOI后缀猜期刊或日期，Crossref无记录不证明DOI不存在。'],
    'fallback': '用https://doi.org/{doi}或题目指定库的唯一标识检索；失败不是文章不存在。'}
record_recipe = next(r for r in cnki['recipes'] if r['task_kind'] == 'record-lookup')
record_recipe['status_scope'] = 'browser'
record_recipe['retrieval_channels'] = [doi_channel]

profiles['excel-support']['recipes'].append(manual_recipe('excel-support', 'product-capability',
    ['function_or_feature', 'product_version', 'target_rule'],
    ['Excel函数/功能题先复用适用官方规则或读Microsoft支持的对应函数文档，不按calculation流程进入实际数据库；同页参数和示例可核对多个函数选项。']))
profiles['quiz-wiley']['recipes'].append(manual_recipe('quiz-wiley', 'statistics-ranking',
    ['title_terms', 'matching_mode', 'resource_type', 'start_year', 'end_year', 'analysis_field', 'sort'],
    ['题目指定Wiley Online Library时，保持本题题名、起止日期及期刊文献类型，在实际结果分析读取期刊发文量；不以Crossref总量替代。',
     '当前浏览器入口曾受验证阻挡；此流程只有手工路由，无已验证控件或execution；必须取得本题结果后才可核验。']))

for recipe in profiles['pubmed']['recipes']:
    if recipe['task_kind'] == 'record-lookup':
        recipe['field_routes'] = [
            {'target': '已知PMID的题录字段', 'route': '直接官方记录或可用EFetch；无需ESearch定位',
             'scope': '只取本题字段，API既有受阻状态保留'},
            {'target': 'PubMed记录中的物质索引', 'route': '读完整Substances字段；与MeSH、摘要词及正文物质分开',
             'scope': '未读取当前记录，不提供题目物质数；字段完整性未确认时不把缺失当0'}]
    elif recipe['task_kind'] == 'statistics-ranking':
        recipe['field_routes'] = [
            {'target': 'Completion Date + Affiliation',
             'documentation': 'https://pubmed.ncbi.nlm.nih.gov/help/#search-field-tags',
             'route': 'Completion Date使用[dcom]，Affiliation使用[ad]，按本题完整条件核对查询解释与总数',
             'scope': '字段规则已读官方帮助，非实查计数；完成日期不替换为发表日期，单位不是默认第一作者单位'},
            {'target': 'MeSH主要主题、Title通配符、Publication Type',
             'documentation': 'https://pubmed.ncbi.nlm.nih.gov/help/',
             'route': '不同字段各按官方标签解释；语法选项读帮助，动态数量/年份/类型选项读取本题结果',
             'scope': '指南不能证明当前总量或年度最高；不将全部多选项降成语法题'}]
profiles['crossref']['recipes'][0]['instructions'].insert(0,
    '先确认本题渠道适用；Crossref不收录所有DOI，没有记录时采用DOI官方解析/原发布方，不把失败写成文章不存在。已定位正确记录无需另查登记机构。')
for recipe in profiles['unesco-students']['recipes']:
    recipe['instructions'].insert(0,
        '本来源是《学生人工智能能力框架》2024英文版；《生成式人工智能教育和研究应用指南》等其他UNESCO文件必须按完整题名、语言和版本另行定位，不能共用本文件页码或表题。')
for source_id, profile in profiles.items():
    write(SKILL / f'references/sites/{source_id}.json', profile)

tags_changed = []
for source in index['sources']:
    profile = profiles.get(source['id']) or read(SKILL / source['profile'])
    actual = list(dict.fromkeys(r['task_kind'] for r in profile['recipes']))
    if source['task_kinds'] != actual:
        tags_changed.append({'source_id': source['id'], 'before': source['task_kinds'], 'after': actual})
        source['task_kinds'] = actual
write(SKILL / 'references/search-index.json', index)
inventory_path = ROOT / 'validation/school-paper-inventory.json'
inventory = read(inventory_path)
q43 = next(q for q in inventory['questions'] if q['id'] == 'G1-Q43')
q43['primary_route'] = 'fulltext_chain'
q43['scope_ambiguous'] = '借助参考文献可能指直接读出，也可能允许定位外部记录；不假定仅限题内材料'
inventory['route_counts'] = {k: sum(q['primary_route'] == k for q in inventory['questions']) for k in inventory['route_counts']}
write(inventory_path, inventory)
write(ROOT / 'validation/school-paper-routing-update.json', {'profiles_updated': ids,
    'recipes_added': ['cnki:search-syntax', 'excel-support:product-capability', 'quiz-wiley:statistics-ranking'],
    'source_task_tags_updated': tags_changed, 'runtime_code_changed': False,
    'new_execution_declarations': 0, 'raw_questions_or_answers_added_to_skill': False})
print(json.dumps({'profiles_updated': len(ids), 'recipes_added': 3, 'source_task_tags_updated': len(tags_changed), 'runtime_code_changed': False}))
