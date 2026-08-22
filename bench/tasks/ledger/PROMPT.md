This project is a small ledger library. `npm test` passes, and the library is
still wrong in several places.

Each defect is a case where the code does not do what the comment beside it
says it does. Read the source, find them, and fix them.

Rules:

- Do not change anything under `test/`. The existing tests describe behaviour
  that is correct and must stay correct.
- Fix the source, not the symptoms. A special case that makes one input work is
  not a fix.
- `npm test` must still pass when you are done.

There is more than one defect and they are in different files. Nothing tells you
how many.

## Done means

`npm test` passes and the library behaves as its own comments describe.
