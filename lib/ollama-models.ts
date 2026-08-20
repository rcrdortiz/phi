/**
 * The local model roster, in one place.
 *
 * ollama-local.ts registers these as a provider; memory-guard.ts uses the same
 * list to work out which of them actually fit in the memory available right
 * now, and to switch to one. Defining them twice is how the two drift apart.
 *
 * contextWindow must match the `num_ctx` baked into the corresponding Ollama
 * variant, or pi will happily send more context than the model was loaded with.
 */

/**
 * Qwen publishes different sampling for thinking and instruct modes, and the
 * mismatch is not cosmetic: thinking at instruct temperatures drives repetition
 * loops. Since the thinking level is now changed live with Shift+Tab, sampling
 * has to follow it rather than being baked into a separate model variant.
 */
export const SAMPLING = {
	instruct: { temperature: 0.7, top_p: 0.8, top_k: 20, presence_penalty: 1.5 },
	thinking: { temperature: 1.0, top_p: 0.95, top_k: 20 },
} as const;

export function samplingFor(level: string) {
	return level === "off" || level === "minimal" ? SAMPLING.instruct : SAMPLING.thinking;
}

export const PROVIDER = "ollama-local";
export const BASE_URL = `${process.env.PI_OLLAMA_URL ?? "http://localhost:11434"}/v1`;

export interface LocalModel {
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
	/** Approximate weight size, used for the memory check. `ollama list` is
	 *  authoritative at runtime; this is the fallback when it cannot be read. */
	weightsGb: number;
	/** Whether the model accepts images. `ollama show` reports this as the
	 *  `vision` capability; only the Qwen3.8 variants have it. */
	vision: boolean;
	/**
	 * Where this model starts on pi's thinking scale. Shift+Tab cycles it live;
	 * this is only the default applied when the model is selected.
	 *
	 * `reasoning` is a capability flag, not a default: with it false pi clamps
	 * every level to "off", Shift+Tab becomes a no-op and the footer hides the
	 * indicator, so `thinkingLevelMap` is never consulted. Any model that can
	 * think needs it true, and starts where `defaultThinking` says.
	 *
	 * Qwen3.8 thinks by DEFAULT, so "off" is not the absence of a request. On
	 * Ollama's OpenAI-compatible endpoint `reasoning_effort` is the control that
	 * works: "none" produced 3 completion tokens where the default produced 39.
	 */
	defaultThinking: "off" | "low" | "medium" | "high";
}

export const MODELS: LocalModel[] = [
	{
		id: "qwen3-coder:30b",
		vision: false,
		name: "Qwen3 Coder 30B (MoE — fastest)",
		reasoning: false,
		contextWindow: 65536,
		maxTokens: 16384,
		weightsGb: 18,
		defaultThinking: "off",
	},
	{
		id: "qwen3.8-4MLX",
		vision: true,
		name: "Qwen3.8 27B — 4-bit MLX",
		reasoning: true,
		contextWindow: 51200,
		maxTokens: 16384,
		weightsGb: 18,
		defaultThinking: "off",
	},
	{
		id: "qwen3.8-8MLX",
		vision: true,
		name: "Qwen3.8 27B — 8-bit MLX (needs the machine to itself)",
		reasoning: true,
		contextWindow: 51200,
		maxTokens: 16384,
		weightsGb: 31,
		defaultThinking: "high",
	},
];

/** Shape pi expects from registerProvider / setModel. */
export function toPiModel(m: LocalModel, level?: string) {
	return {
		id: m.id,
		name: m.name,
		api: "openai-completions" as const,
		provider: PROVIDER,
		baseUrl: BASE_URL,
		reasoning: m.reasoning,
		// Qwen3.8 reports the `vision` capability; qwen3-coder does not, so this
		// follows the roster rather than being set for every local model.
		// Cost is ~1015 pixels per token, independent of file size or format,
		// so tool-budget caps images by DIMENSION. Compression saves nothing.
		input: (m.vision ? ["text", "image"] : ["text"]) as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
		// Wires pi's thinking scale to Ollama's reasoning_effort, so Shift+Tab
		// changes it live instead of it being fixed per model. A level mapped to
		// null is hidden from the cycle; xhigh and max only appear if mapped,
		// and Qwen3.8 has no distinct behaviour beyond high, so they are left out.
		// Sampling matched to the active thinking level, or the model's default.
		samplingParams: samplingFor(level ?? m.defaultThinking),
		thinkingLevelMap: {
			off: "none",
			minimal: "low",
			low: "low",
			medium: "medium",
			high: "high",
		},
	};
}
