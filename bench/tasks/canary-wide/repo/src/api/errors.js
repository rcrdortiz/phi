/** A consistent error envelope. */
export function apiError(code, message) {
  return { error: { code, message } };
}
