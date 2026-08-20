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
 * Two numbers, because they have different causes and different fixes.
 *
 *   decode   tokens per second once text is actually streaming
 *   prefill  the wait before the first token, processing the prompt
 *
 * Reporting one blended figure hides which is which, and they point at opposite
 * remedies. Measured on this machine: decode runs ~49 tok/s on an empty context
 * and falls to ~13-19 by 10-16K, while prefill holds near ~120 tok/s. So a
 * blended number that reads "15 tok/s" can mean the model is fine and the
 * context is deep, or that a cache miss just re-processed 20K tokens. Only the
 * split tells you whether to shrink the context or stop invalidating the cache.
 *
 * Windows come from message_start (turn begins), the first message_update that
 * carries text (first token out), and message_end. Tools run outside all three,
 * so their time is correctly excluded. Token counts are the provider's own
 * `usage.output`, not an estimate from text length.
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
	/** Time spent streaming tokens. */
	ms: number;
	/** Time before the first token, i.e. prompt processing. */
	prefillMs: number;
}

export class RateTracker {
	private samples: Sample[] = [];
	private startedAt: number | undefined;
	private firstTokenAt: number | undefined;

	begin(now: number): void {
		this.startedAt = now;
		this.firstTokenAt = undefined;
	}

	/** First streamed text of this message: the boundary between prefill and decode. */
	firstToken(now: number): void {
		if (this.startedAt !== undefined && this.firstTokenAt === undefined) this.firstTokenAt = now;
	}

	/** Returns the decode rate for this message, or undefined if it was too small to mean anything. */
	end(now: number, tokens: number): number | undefined {
		const started = this.startedAt;
		// Without a streamed first token there is no split to make, so charge the
		// whole window to decode rather than inventing a boundary.
		const firstAt = this.firstTokenAt ?? started;
		this.startedAt = undefined;
		this.firstTokenAt = undefined;
		if (started === undefined || firstAt === undefined || tokens < MIN_TOKENS) return undefined;
		const ms = now - firstAt;
		if (ms <= 0) return undefined;
		this.samples.push({ tokens, ms, prefillMs: firstAt - started });
		if (this.samples.length > 20) this.samples.shift();
		return (tokens / ms) * 1000;
	}

	/** Mean seconds spent waiting for the first token. */
	prefillSeconds(): number | undefined {
		if (!this.samples.length) return undefined;
		return this.samples.reduce((a, s) => a + s.prefillMs, 0) / this.samples.length / 1000;
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
		this.firstTokenAt = undefined;
	}
}

/** Whether streamed content has produced any actual text yet. */
function hasText(content: unknown): boolean {
	if (typeof content === "string") return content.length > 0;
	if (Array.isArray(content))
		return content.some((p) => typeof (p as { text?: string })?.text === "string" && (p as { text: string }).text.length > 0);
	return false;
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

	// The first streamed text ends prompt processing and starts generation.
	pi.on("message_update", async (event) => {
		const e = event as { message?: { content?: unknown } };
		if (hasText(e.message?.content)) tracker.firstToken(Date.now());
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
			const prefill = tracker.prefillSeconds();
			ctx.ui.notify(
				avg === undefined
					? "No generation sampled yet."
					: [
							`Decode: ${avg.toFixed(1)} tok/s (token-weighted, last 20 messages).`,
							prefill !== undefined ? `Prefill: ${prefill.toFixed(1)}s before the first token, on average.` : "",
							`A low decode rate means the context is deep; a long prefill means the prefix cache missed.`,
						]
							.filter(Boolean)
							.join("\n"),
				"info",
			);
		},
	});
}
