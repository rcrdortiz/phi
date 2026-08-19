/**
 * One compaction at a time, shared by every extension that wants one.
 *
 * Two extensions independently deciding "context is too big" is how you get:
 *
 *   Context compacted (this session cannot start a fresh one).
 *   Error: This operation was aborted
 *   Error: Compaction failed: Nothing to compact (session too small)
 *
 * — plan-notes compacting at a step boundary while auto-handoff compacts on its
 * projection, the second one aborting the first and then failing on the remains.
 * Node caches this module, so the lock is shared across extensions.
 *
 * Also note what is NOT here: starting a fresh session. `newSession` exists on
 * ExtensionCommandContext only — slash-command handlers get it, tools and event
 * handlers do not. A true reset can therefore only be user-initiated (`/next`),
 * so everything automatic compacts instead.
 */

export interface CompactableContext {
	compact?: (options: {
		customInstructions?: string;
		onComplete?: (result: { summary: string; tokensBefore: number }) => void;
		onError?: (error: Error) => void;
	}) => void;
	ui: { notify: (message: string, level?: "info" | "warning" | "error") => void };
}

let inFlight = false;
let lastAt = 0;

/** Compactions closer together than this are the double-fire we are preventing. */
const MIN_GAP_MS = 20_000;

/** "Nothing to compact" is a normal outcome, not a failure worth reporting. */
function isBenign(message: string): boolean {
	return /nothing to compact|too small|aborted/i.test(message);
}

export function compactionBusy(): boolean {
	return inFlight;
}

/** Clear the shared state. For tests: the lock is a module-level singleton by
 *  design, so independent cases in one process would otherwise block each other. */
export function resetCompactionState(): void {
	inFlight = false;
	lastAt = 0;
}

/**
 * Request a compaction. Returns false if one is already running, one finished
 * moments ago, or the context cannot compact at all.
 */
export function requestCompaction(
	ctx: CompactableContext,
	reason: string,
	options: {
		instructions?: string;
		onSummary?: (summary: string, tokensBefore: number) => void;
		announce?: boolean;
	} = {},
): boolean {
	if (inFlight) return false;
	if (Date.now() - lastAt < MIN_GAP_MS) return false;
	if (typeof ctx.compact !== "function") return false;

	inFlight = true;
	if (options.announce !== false) ctx.ui.notify(`${reason} — compacting.`, "info");

	try {
		ctx.compact({
			customInstructions: options.instructions,
			onComplete: (result) => {
				inFlight = false;
				lastAt = Date.now();
				try {
					options.onSummary?.(result.summary, result.tokensBefore);
				} catch {
					/* writing the summary out is best-effort */
				}
			},
			onError: (err) => {
				inFlight = false;
				lastAt = Date.now();
				if (!isBenign(err.message)) ctx.ui.notify(`Compaction failed: ${err.message}`, "warning");
			},
		});
	} catch (e) {
		inFlight = false;
		if (!isBenign(String(e))) ctx.ui.notify(`Compaction failed: ${String(e)}`, "warning");
		return false;
	}
	return true;
}
