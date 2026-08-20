# pi-local

Run **Qwen3.8 27B locally on a 48 GB+ MacBook Pro, and keep using the laptop
while it runs.** That second half is the whole point. A local coding agent is
easy to set up and easy to make unusable: give it too much context and the
machine swaps, give it too little and it forgets what it was doing.

This is [pi](https://github.com/earendil-works/pi-coding-agent) plus a set of
extensions that keep a 27B model inside its budget — memory, context and
attention — without you having to think about it.

```sh
git clone https://github.com/rcrdortiz/pi-local.git
cd pi-local && ./install.sh
pi
```

**Clone it, do not download a zip.** The extensions keep themselves current by
fast-forwarding this repo at startup, which needs a real checkout with an
`origin`. Updates are offered, never taken.

## What you need

- Apple Silicon, **48 GB minimum**. The model peaks at ~26 GB with a full
  context; below 48 GB there is nothing left for a desktop.
- Homebrew, node, and Ollama. `install.sh` handles the rest and is safe to
  re-run.

It raises the GPU wired limit to ~83% of RAM and installs a login agent for
Ollama's keep-alive. Both survive reboots.

## The model

One model, `qwen3.8-4MLX` — Qwen3.8 27B at 4-bit MLX, **64K context**.

The size of that window is set by the goal, not by taste. Measured on a clean
load with nothing else resident:

| | |
|---|---|
| weights | 18.49 GB (flat — the MLX runner allocates its cache lazily) |
| at 2.5K tokens | 18.66 GB |
| at a full 64K | **25.79 GB** |
| left for your desktop | **~22 GB** |

That last row is the design constraint. `memory-guard` refuses to start below
28 GB free for the same reason: under that, finishing a long session means
swapping, and a swapping local model does not fail — it slows to nothing while
looking like it is still thinking.

**Speed depends on how full the context is, not how big it can get.** Measured
cold on an idle machine:

| depth | decode | |
|---|---|---|
| ~0 | 47 tok/s | 100% |
| 4.5K | 45 tok/s | 96% |
| 9K | 39 tok/s | 83% |
| 18K | 17 tok/s | 36% |
| 53K | 15 tok/s | 32% |

The cliff sits between 9K and 18K, and past it the model stays at about a third
of its speed for the rest of the session. So the 64K window is a *ceiling* — it
stops a hard overflow and costs almost nothing unused — while **compaction fires
at 12K**, which is what keeps the model in the fast band. Raise the ceiling
freely; raise `PI_COMPACT_AT_TOKENS` only if you are willing to pay for it.

**Thinking is set to `high` by default, and that is the recommendation.** On a
27B at 4-bit the thinking pass is where the quality comes from, and this setup
assumes a model working alongside you rather than racing you. `Shift+Tab` lowers
it live when a task is mechanical; `/effort` sets it explicitly.

Two other models were tried and dropped: the 8-bit build needs the machine to
itself (~37.5 GB), and `qwen3-coder:30b` was fastest only on an empty context —
by 15K it was behind. A short roster is also a reliability property: this repo
has direct evidence that giving a model two ways to do one job costs accuracy.

## What the extensions do

| | |
|---|---|
| `ollama-local` | registers the local model with pi |
| `memory-guard` | refuses to start, or switch, into a model that will swap |
| `model-preload` | loads the weights before you type |
| `thinking-level` | `Shift+Tab` / `/effort` change effort mid-session |
| `plan-notes` | plan and findings live on disk, so context can be thrown away |
| `smart-edit` | edits that survive a model with imperfect whitespace recall |
| `tool-budget` | stops one tool result eating the window |
| `auto-handoff` | compacts mid-run, and records every compaction to disk |
| `token-rate` | decode speed in the footer, so a stall is visible |
| `incremental-writes` | large files written in verified chunks |
| `self-update` | offers new commits at startup |

The two that change how you work:

**`plan-notes`** — `plan_write` lays out steps, `plan_next` finishes one and
resets the context. State lives in `.pi/PLAN.md` and `.pi/NOTES.md`, so a wiped
context costs nothing. `/notes-gc` trims notes that have outgrown their welcome.

**`smart-edit`** — `edit_symbol` edits a function or method **by name** rather
than by line number, which is where most failed edits came from. `outline` lists
a file's declarations for a fraction of the cost of reading it. The built-in
`read` and `edit` tools are retired in favour of these: one tool per job.

## Tuning

Everything has a working default. These exist for when it does not.

| variable | default | |
|---|---|---|
| `PI_TOOL_BUDGET_FRACTION` | `0.10` | window share one tool result may take |
| `PI_TOOL_BUDGET_BASH_FRACTION` | `0.04` | the same, for bash |
| `PI_VIEW_MAX_LINES` | `400` | cap on one `view_lines` call |
| `PI_NOTE_MAX_CHARS` | `350` | cap on one note |
| `PI_COMPACT_AT_TOKENS` | `12000` | depth at which context is compacted |
| `PI_PLAN_KEEP_DONE` | `3` | completed steps kept in the plan |
| `PI_PLAN_AUTOCONTINUE` | `1` | run steps unattended |
| `PI_MIN_FREE_GB` | `28` | memory floor before pi refuses to start |
| `PI_TOKEN_RATE` | `1` | show decode speed |

## Why things are the way they are

Nearly every default here was set by measuring something, and the measurement is
recorded next to the code it justifies — in comments, and in `git log`. If a
number looks arbitrary, `git log -S` the number and the commit will say what was
measured and why.

Deliberately not duplicated here: this file used to carry all of it, and a
README that repeats what the code already explains goes stale in exactly the way
the code does not.

## Tests

```sh
for t in test-*.mjs; do node "$t"; done
```

No framework. Each file builds the extension against a stub pi, asserts, and
prints a count.
