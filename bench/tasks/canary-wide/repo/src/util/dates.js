/** Whole days between two timestamps. */
export function daysBetween(a, b) {
  return Math.floor(Math.abs(b - a) / 86400000);
}
