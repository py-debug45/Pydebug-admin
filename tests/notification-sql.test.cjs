// PostgreSQL integration tests for the shared notification migration.
// Optional local test dependency (not needed by the deployed static site):
// npm install --no-save --no-package-lock --ignore-scripts @electric-sql/pglite@0.3.14
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch (_) {}
const migration = fs.readFileSync('db/migrations/20261028_admin_notification_safety.sql', 'utf8');

const ADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REQUEST = '11111111-1111-4111-8111-111111111111';

const fixtures = `
  create role anon; create role authenticated;
  create schema auth; create schema net;
  create function auth.uid() returns uuid language sql as $$
    select nullif(current_setting('test.uid', true), '')::uuid
  $$;
  create function public.is_admin() returns boolean language sql as $$
    select coalesce(current_setting('test.admin', true) = 'true', false)
  $$;
  create table public.profiles (
    id uuid primary key, is_premium boolean, premium_expires_at timestamptz
  );
  create table public.push_subscriptions (user_id uuid not null);
  create table public.notifications (
    id uuid primary key default gen_random_uuid(), user_id uuid not null,
    type text, title text, message text, link text, is_read boolean default false,
    created_at timestamptz default now(), metadata jsonb
  );
  create table public.push_announcements (
    id uuid primary key default gen_random_uuid(), title text, body text,
    url text, segment text default 'all'
  );
  create table net.requests (url text, headers jsonb, body jsonb, timeout integer);
  create function net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds integer)
  returns bigint language plpgsql as $$
  begin
    if current_setting('test.net_failure', true) = 'true' then
      raise exception 'simulated queue failure';
    end if;
    insert into net.requests values (url, headers, body, timeout_milliseconds);
    return 1;
  end $$;
  select set_config('test.uid', '${ADMIN}', false);
  select set_config('test.admin', 'true', false);
`;

async function setup() {
  const db = new PGlite();
  await db.exec(fixtures);
  await db.exec(migration);
  return db;
}
async function rpc(db, request, options = {}) {
  const values = [request, options.title ?? 'Hello', options.message ?? 'Update',
    options.link === undefined ? '/problems' : options.link,
    options.type ?? 'announcement', options.audience ?? 'all', options.push ?? false];
  return (await db.query('select public.admin_send_broadcast($1,$2,$3,$4,$5,$6,$7) as result', values)).rows[0].result;
}
async function seedSegment(db) {
  await db.exec(`
    insert into profiles values
      ('00000000-0000-4000-8000-000000000001', true, null),
      ('00000000-0000-4000-8000-000000000002', true, now() + interval '1 day'),
      ('00000000-0000-4000-8000-000000000003', true, now() - interval '1 day'),
      ('00000000-0000-4000-8000-000000000004', false, null);
    insert into push_subscriptions select id from profiles;
  `);
}

test('notification database migration behaves correctly on PostgreSQL', {
  skip: !PGlite && 'Install the optional PGlite test dependency (see test header)',
}, async (t) => {
  const db = await setup();
  t.after(() => db.close());
  async function reset() {
    await db.exec(`truncate public.notifications, public.push_subscriptions, public.push_announcements,
      public.profiles, public.admin_broadcast_requests, net.requests;
      select set_config('test.uid', '${ADMIN}', false);
      select set_config('test.admin', 'true', false);
      select set_config('test.net_failure', 'false', false);
      select set_config('app.settings.push_instant', 'on', false);`);
  }

  await t.test('audiences honor active and expired premium; push is targeted', async () => {
    await reset(); await seedSegment(db);
    const result = await rpc(db, REQUEST, { audience: 'premium', push: true });
    assert.equal(result.recipients, 2);
    assert.equal(result.web_push_enabled, true);
    assert.deepEqual((await db.query('select user_id from notifications order by user_id')).rows.map(x => x.user_id), [
      '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002',
    ]);
    const requests = (await db.query('select body from net.requests')).rows;
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.notification_ids.length, 2);
    assert.equal(requests[0].body.broadcast, undefined);

    await reset(); await seedSegment(db);
    assert.equal((await rpc(db, REQUEST, { audience: 'free', push: false })).recipients, 2);
    assert.deepEqual((await db.query('select user_id from notifications order by user_id')).rows.map(x => x.user_id), [
      '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000004',
    ]);
    assert.equal((await db.query('select count(*)::int as n from net.requests')).rows[0].n, 0);
  });

  await t.test('push may be enabled even when no matching learner has a subscription', async () => {
    await reset();
    await db.query('insert into profiles (id, is_premium) values ($1, false)', ['00000000-0000-4000-8000-000000000001']);
    const result = await rpc(db, '11111111-1111-4111-8111-111111111118', { audience: 'all', push: true });
    assert.equal(result.recipients, 1);
    assert.equal(result.web_push_enabled, true);
    assert.equal((await db.query('select count(*)::int as n from net.requests')).rows[0].n, 0);
  });

  await t.test('same request is idempotent, changed payload and non-admin access are rejected', async () => {
    await reset(); await seedSegment(db);
    const first = await rpc(db, REQUEST, { push: true });
    const retry = await rpc(db, REQUEST, { push: true });
    assert.equal(first.already_processed, false);
    assert.equal(retry.already_processed, true);
    assert.equal(retry.recipients, 4);
    assert.equal((await db.query('select count(*)::int as n from notifications')).rows[0].n, 4);
    assert.equal((await db.query('select count(*)::int as n from net.requests')).rows[0].n, 1);
    await assert.rejects(rpc(db, REQUEST, { title: 'Changed', push: true }), /different broadcast/);
    await db.exec(`select set_config('test.uid', '${OTHER}', false)`);
    await assert.rejects(rpc(db, REQUEST, { push: true }), /different broadcast/);
    await db.exec("select set_config('test.admin', 'false', false)");
    await assert.rejects(rpc(db, '22222222-2222-4222-8222-222222222222'), /Admin access required/);
    const grants = (await db.query(`select has_function_privilege('anon',
      'public.admin_send_broadcast(uuid,text,text,text,text,text,boolean)', 'execute') as anon,
      has_table_privilege('authenticated', 'public.admin_broadcast_requests', 'select') as ledger`)).rows[0];
    assert.equal(grants.anon, false);
    assert.equal(grants.ledger, false);
  });

  await t.test('push failure rolls back every bell row and the idempotency ledger', async () => {
    await reset(); await seedSegment(db);
    await db.exec("select set_config('test.net_failure', 'true', false)");
    await assert.rejects(rpc(db, REQUEST, { push: true }), /Web Push request failed/);
    assert.equal((await db.query('select count(*)::int as n from notifications')).rows[0].n, 0);
    assert.equal((await db.query('select count(*)::int as n from admin_broadcast_requests')).rows[0].n, 0);
    assert.equal((await db.query('select count(*)::int as n from net.requests')).rows[0].n, 0);
    await db.exec("select set_config('test.net_failure', 'false', false); select set_config('app.settings.push_instant', 'off', false)");
    await assert.rejects(rpc(db, REQUEST, { push: true }), /unavailable/);
    assert.equal((await rpc(db, REQUEST, { push: false })).recipients, 4);
  });

  await t.test('unsafe links are rejected at the database boundary', async () => {
    await reset(); await seedSegment(db);
    for (const link of ['//evil.test/path', '/\\evil.test', '/%2Fevil.test', '/%5cevil.test', '/x%0Aheader']) {
      await assert.rejects(rpc(db, REQUEST, { link }), /safe in-app path/, link);
    }
    assert.equal((await db.query('select count(*)::int as n from notifications')).rows[0].n, 0);
    assert.equal((await rpc(db, REQUEST, { link: '/problem?id=3#answer' })).recipients, 4);
  });

  await t.test('all subscribed devices are included in <=250-ID batches', async () => {
    await reset();
    await db.exec(`insert into profiles select gen_random_uuid(), false, null from generate_series(1, 501);
      insert into push_subscriptions select id from profiles;`);
    const result = await rpc(db, REQUEST, { type: 'new_problem', push: true });
    assert.equal(result.recipients, 501);
    const requests = (await db.query('select body from net.requests')).rows.map(x => x.body);
    assert.deepEqual(requests.map(x => x.notification_ids ? x.notification_ids.length : 1), [250, 250, 1]);
    const ids = requests.flatMap(x => x.notification_ids || [x.notification_id]);
    assert.equal(new Set(ids).size, 501);
    assert.equal((await db.query('select count(*)::int as n from notifications')).rows[0].n, 501);
  });

  await t.test('legacy targeted announcements cannot populate another audience or trigger global fanout', async () => {
    await reset(); await seedSegment(db);
    await db.exec(`insert into push_announcements (title, body, url, segment)
      values ('Members only', 'For premium', '//evil.test', 'premium')`);
    const rows = (await db.query('select user_id, link from notifications order by user_id')).rows;
    assert.equal(rows.length, 2);
    assert.ok(rows.every(row => row.link === '/dashboard'));
    assert.ok(rows.every(row => ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'].includes(row.user_id)));
    const requests = (await db.query('select body from net.requests')).rows;
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.notification_ids.length, 2);
    assert.equal(requests[0].body.broadcast, undefined);
    await assert.rejects(db.exec("insert into push_announcements (title, body, segment) values ('bad','bad','other')"), /Invalid push announcement audience/);

    await reset(); await seedSegment(db);
    await db.exec("select set_config('test.net_failure', 'true', false)");
    await assert.rejects(db.exec("insert into push_announcements (title, body, segment) values ('fail','fail','free')"), /Targeted announcement failed/);
    assert.equal((await db.query('select count(*)::int as n from notifications')).rows[0].n, 0);
    assert.equal((await db.query('select count(*)::int as n from push_announcements')).rows[0].n, 0);
  });

  await t.test('ordinary app notifications retain their previous filtering', async () => {
    await reset(); await seedSegment(db);
    const uid = '00000000-0000-4000-8000-000000000001';
    await db.query(`insert into notifications (user_id, type, title, message, metadata) values
      ($1, 'new_problem', 'New', 'One', '{}'),
      ($1, 'leaderboard_rank', 'Rank', 'Two', '{}'),
      ($1, 'streak_warning', 'Streak', 'Three', '{}'),
      ($1, 'announcement', 'Feed', 'Four', '{"from_push_announcements":true}'),
      ($1, 'reply', 'Reply', 'Five', '{}'),
      ($1, 'streak_warning', 'Milestone', 'Six', '{"milestone":true}')`, [uid]);
    const requests = (await db.query('select body from net.requests')).rows;
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.notification_ids.length, 2);
    assert.equal((await db.query('select count(*)::int as n from notifications')).rows[0].n, 6);
  });
});
