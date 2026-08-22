This is Quill, a small publishing platform: PHP on the server, TypeScript on the
client, with a SQLite database.

```
src/        PHP: Domain, Database, Query, Repository, Rendering, Validation, Http, Event, Service
web/        TypeScript: api, state, components, util
db/         schema.sql, seed.sql, migrations
templates/  HTML
assets/     CSS
test/       run.php and run.ts, the existing suites
```

Run the suites with `php test/run.php` and `node --experimental-strip-types test/run.ts`.
Both pass, and the software is still wrong in several places.

Each defect is a case where the code does not do what the comment beside it, or
the interface it implements, says it does. They are in different files and in
more than one language. Nothing tells you how many there are.

Rules:

- Do not change anything under `test/`. Those tests describe behaviour that is
  correct and must stay correct.
- Fix the cause, not the symptom. A special case that makes one input work is
  not a fix.
- Both suites must still pass when you are done.

## Done means

Both suites pass and the code behaves as its own comments and interfaces
describe.
