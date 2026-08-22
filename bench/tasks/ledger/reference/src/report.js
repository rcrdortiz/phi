"use strict";
const money = require("./money");
const ledger = require("./ledger");

// Group entries by a key function. Every entry must land in exactly one group.
function groupBy(entries, keyFn) {
  const groups = {};
  for (const e of entries) {
    const k = keyFn(e);
    if (k === undefined || k === null) continue;
    if (!groups[k]) groups[k] = [];
    groups[k].push(e);
  }
  return groups;
}

function byParty(entries) { return groupBy(entries, (e) => e.party); }
function byKind(entries) { return groupBy(entries, (e) => e.kind); }

// A summary row per party, ordered by net descending, then by party ascending
// so the order is stable when two parties net the same.
function summary(entries) {
  const groups = byParty(entries);
  const rows = Object.keys(groups).map((party) => {
    const es = groups[party];
    return {
      party: party,
      count: es.length,
      gross: ledger.gross(es),
      fees: ledger.fees(es),
      net: es.reduce((sum, e) => money.add(sum, e.kind === "refund" ? -Math.abs(e.cents) : Math.abs(e.cents)), 0),
    };
  });
  rows.sort((a, b) => (b.net - a.net) || (a.party < b.party ? -1 : 1));
  return rows;
}

function totals(entries) {
  return {
    entries: entries.length,
    gross: ledger.gross(entries),
    fees: ledger.fees(entries),
    balance: ledger.balance(entries),
  };
}

function render(entries) {
  const rows = summary(entries);
  const lines = ["party,count,gross,fees,net"];
  for (const r of rows) {
    lines.push([r.party, r.count, money.format(r.gross), money.format(r.fees), money.format(r.net)].join(","));
  }
  return lines.join("\n");
}

module.exports = { groupBy, byParty, byKind, summary, totals, render };
