/**
 * Turning characters into tokens, well enough to budget with.
 *
 * Lives here rather than in tool-budget because three extensions now need it:
 * the budget itself, the notes report, and the usage log. A shared estimate in
 * one place is also the only way the numbers those three print can agree.
 */

/**
 * Characters per token, by what the tool actually returns.
 *
 * One number cannot do this job. Measured against the model's own tokenizer,
 * each sample sent once and twice so the chat template's fixed overhead cancels:
 *
 *   English prose   5.60      TS source       3.57
 *   Markdown        3.51      JS source       3.38
 *   JSON            2.01      Command output  2.00
 *
 * The single 3.6 this replaces was taken from a transcript of mixed code and
 * prose, which is fair for a file read and badly wrong for everything a shell
 * prints. Command output packs nearly twice the tokens per character, so a bash
 * result was being sized as though it cost 45% of what it really cost, and
 * tool-budget exists precisely to stop one result eating the window.
 *
 * The budget errs dense on purpose: under-counting tokens overruns the window,
 * while over-counting only truncates a little early, and those are not equally
 * bad. Anything not named here gets the source-code figure.
 */
const CHARS_PER_TOKEN_BASH = Number(process.env.PI_CHARS_PER_TOKEN_BASH ?? 2.0);
const CHARS_PER_TOKEN_TEXT = Number(process.env.PI_CHARS_PER_TOKEN ?? 3.4);

/** Tools whose output is shell-shaped: listings, logs, JSON, diffs. */
const DENSE_TOOLS = new Set(["bash", "ls", "grep", "find"]);

export function charsPerToken(toolName?: string): number {
	return toolName && DENSE_TOOLS.has(toolName) ? CHARS_PER_TOKEN_BASH : CHARS_PER_TOKEN_TEXT;
}

