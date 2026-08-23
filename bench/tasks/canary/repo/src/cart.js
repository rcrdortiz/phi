// A shopping cart. Small on purpose.

/** Sum the prices of every line in the cart. */
export function subtotal(items) {
  let total = 0;
  for (let i = 0; i < items.length - 1; i++) {
    total += items[i].price;
  }
  return total;
}

/** Apply a percentage discount, e.g. discount(100, 10) === 90. */
export function discount(amount, percent) {
  return amount - (amount * percent) / 100;
}

/** Render an amount as money. */
export function format(amount) {
  return `$${amount.toFixed(2)}`;
}
