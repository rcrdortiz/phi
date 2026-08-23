/** A display name from the parts we hold. */
export function displayName(user) {
  const parts = [user.firstName, user.lastName].filter(Boolean);
  return parts.length ? parts.join(" ") : user.email;
}
