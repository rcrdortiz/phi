/**
 * Where phi keeps a project's plan, notes and handoffs.
 *
 * `.phi`, not `.pi`. They used to share `.pi`, which is pi's own project
 * directory and holds its `settings.json`. Mixing the two makes it impossible
 * to tell at a glance which files a phi uninstall should take with it, and it
 * puts phi's state at the mercy of anything pi decides to do with its own
 * directory. They are separate installs sharing a binary everywhere else, and
 * this is the last place that was not true.
 *
 * Env: PHI_STATE_DIR=.somewhere  put them elsewhere
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const STATE_DIR = process.env.PHI_STATE_DIR || ".phi";

/** The directory phi used before 0.6.0, and pi's own project directory. */
const LEGACY_DIR = ".pi";

/** Files phi owns. Everything else in `.pi` belongs to pi and is left alone. */
export const OWNED = ["PLAN.md", "PLAN-DONE.md", "NOTES.md", "HANDOFF.md", "compaction-times.json", "message-end.log"];

/** A project-relative path inside the state directory. */
export function statePath(name: string): string {
	return `${STATE_DIR}/${name}`;
}

/**
 * Move phi's files out of `.pi` the first time a project is opened.
 *
 * Only the files phi wrote, named explicitly rather than matched by pattern:
 * `.pi/settings.json` is pi's and moving it would silently change a project's
 * configuration. A file already present in the new location wins, so this can
 * never overwrite current state with something stale, and it is safe to run on
 * every start.
 *
 * Returns the names it moved, for the caller to report.
 */
export function migrateStateDir(cwd: string, dir = STATE_DIR): string[] {
	if (dir === LEGACY_DIR) return [];
	const from = path.join(cwd, LEGACY_DIR);
	const to = path.join(cwd, dir);
	const moved: string[] = [];
	for (const name of OWNED) {
		const src = path.join(from, name);
		const dest = path.join(to, name);
		try {
			if (!fs.existsSync(src) || fs.existsSync(dest)) continue;
			fs.mkdirSync(to, { recursive: true });
			fs.renameSync(src, dest);
			moved.push(name);
		} catch {
			// A file that cannot be moved is left where it is. Losing the plan to
			// a rename is a far worse outcome than reading it from the old path.
		}
	}
	return moved;
}
