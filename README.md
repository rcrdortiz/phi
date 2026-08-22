# phi

```
          ███
        ███████
    ███████████████            phi
  █████   ███   █████
 ████     ███     ████         a local coding agent that leaves
 ███      ███      ███         the laptop usable while it runs
 ███      ███      ███
 ████     ███     ████         Qwen3.8 27B · 64K context · 48 GB
  █████   ███   █████
    ███████████████
        ███████
          ███
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

`phi -v` reports both versions, phi's and the pi underneath it, because almost
everything phi does is constrained by the second one.

**Updates install themselves.** phi checks for a newer pi and a newer phi at
startup, in the background, and asks once if it finds either. Answer yes and it
runs them; `/update` does the same later. Both apply on the next launch, because
node has already loaded the code a running session is using. Set
`PHI_UPDATE_CHECK=0` to skip the network entirely.

It looks again every ten minutes, so a session left open all day is not still
reporting the state of the world at the moment it started. The repeating check
never opens a dialog: a modal appearing mid-run interrupts the work to ask
about a typo fix, and the answer to "install now?" while the model is mid-edit
is always no. It updates the box, and `/update` installs when the moment is
right. A declined update stays declined rather than being re-announced every
ten minutes. `PHI_UPDATE_INTERVAL_MS=0` checks once at startup and never again.

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

**Compaction fires at 36,000 tokens**, and that number is a measured bound
rather than a preference. A prefix-cache miss has to re-prefill the whole context, and
prefill runs ~120 tok/s at depth, so past a certain depth a miss cannot finish
before pi's HTTP idle timeout and comes back as `Request timed out` instead of
slowly. Misses happen: the server log carries `failed to restore cache, freeing
all caches`. So the working depth has to stay somewhere a miss is survivable.
`PI_MAX_SAFE_DEPTH` caps it independently of the window.

Prefill rate is not flat, which an earlier version of this assumed. Measured on
an idle machine with the weights resident, forcing a cache miss each time:

| depth | prefill | rate | margin under a 500s timeout |
|---|---|---|---|
| 12,193 | 74s | 165 tok/s | |
| 18,271 | 126s | 145 tok/s | |
| 31,772 | 224s | 142 tok/s | 276s |
| 39,698 | 335s | 119 tok/s | 165s |
| 47,625 | 413s | 115 tok/s | 87s |

`httpIdleTimeoutMs` is a pi setting: 300s is the default and the largest value
its settings picker offers, but it takes any millisecond count, and this install
seeds 500s. That is what makes 36,000 possible at all; under 300s the same
depth cannot recover from a miss. The cost of the longer timeout is that a
genuinely hung request takes three minutes longer to admit it.

**The trigger is bounded by the timeout, not set beside it.** It is the lowest
of three: 70% of the window, a fixed 36,000, and 70% of what prefill can cover
before the timeout. So lowering `httpIdleTimeoutMs` lowers the working depth
automatically. A literal trigger and a changed timeout drift apart silently, and
36,000 above a 300s install's 34,500 ceiling is a guaranteed `Request timed out`
dressed up as a configuration choice.

48,000 was rejected: 413s against a 500s timeout is 87s of margin, and these
numbers come from an idle machine. One being used for something else, which is
the entire point here, prefills slower than this.

**The footer counts against the model's window, not against the trigger.** It
reads 66K because that is what the model can hold; compaction fires at 36,000,
so a footer showing 55% is already at the point of compacting. The `ctx` chip
next to it shows the number that actually decides, and `/context` reports both.

**Compaction summarises at a lower thinking level.** pi passes the session's
level to the summarisation call, so at `high` the model deliberates before
writing the summary. Measured live: 79 seconds of prefill and then roughly 380
seconds of generation, against a 500 second timeout it was about to hit.
Summarising a transcript is not a reasoning task, so it runs with thinking off
and the session's level is restored afterwards.

**Compaction shows elapsed seconds and a progress bar.** It is a model call on
a large prompt, so it takes as long as a turn does, and a slow one and a wedged
one look identical behind a spinner. The estimate averages the last five
compactions in this project, kept in `.phi/compaction-times.json`, so a fresh
session already has one. The first compaction in a new project shows a clock
and no bar, because there is nothing to compare against.

**What the summary keeps.** State, not narrative: what is done with its concrete
outcome, what is in progress, decisions and constraints, and dead ends so they
are not retried. It is also told to record what was decided rather than the
deliberation that reached it. That matters more than it sounds: at thinking
level high a single decision can run to several hundred tokens of reconsidering,
and a faithful summary preserves all of it. The test the model is given is
whether a sentence would change what the next session does.

pi has its own trigger at 75%, deliberately above ours. We check at `turn_end`,
which fires inside a long run; pi checks at `agent_end`, which does not. Ours
acting first means pi is only ever the backstop, and matching the two produces
two compactions, one of which returns "Already compacted".

**Thinking is set to `low` by default, and that is a cost choice rather than a
measured one.** A sweep of off, low, medium and high on a bug-hunt task scored
18 to 20 out of 23 at every level, inside a noise floor of plus or minus two
measured from identical control runs, and output tokens did not track the level
at all (r = +0.17, n = 11). Nothing distinguished them, so the cheap end wins
until something does. `Shift+Tab` raises it live when a task warrants it, and
`/effort` sets it explicitly.

high is the top of this model's scale, not of pi's: pi accepts `xhigh` and
`max`, but Ollama's `reasoning_effort` takes none/low/medium/high, so mapping
them would add levels that behave identically to high while looking like more.

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
| `collapse` (lib) | tool results render as one line until `ctrl+o` |
| `auto-handoff` | compacts mid-run, resumes what it interrupted, and writes a handoff on every compaction and on exit |
| `token-rate` | decode speed in the footer, so a stall is visible |
| `incremental-writes` | large files written in verified chunks |
| `model-install` | `/model-install` pulls and builds a preconfigured model, and rebuilds one whose modelfile has changed |
| `exit-word` | a bare `exit` closes pi instead of being answered by the model |
| `working-timer` | what the turn is doing, and how long it has been doing it |
| `resume-hint` | makes the resume command pi prints on exit name `phi` |
| `doctor` | `/doctor`, and a startup check for cache thrashing |
| `usage-log` | records what each tool call costs, for `/usage` |
| `boot-screen` | replaces pi's banner with one about phi, and offers to install pi and phi updates |

The two that change how you work:

**`plan-notes`**. `plan_write` lays out steps, `plan_next` finishes one and
resets the context. A step is `[ ]` waiting, `[o]` where work last
happened, `[x]` done. The middle mark is set automatically on the first edit,
because "current" was otherwise inferred as "the first one not done", which
cannot tell a step someone was interrupted in from one nobody has touched. After
a crash, a ctrl+c or a compaction, that is the whole question.

It is not called "in progress" on purpose. The mark is evidence that an edit
landed while that step was current, not proof the edit was on it: work asked for
in chat, outside the plan, marks it too. Naming it for what it measures keeps
the next session from trusting it further than it deserves. State lives in `.phi/PLAN.md` and `.phi/NOTES.md`, so a wiped
context costs nothing. `/notes-gc` trims notes that have outgrown their welcome.

A finished plan briefs the model that it is finished, keeps showing `NOTES.md`,
and says the next task needs its own `plan_write`. An edit is refused when every
step in `PLAN.md` is already done, because that means new work started without a
plan: the previous task's plan is still on
disk, finished, and the model is about to change the repo against it. That is
the one case where "no plan" is unambiguous rather than a guess, so it is the
only one that blocks. A session that never had a plan may be answering a
one-line request and is left alone. `PI_PLAN_GATE=0` turns it off.

**How a character budget becomes a token budget.** `tool-budget` works in
characters and thinks in tokens, so the conversion has to match what a tool
actually returns. Measured against the model's own tokenizer, each sample sent
once and twice so the chat template's overhead cancels:

| content | chars/token |
|---|---|
| English prose | 5.60 |
| TypeScript source | 3.57 |
| Markdown | 3.51 |
| JavaScript source | 3.38 |
| JSON | 2.01 |
| Command output | 2.00 |

Formatting costs tokens too, and some of it buys nothing. Measured the same
way, holding the information constant and changing only the shape:

| change | saving |
|---|---|
| `ls -1` instead of `ls -la` | 86.5% |
| compact JSON instead of `indent=2` | 45.3% |
| dropping `view_lines`' line numbers | 22.8% |
| tabs instead of spaces | 0.6% |
| removing blank lines | 0.0% |

The last two are noise, and neither was ours to change. The gutter is: line
numbers cost about 4.4 tokens a line, of which the right-alignment padding is
one and buys nothing, so `view_lines` writes `12|code` rather than `  12| code`.
The remaining 3.4 pays for `replace_lines` being able to address an edit at all.

One number cannot cover that spread. Shell output and JSON pack nearly twice
the tokens per character that source does, so `bash`, `ls`, `grep` and `find`
convert at 2.0 and everything else at 3.4. The single 3.6 this replaces came
from a transcript of mixed code and prose: fair for a file read, and wrong
enough for a command result that it was sized as costing 45% of what it really
cost. The budget errs dense deliberately, because under-counting overruns the
window while over-counting only truncates a little early.

**`smart-edit`**. `edit_symbol` edits a function or method **by name** rather
than by line number, which is where most failed edits came from. `outline` lists a file's declarations, its section banners, and for HTML its tags and inline script, for a fraction of the cost of reading it: 16x cheaper than the file on a 529-line test page. The built-in
`read` and `edit` tools are retired in favour of these: one tool per job.

**Finding the next thing to optimise.** Run with `PHI_DEBUG=1`, work normally,
then `/usage`. Debug mode turns on the logs and turns off the hiding: tool
output stops collapsing, tool costs are recorded, message ends are written out.
The boot box turns yellow and says so, because a mode that changes what a
session does should be visible before anything has happened, rather than
discovered from a log file that exists.
One switch, because a debug mode that makes you name each thing you wanted, or
that collapses the output you asked to see, is not one. Anything set explicitly
still wins, since that was a decision rather than a default.

`/usage` reports where the tokens went: per tool, with calls, total, share,
median and worst, plus the individual calls that cost the most, plus shell
commands grouped by total cost. Commands are grouped on their full text, not
their program: `ls` and `ls -laR /` cost wildly different amounts, and a cheap
command run forty times is the shape worth finding. Median next to total on purpose, because they answer
different questions. A tool with a high total and a low median is called often
and is working as intended; a high median means it is expensive every time, and
that is the one worth changing. Raw records are in `.phi/usage.jsonl`, one line
per call.

Every measured improvement in this repo was found after something had already
gone wrong: a stalled session, a timeout, a budget wrong by a factor of two.
This is the same evidence collected before the fact.

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
| `/usage` | which tools are spending the context |
| `/doctor` | whether the machine is holding the model back |
| `/syntax` | check a file parses, without reading it back |
| `/handoff` | summarise and compact now |
| `/effort` | set thinking level (or `Shift+Tab`) |
| `/budget` | show the per-tool-result size limit |

## Tuning

Everything has a working default. These exist for when it does not.

| variable | default | |
|---|---|---|
| `PI_CHARS_PER_TOKEN` | `3.4` | chars per token for source and prose |
| `PI_CHARS_PER_TOKEN_BASH` | `2.0` | the same, for shell output and JSON |
| `PI_TOOL_BUDGET_FRACTION` | `0.10` | window share one tool result may take |
| `PI_TOOL_BUDGET_BASH_FRACTION` | `0.04` | the same, for bash |
| `PI_BASH_TIMEOUT_SECONDS` | `300` | ceiling on a bash call that omits its own |
| `PI_VIEW_MAX_LINES` | `400` | cap on one `view_lines` call |
| `PI_NOTE_MAX_CHARS` | `350` | cap on one note |
| `PI_NOTES_MAX_CHARS` | `4000` | cap on the whole notes file |
| `PI_COMPACT_AT_TOKENS` | 70% of window | depth at which context is compacted |
| `PI_MAX_SAFE_DEPTH` | `36000` | absolute cap on that depth |
| `PI_CEILING_FRACTION` | `0.7` | share of the prefill ceiling the depth may use |
| `PI_PREFILL_CEILING_TOKENS` | derived | depth past which compaction stops waiting for a clean margin |
| `PI_PREFILL_TOKENS_PER_SECOND` | `115` | measured prefill rate at depth, used to derive that ceiling |
| `PI_PLAN_KEEP_DONE` | `3` | completed steps kept in the plan |
| `PI_PLAN_AUTOCONTINUE` | `1` | run steps unattended (also gates the compaction resume) |
| `PI_PLAN_GATE` | `1` | `0` allows edits when the plan on disk is finished |
| `PI_PLAN_MAX_AUTO` | `25` | unattended steps before pausing |
| `PI_WATCHDOG_MAX_RESUMES` | `25` | mid-step compaction resumes before pausing |
| `PI_MIN_FREE_GB` | `28` | memory floor before pi refuses to start |
| `PI_TOKEN_RATE` | `1` | show decode speed |
| `PI_COMPACT_THINKING` | `off` | thinking level for the summarisation; `keep` inherits the session's |
| `PI_COMPACT_QUIET` | `1` | `0` shows the interruption our own compaction causes |
| `PI_EXIT_HANDOFF` | `1` | `0` skips the note written when you quit |
| `PI_COLLAPSE_TOOLS` | `1` | `0` renders tool results in full |
| `PI_COLLAPSE_KEEP` | `1` | lines kept before the expand hint |
| `PI_COMPACT_SAMPLES` | `5` | past compactions the progress estimate averages |
| `PHI_DEBUG` | off | `1` records the logs and stops collapsing tool output |
| `PHI_DEBUG_MESSAGE_END` | off | `1` logs every assistant message end to `.phi/message-end.log` |
| `PHI_USAGE_LOG` | off | `1` records tool costs without the rest of debug mode |
| `PHI_DOCTOR` | `1` | `0` skips the startup health check |
| `PHI_DOCTOR_MINUTES` | `30` | how far back `/doctor` looks for evictions |
| `PHI_USAGE_MAX_BYTES` | `2000000` | log size before the oldest half is dropped |
| `PI_EXIT_WORD` | `1` | `0` sends a bare `exit` to the model instead of quitting |
| `PI_WORKING_TIMER` | `1` | `0` leaves pi's plain "Working..." alone |
| `PHI_RESUME_HINT` | `1` | `0` leaves pi's exit line alone |
| `PI_KEEP_RECENT_TOKENS` | from settings | what pi keeps past a compaction |
| `PHI_BOOT` | `1` | `0` keeps pi's own startup banner |
| `PHI_UPDATE_CHECK` | `1` | `0` draws the box but skips the network |
| `PHI_UPDATE_INTERVAL_MS` | `600000` | how often to look again; `0` checks only at startup |
| `PHI_HOME` | `~/.phi` | where phi's own agent directory lives |
| `PHI_STATE_DIR` | `.phi` | per-project plan, notes and handoffs |

## Why things are the way they are

Nearly every default here was set by measuring something, and the measurement is
recorded next to the code it justifies, in comments and in `git log`. If a
number looks arbitrary, `git log -S` the number and the commit will say what was
measured and why.

Deliberately not duplicated here: this file used to carry all of it, and a
README that repeats what the code already explains goes stale in exactly the way
the code does not.

**Quitting leaves a note.** Ctrl+C writes a "where this stopped" section to the
top of `.phi/HANDOFF.md`: the plan step in progress, anything cut off mid-call,
the files changed, and the last few actions. Assembled from what is already
known rather than summarised by the model, because a summary is a model call on
the whole context and the one thing someone pressing ctrl+c has said is that
they want out now.

It goes above the previous compaction summary rather than over it. That summary
is a model-written account of the work and is better material than this; an exit
is no reason to lose it. A session that did nothing writes nothing, so a stub
never replaces a real summary.

**When the machine is the problem, not the model.** A session once spent
thirty-four minutes producing ninety-eight seconds of generation. Nothing inside
it said anything was wrong: no error, no warning, just slowness that read like a
slow model. Ollama was discarding its prefix cache every couple of minutes, so
every turn re-read the whole conversation from scratch.

`/doctor` reports it: the wired limit, the resident model, the window it is
loaded with, the headroom, and how often the cache was thrown away recently. A
session checks once at startup and says something only when there is something
to say, because a health check that reports good health every launch is one
people stop reading.

It refuses to guess. With Ollama's log unreadable there is no verdict, only what
could be seen, and a missing number prints as unknown rather than as zero.

## Releases

`CHANGELOG.md` and semver, read against the behaviour of a session rather than
against an API, because phi does not have one. **major** needs something from
you (a setting, a reinstall, a model rebuild). **minor** changes how sessions
run and is worth reading before you accept it. **patch** fixes things.

```sh
npm run release -- patch|minor|major [--dry]
```

It bumps `package.json`, dates the `## Unreleased` entry, commits and tags. It
refuses a dirty tree and an empty entry, and it stops at the tag: pushing is
separate, since a tag pushed by accident is awkward to withdraw.

This matters more than it would for a library, because phi replaces itself on
the machine it runs on. "3 commits behind" does not tell you whether the update
is a typo fix or a changed default that will alter how your sessions compact.

## Tests

```sh
npm test
```

No framework and no dependencies. Each file under `test/` builds an extension
against a stub pi, asserts, and prints a count; `test/run.mjs` runs them all and
exits non-zero if any assertion fails. Fixtures are generated and committed, so
the suite passes on a machine that has never seen this project.
