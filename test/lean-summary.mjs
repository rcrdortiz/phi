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
const { default: mod, LEAN_PROMPT, hasDurableState, transcript, usable } =
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
check("a long enough string is usable", usable("x".repeat(50)));
check("an empty string is not", !usable(""));
check("a stub is not", !usable("ok"), "a two character summary would silently erase the session");
check("a non-string is not", !usable({ summary: "no" }));

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

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
