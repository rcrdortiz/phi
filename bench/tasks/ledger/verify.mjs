// The hidden suite. Five planted bugs, none of which the visible suite catches.
//
// Each is a thing the source comments already promise and the code does not do,
// so nothing here is a guess about intent: the contract is written down beside
// the defect. The agent is told there are bugs, not where.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const dir = process.argv[2] ?? ".";
const results = [];
const check = (name, fn) => {
  try {
    const ok = fn();
    results.push({ name, pass: ok === true, detail: ok === true ? "" : String(ok) });
  } catch (e) {
    results.push({ name, pass: false, detail: (e && e.message) || String(e) });
  }
};

let lib;
try {
  const req = (await import("node:module")).createRequire(path.resolve(dir, "package.json"));
  for (const k of Object.keys(req.cache ?? {})) delete req.cache[k];
  lib = req("./src");
  results.push({ name: "the library loads", pass: true, detail: "" });
} catch (e) {
  results.push({ name: "the library loads", pass: false, detail: (e && e.message) || String(e) });
}

if (lib) {
  const eq = (got, want) => (got === want ? true : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

  // BUG 1: allocate() drops the remainder. "The parts must sum back exactly."
  check("allocate splits 100 across 3 without losing a cent", () =>
    eq(lib.money.allocate(100, 3).reduce((a, b) => a + b, 0), 100));
  check("allocate spreads the remainder rather than piling it", () => {
    const p = lib.money.allocate(100, 3).slice().sort((a, b) => a - b);
    return p[p.length - 1] - p[0] <= 1 || `spread ${JSON.stringify(p)}`;
  });
  check("allocate is exact for an even split too", () =>
    eq(lib.money.allocate(90, 3).join(","), "30,30,30"));

  // BUG 2: tierFor uses > where the comment says at least, so a boundary
  // amount falls through to the last tier.
  check("an amount on a tier boundary takes the higher tier", () =>
    eq(lib.tiers.tierFor(10000).rate, 0.025));
  check("zero is in the first tier, not the last", () =>
    eq(lib.tiers.tierFor(0).rate, 0.029));
  check("a boundary fee is charged at the right rate", () =>
    eq(lib.tiers.feeFor(100000), Math.round(100000 * 0.021) + 25));

  // BUG 3: splitRows toggles `quoted` on every quote, so a doubled quote
  // inside a field flips it back and a later newline splits the row.
  check("a doubled quote inside a field survives", () =>
    eq(lib.csv.parse('a\n"he said ""hi"""')[0].a, 'he said "hi"'));
  check("a newline inside a quoted field does not split the row", () =>
    eq(lib.csv.parse('a,b\n"x\ny",2').length, 1));
  check("a doubled quote and a newline together", () => {
    const rows = lib.csv.parse('a,b\n"say ""hi""\nagain",2');
    return rows.length === 1 && rows[0].b === "2" ? true : `rows ${rows.length}`;
  });

  // BUG 4: netByParty adds every entry's cents, but refunds arrive already
  // signed from load() and unsigned from ledger.refund(), so a refund built
  // directly is added rather than subtracted.
  check("a refund reduces a party's net", () => {
    const es = [lib.ledger.charge("a", 1000), lib.ledger.refund("a", 400)];
    return eq(lib.ledger.netByParty(es).a, 600);
  });
  check("a party can net negative", () => {
    const es = [lib.ledger.charge("a", 100), lib.ledger.refund("a", 500)];
    return eq(lib.ledger.netByParty(es).a, -400);
  });
  check("fees ignore refunds", () => {
    const es = [lib.ledger.charge("a", 10000), lib.ledger.refund("a", 10000)];
    return eq(lib.ledger.fees(es), lib.tiers.feeFor(10000));
  });

  // BUG 5: groupBy skips falsy keys, so a party literally named "0" vanishes,
  // and "every entry must land in exactly one group" is violated.
  check("no entry is dropped by grouping", () => {
    // A timestamp of 0 is a real key, and "every entry must land in exactly
    // one group" is what the source says.
    const es = [lib.ledger.charge("a", 100, 0), lib.ledger.charge("b", 100, 5)];
    const groups = lib.report.groupBy(es, (e) => e.at);
    const counted = Object.keys(groups).reduce((n, k) => n + groups[k].length, 0);
    return eq(counted, 2);
  });
  check("grouping by a zero key keeps its group", () =>
    eq(Object.keys(lib.report.groupBy([lib.ledger.charge("a", 1, 0)], (e) => e.at)).length, 1));

  // BUG 6: dates.within says both ends are inclusive and excludes the upper.
  check("a timestamp on the closing edge is inside the period", () =>
    eq(lib.dates.within(100, 0, 100), true));
  check("and one past it is not", () => eq(lib.dates.within(101, 0, 100), false));

  // BUG 7: fx.convert rounds on the way into USD as well as out, so a
  // round trip loses more than the one cent the comment allows.
  check("a currency round trip comes back within a cent", () => {
    const there = lib.fx.convert(123456, "USD", "JPY");
    const back = lib.fx.convert(there, "JPY", "USD");
    return Math.abs(back - 123456) <= 1 || `drifted ${back - 123456} cents`;
  });
  check("converting to the same currency changes nothing", () =>
    eq(lib.fx.convert(999, "EUR", "EUR"), 999));

  // BUG 8: a payout exactly on the threshold is carried, and the comment says
  // it is paid.
  check("a payout exactly on the threshold is paid", () => {
    const split = lib.settle.applyThreshold([{ party: "a", net: lib.settle.MIN_PAYOUT }]);
    return eq(split.paid.length, 1);
  });
  check("a payout below the threshold is carried, not dropped", () => {
    const split = lib.settle.applyThreshold([{ party: "a", net: 1 }]);
    return split.paid.length === 0 && split.carried.length === 1 ? true : "lost a payout";
  });

  // The visible suite must still pass: fixing a bug by breaking something the
  // tests already cover is not a fix.
  check("the visible suite still passes", () => {
    try {
      execFileSync(process.execPath, ["test/run.js"], { encoding: "utf8", cwd: dir });
      return true;
    } catch (e) {
      return `visible suite failing:\n${(e.stdout ?? "").split("\n").filter((l) => l.startsWith("FAIL")).join("; ")}`;
    }
  });

  // And the tests themselves must not have been edited into agreement.
  check("the visible suite was not modified", () => {
    const expected = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "test-run.sha"), "utf8").trim();
    const actual = execFileSync("shasum", ["-a", "256", path.join(dir, "test/run.js")], { encoding: "utf8" }).split(" ")[0];
    return actual === expected || "test/run.js was edited";
  });
}

const passed = results.filter((r) => r.pass).length;
process.stdout.write(JSON.stringify({ passed, total: results.length, results }, null, 2));
