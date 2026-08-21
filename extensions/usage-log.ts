/**
 * usage-log — record what each tool call costs, so optimising is not guesswork.
 *
 * `/usage` shows where the tokens went: per tool, and the individual calls that
 * cost the most. Every improvement in this repo so far started from a specific
 * measurement taken after something had already gone wrong. This is the same
 * evidence, collected continuously, so the next question about what to change
 * has an answer from your own sessions rather than an assumption about which
 * tool is expensive.
 *
 * The cost of collecting it is one appended line per tool call, and the whole
 * thing is wrapped so a failure to record can never break the call it observes.
 *
 * Env: PHI_USAGE_LOG=0  stop recording
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resultText } from "../lib/collapse.ts";
import { charsPerToken } from "../lib/token-estimate.ts";
import { ENABLED, formatSummary, readUsage, record, usagePath } from "../lib/usage.ts";

/**
 * What identifies this call in a report.
 *
 * A file's basename or a command's program: enough to recognise the call
 * without storing arguments that may contain anything.
 */
export function detailOf(toolName: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	if (typeof a.command === "string") return a.command.trim().split("\n")[0].split(/\s+/)[0] ?? "";
	const p = a.file ?? a.path ?? a.file_path ?? a.filePath;
	if (typeof p === "string" && p) return p.split("/").filter(Boolean).pop() ?? "";
	if (typeof a.symbol === "string") return a.symbol;
	return "";
}

export default function usageLog(pi: ExtensionAPI): void {
	if (!ENABLED) return;

	// Keyed by call id: tool calls interleave, so a single "current call" would
	// attribute one tool's output to another's timer.
	const open = new Map<string, { tool: string; detail: string; at: number }>();

	pi.on("tool_execution_start", async (event) => {
		const e = event as { toolCallId?: string; toolName?: string; args?: unknown };
		if (!e.toolCallId || !e.toolName) return undefined;
		open.set(e.toolCallId, { tool: e.toolName, detail: detailOf(e.toolName, e.args), at: Date.now() });
		return undefined;
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		const e = event as { toolCallId?: string; toolName?: string; result?: unknown; isError?: boolean };
		const started = e.toolCallId ? open.get(e.toolCallId) : undefined;
		if (e.toolCallId) open.delete(e.toolCallId);
		const tool = started?.tool ?? e.toolName;
		if (!tool) return undefined;
		const text = resultText(e.result);
		record((ctx as unknown as ExtensionContext).cwd, {
			at: new Date().toISOString(),
			tool,
			detail: started?.detail ?? "",
			chars: text.length,
			// The same estimate the budget uses, so the two reports agree.
			tokens: Math.round(text.length / charsPerToken(tool)),
			ms: started ? Date.now() - started.at : 0,
			...(e.isError ? { error: true } : {}),
		});
		return undefined;
	});

	pi.registerCommand("usage", {
		description: "Show which tools are spending the context",
		handler: async (_args, ctx) => {
			const c = ctx as unknown as ExtensionContext;
			const records = readUsage(c.cwd);
			ctx.ui.notify(
				records.length
					? `${formatSummary(records)}\n\nRaw log: ${usagePath(c.cwd)}`
					: `No tool calls recorded yet. They land in ${usagePath(c.cwd)}.`,
				"info",
			);
		},
	});
}
