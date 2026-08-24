// The summary is the session's memory, so what matters is that this hooks the
// path that actually fires, and that every failure falls back to pi rather than
// substituting something worse.
//
// The first version of this extension hooked before_provider_request, which
// never fires for a compaction: sdk.js forwards transformHeaders into streamFn
// but not onPayload. It passed seventeen tests that all called its pure
// rewriting function directly, and failed on the first real run. So the first
// assertion here is about which event is registered, and the rest drive the
// handler rather than its helpers.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { STATE_DIR } from "../lib/state-dir.ts";

const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + d : ""}`); };

process.env.PHI_LEAN_SUMMARY = "1";
const { default: mod, LEAN_PROMPT, hasDurableState, transcript, usable, leanUsage } =
  await import("../extensions/lean-summary.ts");

// --- it must register on the hook that reaches compaction ------------------
const handlers = {};
mod({ on: (e, h) => (handlers[e] = h), registerTool: () => {}, registerCommand: () => {} });
check("registers session_before_compact", typeof handlers["session_before_compact"] === "function",
  "before_provider_request never fires for a compaction; that was the original bug");
check("does not rely on before_provider_request", handlers["before_provider_request"] === undefined);

// --- the guard -------------------------------------------------------------
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lean-"));
check("stands down with no durable state", !hasDurableState(DIR),
  "with no plan or notes, pi's full template is the correct thing to send");
fs.mkdirSync(path.join(DIR, STATE_DIR), { recursive: true });
fs.writeFileSync(path.join(DIR, STATE_DIR, "NOTES.md"), "");
check("an empty notes file is not durable state", !hasDurableState(DIR));
fs.writeFileSync(path.join(DIR, STATE_DIR, "NOTES.md"), "- something worth keeping\n");
check("fires once notes have content", hasDurableState(DIR));

// --- transcript flattening -------------------------------------------------
check("flattens string content", transcript([{ role: "user", content: "hello" }]) === "[user] hello");
check("flattens block content",
  transcript([{ role: "assistant", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }]) === "[assistant] a\nb");
check("drops thinking blocks",
  !/secret/.test(transcript([{ role: "assistant", content: [{ type: "thinking", text: "secret" }, { type: "text", text: "kept" }] }])),
  "thinking is the bulk of the tokens and is not part of a replayed context");
check("skips empty messages", transcript([{ role: "user", content: "  " }, { role: "user", content: "x" }]) === "[user] x");

// --- what counts as a usable summary --------------------------------------
// This guard is the last thing between a bad model response and the session's
// memory being replaced. On the first live run it let through 110 characters of
// "Let me verify the split depth math..." in place of 30,000 tokens, because the
// bar was 40 characters and only rejected an empty body.
const REAL = "The bomb split logic in pang.js:254 uses pminy/pmaxy and is already Y-aware, so C1 needed only the "
  + "up/down keys wired into newGame() and the clamped vertical motion in play(). Tests are at 105/105 after four "
  + "vertical-movement checks were added: home line, down, up, and above. index.html maps ArrowUp/KeyW to up and "
  + "ArrowDown/KeyS to down. renderBomb() still needs its sprite path verified against the atlas, which is the next "
  + "unstarted piece. Nothing is mid-edit and no command was left running.";
check("a real handover note is usable", usable(REAL));
check("an empty string is not", !usable(""));
check("a non-string is not", !usable({ summary: "no" }));
check("too short is not", !usable("Done."), "a stub would silently erase the session");
check("the continuation that broke it is rejected",
  !usable("Let me verify the split depth math so I can pin the potential count formula precisely before writing a plan."),
  "the model carried on talking instead of summarising, and it read as fluent prose");
check("a LONG continuation is rejected too", !usable("Let me " + "x".repeat(600)),
  "length alone cannot tell a summary from someone still working");
for (const opener of ["I'll start by", "Now I need to", "Alright, so", "Okay so next", "I will check"]) {
  check(`rejects an opener of "${opener}"`, !usable(opener + " " + "y".repeat(500)));
}
check("a note that merely mentions the word let is fine",
  usable("The tests let the bomb fall through when r=30. " + REAL),
  "the check anchors on the opening, not on the word appearing anywhere");

// --- the handler falls back rather than guessing ---------------------------
const h = handlers["session_before_compact"];
const ctxNoState = { cwd: fs.mkdtempSync(path.join(os.tmpdir(), "bare-")), model: { id: "m" } };
check("no durable state -> pi compacts",
  (await h({ preparation: { firstKeptEntryId: "a", messagesToSummarize: [{ role: "user", content: "hi" }] } }, ctxNoState)) === undefined);
const ctx = { cwd: DIR, model: { id: "m" } };
check("no firstKeptEntryId -> pi compacts",
  (await h({ preparation: { messagesToSummarize: [{ role: "user", content: "hi" }] } }, ctx)) === undefined);
check("no model -> pi compacts",
  (await h({ preparation: { firstKeptEntryId: "a", messagesToSummarize: [{ role: "user", content: "hi" }] } }, { cwd: DIR })) === undefined);
check("nothing to summarise -> pi compacts",
  (await h({ preparation: { firstKeptEntryId: "a", messagesToSummarize: [] } }, ctx)) === undefined);
// Unreachable server: the fetch throws, and a thrown handler must not lose the compaction.
{
  const prev = process.env.PI_OLLAMA_URL;
  const dead = await import("../extensions/lean-summary.ts?dead");
  check("an unreachable model -> pi compacts",
    (await h({ preparation: { firstKeptEntryId: "a", messagesToSummarize: [{ role: "user", content: "hi" }] },
      signal: AbortSignal.abort() }, ctx)) === undefined,
    "an aborted or failed call must fall through, never substitute a worse summary");
  void prev; void dead;
}

// --- the prompt ------------------------------------------------------------
check("names the files that make it safe", /PLAN\.md/.test(LEAN_PROMPT) && /NOTES\.md/.test(LEAN_PROMPT));
check("asks for what those files do not hold",
  /just attempted/.test(LEAN_PROMPT) && /in flight/.test(LEAN_PROMPT));
check("asks for no headings, unlike pi's nine sections", /No headings/.test(LEAN_PROMPT));
// The bug was position, not wording: the instruction sat in a system message
// before the transcript, so the user turn ended on an assistant line and the
// model continued it. pi puts its instruction after the conversation on purpose.
check("tells the model not to continue the conversation",
  /Do not continue the conversation/i.test(LEAN_PROMPT),
  "the prompt now trails the transcript, so it must say what it is looking at");
check("refers to the transcript as above it", /transcript above/i.test(LEAN_PROMPT));


// --- the usage record pi renders -----------------------------------------
// Returning {input, output} crashed a live session. pi's addUsageToTotals reads
// usage.cost.total, from the FOOTER's render, so the throw landed after the
// compaction had already succeeded and killed the process instead of falling
// back. Every field pi's Usage declares has to be present.
{
  const u = leanUsage(1200, 648);
  for (const f of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
    check(`usage carries ${f}`, typeof u[f] === "number");
  }
  check("usage carries a cost object", u.cost && typeof u.cost === "object");
  for (const f of ["input", "output", "cacheRead", "cacheWrite", "total"]) {
    check(`cost carries ${f}`, typeof u.cost[f] === "number", "cost.total is the one that crashed it");
  }
  check("totalTokens is the sum", u.totalTokens === 1848);
  check("cost is zero for a local model", u.cost.total === 0);
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
