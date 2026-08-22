"use strict";
// Fee tiers, in cents. A tier applies when the amount is at least `from` and
// below `to`. The last tier has no upper bound.

const TIERS = [
  { from: 0, to: 10000, rate: 0.029, fixed: 30 },
  { from: 10000, to: 100000, rate: 0.025, fixed: 30 },
  { from: 100000, to: 1000000, rate: 0.021, fixed: 25 },
  { from: 1000000, to: Infinity, rate: 0.018, fixed: 0 },
];

// The tier an amount falls into. An amount exactly on a boundary belongs to
// the higher tier: 10000 is the start of the second tier, not the end of the
// first.
function tierFor(cents) {
  for (const t of TIERS) {
    if (cents >= t.from && cents < t.to) return t;
  }
  return TIERS[TIERS.length - 1];
}

function feeFor(cents) {
  const t = tierFor(cents);
  return Math.round(cents * t.rate) + t.fixed;
}

function describe(cents) {
  const t = tierFor(cents);
  const upper = t.to === Infinity ? "and up" : "to " + t.to;
  return "tier " + t.from + " " + upper + " at " + (t.rate * 100).toFixed(1) + "%";
}

module.exports = { TIERS, tierFor, feeFor, describe };
