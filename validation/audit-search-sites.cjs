'use strict';
// Preparation audit only. Direct official Playwright library + visible Chrome.
const fs=require('node:fs'); const path=require('node:path'); const os=require('node:os');const {createRequire}=require('node:module');
const root=path.resolve(__dirname,'..'); const refs=path.join(root,'ai-literacy-search','references');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const write=(f,v)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(v,null,2)+'\n');};
const index=read(path.join(refs,'search-index.json'));
const runtimeRequire=createRequire(path.join(os.homedir(),'.ailiteracy-runtime','package.json'));
const {chromium}=runtimeRequire('playwright');
const out=path.join(__dirname,'site-audit-v24');fs.mkdirSync(out,{recursive:true});
const sourceArg=process.argv.find(x=>x.startsWith('--ids='));const only=sourceArg?.slice(6).split(',');
const reportFile=path.join(out,only?'report-supplemental.json':'report.json');
const candidates=index.sources.filter(s=>!only||only.includes(s.id));
const {performance}=require('node:perf_hooks');
const report={version:'2.4.0',started_at:new Date().toISOString(),sources_total:candidates.length,concurrency:5,max_retries:2,records:[]};
const rootDomain=h=>{const p=h.split('.');return p.slice(/\.(?:com|gov|edu|org)\.cn$/u.test('.'+h)?-3:-2).join('.');};
const sameDomain=(href,s)=>{try{const h=new URL(href).hostname;return s.domains.some(d=>h===d||h.endsWith('.'+d));}catch{return false;}};
function publishedURL(raw){try{const u=new URL(raw);for(const key of [...u.searchParams.keys()])if(/captcha|token|session|return|redirect|callback|ticket|code|nonce|state|auth|login|sign|key|timestamp|^t$|uuid/iu.test(key))u.searchParams.delete(key);return u.href;}catch{return raw;}}
async function observe(page,source,suffix){
 let data=await page.evaluate(()=>{
  const visible=e=>{const r=e.getBoundingClientRect();const style=getComputedStyle(e);return r.width>0&&r.height>0&&style.visibility!=='hidden'&&style.display!=='none';};
  const esc=s=>CSS.escape(s);
  const controls=[...document.querySelectorAll('input,textarea,select,button,[role="button"],[role="searchbox"],[role="combobox"],[role="textbox"]')].filter(visible).slice(0,150).map(e=>{
   const id=e.id;const name=e.getAttribute('name');const placeholder=e.getAttribute('placeholder');const aria=e.getAttribute('aria-label');
   const lab=e.labels?.[0]?.innerText?.trim()||'';let css=null;
   if(id&&document.querySelectorAll('#'+esc(id)).length===1)css='#'+esc(id);
   else if(name){const c=e.tagName.toLowerCase()+'[name="'+name.replace(/"/g,'\\"')+'"]';if(document.querySelectorAll(c).length===1)css=c;}
   else if(placeholder){const c=e.tagName.toLowerCase()+'[placeholder="'+placeholder.replace(/"/g,'\\"')+'"]';if(document.querySelectorAll(c).length===1)css=c;}
   const text=(aria||lab||e.innerText||e.value||placeholder||'').trim().slice(0,180);
   return {tag:e.tagName.toLowerCase(),type:e.getAttribute('type'),text,label:lab,aria_label:aria,placeholder,name,id,css,role:e.getAttribute('role'),form_action:e.form?.action||null};
  });
  return {url:location.href,title:document.title,body:document.body?.innerText||'',controls,links:[...document.querySelectorAll('a[href]')].filter(visible).map(e=>({text:e.innerText.trim().slice(0,160),href:e.href,target:e.target})).filter(e=>e.text||e.href).slice(0,400),frames:[...document.querySelectorAll('iframe')].map(e=>({src:e.src,id:e.id,name:e.name,title:e.title}))};
 });
 if(!data||typeof data!=='object')data={url:page.url(),title:await page.title().catch(()=>''),body:await page.locator('body').innerText({timeout:5000}).catch(()=>''),controls:[],links:[],frames:[],observation_limit:'页面evaluate返回空，改用Playwright原生locator读取正文；控件结构待重新观察。'};
 data.observed_at=new Date().toISOString();data.source_id=source.id;data.snapshot=path.relative(root,path.join(out,source.id+'-'+suffix+'.json')).replace(/\\/g,'/');
 write(path.join(out,source.id+'-'+suffix+'.json'),data);
 try{await page.screenshot({path:path.join(out,source.id+'-'+suffix+'.png'),timeout:4000});}catch{}
 return data;
}
function auth(data){
 const head=data.body.slice(0,1800);const all=data.body;const url=data.url;
 if(/验证码|安全验证|人机验证|人机检测|完成验证|滑动验证|验证码验证|Verify you are human|Checking your browser|Access Denied|Robot Check|请先完成|系统检测|验证后即可/iu.test(head))return 'captcha_required';
 if(/\/(?:login|signin|sso)(?:[/?#]|$)|passport\./iu.test(url)||(/用户名|手机号|账号/iu.test(head)&&/密码|验证码|扫码登录/iu.test(head)&&all.length<6000))return 'login_required';
 if(/无法访问此网站|ERR_|此站点不安全|Privacy error|此网页无法显示/iu.test(head))return 'network_error';
 return 'accessible';
}
function locator(c){
 if(c.css&&/^#(?:el-id|rc-|radix-|headlessui|mui-)/u.test(c.css))return c.placeholder?{css:c.tag+'[placeholder="'+c.placeholder.replace(/"/g,'\\"')+'"]'}:c.label?{label:c.label}:null;
 if(c.css)return {css:c.css};
 if(c.label)return {label:c.label};
 if(c.aria_label)return {role:c.role||(['textarea','input'].includes(c.tag)?'textbox':'button'),name:c.aria_label,exact:true};
 if(c.tag==='button'&&c.text)return {role:'button',name:c.text,exact:true};
 return null;
}
function updateProfile(s,data,entry,status,errors,more){
 const f=path.join(root,'ai-literacy-search',s.profile);const p=read(f);p.checked_at=new Date().toISOString();p.status=status==='accessible'?'entry_observed':'blocked';
 p.entry={url:s.url,final_url:publishedURL(data?.url||entry.url),title:data?.title||'',status,http_status:entry.http_status,checked_at:p.checked_at,identity: {declared_name:s.name,hostname:data?.url?new URL(data.url).hostname:null,domain_matches:data?sameDomain(data.url,s):false},links:data?.links?.filter(x=>/检索|搜索|search|advanced|专业|高级|help|帮助|课程|资源|数据库/iu.test(x.text)).slice(0,24).map(x=>({...x,href:publishedURL(x.href)}))||[],frames:(data?.frames||[]).map(x=>({...x,src:publishedURL(x.src)}))};
 p.controls=(data?.controls||[]).map(c=>({...c,locator:locator(c),observed_url:publishedURL(data.url),observed_at:data.observed_at}));
 p.blockers=errors;
 if(status!=='accessible'&&!errors.length)p.blockers.push({kind:status,detail:'需在当前可见页面人工验证或授权；未确认可用检索。'});
 for(const recipe of p.recipes){recipe.status=status==='accessible'?'entry_observed':'blocked';recipe.entry_url=status==='accessible'&&sameDomain(data.url,s)?publishedURL(data.url):s.url;recipe.controls=p.controls.filter(c=>c.locator);recipe.transitions={};recipe.pending=['结果容器、完成标志与页面打开方式仍需真实查询确认'];}
 p.provenance={...p.provenance,audit:{checked_at:p.checked_at,browser:'Google Chrome',api:'Playwright JavaScript library',snapshot:data?.snapshot||null,original_entry_snapshot:more?.snapshot||data?.snapshot||null,identity_limit:'匹配来源域名不等于核验所有内容；查询未执行时不得声称检索验证完成。'}};
 write(f,p);
 return p;
}
async function main(){
 const executable=[process.env.ProgramFiles,process.env['ProgramFiles(x86)'],path.join(os.homedir(),'AppData','Local')].filter(Boolean).map(p=>path.join(p,'Google','Chrome','Application','chrome.exe')).find(fs.existsSync);
 const ctx=await chromium.launchPersistentContext(path.join(os.homedir(),'.ailiteracy-runtime','profiles','chrome','v24-preparation-audit'),{headless:false,channel:'chrome',executablePath:executable,viewport:{width:1280,height:840},ignoreHTTPSErrors:false});
 const pages=ctx.pages();const first=pages[0]||await ctx.newPage();for(const p of pages.slice(1))await p.close();
 const workers=[first];while(workers.length<5)workers.push(await ctx.newPage());
 ctx.on('page',p=>{if(!workers.includes(p))p.close().catch(()=>{});});
 const pending=candidates.slice();const active=new Set();let taken=0;
 async function worker(page){
  for(;;){let pos=pending.findIndex(s=>!active.has(rootDomain(new URL(s.url).hostname)));if(pos<0){if(!pending.length)break;await new Promise(r=>setTimeout(r,150));continue;}
   const s=pending.splice(pos,1)[0];const domain=rootDomain(new URL(s.url).hostname);active.add(domain);const began=performance.now();let data=null,original=null,status='network_error',entry={url:s.url,http_status:null};const errors=[];let attempts=0;
   try{
    for(;attempts<3;attempts++){
     try{const response=await page.goto(s.url,{waitUntil:'domcontentloaded',timeout:10000});entry.http_status=response?.status()||null;await page.waitForTimeout(700);data=await observe(page,s,'entry');original=data;status=auth(data);if(entry.http_status>=400){status='http_error';errors.push({kind:'http_error',http_status:entry.http_status});}break;}
     catch(e){errors.push({kind:'network_error',attempt:attempts+1,detail:e.message.slice(0,600)});if(page.url().startsWith('http')){try{data=await observe(page,s,'partial');if(data.body.length>300&&sameDomain(data.url,s)&&!/^chrome-error/.test(data.url)){status=auth(data);original=data;break;}}catch{}}}
    }
    if(status==='accessible'&&data){
     // Follow only a current observed same-domain advanced/search link; no guessed URL.
     const deeper=data.links.find(x=>sameDomain(x.href,s)&&/高级检索|专业检索|advanced search|advanced-search/iu.test(x.text)&&new URL(x.href).pathname!==new URL(data.url).pathname);
     if(deeper){try{await page.goto(deeper.href,{waitUntil:'domcontentloaded',timeout:10000});await page.waitForTimeout(700);data=await observe(page,s,'search-entry');status=auth(data);}catch(e){errors.push({kind:'search_entry_navigation',detail:e.message.slice(0,300)});data=original;}}
    }
    const profile=updateProfile(s,data,entry,status,errors,original);
    report.records.push({source_id:s.id,status:profile.status,access_status:status,url:s.url,final_url:data?.url||null,title:data?.title||null,controls:profile.controls.length,locators:profile.controls.filter(x=>x.locator).length,snapshot:data?.snapshot||null,attempts:Math.min(attempts+1,3),elapsed_ms:Math.round(performance.now()-began)});
   }catch(e){report.records.push({source_id:s.id,status:'blocked',access_status:'audit_error',error:e.message});updateProfile(s,data,entry,'audit_error',[{kind:'audit_error',detail:e.message}],original);}
   finally{active.delete(domain);taken++;if(taken%10===0||taken===candidates.length){report.updated_at=new Date().toISOString();write(reportFile,report);console.log(JSON.stringify({completed:taken,total:candidates.length,last:s.id,status,accessible:report.records.filter(x=>x.access_status==='accessible').length}));}}
  }
 }
 await Promise.all(workers.map(worker));report.completed_at=new Date().toISOString();report.summary=report.records.reduce((o,r)=>(o[r.access_status]=(o[r.access_status]||0)+1,o),{});write(reportFile,report);await ctx.close();console.log(JSON.stringify({done:true,total:report.records.length,summary:report.summary}));
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
