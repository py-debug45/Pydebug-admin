-- =============================================================================
-- 20261106_admin_platform_core.sql
-- PyDebug Admin — platform core upgrade (idempotent, safe to re-run)
--
-- Adds the missing "professional panel" foundations WITHOUT widening learner
-- access and without breaking any existing admin flow:
--
--   1. Team accounts + role based permissions  (admin_members, has_perm)
--   2. Runtime settings                        (app_settings)
--   3. Feature flags / kill switches           (server_flags)
--   4. Soft delete + restore (Trash)           (deletion_archive)
--   5. Admin sessions (revoke / force logout)  (admin_sessions)
--   6. Audit hardening                         (ip, user_agent, session_id, append-only)
--
-- Security model
-- --------------
-- `public.is_admin()` remains the single RLS gate used by every existing
-- policy. It now returns true for legacy `profiles.is_admin = true` accounts
-- (unchanged behaviour) AND for rows in `admin_members`, so a support agent can
-- read the tables their role needs. Least privilege is enforced where it
-- matters most: every new mutating RPC below calls `has_perm(...)`, and the
-- panel hides UI the role cannot use. A follow-up migration can move the same
-- checks into per-table policies; this file deliberately does not rewrite the
-- existing policy set so re-running it can never lock an admin out.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. TEAM + ROLE BASED PERMISSIONS
-- -----------------------------------------------------------------------------

create table if not exists public.admin_members (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  role text not null default 'support'
    check (role in ('owner', 'admin', 'moderator', 'support', 'finance', 'content')),
  added_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);

create table if not exists public.admin_role_permissions (
  role text not null,
  permission text not null,
  primary key (role, permission)
);

-- Permission catalogue. `*` means "everything" (owner only).
insert into public.admin_role_permissions (role, permission) values
  ('owner', '*'),

  ('admin', 'dashboard.read'), ('admin', 'users.read'), ('admin', 'users.write'),
  ('admin', 'users.delete'), ('admin', 'payments.read'), ('admin', 'payments.write'),
  ('admin', 'payments.refund'), ('admin', 'coupons.read'), ('admin', 'coupons.write'),
  ('admin', 'submissions.read'), ('admin', 'submissions.write'),
  ('admin', 'problems.read'), ('admin', 'problems.write'), ('admin', 'problems.delete'),
  ('admin', 'community.read'), ('admin', 'community.write'),
  ('admin', 'certificates.read'), ('admin', 'certificates.write'),
  ('admin', 'notifications.read'), ('admin', 'notifications.write'),
  ('admin', 'ai.read'), ('admin', 'ai.write'), ('admin', 'audit.read'),
  ('admin', 'settings.read'), ('admin', 'settings.write'),
  ('admin', 'team.read'), ('admin', 'team.write'),
  ('admin', 'trash.read'), ('admin', 'trash.write'),

  ('moderator', 'dashboard.read'), ('moderator', 'users.read'), ('moderator', 'users.write'),
  ('moderator', 'submissions.read'), ('moderator', 'submissions.write'),
  ('moderator', 'problems.read'), ('moderator', 'community.read'),
  ('moderator', 'community.write'), ('moderator', 'certificates.read'),
  ('moderator', 'audit.read'), ('moderator', 'notifications.read'),
  ('moderator', 'trash.read'), ('moderator', 'trash.write'),

  ('support', 'dashboard.read'), ('support', 'users.read'), ('support', 'payments.read'),
  ('support', 'submissions.read'), ('support', 'community.read'),
  ('support', 'certificates.read'), ('support', 'audit.read'),
  ('support', 'notifications.read'), ('support', 'trash.read'),

  ('finance', 'dashboard.read'), ('finance', 'users.read'), ('finance', 'payments.read'),
  ('finance', 'payments.write'), ('finance', 'payments.refund'),
  ('finance', 'coupons.read'), ('finance', 'coupons.write'),
  ('finance', 'audit.read'), ('finance', 'trash.read'),

  ('content', 'dashboard.read'), ('content', 'problems.read'), ('content', 'problems.write'),
  ('content', 'problems.delete'), ('content', 'submissions.read'),
  ('content', 'certificates.read'), ('content', 'certificates.write'),
  ('content', 'community.read'), ('content', 'ai.read'), ('content', 'ai.write'),
  ('content', 'trash.read'), ('content', 'trash.write')
on conflict (role, permission) do nothing;

alter table public.admin_members enable row level security;
alter table public.admin_role_permissions enable row level security;

drop policy if exists "Admins read team" on public.admin_members;
create policy "Admins read team" on public.admin_members
  for select using ((select public.is_admin()));

drop policy if exists "Admins read role permissions" on public.admin_role_permissions;
create policy "Admins read role permissions" on public.admin_role_permissions
  for select using ((select public.is_admin()));

-- Seed existing operators so nobody loses access when this runs.
-- 1) The older `admin_users` roster (superadmin / content_editor / analyst ...)
--    is mapped onto the new role names. This runs first so a content editor is
--    not accidentally seeded as an owner by the profiles pass below.
do $$
begin
  if to_regclass('public.admin_users') is not null then
    execute $seed$
      insert into public.admin_members (user_id, role, added_by)
      select a.user_id,
             case a.role
               when 'superadmin' then 'owner'
               when 'content_editor' then 'content'
               when 'analyst' then 'support'
               when 'moderator' then 'moderator'
               when 'support' then 'support'
               when 'finance' then 'finance'
               else 'support'
             end,
             null
      from public.admin_users a
      where exists (select 1 from public.profiles p where p.id = a.user_id)
      on conflict (user_id) do nothing
    $seed$;
  end if;
end $$;

-- 2) Legacy profiles.is_admin = true accounts become owners.
insert into public.admin_members (user_id, role, added_by)
select p.id, 'owner', null
from public.profiles p
where coalesce(p.is_admin, false) = true
on conflict (user_id) do nothing;

-- Resolve a member's role: explicit membership first, then legacy flag.
create or replace function public.admin_member_role(target uuid default auth.uid())
returns text
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select m.role from public.admin_members m where m.user_id = target),
    case
      when exists (
        select 1 from public.profiles p
        where p.id = target and coalesce(p.is_admin, false) = true
      ) then 'owner'
      else null
    end
  );
$$;

create or replace function public.admin_permissions(target uuid default auth.uid())
returns text[]
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    array(
      select rp.permission
      from public.admin_role_permissions rp
      where rp.role = public.admin_member_role(target)
      order by rp.permission
    ),
    array[]::text[]
  );
$$;

create or replace function public.has_perm(perm text, target uuid default auth.uid())
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.admin_role_permissions rp
    where rp.role = public.admin_member_role(target)
      and (rp.permission = perm or rp.permission = '*')
  );
$$;

-- Keep the single RLS gate backwards compatible:
--   legacy profiles.is_admin = true  -> still admin
--   member of admin_members          -> admin
create or replace function public.is_admin()
returns boolean
language sql security definer
set search_path = public, pg_temp
as $$
  select
    coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false)
    or exists (select 1 from public.admin_members m where m.user_id = auth.uid()
               and m.role in ('owner', 'admin', 'moderator', 'support', 'finance', 'content'));
$$;

create or replace function public.admin_identity()
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_perms text[];
begin
  if v_uid is null then
    return jsonb_build_object('role', null, 'perms', '[]'::jsonb, 'signed_in', false);
  end if;

  v_role := public.admin_member_role(v_uid);
  v_perms := public.admin_permissions(v_uid);

  return jsonb_build_object(
    'user_id', v_uid,
    'role', v_role,
    'perms', to_jsonb(v_perms),
    'legacy', coalesce((select p.is_admin from public.profiles p where p.id = v_uid), false),
    'signed_in', true
  );
end;
$$;

-- Team management -----------------------------------------------------------------
create or replace function public.admin_list_members()
returns table (
  user_id uuid, email text, display_name text, role text,
  created_at timestamptz, last_seen_at timestamptz, is_legacy boolean
)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  if not public.has_perm('team.read') then
    raise exception 'Permission denied: team.read' using errcode = '42501';
  end if;

  return query
  select p.id,
         p.email,
         coalesce(p.display_name, p.full_name, p.email),
         public.admin_member_role(p.id),
         m.created_at,
         m.last_seen_at,
         coalesce(p.is_admin, false)
  from public.admin_members m
  join public.profiles p on p.id = m.user_id
  union
  -- Legacy admins that predate this migration are visible too.
  select p.id,
         p.email,
         coalesce(p.display_name, p.full_name, p.email),
         'owner',
         null::timestamptz,
         null::timestamptz,
         true
  from public.profiles p
  where coalesce(p.is_admin, false) = true
    and not exists (select 1 from public.admin_members m2 where m2.user_id = p.id)
  order by 4, 2;
end;
$$;

create or replace function public.admin_add_member(p_email text, p_role text default 'support')
returns uuid
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_target uuid;
  v_old text;
begin
  if not public.has_perm('team.write') then
    raise exception 'Permission denied: team.write' using errcode = '42501';
  end if;
  if p_role not in ('owner', 'admin', 'moderator', 'support', 'finance', 'content') then
    raise exception 'Unknown role %', p_role using errcode = '22023';
  end if;
  if p_role = 'owner' and not public.has_perm('*') then
    raise exception 'Only an owner can grant the owner role' using errcode = '42501';
  end if;

  select p.id into v_target
  from public.profiles p
  where lower(p.email) = lower(trim(p_email))
  limit 1;

  if v_target is null then
    raise exception 'No PyDebug account uses %', p_email using errcode = 'P0002';
  end if;

  select role into v_old from public.admin_members where user_id = v_target;

  insert into public.admin_members (user_id, role, added_by)
  values (v_target, p_role, v_uid)
  on conflict (user_id) do update set role = excluded.role, added_by = v_uid;

  -- Login + 2FA gate (`_require_totp_admin`) reads profiles.is_admin, and the
  -- older admin roster lives in admin_users. Keep both in step so a teammate
  -- added here can actually sign in and set up Google Authenticator.
  update public.profiles set is_admin = true where id = v_target;

  if to_regclass('public.admin_users') is not null then
    insert into public.admin_users (user_id, email, role, created_by)
    select p.id, p.email,
           case p_role
             when 'owner' then 'superadmin'
             when 'admin' then 'superadmin'
             when 'content' then 'content_editor'
             else p_role
           end,
           v_uid
    from public.profiles p
    where p.id = v_target
    on conflict (user_id) do update set role = excluded.role;
  end if;

  insert into public.admin_audit_log (admin_id, action, entity_type, entity_id, new_value, metadata)
  values (v_uid, 'team_member_added', 'admin_members', v_target::text,
          jsonb_build_object('role', p_role), jsonb_build_object('previous_role', v_old));

  return v_target;
end;
$$;

create or replace function public.admin_set_member_role(p_user_id uuid, p_role text)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_old text;
  v_owners int;
begin
  if not public.has_perm('team.write') then
    raise exception 'Permission denied: team.write' using errcode = '42501';
  end if;
  if p_role not in ('owner', 'admin', 'moderator', 'support', 'finance', 'content') then
    raise exception 'Unknown role %', p_role using errcode = '22023';
  end if;
  if p_role = 'owner' and not public.has_perm('*') then
    raise exception 'Only an owner can grant the owner role' using errcode = '42501';
  end if;

  select role into v_old from public.admin_members where user_id = p_user_id;

  select count(*) into v_owners from public.admin_members where role = 'owner';
  if v_old = 'owner' and p_role <> 'owner' and v_owners <= 1 then
    raise exception 'Cannot demote the last owner' using errcode = '22023';
  end if;

  insert into public.admin_members (user_id, role, added_by)
  values (p_user_id, p_role, v_uid)
  on conflict (user_id) do update set role = excluded.role;

  update public.profiles set is_admin = true where id = p_user_id;

  if to_regclass('public.admin_users') is not null then
    update public.admin_users
       set role = case p_role
                    when 'owner' then 'superadmin'
                    when 'admin' then 'superadmin'
                    when 'content' then 'content_editor'
                    else p_role
                  end
     where user_id = p_user_id;
  end if;

  insert into public.admin_audit_log (admin_id, action, entity_type, entity_id, new_value, metadata)
  values (v_uid, 'team_role_changed', 'admin_members', p_user_id::text,
          jsonb_build_object('role', p_role), jsonb_build_object('previous_role', v_old));
end;
$$;

create or replace function public.admin_remove_member(p_user_id uuid, p_clear_legacy boolean default true)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_owners int;
begin
  if not public.has_perm('team.write') then
    raise exception 'Permission denied: team.write' using errcode = '42501';
  end if;
  if p_user_id = v_uid then
    raise exception 'You cannot remove your own access' using errcode = '22023';
  end if;

  select role into v_role from public.admin_members where user_id = p_user_id;

  select count(*) into v_owners from public.admin_members where role = 'owner';
  if v_role = 'owner' and v_owners <= 1 then
    raise exception 'Cannot remove the last owner' using errcode = '22023';
  end if;

  delete from public.admin_members where user_id = p_user_id;

  -- Removing panel access must remove it everywhere, not just from the new
  -- table: profiles.is_admin gates every RLS policy and the TOTP login, and
  -- admin_users is the legacy roster. `p_clear_legacy` is kept for API
  -- compatibility but access is always revoked.
  update public.profiles set is_admin = false where id = p_user_id;

  if to_regclass('public.admin_users') is not null then
    delete from public.admin_users where user_id = p_user_id;
  end if;

  insert into public.admin_audit_log (admin_id, action, entity_type, entity_id, new_value)
  values (v_uid, 'team_member_removed', 'admin_members', p_user_id::text,
          jsonb_build_object('cleared_legacy_flag', true,
                             'requested_clear_legacy', p_clear_legacy));
end;
$$;

-- -----------------------------------------------------------------------------
-- 1b. LEGACY PROFILE GUARD (profiles.is_admin sync)
--
-- The pre-existing `guard_profile_self_write()` trigger only lets a user touch
-- their own row, so the team RPCs above would fail while mirroring membership
-- into the legacy `profiles.is_admin` flag. This block patches that single
-- function: a caller holding `team.write` may write a row whose only differing
-- column is `is_admin`. Every other protection in the trigger is left as is.
-- Idempotent, and skipped when the trigger is not installed.
-- -----------------------------------------------------------------------------

do $$
declare
  v_src text;
  v_old text := $anchor$  if new.id is distinct from auth.uid() and not v_is_founder then
    raise exception 'You can only update your own profile' using errcode = '42501';
  end if;$anchor$;
  v_new text := $patch$  if new.id is distinct from auth.uid() and not v_is_founder then
    -- Admin panel team management mirrors membership into profiles.is_admin.
    -- Only that one column may differ, and only for a team.write holder.
    if public.has_perm('team.write', auth.uid())
       and (to_jsonb(new) - 'is_admin') = (to_jsonb(old) - 'is_admin') then
      return new;
    end if;

    raise exception 'You can only update your own profile' using errcode = '42501';
  end if;$patch$;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'guard_profile_self_write'
   limit 1;

  if v_src is null then
    raise notice 'guard_profile_self_write not present; skipping patch';
    return;
  end if;
  if position('public.has_perm(''team.write'', auth.uid())' in v_src) > 0 then
    return; -- already patched
  end if;
  if position(v_old in v_src) = 0 then
    raise exception 'guard_profile_self_write anchor not found - refusing to patch';
  end if;

  execute replace(v_src, v_old, v_new);
end $$;

-- -----------------------------------------------------------------------------
-- 2. RUNTIME SETTINGS
-- -----------------------------------------------------------------------------

create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null,
  is_public boolean not null default false,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

-- The table already existed before this migration in some installs, without a
-- public/private marker. Add it, then stop the old "anyone can read every row"
-- policy from exposing limits, AI budgets and security policy.
alter table public.app_settings add column if not exists is_public boolean not null default false;

alter table public.app_settings enable row level security;

-- The learner app reads these four legacy keys directly with the anon key.
update public.app_settings
   set is_public = true
 where key in ('maintenance_mode', 'battles_enabled', 'new_user_offer_enabled', 'signups_enabled');

drop policy if exists "public read settings" on public.app_settings;
drop policy if exists "Public read public settings" on public.app_settings;
create policy "Public read public settings" on public.app_settings
  for select to anon, authenticated using (is_public = true);

drop policy if exists "Admins read all settings" on public.app_settings;
create policy "Admins read all settings" on public.app_settings
  for select to authenticated using ((select public.is_admin()));

drop policy if exists "Admins read settings" on public.app_settings;

insert into public.app_settings (key, value, is_public) values
  ('general.site_name', '"PyDebug"'::jsonb, true),
  ('general.support_email', '"support@pydebug.in"'::jsonb, false),
  ('general.timezone', '"Asia/Kolkata"'::jsonb, true),
  ('general.currency', '"INR"'::jsonb, true),

  ('announcement.enabled', 'false'::jsonb, true),
  ('announcement.text', '""'::jsonb, true),
  ('announcement.link', '""'::jsonb, true),
  ('announcement.level', '"info"'::jsonb, true),

  ('maintenance.enabled', 'false'::jsonb, true),
  ('maintenance.message', '"PyDebug is getting an upgrade. Back in a few minutes."'::jsonb, true),
  ('maintenance.allow_admins', 'true'::jsonb, false),

  ('limits.free_daily_submissions', '20'::jsonb, false),
  ('limits.free_hint_unlocks', '3'::jsonb, false),
  ('limits.free_mock_tests', '1'::jsonb, false),
  ('limits.max_playground_runs_per_day', '50'::jsonb, false),

  ('gamification.xp_per_solve', '10'::jsonb, false),
  ('gamification.streak_bonus', '5'::jsonb, false),
  ('gamification.freeze_cost', '50'::jsonb, false),
  ('gamification.monthly_leaderboard_reset', 'true'::jsonb, false),

  ('ai.master_enabled', 'true'::jsonb, false),
  ('ai.features', '{"interview":true,"hints":true,"review":true,"safety":true,"growth":true}'::jsonb, false),
  ('ai.monthly_budget_paise', '500000'::jsonb, false),

  ('security.session_idle_minutes', '60'::jsonb, false),
  ('security.enforce_totp', 'true'::jsonb, false),
  ('security.login_alerts', 'true'::jsonb, false),

  ('email.sender_name', '"PyDebug"'::jsonb, false),
  ('email.reply_to', '"support@pydebug.in"'::jsonb, false),
  ('email.marketing_opt_in_default', 'false'::jsonb, false),

  ('plans.catalog', '[{"key":"weekly","name":"Weekly","amount_paise":4900,"days":7},{"key":"monthly","name":"Monthly","amount_paise":14900,"days":30},{"key":"yearly","name":"Yearly","amount_paise":99900,"days":365}]'::jsonb, true)
on conflict (key) do nothing;

-- Keep the new names in sync with the legacy keys the learner app already
-- reads, so the panel shows the real current state on first load.
update public.app_settings a
   set value = l.value, updated_at = now()
  from public.app_settings l
 where a.key = 'maintenance.enabled'
   and l.key = 'maintenance_mode'
   and l.value is not null;

create or replace function public.admin_get_settings()
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  if not public.has_perm('settings.read') then
    raise exception 'Permission denied: settings.read' using errcode = '42501';
  end if;

  return coalesce(
    (select jsonb_object_agg(key, value) from public.app_settings),
    '{}'::jsonb
  );
end;
$$;

create or replace function public.admin_set_setting(p_key text, p_value jsonb)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_old jsonb;
begin
  if not public.has_perm('settings.write') then
    raise exception 'Permission denied: settings.write' using errcode = '42501';
  end if;
  if p_key is null or p_key !~ '^[a-z0-9_]+(\.[a-z0-9_]+)+$' then
    raise exception 'Invalid setting key' using errcode = '22023';
  end if;

  select value into v_old from public.app_settings where key = p_key;

  insert into public.app_settings (key, value, updated_by, updated_at)
  values (p_key, coalesce(p_value, 'null'::jsonb), v_uid, now())
  on conflict (key) do update
    set value = excluded.value, updated_by = v_uid, updated_at = now();

  -- The learner app still reads the legacy maintenance_mode switch.
  if p_key = 'maintenance.enabled' then
    insert into public.app_settings (key, value, is_public)
    values ('maintenance_mode', coalesce(p_value, 'false'::jsonb), true)
    on conflict (key) do update set value = excluded.value, updated_at = now();
  end if;

  insert into public.admin_audit_log (admin_id, action, entity_type, entity_id, old_value, new_value)
  values (v_uid, 'setting_updated', 'app_settings', p_key, coalesce(v_old, '{}'::jsonb), p_value);
end;
$$;

-- Safe, cacheable subset for the learner app / maintenance screen.
create or replace function public.public_settings()
returns jsonb
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select jsonb_object_agg(key, value) from public.app_settings where is_public = true),
    '{}'::jsonb
  );
$$;

grant execute on function public.public_settings() to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3. FEATURE FLAGS / KILL SWITCHES
--
-- The learner app is already driven by `server_flags` (key + enabled). Instead
-- of introducing a second, competing flag table, this migration extends that
-- one with labels, descriptions, rollout % and an author — so a toggle here
-- changes the product immediately, and every existing flag (for example
-- `db_solve_xp`) shows up in the panel.
-- -----------------------------------------------------------------------------

do $$
begin
  if to_regclass('public.server_flags') is null then
    create table public.server_flags (
      key text primary key,
      enabled boolean not null default false,
      updated_at timestamptz not null default now()
    );
  end if;
end $$;

alter table public.server_flags add column if not exists label text;
alter table public.server_flags add column if not exists description text;
alter table public.server_flags add column if not exists rollout_percent int not null default 100;
alter table public.server_flags add column if not exists updated_by uuid references public.profiles(id) on delete set null;

alter table public.server_flags drop constraint if exists server_flags_rollout_check;
alter table public.server_flags
  add constraint server_flags_rollout_check check (rollout_percent between 0 and 100);

insert into public.server_flags (key, enabled, label, description, rollout_percent) values
  ('ai_interview',  true,  'AI Interview Studio', 'Mock interview generator + rubric scoring', 100),
  ('ai_hints',      true,  'AI hints & review',   'In-problem hint unlock and code review coach', 100),
  ('community_hub', true,  'Community Hub',       'Posts, comments, likes and campus discussions', 100),
  ('mock_tests',    true,  'Mock tests',          'Timed full-length mock tests', 100),
  ('battles',       true,  '1v1 Battles',         'Live head-to-head coding battles', 100),
  ('study_plans',   true,  'Study plans',         'Personalised multi-week prep plans', 100),
  ('certificates',  true,  'Certificates',        'Verifiable completion certificates', 100),
  ('referrals',     false, 'Referral programme',  'Invite friends, both get premium days', 0),
  ('write_code',    true,  'Write-Code judge',    'Run hidden test cases against learner code', 100),
  ('weekly_wordle', true,  'Weekly Wordle',       'Today''s Wordle challenge', 100)
on conflict (key) do nothing;

-- Friendly names for flags that existed before this migration.
update public.server_flags set label = coalesce(label, 'DB-backed solve XP'),
       description = coalesce(description, 'Award solve XP from the database instead of the client')
 where key = 'db_solve_xp';

-- The legacy product switch lives in app_settings; mirror its current value.
update public.server_flags f
   set enabled = (l.value = 'true'::jsonb)
  from public.app_settings l
 where f.key = 'battles'
   and l.key = 'battles_enabled';

create or replace function public.admin_list_flags()
returns table (key text, label text, description text, enabled boolean, rollout_percent int, updated_at timestamptz)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  if not public.has_perm('settings.read') then
    raise exception 'Permission denied: settings.read' using errcode = '42501';
  end if;

  return query
  select f.key,
         coalesce(f.label, f.key),
         f.description,
         f.enabled,
         coalesce(f.rollout_percent, 100),
         f.updated_at
  from public.server_flags f
  order by coalesce(f.label, f.key);
end;
$$;

create or replace function public.admin_set_flag(p_key text, p_enabled boolean, p_rollout int default null)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_old public.server_flags%rowtype;
begin
  if not public.has_perm('settings.write') then
    raise exception 'Permission denied: settings.write' using errcode = '42501';
  end if;

  select * into v_old from public.server_flags where key = p_key;
  if not found then
    raise exception 'Unknown feature flag %', p_key using errcode = 'P0002';
  end if;

  update public.server_flags
     set enabled = coalesce(p_enabled, enabled),
         rollout_percent = coalesce(greatest(0, least(100, p_rollout)), rollout_percent),
         updated_by = v_uid,
         updated_at = now()
   where key = p_key;

  -- Keep the legacy product switch in step with the flag.
  if p_key = 'battles' then
    insert into public.app_settings (key, value, is_public)
    values ('battles_enabled', to_jsonb(coalesce(p_enabled, v_old.enabled)), true)
    on conflict (key) do update set value = excluded.value, updated_at = now();
  end if;

  insert into public.admin_audit_log (admin_id, action, entity_type, entity_id, old_value, new_value)
  values (v_uid, 'feature_flag_updated', 'server_flags', p_key,
          jsonb_build_object('enabled', v_old.enabled, 'rollout', v_old.rollout_percent),
          jsonb_build_object('enabled', coalesce(p_enabled, v_old.enabled),
                             'rollout', coalesce(p_rollout, v_old.rollout_percent)));
end;
$$;

create or replace function public.public_feature_flags()
returns jsonb
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select jsonb_object_agg(key, jsonb_build_object('enabled', enabled,
                                                     'rollout', coalesce(rollout_percent, 100)))
     from public.server_flags where enabled = true),
    '{}'::jsonb
  );
$$;

grant execute on function public.public_feature_flags() to anon, authenticated;

-- The panel never reads or writes this table directly (RPC only), and no anon
-- grant is added, so learner-side access stays exactly as it was.

-- -----------------------------------------------------------------------------
-- 4. SOFT DELETE + TRASH
-- -----------------------------------------------------------------------------

create table if not exists public.deletion_archive (
  id uuid primary key default gen_random_uuid(),
  table_name text not null,
  row_id text not null,
  payload jsonb not null,
  reason text,
  deleted_by uuid references public.profiles(id) on delete set null,
  deleted_at timestamptz not null default now(),
  restored_at timestamptz,
  restored_by uuid references public.profiles(id) on delete set null,
  purged_at timestamptz
);

create index if not exists deletion_archive_deleted_idx
  on public.deletion_archive (deleted_at desc);
create index if not exists deletion_archive_table_idx
  on public.deletion_archive (table_name, deleted_at desc);

alter table public.deletion_archive enable row level security;

drop policy if exists "Admins read trash" on public.deletion_archive;
create policy "Admins read trash" on public.deletion_archive
  for select using ((select public.is_admin()));

create or replace function public.admin_soft_delete(p_table text, p_row_id text, p_reason text default null)
returns uuid
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_payload jsonb;
  v_id uuid;
  v_allowed text[] := array['problems', 'submissions', 'notifications',
                              'problem_discussions', 'community_posts',
                              'shared_snippets'];
begin
  if not public.has_perm('trash.write') then
    raise exception 'Permission denied: trash.write' using errcode = '42501';
  end if;
  if p_table is null or not (p_table = any (v_allowed)) then
    raise exception 'Table % cannot be archived from the panel', coalesce(p_table, '(null)')
      using errcode = '22023';
  end if;
  if p_row_id is null or p_row_id = '' then
    raise exception 'Row id is required' using errcode = '22023';
  end if;

  execute format('select to_jsonb(t) from public.%I t where t.id::text = $1', p_table)
    into v_payload
    using p_row_id;

  if v_payload is null then
    raise exception 'Row % not found in %', p_row_id, p_table using errcode = 'P0002';
  end if;

  insert into public.deletion_archive (table_name, row_id, payload, reason, deleted_by)
  values (p_table, p_row_id, v_payload, p_reason, v_uid)
  returning id into v_id;

  -- Keep the row id in the payload so a restore can rebuild it even if the
  -- caller passed a text-cast id (uuid/numeric both work).
  execute format('delete from public.%I where id::text = $1', p_table) using p_row_id;

  insert into public.admin_audit_log (admin_id, action, entity_type, entity_id, reason, new_value)
  values (v_uid, 'row_archived', p_table, p_row_id, p_reason, jsonb_build_object('archive_id', v_id));

  return v_id;
end;
$$;

create or replace function public.admin_restore_row(p_archive_id uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.deletion_archive%rowtype;
  v_cols text;
  v_table text;
begin
  if not public.has_perm('trash.write') then
    raise exception 'Permission denied: trash.write' using errcode = '42501';
  end if;

  select * into v_row from public.deletion_archive
   where id = p_archive_id and restored_at is null and purged_at is null
   for update;

  if not found then
    raise exception 'Archived row not found or already handled' using errcode = 'P0002';
  end if;

  v_table := v_row.table_name;

  select string_agg(quote_ident(k), ', ' order by k)
    into v_cols
    from jsonb_object_keys(v_row.payload) as k;

  begin
    execute format(
      'insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1) on conflict (id) do nothing',
      v_table, v_cols, v_cols, v_table
    ) using v_row.payload;
  exception when others then
    raise exception 'Could not restore row from %: %', v_table, sqlerrm using errcode = '22023';
  end;

  update public.deletion_archive
     set restored_at = now(), restored_by = v_uid
   where id = p_archive_id;

  insert into public.admin_audit_log (admin_id, action, entity_type, entity_id, new_value)
  values (v_uid, 'row_restored', v_table, v_row.row_id,
          jsonb_build_object('archive_id', p_archive_id));
end;
$$;

create or replace function public.admin_purge_row(p_archive_id uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.deletion_archive%rowtype;
begin
  if not public.has_perm('trash.write') then
    raise exception 'Permission denied: trash.write' using errcode = '42501';
  end if;

  select * into v_row from public.deletion_archive where id = p_archive_id;
  if not found then
    raise exception 'Archived row not found' using errcode = 'P0002';
  end if;

  update public.deletion_archive set purged_at = now() where id = p_archive_id;

  insert into public.admin_audit_log (admin_id, action, entity_type, entity_id, new_value, reason)
  values (v_uid, 'row_purged', v_row.table_name, v_row.row_id,
          jsonb_build_object('archive_id', p_archive_id), 'permanent delete from Trash');
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. ADMIN SESSIONS
-- -----------------------------------------------------------------------------

create table if not exists public.admin_sessions (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references public.profiles(id) on delete cascade,
  user_agent text,
  ip inet,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references public.profiles(id) on delete set null,
  revoke_reason text
);

create index if not exists admin_sessions_admin_idx on public.admin_sessions (admin_id, last_seen_at desc);

alter table public.admin_sessions enable row level security;

drop policy if exists "Admins read sessions" on public.admin_sessions;
create policy "Admins read sessions" on public.admin_sessions
  for select using (
    admin_id = auth.uid() or public.has_perm('team.read')
  );

create or replace function public.admin_start_session(p_user_agent text default null)
returns uuid
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
begin
  if v_uid is null or public.admin_member_role(v_uid) is null then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  -- Housekeeping: nothing older than 30 days is worth keeping, and keeping the
  -- table small keeps the sessions panel instant.
  delete from public.admin_sessions
   where admin_id = v_uid
     and created_at < now() - interval '30 days';

  insert into public.admin_sessions (admin_id, user_agent)
  values (v_uid, left(coalesce(p_user_agent, ''), 400))
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.admin_touch_session(p_id uuid)
returns boolean
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  update public.admin_sessions
     set last_seen_at = now()
   where id = p_id and admin_id = auth.uid() and revoked_at is null;

  return found;
end;
$$;

create or replace function public.admin_session_state(p_id uuid)
returns text
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_revoked timestamptz;
begin
  select revoked_at into v_revoked
  from public.admin_sessions
  where id = p_id and admin_id = auth.uid();

  if not found then
    return 'missing';
  end if;
  if v_revoked is not null then
    return 'revoked';
  end if;
  return 'active';
end;
$$;

create or replace function public.admin_list_sessions()
returns table (id uuid, admin_id uuid, email text, user_agent text, created_at timestamptz,
               last_seen_at timestamptz, revoked_at timestamptz)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  if not public.has_perm('team.read') then
    raise exception 'Permission denied: team.read' using errcode = '42501';
  end if;

  return query
  select s.id, s.admin_id, p.email, s.user_agent, s.created_at, s.last_seen_at, s.revoked_at
  from public.admin_sessions s
  left join public.profiles p on p.id = s.admin_id
  order by (s.revoked_at is not null), s.last_seen_at desc
  limit 100;
end;
$$;

create or replace function public.admin_revoke_session(p_id uuid, p_reason text default null)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_owner uuid;
begin
  select admin_id into v_owner from public.admin_sessions where id = p_id;
  if v_owner is null then
    raise exception 'Session not found' using errcode = 'P0002';
  end if;
  if v_owner <> v_uid and not public.has_perm('team.write') then
    raise exception 'Permission denied: team.write' using errcode = '42501';
  end if;

  update public.admin_sessions
     set revoked_at = now(), revoked_by = v_uid, revoke_reason = p_reason
   where id = p_id and revoked_at is null;

  insert into public.admin_audit_log (admin_id, action, entity_type, entity_id, reason)
  values (v_uid, 'admin_session_revoked', 'admin_sessions', p_id::text, p_reason);
end;
$$;

create or replace function public.admin_revoke_other_sessions(p_keep uuid default null)
returns int
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_count int;
begin
  update public.admin_sessions
     set revoked_at = now(), revoked_by = v_uid, revoke_reason = 'revoked from security settings'
   where admin_id = v_uid
     and revoked_at is null
     and (p_keep is null or id <> p_keep);

  get diagnostics v_count = row_count;

  insert into public.admin_audit_log (admin_id, action, entity_type, entity_id, new_value)
  values (v_uid, 'admin_sessions_revoked_bulk', 'admin_sessions', v_uid::text,
          jsonb_build_object('revoked', v_count));

  return v_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. AUDIT HARDENING
-- -----------------------------------------------------------------------------

alter table public.admin_audit_log add column if not exists ip inet;
alter table public.admin_audit_log add column if not exists user_agent text;
alter table public.admin_audit_log add column if not exists session_id uuid;
alter table public.admin_audit_log add column if not exists request_id text;

create index if not exists admin_audit_log_action_idx
  on public.admin_audit_log (action, created_at desc);
create index if not exists admin_audit_log_admin_idx
  on public.admin_audit_log (admin_id, created_at desc);

-- Append-only: the panel may insert and read, never rewrite history.
revoke update, delete on public.admin_audit_log from authenticated, anon;

drop policy if exists "Admin panel insert" on public.admin_audit_log;
create policy "Admin panel insert" on public.admin_audit_log for insert to authenticated
with check ((select public.is_admin()) and (admin_id = (select auth.uid()) or admin_id is null));

-- -----------------------------------------------------------------------------
-- 7. SAVED VIEWS (shared list presets for the panel)
-- -----------------------------------------------------------------------------

create table if not exists public.saved_views (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references public.profiles(id) on delete cascade,
  page text not null,
  name text not null,
  query jsonb not null default '{}'::jsonb,
  is_shared boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.saved_views enable row level security;

drop policy if exists "Admins manage own saved views" on public.saved_views;
create policy "Admins manage own saved views" on public.saved_views
  for all using (admin_id = auth.uid() or (is_shared and (select public.is_admin())))
  with check (admin_id = auth.uid());

-- -----------------------------------------------------------------------------
-- 8. GRANTS
-- -----------------------------------------------------------------------------

grant select on public.admin_members, public.admin_role_permissions, public.app_settings,
      public.deletion_archive, public.admin_sessions, public.saved_views
  to authenticated;

revoke insert, update, delete on public.admin_members, public.admin_role_permissions,
       public.app_settings, public.deletion_archive, public.admin_sessions
  from authenticated, anon;

-- New RPCs: authenticated only, never anon.
revoke all on function public.admin_member_role(uuid) from public, anon;
revoke all on function public.admin_permissions(uuid) from public, anon;
revoke all on function public.has_perm(text, uuid) from public, anon;
revoke all on function public.admin_identity() from public, anon;
revoke all on function public.admin_list_members() from public, anon;
revoke all on function public.admin_add_member(text, text) from public, anon;
revoke all on function public.admin_set_member_role(uuid, text) from public, anon;
revoke all on function public.admin_remove_member(uuid, boolean) from public, anon;
revoke all on function public.admin_get_settings() from public, anon;
revoke all on function public.admin_set_setting(text, jsonb) from public, anon;
revoke all on function public.admin_list_flags() from public, anon;
revoke all on function public.admin_set_flag(text, boolean, int) from public, anon;
revoke all on function public.admin_soft_delete(text, text, text) from public, anon;
revoke all on function public.admin_restore_row(uuid) from public, anon;
revoke all on function public.admin_purge_row(uuid) from public, anon;
revoke all on function public.admin_start_session(text) from public, anon;
revoke all on function public.admin_touch_session(uuid) from public, anon;
revoke all on function public.admin_session_state(uuid) from public, anon;
revoke all on function public.admin_list_sessions() from public, anon;
revoke all on function public.admin_revoke_session(uuid, text) from public, anon;
revoke all on function public.admin_revoke_other_sessions(uuid) from public, anon;

grant execute on function public.admin_member_role(uuid),
                     public.admin_permissions(uuid),
                     public.has_perm(text, uuid),
                     public.admin_identity(),
                     public.admin_list_members(),
                     public.admin_add_member(text, text),
                     public.admin_set_member_role(uuid, text),
                     public.admin_remove_member(uuid, boolean),
                     public.admin_get_settings(),
                     public.admin_set_setting(text, jsonb),
                     public.admin_list_flags(),
                     public.admin_set_flag(text, boolean, int),
                     public.admin_soft_delete(text, text, text),
                     public.admin_restore_row(uuid),
                     public.admin_purge_row(uuid),
                     public.admin_start_session(text),
                     public.admin_touch_session(uuid),
                     public.admin_session_state(uuid),
                     public.admin_list_sessions(),
                     public.admin_revoke_session(uuid, text),
                     public.admin_revoke_other_sessions(uuid)
  to authenticated;

-- Refresh PostgREST's schema cache immediately.
notify pgrst, 'reload schema';
