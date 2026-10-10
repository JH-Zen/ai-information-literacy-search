'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const {createSession,VERSION}=require(path.join(root,'ai-literacy-search','scripts','browser.cjs'));
const stamp=()=>new Date().toISOString();
const normalize=value=>String(value??'').normalize('NFKC').replace(/\s+/gu,' ').trim();
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const report={version:VERSION,started_at:stamp(),method:'Playwright JavaScript library / visible Google Chrome',
 policy:'准备阶段窄实站验证；每站独立validation profile，仅自检该测试目标，不改变正常8库配置；不做答题用时统计。',max_parallel_sites:2,max_total_pages:5,checks:[]};
const file=path.join(__dirname,'v26-live-executors.json');
const write=()=>fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');
const cases=[
 {sourceId:'vip',recipeId:'vip:statistics-ranking',query:'T=数字素养',expected:'数字素养',
  stem:'请在维普中检索篇名包含数字素养的文献，并检查当前结果列表与查询条件。',quote:'数字素养'},
 {sourceId:'npc-laws',recipeId:'npc-laws:record-lookup',query:'个人信息保护法',expected:'个人信息保护法',
  stem:'请在国家法律法规数据库中查找个人信息保护法并核验当前查询结果。',quote:'个人信息保护法'},
 {sourceId:'standards-fulltext',recipeId:'standards-fulltext:record-lookup',query:'GB/T 7714',expected:'GB/T 7714',
  stem:'请在国家标准全文公开系统检索GB/T 7714，核验结果列表中的标准号、名称与状态。',quote:'GB/T 7714'}
];
const selected=process.argv.find(arg=>arg.startsWith('--ids='))?.slice(6).split(',');
const reuse=process.argv.includes('--reuse');
const previousReport=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
if(reuse&&previousReport)report.previous_runs=previousReport.checks;
if(selected&&fs.existsSync(file)){
 const previous=JSON.parse(fs.readFileSync(file,'utf8'));
 report.checks=(previous.checks||[]).filter(item=>!selected.includes(item.source_id));
}

async function check(definition){
 const previous=reuse&&previousReport?.checks.find(item=>item.source_id===definition.sourceId);
 const sessionId=previous?.session_id||'v26-executor-'+definition.sourceId+'-'+Date.now();
 const outputDir=previous?.output_dir||path.join(__dirname,sessionId);
 const profileDir=previous?.profile_dir||path.join(outputDir,'chrome-profile');
 const entry={source_id:definition.sourceId,recipe_id:definition.recipeId,query:definition.query,expected:definition.expected,
   started_at:stamp(),session_id:sessionId,output_dir:outputDir,profile_dir:profileDir,reused_owned_profile:!!previous,status:'pending',observations:[]};
 let session;
 try{
  session=await createSession({sessionId,outputDir,profileDir,preflightSourceIds:[definition.sourceId],browser:'chrome',headless:false,maxPages:2,navigationTimeoutMs:22000});
  let maxPageCount=0;
  const noteCount=()=>{maxPageCount=Math.max(maxPageCount,session.context.pages().length);};
  session.context.on('page',noteCount);noteCount();
  const preflight=await session.preflight();
  const startup=preflight.entries.find(item=>item.source_id===definition.sourceId);
  entry.preflight={completed:preflight.completed,source_ids:preflight.initialization_source_ids,entry:startup};
  const question={id:'current-'+sessionId,question:definition.stem,type:'unknown',options:{}};
  entry.question=question;
  await session.beginQuestion(question);
  const result=await session.runSearch(question,{recipeId:definition.recipeId,parameters:{query:definition.query},parameterQuotes:{query:definition.quote},expected:definition.expected,extract:{limit:6,maxChars:6000},capture:true});
  noteCount();
  entry.execution={status:result.status,outcome:result.outcome,reason:result.reason||null,binding:result.binding,data:result.data,sources:result.sources,artifact:result.artifact};
  if(result.observation)entry.observations.push({url:result.observation.url,title:result.observation.title,artifact:result.observation.artifact,text:result.observation.text?.slice(0,2200),controls:result.observation.controls});
  if(result.status==='ready'){
   const record=session.questionRecords.findLast(item=>item.question_id===question.id);
   const expectedQuestionHash=digest(JSON.stringify({question:question.question,options:[]}));
   const expectedQueryHash=digest(JSON.stringify({query:definition.query,filters:{query:definition.query},expected:definition.expected}));
   const sourcesPresent=Array.isArray(result.sources)&&result.sources.length>0;
   const records=sourcesPresent?result.sources.map(source=>session.evidence.find(item=>item.question_id===question.id&&Object.entries(source).every(([key,value])=>item.source[key]===value))):[];
   const artifacts=records.map(item=>item?.artifact).filter(Boolean);
   entry.assertions={
     startup_scope_is_only_test_source:preflight.initialization_source_ids?.length===1&&preflight.initialization_source_ids[0]===definition.sourceId,
     ready:result.status==='ready',results:result.outcome==='results',
     binding_current_question:result.binding?.question_id===question.id&&result.binding?.attempt===session.activeQuestion.attempt,
     binding_current_source:result.binding?.source_id===definition.sourceId&&result.binding?.role==='results',
     current_question_fingerprint:record?.fingerprint===expectedQuestionHash,
     current_query_fingerprint:result.binding?.query_fingerprint===expectedQueryHash,
     conditions_echo_expected:normalize(result.data?.conditions).includes(normalize(definition.expected)),
     result_text_contains_expected:normalize(result.data?.text).includes(normalize(definition.expected)),
     sources_captured:sourcesPresent,
     all_sources_tied_to_current_question:records.length===result.sources.length&&records.every(Boolean),
     real_artifacts_exist:artifacts.length===result.sources.length&&artifacts.every(artifact=>fs.existsSync(artifact.snapshot)&&fs.existsSync(artifact.screenshot)&&fs.existsSync(artifact.target_text)),
     source_query_matches:result.sources.every(source=>source.query===definition.query),
     only_owned_page_limit:Math.max(maxPageCount,session.context.pages().length)<=2,
   };
   entry.evidence_artifacts=[...new Map(artifacts.map(artifact=>[artifact.snapshot,artifact])).values()];
   entry.status=Object.values(entry.assertions).every(Boolean)?'passed':'failed';
  }else{
   const reason=result.reason||'';
   entry.status=result.status==='blocked'||/network|navigation|captcha|challenge|login|验证|登录|权限/i.test(reason)?'blocked':'needs_observation';
   if(result.page&&!result.page.isClosed()){
     const observed=await session.observe(result.page,{name:'executor-obstacle-'+definition.sourceId,compact:true,focus:[definition.expected,'验证码','正在加载']});
     entry.observations.push({url:observed.url,title:observed.title,artifact:observed.artifact,text:observed.text,controls:observed.controls});
     const screenshot=path.join(outputDir,'executor-obstacle.png');await result.page.screenshot({path:screenshot});entry.obstacle_screenshot=screenshot;
   }
   const questionRecord=session.questionRecords.findLast(item=>item.question_id===question.id);
   const queryHash=digest(JSON.stringify({query:definition.query,filters:{query:definition.query},expected:definition.expected}));
   entry.diagnostics={
    startup_scope_is_only_test_source:preflight.initialization_source_ids?.length===1&&preflight.initialization_source_ids[0]===definition.sourceId,
    transition_bound_ready:result.binding?.status==='ready',transition_outcome:result.binding?.outcome,
    binding_current_question:result.binding?.question_id===question.id&&result.binding?.attempt===session.activeQuestion.attempt,
    current_question_fingerprint:questionRecord?.fingerprint===digest(JSON.stringify({question:question.question,options:[]})),
    current_query_fingerprint:result.binding?.query_fingerprint===queryHash,
    expected_in_latest_observed_text:normalize(entry.observations.at(-1)?.text).includes(normalize(definition.expected)),
    captured_source_count:result.sources.length,
    diagnostic_screenshot_exists:!!entry.obstacle_screenshot&&fs.existsSync(entry.obstacle_screenshot),
    limitation:'Transition can be bound ready while runSearch rejects evidence capture; this is not a successful executor result or answer proof.'
   };
  }
  entry.max_own_page_count=maxPageCount;
 }catch(error){entry.status=/network|navigation|timeout|net::|captcha|challenge/i.test(error.message)?'blocked':'failed';entry.error=error.message;}
 finally{
  if(session){await session.close().catch(error=>{entry.close_error=error.message;});entry.own_context_closed=!session.context?.browser()?.isConnected();}
  entry.finished_at=stamp();report.checks.push(entry);write();
  console.log(JSON.stringify({source_id:entry.source_id,status:entry.status,outcome:entry.execution?.outcome,reason:entry.execution?.reason||entry.error,assertions:entry.assertions,own_context_closed:entry.own_context_closed}));
 }
}

(async()=>{
 const targets=cases.filter(item=>!selected||selected.includes(item.sourceId));
 // At most two isolated sites concurrently; each session allows at most two task pages.
 for(let i=0;i<targets.length;i+=2){
  const results=await Promise.allSettled(targets.slice(i,i+2).map(check));
  for(const result of results)if(result.status==='rejected'){report.fatal_errors||=[];report.fatal_errors.push(result.reason?.message||String(result.reason));}
 }
 report.completed_at=stamp();report.summary=report.checks.reduce((sum,item)=>(sum[item.status]=(sum[item.status]||0)+1,sum),{});write();
})().catch(error=>{report.fatal_error=error.message;write();process.exitCode=1;});
