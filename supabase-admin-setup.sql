-- =============================================================
-- PyDebug Admin — Supabase setup (run ONCE in SQL Editor)
-- =============================================================
-- Assumes the user-panel tables (profiles, problems, submissions, etc.)
-- already exist from the user app's setup.
-- This script is idempotent — safe to re-run after upgrades.
--
-- It also backfills a few columns that the user app added to the live
-- database without a migration file (problem_number, submissions.code,
-- display_name, monthly_xp, ...), so fresh databases work too.
-- =============================================================

-- 0. Backfill columns the user app expects ----------------------
-- (all IF NOT EXISTS — no-ops on databases that already have them)

alter table profiles add column if not exists is_admin boolean default false;
alter table profiles add column if not exists display_name text;
alter table profiles add column if not exists monthly_xp integer default 0;
alter table profiles add column if not exists is_first_purchase boolean default true;
alter table profiles add column if not exists theme_preference text;
alter table profiles add column if not exists last_active_date date;
alter table profiles add column if not exists streak_freezes integer not null default 1;
alter table profiles add column if not exists last_streak_freeze_used_on date;
alter table profiles add column if not exists reminder_opt_in boolean not null default true;
alter table profiles add column if not exists premium_expires_at timestamptz;
alter table problems add column if not exists problem_number integer;
alter table problems add column if not exists is_premium boolean default false;
alter table problems add column if not exists hints jsonb default '[]'::jsonb;
-- Columns required by AI problem generation (js/ai-brain.js, js/ai-content.js)
-- and the manual problem form (js/admin-problem-form.js). Without them every
-- insert into problems fails with "column does not exist".
alter table problems add column if not exists starter_code text;
alter table problems add column if not exists expected_output text;
alter table problems add column if not exists solution_code text;
alter table problems add column if not exists status text;
alter table problems add column if not exists battle_error text;
alter table submissions add column if not exists code text;

-- Number any problems that don't have a problem_number yet, continuing
-- after the current max, oldest first. The user app's grid, Next/Previous
-- buttons and SEO listing all order by problem_number.
-- Snapshot the current max once so per-row re-evaluation can't collide.
with bounds as (
  select coalesce(max(problem_number), 0) as mx from problems
), numbered as (
  select id, row_number() over (order by created_at, id) as rn
  from problems
  where problem_number is null
)
update problems p
set problem_number = b.mx + n.rn
from numbered n, bounds b
where p.id = n.id;

-- NOTE: the user panel does NOT have a problems.solution_code column —
-- the admin panel no longer writes one. If your database has a leftover
-- solution_code column from an experiment, you may drop it:
--   alter table problems drop column if exists solution_code;

-- 1. Notifications table (used by the user app's bell + the admin
--    broadcast page). Created only if it doesn't exist yet.
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  type text default 'announcement',
  title text not null,
  message text not null,
  link text,
  is_read boolean default false,
  created_at timestamptz default now()
);
alter table public.notifications add column if not exists type text default 'announcement';
alter table public.notifications add column if not exists title text;
alter table public.notifications add column if not exists message text;
alter table public.notifications add column if not exists link text;
alter table public.notifications add column if not exists is_read boolean default false;

-- 2. Security-definer helper so RLS policies can check
--    "is this user an admin?" without recursively re-triggering RLS.
create or replace function public.is_admin()
returns boolean
language sql security definer
set search_path = public
as $$
  select coalesce((select is_admin from profiles where id = auth.uid()), false);
$$;

-- 3. Problems: admins can create/edit/delete
--    (everyone can still just read them via the user app's policies)
drop policy if exists "Admins can insert problems" on problems;
create policy "Admins can insert problems" on problems for insert with check (is_admin());

drop policy if exists "Admins can update problems" on problems;
create policy "Admins can update problems" on problems for update using (is_admin());

drop policy if exists "Admins can delete problems" on problems;
create policy "Admins can delete problems" on problems for delete using (is_admin());

-- 4. Profiles: admins can read everyone (Users page, stats, lookups)
--    and update anyone (grant/revoke premium, XP, admin role)
drop policy if exists "Admins can read all profiles" on profiles;
create policy "Admins can read all profiles" on profiles for select using (is_admin());

drop policy if exists "Admins can update any profile" on profiles;
create policy "Admins can update any profile" on profiles for update using (is_admin());

-- 5a. payment_grants: the REAL payment ledger in the user app
--      (api/verify-payment.js writes here; `payments` is legacy/unused).
--      Create it if the user-panel migration was never run — definition
--      matches db/migrations/20260907_payment_grants.sql exactly.
create table if not exists public.payment_grants (
  payment_id text primary key,
  order_id text not null,
  user_id uuid not null references public.profiles (id) on delete cascade,
  plan_key text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  -- What Razorpay actually charged (coupon / old price already applied).
  -- Populated by fulfil_payment_order() + the capture trigger added in
  -- db/migrations/20261024_payment_actual_amounts.sql.
  amount_paise bigint,
  product_key text,
  coupon_code text,
  discount_percent integer
);
-- Existing installs created before the columns above existed.
alter table public.payment_grants add column if not exists amount_paise bigint;
alter table public.payment_grants add column if not exists product_key text;
alter table public.payment_grants add column if not exists coupon_code text;
alter table public.payment_grants add column if not exists discount_percent integer;
create index if not exists payment_grants_user_idx
  on public.payment_grants (user_id);
create index if not exists payment_grants_order_idx
  on public.payment_grants (order_id);

--      The user app's migration left this table without RLS, i.e.
--      world-readable — enabling RLS + an admin-read policy fixes that.
--      verify-payment uses the service-role key, which bypasses RLS,
--      so grants keep working.
alter table public.payment_grants enable row level security;
drop policy if exists "Admins can read all payment grants" on payment_grants;
create policy "Admins can read all payment grants" on payment_grants for select using (is_admin());

-- 5b. Legacy payments table: keep the old policy so nothing breaks
--      if you ever backfill it. Skip entirely when the table was never
--      created — otherwise this statement aborts the rest of the script
--      (submissions / discussions / notifications policies never apply).
do $$
begin
  if to_regclass('public.payments') is not null then
    execute 'drop policy if exists "Admins can read all payments" on public.payments';
    execute 'create policy "Admins can read all payments" on public.payments for select using (is_admin())';
  end if;
end $$;

-- 6. Submissions: admins can read all (Submissions page, dashboard
--    analytics, user detail) and delete spam/bad rows
drop policy if exists "Admins can read all submissions" on submissions;
create policy "Admins can read all submissions" on submissions for select using (is_admin());

drop policy if exists "Admins can delete submissions" on submissions;
create policy "Admins can delete submissions" on submissions for delete using (is_admin());

-- 7. Discussions moderation (problem_discussions + discussion_likes).
--    Guarded: a missing table must not abort later policies.
do $$
begin
  if to_regclass('public.problem_discussions') is not null then
    execute 'drop policy if exists "Admins can read all discussions" on public.problem_discussions';
    execute 'create policy "Admins can read all discussions" on public.problem_discussions for select using (is_admin())';
    execute 'drop policy if exists "Admins can delete discussions" on public.problem_discussions';
    execute 'create policy "Admins can delete discussions" on public.problem_discussions for delete using (is_admin())';
    execute 'drop policy if exists "Admins can insert discussions" on public.problem_discussions';
    execute 'create policy "Admins can insert discussions" on public.problem_discussions for insert with check (is_admin())';
  end if;
  if to_regclass('public.discussion_likes') is not null then
    execute 'drop policy if exists "Admins can read all discussion likes" on public.discussion_likes';
    execute 'create policy "Admins can read all discussion likes" on public.discussion_likes for select using (is_admin())';
    execute 'drop policy if exists "Admins can delete discussion likes" on public.discussion_likes';
    execute 'create policy "Admins can delete discussion likes" on public.discussion_likes for delete using (is_admin())';
  end if;
end $$;

-- 8. Achievements: admins can read badges (shown on the user-detail page).
--    Unlocks stay server-side only — no admin insert/update/delete.
do $$
begin
  if to_regclass('public.user_achievements') is not null then
    execute 'drop policy if exists "Admins can read all achievements" on public.user_achievements';
    execute 'create policy "Admins can read all achievements" on public.user_achievements for select using (is_admin())';
  end if;
end $$;

-- 9. Notifications: users read/update their own (the bell), admins manage all.
alter table public.notifications enable row level security;

drop policy if exists "Users can read own notifications" on notifications;
create policy "Users can read own notifications" on notifications for select using (auth.uid() = user_id);

drop policy if exists "Users can mark own notifications read" on notifications;
create policy "Users can mark own notifications read" on notifications for update using (auth.uid() = user_id);

drop policy if exists "Admins can manage all notifications" on notifications;
create policy "Admins can manage all notifications" on notifications for all using (is_admin());

-- 10. Support lookups: hint unlocks, ad-hint usage, playground files.
--      Read-only for admins (used for support/debugging later).
do $$
begin
  if to_regclass('public.hint_unlocks') is not null then
    execute 'drop policy if exists "Admins can read all hint unlocks" on public.hint_unlocks';
    execute 'create policy "Admins can read all hint unlocks" on public.hint_unlocks for select using (is_admin())';
  end if;
  if to_regclass('public.ad_hint_log') is not null then
    execute 'drop policy if exists "Admins can read all ad hint log" on public.ad_hint_log';
    execute 'create policy "Admins can read all ad hint log" on public.ad_hint_log for select using (is_admin())';
  end if;
  if to_regclass('public.playground_files') is not null then
    execute 'drop policy if exists "Admins can read all playground files" on public.playground_files';
    execute 'create policy "Admins can read all playground files" on public.playground_files for select using (is_admin())';
  end if;
end $$;

-- NOTE: if you already added the `prevent_self_premium_grant` trigger from
-- the user app's setup (blocking users from self-granting premium), it works
-- fine alongside these policies — that trigger explicitly allows changes
-- when is_admin() is true, so admin-panel premium grants/revokes keep working.

-- 11. Own-AI control tables (idempotent) ------------------------
-- ai_settings: single-row ("control") JSON with the master switch +
-- module toggles, so ON/OFF state follows the admin on every device.
-- (The panel also keeps a localStorage copy and works fully offline from
-- these tables — they are only a cloud sync layer.)
create table if not exists public.ai_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.ai_settings enable row level security;
drop policy if exists "Admins can manage ai settings" on ai_settings;
create policy "Admins can manage ai settings" on ai_settings for all using (is_admin());

-- ai_logs: cloud copy of the AI activity log (best-effort inserts from
-- the panel; the full log always lives in the browser too).
create table if not exists public.ai_logs (
  id uuid primary key default gen_random_uuid(),
  level text not null default 'info',
  action text not null,
  detail text,
  created_at timestamptz not null default now()
);
alter table public.ai_logs enable row level security;
drop policy if exists "Admins can manage ai logs" on ai_logs;
create policy "Admins can manage ai logs" on ai_logs for all using (is_admin());

-- 12. DB-backed panel password -----------------------------------
-- The browser never receives this value or the hash. The client invokes a
-- SECURITY DEFINER verifier only after Supabase has authenticated an admin.
-- Default passcode: imtiyaj khan 9329
create extension if not exists pgcrypto with schema extensions;
set search_path = public, extensions;

create table if not exists public.admin_panel_security (
  id integer primary key check (id = 1),
  password_hash text not null,
  updated_at timestamptz not null default now()
);
alter table public.admin_panel_security enable row level security;

insert into public.admin_panel_security (id, password_hash)
values (1, crypt('imtiyaj khan 9329', gen_salt('bf')))
on conflict (id) do nothing;

create or replace function public.verify_admin_panel_password(input_password text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if auth.uid() is null then
    return false;
  end if;

  if not exists (
    select 1 from public.profiles
    where id = auth.uid() and coalesce(is_admin, false) = true
  ) then
    return false;
  end if;

  return exists (
    select 1
    from public.admin_panel_security
    where id = 1
      and password_hash = crypt(coalesce(input_password, ''), password_hash)
  );
end;
$$;

revoke all on function public.verify_admin_panel_password(text) from public;
grant execute on function public.verify_admin_panel_password(text) to authenticated;
revoke all on table public.admin_panel_security from anon, authenticated;

-- To rotate the passcode later, replace the text below and run only this
-- statement in the SQL editor:
-- update public.admin_panel_security
-- set password_hash = crypt('your new passcode', gen_salt('bf')), updated_at = now()
-- where id = 1;

-- 13. Live activity: who is on the site RIGHT NOW + who practiced today ----
-- user_presence: one ephemeral row per user, refreshed by the learner app.
-- The trigger and admin snapshot below use the server clock; a stopped
-- heartbeat expires from the dashboard after approximately 60 seconds.
create table if not exists public.user_presence (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  last_seen_at timestamptz not null default now(),
  page text
);
create index if not exists user_presence_last_seen_idx
  on public.user_presence (last_seen_at);
alter table public.user_presence enable row level security;

-- Users may only ever touch their OWN row (upsert heartbeat + self delete).
drop policy if exists "Users can heartbeat own presence" on user_presence;
create policy "Users can heartbeat own presence" on user_presence
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Admins read every row (the "Live right now" list on the dashboard)...
drop policy if exists "Admins can read all presence" on user_presence;
create policy "Admins can read all presence" on user_presence
  for select using (is_admin());

-- Optional permission to purge rows older than 24h for storage hygiene.
-- The dashboard itself does not delete rows based on a device clock. Other
-- admin policies may grant broader delete access on existing installations.
drop policy if exists "Admins can purge stale presence" on user_presence;
create policy "Admins can purge stale presence" on user_presence
  for delete using (is_admin() and last_seen_at < now() - interval '24 hours');

-- Server-clock presence (also available as a standalone migration).
-- Keep live presence independent of both the learner's and the admin's
-- device clocks. Safe to re-run on an existing installation.
--
-- The table intentionally has one short-lived row per user. The learner's
-- heartbeat may still send last_seen_at, but the database is authoritative.
create or replace function public.set_user_presence_server_timestamp()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  new.last_seen_at := clock_timestamp();
  return new;
end;
$$;

revoke all on function public.set_user_presence_server_timestamp() from public, anon, authenticated;

drop trigger if exists user_presence_server_timestamp on public.user_presence;
create trigger user_presence_server_timestamp
  before insert or update on public.user_presence
  for each row execute function public.set_user_presence_server_timestamp();

-- An old client may already have written a date hours or days in the future.
-- Such rows cannot establish that a user is currently online. They are only
-- ephemeral presence rows: an actually active user will heartbeat again.
delete from public.user_presence
where last_seen_at > clock_timestamp() + interval '10 seconds';

-- Return a server-timed snapshot, including a timestamp even when it is empty.
-- SECURITY INVOKER keeps table RLS in force. The explicit admin check and
-- execute grants prevent normal users from using the dashboard endpoint.
create or replace function public.admin_get_live_presence()
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog
as $$
declare
  checked_at timestamptz := clock_timestamp();
  snapshot jsonb;
begin
  if not coalesce(public.is_admin(), false) then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'checked_at', checked_at,
    'rows', coalesce(
      jsonb_agg(
        jsonb_build_object(
          'user_id', p.user_id,
          'last_seen_at', p.last_seen_at,
          'page', p.page
        ) order by p.last_seen_at desc, p.user_id
      ),
      '[]'::jsonb
    )
  ) into snapshot
  from public.user_presence as p
  where p.last_seen_at > checked_at - interval '60 seconds'
    and p.last_seen_at <= checked_at;

  return snapshot;
end;
$$;

revoke all on function public.admin_get_live_presence() from public, anon;
grant execute on function public.admin_get_live_presence() to authenticated;

-- Refresh PostgREST's RPC cache without waiting for its automatic reload.
notify pgrst, 'reload schema';

-- 12. Admin audit log: records sensitive changes made from this panel.
create table if not exists public.admin_audit_log (
  id bigint generated by default as identity primary key,
  admin_id uuid references public.profiles(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text,
  target_id text,
  resource text,
  old_value jsonb not null default '{}'::jsonb,
  new_value jsonb not null default '{}'::jsonb,
  reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
-- Backfill columns on older installs where the table was created before the
-- writeAudit / writeAdminAudit / admin_record_grant_amount fields existed.
alter table public.admin_audit_log add column if not exists target_id text;
alter table public.admin_audit_log add column if not exists resource text;
alter table public.admin_audit_log add column if not exists old_value jsonb not null default '{}'::jsonb;
alter table public.admin_audit_log add column if not exists new_value jsonb not null default '{}'::jsonb;
alter table public.admin_audit_log add column if not exists reason text;
alter table public.admin_audit_log add column if not exists admin_role text;
create index if not exists admin_audit_log_created_idx on public.admin_audit_log(created_at desc);
alter table public.admin_audit_log enable row level security;
drop policy if exists "Admins can read audit log" on admin_audit_log;
create policy "Admins can read audit log" on admin_audit_log for select using (is_admin());
drop policy if exists "Admins can write audit log" on admin_audit_log;
create policy "Admins can write audit log" on admin_audit_log for insert with check (is_admin() and admin_id = auth.uid());

-- Publish row changes so the admin dashboard updates INSTANTLY via
-- Supabase Realtime (postgres_changes) instead of waiting for a poll.
do $$
begin
  if to_regclass('public.user_presence') is not null
     and exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'user_presence'
     )
  then
    execute 'alter publication supabase_realtime add table public.user_presence';
  end if;
end $$;

-- =============================================================
-- 14. Full 2026 Feature & RPC Upgrade
-- Run these three migrations in order after this base script:
--   1. db/migrations/20261021_admin_compatibility.sql
--   2. db/migrations/20261023_complete_admin_features.sql
--   3. db/migrations/20261023_fix_admin_table_grants.sql
-- They add Write-Code problem columns, URL slugs, trigger deduplication,
-- Certificates / Mock Tests / Battles / Study Plans / Community /
-- Classrooms / Institute Enquiries / Feedback / Web Push grants + RLS policies,
-- and the 6 SECURITY DEFINER admin RPCs.
-- =============================================================
