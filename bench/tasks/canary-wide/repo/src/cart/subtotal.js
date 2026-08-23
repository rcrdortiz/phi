/** Sum every line in the cart, in minor units. */
export function subtotal(lines) {
  let total = 0;
  for (const line of lines) total += line.price * line.quantity;
  return total;
}
