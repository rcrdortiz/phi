import { roundCents } from "./round.js";
/** Convert between currencies at a given rate. */
export function convert(cents, rate) {
  return roundCents(cents * rate);
}
