import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { existsSync } from "node:fs"
import { tooBig, DEFAULT_LIMITS } from "../lib/incremental-writes-rules.ts"

/**
 * Hook wiring only — the rules live in ../lib/ because Pi scans this directory
 * for extension factories and a plain module here fails the session to load.
 */
export default function (pi: ExtensionAPI) {
  pi.registerFlag("max-write-lines", {
    description: `Lines a single write may create before it is blocked (default ${DEFAULT_LIMITS.maxLines})`,
    type: "string",
  })

  pi.on("tool_call", (event) => {
    let path: string | undefined
    let content: string | undefined

    if (event.toolName === "write") {
      const i = event.input as { path?: string; content?: string }
      path = i.path
      content = i.content
    } else if (event.toolName === "edit") {
      // A single edit that pastes an entire file in is the same generation and
      // the same risk, whatever tool carried it.
      const i = event.input as { path?: string; edits?: { newText: string }[] }
      path = i.path
      content = (i.edits ?? []).map((e) => e.newText).join("\n")
    } else {
      return
    }
    if (!path || !content) return

    const override = Number(pi.getFlag("max-write-lines"))
    const limits = Number.isFinite(override) && override > 0
      ? { ...DEFAULT_LIMITS, maxLines: override }
      : DEFAULT_LIMITS

    const problem = tooBig(path, content, existsSync(path), limits)
    if (problem) {
      return {
        block: true,
        reason:
          `BLOCKED by incremental-writes.\n\n${problem}\n\n` +
          `Raise the ceiling with --max-write-lines <n> if this file genuinely has to land in one piece.`,
      }
    }
  })
}
