"use strict";
const money = require("./money");
const tiers = require("./tiers");
const ledger = require("./ledger");
const dates = require("./dates");

// Settlement batches. Entries within a period are grouped into payouts, one per
// party, with fees deducted and a minimum payout threshold applied.

const MIN_PAYOUT = 100;

function payoutsFor(entries, from, to) {
  const inPeriod = entries.filter((e) => dates.within(e.at, from, to));
  const byParty = {};
  for (const e of inPeriod) {
    if (byParty[e.party] === undefined) byParty[e.party] = [];
    byParty[e.party].push(e);
  }
  return Object.keys(byParty).map((party) => {
    const es = byParty[party];
    const gross = ledger.gross(es);
    const fee = ledger.fees(es);
    return { party: party, gross: gross, fee: fee, net: money.sub(gross, fee), count: es.length };
  });
}

// A payout below the threshold is carried into the next batch rather than paid,
// so nothing is ever dropped: paid plus carried must equal the total net. A
// payout of exactly the threshold is paid, not carried.
function applyThreshold(payouts) {
  const paid = [];
  const carried = [];
  for (const p of payouts) {
    if (p.net >= MIN_PAYOUT) paid.push(p);
    else carried.push(p);
  }
  return { paid: paid, carried: carried };
}

function batch(entries, from, to) {
  const split = applyThreshold(payoutsFor(entries, from, to));
  const total = split.paid.reduce((sum, p) => money.add(sum, p.net), 0);
  return { from: from, to: to, paid: split.paid, carried: split.carried, total: total };
}

function describe(b) {
  return b.paid.length + " paid, " + b.carried.length + " carried, " + money.format(b.total) + " total";
}

module.exports = { MIN_PAYOUT, payoutsFor, applyThreshold, batch, describe };
