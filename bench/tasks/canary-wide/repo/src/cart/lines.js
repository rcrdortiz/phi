/** Merge duplicate product lines into one. */
export function mergeLines(lines) {
  const byId = new Map();
  for (const l of lines) {
    const found = byId.get(l.productId);
    if (found) found.quantity += l.quantity;
    else byId.set(l.productId, { ...l });
  }
  return [...byId.values()];
}
