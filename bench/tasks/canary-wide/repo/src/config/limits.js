export const LIMITS = { maxLines: 100, maxQuantity: 999, maxWeightGrams: 30000 };
export function withinLimits(order) {
  return order.lines.length <= LIMITS.maxLines;
}
