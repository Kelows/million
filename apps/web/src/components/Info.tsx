/** Small (i) with a native tooltip — documents how a number is computed. */
export function Info({ text }: { text: string }) {
  return (
    <span title={text} className="text-dim hover:text-neon cursor-help select-none ml-1 text-[0.7rem]" aria-label={text}>
      ⓘ
    </span>
  );
}
