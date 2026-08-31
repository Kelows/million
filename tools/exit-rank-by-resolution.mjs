#!/usr/bin/env node
/**
 * Does bar size change WHICH exit rule wins?
 *
 * Hourly candles exist because the minute endpoint stops at 8.3h and 61% of
 * roster profit sits past 24h -- they are the only instrument that reaches
 * that band. But a trailing stop reacts to the closes it is shown, so scoring
 * a peak-relative rule on hourly bars measures the bar size as much as the
 * rule.
 *
 * This scores the same rules at both resolutions over the same wall-clock
 * window, on paths paired by (mint, entryTs), and compares the ORDERING. If
 * the ranking is stable, hourly can be trusted to choose exit parameters; if
 * it is not, every trail/arm/stop/ratchet conclusion drawn from hourly is
 * measuring the instrument.
 *
 *   node tools/exit-rank-by-resolution.mjs
 */
import { execFileSync } from 'node:child_process';
const DB='/Users/noadefago/Dev/million/apps/api/prisma/dev.db';
const q=(s)=>{const r=execFileSync('sqlite3',['-json','-readonly',DB,s],{encoding:'utf8',maxBuffer:1<<29}).trim();return r?JSON.parse(r):[]};

// exit rules, written so one implementation scores at any bar size
const trail=(pct,arm,stop,ratchet)=>(e,c)=>{
  let peak=e;
  for(const x of c){ if(!(x>0))continue; peak=Math.max(peak,x);
    if((x/e-1)*100<=-stop) return -stop;
    if(peak>=e*(1+arm/100)){
      const be = ratchet && peak>=e*1.25 ? e*1.02 : 0;
      if(x<=Math.max(peak*(1-pct/100),be)) return (x/e-1)*100; } }
  return (c.filter(v=>v>0).at(-1)/e-1)*100;
};
const holdBars=(n)=>(e,c)=>((c[Math.min(n,c.length)-1]??c.at(-1))/e-1)*100;

const RULES=[
  ['trail 10 · arm 20 · stop 50 · ratchet', trail(10,20,50,true)],
  ['trail 10 · arm 20 · stop 50 · NO ratchet', trail(10,20,50,false)],
  ['trail 10 · arm 20 · stop 30 · ratchet', trail(10,20,30,true)],
  ['trail 20 · arm 20 · stop 50 · ratchet', trail(20,20,50,true)],
  ['trail 20 · arm 20 · stop 30 · ratchet', trail(20,20,30,true)],
  ['trail 30 · arm 20 · stop 50 · ratchet', trail(30,20,50,true)],
  ['trail 20 · arm 40 · stop 50 · ratchet', trail(20,40,50,true)],
  ['hold to bar 4 (fixed horizon)', holdBars(4)],
];

const rows=q(`SELECT m.entryPrice AS ep, m.closes AS mc, h.closes AS hc
  FROM (SELECT mint,entryTs,entryPrice,closes FROM BacktestPath WHERE resolution='minute') m
  JOIN (SELECT mint,entryTs,entryPrice,closes FROM BacktestPath WHERE resolution='hour') h
    ON h.mint=m.mint AND h.entryTs=m.entryTs;`);

const paths=[];
for(const r of rows){ let mc,hc; try{mc=JSON.parse(r.mc);hc=JSON.parse(r.hc)}catch{continue}
  if(mc?.length>1&&hc?.length>1&&r.ep>0) paths.push({ep:r.ep,mc,hc}); }

const mean=(x)=>x.reduce((a,b)=>a+b,0)/x.length;
const med=(x)=>{const s=[...x].sort((a,b)=>a-b);return s[Math.floor(s.length/2)]};

// score each rule at both resolutions. Minute paths are truncated to the same
// wall-clock window the hourly replay uses, so only bar size differs.
const res=RULES.map(([name,f])=>{
  const M=[],H=[];
  for(const p of paths){
    const hoursCovered=Math.min(p.hc.length, Math.ceil(p.mc.length/60));
    M.push(f(p.ep, p.mc.slice(0, hoursCovered*60)));
    H.push(f(p.ep, p.hc.slice(0, hoursCovered)));
  }
  return {name, mMean:mean(M), mMed:med(M), hMean:mean(H), hMed:med(H)};
});

const rank=(arr,key)=>{const s=[...arr].sort((a,b)=>b[key]-a[key]);return new Map(s.map((r,i)=>[r.name,i+1]))};
const rM=rank(res,'mMean'), rH=rank(res,'hMean');

console.log(`n = ${paths.length} paired paths, identical window, only bar size differs\n`);
console.log('rule                                      MINUTE mean  rank | HOURLY mean  rank | rank moved');
for(const r of res){
  const d=rH.get(r.name)-rM.get(r.name);
  console.log(`  ${r.name.padEnd(38)} ${(r.mMean>=0?'+':'')+r.mMean.toFixed(1)+'%'} ${String(rM.get(r.name)).padStart(6)} | `+
    `${(r.hMean>=0?'+':'')+r.hMean.toFixed(1)+'%'} ${String(rH.get(r.name)).padStart(6)} | ${d===0?'  —':(d>0?'+':'')+d}`);
}
// Spearman on the ranks
const n=res.length;
const d2=res.reduce((a,r)=>a+Math.pow(rM.get(r.name)-rH.get(r.name),2),0);
console.log(`\n  Spearman rank correlation (minute vs hourly ordering): ${(1-6*d2/(n*(n*n-1))).toFixed(2)}`);
console.log(`  minute best: ${[...res].sort((a,b)=>b.mMean-a.mMean)[0].name}`);
console.log(`  hourly best: ${[...res].sort((a,b)=>b.hMean-a.hMean)[0].name}`);
