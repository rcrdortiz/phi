/**
 * memory-guard — refuse to start, or to switch to, a model that will not fit.
 *
 * A local model that doesn't fit doesn't fail cleanly: macOS swaps, generation
 * decays toward zero, and the session looks like it is "thinking" for an hour
 * before the client gives up with "Error: terminated".
 *
 * Two separate checks, because a single startup threshold is not enough:
 *
 *   1. At startup   — is there enough memory at all?
 *   2. On /model    — does THIS model fit? Starting with 35GB free and then
 *                     selecting a 32GB model is how you end up swapping, and
 *                     a startup-only check never sees it.
 *
 * Env: PI_MIN_FREE_GB   (default 30) available, counting resident models
 *      PI_MIN_ACTUAL_GB (default 8)  genuinely free, regardless of the above
 *      PI_KV_KB_PER_TOKEN (default 150) measured for qwen3.8-27B at q8 cache
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { MODELS, toPiModel } from "../lib/ollama-models.ts";

// 28 GB is the model's measured peak plus a little: 18.49 GB of weights on a
// clean load (flat regardless of num_ctx — MLX allocates its cache lazily) and
// 25.79 GB with a full 64K context, measured by filling it. Below this the
// machine has to swap to finish a long session, and a swapping local model does
// not fail — it slows to nothing while still looking like it is thinking.
const MIN_FREE_GB = Number(process.env.PI_MIN_FREE_GB ?? 28);
const MIN_ACTUAL_GB = Number(process.env.PI_MIN_ACTUAL_GB ?? 8);
// Measured across the full window (2.5K -> 64K), not extrapolated from a narrow
// sample: a 1.5K->14K sample reads 136.5 and over-predicts the peak by ~1.2 GB,
// because growth is not quite linear. This is the whole-range figure.
const KV_KB_PER_TOKEN = Number(process.env.PI_KV_KB_PER_TOKEN ?? 113);
// Small, because the two numbers it pads are now measured rather than guessed.
// At 4 GB the per-model check demanded ~31 GB free for a model whose real peak
// is 27, which refuses to start on a machine that would have been fine.
const HEADROOM_GB = 1;

function sh(cmd: string, args: string[]): string {
	try {
		return execFileSync(cmd, args, { encoding: "utf8", timeout: 5000 });
	} catch {
		return "";
	}
}

type Mem = { actual: number; free: number; total: number; reclaimable: number };

function memory(): Mem | undefined {
	const vm = sh("vm_stat", []);
	const memsize = sh("sysctl", ["-n", "hw.memsize"]).trim();
	if (!vm || !memsize) return undefined;

	const page = Number(/page size of (\d+)/.exec(vm)?.[1] ?? 4096);
	const pages = (label: string) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(vm)?.[1] ?? 0);
	const used =
		(pages("Pages active") + pages("Pages wired down") + pages("Pages occupied by compressor")) *
		page;
	const total = Number(memsize);

	// Resident models are reclaimable: loading a different one evicts them.
	let reclaimable = 0;
	for (const line of sh("ollama", ["ps"]).split("\n").slice(1)) {
		const m = /\s(\d+(?:\.\d+)?)\s*GB\s/.exec(line);
		if (m) reclaimable += Number(m[1]);
	}

	const actual = (total - used) / 2 ** 30;
	return { actual, free: actual + reclaimable, total: total / 2 ** 30, reclaimable };
}

/** Weight size in GB for an Ollama model id, from `ollama list`. */
function weightsGb(modelId: string): number | undefined {
	const want = modelId.replace(/:latest$/, "");
	for (const line of sh("ollama", ["list"]).split("\n").slice(1)) {
		const cols = line.split(/\s{2,}/);
		if (cols.length < 3) continue;
		const name = cols[0].trim().replace(/:latest$/, "");
		if (name !== want) continue;
		const m = /(\d+(?:\.\d+)?)\s*GB/.exec(cols[2] ?? "");
		if (m) return Number(m[1]);
	}
	return undefined;
}

/** Whether a specific model fits right now, and why not. */
function modelShortfall(modelId: string, contextWindow?: number): string | undefined {
	const mem = memory();
	const w = weightsGb(modelId);
	if (!mem || w === undefined) return undefined;

	const kv = ((contextWindow ?? 65536) * KV_KB_PER_TOKEN) / 2 ** 20;
	const need = w + kv + HEADROOM_GB;
	// A model already resident needs no new memory.
	const resident = sh("ollama", ["ps"]).includes(modelId.replace(/:latest$/, ""));
	if (resident) return undefined;
	if (mem.free >= need) return undefined;

	return (
		`${modelId} needs ~${need.toFixed(0)} GB (${w} GB weights + ${kv.toFixed(0)} GB context cache) ` +
		`but only ${mem.free.toFixed(1)} GB is available. It will swap and crawl. ` +
		`Free ${(need - mem.free).toFixed(1)} GB, or pick a smaller model.`
	);
}

/** General "is this machine usable at all" check. */
function startupShortfall(): string | undefined {
	const m = memory();
	if (!m) return undefined;
	if (m.actual < MIN_ACTUAL_GB) {
		return (
			`Only ${m.actual.toFixed(1)} GB actually free (${m.reclaimable.toFixed(0)} GB is held by ` +
			`loaded models). The machine is at its limit — quit Chrome and other apps first.`
		);
	}
	if (m.free < MIN_FREE_GB) {
		return (
			`Only ${m.free.toFixed(1)} GB available of ${m.total.toFixed(0)} GB (need ${MIN_FREE_GB}). ` +
			`Free ${(MIN_FREE_GB - m.free).toFixed(1)} GB more — quitting Chrome usually does it.`
		);
	}
	return undefined;
}

/** True when pi was invoked non-interactively (no dialog can be answered). */
function nonInteractive(): boolean {
	return process.argv.some((a) => a === "--print" || a === "-p" || a === "--mode");
}

export default function memoryGuardExtension(pi: ExtensionAPI) {
	// The factory is the only code guaranteed to run in every mode: when memory
	// is short enough to matter, pi can stall loading the model before any event
	// fires, so an event-based gate would never get the chance to speak.
	if (process.platform === "darwin" && nonInteractive()) {
		const why = startupShortfall();
		if (why) {
			process.stderr.write(`memory-guard: ${why}\n`);
			process.exit(1);
		}
	}

	let checked = false;

	pi.on("session_start", async (_event, ctx) => {
		if (checked || process.platform !== "darwin") return;
		checked = true;
		const why = startupShortfall() ?? modelShortfall(ctx.model?.id ?? "", ctx.model?.contextWindow);
		if (!why) return;

		if (ctx.mode !== "tui") {
			process.stderr.write(`memory-guard: ${why}\n`);
			process.exit(1);
		}

		// Offer the models that DO fit, so a low-memory warning is something you
		// can act on rather than just a yes/no.
		const fitting = MODELS.filter(
			(m) => m.id !== ctx.model?.id && !modelShortfall(m.id, m.contextWindow),
		);
		const switchTo = fitting.map((m) => `Switch to ${m.id}  (${weightsGb(m.id) ?? m.weightsGb} GB)`);
		const START = "Start anyway (will swap)";
		const QUIT = "Quit";

		const choice = await ctx.ui.select(`Low memory — ${why}`, [...switchTo, START, QUIT]);

		if (choice === undefined || choice === QUIT) {
			ctx.ui.notify("Stopped: not enough free memory.", "error");
			process.exit(1);
		}
		if (choice === START) {
			ctx.ui.notify("Starting with low memory — expect swapping.", "warning");
			return;
		}
		const picked = fitting[switchTo.indexOf(choice)];
		if (picked) {
			const ok = await pi.setModel(toPiModel(picked));
			ctx.ui.notify(
				ok ? `Switched to ${picked.id}.` : `Could not switch to ${picked.id}.`,
				ok ? "info" : "error",
			);
		}
	});

	// The gap a startup-only check misses: begin with room, then switch to a
	// model that does not fit. Warn at the moment of the switch, when it is
	// still cheap to change your mind.
	pi.on("model_select", async (event, ctx) => {
		if (process.platform !== "darwin") return;
		const model = (event as { model?: { id?: string; contextWindow?: number } }).model ?? ctx.model;
		if (!model?.id) return;
		const why = modelShortfall(model.id, model.contextWindow);
		if (!why) return;
		ctx.ui.notify(why, "warning");
	});
}
