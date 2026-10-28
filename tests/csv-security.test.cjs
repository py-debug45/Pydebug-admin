const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('js/admin-export.js', 'utf8');
const ctx = vm.createContext({});
vm.runInContext(source, ctx);

test('CSV export neutralises spreadsheet formulas, including whitespace prefixes', () => {
  for (const value of ['=1+1', '+SUM(A1:A2)', '-1+2', '@SUM(1)', '  =HYPERLINK("https://evil.test")', '\t=2+2', '\uFEFF=2+2', '\u200B@calc']) {
    const cell = ctx.csvCell(value);
    assert.match(cell, /^"?'/, value);
  }
  assert.equal(ctx.csvCell(-42), '-42');
  assert.equal(ctx.csvCell('normal'), 'normal');
  assert.equal(ctx.csvCell(null), '');
});

test('CSV fields containing separators, quotes, CR or LF stay in one field', () => {
  assert.equal(ctx.csvCell('a,b'), '"a,b"');
  assert.equal(ctx.csvCell('a"b'), '"a""b"');
  assert.equal(ctx.csvCell('a\rb'), '"a\rb"');
  assert.equal(ctx.csvCell('a\nb'), '"a\nb"');
  assert.equal(ctx.csvCell('\r=2+2'), '"\'\r=2+2"');
});

test('CSV column headers use the same escaping as data cells', () => {
  assert.match(source, /cols\.map\(csvCell\)\.join/);
});
