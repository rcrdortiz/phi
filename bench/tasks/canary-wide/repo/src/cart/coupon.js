const COUPONS = { WELCOME: 10, SUMMER: 15 };
/** The percentage a coupon is worth, or zero. */
export function couponValue(code) {
  return COUPONS[String(code || "").toUpperCase()] ?? 0;
}
