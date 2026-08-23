/** Render minor units as money. */
export function format(cents, currency = "USD") {
  const symbol = currency === "EUR" ? "\u20ac" : "$";
  return `${symbol}${(cents / 100).toFixed(2)}`;
}
