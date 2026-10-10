'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require((process.env.AI_LITERACY_RUNTIME_DIR || path.join(os.homedir(), '.ailiteracy-runtime')) + '/node_modules/playwright');
const root = __dirname;
const targets = [
  ['doi', 'https://www.doi.org/doi-handbook/html/', /persistent identifier|identif.*location|access.*content|free.*access|access control|10\.|opaque/i],
  ['isbn', 'https://www.isbn-international.org/content/what-isbn/10', /specific title|specific edition|product form|ISBN.*13|International Standard Book Number|copy|copies/i],
  ['issn', 'https://www.issn.org/understanding-the-issn/what-is-an-issn/', /eight|8-digit|International Standard|serial|article|content|origin|numeric|medium|media/i],
  ['inverted-index', 'https://nlp.stanford.edu/IR-book/html/htmledition/an-example-information-retrieval-problem-1.html', /dictionary of terms|which documents|inverted index|posting|not called/i]
];
(async () => {
  const profile = path.join(root, 'v26-knowledge-profile');
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: false, viewport: { width: 1300, height: 930 },
    args: ['--disable-extensions', '--no-first-run']
  });
  const page = context.pages()[0] || await context.newPage();
  const report = [];
  try {
    for (const [id,url,re] of targets) {
      const entry = { id, requested_url: url };
      try {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.locator('body').waitFor({ state: 'visible', timeout: 15000 });
        entry.url = page.url(); entry.title = await page.title(); entry.status = response?.status();
        const elements = await page.locator('p,li,h1,h2,h3,h4').evaluateAll(elements => elements.map((el,index) => ({index, tag:el.tagName, id:el.id, class:el.className, text:(el.innerText || '').trim()})).filter(el=>el.text));
        entry.matches = elements.filter(el=>re.test(el.text)).map(el=>({...el,text:el.text.slice(0,2600)})).slice(0,60);
      } catch(error) { entry.error = error.message; }
      report.push(entry);
      console.log(JSON.stringify(entry));
    }
    fs.writeFileSync(path.join(root,'v26-knowledge-scout.json'), JSON.stringify(report,null,2)+'\n');
  } finally { await context.close(); }
})().catch(error => { console.error(error.stack); process.exitCode=1; });
