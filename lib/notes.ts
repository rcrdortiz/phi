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

export interface GcResult {
	text: string;
	dropped: string[];
	trimmed: number;
	before: number;
	after: number;
}

/**
 * Apply the note rules to a file that predates them.
 *
 * The rules only bind new notes, so a file written before them keeps costing
 * its old size on every single turn. This is the one-time catch-up: drop
 * narration, drop exact duplicates, trim the over-long, and report what went so
 * the change is reviewable rather than silent.
 */
export function gcNotes(text: string, max = NOTE_MAX_CHARS): GcResult {
	const before = text.length;
	const out: string[] = [];
	const dropped: string[] = [];
	const seen = new Set<string>();
	let trimmed = 0;
	for (const line of text.split("\n")) {
		const m = /^(\s*-\s+)(\S.*)$/.exec(line);
		if (!m) { out.push(line); continue; }
		const body = m[2].trim();
		const why = narrationReason(body);
		if (why) { dropped.push(`${why}: ${body.slice(0, 60)}`); continue; }
		const key = body.toLowerCase().replace(/\s+/g, " ").slice(0, 80);
		if (seen.has(key)) { dropped.push(`duplicate: ${body.slice(0, 60)}`); continue; }
		seen.add(key);
		const t = trimNote(body, max);
		if (t.trimmed) trimmed++;
		out.push(`${m[1]}${t.text}`);
	}
	// Drop category headings left with nothing under them.
	const kept: string[] = [];
	for (let i = 0; i < out.length; i++) {
		if (/^##\s/.test(out[i])) {
			let j = i + 1;
			while (j < out.length && !/^##\s/.test(out[j]) && !/^\s*-\s+\S/.test(out[j])) j++;
			if (j >= out.length || /^##\s/.test(out[j])) continue;
		}
		kept.push(out[i]);
	}
	const result = `${kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
	return { text: result, dropped, trimmed, before, after: result.length };
}

/**
 * A ceiling, because nothing else provides one.
 *
 * The rules so far all bound a note: narration is refused, length is capped,
 * `state` expires. None of them bounds the FILE. Across 15 sessions note_add was
 * called 35 times, 8 in the busiest one, and every gotcha/technical/decision is
 * permanent by design — so the briefing grows monotonically, and it is charged
 * on every request forever.
 *
 * Eviction is by category, not by age alone, because the two are not
 * interchangeable:
 *
 *   gotcha, decision   constraints and the reasons behind choices. These stay
 *   product, design    true regardless of what the code does next. Never evicted.
 *
 *   technical, state   descriptions of the code AS IT IS NOW. This is the class
 *                      that rots — in the observed file, "run.html is still the
 *                      Space-Invaders suite", "6 tests still FAIL", "shot.html
 *                      still calls startWave()" were all `technical` or `gotcha`
 *                      written as fact and false within days. It is also the
 *                      class that is cheapest to lose, because the code itself
 *                      still says what the code does.
 *
 * When only durable notes remain the file stops shrinking rather than evicting
 * an invariant. A ceiling that discards constraints to meet a number would be
 * worse than no ceiling.
 */
export const NOTES_MAX_CHARS = Number(process.env.PI_NOTES_MAX_CHARS ?? 4000);
const DECAYING = new Set(["technical", EXPIRING_CATEGORY]);

interface Entry { category: string; line: string; index: number; }

function parseEntries(text: string): Entry[] {
	const out: Entry[] = [];
	let cat = "";
	text.split("\n").forEach((line, i) => {
		const h = /^##\s+(\S+)/.exec(line);
		if (h) { cat = h[1].toLowerCase(); return; }
		if (/^\s*-\s+\S/.test(line)) out.push({ category: cat, line, index: i });
	});
	return out;
}

export function enforceBudget(text: string, max = NOTES_MAX_CHARS): { text: string; evicted: string[] } {
	if (text.length <= max) return { text, evicted: [] };
	const lines = text.split("\n");
	const drop = new Set<number>();
	const evicted: string[] = [];
	// Oldest first, and only from the categories that describe passing state.
	for (const e of parseEntries(text)) {
		const size = lines.filter((_, i) => !drop.has(i)).join("\n").length;
		if (size <= max) break;
		if (!DECAYING.has(e.category)) continue;
		drop.add(e.index);
		evicted.push(e.line.replace(/^\s*-\s+/, ""));
	}
	if (!drop.size) return { text, evicted: [] };
	const kept = lines.filter((_, i) => !drop.has(i));
	return { text: `${kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`, evicted };
}

/**
 * Whether `note` restates something already recorded.
 *
 * Jaccard is the obvious choice and the wrong one. The real duplicate pair in
 * the observed file — "Clear-reseed MUST be gated on a flag (this.roundActive)
 * set ONLY by startDrop()" against "Clear-detection in play() is gated on
 * this.roundActive (set only by startDrop()). Isolated tests set bombs[]
 * directly" — scores 0.375, because the second note says everything the first
 * does AND more. Union in the denominator punishes a restatement for being
 * longer.
 *
 * Overlap coefficient (shared / smaller) measures containment instead, which is
 * what a restatement actually is. On its own it over-fires on notes that merely
 * share vocabulary, so it is paired with a requirement for two shared
 * IDENTIFIERS — this.roundActive, startDrop(), pang.js. Two notes about the same
 * named things, one containing the other, is a duplicate; two notes about the
 * same file are not.
 */
function tokens(t: string): Set<string> {
	const out = new Set<string>();
	for (const raw of t.toLowerCase().replace(/[^a-z0-9_().\s]/g, " ").split(/\s+/)) {
		// Trim punctuation clinging to the edges, while keeping the "()" that
		// makes a call look like a call. Without this, `this.roundActive)` and
		// `this.roundActive` are different tokens and an obvious restatement
		// scores as unrelated.
		let w = raw.replace(/^[^a-z0-9_]+/, "").replace(/[.,;:]+$/, "");
		// A call inside brackets — "(set only by startDrop())" — ends with two
		// closing parens, one of which belongs to the prose. Collapse the run so
		// startDrop()) and startDrop() are the same identifier.
		w = w.includes("(") ? w.replace(/\)+$/, ")") : w.replace(/\)+$/, "");
		if (w.length > 2) out.add(w);
	}
	return out;
}
function identifiers(t: string): Set<string> {
	return new Set([...tokens(t)].filter((w) => w.includes(".") || w.includes("(") || w.includes("_")));
}

export function duplicateOf(text: string, note: string): string | undefined {
	const inWords = tokens(note);
	const inIds = identifiers(note);
	if (inWords.size < 4) return undefined;
	for (const e of parseEntries(text)) {
		const exWords = tokens(e.line);
		let shared = 0;
		for (const w of inWords) if (exWords.has(w)) shared++;
		const overlap = shared / Math.max(1, Math.min(inWords.size, exWords.size));
		if (overlap < 0.55) continue;
		const exIds = identifiers(e.line);
		let sharedIds = 0;
		for (const w of inIds) if (exIds.has(w)) sharedIds++;
		if (sharedIds >= 2) return e.line.replace(/^\s*-\s+/, "");
	}
	return undefined;
}
