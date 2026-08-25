/**
 * plan-notes — externalise state to markdown so context can be thrown away.
 *
 * A local 27B model gets slower and dumber as context grows: prefill is
 * quadratic and quality degrades long before the window fills. This extension
 * moves the two things worth remembering out of the conversation and onto disk:
 *
 *   PLAN.md   ordered checklist of steps, one in progress at a time
 *   NOTES.md  durable findings (technical / product / design / gotcha)
 *   PLAN-DONE.md  completed steps, archived out of the plan once there are
 *             more than three, so the plan stays a list of what is LEFT
 *
 * The agent then works one step at a time, and `plan_next` starts a FRESH
 * session seeded only with the plan and the notes. Context returns to its
 * ~2K floor at every step boundary instead of growing all afternoon.
 *
 * Tools:  plan_write, plan_next, plan_status, note_add
 * Commands: /plan, /notes, /next
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expectCompaction, midRunCompactionAllowed, requestCompaction } from "../lib/compaction.ts";
import { EXPIRING_CATEGORY, NOTES_MAX_CHARS, NOTE_MAX_CHARS, duplicateOf, enforceBudget, gcNotes, narrationReason, pruneExpiring, trimNote } from "../lib/notes.ts";
import { Type } from "../lib/schema.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { collapsedRenderer } from "../lib/collapse.ts";
import { charsPerToken } from "../lib/token-estimate.ts";
import { statePath } from "../lib/state-dir.ts";

// Kept under the project's .pi/ directory, next to Pi's own .pi/agent/sessions,
// so working files never land in the repo root.
const PLAN_FILE = process.env.PI_PLAN_FILE || statePath("PLAN.md");
const NOTES_FILE = process.env.PI_NOTES_FILE || statePath("NOTES.md");
// Completed steps move here once there are more than KEEP_DONE of them. The
// plan is a working document about what is LEFT; the archive is the record.
const DONE_FILE = process.env.PI_PLAN_DONE_FILE || statePath("PLAN-DONE.md");
const KEEP_DONE = Number(process.env.PI_PLAN_KEEP_DONE ?? 3);
// A completed step keeps its summary, and the summary is re-injected on every
// turn for as long as the step is retained. Measured on a live plan: completed
// lines had grown to 857 and 875 characters against ~245 for the pending ones,
// so the record of finished work cost more than the work still to do.
const SUMMARY_MAX = Number(process.env.PI_PLAN_SUMMARY_MAX ?? 180);

// `state` is the only one with a lifetime: notes about the CURRENT condition of
// the work, dropped at the next step boundary because that is when "currently"
// stops being true. Everything else is meant to stay true and stays put.
const CATEGORIES = ["technical", "product", "design", "gotcha", "decision", EXPIRING_CATEGORY] as const;

// Finishing a step should not hand control back and wait for "continue".
// Disable with PI_PLAN_AUTOCONTINUE=0; PI_PLAN_MAX_AUTO caps how many steps run
// unattended before the agent stops and waits, so a model that calls plan_next
// without doing the work cannot spin through the whole plan.
const AUTO_CONTINUE = process.env.PI_PLAN_AUTOCONTINUE !== "0";
/** Refuse an edit when the plan on disk is finished, so new work gets its own plan. */
const PLAN_GATE = process.env.PI_PLAN_GATE !== "0";
const MAX_AUTO = Number(process.env.PI_PLAN_MAX_AUTO ?? 25);

/**
 * Whether finishing a step compacts the context.
 *
 * It used to, unconditionally, with force:true so the size check could not stand
 * it down. Measured across 38 real compactions, that produced a whole second
 * population firing at 17,000-22,000 tokens, roughly half of all compactions,
 * against a post-compaction floor near 12,000. Each one cost a summary (~1,725
 * output tokens) plus a full re-prefill, about 145s, to reclaim five to ten
 * thousand tokens of headroom at a depth where decode is still near its best
 * and peak memory is nowhere near the knee.
 *
 * The depth watchdog already compacts when depth is actually the problem, and
 * the before_agent_start briefing re-establishes the plan on every turn, which
 * is what made a wiped context safe in the first place. It orients the model
 * whether or not a compaction happened.
 *
 * What is given up: the step-boundary compaction carried tailored instructions
 * ("keep what the next step needs, drop the narrative"), so narrative from
 * earlier steps now survives until the depth trigger fires with its generic
 * instructions.
 *
 * PI_PLAN_STEP_COMPACT=1 restores it.
 *
 * Read at call time rather than captured at import, so a test can set it
 * without controlling module load order. Same reason keepRecentTokens does.
 */
export function stepCompact(): boolean {
	return process.env.PI_PLAN_STEP_COMPACT === "1";
}

/**
 * A step, and whether anyone has started it.
 *
 * `[ ]` waiting, `[o]` the step work last happened on, `[x]` done. The middle
 * one exists because "current" used to be inferred as "the first one not done",
 * which cannot tell a step someone was interrupted in from one nobody has
 * touched. After a crash, a ctrl+c or a compaction, that is the whole question.
 *
 * It is deliberately not called "in progress". The mark is set by an edit
 * landing while that step was current, which is evidence that work happened
 * near it, not proof that the work was ON it. Observed live: a plan step about
 * index.html was marked while the model was doing an unrelated rename in
 * pang.js that had been asked for in chat. Naming it for what it measures keeps
 * the next session from trusting it further than it deserves.
 */
export type Step = { done: boolean; active?: boolean; text: string };

// ---------------------------------------------------------------- files

function planPath(ctx: { cwd: string }) {
	return path.join(ctx.cwd, PLAN_FILE);
}
function notesPath(ctx: { cwd: string }) {
	return path.join(ctx.cwd, NOTES_FILE);
}
function donePath(ctx: { cwd: string }) {
	return path.join(ctx.cwd, DONE_FILE);
}

function readFileSafe(p: string): string {
	try {
		return fs.readFileSync(p, "utf8");
	} catch {
		return "";
	}
}

/** The .pi directory may not exist yet in a fresh project. */
function writeFileSafe(p: string, contents: string): void {
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, contents, "utf8");
}

export function parsePlan(text: string): Step[] {
	const steps: Step[] = [];
	for (const line of text.split("\n")) {
		const m = /^\s*[-*]\s*\[([ xXoO])\]\s*(.+?)\s*$/.exec(line);
		if (!m) continue;
		const mark = m[1].toLowerCase();
		steps.push({ done: mark === "x", ...(mark === "o" ? { active: true } : {}), text: m[2] });
	}
	return steps;
}

/** Tools that change the repo. Reading is always allowed. */
const MUTATING = new Set(["edit_symbol", "replace_lines", "edit_block", "edit", "write", "multi_edit"]);

/**
 * A finished plan followed by an edit means new work started without one.
 *
 * This is the one case where "no plan" is unambiguous rather than a guess. A
 * session that never had a plan may be answering a one-line request, and being
 * made to plan that is friction. But a plan whose every step is done, followed
 * by an attempt to change the repo, is a different task that skipped planning:
 * observed live, where three fixes arrived in chat, the agent investigated, and
 * went straight to editing with the completed plan from the previous task still
 * sitting on disk.
 *
 * Blocking is the mechanism because guidance was not. The instruction to call
 * plan_write first has been in this tool's guidelines the whole time.
 */
/**
 * The steps, however the model sent them.
 *
 * The schema asks for an array and the model sometimes sends one string. That
 * used to fail validation, which cost a whole turn: observed live, plan_write
 * was rejected, the model spent a turn reasoning about the schema, then retried.
 * A step is one line, so splitting on newlines is unambiguous. Numbered or
 * bulleted prefixes are stripped, since a model writing a list writes "1." in
 * front of it.
 */
export function asSteps(input: string[] | string): string[] {
	const raw = Array.isArray(input) ? input : String(input).split(/\r?\n/);
	return raw
		.map((t) => String(t).replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim())
		.filter(Boolean);
}

export function planIsSpent(steps: Step[]): boolean {
	return steps.length > 0 && steps.every((s) => s.done);
}

function renderPlan(goal: string, steps: Step[]): string {
	const body = steps.map((s) => `- [${s.done ? "x" : s.active ? "o" : " "}] ${s.text}`).join("\n");
	return `# Plan\n\n${goal ? `**Goal:** ${goal}\n\n` : ""}${body}\n`;
}

/**
 * Move all but the most recent KEEP_DONE completed steps into the archive.
 *
 * A finished step costs context twice, and the second one is the expensive one.
 * On disk it is a line in PLAN.md, which is minor. But `briefing()` seeds every
 * fresh session with the completed list AND each step's summary, so a 40-step
 * plan means every context reset starts by re-reading 37 things nobody is going
 * to do again. That is the opposite of what plan_next exists for.
 *
 * Three are kept because the immediate past is genuinely load-bearing: it is how
 * the model knows what it just did and why the current step follows from it.
 * Beyond that it is history, and history belongs in a file you open on purpose.
 *
 * Returns the steps the plan should now contain.
 */
function archiveCompleted(ctx: { cwd: string }, steps: Step[]): Step[] {
	const done = steps.filter((s) => s.done);
	if (done.length <= KEEP_DONE) return steps;

	const overflow = done.slice(0, done.length - KEEP_DONE);
	const keep = new Set(done.slice(done.length - KEEP_DONE));

	const p = donePath(ctx);
	const existing = readFileSafe(p);
	// Match on the step text before its " — summary", so re-archiving after a
	// plan revision does not append the same step twice under new wording.
	const key = (t: string) => t.split(" \u2014 ")[0].trim().toLowerCase().replace(/\s+/g, " ");
	const already = new Set(
		existing
			.split("\n")
			.map((l) => /^\s*-\s*(?:\[[xX ]\]\s*)?(.+?)\s*$/.exec(l)?.[1])
			.filter((t): t is string => Boolean(t))
			.map(key),
	);
	const fresh = overflow.filter((st) => !already.has(key(st.text)));
	if (fresh.length) {
		const header = existing.trim() ? "" : `# Completed\n\n_Archived from ${PLAN_FILE}. Read this when replanning._\n\n`;
		writeFileSafe(p, `${existing.replace(/\s*$/, "")}${existing.trim() ? "\n" : ""}${header}${fresh.map((st) => `- ${st.text}`).join("\n")}\n`);
	}
	return steps.filter((st) => !st.done || keep.has(st));
}

/** How many steps are already in the archive, for the briefing and status. */
function archivedCount(ctx: { cwd: string }): number {
	return readFileSafe(donePath(ctx))
		.split("\n")
		.filter((l) => /^\s*-\s+\S/.test(l)).length;
}

function planGoal(text: string): string {
	const m = /^\*\*Goal:\*\*\s*(.+)$/m.exec(text);
	return m ? m[1].trim() : "";
}

/**
 * The step being worked on: the one marked in progress, else the first waiting.
 *
 * Preferring the mark matters when work happened out of order, or when a step
 * was started and something else was touched afterwards. The fallback keeps a
 * plan written by hand, with no marks in it, working exactly as before.
 */
function currentStep(steps: Step[]): { index: number; step?: Step } {
	const active = steps.findIndex((s) => s.active && !s.done);
	const i = active !== -1 ? active : steps.findIndex((s) => !s.done);
	return { index: i, step: i === -1 ? undefined : steps[i] };
}

/**
 * Mark the current step as started, if it is not already.
 *
 * Deterministic and free: the model is told to do one step, so an edit landing
 * is the best available evidence of where work is. Asking the model to declare
 * a start would be more accurate and would cost a round trip on every step at
 * fifteen tokens a second, and would be forgotten exactly when a session is
 * about to be interrupted, which is the case this exists for.
 *
 * The inaccuracy is real and is why the mark is named for evidence rather than
 * intent. Work asked for in chat, outside the plan, marks the current step too.
 */
export function markActive(steps: Step[]): Step[] | undefined {
	const { index, step } = currentStep(steps);
	if (!step || step.active) return undefined;
	return steps.map((t, i) => (i === index ? { ...t, active: true } : t));
}

/** Compare a proposed plan against the current one. Matching is on trimmed,
 *  case-insensitive text: a model rewording a step slightly should not look
 *  like dropping one and adding another. */
function planDiff(existing: Step[], proposed: string[]) {
	// plan_next appends "text — what was done" to a completed step, so match on
	// the part before that separator; otherwise every finished step looks both
	// dropped and re-added when the plan is revised.
	const key = (t: string) =>
		t.split(" \u2014 ")[0].trim().toLowerCase().replace(/\s+/g, " ");
	const proposedKeys = new Set(proposed.map(key));
	const existingKeys = new Set(existing.map((s) => key(s.text)));

	return {
		droppedDone: existing.filter((s) => s.done && !proposedKeys.has(key(s.text))),
		droppedPending: existing.filter((s) => !s.done && !proposedKeys.has(key(s.text))),
		kept: existing.filter((s) => proposedKeys.has(key(s.text))),
		added: proposed.filter((t) => !existingKeys.has(key(t))),
	};
}

/** The briefing a fresh session needs: the plan, the notes, the current step. */
function briefing(ctx: { cwd: string }): string {
	const planText = readFileSafe(planPath(ctx));
	const steps = parsePlan(planText);
	const { index, step } = currentStep(steps);
	const notes = readFileSafe(notesPath(ctx)).trim();

	// A finished plan used to brief nothing at all: no goal, no findings, not
	// even the fact that a plan file exists. The model then started the next
	// task with no idea it was expected to plan, which is why HANDOFF.md filled
	// up with work that PLAN.md never mentioned. Say so instead.
	if (!step) {
		if (!steps.length) return "";
		return [
			`## ${PLAN_FILE} is complete`,
			planGoal(planText) ? `The finished plan was: ${planGoal(planText)}` : "",
			"",
			"Anything you are asked to do now is new work. Call plan_write with its steps " +
				"before editing, then summarise the plan for the user before starting step 1. " +
				"Editing is refused until a plan exists, so this is not optional.",
			"",
			notes ? `## Findings so far (from ${NOTES_FILE})\n${notes}` : "",
		]
			.filter((t) => t !== "")
			.join("\n");
	}
	const remaining = steps.filter((s) => !s.done).length;
	// Only the recent past is seeded. Everything older is in the archive, which
	// is named here so the model can open it deliberately when replanning
	// instead of being handed it on every single context reset.
	const doneList = steps
		.filter((s) => s.done)
		.map((s) => `- ${s.text}`)
		.join("\n");
	const pendingList = steps
		.slice(index + 1)
		.filter((s) => !s.done)
		.map((s, i) => `${index + 2 + i}. ${s.text}`)
		.join("\n");
	const archived = archivedCount(ctx);

	return [
		`## Current work (from ${PLAN_FILE})`,
		planGoal(planText) ? `Goal: ${planGoal(planText)}` : "",
		"",
		`**Step ${index + 1} of ${steps.length}${step.active ? " (work last happened here)" : ""} — do only this one:**`,
		step.text,
		"",
		doneList ? `Recently done:\n${doneList}` : "",
		// The steps still to come, named but not invited.
		//
		// They used to be withheld, on the reasoning that "do only this one" keeps
		// the model on the current step. The cost of hiding them was worse than
		// the risk: observed live, a session spent a long stretch guessing at them
		// ("steps 2-5 presumably are: apply fixes, verify..."), then read PLAN.md
		// through the shell to find out, and was told off by a steer claiming the
		// file was already in context. It was not. Only the current step and the
		// finished ones were.
		//
		// Titles only, and the instruction above still says to do one. A step list
		// is a handful of tokens; a model reasoning about what it cannot see is
		// not.
		pendingList ? `Still to come, in order (do not start these yet):\n${pendingList}` : "",
		archived ? `(${archived} earlier step(s) archived in ${DONE_FILE} — read it before revising the plan.)` : "",
		"",
		notes ? `## Findings so far (from ${NOTES_FILE})\n${notes}` : "",
		"",
		`If this step turns out to hold more than one outcome, expand it with plan_write (that step replaced by the finer outcomes, the others verbatim) rather than doing all of it in one pass.`,
		`When this step is finished and verified, record anything worth keeping with note_add, then call plan_next. ${remaining - 1} step(s) will remain.`,
	]
		.filter((s) => s !== "")
		.join("\n");
}

// ---------------------------------------------------------------- extension

type PendingReset = { index: number; total: number; text: string };

export default function planNotesExtension(pi: ExtensionAPI) {
	let pendingReset: PendingReset | undefined;
	let autoCount = 0;

	// Anything the user types is a fresh mandate: reset the unattended counter.
	pi.on("input", async () => {
		autoCount = 0;
		return undefined;
	});

	// Perform a queued step-boundary reset once the turn has fully settled.
	// Falls back to compaction, and finally to doing nothing at all — the
	// before_agent_start briefing keeps the model oriented either way, so a
	// missing API costs context size, never correctness.
	const performReset = async (ctx: ExtensionContext) => {
		const reset = pendingReset;
		if (!reset) return;
		pendingReset = undefined;

		const carryOn = () => {
			if (!AUTO_CONTINUE) return;
			if (autoCount >= MAX_AUTO) {
				ctx.ui.notify(
					`Paused after ${autoCount} unattended steps (PI_PLAN_MAX_AUTO). Say continue to resume.`,
					"warning",
				);
				return;
			}
			autoCount++;
			// Always triggers a turn, so the next step starts without the user
			// having to type "continue".
			// See auto-handoff's resume: bare sendUserMessage throws while the agent
			// is streaming, and a step boundary is reached mid-run by definition.
			pi.sendUserMessage(
				`Continue with step ${reset.index + 1} of ${reset.total}: ${reset.text}`,
				{ deliverAs: "followUp" } as never,
			);
		};

		// A true fresh session is not available here: newSession lives on
		// ExtensionCommandContext, which only slash-command handlers receive.
		// Compaction is the reachable equivalent, and the before_agent_start
		// briefing re-establishes the plan either way.
		// Same reason the size watchdog stands down in print mode: this fires
		// mid-run, and an aborted print turn cannot be resumed before the process
		// exits. See midRunCompactionAllowed.
		// Advancing the plan is the part that matters; the compaction was the
		// expensive half and the briefing does the orienting either way.
		if (!stepCompact()) {
			carryOn();
			return undefined;
		}
		if (!midRunCompactionAllowed()) return undefined;
		const started = requestCompaction(ctx, `Step ${reset.index} finished`, {
			// A step boundary is a semantic trigger, not a size one, and it fires
			// mid-run where pi does not act at all. Standing down here is how a
			// finished step carries its whole context into the next one.
			force: true,
			// Lives on the ExtensionAPI, not the context. See requestCompaction.
			setThinkingLevel: (l) => (pi as unknown as { setThinkingLevel?: (x: string) => void }).setThinkingLevel?.(l),
			instructions:
				`The next step is: ${reset.text}. Keep only what that step needs: ` +
				`decisions, constraints and the state of the code. Drop the narrative of how the previous step went, ` +
				`and drop the deliberation that reached each decision. Record what was settled, not the argument. ` +
				`If a sentence would not change what the next step does, leave it out.`,
			// Continue once the compaction settles, whether or not it produced a
			// summary. A refused compaction ("nothing to compact") is a normal
			// outcome on a small step, and it must not stop the plan: hanging
			// carryOn on success alone is what left a run sitting at a prompt
			// after a cosmetic error.
			onDone: () => carryOn(),
		});
		if (!started) carryOn();
	};

	// Swap at the first turn boundary after the step completes, rather than
	// waiting for the whole run to settle: during a long agentic run the model
	// may work through several more steps before settling, which is exactly the
	// context growth the reset exists to prevent. turn_end is still a safe
	// point — no tool call is half-finished.
	pi.on("turn_end", async (_event, ctx) => performReset(ctx));
	// Backstop, in case a run ends without a final turn_end.
	pi.on("agent_settled", async (_event, ctx) => performReset(ctx));
	// Every turn starts by restating where we are. Cheap (a few hundred tokens)
	// and it is what makes a wiped context safe.
	pi.on("before_agent_start", async (event, ctx) => {
		const brief = briefing(ctx);
		if (!brief) return;
		// Append to this turn's system prompt rather than injecting a message:
		// it survives compaction and is the first thing a fresh session sees.
		return { systemPrompt: `${event.systemPrompt}\n\n${brief}` };
	});

	// New work must not start against a spent plan. See planIsSpent. The same
	// hook marks the current step as started, since an edit is the clearest
	// evidence there is that work on it has begun.
	pi.on("tool_call", async (event, ctx) => {
		const e = event as { toolName?: string };
		if (!e.toolName || !MUTATING.has(e.toolName)) return undefined;
		const c = ctx as unknown as { cwd: string };
		const steps = parsePlan(readFileSafe(planPath(c)));
		if (!planIsSpent(steps)) {
			const marked = markActive(steps);
			if (marked) {
				try {
					const text = readFileSafe(planPath(c));
					writeFileSafe(planPath(c), renderPlan(planGoal(text), marked));
				} catch {
					/* a mark is a convenience; never block an edit over it */
				}
			}
			return undefined;
		}
		if (!PLAN_GATE) return undefined;
		return {
			block: true,
			reason:
				`Every step in ${PLAN_FILE} is complete, so this is new work with no plan. ` +
				`Call plan_write with the steps for it first, then summarise the plan for the user before editing.`,
		};
	});

	pi.registerTool({
		name: "plan_write",
		renderResult: collapsedRenderer(),
		label: "Write plan",
		description:
			`Create or replace ${PLAN_FILE} with an ordered checklist of steps. ` +
			`Each step must name the OUTCOME that will be true when it is done, not the activity it consists of: ` +
			`"Paginator::offset() returns 0 for page 1, verified by a runtime check" rather than "look at the paginator". ` +
			`A step whose outcome cannot be checked cannot be finished, only abandoned. ` +
			`Call this at the START of any task that needs more than one edit, before investigating rather than after: if the work needs investigation first, that is step 1 and its outcome is a recorded finding.`,
		promptSnippet: `Write ${PLAN_FILE}: break the task into small ordered steps`,
		promptGuidelines: [
			`Use plan_write before starting multi-step work, so progress survives a compaction.`,
			`After writing a plan, tell the user what you found and what the plan is, then let them respond before starting step 1. Investigation that only exists in your context is investigation the user cannot correct.`,
			// Investigation used to happen BEFORE plan_write, which put it in the
			// one place nothing survives: the conversation. A compaction then threw
			// it away, and the plan that followed described only the fixing, so a
			// resumed session had to investigate again from nothing. Making it step
			// one is what lets it be split, resumed, and seen by the user.
			`Write the plan BEFORE investigating, not after. When the work needs investigation first, that is step 1, stated as what it will produce: "the cause of the double render is identified and recorded with note_add" rather than "investigate the double render". Investigation done before plan_write survives nothing.`,
			`An investigation step ends with note_add. A finding that is only in your context is not an outcome, because nothing can verify it and a compaction erases it.`,
			`Keep each step small enough to finish and verify on its own.`,
			// Phase-shaped plans read well and do not survive contact with the work.
			// Observed live: a five-step plan of "read the PHP", "read the TS",
			// "identify the defects", "fix them", "verify" was written, and the
			// model then did all five inside step 1, because that is how the work
			// actually goes. It spent the rest of the session reconciling a
			// sequential plan against work already finished, and a compaction
			// resumed it into re-reading files it had already read.
			`State each step as the outcome that will be true, not the activity: "the feed returns the newest articles, checked against the seed" rather than "review the feed code". Outcomes can be verified and cannot be half-done; activities can always be done again.`,
			`Do not plan by phase ("read everything", then "fix everything"). Beyond a single leading investigation step, investigation and its fix belong together, because a plan that separates them is one the work will not follow, and every later step then has to be reconciled against work already finished.`,
			`One scoped investigation step is not planning by phase. The difference is whether the step has an outcome of its own: "the three callers of render() are known and recorded" can be finished and checked, while "read the codebase" cannot, and the model will do it alongside the fix regardless.`,
			`If the agreed direction changes, call plan_write again with the revised steps BEFORE continuing — never keep working against a plan that no longer matches what was agreed.`,
			// The failure this prevents: a step turns out to hold several distinct
			// outcomes, the model does all of them in one pass, and the plan then
			// describes a shape the work no longer has. Expanding costs one call
			// and keeps the plan a true record of where things stand.
			`When the step you are on turns out to contain more than one outcome, expand it: call plan_write with that step replaced by the finer outcomes, every other step repeated verbatim. Do that instead of finishing all of it in a single pass, so a compaction lands between outcomes rather than in the middle of one.`,
			`An expansion must stay inside the step it replaces. If a substep duplicates or contradicts a later step, the plan is wrong rather than too coarse: revise the whole thing instead.`,
			`Completed steps beyond the most recent three live in ${DONE_FILE}. Read it before rewriting a plan, so finished work is not scheduled again.`,
			`Steps that still apply should be repeated verbatim in the revision; their completed state is preserved automatically.`,
		],
		parameters: Type.Object({
			goal: Type.String({ description: "one sentence" }),
			// A string is accepted as well as an array. The model serialises the
			// steps as one string often enough that rejecting it costs a whole
			// turn: observed live, plan_write failed validation, the model spent a
			// turn reasoning about the schema, and retried. Splitting a string on
			// newlines is unambiguous here, since a step is one line.
			steps: Type.Union([Type.Array(Type.String()), Type.String()], {
				description: "Ordered steps, each independently verifiable",
			}),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const stepList = asSteps(params.steps);
			const existing = parsePlan(readFileSafe(planPath(ctx)));
			const d = planDiff(existing, stepList);
			const losesWork = d.droppedDone.length > 0 || d.droppedPending.length > 0;

			// A plan revision no longer asks permission. Blocking on a dialog
			// defeats the point of plan_next, which exists so the agent can run
			// unattended across context resets: a confirm that nobody is sitting
			// there to answer stalls the run until it times out. And the failure
			// it guarded against is cheap to undo, because dropped completed
			// steps are in the archive and the plan itself is a file in the repo.
			//
			// The change is still announced, so it stays visible without being
			// blocking. Silence would be the actual problem, not the absence of
			// a prompt.
			if (existing.length && losesWork) {
				const summary = [
					d.droppedPending.length ? `dropping ${d.droppedPending.length} pending` : "",
					d.droppedDone.length ? `dropping ${d.droppedDone.length} completed` : "",
					d.added.length ? `adding ${d.added.length}` : "",
					d.kept.length ? `keeping ${d.kept.length}` : "",
				]
					.filter(Boolean)
					.join(", ");
				ctx.ui.notify(`Plan revised: ${summary}.`, "info");
			}

			// Steps that survive keep their completed state: a revision should
			// not make finished work look outstanding again.
			const norm = (t: string) => t.split(" \u2014 ")[0].trim().toLowerCase().replace(/\s+/g, " ");
			const doneText = new Map(existing.filter((s) => s.done).map((s) => [norm(s.text), s.text]));
			// A step that was under way stays under way through a revision. Losing
			// the mark here would be silent until the next edit re-set it, and an
			// interruption inside that window is exactly the case it exists for.
			const activeText = new Set(existing.filter((s) => s.active && !s.done).map((s) => norm(s.text)));
			const steps: Step[] = stepList.map((t: string) => {
				const prior = doneText.get(norm(t));
				// Keep the completed step's original wording, which carries its
				// summary — the revision should not erase what was recorded.
				if (prior) return { done: true, text: prior };
				return { done: false, ...(activeText.has(norm(t)) ? { active: true } : {}), text: t };
			});
			const kept = archiveCompleted(ctx, steps);
			writeFileSafe(planPath(ctx), renderPlan(params.goal, kept));
			return {
				content: [
					{
						type: "text",
						// Deliberately not "start with step 1". That sentence was an
						// instruction to begin, and the model took it: investigation
						// went straight into edits with nothing shown to the user in
						// between. The recap is the point at which a wrong plan is
						// still cheap to correct.
						text:
							`Wrote ${PLAN_FILE} with ${steps.length} steps. First step: ${steps[0]?.text ?? "(none)"}. ` +
							`Summarise for the user what you found and what you intend to do, then begin step 1 ` +
							`in this same turn. Do not ask whether to start: writing the plan is the agreement to ` +
							`run it. If something genuinely blocks progress, say which assumption you are ` +
							`proceeding under and carry on.`,
					},
				],
				details: { steps: steps.length },
			};
		},
	});

	pi.registerTool({
		name: "note_add",
		renderResult: collapsedRenderer(),
		label: "Add note",
		description:
			`Append a finding to ${NOTES_FILE}. Ask first how long it stays true. ` +
			`"${EXPIRING_CATEGORY}" is for anything scoped to the step you are on ("the PHP sweep found nothing further", ` +
			`"3 tests still fail"): it is dropped at the next step boundary, which is exactly when it stops being true. ` +
			`Everything else (${CATEGORIES.filter((c) => c !== EXPIRING_CATEGORY).join(", ")}) is permanent and will be ` +
			`carried into every later session, so use it only for what outlives this step: a constraint, a gotcha, ` +
			`a decision and its reason. When in doubt, "${EXPIRING_CATEGORY}" is the safe choice.`,
		promptSnippet: `Record a finding in ${NOTES_FILE} (technical/product/design/gotcha/decision)`,
		promptGuidelines: [
			`note_add records what would be expensive to rediscover: a constraint, a gotcha, a decision and its reason. Not what you just did — step summaries belong in plan_next.`,
			`Use category "${EXPIRING_CATEGORY}" for anything only true right now ("3 tests still fail"), so it expires instead of rotting into a false statement.`,
			`Step-scoped findings are the common case, not the exception. A permanent note is a claim that a future session, on unrelated work, still needs this.`,
		],
		parameters: Type.Object({
			category: Type.String({ description: CATEGORIES.join("|") }),
			note: Type.String({ description: "one or two sentences" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = notesPath(ctx);

			// Progress reports are refused rather than trimmed: plan_next already
			// records what a step accomplished, in the plan, where it is archived
			// after three steps. A note saying the same thing is a second copy
			// that nothing prunes, and it was 9 of the 26 notes in the file that
			// motivated this. Refusing costs one retry and teaches the boundary.
			const narration = narrationReason(params.note);
			if (narration) {
				return {
					content: [{
						type: "text",
						text:
							`Not recorded: ${narration}. ${NOTES_FILE} is for things that stay true afterwards, ` +
							`and it is re-read at the start of every session. Pass the summary to plan_next instead, ` +
							`which records it against the step. If there is a durable constraint or gotcha ` +
							`underneath this, note that part on its own.`,
					}],
					isError: true,
				};
			}

			const { text: noteText, trimmed } = trimNote(params.note);

			// A restatement is not free: it is charged on every request for as long
			// as it lives, and two notes saying one thing is how the observed file
			// ended up explaining the roundActive gate twice.
			const dupe = duplicateOf(readFileSafe(p), noteText);
			if (dupe) {
				return {
					content: [{
						type: "text",
						text: `Already recorded, as: "${dupe}". Add a note only if it says something that one does not.`,
					}],
					isError: true,
				};
			}
			const cat = (CATEGORIES as readonly string[]).includes(params.category.toLowerCase())
				? params.category.toLowerCase()
				: "technical";

			let text = readFileSafe(p);
			if (!text.trim()) text = `# Notes\n`;

			const heading = `## ${cat}`;
			const entry = `- ${noteText}`;
			if (text.includes(heading)) {
				// append under the existing category heading
				const lines = text.split("\n");
				const at = lines.findIndex((l) => l.trim() === heading);
				let insert = at + 1;
				while (insert < lines.length && !lines[insert].startsWith("## ")) insert++;
				while (insert > at + 1 && lines[insert - 1].trim() === "") insert--;
				lines.splice(insert, 0, entry);
				text = lines.join("\n");
			} else {
				text = `${text.trimEnd()}\n\n${heading}\n${entry}\n`;
			}
			const budgeted = enforceBudget(text.endsWith("\n") ? text : `${text}\n`);
			writeFileSafe(p, budgeted.text);
			if (budgeted.evicted.length) {
				// Kept on disk rather than deleted: evicted for being re-derivable
				// from the code is not the same as being wrong.
				const arch = path.join(ctx.cwd, `${NOTES_FILE}.archive`);
				const prior = readFileSafe(arch);
				writeFileSafe(arch, `${prior}${budgeted.evicted.map((e) => `- ${e}`).join("\n")}\n`);
			}
			return {
				content: [{
					type: "text",
					text:
						`Noted under ${cat}.` +
						(trimmed ? ` Trimmed to ${NOTE_MAX_CHARS} characters — keep notes to one or two sentences.` : "") +
						(cat === EXPIRING_CATEGORY ? " This one is dropped at the next step boundary." : "") +
						(budgeted.evicted.length
							? ` ${NOTES_FILE} was over ${NOTES_MAX_CHARS} chars, so ${budgeted.evicted.length} older technical note(s) moved to ${NOTES_FILE}.archive.`
							: ""),
				}],
				details: { category: cat, trimmed },
			};
		},
	});

	pi.registerTool({
		name: "plan_status",
		renderResult: collapsedRenderer(),
		label: "Plan status",
		description: `Show the current plan and which step is in progress.`,
		promptSnippet: `Check which plan step is current`,
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const steps = parsePlan(readFileSafe(planPath(ctx)));
			if (!steps.length) {
				return { content: [{ type: "text", text: `No ${PLAN_FILE} yet — use plan_write.` }] };
			}
			const { index, step } = currentStep(steps);
			return {
				content: [
					{
						type: "text",
						text:
							(step
								? `Step ${index + 1}/${steps.length}: ${step.text}`
								: `All ${steps.length} steps are done.`) +
							(archivedCount(ctx) ? ` (${archivedCount(ctx)} earlier step(s) in ${DONE_FILE})` : ""),
					},
				],
				details: { total: steps.length, current: index, archived: archivedCount(ctx) },
			};
		},
	});

	pi.registerTool({
		name: "plan_next",
		renderResult: collapsedRenderer(),
		label: "Finish step",
		description:
			`Mark the current step done and move to the next one. ` +
			`Only ${PLAN_FILE} and ${NOTES_FILE} survive a compaction, so record anything worth keeping with note_add first. ` +
			`Call it as soon as the current step is verified.`,
		promptSnippet: `Mark the current step done and move to the next`,
		promptGuidelines: [
			`Call plan_next only after the current step is actually verified (tests run, output checked).`,
			`Call note_add before plan_next for anything worth carrying forward. Only the plan and the notes survive a compaction.`,
			// The model used to reason itself in circles here, because the old
			// description promised a session reset that never happened: it would
			// weigh whether to also start the next step in the same turn, and
			// whether to pretend its context had been purged. It has not been, and
			// it does not need to decide. End the turn.
			`After plan_next returns, end your turn. The next step is started for you, so do not begin it in the same response.`,
		],
		parameters: Type.Object({
			summary: Type.Optional(
				Type.String({ description: `one line, trimmed past ${SUMMARY_MAX} chars` }),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const p = planPath(ctx);
			const text = readFileSafe(p);
			const steps = parsePlan(text);
			if (!steps.length) {
				return { content: [{ type: "text", text: `No ${PLAN_FILE} — use plan_write first.` }] };
			}
			const { index, step } = currentStep(steps);
			if (!step) {
				return { content: [{ type: "text", text: "All steps are already done." }] };
			}

			const summary = params.summary ? trimNote(params.summary, SUMMARY_MAX).text : "";
			steps[index] = {
				done: true,
				text: summary ? `${step.text} \u2014 ${summary}` : step.text,
			};

			// The step boundary is exactly when "currently" stops being true, so
			// state notes go here. Two notes in the observed file had rotted into
			// false statements this would have retired on time.
			const notesText = readFileSafe(notesPath(ctx));
			const pruned = pruneExpiring(notesText);
			if (pruned.removed) writeFileSafe(notesPath(ctx), pruned.text);
			writeFileSafe(p, renderPlan(planGoal(text), archiveCompleted(ctx, steps)));

			const next = currentStep(steps);
			if (!next.step) {
				autoCount = 0;
				return {
					content: [
						{ type: "text", text: `Step ${index + 1} done. Plan complete — all ${steps.length} steps finished.` },
					],
					details: { complete: true },
				};
			}

			// Queue the reset rather than performing it here: the context handed to
			// a tool comes from an optional factory and may lack newSession
			// ("ctx.newSession is not a function"). The agent_settled handler
			// below runs with the mode's full context, so it can do the swap.
			// Say a compaction is coming as soon as it is scheduled. It happens at
			// the end of this turn, and the abort in between belongs to it.
			if (stepCompact()) expectCompaction();
			pendingReset = {
				index: next.index,
				total: steps.length,
				text: next.step.text,
			};

			return {
				content: [
					{
						type: "text",
						text:
							`Step ${index + 1} done. Next: step ${next.index + 1} of ${steps.length} — ${next.step.text}.` +
							(stepCompact() ? " Context is compacted when this turn ends." : ""),
					},
				],
				details: { completed: index, next: next.index },
			};
		},
	});

	// ------------------------------------------------------------ commands

	pi.registerCommand("plan", {
		description: "Show the current plan",
		handler: async (_args, ctx) => {
			const text = readFileSafe(planPath(ctx));
			ctx.ui.notify(text.trim() || `No ${PLAN_FILE} yet`, "info");
		},
	});

	pi.registerCommand("notes", {
		description: "Show recorded findings",
		handler: async (_args, ctx) => {
			const text = readFileSafe(notesPath(ctx));
			ctx.ui.notify(text.trim() || `No ${NOTES_FILE} yet`, "info");
		},
	});

	pi.registerCommand("notes-gc", {
		description: "Apply the note rules to an existing NOTES.md (--apply to write)",
		handler: async (args, ctx) => {
			const p = notesPath(ctx);
			const text = readFileSafe(p);
			if (!text.trim()) {
				ctx.ui.notify(`No ${NOTES_FILE} yet.`, "info");
				return;
			}
			const r = gcNotes(text);
			const saved = r.before - r.after;
			const summary = [
				`${NOTES_FILE}: ${r.before.toLocaleString()} -> ${r.after.toLocaleString()} chars ` +
					`(${Math.round((100 * saved) / r.before)}% smaller)`,
				`~${Math.round(saved / charsPerToken()).toLocaleString()} tokens saved on EVERY request — it is injected by the briefing.`,
				`Dropping ${r.dropped.length}, trimming ${r.trimmed}.`,
				...r.dropped.slice(0, 12).map((d) => `  - ${d}`),
			].join("\n");
			if (!/--apply|-a\b/.test(args ?? "")) {
				ctx.ui.notify(`${summary}\n\nRun /notes-gc --apply to write it.`, "info");
				return;
			}
			// Keep the original next to it: these are durable findings, and a
			// rule applied retroactively should be reversible.
			try {
				fs.writeFileSync(`${p}.bak`, text, "utf8");
			} catch {
				/* the backup is a courtesy; the write below is what matters */
			}
			writeFileSafe(p, r.text);
			ctx.ui.notify(`${summary}\n\nWritten. Original kept at ${NOTES_FILE}.bak`, "info");
		},
	});

	pi.registerCommand("next", {
		description: "Mark the current plan step done and reset context",
		handler: async (_args, ctx) => {
			const p = planPath(ctx);
			const text = readFileSafe(p);
			const steps = parsePlan(text);
			const { index, step } = currentStep(steps);
			if (!step) {
				ctx.ui.notify("Nothing in progress.", "info");
				return;
			}
			steps[index] = { done: true, text: step.text };
			writeFileSafe(p, renderPlan(planGoal(text), archiveCompleted(ctx, steps)));
			const next = currentStep(steps);
			if (!next.step) {
				ctx.ui.notify("Plan complete.", "info");
				return;
			}
			const message = `Continue the plan. Step ${next.index + 1} of ${steps.length}: ${next.step!.text}`;
			if (typeof ctx.newSession === "function") {
				await ctx.newSession({ withSession: async (fresh) => void (await fresh.sendUserMessage(message)) });
			} else {
				ctx.ui.notify(`Step marked done. ${message}`, "info");
			}
		},
	});
}
