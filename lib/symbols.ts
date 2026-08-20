/**
 * Find a named function, method or class and its exact span.
 *
 * Why this exists, from 30 sessions of real edits:
 *
 *   replace_lines   114 calls, 39 failed (34%)
 *     22  "edit broke the file (auto-reverted)"
 *     16  "expect did not match the range"
 *
 * Both are line-number failures. A line range has no idea where a block starts
 * or ends, so a range that looks right can cut across a brace boundary; and the
 * numbers themselves go stale after every edit, which is what the `expect`
 * guard keeps catching. The model was never really asking for "lines 311-329",
 * it was asking for "the end of play()".
 *
 * Resolving the span from the syntax instead of from remembered numbers removes
 * both failure modes at once: you cannot half-close a block you did not have to
 * count, and a symbol name does not go stale when lines shift.
 */

/** Languages whose blocks are delimited by braces. Python is deliberately
 *  absent: its blocks are indentation-scoped and need a different algorithm,
 *  and a half-working implementation is worse than an honest refusal. */
const BRACE_LANGS = /\.(js|mjs|cjs|jsx|ts|tsx|php|go|rs|java|c|h|cpp|cs|swift|kt|scala)$/i;

export function supportsSymbols(filename: string): boolean {
	return BRACE_LANGS.test(filename);
}

/**
 * Strip strings and comments from a line so brace counting sees only code.
 *
 * A naive counter is wrong the moment a file contains `"{"` or a commented-out
 * block, and it fails silently — you get a span that is off by one nesting
 * level and an edit that corrupts the file. `state.inBlockComment` carries
 * across lines because `/* ... *​/` and template literals both span them.
 */
export interface ScanState {
	inBlockComment: boolean;
	inTemplate: boolean;
}

export function stripNonCode(line: string, state: ScanState): string {
	let out = "";
	let i = 0;
	while (i < line.length) {
		const two = line.slice(i, i + 2);
		if (state.inBlockComment) {
			if (two === "*/") { state.inBlockComment = false; i += 2; } else i++;
			continue;
		}
		if (state.inTemplate) {
			if (line[i] === "\\") { i += 2; continue; }
			if (line[i] === "`") { state.inTemplate = false; i++; continue; }
			i++;
			continue;
		}
		if (two === "//") break;              // rest of the line is a comment
		if (two === "/*") { state.inBlockComment = true; i += 2; continue; }
		if (line[i] === "`") { state.inTemplate = true; i++; continue; }
		if (line[i] === '"' || line[i] === "'") {
			const quote = line[i];
			i++;
			while (i < line.length && line[i] !== quote) i += line[i] === "\\" ? 2 : 1;
			i++;
			continue;
		}
		out += line[i];
		i++;
	}
	return out;
}

export interface SymbolSpan {
	name: string;
	/** 1-based line of the declaration. */
	start: number;
	/** 1-based line holding the block's closing brace. */
	end: number;
	/** 1-based line holding the opening brace. */
	bodyStart: number;
	/** Indentation of the declaration line. */
	indent: string;
	/** Indentation used by the body, for inserted code. */
	bodyIndent: string;
}

/** Declaration forms worth targeting, with the name captured. */
function declRegexes(name: string): RegExp[] {
	const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return [
		new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s+${n}\\s*\\(`),
		new RegExp(`^\\s*(?:export\\s+)?(?:abstract\\s+)?class\\s+${n}\\b`),
		// class method / object member: `name(args) {`, excluding control keywords
		new RegExp(`^\\s*(?:static\\s+|async\\s+|get\\s+|set\\s+|public\\s+|private\\s+|protected\\s+)*${n}\\s*\\([^)]*\\)\\s*\\{`),
		// const name = function / arrow
		new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${n}\\s*=\\s*(?:async\\s*)?(?:function|\\(|[\\w$]+\\s*=>)`),
		// go / rust / php
		new RegExp(`^\\s*(?:pub\\s+)?(?:func|fn)\\s+${n}\\b`),
	];
}

const CONTROL = /^\s*(if|for|while|switch|catch|return|else|do|try)\b/;

/**
 * Locate `name`. Accepts "method" or "Class.method"; the qualified form scopes
 * the search to that class, which is how you disambiguate a name that several
 * classes share without falling back to line numbers.
 */
export function findSymbol(lines: string[], name: string): SymbolSpan | { ambiguous: number[] } | undefined {
	if (name.includes(".")) {
		const [outer, inner] = name.split(".", 2);
		const parent = findSymbol(lines, outer);
		if (!parent || "ambiguous" in parent) return parent;
		const scoped = lines.slice(parent.start - 1, parent.end);
		const hit = findSymbol(scoped, inner);
		if (!hit || "ambiguous" in hit) return hit;
		const shift = parent.start - 1;
		return { ...hit, start: hit.start + shift, end: hit.end + shift, bodyStart: hit.bodyStart + shift };
	}

	const res = declRegexes(name);
	const matches: number[] = [];
	const state: ScanState = { inBlockComment: false, inTemplate: false };
	for (let i = 0; i < lines.length; i++) {
		const code = stripNonCode(lines[i], state);
		if (!code.trim() || CONTROL.test(code)) continue;
		if (res.some((r) => r.test(code))) matches.push(i);
	}
	if (!matches.length) return undefined;
	if (matches.length > 1) return { ambiguous: matches.map((i) => i + 1) };

	const declIdx = matches[0];
	// Walk forward to the opening brace, then brace-match to its partner.
	const scan: ScanState = { inBlockComment: false, inTemplate: false };
	for (let i = 0; i < declIdx; i++) stripNonCode(lines[i], scan);

	let depth = 0;
	let bodyStart = -1;
	for (let i = declIdx; i < lines.length; i++) {
		const code = stripNonCode(lines[i], scan);
		for (const ch of code) {
			if (ch === "{") {
				if (bodyStart === -1) bodyStart = i;
				depth++;
			} else if (ch === "}") {
				depth--;
				if (bodyStart !== -1 && depth === 0) {
					const indent = /^[ \t]*/.exec(lines[declIdx])?.[0] ?? "";
					// Prefer the body's own indentation so inserted code matches its
					// neighbours rather than a guess derived from the declaration.
					let bodyIndent = `${indent}  `;
					for (let j = bodyStart + 1; j < i; j++) {
						if (lines[j].trim()) { bodyIndent = /^[ \t]*/.exec(lines[j])?.[0] ?? bodyIndent; break; }
					}
					return { name, start: declIdx + 1, end: i + 1, bodyStart: bodyStart + 1, indent, bodyIndent };
				}
			}
		}
	}
	return undefined;   // unterminated block
}
