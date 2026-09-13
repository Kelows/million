#!/usr/bin/env node
/**
 * Draws the README's loop diagram: docs/loop-light.svg and docs/loop-dark.svg.
 *
 * GitHub renders a README SVG as an <img>, so it cannot inherit the page's
 * colors; the README switches between the two files with <picture>. Both come
 * from this one drawing so they cannot drift apart.
 *
 * Ribbon height is proportional to log10(count) — the narrowing IS the filter.
 * Counts are from the first instance's run.
 *
 *   node tools/readme-loop.mjs
 */
import fs from 'node:fs';

export const THEMES = {
  light: { bg: '#ffffff', ink: '#11161a', ink2: '#4e5860', ink3: '#7d878f', wal: '#2a78d6', tok: '#eb6834', trade: '#0f8f62', mesh: '#11161a', fill: 0.22 },
  dark: { bg: '#0d1117', ink: '#e6edf3', ink2: '#9aa5ad', ink3: '#6e7781', wal: '#3987e5', tok: '#d95926', trade: '#199e70', mesh: '#e6edf3', fill: 0.4 },
  // the deck's own palette and fonts, for images rendered next to the deck (not written to docs/)
  deck: { bg: '#0b121d', ink: '#f2f8ff', ink2: '#c9d8ea', ink3: '#64809f', wal: '#3987e5', tok: '#ff9f45', trade: '#34f5a4', mesh: '#c9d8ea', fill: 0.34, sans: "'Chakra Petch', sans-serif", mono: "'JetBrains Mono', monospace", noFile: true },
};

const N = {
  wallets: 1917, subscribed: 51,
  tokens: 24115, checked: 416, rejected: 369, clean: 47,
  opportunities: 143, positions: 26,
  roundTrips: 7882, edges: 10213, shadow: 33, paths: 759,
};
const fmt = (n) => n.toLocaleString('en-US');
const H = (n) => 17 * Math.log10(n); // ribbon height

// geometry
const W = 1000, HGT = 520;
const yW = 165, yT = 345, yM = 255;
const x0 = 40, xG = 175, xF = 300, x1 = 440, x2 = 650, x3 = 850, xEnd = 925;

function ribbon(xa, ya, ha, xb, yb, hb) {
  const mid = (xa + xb) / 2;
  return `M${xa},${ya - ha / 2} C${mid},${ya - ha / 2} ${mid},${yb - hb / 2} ${xb},${yb - hb / 2} ` +
    `L${xb},${yb + hb / 2} C${mid},${yb + hb / 2} ${mid},${ya + ha / 2} ${xa},${ya + ha / 2} Z`;
}
const lerp = (a, b, t) => a + (b - a) * t;
const hAt = (x, xa, ha, xb, hb) => lerp(ha, hb, (x - xa) / (xb - xa));

export function draw(t) {
  const hW0 = H(N.wallets), hW1 = H(N.subscribed);
  const hT0 = H(N.tokens), hT1 = H(N.clean);
  const hM = H(N.opportunities), hX = H(N.positions);
  const hWf = hAt(xF, x0, hW0, x1, hW1), hTf = hAt(xF, x0, hT0, x1, hT1);

  const SANS = t.sans ?? `-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`;
  const MONO = t.mono ?? `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  const text = (x, y, s, { size = 12, fill = t.ink2, anchor = 'middle', weight = 400, mono = false, spacing } = {}) =>
    `<text x="${x}" y="${y}" font-family="${mono ? MONO : SANS}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${spacing ? ` letter-spacing="${spacing}"` : ''}>${s}</text>`;

  // a sieve: a column of short dashes across the band
  const mesh = (x, yc, h) => {
    let s = '';
    for (let y = yc - h / 2 - 6; y <= yc + h / 2 + 6; y += 6) s += `<line x1="${x - 5}" y1="${y}" x2="${x + 5}" y2="${y}" stroke="${t.mesh}" stroke-width="1.4" stroke-linecap="round"/>`;
    return s + `<line x1="${x}" y1="${yc - h / 2 - 8}" x2="${x}" y2="${yc + h / 2 + 8}" stroke="${t.mesh}" stroke-width="1.4"/>`;
  };
  const arrow = (id, color) =>
    `<marker id="${id}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" fill="${color}"/></marker>`;

  const topY = 72, botY = 470, r = 14;
  const loopTop = `M${x3 + 40},${yM - hX / 2 - 4} V${topY + r} Q${x3 + 40},${topY} ${x3 + 40 - r},${topY} H${xF + r} Q${xF},${topY} ${xF},${topY + r} V${yW - hWf / 2 - 12}`;
  const loopBot = `M${x3 + 40},${yM + hX / 2 + 4} V${botY - r} Q${x3 + 40},${botY} ${x3 + 40 - r},${botY} H${xF + r} Q${xF},${botY} ${xF},${botY - r} V${yT + hTf / 2 + 12}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${HGT}" role="img" aria-label="The million loop: 1,917 wallets and 24,115 tokens feed each other, pass through their filters down to 51 subscribed wallets and 47 clean tokens, merge into 143 opportunities and 26 positions, and every trade's outcome loops back to re-score wallets and re-tune the rules.">
<defs>${arrow('a-ink', t.ink2)}${arrow('a-loop', t.ink3)}${arrow('a-trade', t.trade)}</defs>
<rect width="${W}" height="${HGT}" rx="14" fill="${t.bg}"/>

${text(xG - 55, 34, 'GATHER', { size: 11, fill: t.ink3, weight: 600, spacing: '1.5' })}
${text(xF, 34, 'FILTER', { size: 11, fill: t.ink3, weight: 600, spacing: '1.5' })}
${text(x2, 34, 'SIGNAL', { size: 11, fill: t.ink3, weight: 600, spacing: '1.5' })}
${text(x3, 34, 'TRADE', { size: 11, fill: t.ink3, weight: 600, spacing: '1.5' })}

<!-- ribbons: height ∝ log10(count) -->
<path d="${ribbon(x0, yW, hW0, x1, yW, hW1)}" fill="${t.wal}" fill-opacity="${t.fill}"/>
<path d="${ribbon(x0, yT, hT0, x1, yT, hT1)}" fill="${t.tok}" fill-opacity="${t.fill}"/>
<path d="${ribbon(x1, yW, hW1, x2, yM - hM / 4, hM / 2)}" fill="${t.wal}" fill-opacity="${t.fill}"/>
<path d="${ribbon(x1, yT, hT1, x2, yM + hM / 4, hM / 2)}" fill="${t.tok}" fill-opacity="${t.fill}"/>
<path d="${ribbon(x2, yM, hM, x3 + 40, yM, hX)}" fill="${t.trade}" fill-opacity="${t.fill}"/>
<line x1="${x3 + 40}" y1="${yM}" x2="${xEnd + 40}" y2="${yM}" stroke="${t.trade}" stroke-width="2.5" marker-end="url(#a-trade)"/>
${text(xEnd + 44, yM - 10, 'SOL', { size: 11, fill: t.trade, weight: 700, anchor: 'end', mono: true })}

<!-- sources -->
${text(x0, yW - hW0 / 2 - 10, 'live swaps · Helius webhook', { size: 11, fill: t.ink3, anchor: 'start' })}
${text(x0, yT + hT0 / 2 + 20, 'crawler · DexScreener · Jupiter quotes', { size: 11, fill: t.ink3, anchor: 'start' })}

<!-- the counts that go in -->
${text(xG - 55, yW + 1, fmt(N.wallets), { size: 19, fill: t.ink, weight: 700, mono: true })}
${text(xG - 55, yW + 16, 'wallets analyzed', { size: 11, fill: t.ink2 })}
${text(xG - 55, yT + 1, fmt(N.tokens), { size: 19, fill: t.ink, weight: 700, mono: true })}
${text(xG - 55, yT + 16, 'tokens seen', { size: 11, fill: t.ink2 })}

<!-- cross-feed: the two lanes find each other -->
<line x1="${xG + 20}" y1="${yW + hAt(xG + 20, x0, hW0, x1, hW1) / 2 + 6}" x2="${xG + 20}" y2="${yT - hAt(xG + 20, x0, hT0, x1, hT1) / 2 - 6}" stroke="${t.ink2}" stroke-width="1.5" marker-end="url(#a-ink)"/>
<line x1="${xG + 44}" y1="${yT - hAt(xG + 44, x0, hT0, x1, hT1) / 2 - 6}" x2="${xG + 44}" y2="${yW + hAt(xG + 44, x0, hW0, x1, hW1) / 2 + 6}" stroke="${t.ink2}" stroke-width="1.5" marker-end="url(#a-ink)"/>
${text(xG + 12, yM - 10, 'their new buys', { size: 11, fill: t.ink2, anchor: 'end' })}
${text(xG + 12, yM + 4, 'become tokens', { size: 11, fill: t.ink3, anchor: 'end' })}
${text(xG + 52, yM - 10, 'each token’s buyers', { size: 11, fill: t.ink2, anchor: 'start' })}
${text(xG + 52, yM + 4, 'become wallets', { size: 11, fill: t.ink3, anchor: 'start' })}

<!-- the filters -->
${mesh(xF, yW, hWf)}
${mesh(xF, yT, hTf)}
${text(xF - 34, yW + hWf / 2 + 22, 'bot &amp; infra flags', { size: 11, fill: t.ink2 , anchor: 'start' })}
${text(xF - 34, yW + hWf / 2 + 36, 'hold style · copyability', { size: 11, fill: t.ink2 , anchor: 'start' })}
${text(xF - 34, yT - hTf / 2 - 30, 'gauntlet: authorities · liquidity', { size: 11, fill: t.ink2 , anchor: 'start' })}
${text(xF - 34, yT - hTf / 2 - 16, `holders · sell-sim · ${fmt(N.rejected)} of ${fmt(N.checked)} rejected`, { size: 11, fill: t.ink2 , anchor: 'start' })}

<!-- what survives -->
${text(x1 - 6, yW + 5, `${fmt(N.subscribed)} subscribed`, { size: 13, fill: t.ink, weight: 700, anchor: 'end' })}
${text(x1 - 6, yT + 5, `${fmt(N.clean)} clean`, { size: 13, fill: t.ink, weight: 700, anchor: 'end' })}

<!-- signal -->
${text(x2, yM + 5, `${fmt(N.opportunities)} opportunities`, { size: 13, fill: t.ink, weight: 700 })}
${text(x2 + 34, yM - hM / 2 - 32, 'a subscribed wallet', { size: 11, fill: t.ink2 })}
${text(x2 + 34, yM - hM / 2 - 18, 'buys a clean token', { size: 11, fill: t.ink2 })}
${text(x2 + 34, yM + hM / 2 + 22, 'copy · consensus · ladder', { size: 11, fill: t.ink2 })}
${text(x2 + 34, yM + hM / 2 + 37, 'one vote per owner', { size: 11, fill: t.ink2 })}
${text(x2 + 34, yM + hM / 2 + 52, `${fmt(N.edges)} co-entry edges`, { size: 11, fill: t.ink3 })}

<!-- trade -->
${text(x3 - 8, yM + 5, `${fmt(N.positions)} positions`, { size: 13, fill: t.ink, weight: 700 })}
${text(x3 - 38, yM - hX / 2 - 18, 'trail 10% · stop 50%', { size: 11, fill: t.ink2 })}
${text(x3 - 38, yM + hX / 2 + 22, 'paper, or live', { size: 11, fill: t.ink2 })}
${text(x3 - 38, yM + hX / 2 + 37, 'via Jupiter', { size: 11, fill: t.ink2 })}

<!-- the loop back: outcomes change what gets through next time -->
<path d="${loopTop}" fill="none" stroke="${t.ink3}" stroke-width="1.5" stroke-dasharray="5 4" marker-end="url(#a-loop)"/>
<path d="${loopBot}" fill="none" stroke="${t.ink3}" stroke-width="1.5" stroke-dasharray="5 4" marker-end="url(#a-loop)"/>
${text((xF + x3 + 40) / 2, topY - 10, `every round trip re-scores its wallet · dead styles churn out · ${fmt(N.roundTrips)} observed`, { size: 11, fill: t.ink2 })}
${text((xF + x3 + 40) / 2, botY + 22, `skipped trades and backtests re-tune the gauntlet and exits · ${fmt(N.shadow)} shadow · ${fmt(N.paths)} paths`, { size: 11, fill: t.ink2 })}
</svg>
`;
}

// write the README variants only when run directly, so draw() can be imported
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) for (const [name, theme] of Object.entries(THEMES)) {
  if (theme.noFile) continue;
  const out = new URL(`../docs/loop-${name}.svg`, import.meta.url);
  fs.writeFileSync(out, draw(theme));
  console.log(`wrote docs/loop-${name}.svg`);
}
