"use strict";
const money = require("./money");
const ledger = require("./ledger");
const validate = require("./validate");

// Audit trail. Every mutation appends a record; the trail is append-only and
// must never be reordered, because the order is the history.

function trail() {
  const records = [];
  return {
    append: function (action, detail) {
      records.push({ seq: records.length + 1, action: action, detail: detail || {} });
      return records[records.length - 1];
    },
    all: function () { return records.slice(); },
    since: function (seq) { return records.filter((r) => r.seq > seq); },
    count: function () { return records.length; },
  };
}

// Replay a trail into a set of entries. Unknown actions are ignored rather than
// throwing, because an old trail may contain actions this version has dropped.
function replay(records) {
  const entries = [];
  for (const r of records) {
    if (r.action === "charge") entries.push(ledger.charge(r.detail.party, r.detail.cents, r.detail.at));
    else if (r.action === "refund") entries.push(ledger.refund(r.detail.party, r.detail.cents, r.detail.at));
  }
  return entries;
}

function verify(records) {
  const problems = [];
  let expected = 1;
  for (const r of records) {
    if (r.seq !== expected) problems.push({ seq: r.seq, reason: "out of sequence" });
    expected += 1;
  }
  const entries = replay(records);
  const bad = validate.partition(entries).bad;
  for (const b of bad) problems.push({ seq: 0, reason: "invalid entry", detail: b.problems });
  return problems;
}

function summary(records) {
  const entries = replay(records);
  return { records: records.length, entries: entries.length, gross: ledger.gross(entries) };
}

module.exports = { trail, replay, verify, summary };
