/** Add stock back, never below zero. */
export function restock(stock, quantity) {
  return Math.max(0, stock + quantity);
}
