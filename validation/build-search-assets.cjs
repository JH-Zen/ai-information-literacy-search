'use strict';
// Builds task routes, never an answer key. All locator claims come from the live audit.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const refs = path.join(root, 'ai-literacy-search', 'references');
const read = f => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
const write = (f,v) => { fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(v,null,2)+'\n'); };
const catalog = read(path.join(refs,'sources.json'));
const questions = read(path.join(__dirname,'recipe-input','questions.json'));
const links = read(path.join(__dirname,'recipe-input','links.json'));
const canonical = value => {const u=new URL(value);return u.hostname.toLowerCase()+u.pathname.replace(/\/$/,'')+u.search;};
const extras = {
  'www.qianwen.com':'qianwen','www.sciencedirect.com':'sciencedirect','www.aminer.cn':'aminer','www.coze.cn':'coze','yuanqi.tencent.com':'yuanqi','ima.qq.com':'ima',
  'github.com':'github','www.yixi.tv':'yixi','www.tandfonline.com':'taylor-francis','onlinelibrary.wiley.com':'wiley','ieeexplore.ieee.org':'ieee-xplore','www.zotero.org':'zotero',
  'www.ncbi.nlm.nih.gov':'ncbi-bookshelf','www.ncss.cn':'ncss','xhsz.news.cn':'curriculum-politics','kd.nsfc.cn':'nsfc','www.hippter.com':'hippter','gw.xkonglong.com':'xkonglong',
};
const sources = catalog.sources.map(x=>({id:x.id,name:x.name,url:x.url,domains:x.domains,aliases:[x.name],base_source_id:x.id,profile:'references/sites/'+x.id+'.json',task_kinds:[]}));
const linkRoutes=[];
for(const [i,l] of links.entries()){
 let s=sources.find(x=>canonical(x.url)===canonical(l.url));
 if(!s){
   const u=new URL(l.url);let id='quiz-'+(extras[u.hostname]||u.hostname.replace(/^www\./,'').replace(/[^a-z0-9]+/g,'-'));
   if(sources.some(x=>x.id===id))id+='-'+crypto.createHash('sha256').update(canonical(l.url)).digest('hex').slice(0,7);
   s={id,name:l.name,url:l.url,domains:[u.hostname],aliases:[l.name],profile:'references/sites/'+id+'.json',task_kinds:[],category:l.category};sources.push(s);
 }else if(!s.aliases.includes(l.name))s.aliases.push(l.name);
 linkRoutes.push({entry_id:'quiz-entry-'+String(i+1).padStart(3,'0'),name:l.name,url:l.url,source_id:s.id});
}
const supplemental=[
 ['ieee','IEEE 官网','https://www.ieee.org/','题面明示URL'],
 ['ncpssd','国家哲学社会科学文献中心','https://www.ncpssd.org/index','中心官网观察；刷题链接误标为社科基金查询，保留原入口另建本源'],
 ['lawyer-credit','全国律师执业诚信信息公示平台','https://credit.acla.org.cn/','司法部官网公开的平台网址'],
 ['fj-library','福建省图书馆','https://www.fjlib.net/','图书馆官网'],
 ['scu-library','四川大学图书馆','https://lib.scu.edu.cn/','图书馆官方GenAI介绍页与首页'],
 ['sysu-library','中山大学图书馆','https://library.sysu.edu.cn/','题面指定机构官网；官方微信客户端操作另行核验'],
 ['ai-data','中国知网 AI知数','https://data.cnki.net/aidata','中科院图书馆发布的官方工具使用手册指向'],
 ['aidaxue','科大讯飞 AI大学堂','https://www.aidaxue.com/','当前产品官网'],
 ['aliyun-ai-course','阿里云开发者社区人工智能学习路线','https://developer.aliyun.com/learning/roadmap/ai','当前官方学习路线'],
 ['oalib','OALib','https://www.oalib.com/','当前出版检索平台首页'],
 ['most','科学技术部','https://www.most.gov.cn/','题面指定发布机构官网'],
 ['word-support','Microsoft Word 官方支持','https://support.microsoft.com/zh-cn/word','软件发布方官方帮助'],
];
for(const [slug,name,url,origin]of supplemental){const id='quiz-'+slug;sources.push({id,name,url,domains:[new URL(url).hostname],aliases:[name],profile:'references/sites/'+id+'.json',task_kinds:[],origin,additional_to_merged_directory:true});}
const alias = {
 cnki:['CNKI','中国知网','知网'],wanfang:['万方'],vip:['维普'],duxiu:['读秀'],'chaoxing-huiya':['汇雅'],'baidu-scholar':['百度学术'],'baidu-search':['百度搜索','百度检索','百度的高级','百度高级'],
 'national-data':['国家统计局','国家数据'],'xi-speeches':['习近平系列重要讲话数据库'],'standards':['全国标准信息公共服务平台'],'standards-fulltext':['国家标准全文公开系统'],
 'patents':['国家知识产权局专利','中国专利公布公告','专利公布公告系统'],'npc-laws':['国家法律法规数据库'],'nmpa':['国家药品监督管理局','国家药监局'],'nhc':['国家卫健委','国家卫生健康委员会'],
 nlc:['国家图书馆'],'nlc-digital':['民国时期文献','古籍特藏','民族文字古籍'],'classics-navigation':['奎章阁','中国古典文献资源导航'],'court-enforcement':['失信被执行人','中国执行信息公开网'],
 yz:['研招网','中国研究生招生信息网'],chsi:['学信网'],pubscholar:['PubScholar','pubscholar'],pubmed:['PubMed'],arxiv:['arXiv'],cambridge:['剑桥数据库','Cambridge'],oxford:['牛津学术','牛津数据库','Oxford'],
 'szu-ai':['深圳大学图书馆','深大图书馆'],'unesco-students':['联合国教科文组织','UNESCO'],mooc:['中国大学MOOC','中国大学 MOOC'],
 'quiz-ieee-xplore':['IEEE Xplore'],'quiz-sciencedirect-036945c':['ScienceDirect'],'quiz-taylor-francis':['Taylor&Francis','Taylor & Francis','Taylor& Francis'],'quiz-wiley':['Wiley'],
 'quiz-curriculum-politics':['全国高校课程思政教学资源服务平台'],'quiz-nsfc':['国家自然科学基金大数据知识管理服务门户'],
 'quiz-yixi':['一席'],'quiz-ima':['腾讯ima','腾讯 ima','ima'],'quiz-qianwen':['千问','通义千问'],'quiz-github':['GitHub'],
 'excel-support':['Excel','excel'],'quiz-xkonglong':['不坑盒子','小恐龙公文排版助手'], 'quiz-ncbi-bookshelf':['bookshelf','Bookshelf'],
 'iflytek-paper':['星火科研助手'],'xinghuo':['讯飞星火'],'chatglm':['智谱清言'],'doubao':['豆包'],'yuanbao':['腾讯元宝'],
 'quiz-ncss':['高校毕业生到国际组织实习任职信息服务平台'],'quiz-hippter':['HIPPTER'],
 'acm':['ACM'],'quiz-im-qq-com':['QQ','qq'],'quiz-yunzhan365-com':['云展网'],'quiz-chkd-cnki-net':['CHKD','CHKDAI','中国医院知识总库'],
 'quiz-uspto-gov':['美国专利商标局','USPTO'],'quiz-gs-sac-net-cn':['中国证券业协会'],'quiz-lawpro-cnki-net':['中国法律知识资源总库','中国法律智库平台'],
 'quiz-higher-smartedu-cn':['国家高等教育智慧教育平台'],'quiz-ai-data':['AI知数'],'quiz-word-support':['Word','word'],'quiz-ieee':['IEEE官网','IEEE IAS'],
 'quiz-ncpssd':['国家哲学社会科学文献中心'],'quiz-lawyer-credit':['全国律师执业诚信信息公示平台'],'quiz-fj-library':['福建省图书馆'],
 'quiz-most':['科学技术部'],'quiz-oalib':['OALib'],'quiz-aidaxue':['AI大学堂'],'quiz-aliyun-ai-course':['阿里云开发者社区'],'quiz-scu-library':['四川大学图书馆'],'quiz-sysu-library':['中山大学图书馆'],
};
for(const s of sources){if(alias[s.id])s.aliases.push(...alias[s.id]);s.aliases=[...new Set(s.aliases)];}
const taskRules=[
 ['pdf-inspection',/PDF.*(全文|页数|共|第|页)|正文第|正文（|附图|说明书部分|底纹|第\s*\d+\s*页|全文共有|章节的PDF/iu],
 ['catalog-holdings',/索书号|复本|馆藏|哪些图书馆|收藏这本书|分馆/iu],
 ['citation-export',/引用格式|引文格式|导出|参考文献格式|GB.?T.?\s*7714/iu],
 ['statistics-ranking',/数量|共有|多少|最多|最少|排名|排在|前\s*\d+|被引次数最高|发文量|人数|毕业生人数|关注量|热度最高|同比|H指数|指数数据/iu],
 ['search-syntax',/表达式|检索表达|匹配的词|漏检|截词|搜索题名|搜索关键词的位置|短语检索|精确匹配|检索效率|查准率|查全率/iu],
 ['calculation',/单元格|函数|公式|查准率|查全率|百分点|比率|输出的结果/iu],
 ['product-capability',/功能|版本服务|支持|可选|可以选择|模块能力|包括哪些|筛选项|提示词模板|风格|首页|侧边栏|按钮|图标|工具栏|下拉箭头|插件|替换|快捷|Ctrl|ctrl|Shift|shift/iu],
 ['course-video',/课程|在线视频|演讲|视频|时长|讲者|章节主题|讲述|总学时|教学部门/iu],
 ['record-lookup',/检索|查询|查找|查到|找到|文献|论文|期刊|标准|专利|证书|批准文号|项目|立项|案件|立案|注册证|记录|会议|事务所/iu],
 ['navigation-membership',/栏目|类目|导航|专题|哪些网站|有哪些|内容包括/iu],
 ['official-guidance',/.*/u]
];
const parameters={
 'pdf-inspection':['document_title_or_identifier','edition_or_language','body_page_or_pdf_page','target_section'],
 'catalog-holdings':['title','author','edition','language','library','holding_field'],
 'citation-export':['record_identifier','citation_style','export_format'],
 'statistics-ranking':['query_terms','fields','boolean_relation','match_mode','start_year','end_year','resource_type','fund','sort_field','sort_direction','rank_or_threshold'],
 'search-syntax':['field','terms','operators','phrase_mode','wildcard','exclude_terms'],
 calculation:['input_values','operation','precision'],
 'product-capability':['product','client_platform','feature','menu_or_setting'],
 'course-video':['title','institution','instructor_or_speaker','chapter_or_timestamp','target_field'],
 'record-lookup':['title_or_identifier','author','institution','date_or_year','resource_type','target_field'],
 'navigation-membership':['product','section','category','target_item'],
 'official-guidance':['topic','official_publisher','version','target_statement']
};
const norm = t=>t.toLowerCase().replace(/[\s·&＆]/gu,'');
function route(q,withOptions=false){
 const text=q.stem+(withOptions?' '+q.options.map(x=>x.text).join(' '):''); const clean=text.replace(/https?:\/\/[^\s<>）)。，；]+/gu,'').normalize('NFKC').toLowerCase();const normalized=norm(clean);const matches=[];
 for(const s of sources){
  const needles=s.aliases.flatMap(a=>[a,a.replace(/[（(].*$/u,'').replace(/\/.*$/u,'')]);
  const length=Math.max(0,...needles.filter(a=>{const needle=norm(a);return needle.length>=2&&(/^[a-z0-9]+$/u.test(a.trim().toLowerCase())?new RegExp('(^|[^a-z0-9])'+needle+'($|[^a-z0-9])','u').test(clean):normalized.includes(needle));}).map(a=>norm(a).length));
  if(length)matches.push({s,length});
 }
 // Prefer the specifically named product over a shorter parent-brand name.
 matches.sort((a,b)=>b.length-a.length||Number(!a.s.base_source_id)-Number(!b.s.base_source_id));
 const selected=[];
 for(const m of matches){if(selected.some(s=>s.domains.some(d=>m.s.domains.includes(d))))continue;selected.push(m.s);}
 const urls=[...(text+' '+(q.explanation||'')).matchAll(/https?:\/\/[^\s<>）)。，；]+/gu)].map(x=>x[0]);
 for(const raw of urls){try{const url=new URL(raw);const choices=sources.filter(s=>new URL(s.url).hostname===url.hostname).sort((a,b)=>Number(url.pathname.startsWith(new URL(b.url).pathname))-Number(url.pathname.startsWith(new URL(a.url).pathname))||new URL(b.url).pathname.length-new URL(a.url).pathname.length);const s=choices[0];if(s&&!selected.some(x=>x.id===s.id||x.domains.some(d=>s.domains.includes(d))))selected.push(s);}catch{}}
 if(!selected.length&&!withOptions)return route(q,true);
 if(!selected.length){
  const inferred=[[/医疗器械|械注准/u,['nmpa']],[/专利/u,['patents']],[/CSSCI|学位论文|学术论文/u,['cnki']],[/ISSN|学术出版规范|一稿多投/u,['standards-fulltext','quiz-nppa-gov-cn']],[/单元格|函数/u,['excel-support']],[/学术出版中AIGC使用边界指南/u,['standards-fulltext']]];
  const m=inferred.find(([rx])=>rx.test(q.stem));if(m)return m[1];
 }
 return selected.map(x=>x.id);
}
const exampleTasks = questions.map(q=>{const task_kind=taskRules.find(([,rx])=>rx.test(q.stem))[0];return {example_id:q.id,year:q.year,type:q.type,task_kind,source_ids:route(q),parameters:parameters[task_kind],routing_basis:'网站名称/产品别名、题面或说明中的URL及选项涉及的产品；无指定库的记录按官方发布类别路由；未使用答案',needs_official_source_selection:route(q).length===0};});
for(const task of exampleTasks)if(task.example_id==='PT1-Q22')Object.assign(task,{routing_status:'client_required',client:'国家反诈APP',method:'在官方APP的反馈与帮助中读取当前常见问题分类；网页浏览器无法等价代替',needs_official_source_selection:false});
for(const s of sources)s.task_kinds=[...new Set(exampleTasks.filter(t=>t.source_ids.includes(s.id)).map(t=>t.task_kind))];
const instructions = {
 'pdf-inspection':['使用本题书名、标识符、语言和版次定位记录，确认正文页码与PDF物理页码的偏移后读取目标页；只在页面/全文确实可读时取证。'],
 'statistics-ranking':['把本题条件逐一填入已观察字段或该库自己的专业语法；清除上题筛选；核对结果回显、资源类型、年份、匹配方式、排序及统计口径。'],
 'record-lookup':['使用本题实体或唯一标识查找；在真实结果容器内匹配题名、作者、机构、年份或ID，打开详情读取目标字段。'],
 'catalog-holdings':['用本题书名、作者、版本和语言查馆藏；在馆藏明细读取索书号、馆藏地和复本，不将不同版次默认为同一记录。'],
 'search-syntax':['在官方检索帮助确认该字段、布尔、短语或截词规则；数据库之间不得互套语法。'],
 'citation-export':['打开本题记录的引用/导出入口，读取当前支持的格式和样式；不得沿用示例引文。'],
 'product-capability':['先确认网页版/桌面版/插件的具体产品和版本，再打开本题功能菜单或官方帮助读取选项；不提交生成、付费或个人信息。'],
 'course-video':['根据本题课程或视频名称、机构和讲者匹配记录；打开目标章节或时间点读取课程字段或播放信息。'],
 'navigation-membership':['进入本题指定栏目/分类，读取当前子类和可见成员；不能用截断列表证明不存在。'],
 calculation:['提取本题输入和操作，使用本地计算并以官方函数/统计定义核验；不能复用示例数值。'],
 'official-guidance':['优先发布机构的当前原文/官方帮助，核查完整陈述及版本，不引用题库答案作为依据。']
};
for(const s of sources){const file=path.join(root,'ai-literacy-search',s.profile);const old=fs.existsSync(file)?read(file):null;const recipes=(s.task_kinds.length?s.task_kinds:['record-lookup']).map(kind=>({id:s.id+':'+kind,source_id:s.id,task_kind:kind,status:'pending_observation',parameters:parameters[kind],instructions:instructions[kind],transitions:{}}));
 const profile={version:'2.4.0',source_id:s.id,status:'pending_observation',checked_at:null,entry:{url:s.url,status:'pending'},controls:[],recipes,blockers:[],provenance:{catalog_source_id:s.base_source_id||null,quiz_entries:linkRoutes.filter(x=>x.source_id===s.id).map(x=>x.entry_id),example_ids:exampleTasks.filter(x=>x.source_ids.includes(s.id)).map(x=>x.example_id),method:'参数化操作学习；不分发整题、答案或解析'}};
 // Rebuilding task routes must not erase a previously captured live observation.
 if(old?.checked_at){Object.assign(profile,{status:old.status,checked_at:old.checked_at,entry:old.entry,controls:old.controls,blockers:old.blockers});for(const key of ['result_items','record_identity','detail_fields','completion','query_validation','professional_search'])if(old[key]!==undefined)profile[key]=old[key];for(const recipe of recipes){const prev=old.recipes?.find(x=>x.id===recipe.id);if(prev)Object.assign(recipe,prev);}profile.provenance={...profile.provenance,...old.provenance};}
 write(file,profile);
}
const by_source={};for(const q of exampleTasks)for(const id of q.source_ids)by_source[id]=(by_source[id]||0)+1;
const by_task={};for(const q of exampleTasks)by_task[q.task_kind]=(by_task[q.task_kind]||0)+1;
const index={version:'2.4.0',preparation_defaults:{max_concurrent_sites:5,max_task_pages:5,per_domain:'serial',historical_audit_concurrency:3},examples:{total:questions.length,by_source,by_task,without_named_source:exampleTasks.filter(x=>!x.source_ids.length).map(x=>x.example_id)},sources,quiz_entries:linkRoutes,example_tasks:exampleTasks,provenance:{quiz_url:'https://89757-creater.github.io/ai-info-literacy-quiz/#/',base_catalog_count:catalog.sources.length,quiz_entry_count:links.length,merge_rule:'仅合并规范化后同host/path/query入口；保留不同产品和深链，不按共同主域自动合并。',learning_policy:'只保留任务路由和参数字段，不保存原题/选项/答案用于答题。'}};
write(path.join(refs,'search-index.json'),index);
write(path.join(__dirname,'search-assets-build.json'),{version:'2.4.0',base_sources:catalog.sources.length,quiz_entries:links.length,merged_sources:sources.length,example_tasks:exampleTasks.length,without_named_source:index.examples.without_named_source,by_task,checked_at:new Date().toISOString()});
console.log(JSON.stringify({sources:sources.length,examples:exampleTasks.length,without_named_source:index.examples.without_named_source,by_task},null,2));
