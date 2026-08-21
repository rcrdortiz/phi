// phi keeps a project's plan, notes and handoffs in .phi. They used to live in
// .pi, which is pi's own project directory and holds its settings.json.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { STATE_DIR, OWNED, statePath, migrateStateDir } from "../lib/state-dir.ts";

const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + String(d).replace(/\n/g, "\n        ") : ""}`); };

check("state lives in .phi", STATE_DIR === ".phi");
check("paths are built from it", statePath("PLAN.md") === ".phi/PLAN.md");

const project = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phi-statedir-"));
  fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
  return dir;
};
const write = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const read = (dir, rel) => (fs.existsSync(path.join(dir, rel)) ? fs.readFileSync(path.join(dir, rel), "utf8") : undefined);

// --- the migration ---------------------------------------------------------
let dir = project();
write(dir, ".pi/PLAN.md", "the plan");
write(dir, ".pi/NOTES.md", "the notes");
write(dir, ".pi/settings.json", '{"model":"x"}');
const moved = migrateStateDir(dir);
check("phi's files move to the new directory",
  read(dir, `${STATE_DIR}/PLAN.md`) === "the plan" && read(dir, `${STATE_DIR}/NOTES.md`) === "the notes");
check("and are gone from the old one", read(dir, ".pi/PLAN.md") === undefined);
check("pi's settings are left exactly where they are",
  read(dir, ".pi/settings.json") === '{"model":"x"}',
  "moving it would silently change how the project is configured");
check("what moved is reported", moved.sort().join(",") === "NOTES.md,PLAN.md", moved.join(","));
fs.rmSync(dir, { recursive: true, force: true });

// Current state must never be overwritten by something stale left behind.
dir = project();
write(dir, ".pi/PLAN.md", "old plan");
write(dir, `${STATE_DIR}/PLAN.md`, "current plan");
migrateStateDir(dir);
check("an existing file is not overwritten by the old one",
  read(dir, `${STATE_DIR}/PLAN.md`) === "current plan", read(dir, `${STATE_DIR}/PLAN.md`));
check("and the old copy is left in place rather than deleted",
  read(dir, ".pi/PLAN.md") === "old plan",
  "deleting a file this did not move is not its job");
fs.rmSync(dir, { recursive: true, force: true });

// Safe to run on every start.
dir = project();
write(dir, ".pi/PLAN.md", "p");
migrateStateDir(dir);
check("running it again does nothing", migrateStateDir(dir).length === 0);
fs.rmSync(dir, { recursive: true, force: true });

dir = project();
check("a project with nothing to move is untouched", migrateStateDir(dir).length === 0);
check("and no empty directory is created for it", !fs.existsSync(path.join(dir, STATE_DIR)),
  "a session that never plans should not litter the repo");
fs.rmSync(dir, { recursive: true, force: true });

// A configured state dir of .pi means the files are already where they belong.
dir = project();
write(dir, ".pi/PLAN.md", "p");
check("configuring .pi as the state dir is not a move onto itself",
  migrateStateDir(dir, ".pi").length === 0 && read(dir, ".pi/PLAN.md") === "p");
fs.rmSync(dir, { recursive: true, force: true });

check("every file phi owns is listed for migration",
  ["PLAN.md", "NOTES.md", "PLAN-DONE.md", "HANDOFF.md", "compaction-times.json"].every((f) => OWNED.includes(f)),
  "a file left off the list silently stays behind in .pi");

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
