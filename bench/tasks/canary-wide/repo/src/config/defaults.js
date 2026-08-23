export const DEFAULTS = { perPage: 20, currency: "USD", country: "GB" };
export function withDefaults(options = {}) {
  return { ...DEFAULTS, ...options };
}
