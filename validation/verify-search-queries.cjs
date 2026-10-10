'use strict';
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const {createRequire}=require('node:module');
const root=path.resolve(__dirname,'..'),refs=path.join(root,'ai-literacy-search','references'),out=path.join(__dirname,'site-audit-v24');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const write=(f,v)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(v,null,2)+'\n');};
const {chromium}=createRequire(path.join(os.homedir(),'.ailiteracy-runtime','package.json'))('playwright');
const index=read(path.join(refs,'search-index.json'));
const only=process.argv.find(x=>x.startsWith('--ids='))?.slice(6).split(',')||['cnki','wanfang','vip','baidu-scholar','npc-laws','national-data','standards-fulltext','arxiv','pubmed'];
const term=process.argv.find(x=>x.startsWith('--term='))?.slice(7)||'人工智能素养';
async function snapshot(page,id,stage){
 const d=await page.evaluate(()=>{
  const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';};
  const selector=e=>{if(e.id&&!/^el-id|^rc-|^radix-|^mui-/u.test(e.id)&&document.querySelectorAll('#'+CSS.escape(e.id)).length===1)return '#'+CSS.escape(e.id);if(e.getAttribute('placeholder')){const c=e.tagName.toLowerCase()+'[placeholder="'+e.getAttribute('placeholder').replace(/"/g,'\\"')+'"]';if(document.querySelectorAll(c).length===1)return c;}const classes=[...e.classList].filter(c=>!/^is-|^el-|^active|^focus|^selected|^hover|^css-/u.test(c)&&c.length<90);for(const c of classes){const sel=e.tagName.toLowerCase()+'.'+CSS.escape(c);if(document.querySelectorAll(sel).length===1)return sel;}return null;};
  const controlElements=[...document.querySelectorAll('input,textarea,select,button,a,[role="button"],[role="combobox"],[role="textbox"]')].filter(visible);
  const textControls=[...document.querySelectorAll('div,span,li,p')].filter(e=>visible(e)&&e.children.length<3&&/^(专业检索|高级检索|检索|搜索|查询|题名|篇名|主题|关键词|摘要|作者单位|作者|查询|Search)$/iu.test(e.innerText.trim()));
  const containers=[...document.querySelectorAll('[class],[id],table,[role="list"],[role="table"],[role="grid"]')].filter(e=>visible(e)&&/result|list|article|paper|search|table|content|message|record|empty/iu.test(e.className+' '+e.id)).map(e=>({css:selector(e),tag:e.tagName.toLowerCase(),class:e.className,id:e.id,text:e.innerText.slice(0,3500),children:e.children.length})).filter(e=>e.css&&e.text.trim()).slice(0,120);
  return {url:location.href,title:document.title,body:document.body.innerText,controls:[...new Set([...controlElements,...textControls])].map(e=>({tag:e.tagName.toLowerCase(),css:selector(e),text:(e.innerText||e.value||'').trim().slice(0,300),placeholder:e.getAttribute('placeholder'),role:e.getAttribute('role'),name:e.getAttribute('name'),href:e.href||null,target:e.target||null})),containers,frames:[...document.querySelectorAll('iframe')].map(e=>({id:e.id,name:e.name,src:e.src}))};
 });
 d.observed_at=new Date().toISOString();write(path.join(out,id+'-query-'+stage+'.json'),d);await page.screenshot({path:path.join(out,id+'-query-'+stage+'.png'),timeout:4000}).catch(()=>{});return d;
}
function blocked(d){return /安全验证|完成.*验证|向右滑动|验证码|Access Denied|Verify you are human|reCAPTCHA|检查您的浏览器/iu.test(d.title+' '+d.body.slice(0,1800));}
async function main(){
 const executable=[process.env.ProgramFiles,process.env['ProgramFiles(x86)'],path.join(os.homedir(),'AppData','Local')].filter(Boolean).map(p=>path.join(p,'Google','Chrome','Application','chrome.exe')).find(fs.existsSync);
 const ctx=await chromium.launchPersistentContext(path.join(os.homedir(),'.ailiteracy-runtime','profiles','chrome','v24-preparation-audit'),{headless:false,channel:'chrome',executablePath:executable,viewport:{width:1280,height:840}});
 let page=ctx.pages()[0]||await ctx.newPage();for(const p of ctx.pages().slice(1))await p.close();const records=[];
 for(const id of only){const s=index.sources.find(x=>x.id===id);if(!s)continue;const profile=read(path.join(root,'ai-literacy-search',s.profile));const recipe=profile.recipes[0];let before,after;const row={source_id:id,checked_at:new Date().toISOString(),query:term};
  try{
   const entry=recipe.entry_url||s.url;await page.goto(entry,{waitUntil:'domcontentloaded',timeout:15000}).catch(e=>row.navigation_error=e.message.slice(0,350));await page.waitForTimeout(1400);before=await snapshot(page,id,'before');
   if(blocked(before)){row.status='captcha_required';records.push(row);console.log(JSON.stringify(row));continue;}
   const mode=page.getByText('专业检索',{exact:true});if(['cnki','wanfang','vip'].includes(id)&&await mode.count()===1&&await mode.isVisible()){await mode.click();await page.waitForTimeout(500);before=await snapshot(page,id,'professional');row.mode='professional';}
   if(id==='wanfang'){const field=page.getByText('题名',{exact:true}).filter({visible:true});if(await field.count()===1&&await field.isVisible()){await field.click();row.field_generated=await page.locator('textarea[maxlength="800"]').inputValue().catch(()=>null);}}
   if(id==='arxiv'){const observed=before.controls.find(c=>c.tag==='a'&&c.text==='Search'&&c.href);if(observed){await page.goto(observed.href,{waitUntil:'domcontentloaded',timeout:15000}).catch(e=>row.search_entry_error=e.message.slice(0,200));before=await snapshot(page,id,'search-entry');}}
   let input=before.controls.find(c=>c.tag==='textarea'&&c.css)||before.controls.find(c=>c.tag==='input'&&c.css&&(/检索|搜索|search|Enter|2012年|请输入|Search/iu.test(c.placeholder||'')||id==='baidu-scholar'));
   if(!input){const visibleBoxes=await page.locator('textarea:visible').count();if(visibleBoxes===1)input={tag:'textarea',css:id==='wanfang'?'textarea[maxlength="800"]':'textarea:visible'};}
   if(!input){const choices=before.controls.filter(c=>c.tag==='input'&&c.css&&(/term|query|search/iu.test(c.css+' '+c.name)));if(choices.length===1)input=choices[0];}
   if(!input){for(const c of before.controls.filter(c=>c.tag==='input'&&c.placeholder)){const css='input[placeholder="'+c.placeholder.replace(/"/g,'\\"')+'"]:visible';if(await page.locator(css).count()===1){input={...c,css};break;}}}
   if(!input){row.status='input_unresolved';records.push(row);console.log(JSON.stringify(row));continue;}
   const generated=row.field_generated||'';const professionalQuery=generated?generated.includes('()')?generated.replace('()','(人工智能素养)'):generated.includes('""')?generated.replace('""','"人工智能素养"'):generated+'人工智能素养':'人工智能素养';
   const query=id==='wanfang'?professionalQuery:id==='vip'&&before.body.includes('T=篇名')?'T='+term:id==='national-data'?'2024年 全国 第一产业就业人员':id==='arxiv'||id==='pubmed'?'artificial intelligence literacy':id==='standards-fulltext'?'儿童口罩':row.query;row.query=query;row.input={css:input.css};
   await page.locator(input.css).fill(query);before=await snapshot(page,id,'filled');
   const submits=before.controls.filter(c=>/^(检索|搜索|查询|Search)$/iu.test(c.text.replace(/\s/gu,''))&&!['input','textarea'].includes(c.tag));
   const submit=submits.find(c=>c.tag==='button'&&c.css)||submits.find(c=>c.css)||submits.find(c=>c.tag==='button')||submits[0];
   let locator=submit?.css?page.locator(submit.css):submit?page.getByText(submit.text,{exact:true}):null;
   if(locator&&await locator.count()!==1)locator=null;
   const pagesBefore=new Set(ctx.pages());const newPages=[];const opened=p=>newPages.push(p);ctx.on('page',opened);
   row.submit=submit?submit.css?{css:submit.css}:{text:submit.text,exact:true}:{action:'press Enter'};
   if(locator)await locator.click({timeout:5000});else await page.locator(input.css).press('Enter');
   await page.waitForTimeout(4000);ctx.off('page',opened);
   const target=newPages.find(p=>!p.isClosed())||page;await target.waitForLoadState('domcontentloaded',{timeout:12000}).catch(()=>{});await target.waitForTimeout(1200);after=await snapshot(target,id,'results');
   row.mode_actual=target===page?'same-page':'popup';row.final_url=after.url;row.title=after.title;row.status=blocked(after)?'captcha_required':/no results|很抱歉|没有找到|未查询到|暂无|无结果|0 results/iu.test(after.body)?'empty_or_failed_pending_review':after.body.length>200?'results_pending_review':'loading_or_failed';row.result_candidates=after.containers.filter(c=>/result|list|paper|article|record/iu.test(c.class+' '+c.id)).map(c=>({css:c.css,excerpt:c.text.slice(0,160)})).slice(0,18);
   if(id==='npc-laws'&&row.status==='results_pending_review'){
    const title='深圳经济特区人工智能产业促进条例';const item=target.getByText(title,{exact:true});if(await item.count()===1){const detailPages=[];const detailListener=p=>detailPages.push(p);ctx.on('page',detailListener);await item.click();await target.waitForTimeout(1800);ctx.off('page',detailListener);const detail=detailPages[0]||target;await detail.waitForLoadState('domcontentloaded',{timeout:10000}).catch(()=>{});await detail.waitForTimeout(900);const dd=await snapshot(detail,id,'detail');row.detail={mode:detail===target?'same-page':'popup',url:dd.url,title:dd.title,containers:dd.containers.map(c=>({css:c.css,excerpt:c.text.slice(0,150)})).slice(0,20)};}
   }
   if(id==='vip'&&row.status==='results_pending_review'){
    const record=after.controls.find(c=>c.tag==='a'&&c.target==='_blank'&&/^https:\/\/www\.cqvip\.com\/doc\//u.test(c.href||''));if(record){const item=target.getByRole('link',{name:record.text,exact:true});if(await item.count()===1){const detailPages=[];const listener=p=>detailPages.push(p);ctx.on('page',listener);await item.click();await target.waitForTimeout(1800);ctx.off('page',listener);const detail=detailPages[0]||target;await detail.waitForLoadState('domcontentloaded',{timeout:10000}).catch(()=>{});await detail.waitForTimeout(1200);const dd=await snapshot(detail,id,'detail');row.detail={mode:detail===target?'same-page':'popup',url:dd.url,title:dd.title,containers:dd.containers.map(c=>({css:c.css,excerpt:c.text.slice(0,150)})).slice(0,20)};}}
   }
   if(id==='standards-fulltext'&&row.status==='results_pending_review'){
    const tr=target.getByRole('row').filter({hasText:/GB\/T 38880-2020[\s\S]*推标/u});if(await tr.count()===1){const link=tr.getByText('查看详细',{exact:true});if(await link.count()===1){const detailPages=[];const listener=p=>detailPages.push(p);ctx.on('page',listener);await link.click();await target.waitForTimeout(1800);ctx.off('page',listener);const detail=detailPages[0]||target;await detail.waitForLoadState('domcontentloaded',{timeout:10000}).catch(()=>{});await detail.waitForTimeout(1200);const dd=await snapshot(detail,id,'detail');row.detail={mode:detail===target?'same-page':'popup',url:dd.url,title:dd.title,containers:dd.containers.map(c=>({css:c.css,excerpt:c.text.slice(0,150)})).slice(0,20)};}}
   }
   for(const p of ctx.pages())if(p!==page&&!pagesBefore.has(p))await p.close().catch(()=>{});
  }catch(e){row.status='query_error';row.error=e.message.slice(0,600);}
  records.push(row);write(path.join(out,'query-report.json'),{checked_at:new Date().toISOString(),records});console.log(JSON.stringify(row));
 }
 write(path.join(out,'query-report.json'),{checked_at:new Date().toISOString(),records});await ctx.close();
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
