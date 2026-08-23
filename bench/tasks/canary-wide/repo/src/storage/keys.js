/** A stable key for a row. */
export function keyFor(row) {
  return `${row.type ?? "row"}:${row.id}`;
}
