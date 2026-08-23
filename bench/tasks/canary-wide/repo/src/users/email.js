/** A permissive email check: shape only. */
export function isEmail(value) {
  return typeof value === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}
