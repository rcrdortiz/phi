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

/** pi's own reserve: it compacts above contextWindow - RESERVE. */
const RESERVE = Number(process.env.PI_RESERVE_TOKENS ?? 16384);
/** pi keeps this much recent conversation; below it there is nothing older to
 *  summarise, and a request returns "Nothing to compact (session too small)". */
const KEEP_RECENT = Number(process.env.PI_KEEP_RECENT_TOKENS ?? 20000);

export interface CompactableContext {
	getContextUsage?: () => { tokens: number | null; contextWindow: number } | undefined;
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

/** Outcomes that mean "no compaction was needed", not "something went wrong".
 *  Reporting these as failures is pure noise: the context is small, which is
 *  the goal. "Already compacted" shows up when pi's own automatic compaction
 *  got there first. */
function isBenign(message: string): boolean {
	return /nothing to compact|too small|aborted|already compacted/i.test(message);
}

export function compactionBusy(): boolean {
	return inFlight;
}

/**
 * Track pi's OWN compactions as well as ours.
 *
 * pi compacts automatically when it approaches the window, and it does not tell
 * this lock. Without these hooks an extension can request a compaction moments
 * after pi already ran one, which fails with "Already compacted" — visible in a
 * session as an error and a warning for something that is not a problem.
 *
 * Call once from a single extension; the hooks update the shared state.
 */
export function trackExternalCompactions(pi: {
	on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown) => void;
}): void {
	pi.on("session_before_compact", async () => {
		inFlight = true;
		return undefined;
	});
	pi.on("session_compact", async () => {
		inFlight = false;
		lastAt = Date.now();
		return undefined;
	});
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

	// If usage is already at or above pi's own trigger, pi is compacting — or is
	// about to, or is in overflow recovery. Asking now lands in the middle of
	// that and comes back as "Already compacted" after "This operation was
	// aborted". Our compactions are an optimisation; when pi has taken over,
	// stand down.
	const usage = ctx.getContextUsage?.();
	if (usage?.tokens && usage.contextWindow) {
		// pi has taken over: it is compacting, about to, or in overflow recovery.
		if (usage.tokens >= usage.contextWindow - RESERVE) return false;
		// Too small to have anything to compact. A short task genuinely does not
		// need one, and asking produces an error for a session that is fine.
		if (usage.tokens <= KEEP_RECENT * 1.2) return false;
	}

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
