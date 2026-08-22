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
  /** Agent sessions other than this one talking to the same Ollama. */
  otherSessions?: number;
  /** Cache slots Ollama was started with. One conversation fits per slot. */
  parallelSlots?: number;
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

/**
 * Other agent sessions pointed at the same Ollama.
 *
 * phi and pi are the same binary, so both show up as "pi"; this counts them
 * all and drops our own pid. A session we cannot see is better than a number
 * we invented, so a failure here is undefined rather than zero.
 */
export async function otherSessions(): Promise<number | undefined> {
  try {
    const { stdout } = await run("pgrep", ["-x", "pi"], { timeout: 3000 });
    const pids = stdout.split("\n").map((l) => Number(l.trim())).filter((n) => Number.isFinite(n) && n > 0);
    return pids.filter((pid) => pid !== process.pid && pid !== process.ppid).length;
  } catch (err: unknown) {
    // pgrep exits 1 with no output when nothing matched, which is a real zero.
    if ((err as { code?: number })?.code === 1) return 0;
    return undefined;
  }
}

/** Slots Ollama was started with, as it logged them at boot. */
export function parallelSlots(logPath = path.join(os.homedir(), ".ollama/logs/server.log")): number | undefined {
  try {
    const tail = fs.readFileSync(logPath, "utf8").slice(-2_000_000);
    const hits = [...tail.matchAll(/OLLAMA_NUM_PARALLEL:(\d+)/g)];
    if (hits.length === 0) return undefined;
    const n = Number(hits[hits.length - 1][1]);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

export async function inspect(baseUrl = "http://localhost:11434", minutes = 30): Promise<Health> {
  const notes: string[] = [];
  const [limit, model, others] = await Promise.all([wiredLimit(), loadedModel(baseUrl), otherSessions()]);
  const evictions = recentEvictions(minutes);
  const slots = parallelSlots();

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
    otherSessions: others,
    parallelSlots: slots,
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

  const contended = h.otherSessions !== undefined && h.otherSessions > 0 && h.otherSessions + 1 > (h.parallelSlots ?? 1);

  if (h.evictions > 0 && contended) {
    advice.push(
      `${h.otherSessions} other agent session(s) are using this Ollama, which has ${h.parallelSlots ?? 1} cache slot(s). ` +
        "Two conversations sharing one slot evict each other every time they take turns, so both re-read their whole history. " +
        "Closing the other session, or raising OLLAMA_NUM_PARALLEL, fixes this; the context window is not the problem.",
    );
  }

  if (h.evictions > 0) {
    advice.push(
      `Ollama discarded its prefix cache ${h.evictions} time(s) in the last ${h.evictionWindowMinutes} minutes. ` +
        "Each one makes the next turn re-read the whole conversation, which at depth is minutes, not seconds.",
    );
    if (!contended && h.headroom !== undefined && h.contextLength) {
      advice.push(
        `The model is holding ${gb(h.modelBytes)} of a ${gb(h.wiredLimit)} limit at a ${h.contextLength.toLocaleString()} token window, ` +
          `leaving ${gb(h.headroom)}. Lowering num_ctx shrinks both the model and every cached snapshot: /model-install rebuilds it.`,
      );
    }
  }

  if (perHour >= 4) {
    const why = contended ? `: ${h.otherSessions} other session(s) sharing ${h.parallelSlots ?? 1} cache slot(s)` : "";
    return { level: "bad", summary: `cache thrashing: about ${Math.round(perHour)} evictions an hour${why}`, advice };
  }
  if (h.evictions > 0) return { level: "warn", summary: `${h.evictions} cache eviction(s) recently`, advice };
  return {
    level: "ok",
    summary: `no cache evictions in ${h.evictionWindowMinutes} minutes`,
    advice: h.headroom !== undefined ? [`${gb(h.headroom)} spare inside the wired limit.`] : [],
  };
}
