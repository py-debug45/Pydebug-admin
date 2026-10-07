-- PyDebug Admin v2 — service-role-only admin schema
-- Run in the SAME Supabase project as pydebug.in. Idempotent where possible.

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  role text not null check (role in
    ('superadmin','content_editor','support','finance','moderator','analyst')),
  totp_enabled boolean not null default false,
  totp_secret_encrypted text,
  created_by uuid,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);
alter table public.admin_users add column if not exists totp_secret_encrypted text;
alter table public.admin_users enable row level security;
revoke all on public.admin_users from anon, authenticated;

create table if not exists public.admin_audit_log (
  id bigint generated always as identity primary key,
  admin_id uuid not null,
  admin_role text not null,
  resource text not null,
  action text not null,
  target_id text,
  old_value jsonb,
  new_value jsonb,
  reason text,
  ip inet,
  created_at timestamptz not null default now()
);

-- Upgrade the legacy admin panel's audit table in place without losing history.
alter table public.admin_audit_log
  add column if not exists admin_role text,
  add column if not exists resource text,
  add column if not exists target_id text,
  add column if not exists old_value jsonb,
  add column if not exists new_value jsonb,
  add column if not exists reason text,
  add column if not exists ip inet;
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='admin_audit_log' and column_name='entity_type') then
    execute 'update public.admin_audit_log set resource = coalesce(resource, entity_type, ''legacy'') where resource is null';
  else
    update public.admin_audit_log set resource = 'legacy' where resource is null;
  end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='admin_audit_log' and column_name='entity_id') then
    execute 'update public.admin_audit_log set target_id = coalesce(target_id, entity_id) where target_id is null';
  end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='admin_audit_log' and column_name='metadata') then
    execute 'update public.admin_audit_log set new_value = coalesce(new_value, metadata) where new_value is null';
  end if;
end $$;
update public.admin_audit_log set admin_role = 'legacy' where admin_role is null;

-- The v2 audit actor is intentionally a snapshot UUID, not a foreign key:
-- deleting an Auth/profile row must never delete or rewrite its audit history.
do $$
declare constraint_name text;
begin
  for constraint_name in
    select conname from pg_constraint
    where conrelid = 'public.admin_audit_log'::regclass and contype = 'f'
  loop
    execute format('alter table public.admin_audit_log drop constraint %I', constraint_name);
  end loop;
end $$;
update public.admin_audit_log
set admin_id = '00000000-0000-0000-0000-000000000000'::uuid
where admin_id is null;
alter table public.admin_audit_log
  alter column admin_id set not null,
  alter column admin_role set not null,
  alter column resource set not null;

alter table public.admin_audit_log enable row level security;
revoke all on public.admin_audit_log from anon, authenticated;
revoke update, delete on public.admin_audit_log from service_role;
create index if not exists admin_audit_created_idx on public.admin_audit_log (created_at desc);
create index if not exists admin_audit_target_idx on public.admin_audit_log (target_id, created_at desc);
create index if not exists admin_audit_admin_idx on public.admin_audit_log (admin_id, created_at desc);

-- Atomic first-admin bootstrap. The API still checks ADMIN_ALLOWED_EMAILS;
-- this transaction guarantees concurrent first logins cannot both win and
-- writes the bootstrap audit row with the admin row.
drop function if exists public.bootstrap_first_admin(uuid, text);
create or replace function public.bootstrap_first_admin(p_user_id uuid, p_email text, p_ip inet)
returns setof public.admin_users
language plpgsql
security definer
set search_path = public
as $$
declare created public.admin_users%rowtype;
begin
  perform pg_advisory_xact_lock(hashtext('pydebug_admin_bootstrap'));
  if exists (select 1 from public.admin_users) then
    return;
  end if;
  insert into public.admin_users (user_id, email, role, created_by)
  values (p_user_id, lower(p_email), 'superadmin', p_user_id)
  returning * into created;
  insert into public.admin_audit_log
    (admin_id, admin_role, resource, action, target_id, old_value, new_value, ip)
  values
    (p_user_id, 'superadmin', 'auth', 'bootstrap_superadmin', p_user_id::text,
     null, jsonb_build_object('user_id', p_user_id, 'email', lower(p_email), 'role', 'superadmin'), p_ip);
  return next created;
end;
$$;
revoke all on function public.bootstrap_first_admin(uuid, text, inet) from public, anon, authenticated;
grant execute on function public.bootstrap_first_admin(uuid, text, inet) to service_role;

-- Audit rows are append-only, including for service-role requests.
create or replace function public.prevent_admin_audit_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'admin_audit_log is append-only';
end;
$$;
drop trigger if exists admin_audit_immutable on public.admin_audit_log;
create trigger admin_audit_immutable
before update or delete on public.admin_audit_log
for each row execute function public.prevent_admin_audit_mutation();

create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null,
  updated_by uuid,
  updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;
drop policy if exists "public read settings" on public.app_settings;
create policy "public read settings" on public.app_settings for select using (true);
revoke insert, update, delete on public.app_settings from anon, authenticated;

insert into public.app_settings (key, value) values
  ('maintenance_mode', 'false'::jsonb),
  ('battles_enabled', 'true'::jsonb),
  ('new_user_offer_enabled', 'true'::jsonb),
  ('signups_enabled', 'true'::jsonb)
on conflict (key) do nothing;

alter table public.profiles
  add column if not exists status text not null default 'active'
    check (status in ('active','warned','muted','suspended')),
  add column if not exists status_reason text,
  add column if not exists status_until timestamptz;

alter table public.problems
  add column if not exists status text not null default 'published'
    check (status in ('draft','published','archived')),
  add column if not exists updated_at timestamptz default now(),
  add column if not exists created_by uuid,
  add column if not exists admin_skip_notification boolean not null default false,
  add column if not exists battle_error text;

comment on column public.problems.battle_error is
  'Bug-hunt problems: the real Python exception class raised by the starter code (e.g. IndexError). Empty for output-prediction problems.';

comment on column public.problems.admin_skip_notification is
  'Admin editor opt-out flag. Existing new-problem notification trigger must return NEW without broadcasting when this is true.';

-- Fields used by the segmented broadcast composer (the table already exists
-- in the main product; these additions are harmless when columns are present).
alter table public.push_announcements
  add column if not exists title text,
  add column if not exists body text,
  add column if not exists url text,
  add column if not exists segment text default 'all',
  add column if not exists created_by uuid;

create table if not exists public.discussion_flags (
  id uuid primary key default gen_random_uuid(),
  discussion_id uuid not null,
  reporter_id uuid,
  reason text,
  resolved_by uuid,
  resolved_at timestamptz,
  resolution text check (resolution in ('dismissed','hidden','deleted','user_muted')),
  created_at timestamptz default now()
);
alter table public.discussion_flags enable row level security;
revoke all on public.discussion_flags from anon, authenticated;
create index if not exists discussion_flags_open_idx
  on public.discussion_flags (resolved_at, created_at desc);

-- Keeps problem updated_at accurate without relying on the browser.
create or replace function public.touch_problem_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
drop trigger if exists problems_touch_updated_at on public.problems;
create trigger problems_touch_updated_at before update on public.problems
for each row execute function public.touch_problem_updated_at();

-- Optional helper view for content-health screens. Service role bypasses RLS.
create or replace view public.admin_problem_stats as
select p.id,
       count(s.id) as attempt_count,
       count(s.id) filter (where s.status = 'solved') as solve_count,
       case when count(s.id) = 0 then 0
            else round(100.0 * count(s.id) filter (where s.status = 'solved') / count(s.id), 1)
       end as success_rate
from public.problems p
left join public.submissions s on s.problem_id = p.id
group by p.id;
revoke all on public.admin_problem_stats from anon, authenticated;

-- Lock down policies left by the retired browser-side admin panel. The v2
-- panel uses service_role on the server and never needs authenticated-admin
-- RLS bypass policies. User-owned policies with other names are untouched.
drop policy if exists "Admins can insert problems" on public.problems;
drop policy if exists "Admins can update problems" on public.problems;
drop policy if exists "Admins can delete problems" on public.problems;
drop policy if exists "Admins can read all profiles" on public.profiles;
drop policy if exists "Admins can update any profile" on public.profiles;
drop policy if exists "Admins can read all submissions" on public.submissions;
drop policy if exists "Admins can delete submissions" on public.submissions;
drop policy if exists "Admins can manage all notifications" on public.notifications;
drop policy if exists "Admins can read audit log" on public.admin_audit_log;
drop policy if exists "Admins can write audit log" on public.admin_audit_log;
do $$
declare item record;
begin
  for item in select * from (values
    ('payment_grants', 'Admins can read all payment grants'),
    ('payments', 'Admins can read all payments'),
    ('problem_discussions', 'Admins can read all discussions'),
    ('problem_discussions', 'Admins can delete discussions'),
    ('problem_discussions', 'Admins can insert discussions'),
    ('discussion_likes', 'Admins can read all discussion likes'),
    ('discussion_likes', 'Admins can delete discussion likes'),
    ('user_achievements', 'Admins can read all achievements'),
    ('hint_unlocks', 'Admins can read all hint unlocks'),
    ('ad_hint_log', 'Admins can read all ad hint log'),
    ('playground_files', 'Admins can read all playground files'),
    ('user_presence', 'Admins can read all presence'),
    ('user_presence', 'Admins can purge stale presence'),
    ('ai_settings', 'Admins can manage ai settings'),
    ('ai_logs', 'Admins can manage ai logs')
  ) as policies(table_name, policy_name)
  loop
    if to_regclass('public.' || item.table_name) is not null then
      execute format('drop policy if exists %I on public.%I', item.policy_name, item.table_name);
    end if;
  end loop;
end $$;

-- Keep a legacy is_admin column only when another part of the live product
-- still depends on its shape, but permanently force it false so it can no
-- longer grant browser-side admin access.
create or replace function public.disable_legacy_admin_flag()
returns trigger language plpgsql as $$
begin
  new.is_admin = false;
  return new;
end;
$$;
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='is_admin') then
    update public.profiles set is_admin = false where coalesce(is_admin, false) = true;
    execute 'drop trigger if exists profiles_disable_legacy_admin on public.profiles';
    execute 'create trigger profiles_disable_legacy_admin before insert or update of is_admin on public.profiles for each row execute function public.disable_legacy_admin_flag()';
  end if;
end $$;
drop function if exists public.verify_admin_panel_password(text);
drop table if exists public.admin_panel_security;

grant usage on schema public to service_role;
grant all on public.admin_users, public.app_settings, public.discussion_flags to service_role;
grant select, insert on public.admin_audit_log to service_role;
revoke update, delete on public.admin_audit_log from service_role;
do $$
declare sequence_name text;
begin
  sequence_name := pg_get_serial_sequence('public.admin_audit_log', 'id');
  if sequence_name is not null then
    execute format('grant usage, select on sequence %s to service_role', sequence_name);
  end if;
end $$;
grant select on public.admin_problem_stats to service_role;
