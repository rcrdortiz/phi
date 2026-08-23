import { format } from "../money/format.js";
/** Shape an order for the wire. */
export function serializeOrder(order, total) {
  return { reference: order.reference, country: order.country, total: format(total) };
}
