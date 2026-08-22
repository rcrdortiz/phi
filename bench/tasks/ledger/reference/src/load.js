"use strict";
const csv = require("./csv");
const money = require("./money");
const ledger = require("./ledger");

// Turn a CSV document into ledger entries.
//
// Expected columns: party, kind, amount, at, memo. `amount` is parsed as money
// and may carry a currency symbol or thousands separators. A row with an
// unparseable amount is skipped and reported, never silently dropped.

function rowToEntry(row, index, problems) {
  const party = (row.party || "").trim();
  const kind = (row.kind || "").trim().toLowerCase();
  const cents = money.parse(row.amount);

  if (!party) { problems.push({ row: index, reason: "missing party" }); return null; }
  if (kind !== "charge" && kind !== "refund") {
    problems.push({ row: index, reason: "unknown kind: " + kind });
    return null;
  }
  if (cents === null) { problems.push({ row: index, reason: "bad amount: " + row.amount }); return null; }

  const at = row.at ? Number(row.at) : 0;
  const signed = kind === "refund" ? -Math.abs(cents) : Math.abs(cents);
  return ledger.entry(party, kind, signed, Number.isFinite(at) ? at : 0, row.memo || "");
}

function load(text) {
  const rows = csv.parse(text);
  const problems = [];
  const entries = [];
  rows.forEach((row, i) => {
    const e = rowToEntry(row, i + 2, problems);
    if (e) entries.push(e);
  });
  return { entries: entries, problems: problems };
}

module.exports = { load, rowToEntry };
