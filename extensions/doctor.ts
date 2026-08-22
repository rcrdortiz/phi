/**
 * doctor — say when the machine, not the model, is the problem.
 *
 * An afternoon went into a session that spent thirty-four minutes producing
 * ninety-eight seconds of generation. Nothing inside the session said anything
 * was wrong: no error, no warning, just slowness that read like a slow model.
 * The cause was Ollama discarding its prefix cache every couple of minutes, so
 * every turn re-read the entire conversation from scratch.
 *
 * That is invisible from where a user sits, and it is the kind of thing a local
 * setup should notice on their behalf rather than leave them to infer from a
 * log they do not know exists.
 *
 * `/doctor` reports it on demand. A session also checks once at startup, and
 * says something only when there is something to say.
 *
 * Env: PHI_DOCTOR=0        no startup check
 *      PHI_DOCTOR_MINUTES  how far back to look, default 30
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BASE_URL } from "../lib/ollama-models.ts";
import { flag } from "../lib/debug.ts";
import { type Health, inspect, verdict } from "../lib/health.ts";

const ENABLED = flag("PHI_DOCTOR", true);
const MINUTES = Number(process.env.PHI_DOCTOR_MINUTES ?? 30);

const gb = (n?: number) => (n === undefined ? "?" : `${(n / 1e9).toFixed(1)} GB`);

export function report(h: Health): string {
  const v = verdict(h);
  const lines = [
    `${v.level === "ok" ? "healthy" : v.level}: ${v.summary}`,
    "",
    `  model      ${h.modelName ?? "not loaded"}`,
    `  window     ${h.contextLength?.toLocaleString() ?? "?"} tokens`,
    `  resident   ${gb(h.modelBytes)} of ${gb(h.wiredLimit)} wired limit`,
    `  headroom   ${gb(h.headroom)}`,
    `  evictions  ${h.evictions ?? "?"} in ${h.evictionWindowMinutes} minutes`,
  ];
  if (v.advice.length) lines.push("", ...v.advice.map((a) => `  ${a}`));
  if (h.notes.length) lines.push("", ...h.notes.map((n) => `  (${n})`));
  return lines.join("\n");
}

export default function doctor(pi: ExtensionAPI): void {
  pi.registerCommand("doctor", {
    description: "Check whether the machine is holding the model back",
    handler: async (_args, ctx) => {
      const h = await inspect(BASE_URL, MINUTES);
      ctx.ui.notify(report(h), verdict(h).level === "bad" ? "warning" : "info");
    },
  });

  if (!ENABLED) return;

  pi.on("session_start", async (_event, ctx) => {
    const c = ctx as unknown as ExtensionContext;
    if (c.mode !== "tui") return undefined;
    // Detached and silent unless it finds something. A health check that
    // announces good health every launch becomes something people stop reading,
    // and then it is not a health check.
    void (async () => {
      try {
        const h = await inspect(BASE_URL, MINUTES);
        const v = verdict(h);
        if (v.level !== "bad") return;
        c.ui.notify(
          `${v.summary}. Turns will be far slower than the model itself is. /doctor explains.`,
          "warning",
        );
      } catch {
        /* a health check must never be the thing that breaks a session */
      }
    })();
    return undefined;
  });
}
