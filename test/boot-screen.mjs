import * as fs from "node:fs";
import mod, { renderBox, checkPi, checkPhi, applyUpdates } from "../extensions/boot-screen.ts";

const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + String(d).replace(/\n/g, "\n        ") : ""}`); };
const plain = (_role, s) => s;
const base = { version: "0.1.0", cwd: "/home/x/proj", updates: { checked: true, phase: "idle" }, paint: plain };
const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");

// --- layout ---------------------------------------------------------------
// A box whose rows disagree on width is visibly broken, and colour codes are
// the usual cause: they add bytes that are not columns.
for (const w of [40, 60, 78, 120, 200]) {
  const out = renderBox(w, { ...base, model: "qwen3.8-4MLX", contextWindow: 65536, thinking: "high" });
  const widths = new Set(out.map((l) => l.length));
  check(`rows align at width ${w}`, widths.size === 1, `widths: ${[...widths].join(", ")}`);
}
const wide = renderBox(300, { ...base, model: "m" });
check("very wide terminals are capped, not stretched", wide[0].length <= 92, `${wide[0].length} cols`);
// A box wider than the terminal does not wrap politely: it pushes the right
// border onto the next row and the frame comes apart.
for (const w of [20, 30, 40]) {
  const n = renderBox(w, { ...base, model: "qwen3.8-4MLX", contextWindow: 65536 });
  check(`width ${w} never exceeds the terminal`, n.every((l) => l.length <= w),
    `widest row: ${Math.max(...n.map((l) => l.length))} of ${w}`);
}

// Colour must not break the padding.
const painted = renderBox(78, { ...base, model: "m", paint: (_r, s) => String.fromCharCode(27) + "[35m" + s + String.fromCharCode(27) + "[0m" });
const stripped = painted.map((l) => l.replace(ANSI, ""));
check("colour does not disturb alignment", new Set(stripped.map((l) => l.length)).size === 1,
  `widths: ${[...new Set(stripped.map((l) => l.length))].join(", ")}`);

// --- content --------------------------------------------------------------
const withModel = renderBox(78, { ...base, model: "qwen3.8-4MLX", contextWindow: 65536, thinking: "high" }).join("\n");
check("names the model, window and thinking level",
  /qwen3\.8-4MLX/.test(withModel) && /64K context/.test(withModel) && /thinking high/.test(withModel));
check("shows the phi symbol", withModel.includes("Φ"));
check("titles the box Phi with its version", /Phi 0\.1\.0/.test(withModel));

const noModel = renderBox(78, { ...base }).join("\n");
check("a machine with no model is told what to run", /no model yet/.test(noModel) && /\/model-install/.test(noModel),
  "the first thing a new install needs");

// --- updates: the box reports a phase, it does not print a command ------
const avail = { checked: true, phase: "available", pi: { current: "1.0.0", latest: "1.1.0" }, phi: { behind: 3 } };
const shown = renderBox(78, { ...base, model: "m", updates: avail }).join("\n");
check("names what is out of date", /pi 1\.0\.0 to 1\.1\.0/.test(shown) && /phi 3 commit\(s\) behind/.test(shown));
check("offers /update rather than a command to copy",
  /\/update to install/.test(shown) && !/npm i -g/.test(shown),
  "copying a command is the friction this replaces");

const phases = {
  installing: /installing/,
  installed: /update installed.*restart pi to apply/s,
  failed: /update failed/,
  declined: /\/update to install/,
};
for (const [phase, re] of Object.entries(phases)) {
  const out = renderBox(78, { ...base, model: "m", updates: { ...avail, phase }, error: "EACCES" }).join("\n");
  check(`the box reports the ${phase} phase`, re.test(out), out.split("\n").slice(-3, -1).join(" | ").trim());
}

const clean = renderBox(78, { ...base, model: "m", updates: { checked: true, phase: "idle" } }).join("\n");
check("says nothing when everything is current", !/update/.test(clean),
  "an up-to-date machine should get no nag");

// --- applying ------------------------------------------------------------
const calls = [];
const okExec = async (cmd, args) => { calls.push(`${cmd} ${args.join(" ")}`); };
let r = await applyUpdates({ checked: true, phase: "available", pi: { current: "1", latest: "2" }, phi: { behind: 1 } }, okExec);
check("installs pi and phi", r.ok && calls.length === 2, calls.join(" | "));
check("uses npm for pi and pi update for phi",
  /npm i -g @earendil-works\/pi-coding-agent/.test(calls[0]) && /^pi update/.test(calls[1]), calls.join(" | "));

calls.length = 0;
r = await applyUpdates({ checked: true, phase: "available", phi: { behind: 1 } }, okExec);
check("only updates what is actually behind", r.ok && calls.length === 1 && /^pi update/.test(calls[0]), calls.join(" | "));

r = await applyUpdates({ checked: true, phase: "available", pi: { current: "1", latest: "2" } },
  async () => { throw new Error("EACCES: permission denied, access '/usr/local/lib'"); });
check("a failed install is reported, not thrown", r.ok === false && /EACCES/.test(r.error ?? ""), r.error);

// --- the checks fail silently ---------------------------------------------
check("an unknown current version skips the pi check", (await checkPi("")) === undefined);
check("a directory that is not a repo yields no phi update", (await checkPhi("/nonexistent-xyz")) === undefined,
  "offline and broken must be indistinguishable from up-to-date");

// --- wiring ---------------------------------------------------------------
const handlers = {}, cmds = [];
mod({ on: (e, h) => ((handlers[e] ||= []).push(h)), registerCommand: (n) => cmds.push(n), registerTool: () => {} });
check("hooks session_start", (handlers["session_start"] ?? []).length > 0);
check("registers /update", cmds.includes("update"));

let headerSet = false;
await handlers["session_start"][0]({}, {
  mode: "print", cwd: "/x",
  ui: { setHeader: () => { headerSet = true; }, notify: () => {} },
});
check("a --print run gets no header", headerSet === false, "the box is a TUI thing");

// The theme it asks pi to use must actually ship.
const theme = JSON.parse(fs.readFileSync(new URL("../themes/phi-purple.json", import.meta.url), "utf8"));
check("the purple theme ships and is named", theme.name === "phi-purple");
check("every colour resolves to a var or a literal",
  Object.values(theme.colors).every((v) => String(v).startsWith("#") || v in theme.vars),
  "an unresolved name silently falls back to a default");

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
