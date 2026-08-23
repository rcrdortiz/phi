/** Whether a quantity can be fulfilled. */
export function canFulfil(stock, quantity) {
  return Number.isInteger(quantity) && quantity > 0 && stock >= quantity;
}
