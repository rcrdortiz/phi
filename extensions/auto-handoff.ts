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
/** Hide the interruption our own compaction causes. See the message_end handler. */
const COMPACT_QUIET = process.env.PI_COMPACT_QUIET !== "0";
/**
 * Record every assistant message_end to `.pi/message-end.log`.
 *
 * Here because the suppressor below is correct in isolation and was still not
 * working in a live session, and a second round of reasoning about why is worth
 * less than one line of what actually arrived. Off by default: it writes on
 * every turn.
 */
const DEBUG = process.env.PHI_DEBUG_MESSAGE_END === "1";

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
	// The expensive thing to carry forward is not the conversation, it is the
	// model arguing with itself. At thinking level high a single decision can
	// run to several hundred tokens of \"actually, wait, reconsider\", and a
	// faithful summary preserves all of it. The conclusion is worth keeping;
	// the route to it almost never is, because the next session cannot act on
	// an argument, only on what it settled.
	"Record what was decided, not the deliberation that reached it. An option considered and rejected belongs under Dead ends as one line with the reason; do not replay the weighing up.",
	"Never carry over self-questioning, second-guessing, or restatements of the task. If a sentence would not change what the next session does, leave it out.",
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

/** See DEBUG. Best effort: a diagnostic must never break the turn it observes. */
function recordMessageEnd(ctx: { cwd: string }, event: unknown): void {
	try {
		const m = (event as { message?: Record<string, unknown> }).message ?? {};
		const content = Array.isArray(m.content) ? (m.content as { type?: string }[]) : [];
		const line = JSON.stringify({
			at: new Date().toISOString(),
			role: m.role,
			stopReason: m.stopReason,
			errorMessage: m.errorMessage ?? null,
			parts: content.map((c) => c?.type),
			busy: compactionBusy(),
			recent: recentlyCompacted(10_000),
		});
		const p = path.join(ctx.cwd, ".pi", "message-end.log");
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.appendFileSync(p, line + "\n");
	} catch {
		/* never break a turn to record it */
	}
}

/** Footer chip key, so repeated writes replace rather than accumulate. */
const STATUS_KEY = "phi-context";

/** 28000 -> "28k". Footer space is scarce and the exact digits are in /context. */
function short(n: number): string {
	return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

export default function autoHandoffExtension(pi: ExtensionAPI) {
	/**
	 * Swallow the interruption our own compaction causes.
	 *
	 * Compacting aborts the in-flight turn. That arrives as an assistant message
	 * with stopReason "error" and the text "This operation was aborted", and it
	 * is not a failure: it is the mechanism working.
	 *
	 * Blanking the text is not enough, and blanking it alone was actively worse
	 * than doing nothing. pi's renderer prints `errorMessage || "Unknown error"`
	 * whenever the stop reason is "error", so removing the one useful word
	 * turned a correctly labelled abort into a red "Error: Unknown error" that
	 * named nothing at all. Confirmed from a recorded message end rather than
	 * reasoned about: stopReason "error", errorMessage "This operation was
	 * aborted", with one of our compactions in flight.
	 *
	 * The stop reason itself has to change, and "stop" is what actually
	 * happened from the session's point of view: the turn ended because we
	 * ended it.
	 *
	 * That rewrite is the part worth care, since stopReason feeds pi's retry and
	 * context accounting and not only the display. Three things keep it narrow:
	 * the message must be an assistant message, one of OUR compactions must be
	 * in flight or seconds old, and the error must either say it was aborted or
	 * say nothing at all. A genuine provider failure names itself and is left
	 * alone. An abort the user caused by pressing escape falls outside the
	 * window and still shows, because that one they need to see.
	 *
	 * Env: PI_COMPACT_QUIET=0  show them, when you suspect one is real
	 */
	pi.on("message_end", async (event, ctx) => {
		if (DEBUG) recordMessageEnd(ctx as unknown as { cwd: string }, event);
		const m = (event as {
			message?: { role?: string; errorMessage?: string; stopReason?: string };
		}).message;
		if (m?.role !== "assistant") return undefined;
		if (m.stopReason !== "error" && m.stopReason !== "aborted") return undefined;
		if (m.errorMessage && !/abort/i.test(m.errorMessage)) return undefined;
		if (!compactionBusy() && !recentlyCompacted(10_000)) return undefined;
		// This is the evidence that a turn was genuinely cut off rather than
		// finishing on its own, and it is what decides whether to resume. Set
		// before the quiet check, so turning the suppression off does not also
		// turn off resuming.
		interrupted = true;
		if (!COMPACT_QUIET) return undefined;
		return { message: { ...m, stopReason: "stop", errorMessage: undefined } } as never;
	});

	let resumes = 0;
	/** Set when one of our compactions aborted a live turn. See onDone. */
	let interrupted = false;
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
		// The built-in footer counts against the model's window, which is nearly
		// twice the depth we actually run to. Show the number that decides when
		// the context is thrown away.
		c.ui.setStatus?.(STATUS_KEY, `ctx ${short(u.tokens)}/${short(trigger)}`);
		if (u.tokens < trigger) return undefined;
		const pct = Math.round((u.tokens / u.contextWindow) * 100);
		requestCompaction(c, `Context at ${pct}% mid-run`, {
			force: true,
			// Same rules as /handoff, plus the one thing that differs: this fires
			// mid-flight, so what was just attempted has to survive. Kept as one
			// definition, because three copies of the summarisation rules drifted
			// apart and only one of them was ever updated.
			instructions: `${INSTRUCTIONS}\nThis fires mid-task: keep the current goal and exactly what was just attempted, since the run continues immediately after.`,
			onSummary: (summary, tokensBefore) => writeHandoff(c.cwd, summary, tokensBefore, "mid-run watchdog"),
			// Compaction aborts whatever the agent was doing — the abort is what
			// "This operation was aborted" reports. plan-notes resumes after a
			// step-boundary compaction; without the same here, compacting in the
			// MIDDLE of a step left the run sitting at a prompt with the step
			// half-finished, which defeats the point of unattended progress.
			onDone: () => {
				if (!AUTO_CONTINUE) return;
				// Resume when work was demonstrably cut off, which is not the same
				// as "a plan step is outstanding". This used to require a pending
				// step, so anything not driven by a plan simply died at the
				// compaction: investigation, a request typed into the chat, even
				// the turn that was on its way to calling plan_write. The plan was
				// a proxy for "is there work left", and a poor one.
				//
				// `interrupted` is set by the message_end handler above when our
				// compaction aborted a live turn, so it is evidence rather than
				// inference. A compaction that interrupted nothing still resumes
				// nothing, which is the case the old guard was really protecting.
				const step = pendingStep(c.cwd);
				const wasInterrupted = interrupted;
				interrupted = false;
				if (!step && !wasInterrupted) return;
				if (resumes >= MAX_RESUMES) {
					c.ui.notify(
						`Paused after ${resumes} compaction resumes (PI_WATCHDOG_MAX_RESUMES). Say continue to carry on.`,
						"warning",
					);
					return;
				}
				resumes++;
				pi.sendUserMessage(
					step
						? `Context was compacted mid-step. Continue with: ${step}`
						: `Context was compacted mid-task. Carry on with what you were doing; the summary above says where you had got to.`,
				);
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
			// Report OUR trigger, not pi's. pi's is the backstop and sits far
			// above: quoting it says there is half a window of room left when
			// compaction is in fact a few thousand tokens away. That gap is
			// exactly why the footer reads as though there is plenty of room.
			const trigger = compactAtTokens(u.contextWindow);
			const room = Math.max(0, trigger - u.tokens);
			const piTrigger = u.contextWindow - reserveTokens(u.contextWindow);
			ctx.ui.notify(
				[
					`${u.tokens.toLocaleString()} of ${trigger.toLocaleString()} tokens before compaction, ` +
						`${room.toLocaleString()} left.`,
					`The model's window is ${u.contextWindow.toLocaleString()}, which is what the footer counts ` +
						`against. Compaction is deliberately much earlier: past roughly 18,000 tokens decode speed ` +
						`is already down to about a third, and a prefix-cache miss deeper than that cannot prefill ` +
						`before the request is judged idle.`,
					`pi's own trigger is ${piTrigger.toLocaleString()} and only ever acts on what we miss.`,
					`Plan steps compact on completion; /handoff compacts now.`,
				].join("\n"),
				"info",
			);
		},
	});
}
