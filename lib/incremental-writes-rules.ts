/**
 * Keeps a single generation small enough to survive.
 *
 * From a real failure: asked for a complete arcade game as one self-contained
 * index.html, the agent announced the plan, began the write, and died with
 * `terminated` — three times, losing everything each round. `terminated` is
 * undici reporting a dropped stream, and on a local 8-bit 27B a write that long
 * is minutes of held connection with a KV cache growing toward the machine's
 * memory ceiling. Nothing about the plan was wrong; the unit of work was.
 *
 * The rule is not "large files are bad". Plenty of files are legitimately
 * large. It is that CREATING one in a single uninterruptible generation has no
 * checkpoint: any failure costs the whole thing, and the model cannot review
 * what it already wrote. A skeleton followed by additive edits produces working
 * software after the first step and is recoverable at every step after it.
 */

/** Formats where one big write is normal and there is nothing to stage. */
const BULK_OK = /\.(json|lock|csv|tsv|svg|snap|map|ya?ml|sql|txt|md)$/i

/** Machine-written files: the agent is transcribing, not composing. */
const GENERATED = /(generated|\.min\.|dist\/|build\/|vendor\/|node_modules\/)/i

export interface Limits { maxLines: number; maxBytes: number }
// Sized against measured output: ~12.8 tokens per line of real JS, and the
// models are configured with maxTokens 16384 — a hard ceiling of ~1280 lines
// per response, beyond which the file arrives truncated rather than blocked.
// 700 leaves room for a preamble and keeps a write under ~2 min on the coder
// model, so a dropped stream costs a couple of minutes instead of ten.
// maxBytes tracks it: real code measured 38 bytes/line, so 700 lines ~= 27 KB.
export const DEFAULT_LIMITS: Limits = { maxLines: 700, maxBytes: 28_000 }

export function tooBig(
  path: string,
  content: string,
  exists: boolean,
  limits: Limits = DEFAULT_LIMITS,
): string | null {
  if (BULK_OK.test(path) || GENERATED.test(path)) return null

  const lines = content.split("\n").length
  const bytes = Buffer.byteLength(content, "utf8")
  if (lines <= limits.maxLines && bytes <= limits.maxBytes) return null

  const size = `${lines} lines / ${(bytes / 1024).toFixed(1)} KB`
  const verb = exists ? "rewrites" : "creates"

  return (
    `This ${verb} ${path} in one generation (${size}, over ${limits.maxLines} lines or ` +
    `${(limits.maxBytes / 1024).toFixed(0)} KB).\n\n` +
    `A write this long has no checkpoint: if the stream drops you lose all of it, and you cannot ` +
    `read back what you already wrote. Build it up instead:\n\n` +
    `  1. Write the smallest version that RUNS — structure, entry point, one working path.\n` +
    `  2. Verify it runs.\n` +
    `  3. Add one capability per edit, verifying as you go.\n\n` +
    `You end up at the same file, having had working software the whole way, and a failure costs ` +
    `one step instead of everything.`
  )
}
