import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

// A throwaway "repo" whose modelfiles point at a base model that really exists.
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), "recon-"));
fs.mkdirSync(path.join(REPO, ".git"));
fs.mkdirSync(path.join(REPO, "modelfiles"));
fs.mkdirSync(path.join(REPO, "extensions"));
process.env.PI_SELFUPDATE_REPO = REPO;
process.env.PI_SELFUPDATE_MIN_HOURS = "0";

const VARIANT = "pi-recon-test";
fs.writeFileSync(
	path.join(REPO, "modelfiles", `${VARIANT}.modelfile`),
	"FROM qwen3.8:27b-mlx\nPARAMETER num_ctx 8192\n",
);

const mod = await import("/Users/rcrd/AI/pi-local/extensions/self-update.ts");
let handler;
mod.default({ on: () => {}, registerCommand: (_n, o) => (handler = o.handler), registerTool: () => {} });
const notes = [];
const run = async () => {
	notes.length = 0;
	await handler("", { mode: "tui", ui: { notify: (t) => notes.push(t) } });
	return notes.join("\n");
};
const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + d.split("\n").slice(0,2).join(" / ") : ""}`); };

const listed = () => execFileSync("ollama", ["list"], { encoding: "utf8" });

// 1. Variant does not exist yet -> gets built.
let out = await run();
check("builds a variant that is missing locally", /rebuilt pi-recon-test/.test(out) && listed().includes(VARIANT), out);

// 2. Nothing changed -> no rebuild (hash cache works).
out = await run();
check("does not rebuild when nothing changed", !/rebuilt/.test(out), out || "(silent)");

// 3. Modelfile edited -> rebuilt.
fs.writeFileSync(path.join(REPO, "modelfiles", `${VARIANT}.modelfile`), "FROM qwen3.8:27b-mlx\nPARAMETER num_ctx 4096\n");
out = await run();
check("rebuilds after the modelfile changes", /rebuilt pi-recon-test/.test(out), out);

// 4. Variant deleted behind our back -> rebuilt.
try { execFileSync("ollama", ["rm", VARIANT], { stdio: "pipe" }); } catch {}
out = await run();
check("rebuilds a variant removed outside pi", /rebuilt pi-recon-test/.test(out) && listed().includes(VARIANT), out);

// 5. Missing base model -> reported, never downloaded.
fs.writeFileSync(path.join(REPO, "modelfiles", "pi-recon-absent.modelfile"), "FROM definitely-not-a-real-model:99b\n");
out = await run();
check("reports a missing base instead of downloading it",
	/missing base model/.test(out) && /ollama pull definitely-not-a-real-model/.test(out), out);

try { execFileSync("ollama", ["rm", VARIANT], { stdio: "pipe" }); } catch {}
fs.rmSync(REPO, { recursive: true, force: true });
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
