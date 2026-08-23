const RATES = { GB: 20, DE: 19, US: 0 };
/** VAT percentage for a country code. */
export function taxRate(country) {
  return RATES[country] ?? 0;
}
