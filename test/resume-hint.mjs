import resumeHint, { rewriteResumeHint } from "../extensions/resume-hint.ts";

const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + String(d).replace(/\n/g, "\n        ") : ""}`); };
const ESC = String.fromCharCode(27);

// --- the rewrite -----------------------------------------------------------
check("the resume command names phi",
  rewriteResumeHint("To resume this session: pi --session abc\n") === "To resume this session: phi --session abc\n",
  "under phi, `pi --session` looks in ~/.pi and the session is in ~/.phi");
check("a dimmed label does not hide the command",
  rewriteResumeHint(`${ESC}[2mTo resume this session:${ESC}[22m pi --session abc\n`).includes("phi --session"),
  "the label is wrapped in ANSI, so the line cannot be parsed positionally");
check("a --session-dir form survives",
  rewriteResumeHint("To resume this session: pi --session-dir /x --session abc\n").includes("phi --session-dir"));

// Narrowness is the whole safety argument for patching a write.
check("a line without the label is untouched",
  rewriteResumeHint("running pi --session abc now\n") === "running pi --session abc now\n");
check("an id that happens to contain pi is untouched",
  rewriteResumeHint("To resume this session: pi --session pi-01a0\n") === "To resume this session: phi --session pi-01a0\n",
  "only the word before the first flag moves");
check("a path ending in pi is not a command",
  rewriteResumeHint("To resume this session: /usr/bin/pi --session abc\n") === "To resume this session: /usr/bin/pi --session abc\n",
  "a bare word only");
check("the label alone changes nothing",
  rewriteResumeHint("To resume this session: pi\n") === "To resume this session: pi\n",
  "no flags means it is not the command line we mean");
check("an empty string is safe", rewriteResumeHint("") === "");

// --- wiring ----------------------------------------------------------------
const handlers = {};
resumeHint({ on: (e, h) => ((handlers[e] ||= []).push(h)), registerCommand: () => {}, registerTool: () => {} });
check("hooks session_start", (handlers.session_start ?? []).length === 1);

const original = process.stdout.write;
await handlers.session_start[0]({}, { mode: "print" });
check("a --print run leaves stdout alone", process.stdout.write === original,
  "patching a write is only justified by the line it fixes, which is a TUI thing");

await handlers.session_start[0]({}, { mode: "tui" });
check("a TUI run patches the write", process.stdout.write !== original);

// The patch must pass everything else through untouched, and must forward the
// callback/encoding arguments a stream write can carry.
const patched = process.stdout.write;
process.stdout.write = original;

const captured = [];
const sink = ((c, ...rest) => { captured.push(String(c)); const cb = rest.find((r) => typeof r === "function"); cb?.(); return true; });
process.stdout.write = sink;
const handlers2 = {};
resumeHint({ on: (e, h) => ((handlers2[e] ||= []).push(h)), registerCommand: () => {}, registerTool: () => {} });
await handlers2.session_start[0]({}, { mode: "tui" });
const live = process.stdout.write;
// Put the real stdout back before asserting. `live` still closes over the sink,
// so the patch is exercised, while check() output reaches the terminal instead
// of being captured by the thing under test.
process.stdout.write = original;

live("ordinary output\n");
check("output that is not the resume line passes through unchanged",
  captured.at(-1) === "ordinary output\n");

live("To resume this session: pi --session abc\n");
check("the resume line is rewritten on the way out",
  captured.at(-1) === "To resume this session: phi --session abc\n",
  captured.at(-1));

let called = false;
live("plain\n", () => { called = true; });
check("a write callback still fires", called,
  "swallowing it would hang a caller waiting on the drain");

process.stdout.write = original;
void patched;

process.stdout.write = original;
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
