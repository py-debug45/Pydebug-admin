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

test('live plan catalog matches pydebug.in/premium founding prices', () => {
  const ctx = fullCommonContext();
  assert.equal(ctx.planAmountPaise('monthly'), 14900);
  assert.equal(ctx.planAmountPaise('sixmonth'), 49900);
  assert.equal(ctx.planAmountPaise('yearly'), 99900);
  assert.equal(ctx.planAmountPaise('exam_pack'), 149900);
  assert.equal(ctx.planLabel('exam_pack'), 'Exam Pack');
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
