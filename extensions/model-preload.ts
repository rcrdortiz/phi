/**
 * model-preload — load the model into memory when pi opens, not when you type.
 *
 * Ollama loads weights lazily on the first request, so the first message of a
 * session pays ~10-30s of model load on top of its own prefill. This fires an
 * empty request at session start (and whenever you switch models with /model)
 * so the weights are resident by the time you finish typing.
 *
 * Also sets keep_alive so the model doesn't unload while you think — the
 * default is 5 minutes, which is shorter than a coffee.
 *
 * Env: PI_OLLAMA_URL (default http://localhost:11434)
 *      PI_KEEP_ALIVE (default 2h)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const OLLAMA = process.env.PI_OLLAMA_URL ?? "http://localhost:11434";
const KEEP_ALIVE = process.env.PI_KEEP_ALIVE ?? "2h";

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
}
