interface PaginationProps {
  page: number;
  pageCount: number;
  from: number;
  to: number;
  total: number;
  onPage: (page: number) => void;
}

export function Pagination({ page, pageCount, from, to, total, onPage }: PaginationProps) {
  if (pageCount <= 1) return null;
  return (
    <div className="flex items-center justify-end gap-3 px-4 py-2 border-t border-line text-xs font-mono text-dim">
      <span>
        {from}–{to} of {total}
      </span>
      <button
        type="button"
        className="px-2 py-0.5 border border-line hover:border-neon hover:text-neon disabled:opacity-40 disabled:hover:border-line disabled:hover:text-dim"
        disabled={page === 0}
        onClick={() => onPage(page - 1)}
      >
        ‹
      </button>
      <span>
        {page + 1}/{pageCount}
      </span>
      <button
        type="button"
        className="px-2 py-0.5 border border-line hover:border-neon hover:text-neon disabled:opacity-40 disabled:hover:border-line disabled:hover:text-dim"
        disabled={page >= pageCount - 1}
        onClick={() => onPage(page + 1)}
      >
        ›
      </button>
    </div>
  );
}
