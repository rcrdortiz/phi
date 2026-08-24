/**
 * model-preload — load the model into memory when pi opens, not when you type.
 *
 * Ollama loads weights lazily on the first request, so the first message of a
 * session pays ~10-30s of model load on top of its own prefill. This fires an
 * empty request at session start (and whenever you switch models with /model)
 * so the weights are resident by the time you finish typing.
 *
 * It also asks for a long keep_alive, but that alone is NOT enough: keep_alive
 * is per-request, and pi's own requests do not set it, so the next one resets
 * the timer to the server default of 5 minutes. A 20GB model then unloads
 * during any pause, and the next message pays a full reload — or races the
 * teardown and fails with `Post ".../v1/completions": EOF`. The durable fix is
 * the server-wide OLLAMA_KEEP_ALIVE, which install.sh sets.
 *
 * The other half is releasing them again. A 2h keep_alive is right while you are
 * working and wrong the moment you stop: it holds ~29GB on a machine you also
 * use for everything else, long after the last message. So the last session to
 * exit hands the memory back, and the next start pays the load it was always
 * going to pay. Only the LAST one: unloading while another session is mid-turn
 * would evict the model out from under it.
 *
 * Env: PI_OLLAMA_URL (default http://localhost:11434)
 *      PI_KEEP_ALIVE (default 2h)
 *      PHI_RELEASE_ON_EXIT=0  keep the model resident after the last session
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { otherSessions } from "../lib/health.ts";

const OLLAMA = process.env.PI_OLLAMA_URL ?? "http://localhost:11434";
const KEEP_ALIVE = process.env.PI_KEEP_ALIVE ?? "2h";
const RELEASE_ON_EXIT = process.env.PHI_RELEASE_ON_EXIT !== "0";

async function isUp(): Promise<boolean> {
	try {
		const r = await fetch(`${OLLAMA}/api/version`, {
			signal: AbortSignal.timeout(1500),
		});
		return r.ok;
	} catch {
		return false;
	}
}

async function loaded(model: string): Promise<boolean> {
	try {
		const r = await fetch(`${OLLAMA}/api/ps`, { signal: AbortSignal.timeout(2000) });
		if (!r.ok) return false;
		const d = (await r.json()) as { models?: { name?: string }[] };
		return (d.models ?? []).some((m) => m.name === model || m.name === `${model}:latest`);
	} catch {
		return false;
	}
}

/** Empty prompt + keep_alive = load weights and hold them, generating nothing. */
async function preload(model: string): Promise<void> {
	await fetch(`${OLLAMA}/api/generate`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ model, prompt: "", keep_alive: KEEP_ALIVE }),
		signal: AbortSignal.timeout(600_000),
	});
}

/** Bytes Ollama reports for a resident model, so the report names a real number. */
export async function residentBytes(model: string, url = OLLAMA): Promise<number | undefined> {
	try {
		const r = await fetch(`${url}/api/ps`, { signal: AbortSignal.timeout(2000) });
		if (!r.ok) return undefined;
		const d = (await r.json()) as { models?: { name?: string; size?: number }[] };
		const m = (d.models ?? []).find((x) => x.name === model || x.name === `${model}:latest`);
		return typeof m?.size === "number" ? m.size : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Should this exit hand the weights back?
 *
 * Only when we are the last session. otherSessions returns undefined when it
 * could not tell, and that is deliberately NOT treated as zero: evicting a
 * model another session is using costs it a full reload mid-turn, which is a
 * far worse outcome than holding memory a while longer.
 */
export function shouldRelease(others: number | undefined, enabled = RELEASE_ON_EXIT): boolean {
	return enabled && others === 0;
}

/** keep_alive 0 tells Ollama to drop the weights now rather than on a timer. */
export async function release(model: string, url = OLLAMA): Promise<boolean> {
	try {
		const r = await fetch(`${url}/api/generate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model, prompt: "", keep_alive: 0 }),
			signal: AbortSignal.timeout(10_000),
		});
		return r.ok;
	} catch {
		return false;
	}
}

export default function modelPreloadExtension(pi: ExtensionAPI) {
	let warming: string | undefined;

	const warm = async (model: string | undefined, ctx: { ui: { notify: Function } }) => {
		if (!model || warming === model) return;
		if (!(await isUp())) return;
		if (await loaded(model)) return;

		warming = model;
		const t0 = Date.now();
		ctx.ui.notify(`Loading ${model} into memory…`, "info");
		try {
			await preload(model);
			ctx.ui.notify(`${model} ready (${((Date.now() - t0) / 1000).toFixed(0)}s)`, "info");
		} catch {
			// A failed warm-up costs nothing: the first real request loads it anyway.
		} finally {
			warming = undefined;
		}
	};

	// Deliberately not awaited anywhere below: the prompt should appear
	// immediately and the model can finish loading while the user types.
	pi.on("session_start", async (_event, ctx) => {
		void warm(ctx.model?.id, ctx);
	});
	// session_start does not fire in --print/--mode json; this covers those.
	pi.on("before_agent_start", async (_event, ctx) => {
		void warm(ctx.model?.id, ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		void warm((event as { model?: { id?: string } }).model?.id ?? ctx.model?.id, ctx);
	});

	// Awaited, unlike the warms above: the process is leaving, and a detached
	// fetch would be killed before it reached the server.
	pi.on("session_shutdown", async (_event, ctx) => {
		const model = ctx.model?.id;
		if (!model || !RELEASE_ON_EXIT) return undefined;
		try {
			if (!(await isUp())) return undefined;
			if (!(await loaded(model))) return undefined;
			if (!shouldRelease(await otherSessions())) return undefined;
			const size = await residentBytes(model);
			if (await release(model)) {
				const gb = size ? ` (${(size / 2 ** 30).toFixed(1)} GB)` : "";
				ctx.ui?.notify?.(`Released ${model}${gb}. It reloads on the next session.`, "info");
			}
		} catch {
			/* memory handed back late is a nuisance; a failed exit is a bug */
		}
		return undefined;
	});
}
