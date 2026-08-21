/**
 * auto-handoff — keep a durable record of compactions; let pi decide when.
 *
 * This extension used to run its own threshold-based compaction. It no longer
 * does, and the reason is worth keeping: pi already compacts automatically
 * above `contextWindow - reserveTokens` (25% of the window, so it triggers at
 * 75% whatever the window is). A second mechanism watching the same number can only be early or
 * late, and in practice it was late: every request arrived after pi's and came
 * back as `Compaction failed: Already compacted`, alongside `This operation was
 * aborted` and `Nothing to compact (session too small)`.
 *
 * Racing a mechanism that is maintained upstream, knows its own internals, and
 * already handles overflow recovery was never going to win. So:
 *
 *   when to compact   pi decides, on size
 *   plan step done    plan-notes compacts, on meaning — a boundary pi cannot see
 *   on demand         /handoff
 *
 * What is kept here is the part pi does not do: writing the summary to
 * `.pi/HANDOFF.md` so it survives the session, whoever triggered it.
 *
 * Env: PI_HANDOFF_FILE=.pi/HANDOFF.md
 *      PI_RESERVE_TOKENS       pi's reserve, if you have overridden it;
 *                              otherwise 25% of the context window
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { compactAtTokens, compactionBusy, observeContext, recentlyCompacted, requestCompaction, reserveTokens, trackExternalCompactions } from "../lib/compaction.ts";

const HANDOFF_FILE = process.env.PI_HANDOFF_FILE || ".pi/HANDOFF.md";
const PLAN_FILE = process.env.PI_PLAN_FILE || ".pi/PLAN.md";
// Shared with plan-notes, so switching autonomy off switches off both routes.
const AUTO_CONTINUE = process.env.PI_PLAN_AUTOCONTINUE !== "0";
// A resume that produces no progress must not resume forever.
const MAX_RESUMES = Number(process.env.PI_WATCHDOG_MAX_RESUMES ?? 25);

/** The first unfinished step in the plan, if there is one. */
function pendingStep(cwd: string): string | undefined {
	try {
		for (const line of fs.readFileSync(path.join(cwd, PLAN_FILE), "utf8").split("\n")) {
			const m = /^\s*[-*]\s*\[ \]\s*(.+?)\s*$/.exec(line);
			if (m) return m[1];
		}
	} catch {
		/* no plan is a perfectly normal state */
	}
	return undefined;
}

const INSTRUCTIONS = [
	"Summarise the work so far as state, not narrative, for a session that can see the repo but none of this conversation.",
	"## Done — completed work, each with its concrete outcome (file changed, test passing)",
	"## In progress — the current step and exactly where it stands",
	"## Constraints & decisions — choices made and why, plus anything that must not be broken",
	"## Dead ends — what was tried and did not work, so it is not retried",
	"Name files, functions, commands and error messages. Omit conversational back-and-forth and tool output that led nowhere.",
].join("\n");

function writeHandoff(cwd: string, summary: string, tokensBefore: number | undefined, reason: string) {
	try {
		const p = path.join(cwd, HANDOFF_FILE);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
		const size = tokensBefore ? `, at ${tokensBefore} tokens` : "";
		fs.writeFileSync(p, `# Handoff\n\n_${stamp}${size} (${reason})._\n\n${summary}\n`, "utf8");
	} catch {
		/* the compaction itself is what matters; the file is a convenience */
	}
}

export default function autoHandoffExtension(pi: ExtensionAPI) {
	/**
	 * Swallow the abort that our own compaction causes.
	 *
	 * Compacting interrupts the in-flight turn, and that interruption surfaces as
	 * a red "Error: This operation was aborted" against an assistant message. It
	 * is not a failure — it is the mechanism working — and pi already blanks the
	 * equivalent message for its own compaction (`errorMessage: aborted ?
	 * undefined : ...`). Ours had no such treatment, so every compaction printed
	 * an error for something that went exactly to plan.
	 *
	 * Narrow on purpose: only an abort, and only while one of our compactions is
	 * in flight or has just finished. An abort the user caused by pressing escape
	 * still shows, because that one they need to see.
	 */
	pi.on("message_end", async (event) => {
		const m = (event as { message?: { role?: string; errorMessage?: string } }).message;
		if (m?.role !== "assistant" || !m.errorMessage) return undefined;
		if (!/abort/i.test(m.errorMessage)) return undefined;
		if (!compactionBusy() && !recentlyCompacted(10_000)) return undefined;
		return { message: { ...m, errorMessage: undefined } } as never;
	});

	let resumes = 0;
	// Anything the user types is a fresh mandate.
	pi.on("input", async () => {
		resumes = 0;
		return undefined;
	});

	// Mid-run watchdog.
	//
	// The note above says pi owns compaction timing. That is true BETWEEN runs:
	// pi's own comment says it checks "at agent_end and before prompt
	// submission". A single agentic run doing thirty tool calls hits neither,
	// so nothing watches the window while it fills. Observed live at 96.3% of a
	// 51K window with auto-compaction on and pi never firing.
	//
	// turn_end is the right hook: it fires repeatedly inside a long run, and no
	// tool call is half-finished at that point. The shared lock keeps this from
	// racing plan-notes' step-boundary compaction or pi's own.
	pi.on("turn_end", async (_event, ctx) => {
		if (compactionBusy()) return undefined;
		const c = ctx as unknown as ExtensionContext;
		const u = c.getContextUsage?.();
		if (!u?.tokens || !u.contextWindow) return undefined;
		// Every turn, including the quiet ones: the floor is only observable
		// while the session is still small.
		observeContext(u.tokens);
		const trigger = compactAtTokens(u.contextWindow);
		if (u.tokens < trigger) return undefined;
		const pct = Math.round((u.tokens / u.contextWindow) * 100);
		requestCompaction(c, `Context at ${pct}% mid-run`, {
			force: true,
			instructions:
				"Summarise for a session continuing the SAME task mid-flight. Keep the current goal, " +
				"the state of the code, decisions and constraints, and what was just attempted. " +
				"Drop tool output and the narrative of how earlier steps went.",
			onSummary: (summary, tokensBefore) => writeHandoff(c.cwd, summary, tokensBefore, "mid-run watchdog"),
			// Compaction aborts whatever the agent was doing — the abort is what
			// "This operation was aborted" reports. plan-notes resumes after a
			// step-boundary compaction; without the same here, compacting in the
			// MIDDLE of a step left the run sitting at a prompt with the step
			// half-finished, which defeats the point of unattended progress.
			onDone: () => {
				if (!AUTO_CONTINUE) return;
				// Only when there is demonstrably work left. If the plan is finished,
				// or there is no plan, the agent stopping is the correct outcome and
				// nudging it just buys a wasted turn at full context depth.
				const step = pendingStep(c.cwd);
				if (!step) return;
				if (resumes >= MAX_RESUMES) {
					c.ui.notify(
						`Paused after ${resumes} compaction resumes (PI_WATCHDOG_MAX_RESUMES). Say continue to carry on.`,
						"warning",
					);
					return;
				}
				resumes++;
				pi.sendUserMessage(`Context was compacted mid-step. Continue with: ${step}`);
			},
		});
		return undefined;
	});

	// Keeps the shared lock aware of pi's compactions, so plan-notes does not
	// ask for one while pi is mid-flight.
	trackExternalCompactions(pi as never);

	// Whoever compacted — pi on size, plan-notes on a step boundary, or you via
	// /handoff — the summary lands on disk.
	pi.on("session_compact", async (event, ctx) => {
		const entry = (event as { compactionEntry?: { summary?: string; tokensBefore?: number } })
			.compactionEntry;
		if (entry?.summary) writeHandoff(ctx.cwd, entry.summary, entry.tokensBefore, "context compaction");
	});

	pi.registerCommand("handoff", {
		description: "Summarise and compact now",
		handler: async (_args, ctx) => {
			const c = ctx as unknown as ExtensionContext;
			const started = requestCompaction(c, "Handoff requested", {
				// Explicit: the user asked. The high-water guard exists to stop the
				// SIZE-based watchdog racing pi, not to overrule a direct request.
				force: true,
				instructions: INSTRUCTIONS,
				onSummary: (summary, tokensBefore) => writeHandoff(c.cwd, summary, tokensBefore, "requested"),
			});
			if (!started) ctx.ui.notify("Nothing to compact right now.", "info");
		},
	});

	pi.registerCommand("context", {
		description: "Show context usage and when compaction will happen",
		handler: async (_args, ctx) => {
			const u = (ctx as unknown as ExtensionContext).getContextUsage?.();
			if (!u?.tokens) {
				ctx.ui.notify("Context usage unknown (just compacted).", "info");
				return;
			}
			const pct = u.percent ?? (u.tokens / u.contextWindow) * 100;
			const reserve = reserveTokens(u.contextWindow);
			const trigger = ((u.contextWindow - reserve) / u.contextWindow) * 100;
			const room = Math.max(0, u.contextWindow - reserve - u.tokens);
			ctx.ui.notify(
				[
					`${u.tokens.toLocaleString()} / ${u.contextWindow.toLocaleString()} tokens (${pct.toFixed(0)}%)`,
					`pi compacts above ${trigger.toFixed(0)}% — ${room.toLocaleString()} tokens of room left`,
					`Plan steps compact on completion; /handoff compacts now.`,
				].join("\n"),
				"info",
			);
		},
	});
}
