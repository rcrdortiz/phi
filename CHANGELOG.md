# Changelog

phi replaces itself on the machine it runs on, so "3 commits behind" is not
enough to decide whether to accept an update. This file says what changed and
whether it will alter how your sessions behave.

Versioning is semver, read against the *behaviour of a session*, not against a
public API. phi has no API.

- **major**: an update that needs something from you. A new setting, a
  reinstall, a model rebuild, anything that fails if you just take the update.
- **minor**: new behaviour, or a changed default that alters how sessions run.
  Safe to take, but worth reading first.
- **patch**: fixes and wording. Nothing about how a session runs changes,
  except that something broken stops being broken.

## Unreleased

**Changed: Ollama now runs with two prefix-cache slots.** This is the fix for
the thrashing 0.20.0 described but did not solve. Ollama defaults to one cache
slot, and a slot holds one conversation, so two agent sessions evict each
other's cache on every turn and both re-read their whole history. It looks
exactly like running out of memory and is not: halving the window changed
nothing, and eight evictions still happened in thirty minutes with sixteen
gigabytes of headroom spare. Measured after the change: zero evictions across a
full hour of benchmark load.

**Changed: the model window is 65,536 again, was 40,960.** The window was never
the constraint, so the reduction is reverted. This moves compaction from 28,672
to 36,000.

**This release needs two things from you**, which is why it is not a quiet
update. Run `/model-install` to rebuild the model at the new window, and restart
Ollama so it picks up the slot count. Taking the update without the rebuild
leaves phi believing the window is larger than the model actually has. Quitting
Ollama.app from the menu bar is not always enough: the Electron process can
survive and respawn the server with its old environment, so confirm with
`grep 'server config' ~/.ollama/logs/server.log | tail -1`.

**Added: `/doctor` names cache contention.** It reports the slot count and how
many other sessions are running, leads with contention when it finds it, and
withholds the "lower your window" advice in that case, because rebuilding a
model does not help when the window was never the problem.

**Added: the installer sets the slot count, scaled to the machine.** Two slots
where the wired limit can hold them, which at this window means roughly 33 GB,
and one below that with a warning that concurrent sessions will evict each
other. A 32 GB machine asked for two would trade contention for real memory
pressure.

**Fixed: compaction fires early by what a turn has been shown to cost.** The
trigger is only checked at turn_end, the one boundary where no tool call is
half-finished, and a single agentic turn spans many model round-trips. Measured:
a run crossed a 36,000 trigger at 37,560 and did not reach turn_end until
53,097. The trigger now subtracts the largest growth any turn has been observed
to add, so a turn ends near the intended depth instead of starting there. Capped
at 40%, because one huge turn must not collapse the trigger into compacting
every turn.

## 0.20.0 (2026-08-22)

**Added: `/doctor`, and a startup check for when the machine is the problem.**
A session spent thirty-four minutes producing ninety-eight seconds of
generation, with no error and no warning: Ollama was discarding its prefix cache
every couple of minutes, so every turn re-read the whole conversation. That is
invisible from inside a session and the evidence lives in a log nobody knows
exists. `/doctor` reports the wired limit, resident size, window, headroom and
recent evictions, and a session warns once at startup only when it finds
thrashing. It says "unknown" rather than guessing when a signal cannot be read.

**Changed: the model window is 40,960, was 65,536.** Lower windows mean smaller
cached snapshots. Note that this did not on its own stop the evictions, which is
recorded in the task notes rather than claimed as a fix.

## 0.19.2 (2026-08-22)

**Fixed: the benchmark's diff walker died on any nested codebase.** It listed
the project root and called `readFileSync` on everything it found, which is fine
for a one-file task and throws `EISDIR` on the first subdirectory. It killed the
quill smoke run at the phase boundary, twenty-seven minutes in. The walk is
recursive now, skips agent state and `node_modules`, and is tested against a
real tree.

## 0.19.1 (2026-08-22)

**Fixed: a timed-out run is now marked void and excluded from the statistics.**
Phases are separate processes, so a timed-out phase does not stop the next one:
it runs against a half-finished repo and produces numbers that look valid.
Averaging those in reads as "the harness scored badly" when what happened is
that it was cut off. Void runs are counted and reported separately, and an arm
with nothing but void runs still prints rather than silently vanishing.

## 0.19.0 (2026-08-22)

**Added: `bench/tasks/quill`, one session, three phases, four languages.**
Roughly eighty files of PHP, TypeScript, HTML, CSS and SQL. Phase one finds
three planted defects, phase two adds a feature across all four languages, phase
three adds an output format and measures whether it went in through the existing
seam. The phases run as sequential prompts in a single session so context
accumulates, because thirty runs across the earlier tasks produced zero
compactions and compaction is most of what separates phi from pi.

**Added: the runner supports N phases and per-task session policy.** `task.json`
sets `sameSession`; quill shares one session, the exporter deliberately does not,
since it measures whether a design survives being handed to a stranger.

## 0.18.0 (2026-08-22)

**Changed: the default thinking level is `low`, was `high`.** Not because `low`
was shown to be better. A sweep of off/low/medium/high on a bug-hunt task scored
18-20 out of 23 at every level, inside a plus-or-minus-two noise floor measured
from identical control runs, and output tokens did not correlate with the level
(r = +0.17, n = 11). Nothing distinguished them, so the default moves to the
cheap end until something does. `Shift+Tab` and `/effort` still change it live.

## 0.17.1 (2026-08-22)

**Changed: compaction summarises with thinking off, not `low`.** Summarising is
reading something that already exists and writing down what mattered, and
whatever judgement that needs is the same judgement the model makes while
writing the summary. Deliberating first buys nothing and is charged at the
decode rate, which on this setup is the entire cost of a compaction.

## 0.17.0 (2026-08-22)

**Added: `bench/tasks/ledger`, a seeded bug hunt sized to reach a compaction.**
The exporter task finished without compacting once, which makes it a poor
phi-versus-pi comparison: compaction is most of what separates them. This is six
modules with five defects the visible suite does not catch, each one a case
where a comment states the intent and the code below does something else.
Finding them requires reading the codebase rather than reading a failing test.
The hidden suite also checks the visible tests were not edited into agreement,
and a reference copy with all five fixed proves the suite is passable at 17/17.

## 0.16.0 (2026-08-22)

**Added: `--compact-thinking` sweeps the summarisation level.** A different
question from the agent's own effort, and now that phi summarises at `low` by
default it is the one worth answering: whether a cheaper summary is a worse one.
That cost lands on every turn after the compaction rather than on the
compaction's own timing, so it has to be measured rather than assumed. phi only,
since plain pi has no such setting.

## 0.15.1 (2026-08-22)

**Fixed: compaction inherited `thinking: high` and nearly timed out because of
it.** pi passes the session's thinking level to the summarisation call, so the
model deliberated before writing the summary. Caught from the Ollama log while
a compaction sat at 459 seconds: 79 of prefill, then roughly 380 generating,
against a 500 second idle timeout. Summarising a transcript is not a reasoning
task. It runs at `low` now, and the session's level is restored afterwards,
including when the compaction fails. `PI_COMPACT_THINKING=keep` restores the old
behaviour.

## 0.15.0 (2026-08-22)

**Added: a two-phase task that measures what SOLID is for.** `bench/tasks/exporter`
builds a CSV exporter, then in a fresh session with no memory of building it
asks for a second format. The phase-two prompt is a separate file and is never
present during phase one, because a task that reveals what is coming measures
hint-following rather than design.

The headline metric is regression: phase one's suite is re-run unchanged after
phase two. Adding a format is the easy half; not breaking the one already there
is what separates a design with seams from one without.

Diff size is reported and **not** scored. The plan was that a good design would
show a smaller diff, and measured against a factored reference and a
deliberately monolithic one it did not discriminate at all: 24 changed lines
against 23. The task is too small for change cost to bite, which is a task to
write rather than a metric to fix. The negative result is in `bench/README.md`
and asserted in the tests so it cannot quietly stop being stated.

## 0.14.0 (2026-08-22)

**Added: the benchmark sweeps thinking levels.**
`--effort off,low,medium,high` runs each harness at each level. Thinking tokens
are output tokens, so more effort costs both tokens and minutes, and whether it
earns that is not obvious in either direction on a local model. The summary
reports tokens per check passed, which is the only column that answers it: the
score alone says more thinking won, the token count alone says it lost.

Four levels rather than seven, because Ollama's `reasoning_effort` takes
none/low/medium/high and pi's `xhigh` and `max` map onto high. Sweeping also
splits the phi-versus-pi comparison in two: without `--effort` each harness uses
its own default and the settings are part of what is measured, with a fixed
level on both they are held equal and only the extensions differ.

## 0.13.3 (2026-08-22)

**Fixed: `Error: This operation was aborted` on a step-boundary compaction.**
`plan_next` finishes a step and the compaction happens at the end of the turn,
not inside the tool call. The turn is aborted in between, so the abort arrived
before any compaction existed and the suppression window, which opened when a
compaction started, missed it. Caught in `message-end.log` at busy:false four
milliseconds after the tool result. A compaction is now announced when it is
scheduled rather than when it begins.

## 0.13.2 (2026-08-22)

**Changed: `[o]` means "where work last happened", not "in progress".** The mark
is set by an edit landing while that step was current, which is evidence work
happened near it rather than proof it was on it. Seen live: a step about
`index.html` was marked while the model did an unrelated rename in `pang.js`
asked for in chat. The mechanism is unchanged and still costs nothing; only the
claim it makes is now the one the evidence supports.

## 0.13.1 (2026-08-22)

**Added: failed calls record why, and repeats are grouped.** A session lost five
minutes to six edits and two failed runs of one shell script, and the log could
say only that they failed. `/usage` now lists failures with the start of the
error text, grouped so the same failure three times shows as one row with a
count: three of one failure is a loop, three different ones are three problems.

## 0.13.0 (2026-08-21)

**Added: `bench/`, comparing harnesses on one task with a suite they do not
control.** `node bench/run.mjs --harness phi,pi --runs 3` runs the task through
`pi --print` in a fresh directory per run and grades the artifact against a
fixed acceptance suite the agent never sees. Reports median and range, never a
single number; alternates harnesses so a warm prefix cache does not land on one
side; and records timeouts rather than dropping them, since not finishing is the
most important thing a harness can do wrong. `test/bench.mjs` grades the
benchmark itself, including that a reference implementation passes every check.

## 0.12.1 (2026-08-21)

**Fixed: the "already in your context" steering had been dead since 0.6.0.** It
tested for `.pi/PLAN.md` with a regex of its own, and state moved to `.phi/` six
versions ago, so a `cat .phi/PLAN-DONE.md` went through at 974 tokens with no
pushback at all. It now asks the same list `view_lines` uses, matches the bare
filename however the read was reached, and still matches the pre-0.6.0 path for
a project that never migrated.

It also no longer claims `PLAN-DONE.md` is injected every turn, because it is
not: the briefing names it and tells the model to read it before replanning.
Large shell reads of any file now get a shorter note instead, saying that
`view_lines` takes a range and remembers what it has sent.

## 0.12.0 (2026-08-21)

**Added: a step can be in progress, `[o]`, not just waiting or done.** "Current"
was inferred as "the first one not done", which cannot tell a step that was
started and interrupted from one nobody has touched, and after a crash or a
ctrl+c that is the whole question. The mark is set automatically on the first
edit rather than by a tool call: the model is told to do one step, so the moment
it changes anything, that step is under way. The briefing, the compaction resume
and the exit note all prefer it over the first waiting step.

## 0.11.0 (2026-08-21)

**Added: quitting writes a "where this stopped" note.** Ctrl+C now leaves the
plan step in progress, anything cut off mid-call, the files changed and the last
few actions at the top of `.phi/HANDOFF.md`. Assembled from what is already
known rather than summarised, because a summary is a model call on the whole
context and the one thing someone pressing ctrl+c has said is that they want out
now. It sits above the previous compaction summary rather than replacing it, and
a session that did nothing writes nothing.

## 0.10.0 (2026-08-21)

**Added: `outline` covers HTML, and section banners in every language.** Found
in a usage log: `run.html`, 529 lines, was read nine times in one session for a
third of its entire tool output. `outline` returned nothing for `.html`, so
ranged reads were the only way to navigate the single most-read file there was.
It now anchors on tags, inline script declarations, and `// ---- section ----`
banners, which in a file of flat assertions are the only structure present. 16x
cheaper than reading that file.

## 0.9.3 (2026-08-21)

**Changed: the usage log records a read's line range, not just its file.** Six
reads of one file are six wasted reads if they cover the same lines and ordinary
exploration if they do not. The log could not tell the difference, so the first
real question asked of it came back unanswerable.

## 0.9.2 (2026-08-21)

**Fixed: `cat file 2>/dev/null` walked past the steering that exists to stop
it.** The guard treated any `|` or `>` as a pipeline that filters output before
it reaches the context, which is true of `cat x | grep y` and false of
`2>/dev/null` and `|| echo`. Found in a real usage log:
`cat .phi/PLAN-DONE.md 2>/dev/null || echo "NO PLAN-DONE"` cost 898 tokens on a
file the briefing already injects every turn. Stderr redirection is now ignored
and `||`/`&&` are treated as separators, so each branch is judged on its own.
Real pipelines and stdout redirects are still left alone.

## 0.9.1 (2026-08-21)

**Added: the boot box is yellow under `PHI_DEBUG`, and says why.** Debug mode
changes what a session does, so it should be visible at the top of the screen
rather than discovered from a log file that exists or from output that suddenly
will not fold. Purple is ordinary, yellow means someone is watching.

## 0.9.0 (2026-08-21)

**Changed: recording is opt-in, behind `PHI_DEBUG=1`.** One switch turns on the
logs and turns off the hiding: tool output stops collapsing, tool costs are
recorded, message ends are written out. A debug mode that makes you name each
thing you wanted, or that collapses the output you asked to see, is not one.
Anything set explicitly still wins over the mode.

**Added: shell commands are recorded in full and reported by total cost.** The
program alone groups `ls` with `ls -laR /`, so the report would have hidden
exactly what it is for. Commands group on their text, which makes a cheap
command run forty times show up as one expensive row.

## 0.8.0 (2026-08-21)

**Added: `/usage`, and a per-call log behind it.** Reports where the tokens went:
per tool with calls, total, share, median and worst, plus the individual calls
that cost the most. Median sits next to total because they answer different
questions: a high total with a low median is a tool called often and working as
intended, while a high median is expensive every time and is the one worth
changing. Raw records land in `.phi/usage.jsonl`, one line per call, capped and
halved when it grows past 2MB. `PHI_USAGE_LOG=0` stops it.

**Changed: the chars-per-token estimate moved to `lib/token-estimate.ts`.**
Three extensions need it now, and a shared estimate is the only way the numbers
they each print can agree.

## 0.7.3 (2026-08-21)

**Changed: `view_lines` drops the alignment padding from its line numbers.**
The gutter is 23% of a file read. Measured on 160 lines of source, the
right-alignment padding costs about a token per line and buys nothing, since
nothing in the output is read as a column. `12|code` instead of `  12| code`,
for about 5% off every read with no capability lost.

## 0.7.2 (2026-08-21)

**Fixed: shell output was budgeted as though it cost half what it does.**
`tool-budget` converted characters to tokens at a flat 3.6, taken from a
transcript of mixed code and prose. Measured against the model's own tokenizer,
source and markdown do run about 3.4, but command output and JSON run 2.0, so a
bash result was sized as costing 45% of its real token count. That is precisely
what the extension exists to prevent. `bash`, `ls`, `grep` and `find` now
convert at 2.0 and everything else at 3.4, and the budget errs dense on purpose:
under-counting overruns the window, over-counting only truncates a little early.

## 0.7.1 (2026-08-21)

**Fixed: only five of phi's nine tools were collapsing.** The renderer went on
the `smart-edit` tools and never on the plan ones, so `plan_status` still
printed the whole step. All nine collapse now, and the test walks the
registrations rather than naming the tools that happened to be noisy that day,
so one added later cannot quietly print a screenful.

## 0.7.0 (2026-08-21)

**Changed: the compaction trigger moves from 28,000 to 36,000 tokens, measured.**
28,000 was bounded by a 300s idle timeout at an assumed flat 120 tok/s prefill.
The timeout is now 500s, so that bound moved, and prefill was benchmarked at
depth rather than assumed: 142 tok/s at 32K, 119 at 40K, 115 at 48K. It
degrades, so the assumption of flatness was wrong, but the deep-end rate is
still faster than the 120 that was being used. 36,000 costs 335s to recover
from a cache miss against a 500s timeout. 48,000 was rejected at 87s of margin,
and 40,000 at 165s, because the benchmark ran on an idle machine and this one is
meant to be used while the model runs. Work between compactions rises 55%.

**Fixed: the trigger is now bounded by the timeout instead of set beside it.**
It is the lowest of 70% of the window, a fixed cap, and 70% of what prefill can
cover before the timeout expires. A literal 36,000 on a default 300s install
would sit above that install's 34,500 ceiling, which is a guaranteed
`Request timed out` dressed up as a configuration choice. Lowering
`httpIdleTimeoutMs` now lowers the working depth with it.

**Fixed: `keepRecentTokens` no longer scales with the trigger.** It was 35% of
it, so raising the trigger to hold more work would have raised how much is kept
and cancelled most of the gain. It answers a question about continuity, not
about depth, and is a fixed 9,800.

## 0.6.0 (2026-08-21)

**Changed: per-project state moved from `.pi` to `.phi`.** `PLAN.md`,
`NOTES.md`, `PLAN-DONE.md`, `HANDOFF.md` and the compaction timings now live in
`.phi`. `.pi` is pi's own project directory and holds its `settings.json`;
sharing it made phi's files indistinguishable from pi's and left phi's state at
the mercy of whatever pi does with its own directory. Existing projects are
migrated on the first session, by name and one file at a time, so pi's settings
are never touched and current state is never overwritten by a stale copy.
`PHI_STATE_DIR` overrides it.

**Fixed: a test suite in `lib/` that nothing ran.** `incremental-writes-rules.test.ts`
printed in a format the runner does not parse, so the write gate's nine cases
claimed coverage they were not providing. Moved into `test/`.

## 0.5.0 (2026-08-21)

**Added: compaction shows elapsed seconds and a progress bar.** It is a model
call on a large prompt, so it takes as long as a turn, and behind a bare spinner
a slow one and a wedged one look identical. The estimate averages the last five
compactions in the project, kept in `.pi/compaction-times.json` so a fresh
session already has one. Past the estimate the bar pins at full and says "over
Ns" rather than continuing to predict. Only plausible, successful compactions
are recorded.

**Changed: the summariser is told to drop deliberation, not just conversation.**
At thinking level high a single decision can run to several hundred tokens of
reconsidering, and a faithful summary preserved all of it. It now records what
was decided rather than the argument that reached it, with a rejected option
kept as one line under Dead ends. The test it is given is whether a sentence
would change what the next session does.

**Changed: one set of summarisation rules instead of three.** The mid-run
watchdog, the step boundary and `/handoff` each had their own copy. They had
drifted, and only one was ever being updated.

## 0.4.0 (2026-08-21)

**Added: the working indicator says what the model is doing.**
`Working... Reading pang.js 1m 05s`, `Working... Running ./verify.sh 5m 52s`,
`Working... Thinking 12s`. Costs nothing: pi hands over the tool name and its
arguments at `tool_execution_start`, so the label is a lookup on data already
in hand. Asking the model for a subject would mean output tokens on every phase
change and a round trip at 20 tok/s, so the gaps between tool calls read as
plain "Thinking" with no subject.

## 0.3.0 (2026-08-21)

**Added: tool results collapse to one line until `ctrl+o`.** A turn that reads
three files and lists a directory filled the screen with output nobody reads,
and on a local model the sentence worth reading arrives slowly enough that
scrolling back to find it is a real cost. phi's own tools already write a
summary as their first line, so that is what shows: file and range for
`view_lines`, declaration count for `outline`, what changed for the edit tools.
Nothing is hidden, only deferred. `PI_COLLAPSE_TOOLS=0` restores full output.

pi's built-in tools (`ls`, `bash`, `grep`) are unaffected: their rendering is
fixed at twenty lines inside pi and an extension cannot reach it.

## 0.2.6 (2026-08-21)

**Fixed: work that was not driven by a plan died at every compaction.** The
watchdog only resumed when a plan step was outstanding, so investigation, a
request typed into the chat, and even the turn on its way to calling
`plan_write` were all cut off and never picked up. The plan was standing in for
"is there work left", and it was a poor proxy. Resuming now keys off evidence
that a live turn was actually interrupted, which the abort handler already sees.
A compaction that interrupted nothing still resumes nothing.

**Fixed: `/context` quoted pi's compaction threshold instead of phi's.** pi's
sits far above ours, so it reported half a window of room left when compaction
was a few thousand tokens away.

**Added: a `ctx` chip showing depth against the trigger that fires.** The
built-in footer counts against the model's 64K window, which is nearly twice
the depth phi actually runs to, so it reads as though there is plenty of room
right up until the context is thrown away.

## 0.2.5 (2026-08-21)

**Fixed: the `Error: Unknown error` on every compaction was phi's own doing.**
Compacting aborts the in-flight turn, which arrives as `stopReason: "error"`
carrying the text "This operation was aborted". The suppressor matched it,
blanked the text, and left the stop reason alone. pi renders
`errorMessage || "Unknown error"` whenever the stop reason is `error`, so
removing the one useful word turned a correctly labelled abort into a red line
naming nothing. It was worse than doing nothing. The stop reason is now
rewritten too, which is what the 0.2.1 change should have done: that release
added a branch for an empty error message which never fired, because the text
is always there.

## 0.2.4 (2026-08-21)

**Fixed: `phi -v` printed pi's version.** The thing you typed is phi, and its
version is what decides whether you have a given fix. Both are now printed and
labelled, since almost everything phi does is constrained by the pi underneath.

## 0.2.3 (2026-08-21)

**Added: `PHI_DEBUG_MESSAGE_END=1` records every assistant message end.** The
compaction-error suppressor added in 0.2.1 behaves correctly in isolation and
was still not suppressing in a live session. Rather than reason about it a
second time, set this and the next occurrence writes what actually arrived to
`.pi/message-end.log`: stop reason, error text, content parts, and whether one
of our compactions was in flight. Off by default, since it writes on every turn.

## 0.2.2 (2026-08-21)

**Fixed: the resume command printed on exit did not work.** Quitting printed
"To resume this session: pi --session <id>", but phi's sessions live under
`~/.phi` and plain `pi` looks in `~/.pi`, so the command found nothing. The name
comes from pi's own package.json and the line is written after extensions are
disposed, so there is no hook and no setting: phi rewrites that one write.
`PHI_RESUME_HINT=0` leaves it alone.

## 0.2.1 (2026-08-21)

**Fixed: a finished plan briefed nothing, so the next task never got one.**
The system-prompt briefing returned an empty string when no step was
outstanding: no goal, no findings, not even the fact that a plan file existed.
The model began the next task with no idea it was expected to plan, which is
how `HANDOFF.md` filled with work that `PLAN.md` never mentioned. A spent plan
now says it is spent, says new work needs `plan_write` first, and keeps
surfacing `NOTES.md`, which used to disappear the moment the last step was
ticked.
**Fixed: a red `Error: Unknown error` on every compaction.** Compacting tears
down the in-flight request, and that arrives as `stopReason: "error"` with an
empty message, which pi's renderer prints as the words "Unknown error". The
existing suppressor skipped it, because it only looked at messages that had
text. A red line on every compaction teaches you to stop reading red lines,
which is the more expensive habit. Narrow: assistant messages only, only while
one of our own compactions is in flight or seconds old, and only when the error
carries no text, since a real provider failure names itself. `PI_COMPACT_QUIET=0`
shows them again.

**Added: updates are checked every ten minutes, not only at startup.** A
session left open all day was reporting the state of the world at the moment it
started. The repeating check updates the box and never opens a dialog, since a
modal mid-run interrupts the work to ask about a typo fix. A declined update
stays declined. `PHI_UPDATE_INTERVAL_MS=0` restores the old behaviour.

**Fixed: new work could start with no plan, and no recap.** A task finishing
left its completed plan on disk; the next request was investigated and edited
against it with nothing shown to the user in between. An edit is now refused
when every step in `PLAN.md` is done, which is the one case where "no plan" is
unambiguous rather than a guess. `PI_PLAN_GATE=0` turns it off.

**Changed: `plan_write` no longer replies "start with step 1".** That sentence
was an instruction to begin and the model took it. It now asks for a summary of
what was found and what is intended, before the first step, which is while a
wrong plan is still cheap to correct.

## 0.2.0 (2026-08-21)

Everything before this was unversioned. The entry is written from `git log`.

**Fixed: compaction reclaimed almost nothing, then the next turn timed out.**
Two separate defects with one symptom. pi keeps `compaction.keepRecentTokens`
of recent messages past a compaction and defaults to 20000, sized for a 128K+
window; on a 64K window that is most of the 28,000 trigger, so a compaction at
31,126 tokens left about 29,500. Separately, the post-compaction baseline was
claimed on the first call *past* the trigger, so it recorded the trigger depth
rather than the depth compaction left behind, deferring the next compaction to
roughly 42,700. Both ended the same way: a prefix-cache miss with more tokens
to re-prefill than the idle timeout allows, reported as `Request timed out`.
The installer now seeds pi's compaction numbers, and the baseline is taken from
a reading below the trigger.

**Changed: the HTTP idle timeout is seeded at 500s, up from pi's 300s.** At the
measured ~120 tok/s prefill that moves the depth a cache miss can survive from
36,000 tokens to 60,000. The cost is that a genuinely hung request takes three
minutes longer to admit it. The compaction trigger deliberately did not move:
it is bounded by decode speed as well, and past 18,000 tokens the model is
already at about a third of its rate.

**Added: an elapsed counter on the working indicator.** A four-minute prefill
and a wedged process look identical behind a spinner.

**Added: `exit` quits.** A bare `exit`, `quit` or `:q` closes pi instead of
being sent to the model to be answered.

**Changed: quitting leaves the terminal as it was found.** pi's
`fullscreenExitOutput` default prints the whole session into the scrollback on
the way out; new installs get `resume-hint`.

**Changed: updates are reported once.** phi checks for a newer pi and a newer
phi in its own boot box and offers to install both. pi's own startup banners
said the same thing again, in a different place, with a command to copy, so the
`phi` command now sets `PI_OFFLINE`.

**Added: the boot box, and a large mark drawn in full blocks.** Half-blocks
stripe on a real terminal, where a cell taller than the glyph leaves a gap
between rows.

## 0.1.0

Initial: the extension set, the local model roster, `get-phi.sh`, and the test
suite.
