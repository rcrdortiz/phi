import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
import mod, { asSteps } from "../extensions/plan-notes.ts";
import { resetCompactionState } from "../lib/compaction.ts";
import { STATE_DIR, statePath } from "../lib/state-dir.ts";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "plan-"));
const tools = {}; const handlers = {};
const sentMessages = [];
mod({
  registerTool: (t) => (tools[t.name] = t),
  registerCommand: () => {},
  on: (e, h) => (handlers[e] = h),
  sendUserMessage: (m) => sentMessages.push(m),   // plan_next auto-continues
});

const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + d : ""}`); };

async function scenario(label, ctxExtras, expect) {
  resetCompactionState();
  fs.rmSync(path.join(DIR, STATE_DIR), { recursive: true, force: true });
  const notes = [];
  const base = { cwd: DIR, ui: { notify: (m) => notes.push(m) } };
  const toolCtx = { ...base };                       // tools get the partial ctx
  const eventCtx = { ...base, ...ctxExtras };        // events get the mode's ctx
  await tools.plan_write.execute("1", { goal: "g", steps: ["one", "two"] }, undefined, undefined, toolCtx);
  const r = await tools.plan_next.execute("2", {}, undefined, undefined, toolCtx);
  const toolOk = !r.isError;
  await handlers["turn_end"]({}, eventCtx);   // fires first, at the step boundary
  await handlers["agent_settled"]({}, eventCtx); // backstop must be a no-op
  expect({ toolOk, notes, r });
}

// 1. A completed step advances the plan WITHOUT compacting. Measured across 38
// real compactions, the step boundary produced a second population firing at
// 17,000-22,000 tokens against a ~12,000 floor: ~145s spent to reclaim five to
// ten thousand tokens, at a depth where nothing was wrong. The depth watchdog
// still compacts when depth is the actual problem.
let compacted = null;
await scenario("step boundary", { compact: (o) => (compacted = o) },
  ({ toolOk }) => {
    check("plan_next no longer throws from the tool context", toolOk);
    check("a finished step does not compact", compacted === null,
      "the briefing re-establishes the plan every turn, compaction is not what orients it");
  });

// 1b. The old behaviour is still reachable, and still aims its summary at the
// next step: that instruction is the whole reason it was worth doing.
process.env.PI_PLAN_STEP_COMPACT = "1";
let forced = null;
await scenario("step boundary, opted in", { compact: (o) => (forced = o) },
  () => {
    check("PI_PLAN_STEP_COMPACT=1 restores the compaction", forced !== null);
    check("and the summary is still aimed at the next step",
      /next step is: two/i.test(forced?.customInstructions ?? ""),
      (forced?.customInstructions ?? "").slice(0, 70));
  });
delete process.env.PI_PLAN_STEP_COMPACT;

// 2. No compaction available -> degrades quietly rather than erroring.
await scenario("no compact API", {}, ({ notes }) =>
  check("degrades quietly when the context cannot compact",
    !notes.some((n) => /error|failed/i.test(n)), notes.join(" | ") || "(silent)"));

// 4. The plan file still advanced in every case.
const plan = fs.readFileSync(path.join(DIR, STATE_DIR, "PLAN.md"), "utf8");
check("plan still records the completed step", /- \[x\] one/.test(plan), plan.trim().split("\n").slice(-2).join(" / "));

fs.rmSync(DIR, { recursive: true, force: true });

// --- what plan_next tells the model it does -------------------------------
// It used to say "START A FRESH SESSION", "everything not written is
// discarded", and "this is what keeps context small". None of that was ever
// literally true (a real newSession is not reachable from a tool), and since
// step boundaries stopped compacting, none of it is even approximately true.
// A session was observed reasoning in circles about whether to pretend its
// context had been purged and whether to start the next step in the same turn.
{
  const d = tools.plan_next.description + " " + (tools.plan_next.promptGuidelines ?? []).join(" ")
    + " " + (tools.plan_next.promptSnippet ?? "") + " " + (tools.plan_next.label ?? "");
  check("plan_next does not promise a fresh session", !/fresh session|new session/i.test(d), d.slice(0, 90));
  check("plan_next does not claim the conversation is discarded",
    !/is discarded|are discarded/i.test(d), d.slice(0, 90));
  check("plan_next does not claim it resets context", !/reset context/i.test(d));
  // What IS true, and the reason note_add still has to come first.
  check("it still says only the plan and notes survive a compaction",
    /survive a compaction/i.test(d), d.slice(0, 120));
  // The circular reasoning was about what to do next, so say it.
  check("it says to end the turn afterwards", /end your turn/i.test(d));
}


// --- investigation belongs in the plan ------------------------------------
// It used to happen before plan_write, which put it in the one place nothing
// survives: the conversation. A compaction threw it away, the plan described
// only the fixing, and a resumed session investigated again from nothing.
{
  const g = (tools.plan_write.promptGuidelines ?? []).join(" ") + " " + tools.plan_write.description;
  check("tells the model to plan before investigating", /BEFORE investigating|before investigating/.test(g));
  check("gives investigation an outcome shape",
    /is identified and recorded/.test(g),
    "an outcome can be finished and checked; an activity cannot");
  check("requires an investigation step to end in a note", /investigation step ends with note_add/i.test(g),
    "a finding only in context is erased by the next compaction");
  // The anti-phase rule still has to hold, or the old failure comes back: a
  // five-step read/read/identify/fix/verify plan that the model did all at once.
  check("still forbids planning by phase", /Do not plan by phase/.test(g));
  check("and distinguishes the two explicitly", /not planning by phase/i.test(g),
    "one scoped investigation step is allowed; read-everything-then-fix-everything is not");
}

const failed = results.filter((r) => !r).length;

// --- plan_write must not stall, and must not be fussy --------------------
{
  const src = fs.readFileSync(path.join(root, "extensions/plan-notes.ts"), "utf8");
  check("plan_write tells the model to begin, not to ask",
    /begin step 1 in this same turn/.test(src) && /Do not ask whether to start/.test(src),
    "it used to say 'raise anything you want decided', and the model stopped and asked");
  check("the recap survives", /Summarise for the user what you found/.test(src),
    "a wrong plan is cheapest to correct before any editing happens");

  check("steps sent as one string are accepted", JSON.stringify(asSteps("1. one\n2. two")) === '["one","two"]',
    JSON.stringify(asSteps("1. one\n2. two")));
  check("bullets are stripped too", JSON.stringify(asSteps("- a\n* b")) === '["a","b"]');
  check("an array is passed through", JSON.stringify(asSteps(["x", "y"])) === '["x","y"]');
  check("blank lines are dropped", JSON.stringify(asSteps("a\n\n  \nb")) === '["a","b"]');
}


// --- the briefing must show where the plan is going -----------------------
// It used to inject the goal, the current step and the finished ones, but not
// the pending ones. Observed live: a session spent a long stretch guessing
// ("steps 2-5 presumably are: apply fixes, verify..."), read PLAN.md through
// the shell to find out, and was told by a steer that the file was already in
// context. It was not.
{
  const src = fs.readFileSync(path.join(root, "extensions/plan-notes.ts"), "utf8");
  check("the briefing lists the steps still to come",
    /Still to come, in order/.test(src) && /pendingList/.test(src),
    "a model reasoning about what it cannot see costs more than the list does");
  check("pending steps are built from the ones after the current",
    /\.slice\(index \+ 1\)/.test(src));
  check("and it still says to do only the current one",
    /do only this one/.test(src),
    "showing the plan must not become an invitation to run ahead");
  check("they are marked as not-yet",
    /do not start these yet/.test(src));
}


// --- steps are outcomes, notes are scoped -------------------------------
// A five-step plan of "read the PHP", "read the TS", "identify", "fix",
// "verify" was written live, and the model did all five inside step 1 because
// that is how the work goes. It then spent the session reconciling a sequential
// plan against work already finished, and a compaction resumed it into
// re-reading files it had already read.
{
  const src = fs.readFileSync(path.join(root, "extensions/plan-notes.ts"), "utf8");
  check("plan_write asks for the outcome, not the activity",
    /name the OUTCOME that will be true/.test(src),
    "an activity can always be done again; an outcome cannot be half-done");
  check("and gives a worked example of the difference",
    /rather than "look at the paginator"/.test(src));
  check("it warns against planning by phase",
    /Do not plan by phase/.test(src) && /same step/.test(src),
    "separating investigation from its fix is what produced the tangle");

  check("note_add leads with how long the finding stays true",
    /Ask first how long it stays true/.test(src));
  check("step-scoped is presented as the common case",
    /the common case, not the exception/.test(src),
    "the model reached for a permanent category for a step-scoped finding");
  check("permanent categories are named as permanent",
    /permanent and will be\s*\n?\s*`? *\+? *`?carried into every later session/.test(src.replace(/\s+/g, " ")) ||
      /permanent and will be carried into every later session/.test(src.replace(/\s+/g, " ")));
}


// --- expanding a step beats bulldozing it ---------------------------------
// A step that holds several outcomes gets done in one pass, and the plan then
// describes a shape the work no longer has. Expanding is a plan_write revision,
// which already preserves completed state for steps repeated verbatim, so this
// needs guidance rather than machinery.
{
  const src = fs.readFileSync(path.join(root, "extensions/plan-notes.ts"), "utf8");
  check("plan_write offers expansion when a step is too coarse",
    /expand it: call plan_write with that step replaced by the finer outcomes/.test(src),
    "the alternative is a plan that stops matching the work");
  check("expansion keeps the other steps verbatim",
    /every other step repeated verbatim/.test(src),
    "plan_write preserves completed state only for steps repeated exactly");
  check("a substep must not reach outside the step it replaces",
    /must stay inside the step it replaces/.test(src) && /duplicates or contradicts a later step/.test(src),
    "otherwise expanding quietly rewrites the plan");
  check("and the briefing says it where it matters",
    /If this step turns out to hold more than one outcome/.test(src),
    "tool descriptions are read once; the briefing arrives every turn");
  check("the reason is compaction, not tidiness",
    /compaction lands between outcomes rather than in the middle of one/.test(src));
}

console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
