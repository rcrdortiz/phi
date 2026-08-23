const RANK = { guest: 0, customer: 1, staff: 2, admin: 3 };
/** Whether a role meets a required level. */
export function atLeast(role, required) {
  return (RANK[role] ?? -1) >= (RANK[required] ?? 99);
}
