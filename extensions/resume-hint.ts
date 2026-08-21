/**
 * resume-hint — make the line pi prints on the way out actually work.
 *
 * Quitting a fullscreen session prints "To resume this session: pi --session
 * <id>". Under phi that command fails. Sessions live under the agent directory,
 * which for phi is ~/.phi, and plain `pi` looks in ~/.pi and finds nothing. The
 * name is wrong and so is the advice.
 *
 * The name comes from APP_NAME, which pi reads from its own package.json at
 * import time. Changing it would rename the whole app: the agent directory
 * environment variable along with it, for the single global install that plain
 * `pi` also uses. That is not a trade worth making for one line.
 *
 * There is no hook either. The line is written after extensions are disposed,
 * so session_shutdown has already been and gone by the time it appears.
 *
 * What is left is rewriting the write. It is a blunt instrument and it is used
 * as narrowly as possible: one exact label, one leading word, and the original
 * text returned untouched for everything else. The alternative is printing a
 * command that does not work every time someone quits.
 *
 * Env: PHI_RESUME_HINT=0  leave pi's line alone
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ENABLED = process.env.PHI_RESUME_HINT !== "0";
const LABEL = "To resume this session:";

/**
 * Rewrite the resume line, and only that line.
 *
 * The label may be wrapped in ANSI dim, so the command is found by looking for
 * `pi` as a standalone word after the label rather than by parsing the line.
 */
export function rewriteResumeHint(text: string, command = "phi"): string {
	if (!text.includes(LABEL)) return text;
	// Only a bare `pi` immediately before its arguments. A path, a longer word,
	// or the id itself must not be touched.
	return text.replace(/(\s)pi(\s+-)/, `$1${command}$2`);
}

export default function resumeHint(pi: ExtensionAPI): void {
	if (!ENABLED) return;

	pi.on("session_start", async (_event, ctx) => {
		if ((ctx as unknown as ExtensionContext).mode !== "tui") return undefined;
		const out = process.stdout;
		const original = out.write.bind(out);
		// Never restored. The only write this touches happens during exit, after
		// every extension has been disposed, so there is no later point at which
		// putting it back would be anything but a way to miss the line.
		out.write = ((chunk: unknown, ...rest: unknown[]) => {
			if (typeof chunk === "string") {
				const rewritten = rewriteResumeHint(chunk);
				if (rewritten !== chunk) return (original as (...a: unknown[]) => boolean)(rewritten, ...rest);
			}
			return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
		}) as typeof out.write;
		return undefined;
	});
}
