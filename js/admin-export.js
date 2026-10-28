// admin-export.js — one-click CSV downloads for admin tables.
// Treat every string as untrusted: a learner can put spreadsheet formulas in
// names, comments or code which an admin may later open in Excel/LibreOffice.
function csvCell(value) {
  if (value === null || value === undefined) return "";
  let text = typeof value === "object" ? JSON.stringify(value) : String(value);
  // A quoted CSV field is still evaluated as a formula by spreadsheet apps.
  // The apostrophe forces text, including formulas hidden behind whitespace,
  // BOMs or zero-width characters. Preserve actual numeric values as numbers.
  if (typeof value !== "number" && /^[\s\uFEFF\u200B-\u200D]*[=+\-@]/u.test(text)) {
    text = "'" + text;
  } else if (/^[\t\r\n]/.test(text)) {
    // Spreadsheet programs can also interpret leading tab/CR/LF specially.
    text = "'" + text;
  }
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadCSV(filename, rows) {
  if (!rows || !rows.length) {
    showToast("Nothing to export", "error");
    return;
  }
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  // Column names also pass through the same escaping and formula guard.
  const csv = [cols.map(csvCell).join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  showToast(`Exported ${rows.length} rows`, "success");
}
