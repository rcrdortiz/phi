/**
 * tool-budget — stop one tool result from eating the context window.
 *
 * Measured on the session that died in pang-clone (1MB transcript, 327 entries):
 *
 *   toolResult   88.6% of all context      images  1 (0.0%)
 *     view_lines   54.1%  (30 calls)
 *     read         14.8%  ( 9 calls)
 *     bash         12.4%  (50 calls)
 *
 * Tool output IS the context. Nothing else comes close, and the screenshots
 * that looked like the culprit were never the problem.
 *
 * The specific failure was a single call:
 *
 *   view_lines {file: "pang.js", offset: "630", limit: "120", end_line: 710}
 *
 * It asked for 80 lines (3,466 chars) and got back 35,716 — 77% of the whole
 * file, ~10K tokens, 30% of a 32K window, in ONE result. Note the mixed
 * parameter styles and the string-typed numbers: small local models emit
 * malformed arguments like this regularly, and a tool that responds by dumping
 * most of the file turns a sloppy call into a dead session.
 *
 * Why a cap rather than fixing the tools: pi checks whether to compact at
 * `agent_end`, AFTER results are already in context. A result big enough to
 * matter has therefore already landed before anything can react — which is how
 * usage reached 163% of a 66K window and left compaction with no way out but a
 * full re-prefill it could not finish. Capping at the source is the only point
 * where the overshoot is actually preventable.
 *
 * Truncation keeps the head and the tail. The head is where a file's imports
 * and shape live; the tail is usually what was actually being asked about. The
 * middle is what gets dropped, and the marker says so explicitly, with the
 * numbers, so the model re-reads a narrower range instead of assuming the file
 * simply ends there.
 *
 * Env: PI_TOOL_BUDGET_FRACTION  (default 0.10) of the context window, per result
 *      PI_TOOL_BUDGET_MIN_CHARS (default 4000) floor, so a small window still works
 *      PI_TOOL_BUDGET_IMAGE_PX  (default 1024) longest edge for images
 *      PI_TOOL_BUDGET=0         disable entirely
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Measured on this transcript: 159,636 chars of mixed code and prose per
 *  ~44K tokens. Code runs denser than prose, so this errs slightly generous. */
const CHARS_PER_TOKEN = 3.6;

const FRACTION = Number(process.env.PI_TOOL_BUDGET_FRACTION ?? 0.1);
const MIN_CHARS = Number(process.env.PI_TOOL_BUDGET_MIN_CHARS ?? 4000);
const IMAGE_PX = Number(process.env.PI_TOOL_BUDGET_IMAGE_PX ?? 1024);
const ENABLED = process.env.PI_TOOL_BUDGET !== "0";

/** Fraction of the kept text taken from the head; the rest comes from the tail. */
const HEAD_SHARE = 0.6;

export function budgetChars(contextWindow: number | undefined): number {
	const window = contextWindow && contextWindow > 0 ? contextWindow : 32768;
	return Math.max(MIN_CHARS, Math.round(window * FRACTION * CHARS_PER_TOKEN));
}

/** Trim to `limit`, keeping head and tail, with a marker explaining the gap.
 *  Returns the original string when it already fits. */
export function truncate(text: string, limit: number, label: string): string {
	if (text.length <= limit) return text;

	const dropped = text.length - limit;
	const marker =
		`\n\n... [tool-budget] ${dropped.toLocaleString()} of ${text.length.toLocaleString()} characters ` +
		`(~${Math.round(dropped / CHARS_PER_TOKEN).toLocaleString()} tokens) removed from the middle of this ` +
		`${label} result, which exceeded the ${limit.toLocaleString()}-character per-result budget.\n` +
		`The head and tail below are intact. This is a display limit, not the end of the data — ` +
		`re-run with a narrower range (or a more specific pattern) to see the middle.\n\n`;

	const room = limit - marker.length;
	// A budget smaller than its own explanation: keep the marker, it is the
	// more useful of the two.
	if (room <= 0) return marker.trim();

	const head = Math.floor(room * HEAD_SHARE);
	const tail = room - head;
	// Prefer cutting at a line boundary so we don't hand back half a token.
	const headText = text.slice(0, head).replace(/\n[^\n]*$/, "");
	const tailText = text.slice(text.length - tail).replace(/^[^\n]*\n/, "");
	return headText + marker + tailText;
}

/** Longest-edge downscale via sips. Returns null if it cannot be done, so the
 *  caller passes the original through rather than losing the image. */
export function shrinkImage(base64: string, mimeType: string, maxPx: number): string | null {
	if (process.platform !== "darwin") return null;
	let dir: string | undefined;
	try {
		const bytes = Buffer.from(base64, "base64");
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-budget-"));
		const ext = (mimeType.split("/")[1] ?? "png").replace(/[^a-z0-9]/gi, "") || "png";
		const src = path.join(dir, `in.${ext}`);
		fs.writeFileSync(src, bytes);

		const dims = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", src], {
			encoding: "utf8",
			timeout: 10_000,
		});
		const w = Number(/pixelWidth:\s*(\d+)/.exec(dims)?.[1] ?? 0);
		const h = Number(/pixelHeight:\s*(\d+)/.exec(dims)?.[1] ?? 0);
		if (!w || !h || Math.max(w, h) <= maxPx) return null;

		// JPEG only to shrink the payload on the wire. It saves no context
		// whatsoever: token cost is ~1015 pixels per token and is completely
		// independent of file size or format. Measured, on this model: the same
		// 800px image costs 477 tokens as a 353KB PNG and as a 27KB JPEG.
		const out = path.join(dir, "out.jpg");
		execFileSync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "70", "-Z", String(maxPx), src, "--out", out], {
			timeout: 15_000,
			stdio: "ignore",
		});
		return fs.readFileSync(out).toString("base64");
	} catch {
		return null;
	} finally {
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	}
}

export default function toolBudgetExtension(pi: ExtensionAPI) {
	if (!ENABLED) return;

	pi.on("tool_result", async (event, ctx) => {
		const e = event as {
			toolName: string;
			content: ({ type?: string } & Record<string, unknown>)[];
		};
		if (!Array.isArray(e.content) || e.content.length === 0) return undefined;

		const c = ctx as unknown as ExtensionContext;
		const limit = budgetChars(c.getContextUsage?.()?.contextWindow);

		let changed = false;
		let savedChars = 0;
		const content = e.content.map((part) => {
			if (typeof part.text === "string") {
				const trimmed = truncate(part.text, limit, e.toolName);
				if (trimmed === part.text) return part;
				changed = true;
				savedChars += part.text.length - trimmed.length;
				return { ...part, text: trimmed };
			}
			if (part.type === "image" && typeof part.data === "string") {
				const shrunk = shrinkImage(part.data, String(part.mimeType ?? "image/png"), IMAGE_PX);
				if (!shrunk) return part;
				changed = true;
				return { ...part, data: shrunk, mimeType: "image/jpeg" };
			}
			return part;
		});

		if (!changed) return undefined;
		if (savedChars > 0) {
			c.ui.notify(
				`tool-budget: trimmed ${savedChars.toLocaleString()} chars ` +
					`(~${Math.round(savedChars / CHARS_PER_TOKEN).toLocaleString()} tokens) from a ${e.toolName} result.`,
				"info",
			);
		}
		return { content } as never;
	});

	pi.registerCommand("budget", {
		description: "Show the per-tool-result size budget",
		handler: async (_args, ctx) => {
			const u = (ctx as unknown as ExtensionContext).getContextUsage?.();
			const limit = budgetChars(u?.contextWindow);
			ctx.ui.notify(
				[
					`Per-result budget: ${limit.toLocaleString()} chars (~${Math.round(limit / CHARS_PER_TOKEN).toLocaleString()} tokens)`,
					`= ${(FRACTION * 100).toFixed(0)}% of a ${(u?.contextWindow ?? 32768).toLocaleString()}-token window`,
					`Images capped at ${IMAGE_PX}px on the longest edge (~${Math.round((IMAGE_PX * IMAGE_PX * 0.66) / 1015).toLocaleString()} tokens).`,
				].join("\n"),
				"info",
			);
		},
	});
}
