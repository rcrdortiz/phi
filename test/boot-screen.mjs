import * as fs from "node:fs";
import mod, { renderBox, checkPi, checkPhi, applyUpdates, parseInterval, debugPaint } from "../extensions/boot-screen.ts";

const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + String(d).replace(/\n/g, "\n        ") : ""}`); };
const plain = (_role, s) => s;
const base = { version: "0.1.0", cwd: "/home/x/proj", updates: { checked: true, phase: "idle" }, paint: plain };
const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");

// --- layout ---------------------------------------------------------------
// A box whose rows disagree on width is visibly broken, and colour codes are
// the usual cause: they add bytes that are not columns.
for (const w of [40, 60, 61, 62, 63, 64, 78, 120, 200]) {
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
// The mark is drawn large when there is room and falls back to the glyph when
// there is not, so "is the mark there" is two different questions by width.
check("draws the large mark when the terminal is wide enough",
  withModel.includes("\u2588\u2588\u2588\u2588\u2588") && !withModel.includes("\u03a6"),
  "block art, not the glyph");
const narrow = renderBox(40, { ...base, model: "qwen3.8-4MLX" }).join("\n");
check("falls back to the framed glyph on a narrow terminal",
  narrow.includes("\u03a6") && !narrow.includes("\u2588\u2588\u2588\u2588\u2588"),
  "25 columns of art is most of a 40 column terminal");
check("the large mark is shaded rather than flat",
  new Set(renderBox(78, { ...base, model: "m", paint: (role, t) => "<" + role + ">" + t })
    .join("\n").match(/<(accent|border|muted|dim)>/g) ?? []).size >= 3,
  "a light source needs more than one tone");
check("titles the box Phi with its version", /Phi 0\.1\.0/.test(withModel));

const noModel = renderBox(78, { ...base }).join("\n");
check("a machine with no model is told what to run", /no model yet/.test(noModel) && /\/model-install/.test(noModel),
  "the first thing a new install needs");

// --- updates: the box reports a phase, it does not print a command ------
const avail = { checked: true, phase: "available", pi: { current: "1.0.0", latest: "1.1.0" },
  phi: { behind: 3, from: "0.25.0", to: "0.26.0" } };
const shown = renderBox(78, { ...base, model: "m", updates: avail }).join("\n");
// A commit count answers "how much changed"; a version range answers whether it
// matters, which is the question actually being asked.
check("names what is out of date, as versions",
  /pi 1\.0\.0 \u2192 1\.1\.0/.test(shown) && /phi 0\.25\.0 \u2192 0\.26\.0/.test(shown), shown);
// Between releases both sides carry the same version, and "0.25.0 to 0.25.0"
// would say nothing. That is the only case where the count is the honest report.
const unreleased = renderBox(78, { ...base, model: "m",
  updates: { ...avail, phi: { behind: 3, from: "0.25.0", to: "0.25.0" } } }).join("\n");
check("falls back to the commit count when the version has not moved",
  /phi 3 commit\(s\) behind/.test(unreleased) && !/0\.25\.0 \u2192 0\.25\.0/.test(unreleased), unreleased);
const nover = renderBox(78, { ...base, model: "m",
  updates: { ...avail, phi: { behind: 2 } } }).join("\n");
check("and when no version could be read at all",
  /phi 2 commit\(s\) behind/.test(nover), nover);
check("offers /update rather than a command to copy",
  /\/update to install/.test(shown) && !/npm i -g/.test(shown),
  "copying a command is the friction this replaces");

const phases = {
  installing: /installing/,
  installed: /\u2713 update installed.*restart to update/s,
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

// --- the repeating check ---------------------------------------------------
// A session left open all day would otherwise report the state of the world at
// the moment it started.
check("the default interval is ten minutes", parseInterval(undefined) === 600_000);
check("an explicit interval is honoured", parseInterval("900000") === 900_000);
check("zero means check once at startup and never again", parseInterval("0") === 0);
check("a value under a minute is raised rather than obeyed",
  parseInterval("5000") === 60_000, "5000 is a units mistake, not a request");
check("garbage falls back to the default rather than to never",
  parseInterval("soon") === 600_000 && parseInterval("-1") === 600_000,
  "never looking again is indistinguishable from the feature working");

// The timer has to be unref'd and cleared, or pi cannot exit between the last
// turn and shutdown. Neither is observable without letting the checks reach the
// network, so they are asserted at the source.
const src = fs.readFileSync(new URL("../extensions/boot-screen.ts", import.meta.url), "utf8");
check("the interval does not hold the process open", /timer\.unref\?\.\(\)/.test(src));
check("the interval is cleared on shutdown",
  /session_shutdown[\s\S]{0,120}clearInterval\(timer\)/.test(src));
check("the repeating check does not open a dialog",
  /runChecks\(false\)/.test(src) && /void runChecks\(true\)/.test(src),
  "a modal ten minutes into a run interrupts the work to ask about a typo fix");
check("a check landing during an install is dropped",
  /phase === "installing"\) return;/.test(src));
check("a declined update stays declined",
  /declined \? "declined" : "available"/.test(src),
  "re-announcing it every ten minutes is nagging");

// --- debug mode is visible before anything happens -------------------------
// Debug mode changes what a session does: nothing collapses and every tool call
// is written to disk. Finding that out from a log file that exists is worse
// than being told at the top of the screen.
const dbg = renderBox(92, { ...base, model: "m", debug: true, paint: debugPaint }).join("\n");
check("the debug box says it is in debug mode", /debug/.test(dbg));
check("and says what that changed", /logging to|collapsed/.test(dbg),
  "a colour with no explanation is a mystery, not a signal");

const ESC2 = String.fromCharCode(27);
const tones = (t) => new Set((t.match(new RegExp(ESC2 + "\\[38;5;(\\d+)m", "g")) ?? []));
check("debug repaints the whole box, not just one line",
  tones(dbg).size >= 3, `${tones(dbg).size} tones`);
check("the mark keeps its shading in debug colours",
  tones(renderBox(92, { ...base, model: "m", debug: true, paint: debugPaint }).slice(1, 6).join("\n")).size >= 2,
  "one yellow would flatten the light source the mark is drawn with");

// The ordinary box must not pick up any of this.
const plainBox = renderBox(92, { ...base, model: "m" }).join("\n");
check("an ordinary session says nothing about debug", !/debug/.test(plainBox));
check("rows still align in debug", (() => {
  const rows = renderBox(78, { ...base, model: "m", debug: true, paint: debugPaint })
    .map((l) => l.replace(new RegExp(ESC2 + "\\[[0-9;]*m", "g"), "").length);
  return new Set(rows).size === 1;
})(), "colour must not change the geometry");


// --- the terminal tab says phi, not pi -------------------------------------
// pi builds its title from pkg.piConfig?.name in its own package.json, falling
// back to the literal "π". phi cannot set that without renaming the shared
// binary for plain pi too, so it sets the title itself and re-asserts it,
// because pi rebuilds the title on session and cwd changes.
{
  const titles = [];
  const ctx = { cwd: "/Users/x/AI/pang-clone", mode: "tui", ui: { setTitle: (t) => titles.push(t), setHeader: undefined } };
  const handlers = {};
  const pi = {
    on: (name, fn) => { handlers[name] = fn; },
    registerCommand: () => {}, registerTool: () => {}, setThinkingLevel: () => {},
  };
  mod(pi);
  check("a session_start hook is registered", typeof handlers.session_start === "function");
  check("a turn_end hook re-asserts it", typeof handlers.turn_end === "function",
    "pi rebuilds the title mid-session; a tab name that reverts is worse than one that never changed");
  if (handlers.session_start) await handlers.session_start({}, ctx);
  if (handlers.turn_end) await handlers.turn_end({}, ctx);
  check("the title names phi", titles.every((t) => /phi/.test(t)), JSON.stringify(titles));
  check("the title carries the directory", titles.every((t) => /pang-clone/.test(t)), JSON.stringify(titles));
  check("it never says pi on its own", !titles.some((t) => /(^|[^h])\bpi\b/.test(t)), JSON.stringify(titles));

  // A terminal without setTitle must not take the session down with it.
  const bare = { cwd: "/tmp/x", mode: "tui", ui: {} };
  let threw = false;
  try { if (handlers.turn_end) await handlers.turn_end({}, bare); } catch { threw = true; }
  check("a terminal that cannot set a title is survivable", !threw,
    "a tab name is never worth failing a turn over");
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
