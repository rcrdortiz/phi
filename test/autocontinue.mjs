import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetCompactionState } from "../lib/compaction.ts";
import { STATE_DIR, statePath } from "../lib/state-dir.ts";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "auto-"));
const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + d : ""}`); };

async function load(env = {}) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  // Fresh module instance so env changes take effect.
  // Cache-busted so each case gets a fresh module, but resolved against THIS
  // file rather than an absolute path, which only existed on one machine.
  const url = new URL("../extensions/plan-notes.ts", import.meta.url);
  const mod = (await import(`${url.href}?${Math.random()}`)).default;
  const tools = {}, handlers = {}, sent = [], notes = [];
  mod({
    registerTool: (t) => (tools[t.name] = t),
    registerCommand: () => {},
    on: (e, h) => (handlers[e] = h),
    sendUserMessage: (m) => sent.push(m),
  });
  return { tools, handlers, sent, notes };
}

const ctxFor = (notes, tokens = 12_000) => ({
  cwd: DIR, mode: "tui",
  ui: { notify: (t) => notes.push(t), confirm: async () => true },
  getContextUsage: () => ({ tokens, contextWindow: 65_536, percent: (tokens / 65_536) * 100 }),
  compact: (o) => o.onComplete?.({ summary: "s", tokensBefore: tokens }),
});

// 1. Finishing a step continues on its own.
{
  fs.rmSync(path.join(DIR, STATE_DIR), { recursive: true, force: true });
  resetCompactionState();
  const { tools, handlers, sent, notes } = await load();
  const ctx = ctxFor(notes);
  await tools.plan_write.execute("1", { goal: "g", steps: ["one", "two", "three"] }, undefined, undefined, ctx);
  await tools.plan_next.execute("2", {}, undefined, undefined, ctx);
  await handlers["turn_end"]({}, ctx);
  check("continues to the next step without user input", sent.length === 1, sent[0]);
  check("the message names the next step", /step 2 of 3: two/i.test(sent[0] ?? ""), sent[0]);
}

// 2. Finishing the LAST step stops rather than continuing.
{
  fs.rmSync(path.join(DIR, STATE_DIR), { recursive: true, force: true });
  resetCompactionState();
  const { tools, handlers, sent, notes } = await load();
  const ctx = ctxFor(notes);
  await tools.plan_write.execute("1", { goal: "g", steps: ["only"] }, undefined, undefined, ctx);
  const r = await tools.plan_next.execute("2", {}, undefined, undefined, ctx);
  await handlers["turn_end"]({}, ctx);
  check("stops at the end of the plan", sent.length === 0 && /Plan complete/.test(r.content[0].text), r.content[0].text);
}

// 3. The unattended run is capped.
{
  fs.rmSync(path.join(DIR, STATE_DIR), { recursive: true, force: true });
  resetCompactionState();
  const { tools, handlers, sent, notes } = await load({ PI_PLAN_MAX_AUTO: "2" });
  const ctx = ctxFor(notes);
  // Enough steps that the plan is not finished when the cap is reached —
  // otherwise "plan complete" stops it for an unrelated reason.
  await tools.plan_write.execute("1", { goal: "g", steps: ["a", "b", "c", "d", "e", "f", "g", "h"] }, undefined, undefined, ctx);
  for (let i = 0; i < 4; i++) {
    await tools.plan_next.execute(String(i), {}, undefined, undefined, ctx);
    await handlers["turn_end"]({}, ctx);
  }
  check("caps unattended steps", sent.length === 2, `sent ${sent.length}`);
  check("says why it paused", notes.some((n) => /Paused after 2/.test(n)), notes.filter(n => /Paused/.test(n))[0] ?? "");

  // A user message resets the allowance.
  await handlers["input"]({}, ctx);
  await tools.plan_next.execute("x", {}, undefined, undefined, ctx);
  await handlers["turn_end"]({}, ctx);
  check("user input restores the allowance", sent.length === 3, `sent ${sent.length}`);
}

// 4. Opt-out works.
{
  fs.rmSync(path.join(DIR, STATE_DIR), { recursive: true, force: true });
  resetCompactionState();
  const { tools, handlers, sent, notes } = await load({ PI_PLAN_AUTOCONTINUE: "0", PI_PLAN_MAX_AUTO: "25" });
  const ctx = ctxFor(notes);
  await tools.plan_write.execute("1", { goal: "g", steps: ["one", "two"] }, undefined, undefined, ctx);
  await tools.plan_next.execute("2", {}, undefined, undefined, ctx);
  await handlers["turn_end"]({}, ctx);
  check("PI_PLAN_AUTOCONTINUE=0 disables it", sent.length === 0);
}

fs.rmSync(DIR, { recursive: true, force: true });
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
