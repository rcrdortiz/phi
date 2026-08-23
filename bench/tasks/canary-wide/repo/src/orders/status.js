export const STATUSES = ["pending", "paid", "shipped", "delivered", "cancelled"];
/** Whether a transition is allowed. */
export function canTransition(from, to) {
  if (from === "cancelled") return false;
  return STATUSES.indexOf(to) > STATUSES.indexOf(from);
}
