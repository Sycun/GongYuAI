import { useCallback, useEffect, useMemo, useState } from "react";

export type ClientPaginationConfig = {
  currentPage: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
};

/**
 * Pure pagination helper: clamps `page` into `[1, totalPages]` and returns the
 * current page slice without mutating the input array.
 */
export function sliceClientPage<T>(
  rows: readonly T[],
  page: number,
  pageSize: number,
): { currentPage: number; total: number; totalPages: number; dataSource: T[] } {
  const safePageSize = Math.max(1, Math.floor(pageSize));
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / safePageSize));
  const requested = Number.isFinite(page) ? Math.floor(page) : 1;
  const currentPage = Math.min(Math.max(1, requested), totalPages);
  const start = (currentPage - 1) * safePageSize;
  const dataSource = total > safePageSize ? rows.slice(start, start + safePageSize) : [...rows];
  return { currentPage, total, totalPages, dataSource };
}

/**
 * Controlled client-side pagination for Semi UI `Table`.
 *
 * Semi UI's uncontrolled `Table` resets `currentPage` to 1 whenever `dataSource`
 * receives a new array reference (such as on polling ticks or parent re-renders).
 * Passing `currentPage`, `pageSize`, `total`, and `onPageChange` switches `Table`
 * to controlled pagination so live updates preserve the current page, while still
 * clamping if the dataset shrinks or resetting when `resetKey` changes.
 */
export function useClientPagination<T>(
  rows: readonly T[],
  pageSize: number,
  resetKey?: string | number | boolean,
): { dataSource: T[]; pagination: ClientPaginationConfig | false } {
  const [state, setState] = useState<{ page: number; resetKey: string | number | boolean | undefined }>({
    page: 1,
    resetKey,
  });

  const activePage = state.resetKey === resetKey ? state.page : 1;
  const { currentPage, total, dataSource } = useMemo(
    () => sliceClientPage(rows, activePage, pageSize),
    [rows, activePage, pageSize],
  );

  useEffect(() => {
    if (state.resetKey !== resetKey || state.page !== currentPage) {
      setState({ page: currentPage, resetKey });
    }
  }, [state.resetKey, state.page, resetKey, currentPage]);

  const onPageChange = useCallback(
    (nextPage: number) => {
      setState({ page: nextPage, resetKey });
    },
    [resetKey],
  );

  const pagination = useMemo<ClientPaginationConfig | false>(
    () => (total > pageSize ? { currentPage, pageSize, total, onPageChange } : false),
    [total, pageSize, currentPage, onPageChange],
  );

  return { dataSource, pagination };
}
