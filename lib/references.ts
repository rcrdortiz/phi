/**
 * Who calls this, and what am I looking at.
 *
 * Two small things aimed at one measured failure. In the first quill run phi
 * regressed 15 checks against pi's 4, and the mechanism was visible in the tool
 * log: phi made 70 windowed `view_lines` calls where pi read whole subsystems
 * with `cat`. Reading a slice tells you what a function does. It does not tell
 * you who depends on it, so a change that is locally correct breaks a caller
 * the model never saw.
 *
 * Both halves are hints, not guarantees. There is no language server here, and
 * the projects are PHP and TypeScript where a call can be built from a string.
 * For catching regressions, over-reporting is the safe direction: a caller
 * listed that turns out to be unrelated costs a glance, a caller missed costs
 * the regression this exists to prevent.
 */
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { outline } from "./read-lean.ts";
import { DEBUG } from "./debug.ts";
import { statePath } from "./state-dir.ts";
import * as fs from "node:fs";

/** Extensions worth searching. Kept narrow: a hit in a lockfile is noise. */
const SOURCE_GLOBS = ["*.ts", "*.tsx", "*.js", "*.mjs", "*.php", "*.html"];

/** Directories that are never interesting and are usually enormous. */
const SKIP_DIRS = ["node_modules", ".git", "vendor", "dist", "build", ".phi", ".pi"];

/** Beyond this a list stops being a hint and becomes another wall of text. */
export const MAX_CALLERS = Number(process.env.PI_MAX_CALLERS ?? 12);

/**
 * Names so common that listing their references says nothing.
 *
 * Measured on quill: 92 distinct method names, 22 of them declared in more than
 * one class. Most of that overlap is worth showing, because it is interface
 * implementations: `findBySlug` exists three times, and if you change one the
 * other two are exactly what you need to look at. The exception is the magic
 * methods. `__construct` is declared 32 times, and a list of 32 unrelated
 * constructors is noise that trains the reader to skip the whole hint.
 */
const UBIQUITOUS = new Set([
	"__construct", "__destruct", "__toString", "__get", "__set", "__isset",
	"__unset", "__call", "__callStatic", "__invoke", "__clone", "constructor",
	"toString", "valueOf",
]);

/**
 * Declarations past which a name is treated as ubiquitous rather than specific.
 *
 * Ten, and deliberately generous. Four was tried first and it suppressed
 * `render`, which is declared five times in quill: once on RendererInterface
 * and once per implementation. That is the single most important hint in the
 * whole repository, because phase 3 asks for a new renderer and the existing
 * implementations are what it has to stay consistent with. Suppressing it to
 * avoid noise would have hidden the answer to the hardest task in the set.
 *
 * The real noise is magic methods, and UBIQUITOUS names them directly. This
 * stays only as a backstop for a pattern nobody anticipated.
 */
export const MAX_DECLARATIONS = Number(process.env.PI_MAX_DECLARATIONS ?? 10);

/** How many places declare this name, used to spot a name that means nothing. */
export function declarationCount(cwd: string, name: string): number {
	try {
		const out = execFileSync(
			"grep",
			["-rE", "--include", "*.php", "--include", "*.ts", "--include", "*.js",
				"--exclude-dir", "node_modules", "--exclude-dir", "vendor", "--exclude-dir", ".git",
				`(function|class|interface|trait)\\s+${name}\\b`, "."],
			{ cwd, encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 },
		);
		return out.split("\n").filter(Boolean).length;
	} catch {
		return 0;
	}
}

/**
 * The identifier a declaration line declares.
 *
 * Deliberately loose, because it runs over four languages. The ordered
 * alternatives matter: `public function foo(` must yield `foo`, not `function`,
 * so the keyword forms are tried before the bare `name(` form.
 */
export function symbolName(decl: string): string | undefined {
	// A loop initialiser looks exactly like a declaration: `for (let i = 0; ...)`
	// yields `i` on the const/let/var pattern. outline() already drops control
	// structures before this is reached, but a helper that is wrong on its own
	// is a trap for the next caller.
	if (/^\s*(?:if|for|while|switch|catch|return|else|do|try|with)\b/.test(decl)) return undefined;
	const patterns = [
		/\b(?:function|class|interface|trait|enum|type)\s+(\w+)/,
		/\b(?:const|let|var)\s+(\w+)\s*=/,
		/\b(\w+)\s*\([^)]*\)\s*(?::[^{]+)?\{/,
		/\b(\w+)\s*[:=]\s*(?:async\s*)?\(/,
	];
	for (const re of patterns) {
		const m = re.exec(decl);
		if (m?.[1] && !RESERVED.has(m[1])) return m[1];
	}
	return undefined;
}

/** Words that are never the thing being declared. */
const RESERVED = new Set([
	"function", "class", "const", "let", "var", "return", "if", "for", "while",
	"switch", "catch", "else", "do", "try", "public", "private", "protected",
	"static", "async", "await", "new", "export", "default", "interface", "type",
]);

/**
 * The declaration a line sits inside, as a hint for `view_lines`.
 *
 * Nearest declaration at or above the line, which is what a reader does when
 * they scroll up to see where they are. It can be wrong where one declaration
 * has closed and the next has not opened, so it is reported as an anchor rather
 * than asserted as containment.
 */
export function enclosingSymbol(
	lines: string[],
	filename: string,
	line: number,
): { name: string; line: number; text: string } | undefined {
	const entries = outline(lines, filename);
	if (!entries.length) return undefined;
	let best: { line: number; text: string } | undefined;
	for (const e of entries) {
		if (e.line > line) break;
		best = e;
	}
	if (!best) return undefined;
	const name = symbolName(best.text);
	return name ? { name, line: best.line, text: best.text.trim() } : undefined;
}

export interface Caller {
	file: string;
	line: number;
	text: string;
}

/**
 * Where else a name appears, excluding the file it was edited in.
 *
 * grep rather than a parser: it is available everywhere, it is fast enough on a
 * repository this size, and a parser per language is a much larger promise than
 * this feature makes. The word boundary is what keeps `render` from matching
 * `prerender`; nothing keeps it from matching the same word in a comment, which
 * is the over-reporting this accepts on purpose.
 */
export function findCallers(cwd: string, name: string, exclude?: string): Caller[] {
	if (!/^\w{3,}$/.test(name)) return [];
	const args = ["-rnw", "--binary-files=without-match"];
	for (const d of SKIP_DIRS) args.push("--exclude-dir", d);
	for (const g of SOURCE_GLOBS) args.push("--include", g);
	args.push(name, ".");
	let stdout = "";
	try {
		stdout = execFileSync("grep", args, {
			cwd,
			encoding: "utf8",
			timeout: 5000,
			maxBuffer: 4 * 1024 * 1024,
		});
	} catch {
		// grep exits 1 when nothing matched, which is a real answer, not a fault.
		return [];
	}
	const excluded = exclude ? path.resolve(cwd, exclude) : undefined;
	const out: Caller[] = [];
	for (const row of stdout.split("\n")) {
		const m = /^(.+?):(\d+):(.*)$/.exec(row);
		if (!m) continue;
		const file = m[1].replace(/^\.\//, "");
		if (excluded && path.resolve(cwd, file) === excluded) continue;
		const text = m[3].trim();
		// A declaration is not a call, and neither is a comment about one.
		if (/^\s*(?:\/\/|\*|#)/.test(text)) continue;
		out.push({ file, line: Number(m[2]), text: text.slice(0, 120) });
	}
	return rank(out, name, exclude);
}

/**
 * Most likely to matter first, because only the first few survive the cap.
 *
 * A call reads `name(`; a mention that does not is a property, an import or a
 * string, and is weaker evidence. Proximity comes next: the same directory is
 * the same subsystem in every layout this runs against, and a sibling file is a
 * likelier caller than something across the tree.
 */
function rank(callers: Caller[], name: string, exclude?: string): Caller[] {
	const dir = exclude ? path.dirname(exclude) : undefined;
	const callRe = new RegExp(`\\b${name}\\s*\\(`);
	const score = (c: Caller) =>
		(callRe.test(c.text) ? 4 : 0) +
		(dir && path.dirname(c.file) === dir ? 2 : 0) +
		(dir && c.file.split("/")[0] === dir.split("/")[0] ? 1 : 0);
	return [...callers].sort((a, b) => score(b) - score(a) || a.file.localeCompare(b.file) || a.line - b.line);
}

/**
 * The line appended to an edit result.
 *
 * Phrased as work still to do rather than as information, because the failure
 * being prevented is the model treating a locally correct edit as a finished
 * one. Returns undefined when there is nothing to say, so a quiet edit stays
 * quiet.
 */
export function callersNote(callers: Caller[], name: string, declarations = 0): string | undefined {
	if (!callers.length) return undefined;
	// A name that means something everywhere means nothing here.
	if (UBIQUITOUS.has(name)) return undefined;
	if (declarations >= MAX_DECLARATIONS) return undefined;
	const shown = callers.slice(0, MAX_CALLERS);
	const more = callers.length - shown.length;
	const lines = shown.map((c) => `  ${c.file}:${c.line}  ${c.text}`);
	return (
		`[callers] \`${name}\` is referenced in ${callers.length} other place(s). ` +
		`Check these still hold after this edit:\n${lines.join("\n")}` +
		(more > 0 ? `\n  ...and ${more} more` : "")
	);
}


/**
 * A record that the hint was shown, so we can find out whether it is read.
 *
 * `outline` has been used 8 times in 47 sessions, which is the failure mode
 * this feature has to avoid: a good idea nobody calls. A hint that is pushed
 * rather than requested cannot be ignored by not being called, but it can be
 * ignored by being skipped, and the only way to tell the difference is to
 * record what was offered and compare it against what the model did next.
 *
 * Debug builds only. This is instrumentation for deciding whether the feature
 * earns its place, not something a normal session should be writing.
 */
export function recordHint(symbol: string, callers: Caller[]): void {
	if (!DEBUG) return;
	try {
		const rec = {
			at: new Date().toISOString(),
			symbol,
			count: callers.length,
			files: [...new Set(callers.map((c) => c.file))].slice(0, MAX_CALLERS),
		};
		fs.appendFileSync(statePath("callers-hints.jsonl"), `${JSON.stringify(rec)}\n`);
	} catch {
		/* instrumentation must never break an edit */
	}
}
