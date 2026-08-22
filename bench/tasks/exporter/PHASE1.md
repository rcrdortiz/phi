Write `exporter.js` in the current directory. Plain JavaScript, no dependencies,
loadable in node. It must define `globalThis.EXPORTER = { exportRecords }`.

`exportRecords(records, options)` turns an array of plain objects into a CSV
string.

- `options.columns` is an array of keys, in order. Required.
- The first line is a header row of those keys.
- Values are looked up by key. A missing key, `null` or `undefined` is empty.
- A value containing a comma, a double quote, or a newline is wrapped in double
  quotes, and any double quote inside it is doubled.
- Rows are joined with `\n`. There is no trailing newline.
- `options.header` defaults to true; when false the header row is omitted.
- Numbers and booleans are written as `String(value)`.
- `options.limit`, when given, exports at most that many records.

Example:

```
exportRecords([{ a: 1, b: "x,y" }], { columns: ["a", "b"] })
// a,b
// 1,"x,y"
```

## Done means

`node --check exporter.js` passes and the behaviour above holds exactly.
No tests, no README, no CLI.
