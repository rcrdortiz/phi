/**
 * model-install — pull and build a preconfigured local model from inside pi.
 *
 * This used to live in install.sh, which meant setting up a model required a
 * checkout of this repo. pi installs the package itself now, so there is no
 * checkout to run a script from, and the one thing install.sh still genuinely
 * needs — sudo for the GPU wired limit, brew for Ollama — is the one thing a
 * slash command cannot do. So the split is by privilege, not by convenience:
 * get-phi.sh handles what needs root, /model-install handles the rest.
 *
 * A "model" here is a base pulled from Ollama's registry plus a modelfile that
 * fixes its context window and sampling. Both matter: the roster's
 * contextWindow has to match the num_ctx baked into the variant, or pi sends
 * more context than the model was loaded with.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODELFILES = path.resolve(HERE, "..", "modelfiles");

interface Preconfigured {
	/** The variant this builds, and what the roster refers to. */
	name: string;
	/** Pulled from Ollama's registry. */
	base: string;
	sizeGb: number;
	/** Peak resident memory with a full context, measured rather than derived. */
	peakGb: number;
	summary: string;
}

const MODELS: Preconfigured[] = [
	{
		name: "qwen3.8-4MLX",
		base: "qwen3.8:27b-mlx",
		sizeGb: 18,
		peakGb: 26,
		summary: "Qwen3.8 27B, 4-bit MLX, 64K context. The default: shares the machine with your work.",
	},
];

function installed(): Set<string> {
	try {
		return new Set(
			execFileSync("ollama", ["list"], { encoding: "utf8", timeout: 10_000 })
				.split("\n")
				.slice(1)
				.map((l) => l.split(/\s+/)[0]?.replace(/:latest$/, ""))
				.filter(Boolean),
		);
	} catch {
		return new Set();
	}
}

function freeGb(): number | undefined {
	try {
		const vm = execFileSync("vm_stat", [], { encoding: "utf8", timeout: 5000 });
		const total = Number(execFileSync("sysctl", ["-n", "hw.memsize"], { encoding: "utf8" }).trim());
		const page = Number(/page size of (\d+)/.exec(vm)?.[1] ?? 4096);
		const pages = (l: string) => Number(new RegExp(`${l}:\\s+(\\d+)`).exec(vm)?.[1] ?? 0);
		const used = (pages("Pages active") + pages("Pages wired down") + pages("Pages occupied by compressor")) * page;
		return (total - used) / 2 ** 30;
	} catch {
		return undefined;
	}
}

/**
 * Rebuild a variant whose modelfile no longer matches what Ollama holds.
 *
 * The roster's contextWindow must equal the num_ctx baked into the variant, or
 * pi sends more context than the model was loaded with. An update can change a
 * modelfile, and nothing else would notice: `pi update` refreshes the package,
 * not the models Ollama has already built from it.
 *
 * Compares the modelfile's PARAMETER lines against `ollama show --parameters`
 * rather than hashing the file. A hash needs a state file that can be lost or
 * go stale, and it answers the wrong question — what matters is not whether the
 * file changed but whether the built model still agrees with it.
 *
 * Rebuilds are cheap because a variant shares its base model's blobs. Missing
 * BASES are reported instead: those are an 18 GB download, which is not
 * something to start behind someone's back at session start.
 */
function reconcile(): string[] {
	if (!fs.existsSync(MODELFILES)) return [];
	const notes: string[] = [];
	const have = installed();

	for (const f of fs.readdirSync(MODELFILES).filter((n) => n.endsWith(".modelfile"))) {
		const name = f.replace(/\.modelfile$/, "");
		const body = fs.readFileSync(path.join(MODELFILES, f), "utf8");

		const base = /^FROM\s+(\S+)/m.exec(body)?.[1];
		if (base && !have.has(base.replace(/:latest$/, ""))) {
			notes.push(`${name}: base ${base} is not pulled — run /model-install`);
			continue;
		}

		const want = new Map<string, string>();
		for (const m of body.matchAll(/^PARAMETER\s+(\S+)\s+(.+)$/gm)) want.set(m[1], m[2].trim());

		let current = "";
		try {
			current = execFileSync("ollama", ["show", "--parameters", name], { encoding: "utf8", timeout: 10_000 });
		} catch {
			current = "";   // not built yet
		}
		const got = new Map<string, string>();
		for (const line of current.split("\n")) {
			const m = /^\s*(\S+)\s+(.+?)\s*$/.exec(line);
			if (m) got.set(m[1], m[2]);
		}
		const drifted = [...want].filter(([k, v]) => got.get(k) !== v);
		if (current && !drifted.length) continue;

		try {
			execFileSync("ollama", ["create", name, "-f", path.join(MODELFILES, f)], { stdio: "ignore", timeout: 600_000 });
			notes.push(
				current
					? `rebuilt ${name} (${drifted.map(([k]) => k).join(", ")} changed)`
					: `built ${name}`,
			);
		} catch (e) {
			notes.push(`could not build ${name}: ${String((e as Error).message).split("\n")[0]}`);
		}
	}
	return notes;
}

export default function modelInstallExtension(pi: ExtensionAPI) {
	// Only when a model is actually in use; a --print run should not stop to
	// rebuild anything.
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return undefined;
		const notes = reconcile();
		if (notes.length) ctx.ui.notify(notes.join("\n"), "info");
		return undefined;
	});

	pi.registerCommand("model-install", {
		description: "Pull and build a preconfigured local model",
		handler: async (args, ctx) => {
			try {
				execFileSync("ollama", ["--version"], { stdio: "ignore", timeout: 5000 });
			} catch {
				ctx.ui.notify("Ollama is not installed or not on PATH. Re-run get-phi.sh.", "error");
				return;
			}

			const have = installed();
			const wanted = (args ?? "").trim();
			let target = MODELS.find((m) => m.name === wanted);

			// A name that matches nothing is reported, not silently swallowed by the
			// picker: otherwise a typo looks like the command simply ignoring you.
			if (wanted && !target) {
				ctx.ui.notify(`No preconfigured model named "${wanted}". Choose from the list.`, "warning");
			}
			if (!target) {
				const labels = MODELS.map(
					(m) => `${m.name}  ${m.sizeGb} GB  ${have.has(m.name) ? "(installed)" : "(not installed)"}  — ${m.summary}`,
				);
				const choice = await ctx.ui.select("Install which model?", labels);
				if (choice === undefined) return;
				target = MODELS[labels.indexOf(choice)];
			}
			if (!target) return;

			// Refuse rather than half-finish: a pull that runs the disk out leaves
			// a partial blob store, and a model that cannot fit is worse than no
			// model — it swaps, and a swapping local model does not fail, it
			// slows to nothing while still looking like it is thinking.
			const free = freeGb();
			if (free !== undefined && free < target.peakGb) {
				const go = await ctx.ui.confirm(
					"Not much memory free",
					`${target.name} peaks near ${target.peakGb} GB with a full context and only ` +
						`${free.toFixed(0)} GB is free right now. It will swap. Continue anyway?`,
				);
				if (!go) return;
			}

			if (!have.has(target.base.replace(/:latest$/, ""))) {
				ctx.ui.notify(`Pulling ${target.base} (~${target.sizeGb} GB). This takes a while.`, "info");
				try {
					await run("ollama", ["pull", target.base], { timeout: 3_600_000 });
				} catch (e) {
					ctx.ui.notify(`Pull failed: ${String((e as Error).message).slice(0, 200)}`, "error");
					return;
				}
			} else {
				ctx.ui.notify(`${target.base} is already pulled.`, "info");
			}

			const mf = path.join(MODELFILES, `${target.name}.modelfile`);
			if (!fs.existsSync(mf)) {
				ctx.ui.notify(`Missing modelfile: ${mf}`, "error");
				return;
			}
			try {
				await run("ollama", ["create", target.name, "-f", mf], { timeout: 600_000 });
			} catch (e) {
				ctx.ui.notify(`Build failed: ${String((e as Error).message).slice(0, 200)}`, "error");
				return;
			}

			const ctxLen = /num_ctx\s+(\d+)/.exec(fs.readFileSync(mf, "utf8"))?.[1] ?? "?";
			ctx.ui.notify(
				`${target.name} ready — ${ctxLen} context. Select it with /model.`,
				"info",
			);
		},
	});
}
