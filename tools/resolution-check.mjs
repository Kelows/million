#!/usr/bin/env node
/**
 * Is the minute/hourly disagreement a real effect, or an artefact of the two
 * caches covering different trades?
 *
 * Paths must be paired on (mint, entryTs) — pairing on mint alone silently
 * compares DIFFERENT entries into the same token: of 190 shareable pairs only
 * 48 share a timestamp, the rest averaging 65h apart with entry prices 167%
 * apart. That mistake produced the original "contradiction" finding.
 *
 * Decomposes the gap by replaying the hourly path over the SAME window the
 * minute path covers, which separates:
 *   A - B  bar resolution (same trade, same window, different bar size)
 *   B - C  horizon        (same bars, 5h vs 168h)
 *
 *   node tools/resolution-check.mjs
 */
import { execFileSync } from 'node:child_process';
const DB='/Users/noadefago/Dev/million/apps/api/prisma/dev.db';
const q=(s)=>{const r=execFileSync('sqlite3',['-json','-readonly',DB,s],{encoding:'utf8',maxBuffer:1<<29}).trim();return r?JSON.parse(r):[]};
function dyn(h,fb){if(h.length<20)return fb;let p=h[0];const d=[];for(const x of h){p=Math.max(p,x);d.push((1-x/p)*100)}d.sort((a,b)=>a-b);return Math.min(35,Math.max(fb,d[Math.floor(d.length*0.9)]*1.2))}
function replay(cl,e,bm,mh){
  const mb=Math.floor(mh*60/bm),arm=e*1.20,h=[];let pk=e;
  for(let i=0;i<cl.length&&i<mb;i++){const x=cl[i];if(!(x>0))continue;h.push(x);pk=Math.max(pk,x);
    if((x/e-1)*100<=-50)return -50;
    if(pk>=arm){const t=dyn(h,10);if(x<=Math.max(pk*(1-t/100),pk>=e*1.25?e*1.02:0))return (x/e-1)*100}}
  const l=cl.filter(c=>c>0).at(-1)??e;return (l/e-1)*100;
}
const st=(xs)=>{const s=[...xs].sort((a,b)=>a-b);const m=s.reduce((a,b)=>a+b,0)/s.length;
  return`mean ${m>=0?'+':''}${m.toFixed(1)}%  median ${s[Math.floor(s.length/2)]>=0?'+':''}${s[Math.floor(s.length/2)].toFixed(1)}%  win ${(xs.filter(x=>x>0).length/xs.length*100).toFixed(0)}%`};

const rows=q(`SELECT m.mint, m.entryPrice AS ep, m.closes AS mc, h.closes AS hc
  FROM (SELECT mint,entryTs,entryPrice,closes FROM BacktestPath WHERE resolution='minute') m
  JOIN (SELECT mint,entryTs,entryPrice,closes FROM BacktestPath WHERE resolution='hour') h
    ON h.mint=m.mint AND h.entryTs=m.entryTs;`);

const A=[],B=[],C=[];
for(const r of rows){
  let mc,hc; try{mc=JSON.parse(r.mc);hc=JSON.parse(r.hc)}catch{continue}
  if(!(mc?.length>1&&hc?.length>1&&r.ep>0))continue;
  const reachH = mc.length/60;                 // how far this minute path actually goes
  A.push(replay(mc,r.ep,1,168));               // minute, its natural reach
  B.push(replay(hc,r.ep,60,reachH));           // HOURLY truncated to the SAME window
  C.push(replay(hc,r.ep,60,168));              // hourly, full reach
}
console.log(`n = ${A.length} exact pairs\n`);
console.log(`  A  minute bars, reach ~${(rows.length?0:0)||''}5h        ${st(A)}`);
console.log(`  B  HOURLY bars, SAME ~5h window   ${st(B)}   <- isolates resolution`);
console.log(`  C  hourly bars, full 168h         ${st(C)}   <- isolates horizon`);
const dAB=A.map((v,i)=>v-B[i]), dBC=B.map((v,i)=>v-C[i]);
const mn=(x)=>x.reduce((a,b)=>a+b,0)/x.length;
console.log(`\n  A - B  (resolution effect, same window) : ${mn(dAB)>=0?'+':''}${mn(dAB).toFixed(1)} pts mean`);
console.log(`  B - C  (horizon effect, same resolution): ${mn(dBC)>=0?'+':''}${mn(dBC).toFixed(1)} pts mean`);
