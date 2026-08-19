import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Build a throwaway origin + clone so nothing touches the real repo.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "selfupd-"));
const ORIGIN = path.join(TMP, "origin.git");
const CLONE = path.join(TMP, "clone");
const sh = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" });

execFileSync("git", ["init", "--quiet", "--bare", ORIGIN]);
execFileSync("git", ["clone", "--quiet", ORIGIN, CLONE]);
sh(CLONE, ["config", "user.email", "t@t"]);
sh(CLONE, ["config", "user.name", "t"]);
fs.mkdirSync(path.join(CLONE, "extensions"));
fs.writeFileSync(path.join(CLONE, "extensions", "a.ts"), "// a\n");
sh(CLONE, ["add", "-A"]);
sh(CLONE, ["commit", "-qm", "first"]);
sh(CLONE, ["push", "-q", "origin", "HEAD:master"]);
sh(CLONE, ["branch", "--set-upstream-to=origin/master"]);

process.env.PI_SELFUPDATE_REPO = CLONE;
process.env.PI_SELFUPDATE_MIN_HOURS = "0";
// The updater shells out to `pi install` for new extensions. In a test that
// would write registrations for temp files into the real user settings, which
// then dangle once the temp dir is gone. Shadow `pi` with a no-op for the
// duration of the run.
const BIN = path.join(TMP, "bin");
fs.mkdirSync(BIN);
fs.writeFileSync(path.join(BIN, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
process.env.PATH = `${BIN}:${process.env.PATH}`;
const mod = await import("/Users/rcrd/AI/pi-local/extensions/self-update.ts");

// Grab the update() logic by registering against a stub and invoking /update.
let outcomes = [];
const pi = {
	on: () => {},
	registerCommand: (_n, opts) => (pi._handler = opts.handler),
	registerTool: () => {},
};
mod.default(pi);
let selectAnswer;           // what the user "clicks" in the update prompt
let selectPrompt;           // what they were shown
const ctx = {
	mode: "tui",
	ui: {
		notify: (t) => outcomes.push(t),
		select: async (title, options) => {
			selectPrompt = { title, options };
			return typeof selectAnswer === "function" ? selectAnswer(options) : selectAnswer;
		},
	},
};
const run = async () => {
	outcomes = [];
	await pi._handler("", ctx);
	return outcomes.join("\n");
};

const results = [];
const check = (label, pass, detail = "") => {
	results.push(pass);
	console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? "\n        " + detail.split("\n")[0] : ""}`);
};

// 1. Already current
let out = await run();
check("reports up to date when in sync", /already up to date/i.test(out), out);

// 2. Behind -> the session_start path must ASK before applying.
const startHandlers = {};
{
	const probe = { on: (e, h) => (startHandlers[e] = h), registerCommand: () => {}, registerTool: () => {} };
	(await import("/Users/rcrd/AI/pi-local/extensions/self-update.ts")).default(probe);
}

// 2. Behind -> fast-forwards, and finds the new extension file
const OTHER = path.join(TMP, "other");
execFileSync("git", ["clone", "--quiet", ORIGIN, OTHER]);
sh(OTHER, ["config", "user.email", "t@t"]);
sh(OTHER, ["config", "user.name", "t"]);
fs.writeFileSync(path.join(OTHER, "extensions", "b.ts"), "// b\n");
sh(OTHER, ["add", "-A"]);
sh(OTHER, ["commit", "-qm", "add b extension"]);
sh(OTHER, ["push", "-q", "origin", "HEAD:master"]);

out = await run();
const gotB = fs.existsSync(path.join(CLONE, "extensions", "b.ts"));
check("fast-forwards when behind", /updated \(1 commit\)/.test(out) && gotB, out);
check("tells you a restart is needed", /restart pi/i.test(out), out);

// 2b. An extension deleted upstream is detected for unregistration.
fs.rmSync(path.join(OTHER, "extensions", "a.ts"));
sh(OTHER, ["add", "-A"]);
sh(OTHER, ["commit", "-qm", "remove a extension"]);
sh(OTHER, ["push", "-q", "origin", "HEAD:master"]);
out = await run();
check(
	"picks up an extension deleted on another machine",
	!fs.existsSync(path.join(CLONE, "extensions", "a.ts")),
	out,
);

// 2c. A lib/ change syncs too (extensions import from ../lib).
fs.mkdirSync(path.join(OTHER, "lib"), { recursive: true });
fs.writeFileSync(path.join(OTHER, "lib", "shared.ts"), "export const V = 2\n");
sh(OTHER, ["add", "-A"]);
sh(OTHER, ["commit", "-qm", "add shared lib"]);
sh(OTHER, ["push", "-q", "origin", "HEAD:master"]);
out = await run();
check(
	"syncs lib/ files, not just extensions/",
	fs.existsSync(path.join(CLONE, "lib", "shared.ts")),
	out,
);

// 2d. The startup path offers rather than applies, and honours "Not now".
fs.writeFileSync(path.join(OTHER, "extensions", "offered.ts"), "// offered\n");
sh(OTHER, ["add", "-A"]);
sh(OTHER, ["commit", "-qm", "an offered change"]);
sh(OTHER, ["push", "-q", "origin", "HEAD:master"]);
selectAnswer = "Not now";
outcomes = [];
await startHandlers["session_start"]({}, ctx);
await new Promise((r) => setTimeout(r, 300));
check(
	"startup offers the update instead of applying it",
	/new commit/.test(selectPrompt?.title ?? "") && (selectPrompt?.options ?? []).includes("Update now"),
	JSON.stringify(selectPrompt?.options),
);
check(
	'"Not now" leaves the repo untouched',
	!fs.existsSync(path.join(CLONE, "extensions", "offered.ts")),
);

// 2e. Accepting applies it.
selectAnswer = "Update now";
await startHandlers["session_start"]({}, ctx);
await new Promise((r) => setTimeout(r, 500));
check('"Update now" applies the update', fs.existsSync(path.join(CLONE, "extensions", "offered.ts")));

// 3. Dirty tree -> refuses
fs.writeFileSync(path.join(CLONE, "extensions", "a.ts"), "// locally edited\n");
fs.writeFileSync(path.join(OTHER, "extensions", "c.ts"), "// c\n");
sh(OTHER, ["add", "-A"]);
sh(OTHER, ["commit", "-qm", "add c"]);
sh(OTHER, ["push", "-q", "origin", "HEAD:master"]);
out = await run();
check(
	"refuses to update over local edits",
	/uncommitted changes/.test(out) && !fs.existsSync(path.join(CLONE, "extensions", "c.ts")),
	out,
);

// 4. Unpushed local commits -> refuses (would not be a fast-forward)
sh(CLONE, ["checkout", "--", "."]);
fs.writeFileSync(path.join(CLONE, "extensions", "local.ts"), "// mine\n");
sh(CLONE, ["add", "-A"]);
sh(CLONE, ["commit", "-qm", "local work"]);
out = await run();
check("refuses when local and remote diverged", /diverged|unpushed/.test(out), out);

fs.rmSync(TMP, { recursive: true, force: true });
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
