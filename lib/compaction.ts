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

/**
 * pi's compaction numbers, mirrored from settings.json `compaction`.
 *
 * These are FRACTIONS of the context window, not fixed token counts, and that
 * is the whole point. pi's defaults (16384 reserve, 20000 keepRecent) are sized
 * for a 128K+ window. Drop the window to 32K and they stop making sense:
 * the reserve becomes 50% of the window, and keepRecent (20000) lands ABOVE the
 * compaction trigger (32768 - 16384 = 16384). Every branch below then returns
 * false, so extension-initiated compaction silently stops happening at exactly
 * the window size where it matters most.
 *
 * Deriving from the window means changing num_ctx does not require remembering
 * to change two more numbers somewhere else.
 */
const KEEP_RECENT_FRACTION = 0.35;

/**
 * Our watchdog fires BELOW pi's own trigger, and that gap is load-bearing.
 *
 * pi checks at agent_end; we check at turn_end, which also fires inside a long
 * run. Set both to the same threshold and a turn_end and an agent_end that land
 * close together produce two compactions: one succeeds and the other returns
 * "Already compacted", with "This operation was aborted" in front of it. The
 * shared lock cannot prevent that, because it does not know about pi's.
 *
 * So we take the lower threshold and act first, and pi becomes the backstop for
 * the case we cannot see. In a long run the context never reaches pi's mark.
 *
 * For reference, decode speed on qwen3.8-4MLX measured cold and idle:
 *
 *      28 tok  47.2 tok/s      17,802  17.1 tok/s
 *   4,471      45.1            35,582  19.3
 *   8,911      39.2            53,362  15.1
 *
 * The cliff is between 9K and 18K. A high trigger buys window at roughly a
 * third of the speed; that is a real trade, and PI_COMPACT_AT_TOKENS is where
 * it is made.
 */
const WATCHDOG_FRACTION = 0.7;
const PI_TRIGGER_FRACTION = 0.75;

function fromEnvOr(name: string, contextWindow: number, fraction: number): number {
	const raw = Number(process.env[name]);
	if (Number.isFinite(raw) && raw > 0) return raw;
	return Math.round(contextWindow * fraction);
}

/** The depth at which compaction should fire. Env: PI_COMPACT_AT_TOKENS. */
export function compactAtTokens(contextWindow: number): number {
	const raw = Number(process.env.PI_COMPACT_AT_TOKENS);
	if (Number.isFinite(raw) && raw > 0) return raw;
	return Math.round(contextWindow * WATCHDOG_FRACTION);
}

/** pi compacts above contextWindow - this. Env: PI_RESERVE_TOKENS. */
export function reserveTokens(contextWindow: number): number {
	const raw = Number(process.env.PI_RESERVE_TOKENS);
	if (Number.isFinite(raw) && raw > 0) return raw;
	// pi's reserve, deliberately above our own trigger so it only ever acts on
	// what we missed.
	return Math.round(contextWindow * (1 - PI_TRIGGER_FRACTION));
}

/** pi keeps this much recent conversation; below it there is nothing older to
 *  summarise, and a request returns "Nothing to compact (session too small)".
 *  Env: PI_KEEP_RECENT_TOKENS. */
export function keepRecentTokens(contextWindow: number): number {
	const raw = Number(process.env.PI_KEEP_RECENT_TOKENS);
	if (Number.isFinite(raw) && raw > 0) return raw;
	// Derived from the TRIGGER, not the window. Deriving it from the window is
	// how it ends up larger than the trigger itself, at which point there is
	// never anything older to summarise and compaction silently stops happening.
	return Math.round(compactAtTokens(contextWindow) * KEEP_RECENT_FRACTION);
}

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

/**
 * Context size at the last compaction, so we can measure NEW content.
 *
 * pi's prepareCompaction does not look at how big the context is. It walks back
 * from the newest entry accumulating tokens until it passes keepRecentTokens,
 * and summarises whatever is left BEFORE that point — but only back as far as
 * the previous compaction. If the span since that compaction is itself smaller
 * than keepRecentTokens, the cut lands on the first entry, there is nothing
 * before it, and the request comes back "Nothing to compact (session too
 * small)".
 *
 * So the quantity that decides whether a compaction is possible is tokens SINCE
 * THE LAST COMPACTION, not total context. Those two are the same number only
 * until the first compaction; after that, most of the context is the summary
 * plus the recent tail that would be kept anyway. Guarding on the total is what
 * made a step boundary ask for a compaction that could not succeed.
 */
let baseline = 0;
let baselineStale = false;

/**
 * Smallest context reading seen this session — effectively the system prompt.
 *
 * pi's keepRecentTokens is measured over SESSION MESSAGES. getContextUsage
 * reports the whole context, which also carries the system prompt: pi's base
 * instructions, the tool schemas, and plan-notes' briefing. On this setup that
 * floor is several thousand tokens, so a 12,000-token context can hold only
 * ~6,000 of messages — at which point pi walks back, hits keepRecentTokens
 * before it runs out of messages, and answers "Nothing to compact (session too
 * small)" for a session that looks two-thirds full.
 *
 * Subtracting the floor turns the reading into something comparable with the
 * number pi actually uses. It is observed rather than configured because it
 * varies with the briefing, which grows and shrinks as the plan does.
 */
let sessionFloor = Number.POSITIVE_INFINITY;

/** Record a context reading. Call on every turn, not only when acting. */
export function observeContext(tokens: number): void {
	if (tokens > 0 && tokens < sessionFloor) sessionFloor = tokens;
}

/** Compactions closer together than this are the double-fire we are preventing.
 *  Tunable because a fast plan step can legitimately finish inside the window,
 *  and because a fixed 20s makes the behaviour untestable without sleeping. */
const MIN_GAP_MS = Number(process.env.PI_COMPACT_MIN_GAP_MS ?? 20_000);

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

/** Whether a compaction finished within `ms`. The abort it caused surfaces a
 *  moment later, so "busy" alone does not cover the whole window. */
export function recentlyCompacted(ms: number): boolean {
	return lastAt > 0 && Date.now() - lastAt < ms;
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
		// Usage right after a compaction is not reliably readable, so the next
		// reading becomes the new baseline instead.
		baselineStale = true;
		return undefined;
	});
}

/** Clear the shared state. For tests: the lock is a module-level singleton by
 *  design, so independent cases in one process would otherwise block each other. */
export function resetCompactionState(): void {
	inFlight = false;
	lastAt = 0;
	baseline = 0;
	baselineStale = false;
	sessionFloor = Number.POSITIVE_INFINITY;
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
		/** Runs after the compaction settles, successfully or not. A caller that
		 *  continues unattended work must use this rather than onSummary: a
		 *  compaction that fails is not a reason to stop, and hanging the run on
		 *  it turns a cosmetic error into a stalled session. */
		onDone?: () => void;
		/** Compact even when usage is already past pi's own trigger.
		 *
		 * The normal guard assumes that above `contextWindow - reserve` pi has
		 * taken over. That holds between runs, because pi checks at agent_end and
		 * before prompt submission — and NOT during one. A long agentic run with
		 * dozens of tool calls never reaches either point, so usage climbs past
		 * the trigger with nothing watching. Observed at 96.3% of a 51K window.
		 *
		 * Only the mid-run watchdog sets this; everything else should still stand
		 * down when pi is genuinely about to act. */
		force?: boolean;
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
		// Deliberately NOT observing here. The floor has to be sampled while the
		// session is small, and this function only runs when it is not — a call
		// that observed its own reading would set the floor to the very number it
		// is judging, making `since` zero and refusing every time.
		// The first reading after a compaction establishes the new baseline.
		// Refusing this one costs nothing: we just compacted.
		if (baselineStale) {
			baseline = usage.tokens;
			baselineStale = false;
			return false;
		}
		// Past the window entirely, pi really has taken over: it is in overflow
		// recovery, which owns the session until it finishes. `force` does not
		// apply here — this is the one case where standing down is correct
		// whoever is asking, and asking anyway is what produced "This operation
		// was aborted" followed by a failed compaction.
		if (usage.tokens >= usage.contextWindow) return false;
		// Past the trigger, pi will act at agent_end — but not during a run, and
		// not for an explicit request. That is what `force` is for.
		if (!options.force && usage.tokens >= usage.contextWindow - reserveTokens(usage.contextWindow))
			return false;
		// Nothing has accumulated since the last compaction that pi would not
		// keep anyway, so there is no older history to summarise. Asking here is
		// what produces "Nothing to compact (session too small)".
		//
		// Measured against the session floor before the first compaction, so the
		// system prompt is not counted as summarisable history.
		// No floor observed yet — a --print run, or a caller that reaches this
		// before any turn has ended — means we cannot separate prompt from
		// messages. Fall back to counting everything, which can only make us ask
		// when we might not have needed to. Falling back to `usage.tokens`
		// instead would make `since` zero and silently disable compaction.
		const base = baseline > 0 ? baseline : Number.isFinite(sessionFloor) ? Math.min(sessionFloor, usage.tokens) : 0;
		const since = usage.tokens - base;
		// 1.5 rather than a hair over 1.0, because pi cuts at a message boundary
		// and not at an exact token count: it walks back to keepRecentTokens and
		// then rounds to the nearest cut point, which can swallow the little that
		// was left. Asking with a thin margin is how "Nothing to compact" gets
		// reported for a session that arithmetically had something.
		if (since <= keepRecentTokens(usage.contextWindow) * 1.5) return false;
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
				options.onDone?.();
			},
			onError: (err) => {
				inFlight = false;
				lastAt = Date.now();
				if (!isBenign(err.message)) ctx.ui.notify(`Compaction failed: ${err.message}`, "warning");
				options.onDone?.();
			},
		});
	} catch (e) {
		inFlight = false;
		if (!isBenign(String(e))) ctx.ui.notify(`Compaction failed: ${String(e)}`, "warning");
		options.onDone?.();
		return false;
	}
	return true;
}
