/**
 * Is the machine actually able to run this model well?
 *
 * Written after an afternoon lost to a problem that was invisible from inside a
 * session. Ollama was discarding its whole prefix cache every couple of minutes,
 * so every turn re-prefilled the entire context: thirty-four minutes of wall
 * clock for ninety-eight seconds of generation. Nothing in the session said so.
 * The evidence was in Ollama's log, the GPU wired limit and the resident model
 * size, none of which anyone thinks to check.
 *
 * Everything here degrades to "unknown" rather than guessing. A health check
 * that invents a diagnosis is worse than one that says it cannot tell.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Health {
  /** GPU wired limit in bytes, where the platform exposes one. */
  wiredLimit?: number;
  /** Resident size of the loaded model, from Ollama. */
  modelBytes?: number;
  modelName?: string;
  /** The context the model is actually loaded with, which may not be the roster's. */
  contextLength?: number;
  /** Bytes left inside the wired limit once the model is resident. */
  headroom?: number;
  /** Times Ollama freed its whole prefix cache in the window examined. */
  evictions?: number;
  evictionWindowMinutes?: number;
  notes: string[];
}

/** macOS only. Elsewhere there is no equivalent knob and we say nothing. */
async function wiredLimit(): Promise<number | undefined> {
  if (os.platform() !== "darwin") return undefined;
  try {
    const { stdout } = await run("sysctl", ["-n", "iogpu.wired_limit_mb"], { timeout: 3000 });
    const mb = Number(stdout.trim());
    return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : undefined;
  } catch {
    return undefined;
  }
}

async function loadedModel(baseUrl: string): Promise<{ name?: string; bytes?: number; ctx?: number }> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/v1\/?$/, "")}/api/ps`, {
      signal: AbortSignal.timeout(3000),
    });
    const body = (await res.json()) as { models?: { name?: string; size?: number; context_length?: number }[] };
    const m = body.models?.[0];
    return { name: m?.name, bytes: m?.size, ctx: m?.context_length };
  } catch {
    return {};
  }
}

/**
 * How often Ollama threw away its prefix cache recently.
 *
 * This is the signal that matters and the one nobody looks at. Each occurrence
 * costs a full re-prefill of the whole context, which at depth is minutes.
 */
export function recentEvictions(minutes = 30, logPath = path.join(os.homedir(), ".ollama/logs/server.log")): number | undefined {
  try {
    const raw = fs.readFileSync(logPath, "utf8");
    // The log is large; only the tail can be recent.
    const tail = raw.slice(-2_000_000).split("\n");
    const cutoff = Date.now() - minutes * 60_000;
    let n = 0;
    for (const line of tail) {
      if (!line.includes("freeing all caches")) continue;
      const stamp = /time=(\S+)/.exec(line)?.[1];
      const at = stamp ? Date.parse(stamp) : NaN;
      // A line we cannot date is counted: missing it understates the problem.
      if (!Number.isFinite(at) || at >= cutoff) n++;
    }
    return n;
  } catch {
    return undefined;
  }
}

export async function inspect(baseUrl = "http://localhost:11434", minutes = 30): Promise<Health> {
  const notes: string[] = [];
  const [limit, model] = await Promise.all([wiredLimit(), loadedModel(baseUrl)]);
  const evictions = recentEvictions(minutes);

  const headroom = limit !== undefined && model.bytes !== undefined ? limit - model.bytes : undefined;

  if (limit === undefined) notes.push("no GPU wired limit visible; this check is written for Apple Silicon");
  if (model.bytes === undefined) notes.push("Ollama is not holding a model right now, so its size is unknown");
  if (evictions === undefined) notes.push("Ollama's log could not be read, so cache evictions are unknown");

  return {
    wiredLimit: limit,
    modelBytes: model.bytes,
    modelName: model.name,
    contextLength: model.ctx,
    headroom,
    evictions,
    evictionWindowMinutes: minutes,
    notes,
  };
}

const gb = (n?: number) => (n === undefined ? "unknown" : `${(n / 1e9).toFixed(1)} GB`);

/**
 * A verdict, in the order someone would want to hear it.
 *
 * Deliberately refuses to conclude from partial data: with no eviction count
 * there is no verdict, only what could be read.
 */
export function verdict(h: Health): { level: "ok" | "warn" | "bad" | "unknown"; summary: string; advice: string[] } {
  if (h.evictions === undefined) {
    return { level: "unknown", summary: "not enough is visible to judge", advice: h.notes };
  }
  const perHour = (h.evictions / Math.max(1, h.evictionWindowMinutes ?? 30)) * 60;
  const advice: string[] = [];

  if (h.evictions > 0) {
    advice.push(
      `Ollama discarded its prefix cache ${h.evictions} time(s) in the last ${h.evictionWindowMinutes} minutes. ` +
        "Each one makes the next turn re-read the whole conversation, which at depth is minutes, not seconds.",
    );
    if (h.headroom !== undefined && h.contextLength) {
      advice.push(
        `The model is holding ${gb(h.modelBytes)} of a ${gb(h.wiredLimit)} limit at a ${h.contextLength.toLocaleString()} token window, ` +
          `leaving ${gb(h.headroom)}. Lowering num_ctx shrinks both the model and every cached snapshot: /model-install rebuilds it.`,
      );
    }
  }

  if (perHour >= 4) return { level: "bad", summary: `cache thrashing: about ${Math.round(perHour)} evictions an hour`, advice };
  if (h.evictions > 0) return { level: "warn", summary: `${h.evictions} cache eviction(s) recently`, advice };
  return {
    level: "ok",
    summary: `no cache evictions in ${h.evictionWindowMinutes} minutes`,
    advice: h.headroom !== undefined ? [`${gb(h.headroom)} spare inside the wired limit.`] : [],
  };
}
