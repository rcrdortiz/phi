/** Group rows by the value of a field. */
export function groupBy(rows, field) {
  const out = new Map();
  for (const r of rows) {
    const k = r[field];
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  }
  return out;
}
