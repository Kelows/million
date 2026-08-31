#!/usr/bin/env node
/**
 * Two clocks run on this experiment and they have very different speeds.
 *
 *  FILL CLOCK — is the price we model actually obtainable? Measured as our
 *  entry against the trigger wallet's own on-chain fill. Low variance, so it
 *  converges in TENS of trades. This is the one real money answers that paper
 *  cannot, and it is nearly done.
 *
 *  EDGE CLOCK — is the mean positive? Counts trades, not dollars, so going
 *  live does not speed it up. ~1,000 trades for 68% power.
 *
 * Also scores the kill criterion from docs/state.md against two worlds: one
 * drawn from the observed distribution, one with the same fat tails and the
 * drift removed.
 *
 *   node tools/decision-clocks.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const DB='/Users/noadefago/Dev/million/apps/api/prisma/dev.db';
const MC=new URL('../docs/monte-carlo.json',import.meta.url).pathname;
const q=(s)=>{const r=execFileSync('sqlite3',['-json','-readonly',DB,s],{encoding:'utf8',maxBuffer:1<<29}).trim();return r?JSON.parse(r):[]};
const mean=(x)=>x.reduce((a,b)=>a+b,0)/x.length;
const sd=(x)=>{const m=mean(x);return Math.sqrt(x.reduce((a,b)=>a+(b-m)**2,0)/(x.length-1))};
const med=(x)=>{const s=[...x].sort((a,b)=>a-b);return s[Math.floor(s.length/2)]};

/* ---------- clock 1: the FILL question (what real money answers) ---------- */
const prem=q(`SELECT (entryPriceUsd/whaleEntryPriceUsd-1)*100 AS p FROM PaperPosition
  WHERE whaleEntryPriceUsd IS NOT NULL AND whaleEntryPriceUsd>0;`).map(r=>r.p);
const pm=mean(prem), ps=sd(prem);
console.log(`FILL CLOCK — entry premium vs the whale's own fill`);
console.log(`  n=${prem.length}  mean ${pm>=0?'+':''}${pm.toFixed(2)}%  median ${med(prem).toFixed(2)}%  sd ${ps.toFixed(2)}%`);
console.log(`  range ${Math.min(...prem).toFixed(2)}% .. ${Math.max(...prem).toFixed(2)}%`);
console.log(`  trades needed to pin the mean to +/-:`);
for(const tol of [1.0,0.5,0.25]){
  const n=Math.ceil((1.96*ps/tol)**2);
  console.log(`    +/-${tol.toFixed(2)}%  ->  n = ${n}  (${(n/30.6).toFixed(1)} days)`);
}

/* ---------- clock 2: the KILL criterion ---------- */
// state.md: after ~300 trades, kill if median < -10% AND no trade cleared +100%
if(!fs.existsSync(MC)) { console.error('run tools/monte-carlo.mjs first — it writes docs/monte-carlo.json'); process.exit(1); }
const real=JSON.parse(fs.readFileSync(MC,'utf8')).trades.map(t=>t.netPct); // "edge is real" world
const m0=mean(real);
const nullw=real.map(r=>r-m0);                        // same shape, zero drift
function mulberry32(a){return function(){a|=0;a=a+0x6d2b79f5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
const rng=mulberry32(4242);
function killRate(pool,n,TR=3000){
  let kill=0,condMed=0,condTail=0;
  for(let t=0;t<TR;t++){
    const d=Array.from({length:n},()=>pool[Math.floor(rng()*pool.length)]);
    const cm=med(d)< -10, ct=Math.max(...d)<100;
    if(cm)condMed++; if(ct)condTail++; if(cm&&ct)kill++;
  }
  return {kill:kill/TR, med:condMed/TR, tail:condTail/TR};
}
console.log(`\nKILL CLOCK — "median < -10% AND no trade over +100%"`);
console.log(`  trades  days |  P(kill | edge real)  P(kill | NO edge) | P(med<-10) real/null  P(no +100%) real/null`);
const rows=[];
for(const n of [50,100,200,300,500,1000]){
  const R=killRate(real,n), N=killRate(nullw,n);
  rows.push({n,days:+(n/30.6).toFixed(1),falseKill:R.kill,trueKill:N.kill,
             medReal:R.med,medNull:N.med,tailReal:R.tail,tailNull:N.tail});
  console.log(`  ${String(n).padStart(6)}  ${String((n/30.6).toFixed(1)).padStart(4)} |`+
    `${(R.kill*100).toFixed(1).padStart(18)}% ${(N.kill*100).toFixed(1).padStart(17)}% |`+
    `${(R.med*100).toFixed(0).padStart(12)}%/${(N.med*100).toFixed(0)}%`.padEnd(22)+
    `${(R.tail*100).toFixed(0).padStart(12)}%/${(N.tail*100).toFixed(0)}%`);
}
fs.writeFileSync(new URL('../docs/decision-clocks.json',import.meta.url).pathname,JSON.stringify({
  fill:{n:prem.length,mean:pm,median:med(prem),sd:ps,min:Math.min(...prem),max:Math.max(...prem),
        needed:[1.0,0.5,0.25].map(t=>({tol:t,n:Math.ceil((1.96*ps/t)**2)}))},
  kill:rows},null,1));
