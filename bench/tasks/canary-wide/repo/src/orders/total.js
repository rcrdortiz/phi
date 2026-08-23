import { subtotal } from "../cart/subtotal.js";
import { withTax } from "../tax/apply.js";
import { shippingCost } from "../shipping/cost.js";
/** The full order total in minor units. */
export function orderTotal(order) {
  const goods = subtotal(order.lines);
  return withTax(goods, order.country) + shippingCost(order.country, order.weightGrams ?? 0);
}
