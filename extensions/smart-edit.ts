/**
 * smart-edit — edits that survive a model with imperfect whitespace recall.
 *
 * The built-in edit tool needs byte-exact `oldText`. A local 30B model cannot
 * reliably reproduce indentation: it reads a file, forms an approximate memory
 * of it, and matches fail. Worse, each failure tends to push it toward blind
 * sed/awk splicing, which corrupts the file and makes the next match harder.
 * (Observed: a file left with 3-, 5-, 7- and 9-space indents after a flailing
 * session, and a `};` at 2 spaces the model kept matching at 5.)
 *
 * Three tools that remove that failure mode:
 *
 *   edit_block    match on line CONTENT, ignoring indentation; re-indent the
 *                 replacement to the file's actual indentation
 *   replace_lines deterministic line-range replacement, with a guard string
 *   view_lines    numbered view so ranges can be targeted precisely
 *   outline       declarations with line numbers, to find a range cheaply\n *   edit_symbol   edit a named function/method/class, no line numbers at all
 *
 * The built-in `edit` and `read` tools are retired in favour of edit_block and
 * view_lines: one tool per job, so the model never guesses between two schemas.
 *
 * Every write is syntax-checked where a checker exists (js/ts/json/py/php) and
 * automatically reverted if the edit breaks the file, so a bad edit costs one
 * error message rather than a corrupted file.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "../lib/schema.ts";
import { callersNote, declarationCount, enclosingSymbol, findCallers, recordHint } from "../lib/references.ts";
import { collapsedRenderer } from "../lib/collapse.ts";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { MAX_SPAN, ReadCache, alreadyInContext, outline, resolveRange } from "../lib/read-lean.ts";
import { findSymbol, supportsSymbols } from "../lib/symbols.ts";

// The built-in edit tool needs byte-exact indentation, which is the failure
// this extension exists to remove. Leaving it available means the model keeps
// reaching for it and keeps getting "Could not find the exact text".
const KEEP_BUILTIN_EDIT = process.env.PI_KEEP_BUILTIN_EDIT === "1";

// The built-in `read` competes with view_lines for the same job, and having
// both is what made view_lines expensive: the model borrowed read's `offset`
// and `limit` parameter names for view_lines calls 17 times across 30 sessions,
// and view_lines silently dropped them and started from line 1.
//
// The precedent is `edit`, retired above for the same reason and vindicated by
// the logs: the built-in edit failed 20 of 41 calls (49%), edit_block 0 of 31.
// One tool per job is what stops a local model guessing between two schemas.
//
// read is also uncapped, and it was 33.3% of all context across those sessions.
const KEEP_BUILTIN_READ = process.env.PI_KEEP_BUILTIN_READ === "1";

function resolve(cwd: string, p: string): string {
	return path.isAbsolute(p) ? p : path.join(cwd, p);
}

/** Lines already delivered this session, so the same range is not sent twice. */
const readCache = new ReadCache();

function stampOf(file: string) {
	const st = fs.statSync(file);
	return { size: st.size, mtimeMs: st.mtimeMs };
}

function readLines(file: string): string[] {
	return fs.readFileSync(file, "utf8").split("\n");
}

/** Content of a line with indentation and trailing space removed. */
function norm(line: string): string {
	return line.trim();
}

function indentOf(line: string): string {
	return /^[ \t]*/.exec(line)?.[0] ?? "";
}

/**
 * Find where `needle` lines occur in `hay`, comparing trimmed content only.
 * Blank lines in the needle match any blank line.
 */
function findBlock(hay: string[], needle: string[]): number[] {
	const n = needle.map(norm);
	// Ignore leading/trailing blank lines in the needle — models add them freely.
	while (n.length && n[0] === "") n.shift();
	while (n.length && n[n.length - 1] === "") n.pop();
	if (!n.length) return [];

	const hits: number[] = [];
	for (let i = 0; i + n.length <= hay.length; i++) {
		let ok = true;
		for (let j = 0; j < n.length; j++) {
			if (norm(hay[i + j]) !== n[j]) {
				ok = false;
				break;
			}
		}
		if (ok) hits.push(i);
	}
	return hits;
}

/** Best-effort "did you mean" when nothing matched. */
function closest(hay: string[], needle: string[]): string {
	const first = needle.map(norm).find((l) => l !== "");
	if (!first) return "";
	const scored = hay
		.map((line, i) => ({ i, line, score: similarity(norm(line), first) }))
		.filter((c) => c.score > 0.5)
		.sort((a, b) => b.score - a.score)
		.slice(0, 3);
	if (!scored.length) return "";
	return (
		"\nClosest lines in the file:\n" +
		scored.map((c) => `  ${c.i + 1}: ${c.line}`).join("\n") +
		"\nUse view_lines to see the exact text, or replace_lines to edit by number."
	);
}

function similarity(a: string, b: string): number {
	if (!a || !b) return 0;
	if (a === b) return 1;
	const shorter = a.length < b.length ? a : b;
	const longer = a.length < b.length ? b : a;
	if (longer.includes(shorter)) return shorter.length / longer.length;
	let same = 0;
	for (let i = 0; i < shorter.length; i++) if (a[i] === b[i]) same++;
	return same / longer.length;
}

/**
 * Re-indent `replacement` so its shallowest line sits at `baseIndent`, keeping
 * the replacement's own relative structure. This is what lets a model supply
 * roughly-indented code and still get a correctly indented file.
 *
 * Anchored on the MINIMUM indent across the block, not the first line's indent
 * as a string prefix. The old version did the latter and had two failure modes,
 * both of which flattened nested code onto one level:
 *
 *   - a replacement whose first line has no indent gives `own === ""`, which is
 *     falsy, so EVERY line took the fallback branch and lost its nesting;
 *   - any line not literally starting with the first line's whitespace — normal
 *     the moment a block contains a deeper line — took it too.
 *
 * Flattening a `}` to the same column as the `if` that opened it is what
 * "the re-indent cascade is mangling braces" meant. It produced files whose
 * structure no longer matched their indentation, which then broke the next
 * content match, which is how an edit session turns into a loop.
 */
function reindent(replacement: string[], baseIndent: string): string[] {
	const nonBlank = replacement.filter((l) => l.trim() !== "");
	if (!nonBlank.length) return replacement;
	// Relative depth is measured against the shallowest line in the block, so
	// nesting survives even when the block's own indentation is irregular.
	const base = Math.min(...nonBlank.map((l) => indentOf(l).length));
	return replacement.map((l) =>
		l.trim() === "" ? "" : baseIndent + indentOf(l).slice(base) + l.trimStart(),
	);
}

/** Syntax check, where one is cheaply available. Returns an error or undefined. */
function syntaxError(file: string): string | undefined {
	const ext = path.extname(file).toLowerCase();
	const run = (cmd: string, args: string[]) => {
		try {
			execFileSync(cmd, args, { stdio: "pipe", timeout: 20000 });
			return undefined;
		} catch (e) {
			const err = e as { stderr?: Buffer; stdout?: Buffer; message?: string };
			const out = (err.stderr?.toString() || err.stdout?.toString() || err.message || "").trim();
			return out.split("\n").slice(0, 4).join("\n");
		}
	};
	switch (ext) {
		case ".js":
		case ".cjs":
		case ".mjs":
			return run("node", ["--check", file]);
		case ".json":
			try {
				JSON.parse(fs.readFileSync(file, "utf8"));
				return undefined;
			} catch (e) {
				return String(e);
			}
		case ".py":
			return run("python3", ["-m", "py_compile", file]);
		case ".php":
			return run("php", ["-l", file]);
		default:
			return undefined; // no checker: not an error
	}
}

/** Write, verify, and roll back if the write broke the file. */
function writeChecked(file: string, lines: string[], before: string): string {
	// Every edit and every revert passes through here, so this is the one place
	// the read cache has to be dropped. Re-reading after an edit is correct:
	// line numbers have moved and the model's memory of them is stale.
	readCache.invalidate(file);
	fs.writeFileSync(file, lines.join("\n"), "utf8");
	const err = syntaxError(file);
	if (err) {
		fs.writeFileSync(file, before, "utf8");
		throw new Error(`Edit reverted — it would have broken the file:\n${err}`);
	}
	return "ok";
}

/**
 * The callers line to append to an edit result, or nothing.
 *
 * Wrapped so a failure here can never fail an edit that already succeeded: the
 * file is written by this point, and losing the write to a grep problem would
 * be a far worse bug than missing a hint.
 */
function callersFor(cwd: string, file: string, lines: string[], line: number): string {
	try {
		const sym = enclosingSymbol(lines, file, line);
		if (!sym) return "";
		const callers = findCallers(cwd, sym.name, file);
		const note = callersNote(callers, sym.name, declarationCount(cwd, sym.name));
		if (note) recordHint(sym.name, callers);
		return note ? `\n\n${note}` : "";
	} catch {
		return "";
	}
}

/**
 * An experiment: no line-based editing, and therefore no line numbers.
 *
 * `replace_lines` is the only tool that needs a gutter. Measured across 47
 * sessions: 727 view_lines calls paid for it, and 40 replace_lines calls used
 * it, against 174 edit_block (matches on content) and 34 edit_symbol (matches
 * on a name). The gutter costs roughly 3.4 tokens a line, so about 95% of reads
 * carry a cost they never spend.
 *
 * phi already learned this once from the other side: replace_lines failed 34%
 * of the time on stale line numbers, which is why lib/symbols.ts exists. The
 * conclusion then was that the model was never asking for "lines 311-329", it
 * was asking for "the end of play()". This tests taking that to its end.
 *
 * Set PI_DROP_REPLACE_LINES=1 to withhold the tool and strip the gutter
 * together, since neither is useful without the other.
 */
const LINE_FREE = process.env.PI_DROP_REPLACE_LINES === "1";

/**
 * Reading several files costs one call, not one call each.
 *
 * Measured across 47 sessions: 727 view_lines calls, and 368 reads that went
 * through bash instead, 224 of them `for f in a b c; do cat "$f"; done`. A third
 * of all reading bypassed this tool, and the reason is that it takes one file.
 * Everything the bypass costs is what this tool exists to provide: the read
 * cache that suppresses a file already shown, the line cap, the budget, the
 * symbol anchor.
 *
 * Two caps, not one. A per-batch cap alone would divide a twelve-file request
 * into twelfths, which is useless, and the model would go back to bash to avoid
 * the round trip. So each file gets a workable slice AND the batch has a
 * ceiling: a normal two-to-six file request is never clipped, and twenty files
 * cannot quietly cost twenty times one.
 */
const BATCH_MAX_FILES = Number(process.env.PI_VIEW_MAX_FILES ?? 12);
const BATCH_MAX_CHARS = Number(process.env.PI_VIEW_BATCH_CHARS ?? 24_000);
const PER_FILE_CHARS = Number(process.env.PI_VIEW_FILE_CHARS ?? 8_000);

/**
 * Nudge a run of single-file reads toward the list form.
 *
 * The bash steer covers one half of the behaviour: 224 shell loops across 47
 * sessions. It misses the other half entirely. One benchmark run made 70
 * single-file view_lines calls and 4 bash calls, so nothing fired, and 70 round
 * trips carried 70 headers into the context for want of one call.
 *
 * Fires on the behaviour rather than in a description, which is the only thing
 * that has worked: outline was available throughout and called 8 times in 47
 * sessions, while the symbol anchor and the callers hint landed because they
 * attach to a result the model already receives.
 *
 * Nudges at most once per RUN_LENGTH reads, and resets when a list is used or a
 * batch arrives, because a message repeated on every call is one the model
 * learns to skip.
 */
const RUN_LENGTH = Number(process.env.PI_VIEW_RUN_NUDGE ?? 3);
let singleRun: string[] = [];

/** Test seam: a run is per session, and nothing else resets it. */
export function resetReadRun(): void {
	singleRun = [];
}

function nudgeForRun(file: string): string {
	if (RUN_LENGTH <= 0) return "";
	singleRun.push(file);
	if (singleRun.length < RUN_LENGTH) return "";
	const names = singleRun.slice(-RUN_LENGTH);
	singleRun = [];
	return (
		`\n[view_lines] That is ${RUN_LENGTH} single-file reads in a row. ` +
		`\`view_lines({ file: [${names.map((f) => `"${f}"`).join(", ")}] })\` would have been one call, ` +
		`capped per file and skipping any already sent.`
	);
}

/**
 * Read a batch of files, honouring the cache, the caps and the anchors.
 *
 * Each file is truncated to PER_FILE_CHARS so one large file cannot eat the
 * batch, and the whole result stops at BATCH_MAX_CHARS. Truncation is always
 * stated: a silently shortened file is how a model concludes a function does
 * not exist. Files already shown and unchanged are named rather than repeated,
 * which is the read cache doing the thing a shell loop cannot.
 */
function readMany(ctx: { cwd: string }, files: string[], refresh: boolean) {
	singleRun = [];
	const wanted = files.slice(0, BATCH_MAX_FILES);
	const dropped = files.length - wanted.length;
	const parts: string[] = [];
	const skipped: string[] = [];
	let used = 0;
	let stoppedAt: string | undefined;

	for (const rel of wanted) {
		if (used >= BATCH_MAX_CHARS) {
			stoppedAt = rel;
			break;
		}
		const abs = resolve(ctx.cwd, rel);
		if (!fs.existsSync(abs)) {
			parts.push(`${rel}: no such file`);
			continue;
		}
		const injected = alreadyInContext(abs);
		if (injected && !refresh) {
			skipped.push(`${rel} (already injected into the system prompt)`);
			continue;
		}
		const lines = readLines(abs);
		const stamp = stampOf(abs);
		const end = Math.min(lines.length, MAX_SPAN);
		if (!refresh && readCache.covered(abs, stamp, 1, end)) {
			skipped.push(`${rel} (already shown above, unchanged)`);
			continue;
		}
		readCache.record(abs, stamp, 1, end);

		let body = lines.slice(0, end).map((l, i) => (LINE_FREE ? l : `${i + 1}|${l}`)).join("\n");
		const room = Math.min(PER_FILE_CHARS, BATCH_MAX_CHARS - used);
		let note = lines.length > end ? `, showing 1-${end}` : "";
		if (body.length > room) {
			body = body.slice(0, room);
			note += `, truncated at ${room} characters`;
		}
		used += body.length;
		parts.push(`===== ${rel} (${lines.length} lines${note}) =====\n${body}`);
	}

	const tail: string[] = [];
	if (skipped.length) tail.push(`[view_lines] not repeated: ${skipped.join("; ")}`);
	if (stoppedAt) tail.push(`[view_lines] stopped at ${stoppedAt}: the batch reached ${BATCH_MAX_CHARS} characters. Ask for the rest separately.`);
	if (dropped > 0) tail.push(`[view_lines] ${dropped} more file(s) not read: at most ${BATCH_MAX_FILES} per call.`);

	return {
		content: [{ type: "text", text: [...parts, ...tail].filter(Boolean).join("\n\n") || "Nothing to show." }],
		details: { files: parts.length, skipped: skipped.length, chars: used },
	};
}

/**
 * Strip a view_lines gutter the model has pasted back into replacement text.
 *
 * view_lines renders "12|code" and the model sometimes copies that straight
 * into new_text. On a syntax-checked file the check catches it and reverts, so
 * the cost is one wasted call. On markdown, text, or anything else without one,
 * "2|some text" is written into the file and reported as a successful replace:
 * silent corruption, and of exactly the thing the gutter exists to help with.
 *
 * Only strips when EVERY line carries a number and those numbers run
 * consecutively, optionally from an expected start. That is what an echoed
 * gutter looks like; a CSV or a markdown table with pipes does not have
 * consecutive line numbers matching the range being replaced, so it survives.
 */
export function stripEchoedGutter(text: string, startLine?: number): { text: string; stripped: boolean } {
	if (!text) return { text, stripped: false };
	const lines = text.split("\n");
	const parsed = lines.map((l) => /^(\d+)\|(.*)$/.exec(l));
	if (parsed.some((m) => m === null)) return { text, stripped: false };
	const nums = parsed.map((m) => Number(m![1]));
	for (let i = 1; i < nums.length; i++) if (nums[i] !== nums[i - 1] + 1) return { text, stripped: false };
	if (startLine !== undefined && nums[0] !== startLine) return { text, stripped: false };
	return { text: parsed.map((m) => m![2]).join("\n"), stripped: true };
}

export default function smartEditExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "edit_block",
		renderResult: collapsedRenderer(),
		label: "Edit block",
		description:
			"Replace a block of lines, matching on line CONTENT and ignoring indentation. " +
			"Prefer this over the built-in edit tool: you do not need to reproduce whitespace " +
			"exactly, and the replacement is re-indented to match the file. " +
			"The file is syntax-checked afterwards and the edit is reverted if it breaks.",
		promptSnippet: "Replace a block of lines without needing exact indentation",
		promptGuidelines: [
			"Use edit_block for code edits instead of the built-in edit tool — it tolerates indentation differences.",
			"Give enough lines in old_text to be unique; 2-4 lines is usually plenty.",
			"Never use sed/awk to splice files; edit_block or replace_lines are safer and report what went wrong.",
		],
		parameters: Type.Object({
			file: Type.String(),
			old_text: Type.String({ description: "Indentation ignored when matching" }),
			new_text: Type.String({ description: "Indentation is adjusted to the file" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const file = resolve(ctx.cwd, params.file);
			if (!fs.existsSync(file)) {
				return { content: [{ type: "text", text: `No such file: ${params.file}` }], isError: true };
			}
			const before = fs.readFileSync(file, "utf8");
			const lines = before.split("\n");
			const needle = params.old_text.split("\n");
			const hits = findBlock(lines, needle);

			if (hits.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No match for that block in ${params.file}.${closest(lines, needle)}`,
						},
					],
					isError: true,
				};
			}
			if (hits.length > 1) {
				return {
					content: [
						{
							type: "text",
							text:
								`That block appears ${hits.length} times (lines ${hits.map((h) => h + 1).join(", ")}). ` +
								`Add surrounding lines to make it unique, or use replace_lines.`,
						},
					],
					isError: true,
				};
			}

			const trimmedNeedle = needle.map(norm);
			while (trimmedNeedle.length && trimmedNeedle[0] === "") {
				trimmedNeedle.shift();
				needle.shift();
			}
			while (trimmedNeedle.length && trimmedNeedle[trimmedNeedle.length - 1] === "") {
				trimmedNeedle.pop();
				needle.pop();
			}

			const start = hits[0];
			const count = trimmedNeedle.length;
			const baseIndent = indentOf(lines[start]);
			const replacement = reindent(stripEchoedGutter(params.new_text).text.split("\n"), baseIndent);

			const updated = [...lines.slice(0, start), ...replacement, ...lines.slice(start + count)];
			try {
				writeChecked(file, updated, before);
			} catch (e) {
				return { content: [{ type: "text", text: String((e as Error).message) }], isError: true };
			}
			return {
				content: [
					{
						type: "text",
						text:
							`Replaced ${count} line(s) at ${params.file}:${start + 1} with ${replacement.length}. ` +
							`Indented to "${baseIndent.length}" spaces to match the file.` +
							callersFor(ctx.cwd, params.file, updated, start + 1),
					},
				],
				details: { line: start + 1, removed: count, added: replacement.length },
			};
		},
	});

	if (!LINE_FREE) pi.registerTool({
		name: "replace_lines",
		renderResult: collapsedRenderer(),
		label: "Replace lines",
		description:
			"Replace an inclusive range of line numbers with new text. Deterministic — no matching involved. " +
			"Use after view_lines. Pass `expect` with a distinctive substring from the range as a safety check.",
		promptSnippet: "Replace an exact line range (use after view_lines)",
		promptGuidelines: [
			"Prefer edit_symbol inside a named function or class. Use replace_lines only for code that is not in one, and call view_lines first: line numbers shift after every edit.",
		],
		parameters: Type.Object({
			file: Type.String(),
			start_line: Type.Number({ description: "1-based, inclusive" }),
			end_line: Type.Number({ description: "1-based, inclusive" }),
			new_text: Type.String({ description: "Replacement text. Use an empty string to delete the range." }),
			expect: Type.Optional(
				Type.String({ description: "Substring that must appear in the range being replaced" }),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const file = resolve(ctx.cwd, params.file);
			if (!fs.existsSync(file)) {
				return { content: [{ type: "text", text: `No such file: ${params.file}` }], isError: true };
			}
			const before = fs.readFileSync(file, "utf8");
			const lines = before.split("\n");
			const s = Math.max(1, Math.floor(params.start_line));
			const e = Math.min(lines.length, Math.floor(params.end_line));
			if (s > e) {
				return { content: [{ type: "text", text: `start_line ${s} is after end_line ${e}.` }], isError: true };
			}
			const target = lines.slice(s - 1, e).join("\n");
			if (params.expect && !target.includes(params.expect)) {
				// Show the range NUMBERED, and say where the text actually is when
				// it exists nearby. A bare dump of the range sends the model back to
				// view_lines to copy an exact string, and that round trip is where a
				// failed edit turns into a loop. Everything needed to correct the
				// call is in this message.
				// Same gutter as view_lines, deliberately. This is the message the
				// model copies an `expect` string out of, and two formats for the
				// same thing is how a copied line arrives with a stray space or a
				// padded number attached. Measured on the model's own tokenizer,
				// the padded form also costs 39% over bare source against the
				// compact form's 23%, so matching is cheaper as well as safer.
				const numbered = lines
					.slice(s - 1, e)
					.map((l, i) => `${s + i}|${l}`)
					.join("\n");
				const firstLine = params.expect.split("\n")[0].trim();
				const foundAt = firstLine
					? lines.findIndex((l, i) => i >= Math.max(0, s - 200) && l.includes(firstLine)) + 1
					: 0;
				const hint =
					foundAt > 0 && (foundAt < s || foundAt > e)
						? `\n\nThat text is at line ${foundAt}, outside ${s}-${e}. \`expect\` must appear INSIDE the range you are replacing — widen the range, or quote something from within it.`
						: `\n\nQuote \`expect\` verbatim from the numbered lines above, including indentation.`;
				return {
					content: [
						{
							type: "text",
							text: `Safety check failed: lines ${s}-${e} do not contain that text.\n\n${numbered}${hint}`,
						},
					],
					isError: true,
				};
			}
			const pasted = stripEchoedGutter(params.new_text, Math.floor(params.start_line));
			const replacement = pasted.text === "" ? [] : pasted.text.split("\n");
			const updated = [...lines.slice(0, s - 1), ...replacement, ...lines.slice(e)];
			try {
				writeChecked(file, updated, before);
			} catch (err) {
				return { content: [{ type: "text", text: String((err as Error).message) }], isError: true };
			}
			return {
				content: [
					{
						type: "text",
						text:
							`Replaced lines ${s}-${e} of ${params.file} with ${replacement.length} line(s).` +
							// Said out loud rather than done quietly: the strip is a heuristic,
							// and a pipe-delimited file whose first column happens to be
							// consecutive row numbers looks identical to an echoed gutter.
							// Naming it is what makes that case recoverable.
							(pasted.stripped ? ` Stripped the line-number gutter from new_text; pass the code alone next time.` : "") +
							callersFor(ctx.cwd, params.file, updated, s),
					},
				],
				details: { start: s, end: e, added: replacement.length },
			};
		},
	});

	pi.registerTool({
		name: "view_lines",
		renderResult: collapsedRenderer(),
		label: "View lines",
		description:
			`Show a numbered range of a file (max ${MAX_SPAN} lines per call). Use before replace_lines, and to check an edit landed. ` +
			"Give start_line plus either end_line or limit. `offset` is accepted as start_line. " +
			`\`file\` also takes a list, which reads up to ${BATCH_MAX_FILES} files in one call: prefer that over several calls or a shell loop.`,
		promptSnippet: "Show a numbered line range",
		parameters: Type.Object({
			// A list reads them all in one call. Ranges apply to a single file
			// only: a start_line that meant different things in each of six files
			// would be a worse tool than the bash loop it replaces.
			file: Type.Union([Type.String(), Type.Array(Type.String())]),
			start_line: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			end_line: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			// Accepted because the model reaches for the built-in read tool's
			// names constantly. Silently dropping them is what returned lines
			// 1-710 instead of 630-710 and cost ~10K tokens in one result.
			offset: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			limit: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			refresh: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (Array.isArray(params.file)) {
				return readMany(ctx, params.file as string[], Boolean(params.refresh));
			}
			const file = resolve(ctx.cwd, params.file);
			if (!fs.existsSync(file)) {
				return { content: [{ type: "text", text: `No such file: ${params.file}` }], isError: true };
			}
			// PLAN.md and NOTES.md are injected into the system prompt on every
			// turn. Reading them buys nothing and pays for them twice.
			const injected = alreadyInContext(file);
			if (injected && !params.refresh) {
				return {
					content: [{
						type: "text",
						text:
							`${injected} is already in your context — plan-notes injects it into the system prompt every turn. ` +
							`Look at the "Current work" / "Findings" section you were given rather than reading it again. ` +
							`Pass refresh:true only if you have just written to it.`,
					}],
					details: { injected: true },
				};
			}

			const lines = readLines(file);
			const { start: s, end: e, notes } = resolveRange(params, lines.length);

			// Already in context, and the file has not changed since: say so
			// instead of sending it again. Only a FULLY covered range is
			// suppressed; a partial overlap is delivered whole, because a
			// result with a hole in it is worse than a redundant one.
			const stamp = stampOf(file);
			if (!params.refresh && readCache.covered(file, stamp, s, e)) {
				return {
					content: [{
						type: "text",
						text:
							`${params.file} lines ${s}-${e} are already shown above and the file has not ` +
							`changed since. Scroll up rather than re-reading. ` +
							`Pass refresh:true if you genuinely need them repeated.`,
					}],
					details: { total: lines.length, from: s, to: e, cached: true },
				};
			}
			readCache.record(file, stamp, s, e);

			// No right-alignment padding, and no space after the bar. Measured
			// against the model's own tokenizer on 160 lines of source: the
			// padding costs about one token per line and buys nothing, since
			// nothing here is read as a column. The bar earns its own token by
			// keeping the number unambiguous against a line of code that itself
			// starts with a digit. The digits are the remaining ~2.4 tokens a
			// line and are the whole point of a gutter.
			const body = lines
				.slice(s - 1, e)
				.map((l, i) => (LINE_FREE ? l : `${s + i}|${l}`))
				.join("\n");
			// The note matters as much as the text: it is how the model learns
			// it got a different range than it asked for, instead of concluding
			// the file simply ends where the output does.
			// Where the reader is, which a windowed read otherwise never says. The
			// nearest declaration at or above the range, the same thing a person
			// gets by scrolling up, so it is an anchor rather than a claim of
			// containment.
			const anchor = (() => {
				try {
					const sym = enclosingSymbol(lines, params.file, s);
					return sym ? `  [in ${sym.name}, declared line ${sym.line}]` : "";
				} catch {
					return "";
				}
			})();
			const head =
				`${params.file} (${lines.length} lines) showing ${s}-${e}${anchor}` +
				(notes.length ? `\n[view_lines] ${notes.join("; ")}` : "") +
				nudgeForRun(String(params.file));
			return {
				content: [{ type: "text", text: `${head}\n${body}` }],
				details: { total: lines.length, from: s, to: e },
			};
		},
	});

	// Orientation without reading the file. In the session that died, most
	// view_lines calls were "where is X" answered by reading hundreds of lines;
	// this answers it in one line per declaration.
	pi.registerTool({
		name: "outline",
		renderResult: collapsedRenderer(),
		label: "Outline",
		description:
			"List a file's functions, classes and headings with their line numbers. Use this FIRST to find where something is, then view_lines that range. Far cheaper than reading the file.",
		promptSnippet: "List declarations with line numbers",
		promptGuidelines: [
			"To find something in a file you have not read, call outline before view_lines.",
		],
		parameters: Type.Object({ file: Type.String() }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const file = resolve(ctx.cwd, params.file);
			if (!fs.existsSync(file)) {
				return { content: [{ type: "text", text: `No such file: ${params.file}` }], isError: true };
			}
			const lines = readLines(file);
			const entries = outline(lines, file);
			if (!entries.length) {
				return {
					content: [{
						type: "text",
						text: `${params.file} (${lines.length} lines): no outline available for this file type. Use view_lines with a range.`,
					}],
					details: { total: lines.length, entries: 0 },
				};
			}
			// Same gutter as view_lines and replace_lines. An outline is read
			// alongside both, and one format across all three is what stops a
			// line number being copied with a stray space attached.
			const body = entries.map((x) => `${x.line}|${x.text}`).join("\n");
			return {
				content: [{
					type: "text",
					text: `${params.file} (${lines.length} lines, ${entries.length} declarations)\n${body}`,
				}],
				details: { total: lines.length, entries: entries.length },
			};
		},
	});

	// Edit by NAME instead of by line number.
	//
	// Across 30 sessions replace_lines failed 39 times in 114 calls, and both
	// failure modes are line-number problems: 22 "edit broke the file", where a
	// range cut across a brace boundary, and 16 "expect did not match", where
	// the numbers had gone stale. The model was never really asking for lines
	// 311-329; it was asking for "the end of play()". Resolving the span from
	// the syntax removes both at once.
	pi.registerTool({
		name: "edit_symbol",
		renderResult: collapsedRenderer(),
		label: "Edit symbol",
		description:
			"Edit a named function, method or class WITHOUT line numbers. " +
			"actions: replace (the whole thing), append / prepend (inside its body), before / after (outside it). " +
			"Use `Class.method` when a name appears more than once. Prefer this over replace_lines for anything inside a named block.",
		promptSnippet: "Edit a function/method/class by name",
		promptGuidelines: [
			"To change code inside a named function, method or class, use edit_symbol, not replace_lines: line numbers go stale and ranges cut across braces.",
		],
		parameters: Type.Object({
			file: Type.String(),
			symbol: Type.String({ description: "Name, or Class.method to disambiguate" }),
			action: Type.String({ description: "replace | append | prepend | before | after" }),
			text: Type.String({ description: "Indentation is adjusted to the file" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const file = resolve(ctx.cwd, params.file);
			if (!fs.existsSync(file)) {
				return { content: [{ type: "text", text: `No such file: ${params.file}` }], isError: true };
			}
			if (!supportsSymbols(file)) {
				return {
					content: [{
						type: "text",
						text:
							`edit_symbol does not handle ${path.extname(file) || "this file type"} — its blocks are not brace-delimited. ` +
							`Use view_lines then replace_lines.`,
					}],
					isError: true,
				};
			}
			const action = String(params.action || "").toLowerCase();
			if (!["replace", "append", "prepend", "before", "after"].includes(action)) {
				return {
					content: [{ type: "text", text: `Unknown action "${params.action}". Use replace, append, prepend, before or after.` }],
					isError: true,
				};
			}

			const lines = readLines(file);
			const found = findSymbol(lines, params.symbol);
			if (!found) {
				// Naming what IS there beats "not found": the next call can be right
				// without a round trip through outline.
				const names = outline(lines, file).slice(0, 40).map((o) => `${o.line}| ${o.text.trim()}`);
				return {
					content: [{
						type: "text",
						text:
							`No symbol "${params.symbol}" in ${params.file}.` +
							(names.length ? `\n\nDeclarations in this file:\n${names.join("\n")}` : ""),
					}],
					isError: true,
				};
			}
			if ("ambiguous" in found) {
				return {
					content: [{
						type: "text",
						text:
							`"${params.symbol}" appears ${found.ambiguous.length} times, at lines ${found.ambiguous.join(", ")}. ` +
							`Qualify it as Class.method, or use replace_lines for a specific range.`,
					}],
					isError: true,
				};
			}

			const body = params.text.split("\n");
			let updated: string[];
			let where: string;
			switch (action) {
				case "replace":
					updated = [...lines.slice(0, found.start - 1), ...reindent(body, found.indent), ...lines.slice(found.end)];
					where = `replaced lines ${found.start}-${found.end}`;
					break;
				case "append":
					// Before the closing brace, so it lands at the end of the body.
					updated = [...lines.slice(0, found.end - 1), ...reindent(body, found.bodyIndent), ...lines.slice(found.end - 1)];
					where = `appended inside, before line ${found.end}`;
					break;
				case "prepend":
					updated = [...lines.slice(0, found.bodyStart), ...reindent(body, found.bodyIndent), ...lines.slice(found.bodyStart)];
					where = `prepended inside, after line ${found.bodyStart}`;
					break;
				case "before":
					updated = [...lines.slice(0, found.start - 1), ...reindent(body, found.indent), ...lines.slice(found.start - 1)];
					where = `inserted before line ${found.start}`;
					break;
				default:
					updated = [...lines.slice(0, found.end), ...reindent(body, found.indent), ...lines.slice(found.end)];
					where = `inserted after line ${found.end}`;
			}

			try {
				writeChecked(file, updated, lines.join("\n"));
			} catch (err) {
				return { content: [{ type: "text", text: String((err as Error).message) }], isError: true };
			}
			return {
				content: [{
					type: "text",
					text:
						`${params.symbol} (${found.start}-${found.end}): ${where}, ${body.length} line(s).` +
						callersFor(ctx.cwd, params.file, updated, found.start),
				}],
				details: { start: found.start, end: found.end, action },
			};
		},
	});

	// A quick way to see whether a file the agent has been editing still parses.
	pi.registerCommand("syntax", {
		description: "Syntax-check a file (js/ts/json/py/php)",
		handler: async (args, ctx) => {
			const target = (args ?? "").trim();
			if (!target) {
				ctx.ui.notify("usage: /syntax <file>", "info");
				return;
			}
			const file = resolve(ctx.cwd, target);
			if (!fs.existsSync(file)) {
				ctx.ui.notify(`No such file: ${target}`, "error");
				return;
			}
			const err = syntaxError(file);
			ctx.ui.notify(err ? `${target}:\n${err}` : `${target}: OK`, err ? "error" : "info");
		},
	});

	// Retire the built-in edit tool in favour of edit_block. Done at runtime so
	// it needs no CLI flag; set PI_KEEP_BUILTIN_EDIT=1 to keep both.
	let retired = false;
	const retireBuiltins = (notify?: (m: string, l: "info") => void) => {
		if (retired) return;
		const drop = new Set<string>();
		if (!KEEP_BUILTIN_EDIT) drop.add("edit");
		if (!KEEP_BUILTIN_READ) drop.add("read");
		if (!drop.size) return;
		let all;
		try {
			all = pi.getAllTools();
		} catch {
			return;
		}
		const present = [...drop].filter((n) => all?.some((t) => t.name === n));
		if (!present.length) return;
		pi.setActiveTools(all.map((t) => t.name).filter((n) => !drop.has(n)));
		retired = true;
		// Deliberately silent. Which tools are retired is a property of the
		// install, not news, and announcing it on every launch is the same noise
		// as pi's resource listing: true, unchanging, and read once ever. The
		// README says what is retired, and the model is told through the tool
		// list it is given.
		void notify;
	};

	pi.on("session_start", async (_event, ctx) => retireBuiltins(ctx.ui.notify));
	// session_start does not fire in --print mode; this covers those runs.
	pi.on("before_agent_start", async () => retireBuiltins());
}
