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

import * as fs from "node:fs";
import * as path from "node:path";

import { STATE_DIR } from "./state-dir.ts";

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
/**
 * How much recent conversation survives a compaction.
 *
 * A fixed count, not a fraction of the trigger, and that is a correction. It
 * began as 35% of a 28,000 trigger, which quietly made it scale: raising the
 * trigger to hold more work would also have raised how much is kept, cancelling
 * out most of the gain. It answers a different question anyway, one about
 * continuity rather than depth. How much of the immediate past does the model
 * need to carry on coherently, given the summary already carries the rest?
 * 9,800 tokens is a few turns of real work and does not change because the
 * session is allowed to run deeper before compacting.
 *
 * It must also match settings.json, since pi is what enforces it. See
 * keepRecentTokens, which reads back what pi will really do.
 */
const KEEP_RECENT_TOKENS = Number(process.env.PI_KEEP_RECENT_RECOMMENDED ?? 9800);

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
// Capped in ABSOLUTE tokens, not just as a fraction, because the ceiling is not
// about the window at all — it is about how long a cache miss takes to recover.
//
// pi's HTTP idle timeout maxes out at 300s (the only larger choice is
// "disabled"). Prefill runs ~120 tok/s at depth, so a miss above roughly 36,000
// tokens cannot finish before the connection is judged idle. Ollama then logs
// `500` and `Request terminated: context canceled`, and pi reports "Request
// timed out" — which is what a 57,344 trigger produced.
//
// Misses are not rare at depth either: the server log carries
// `failed to restore cache, freeing all caches` at offsets 5,600 / 21,723 /
// 31,097, each one turning the next request into a full re-prefill.
//
// 28,000 leaves the worst case around 233s, roughly 67s inside the timeout.
//
// Set at the TOP of the usable band rather than the bottom, because decode is
// flat across it: 17 tok/s at 18K, 22 at 27K, 19 at 36K. Compacting sooner buys
// no speed. The genuinely fast zone is below ~9K, and post-compaction context is
// floor + summary + keepRecent, about 14K, so that zone is out of reach whatever
// this is set to.
//
// The lower wall is thrash. Below ~16K the headroom between post-compaction and
// the trigger drops under a few thousand tokens, so a session compacts almost
// every turn and pays a full re-prefill each time — slower than simply running
// deeper. That is the wrong end of the trade, not the safe one.
/** Share of the prefill ceiling the working depth may use. See compactAtTokens. */
const CEILING_FRACTION = Number(process.env.PI_CEILING_FRACTION ?? 0.7);

/**
 * The deepest phi will run before compacting, whatever the window allows.
 *
 * Was 36,000, justified by a "decode cliff" that does not exist. Measured
 * 2026-08-23 with 400-token samples: 55.0 tok/s at 3,610 tokens and 32.4 tok/s
 * at 37,000. That is a smooth 41% decline across ten times the depth, exactly
 * what reading a linearly growing KV cache predicts, with no knee anywhere. An
 * earlier sweep suggested a cliff, but it sampled 60 tokens per point, which is
 * under two seconds of decoding and mostly measures startup.
 *
 * So this is a time-versus-context preference, not a safety limit. 45,000 lets
 * the window fraction bind instead (70% of 65,536 is 45,875), buying 25% more
 * context between compactions for roughly 10% slower decode in the deeper
 * range. A cold re-prefill of 45,000 tokens at the measured 215 tok/s is 209
 * seconds, comfortably inside a 500s idle timeout.
 *
 * The constraint that does bite is memory, and it is not settled: KV cost is
 * somewhere between 111 KB/token (phi's old figure) and about 320, and at the
 * high end two concurrent sessions both running this deep would exceed a 48 GB
 * machine's wired limit. One session at this depth is fine either way. Watch
 * /doctor for evictions if two sessions run deep at once.
 */
const MAX_SAFE_DEPTH = Number(process.env.PI_MAX_SAFE_DEPTH ?? 45000);

/**
 * Whether compaction may interrupt a turn that is still running.
 *
 * Not in `--print`. Compaction aborts the turn it fires in, and a print run is
 * one turn: runPrintMode awaits a single session.prompt(), and the moment that
 * resolves, aborted or not, it reads the last message and returns. The resume
 * that repairs an interrupted turn is a NEW turn issued from onDone, and the
 * process is already leaving by then. Measured on quill: the run compacted at
 * 32,647 tokens, the turn aborted, the error was rewritten to a clean stop, and
 * it exited having edited nothing, with one user message in the whole session.
 *
 * Standing down means running deeper, which is survivable and measured: pi
 * reached 61,373 tokens on the same task and scored better than every phi run.
 * Losing the run is not survivable. Interactive sessions are unaffected, since
 * there the resume lands and this has always worked.
 *
 * Env: PI_PRINT_COMPACT=1 restores it, for testing the resume path itself.
 */
export function midRunCompactionAllowed(): boolean {
	if (process.env.PI_PRINT_COMPACT === "1") return true;
	return !(process.argv.includes("--print") || process.argv.includes("-p"));
}

/**
 * How much of the trigger a single turn's growth may claim back.
 *
 * The trigger is only checked at turn_end, because that is the one boundary
 * where no tool call is half-finished. A single agentic turn can span a dozen
 * model round-trips, so depth does not stop at the trigger: measured live, a
 * run crossed a 36,000 trigger at 37,560 and did not reach turn_end until
 * 53,097, seventeen thousand tokens deeper. Nothing failed, but the margin the
 * trigger exists to protect was mostly gone.
 *
 * So the trigger fires early by whatever the worst turn has been shown to add.
 * Capped, because a single enormous turn must not collapse the trigger to
 * nothing: a session that compacts every turn re-prefills every turn, which is
 * slower than simply running deeper.
 */
const MAX_OVERSHOOT_SHARE = Number(process.env.PI_MAX_OVERSHOOT_SHARE ?? 0.4);

let maxTurnGrowth = 0;
let lastObserved: number | undefined;

/** The largest growth seen between two consecutive turn_end observations. */
export function observedTurnGrowth(): number {
	return maxTurnGrowth;
}

/** How far below the hard bound the trigger sits, given what turns have cost. */
export function overshootAllowance(base: number): number {
	if (maxTurnGrowth <= 0) return 0;
	return Math.min(maxTurnGrowth, Math.round(base * MAX_OVERSHOOT_SHARE));
}

/** Test seam. A session learns this from scratch; nothing else resets it. */
export function resetTurnGrowth(): void {
	maxTurnGrowth = 0;
	lastObserved = undefined;
}
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
	// Three bounds, and the session runs to the lowest.
	//
	// The window itself, obviously. A fixed depth, because past the decode cliff
	// deeper is slower and the cliff does not move with the window. And the
	// prefill ceiling, which is the one that used to be missing: a trigger above
	// the depth a cache miss can recover from is a guaranteed `Request timed
	// out`, and the ceiling depends on a setting, so a literal trigger and a
	// changed timeout drift apart silently. That is how 36,000 came to sit above
	// a 34,500 ceiling on a default 300s install.
	//
	// 0.7 of the ceiling rather than all of it: at 36,000 a miss measured 335s
	// against a 500s timeout, which is 67%, and the benchmark ran on an idle
	// machine. One that is being used for something else prefills slower.
	//
	// Then early by the worst turn's growth, because the check only happens at
	// turn_end and depth keeps climbing until it arrives. See MAX_OVERSHOOT_SHARE.
	const base = Math.min(
		Math.round(contextWindow * WATCHDOG_FRACTION),
		MAX_SAFE_DEPTH,
		Math.round(prefillCeiling() * CEILING_FRACTION),
	);
	return base - overshootAllowance(base);
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
/**
 * What pi will actually keep, which is not the same as what we would choose.
 *
 * This function decides whether asking for a compaction is worth it, so it has
 * to report pi's real behaviour. pi reads `compaction.keepRecentTokens` from
 * settings.json and falls back to 20000, a number sized for a 128K+ window. On
 * a 64K window that is most of the trigger, so a compaction reclaims almost
 * nothing: measured live, compacting at 31,126 tokens left about 29,500. The
 * session then sits permanently above the trigger, every turn asks for a
 * compaction that cannot help, and the next cache miss has 26,000 tokens to
 * re-prefill.
 *
 * recommendedKeepRecentTokens is what phi seeds into settings.json. Reading
 * back rather than assuming is the difference between the two.
 */
export function keepRecentTokens(contextWindow: number): number {
	const raw = Number(process.env.PI_KEEP_RECENT_TOKENS);
	if (Number.isFinite(raw) && raw > 0) return raw;
	const configured = Number(piSettings().compaction?.keepRecentTokens);
	if (Number.isFinite(configured) && configured > 0) return configured;
	return 20_000; // pi's default, and the number that breaks a small window
}

/**
 * What phi seeds into settings.json for a given window.
 *
 * Derived from the TRIGGER, not the window. Deriving it from the window is how
 * it ends up larger than the trigger itself, at which point there is never
 * anything older to summarise and compaction silently stops happening.
 */
export function recommendedKeepRecentTokens(_contextWindow?: number): number {
	return KEEP_RECENT_TOKENS;
}

export interface CompactableContext {
	getContextUsage?: () => { tokens: number | null; contextWindow: number } | undefined;
	compact?: (options: {
		customInstructions?: string;
		onComplete?: (result: { summary: string; tokensBefore: number }) => void;
		onError?: (error: Error) => void;
	}) => void;
	/** Current thinking level. Readable on the context; changing it is not. */
	thinkingLevel?: string;
	ui: {
		notify: (message: string, level?: "info" | "warning" | "error") => void;
		/** Footer chip, used for compaction progress. Absent outside the TUI. */
		setStatus?: (key: string, text: string | undefined) => void;
	};
	/** Where to remember how long compactions take. Absent in some contexts. */
	cwd?: string;
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
/**
 * Prefill rate at depth, measured on an M4 Max running the 4-bit MLX build.
 *
 * NOT flat, which an earlier version of this assumed. Measured on an idle
 * machine with the weights resident, forcing a cache miss each time:
 *
 *   12,193 tokens  165 tok/s      31,772 tokens  142 tok/s
 *   18,271 tokens  145 tok/s      39,698 tokens  119 tok/s
 *   24,344 tokens  136 tok/s      47,625 tokens  115 tok/s
 *
 * The deep-end figure is the one used, because the ceiling only matters at the
 * deep end and a rate taken from shallow context would flatter it. Idle, too:
 * a machine being used alongside the model prefills slower than this, which is
 * the normal case here and another reason not to run the number to its edge.
 */
/**
 * Cold prefill rate, measured rather than assumed.
 *
 * Was 115, which was wrong by nearly half and had been shaping the trigger ever
 * since. Re-measured 2026-08-23 against Ollama's own prompt_eval_count and
 * prompt_eval_duration, on a 16,438 token prompt it had never seen, so a true
 * cache miss rather than a warm hit: 214.8 tok/s. mlx-lm on the same hardware
 * and model family gave 218.8, which is close enough to rule out a runner
 * quirk.
 *
 * The original 115 was taken during the afternoon when Ollama's prefix cache
 * was thrashing, before we knew that two sessions were sharing one cache slot.
 * It was a measurement of a fault, not of the hardware.
 *
 * 180 rather than the measured 215: both figures come from an idle machine, and
 * the ceiling exists to protect a cache miss on a machine that is being used
 * for something else. A sixth off the measurement is the margin.
 *
 * On an install with a raised idle timeout this changes nothing, because the
 * 36,000 safe depth binds first. On a stock 300s install it moves the trigger
 * from 24,150 to 36,000.
 */
const PREFILL_TOKENS_PER_SECOND = Number(process.env.PI_PREFILL_TOKENS_PER_SECOND ?? 180);

/**
 * Depth beyond which a prefix-cache miss cannot finish prefilling in time.
 *
 * A miss has to re-prefill the whole context. If that takes longer than pi's
 * HTTP idle timeout the request is reported as `Request timed out` rather than
 * as a slow reply, and the user loses the turn. Misses do happen: the Ollama
 * log carries `failed to restore cache, freeing all caches`.
 *
 * Derived rather than hardcoded, because it is the product of two numbers that
 * both move. The timeout is a pi setting, and raising it genuinely raises the
 * ceiling; a hardcoded value silently stops matching the moment someone changes
 * it, and the failure that follows looks like a compaction bug rather than a
 * stale constant.
 */
export function prefillCeiling(): number {
	const override = Number(process.env.PI_PREFILL_CEILING_TOKENS);
	if (Number.isFinite(override) && override > 0) return override;
	const timeoutMs = httpIdleTimeoutMs();
	// 0 means the timeout is disabled, so nothing can be too deep to prefill.
	if (timeoutMs <= 0) return Number.POSITIVE_INFINITY;
	return Math.round((timeoutMs / 1000) * PREFILL_TOKENS_PER_SECOND);
}

/**
 * pi's configured HTTP idle timeout, in milliseconds.
 *
 * Read from the agent directory's settings rather than assumed, and cached: it
 * cannot change while the process runs, and this is consulted on every turn.
 */
type PiSettings = {
	httpIdleTimeoutMs?: number | string;
	compaction?: { keepRecentTokens?: number; reserveTokens?: number };
};

let cachedSettings: PiSettings | undefined;
function piSettings(): PiSettings {
	if (cachedSettings !== undefined) return cachedSettings;
	cachedSettings = {};
	const dir = process.env.PI_CODING_AGENT_DIR;
	if (dir) {
		try {
			cachedSettings = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")) as PiSettings;
		} catch {
			/* no settings file, or unreadable: pi's defaults stand */
		}
	}
	return cachedSettings;
}

export function httpIdleTimeoutMs(): number {
	const v = Number(piSettings().httpIdleTimeoutMs);
	return Number.isFinite(v) && v >= 0 ? v : 300_000; // pi's own default
}

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

/**
 * Record a context reading. Call on every turn, not only when acting.
 *
 * This is also where the post-compaction baseline is captured, and it has to be
 * here rather than in requestCompaction. requestCompaction is only reached once
 * usage is already past the trigger, so a baseline taken there records the
 * TRIGGER depth, not the depth compaction actually left behind. The `since`
 * margin then stacks on top of the trigger instead of on top of the floor, and
 * the next compaction is deferred by that much again: with a 64K window that
 * moved the real compaction depth from 28,000 to about 42,700, past the depth
 * where a prefix-cache miss can still prefill inside pi's idle timeout. The
 * symptom is not a missed compaction, it is `Request timed out` on the next
 * thing the user types.
 */
export function observeContext(tokens: number): void {
	if (tokens <= 0) return;
	// Growth between consecutive observations is one turn's cost. Only positive
	// steps count: the drop across a compaction is not something a turn spent.
	if (lastObserved !== undefined && tokens > lastObserved) {
		const grew = tokens - lastObserved;
		if (grew > maxTurnGrowth) maxTurnGrowth = grew;
	}
	lastObserved = tokens;
	if (tokens < sessionFloor) sessionFloor = tokens;
	if (baselineStale) {
		baseline = tokens;
		baselineStale = false;
	}
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

/**
 * A compaction that is coming but has not started.
 *
 * plan_next finishes a step and the compaction happens at the end of the turn,
 * not inside the tool call. The turn is aborted in between, and that abort
 * surfaced as a red "This operation was aborted" because the suppression window
 * only opened when the compaction actually began, a moment after the thing it
 * was supposed to cover.
 *
 * Recorded, not reasoned about: message-end.log had the abort at
 * 00:08:03.129 with busy false and recent false, four milliseconds after the
 * tool result and before any compaction existed to be busy with.
 *
 * Separate from inFlight on purpose. inFlight means "one is running, do not
 * start another"; making this set it would refuse the very compaction it is
 * announcing. This only says an abort in the next few seconds is ours.
 */
let expectingUntil = 0;

/** Arm the window. Called when a compaction is scheduled rather than started. */
export function expectCompaction(ms = 30_000): void {
	expectingUntil = Date.now() + ms;
}

/** Whether a compaction of ours is running, imminent, or moments past. */
export function compactionNearby(recentMs = 10_000): boolean {
	return inFlight || Date.now() < expectingUntil || recentlyCompacted(recentMs);
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
	expectingUntil = 0;
	cachedSettings = undefined;
	resetTurnGrowth();
}

// ---------------------------------------------------------------- progress

/** Footer chip key for compaction progress. */
/**
 * Thinking level for the summarisation call.
 *
 * pi passes the session's level to compact(), so at `high` the model
 * deliberates before writing the summary. Summarising a transcript is not a
 * reasoning task, and on a 27B at twenty tokens a second the deliberation is
 * the whole cost: measured live, a compaction spent 79s on prefill and then
 * roughly 380s generating, against a 500s timeout it was about to hit.
 *
 * `off`, not `low`. Summarising is reading something that already exists and
 * writing down what mattered, and whatever judgement that needs is the same
 * judgement the model makes while writing the summary itself. Deliberating
 * first buys nothing here and is charged at the decode rate, which on this
 * setup is the whole cost.
 *
 * Set to `keep` to inherit the session level.
 */
const COMPACT_THINKING = process.env.PI_COMPACT_THINKING ?? "off";

const PROGRESS_KEY = "phi-compacting";

/** How many past compactions the estimate averages over. */
const SAMPLES = 5;

/**
 * Durations of recent compactions, in milliseconds.
 *
 * Kept on disk beside the plan and notes, so the first compaction of a session
 * already has an estimate. Without that, the progress bar would be useless
 * exactly when a session is new and the wait is most surprising.
 */
function timesPath(cwd: string): string {
	return path.join(cwd, STATE_DIR, "compaction-times.json");
}

function readTimes(cwd: string | undefined): number[] {
	if (!cwd) return [];
	try {
		const raw = JSON.parse(fs.readFileSync(timesPath(cwd), "utf8")) as unknown;
		if (!Array.isArray(raw)) return [];
		return raw.filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n > 0).slice(-SAMPLES);
	} catch {
		return [];
	}
}

/**
 * Shortest duration worth remembering.
 *
 * A compaction is a model call on a large prompt; it cannot finish in
 * milliseconds. Anything that fast is a stub, a test, or a failure that
 * reported success, and recording it would make the next progress bar promise
 * an instant compaction.
 */
const MIN_SAMPLE_MS = 500;

export function recordCompactionMs(cwd: string | undefined, ms: number): void {
	if (!cwd || !Number.isFinite(ms) || ms < MIN_SAMPLE_MS) return;
	try {
		const next = [...readTimes(cwd), ms].slice(-SAMPLES);
		fs.mkdirSync(path.dirname(timesPath(cwd)), { recursive: true });
		fs.writeFileSync(timesPath(cwd), JSON.stringify(next));
	} catch {
		/* an estimate is a nicety; never fail a compaction over it */
	}
}

/** Mean of the recent samples, or undefined when there is nothing to go on. */
export function estimateMs(cwd: string | undefined): number | undefined {
	const times = readTimes(cwd);
	if (!times.length) return undefined;
	return Math.round(times.reduce((a, b) => a + b, 0) / times.length);
}

/**
 * The compaction progress label.
 *
 * Elapsed seconds always, because that is the number that answers "is this
 * stuck". The bar only appears once there is a previous compaction to compare
 * against, and it stops claiming to predict anything once the estimate is
 * passed: a bar pinned at full with the seconds still climbing is honest,
 * while one that keeps growing past the end is not.
 */
export function progressLabel(elapsedMs: number, estimate: number | undefined, width = 10): string {
	const secs = Math.max(0, Math.round(elapsedMs / 1000));
	if (!estimate) return `compacting ${secs}s`;
	const done = Math.min(1, elapsedMs / estimate);
	const filled = Math.round(done * width);
	const bar = "\u2588".repeat(filled) + "\u2591".repeat(width - filled);
	const target = Math.round(estimate / 1000);
	return elapsedMs >= estimate
		? `compacting ${bar} ${secs}s (over ${target}s)`
		: `compacting ${bar} ${secs}s / ~${target}s`;
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
		/**
		 * How to change the thinking level, used to keep the summarisation off
		 * the session's level.
		 *
		 * Passed in rather than read from the context, because it lives on the
		 * ExtensionAPI object and not on the context: `ctx.thinkingLevel` reads,
		 * `pi.setThinkingLevel` writes. Reaching for it on the context compiles
		 * through a cast and then silently does nothing, which is worse than not
		 * trying.
		 */
		setThinkingLevel?: (level: string) => void;
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
		// Fallback for a caller that never observes: observeContext normally
		// claims this first, at the post-compaction depth, which is the reading
		// that makes `since` mean what it says.
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
		// ...unless we are deep enough that the next prefix-cache miss cannot
		// prefill before pi calls the request idle. Past that point a compaction
		// that comes back "Nothing to compact" costs one cosmetic line, and NOT
		// compacting costs the user their next prompt with `Request timed out`.
		// The cheap failure wins.
		if (usage.tokens < prefillCeiling() && since <= keepRecentTokens(usage.contextWindow) * 1.5) return false;
	}

	inFlight = true;
	if (options.announce !== false) ctx.ui.notify(`${reason} — compacting.`, "info");

	// Compaction is a model call on a large prompt, so it takes as long as a
	// turn does. A spinner that says nothing about elapsed time is the same
	// problem the working indicator had: a slow compaction and a wedged one look
	// identical. The estimate comes from previous compactions in this project.
	const startedAt = Date.now();
	const estimate = estimateMs(ctx.cwd);
	const setStatus = ctx.ui.setStatus;
	let ticker: ReturnType<typeof setInterval> | undefined;
	if (setStatus) {
		setStatus(PROGRESS_KEY, progressLabel(0, estimate));
		ticker = setInterval(() => setStatus(PROGRESS_KEY, progressLabel(Date.now() - startedAt, estimate)), 1000);
		// A pending interval would keep node alive past the last turn.
		ticker.unref?.();
	}
	// Turn the thinking down for the summarisation, and put it back afterwards.
	// The level is a session-wide setting, so leaving it lowered would quietly
	// change every turn after a compaction.
	const priorThinking = ctx.thinkingLevel;
	const setThinking = options.setThinkingLevel;
	const canSetThinking =
		COMPACT_THINKING !== "keep" &&
		typeof setThinking === "function" &&
		typeof priorThinking === "string" &&
		priorThinking !== COMPACT_THINKING;
	if (canSetThinking) {
		try {
			setThinking?.(COMPACT_THINKING);
		} catch {
			/* a slower compaction is better than a failed one */
		}
	}

	const settle = () => {
		if (ticker) clearInterval(ticker);
		ticker = undefined;
		setStatus?.(PROGRESS_KEY, undefined);
		if (canSetThinking && typeof priorThinking === "string") {
			try {
				setThinking?.(priorThinking);
			} catch {
				/* the next model_select restores it from the roster */
			}
		}
	};

	try {
		ctx.compact({
			customInstructions: options.instructions,
			onComplete: (result) => {
				inFlight = false;
				expectingUntil = 0;
				lastAt = Date.now();
				settle();
				// Only successful compactions inform the estimate. One that failed
				// after two seconds would make the next bar promise two seconds.
				recordCompactionMs(ctx.cwd, lastAt - startedAt);
				try {
					options.onSummary?.(result.summary, result.tokensBefore);
				} catch {
					/* writing the summary out is best-effort */
				}
				options.onDone?.();
			},
			onError: (err) => {
				inFlight = false;
				expectingUntil = 0;
				lastAt = Date.now();
				settle();
				if (!isBenign(err.message)) ctx.ui.notify(`Compaction failed: ${err.message}`, "warning");
				options.onDone?.();
			},
		});
	} catch (e) {
		inFlight = false;
		settle();
		if (!isBenign(String(e))) ctx.ui.notify(`Compaction failed: ${String(e)}`, "warning");
		options.onDone?.();
		return false;
	}
	return true;
}
