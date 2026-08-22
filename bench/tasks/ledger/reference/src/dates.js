"use strict";
// Period handling. Timestamps are epoch milliseconds throughout.

const DAY = 86400000;

function startOfDay(ms) { return Math.floor(ms / DAY) * DAY; }
function endOfDay(ms) { return startOfDay(ms) + DAY - 1; }

// An inclusive range of whole days covering [from, to].
function daysBetween(from, to) {
  const out = [];
  for (let d = startOfDay(from); d <= startOfDay(to); d += DAY) out.push(d);
  return out;
}

// Bucket a timestamp into a period key. Weeks start on Monday.
function periodKey(ms, unit) {
  const d = new Date(ms);
  if (unit === "day") return d.toISOString().slice(0, 10);
  if (unit === "month") return d.toISOString().slice(0, 7);
  if (unit === "week") {
    const day = d.getUTCDay();
    const back = day === 0 ? 6 : day - 1;
    const monday = new Date(ms - back * DAY);
    return monday.toISOString().slice(0, 10);
  }
  return String(ms);
}

// Whether a timestamp is inside [from, to]. Both ends are inclusive: a payment
// made at the last millisecond of the period belongs to that period.
function within(ms, from, to) {
  return ms >= from && ms <= to;
}

function clamp(ms, from, to) {
  if (ms < from) return from;
  if (ms > to) return to;
  return ms;
}

module.exports = { DAY, startOfDay, endOfDay, daysBetween, periodKey, within, clamp };
