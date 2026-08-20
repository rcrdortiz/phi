/**
 * Reading a file without paying for the whole file.
 *
 * Two problems, both measured on the pang-clone session that died of context
 * overflow, where `view_lines` alone was 54.1% of everything in context.
 *
 * ── 1. A missing start_line silently means "from line 1" ──────────────────
 *
 * The call that killed that session:
 *
 *   view_lines {file: "pang.js", offset: "630", limit: "120", end_line: 710}
 *
 * `offset` and `limit` are the BUILT-IN read tool's parameter names. view_lines
 * takes start_line/end_line, so typebox dropped the two it did not recognise,
 * `start_line ?? 1` defaulted to the top of the file, and the model received
 * lines 1-710 of a 1036-line file: ~36,000 characters where it wanted 3,870.
 * Nine and a half times too much, ~10K tokens, in a single result.
 *
 * Blaming the model for mixing up two schemas is not a fix — it will keep doing
 * it, because both tools exist and both are about reading lines. So:
 *
 *   - offset/limit are accepted as aliases for start_line/count
 *   - string numbers are coerced, since local models quote them constantly
 *   - an end WITHOUT a start means "the window ending there", never "from 1"
 *   - the span is capped, so no single call can dominate the window
 *
 * The rule that matters is the third. Defaulting an absent start to 1 turns a
 * small mistake into the largest possible result, which is exactly backwards:
 * an ambiguous request should fail small.
 *
 * ── 2. Reading is the wrong way to find something ─────────────────────────
 *
 * Most of those 30 view_lines calls were orientation — "where is the render
 * function" — answered by reading hundreds of lines. `outline` answers it with
 * one line per declaration: ~40 lines instead of ~1000 for pang.js, and the
 * model then views the 30 lines it actually wants.
 */

/** Lines returned when a call gives no bound at all. */
export const DEFAULT_SPAN = 120;
/** Hard ceiling per call, whatever was asked for. */
export const MAX_SPAN = Number(process.env.PI_VIEW_MAX_LINES ?? 400);

export interface RangeRequest {
	start_line?: number | string;
	end_line?: number | string;
	/** Alias for start_line, because the built-in read tool calls it this. */
	offset?: number | string;
	/** Number of lines, not an end position. */
	limit?: number | string;
	count?: number | string;
}

export interface ResolvedRange {
	start: number;
	end: number;
	/** Adjustments worth telling the model about, so it can ask better next time. */
	notes: string[];
}

/** Accept 630, "630" and " 630 "; reject "", null, NaN and negatives. */
function num(v: unknown): number | undefined {
	if (v === undefined || v === null || v === "") return undefined;
	const n = typeof v === "number" ? v : Number(String(v).trim());
	if (!Number.isFinite(n)) return undefined;
	const i = Math.floor(n);
	return i >= 0 ? i : undefined;
}

/**
 * Work out which lines to return, preferring a SMALL window whenever the
 * request is ambiguous.
 */
export function resolveRange(req: RangeRequest, totalLines: number): ResolvedRange {
	const notes: string[] = [];
	const start = num(req.start_line) ?? num(req.offset);
	const end = num(req.end_line);
	const span = num(req.count) ?? num(req.limit);

	if (num(req.offset) !== undefined && num(req.start_line) === undefined) {
		notes.push("`offset` was read as `start_line`");
	}
	if (span !== undefined && num(req.count) === undefined) {
		notes.push("`limit` was read as a line count");
	}

	let s: number;
	let e: number;

	if (start !== undefined && end !== undefined) {
		s = start;
		e = end;
		// offset+limit+end_line together: the end is the odd one out, since
		// offset/limit are a matched pair and describe a window on their own.
		if (span !== undefined && e - s + 1 !== span) {
			e = s + span - 1;
			notes.push(`\`end_line\` ignored: \`offset\`/\`limit\` already describe a window`);
		}
	} else if (start !== undefined) {
		s = start;
		e = start + (span ?? DEFAULT_SPAN) - 1;
	} else if (end !== undefined) {
		// THE FIX. Never expand backwards to line 1: an end with no start is a
		// window ending there, and guessing "the whole file" is how one typo
		// costs 10K tokens.
		e = end;
		s = Math.max(1, end - (span ?? DEFAULT_SPAN) + 1);
		notes.push(`no start given, so this is the ${span ?? DEFAULT_SPAN} lines ending at ${end}`);
	} else if (span !== undefined) {
		s = 1;
		e = span;
	} else {
		s = 1;
		e = Math.min(totalLines, DEFAULT_SPAN);
		if (totalLines > DEFAULT_SPAN) {
			notes.push(`no range given, showing the first ${DEFAULT_SPAN} of ${totalLines} lines`);
		}
	}

	s = Math.max(1, s);
	e = Math.min(totalLines, e);
	if (e < s) {
		// A reversed or out-of-file range; a small window beats an error the
		// model will just retry blindly.
		e = Math.min(totalLines, s + DEFAULT_SPAN - 1);
		notes.push("range was empty or reversed, showing forward from the start");
	}
	if (e - s + 1 > MAX_SPAN) {
		notes.push(`capped at ${MAX_SPAN} lines (asked for ${e - s + 1}); call again from ${s + MAX_SPAN}`);
		e = s + MAX_SPAN - 1;
	}
	return { start: s, end: e, notes };
}

/** Declarations worth showing in an outline, per language family. */
const DECL: Array<{ ext: RegExp; re: RegExp }> = [
	{
		ext: /\.(js|mjs|cjs|jsx|ts|tsx)$/i,
		re: /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function\s*\*?\s+\w+|class\s+\w+|(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>|\w+\s*=>)|\w[\w$]*\s*\([^)]*\)\s*\{)/,
	},
	{ ext: /\.py$/i, re: /^\s*(?:async\s+)?(?:def|class)\s+\w+/ },
	{ ext: /\.php$/i, re: /^\s*(?:abstract\s+|final\s+)?(?:public\s+|private\s+|protected\s+|static\s+)*(?:function\s+\w+|class\s+\w+|trait\s+\w+|interface\s+\w+)/ },
	{ ext: /\.(go|rs)$/i, re: /^\s*(?:pub\s+)?(?:func|fn|type|struct|impl)\s+\w+/ },
	{ ext: /\.(css|scss)$/i, re: /^[^\s@}][^{}]*\{\s*$/ },
	{ ext: /\.(md|markdown)$/i, re: /^#{1,4}\s+\S/ },
];

export interface OutlineEntry {
	line: number;
	text: string;
}

/**
 * One entry per declaration. Returns [] when the file type has no rule, so the
 * caller can fall back to a normal read rather than showing a misleading empty
 * outline.
 */
export function outline(lines: string[], filename: string): OutlineEntry[] {
	const rule = DECL.find((d) => d.ext.test(filename));
	if (!rule) return [];
	const out: OutlineEntry[] = [];
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i];
		if (!l.trim() || l.trim().startsWith("//") || l.trim().startsWith("*")) continue;
		if (rule.re.test(l)) out.push({ line: i + 1, text: l.trimEnd() });
	}
	return out;
}

/**
 * Which lines of which file have already been delivered this session.
 *
 * Measured across 30 sessions: 18% of everything read/view_lines ever returned
 * was lines the model had ALREADY been shown, with no edit to that file in
 * between — 176,722 characters, ~49,000 tokens, and `pang.js` alone was 48,000
 * of them. It is the single largest remaining source of avoidable context.
 *
 * The "with no edit in between" qualifier is the whole design. Re-reading after
 * an edit is correct and necessary: line numbers shift, so the model's memory
 * of them is genuinely stale. Suppressing THAT would break editing. So the
 * cache tracks file identity (size + mtime) and forgets a file the moment it
 * changes on disk, whoever changed it.
 *
 * It only ever suppresses a FULLY covered request. A partial overlap is
 * delivered in full: handing back a fragment with a hole in it, or a range that
 * silently starts somewhere other than where it was asked to, is exactly the
 * class of confusion that made view_lines expensive in the first place.
 */
export interface CacheStamp {
	size: number;
	mtimeMs: number;
}

export class ReadCache {
	private seen = new Map<string, { stamp: CacheStamp; lines: Set<number> }>();

	/** Forget a file whose bytes changed; keep it otherwise. */
	private entry(file: string, stamp: CacheStamp) {
		const e = this.seen.get(file);
		if (e && e.stamp.size === stamp.size && e.stamp.mtimeMs === stamp.mtimeMs) return e;
		const fresh = { stamp, lines: new Set<number>() };
		this.seen.set(file, fresh);
		return fresh;
	}

	/** Record that lines [start, end] of `file` are now in context. */
	record(file: string, stamp: CacheStamp, start: number, end: number): void {
		const e = this.entry(file, stamp);
		for (let i = start; i <= end; i++) e.lines.add(i);
	}

	/** True when every line of [start, end] is already in context, unchanged. */
	covered(file: string, stamp: CacheStamp, start: number, end: number): boolean {
		const e = this.seen.get(file);
		if (!e || e.stamp.size !== stamp.size || e.stamp.mtimeMs !== stamp.mtimeMs) return false;
		for (let i = start; i <= end; i++) if (!e.lines.has(i)) return false;
		return true;
	}

	/** Drop a file entirely — call after an edit, before mtime is even consulted. */
	invalidate(file: string): void {
		this.seen.delete(file);
	}

	clear(): void {
		this.seen.clear();
	}
}
