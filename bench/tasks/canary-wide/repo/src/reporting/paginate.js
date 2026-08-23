/**
 * Pagination arithmetic. Pages are 1-based: page 1 is the first page.
 */
export function pageCount(totalRows, perPage) {
  if (perPage <= 0) return 0;
  return Math.ceil(totalRows / perPage);
}

/** The number of rows to skip to reach the start of a page. */
export function offset(page, perPage) {
  return page * perPage;
}
