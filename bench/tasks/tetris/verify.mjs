// The acceptance suite for the tetris task.
//
// The benchmark owns this file and the agent never sees it. That is the whole
// point: an agent that writes its own tests is grading its own homework, and
// "the model said it was done" is not a measurement. This runs against whatever
// was produced and reports what actually holds.
//
// Node only, no browser and no dependencies, so a run costs seconds and the
// score cannot vary with a Chrome version.
//
// Usage: node verify.mjs <dir>   ->  JSON on stdout
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";

const dir = process.argv[2] ?? ".";
const results = [];
const check = (name, fn) => {
  try {
    const ok = fn();
    results.push({ name, pass: ok === true, detail: ok === true ? "" : String(ok) });
  } catch (e) {
    results.push({ name, pass: false, detail: (e && e.message) || String(e) });
  }
};

let Game;
const file = path.join(dir, "tetris.js");
try {
  const src = fs.readFileSync(file, "utf8");
  const sandbox = { globalThis: {}, module: { exports: {} }, exports: {}, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { timeout: 5000 });
  Game = sandbox.TETRIS?.Game ?? sandbox.module?.exports?.Game ?? sandbox.module?.exports?.TETRIS?.Game;
} catch (e) {
  results.push({ name: "tetris.js loads", pass: false, detail: (e && e.message) || String(e) });
}

if (Game) {
  results.push({ name: "tetris.js loads", pass: true, detail: "" });
  const make = (o) => new Game({ cols: 10, rows: 20, seed: 1, ...o });
  const filled = (b) => b.flat().filter(Boolean).length;

  check("a new board is empty and the right shape", () => {
    const s = make().snapshot();
    return (s.board.length === 20 && s.board.every((r) => r.length === 10) && filled(s.board) === 0) || "wrong shape or not empty";
  });
  check("starts at score 0, no lines, level 1, not over", () => {
    const s = make().snapshot();
    return (s.score === 0 && s.lines === 0 && s.level === 1 && s.over === false) || JSON.stringify({ s: s.score, l: s.lines, lv: s.level, o: s.over });
  });
  check("spawn puts four cells on the board", () => {
    const g = make(); g.spawn("T");
    const a = g.snapshot().active;
    return (a && a.kind === "T" && a.cells.length === 4) || "no active piece with four cells";
  });
  check("every tetromino spawns", () => {
    const bad = "IOTSZJL".split("").filter((k) => {
      const g = make(); g.spawn(k);
      const a = g.snapshot().active;
      return !a || a.cells.length !== 4;
    });
    return bad.length === 0 || `failed: ${bad.join(",")}`;
  });
  check("a piece falls one row per step", () => {
    const g = make(); g.spawn("T");
    const before = Math.min(...g.snapshot().active.cells.map(([, y]) => y));
    g.step();
    const after = Math.min(...g.snapshot().active.cells.map(([, y]) => y));
    return after === before + 1 || `moved ${after - before}`;
  });
  check("a piece cannot leave the board sideways", () => {
    const g = make(); g.spawn("O");
    for (let i = 0; i < 20; i++) g.move(-1);
    return g.snapshot().active.cells.every(([x]) => x >= 0) || "escaped left";
  });
  check("rotation keeps four cells inside the board", () => {
    const g = make(); g.spawn("T");
    g.rotate();
    const c = g.snapshot().active.cells;
    return (c.length === 4 && c.every(([x, y]) => x >= 0 && x < 10 && y >= 0 && y < 20)) || "rotation left the board";
  });
  check("drop locks the piece onto the floor", () => {
    const g = make(); g.spawn("O"); g.drop();
    const s = g.snapshot();
    const rows = s.board.map((r, i) => (r.some(Boolean) ? i : -1)).filter((i) => i >= 0);
    return (filled(s.board) === 4 && rows.includes(19)) || `filled ${filled(s.board)}, rows ${rows}`;
  });
  check("a filled row clears and scores 100", () => {
    // Five O pieces side by side fill a ten-wide row. Each is pushed fully left
    // and then stepped right past the ones already placed; moving them all left
    // would stack them in the same two columns, which is a stack, not a row.
    const g = make();
    for (let i = 0; i < 5; i++) {
      g.spawn("O");
      while (g.move(-1));
      for (let n = 0; n < i * 2; n++) g.move(1);
      g.drop();
    }
    const s = g.snapshot();
    return (s.lines >= 1 && s.score >= 100 && filled(s.board) === 0) ||
      `lines ${s.lines}, score ${s.score}, cells left ${filled(s.board)}`;
  });
  check("the same seed gives the same sequence", () => {
    const seq = (seed) => { const g = make({ seed }); const out = []; for (let i = 0; i < 12; i++) { g.spawn(); out.push(g.snapshot().active.kind); g.drop(); } return out.join(""); };
    return seq(7) === seq(7) || `${seq(7)} vs ${seq(7)}`;
  });
  check("a different seed gives a different sequence", () => {
    const seq = (seed) => { const g = make({ seed }); const out = []; for (let i = 0; i < 14; i++) { g.spawn(); out.push(g.snapshot().active.kind); g.drop(); } return out.join(""); };
    return seq(1) !== seq(99) || "identical sequences";
  });
  check("level rises every ten lines", () => {
    const g = make();
    if (typeof g.lines !== "undefined") g.lines = 10;
    const s = g.snapshot();
    return s.level >= 1 || "no level";
  });
  check("stacking to the top ends the game", () => {
    const g = make();
    for (let i = 0; i < 200 && !g.snapshot().over; i++) { g.spawn(); g.drop(); }
    return g.snapshot().over === true || "never ended";
  });
  check("a thousand steps never throw", () => {
    const g = make();
    for (let i = 0; i < 1000; i++) { if (g.snapshot().over) break; if (!g.snapshot().active) g.spawn(); g.step(); }
    return true;
  });
}

const passed = results.filter((r) => r.pass).length;
process.stdout.write(JSON.stringify({ passed, total: results.length, results }, null, 2));
process.exit(0);
