import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';

export interface TradeToast {
  kind: 'open' | 'closed';
  symbol: string | null;
  mint: string;
  sizeSol: number;
  pnlSol?: number;
  pnlPct?: number;
  reason?: string;
  mode: string;
}

const REASON_LABEL: Record<string, string> = { tp: 'take profit', sl: 'stop loss', timeout: 'timeout', manual: 'manual', dead: 'pool died', mirror: 'mirrored exit' };
const TTL_MS = 8_000;

/** App-wide trade notifications: the SSE bridge dispatches, this renders the stack. */
export function TradeToasts() {
  const [toasts, setToasts] = useState<(TradeToast & { id: number })[]>([]);

  useEffect(() => {
    let nextId = 1;
    const onToast = (e: Event) => {
      const detail = (e as CustomEvent<TradeToast>).detail;
      const id = nextId++;
      setToasts((t) => [...t.slice(-3), { ...detail, id }]); // max 4 on screen
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), TTL_MS);
    };
    window.addEventListener('trade-toast', onToast);
    return () => window.removeEventListener('trade-toast', onToast);
  }, []);

  if (toasts.length === 0) return null;
  return (
    <div className="fixed top-14 right-4 z-50 flex flex-col gap-2 w-80 max-w-[90vw]">
      <style>{`@keyframes toast-in { from { transform: translateX(110%); opacity: 0 } to { transform: none; opacity: 1 } }
        @media (prefers-reduced-motion: reduce) { .toast-card { animation: none !important } }`}</style>
      {toasts.map((t) => {
        const win = (t.pnlSol ?? 0) >= 0;
        const edge = t.kind === 'open' ? 'border-l-neon' : win ? 'border-l-profit' : 'border-l-loss';
        return (
          <div key={t.id} className={`toast-card bg-deck2/95 backdrop-blur border border-line border-l-4 ${edge} p-3 font-mono text-xs shadow-lg`} style={{ animation: 'toast-in 0.25s ease-out' }}>
            <div className="flex items-baseline justify-between gap-3">
              <span className={`font-bold tracking-widest ${t.kind === 'open' ? 'text-neon' : win ? 'text-profit' : 'text-loss'}`}>
                {t.kind === 'open' ? '◈ POSITION OPEN' : win ? '▲ CLOSED · WIN' : '▼ CLOSED · LOSS'}
              </span>
              <span className="text-dim uppercase">{t.mode}</span>
            </div>
            <div className="mt-1.5 flex items-baseline justify-between gap-3">
              <Link to="/tokens/$mint" params={{ mint: t.mint }} className="text-bright font-bold hover:text-neon truncate">
                {t.symbol ?? `${t.mint.slice(0, 4)}…${t.mint.slice(-4)}`}
              </Link>
              <span className="text-dim">{t.sizeSol} ◎</span>
            </div>
            {t.kind === 'closed' && (
              <div className="mt-1 flex items-baseline justify-between gap-3 [font-variant-numeric:tabular-nums]">
                <span className={`text-base font-bold ${win ? 'text-profit' : 'text-loss'}`}>
                  {win ? '+' : ''}{t.pnlSol} ◎ <span className="text-xs">({win ? '+' : ''}{t.pnlPct}%)</span>
                </span>
                <span className="text-dim">{REASON_LABEL[t.reason ?? ''] ?? t.reason}</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
