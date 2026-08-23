/** Sum a numeric field across rows. */
export function sumBy(rows, field) {
  return rows.reduce((acc, r) => acc + (r[field] ?? 0), 0);
}
