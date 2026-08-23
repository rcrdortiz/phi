// The visible suite. It passes today, and it does not cover the defect.
import { format } from "../src/money/format.js";
import { subtotal } from "../src/cart/subtotal.js";
import { discount } from "../src/cart/discount.js";
import { withTax } from "../src/tax/apply.js";
import { shippingCost } from "../src/shipping/cost.js";
import { canFulfil } from "../src/inventory/stock.js";
import { pageCount } from "../src/reporting/paginate.js";
import { sumBy } from "../src/reporting/totals.js";
import { slugify } from "../src/util/slug.js";
import { chunk } from "../src/util/chunk.js";
import { displayName } from "../src/users/name.js";
import { atLeast } from "../src/users/roles.js";
import { canTransition } from "../src/orders/status.js";
import { createStore } from "../src/storage/memory.js";

const results = [];
const check = (name, ok) => { results.push(ok); console.log(`${ok ? "ok  " : "FAIL"} ${name}`); };

check("money formats to two decimals", format(1234) === "$12.34");
check("subtotal multiplies quantity", subtotal([{ price: 100, quantity: 2 }, { price: 50, quantity: 1 }]) === 250);
check("a ten percent discount", discount(10000, 10) === 9000);
check("uk vat is twenty percent", withTax(1000, "GB") === 1200);
check("heavy parcels cost double", shippingCost("GB", 3000) === 798);
check("stock covers the quantity", canFulfil(5, 3) === true);
check("stock does not cover more", canFulfil(2, 3) === false);
check("page count rounds up", pageCount(21, 20) === 2);
check("page count of nothing", pageCount(0, 20) === 0);
check("sum by field", sumBy([{ n: 1 }, { n: 2 }], "n") === 3);
check("slugify", slugify("Hello There!") === "hello-there");
check("chunk splits evenly", chunk([1, 2, 3, 4], 2).length === 2);
check("display name prefers real names", displayName({ firstName: "Ada", lastName: "L", email: "a@b.c" }) === "Ada L");
check("admin outranks staff", atLeast("admin", "staff") === true);
check("cancelled orders do not move on", canTransition("cancelled", "shipped") === false);
check("a store counts what it holds", (() => { const s = createStore(); s.insert({ id: 1 }); return s.count() === 1; })());

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
