import { zoneFor } from "./zones.js";
const PRICES = { domestic: 399, eu: 899, world: 1499 };
/** Shipping cost in minor units. */
export function shippingCost(country, weightGrams) {
  const base = PRICES[zoneFor(country)];
  return weightGrams > 2000 ? base * 2 : base;
}
