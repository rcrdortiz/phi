const ZONES = { GB: "domestic", DE: "eu", US: "world" };
/** Which shipping zone a country falls in. */
export function zoneFor(country) {
  return ZONES[country] ?? "world";
}
