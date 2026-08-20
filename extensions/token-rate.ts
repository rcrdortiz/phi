/**
 * token-rate — generation speed in the footer, next to the context indicator.
 *
 * Local inference speed is not a constant you can look up once. It degrades as
 * the KV cache grows, it collapses when the machine starts swapping, and on a
 * shared desktop it moves whenever something else wakes up. Those are exactly
 * the conditions this setup runs in, and none of them announce themselves: a
 * session that has quietly dropped from 30 tok/s to 4 looks identical to one
 * that is merely thinking hard.
 *
 * Measured on this machine for context: prefill runs ~180 tok/s and decays with
 * length, so a number that falls and keeps falling is the signal that the window
 * is too big or that memory pressure has started.
 *
 * The rate is taken from message_start to message_end around a single assistant
 * message, which is the generation window. Tools run outside it, so their time
 * is correctly excluded. Token counts are the provider's own `usage.output`
 * rather than an estimate from text length.
 *
 * Env: PI_TOKEN_RATE=0  hide it
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ENABLED = process.env.PI_TOKEN_RATE !== "0";
const KEY = "tokrate";
/** Samples below this are noise: a 3-token reply times its own scheduling. */
const MIN_TOKENS = 8;

interface Sample {
	tokens: number;
	ms: number;
}

export class RateTracker {
	private samples: Sample[] = [];
	private startedAt: number | undefined;

	begin(now: number): void {
		this.startedAt = now;
	}

	/** Returns the rate for this message, or undefined if it was too small to mean anything. */
	end(now: number, tokens: number): number | undefined {
		const started = this.startedAt;
		this.startedAt = undefined;
		if (started === undefined || tokens < MIN_TOKENS) return undefined;
		const ms = now - started;
		if (ms <= 0) return undefined;
		this.samples.push({ tokens, ms });
		if (this.samples.length > 20) this.samples.shift();
		return (tokens / ms) * 1000;
	}

	/** Token-weighted mean, so one fast two-word reply cannot skew the average. */
	average(): number | undefined {
		if (!this.samples.length) return undefined;
		const t = this.samples.reduce((a, s) => a + s.tokens, 0);
		const ms = this.samples.reduce((a, s) => a + s.ms, 0);
		return ms > 0 ? (t / ms) * 1000 : undefined;
	}

	reset(): void {
		this.samples = [];
		this.startedAt = undefined;
	}
}

export function format(last: number, avg: number | undefined): string {
	const n = (x: number) => (x >= 10 ? x.toFixed(0) : x.toFixed(1));
	// The average only earns its space once it says something different.
	if (avg === undefined || Math.abs(avg - last) < 0.5) return `${n(last)} tok/s`;
	return `${n(last)} tok/s (avg ${n(avg)})`;
}

export default function tokenRateExtension(pi: ExtensionAPI) {
	if (!ENABLED) return;
	const tracker = new RateTracker();

	pi.on("message_start", async () => {
		tracker.begin(Date.now());
		return undefined;
	});

	pi.on("message_end", async (event, ctx) => {
		const m = (event as { message?: { role?: string; usage?: { output?: number } } }).message;
		if (m?.role !== "assistant") return undefined;
		const rate = tracker.end(Date.now(), Number(m.usage?.output ?? 0));
		if (rate !== undefined) ctx.ui.setStatus?.(KEY, format(rate, tracker.average()));
		return undefined;
	});

	// A different model has a different speed; carrying the old average over
	// would make the first sample after a switch look like a regression.
	pi.on("model_select", async (_event, ctx) => {
		tracker.reset();
		ctx.ui.setStatus?.(KEY, undefined);
		return undefined;
	});

	pi.registerCommand("speed", {
		description: "Show generation speed for this session",
		handler: async (_args, ctx) => {
			const avg = tracker.average();
			ctx.ui.notify(
				avg === undefined
					? "No generation sampled yet."
					: `Session average: ${avg.toFixed(1)} tok/s (token-weighted, last 20 messages).`,
				"info",
			);
		},
	});
}
