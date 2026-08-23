/** An in-memory row store, enough for tests. */
export function createStore() {
  const rows = [];
  return {
    insert(row) { rows.push(row); return row; },
    all() { return [...rows]; },
    count() { return rows.length; },
    page(skip, take) { return rows.slice(skip, skip + take); },
  };
}
