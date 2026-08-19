# pi-local

Pi extensions for running local models (Ollama, Apple Silicon) as a coding
agent. Built around one measurement: **Claude Code sends 45,349 tokens on its
first turn; Pi sends 1,782.** On a hosted model that difference is invisible;
on a 27B running at ~100 tok/s of prefill it is the difference between 7.5
minutes and 18 seconds before the first token.

Everything here follows from that, plus a second measurement: prefill cost
grows quadratically with prompt length, so the way to stay fast is to keep
context small — not to buy a bigger window.

## If someone shared this with you

```sh
git clone https://github.com/rcrdortiz/pi-local.git
cd pi-local && ./install.sh
pi --provider ollama-local --model qwen3-coder:30b
```

**Clone it — do not download a zip.** The extensions keep themselves current by
fast-forwarding this repo at startup, which needs a real git checkout with an
`origin`. From a zip you get a snapshot and no updates.

**Updates are offered, never taken.** When there are new commits you get a
prompt at startup listing them, with *Update now* / *Not now* / *Stop asking*.
Nothing is pulled until you choose. Taking someone else's commits onto your
machine should be a decision each time, not consent you gave once at install.

`PI_SELFUPDATE=auto` applies silently if you would rather not be asked;
`PI_SELFUPDATE=0` disables the check entirely. Whichever you pick, it only ever
runs `git` and `pi install` — never build steps or anything else from the repo —
and refuses to touch your working tree if you have edited anything.

Local edits always win: the updater refuses a dirty or diverged tree and tells
you rather than overwriting your work. Check on demand with
`/update-extensions`, and set `PI_SELFUPDATE_MIN_HOURS=0` if the default
six-hour gap is too slow.

## This is not `ollama launch pi`

Ollama ships its own launcher for coding agents (`ollama launch pi`, and the
same for claude / opencode / codex). That opens a model picker of Ollama's
recommendations — including `:cloud` models that need a sign-in and are not
local at all — and it knows nothing about this repo.

If you want the setup described here, ignore that launcher and run:

```sh
./install.sh
pi --provider ollama-local --model qwen3-coder:30b
```

## Where the models come from

Ollama's registry, not Hugging Face — `install.sh` runs `ollama pull` on three
tags (~67 GB total). Hugging Face is only useful here for GGUF builds; Ollama
refuses MLX repos from HF ("Repository is not GGUF"), and the MLX builds are
what make this fast on Apple Silicon.

## What this assumes

Tuned for a **48 GB Apple Silicon Mac**. On different hardware you will want to
change:

- **the models** — `qwen3.8:27b-mlx` and `:27b-mxfp8` are Apple MLX builds;
  on Linux/NVIDIA use the GGUF or FP8 tags instead
- **the memory thresholds** — `PI_MIN_FREE_GB` (30) and `PI_MIN_ACTUAL_GB` (8)
  will refuse to start on a 16 GB machine, correctly but unhelpfully
- **the GPU limit** — `install.sh` now scales it to ~83% of installed memory
  (39 GB on a 48 GB Mac, 24 GB on a 32 GB one), so it no longer assumes this
  machine

## Install

```sh
./install.sh                 # everything: ollama, models, variants, pi, extensions, GPU limit
./install.sh --skip-models   # config only, no ~67GB of downloads
./install.sh --skip-sysctl   # leave the GPU memory limit alone (no sudo)
```

Idempotent — re-run it any time; it skips what is already in place. What it does:

1. Checks macOS / Apple Silicon / memory size and warns if models will not fit
2. Installs Ollama, starts the server, and makes flash attention + the
   quantised KV cache persistent (~2.3x generation speed at long context)
3. Raises the GPU wired limit to 40 GB via a LaunchDaemon, so it survives reboots
4. Pulls the three base models and builds the variants from `modelfiles/`
5. Installs pi and registers every extension
6. Verifies the models show up in `pi --list-models`

## Extensions

### `ollama-local.ts` — the models

Thinking is controlled here, and it is not obvious: **Qwen3.8 thinks by
default**, and pi's `reasoning: false` only stops pi *asking* for thinking. The
only thing that actually switches it off on Ollama's OpenAI-compatible endpoint
is `reasoning_effort: "none"`, sent via `samplingParams` — measured at 3
completion tokens versus 39 for the same trivial question.

Registers the local Ollama models as a Pi provider. Context windows here match
the `num_ctx` baked into each Ollama variant, so Pi never sends more than the
model was loaded with.

| model | weights | ctx | notes |
|---|---|---|---|
| `qwen3-coder:30b` | 18 GB (MoE, 3B active) | 64K | fastest generation |
| `qwen3.8-fast` | 18 GB (4-bit MLX) | 64K | everyday work |
| `qwen3.8-medium` | 18 GB (4-bit MLX) | 64K | thinking enabled |
| `qwen3.8-reasoning` | 31 GB (8-bit mxfp8) | 64K | best quality, needs the machine to itself |

### `memory-guard.ts` — refuse to start without room

A model that doesn't fit doesn't fail cleanly: macOS swaps, prefill decays to
zero, and the session hangs looking like it is thinking. Observed once as a
10-minute hang that produced nothing.

Two thresholds, because one is not enough:

- `PI_MIN_FREE_GB` (default 30) — available memory, counting resident Ollama
  models as reclaimable since loading another evicts them.
- `PI_MIN_ACTUAL_GB` (default 8) — *actually* free memory. Without this, 37 GB
  of resident models makes a machine with 3 GB free look like it has 40.

It also checks the **selected model** specifically — weights + context cache +
headroom against what is available — at startup and again on `/model`. A
startup-only threshold misses the common case: start with 35 GB free, then
switch to a 31 GB model.

In the TUI the warning lists the models that *do* fit and switches to the one
you pick. In `--print` it exits immediately rather than hanging.

### `model-preload.ts` — load the weights before you type

Ollama loads lazily, so the first message of a session pays 10–30s of model
load on top of its own prefill. This fires an empty request at startup (and on
`/model`) so the weights are resident by the time you finish typing, and sets
`keep_alive` (default `2h`) so the model doesn't unload while you think.

Env: `PI_OLLAMA_URL`, `PI_KEEP_ALIVE`.

### `plan-notes.ts` — state on disk, not in context

Moves the two things worth remembering out of the conversation:

- `.pi/PLAN.md` — ordered checklist, one step in progress
- `.pi/NOTES.md` — durable findings by category (technical / product / design /
  gotcha / decision)

Tools: `plan_write`, `note_add`, `plan_status`, `plan_next`.

**Revising a plan asks first.** If `plan_write` would drop steps, it explains
the change and waits:

```
Change the plan?

No longer doing:
  - add enemies
  - add sound
Adding:
  + add power-ups
  + add music

Is that correct?
```

Declining leaves the plan untouched and tells the model the revision was
refused, so it discusses rather than quietly proceeding. Steps repeated in the
revision keep their completed state — and their recorded summary — so a change
of direction never makes finished work look outstanding. Pure additions do not
interrupt, and non-interactive runs apply without prompting.
Commands: `/plan`, `/notes`, `/next`.

`plan_next` marks the step done and starts a **fresh session** — context drops
back to its ~2K floor at every step boundary. A `before_agent_start` hook
appends the plan, the current step and the notes to each turn's system prompt,
which is what makes a wiped context safe.

`plan_next` resets at the **first turn boundary after the step completes**, not
when the whole run settles — during a long agentic run the model may work
through several more steps before settling, which is the context growth the
reset exists to prevent.

`plan_next` does not reset the session itself: the context handed to a tool
comes from an optional factory and can lack `newSession` (observed as
`ctx.newSession is not a function`). It records the intent and the reset happens
on `agent_settled`, which runs with the mode's full context — falling back to
compaction, and then to a warning, so a missing API costs context size rather
than correctness.

Env: `PI_PLAN_FILE`, `PI_NOTES_FILE`. Test: `node --experimental-strip-types test-plan-notes.mjs`.

### `smart-edit.ts` — edits a local model can actually land

The built-in `edit` tool needs byte-exact `oldText`. A 30B model cannot reliably
reproduce indentation, so matches fail — and a failing match tends to push it
into blind `sed`/`awk` splicing, which corrupts the file and makes the next
match harder. Observed on a real file: a `};` indented 2 spaces that the model
kept matching at 5, and seven lines left at odd indents by its own repair
attempts.

- `edit_block` — matches on line **content**, ignoring indentation, then
  re-indents the replacement to the file's own style
- `replace_lines` — deterministic line-range replacement with an `expect` guard
- `view_lines` — numbered view for targeting ranges
- `/syntax <file>` — check a file by hand

Every write is syntax-checked (js/cjs/mjs/json/py/php) and **reverted if it
breaks the file**, so a bad edit costs one error message instead of a corrupted
file. Misses report the closest lines; ambiguous matches are refused with line
numbers rather than guessed at.

**It retires the built-in `edit` tool at startup**, because leaving it
available means the model keeps reaching for it and keeps getting "Could not
find the exact text". Set `PI_KEEP_BUILTIN_EDIT=1` to keep both.

Why the built-in tool fails: it *does* fuzzy-match, but only trailing
whitespace, smart quotes, dashes and Unicode forms — then falls back to a plain
`indexOf`. **Leading indentation must be byte-exact**, and that is the one thing
a local model does not reproduce reliably.

Run `node --experimental-strip-types test-smart-edit.mjs` to exercise it.

### `auto-handoff.ts` — compact on a forecast, not a threshold

Two pressures, two responses:

| when | what happens | why |
|---|---|---|
| mid-task | **compact** | swapping sessions here would abort work in flight |
| plan step done | **session swap** (`plan-notes`) | the only moment a full reset is free |

The trigger is a projection. Usage is sampled every turn, which gives a growth
rate; if the next `PI_HANDOFF_LOOKAHEAD` turns (default 2) would cross
`PI_HANDOFF_PCT` (85), it compacts *now*. A fixed threshold is checked too late
by definition — one turn that reads three files can jump 20% in a single step,
which is how a session reaches 90% having never been seen at 85%.
`PI_HANDOFF_HARD` (93) compacts immediately regardless of the forecast.

The summary is written to `.pi/HANDOFF.md` as well as compacted into the
session, structured as state rather than narrative: done / in progress /
constraints & decisions / dead ends.

`/context` shows usage, the measured growth per turn, and how many turns of
room are left. `/handoff` compacts on demand.

## Notes from building this

- **`session_start` does not fire in `--print` mode.** Only the extension
  factory is guaranteed to run in every mode, which is why the memory gate
  lives there.
- **`ctx.ui.confirm()` blocks forever outside the TUI.** Gate any dialog on
  `ctx.mode === "tui"`.
- **`before_agent_start` returns `systemPrompt` / `message`,** not the
  `additionalContext` the docs imply. Check `dist/core/extensions/types.d.ts`
  in the installed package rather than trusting prose.
- Model sizes and the roster live in `lib/ollama-models.ts`, imported by both
  `ollama-local.ts` and `memory-guard.ts` — defined twice, they drift.
- Ollama reuses the KV cache across turns, so only *new* tokens are prefilled:
  a first turn costing 26s was followed by turns costing 0.4s. Anything that
  changes the start of the prompt (a `/clear`, a model switch) throws that away.
