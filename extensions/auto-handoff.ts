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
import { requestCompaction, reserveTokens, trackExternalCompactions } from "../lib/compaction.ts";

const HANDOFF_FILE = process.env.PI_HANDOFF_FILE || ".pi/HANDOFF.md";

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
