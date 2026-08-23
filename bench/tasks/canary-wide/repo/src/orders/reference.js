/** A human-facing order reference. */
export function reference(id, year) {
  return `ORD-${year}-${String(id).padStart(5, "0")}`;
}
