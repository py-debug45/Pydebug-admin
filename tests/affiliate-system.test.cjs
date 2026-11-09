const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('affiliate migration keeps money in paise, attributes only captured paid grants, and holds commissions seven days', () => {
  const sql = read('db/migrations/20261109_affiliate_partners_weekly_payouts.sql');
  assert.match(sql, /sale_amount_paise bigint/);
  assert.match(sql, /after insert on public\.payment_grants/);
  assert.match(sql, /new\.amount_paise/);
  assert.match(sql, /interval '7 days'/);
  assert.match(sql, /on conflict\(payment_id\) do nothing/);
  assert.match(sql, /before insert on public\.payment_orders/);
  assert.match(sql, /affiliate_commission_percent/);
  assert.match(sql, /extract\(isodow from v_today\)<>7/);
  assert.match(sql, /'Asia\/Kolkata'/);
  assert.match(sql, /public\.has_perm\('payments\.write'\)/);
});

test('partner data is exposed only by caller-scoped RPCs and admin writes are guarded', () => {
  const sql = read('db/migrations/20261109_affiliate_partners_weekly_payouts.sql');
  assert.match(sql, /enable row level security/);
  assert.match(sql, /revoke all on public\.affiliate_partners, public\.affiliate_commissions,/);
  assert.match(sql, /if v_uid is null then raise exception 'Sign in required'/);
  assert.match(sql, /public\.has_perm\('coupons\.write'\)/);
  assert.match(sql, /public\.has_perm\('payments\.write'\)/);
  assert.match(sql, /p_accept_terms is distinct from true/);
});

test('the admin and partner frontends use Supabase RPCs without bundling privileged secrets', () => {
  const admin = read('js/admin-affiliates.js');
  const partner = read('js/partner-portal.js');
  const html = read('partner.html');
  assert.match(admin, /affiliate_admin_create_sunday_payout_run/);
  assert.match(admin, /affiliate_admin_mark_payout/);
  assert.match(admin, /requirePerm\("coupons\.read"\)/);
  assert.match(partner, /affiliate_partner_dashboard/);
  assert.match(partner, /affiliate_apply/);
  assert.match(html, /Partner Rules &amp; Payout Policy/);
  assert.match(html, /7 days/);
  assert.match(html, /Sunday/);
  assert.doesNotMatch(`${admin}\n${partner}\n${html}`, /service_role|RAZORPAY_KEY_SECRET|SUPABASE_SERVICE_ROLE_KEY/i);
  assert.doesNotMatch(html, /admin-boot\.js/); // collaborators do not share the admin session
});

test('price example for recommended 10% discount and 20% commission uses customer-paid amount', () => {
  const monthlyPaidPaise = Math.round(14900 * 0.90);
  const yearlyPaidPaise = Math.round(99900 * 0.90);
  assert.equal(monthlyPaidPaise, 13410);
  assert.equal(Math.round(monthlyPaidPaise * 0.20), 2682);
  assert.equal(monthlyPaidPaise - Math.round(monthlyPaidPaise * 0.20), 10728);
  assert.equal(yearlyPaidPaise, 89910);
  assert.equal(Math.round(yearlyPaidPaise * 0.20), 17982);
  assert.equal(yearlyPaidPaise - Math.round(yearlyPaidPaise * 0.20), 71928);
});
