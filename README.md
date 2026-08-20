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

### Retiring the built-in `read`

`read` and `view_lines` did the same job with different parameter names, and
across 30 sessions that cost 17 broken `view_lines` calls: the model borrowed
`offset`/`limit` from `read`, and `view_lines` dropped them and started at line
1. `read` was also uncapped, and 33.3% of all context.

The precedent is `edit`, retired for exactly this reason, and the logs vindicate
it: the built-in `edit` failed **20 of 41 calls (49%)**, `edit_block` **0 of
31**. One tool per job is what stops a local model guessing between two schemas.
`PI_KEEP_BUILTIN_READ=1` puts it back.

### The re-read cache

18% of everything `read`/`view_lines` ever returned was lines the model had
already been shown, with no edit to that file in between: 176,722 characters,
~49,000 tokens, and `pang.js` alone was 48,000 of them.

"With no edit in between" is the whole design. Re-reading after an edit is
correct, because line numbers have moved and the model's memory of them is
genuinely stale, so the cache keys on file size and mtime and forgets a file the
moment it changes, whoever changed it. Every edit passes through one function,
so that is the single place invalidation has to happen.

It only suppresses a **fully** covered range. Partial overlaps are delivered
whole: handing back a fragment with a hole in it is the same class of confusion
that made `view_lines` expensive to begin with. `refresh:true` forces a re-read.

### Bash was routing around all of it

The top 10 bash calls were 29% of all bash output and were almost entirely file
dumps:

```
13,927 ch   cat .pi/NOTES.md
10,206 ch   awk '{printf "%3d| %s\n", NR, $0}' pang.js
```

That `awk` is the model reimplementing `view_lines` in bash. These land between
8K and 14K characters, which slips *under* the general cap, so they escaped
every protection while being exactly what the read tools exist to prevent.

bash now gets a tighter budget of its own (4% of the window), which costs
nothing: only 26 of 371 logged calls exceeded 2,000 characters. When a command
is genuinely a file read, the result carries a pointer to `outline`/`view_lines`.

Detection masks quoted spans before judging punctuation. The `awk` line above
contains a `|` inside its own program, so a naive pipe check classifies the
single largest leak as a legitimate pipeline and waves it through. Real
pipelines and redirects are left alone: `cat x | grep y` filters before anything
reaches the context, and steering away from it would make things worse.

### `token-rate.ts` — generation speed in the footer

Local inference speed is not a constant. It decays as the KV cache grows, it
collapses when the machine swaps, and on a shared desktop it moves whenever
something else wakes up. None of that announces itself: a session that has
quietly dropped from 30 tok/s to 4 looks exactly like one that is thinking hard.

Measured from `message_start` to `message_end` around a single assistant
message, so tool time is excluded, using the provider's own `usage.output`
rather than an estimate from text length. The session average is
token-weighted, so a two-word reply that returns instantly cannot skew it.
`/speed` reports it, `PI_TOKEN_RATE=0` hides it.

### Plans that stay about what is left

Two changes to `plan-notes`, both aimed at the same thing: a plan is a working
document about remaining work, not a monument to finished work.

**Revisions no longer ask permission.** `plan_write` used to block on a confirm
dialog whenever a revision dropped steps. That defeats the point of `plan_next`,
which exists so the agent can run unattended across context resets: a prompt
nobody is sitting there to answer stalls the run until it times out. The failure
it guarded against is also cheap to undo, because dropped completed steps are in
the archive and the plan is a file in the repo.

The change is still announced (`Plan revised: dropping 2 pending, adding 2,
keeping 1`), because silence is the real failure mode, not the absence of a
prompt. Pure additions stay quiet: nothing was lost, so there is nothing to draw
attention to.

**Completed steps are archived past the most recent three.** A finished step
costs context twice, and the second one is expensive. On disk it is one line in
`PLAN.md`, which is nothing. But `briefing()` seeds **every fresh session** with
the completed list and each step's summary, so a long plan means every context
reset opens by re-reading things nobody will do again.

Measured on a 24-step plan with 20 completed:

| | PLAN.md |
|---|---|
| without archiving | 1,773 chars (~493 tokens) |
| with archiving | 448 chars (~124 tokens) |
| **reduction** | **75%** |

Three are kept because the immediate past is load-bearing: it is how the model
knows what it just did and why the current step follows from it. Beyond that it
is history, and history belongs in a file you open on purpose. The briefing and
`plan_status` name `.pi/PLAN-DONE.md` and its count, so replanning can consult
it deliberately instead of being handed it every time.

`PI_PLAN_KEEP_DONE` changes how many stay; `PI_PLAN_DONE_FILE` moves the archive.

### `notes.ts` — what belongs in NOTES.md, and for how long

The notes file from the pang-clone work: 26 notes, 14,723 characters, ~4,090
tokens, re-injected into **every** fresh session by `briefing()`. Reading them
found three different things sharing one bucket and one lifetime:

| | |
|---|---|
| **9 of 26** | progress narration: "Step 1 done:", "delivered across 6 steps" |
| **2 of 26** | actively **false** by the time they were read |
| ~6 of 26 | genuine invariants worth keeping forever |

The false ones matter most. One said `test/run.html` was still the old
Space-Invaders suite; another said 6 tests were failing. A later note recorded
the rewrite and 44/44 passing. Both were true when written, both rotted, and
both were still being fed to every new session.

**Why not an LRU.** It cannot work mechanically: `briefing()` injects the whole
file every time, so every note is "used" on every turn and there is no access
signal to sort by — an LRU degenerates into insertion order. And it optimises
the wrong axis. Recency is uncorrelated with which of those three kinds a note
is, so it would keep fresh narration and evict the oldest invariant. The part of
the human-memory analogy that does transfer is consolidation and decay, not
recency: what stays true hardens, observations about a passing situation fade.
So lifetime is a property of the KIND of note, declared when it is written.

Three rules:

- **Narration is refused**, not trimmed. `plan_next` already records what a step
  accomplished, in the plan, where it is archived after three steps. A note
  saying it again is a second copy nothing prunes. Refusing costs one retry and
  teaches the boundary.
- **`state` is a category with a lifetime.** Observations about the current
  condition of the work are dropped at the next step boundary, because that is
  exactly when "currently" stops being true. Both rotted notes would have
  retired on time.
- **350 characters per note** (`PI_NOTE_MAX_CHARS`). The file averaged 565
  against a "one or two sentences" instruction, so the instruction alone did not
  hold. Over-long notes are trimmed at a sentence boundary rather than refused:
  a refusal risks a loop with a model that cannot reliably self-shorten, and the
  point of a note is nearly always in its first sentence.

### The edit loop, and the four things that caused it

A real session got stuck editing one file. The chain is worth recording, because
every link was a separate defect and only the last one was obvious:

1. `replace_lines` refused an `expect` that sat outside the replaced range, and
   answered with the raw range content — `}` — which is ambiguous.
2. The model went back to `view_lines` to copy exact text, and the **read cache
   refused it**: "already shown above, scroll up".
3. Unable to quote the text, its next edit broke the file and was auto-reverted.
4. It abandoned the tools for `python3 - <<PY ... open(p,"w") ... PY`, which
   inserted a block at class-body scope instead of inside the method, and left
   an unbalanced brace with no revert.

**The re-indent cascade was the root cause.** `reindent` anchored on the first
line's indentation as a string prefix:

```js
if (own && l.startsWith(own)) return baseIndent + l.slice(own.length);
return baseIndent + l.trimStart();          // flattens everything else
```

A replacement whose first line has no indent gives `own === ""`, which is falsy,
so **every** line took the fallback and lost its nesting. A `}` ends up in the
same column as the `if` that opened it. That is what "the re-indent cascade is
mangling braces" meant, and it is why the model stopped trusting the tools. Now
anchored on the *minimum* indent across the block, so relative depth survives
even when the surrounding file's indentation is irregular.

The other three:

- **The read cache no longer refuses cheap reads.** Suppressing a 9-line re-read
  saved ~40 tokens and cost an entire edit cycle plus a broken file. Anything at
  or under `PI_READ_CACHE_MIN_LINES` (60) is always served; suppression is for
  re-reads that are actually expensive.
- **A failed `expect` is now self-correcting.** It returns the range *numbered*,
  and when the text exists nearby it says where: "That text is at line 4, outside
  3-3." Everything needed to fix the call is in the error, so there is no reason
  to go back and re-read.
- **Shell writes to source files are flagged.** Every edit through the tools is
  syntax-checked and reverted on failure; a heredoc bypasses that completely, so
  a broken edit made that way stays broken. `tool-budget` now says so.

### `edit_symbol` — edit by name, not by line number

The audit that produced this, across 30 sessions:

| tool | calls | failed |
|---|---|---|
| `replace_lines` | 114 | **39 (34%)** |
| `edit_block` | 34 | 6 (18%) |
| `write` | 30 | 1 (3%) |

And the reasons `replace_lines` failed: **22 "edit broke the file"**, where a
range cut across a brace boundary, and **16 "expect did not match"**, where the
numbers had gone stale. Both are line-number problems. The model was never
really asking for lines 311-329; it was asking for *the end of `play()`*.

So `edit_symbol` resolves the span from the syntax:

```
edit_symbol { symbol: "Game.play", action: "append", text: "..." }
  -> Game.play (204-329): appended inside, before line 329
```

`replace` swaps the whole thing, `append`/`prepend` go inside the body,
`before`/`after` go outside it. `Class.method` disambiguates a repeated name.

Three details that decide whether it can be trusted:

- **Brace matching ignores strings and comments.** A naive counter is wrong the
  moment a file contains `"}"` or a commented-out block, and it fails *silently*
  — you get a span off by one nesting level and an edit that corrupts the file.
- **An unknown symbol lists what the file does contain**, so the next call can be
  right without a round trip through `outline`.
- **Python is refused, not half-handled.** Its blocks are indentation-scoped and
  need a different algorithm; a partly-working version would fail in exactly the
  silent way this tool exists to prevent.

**On the cost of more tools.** Schemas ride in the system prompt on every
request, and they are cheap: 8 custom tools were 1,776 tokens, ~222 each, 3.5%
of a 51K window. The real cost is *selection*, and there is direct evidence for
it here — `read` coexisting with `view_lines` produced 17 malformed calls before
`read` was retired. That is why the audit added one tool rather than five:
`edit_symbol` addresses roughly 38 of the 45 recorded edit failures, and nothing
else in the data justified a second.

### Paying twice for the same tokens

Measured on a live session, before anything is typed:

| injected every turn | |
|---|---|
| `.pi/NOTES.md` | 16,323 chars ≈ **4,534 tokens** |
| `.pi/PLAN.md` | 2,683 chars ≈ **745 tokens** |
| **briefing floor** | **~5,279 tokens = 10.3% of a 51K window** |

That is the cost of `briefing()` doing its job, and it is worth paying. What is
not worth paying is the *second* copy. In that same session the model ran
`view_lines .pi/PLAN.md` and `cat .pi/NOTES.md` — both files it was already
holding — because the briefing arrives as system text with no filename attached,
so "read the plan" looks like the obvious move.

Both paths now say so instead: `view_lines` on an injected file returns a
pointer (`refresh:true` overrides), and `tool-budget` flags the same trap
through the shell.

**Completed steps outgrew the work remaining.** `plan_next` appends its summary
to the step, and that summary is re-injected for as long as the step is
retained. On the live plan the two finished lines were 857 and 875 characters
against ~245 for each pending one. Summaries are now capped at
`PI_PLAN_SUMMARY_MAX` (180).

**`/notes-gc` applies the note rules retroactively.** They only bind new notes,
so a file written before them keeps costing its old size forever. On the live
file: **16,323 → 6,245 chars, 62% smaller, ~4,534 → ~1,735 tokens on every
request**, dropping 10 notes — all of them `Step N done` narration already
recorded in the plan — and trimming 15. Dry by default, `--apply` writes and
keeps a `.bak`.

**One thing that costs nothing:** skills. pi only injects the skills block when
the `read` tool is active (`hasRead = tools.includes("read")`), and `read` is
retired here. The startup banner still lists them as loaded. The flip side is
that skills are also non-functional in this setup, since the block it would
inject tells the model to open them with `read`.
