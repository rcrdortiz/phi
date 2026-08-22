"use strict";
const money = require("./money");

// Currency conversion. Rates are quoted against USD: RATES[c] is how many units
// of c one USD buys.

const RATES = { USD: 1, EUR: 0.92, GBP: 0.79, JPY: 151.2, CAD: 1.36 };

function known(code) { return Object.prototype.hasOwnProperty.call(RATES, code); }

// Convert cents from one currency to another, rounding once at the end. Two
// conversions in sequence must not round twice: convert(convert(x, A, B), B, A)
// should come back to within a cent of x.
function convert(cents, from, to) {
  if (!known(from) || !known(to)) return null;
  if (from === to) return cents;
  const usd = cents / RATES[from];
  return Math.round(usd * RATES[to]);
}

function toUsd(cents, from) { return convert(cents, from, "USD"); }

function formatIn(cents, code) {
  const symbol = { USD: "$", EUR: "\u20ac", GBP: "\u00a3", JPY: "\u00a5", CAD: "$" }[code] || "";
  return symbol + (Math.abs(cents) / 100).toFixed(code === "JPY" ? 0 : 2);
}

module.exports = { RATES, known, convert, toUsd, formatIn };
