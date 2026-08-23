/** A quantity must be a positive whole number. */
export function isQuantity(value) {
  return Number.isInteger(value) && value > 0;
}
