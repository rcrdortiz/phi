# phi

```
          ▄███▄
      ▄▄▄▄█████▄▄▄▄            phi
    ▄██▀▀▀█████▀▀▀██▄
   ██▀    █████    ▀██         a local coding agent that leaves
  ██▌     █████     ▐██        the laptop usable while it runs
  ██▌     █████     ▐██
   ██▄    █████    ▄██         Qwen3.8 27B · 64K context · 48 GB
    ▀██▄▄▄█████▄▄▄██▀
      ▀▀▀▀█████▀▀▀▀
          ▀███▀
```

Run **Qwen3.8 27B locally on a 48 GB+ MacBook Pro, and keep using the laptop
while it runs.** That second half is the whole point. A local coding agent is
easy to set up and easy to make unusable: give it too much context and the
machine swaps, give it too little and it forgets what it was doing.

## What this sits on

[**pi**](https://github.com/earendil-works/pi-coding-agent) is a terminal coding
agent. It reads and edits your files, runs commands, and talks to whichever
model you point it at, local or hosted. It is the thing you actually run.

phi is a package that pi installs. It adds tools and rules that keep a 27B model
inside its budget of memory, context and attention, so a local model stays
usable for real work instead of degrading after twenty minutes.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/rcrdortiz/phi/master/get-phi.sh | bash
```

That installs Ollama, pi, and phi, raises the GPU wired limit, and sets up the
login agent for Ollama's keep-alive. It asks before anything that needs `sudo`,
and is safe to re-run: it skips whatever is already in place.

`raw.githubusercontent.com` caches for five minutes, so immediately after a push
the one-liner can still fetch the previous script. If something looks wrong just
after an update, wait a minute and run it again.

Then run `phi`, and `/model-install` inside it to pull and build a model. Type
`exit` to quit.

**`phi` and `pi` are separate installs sharing one binary.** `phi` runs pi
against its own agent directory (`~/.phi`), so it gets these extensions, the
purple theme, the fullscreen TUI and the local model roster. Plain `pi` keeps
its own directory and behaves exactly as it does on any other machine. Neither
can disturb the other: they do not share a settings file, and a session started
in one does not appear in the other.

**No checkout, at any point.** pi clones and manages the package itself.

**Updates install themselves.** phi checks for a newer pi and a newer phi at
startup, in the background, and asks once if it finds either. Answer yes and it
runs them; `/update` does the same later. Both apply on the next launch, because
node has already loaded the code a running session is using. Set
`PHI_UPDATE_CHECK=0` to skip the network entirely.

The boot box is the only place updates are reported. The `phi` command sets
`PI_OFFLINE=1`, which turns off pi's own startup version and package banners so
the same two facts are not announced twice, in two places, one of them handing
you a command to copy. It also skips pi's remote model catalog refresh, which
this setup has no use for, because the models are local. The update commands
clear the flag for themselves.

## What you need

- Apple Silicon, **48 GB minimum**. The model peaks at ~27 GB with a full
  context; below 48 GB there is nothing left for a desktop.
- Homebrew and node. `get-phi.sh` installs the rest and is safe to re-run.

It raises the GPU wired limit to ~83% of RAM and installs a login agent for
Ollama's keep-alive; both survive reboots. It also sets the TUI to fullscreen,
the theme to `phi-purple`, and `quietStartup`, so launching prints the boot box
rather than a listing of everything that loaded. Exiting is quiet in the same
way: `fullscreenExitOutput` is `resume-hint`, so quitting hands the terminal
back as it was found instead of printing the whole session into the scrollback. Models are not its job, because a
27B pull is not something an installer should start unasked. That is
`/model-install`.

## The model

One model, `qwen3.8-4MLX`: Qwen3.8 27B at 4-bit MLX, **64K context**.

The size of that window is set by the goal, not by taste. Measured on a clean
load with nothing else resident:

| | |
|---|---|
| weights | 18.49 GB, flat (the MLX runner allocates its cache lazily) |
| context cache | ~113 KB per token, measured across the full window |
| at a full 64K | **25.8 GB** |
| left for your desktop | **~22 GB** |

An 80K window was tried and reverted: it measured **31.9 GB**, not the 27 the
per-token figure predicted, because Ollama retains several prefix-cache
snapshots and their cost is not linear in the window.

That last row is the design constraint. `memory-guard` refuses to start below
28 GB free for the same reason: under that, finishing a long session means
swapping, and a swapping local model does not fail. It slows to nothing while
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
of its speed for the rest of the session.

**Compaction fires at 28,000 tokens**, and that number is a hard ceiling rather
than a preference. pi's HTTP idle timeout maxes at 300s; prefill runs ~120 tok/s
at depth; so a prefix-cache miss above ~36,000 tokens cannot finish before the
request is judged idle, and comes back as `Request timed out`. Misses happen:
the server log carries `failed to restore cache, freeing all caches`. So the
working depth has to stay somewhere a miss is survivable. `PI_MAX_SAFE_DEPTH`
caps it independently of the window.

pi has its own trigger at 75%, deliberately above ours. We check at `turn_end`,
which fires inside a long run; pi checks at `agent_end`, which does not. Ours
acting first means pi is only ever the backstop, and matching the two produces
two compactions, one of which returns "Already compacted".

**Thinking is set to `high` by default, and that is the recommendation.** high
is the top of this model's scale, not of pi's: pi accepts `xhigh` and `max`, but
Ollama's `reasoning_effort` takes none/low/medium/high, so mapping them would
add levels that behave exactly like high while looking like more. On a
27B at 4-bit the thinking pass is where the quality comes from, and this setup
assumes a model working alongside you rather than racing you. `Shift+Tab` lowers
it live when a task is mechanical; `/effort` sets it explicitly.

Two other models were tried and dropped: the 8-bit build needs the machine to
itself (~37.5 GB), and `qwen3-coder:30b` was fastest only on an empty context.
By 15K it was behind. A short roster is also a reliability property: this repo
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
| `model-install` | `/model-install` pulls and builds a preconfigured model, and rebuilds one whose modelfile has changed |
| `exit-word` | a bare `exit` closes pi instead of being answered by the model |
| `boot-screen` | replaces pi's banner with one about phi, and offers to install pi and phi updates |

The two that change how you work:

**`plan-notes`**. `plan_write` lays out steps, `plan_next` finishes one and
resets the context. State lives in `.pi/PLAN.md` and `.pi/NOTES.md`, so a wiped
context costs nothing. `/notes-gc` trims notes that have outgrown their welcome.

**`smart-edit`**. `edit_symbol` edits a function or method **by name** rather
than by line number, which is where most failed edits came from. `outline` lists
a file's declarations for a fraction of the cost of reading it. The built-in
`read` and `edit` tools are retired in favour of these: one tool per job.

## Commands

| | |
|---|---|
| `/model-install` | pull and build a preconfigured model |
| `/update` | install a newer pi or phi |
| `/context` | how full the window is, and when it compacts |
| `/speed` | decode rate, and prefill separately |
| `/plan` | show the plan and where it is up to |
| `/next` | finish the current step and reset the context |
| `/notes` | show what is currently on the notes file |
| `/notes-gc` | trim notes that have outgrown their welcome |
| `/syntax` | check a file parses, without reading it back |
| `/handoff` | summarise and compact now |
| `/effort` | set thinking level (or `Shift+Tab`) |
| `/budget` | show the per-tool-result size limit |

## Tuning

Everything has a working default. These exist for when it does not.

| variable | default | |
|---|---|---|
| `PI_TOOL_BUDGET_FRACTION` | `0.10` | window share one tool result may take |
| `PI_TOOL_BUDGET_BASH_FRACTION` | `0.04` | the same, for bash |
| `PI_BASH_TIMEOUT_SECONDS` | `300` | ceiling on a bash call that omits its own |
| `PI_VIEW_MAX_LINES` | `400` | cap on one `view_lines` call |
| `PI_NOTE_MAX_CHARS` | `350` | cap on one note |
| `PI_NOTES_MAX_CHARS` | `4000` | cap on the whole notes file |
| `PI_COMPACT_AT_TOKENS` | 70% of window | depth at which context is compacted |
| `PI_MAX_SAFE_DEPTH` | `28000` | absolute cap on that depth |
| `PI_PLAN_KEEP_DONE` | `3` | completed steps kept in the plan |
| `PI_PLAN_AUTOCONTINUE` | `1` | run steps unattended (also gates the compaction resume) |
| `PI_PLAN_MAX_AUTO` | `25` | unattended steps before pausing |
| `PI_WATCHDOG_MAX_RESUMES` | `25` | mid-step compaction resumes before pausing |
| `PI_MIN_FREE_GB` | `28` | memory floor before pi refuses to start |
| `PI_TOKEN_RATE` | `1` | show decode speed |
| `PI_EXIT_WORD` | `1` | `0` sends a bare `exit` to the model instead of quitting |
| `PHI_BOOT` | `1` | `0` keeps pi's own startup banner |
| `PHI_UPDATE_CHECK` | `1` | `0` draws the box but skips the network |
| `PHI_HOME` | `~/.phi` | where phi's own agent directory lives |

## Why things are the way they are

Nearly every default here was set by measuring something, and the measurement is
recorded next to the code it justifies, in comments and in `git log`. If a
number looks arbitrary, `git log -S` the number and the commit will say what was
measured and why.

Deliberately not duplicated here: this file used to carry all of it, and a
README that repeats what the code already explains goes stale in exactly the way
the code does not.

## Tests

```sh
npm test
```

No framework and no dependencies. Each file under `test/` builds an extension
against a stub pi, asserts, and prints a count; `test/run.mjs` runs them all and
exits non-zero if any assertion fails. Fixtures are generated and committed, so
the suite passes on a machine that has never seen this project.
