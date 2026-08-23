/** Round to the nearest minor unit, half away from zero. */
export function roundCents(value) {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}
