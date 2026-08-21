/**
 * One switch for everything that helps you see what is happening.
 *
 * `PHI_DEBUG=1` turns on the logs and turns off the hiding: tool output stops
 * collapsing, tool costs are recorded, and message ends are written out. The
 * point of a debug mode is that it does not make you name each thing you wanted
 * to see, and it does not hide half of what you asked for.
 *
 * Everything remains individually overridable, and an explicit setting always
 * beats the mode. Someone who set PI_COLLAPSE_TOOLS=1 chose collapsing on
 * purpose, and a debug flag should not quietly reverse a decision that was
 * spelled out.
 */

export const DEBUG = process.env.PHI_DEBUG === "1";

/**
 * Read a boolean env var that defaults to something else when unset.
 *
 * "0" and "1" only, because everything in this repo is already written that
 * way and accepting "true"/"yes"/"on" invites the question of what "PHI_DEBUG=n"
 * means.
 */
export function flag(name: string, whenUnset: boolean): boolean {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return whenUnset;
	return raw !== "0";
}
