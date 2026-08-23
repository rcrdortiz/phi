This is an order service: plain JavaScript modules, no framework.

```
src/api/          request shaping, paging, errors
src/cart/         lines, subtotal, discounts, coupons
src/config/       defaults and limits
src/events/       a small event bus
src/inventory/    stock and reservations
src/money/        formatting, rounding, conversion
src/orders/       totals, status, references
src/reporting/    pagination, totals, grouping
src/shipping/     zones, cost, estimates
src/storage/      an in-memory store
src/tax/          rates and application
src/users/        names, email, roles
src/util/         small helpers
test/run.mjs      the visible suite
```

Run it with `node test/run.mjs`. It passes, and the code is still wrong.

There is exactly one bug. Find it and fix it.

Do not change anything under `test/`. Do not add new files. Fix the source.
