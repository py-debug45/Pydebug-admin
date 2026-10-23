-- =============================================================
-- Fix missing authenticated table grants & tighten anon privileges
-- Idempotent: safe to run multiple times in Supabase SQL Editor.
--
-- Why this exists:
-- PostgREST requires table-level privileges (GRANT SELECT / INSERT / UPDATE /
-- DELETE TO authenticated) BEFORE evaluating Row Level Security policies.
-- Creating RLS policies alone leaves tables throwing:
--   "permission denied for table user_certificates"
--   "permission denied for table mock_attempts"
--   "permission denied for table study_plans"
--   (and the same error on payment_orders, product_entitlements,
--    push_announcements, push_broadcast_log, discussion_flags, admin_audit_log).
-- =============================================================

grant usage on schema public to anon, authenticated;

do $$
begin
  -- 1. Read-only admin tables (mutations go through SECURITY DEFINER RPCs or server APIs)
  if to_regclass('public.user_certificates') is not null then
    alter table public.user_certificates enable row level security;
    revoke all on public.user_certificates from anon;
    grant select on public.user_certificates to authenticated;
    drop policy if exists "Admins can read all certificates" on public.user_certificates;
    create policy "Admins can read all certificates"
      on public.user_certificates for select to authenticated
      using ((select public.is_admin()));
  end if;

  if to_regclass('public.mock_attempts') is not null then
    alter table public.mock_attempts enable row level security;
    revoke all on public.mock_attempts from anon;
    grant select on public.mock_attempts to authenticated;
    drop policy if exists "Admins can read all mock attempts" on public.mock_attempts;
    create policy "Admins can read all mock attempts"
      on public.mock_attempts for select to authenticated
      using ((select public.is_admin()));
  end if;

  if to_regclass('public.study_plans') is not null then
    alter table public.study_plans enable row level security;
    revoke all on public.study_plans from anon;
    grant select on public.study_plans to authenticated;
    drop policy if exists "Admins can read all study plans" on public.study_plans;
    create policy "Admins can read all study plans"
      on public.study_plans for select to authenticated
      using ((select public.is_admin()));
  end if;

  if to_regclass('public.battles') is not null then
    alter table public.battles enable row level security;
    revoke all on public.battles from anon;
    grant select on public.battles to authenticated;
    drop policy if exists "Admins can read all battles" on public.battles;
    create policy "Admins can read all battles"
      on public.battles for select to authenticated
      using ((select public.is_admin()));
  end if;

  if to_regclass('public.payment_orders') is not null then
    alter table public.payment_orders enable row level security;
    revoke all on public.payment_orders from anon;
    grant select on public.payment_orders to authenticated;
    drop policy if exists "Admins can read all payment orders" on public.payment_orders;
    create policy "Admins can read all payment orders"
      on public.payment_orders for select to authenticated
      using ((select public.is_admin()));
  end if;

  if to_regclass('public.push_broadcast_log') is not null then
    alter table public.push_broadcast_log enable row level security;
    revoke all on public.push_broadcast_log from anon;
    grant select on public.push_broadcast_log to authenticated;
    drop policy if exists "Admins can read push broadcast log" on public.push_broadcast_log;
    create policy "Admins can read push broadcast log"
      on public.push_broadcast_log for select to authenticated
      using ((select public.is_admin()));
  end if;

  if to_regclass('public.push_subscriptions') is not null then
    alter table public.push_subscriptions enable row level security;
    grant select on public.push_subscriptions to authenticated;
    drop policy if exists "Admins can read push subscriptions" on public.push_subscriptions;
    create policy "Admins can read push subscriptions"
      on public.push_subscriptions for select to authenticated
      using ((select public.is_admin()));
  end if;

  -- 2. Append-only audit log (SELECT + INSERT for authenticated admins; immutable via trigger)
  if to_regclass('public.admin_audit_log') is not null then
    alter table public.admin_audit_log enable row level security;
    revoke all on public.admin_audit_log from anon;
    grant select, insert on public.admin_audit_log to authenticated;
    drop policy if exists "Admin panel read" on public.admin_audit_log;
    create policy "Admin panel read"
      on public.admin_audit_log for select to authenticated
      using ((select public.is_admin()));
    drop policy if exists "Admin panel insert" on public.admin_audit_log;
    create policy "Admin panel insert"
      on public.admin_audit_log for insert to authenticated
      with check ((select public.is_admin()) and admin_id = (select auth.uid()));
  end if;

  -- 3. Admin-managed operational tables (RLS enforces is_admin())
  if to_regclass('public.product_entitlements') is not null then
    alter table public.product_entitlements enable row level security;
    revoke all on public.product_entitlements from anon;
    grant select, insert, update, delete on public.product_entitlements to authenticated;
    drop policy if exists "Admins can manage product entitlements" on public.product_entitlements;
    create policy "Admins can manage product entitlements"
      on public.product_entitlements for all to authenticated
      using ((select public.is_admin()))
      with check ((select public.is_admin()));
  end if;

  if to_regclass('public.push_announcements') is not null then
    alter table public.push_announcements enable row level security;
    revoke all on public.push_announcements from anon;
    grant select, insert, update, delete on public.push_announcements to authenticated;
    drop policy if exists "Admins can manage push announcements" on public.push_announcements;
    create policy "Admins can manage push announcements"
      on public.push_announcements for all to authenticated
      using ((select public.is_admin()))
      with check ((select public.is_admin()));
  end if;

  if to_regclass('public.discussion_flags') is not null then
    alter table public.discussion_flags enable row level security;
    revoke all on public.discussion_flags from anon;
    grant select, insert, update, delete on public.discussion_flags to authenticated;
    drop policy if exists "Admins can manage discussion flags" on public.discussion_flags;
    create policy "Admins can manage discussion flags"
      on public.discussion_flags for all to authenticated
      using ((select public.is_admin()))
      with check ((select public.is_admin()));
  end if;

  if to_regclass('public.referrals') is not null then
    alter table public.referrals enable row level security;
    revoke all on public.referrals from anon;
    grant select, insert, update, delete on public.referrals to authenticated;
    drop policy if exists "Admins can manage referrals" on public.referrals;
    create policy "Admins can manage referrals"
      on public.referrals for all to authenticated
      using ((select public.is_admin()))
      with check ((select public.is_admin()));
  end if;

  -- 4. Least-privilege grants on newer community/growth tables (remove excess anon TRUNCATE/DELETE/UPDATE)
  if to_regclass('public.institute_enquiries') is not null then
    revoke all on public.institute_enquiries from anon, authenticated;
    grant insert on public.institute_enquiries to anon, authenticated;
    grant select, update, delete on public.institute_enquiries to authenticated;
  end if;

  if to_regclass('public.learner_feedback') is not null then
    revoke all on public.learner_feedback from anon, authenticated;
    grant select on public.learner_feedback to anon, authenticated;
    grant insert, update, delete on public.learner_feedback to authenticated;
  end if;

  if to_regclass('public.classrooms') is not null then
    revoke all on public.classrooms from anon, authenticated;
    grant select, insert, update, delete on public.classrooms to authenticated;
  end if;

  if to_regclass('public.classroom_members') is not null then
    revoke all on public.classroom_members from anon, authenticated;
    grant select, insert, delete on public.classroom_members to authenticated;
  end if;

  if to_regclass('public.shared_snippets') is not null then
    revoke all on public.shared_snippets from anon, authenticated;
    grant select on public.shared_snippets to anon, authenticated;
    grant insert, update, delete on public.shared_snippets to authenticated;
  end if;
end $$;

notify pgrst, 'reload schema';
