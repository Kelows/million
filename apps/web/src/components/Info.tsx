/** Small (i) with an instant CSS tooltip — documents how a number is computed. */
export function Info({ text }: { text: string }) {
  return (
    <span className="relative inline-block group align-middle ml-1">
      <span className="text-dim group-hover:text-neon cursor-help select-none text-[0.7rem]" aria-label={text}>
        ⓘ
      </span>
      <span className="pointer-events-none absolute left-0 top-full mt-1.5 hidden group-hover:block w-72 max-w-[70vw] bg-deck2 border border-neon/40 p-2.5 text-xs text-ink normal-case tracking-normal font-normal z-50 text-left whitespace-normal leading-relaxed">
        {text}
      </span>
    </span>
  );
}
