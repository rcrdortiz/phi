/**
 * boot-screen: replace pi's startup banner with one about phi.
 *
 * pi's default banner reports pi: its version, its keybindings, and a dump of
 * every loaded extension and skill conflict. That is the right banner for pi
 * and the wrong one here, because none of it is what you need when you sit
 * down: which model you are on, how to get one if you have not, and whether
 * anything is out of date.
 *
 * Update checks run in the background and the header redraws when they land,
 * rather than delaying the prompt. A startup screen that waits on the network
 * is one you learn to resent, and both checks are advisory: pi and phi work
 * perfectly offline, so a failed check should say nothing at all.
 *
 * Env: PHI_BOOT=0          keep pi's own banner
 *      PHI_UPDATE_CHECK=0  draw the box, skip the network
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { DEBUG } from "../lib/debug.ts";
import { STATE_DIR } from "../lib/state-dir.ts";
import { promisify } from "node:util";

const run = promisify(execFile);
const ENABLED = process.env.PHI_BOOT !== "0";
const CHECK_UPDATES = process.env.PHI_UPDATE_CHECK !== "0";
/**
 * How often to look again, for a session that stays open.
 *
 * Ten minutes because the check costs one `npm view` and one `git fetch` of a
 * small repo, and the thing it is watching changes on the order of hours. 0
 * checks once at startup and never again.
 */
export function parseInterval(raw: string | undefined): number {
	if (raw === undefined || raw.trim() === "") return 600_000;
	const n = Number(raw);
	// A garbage value should not silently become "never look again", which is
	// indistinguishable from the feature working.
	if (!Number.isFinite(n) || n < 0) return 600_000;
	// Anything under a minute is a typo or a misunderstanding of the units. The
	// thing being watched changes on the order of hours.
	if (n > 0 && n < 60_000) return 60_000;
	return n;
}
const RECHECK_MS = parseInterval(process.env.PHI_UPDATE_INTERVAL_MS);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

/**
 * The mark, drawn large when there is room for it.
 *
 * Full blocks and spaces only. Half-blocks (\u2580 \u2584 \u258c \u2590) draw a smoother outline on
 * paper and a striped mess in a terminal, because a cell taller than the glyph
 * leaves a gap between rows that the eye reads as banding rather than as a
 * curve. \u2588 fills its cell, so rows meet.
 *
 * Shading is by column and row rather than a hand-maintained tone map: a light
 * source at the top left means brightness falls as x and y increase, which is
 * one rule instead of 250 hand-placed characters that would have to be edited
 * in lockstep every time the silhouette changes.
 *
 * The small form is not a nicety. A 25-column logo eats a third of an 80-column
 * terminal and all of a 40-column one, so below a threshold the frame keeps the
 * glyph and drops the drawing.
 */
const LOGO_BIG = [
	"          \u2588\u2588\u2588          ",
	"        \u2588\u2588\u2588\u2588\u2588\u2588\u2588        ",
	"    \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588    ",
	"  \u2588\u2588\u2588\u2588\u2588   \u2588\u2588\u2588   \u2588\u2588\u2588\u2588\u2588  ",
	" \u2588\u2588\u2588\u2588     \u2588\u2588\u2588     \u2588\u2588\u2588\u2588 ",
	" \u2588\u2588\u2588      \u2588\u2588\u2588      \u2588\u2588\u2588 ",
	" \u2588\u2588\u2588      \u2588\u2588\u2588      \u2588\u2588\u2588 ",
	" \u2588\u2588\u2588\u2588     \u2588\u2588\u2588     \u2588\u2588\u2588\u2588 ",
	"  \u2588\u2588\u2588\u2588\u2588   \u2588\u2588\u2588   \u2588\u2588\u2588\u2588\u2588  ",
	"    \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588    ",
	"        \u2588\u2588\u2588\u2588\u2588\u2588\u2588        ",
	"          \u2588\u2588\u2588          ",
];
const LOGO_SMALL = [" \u256d\u2500\u2500\u2500\u256e ", " \u2502 \u03a6 \u2502 ", " \u2570\u2500\u2500\u2500\u256f "];
/** Below this many usable columns the drawing is dropped for the framed glyph. */
const BIG_LOGO_MIN_WIDTH = 62;

/** Theme roles used as a four-step ramp from lit to shadowed. */
const TONES = ["accent", "border", "muted", "dim"] as const;

/**
 * Paint one row of the mark, lit from the top left.
 *
 * The last row is pushed a step darker than its position alone would give, so
 * the glyph sits on a shadow rather than ending flat.
 */
function paintArtRow(row: string, y: number, rows: number, paint: (role: string, s: string) => string): string {
	const w = row.length;
	let out = "";
	let run = "";
	let runTone = -1;
	const flush = () => {
		if (run) out += paint(TONES[Math.min(runTone, TONES.length - 1)], run);
		run = "";
	};
	for (let x = 0; x < w; x++) {
		const ch = row[x];
		if (ch === " ") {
			flush();
			runTone = -1;
			out += " ";
			continue;
		}
		// Brightness falls with distance from the top-left corner.
		let tone = Math.floor((x / w) * 2.4 + (y / rows) * 1.2);
		if (y === rows - 1) tone += 1;
		tone = Math.min(tone, TONES.length - 1);
		if (tone !== runTone) {
			flush();
			runTone = tone;
		}
		run += ch;
	}
	flush();
	return out;
}

const ESC = String.fromCharCode(27);

/**
 * The box turns yellow under PHI_DEBUG, so the mode is visible before anything
 * has happened.
 *
 * Debug mode changes what a session does: nothing collapses, and every tool
 * call is written to disk. Finding that out from a log file that exists, or
 * from output that suddenly will not fold, is worse than being told at the top
 * of the screen. Purple means ordinary, yellow means someone is watching.
 *
 * Painted as raw ANSI rather than through a theme role, because the mark is
 * shaded across four tones and the theme has exactly one yellow. A ramp needs
 * four.
 */
const DEBUG_TONES: Record<string, string> = {
	accent: "229",
	border: "221",
	muted: "178",
	dim: "136",
	warning: "214",
	success: "229",
	error: "203",
	toolOutput: "221",
};

export function debugPaint(role: string, text: string): string {
	return `${ESC}[38;5;${DEBUG_TONES[role] ?? "221"}m${text}${ESC}[0m`;
}

const ANSI = new RegExp(ESC + "\\[[0-9;]*m", "g");
/** Length ignoring colour, so padding survives it. */
function visible(s: string): number {
	return s.replace(ANSI, "").length;
}

/**
 * Truncate to `n` visible columns, stepping over colour codes rather than
 * counting them.
 *
 * Padding alone is not enough: a line longer than the box does not wrap
 * politely, it pushes the right border onto the next row and the whole frame
 * comes apart. Cutting inside a coloured span would also leave the colour on,
 * so a reset is appended whenever anything was dropped.
 */
function clip(s: string, n: number): string {
	if (visible(s) <= n) return s;
	let out = "";
	let count = 0;
	let i = 0;
	let coloured = false;
	while (i < s.length && count < n) {
		if (s[i] === ESC) {
			const m = /^\u001b\[[0-9;]*m/.exec(s.slice(i));
			if (m) {
				out += m[0];
				i += m[0].length;
				coloured = true;
				continue;
			}
		}
		out += s[i];
		count++;
		i++;
	}
	return out + (coloured ? ESC + "[0m" : "");
}

function phiVersion(): string {
	try {
		return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version ?? "?";
	} catch {
		return "?";
	}
}

function shorten(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

export type UpdatePhase = "checking" | "idle" | "available" | "installing" | "installed" | "failed" | "declined";

export interface UpdateState {
	pi?: { current: string; latest: string };
	phi?: { behind: number };
	checked: boolean;
	phase: UpdatePhase;
	error?: string;
}

/**
 * Is the installed pi behind the registry?
 *
 * `npm view` rather than `npm outdated -g`: outdated exits non-zero when
 * something IS outdated, which is indistinguishable from the command failing.
 */
export async function checkPi(current: string): Promise<UpdateState["pi"]> {
	if (!current) return undefined;
	try {
		const { stdout } = await run("npm", ["view", "@earendil-works/pi-coding-agent", "version"], { timeout: 15000 });
		const latest = stdout.trim();
		return latest && latest !== current ? { current, latest } : undefined;
	} catch {
		return undefined;
	}
}

/** How many commits the installed phi clone is behind its remote. */
export async function checkPhi(repoDir: string): Promise<UpdateState["phi"]> {
	try {
		await run("git", ["-C", repoDir, "fetch", "--quiet", "origin"], { timeout: 20000 });
		const { stdout } = await run("git", ["-C", repoDir, "rev-list", "--count", "HEAD..@{u}"], { timeout: 10000 });
		const behind = Number(stdout.trim());
		return Number.isFinite(behind) && behind > 0 ? { behind } : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The environment for a command that genuinely needs the network.
 *
 * The phi wrapper sets PI_OFFLINE so pi keeps its own update banners quiet and
 * lets this box be the only place updates are reported. A child `pi update`
 * would inherit that and silently do nothing, which looks exactly like a
 * successful update, so the flag is dropped for commands whose whole job is to
 * fetch something.
 */
function online(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.PI_OFFLINE;
	return env;
}

/**
 * Install whatever is out of date.
 *
 * Both are done in place and neither takes effect until pi restarts: node has
 * already loaded pi's code and this package's extensions, so a running session
 * keeps the versions it started with no matter what changes on disk. Saying
 * "restart to apply" is therefore the honest report, not a hedge.
 *
 * Failures are returned rather than thrown. A machine that cannot write to the
 * global npm prefix is a normal machine, and the session it is running should
 * carry on unaffected.
 */
export async function applyUpdates(
	u: UpdateState,
	exec: (cmd: string, args: string[]) => Promise<unknown> = (cmd, args) => run(cmd, args, { timeout: 300000, env: online() }),
): Promise<{ ok: boolean; error?: string }> {
	try {
		if (u.pi) await exec("npm", ["i", "-g", "@earendil-works/pi-coding-agent"]);
		if (u.phi) await exec("pi", ["update", "https://github.com/rcrdortiz/phi"]);
		return { ok: true };
	} catch (e) {
		const msg = String((e as Error)?.message ?? e).split("\n")[0].slice(0, 120);
		return { ok: false, error: msg };
	}
}

export interface BoxOptions {
	version: string;
	model?: string;
	contextWindow?: number;
	thinking?: string;
	cwd: string;
	updates: UpdateState;
	error?: string;
	paint: (role: string, s: string) => string;
	/** Painted yellow, with a line saying why. */
	debug?: boolean;
}

/** Build the box. Exported so the layout can be asserted without a terminal. */
export function renderBox(width: number, o: BoxOptions): string[] {
	// Track the terminal, down to a floor that still holds the title. Never
	// wider than it: a box that overflows is worse than a cramped one.
	const inner = Math.max(16, Math.min(width, 92) - 2);
	const pad = (s: string, n: number) => { const c = clip(s, n); return c + " ".repeat(Math.max(0, n - visible(c))); };

	const title = " Phi " + o.version + " ";
	const top = clip("\u256d\u2500" + title, inner + 1) + "\u2500".repeat(Math.max(0, inner - title.length - 1)) + "\u256e";
	const bottom = "\u2570" + "\u2500".repeat(inner) + "\u256f";
	const rows: string[] = [];
	const line = (s = "") => rows.push("\u2502 " + pad(s, inner - 2) + " \u2502");

	const facts: string[] = [];
	if (o.model) {
		const bits = [o.model];
		if (o.contextWindow) bits.push(Math.round(o.contextWindow / 1024) + "K context");
		if (o.thinking) bits.push("thinking " + o.thinking);
		facts.push(bits.join("  \u00b7  "));
	} else {
		facts.push(o.paint("warning", "no model yet") + "  \u00b7  run /model-install");
	}
	facts.push(o.paint("dim", shorten(o.cwd)));
	// The colour says something changed; this says what.
	if (o.debug) facts.push(o.paint("warning", "debug") + o.paint("dim", "  \u00b7  logging to " + STATE_DIR + ", nothing collapsed"));

	const big = inner - 2 >= BIG_LOGO_MIN_WIDTH;
	const art = big ? LOGO_BIG : LOGO_SMALL;
	// Sit the facts against the middle of the mark rather than its first rows,
	// so a ten-row logo does not leave them stranded at the top.
	const factTop = Math.max(0, Math.floor((art.length - facts.length) / 2));
	art.forEach((row, i) => {
		const painted = paintArtRow(row, i, art.length, o.paint);
		const fact = facts[i - factTop] ?? "";
		line(painted + (fact ? "  " + fact : ""));
	});
	line();
	line(o.paint("accent", "/model-install") + "   pull and build a preconfigured model");
	line(o.paint("accent", "/context") + "         how full the window is, and when it compacts");
	line(o.paint("accent", "/speed") + "           decode rate, so a stall is visible");
	line(o.paint("accent", "/notes-gc") + "        trim notes that have outgrown their welcome");

	const what = [
		o.updates.pi ? "pi " + o.updates.pi.current + " to " + o.updates.pi.latest : "",
		o.updates.phi ? "phi " + o.updates.phi.behind + " commit(s) behind" : "",
	].filter(Boolean).join("  \u00b7  ");

	switch (o.updates.phase) {
		case "checking":
			line();
			line(o.paint("dim", "checking for updates"));
			break;
		case "available":
			line();
			line(o.paint("warning", "update available") + "  " + what);
			line(o.paint("dim", "run /update to install"));
			break;
		case "installing":
			line();
			line(o.paint("accent", "installing") + "  " + what);
			break;
		case "installed":
			line();
			line(o.paint("success", "update installed") + o.paint("dim", "  \u00b7  restart pi to apply"));
			break;
		case "failed":
			line();
			line(o.paint("error", "update failed") + o.paint("dim", "  " + (o.error ?? "")));
			break;
		case "declined":
			// Two lines, like "available". One long line gets clipped on a narrow
			// terminal and the clip lands on the part that says what to do.
			line();
			line(o.paint("dim", "update available") + o.paint("dim", "  " + what));
			line(o.paint("dim", "run /update to install"));
			break;
		default:
			break;
	}

	return [o.paint("accent", top), ...rows, o.paint("accent", bottom)];
}

async function piVersion(): Promise<string> {
	try {
		const { stdout } = await run("pi", ["--version"], { timeout: 5000 });
		return stdout.trim().split("\n")[0].replace(/^v/, "");
	} catch {
		return "";
	}
}

export default function bootScreenExtension(pi: ExtensionAPI) {
	if (!ENABLED) return;
	const updates: UpdateState = { checked: false, phase: CHECK_UPDATES ? "checking" : "idle" };
	let invalidate: (() => void) | undefined;

	/** Install, keeping the box honest about which stage it is at. */
	async function install(ctx: ExtensionContext): Promise<void> {
		if (!updates.pi && !updates.phi) {
			ctx.ui.notify("Everything is up to date.", "info");
			return;
		}
		updates.phase = "installing";
		invalidate?.();
		const r = await applyUpdates(updates);
		if (r.ok) {
			updates.phase = "installed";
			// Cleared so a second /update does not offer what was just installed.
			updates.pi = undefined;
			updates.phi = undefined;
			ctx.ui.notify("Update installed. Restart pi to apply it.", "info");
		} else {
			updates.phase = "failed";
			updates.error = r.error;
			ctx.ui.notify("Update failed: " + (r.error ?? "unknown"), "error");
		}
		invalidate?.();
	}

	pi.registerCommand("update", {
		description: "Install available pi and phi updates",
		handler: async (_args, ctx) => install(ctx as unknown as ExtensionContext),
	});

	pi.on("session_start", async (_event, ctx) => {
		const c = ctx as unknown as ExtensionContext;
		if (c.mode !== "tui" || typeof c.ui.setHeader !== "function") return undefined;

		c.ui.setHeader((tui, theme) => {
			invalidate = () => tui.invalidate();
			return {
				render(width: number) {
					return renderBox(width, {
						version: phiVersion(),
						model: c.model?.id,
						contextWindow: c.model?.contextWindow,
						thinking: (c as { thinkingLevel?: string }).thinkingLevel,
						cwd: c.cwd,
						debug: DEBUG,
						updates,
						error: updates.error,
						paint: DEBUG ? debugPaint : (role, s) => theme.fg(role as never, s),
					});
				},
			};
		});

		/**
		 * Run the checks and redraw.
		 *
		 * `prompt` is false for the repeating check, and that is deliberate. A
		 * modal that appears ten minutes into a run interrupts whatever is on
		 * screen to ask about a typo fix, and the answer to "install now?" while
		 * the model is mid-edit is always no. The box already carries the
		 * answer, and /update installs it whenever the moment is right.
		 */
		const runChecks = async (prompt: boolean) => {
			// A check that lands while an install is running would report the old
			// state back over the new one.
			if (updates.phase === "installing") return;
			let a: UpdateState["pi"];
			let b: UpdateState["phi"];
			const declined = updates.phase === "declined";
			try {
				[a, b] = await Promise.all([
					piVersion().then(checkPi).catch(() => undefined),
					checkPhi(ROOT),
				]);
				updates.pi = a;
				updates.phi = b;
			} finally {
				// Whatever happened, stop saying "checking". A check that
				// failed looks exactly like one still running, and the running
				// one never ends, so the box would sit there indefinitely
				// claiming work it is not doing. Nothing found means nothing
				// shown: "up to date" is noise on every single start.
				updates.checked = true;
				// A declined update stays declined while it is the same update.
				// Re-announcing it every ten minutes is nagging, and the user
				// already said not now.
				updates.phase = updates.pi || updates.phi ? (declined ? "declined" : "available") : "idle";
				invalidate?.();
			}
			if (!prompt || !(a || b) || typeof c.ui.confirm !== "function") return;

			// Ask rather than update silently. Replacing the binary someone is
			// running is not a decision to make on their behalf, and the answer
			// may reasonably be "not in the middle of this".
			const what = [
				a ? "pi " + a.current + " to " + a.latest : "",
				b ? "phi is " + b.behind + " commit(s) behind" : "",
			].filter(Boolean).join("\n");
			const yes = await c.ui.confirm("Update available", what + "\n\nInstall now? It applies when pi restarts.");
			if (!yes) {
				updates.phase = "declined";
				invalidate?.();
				return;
			}
			await install(c);
		};

		if (CHECK_UPDATES) {
			// Detached: the prompt is usable immediately and the box redraws when
			// an answer arrives.
			void runChecks(true);

			if (RECHECK_MS > 0) {
				// A session that stays open all day would otherwise report the
				// state of the world at the moment it started.
				const timer = setInterval(() => void runChecks(false), RECHECK_MS);
				// Node keeps the process alive for a pending interval, which would
				// stop pi exiting between the last turn and shutdown.
				timer.unref?.();
				pi.on("session_shutdown", async () => {
					clearInterval(timer);
					return undefined;
				});
			}
		}
		return undefined;
	});
}
