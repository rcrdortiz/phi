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
import { promisify } from "node:util";

const run = promisify(execFile);
const ENABLED = process.env.PHI_BOOT !== "0";
const CHECK_UPDATES = process.env.PHI_UPDATE_CHECK !== "0";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

/**
 * The symbol itself, framed rather than drawn in ASCII art.
 *
 * A hand-drawn phi at this size reads as noise: the letter is a circle with a
 * bar through it, and three rows of ASCII cannot say that unambiguously. The
 * real glyph can, and every terminal that can render the box-drawing characters
 * around it can render a Greek capital too.
 */
const LOGO = [" \u256d\u2500\u2500\u2500\u256e ", " \u2502 \u03a6 \u2502 ", " \u2570\u2500\u2500\u2500\u256f "];

const ESC = String.fromCharCode(27);
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

export interface UpdateState {
	pi?: { current: string; latest: string };
	phi?: { behind: number };
	checked: boolean;
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

export interface BoxOptions {
	version: string;
	model?: string;
	contextWindow?: number;
	thinking?: string;
	cwd: string;
	updates: UpdateState;
	paint: (role: string, s: string) => string;
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

	LOGO.forEach((art, i) => line(o.paint("accent", art) + "  " + (facts[i] ?? "")));
	line();
	line(o.paint("accent", "/model-install") + "   pull and build a preconfigured model");
	line(o.paint("accent", "/context") + "         how full the window is, and when it compacts");
	line(o.paint("accent", "/speed") + "           decode rate, so a stall is visible");
	line(o.paint("accent", "/notes-gc") + "        trim notes that have outgrown their welcome");

	if (o.updates.pi || o.updates.phi) {
		line();
		if (o.updates.pi) {
			line(o.paint("warning", "update") + "  pi " + o.updates.pi.current + " to " + o.updates.pi.latest +
				o.paint("dim", "   npm i -g @earendil-works/pi-coding-agent"));
		}
		if (o.updates.phi) {
			line(o.paint("warning", "update") + "  phi is " + o.updates.phi.behind + " commit(s) behind" +
				o.paint("dim", "   pi update"));
		}
	} else if (!o.updates.checked && CHECK_UPDATES) {
		line();
		line(o.paint("dim", "checking for updates"));
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
	const updates: UpdateState = { checked: false };

	pi.on("session_start", async (_event, ctx) => {
		const c = ctx as unknown as ExtensionContext;
		if (c.mode !== "tui" || typeof c.ui.setHeader !== "function") return undefined;

		let invalidate: (() => void) | undefined;
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
						updates,
						paint: (role, s) => theme.fg(role as never, s),
					});
				},
			};
		});

		if (CHECK_UPDATES) {
			// Detached: the prompt is usable immediately and the box redraws when
			// an answer arrives.
			void (async () => {
				const [a, b] = await Promise.all([checkPi(await piVersion()), checkPhi(ROOT)]);
				updates.pi = a;
				updates.phi = b;
				updates.checked = true;
				invalidate?.();
			})();
		}
		return undefined;
	});
}
