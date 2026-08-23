/** The routes this service answers. */
export const ROUTES = ["/orders", "/orders/:id", "/reports/sales", "/users/me"];
export function isKnownRoute(path) {
  return ROUTES.some((r) => r === path || (r.includes(":") && path.split("/").length === r.split("/").length));
}
