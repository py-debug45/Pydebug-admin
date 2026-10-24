const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

const source = fs.readFileSync('js/admin-common.js', 'utf8');
const helpers = source.slice(source.indexOf('async function fetchAdminRows'));

function context(sb) {
  const ctx = vm.createContext({ sb, planAmountPaise: () => 9900 });
  vm.runInContext(helpers, ctx);
  return ctx;
}

function fullCommonContext(sb) {
  const escapeHtml = (str) => String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const ctx = vm.createContext({
    sb,
    escapeHtml,
    console,
    Date,
    Math,
    Number,
    String,
    Object,
    Map,
    Set,
    Promise,
    setTimeout,
    clearTimeout,
    document: {
      readyState: 'loading',
      addEventListener: () => {},
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    window: {
      location: { pathname: '/dashboard.html', href: '' },
      setTimeout,
    },
    sessionStorage: { getItem: () => null, removeItem: () => {} },
  });
  vm.runInContext(source, ctx);
  return ctx;
}

test('analytics reads all rows beyond PostgREST response limit', async () => {
  const rows = Array.from({ length: 1274 }, (_, id) => ({ id }));
  const ranges = [];
  const ctx = context({
    from: () => ({
      select: () => ({
        order: () => ({
          range: async (a, b) => {
            ranges.push([a, b]);
            return { data: rows.slice(a, b + 1), error: null };
          },
        }),
      }),
    }),
  });
  assert.equal((await ctx.fetchAdminRows('submissions', 'id')).length, 1274);
  assert.deepEqual(ranges, [[0, 499], [500, 999], [1000, 1499]]);
});

test('query failures are not presented as empty real data', async () => {
  const ctx = context({
    from: () => ({
      select: () => ({
        order: () => ({
          range: async () => ({ error: new Error('denied') }),
        }),
      }),
    }),
  });
  await assert.rejects(ctx.fetchAdminRows('problems', 'id'), /denied/);
});

test('revenue uses verified charged amount, linked order amount, or plan fallback', () => {
  const ctx = context();
  assert.equal(ctx.grantAmountPaise({ amount_paise: 4900 }), 4900);
  assert.equal(ctx.grantAmountPaise({ amount_paise: 0 }), 0);
  assert.equal(ctx.grantAmountPaise({ amount_paise: null, order_amount_paise: 14900, plan_key: 'monthly' }), 14900);
  assert.equal(ctx.grantAmountPaise({ amount_paise: null, plan_key: 'monthly' }), 9900);
});

test('discounted purchases report the real charged amount, list price and savings', () => {
  const ctx = fullCommonContext();

  // DIWALI01: 20% off Pro Monthly (₹149) => Razorpay charged ₹119.
  const monthly = { amount_paise: 11900, plan_key: 'monthly', discount_percent: 20, coupon_code: 'DIWALI01' };
  assert.equal(ctx.grantPaidPaise(monthly), 11900);
  assert.equal(ctx.grantAmountPaise(monthly), 11900, 'revenue must use ₹119, not the ₹149 catalog price');
  assert.equal(ctx.grantAmountIsEstimated(monthly), false);
  assert.equal(ctx.grantDiscountPercent(monthly), 20);
  assert.equal(ctx.grantListAmountPaise(monthly), 14875);
  assert.equal(ctx.grantDiscountPaise(monthly), 2975);

  // No coupon columns stored? Infer the discount from the actual amount.
  const yearly = { amount_paise: 79920, plan_key: 'yearly' };
  assert.equal(ctx.grantDiscountPercent(yearly), 20);
  assert.equal(ctx.grantListAmountPaise(yearly), 99900);
  assert.equal(ctx.grantDiscountPaise(yearly), 19980);
  assert.equal(ctx.grantAmountPaise(yearly), 79920);

  // A linked checkout order can stand in for an older grant.
  const fromOrder = { amount_paise: null, order_amount_paise: 11900, plan_key: 'monthly', discount_percent: 20 };
  assert.equal(ctx.grantPaidPaise(fromOrder), 11900);
  assert.equal(ctx.grantAmountIsEstimated(fromOrder), false);

  // Legacy grants are flagged instead of silently pretending the list price was paid.
  const legacy = { amount_paise: null, plan_key: 'yearly' };
  assert.equal(ctx.grantAmountIsEstimated(legacy), true);
  assert.equal(ctx.grantAmountPaise(legacy), 99900);
  assert.equal(ctx.grantDiscountPercent(legacy), 0);
  assert.equal(ctx.grantDiscountPaise(legacy), 0);
});

test('premium expiry labels show time left and expired access', () => {
  const ctx = fullCommonContext();
  const inThreeDays = new Date(Date.now() + 3 * 86400000).toISOString();
  const three = ctx.premiumTimeLeft(inThreeDays);
  assert.equal(three.expired, false);
  assert.equal(three.days, 3);
  assert.match(three.label, /3 days left/);

  const never = ctx.premiumTimeLeft(null);
  assert.equal(never.expired, false);
  assert.equal(never.days, null);
  assert.equal(never.label, 'No expiry');
  const gone = ctx.premiumTimeLeft('2020-01-01T00:00:00Z');
  assert.equal(gone.expired, true);
  assert.equal(gone.label, 'Expired');

  const soon = ctx.premiumTimeLeft(new Date(Date.now() + 5 * 3600000).toISOString());
  assert.equal(soon.expired, false);
  assert.match(soon.label, /Ends in \d+h/);
});

test('live plan catalog matches pydebug.in/premium founding prices including weekly 7-Day Pass and legacy sixmonth', () => {
  const ctx = fullCommonContext();
  assert.equal(ctx.planAmountPaise('weekly'), 4900);
  assert.equal(ctx.planLabel('weekly'), 'Pro 7-Day Pass (7d)');
  assert.match(ctx.planBadge('weekly'), /tag--weekly.*Pro 7-Day Pass \(7d\)/);

  assert.equal(ctx.planAmountPaise('monthly'), 14900);
  assert.equal(ctx.planLabel('monthly'), 'Pro Monthly');

  assert.equal(ctx.planAmountPaise('yearly'), 99900);
  assert.equal(ctx.planLabel('yearly'), 'Pro Yearly');

  assert.equal(ctx.planAmountPaise('sixmonth'), 49900);
  assert.equal(ctx.planLabel('sixmonth'), 'Pro 6 Months (Legacy)');
  assert.match(ctx.planBadge('sixmonth'), /tag--unknown.*Pro 6 Months \(Legacy\)/);

  assert.equal(ctx.planAmountPaise('exam_pack'), 149900);
  assert.equal(ctx.planLabel('exam_pack'), 'Exam Pack');

  assert.equal(ctx.formatPaiseINR(4900), '₹49');
  assert.equal(ctx.formatPaiseINR(3920), '₹39.20');
});

test('sachet conversion metrics split today/7d revenue and track weekly -> monthly/yearly repeat upgrades', () => {
  const ctx = fullCommonContext();
  const now = new Date('2026-10-24T18:00:00.000Z').getTime();
  const todayIso = new Date(now - 2 * 3600000).toISOString();
  const threeDaysAgoIso = new Date(now - 3 * 86400000).toISOString();
  const twentyDaysAgoIso = new Date(now - 20 * 86400000).toISOString();

  const grants = [
    // User 1: bought weekly 20d ago (welcome ₹39), upgraded to monthly today (₹149)
    { user_id: 'u1', plan_key: 'weekly', amount_paise: 3900, created_at: twentyDaysAgoIso },
    { user_id: 'u1', plan_key: 'monthly', amount_paise: 14900, created_at: todayIso },
    // User 2: bought weekly 3d ago (₹49), upgraded to yearly today (₹999)
    { user_id: 'u2', plan_key: 'weekly', amount_paise: 4900, created_at: threeDaysAgoIso },
    { user_id: 'u2', plan_key: 'yearly', amount_paise: 99900, created_at: todayIso },
    // User 3: bought weekly today (₹49), has not upgraded yet
    { user_id: 'u3', plan_key: 'weekly', amount_paise: 4900, created_at: todayIso },
    // User 4: bought monthly first, later bought weekly — NOT a weekly-first upgrade
    { user_id: 'u4', plan_key: 'monthly', amount_paise: 14900, created_at: twentyDaysAgoIso },
    { user_id: 'u4', plan_key: 'weekly', amount_paise: 4900, created_at: threeDaysAgoIso },
  ];

  const m = ctx.computeSachetMetrics(grants, now);
  assert.equal(m.today.weekly.count, 1);
  assert.equal(m.today.weekly.revenuePaise, 4900);
  assert.equal(m.today.monthly.count, 1);
  assert.equal(m.today.monthly.revenuePaise, 14900);
  assert.equal(m.today.yearly.count, 1);
  assert.equal(m.today.yearly.revenuePaise, 99900);

  assert.equal(m.last7d.weekly.count, 3);
  assert.equal(m.last7d.weekly.revenuePaise, 14700);
  assert.equal(m.last7d.monthly.count, 1);
  assert.equal(m.last7d.yearly.count, 1);

  assert.equal(m.upgrades.weeklyFirstUsers, 3);
  assert.equal(m.upgrades.upgradedUsers, 2);
  assert.equal(m.upgrades.toMonthlyUsers, 1);
  assert.equal(m.upgrades.toYearlyUsers, 1);
  assert.equal(m.upgrades.conversionPercent, 67);
  assert.equal(m.upgrades.upgradeRevenuePaise, 14900 + 99900);

  const html = ctx.renderSachetCardHtml(m);
  assert.match(html, /Pro 7-Day Pass \(7d\)/);
  assert.match(html, /2 Sachet → Pro Upgrades/);
});

test('campus leaderboard helpers parse, moderate, and aggregate display_name tags case-insensitively', () => {
  const ctx = fullCommonContext();

  const parsed = ctx.parseDisplayNameCampus('Aarav Sharma · DAVV Indore');
  assert.equal(parsed.hasCampus, true);
  assert.equal(parsed.baseName, 'Aarav Sharma');
  assert.equal(parsed.campusTag, 'DAVV Indore');

  const plain = ctx.parseDisplayNameCampus('Priya Patel');
  assert.equal(plain.hasCampus, false);
  assert.equal(plain.baseName, 'Priya Patel');
  assert.equal(plain.campusTag, null);

  assert.equal(ctx.clearDisplayNameCampus('Aarav Sharma · Spam Tag'), 'Aarav Sharma');
  assert.equal(ctx.composeDisplayNameWithCampus('Aarav Sharma', 'IIT Bombay'), 'Aarav Sharma · IIT Bombay');

  const longComposed = ctx.composeDisplayNameWithCampus('A'.repeat(50), 'Indian Institute of Technology Indore MP');
  assert.ok(longComposed.length <= 60, `Expected <= 60 chars, got ${longComposed.length}`);
  assert.ok(longComposed.includes(' · '));

  assert.equal(
    ctx.campusLeaderboardLink('DAVV Indore'),
    'https://pydebug.in/leaderboard?campus=DAVV%20Indore'
  );

  const rollup = ctx.aggregateCampuses([
    { display_name: 'Aarav · DAVV Indore', xp: 450, streak: 5, is_premium: true },
    { display_name: 'Riya · davv indore', xp: 300, streak: 0, is_premium: false },
    { display_name: 'Kabir · VIT Vellore', xp: 900, streak: 12, is_premium: true },
    { display_name: 'Untagged Learner', xp: 5000, streak: 20, is_premium: true },
  ]);

  assert.equal(rollup.length, 2);
  assert.equal(rollup[0].campus, 'DAVV Indore');
  assert.equal(rollup[0].totalStudents, 2);
  assert.equal(rollup[0].activeStreakUsers, 1);
  assert.equal(rollup[0].totalXp, 750);
  assert.equal(rollup[0].proSubscribers, 1);
  assert.equal(rollup[0].leaderboardUrl, 'https://pydebug.in/leaderboard?campus=DAVV%20Indore');

  assert.equal(rollup[1].campus, 'VIT Vellore');
  assert.equal(rollup[1].totalStudents, 1);
  assert.equal(rollup[1].totalXp, 900);
});

test('grant controls offer 7-day pass and never offer legacy sixmonth for new grants', () => {
  const paymentsHtml = fs.readFileSync('payments.html', 'utf8');
  const userDetailHtml = fs.readFileSync('user-detail.html', 'utf8');

  // Entitlement grant select in payments.html has 7 Days — Pro 7-Day Pass and NOT sixmonth/182
  const entSelect = paymentsHtml.match(/<select id="ent-days">([\s\S]*?)<\/select>/);
  assert.ok(entSelect, 'Expected #ent-days select on payments.html');
  assert.match(entSelect[1], /value="7"[^>]*>7 Days — Pro 7-Day Pass/);
  assert.doesNotMatch(entSelect[1], /sixmonth|182/i);

  // User detail grant select has 7d — Pro 7-Day Pass and NOT sixmonth/6mo
  const premSelect = userDetailHtml.match(/<select id="premium-duration">([\s\S]*?)<\/select>/);
  assert.ok(premSelect, 'Expected #premium-duration select on user-detail.html');
  assert.match(premSelect[1], /value="7d"[^>]*>7 Days — Pro 7-Day Pass/);
  assert.doesNotMatch(premSelect[1], /sixmonth|6mo/i);
});

test('slugifyProblemTitle produces clean URL-safe slugs', () => {
  const ctx = fullCommonContext();
  assert.equal(ctx.slugifyProblemTitle("TypeError: range('5') gets text!"), 'typeerror-range-5-gets-text');
  assert.equal(ctx.slugifyProblemTitle('   ---   '), 'python-problem');
});

test('badges render account moderation, certificate tiers, and statuses safely', () => {
  const ctx = fullCommonContext();
  assert.equal(ctx.accountStatusBadge({ status: 'active' }), '');
  assert.match(ctx.accountStatusBadge({ status: 'muted', status_reason: 'Spam' }), /tag--attempted.*muted/);
  assert.match(ctx.accountStatusBadge({ status: 'banned' }), /tag--failed.*banned/);
  assert.match(
    ctx.accountStatusBadge({ status: 'muted', status_until: '2020-01-01T00:00:00Z' }),
    /Restriction ended/
  );
  assert.match(ctx.tierBadge('diamond'), /Diamond/);
  assert.match(ctx.statusBadge('revoked'), /tag--failed/);
  assert.match(ctx.statusBadge('pilot_active'), /tag--solved/);
});

test('every table queried by the admin panel has authenticated grants and RLS policies in migrations', () => {
  const path = require('node:path');
  const jsFiles = fs.readdirSync('js').filter((f) => f.endsWith('.js'));
  const queriedTables = new Set();
  const insertedTables = new Set();

  for (const file of jsFiles) {
    const code = fs.readFileSync(path.join('js', file), 'utf8');
    for (const m of code.matchAll(/fetchAdminRows\(\s*["']([^"']+)["']/g)) {
      queriedTables.add(m[1]);
    }
    for (const m of code.matchAll(/\.from\(\s*["']([^"']+)["']\s*\)/g)) {
      queriedTables.add(m[1]);
    }
    for (const m of code.matchAll(/\.from\(\s*["']([^"']+)["']\s*\)\.insert\(/g)) {
      insertedTables.add(m[1]);
    }
  }

  assert.ok(queriedTables.has('user_certificates'));
  assert.ok(queriedTables.has('mock_attempts'));
  assert.ok(queriedTables.has('study_plans'));

  const restoreSql = fs.readFileSync('db/migrations/20261021_restore_admin_access.sql', 'utf8');
  const completeSql = fs.readFileSync('db/migrations/20261023_complete_admin_features.sql', 'utf8');
  const fixGrantsSql = fs.readFileSync('db/migrations/20261023_fix_admin_table_grants.sql', 'utf8');
  const combinedSql = `${restoreSql}\n${completeSql}\n${fixGrantsSql}`;

  for (const table of queriedTables) {
    assert.match(
      restoreSql,
      new RegExp(`'${table}'`),
      `Expected ${table} to be included in 20261021_restore_admin_access.sql`
    );
    const hasExplicitGrant =
      new RegExp(`grant\\s+[^;]*select[^;]*on\\s+public\\.${table}\\s+to\\s+[^;]*authenticated`, 'i').test(combinedSql) ||
      new RegExp(`'${table}'`).test(restoreSql);
    assert.ok(hasExplicitGrant, `Expected SELECT grant for ${table}`);
  }

  // Specifically guard the tables that previously threw "permission denied for table ..."
  for (const criticalTable of [
    'user_certificates',
    'mock_attempts',
    'study_plans',
    'payment_orders',
    'product_entitlements',
    'push_announcements',
    'push_broadcast_log',
    'discussion_flags',
    'referrals',
    'admin_audit_log',
  ]) {
    assert.match(
      fixGrantsSql,
      new RegExp(`grant\\s+[^;]*select[^;]*on\\s+public\\.${criticalTable}\\s+to\\s+authenticated`, 'i'),
      `Expected explicit SELECT grant for ${criticalTable} in 20261023_fix_admin_table_grants.sql`
    );
    assert.match(
      fixGrantsSql,
      new RegExp(`revoke\\s+all\\s+on\\s+public\\.${criticalTable}\\s+from\\s+anon`, 'i'),
      `Expected anon privilege revocation on ${criticalTable}`
    );
  }

  // Client-side inserts (including writeAdminAudit and Web Push broadcast queue) must have INSERT privilege
  for (const table of insertedTables) {
    const grantedInFix = new RegExp(`grant\\s+[^;]*insert[^;]*on\\s+public\\.${table}\\s+to\\s+[^;]*authenticated`, 'i').test(combinedSql);
    const grantedInLoop = new RegExp(`'${table}'`).test(restoreSql.slice(restoreSql.indexOf('-- Writes are granted')));
    assert.ok(grantedInFix || grantedInLoop, `Expected INSERT grant for client-inserted table ${table}`);
  }
});
