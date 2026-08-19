# pi-local

Pi extensions for running local models (Ollama, Apple Silicon) as a coding
agent. Built around one measurement: **Claude Code sends 45,349 tokens on its
first turn; Pi sends 1,782.** On a hosted model that difference is invisible;
on a 27B running at ~100 tok/s of prefill it is the difference between 7.5
minutes and 18 seconds before the first token.

Everything here follows from that, plus a second measurement: prefill cost
grows quadratically with prompt length, so the way to stay fast is to keep
context small — not to buy a bigger window.

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
Commands: `/plan`, `/notes`, `/next`.

`plan_next` marks the step done and starts a **fresh session** — context drops
back to its ~2K floor at every step boundary. A `before_agent_start` hook
appends the plan, the current step and the notes to each turn's system prompt,
which is what makes a wiped context safe.

Env: `PI_PLAN_FILE`, `PI_NOTES_FILE`.

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

Run `node --experimental-strip-types test-smart-edit.mjs` to exercise it.
Consider `pi --exclude-tools edit` so the model cannot fall back to the
exact-match tool.

### `auto-handoff.ts` — compact at a threshold, then start clean

At `PI_HANDOFF_PCT` (default 85) of the context window, summarises the session
with a brief aimed at state rather than narrative — done / remaining / why /
constraints / dead ends — writes it to `.pi/HANDOFF.md`, and starts a fresh
session that reconciles `PLAN.md` and `NOTES.md` before continuing.

Commands: `/handoff` (now), `/context` (usage).

### `self-update.ts` — track your own repo

At startup, fetches this repo and fast-forwards if it is behind; new extension
files are registered automatically. Extensions load once at launch, so an
update applies on the **next** run — the notification says so.

Constraints, because this runs remote code on every start:

- fast-forward only; never a merge, rebase or force
- refuses a dirty working tree (your local edits win)
- refuses a diverged branch (your unpushed commits win)
- runs `git` and `pi install` only — no build steps, no repo-supplied hooks
- TUI only, so scripted `--print` runs stay reproducible
- network calls are time-boxed; offline failures are silent

`/update-extensions` checks on demand. Env: `PI_SELFUPDATE=0` to disable,
`PI_SELFUPDATE_REPO` to track a different checkout, `PI_SELFUPDATE_MIN_HOURS`
(default 6) to change how often it checks.

Run `node --experimental-strip-types test-self-update.mjs` — it builds a
throwaway origin and clone, so it never touches the real repo.

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
