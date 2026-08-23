/** Constrain a number to a range. */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
