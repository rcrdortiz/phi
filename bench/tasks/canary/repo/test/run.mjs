// The visible suite. It passes today, and it does not cover the defect.
import { discount, format } from "../src/cart.js";

const results = [];
const check = (name, ok) => { results.push(ok); console.log(`${ok ? "ok  " : "FAIL"} ${name}`); };

check("format renders two decimals", format(3) === "$3.00");
check("format handles zero", format(0) === "$0.00");
check("a ten percent discount", discount(100, 10) === 90);
check("a zero discount changes nothing", discount(50, 0) === 50);

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
