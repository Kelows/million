import { useState } from 'react';

export function usePagination<T>(rows: T[], pageSize: number) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(page, pageCount - 1); // clamp when filters shrink the list
  return {
    rows: rows.slice(current * pageSize, (current + 1) * pageSize),
    page: current,
    pageCount,
    total: rows.length,
    from: rows.length === 0 ? 0 : current * pageSize + 1,
    to: Math.min(rows.length, (current + 1) * pageSize),
    setPage,
  };
}
