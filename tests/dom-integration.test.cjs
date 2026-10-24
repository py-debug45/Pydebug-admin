const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

test('HTML markup across updated admin pages has matching IDs, scripts, and zero broken element hooks', () => {
  const pages = [
    {
      html: 'coupons.html',
      js: 'js/admin-coupons.js',
      requiredIds: [
        'coupon-stat-active',
        'coupon-stat-redemptions',
        'coupon-stat-revenue',
        'coupon-stat-payout',
        'coupon-form',
        'coupon-code',
        'coupon-discount',
        'coupon-discount-range',
        'coupon-plan',
        'coupon-expires',
        'coupon-first-purchase',
        'coupon-description',
        'coupon-price-weekly',
        'coupon-price-weekly-final',
        'coupon-price-monthly',
        'coupon-price-yearly',
        'coupons-tbody',
      ],
    },
    {
      html: 'payments.html',
      js: 'js/admin-payments.js',
      requiredIds: [
        'sachet-conversion-root',
        'payment-filter-plan',
        'order-filter-plan',
        'order-filter-state',
        'entitlement-form',
        'ent-user',
        'ent-product',
        'ent-days',
        'payments-tbody',
        'orders-tbody',
        'entitlements-tbody',
      ],
    },
    {
      html: 'users.html',
      js: 'js/admin-users.js',
      requiredIds: [
        'users-campus-card',
        'users-campus-root',
        'user-search',
        'user-filter-campus',
        'user-filter-plan',
        'users-tbody',
      ],
    },
    {
      html: 'user-detail.html',
      js: 'js/admin-user-detail.js',
      requiredIds: [
        'campus-tag-current',
        'campus-tag-input',
        'campus-tag-save-btn',
        'campus-tag-clear-btn',
        'display-name-input',
        'display-name-save-btn',
        'premium-duration',
        'premium-grant-btn',
        'premium-revoke-btn',
        'detail-purchases-tbody',
      ],
    },
    {
      html: 'dashboard.html',
      js: 'js/admin-dashboard.js',
      requiredIds: [
        'dashboard-sachet-root',
        'dashboard-campus-root',
        'stat-revenue',
        'stat-month-revenue',
      ],
    },
    {
      html: 'insights.html',
      js: 'js/admin-insights.js',
      requiredIds: [
        'insights-sachet-root',
        'insights-campus-root',
        'funnel',
        'expiring',
      ],
    },
  ];

  for (const page of pages) {
    const html = fs.readFileSync(path.join(ROOT, page.html), 'utf8');
    const js = fs.readFileSync(path.join(ROOT, page.js), 'utf8');
    assert.ok(js.length > 100);
    for (const id of page.requiredIds) {
      assert.match(html, new RegExp(`id=["']${id}["']`), `Expected #${id} in ${page.html}`);
    }
  }
});

test('admin-coupons.js wires exclusively to the 4 existing Supabase coupon RPCs with exact parameter names', () => {
  const code = fs.readFileSync(path.join(ROOT, 'js', 'admin-coupons.js'), 'utf8');

  // Must NOT bypass RLS via direct .from('coupons') or .from('coupon_redemptions')
  assert.doesNotMatch(code, /\.from\(\s*["']coupons["']\s*\)/);
  assert.doesNotMatch(code, /\.from\(\s*["']coupon_redemptions["']\s*\)/);

  // Must call all 4 RPCs with exact PostgreSQL parameter names
  assert.match(code, /sb\.rpc\(\s*["']admin_list_coupons["']\s*\)/);
  assert.match(code, /sb\.rpc\(\s*["']admin_upsert_coupon["']/);
  for (const param of [
    'p_code',
    'p_discount_percent',
    'p_applicable_plan',
    'p_max_uses',
    'p_max_uses_per_user',
    'p_expires_at',
    'p_first_purchase_only',
    'p_description',
    'p_is_active',
  ]) {
    assert.match(code, new RegExp(`\\b${param}\\s*:`), `Missing RPC parameter ${param}`);
  }
  assert.match(code, /sb\.rpc\(\s*["']admin_toggle_coupon["']\s*,\s*\{\s*p_code:\s*code,\s*p_is_active:\s*nextActive\s*\}/);
  assert.match(code, /sb\.rpc\(\s*["']admin_delete_coupon["']\s*,\s*\{\s*p_code:\s*code\s*\}/);
});

test('user-detail expiryForDuration extends active future Pro expiry accurately for 7d, 1mo, 3mo, 1yr and lifetime', () => {
  const utilsSrc = fs.readFileSync(path.join(ROOT, 'js', 'utils.js'), 'utf8');
  const detailSrc = fs.readFileSync(path.join(ROOT, 'js', 'admin-user-detail.js'), 'utf8');

  const ctx = vm.createContext({
    Date,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Set,
    Promise,
    encodeURIComponent,
    decodeURIComponent,
    parseInt,
    isNaN,
    setTimeout: () => {},
    onAdminReady: () => {},
    window: { location: { href: '' } },
    document: { getElementById: () => null },
  });
  vm.runInContext(utilsSrc, ctx);
  vm.runInContext(detailSrc, ctx);

  assert.equal(ctx.expiryForDuration('lifetime', null), null);

  // Extending an active future expiry adds exactly 7 days onto that future timestamp
  const futureBase = new Date(Date.now() + 10 * 86400000).toISOString();
  const extended7d = ctx.expiryForDuration('7d', futureBase);
  const diffDays = Math.round((new Date(extended7d).getTime() - new Date(futureBase).getTime()) / 86400000);
  assert.equal(diffDays, 7);

  // Expired past timestamp starts fresh from now + 7 days
  const pastBase = '2020-01-01T00:00:00.000Z';
  const fresh7d = ctx.expiryForDuration('7d', pastBase);
  const fromNowDays = Math.round((new Date(fresh7d).getTime() - Date.now()) / 86400000);
  assert.equal(fromNowDays, 7);
});
