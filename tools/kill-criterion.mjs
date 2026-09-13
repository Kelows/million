#!/usr/bin/env node
/**
 * A kill criterion that actually fires.
 *
 * The rule "median < -10% AND no trade over +100%" triggers
 * in 0.0% of runs past ~100 trades whether or not the edge is real -- the two
 * clauses pull against each other, so it carries no information. See
 * tools/decision-clocks.mjs for that measurement.
 *
 * This calibrates the line to the optimistic world instead: stop when the book
 * falls below the 5th percentile of where "the edge is real" would have put it.
 * False kills are then fixed at 5% by construction at every checkpoint, and the
 * only open question is the power against a book with no edge.
 *
 *   node tools/kill-criterion.mjs
 */
import fs from 'node:fs';
const MC=new URL('../docs/monte-carlo.json',import.meta.url).pathname;
const mean=(x)=>x.reduce((a,b)=>a+b,0)/x.length;
const med=(x)=>{const s=[...x].sort((a,b)=>a-b);return s[Math.floor(s.length/2)]};
if(!fs.existsSync(MC)) { console.error('run tools/monte-carlo.mjs first — it writes docs/monte-carlo.json'); process.exit(1); }
const real=JSON.parse(fs.readFileSync(MC,'utf8')).trades.map(t=>t.netPct), m0=mean(real);
const nullw=real.map(r=>r-m0);           // same fat tails, zero drift
function mul(a){return function(){a|=0;a=a+0x6d2b79f5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
const rng=mul(31337);
const RISK=0.05;                         // 0.5 SOL clip on a 10 SOL book

/** one book's equity multiple after n trades, drawn from `pool` */
function book(pool,n){let e=1;for(let i=0;i<n;i++){e*=1+RISK*pool[Math.floor(rng()*pool.length)]/100;if(e<=0.01)return 0}return e}

/**
 * Calibrate a THRESHOLD from the optimistic world, then measure its power
 * against the null. Killing at the 5th percentile of "edge is real" means a
 * 5% false-kill rate BY CONSTRUCTION, at any n -- the only question is how
 * often it catches a book that genuinely has no edge.
 */
const NS=[50,100,200,300,500,1000,2000];
console.log('Alternative: kill when equity falls below the 5th percentile of the "edge is real" world\n');
console.log('  trades  days |  kill line  | P(kill | edge real)  P(kill | NO edge)  <- power');
const out=[];
for(const n of NS){
  const R=Array.from({length:4000},()=>book(real,n)).sort((a,b)=>a-b);
  const line=R[Math.floor(4000*0.05)];
  const N=Array.from({length:4000},()=>book(nullw,n));
  const falseKill=R.filter(x=>x<=line).length/R.length;
  const truePower =N.filter(x=>x<=line).length/N.length;
  out.push({n,days:+(n/30.6).toFixed(1),line,falseKill,power:truePower});
  console.log(`  ${String(n).padStart(6)}  ${String((n/30.6).toFixed(1)).padStart(4)} | `+
    `${line.toFixed(2).padStart(9)}x | ${(falseKill*100).toFixed(1).padStart(18)}% ${(truePower*100).toFixed(0).padStart(17)}%`);
}
fs.writeFileSync(new URL('../docs/kill-criterion.json',import.meta.url).pathname,JSON.stringify(out,null,1));
console.log('\n  Same idea stated as a running rule: at n trades, stop if the book is below the line.');
