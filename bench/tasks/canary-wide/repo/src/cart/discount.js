/** Apply a percentage discount. discount(10000, 10) === 9000 */
export function discount(cents, percent) {
  return cents - Math.round((cents * percent) / 100);
}
