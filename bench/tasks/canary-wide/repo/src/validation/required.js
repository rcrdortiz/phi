/** Which required fields are missing. */
export function missingFields(obj, fields) {
  return fields.filter((f) => obj[f] === undefined || obj[f] === null || obj[f] === "");
}
