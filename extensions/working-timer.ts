/**
 * working-timer — say how long the model has been working.
 *
 * "Working..." with a spinner is fine when a reply takes two seconds. On a
 * local model a turn can take four minutes: prefill after a cache miss is
 * thousands of tokens at ~120 tok/s, and nothing about the spinner tells you
 * whether that is happening or whether the thing has wedged. Both look
 * identical, and the difference matters enough to keep reaching for a stopwatch.
 *
 * An elapsed count makes the two distinguishable without one. A number that
 * keeps climbing past a minute is slow; a number that climbed to 500 and then
 * the turn failed is the idle timeout, and that is a different problem with a
 * different fix.
 *
 * Env: PI_WORKING_TIMER=0  leave pi's plain "Working..." alone
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ENABLED = process.env.PI_WORKING_TIMER !== "0";
const LABEL = "Working...";

/**
 * What the model is doing, in one word, derived from the tool it just called.
 *
 * Free, and that is the whole design constraint. pi hands us the tool name and
 * its arguments at tool_execution_start, so the label is a lookup on data we
 * already have. Asking the model what it is doing would cost output tokens on
 * every phase change and, at 20 tok/s, latency you would notice: a status line
 * is not worth a round trip.
 *
 * The consequence is that the gaps between tool calls read as plain "Thinking",
 * with no subject. The subject is the one thing only the model knows.
 */
const VERBS: Record<string, string> = {
	view_lines: "Reading",
	outline: "Reading",
	read: "Reading",
	ls: "Listing",
	grep: "Searching",
	find: "Searching",
	edit_symbol: "Editing",
	edit_block: "Editing",
	replace_lines: "Editing",
	edit: "Editing",
	write: "Writing",
	bash: "Running",
	plan_write: "Writing the plan",
	plan_next: "Finishing a step",
	plan_status: "Checking the plan",
	note_add: "Taking a note",
};

/** Longest detail shown after the verb. The indicator shares a line with the timer. */
const DETAIL_MAX = 28;

/**
 * The detail worth showing: a file's name, or the command being run.
 *
 * A path is shown by its basename. The directory is rarely the surprising part
 * and it is what makes the line too long to read at a glance.
 */
export function detailFor(toolName: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	if (toolName === "bash") {
		const cmd = String(a.command ?? "").trim().split("\n")[0];
		// The first word is the program, which is the part that says what is
		// happening. The flags are noise at this width.
		return cmd.split(/\s+/)[0] ?? "";
	}
	const p = a.path ?? a.file ?? a.file_path ?? a.filePath;
	if (typeof p === "string" && p) return p.split("/").filter(Boolean).pop() ?? "";
	if (typeof a.symbol === "string") return a.symbol;
	return "";
}

/** The phase label for a tool call, e.g. "Reading pang.js". */
export function phaseFor(toolName: string, args?: unknown): string {
	const verb = VERBS[toolName] ?? toolName;
	const detail = detailFor(toolName, args);
	if (!detail) return verb;
	const short = detail.length > DETAIL_MAX ? `${detail.slice(0, DETAIL_MAX - 1)}\u2026` : detail;
	return `${verb} ${short}`;
}

/**
 * Elapsed time, written the way a person reads a stopwatch.
 *
 * Seconds alone up to a minute, then minutes and seconds: "185s" makes you do
 * arithmetic to notice you have been waiting three minutes.
 */
export function elapsedLabel(ms: number, phase = ""): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const clock = total < 60 ? `${total}s` : `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
	return phase ? `${LABEL} ${phase} ${clock}` : `${LABEL} ${clock}`;
}

export default function workingTimer(pi: ExtensionAPI): void {
	if (!ENABLED) return;

	let timer: ReturnType<typeof setInterval> | undefined;
	let startedAt = 0;
	// Between tool calls the model is generating, which is thinking as far as
	// anyone watching is concerned.
	let phase = "Thinking";

	const stop = (ctx: unknown) => {
		if (timer) clearInterval(timer);
		timer = undefined;
		// Back to pi's own label, so anything that shows the indicator outside a
		// run is not left displaying a frozen count from the last one.
		(ctx as ExtensionContext).ui?.setWorkingMessage?.(undefined);
	};

	pi.on("agent_start", async (_event, ctx) => {
		const c = ctx as unknown as ExtensionContext;
		if (c.mode !== "tui" || typeof c.ui?.setWorkingMessage !== "function") return undefined;
		if (timer) clearInterval(timer);
		startedAt = Date.now();
		phase = "Thinking";
		c.ui.setWorkingMessage(elapsedLabel(0, phase));
		// One second, not less. The indicator already animates, so a faster tick
		// buys no smoothness and costs a render on every frame of a four-minute
		// turn.
		timer = setInterval(() => c.ui.setWorkingMessage(elapsedLabel(Date.now() - startedAt, phase)), 1000);
		// Node keeps the process alive for a pending interval, which would stop
		// pi exiting between the last turn and shutdown.
		timer.unref?.();
		return undefined;
	});

	// The label follows the work. A tool call says what is happening; the gap
	// after it is the model composing its next move.
	// Painted immediately rather than left to the next tick: a tool that returns
	// in under a second would otherwise never be named at all, and the label
	// would lag a second behind the work for every tool that does.
	const repaint = (ctx: unknown) => {
		if (!timer) return;
		(ctx as ExtensionContext).ui?.setWorkingMessage?.(elapsedLabel(Date.now() - startedAt, phase));
	};
	pi.on("tool_execution_start", async (event, ctx) => {
		const e = event as { toolName?: string; args?: unknown };
		if (e.toolName) phase = phaseFor(e.toolName, e.args);
		repaint(ctx);
		return undefined;
	});
	pi.on("tool_execution_end", async (_event, ctx) => {
		phase = "Thinking";
		repaint(ctx);
		return undefined;
	});

	pi.on("agent_end", async (_event, ctx) => {
		stop(ctx);
		return undefined;
	});
	// agent_end does not fire when a turn is aborted or errors, and a frozen
	// counter left on screen reads as "still working" for something that stopped.
	pi.on("agent_settled", async (_event, ctx) => {
		stop(ctx);
		return undefined;
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		stop(ctx);
		return undefined;
	});
}
