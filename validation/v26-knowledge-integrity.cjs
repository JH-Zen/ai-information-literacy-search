'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const root=path.join(__dirname,'..','ai-literacy-search');
const {installLocalEvidence}=require(path.join(root,'scripts','local-evidence.cjs'));
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const inside=(parent,file)=>{const relative=path.relative(path.resolve(parent),path.resolve(file));return relative!==''&&!relative.startsWith('..')&&!path.isAbsolute(relative);};
class RuleReader {}
installLocalEvidence(RuleReader,{root,hash,inside});
const reader=new RuleReader();
const catalog=JSON.parse(fs.readFileSync(path.join(root,'references','rules.json'),'utf8'));
const newIds=['doi-basics','isbn-basics','issn-basics','inverted-index'];
const bySource={};
const checks=catalog.rules.map(card=>{
 const verified=reader.ruleCard(card.id);
 const observation=JSON.parse(fs.readFileSync(path.join(root,verified.artifacts.find(item=>item.path.endsWith('.json')).path),'utf8'));
 const quoteWords=observation.excerpts.join(' ').trim().split(/\s+/).length;
 bySource[card.url]=(bySource[card.url]||0)+quoteWords;
 const screenshots=verified.artifacts.filter(item=>item.path.endsWith('.png')).map(item=>{
   const buffer=fs.readFileSync(path.join(root,item.path));
   if(buffer.toString('hex',0,8)!=='89504e470d0a1a0a')throw new Error('Not a PNG');
   return {path:item.path,width:buffer.readUInt32BE(16),height:buffer.readUInt32BE(20)};
 });
 if(!screenshots.length||screenshots.some(item=>!item.width||!item.height))throw new Error('Missing actual screenshot');
 if(!Object.keys(card.claims).length||!card.scope||!card.exclusions.length)throw new Error('Missing bounded rule claims');
 return {id:card.id,verified_at:card.verified_at,claims:Object.keys(card.claims),quote_words:quoteWords,screenshots};
});
for(const [source,total] of Object.entries(bySource))if(total>25)throw new Error(`Excerpts exceed 25 words for ${source}`);
if(!newIds.every(id=>checks.some(item=>item.id===id)))throw new Error('New rule missing');
const report={verified_at:new Date().toISOString(),status:'passed',new_cards:4,total_cards:checks.length,
  checks:['runtime ruleCard() reads all rules with validated artifact hashes','official observation URLs and timestamps match cards','all rules have claims, scope and exclusions','PNG evidence is present and nonempty','combined literal English excerpts do not exceed 25 words per source'],quote_words_by_source:bySource,cards:checks};
fs.writeFileSync(path.join(__dirname,'v26-knowledge-integrity.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({status:report.status,new_cards:report.new_cards,total_cards:report.total_cards}));
