# quill

A publishing platform in PHP, TypeScript, HTML, CSS and SQL. One session, three
phases, roughly 80 files.

```
phase 1  three defects, in different files and two languages
phase 2  reading time: domain, HTML, TypeScript, CSS
phase 3  a new output format, through the existing seam
```

## Why one session

Every earlier task in this directory finished without compacting once, across
thirty runs and one that reached forty-two turns. That made them useless for
comparing harnesses, because compaction is most of what separates phi from pi: a
task that never triggers it measures the model and reports the result as a
harness difference.

The phases here run as sequential prompts in a single session, so context
accumulates across all three. `task.json` sets `sameSession: true`. The exporter
task sets it to `false` on purpose, because it measures something different:
whether a design survives being handed to someone with no memory of building it.

## The defects

Each is a place where the code does not do what the comment beside it, or the
interface it implements, says it does.

| file | defect | the contract it breaks |
|---|---|---|
| `SqlArticleRepository` | `INNER JOIN` on tags | "the tag join is there to filter, not to decide which articles exist" |
| `Paginator` | `page * perPage` | "the first page is page 1, and its offset is 0" |
| `selectors.ts` | comparator returns a boolean | "newest first" |

The second is the one that matters most: neither the controller nor the
paginator is wrong when read alone. The controller passes a 1-based page because
the URL is 1-based, and the paginator multiplies it because that is what an
offset looks like. Finding it means holding both files in mind at once, which is
the class of defect a 27B failed on in the ledger task.

Both visible suites pass as shipped, 16 PHP checks and 21 TypeScript ones. That
is deliberate: a failing test says where to look, and the looking is the job.

## Measuring architecture in phase 3

Not diff size. That was measured against a factored and a monolithic reference
on the exporter task and did not discriminate at all: 24 changed lines against
23. The measurement here is whether the format went in **through the seam**:

- a new class implementing `RendererInterface`, registered in the container
- the existing renderers never mentioning the new format
- the registry not special-cased for it
- the controllers not naming it

A bolted-on format fails those whatever its diff looks like.

## Grading

PHP through `php`, TypeScript through `node --experimental-strip-types`, CSS and
HTML structurally. The structural checks are the weak ones and are worth naming
as such: a string match is not a rendering test, and there is no browser here to
make it one.

`reference/` is the repo with all three phases implemented. It scores 14/14,
24/24 and 40/40, which is what proves the suites are passable. If it ever stops
doing so, the suites have drifted from the task. `test/bench.mjs` checks that on
every run, and also mutation-tests two of the phase-one fixes to prove those
checks can fail.
