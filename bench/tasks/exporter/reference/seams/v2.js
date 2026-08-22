// The same answer after phase two. The diff is a new function and a dispatch.
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

  function toJsonl(records, options) {
    return records
      .map(function (r) {
        var obj = {};
        options.columns.forEach(function (key) {
          if (r[key] !== undefined && r[key] !== null) obj[key] = r[key];
        });
        return JSON.stringify(obj);
      })
      .join("\n");
  }

  var FORMATS = { csv: toCsv, jsonl: toJsonl };

  function exportRecords(records, options) {
    var limited = options.limit === undefined ? records : records.slice(0, options.limit);
    return (FORMATS[options.format || "csv"] || toCsv)(limited, options);
  }

  globalThis.EXPORTER = { exportRecords: exportRecords };
})();
