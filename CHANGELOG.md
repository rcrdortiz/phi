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
