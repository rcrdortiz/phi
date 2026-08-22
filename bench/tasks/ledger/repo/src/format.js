"use strict";
const money = require("./money");
const dates = require("./dates");

// Rendering helpers. Nothing here does arithmetic; it only turns values that
// are already correct into strings a person can read.

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function padLeft(s, n) {
  s = String(s);
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

function table(rows, columns) {
  if (!rows.length) return "";
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] === undefined ? "" : r[c]).length)));
  const line = (cells) => cells.map((c, i) => pad(c, widths[i])).join("  ").replace(/\s+$/, "");
  const out = [line(columns), line(widths.map((w) => "-".repeat(w)))];
  for (const r of rows) out.push(line(columns.map((c) => (r[c] === undefined ? "" : String(r[c])))));
  return out.join("\n");
}

function moneyColumn(rows, key) {
  return rows.map((r) => Object.assign({}, r, { [key]: money.format(r[key]) }));
}

function periodLabel(from, to, unit) {
  return dates.periodKey(from, unit || "day") + " to " + dates.periodKey(to, unit || "day");
}

function bar(value, max, width) {
  if (max <= 0) return "";
  const n = Math.round((value / max) * width);
  return "#".repeat(Math.max(0, Math.min(width, n)));
}

function histogram(rows, key, width) {
  const max = Math.max(...rows.map((r) => r[key]));
  return rows.map((r) => padLeft(r[key], 8) + " " + bar(r[key], max, width || 30)).join("\n");
}

module.exports = { pad, padLeft, table, moneyColumn, periodLabel, bar, histogram };
