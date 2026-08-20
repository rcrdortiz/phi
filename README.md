# pi-local

Pi extensions for running local models (Ollama, Apple Silicon) as a coding
agent. Built around one measurement: **Claude Code sends 45,349 tokens on its
first turn; Pi sends 1,782.** On a hosted model that difference is invisible;
on a 27B running at ~100 tok/s of prefill it is the difference between 7.5
minutes and 18 seconds before the first token.

Everything here follows from that, plus a second measurement: prefill cost
grows quadratically with prompt length, so the way to stay fast is to keep
context small, not to buy a bigger window.

The point of staying that cheap is that the agent runs on the machine you are
already working on. Not a rented GPU, not a spare box in a cupboard: the same
Mac that has your editor, your browser and Slack open right now. Which model
you pick follows directly from that.

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

## Which model, and why it depends on the machine

There are two Qwen3.8 builds here and the choice between them is not really
about quality. It is about whether this machine has a second job.

**`qwen3.8-4MLX` (18 GB, 4-bit) is the default because it shares.** Weights
plus a full 50K KV cache come to ~24.9 GB, leaving ~23 GB of a 48 GB machine
for the desktop, so you can run a session without closing anything first. You give up some
accuracy against the 8-bit build. In return the agent is something you leave
running next to your work rather than an errand you make room for.

**`qwen3.8-8MLX` (31 GB, 8-bit) is for when the machine has nothing else to
do.** Weights plus a full 50K cache come to roughly 37.5 GB, against a 40 GB GPU
wired limit and 48 GB installed. There is no room left for a desktop, and that
is fine if there is no desktop: a dedicated AI box, a spare Mac, a mini you
have SSHed into. Quality becomes the only axis worth optimising, so take it.

Switching is `/model`, mid-session, and `memory-guard.ts` does not take your
word for it: it weighs the selected model's weights plus cache against actually
free memory at startup and on every switch, then offers the models that fit.

`qwen3-coder:30b` sits outside this axis. It is an MoE with 3B active, so it
generates fastest of the three and has no thinking mode at all. Reach for it
when the work is mechanical and volume matters more than judgement.

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

Thinking is controlled here, and it is not obvious in two directions.
**Qwen3.8 thinks by default**, so the only thing that actually switches it off
on Ollama's OpenAI-compatible endpoint is `reasoning_effort: "none"`, sent via
`samplingParams`: measured at 3 completion tokens versus 39 for the same
trivial question. And pi's `reasoning` flag is a capability gate, not a
default. Set it false and pi clamps every level to `off`, Shift+Tab stops
responding and `thinkingLevelMap` is never consulted, so a model that can think
must declare it true and start wherever `defaultThinking` says.

Measured on "Is 1009 prime?": `none` 10 completion tokens, `low` 357,
`medium` 377. The levels above `none` differ far less than their names suggest,
so `low` buys most of the benefit of thinking at slightly lower cost.

Registers the local Ollama models as a Pi provider. Context windows here match
the `num_ctx` baked into each Ollama variant, so Pi never sends more than the
model was loaded with.

| model | weights | ctx | notes |
|---|---|---|---|
| `qwen3-coder:30b` | 18 GB (MoE, 3B active) | 64K | fastest generation |
| `qwen3.8-4MLX` | 18 GB (4-bit MLX) | 64K | default; shares the machine with your work |
| `qwen3.8-8MLX` | 31 GB (8-bit mxfp8) | 64K | best quality; wants the machine to itself |

### `thinking-level.ts` — change how hard it thinks, mid-session

pi already has the control: **Shift+Tab** cycles the thinking level and the
status line shows it beside the model. What was missing was the wiring —
`lib/ollama-models.ts` now maps pi's scale onto Ollama's `reasoning_effort`:

| pi level | sent as | effect |
|---|---|---|
| `off` | `none` | ~10 completion tokens on a simple question |
| `low` | `low` | ~357 tokens |
| `medium` | `medium` | ~377 — barely above low |
| `high` | `high` | most deliberation, slowest first answer |

Measured on the same prompt, so the useful distinction is really *thinking or
not*: `none` to `low` is a 35× jump, `low` to `medium` is 5%.

Each model also starts at its own default when selected (`qwen3.8-4MLX` off,
`qwen3.8-8MLX` high) rather than inheriting the previous model's level (`PI_THINKING_DEFAULTS=0` to keep whatever is current). Changing level
reports what it costs, and warns when free memory is low, since more thinking
fills the context faster and the KV cache grows with it.

**Sampling follows the level.** Qwen publishes different sampling for thinking
and instruct modes, and running thinking at instruct temperatures drives
repetition loops. That used to require a separate model variant per mode
(`qwen3.8-medium`); now the provider is re-registered with matching sampling
whenever the level changes:

| level | temperature | top_p | presence_penalty |
|---|---|---|---|
| `off` / `minimal` | 0.7 | 0.8 | 1.5 |
| `low` / `medium` / `high` | 1.0 | 0.95 | — |

So there are three models, not four: 4-bit, 4-bit MoE coder, and 8-bit. The
thinking dimension is a control, not a copy of the weights.

`/effort` shows the current level; `/effort low` sets it.

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

**A per-request keep_alive is not enough.** It applies to that request only,
and pi's own requests do not set one, so the timer falls back to the server
default of 5 minutes: the model unloads during any pause, and the next message
either pays a full reload or races the teardown and fails with
`Post "http://127.0.0.1:PORT/v1/completions": EOF`. `install.sh` sets
`OLLAMA_KEEP_ALIVE=2h` server-wide, which is what actually keeps it resident.

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

**Finishing a step continues automatically.** `plan_next` sends the next step
back to the agent itself, so a plan runs through without you typing "continue"
after each one. It stops when the plan is finished, and after
`PI_PLAN_MAX_AUTO` (25) unattended steps it pauses and says so — a model that
calls `plan_next` without doing the work cannot spin through the whole plan.
Anything you type resets that allowance. `PI_PLAN_AUTOCONTINUE=0` turns it off.

`plan_next` compacts at the **first turn boundary after the step completes**, not
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

### `auto-handoff.ts` — record compactions, do not compete for them

pi already compacts automatically above `contextWindow - reserveTokens`
(25% of the window, so it triggers at 75% whatever the window is). This extension used to run its own
threshold-based compaction on top, which produced nothing but collisions:

```
Error: This operation was aborted
Error: Compaction failed: Nothing to compact (session too small)
Error: Compaction failed: Already compacted
```

A second mechanism watching the same number can only be early or late, and it
was late — pi always got there first. That logic is gone. What remains:

| trigger | who | on what |
|---|---|---|
| context size | **pi** | tokens, with overflow recovery it owns |
| plan step finished | `plan-notes` | meaning — a boundary pi cannot see |
| `/handoff` | you | when you want it |

Our compactions only run in the band where they are useful, derived from the
context window — for a 50K window, **between ~18,400 and ~38,400 tokens**:

- **below** `keepRecentTokens × 1.2` there is nothing older to summarise, and
  asking returns `Nothing to compact (session too small)` — a short task simply
  does not need one
- **above** `contextWindow - reserveTokens` pi has taken over (compacting, or in
  overflow recovery), and asking returns `Already compacted` after
  `This operation was aborted`

Ours are an optimisation — a semantic boundary pi cannot see — not a duty.

Every compaction, whoever caused it, is written to `.pi/HANDOFF.md` so the
summary survives the session. `/context` shows usage and how much room is left
before pi compacts.

### `tool-budget.ts` — cap one tool result, save the session

Context in a coding session is not conversation, it is tool output. Measured on
a real 1 MB transcript that died of context overflow:

| source | share of context |
|---|---|
| tool results | **88.6%** |
| assistant text | 11.3% |
| user text | 0.1% |
| **images** | **0.0%** (one image, in the whole session) |

Broken down by tool, `view_lines` alone was 54.1% and `read` another 14.8%.

The session was killed by a single call:

```
view_lines {file: "pang.js", offset: "630", limit: "120", end_line: 710}
```

It asked for lines 630-710 and received lines **1-710**: ~36,000 characters where
3,870 were wanted, roughly 10,000 tokens in a single result. `offset`/`limit` are
the built-in read tool's parameter names, so `view_lines` dropped them, and
`start_line ?? 1` then defaulted to the top of the file. Fixed at the source in
`lib/read-lean.ts`; `tool-budget` remains the backstop for everything else.

A cap is the fix rather than better tools because of *when* pi checks: auto
compaction is evaluated at `agent_end`, after results are already in context. By
the time anything can react, the oversized result has landed. That is how usage
reached 163% of a 66K window, leaving compaction no exit but a full re-prefill it
could not finish before the client timed out.

So each result gets 10% of the window (~18,400 chars at 50K). Over that, the
middle is dropped and the head and tail are kept, with a marker saying how much
went and that it is a display limit rather than the end of the file, so the model
narrows its range instead of concluding the file ends there.

**On images, the intuition most people have is wrong.** Token cost is ~1015
pixels per token and is completely independent of file size and format. Measured
on `qwen3.8-4MLX`, the same 800px image costs **477 tokens as a 353 KB PNG and
477 tokens as a 27 KB JPEG**. Compressing an image saves no context whatsoever.
Only downscaling does:

| capture | tokens | % of 50K |
|---|---|---|
| 3024x1964 (full retina) | 5,736 | 11.2% |
| 2000x1299 (pi's built-in cap) | 2,560 | 5.0% |
| 1024x665 | ~670 | 1.3% |

Hence `PI_TOOL_BUDGET_IMAGE_PX` (default 1024) caps the *longest edge*, not the
byte count. JPEG is used for the re-encode only to shrink the payload on the
wire; it buys nothing in context.

| env | default | |
|---|---|---|
| `PI_TOOL_BUDGET_FRACTION` | `0.10` | share of the window per result |
| `PI_TOOL_BUDGET_MIN_CHARS` | `4000` | floor for small windows |
| `PI_TOOL_BUDGET_IMAGE_PX` | `1024` | longest edge for images |
| `PI_TOOL_BUDGET` | | `0` disables it |

`/budget` shows the current limit.

### `read-lean.ts` — reading without paying for the whole file

`view_lines` was 54.1% of everything in the context of the session that died.
Two separate causes, both fixed here.

**An absent `start_line` meant "from line 1".** The fatal call asked for lines
630-710 and got 1-710. `offset` and `limit` are the *built-in* read tool's
parameter names, so typebox dropped them, and the `?? 1` default did the rest.
Blaming the model does not help: both tools exist, both read lines, and it will
keep confusing them. So `offset`/`limit` are now accepted as aliases, quoted
numbers are coerced, the span is capped at `PI_VIEW_MAX_LINES` (400), and an end
with no start is **the window ending there**, never the whole file above it.

The principle is that an ambiguous request should fail *small*. Defaulting a
missing start to line 1 does the opposite: it turns the smallest possible typo
into the largest possible result.

Every adjustment is reported back in the result:

```
pang.js (1036 lines) showing 630-749
[view_lines] `offset` was read as `start_line`; `limit` was read as a line count
```

Without that line the model cannot tell it got a different range than it asked
for, and concludes the file ends where the output does.

**Reading is the wrong way to *find* something.** Most of those 30 calls were
orientation — "where is the render function" — answered by reading hundreds of
lines. `outline` answers it with one line per declaration: for `pang.js`, 79
declarations in 3,943 characters against 46,290 for the file, **12x cheaper**.
The model then views the 30 lines it actually wants. Supports js/ts, python,
php, go/rust, css and markdown, and returns nothing for file types it has no
rule for, so the fallback is a normal read rather than a misleading empty list.
