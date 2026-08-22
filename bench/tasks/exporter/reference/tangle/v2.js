// The same answer after phase two, extended the way a monolith invites.
//
// The format is threaded through the loop, so the loop has to be rewritten and
// the CSV rules re-stated inside a branch. Every CSV line is touched to add a
// format that has nothing to do with CSV.
(function () {
  function exportRecords(records, options) {
    var format = options.format || "csv";
    var out = "";
    if (format === "csv" && options.header !== false) out += options.columns.join(",");
    var count = 0;
    for (var i = 0; i < records.length; i++) {
      if (options.limit !== undefined && count >= options.limit) break;
      count++;
      var row = "";
      if (format === "jsonl") {
        var obj = {};
        for (var k = 0; k < options.columns.length; k++) {
          var jv = records[i][options.columns[k]];
          if (jv !== undefined && jv !== null) obj[options.columns[k]] = jv;
        }
        row = JSON.stringify(obj);
        out += (count === 1 ? "" : "\n") + row;
        continue;
      }
      for (var c = 0; c < options.columns.length; c++) {
        var v = records[i][options.columns[c]];
        var s = v === undefined || v === null ? "" : String(v);
        if (s.indexOf(",") !== -1 || s.indexOf('"') !== -1 || s.indexOf("\n") !== -1) {
          s = '"' + s.replace(/"/g, '""') + '"';
        }
        row += (c ? "," : "") + s;
      }
      out += (out === "" && options.header === false && count === 1 ? "" : "\n") + row;
    }
    if (format === "csv" && options.header === false && out.charAt(0) === "\n") out = out.slice(1);
    return out;
  }
  globalThis.EXPORTER = { exportRecords: exportRecords };
})();
