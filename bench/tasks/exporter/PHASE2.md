The exporter needs a second output format.

`exportRecords(records, options)` gains `options.format`, which is `"csv"` when
absent and may also be `"jsonl"`.

JSON Lines: one JSON object per record, joined with `\n`, no trailing newline.

- Only the keys in `options.columns` are included, in that order.
- A missing key, `null` or `undefined` is omitted from the object entirely,
  rather than written as null.
- `options.limit` applies as before.
- `options.header` has no meaning for this format and is ignored.

Everything about CSV stays exactly as it is.

Example:

```
exportRecords([{ a: 1, b: null }], { columns: ["a", "b"], format: "jsonl" })
// {"a":1}
```

## Done means

`node --check exporter.js` passes, the new format behaves as above, and CSV
behaves exactly as it did before.
