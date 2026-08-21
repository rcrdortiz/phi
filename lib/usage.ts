/**
 * Where the tokens actually go.
 *
 * Every optimisation in this repo so far was found by measuring something
 * specific after it had already hurt: a stalled session, a timeout, a budget
 * that was wrong by a factor of two. This records the same class of evidence
 * continuously and cheaply, so the next question about where to optimise is
 * answered from a session's own numbers rather than from a guess about which
 * tool is expensive.
 *
 * One line per tool call, appended. JSONL because it survives a crash
 * mid-write, is trivially greppable, and never needs the whole file in memory
 * to add to it.
 *
 * Env: PHI_USAGE_LOG=0        stop recording
 *      PHI_USAGE_MAX_BYTES    file size before the oldest half is dropped
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { STATE_DIR } from "./state-dir.ts";
import { charsPerToken } from "./token-estimate.ts";

export const ENABLED = process.env.PHI_USAGE_LOG !== "0";

/** Trim the file at this size. A heavy day is well under it. */
const MAX_BYTES = Number(process.env.PHI_USAGE_MAX_BYTES ?? 2_000_000);

export interface UsageRecord {
	/** ISO timestamp. */
	at: string;
	tool: string;
	/** File name or command, whichever identifies the call. */
	detail: string;
	/** Characters the result returned, before any truncation for display. */
	chars: number;
	/** Estimated tokens, using the per-tool ratio. */
	tokens: number;
	/** Wall time the call took. */
	ms: number;
	error?: boolean;
}

export function usagePath(cwd: string): string {
	return path.join(cwd, STATE_DIR, "usage.jsonl");
}

/**
 * Keep the file bounded by dropping the oldest half.
 *
 * Halving rather than trimming a line at a time, so this runs once in a long
 * while instead of on every append.
 */
function trim(p: string): void {
	try {
		if (fs.statSync(p).size < MAX_BYTES) return;
		const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
		fs.writeFileSync(p, `${lines.slice(Math.floor(lines.length / 2)).join("\n")}\n`);
	} catch {
		/* bounded is a nicety; never fail a tool call over it */
	}
}

export function record(cwd: string, rec: UsageRecord): void {
	if (!ENABLED) return;
	try {
		const p = usagePath(cwd);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.appendFileSync(p, `${JSON.stringify(rec)}\n`);
		trim(p);
	} catch {
		/* a diagnostic must never break the thing it observes */
	}
}

export function readUsage(cwd: string): UsageRecord[] {
	try {
		return fs
			.readFileSync(usagePath(cwd), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => {
				try {
					return JSON.parse(l) as UsageRecord;
				} catch {
					return undefined;
				}
			})
			.filter((r): r is UsageRecord => !!r && typeof r.tokens === "number");
	} catch {
		return [];
	}
}

export interface ToolSummary {
	tool: string;
	calls: number;
	tokens: number;
	/** Share of all recorded tokens, 0 to 1. */
	share: number;
	median: number;
	/** The worst single call, which is usually where the fix is. */
	worst: number;
	seconds: number;
	errors: number;
}

const median = (ns: number[]): number => {
	if (!ns.length) return 0;
	const s = [...ns].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/**
 * Per tool, ordered by total tokens.
 *
 * Median as well as total, because they answer different questions. A tool with
 * a high total and a low median is called constantly and is working as intended;
 * one with a high median is expensive every time it runs, and that is the one
 * worth changing.
 */
export function summarise(records: UsageRecord[]): ToolSummary[] {
	const byTool = new Map<string, UsageRecord[]>();
	for (const r of records) {
		const list = byTool.get(r.tool);
		if (list) list.push(r);
		else byTool.set(r.tool, [r]);
	}
	const total = records.reduce((a, r) => a + r.tokens, 0) || 1;
	return [...byTool.entries()]
		.map(([tool, rs]) => ({
			tool,
			calls: rs.length,
			tokens: rs.reduce((a, r) => a + r.tokens, 0),
			share: rs.reduce((a, r) => a + r.tokens, 0) / total,
			median: median(rs.map((r) => r.tokens)),
			worst: Math.max(...rs.map((r) => r.tokens)),
			seconds: Math.round(rs.reduce((a, r) => a + r.ms, 0) / 1000),
			errors: rs.filter((r) => r.error).length,
		}))
		.sort((a, b) => b.tokens - a.tokens);
}

/** The individual calls that cost the most, which is where a fix usually is. */
export function worstCalls(records: UsageRecord[], n = 5): UsageRecord[] {
	return [...records].sort((a, b) => b.tokens - a.tokens).slice(0, n);
}

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const num = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

export function formatSummary(records: UsageRecord[]): string {
	if (!records.length) return "No tool calls recorded yet.";
	const rows = summarise(records);
	const total = rows.reduce((a, r) => a + r.tokens, 0);
	const out = [
		`${records.length} calls, ~${total.toLocaleString()} tokens of tool output.`,
		"",
		`${pad("tool", 16)}${pad("calls", 7)}${pad("tokens", 9)}${pad("share", 7)}${pad("median", 8)}${pad("worst", 8)}time`,
	];
	for (const r of rows) {
		out.push(
			pad(r.tool, 16) +
				pad(r.calls, 7) +
				pad(num(r.tokens), 9) +
				pad(`${Math.round(r.share * 100)}%`, 7) +
				pad(num(r.median), 8) +
				pad(num(r.worst), 8) +
				`${r.seconds}s${r.errors ? `  (${r.errors} failed)` : ""}`,
		);
	}
	out.push("", "Biggest single calls:");
	for (const c of worstCalls(records)) {
		out.push(`  ${num(c.tokens).padEnd(6)} ${c.tool} ${c.detail}`.trimEnd());
	}
	return out.join("\n");
}
