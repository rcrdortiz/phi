// A phase-one answer that passes every check and has no seams.
//
// One function does the limiting, the header, the lookup, the escaping and the
// joining, with the CSV rules threaded through the loop. Correct, readable
// enough, and the format is inseparable from the iteration.
(function () {
  function exportRecords(records, options) {
    var out = "";
    if (options.header !== false) out += options.columns.join(",");
    var count = 0;
    for (var i = 0; i < records.length; i++) {
      if (options.limit !== undefined && count >= options.limit) break;
      count++;
      var row = "";
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
    if (options.header === false && out.charAt(0) === "\n") out = out.slice(1);
    return out;
  }
  globalThis.EXPORTER = { exportRecords: exportRecords };
})();
