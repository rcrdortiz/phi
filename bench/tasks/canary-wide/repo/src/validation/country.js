const KNOWN = ["GB", "DE", "US", "FR", "ES"];
export function isCountry(code) {
  return KNOWN.includes(String(code).toUpperCase());
}
