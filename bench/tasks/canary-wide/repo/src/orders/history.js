/** Orders newest first. */
export function newestFirst(orders) {
  return [...orders].sort((a, b) => b.placedAt - a.placedAt);
}
