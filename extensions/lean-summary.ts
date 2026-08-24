/**
 * lean-summary — stop the compaction summary regenerating what is already on disk.
 *
 * pi's summariser asks for a nine section checkpoint: Goal, Constraints &
 * Preferences, Progress (Done / In Progress / Blocked), Key Decisions, Next
 * Steps, Critical Context. For stock pi that is right, because nothing else
 * survives a compaction.
 *
 * phi is not stock pi. The plan lives in PLAN.md and PLAN-DONE.md, findings live
 * in NOTES.md, and plan-notes re-injects both into the system prompt on EVERY
 * turn. So seven of those nine sections are regenerated from a conversation the
 * model is about to lose, at the decode rate, to say what phi is about to read
 * off disk anyway. Measured across 40 real compactions: a median summary of
 * ~1,700 output tokens, and at the ~16.5 tok/s decode rate seen at compaction
 * depth that is roughly 105 seconds, which is essentially the whole cost of a
 * compaction. Prefill is cached and free at the default thinking level.
 *
 * pi's UPDATE prompt makes it worse over a long session: it says "PRESERVE all
 * existing information from the previous summary", so the sections ratchet
 * upward. Two of the 40 summaries carried the entire nine section block twice,
 * verbatim.
 *
 * customInstructions cannot fix this. pi appends it as "Additional focus:" on
 * top of the template, so every instruction phi has ever passed about dropping
 * narrative was arguing with a format it could not remove. before_provider_request
 * can replace the payload outright, which is the only hook that reaches it.
 *
 * The risk is asymmetric and worth naming: the summary IS the session's memory.
 * If the plan and the notes turn out not to hold something the narrative did, it
 * is lost silently and shows up later as the model repeating work. Two guards:
 * this only fires when a plan or notes file actually exists, and it is off by
 * default so it can be measured against the current behaviour rather than
 * assumed better.
 *
 * Env: PHI_LEAN_SUMMARY=1  use the lean prompt
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { STATE_DIR } from "../lib/state-dir.ts";

const ENABLED = process.env.PHI_LEAN_SUMMARY === "1";

/** Distinctive of pi's summarisation prompt, and of nothing else it sends. */
const MARKERS = ["Create a structured context checkpoint summary", "Update the existing structured summary"];

export const LEAN_PROMPT = [
	"The messages above are a conversation to summarise, for an agent that will carry on the work.",
	"",
	"Do NOT restate any of the following. It is written to disk and re-injected into every turn, so",
	"repeating it here costs time and changes nothing:",
	`- the goal, and every plan step, finished or pending (${STATE_DIR}/PLAN.md, ${STATE_DIR}/PLAN-DONE.md)`,
	`- decisions, constraints and gotchas already recorded (${STATE_DIR}/NOTES.md)`,
	"",
	"Write only what those files do not already hold:",
	"- what was just attempted and how it turned out",
	"- the state of any edit or command left in flight",
	"- anything discovered that has not been written down yet",
	"",
	"Preserve exact file paths, function names, error messages and numbers: those are what would be",
	"expensive to rediscover. Leave out the narrative of how the work reached this point.",
	"",
	"Aim for under 400 words. If nothing outside the plan and the notes is worth carrying, say that in",
	"one line rather than padding.",
].join("\n");

/** Does this look like pi's summarisation call rather than an ordinary turn? */
export function isSummarisationPrompt(text: string): boolean {
	return MARKERS.some((m) => text.includes(m));
}

/** phi's durable state only exists once a plan or notes file has been written. */
export function hasDurableState(cwd: string | undefined): boolean {
	if (!cwd) return false;
	return ["PLAN.md", "PLAN-DONE.md", "NOTES.md"].some((f) => {
		try {
			return fs.statSync(path.join(cwd, STATE_DIR, f)).size > 0;
		} catch {
			return false;
		}
	});
}

/**
 * Swap pi's template for the lean one, in place, inside a provider payload.
 *
 * Returns the payload only when something was replaced, so a normal turn passes
 * through untouched and pi keeps its own behaviour.
 */
export function rewritePayload(payload: unknown, prompt = LEAN_PROMPT): unknown | undefined {
	const body = payload as { messages?: { role?: string; content?: unknown }[] } | undefined;
	if (!Array.isArray(body?.messages)) return undefined;
	let hit = false;
	for (const m of body.messages) {
		if (typeof m?.content === "string") {
			if (!isSummarisationPrompt(m.content)) continue;
			// Keep any "Additional focus:" phi appended; it is our own text and it
			// is the part aimed at the next step.
			const focus = /\n\nAdditional focus: ([\s\S]*)$/.exec(m.content)?.[1];
			m.content = focus ? `${prompt}\n\nAdditional focus: ${focus}` : prompt;
			hit = true;
		} else if (Array.isArray(m?.content)) {
			for (const part of m.content as { type?: string; text?: string }[]) {
				if (typeof part?.text !== "string" || !isSummarisationPrompt(part.text)) continue;
				const focus = /\n\nAdditional focus: ([\s\S]*)$/.exec(part.text)?.[1];
				part.text = focus ? `${prompt}\n\nAdditional focus: ${focus}` : prompt;
				hit = true;
			}
		}
	}
	return hit ? body : undefined;
}

export default function leanSummaryExtension(pi: ExtensionAPI) {
	if (!ENABLED) return;
	// Say it once per session. A prototype that swaps a prompt silently cannot be
	// told apart from one that never fired, which is the whole thing under test.
	let announced = false;
	pi.on("before_provider_request", async (event, ctx) => {
		// Without a plan or notes on disk there is nothing else carrying the
		// context, and pi's full template is the correct thing to send.
		if (!hasDurableState((ctx as { cwd?: string })?.cwd)) return undefined;
		try {
			const out = rewritePayload((event as { payload?: unknown }).payload);
			if (out && !announced) {
				announced = true;
				(ctx as { ui?: { notify?: (m: string, k: string) => void } })?.ui?.notify?.(
					"Lean summary active: pi's nine-section template replaced for this compaction. " +
						"Unset PHI_LEAN_SUMMARY to compare.",
					"info",
				);
			}
			return out;
		} catch {
			// A summary written by pi's template is a slow compaction. A thrown
			// handler is a failed request, which is a lost turn.
			return undefined;
		}
	});
}
