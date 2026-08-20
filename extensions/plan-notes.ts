/**
 * plan-notes — externalise state to markdown so context can be thrown away.
 *
 * A local 27B model gets slower and dumber as context grows: prefill is
 * quadratic and quality degrades long before the window fills. This extension
 * moves the two things worth remembering out of the conversation and onto disk:
 *
 *   PLAN.md   ordered checklist of steps, one in progress at a time
 *   NOTES.md  durable findings (technical / product / design / gotcha)
 *
 * The agent then works one step at a time, and `plan_next` starts a FRESH
 * session seeded only with the plan and the notes. Context returns to its
 * ~2K floor at every step boundary instead of growing all afternoon.
 *
 * Tools:  plan_write, plan_next, plan_status, note_add
 * Commands: /plan, /notes, /next
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { requestCompaction } from "../lib/compaction.ts";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";

// Kept under the project's .pi/ directory, next to Pi's own .pi/agent/sessions,
// so working files never land in the repo root.
const PLAN_FILE = process.env.PI_PLAN_FILE || ".pi/PLAN.md";
const NOTES_FILE = process.env.PI_NOTES_FILE || ".pi/NOTES.md";

const CATEGORIES = ["technical", "product", "design", "gotcha", "decision"] as const;

// Finishing a step should not hand control back and wait for "continue".
// Disable with PI_PLAN_AUTOCONTINUE=0; PI_PLAN_MAX_AUTO caps how many steps run
// unattended before the agent stops and waits, so a model that calls plan_next
// without doing the work cannot spin through the whole plan.
const AUTO_CONTINUE = process.env.PI_PLAN_AUTOCONTINUE !== "0";
const MAX_AUTO = Number(process.env.PI_PLAN_MAX_AUTO ?? 25);

type Step = { done: boolean; text: string };

// ---------------------------------------------------------------- files

function planPath(ctx: { cwd: string }) {
	return path.join(ctx.cwd, PLAN_FILE);
}
function notesPath(ctx: { cwd: string }) {
	return path.join(ctx.cwd, NOTES_FILE);
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

function parsePlan(text: string): Step[] {
	const steps: Step[] = [];
	for (const line of text.split("\n")) {
		const m = /^\s*[-*]\s*\[([ xX])\]\s*(.+?)\s*$/.exec(line);
		if (m) steps.push({ done: m[1].toLowerCase() === "x", text: m[2] });
	}
	return steps;
}

function renderPlan(goal: string, steps: Step[]): string {
	const body = steps.map((s) => `- [${s.done ? "x" : " "}] ${s.text}`).join("\n");
	return `# Plan\n\n${goal ? `**Goal:** ${goal}\n\n` : ""}${body}\n`;
}

function planGoal(text: string): string {
	const m = /^\*\*Goal:\*\*\s*(.+)$/m.exec(text);
	return m ? m[1].trim() : "";
}

function currentStep(steps: Step[]): { index: number; step?: Step } {
	const i = steps.findIndex((s) => !s.done);
	return { index: i, step: i === -1 ? undefined : steps[i] };
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

	if (!step) return "";
	const remaining = steps.filter((s) => !s.done).length;
	const doneList = steps
		.filter((s) => s.done)
		.map((s) => `- ${s.text}`)
		.join("\n");

	return [
		`## Current work (from ${PLAN_FILE})`,
		planGoal(planText) ? `Goal: ${planGoal(planText)}` : "",
		"",
		`**Step ${index + 1} of ${steps.length} — do only this one:**`,
		step.text,
		"",
		doneList ? `Already done:\n${doneList}` : "",
		"",
		notes ? `## Findings so far (from ${NOTES_FILE})\n${notes}` : "",
		"",
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
			pi.sendUserMessage(
				`Continue with step ${reset.index + 1} of ${reset.total}: ${reset.text}`,
			);
		};

		// A true fresh session is not available here: newSession lives on
		// ExtensionCommandContext, which only slash-command handlers receive.
		// Compaction is the reachable equivalent, and the before_agent_start
		// briefing re-establishes the plan either way.
		const started = requestCompaction(ctx, `Step ${reset.index} finished`, {
			instructions:
				`The next step is: ${reset.text}. Keep only what that step needs — ` +
				`decisions, constraints and the state of the code. Drop the narrative of how the previous step went.`,
			// Continue once the summary exists, so the next step starts from the
			// compacted context rather than racing it.
			onSummary: () => carryOn(),
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

	pi.registerTool({
		name: "plan_write",
		label: "Write plan",
		description:
			`Create or replace ${PLAN_FILE} with an ordered checklist of small, independently verifiable steps. ` +
			`Call this once at the start of any task that needs more than one edit.`,
		promptSnippet: `Write ${PLAN_FILE}: break the task into small ordered steps`,
		promptGuidelines: [
			`Use plan_write before starting multi-step work, so progress survives a context reset.`,
			`Keep each step small enough to finish and verify on its own.`,
			`If the agreed direction changes, call plan_write again with the revised steps BEFORE continuing — never keep working against a plan that no longer matches what was agreed.`,
			`Steps that still apply should be repeated verbatim in the revision; their completed state is preserved automatically.`,
		],
		parameters: Type.Object({
			goal: Type.String({ description: "One sentence describing the overall objective" }),
			steps: Type.Array(Type.String(), {
				description: "Ordered steps, each independently verifiable",
			}),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const existing = parsePlan(readFileSafe(planPath(ctx)));
			const d = planDiff(existing, params.steps);
			const losesWork = d.droppedDone.length > 0 || d.droppedPending.length > 0;

			// A plan revision no longer asks permission. Blocking on a dialog
			// defeats the point of plan_next, which exists so the agent can run
			// unattended across context resets: a confirm that nobody is sitting
			// there to answer stalls the run until it times out. And the failure
			// it guarded against is cheap to undo, because the plan is a file in
			// the repo.
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
			const steps: Step[] = params.steps.map((t: string) => {
				const prior = doneText.get(norm(t));
				// Keep the completed step's original wording, which carries its
				// summary — the revision should not erase what was recorded.
				return prior ? { done: true, text: prior } : { done: false, text: t };
			});
			writeFileSafe(planPath(ctx), renderPlan(params.goal, steps));
			return {
				content: [
					{
						type: "text",
						text: `Wrote ${PLAN_FILE} with ${steps.length} steps. Start with step 1: ${steps[0]?.text ?? "(none)"}`,
					},
				],
				details: { steps: steps.length },
			};
		},
	});

	pi.registerTool({
		name: "note_add",
		label: "Add note",
		description:
			`Append a durable finding to ${NOTES_FILE} — something a future session would need to know. ` +
			`Categories: ${CATEGORIES.join(", ")}.`,
		promptSnippet: `Record a finding in ${NOTES_FILE} (technical/product/design/gotcha/decision)`,
		promptGuidelines: [
			`Use note_add for anything that would be expensive to rediscover: a constraint, a gotcha, a decision and its reason.`,
			`Do not use note_add for narration of what you just did — only for things that stay true afterwards.`,
		],
		parameters: Type.Object({
			category: Type.String({ description: `One of: ${CATEGORIES.join(", ")}` }),
			note: Type.String({ description: "The finding, one or two sentences" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = notesPath(ctx);
			const cat = (CATEGORIES as readonly string[]).includes(params.category.toLowerCase())
				? params.category.toLowerCase()
				: "technical";
			let text = readFileSafe(p);
			if (!text.trim()) text = `# Notes\n`;

			const heading = `## ${cat}`;
			const entry = `- ${params.note.trim()}`;
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
			writeFileSafe(p, text.endsWith("\n") ? text : `${text}\n`);
			return {
				content: [{ type: "text", text: `Noted under ${cat}.` }],
				details: { category: cat },
			};
		},
	});

	pi.registerTool({
		name: "plan_status",
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
						text: step
							? `Step ${index + 1}/${steps.length}: ${step.text}`
							: `All ${steps.length} steps are done.`,
					},
				],
				details: { total: steps.length, current: index },
			};
		},
	});

	pi.registerTool({
		name: "plan_next",
		label: "Finish step, reset context",
		description:
			`Mark the current step done and START A FRESH SESSION for the next one. ` +
			`Everything not written to ${PLAN_FILE} or ${NOTES_FILE} is discarded, so record findings with note_add FIRST. ` +
			`This is what keeps context small — call it after each completed step.`,
		promptSnippet: `Complete the current step and reset context for the next one`,
		promptGuidelines: [
			`Call plan_next only after the current step is actually verified (tests run, output checked).`,
			`Call note_add before plan_next for anything worth carrying forward — the conversation is discarded.`,
		],
		parameters: Type.Object({
			summary: Type.Optional(
				Type.String({ description: "One line on what was done, appended to the plan step" }),
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

			steps[index] = {
				done: true,
				text: params.summary ? `${step.text} — ${params.summary}` : step.text,
			};
			writeFileSafe(p, renderPlan(planGoal(text), steps));

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
			pendingReset = {
				index: next.index,
				total: steps.length,
				text: next.step.text,
			};

			return {
				content: [
					{
						type: "text",
						text: `Step ${index + 1} done. Next: step ${next.index + 1} of ${steps.length} — ${next.step.text}. Context is compacted when this turn ends.`,
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
			writeFileSafe(p, renderPlan(planGoal(text), steps));
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
