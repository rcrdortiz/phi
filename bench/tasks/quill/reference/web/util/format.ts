export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, Math.max(0, limit - 1)).trimEnd() + "\u2026";
}

/** Minutes to read at 200 words per minute, rounded up, never less than 1.
 *  Mirrors Article::readingTime on the PHP side; the two must agree. */
export function readingTime(words: number): number {
  return Math.max(1, Math.ceil(words / 200));
}

export function pluralise(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function titleCase(text: string): string {
  return text.replace(/\b\w/g, (c) => c.toUpperCase());
}
