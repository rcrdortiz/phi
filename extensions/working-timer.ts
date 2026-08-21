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
 * Elapsed time, written the way a person reads a stopwatch.
 *
 * Seconds alone up to a minute, then minutes and seconds: "185s" makes you do
 * arithmetic to notice you have been waiting three minutes.
 */
export function elapsedLabel(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	if (total < 60) return `${LABEL} ${total}s`;
	const m = Math.floor(total / 60);
	const s = total % 60;
	return `${LABEL} ${m}m ${String(s).padStart(2, "0")}s`;
}

export default function workingTimer(pi: ExtensionAPI): void {
	if (!ENABLED) return;

	let timer: ReturnType<typeof setInterval> | undefined;
	let startedAt = 0;

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
		c.ui.setWorkingMessage(elapsedLabel(0));
		// One second, not less. The indicator already animates, so a faster tick
		// buys no smoothness and costs a render on every frame of a four-minute
		// turn.
		timer = setInterval(() => c.ui.setWorkingMessage(elapsedLabel(Date.now() - startedAt)), 1000);
		// Node keeps the process alive for a pending interval, which would stop
		// pi exiting between the last turn and shutdown.
		timer.unref?.();
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
