import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { FlowRow } from '@million/shared';
import { useFlows } from '../api';
import { TokenLink } from '../components/TokenName';
import { Info } from '../components/Info';

const WINDOWS = [15, 30, 60, 120];

export function Flows() {
  const [minutes, setMinutes] = useState(30);
  const { data } = useFlows(minutes);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-6 flex-wrap">
        <div className="max-w-2xl">
          <h1 className="text-xl font-bold text-bright tracking-wide">Flows</h1>
          <p className="text-sm text-dim mt-1">
            Where the roster is laddering in and out right now. Repetition is the signal — one buy is an event, twenty
            is a decision. Netted against the opposite direction, so a wallet churning a token cancels itself out.
          </p>
        </div>
        <span className="flex items-center gap-2 text-xs font-mono">
          {WINDOWS.map((m) => (
            <button key={m} className={`btn py-1! px-2! text-[0.65rem]! ${minutes === m ? '' : 'opacity-50'}`} onClick={() => setMinutes(m)}>
              {m}m
            </button>
          ))}
        </span>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <FlowTable
          title="Accumulating"
          tone="profit"
          rows={data?.accumulating ?? []}
          hint="Different owners buying this token repeatedly in the window, net of selling. The ladder signal trades on this."
          empty="Nothing being accumulated in this window."
        />
        <FlowTable
          title="Distributing"
          tone="loss"
          rows={data?.distributing ?? []}
          hint="Owners selling out in pieces: the roster leaving a token, which one wallet's exit won't show you."
          empty="Nothing being distributed in this window."
        />
      </div>
    </div>
  );
}

function FlowTable({ title, tone, rows, hint, empty }: { title: string; tone: 'profit' | 'loss'; rows: FlowRow[]; hint: string; empty: string }) {
  return (
    <div className="panel">
      <div className="px-4 pt-4 pb-2 eyebrow">
        {title}
        <Info text={hint} />
      </div>
      {rows.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-dim">{empty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm font-mono">
            <thead>
              <tr className="text-left text-dim text-xs">
                <th className="px-4 py-2 font-normal">token</th>
                <th className="px-4 py-2 font-normal text-right">owners</th>
                <th className="px-4 py-2 font-normal text-right">clips</th>
                <th className="px-4 py-2 font-normal text-right">net ◎</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.mint} className="border-t border-line hover:bg-deck2">
                  <td className="px-4 py-2">
                    <TokenLink mint={r.mint} symbol={r.symbol} />
                  </td>
                  <td className="px-4 py-2 text-right text-warn">{r.owners}</td>
                  <td className="px-4 py-2 text-right text-dim" title={`${r.wallets} wallets`}>{r.clips}</td>
                  <td className={`px-4 py-2 text-right font-bold text-${tone}`}>{r.netSol}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
