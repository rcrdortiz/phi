/**
 * thinking-level — make pi's thinking control work with the local models.
 *
 * pi already has the control: **Shift+Tab** cycles the thinking level, and the
 * status line shows it next to the model. What was missing is the wiring —
 * ollama-models.ts now maps pi's levels onto Ollama's `reasoning_effort`
 * (off → "none", low → "low", medium → "medium", high → "high"), so cycling
 * changes how much the model deliberates, live, mid-session.
 *
 * This extension adds the two things that mapping alone does not give you:
 *
 *   - each model starts at its tier's sensible default when selected, rather
 *     than inheriting whatever the last model was on
 *   - changing level says what it will cost, including a memory note when the
 *     machine is tight, since more thinking means more tokens and a KV cache
 *     that grows faster
 *
 * `/effort [off|low|medium|high]` sets it without reaching for the keyboard
 * shortcut, and reports the current level with no argument.
 *
 * Env: PI_THINKING_DEFAULTS=0  keep the current level when switching models
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { BASE_URL, MODELS, PROVIDER, samplingFor, toPiModel, DFLASH_MODELS, DFLASH_PROVIDER, DFLASH_URL } from "../lib/ollama-models.ts";

const APPLY_DEFAULTS = process.env.PI_THINKING_DEFAULTS !== "0";

/** Sampling is switched with the level; see samplingFor in ../lib. */
void samplingFor;

/** What each level costs, measured on "Is 1009 prime?" against qwen3.8. */
const COST: Record<string, string> = {
	off: "no deliberation — ~10 completion tokens on a simple question",
	minimal: "light deliberation",
	low: "light deliberation — ~357 tokens on the same question",
	medium: "more deliberation — ~377 tokens, barely above low",
	high: "most deliberation, slowest to first answer",
};

function freeGb(): number | undefined {
	if (process.platform !== "darwin") return undefined;
	try {
		const vm = execFileSync("vm_stat", { encoding: "utf8", timeout: 4000 });
		const total = Number(execFileSync("sysctl", ["-n", "hw.memsize"], { encoding: "utf8", timeout: 4000 }));
		const page = Number(/page size of (\d+)/.exec(vm)?.[1] ?? 4096);
		const pages = (l: string) => Number(new RegExp(`${l}:\\s+(\\d+)`).exec(vm)?.[1] ?? 0);
		const used =
			(pages("Pages active") + pages("Pages wired down") + pages("Pages occupied by compressor")) * page;
		return (total - used) / 2 ** 30;
	} catch {
		return undefined;
	}
}

/** Thinking does not load more weights, but it does fill context faster. */
function memoryNote(level: string): string | undefined {
	if (level === "off" || level === "minimal") return undefined;
	const free = freeGb();
	if (free === undefined || free > 12) return undefined;
	return (
		`Only ${free.toFixed(1)} GB free — thinking fills the context faster, ` +
		`and the KV cache grows with it. Consider off/low, or free some memory.`
	);
}

export default function thinkingLevelExtension(pi: ExtensionAPI) {
	const defaults = new Map(MODELS.map((m) => [m.id, m.defaultThinking]));
	let registeredFor: string | undefined;

	/**
	 * Re-register the provider with sampling matched to the current level.
	 *
	 * Qwen wants different sampling for thinking and instruct modes, and running
	 * thinking at instruct temperatures causes repetition loops. That used to be
	 * handled by having a separate model variant per mode; now the level changes
	 * live, so the sampling has to move with it. registerProvider takes effect
	 * immediately, and re-registering the same ids leaves the selection alone.
	 */
	const applySampling = (level: string, ctx?: { ui: { notify: Function } }) => {
		if (registeredFor === level) return;
		try {
			pi.registerProvider(PROVIDER, {
				baseUrl: BASE_URL,
				apiKey: "ollama",
				api: "openai-completions",
				models: MODELS.map((m) => toPiModel(m, level)),
			} as never);
			// A second Ollama on its own port, only when one is configured. Sampling
			// moves with the level here too, or switching model would silently leave
			// the wrong temperature behind.
			if (DFLASH_URL) {
				pi.registerProvider(DFLASH_PROVIDER, {
					baseUrl: DFLASH_URL,
					apiKey: "ollama",
					api: "openai-completions",
					models: DFLASH_MODELS.map((m) => toPiModel(m, level, { provider: DFLASH_PROVIDER, baseUrl: DFLASH_URL })),
				} as never);
			}
			registeredFor = level;
		} catch (e) {
			ctx?.ui.notify(`Could not update sampling for ${level}: ${String(e)}`, "warning");
		}
	};

	/**
	 * Apply the model's default at startup, not only when switching.
	 *
	 * model_select fires when you pick a model; it does not fire for the model
	 * a session opens with. So a machine whose settings name a default model
	 * started at pi's own DEFAULT_THINKING_LEVEL, "medium", regardless of what
	 * the roster asked for, and the footer said so. The roster's defaultThinking
	 * only took effect if you switched models by hand and back.
	 */
	pi.on("session_start", async (_event, ctx) => {
		if (!APPLY_DEFAULTS) return undefined;
		const want = ctx.model?.id ? defaults.get(ctx.model.id) : undefined;
		if (!want) return undefined;
		try {
			if (pi.getThinkingLevel() !== want) {
				pi.setThinkingLevel(want as never);
				applySampling(want, ctx);
			}
		} catch {
			/* a level is a convenience, never a reason to fail a session start */
		}
		return undefined;
	});

	// Each tier has a level it is meant for; without this the level simply
	// carries over from whatever model you were on before.
	pi.on("model_select", async (event, ctx) => {
		if (!APPLY_DEFAULTS) return;
		const id = (event as { model?: { id?: string } }).model?.id ?? ctx.model?.id;
		const want = id ? defaults.get(id) : undefined;
		if (!want) return;
		try {
			if (pi.getThinkingLevel() === want) return;
			pi.setThinkingLevel(want as never);
			applySampling(want, ctx);
			ctx.ui.notify(`Thinking set to ${want} for ${id} (Shift+Tab to change).`, "info");
		} catch {
			/* the level is a convenience, never a reason to fail a model switch */
		}
	});

	// Say what a change costs, and warn when the machine cannot afford it.
	pi.on("thinking_level_select", async (event, ctx) => {
		const level = String((event as { level?: string }).level ?? pi.getThinkingLevel());
		applySampling(level, ctx);
		const note = memoryNote(level);
		ctx.ui.notify(
			[`Thinking: ${level}`, COST[level] ? `  ${COST[level]}` : "", note ? `  ${note}` : ""]
				.filter(Boolean)
				.join("\n"),
			note ? "warning" : "info",
		);
	});

	pi.registerCommand("effort", {
		description: "Show or set thinking level (off | low | medium | high)",
		getArgumentCompletions: (prefix: string) =>
			["off", "low", "medium", "high"]
				.filter((l) => l.startsWith(prefix.trim()))
				.map((l) => ({ value: l, label: l })),
		handler: async (args, ctx) => {
			const want = (args ?? "").trim().toLowerCase();
			const current = pi.getThinkingLevel();
			if (!want) {
				const note = memoryNote(String(current));
				ctx.ui.notify(
					[
						`Thinking: ${current}`,
						COST[String(current)] ? `  ${COST[String(current)]}` : "",
						note ? `  ${note}` : "",
						"  Shift+Tab cycles; /effort <level> sets it directly.",
					]
						.filter(Boolean)
						.join("\n"),
					"info",
				);
				return;
			}
			if (!["off", "minimal", "low", "medium", "high"].includes(want)) {
				ctx.ui.notify(`Unknown level "${want}". Use off, low, medium or high.`, "error");
				return;
			}
			try {
				pi.setThinkingLevel(want as never);
				applySampling(want, ctx);
				const note = memoryNote(want);
				ctx.ui.notify(
					[`Thinking: ${want}`, COST[want] ? `  ${COST[want]}` : "", note ? `  ${note}` : ""]
						.filter(Boolean)
						.join("\n"),
					note ? "warning" : "info",
				);
			} catch (e) {
				ctx.ui.notify(`Could not set thinking level: ${String(e)}`, "error");
			}
		},
	});
}
