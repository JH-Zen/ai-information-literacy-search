'use strict';
const path = require('node:path');
const os = require('node:os');
const { chromium } = require((process.env.AI_LITERACY_RUNTIME_DIR || path.join(os.homedir(), '.ailiteracy-runtime')) + '/node_modules/playwright');
(async () => {
 const ctx = await chromium.launchPersistentContext(path.join(__dirname,'v26-knowledge-profile'),{channel:'chrome',executablePath:process.env.CHROME_EXECUTABLE || undefined,headless:false,viewport:{width:1300,height:930},args:['--disable-extensions','--no-first-run']});
 const page=ctx.pages()[0];
 try {
  page.on('pageerror',e=>console.log(JSON.stringify({pageerror:e.message})));
  await page.goto('https://www.doi.org/doi-handbook/html/',{waitUntil:'load',timeout:45000});
  console.log(JSON.stringify({title:await page.title(),links:await page.locator('a').evaluateAll(els=>els.filter(el=>/1\s+DOI System Overview/.test(el.innerText)).map(el=>({text:el.innerText,href:el.getAttribute('href'),cls:el.className,outer:el.outerHTML}))),frames:page.frames().map(f=>f.url())}));
  const nav = page.locator('a').filter({hasText:/^1\s+DOI System Overview$/});
  console.log(JSON.stringify({nav_count:await nav.count()}));
  if(await nav.count()===1) await nav.click();
  console.log(JSON.stringify({after_click_links:await page.locator('a').evaluateAll(els=>els.filter(el=>/^1\.(?:2|3|9)\s/.test(el.innerText)).map(el=>({text:el.innerText,cls:el.className,html:el.outerHTML,visible:!!el.getClientRects().length}))),scripts:await page.locator('script[src]').evaluateAll(els=>els.map(e=>e.getAttribute('src')))}));
  await page.screenshot({path:path.join(__dirname,'v26-doi-scout.png')});
 }finally {await ctx.close();}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
