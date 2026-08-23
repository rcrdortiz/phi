/** Working days until delivery. */
export function estimateDays(zone) {
  if (zone === "domestic") return 2;
  if (zone === "eu") return 5;
  return 10;
}
