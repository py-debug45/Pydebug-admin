-- =============================================================
-- PyDebug Admin — Supabase setup (run ONCE in SQL Editor)
-- =============================================================
-- Assumes the main user-panel tables (profiles, problems, submissions,
-- payments, etc.) already exist from the user app's setup.
-- This script is idempotent — safe to re-run after upgrades.
-- =============================================================

-- 1. Mark who is an admin --------------------------------------
alter table profiles add column if not exists is_admin boolean default false;

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

-- 5. Payments: admins can read all (Payments page + revenue stats)
drop policy if exists "Admins can read all payments" on payments;
create policy "Admins can read all payments" on payments for select using (is_admin());

-- 6. Submissions: admins can read all (Submissions page, dashboard
--    analytics, user detail) and delete spam/bad rows
drop policy if exists "Admins can read all submissions" on submissions;
create policy "Admins can read all submissions" on submissions for select using (is_admin());

drop policy if exists "Admins can delete submissions" on submissions;
create policy "Admins can delete submissions" on submissions for delete using (is_admin());

-- NOTE: if you already added the `prevent_self_premium_grant` trigger from
-- the user app's setup (blocking users from self-granting premium), it works
-- fine alongside these policies — that trigger explicitly allows changes
-- when is_admin() is true, so admin-panel premium grants/revokes keep working.
