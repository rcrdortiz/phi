/**
 * auto-handoff — when context fills, write down what matters and start clean.
 *
 * Long sessions on a local model degrade twice over: prefill cost grows with
 * every turn, and the useful signal gets buried in dead ends and tool output.
 * At a threshold this summarises the session with a brief aimed at *state*
 * rather than narrative — what is done, what remains, why, what constrains it —
 * writes it to .pi/HANDOFF.md, and starts a fresh session that reconciles
 * .pi/PLAN.md and .pi/NOTES.md before carrying on.
 *
 * Pairs with plan-notes.ts, which re-injects the plan into each new session.
 *
 * Env: PI_HANDOFF_PCT (default 85)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

const THRESHOLD = Number(process.env.PI_HANDOFF_PCT ?? 85);
const HANDOFF_FILE = process.env.PI_HANDOFF_FILE || ".pi/HANDOFF.md";
const PLAN_FILE = process.env.PI_PLAN_FILE || ".pi/PLAN.md";
const NOTES_FILE = process.env.PI_NOTES_FILE || ".pi/NOTES.md";

const INSTRUCTIONS = [
	"Summarise this session as a handoff for a fresh session that can see the repo but none of this conversation.",
	"Structure it exactly as:",
	"## Done — - completed work, each with the concrete outcome (file changed, test passing)",
	"## Remaining — - what is still to do, and why it matters",
	"## Constraints & decisions — - choices made and the reason, plus anything that must not be broken",
	"## Dead ends — - approaches already tried that did not work, so they are not retried",
	"Be specific: name files, functions, commands, error messages.",
	"Omit conversational back-and-forth, restatements, and tool output that led nowhere.",
].join("\n");

function write(cwd: string, rel: string, contents: string) {
	const p = path.join(cwd, rel);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, contents, "utf8");
}

export default function autoHandoffExtension(pi: ExtensionAPI) {
	let busy = false;

	const handoff = async (ctx: ExtensionContext, reason: string) => {
		if (busy) return;
		busy = true;
		ctx.ui.notify(`${reason} — summarising and starting a clean session…`, "info");

		ctx.compact({
			customInstructions: INSTRUCTIONS,
			onError: (err) => {
				busy = false;
				ctx.ui.notify(`Handoff failed: ${err.message}`, "error");
			},
			onComplete: (result) => {
				const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
				write(
					ctx.cwd,
					HANDOFF_FILE,
					`# Handoff\n\n_Written ${stamp} at ${result.tokensBefore} context tokens._\n\n${result.summary}\n`,
				);

				void ctx
					.newSession({
						withSession: async (fresh) => {
							await fresh.sendUserMessage(
								[
									`Continuing after a context reset. Read ${HANDOFF_FILE} for where things stand,`,
									`then reconcile ${PLAN_FILE} (tick off what is done, add steps that emerged) and move any`,
									`durable finding from the handoff into ${NOTES_FILE} with note_add.`,
									`Then continue with the next unfinished step. Do not redo completed work.`,
								].join(" "),
							);
						},
					})
					.finally(() => {
						busy = false;
					});
			},
		});
	};

	// agent_settled fires once a run is fully finished — no retry, compaction or
	// queued continuation pending — which is the only safe moment to swap sessions.
	pi.on("agent_settled", async (_event, ctx) => {
		const usage = ctx.getContextUsage();
		if (!usage?.percent) return;
		if (usage.percent < THRESHOLD) return;
		await handoff(ctx, `Context at ${usage.percent.toFixed(0)}%`);
	});

	pi.registerCommand("handoff", {
		description: "Summarise to .pi/HANDOFF.md and start a clean session now",
		handler: async (_args, ctx) => {
			await handoff(ctx as unknown as ExtensionContext, "Handoff requested");
		},
	});

	pi.registerCommand("context", {
		description: "Show context usage",
		handler: async (_args, ctx) => {
			const u = (ctx as unknown as ExtensionContext).getContextUsage();
			ctx.ui.notify(
				u?.tokens == null
					? "Context usage unknown (just compacted)."
					: `${u.tokens.toLocaleString()} / ${u.contextWindow.toLocaleString()} tokens (${u.percent?.toFixed(0)}%) — handoff at ${THRESHOLD}%`,
				"info",
			);
		},
	});
}
