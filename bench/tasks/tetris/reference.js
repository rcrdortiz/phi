// A correct implementation of the contract in PROMPT.md.
//
// Not an answer key and not shown to any agent. It exists so test/bench.mjs can
// prove the acceptance suite is passable: a suite nobody has ever passed may
// simply be impossible, and every score it has produced would be meaningless.
// When the suite drifts away from the task, this is what notices.

(function () {
  var SHAPES = {
    I: [[0,1],[1,1],[2,1],[3,1]], O: [[1,0],[2,0],[1,1],[2,1]],
    T: [[1,0],[0,1],[1,1],[2,1]], S: [[1,0],[2,0],[0,1],[1,1]],
    Z: [[0,0],[1,0],[1,1],[2,1]], J: [[0,0],[0,1],[1,1],[2,1]],
    L: [[2,0],[0,1],[1,1],[2,1]]
  };
  var KINDS = Object.keys(SHAPES);
  function Game(cfg) {
    cfg = cfg || {};
    this.cols = cfg.cols || 10; this.rows = cfg.rows || 20;
    this.seed = (cfg.seed === undefined ? 1 : cfg.seed) >>> 0 || 1;
    this.board = []; for (var y = 0; y < this.rows; y++) { var r = []; for (var x = 0; x < this.cols; x++) r.push(null); this.board.push(r); }
    this.score = 0; this.lines = 0; this.level = 1; this.over = false; this.active = null;
  }
  Game.prototype.rand = function () { this.seed = (this.seed * 1103515245 + 12345) >>> 0; return this.seed / 4294967296; };
  Game.prototype.cells = function (a) {
    var out = [], i, c;
    for (i = 0; i < a.shape.length; i++) { c = a.shape[i]; out.push([a.x + c[0], a.y + c[1]]); }
    return out;
  };
  Game.prototype.fits = function (a) {
    var cs = this.cells(a), i, x, y;
    for (i = 0; i < cs.length; i++) {
      x = cs[i][0]; y = cs[i][1];
      if (x < 0 || x >= this.cols || y < 0 || y >= this.rows) return false;
      if (this.board[y][x]) return false;
    }
    return true;
  };
  Game.prototype.spawn = function (kind) {
    if (!kind) kind = KINDS[Math.floor(this.rand() * KINDS.length) % KINDS.length];
    var shape = SHAPES[kind].map(function (c) { return [c[0], c[1]]; });
    var a = { kind: kind, shape: shape, x: Math.floor((this.cols - 4) / 2), y: 0 };
    this.active = a;
    if (!this.fits(a)) { this.over = true; }
    return a;
  };
  Game.prototype.move = function (dx) {
    if (!this.active) return false;
    var t = { kind: this.active.kind, shape: this.active.shape, x: this.active.x + dx, y: this.active.y };
    if (!this.fits(t)) return false;
    this.active.x = t.x; return true;
  };
  Game.prototype.rotate = function () {
    if (!this.active) return false;
    var rotated = this.active.shape.map(function (c) { return [3 - c[1], c[0]]; });
    var minx = Math.min.apply(null, rotated.map(function (c) { return c[0]; }));
    var miny = Math.min.apply(null, rotated.map(function (c) { return c[1]; }));
    rotated = rotated.map(function (c) { return [c[0] - minx, c[1] - miny]; });
    var t = { kind: this.active.kind, shape: rotated, x: this.active.x, y: this.active.y };
    if (!this.fits(t)) return false;
    this.active.shape = rotated; return true;
  };
  Game.prototype.lock = function () {
    var cs = this.cells(this.active), i;
    for (i = 0; i < cs.length; i++) this.board[cs[i][1]][cs[i][0]] = this.active.kind;
    this.active = null;
    var kept = this.board.filter(function (r) { return r.some(function (v) { return !v; }); });
    var cleared = this.rows - kept.length;
    while (kept.length < this.rows) { var r = []; for (var x = 0; x < this.cols; x++) r.push(null); kept.unshift(r); }
    this.board = kept;
    if (cleared) {
      this.score += [0, 100, 300, 500, 800][cleared] * this.level;
      this.lines += cleared;
      this.level = 1 + Math.floor(this.lines / 10);
    }
    this.spawn();
    return cleared;
  };
  Game.prototype.step = function () {
    if (this.over) return 0;
    if (!this.active) { this.spawn(); return 0; }
    var t = { kind: this.active.kind, shape: this.active.shape, x: this.active.x, y: this.active.y + 1 };
    if (this.fits(t)) { this.active.y = t.y; return 0; }
    return this.lock();
  };
  Game.prototype.drop = function () {
    var cleared = 0, guard = 0;
    while (this.active && !this.over && guard++ < 100) { var before = this.active; cleared = this.step(); if (this.active !== before) break; }
    return cleared;
  };
  Game.prototype.snapshot = function () {
    var self = this;
    return {
      board: this.board.map(function (r) { return r.slice(); }),
      active: this.active ? { kind: this.active.kind, cells: self.cells(self.active) } : null,
      score: this.score, lines: this.lines, level: this.level, over: this.over
    };
  };
  globalThis.TETRIS = { Game: Game };
})();
