// Regression tests for the mobile Coupons Studio blank-card bug.
//
// Symptoms reported from Chrome on Android: coupon cards kept their layout
// height but most text/labels/buttons painted blank — different elements on
// each repaint — so the code, creator note, expiry date and payout could not
// be read. Two causes were fixed in css/admin.css:
//
//   1. `content-visibility: auto` on .admin-table-wrap was active on phones,
//      where the table is restructured into tall cards and re-rendered via
//      innerHTML after async RPC loads. Chrome Android leaves those skipped
//      subtrees unpainted, so the optimization is now desktop-only.
//   2. The mobile card layout was hardened: fixed desktop min-widths are
//      neutralised, cell values stack in a right-hand column instead of
//      scattering, long dates wrap, and every button is full-width.
//
// The mobile labels themselves come from data-label attributes rendered by
// couponRowHtml() in js/admin-coupons.js, so that contract is tested too.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'css', 'admin.css'), 'utf8');
const couponJs = fs.readFileSync(path.join(ROOT, 'js', 'admin-coupons.js'), 'utf8');

// Remove every @media { ... } block (balanced-brace aware) so the remainder
// is only the base/desktop-unconditional rules.
function stripMediaBlocks(source) {
  let out = '';
  let rest = source;
  while (true) {
    const at = rest.indexOf('@media');
    if (at < 0) {
      out += rest;
      break;
    }
    out += rest.slice(0, at);
    const open = rest.indexOf('{', at);
    let depth = 0;
    let i = open;
    for (; i < rest.length; i += 1) {
      if (rest[i] === '{') depth += 1;
      else if (rest[i] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    rest = rest.slice(i + 1);
  }
  return out;
}

// Extract the first @media block whose header includes the given query bit.
function extractMediaBlock(source, queryBit) {
  const marker = `@media ${queryBit}`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `expected a ${marker} block in css/admin.css`);
  const open = source.indexOf('{', start);
  let depth = 0;
  let i = open;
  for (; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return source.slice(start, i + 1);
}

test('content-visibility paint skipping is never applied unconditionally to admin table wraps', () => {
  const baseRules = stripMediaBlocks(css);
  const wrapRule = baseRules
    .split('}')
    .find((rule) => rule.includes('.admin-table-wrap') && rule.includes('content-visibility'));
  assert.equal(
    wrapRule,
    undefined,
    'Unconditional content-visibility on .admin-table-wrap re-triggers the Chrome Android blank-card paint bug; keep it inside a min-width media query.'
  );
});

test('table-wrap paint skipping is retained as a desktop-only (min-width) optimization', () => {
  const desktopBlock = extractMediaBlock(css, '(min-width: 861px)');
  assert.match(desktopBlock, /\.admin-table-wrap\s*\{[^}]*content-visibility:\s*auto/);
  assert.match(desktopBlock, /contain-intrinsic-size/);
});

test('mobile coupon cards neutralise desktop table min-widths so cards cannot overflow the screen', () => {
  const mobile = extractMediaBlock(css, '(max-width: 860px)');
  assert.match(mobile, /table\.coupon-table\s*\{\s*min-width:\s*0/);
  assert.match(mobile, /table\.coupon-table\s+\.coupon-cell-code\s*\{\s*min-width:\s*0/);
});

test('mobile coupon cells keep every value stacked in a right-hand, wrapping column', () => {
  const mobile = extractMediaBlock(css, '(max-width: 860px)');
  // Flex-wrap rows with a fixed label column and a value column that can shrink.
  assert.match(mobile, /table\.coupon-table td\[data-label\]\s*\{[\s\S]*flex-wrap:\s*wrap/);
  assert.match(mobile, /table\.coupon-table td\[data-label\]\s*>\s*\*\s*\{[\s\S]*min-width:\s*0/);
  // Long expiry dates must wrap instead of forcing horizontal scroll.
  assert.match(mobile, /\.coupon-cell-sub\s*\{[\s\S]*white-space:\s*normal/);
  assert.match(mobile, /\.coupon-cell-sub\s*\{[\s\S]*overflow-wrap:\s*anywhere/);
});

test('mobile coupon code/creator header and action buttons are full-width and left-aligned', () => {
  const mobile = extractMediaBlock(css, '(max-width: 860px)');
  assert.match(mobile, /td\.coupon-cell-code\s*\{[\s\S]*flex-direction:\s*column/);
  assert.match(mobile, /td\.coupon-cell-actions\s*\{[\s\S]*flex-direction:\s*column/);
  assert.match(mobile, /\.coupon-actions\s+\.btn\s*\{[\s\S]*flex:\s*1 1 auto/);
  assert.match(mobile, /\.coupon-share-kit\s+\.btn\s*\{[\s\S]*width:\s*100%/);
});

test('every cell rendered by couponRowHtml carries a data-label used as the mobile row label', () => {
  const fnStart = couponJs.indexOf('function couponRowHtml(');
  assert.ok(fnStart >= 0, 'couponRowHtml must exist in js/admin-coupons.js');
  const fnBody = couponJs.slice(fnStart, couponJs.indexOf('\n}\n', fnStart));

  const tdCount = (fnBody.match(/<td\b/g) || []).length;
  const labelledCount = (fnBody.match(/<td\b[^>]*data-label=/g) || []).length;
  assert.ok(tdCount >= 9, 'expected the nine coupon table cells');
  assert.equal(
    labelledCount,
    tdCount,
    'Every coupon <td> needs a data-label — the mobile card labels are generated from it via ::before.'
  );

  // The exact info the bug report said was unreadable must stay in the markup.
  for (const label of [
    'Coupon / Creator',
    'Discount',
    'Applies to',
    'Usage',
    'Expiry',
    'Verified Revenue',
    'Affiliate Payout',
    'Status',
    'Share & Actions',
  ]) {
    assert.ok(fnBody.includes(`data-label="${label}"`), `missing data-label "${label}"`);
  }
});

test('coupon rows always render the full expiry timestamp, revenue and creator description', () => {
  const fnStart = couponJs.indexOf('function couponRowHtml(');
  const fnBody = couponJs.slice(fnStart, couponJs.indexOf('\n}\n', fnStart));
  // Countdown plus the absolute date ("Never expires" when there is none).
  assert.match(fnBody, /fmtDateTime\(row\.expiresAt\)/);
  assert.match(fnBody, /Never expires/);
  // Money: verified revenue and the calculated affiliate payout.
  assert.match(fnBody, /formatCouponRupees\(row\.revenuePaise\)/);
  assert.match(fnBody, /formatCouponRupees\(payout\.payoutPaise\)/);
  // Creator / campaign note.
  assert.match(fnBody, /class="coupon-desc"/);
});
