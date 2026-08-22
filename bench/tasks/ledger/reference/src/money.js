"use strict";
// Money is integer cents everywhere. Floats are only allowed at the edges,
// in parse() and format(), and never in arithmetic.

function parse(text) {
  if (typeof text === "number") return Math.round(text * 100);
  const s = String(text).trim().replace(/[$,\s]/g, "");
  if (!s || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(parseFloat(s) * 100);
}

function format(cents) {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const s = (abs / 100).toFixed(2);
  return (neg ? "-" : "") + "$" + s;
}

function add(a, b) { return a + b; }
function sub(a, b) { return a - b; }
function mul(cents, factor) { return Math.round(cents * factor); }

// Split `cents` across `n` parts as evenly as possible. The parts must sum
// back to `cents` exactly: this is money, not an average.
function allocate(cents, n) {
  if (n <= 0) return [];
  const base = Math.floor(cents / n);
  const out = [];
  for (let i = 0; i < n; i++) out.push(base);
  let left = cents - base * n;
  for (let i = 0; left > 0; i++, left--) out[i % n] += 1;
  return out;
}

// Split by weights, largest-remainder so the parts still sum exactly.
function allocateBy(cents, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (cents * w) / total);
  const out = raw.map((r) => Math.floor(r));
  let left = cents - out.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac);
  let k = 0;
  while (left > 0) { out[order[k % order.length].i] += 1; left--; k++; }
  return out;
}

module.exports = { parse, format, add, sub, mul, allocate, allocateBy };
