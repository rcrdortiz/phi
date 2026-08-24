// The summary is the session's memory, so the two things that matter are that
// this fires on exactly pi's summarisation call and nothing else, and that it
// stands down when phi has no durable state to lean on.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LEAN_PROMPT, isSummarisationPrompt, hasDurableState, rewritePayload } from "../extensions/lean-summary.ts";
import { STATE_DIR } from "../lib/state-dir.ts";

const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + d : ""}`); };

// --- detection ------------------------------------------------------------
const PI_INITIAL = "The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.\n\nUse this EXACT format:\n\n## Goal";
const PI_UPDATE = "Update the existing structured summary with new information. RULES:\n- PRESERVE all existing information";
check("recognises pi's initial summarisation prompt", isSummarisationPrompt(PI_INITIAL));
check("recognises pi's update prompt", isSummarisationPrompt(PI_UPDATE),
  "the update prompt is the one that says PRESERVE everything, so it ratchets");
check("does not fire on an ordinary turn",
  !isSummarisationPrompt("Please summarize what this function does and add a test."),
  "the word summarize alone must not trigger a payload rewrite");

// --- rewriting ------------------------------------------------------------
{
  const payload = { model: "m", messages: [
    { role: "user", content: "unrelated" },
    { role: "user", content: PI_INITIAL },
  ]};
  const out = rewritePayload(payload);
  check("replaces the summarisation message", out?.messages[1].content === LEAN_PROMPT);
  check("leaves other messages alone", out?.messages[0].content === "unrelated");
  check("the lean prompt names the files that make it safe",
    /PLAN\.md/.test(LEAN_PROMPT) && /NOTES\.md/.test(LEAN_PROMPT));
  check("and asks for what those files do not hold",
    /just attempted/.test(LEAN_PROMPT) && /in flight/.test(LEAN_PROMPT));
}
{
  // phi's own customInstructions are appended by pi as "Additional focus:".
  // They aim the summary at the next step, so they must survive the swap.
  const payload = { model: "m", messages: [
    { role: "user", content: PI_INITIAL + "\n\nAdditional focus: The next step is: two." },
  ]};
  const out = rewritePayload(payload);
  check("keeps phi's own Additional focus", /Additional focus: The next step is: two\./.test(out.messages[0].content));
  check("but drops pi's template", !/## Goal/.test(out.messages[0].content));
}
{
  const payload = { model: "m", messages: [
    { role: "user", content: [{ type: "text", text: PI_INITIAL }] },
  ]};
  check("handles block-shaped content", rewritePayload(payload)?.messages[0].content[0].text === LEAN_PROMPT);
}
check("returns undefined when nothing matched, so the payload passes through",
  rewritePayload({ model: "m", messages: [{ role: "user", content: "hello" }] }) === undefined);
check("survives a payload with no messages", rewritePayload({ model: "m" }) === undefined);
check("survives a null payload", rewritePayload(null) === undefined);

// --- the guard ------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lean-"));
  check("stands down with no durable state", !hasDurableState(dir),
    "with no plan or notes, pi's full template is the correct thing to send");
  fs.mkdirSync(path.join(dir, STATE_DIR), { recursive: true });
  fs.writeFileSync(path.join(dir, STATE_DIR, "NOTES.md"), "");
  check("an empty notes file is not durable state", !hasDurableState(dir));
  fs.writeFileSync(path.join(dir, STATE_DIR, "NOTES.md"), "- something worth keeping\n");
  check("fires once notes have content", hasDurableState(dir));
  check("undefined cwd stands down", !hasDurableState(undefined));
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
