/**
 * write-for-rereading — write code that costs less to re-read.
 *
 * The expensive part of an agent session is not reading code, it is the
 * deliberation that reading triggers. Measured across phi's sessions, thinking
 * is roughly three quarters of output tokens, and a single thinking block has
 * reached 37,505 characters. Most of that is the model reconstructing something
 * the code did not state: what can reach this parameter, whether this can be
 * null here, whether this odd-looking line is a bug.
 *
 * So the lever is not fewer tokens on the page, it is fewer facts the reader has
 * to re-derive. Every "let me double check" is a fact that was not written down.
 *
 * phi's own source is the worked example, and both directions were demonstrated
 * while building it. A comment recording that emptying a finished PLAN.md had
 * been tried and reverted stopped that mistake being repeated, at the cost of
 * one sentence. And pi's comment "Serialize conversation to text so model
 * doesn't try to continue it" was present, correct, and ignored, which cost a
 * live session: the information being written down is necessary, not sufficient.
 *
 * The guidance is deliberately short because it is charged on every turn. It is
 * an experiment, not an established win: the way to judge it is thinking tokens
 * per turn on the same task with it on and off, which the session logs record.
 *
 * Env: PHI_WRITE_GUIDANCE=0   do not inject it
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ENABLED = process.env.PHI_WRITE_GUIDANCE !== "0";

export const GUIDANCE = [
	"When you write code, write it for a model that will read it later without this conversation.",
	"Deliberation is the cost, and it comes from facts the code makes you re-derive:",
	"",
	"- Say why, not what. The code already says what.",
	"- Anything that looks wrong but is right needs a line saying why, or it gets re-investigated on every read.",
	"- Record an approach that was tried and failed beside the code that replaced it, or it gets proposed again.",
	"- Put units and ownership in names: timeoutMs, not timeout.",
	"- State an invariant where it is assumed, not only where it is established.",
	"- Prefer one obvious reading over a general mechanism with several.",
	"",
	"Comment durable things: reasons, invariants, dead ends. A stale comment costs more than no comment,",
	"so never restate code that will drift away from it.",
].join("\n");

export default function writeForRereadingExtension(pi: ExtensionAPI) {
	if (!ENABLED) return;
	pi.on("before_agent_start", async (event) => {
		const base = (event as { systemPrompt?: string }).systemPrompt ?? "";
		return { systemPrompt: base ? `${base}\n\n${GUIDANCE}` : GUIDANCE };
	});
}
