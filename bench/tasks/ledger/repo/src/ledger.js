"use strict";
const money = require("./money");
const tiers = require("./tiers");

// A ledger is a list of entries. Each entry is a charge or a refund against a
// party, in cents, with a timestamp and an optional memo.

function entry(party, kind, cents, at, memo) {
  return { party: party, kind: kind, cents: cents, at: at || 0, memo: memo || "" };
}

function charge(party, cents, at, memo) { return entry(party, "charge", cents, at, memo); }
function refund(party, cents, at, memo) { return entry(party, "refund", cents, at, memo); }

// Gross volume: everything charged, ignoring refunds.
function gross(entries) {
  return entries
    .filter((e) => e.kind === "charge")
    .reduce((sum, e) => money.add(sum, e.cents), 0);
}

// Net volume per party: charges minus refunds. A party that refunded more than
// it charged nets negative, which is legal and must not be clamped.
function netByParty(entries) {
  const out = {};
  for (const e of entries) {
    if (out[e.party] === undefined) out[e.party] = 0;
    out[e.party] = money.add(out[e.party], e.cents);
  }
  return out;
}

// Fees are charged on the gross amount of each charge, never on refunds, and
// never on a netted total.
function fees(entries) {
  return entries
    .filter((e) => e.kind === "charge")
    .reduce((sum, e) => money.add(sum, tiers.feeFor(e.cents)), 0);
}

function balance(entries) {
  const net = netByParty(entries);
  const total = Object.keys(net).reduce((sum, p) => money.add(sum, net[p]), 0);
  return money.sub(total, fees(entries));
}

function between(entries, from, to) {
  return entries.filter((e) => e.at >= from && e.at <= to);
}

function sortByTime(entries) {
  return entries.slice().sort((a, b) => a.at - b.at);
}

module.exports = { entry, charge, refund, gross, netByParty, fees, balance, between, sortByTime };
