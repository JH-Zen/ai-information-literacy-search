'use strict';
const fs=require('node:fs'),path=require('node:path');const {performance}=require('node:perf_hooks');
const root=path.resolve(__dirname,'..');const {createSession}=require(path.join(root,'ai-literacy-search','scripts','browser.cjs'));
const result={version:'2.4.0',checked_at:new Date().toISOString(),checks:[],policy:'备赛窄实站集成，仅preflight目标库；不更改日常八库规则。'};
const selected=process.argv.find(x=>x.startsWith('--ids='))?.slice(6).split(',');
if(selected&&fs.existsSync(path.join(__dirname,'live-recipe-v24.json'))){try{const old=JSON.parse(fs.readFileSync(path.join(__dirname,'live-recipe-v24.json'),'utf8'));result.checks=(old.checks||[]).filter(c=>!selected.includes(c.source_id));}catch{}}
const write=()=>fs.writeFileSync(path.join(__dirname,'live-recipe-v24.json'),JSON.stringify(result,null,2)+'\n');
async function check(sourceId,recipeId,query,expected,kind){
 const began=performance.now();const sessionId='v24-live-'+sourceId+'-'+Date.now();const session=await createSession({sessionId,outputDir:path.join(__dirname,sessionId),preflightSourceIds:[sourceId],navigationTimeoutMs:20000});const report={source_id:sourceId,recipe_id:recipeId,query,expected,started_at:new Date().toISOString(),session_id:sessionId};
 try{
  const preflight=await session.preflight();report.preflight_total=preflight.initialization_source_ids?.length||1;session.beginQuestion('new-question-'+sessionId);
  const recipe=session.recipe(recipeId);const page=await session.page(sourceId,{recipeId});
  if(sourceId==='vip'){const mode=session.locator(page,recipe.mode_switch).filter({visible:true});if(await mode.count()!==1)throw new Error('Current professional mode switch is not unique');await mode.click();await session.observe(page,{name:'professional-mode',compact:true});}
  const input=session.locator(page,recipe.query_input);await input.waitFor({state:'visible',timeout:12000});if(await input.count()!==1||!await input.isVisible())throw new Error('Current query input is not unique and visible');
  await input.fill(query);await session.observe(page,{name:'filled-new-question',compact:true});
  const transitioned=await session.transition(sourceId,{questionId:'new-question-'+sessionId,fromPage:page,toRole:'results',recipeId,query,expected,timeoutMs:25000,trigger:async()=>{if(recipe.submit.action==='press')await input.press(recipe.submit.key);else await session.locator(page,recipe.submit).click();}});
  report.transition={status:transitioned.status,outcome:transitioned.outcome,mode:transitioned.binding.mode,role:transitioned.binding.role,url:transitioned.page.url(),question_id:transitioned.binding.question_id};
  if(transitioned.status==='blocked'){report.status='blocked';report.blocker=transitioned.observation.title+' '+transitioned.observation.text.slice(0,300);}
  else{
   if(kind!=='empty')await transitioned.container.filter({hasText:expected}).waitFor({state:'visible',timeout:15000});
   const structure=await transitioned.container.evaluate(el=>({tag:el.tagName.toLowerCase(),id:el.id,class:el.className,nodes:[...el.querySelectorAll('*')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0;}).slice(0,180).map(e=>({tag:e.tagName.toLowerCase(),class:e.className,id:e.id,text:e.innerText?.trim().slice(0,140)||'',children:e.children.length,parent_tag:e.parentElement?.tagName.toLowerCase(),parent_class:e.parentElement?.className}))}));
   fs.writeFileSync(path.join(__dirname,'site-audit-v24',sourceId+'-runtime-result-structure.json'),JSON.stringify(structure,null,2)+'\n');report.structure_snapshot='validation/site-audit-v24/'+sourceId+'-runtime-result-structure.json';
   await session.recordSearch(sourceId,{page:transitioned.page,query,outcome:transitioned.outcome,detail:'使用当前分发recipe与新参数进行窄实站验证'});
   const text=await transitioned.container.innerText();const evidence=sourceId==='vip'&&kind==='empty'?'暂无数据':text.trim().split(/\r?\n/u).filter(Boolean).find(line=>line.includes(expected))||text.trim().split(/\r?\n/u).filter(Boolean)[0];
   const captured=await session.captureEvidence(transitioned.page,{questionId:'new-question-'+sessionId,name:session.source(sourceId).name,query,field:kind==='empty'?'当前检索零结果标志':'当前结果列表',locator:JSON.stringify(recipe.transitions.results.container),target:transitioned.container,evidence});
   report.status='passed';report.evidence={text:evidence,url:captured.source.url,snapshot:captured.artifact.snapshot,screenshot:captured.artifact.screenshot};report.assertions={bound_current_question:true,current_parameters:true,record_search:true,capture_evidence:true,expected_outcome:kind==='empty'?'empty':'results',correct_outcome:transitioned.outcome===(kind==='empty'?'empty':'results')};
   if(!report.assertions.correct_outcome)report.status='failed';
  }
 }catch(e){report.status='failed';report.error=e.message;}
 finally{await session.close().catch(()=>{});report.context_closed=true;report.elapsed_ms=Math.round(performance.now()-began);result.checks.push(report);write();console.log(JSON.stringify({source_id:sourceId,kind,status:report.status,error:report.error,outcome:report.transition?.outcome,elapsed_ms:report.elapsed_ms,context_closed:true}));}
}
async function main(){
 if(!selected||selected.includes('npc-laws'))await check('npc-laws','npc-laws:record-lookup','民法典','民法典','results');
 if(!selected||selected.includes('vip')){await check('vip','vip:statistics-ranking','T=信息伦理素养','信息伦理素养','results');await check('vip','vip:statistics-ranking','T=页面核验唯一无题名词20261009XYZ','页面核验唯一无题名词20261009XYZ','empty');}
 result.completed_at=new Date().toISOString();result.summary=result.checks.reduce((o,x)=>(o[x.status]=(o[x.status]||0)+1,o),{});write();
}
main().catch(e=>{result.fatal_error=e.message;write();process.exitCode=1;});
