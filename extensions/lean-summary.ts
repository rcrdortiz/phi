/**
 * lean-summary — stop the compaction summary regenerating what is already on disk.
 *
 * pi asks the summariser for nine sections: Goal, Constraints & Preferences,
 * Progress (Done / In Progress / Blocked), Key Decisions, Next Steps, Critical
 * Context. For stock pi that is right, because nothing else survives a
 * compaction. phi keeps the plan in PLAN.md and PLAN-DONE.md and findings in
 * NOTES.md, and plan-notes re-injects both into the system prompt on EVERY
 * turn, so seven of those nine are regenerated at the decode rate to say what
 * phi is about to read off disk anyway.
 *
 * pi's update prompt makes it compound: it says "PRESERVE all existing
 * information from the previous summary", and feeds the previous summary back
 * in verbatim. Measured across 22 compactions paired with recorded durations,
 * corr(summary tokens, seconds) = 0.90, and one session at a flat ~38K depth
 * went 12,950 -> 14,238 -> 16,900 -> 20,369 characters and 287s -> 407s ->
 * 556s -> 607s. Ten minutes to rewrite what it had already written. A session
 * that never ratcheted held at 47-56s.
 *
 * WHY THIS HOOK. The obvious approach, rewriting the request in
 * before_provider_request, does not work, and it fails silently. Compaction
 * calls `streamFn` directly, and sdk.js forwards `transformHeaders` into it but
 * NOT `onPayload`, which is a sibling field. So an extension can rewrite headers
 * on a summarisation call and never its body. The first version of this file did
 * exactly that, passed seventeen tests that all called the pure function
 * directly, and produced a summary carrying all nine of pi's sections on the
 * first real run.
 *
 * session_before_compact is the hook that reaches it: return a `compaction` and
 * pi uses it instead of running its own.
 *
 * The summary IS the session's memory, so every failure path here falls back to
 * pi rather than substituting something worse. Returning undefined means "you do
 * it", and that is what happens on a bad response, a timeout, an abort, or no
 * plan and notes to lean on.
 *
 * Env: PHI_LEAN_SUMMARY=1        use phi's summariser
 *      PHI_LEAN_MAX_TOKENS       cap on the summary (default 900)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { BASE_URL } from "../lib/ollama-models.ts";
import { STATE_DIR } from "../lib/state-dir.ts";

const ENABLED = process.env.PHI_LEAN_SUMMARY === "1";
const MAX_TOKENS = Number(process.env.PHI_LEAN_MAX_TOKENS ?? 900);

export const LEAN_PROMPT = [
	"You are writing a handover note for an agent that will continue this work with the conversation gone.",
	"",
	`Do NOT restate any of the following. It is on disk and re-injected into every turn, so repeating it`,
	"costs time and changes nothing:",
	`- the goal, and every plan step, finished or pending (${STATE_DIR}/PLAN.md, ${STATE_DIR}/PLAN-DONE.md)`,
	`- decisions, constraints and gotchas already recorded (${STATE_DIR}/NOTES.md)`,
	"",
	"Write only what those files do not already hold:",
	"- what was just attempted, and how it turned out",
	"- the state of any edit, command or test left in flight",
	"- anything discovered that has not been written down yet",
	"",
	"Keep exact file paths, function names, error messages and numbers: those are what would be expensive",
	"to rediscover. Leave out the narrative of how the work got here.",
	"",
	"No headings. Under 300 words. If nothing outside the plan and the notes is worth carrying, say that in",
	"one line rather than padding.",
].join("\n");

/** phi's durable state only exists once a plan or notes file has content. */
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

/** Flatten pi's message shapes into a transcript the summariser can read. */
export function transcript(messages: unknown[]): string {
	const out: string[] = [];
	for (const m of messages ?? []) {
		const msg = m as { role?: string; content?: unknown };
		const role = msg?.role ?? "unknown";
		let text = "";
		if (typeof msg?.content === "string") text = msg.content;
		else if (Array.isArray(msg?.content)) {
			text = (msg.content as { type?: string; text?: string }[])
				// Thinking is not part of what a replayed context contains, and it is
				// the bulk of the tokens. Summarising it is paying twice for it.
				.filter((p) => p?.type !== "thinking" && typeof p?.text === "string")
				.map((p) => p.text)
				.join("\n");
		}
		if (text.trim()) out.push(`[${role}] ${text.trim()}`);
	}
	return out.join("\n\n");
}

/** True when the response looks like a usable summary rather than an empty or error body. */
export function usable(summary: unknown): summary is string {
	return typeof summary === "string" && summary.trim().length >= 40;
}

export default function leanSummaryExtension(pi: ExtensionAPI) {
	if (!ENABLED) return;
	let announced = false;

	pi.on("session_before_compact", async (event, ctx) => {
		const c = ctx as { cwd?: string; model?: { id?: string }; ui?: { notify?: (m: string, k: string) => void } };
		// Without a plan or notes there is nothing else carrying the context, and
		// pi's full template is the correct thing to send.
		if (!hasDurableState(c?.cwd)) return undefined;

		const e = event as {
			preparation?: {
				firstKeptEntryId?: string;
				messagesToSummarize?: unknown[];
				turnPrefixMessages?: unknown[];
				tokensBefore?: number;
			};
			customInstructions?: string;
			signal?: AbortSignal;
		};
		const prep = e.preparation;
		const model = c?.model?.id;
		if (!prep?.firstKeptEntryId || !model) return undefined;

		// Both lists, so an in-flight turn is not silently dropped: pi would have
		// summarised turnPrefixMessages separately.
		const body = transcript([...(prep.messagesToSummarize ?? []), ...(prep.turnPrefixMessages ?? [])]);
		if (!body.trim()) return undefined;

		try {
			const prompt = e.customInstructions ? `${LEAN_PROMPT}\n\nAlso: ${e.customInstructions}` : LEAN_PROMPT;
			const r = await fetch(`${BASE_URL}/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model,
					messages: [
						{ role: "system", content: prompt },
						{ role: "user", content: body },
					],
					// Off, for the same reason phi turns it off for pi's summariser:
					// summarising is reading and writing down, and deliberating first
					// is charged at the decode rate, which is the whole cost.
					reasoning_effort: "none",
					max_tokens: MAX_TOKENS,
					temperature: 0.7,
					stream: false,
				}),
				signal: e.signal,
			});
			if (!r.ok) return undefined;
			const j = (await r.json()) as {
				choices?: { message?: { content?: string } }[];
				usage?: { prompt_tokens?: number; completion_tokens?: number };
			};
			const summary = j.choices?.[0]?.message?.content;
			if (!usable(summary)) return undefined;

			if (!announced) {
				announced = true;
				c?.ui?.notify?.(
					`Lean summary: phi summarised this compaction itself (${summary.length} chars). ` +
						`Unset PHI_LEAN_SUMMARY to compare against pi's template.`,
					"info",
				);
			}
			return {
				compaction: {
					summary,
					firstKeptEntryId: prep.firstKeptEntryId,
					tokensBefore: prep.tokensBefore ?? 0,
					usage: {
						input: j.usage?.prompt_tokens ?? 0,
						output: j.usage?.completion_tokens ?? 0,
					},
					details: { leanSummary: true },
				},
			} as never;
		} catch {
			// Abort, timeout, bad JSON: pi runs its own compaction. A slower
			// compaction is a slower compaction; a lost one loses the session.
			return undefined;
		}
	});
}
