import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const TIP_WIDTH = 288;

/**
 * Small (i) with an instant tooltip — documents how a number is computed.
 * Rendered through a body portal with fixed positioning: an absolute tip
 * gets clipped the moment it lives inside an overflow-x-auto table wrap.
 */
export function Info({ text }: { text: string }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  const show = () => {
    const r = anchor.current?.getBoundingClientRect();
    if (!r) return;
    const x = Math.max(8, Math.min(r.left, window.innerWidth - TIP_WIDTH - 8)); // clamp: right-edge columns must not push it off-screen
    setPos({ x, y: r.bottom + 6 });
  };

  return (
    <span ref={anchor} className="relative inline-block align-middle ml-1" onMouseEnter={show} onMouseLeave={() => setPos(null)}>
      <span className="text-dim hover:text-neon cursor-help select-none text-[0.7rem]" aria-label={text}>
        ⓘ
      </span>
      {pos &&
        createPortal(
          <span
            className="pointer-events-none fixed w-72 max-w-[70vw] bg-deck2 border border-neon/40 p-2.5 text-xs text-ink normal-case tracking-normal font-normal z-50 text-left whitespace-normal leading-relaxed"
            style={{ left: pos.x, top: pos.y }}
          >
            {text}
          </span>,
          document.body,
        )}
    </span>
  );
}
