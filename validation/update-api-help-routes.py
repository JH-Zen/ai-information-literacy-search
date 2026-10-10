"""Attach verified/documented channels to existing recipes; no runtime changes."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / 'ai-literacy-search'
read = lambda path: json.loads(path.read_text(encoding='utf-8-sig'))
write = lambda path, value: path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
api_report = read(ROOT / 'validation/api-help-crossref-pubmed.json')
extra = read(ROOT / 'validation/api-help-extra.json')
guides = read(ROOT / 'validation/api-help-chinese-guides.json')['sources']
crossref_request = next(r for r in api_report['requests'] if r['source'] == 'Crossref')
pubmed_request = next(r for r in api_report['requests'] if r['source'] == 'PubMed')
worldbank_request = read(ROOT / 'validation/api-help-worldbank-request.json')
arxiv_request = read(ROOT / 'validation/api-help-arxiv-request.json')

baseline_path = ROOT / 'validation/api-help-routing-baseline.json'
if baseline_path.exists():
    raise RuntimeError('Baseline already exists; do not overwrite original browser evidence')
ids = ['crossref', 'pubmed', 'arxiv', 'quiz-data-worldbank-org', 'vip', 'cnki', 'wanfang']
profiles = {source: read(SKILL / f'references/sites/{source}.json') for source in ids}
index = read(SKILL / 'references/search-index.json')
runtime_files = [p for p in SKILL.rglob('*') if p.is_file() and p.parts[-2] == 'scripts']
runtime_files += [p for p in (SKILL / 'runtime').rglob('*') if p.is_file()]
write(baseline_path, {'profiles': profiles, 'index': index,
    'runtime_hashes': {p.relative_to(SKILL).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in runtime_files}})

crossref = {
    'id': 'crossref-public-doi', 'kind': 'official-api', 'method': 'GET',
    'url_template': 'https://api.crossref.org/works/{doi}', 'response_format': 'json',
    'documentation': [doc['url'] for doc in api_report['sources'][0]['docs']],
    'use_when': '已知Crossref DOI，题目需其登记题录且所问字段实际存在；不替代指定的其他数据库。',
    'verification': {'status': 'sample_verified', 'checked_at': crossref_request['retrieved_at'],
        'http_status': 200, 'scope': '一次公共单DOI请求及其题录字段，非所有检索条件'},
    'field_paths': api_report['sources'][0]['example_field_paths'],
    'constraints': ['DOI编码并核对返回DOI、题名和作者；出版日期区分print/online。',
        '机构、摘要及参考文献可能未存入；缺失不能证明原文没有。',
        'is-referenced-by-count仅为Crossref口径的动态值。'],
    'limits': {'observed_pool': 'public-single', 'observed_limit_per_second': 5,
        'observed_concurrency': 1, 'public_list_limit_per_second': 1,
        'policy': '按当前响应头和官方约束限流，单源串行，429冷却；不虚构mailto。'},
    'fallback': '字段不全读出版方官方记录/授权全文；不为Swagger根页加载状态重做DOI请求。'
}
pubmed = {
    'id': 'pubmed-eutilities', 'kind': 'official-api', 'method': 'GET',
    'base_url': 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/',
    'documentation': [d['url'] for d in api_report['sources'][1]['docs'] if d.get('status') != 'browser_check_page_in_web_tool'],
    'endpoints': [
        {'path': 'esearch.fcgi', 'parameters': {'db': 'pubmed', 'term': '{query}', 'retmode': 'json'},
         'purpose': '按题检索，核对count、idlist、querytranslation及警告/错误', 'status': 'blocked_this_environment'},
        {'path': 'esummary.fcgi', 'parameters': {'db': 'pubmed', 'id': '{pmids}', 'retmode': 'json'},
         'purpose': '已知PMID的记录摘要', 'status': 'documented_only'},
        {'path': 'efetch.fcgi', 'parameters': {'db': 'pubmed', 'id': '{pmids}', 'retmode': 'xml'},
         'purpose': '完整PubMed记录；所问机构/MeSH等必须实际存在，不等于期刊全文', 'status': 'documented_only'}],
    'verification': {'status': 'blocked', 'checked_at': api_report['finished_at'], 'http_status': None,
        'attempted_endpoint': 'esearch.fcgi', 'attempts': 2,
        'reason': 'Node fetch failed；默认Windows curl证书吊销检查离线；无HTTP/API字段'},
    'use_when': '题目指定PubMed且接口恢复后，选择覆盖所问字段的最少请求；PMID已知时跳过ESearch。',
    'constraints': ['保持日期字段、类型、完整检索式、查询翻译、排序及分页；API默认排序不自动等于网站Best Match。',
        'PubMed不等于MEDLINE或PMC；不会自动提供全文权限。',
        '官方旧接口指南已停更；ESearch只可取前10000个结果，大集合用官方分段/批量方案。'],
    'limits': {'without_key_per_second_per_ip': 3, 'policy': '提供真实tool，遵守官方当前限制，单源串行；不虚构email或关闭TLS验证。'},
    'fallback': '本轮直连受阻，优先可读取的官方记录渠道；不每题重复同一失败预检。'
}
pubmed_help = {
    'id': 'pubmed-user-guide', 'kind': 'official-help', 'url': 'https://pubmed.ncbi.nlm.nih.gov/help/',
    'use_when': 'PubMed字段、语法、匹配、日期和检索翻译问题；不提供当前题的结果计数。',
    'verification': {'status': 'content_observed', 'checked_at': api_report['finished_at'],
        'guide_last_update': '2026-05-07', 'scope': '实际读取的官方用户指南相关段落'},
    'fallback': '当前界面默认值、具体结果次序或未覆盖的规则再读对应官方页面。'
}
arxiv = {
    'id': 'arxiv-public-record', 'kind': 'official-api', 'method': 'GET',
    'url_template': 'https://export.arxiv.org/api/query?id_list={id}&max_results=1',
    'response_format': 'Atom/XML',
    'documentation': [d['url'] for d in extra['official_documents'] if d['source'] == 'arXiv'],
    'use_when': '按题指定arXiv ID/版本，所问为元数据；不能用API代替PDF页数或全文参考文献。',
    'verification': {'status': 'blocked', 'checked_at': arxiv_request['finished_at'], 'http_status': 429,
        'reason': 'Rate exceeded.', 'attempts': 1},
    'field_paths': ['entry/id', 'entry/title', 'entry/published', 'entry/updated', 'entry/author/name',
        'entry/author/arxiv:affiliation', 'entry/arxiv:doi'],
    'constraints': ['检查Atom错误entry及真实记录ID；published为首提交日期，updated为该版本日期。',
        '单位及DOI可能缺失，缺失不是不存在。'],
    'limits': {'minimum_seconds_between_requests': 3, 'policy': '429按响应/官方冷却，不立即重复请求。'},
    'fallback': '使用可读的官方abs记录或正确版本全文；保留本轮限流状态。'
}
worldbank = {
    'id': 'worldbank-indicators-v2', 'kind': 'official-api', 'method': 'GET',
    'url_template': 'https://api.worldbank.org/v2/country/{country}/indicator/{indicator}?date={year}&source={source}&format=json',
    'metadata_url_template': 'https://api.worldbank.org/v2/indicator/{indicator}?source={source}&format=json',
    'response_format': 'json', 'api_key_required': False,
    'documentation': [d['url'] for d in extra['official_documents'] if d['source'] == 'World Bank'],
    'use_when': '世界银行指定国家/指标/年份/数据源数值；指标已确认时只请求缺失数值，定义缺口才读metadata。',
    'verification': {'status': 'sample_verified', 'checked_at': worldbank_request['finished_at'],
        'http_status': 200, 'scope': '一条国家/指标/年份/source观测及对应指标metadata'},
    'field_paths': ['[0].sourceid', '[0].lastupdated', '[0].page/pages/total',
        '[1][].indicator.id', '[1][].countryiso3code', '[1][].date', '[1][].value',
        'metadata[1][].sourceNote', 'metadata[1][].sourceOrganization'],
    'constraints': ['国家、指标、source和年份须全部匹配；覆盖所问范围的分页。',
        'unit可能为空；读官方指标名称/定义，不补造单位字段。',
        'null不等于零；lastupdated是数据刷新日期，不是观测年份。',
        '不替代题目指定国家统计局等其他库的口径或网站排名。'],
    'fallback': '参数或定义不明先补读相关官方说明；API失败时使用对应官方数据页。'
}

def help_channel(guide, channel_id):
    status = 'content_observed' if guide['status'] == 'verified_body' else 'body_unverified'
    return {'id': channel_id, 'kind': 'official-help', 'url': guide['docs_url'],
        'use_when': guide['product_scope'],
        'verification': {'status': status, 'checked_at': '2026-10-10',
            'time_precision': 'date', 'scope': guide['version_or_date_scope']},
        'supported_questions': guide['supported_questions'],
        'not_covered': guide['not_covered'],
        'limitations': guide['limitations'], 'fallback': guide['fast_route']}

vip_help = help_channel(guides[0], 'vip-current-search-guide')
wanfang_help = help_channel(guides[1], 'wanfang-expression-guide')
cnki_help = help_channel(guides[2], 'cnki-helpcenter')
channels = {
    'crossref:record-lookup': [crossref],
    'quiz-data-worldbank-org:record-lookup': [worldbank],
    'pubmed:record-lookup': [pubmed],
    'pubmed:statistics-ranking': [pubmed],
    'pubmed:search-syntax': [pubmed_help],
    'arxiv:record-lookup': [arxiv],
    'vip:statistics-ranking': [vip_help],
    'cnki:product-capability': [cnki_help],
    'cnki:official-guidance': [cnki_help],
    'wanfang:search-syntax': [wanfang_help],
    'wanfang:product-capability': [wanfang_help]
}
for source, profile in profiles.items():
    profile['status_scope'] = 'browser'
    for recipe in profile['recipes']:
        if recipe['id'] in channels:
            recipe['status_scope'] = 'browser'
            recipe['retrieval_channels'] = channels[recipe['id']]
            recipe['instructions'].insert(0, '先按retrieval_channels选择覆盖本题缺口的官方API/指南；原status只描述浏览器。指南不能支持当前数量或排名，受阻渠道不重复预检；需要界面时再执行下列浏览器步骤。')
    write(SKILL / f'references/sites/{source}.json', profile)

vip_profile = profiles['vip']
vip_profile['recipes'].append({'id': 'vip:search-syntax', 'source_id': 'vip',
    'task_kind': 'search-syntax', 'status': 'not_observed', 'status_scope': 'browser',
    'parameters': ['product_or_version', 'target_rule'],
    'instructions': ['按当前产品和检索模式读官方规则相关段落；无需运行统计检索，指南未覆盖的字段表再读官方图表。'],
    'retrieval_channels': [vip_help]})
write(SKILL / 'references/sites/vip.json', vip_profile)

for source in index['sources']:
    if source['id'] in ['crossref', 'quiz-data-worldbank-org']:
        source['task_kinds'] = ['record-lookup']
    if source['id'] == 'vip':
        source['task_kinds'].append('search-syntax')
    if source['id'] == 'crossref' and 'Crossref' not in source['aliases']:
        source['aliases'].append('Crossref')
    if source['id'] == 'quiz-data-worldbank-org':
        source['domains'] += ['api.worldbank.org', 'datahelpdesk.worldbank.org']
write(SKILL / 'references/search-index.json', index)
print(json.dumps({'profiles_updated': len(profiles), 'recipes_with_channels': len(channels),
    'guide_recipe_added': 1, 'runtime_changed': False, 'browser_status_preserved': True}))
