"use strict";
// A small CSV reader. Handles quoted fields, embedded commas, embedded
// newlines and doubled quotes.

function parseLine(line) {
  const out = [];
  let field = "";
  let quoted = false;
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i += 1; }
        else { quoted = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      out.push(field);
      field = "";
    } else {
      field += c;
    }
    i += 1;
  }
  out.push(field);
  return out;
}

// Split a document into logical rows. A newline inside a quoted field does not
// end the row.
function splitRows(text) {
  const rows = [];
  let row = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    if (c === "\n" && !quoted) { rows.push(row); row = ""; continue; }
    row += c;
  }
  if (row.length) rows.push(row);
  return rows;
}

function parse(text, options) {
  const opts = options || {};
  const rows = splitRows(text).filter((r) => r.trim().length > 0);
  if (!rows.length) return [];
  const header = parseLine(rows[0]);
  const body = opts.header === false ? rows : rows.slice(1);
  return body.map((r) => {
    const cells = parseLine(r);
    const obj = {};
    header.forEach((h, i) => { obj[h] = cells[i] === undefined ? "" : cells[i]; });
    return obj;
  });
}

module.exports = { parse, parseLine, splitRows };
