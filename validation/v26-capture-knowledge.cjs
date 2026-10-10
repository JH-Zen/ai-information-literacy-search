'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { chromium } = require((process.env.AI_LITERACY_RUNTIME_DIR || path.join(os.homedir(), '.ailiteracy-runtime')) + '/node_modules/playwright');
const taskRoot = path.dirname(__dirname);
const skillRoot = path.join(taskRoot,'ai-literacy-search');
const output = path.join(skillRoot,'references','rule-evidence');
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const words = text => text.trim().split(/\s+/).length;

const definitions = [
  {
    id: 'doi-basics', name: 'DOI Foundation：DOI 标识与解析',
    url: 'https://www.doi.org/doi-handbook/html/',
    scope: 'DOI 系统的通用标识、持久性与解析定义；不据 DOI 字符串猜测具体文献事实',
    claims: {
      identity: 'DOI 是实体的全球唯一标识符，可标识数字、物理或抽象实体，不只用于期刊论文。',
      persistence: 'DOI 标识与其解析到的信息分开维护；目标 URL 等信息可以更新，而 DOI 与被标识实体的对应关系保持。',
      resolution: 'DOI 可以解析到资源、描述实体的元数据或提供进一步访问入口的落地页；仅有 DOI 不能证明全文可免费获得。'
    },
    exclusions: ['任何具体 DOI 的题名、作者、机构、期刊、年份和全文内容', '某篇文献能否访问、是否开放获取及当前权限', '仅按 DOI 后缀猜出版日期、期刊或文献类型', '承诺任何 DOI 永远成功解析或资源永远存在'],
    sections: [
      { nav: /^1\s+DOI System Overview$/, subsection: /^1\.3\s+Identifier\/Resolution System within the Handle System$/, selector: 'p', text: /^A DOI name is a global unique identifier/, excerpt: 'global unique identifier', filename: 'doi-basics-identity.png' },
      { nav: /^1\s+DOI System Overview$/, subsection: /^1\.9\s+Persistence as a Design Feature of the DOI System$/, selector: 'p', text: /^Through the DOI name resolution concept/, excerpt: 'while the mapping of the DOI name to the entity persists', filename: 'doi-basics-persistence.png' },
      { nav: /^1\s+DOI System Overview$/, subsection: /^1\.2\s+Basic Principle: Integration of Identifier Resolution and Semantics$/, selector: 'li', text: /^an identification system of entities based on the Handle System/, excerpt: 'a landing page with access to further resources', filename: 'doi-basics-resolution.png' }
    ]
  },
  {
    id: 'isbn-basics', name: '国际 ISBN 机构：图书产品标识',
    url: 'https://www.isbn-international.org/content/what-isbn/10',
    scope: 'ISBN 的名称、产品识别粒度及版本和格式区别；不确认具体图书的编目记录',
    claims: {
      meaning: 'ISBN 是 International Standard Book Number，即国际标准书号。',
      product: 'ISBN 标识注册者以及具体题名、版本和产品格式；它的识别粒度不是图书馆内某一个实体复本。',
      formats: '同一内容的不同产品形式（例如平装、EPUB、PDF）应分别标识，不能因为题名相同就视为同一 ISBN。'
    },
    exclusions: ['某一本书的实际 ISBN、分类号、馆藏地点、索书号或可借数量', '单凭 ISBN 判断内容质量、版权许可或完整书目信息', '把所有再版、重印和封面变化一律当作必须换号；这些须核验具体分配规则', '把 ISBN 与馆内用于区分实体复本的条码混同'],
    sections: [
      { selector: 'p', text: /^An ISBN is an International Standard Book Number/, excerpt: 'International Standard Book Number', filename: 'isbn-basics-identity.png' },
      { selector: 'p', text: /^An ISBN is essentially a product identifier/, excerpt: 'The ISBN identifies the registrant as well as the specific title, edition and format.', filename: 'isbn-basics-product.png' },
      { selector: 'p', text: /^With regard to the various media available/, excerpt: 'each different product form', filename: 'isbn-basics-formats.png' }
    ]
  },
  {
    id: 'issn-basics', name: 'ISSN 国际中心：连续出版物标识',
    url: 'https://www.issn.org/understanding-the-issn/what-is-an-issn/',
    scope: 'ISSN 的通用识别对象、编码形式及不保证内容质量的边界；不判断具体刊物或文章',
    claims: {
      identity: 'ISSN 是 International Standard Serial Number，即国际标准连续出版物号，用于识别连续出版资源，不限纸质媒介。',
      format: 'ISSN 由八位组成，通常写为两组四位并以连字符分开；最后一位是校验位，可以为 X。',
      quality: 'ISSN 本身不编码出版物来源或内容信息，也不保证内容质量或有效性。'
    },
    exclusions: ['具体期刊 ISSN、刊期、收录情况、核心期刊资格与排名', '单凭 ISSN 判断某篇文章的作者、质量或是否经过同行评议', '不同媒介是否共享同一个 ISSN 或 ISSN-L 的细则', '某数据库的 ISSN 检索语法或匹配方式'],
    sections: [
      { selector:'p', text:/^An ISSN \(International Standard Serial Number\)/, excerpt:'identifies all continuing resources', filename:'issn-basics-identity.png' },
      { selector:'p', text:/^The ISSN takes the form/, excerpt:'this eighth control digit may be an “X”', filename:'issn-basics-format.png' },
      { selector:'li', text:/^it does not guarantee the quality or validity/, excerpt:'it does not guarantee the quality or validity of the contents.', filename:'issn-basics-quality.png', screenshotParent:true }
    ]
  },
  {
    id:'inverted-index', name:'信息检索教材：倒排索引',
    url:'https://nlp.stanford.edu/IR-book/html/htmledition/an-example-information-retrieval-problem-1.html',
    scope:'通用文本检索中倒排索引、词典与倒排列表的基本定义；不证明具体引擎的实现与性能',
    claims: {
      mapping:'倒排索引从词项关联到出现该词项的文档或出现位置。',
      components:'基本结构包含词项词典，以及记录每个词项出现在哪些文档中的倒排列表；列表中的一项称为 posting。'
    },
    exclusions:['特定搜索引擎、数据库的实际算法、字段索引或排序方式', '每个系统都保存词项位置的断言', '索引实时更新频率、覆盖率、搜索耗时或绝对性能保证', '厂商特定语法或数据库实际检索结果'],
    sections:[{selector:'p',text:/This idea is central to/,excerpt:'list that records which documents',filename:'inverted-index.png'}]
  }
];

async function uniqueVisible(page, selector, text) {
  const matches = page.locator(selector).filter({hasText:text});
  await matches.first().waitFor({state:'visible',timeout:15000});
  const count = await matches.count();
  const visible = [];
  for(let i=0;i<count;i++) if(await matches.nth(i).isVisible()) visible.push(matches.nth(i));
  if(visible.length!==1) throw new Error(`Expected one visible target; found ${visible.length} for ${text}`);
  return visible[0];
}

(async () => {
  const context = await chromium.launchPersistentContext(path.join(__dirname,'v26-knowledge-profile'),{
    executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:false,
    viewport:{width:1300,height:930},args:['--disable-extensions','--no-first-run']
  });
  const page = context.pages()[0] || await context.newPage();
  const report = { method:'Playwright JavaScript library / visible Google Chrome', profile:'validation/v26-knowledge-profile', cards:[] };
  fs.mkdirSync(output,{recursive:true});
  const verified=[];
  try {
    for(const definition of definitions.filter(item=>process.argv.length<3 || process.argv.slice(2).includes(item.id))) {
      const entry={id:definition.id,status:'pending',requested_url:definition.url};
      try {
        const response=await page.goto(definition.url,{waitUntil:definition.id==='doi-basics'?'load':'domcontentloaded',timeout:45000});
        if(!response?.ok()) throw new Error(`HTTP ${response?.status()}`);
        const screenshots=[], excerpts=[], sections=[];
        for(const section of definition.sections) {
          if(section.nav) {
            // The chapter opens its actual subsection navigation; no DOM/style alteration.
            await (await uniqueVisible(page,'a.handbook-nav',section.nav)).click();
            await (await uniqueVisible(page,'a',section.subsection)).click();
          }
          const locator=await uniqueVisible(page,section.selector,section.text);
          await locator.scrollIntoViewIfNeeded();
          const actual=await locator.innerText();
          if(!actual.includes(section.excerpt)) throw new Error('Short excerpt not present in observed target.');
          const screenshotTarget=section.screenshotParent?locator.locator('..'):locator;
          await screenshotTarget.screenshot({path:path.join(output,section.filename)});
          excerpts.push(section.excerpt); screenshots.push(section.filename);
          sections.push({section:section.subsection?.source || null,locator:`${section.selector} filtered by ${section.text}`,excerpt:section.excerpt,screenshot:section.filename,visible:true});
        }
        if(excerpts.reduce((sum,excerpt)=>sum+words(excerpt),0)>25) throw new Error('Combined source excerpts exceed 25 English words.');
        const observedAt=new Date().toISOString();
        const observation={url:page.url(),title:await page.title(),observed_at:observedAt,method:report.method,
          excerpts,sections,claims_basis:Object.fromEntries(Object.entries(definition.claims).map(([key,summary])=>[key,{summary,kind:key==='resolution' || key==='product'?'bounded interpretation of observed definition':'paraphrase of observed definition'}]))};
        const jsonFilename=definition.id+'.json';
        fs.writeFileSync(path.join(output,jsonFilename),JSON.stringify(observation,null,2)+'\n','utf8');
        const artifacts=[jsonFilename,...screenshots].map(filename=>({path:'references/rule-evidence/'+filename,sha256:sha256(path.join(output,filename))}));
        const {sections:unusedSections,...rule}=definition;
        verified.push({...rule,status:'verified',freshness:'stable',url:observation.url,verified_at:observedAt,artifacts});
        Object.assign(entry,{status:'verified',url:observation.url,title:observation.title,verified_at:observedAt,artifacts,quote_words:excerpts.reduce((sum,excerpt)=>sum+words(excerpt),0)});
      }catch(error){entry.error=error.message;}
      report.cards.push(entry); console.log(JSON.stringify({id:entry.id,status:entry.status,error:entry.error}));
    }
    if(verified.length) {
      const rulesPath=path.join(skillRoot,'references','rules.json');
      const catalog=JSON.parse(fs.readFileSync(rulesPath,'utf8').replace(/^\uFEFF/,''));
      const ids=new Set(verified.map(card=>card.id));
      catalog.version='1.1.0';
      catalog.rules=[...catalog.rules.filter(card=>!ids.has(card.id)),...verified];
      fs.writeFileSync(rulesPath,JSON.stringify(catalog,null,2)+'\n','utf8');
    }
    const oldReportPath=path.join(__dirname,'v26-knowledge-verification.json');
    if(fs.existsSync(oldReportPath)) {
      const old=JSON.parse(fs.readFileSync(oldReportPath,'utf8'));
      const reportedIds=new Set(report.cards.map(item=>item.id));
      report.cards=[...old.cards.filter(item=>!reportedIds.has(item.id)),...report.cards];
    }
    report.completed_at=new Date().toISOString();
    fs.writeFileSync(path.join(__dirname,'v26-knowledge-verification.json'),JSON.stringify(report,null,2)+'\n','utf8');
  }finally{await context.close();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
