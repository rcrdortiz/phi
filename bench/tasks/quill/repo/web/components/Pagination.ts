/** Page numbers are 1-based, matching the URL and the PHP Paginator. */
export function pageNumbers(current: number, total: number, window = 2): number[] {
  const from = Math.max(1, current - window);
  const to = Math.min(total, current + window);
  const out: number[] = [];
  for (let p = from; p <= to; p++) out.push(p);
  return out;
}

export function renderPagination(current: number, total: number): string {
  if (total <= 1) return "";
  const links = pageNumbers(current, total)
    .map((p) => `<a class="page${p === current ? " is-current" : ""}" href="?page=${p}">${p}</a>`)
    .join("");
  return `<nav class="pagination">${links}</nav>`;
}
