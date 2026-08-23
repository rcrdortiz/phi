import { taxRate } from "./rate.js";
/** Add tax to an amount in minor units. */
export function withTax(cents, country) {
  return cents + Math.round((cents * taxRate(country)) / 100);
}
