/**
 * ollama-local — register the local Ollama models as a pi provider.
 *
 * The roster lives in ../lib/ollama-models.ts so memory-guard can reason about
 * the same models when deciding what fits.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BASE_URL, DFLASH_MODELS, DFLASH_PROVIDER, DFLASH_URL, MODELS, PROVIDER, toPiModel } from "../lib/ollama-models.ts";

export default function ollamaLocalExtension(pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER, {
		baseUrl: BASE_URL,
		apiKey: "ollama",
		api: "openai-completions",
		models: MODELS.map(toPiModel),
	});

	// A second Ollama on its own port, when one is configured. Registered HERE,
	// at load, and not only in thinking-level's applySampling: that runs from
	// session_start behind `if (pi.getThinkingLevel() !== want)`, so on a session
	// that already opens at the roster's default level it never fires at all, and
	// the provider silently never appears in /model. The main provider was always
	// registered here; the second one has to be too.
	if (DFLASH_URL) {
		pi.registerProvider(DFLASH_PROVIDER, {
			baseUrl: DFLASH_URL,
			apiKey: "ollama",
			api: "openai-completions",
			models: DFLASH_MODELS.map(toPiModel),
		});
	}
}
