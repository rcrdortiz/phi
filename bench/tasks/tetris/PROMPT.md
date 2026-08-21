Build a Tetris core in plain JavaScript, in a single file named `tetris.js` in
the current directory. Logic only: no rendering, no DOM, no dependencies.

The file must define `globalThis.TETRIS = { Game }` and work when loaded in node
with `require()` or `eval`.

## Contract

`new Game({ cols = 10, rows = 20, seed = 1 })`

Pieces are the seven tetrominoes, named `I O T S Z J L`.

Methods:
- `spawn(kind)` places that piece at the top, centred. With no argument, take
  the next piece from the seeded sequence.
- `move(dx)` shifts the active piece horizontally if the target cells are free;
  returns whether it moved.
- `rotate()` rotates the active piece clockwise if the result fits; returns
  whether it rotated.
- `step()` drops the active piece one row. If it cannot fall, the piece locks,
  full rows clear, and the next piece spawns. Returns the number of rows cleared.
- `drop()` steps until the piece locks. Returns rows cleared.
- `snapshot()` returns `{ board, active, score, lines, level, over }` where
  `board` is an array of `rows` arrays of `cols` values, each `null` for empty
  or the piece kind that filled it; `active` is `{ kind, cells }` with `cells`
  an array of `[x, y]` pairs in board coordinates, or `null` when there is none.

Rules:
- Scoring: 100, 300, 500, 800 for 1, 2, 3, 4 rows cleared at once, multiplied by
  `level`. `level` starts at 1 and increases by 1 for every 10 lines cleared.
- `over` becomes true when a newly spawned piece overlaps an occupied cell.
- The same `seed` must always give the same sequence of pieces.

## Done means

`node --check tetris.js` passes and the contract above holds exactly. Nothing
else is required: no UI, no tests of your own, no README.
