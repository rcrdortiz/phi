/**
 * One line per tool result, until you ask for more.
 *
 * A turn that reads three files and lists a directory fills the screen with
 * output nobody is reading. The interesting part is the sentence the model
 * wrote before it, and on a local model that sentence arrives slowly enough
 * that scrolling past a hundred lines of file listing to find it is a real
 * cost.
 *
 * pi already collapses, but per built-in tool and at twenty lines, which is
 * more than a screen once several land in a row. Our own tools collapse to
 * their first line, which every one of them writes as a summary: the file and
 * range for view_lines, the file and declaration count for outline, what was
 * replaced for the edit tools. ctrl+o expands, exactly as it does elsewhere,
 * so nothing is hidden, only deferred.
 *
 * Env: PI_COLLAPSE_TOOLS=0  render tool results in full
 *      PHI_DEBUG=1          the same, along with the rest of debug mode
 */

// Debug mode exists to show you what happened. Collapsing output while being
// asked to explain it is the opposite of that, so PHI_DEBUG turns it off. An
// explicit PI_COLLAPSE_TOOLS still wins: that was a decision, not a default.
import { DEBUG, flag } from "./debug.ts";

const ENABLED = flag("PI_COLLAPSE_TOOLS", !DEBUG);

/** How many lines survive the collapse. The first line is the summary. */
const KEEP = Number(process.env.PI_COLLAPSE_KEEP ?? 1);

/**
 * The lines to show for a result.
 *
 * Pure, so the decision can be tested without a terminal. `expanded` comes
 * from pi and flips when ctrl+o is pressed.
 */
export function collapsedLines(text: string, expanded: boolean, keep = KEEP): string[] {
	const lines = text.replace(/\s+$/, "").split("\n");
	if (expanded || !ENABLED) return lines;
	// Nothing to gain from a hint that saves one line, and "1 more line, press
	// a key" is a worse read than the line itself.
	if (lines.length <= keep + 1) return lines;
	const hidden = lines.length - keep;
	return [...lines.slice(0, keep), `... (${hidden} more lines, ctrl+o to expand)`];
}

/** The text a tool result carries, ignoring images and other parts. */
export function resultText(result: unknown): string {
	const content = (result as { content?: { type?: string; text?: string }[] })?.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c) => c?.type === "text" && typeof c.text === "string")
		.map((c) => c.text as string)
		.join("\n");
}

/**
 * A renderResult for a tool that summarises itself on its first line.
 *
 * Returns a plain object rather than a pi-tui component: Component is a
 * structural interface whose only required member is render(width), and
 * pi-tui is not resolvable from an installed package's own directory.
 */
export function collapsedRenderer() {
	return (
		result: unknown,
		options: { expanded: boolean },
		theme: { fg: (role: string, s: string) => string },
	) => {
		const lines = collapsedLines(resultText(result), options.expanded);
		return {
			render(): string[] {
				return lines.map((l, i) =>
					i === lines.length - 1 && l.startsWith("... (")
						? theme.fg("muted", l)
						: theme.fg("toolOutput", l),
				);
			},
		};
	};
}
