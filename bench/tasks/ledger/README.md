# ledger

A seeded repo with five defects, none of which the visible test suite catches.

`repo/` is copied fresh into a temporary directory per run. `verify.mjs` is the
hidden suite and is never shown to the agent. `reference/` is `repo/` with all
five fixed, and exists to prove the suite is passable: it scores 17/17, and if
it ever stops doing so the suite has drifted from the task.

The defects, and why each is fair:

| file | defect | the contract it breaks |
|---|---|---|
| `money.js` | `allocate` drops the remainder | "The parts must sum back to `cents` exactly" |
| `tiers.js` | boundary uses `>` not `>=` | "An amount exactly on a boundary belongs to the higher tier" |
| `csv.js` | doubled quote not consumed | "Handles ... doubled quotes" |
| `ledger.js` | refunds added, not subtracted | "charges minus refunds" |
| `report.js` | falsy group keys dropped | "Every entry must land in exactly one group" |

Every one is a case where a comment already states the intent and the code below
it does something else, so finding them needs reading rather than guessing, and
grading them needs no judgement about what was meant.

The visible suite passes at the start. That is deliberate: a failing test tells
you where to look, and the point of this task is the looking.

`verify.mjs` also checks `test/run.js` is byte-identical to `test-run.sha`.
Editing the tests into agreement is the obvious way to score well without
fixing anything.
