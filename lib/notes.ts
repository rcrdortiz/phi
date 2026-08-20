/**
 * What belongs in NOTES.md, and how long it stays there.
 *
 * Measured on the pang-clone notes file: 26 notes, 14,723 characters, ~4,090
 * tokens — re-injected into EVERY fresh session by briefing(), which is where
 * the cost actually lands. Reading them showed three different kinds of thing
 * sharing one bucket and one lifetime:
 *
 *   9 of 26  progress narration — "Step 1 done:", "Step 3 done:", "delivered
 *            across 6 steps". Already forbidden by note_add's own guideline,
 *            and a duplicate of the summaries plan_next writes into the plan.
 *
 *   2 of 26  actively FALSE. One said test/run.html was still the old
 *            Space-Invaders suite; another said 6 tests were failing. A later
 *            note recorded the rewrite and 44/44 passing. Both were true when
 *            written and rotted afterwards, and both were still being fed to
 *            every new session.
 *
 *   ~6 of 26 genuine invariants: the indentation gotcha, the split-pass
 *            ordering rule, "I cannot view images, use test/shot.html".
 *
 * That is why an LRU is the wrong instrument here. LRU evicts by recency, and
 * recency is uncorrelated with which of those three a note is — it would keep
 * fresh narration and drop the oldest invariant, which is precisely backwards.
 * It also cannot work mechanically: briefing() injects the whole file every
 * time, so every note is "used" on every turn and there is no access signal to
 * sort by. An LRU here degenerates into insertion order.
 *
 * Human memory is a better guide than the cache analogy suggests, but the part
 * that transfers is consolidation and decay, not recency: things that stay true
 * harden, observations about a passing situation fade. So lifetime is a
 * property of the KIND of note, declared when it is written.
 */

/** Notes about the current condition of the work. Dropped at the next step
 *  boundary, because that is exactly when "currently" stops being true. */
export const EXPIRING_CATEGORY = "state";

/** One or two sentences. The file averaged 565 characters per note against a
 *  "one or two sentences" instruction, so the instruction alone did not hold. */
export const NOTE_MAX_CHARS = Number(process.env.PI_NOTE_MAX_CHARS ?? 350);

/**
 * Detect a note that is really a progress report.
 *
 * plan_next already records what a step accomplished, in the plan, where it is
 * archived after three steps. A note saying the same thing is a second copy
 * that nothing ever prunes. Returns the reason to refuse, or undefined.
 */
export function narrationReason(note: string): string | undefined {
	const t = note.trim();
	// "Step 3 done: ...", "Starfield (step 1) done", "step 2 complete"
	if (/\bstep\s*\d+\b[^.]{0,40}?\b(done|complete|completed|finished|delivered|landed)\b/i.test(t))
		return "it reports that a step finished";
	// "Professional redesign delivered across 6 steps"
	if (/\b(delivered|implemented|completed)\b[^.]{0,40}\bacross\s+\d+\s+steps?\b/i.test(t))
		return "it summarises work across several steps";
	// A leading "<something> done:" header, which is how most of them opened.
	if (/^[^:\n]{0,60}\b(done|complete)\b\s*:/i.test(t)) return "it opens as a completion report";
	return undefined;
}

/**
 * Trim an over-long note, preferring a sentence boundary.
 *
 * Truncating rather than refusing is deliberate. A refusal costs a round trip
 * and risks a loop with a model that cannot self-shorten reliably, whereas the
 * point of a note is almost always in its first sentence or two — which is what
 * the length limit is trying to enforce in the first place.
 */
export function trimNote(note: string, max = NOTE_MAX_CHARS): { text: string; trimmed: boolean } {
	const t = note.trim().replace(/\s+/g, " ");
	if (t.length <= max) return { text: t, trimmed: false };

	const head = t.slice(0, max);
	// Cut at the last sentence end if one sits in the back half, so we do not
	// throw away most of the allowance chasing a boundary.
	const stop = Math.max(head.lastIndexOf(". "), head.lastIndexOf("; "), head.lastIndexOf("! "));
	if (stop > max * 0.5) return { text: head.slice(0, stop + 1), trimmed: true };
	// No usable boundary: cut at a word, leaving room for the ellipsis so the
	// result still honours `max` rather than overshooting it by three.
	const room = t.slice(0, Math.max(1, max - 3)).replace(/\s+\S*$/, "");
	return { text: `${room}...`, trimmed: true };
}

/** Remove the expiring section from a notes file. Returns the new text and how
 *  many notes went. */
export function pruneExpiring(text: string): { text: string; removed: number } {
	if (!text.trim()) return { text, removed: 0 };
	const lines = text.split("\n");
	const at = lines.findIndex((l) => l.trim().toLowerCase() === `## ${EXPIRING_CATEGORY}`);
	if (at === -1) return { text, removed: 0 };
	let end = at + 1;
	while (end < lines.length && !lines[end].startsWith("## ")) end++;
	const removed = lines.slice(at + 1, end).filter((l) => /^\s*-\s+\S/.test(l)).length;
	const kept = [...lines.slice(0, at), ...lines.slice(end)];
	// Collapse the blank run the removed section leaves behind.
	return { text: `${kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`, removed };
}
