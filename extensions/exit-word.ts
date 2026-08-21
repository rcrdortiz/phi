/**
 * exit-word — treat a bare "exit" as a command, not as something to answer.
 *
 * Every shell, REPL and database client in the terminal quits on `exit`, so
 * that is what fingers type. Sending it to the model instead costs a full
 * request, a wait, and a reply explaining that it cannot quit for you. On a
 * local model at 15 tok/s that wait is long enough to be annoying.
 *
 * Only a bare word counts. "exit" alone is an instruction to the app, while
 * "exit the loop early" is a sentence about code, and the difference has to
 * stay visible or the extension eats real prompts. Anything with a second word,
 * or with an image attached, is passed straight through.
 *
 * Env: PI_EXIT_WORD=0  disable, and send these words to the model like any other
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ENABLED = process.env.PI_EXIT_WORD !== "0";

/** Bare words that mean "close the app", including the vim reflex. */
const WORDS = new Set(["exit", "quit", ":q", ":q!", ":wq"]);

/** True when the input is one of the words and nothing else. */
export function isExitWord(text: string, hasImages = false): boolean {
	if (hasImages) return false;
	return WORDS.has(text.trim().toLowerCase());
}

export default function exitWord(pi: ExtensionAPI): void {
	if (!ENABLED) return;

	pi.on("input", async (event, ctx) => {
		if (!isExitWord(event.text, (event.images?.length ?? 0) > 0)) {
			return { action: "continue" as const };
		}
		const c = ctx as unknown as ExtensionContext;
		// shutdown() is graceful: it lets pi flush the session to disk rather
		// than dropping the transcript, which process.exit() would.
		c.actions.shutdown();
		return { action: "handled" as const };
	});
}
