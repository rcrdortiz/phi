"use strict";
const fx = require("./fx");

// Entry validation. Returns a list of problems; an empty list means valid.

const KINDS = ["charge", "refund"];

function problemsFor(entry) {
  const out = [];
  if (!entry || typeof entry !== "object") return [{ field: "entry", reason: "not an object" }];
  if (typeof entry.party !== "string" || !entry.party.trim()) out.push({ field: "party", reason: "required" });
  if (KINDS.indexOf(entry.kind) === -1) out.push({ field: "kind", reason: "must be charge or refund" });
  if (!Number.isInteger(entry.cents)) out.push({ field: "cents", reason: "must be whole cents" });
  if (entry.currency !== undefined && !fx.known(entry.currency)) {
    out.push({ field: "currency", reason: "unknown currency" });
  }
  if (entry.at !== undefined && !Number.isFinite(entry.at)) out.push({ field: "at", reason: "not a timestamp" });
  return out;
}

function isValid(entry) { return problemsFor(entry).length === 0; }

// Partition a list into the entries that pass and the ones that do not. Every
// input must appear in exactly one of the two lists.
function partition(entries) {
  const ok = [];
  const bad = [];
  for (const e of entries) {
    if (isValid(e)) ok.push(e);
    else bad.push({ entry: e, problems: problemsFor(e) });
  }
  return { ok: ok, bad: bad };
}

module.exports = { KINDS, problemsFor, isValid, partition };
