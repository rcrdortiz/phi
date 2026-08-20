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
import { Type } from "typebox";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { MAX_SPAN, ReadCache, outline, resolveRange } from "../lib/read-lean.ts";
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

export default function smartEditExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "edit_block",
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
			file: Type.String({ description: "Path to the file" }),
			old_text: Type.String({ description: "Lines to replace. Indentation is ignored when matching." }),
			new_text: Type.String({ description: "Replacement lines. Indentation is adjusted to the file." }),
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
			const replacement = reindent(params.new_text.split("\n"), baseIndent);

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
							`Indented to "${baseIndent.length}" spaces to match the file.`,
					},
				],
				details: { line: start + 1, removed: count, added: replacement.length },
			};
		},
	});

	pi.registerTool({
		name: "replace_lines",
		label: "Replace lines",
		description:
			"Replace an inclusive range of line numbers with new text. Deterministic — no matching involved. " +
			"Use after view_lines. Pass `expect` with a distinctive substring from the range as a safety check.",
		promptSnippet: "Replace an exact line range (use after view_lines)",
		promptGuidelines: [
			"Use replace_lines when edit_block cannot find a unique match — never fall back to sed or awk.",
			"Always call view_lines first so the numbers are current: they shift after every edit.",
		],
		parameters: Type.Object({
			file: Type.String(),
			start_line: Type.Number({ description: "First line to replace (1-based, inclusive)" }),
			end_line: Type.Number({ description: "Last line to replace (1-based, inclusive)" }),
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
				const width = String(e).length;
				const numbered = lines
					.slice(s - 1, e)
					.map((l, i) => `${String(s + i).padStart(width)}| ${l}`)
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
			const replacement = params.new_text === "" ? [] : params.new_text.split("\n");
			const updated = [...lines.slice(0, s - 1), ...replacement, ...lines.slice(e)];
			try {
				writeChecked(file, updated, before);
			} catch (err) {
				return { content: [{ type: "text", text: String((err as Error).message) }], isError: true };
			}
			return {
				content: [
					{ type: "text", text: `Replaced lines ${s}-${e} of ${params.file} with ${replacement.length} line(s).` },
				],
				details: { start: s, end: e, added: replacement.length },
			};
		},
	});

	pi.registerTool({
		name: "view_lines",
		label: "View lines",
		description:
			`Show a numbered range of a file (max ${MAX_SPAN} lines per call). Use before replace_lines, and to check an edit landed. ` +
			"Give start_line plus either end_line or limit. `offset` is accepted as start_line.",
		promptSnippet: "Show a numbered line range",
		parameters: Type.Object({
			file: Type.String(),
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
			const file = resolve(ctx.cwd, params.file);
			if (!fs.existsSync(file)) {
				return { content: [{ type: "text", text: `No such file: ${params.file}` }], isError: true };
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

			const width = String(e).length;
			const body = lines
				.slice(s - 1, e)
				.map((l, i) => `${String(s + i).padStart(width)}| ${l}`)
				.join("\n");
			// The note matters as much as the text: it is how the model learns
			// it got a different range than it asked for, instead of concluding
			// the file simply ends where the output does.
			const head =
				`${params.file} (${lines.length} lines) showing ${s}-${e}` +
				(notes.length ? `\n[view_lines] ${notes.join("; ")}` : "");
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
		label: "Outline",
		description:
			"List a file's functions, classes and headings with their line numbers. Use this FIRST to find where something is, then view_lines that range. Far cheaper than reading the file.",
		promptSnippet: "List declarations with line numbers",
		rules: [
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
			const width = String(lines.length).length;
			const body = entries.map((x) => `${String(x.line).padStart(width)}| ${x.text}`).join("\n");
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
		label: "Edit symbol",
		description:
			"Edit a named function, method or class WITHOUT line numbers. " +
			"actions: replace (the whole thing), append / prepend (inside its body), before / after (outside it). " +
			"Use `Class.method` when a name appears more than once. Prefer this over replace_lines for anything inside a named block.",
		promptSnippet: "Edit a function/method/class by name",
		rules: [
			"To change code inside a named function, method or class, use edit_symbol — not replace_lines. Line numbers go stale and ranges cut across braces.",
			"Use outline first if you do not know the symbol's name.",
		],
		parameters: Type.Object({
			file: Type.String(),
			symbol: Type.String({ description: "Name, or Class.method to disambiguate" }),
			action: Type.String({ description: "replace | append | prepend | before | after" }),
			text: Type.String({ description: "Code to write. Indentation is adjusted to the file." }),
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
					text: `${params.symbol} (${found.start}-${found.end}): ${where}, ${body.length} line(s).`,
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
		const replacement: Record<string, string> = { edit: "edit_block", read: "view_lines/outline" };
		notify?.(
			present.map((n) => `Using ${replacement[n]} instead of the built-in ${n} tool.`).join(" "),
			"info",
		);
	};

	pi.on("session_start", async (_event, ctx) => retireBuiltins(ctx.ui.notify));
	// session_start does not fire in --print mode; this covers those runs.
	pi.on("before_agent_start", async () => retireBuiltins());
}
