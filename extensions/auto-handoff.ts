/**
 * auto-handoff — keep context under control without interrupting work.
 *
 * Two different pressures, two different responses:
 *
 *   mid-task    compact. Swapping sessions here would abort work in flight, so
 *               the conversation is summarised in place and the run continues.
 *   task done   plan-notes swaps the session at a plan-step boundary, which is
 *               the only moment a full reset is free.
 *
 * The trigger is a projection, not a fixed line. Sampling usage at each turn
 * gives a growth rate; if the NEXT turn or two would cross the limit, it
 * compacts now. A fixed threshold is checked too late by definition: a single
 * turn that reads three files can jump 20% in one step, which is how a session
 * ends up at 90% having never seen 85%.
 *
 * Checks are event-driven (every turn) but the projection is only acted on when
 * it matters, so the further from the limit, the less it does.
 *
 * Thresholds are derived from pi's own, not fixed. pi compacts automatically at
 * `contextWindow - reserveTokens` (16384 by default) — 75% of a 64K window. A
 * fixed 85% threshold therefore never fired first: pi always got there, and our
 * request arrived afterwards as `Compaction failed: Already compacted`. We aim
 * a margin BELOW pi's trigger so our summary instructions are the ones used.
 *
 * Env: PI_HANDOFF_MARGIN=8      points below pi's trigger to act
 *      PI_RESERVE_TOKENS=16384  pi's reserve, if you have changed it
 *      PI_HANDOFF_LOOKAHEAD=2   how many turns ahead to project
 *      PI_HANDOFF_PCT / PI_HANDOFF_HARD  override the derived values outright
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { requestCompaction, compactionBusy, trackExternalCompactions } from "../lib/compaction.ts";

const RESERVE = Number(process.env.PI_RESERVE_TOKENS ?? 16384);
const MARGIN = Number(process.env.PI_HANDOFF_MARGIN ?? 8);
const LOOKAHEAD = Number(process.env.PI_HANDOFF_LOOKAHEAD ?? 2);

/** pi compacts above this; we must act below it or we are always second. */
function piTriggerPct(contextWindow: number): number {
	return ((contextWindow - RESERVE) / contextWindow) * 100;
}
function softPct(contextWindow: number): number {
	if (process.env.PI_HANDOFF_PCT) return Number(process.env.PI_HANDOFF_PCT);
	return Math.max(35, piTriggerPct(contextWindow) - MARGIN);
}
function hardPct(contextWindow: number): number {
	if (process.env.PI_HANDOFF_HARD) return Number(process.env.PI_HANDOFF_HARD);
	return Math.max(40, piTriggerPct(contextWindow) - 2);
}
const HANDOFF_FILE = process.env.PI_HANDOFF_FILE || ".pi/HANDOFF.md";
const NOTES_FILE = process.env.PI_NOTES_FILE || ".pi/NOTES.md";

const INSTRUCTIONS = [
	"Summarise the work so far as state, not narrative, for a session that can see the repo but none of this conversation.",
	"## Done — completed work, each with its concrete outcome (file changed, test passing)",
	"## In progress — the current step and exactly where it stands",
	"## Constraints & decisions — choices made and why, plus anything that must not be broken",
	"## Dead ends — what was tried and did not work, so it is not retried",
	"Name files, functions, commands and error messages. Omit conversational back-and-forth and tool output that led nowhere.",
].join("\n");

type Sample = { tokens: number; at: number };

/** Growth per turn over the recent samples, or undefined if not yet knowable. */
function ratePerTurn(samples: Sample[]): number | undefined {
	if (samples.length < 2) return undefined;
	const recent = samples.slice(-4);
	const deltas: number[] = [];
	for (let i = 1; i < recent.length; i++) {
		const d = recent[i].tokens - recent[i - 1].tokens;
		if (d > 0) deltas.push(d); // a drop means compaction happened; ignore it
	}
	if (!deltas.length) return undefined;
	return deltas.reduce((a, b) => a + b, 0) / deltas.length;
}

function writeFile(cwd: string, rel: string, contents: string) {
	const p = path.join(cwd, rel);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, contents, "utf8");
}

export default function autoHandoffExtension(pi: ExtensionAPI) {
	let samples: Sample[] = [];

	// pi compacts on its own schedule too. Without this the lock only knows
	// about our requests, and we ask for a compaction pi has already done.
	trackExternalCompactions(pi as never);
	pi.on("session_compact", async () => {
		samples = []; // the growth curve restarts, whoever compacted
	});

	const compactNow = (ctx: ExtensionContext, reason: string) => {
		const started = requestCompaction(ctx, reason, {
			instructions: INSTRUCTIONS,
			onSummary: (summary, tokensBefore) => {
				try {
					const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
					writeFile(
						ctx.cwd,
						HANDOFF_FILE,
						`# Handoff\n\n_${stamp}, at ${tokensBefore} tokens (${reason})._\n\n${summary}\n`,
					);
				} catch {
					/* the compaction itself is what matters */
				}
				samples = []; // the curve restarts after a compaction
			},
		});
		return started;
	};

	const evaluate = (ctx: ExtensionContext) => {
		if (compactionBusy()) return; // another extension is already handling it
		const usage = ctx.getContextUsage?.();
		if (!usage?.tokens || !usage.contextWindow) return;
		samples.push({ tokens: usage.tokens, at: Date.now() });
		if (samples.length > 12) samples.shift();

		const SOFT = softPct(usage.contextWindow);
		const HARD = hardPct(usage.contextWindow);
		const pct = usage.percent ?? (usage.tokens / usage.contextWindow) * 100;
		if (pct >= HARD) {
			compactNow(ctx, `Context at ${pct.toFixed(0)}%`);
			return;
		}

		// Projection: would the next turns cross the line? Acting on the
		// forecast rather than the level is what stops a single file-reading
		// turn from jumping the threshold entirely.
		const rate = ratePerTurn(samples);
		if (rate === undefined) return;
		const projected = ((usage.tokens + rate * LOOKAHEAD) / usage.contextWindow) * 100;
		if (projected >= SOFT && pct < SOFT) {
			compactNow(
				ctx,
				`Context ${pct.toFixed(0)}%, growing ~${Math.round(rate)} tokens/turn — ${LOOKAHEAD} more would pass ${SOFT.toFixed(0)}%`,
			);
		} else if (pct >= SOFT) {
			compactNow(ctx, `Context at ${pct.toFixed(0)}%`);
		}
	};

	// Sampled every turn: frequent enough to see a jump coming, and turn_end is
	// a safe moment — no tool call is half-finished.
	pi.on("turn_end", async (_event, ctx) => evaluate(ctx));

	pi.registerCommand("handoff", {
		description: "Summarise and compact now",
		handler: async (_args, ctx) => compactNow(ctx as unknown as ExtensionContext, "Handoff requested"),
	});

	pi.registerCommand("context", {
		description: "Show context usage and the projected compaction point",
		handler: async (_args, ctx) => {
			const c = ctx as unknown as ExtensionContext;
			const u = c.getContextUsage?.();
			if (!u?.tokens) {
				ctx.ui.notify("Context usage unknown (just compacted).", "info");
				return;
			}
			const rate = ratePerTurn(samples);
			const pct = u.percent ?? (u.tokens / u.contextWindow) * 100;
			const SOFT = softPct(u.contextWindow);
			const HARD = hardPct(u.contextWindow);
			const lines = [
				`${u.tokens.toLocaleString()} / ${u.contextWindow.toLocaleString()} tokens (${pct.toFixed(0)}%)`,
				`we compact at ${SOFT.toFixed(0)}% projected / ${HARD.toFixed(0)}% hard; ` +
					`pi's own compaction fires at ${piTriggerPct(u.contextWindow).toFixed(0)}%`,
			];
			if (rate !== undefined) {
				const room = u.contextWindow * (softPct(u.contextWindow) / 100) - u.tokens;
				const turns = rate > 0 ? Math.max(0, Math.floor(room / rate)) : Infinity;
				lines.push(
					`growing ~${Math.round(rate)} tokens/turn — about ${Number.isFinite(turns) ? turns : "many"} turn(s) of room`,
				);
			}
			lines.push(`Full session resets happen at plan steps (see ${NOTES_FILE.replace("NOTES", "PLAN")}).`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
