// Unit tests for the Coupon & Promo Codes Manager core helpers.
// The browser module (js/admin-coupons.js) exposes its dependency-free core as
// `globalThis.CouponCore`, so the same code is tested without a DOM.

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

const source = fs.readFileSync('js/admin-coupons.js', 'utf8');
const start = source.indexOf('const COUPON_CODE_PATTERN');
const end = source.indexOf('globalThis.CouponCore = CouponCore;');
if (start < 0 || end < 0) throw new Error('coupon core block not found in js/admin-coupons.js');

const coreSource = source.slice(start, end + 'globalThis.CouponCore = CouponCore;'.length);
const ctx = vm.createContext({ console });
vm.runInContext(coreSource, ctx);
const core = ctx.CouponCore;

const NOW = Date.parse('2026-10-23T12:00:00.000Z');

test('coupon codes are normalised to the RPC alphabet', () => {
  assert.equal(core.normalizeCouponCode(' diwali 30 '), 'DIWALI30');
  assert.equal(core.normalizeCouponCode('new-year_sale!'), 'NEW-YEAR_SALE');
  assert.equal(core.normalizeCouponCode('🎟️ promo'), 'PROMO');
  assert.equal(core.normalizeCouponCode(null), '');
  assert.equal(core.normalizeCouponCode('A'.repeat(30)).length, 24);
});

test('code validation matches the 3–24 char [A-Z0-9_-] rule', () => {
  ['DIWALI30', 'PYD-ABC_12', 'A_B', 'X'.repeat(24)].forEach((code) => {
    assert.equal(core.isValidCouponCode(code), true, `${code} should be valid`);
  });
  ['AB', 'diwali30', 'CODE WITH SPACE', 'X'.repeat(25), '', 'DIWALI.30'].forEach((code) => {
    assert.equal(core.isValidCouponCode(code), false, `${code} should be rejected`);
  });
});

test('random codes are always valid and never contain ambiguous glyphs', () => {
  const fixed = core.generateCouponCode(() => 0);
  assert.equal(fixed, 'PYD-AAAAAA');
  assert.match(fixed, /^[A-Z0-9_-]{3,24}$/);
  const top = core.generateCouponCode(() => 0.999999);
  assert.equal(top.length, 10);
  assert.match(top, /^[A-Z0-9_-]{3,24}$/);
  assert.doesNotMatch(top, /[01OI]/);
});

test('price preview applies the discount to the live base prices', () => {
  const prices = core.couponPricePreview(30);
  assert.equal(prices.monthly.basePaise, 14900);
  assert.equal(prices.monthly.finalPaise, 10430);
  assert.equal(prices.monthly.savePaise, 4470);
  assert.equal(prices.yearly.basePaise, 99900);
  assert.equal(prices.yearly.finalPaise, 69930);
  assert.equal(prices.yearly.savePaise, 29970);

  const capped = core.couponPricePreview(150);
  assert.equal(capped.monthly.finalPaise, 2980); // 80% cap
  assert.equal(capped.yearly.finalPaise, 19980);

  assert.equal(core.couponPricePreview(0).monthly.finalPaise, 14900);
  assert.equal(core.couponPricePreview('').yearly.finalPaise, 99900);
});

test('rupees formatting keeps paise only when they exist', () => {
  assert.equal(core.formatCouponRupees(14900), '₹149');
  assert.equal(core.formatCouponRupees(99900), '₹999');
  assert.equal(core.formatCouponRupees(10430), '₹104.30');
  assert.equal(core.formatCouponRupees(104930), '₹1,049.30');
  assert.equal(core.formatCouponRupees(0), '₹0');
  assert.equal(core.formatCouponRupees(null), '₹0');
});

test('usage tracks unlimited, partial and full quotas', () => {
  const partial = core.couponUsage({ usedCount: 3, maxUses: 50 });
  assert.equal(partial.used, 3);
  assert.equal(partial.percent, 6);
  assert.equal(partial.remaining, 47);
  assert.equal(partial.full, false);

  const unlimited = core.couponUsage({ usedCount: 12, maxUses: null });
  assert.equal(unlimited.unlimited, true);
  assert.equal(unlimited.percent, 0);
  assert.equal(unlimited.remaining, null);

  const full = core.couponUsage({ usedCount: 50, maxUses: 50 });
  assert.equal(full.percent, 100);
  assert.equal(full.full, true);
});

test('status badges cover active, paused, expired and quota-full', () => {
  assert.equal(core.couponStatus({ isActive: true, usedCount: 1, maxUses: 10, expiresAt: null }, NOW).key, 'active');
  assert.equal(core.couponStatus({ isActive: false, usedCount: 0, maxUses: null }, NOW).label, 'Paused');
  assert.equal(core.couponStatus({ isActive: true, isExpired: true }, NOW).label, 'Expired');
  assert.equal(core.couponStatus({ isActive: true, expiresAt: '2026-10-22T12:00:00.000Z' }, NOW).label, 'Expired');
  assert.equal(core.couponStatus({ isActive: true, usedCount: 10, maxUses: 10 }, NOW).label, 'Quota full');

  // An expired code stays "Expired" even if it was also paused.
  assert.equal(core.couponStatus({ isActive: false, isExpired: true }, NOW).label, 'Expired');
});

test('expiry countdown reads naturally', () => {
  assert.deepEqual(
    { ...core.couponCountdown(null, NOW) },
    { state: 'none', text: 'No expiry', tone: 'muted' }
  );
  assert.equal(core.couponCountdown('2026-10-25T12:00:00.000Z', NOW).text, 'Ends in 2d');
  assert.equal(core.couponCountdown('2026-10-23T18:00:00.000Z', NOW).text, 'Ends in 6h');
  assert.equal(core.couponCountdown('2026-10-23T18:00:00.000Z', NOW).tone, 'warn');
  assert.equal(core.couponCountdown('2026-10-21T12:00:00.000Z', NOW).text, 'Expired 2d ago');
  assert.equal(core.couponCountdown('2026-10-21T12:00:00.000Z', NOW).tone, 'danger');
});

test('expiry presets and datetime-local round-trips', () => {
  assert.equal(core.couponPresetExpiryIso('24h', NOW), '2026-10-24T12:00:00.000Z');
  assert.equal(core.couponPresetExpiryIso('7d', NOW), '2026-10-30T12:00:00.000Z');
  assert.equal(core.couponPresetExpiryIso('30d', NOW), '2026-11-22T12:00:00.000Z');
  assert.equal(core.couponPresetExpiryIso('none', NOW), null);
  assert.equal(core.couponPresetExpiryIso('bogus', NOW), null);

  // Both helpers work in local time, so a value survives the round trip.
  const local = '2026-11-05T18:30';
  assert.equal(core.isoToLocalInputValue(core.localInputValueToIso(local)), local);
  assert.equal(core.isoToLocalInputValue(null), '');
  assert.equal(core.localInputValueToIso(''), null);
  assert.equal(core.localInputValueToIso('not-a-date'), null);
});

test('share links point at the premium checkout with the coupon', () => {
  assert.equal(core.couponShareLink('DIWALI30'), 'https://pydebug.in/premium?coupon=DIWALI30');
  assert.equal(core.couponShareLink('A B'), 'https://pydebug.in/premium?coupon=A%20B');
});

test('form validation produces the exact admin_upsert_coupon arguments', () => {
  const result = core.validateCouponForm({
    code: 'diwali30',
    discountPercent: '30',
    applicablePlan: 'yearly',
    maxUses: '',
    maxUsesPerUser: '2',
    expiresAt: '2026-11-05T18:30',
    firstPurchaseOnly: true,
    description: '  Diwali Sale — YouTube promo  ',
  }, NOW);

  assert.equal(result.ok, true);
  assert.deepEqual({ ...result.errors }, {});
  assert.equal(result.value.code, 'DIWALI30');
  assert.equal(result.value.discountPercent, 30);
  assert.equal(result.value.applicablePlan, 'yearly');
  assert.equal(result.value.maxUses, null); // blank = unlimited
  assert.equal(result.value.maxUsesPerUser, 2);
  assert.equal(result.value.expiresAtIso, core.localInputValueToIso('2026-11-05T18:30'));
  assert.equal(result.value.firstPurchaseOnly, true);
  assert.equal(result.value.description, 'Diwali Sale — YouTube promo');
});

test('form validation rejects out-of-range values', () => {
  const base = { code: 'DIWALI30', discountPercent: '30', applicablePlan: 'all' };

  assert.match(core.validateCouponForm({ ...base, code: '' }, NOW).errors.code, /required/i);
  assert.match(core.validateCouponForm({ ...base, code: 'AB' }, NOW).errors.code, /3–24/);
  assert.match(core.validateCouponForm({ ...base, discountPercent: '0' }, NOW).errors.discountPercent, /between 1% and 80%/);
  assert.match(core.validateCouponForm({ ...base, discountPercent: '81' }, NOW).errors.discountPercent, /between 1% and 80%/);
  assert.match(core.validateCouponForm({ ...base, discountPercent: '30.5' }, NOW).errors.discountPercent, /whole number/);
  assert.match(core.validateCouponForm({ ...base, discountPercent: '' }, NOW).errors.discountPercent, /between 1% and 80%/);
  assert.match(core.validateCouponForm({ ...base, maxUses: '0' }, NOW).errors.maxUses, /1 or more/);
  assert.match(core.validateCouponForm({ ...base, maxUsesPerUser: '11' }, NOW).errors.maxUsesPerUser, /1 and 10/);
  assert.match(core.validateCouponForm({ ...base, applicablePlan: 'lifetime' }, NOW).errors.applicablePlan, /plans/);
  assert.match(core.validateCouponForm({ ...base, expiresAt: '2026-10-01T10:00' }, NOW).errors.expiresAt, /future/i);
});

test('per-user limit defaults to 1 and description is capped at 160 chars', () => {
  const result = core.validateCouponForm({
    code: 'NEWYEAR',
    discountPercent: 25,
    applicablePlan: 'all',
    description: 'x'.repeat(400),
  }, NOW);

  assert.equal(result.ok, true);
  assert.equal(result.value.maxUsesPerUser, 1);
  assert.equal(result.value.maxUses, null);
  assert.equal(result.value.expiresAtIso, null);
  assert.equal(result.value.description.length, 160);
  assert.equal(result.value.firstPurchaseOnly, false);
});

test('delete result understands delete vs deactivate responses', () => {
  assert.deepEqual({ ...core.parseCouponDeleteResult({ deleted: true, deactivated: false }) }, { deleted: true, deactivated: false });
  assert.deepEqual({ ...core.parseCouponDeleteResult({ deleted: false, deactivated: true }) }, { deleted: false, deactivated: true });
  assert.deepEqual({ ...core.parseCouponDeleteResult([{ deleted: false, deactivated: true }]) }, { deleted: false, deactivated: true });
  // Older installs return void — treat that as a plain delete.
  assert.deepEqual({ ...core.parseCouponDeleteResult(null) }, { deleted: true, deactivated: false });
});

test('summary cards count live codes, redemptions and revenue', () => {
  const summary = core.summarizeCoupons([
    { isActive: true, usedCount: 3, revenuePaise: 30000, expiresAt: '2026-12-01T00:00:00.000Z' },
    { isActive: false, usedCount: 1, revenuePaise: 10000 },
    { isActive: true, isExpired: true, usedCount: 5, revenuePaise: 40000 },
    { isActive: true, usedCount: 10, maxUses: 10, revenuePaise: 90000 },
  ], NOW);

  assert.equal(summary.total, 4);
  assert.equal(summary.active, 1);
  assert.equal(summary.paused, 1);
  assert.equal(summary.expired, 1);
  assert.equal(summary.quotaFull, 1);
  assert.equal(summary.redemptions, 19);
  assert.equal(summary.revenuePaise, 170000);
  assert.equal(core.formatCouponRupees(summary.revenuePaise), '₹1,700');
});

test('empty and malformed coupon lists never break the summary', () => {
  const summary = core.summarizeCoupons([], NOW);
  assert.deepEqual({ ...summary }, { total: 0, active: 0, paused: 0, expired: 0, quotaFull: 0, redemptions: 0, revenuePaise: 0 });
  assert.equal(core.couponUsage({}).percent, 0);
  assert.equal(core.couponStatus({}, NOW).key, 'active');
});
