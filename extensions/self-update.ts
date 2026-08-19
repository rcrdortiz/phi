/**
 * self-update — keep the pi-local extensions current from your own repo.
 *
 * At startup, fetches the repo these extensions live in and fast-forwards if
 * it is behind. New extension files are registered with pi automatically.
 * Extensions are loaded once at launch, so an update applies on the NEXT run —
 * the notification says so rather than pretending otherwise.
 *
 * Deliberate constraints, because this runs code from a remote on every start:
 *   - fast-forward only; never a merge, rebase, or force
 *   - refuses to touch a dirty working tree (your local edits win)
 *   - refuses if the branch has diverged (unpushed commits win)
 *   - git and `pi install` only; no build steps, no hooks, nothing from the repo
 *   - TUI only, so scripted --print runs stay reproducible
 *   - network calls are time-boxed and failures are silent (offline is normal)
 *
 * Env: PI_SELFUPDATE=0            disable entirely
 *      PI_SELFUPDATE_REPO=<path>  repo to track (default: this file's repo)
 *      PI_SELFUPDATE_MIN_HOURS=6  minimum gap between checks (0 = every start)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ENABLED = process.env.PI_SELFUPDATE !== "0";
const MIN_HOURS = Number(process.env.PI_SELFUPDATE_MIN_HOURS ?? 6);
const REPO =
	process.env.PI_SELFUPDATE_REPO ??
	path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STAMP = path.join(REPO, ".git", "pi-last-update-check");

function git(args: string[], timeout = 20000): { ok: boolean; out: string } {
	try {
		const out = execFileSync("git", ["-C", REPO, ...args], {
			encoding: "utf8",
			timeout,
			stdio: "pipe",
		});
		return { ok: true, out: out.trim() };
	} catch (e) {
		const err = e as { stderr?: Buffer; message?: string };
		return { ok: false, out: (err.stderr?.toString() || err.message || "").trim() };
	}
}

function checkedRecently(): boolean {
	if (MIN_HOURS <= 0) return false;
	try {
		const last = Number(fs.readFileSync(STAMP, "utf8"));
		return Date.now() - last < MIN_HOURS * 3600_000;
	} catch {
		return false;
	}
}

function stampNow(): void {
	try {
		fs.writeFileSync(STAMP, String(Date.now()), "utf8");
	} catch {
		/* a missing stamp only means we check again sooner */
	}
}

type Outcome =
	| { kind: "current" }
	| { kind: "skipped"; why: string }
	| { kind: "updated"; commits: string; newExtensions: string[] }
	| { kind: "error"; why: string };

function update(force: boolean): Outcome {
	if (!fs.existsSync(path.join(REPO, ".git"))) {
		return { kind: "skipped", why: `${REPO} is not a git repo` };
	}
	if (!force && checkedRecently()) return { kind: "skipped", why: "checked recently" };

	const fetched = git(["fetch", "--quiet", "origin"]);
	stampNow();
	if (!fetched.ok) return { kind: "error", why: `fetch failed: ${fetched.out.split("\n")[0]}` };

	const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).out;
	const local = git(["rev-parse", "HEAD"]).out;
	const remote = git(["rev-parse", `origin/${branch}`]).out;
	if (!local || !remote) return { kind: "error", why: `no upstream for ${branch}` };
	if (local === remote) return { kind: "current" };

	// Behind, ahead, or diverged? Only a clean fast-forward is allowed.
	const base = git(["merge-base", "HEAD", `origin/${branch}`]).out;
	if (base !== local) {
		return {
			kind: "skipped",
			why: base === remote ? "you have unpushed commits" : "local and remote have diverged",
		};
	}

	const dirty = git(["status", "--porcelain"]).out;
	if (dirty) {
		return { kind: "skipped", why: `uncommitted changes in ${path.basename(REPO)}` };
	}

	const before = new Set(listExtensions());
	const log = git(["log", "--oneline", `HEAD..origin/${branch}`]).out;
	const pulled = git(["merge", "--ff-only", `origin/${branch}`]);
	if (!pulled.ok) return { kind: "error", why: `fast-forward failed: ${pulled.out.split("\n")[0]}` };

	const added = listExtensions().filter((f) => !before.has(f));
	return { kind: "updated", commits: log, newExtensions: added };
}

// ---------------------------------------------------------------- setup

const HASHES = path.join(REPO, ".git", "pi-modelfile-hashes.json");

function ollama(args: string[], timeout = 120000): { ok: boolean; out: string } {
	try {
		return { ok: true, out: execFileSync("ollama", args, { encoding: "utf8", timeout, stdio: "pipe" }).trim() };
	} catch (e) {
		const err = e as { stderr?: Buffer; message?: string };
		return { ok: false, out: (err.stderr?.toString() || err.message || "").trim() };
	}
}

function installedModels(): Set<string> {
	const r = ollama(["list"], 20000);
	if (!r.ok) return new Set();
	return new Set(
		r.out
			.split("\n")
			.slice(1)
			.map((l) => l.split(/\s+/)[0]?.replace(/:latest$/, ""))
			.filter(Boolean) as string[],
	);
}

function readHashes(): Record<string, string> {
	try {
		return JSON.parse(fs.readFileSync(HASHES, "utf8"));
	} catch {
		return {};
	}
}

/**
 * Bring the local Ollama state in line with the repo: rebuild any variant whose
 * modelfile changed, and report base models that are missing. Rebuilds are
 * cheap (they share the base model's blobs); downloads are not, so those are
 * reported rather than started.
 */
function reconcileModels(): string[] {
	const dir = path.join(REPO, "modelfiles");
	if (!fs.existsSync(dir)) return [];

	const notes: string[] = [];
	const present = installedModels();
	const hashes = readHashes();
	const missingBases = new Set<string>();
	let changed = false;

	for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".modelfile"))) {
		const name = f.replace(/\.modelfile$/, "");
		const body = fs.readFileSync(path.join(dir, f), "utf8");
		const hash = createHash("sha256").update(body).digest("hex").slice(0, 16);

		const base = /^FROM\s+(\S+)/m.exec(body)?.[1];
		if (base && !present.has(base.replace(/:latest$/, ""))) {
			missingBases.add(base);
			continue; // cannot build a variant whose base is absent
		}
		if (hashes[name] === hash && present.has(name)) continue;

		const built = ollama(["create", name, "-f", path.join(dir, f)]);
		if (built.ok) {
			hashes[name] = hash;
			changed = true;
			notes.push(`rebuilt ${name}`);
		} else {
			notes.push(`could not build ${name}: ${built.out.split("\n")[0]}`);
		}
	}

	if (changed) {
		try {
			fs.writeFileSync(HASHES, JSON.stringify(hashes, null, 1), "utf8");
		} catch {
			/* a lost hash file only means one redundant rebuild next time */
		}
	}
	if (missingBases.size) {
		notes.push(
			`missing base model(s): ${[...missingBases].join(", ")} — run: ` +
				[...missingBases].map((m) => `ollama pull ${m}`).join(" && "),
		);
	}
	return notes;
}

function listExtensions(): string[] {
	try {
		return fs
			.readdirSync(path.join(REPO, "extensions"))
			.filter((f) => f.endsWith(".ts"))
			.sort();
	} catch {
		return [];
	}
}

/** Register extension files that did not exist before the update. */
function register(files: string[]): string[] {
	const done: string[] = [];
	for (const f of files) {
		try {
			execFileSync("pi", ["install", path.join(REPO, "extensions", f)], {
				stdio: "pipe",
				timeout: 30000,
			});
			done.push(f);
		} catch {
			/* reported as un-registered below */
		}
	}
	return done;
}

function summarise(o: Outcome): { text: string; level: "info" | "warning" | "error" } | undefined {
	switch (o.kind) {
		case "current":
			return undefined; // silence is the right output for "nothing to do"
		case "skipped":
			return o.why === "checked recently" ? undefined : { text: `pi-local not updated: ${o.why}`, level: "warning" };
		case "error":
			return { text: `pi-local update check failed: ${o.why}`, level: "warning" };
		case "updated": {
			const n = o.commits.split("\n").filter(Boolean).length;
			const registered = register(o.newExtensions);
			const bits = [`pi-local updated (${n} commit${n === 1 ? "" : "s"}) — restart pi to load it.`];
			if (registered.length) bits.push(`Registered: ${registered.join(", ")}.`);
			bits.push(o.commits.split("\n").slice(0, 5).join("\n"));
			return { text: bits.join("\n"), level: "info" };
		}
	}
}

export default function selfUpdateExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ENABLED || ctx.mode !== "tui") return;
		// Not awaited: a network call should never delay the prompt.
		void (async () => {
			try {
				const msg = summarise(update(false));
				if (msg) ctx.ui.notify(msg.text, msg.level);
				// Local reconciliation is deliberately independent of git: being
				// offline, or running from a plain copy of the folder, should not
				// stop a missing variant from being rebuilt.
				const notes = reconcileModels();
				if (notes.length) ctx.ui.notify(notes.join("\n"), "warning");
			} catch {
				/* never let the updater break a session */
			}
		})();
	});

	pi.registerCommand("update-extensions", {
		description: "Check pi-local for updates now and fast-forward if possible",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Checking pi-local…", "info");
			const msg = summarise(update(true));
			const notes = reconcileModels();
			const lines = [msg?.text ?? "pi-local is already up to date.", ...notes];
			ctx.ui.notify(lines.join("\n"), msg?.level ?? (notes.length ? "warning" : "info"));
		},
	});
}
