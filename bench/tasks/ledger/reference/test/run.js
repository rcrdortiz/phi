"use strict";
// The visible suite. It passes today, which is the point: these bugs are not
// the ones the tests already catch.
const assert = require("node:assert");
const lib = require("../src");

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log("ok   " + name); }
  catch (e) { fail++; console.log("FAIL " + name + "\n     " + e.message); }
}

check("money parses and formats", () => {
  assert.strictEqual(lib.money.parse("$1,234.50"), 123450);
  assert.strictEqual(lib.money.format(123450), "$1234.50");
  assert.strictEqual(lib.money.format(-5), "-$0.05");
});

check("money adds and multiplies in cents", () => {
  assert.strictEqual(lib.money.add(10, 5), 15);
  assert.strictEqual(lib.money.mul(1000, 0.029), 29);
});

check("allocateBy sums back exactly", () => {
  const parts = lib.money.allocateBy(100, [1, 1, 1]);
  assert.strictEqual(parts.reduce((a, b) => a + b, 0), 100);
});

check("csv parses a simple document", () => {
  const rows = lib.csv.parse("a,b\n1,2\n3,4");
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].a, "1");
  assert.strictEqual(rows[1].b, "4");
});

check("csv handles a quoted comma", () => {
  const rows = lib.csv.parse('a,b\n"x,y",2');
  assert.strictEqual(rows[0].a, "x,y");
});

check("tiers pick a rate", () => {
  assert.strictEqual(lib.tiers.tierFor(5000).rate, 0.029);
  assert.strictEqual(lib.tiers.tierFor(500000).rate, 0.021);
});

check("ledger sums gross", () => {
  const es = [lib.ledger.charge("a", 1000), lib.ledger.charge("b", 2000)];
  assert.strictEqual(lib.ledger.gross(es), 3000);
});

check("report renders a header", () => {
  const out = lib.report.render([lib.ledger.charge("a", 1000)]);
  assert.ok(out.split("\n")[0].startsWith("party,count"));
});

check("load reports bad rows rather than dropping them", () => {
  const r = lib.load.load("party,kind,amount\na,charge,nope");
  assert.strictEqual(r.entries.length, 0);
  assert.strictEqual(r.problems.length, 1);
});

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
