/** Epoch seconds to a short date. Timestamps are seconds everywhere, matching
 *  the PHP side, so anything arriving in milliseconds is a bug upstream. */
export function formatDate(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  return d.toISOString().slice(0, 10);
}

export function relative(epochSeconds: number, now: number): string {
  const delta = now - epochSeconds;
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

export function isSameDay(a: number, b: number): boolean {
  return formatDate(a) === formatDate(b);
}
