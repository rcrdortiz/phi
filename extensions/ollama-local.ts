/**
 * ollama-local — register the local Ollama models as a pi provider.
 *
 * The roster lives in ../lib/ollama-models.ts so memory-guard can reason about
 * the same models when deciding what fits.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BASE_URL, MODELS, PROVIDER, toPiModel } from "../lib/ollama-models.ts";

export default function ollamaLocalExtension(pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER, {
		baseUrl: BASE_URL,
		apiKey: "ollama",
		api: "openai-completions",
		models: MODELS.map(toPiModel),
	});

}
