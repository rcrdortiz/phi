import * as fs from "node:fs";
import mod, { renderBox, checkPi, checkPhi } from "../extensions/boot-screen.ts";

const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + String(d).replace(/\n/g, "\n        ") : ""}`); };
const plain = (_role, s) => s;
const base = { version: "0.1.0", cwd: "/home/x/proj", updates: { checked: true }, paint: plain };
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

// --- updates --------------------------------------------------------------
const upd = renderBox(78, { ...base, model: "m", updates: { checked: true, pi: { current: "1.0.0", latest: "1.1.0" }, phi: { behind: 3 } } }).join("\n");
check("reports a pi update with the command to run", /pi 1\.0\.0 to 1\.1\.0/.test(upd) && /npm i -g/.test(upd));
check("reports how far phi is behind", /phi is 3 commit\(s\) behind/.test(upd));

const clean = renderBox(78, { ...base, model: "m", updates: { checked: true } }).join("\n");
check("says nothing when everything is current", !/update/.test(clean),
  "an up-to-date machine should get no nag");

// --- the checks fail silently ---------------------------------------------
check("an unknown current version skips the pi check", (await checkPi("")) === undefined);
check("a directory that is not a repo yields no phi update", (await checkPhi("/nonexistent-xyz")) === undefined,
  "offline and broken must be indistinguishable from up-to-date");

// --- wiring ---------------------------------------------------------------
const handlers = {};
mod({ on: (e, h) => ((handlers[e] ||= []).push(h)), registerCommand: () => {}, registerTool: () => {} });
check("hooks session_start", (handlers["session_start"] ?? []).length > 0);

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
