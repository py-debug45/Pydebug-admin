const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const presenceSource = fs.readFileSync('js/admin-presence.js', 'utf8');
const heartbeatSource = fs.readFileSync('js/presence-heartbeat.js', 'utf8');

class FakeElement {
  constructor() {
    this.textContent = '';
    this._html = '';
    this.childElementCount = 0;
    this.ageElements = [];
    this.writes = 0;
  }
  set innerHTML(html) {
    this._html = html;
    this.writes++;
    this.childElementCount = (html.match(/<li(?:\s|>)/g) || []).length;
    this.ageElements = [...html.matchAll(/data-presence-id="([^"]+)"/g)]
      .map((match) => ({ dataset: { presenceId: match[1] }, textContent: '' }));
  }
  get innerHTML() { return this._html; }
  querySelectorAll(selector) { return selector === '[data-presence-id]' ? this.ageElements : []; }
}

function fakeDate(clock) {
  return class extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.wall])); }
    static now() { return clock.wall; }
  };
}

function setupPresence(sb, start = Date.parse('2026-10-30T03:00:00Z')) {
  const clock = { wall: start, mono: 1000 };
  const ids = ['live-list', 'live-count', 'stat-active-now', 'live-updated',
    'daily-list', 'daily-count', 'stat-daily-practice', 'stat-daily-sub'];
  const els = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  const listeners = {};
  const intervals = [];
  const document = {
    hidden: false,
    visibilityState: 'visible',
    getElementById: (id) => els[id] || null,
    addEventListener: (name, fn) => { listeners[name] = fn; },
  };
  const ctx = vm.createContext({
    sb, document, console: { warn() {} }, Date: fakeDate(clock),
    performance: { now: () => clock.mono },
    escapeHtml: (str) => String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    setTimeout, clearTimeout,
    setInterval: (fn, delay) => { intervals.push({ fn, delay }); return intervals.length; },
  });
  vm.runInContext(presenceSource, ctx);
  return { ctx, els, clock, document, listeners, intervals };
}

function snapshot(checkedAt, rows = []) {
  return { data: { checked_at: new Date(checkedAt).toISOString(), rows }, error: null };
}
function row(id, lastSeen, page = '/') {
  return { user_id: id, last_seen_at: new Date(lastSeen).toISOString(), page };
}
function snapshotClient(results, getProfiles = (ids) => ids.map((id) => ({ id, display_name: id }))) {
  const calls = { rpc: 0, profileBatches: [] };
  return {
    calls,
    async rpc(name) {
      assert.equal(name, 'admin_get_live_presence');
      return results[Math.min(calls.rpc++, results.length - 1)];
    },
    from(table) {
      assert.equal(table, 'profiles');
      return { select() { return { async in(_field, ids) {
        calls.profileBatches.push([...ids]);
        return { data: getProfiles(ids), error: null };
      } }; } };
    },
  };
}

function advance(clock, ms) { clock.wall += ms; clock.mono += ms; }
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('live snapshot rejects future and stale heartbeats regardless of admin device clock', async () => {
  const server = Date.parse('2026-10-30T03:00:00Z');
  const client = snapshotClient([snapshot(server, [
    row('valid', server - 10_000, '/learn'),
    row('future', server + 18 * 3600_000, '/ghost'),
    row('old', server - 61_000),
  ])]);
  const { ctx, els, clock } = setupPresence(client, server - 3 * 86400_000);
  await ctx.refreshLive();
  assert.equal(els['stat-active-now'].textContent, '1');
  assert.match(els['live-list'].innerHTML, /valid/);
  assert.doesNotMatch(els['live-list'].innerHTML, /ghost|future|old/);
  assert.equal(els['live-list'].ageElements[0].textContent, '10s ago');
  advance(clock, 49_000);
  ctx.tickPresenceTimes();
  assert.equal(els['live-count'].textContent, '1');
  advance(clock, 1_000);
  ctx.tickPresenceTimes();
  assert.equal(els['live-count'].textContent, '0');
  assert.match(els['live-list'].innerHTML, /Nobody/);
});

test('heartbeat labels update without a list rebuild; profile changes do rebuild it', async () => {
  const server = Date.parse('2026-10-30T03:00:00Z');
  let profile = { id: 'one', display_name: 'First', is_premium: false };
  const client = snapshotClient([
    snapshot(server, [row('one', server - 25_000)]),
    snapshot(server + 10_000, [row('one', server + 8_000)]),
    snapshot(server + 11_000, [row('one', server + 10_000)]),
  ], () => [profile]);
  const { ctx, els, clock } = setupPresence(client, server);
  await ctx.refreshLive();
  assert.equal(els['live-list'].ageElements[0].textContent, '25s ago');
  const initialWrites = els['live-list'].writes;
  advance(clock, 10_000);
  await ctx.refreshLive();
  assert.equal(els['live-list'].writes, initialWrites);
  assert.equal(els['live-list'].ageElements[0].textContent, '2s ago');
  profile = { id: 'one', display_name: 'Renamed', is_premium: true };
  advance(clock, 1000);
  await ctx.refreshLive();
  assert.match(els['live-list'].innerHTML, /Renamed/);
  assert.match(els['live-list'].innerHTML, /Pro/);
  assert.ok(els['live-list'].writes > initialWrites);
});

test('monotonic time expires a user even when the admin clock moves backwards', async () => {
  const server = Date.parse('2026-10-30T03:00:00Z');
  const { ctx, els, clock } = setupPresence(snapshotClient([snapshot(server, [row('one', server - 20_000)])]), server);
  await ctx.refreshLive();
  clock.wall -= 86_400_000;
  clock.mono += 40_000;
  ctx.tickPresenceTimes();
  assert.equal(els['live-count'].textContent, '0');
});

test('slow responses do not resurrect already expired users', async () => {
  const server = Date.parse('2026-10-30T03:00:00Z');
  let resolveRpc;
  const client = snapshotClient([]);
  client.rpc = () => new Promise((resolve) => { resolveRpc = resolve; });
  const { ctx, els, clock } = setupPresence(client, server);
  const pending = ctx.refreshLive();
  advance(clock, 20_000);
  resolveRpc(snapshot(server, [row('one', server - 45_000)]));
  await pending;
  assert.equal(els['live-count'].textContent, '0');
});

test('query errors show unavailable rather than a false zero and can recover', async () => {
  const server = Date.parse('2026-10-30T03:00:00Z');
  const client = snapshotClient([
    { data: null, error: { code: '42501', message: 'permission denied for table user_presence' } },
    snapshot(server, [row('one', server - 1000)]),
  ]);
  const { ctx, els } = setupPresence(client, server);
  assert.equal(await ctx.refreshLive(), false);
  assert.equal(els['live-count'].textContent, '—');
  assert.match(els['live-list'].innerHTML, /unavailable/i);
  assert.doesNotMatch(els['live-list'].innerHTML, /migration/i);
  assert.equal(await ctx.refreshLive(), true);
  assert.equal(els['live-count'].textContent, '1');
});

test('missing RPC gives migration guidance rather than claiming nobody is online', async () => {
  const client = snapshotClient([{ data: null, error: { code: 'PGRST202', message: 'missing function' } }]);
  const { ctx, els } = setupPresence(client);
  await ctx.refreshLive();
  assert.equal(els['live-count'].textContent, '—');
  assert.match(els['live-list'].innerHTML, /migration/i);
  await ctx.refreshLive();
  assert.equal(client.calls.rpc, 1);
});

test('concurrent realtime refreshes are serialized with a trailing snapshot', async () => {
  const server = Date.parse('2026-10-30T03:00:00Z');
  let resolveFirst;
  const client = snapshotClient([]);
  let calls = 0;
  client.rpc = () => {
    calls++;
    return calls === 1 ? new Promise((resolve) => { resolveFirst = resolve; }) : Promise.resolve(snapshot(server));
  };
  const { ctx, els } = setupPresence(client, server);
  const first = ctx.refreshLive();
  const second = ctx.refreshLive();
  assert.equal(first, second);
  resolveFirst(snapshot(server, [row('one', server - 1000)]));
  await first;
  await flush();
  assert.equal(calls, 2);
  assert.equal(els['live-count'].textContent, '0');
});

test('live counts include more than the PostgREST row limit while profile lookups stay bounded', async () => {
  const server = Date.parse('2026-10-30T03:00:00Z');
  const rows = Array.from({ length: 1250 }, (_, i) => row(`user-${i}`, server - 1000));
  const client = snapshotClient([snapshot(server, rows)]);
  const { ctx, els } = setupPresence(client, server);
  await ctx.refreshLive();
  assert.equal(els['live-count'].textContent, '1250');
  assert.match(els['live-list'].innerHTML, /1225 more/);
  assert.equal(client.calls.profileBatches[0].length, 25);
});

function dailyClient() {
  const state = { submissions: [], marked: [], failSub: false, failMarked: false, failNames: false, ranges: [], batches: [] };
  return {
    state,
    from(table) {
      return { select(columns, options) {
        if (options && options.head) return Promise.resolve({ count: 2000, error: null });
        const builder = {
          gte() { return this; }, eq() { return this; }, order() { return this; },
          async range(a, b) {
            state.ranges.push([table, a, b]);
            if ((table === 'submissions' && state.failSub) || (table === 'profiles' && state.failMarked)) {
              return { data: null, error: new Error('denied') };
            }
            const rows = table === 'submissions' ? state.submissions : state.marked;
            return { data: rows.slice(a, b + 1), error: null };
          },
          async in(_field, ids) {
            state.batches.push([...ids]);
            if (state.failNames) return { data: null, error: new Error('profile lookup denied') };
            return { data: ids.map((id) => ({ id, display_name: `Name ${id}` })), error: null };
          },
        };
        return builder;
      } };
    },
  };
}

test('daily practice paginates, batches names, and can be refreshed after its first load', async () => {
  const server = Date.parse('2026-10-30T03:00:00Z');
  const client = dailyClient();
  client.state.submissions = Array.from({ length: 1100 }, (_, i) => ({
    id: `sub-${i}`, user_id: `user-${i}`, created_at: new Date(server - 1000).toISOString(),
  }));
  const { ctx, els } = setupPresence(client, server);
  const first = ctx.loadDailyPractice();
  assert.equal(ctx.loadDailyPractice(), first, 'overlapping daily requests share the same promise');
  assert.equal(await first, true);
  assert.equal(els['daily-count'].textContent, '1100');
  assert.ok(client.state.ranges.some(([table, start]) => table === 'submissions' && start === 1000));
  assert.ok(client.state.batches.length > 1);
  assert.ok(client.state.batches.every((batch) => batch.length <= 100));
  client.state.submissions = client.state.submissions.slice(0, 1);
  await ctx.loadDailyPractice();
  assert.equal(els['daily-count'].textContent, '1');
});

test('daily polling pauses in hidden tabs and refreshes when the admin returns', async () => {
  const server = Date.parse('2026-10-30T03:00:00Z');
  const client = dailyClient();
  client.rpc = async () => snapshot(server);
  const channel = { on() { return this; }, subscribe() { return this; } };
  client.channel = () => channel;
  const { ctx, els, document, intervals, listeners } = setupPresence(client, server);
  ctx.initLivePresence();
  await ctx.loadDailyPractice();
  assert.equal(els['daily-count'].textContent, '0');
  const dailyTimer = intervals.find((timer) => timer.delay === 60_000);
  assert.ok(dailyTimer);
  client.state.submissions = [{ id: 's', user_id: 'u', created_at: new Date(server).toISOString() }];
  document.hidden = true;
  document.visibilityState = 'hidden';
  dailyTimer.fn();
  await flush();
  assert.equal(els['daily-count'].textContent, '0');
  document.hidden = false;
  document.visibilityState = 'visible';
  listeners.visibilitychange();
  await flush();
  assert.equal(els['daily-count'].textContent, '1');
});

test('daily practice reports partial and unavailable sources without hiding known users', async () => {
  const server = Date.parse('2026-10-30T03:00:00Z');
  const client = dailyClient();
  client.state.submissions = [{ id: 's', user_id: 'u', created_at: new Date(server).toISOString() }];
  client.state.failMarked = true;
  client.state.failNames = true;
  const { ctx, els } = setupPresence(client, server);
  assert.equal(await ctx.loadDailyPractice(), false);
  assert.equal(els['daily-count'].textContent, '1+');
  assert.match(els['stat-daily-sub'].textContent, /partial/);
  assert.match(els['daily-list'].innerHTML, /User u/);
  assert.match(els['daily-list'].innerHTML, /names could not be loaded/i);
  client.state.failSub = true;
  assert.equal(await ctx.loadDailyPractice(), false);
  assert.equal(els['daily-count'].textContent, '—');
  assert.match(els['daily-list'].innerHTML, /unavailable/i);
});

function setupHeartbeat(getSession) {
  const clock = { wall: Date.parse('2026-10-30T03:00:00Z'), mono: 0 };
  const docEvents = {};
  const winEvents = {};
  const intervals = new Map();
  const writes = [];
  let authCallback;
  let nextTimer = 0;
  const client = {
    auth: {
      onAuthStateChange(fn) { authCallback = fn; },
      getSession: getSession || (() => Promise.resolve({ data: { session: { user: { id: 'user-a' } } } })),
    },
    from(table) {
      assert.equal(table, 'user_presence');
      return { upsert(data, options) { writes.push({ data, options }); return Promise.resolve({}); } };
    },
  };
  const document = {
    hidden: false, visibilityState: 'visible',
    addEventListener(name, fn) { docEvents[name] = fn; },
  };
  const window = { sb: client, addEventListener(name, fn) { winEvents[name] = fn; } };
  const ctx = vm.createContext({
    window, document, location: { pathname: '/teacher' }, Date: fakeDate(clock),
    setTimeout, clearTimeout,
    setInterval(fn, delay) { const id = ++nextTimer; intervals.set(id, { fn, delay }); return id; },
    clearInterval(id) { intervals.delete(id); },
  });
  vm.runInContext(heartbeatSource, ctx);
  return { clock, document, docEvents, winEvents, intervals, writes, auth: (event, session) => authCallback(event, session) };
}

test('learner heartbeat uses server timestamps, stops on hide/sign-out, and does not delete other tabs', async () => {
  const h = setupHeartbeat();
  await flush();
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].data.user_id, 'user-a');
  assert.equal(h.writes[0].data.page, '/teacher');
  assert.equal(Object.hasOwn(h.writes[0].data, 'last_seen_at'), false);
  h.document.visibilityState = 'hidden';
  h.document.hidden = true;
  advance(h.clock, 25_000);
  for (const timer of h.intervals.values()) timer.fn();
  assert.equal(h.writes.length, 1);
  h.document.visibilityState = 'visible';
  h.document.hidden = false;
  h.docEvents.visibilitychange();
  assert.equal(h.writes.length, 2);
  h.winEvents.pagehide();
  advance(h.clock, 25_000);
  for (const timer of h.intervals.values()) timer.fn();
  assert.equal(h.writes.length, 2);
  h.winEvents.pageshow();
  assert.equal(h.writes.length, 3);
  h.auth('SIGNED_OUT', null);
  assert.equal(h.intervals.size, 0);
  advance(h.clock, 25_000);
  h.winEvents.focus();
  assert.equal(h.writes.length, 3);
});

test('an old getSession result or deferred sign-in cannot restart after sign-out', async () => {
  let resolveSession;
  const h = setupHeartbeat(() => new Promise((resolve) => { resolveSession = resolve; }));
  h.auth('SIGNED_IN', { user: { id: 'old-user' } });
  h.auth('SIGNED_OUT', null);
  resolveSession({ data: { session: { user: { id: 'old-user' } } } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(h.writes.length, 0);
  assert.equal(h.intervals.size, 0);
});

test('base setup includes the same server-clock migration and limits RPC access', () => {
  const sql = fs.readFileSync('db/migrations/20261030_presence_server_clock.sql', 'utf8').trim();
  const setup = fs.readFileSync('supabase-admin-setup.sql', 'utf8');
  assert.ok(setup.includes(sql));
  assert.match(sql, /before insert or update on public\.user_presence/i);
  assert.match(sql, /new\.last_seen_at\s*:=\s*clock_timestamp\(\)/i);
  assert.match(sql, /p\.last_seen_at\s*<=\s*checked_at/i);
  assert.match(sql, /security invoker/i);
  assert.match(sql, /revoke all on function public\.admin_get_live_presence\(\) from public, anon/i);
  assert.match(sql, /if not coalesce\(public\.is_admin\(\), false\)/i);
});
