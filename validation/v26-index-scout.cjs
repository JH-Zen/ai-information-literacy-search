'use strict';
const path = require('node:path');
const os = require('node:os');
const { chromium } = require((process.env.AI_LITERACY_RUNTIME_DIR || path.join(os.homedir(), '.ailiteracy-runtime')) + '/node_modules/playwright');
(async () => {
 const ctx=await chromium.launchPersistentContext(path.join(__dirname,'v26-knowledge-profile'),{channel:'chrome',executablePath:process.env.CHROME_EXECUTABLE || undefined,headless:false,viewport:{width:1300,height:930},args:['--disable-extensions','--no-first-run']});
 const page=ctx.pages()[0];
 try{
  const response=await page.goto('https://nlp.stanford.edu/IR-book/html/htmledition/an-example-information-retrieval-problem-1.html',{waitUntil:'domcontentloaded',timeout:45000});
  console.log(JSON.stringify({status:response.status(),url:page.url(),title:await page.title(),body:(await page.locator('body').innerText()).slice(0,500),p:await page.locator('p').evaluateAll(els=>els.filter(e=>/inverted index/.test(e.innerText)).map(el=>({html:el.outerHTML.slice(0,350),text:el.innerText.slice(0,600)})))}));
 }finally {await ctx.close();}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
