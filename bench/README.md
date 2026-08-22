# bench

Comparing coding harnesses on the same task, on your machine, with your model.

```sh
node bench/run.mjs --harness phi,pi --runs 3 --task tetris
```

Each run gets a fresh temporary directory, is handed `tasks/<task>/PROMPT.md`
through `pi --print`, and is graded afterwards by `tasks/<task>/verify.mjs`.

## Sweeping thinking levels

```sh
node bench/run.mjs --harness phi --effort off,low,medium,high --runs 3
```

Whether thinking earns its cost is not obvious in either direction on a local
model. Thinking tokens are output tokens, so more effort costs both tokens and
minutes at fifteen tokens a second, and the question is whether the extra checks
passed are worth it.

That is what the `tok/check` column is for: output tokens per check passed. The
score alone says more thinking won; the token count alone says it lost; neither
is the question. A level that thinks twice as hard for one more check is visible
only in the ratio.

```
arm            passed      time        output tok   turns   tok/check   timeouts
phi/off        9/15        780s        3200         38      356         0
phi/high       13/15       1580s       8200         38      631         0
```

### Compaction thinking, separately

```sh
node bench/run.mjs --harness phi --compact-thinking off,low,medium --runs 3
```

A different question from the agent's own effort. pi passes the session's
thinking level to the summarisation call, so at `high` the model deliberates
before writing the summary: measured live, a compaction spent 79 seconds on
prefill and roughly 380 generating, against a 500 second timeout it was about to
hit. phi now summarises at `low` by default for that reason.

What is not obvious is whether a cheaper summary is a worse one, and a worse
summary is paid for by every turn after it, in re-reads and lost decisions. That
cost does not appear in the compaction's own timing, which is exactly why it
needs measuring rather than assuming. The two-phase task is the one to run it
against, since phase two is where a thin summary would show up.

phi only: plain pi has no such setting, so sweeping it there would run one
configuration under several names.

Four levels, not seven. Ollama's `reasoning_effort` takes none, low, medium and
high, so pi's `xhigh` and `max` map onto high and would measure the same thing
three times under different names.

Sweeping is also how the phi-versus-pi comparison gets separated into its two
halves. Run without `--effort` and each harness uses its own configured default,
which measures the whole package including the settings. Run with a fixed level
on both and the settings are held equal, so what is left is the extensions.

Mind the arithmetic. Two harnesses times four levels times three runs is 24
runs, and the runner prints the worst-case hours before it starts.

## What it reports

```
harness  passed      time        output tok   turns   compactions  timeouts
phi      13 (12-13)/14   1420 (1180-1655)s   8.2k    41      1            0
pi       11 (9-13)/14    1990 (1720-2400)s   9.9k    38      0            1
```

Median and range, never a single number.

## Four things it is careful about

**The suite is ours.** `verify.mjs` is never shown to the agent, and the prompt
asks for no tests. An agent that writes its own tests is grading its own
homework, and "the model said it was done" is not a measurement. Grading runs
from a pristine copy, outside the project, so nothing the run wrote can affect
its own score.

**Runs are repeated.** One run of a local model is noise. Three is the minimum
that shows a spread, and the spread is usually the interesting part: a harness
that scores 13, 13, 12 is not the same as one that scores 14, 13, 8 even when
the medians match.

**Order is alternated.** Ollama's prefix cache and keep-alive make the second
run of anything cheaper. Running all of one harness and then all of the other
would hand that advantage entirely to whichever went second.

**A failure is a result.** A run that times out or produces nothing is recorded
with whatever it left behind, not dropped for spoiling the average. Not
finishing is the most important thing a harness can do wrong.

## What it cannot control

What else the machine is doing. Prefill and decode both slow under load, and a
browser mid-run can cost more than the difference being measured. Run it idle.

It also cannot tell you whether a task generalises. One task measures one task.

## What is being compared

`phi` and `pi` are the same binary pointed at different agent directories. That
is deliberate: phi is a configuration plus a set of extensions, so the honest
comparison is against pi's own defaults, not against a version of pi with
phi's settings removed one at a time. Differences in context window, thinking
level and compaction are part of what is being measured, not noise to control
away.

## Cost

A Tetris run takes 20 to 60 minutes on a 27B local model. Two harnesses times
three runs is most of a day. Start with `--runs 1` to check the plumbing, and
read the result as a smoke test rather than a finding.

## Reaching a compaction

The `exporter` task never compacts: it finished in 226 seconds having reached
nowhere near the 36,000 token trigger. That makes it a fine smoke test and a
poor comparison, because compaction is most of what separates phi from pi, and a
task that never triggers it mostly measures the model.

`ledger` is sized for it. A seeded repo of six modules with five defects the
visible suite does not catch, spread across five files, none findable without
reading. Finding them means reading most of the codebase, re-reading after
edits, and running the suite repeatedly, which is what actually fills a context.

Whether it reaches two compactions is a question for a real run. The runner
already reports the count per run, and if it comes in under two the answer is a
larger seeded repo rather than a different metric.

## Measuring architecture

You cannot measure SOLID. You can measure what it is for: every one of those
principles exists to make the next change cheap and safe, and that is
observable.

The `exporter` task is two phases. Phase one builds a CSV exporter. Phase two
runs in a fresh session with no memory of phase one and asks for a second
format. The phase-two prompt is a separate file and is never present during
phase one, because a task that reveals what is coming measures whether a model
can follow a hint, not whether it leaves seams by default.

What phase two reports:

```
phase 2: 24/24  310s  +16/-8 in 1 file(s)  no regressions
```

**A negative result, kept here because it was expensive to learn.** The plan was
that a good design would show a smaller diff. It did not discriminate: the task
is too small for change cost to bite.
Measured against the two references in `reference/`, one factored and one
deliberately monolithic, the diffs came out at 24 and 23 changed lines. Adding a
branch to a thirty-line function costs about as many lines as adding a function
beside it. Splitting additions from removals did not separate them either.

So diff size is **reported and not scored**. The metric that does discriminate
is the regression half: phase one's suite is re-run unchanged after phase two,
and `regressed` counts what broke. Adding a format is the easy part. Not
breaking the format already there is what separates a design with seams from one
without, and it needs no line counting to see.

If change cost is to bite, phase one has to be big enough for it: a few hundred
lines and three or four concerns, not thirty lines and one. That is a task to
write, not a metric to fix.

## Adding a task

A directory under `tasks/` with two files:

- `PROMPT.md`, which must specify an artifact contract precise enough to test
  and loose enough to leave the work real.
- `verify.mjs`, which takes a directory and prints
  `{ passed, total, results: [{ name, pass, detail }] }`.

Node only, no browser, no dependencies: a score should not move because a Chrome
version did.

## Grading the grader

`test/bench.mjs` runs in the ordinary suite and checks the benchmark itself: an
empty directory scores zero, a stub scores near zero, a syntax error or an
infinite loop cannot take the runner down, and `reference.js` passes every
check. That last one matters most. A suite nobody has ever passed may simply be
unpassable, and every score it produced would be meaningless. `reference.js` is
never shown to an agent; it exists to prove the task can be done.
