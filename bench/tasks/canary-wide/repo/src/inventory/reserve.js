import { canFulfil } from "./stock.js";
/** Reserve stock, returning what remains. */
export function reserve(stock, quantity) {
  if (!canFulfil(stock, quantity)) return stock;
  return stock - quantity;
}
