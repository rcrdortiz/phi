// A phase-one answer with the concerns separated.
//
// Nothing here anticipates a second format. It is simply cohesive: picking
// values out of a record, escaping one field, and joining rows are three jobs
// and they live in three places. That is ordinary care, not speculative
// generality, which is the point: the phase-two task rewards basic separation
// rather than guessing the future.
(function () {
  function pick(record, columns) {
    return columns.map(function (key) {
      var v = record[key];
      return v === undefined || v === null ? "" : String(v);
    });
  }

  function escapeCsv(value) {
    if (/[",\n]/.test(value)) return '"' + value.replace(/"/g, '""') + '"';
    return value;
  }

  function toCsv(records, options) {
    var lines = [];
    if (options.header !== false) lines.push(options.columns.join(","));
    records.forEach(function (r) {
      lines.push(pick(r, options.columns).map(escapeCsv).join(","));
    });
    return lines.join("\n");
  }

  function exportRecords(records, options) {
    var limited = options.limit === undefined ? records : records.slice(0, options.limit);
    return toCsv(limited, options);
  }

  globalThis.EXPORTER = { exportRecords: exportRecords };
})();
