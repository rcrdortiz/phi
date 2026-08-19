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
	/**
	 * Qwen3.8 thinks by DEFAULT. `reasoning: false` only stops pi asking for
	 * thinking — it does not tell Ollama to switch it off, so a "fast" model
	 * still burns hundreds of tokens deliberating. Measured on Ollama's
	 * OpenAI-compatible endpoint, `reasoning_effort` is the only thing that
	 * works: "none" produced 3 completion tokens where the default produced 39.
	 * Any other value enables thinking.
	 */
	reasoningEffort: "none" | "low" | "medium" | "high";
}

export const MODELS: LocalModel[] = [
	{
		id: "qwen3-coder:30b",
		name: "Qwen3 Coder 30B (MoE — fastest)",
		reasoning: false,
		contextWindow: 65536,
		maxTokens: 16384,
		weightsGb: 18,
		reasoningEffort: "none",
	},
	{
		id: "qwen3.8-fast",
		name: "Qwen3.8 27B fast (4-bit MLX)",
		reasoning: false,
		contextWindow: 65536,
		maxTokens: 16384,
		weightsGb: 18,
		reasoningEffort: "none",
	},
	{
		id: "qwen3.8-medium",
		name: "Qwen3.8 27B medium (thinking)",
		reasoning: true,
		contextWindow: 65536,
		maxTokens: 16384,
		weightsGb: 18,
		reasoningEffort: "medium",
	},
	{
		id: "qwen3.8-reasoning",
		name: "Qwen3.8 27B reasoning (8-bit — needs the machine to itself)",
		reasoning: true,
		contextWindow: 65536,
		maxTokens: 16384,
		weightsGb: 31,
		reasoningEffort: "high",
	},
];

/** Shape pi expects from registerProvider / setModel. */
export function toPiModel(m: LocalModel) {
	return {
		id: m.id,
		name: m.name,
		api: "openai-completions" as const,
		provider: PROVIDER,
		baseUrl: BASE_URL,
		reasoning: m.reasoning,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
		// Sent with every request; this is what actually controls thinking.
		samplingParams: { reasoning_effort: m.reasoningEffort },
	};
}
