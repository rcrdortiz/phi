import { resolveRange, outline, ReadCache, DEFAULT_SPAN, MAX_SPAN } from "/Users/rcrd/AI/pi-local/lib/read-lean.ts";
import * as fs from "node:fs";

const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + d : ""}`); };
const R = (req, total = 1036) => resolveRange(req, total);

// --- THE REGRESSION -------------------------------------------------------
// The exact call that killed the pang-clone session.
const killer = R({ offset: "630", limit: "120", end_line: 710 });
check("the killer call no longer starts at line 1", killer.start === 630,
  `lines ${killer.start}-${killer.end} (was 1-710)`);
check("the killer call returns ~120 lines, not 710", killer.end - killer.start + 1 === 120,
  `${killer.end - killer.start + 1} lines`);
check("and it explains what it did", killer.notes.length > 0, killer.notes.join("; "));

// --- the specific footgun -------------------------------------------------
const endOnly = R({ end_line: 710 });
check("end_line alone does NOT expand back to line 1", endOnly.start > 1,
  `lines ${endOnly.start}-${endOnly.end}`);
check("end_line alone is the window ENDING there", endOnly.end === 710 && endOnly.start === 710 - DEFAULT_SPAN + 1,
  `${endOnly.start}-${endOnly.end}`);

// --- aliases and string coercion -----------------------------------------
check("offset is read as start_line", R({ offset: 630, limit: 10 }).start === 630);
check("string numbers are coerced", R({ start_line: "100", limit: "10" }).start === 100);
check("limit is a count, not an end", R({ start_line: 100, limit: 10 }).end === 109,
  `end=${R({ start_line: 100, limit: 10 }).end}`);
check("start+end still works normally", (() => { const r = R({ start_line: 364, end_line: 475 }); return r.start === 364 && r.end === 475; })());

// --- bounds ---------------------------------------------------------------
check("caps a huge span", R({ start_line: 1, end_line: 99999 }).end - R({ start_line: 1, end_line: 99999 }).start + 1 === MAX_SPAN,
  `${MAX_SPAN} lines`);
check("cap tells you where to resume", /call again from/.test(R({ start_line: 1, end_line: 99999 }).notes.join(" ")));
check("clamps past end of file", R({ start_line: 1000, limit: 500 }).end === 1036);
check("reversed range fails small, not large", (() => { const r = R({ start_line: 500, end_line: 100 }); return r.end >= r.start && r.end - r.start + 1 <= DEFAULT_SPAN; })());
check("no args shows a bounded head, not the file", R({}).end === DEFAULT_SPAN, `1-${R({}).end} of 1036`);
check("a short file with no args is fully shown", (() => { const r = resolveRange({}, 40); return r.start === 1 && r.end === 40 && r.notes.length === 0; })());
check("negative/garbage input is ignored, not trusted", R({ start_line: "-5", limit: "abc" }).start === 1);

// --- outline --------------------------------------------------------------
const pang = fs.readFileSync("/Users/rcrd/AI/pang-clone/pang.js", "utf8").split("\n");
const o = outline(pang, "pang.js");
check("outline finds declarations in pang.js", o.length > 5, `${o.length} declarations`);
const outlineChars = o.map((x) => `${x.line}| ${x.text}`).join("\n").length;
const fullChars = pang.join("\n").length;
check("outline is far cheaper than the file", outlineChars < fullChars / 8,
  `${outlineChars} vs ${fullChars} chars (${(fullChars / outlineChars).toFixed(0)}x smaller)`);
check("outline line numbers are real", o.every((x) => x.line >= 1 && x.line <= pang.length && pang[x.line - 1].includes(x.text.trim().slice(0, 12))));
check("python is recognised", outline(["def foo():", "    pass", "class Bar:"], "x.py").length === 2);
check("markdown headings are recognised", outline(["# Title", "text", "## Sub"], "r.md").length === 2);
check("unknown file types return nothing rather than guessing", outline(["anything"], "x.bin").length === 0);

// --- re-read cache --------------------------------------------------------
const cache = new ReadCache();
const A = { size: 100, mtimeMs: 1000 };
cache.record("f.js", A, 1, 50);
check("a fully re-requested range is recognised as cached", cache.covered("f.js", A, 10, 40));
check("a range extending past what was shown is NOT cached", !cache.covered("f.js", A, 40, 80));
check("an unseen file is never cached", !cache.covered("other.js", A, 1, 5));

// The qualifier that makes this safe: an edit means line numbers moved.
const B = { size: 120, mtimeMs: 2000 };
check("a changed file invalidates the cache", !cache.covered("f.js", B, 10, 40),
  "size/mtime differ, so the old line numbers are stale");
cache.record("f.js", B, 1, 50);
check("and it re-caches under the new stamp", cache.covered("f.js", B, 10, 40));
cache.invalidate("f.js");
check("an explicit edit drops it immediately", !cache.covered("f.js", B, 10, 40));

// Non-contiguous coverage must not report a gap as covered.
const c2 = new ReadCache();
c2.record("g.js", A, 1, 10);
c2.record("g.js", A, 30, 40);
check("a gap between two reads is not reported as covered", !c2.covered("g.js", A, 5, 35));
check("but each recorded island still is", c2.covered("g.js", A, 31, 39));

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
