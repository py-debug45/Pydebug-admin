-- Restore only the admin panel's access. Keep RLS and learner policies intact.
-- Never grant anon access to problems (contains answer keys) or payment data.
grant usage on schema public to authenticated;
do $$
declare t text;
begin
  foreach t in array array['profiles','problems','submissions','payment_grants','payment_orders','payments',
    'product_entitlements','problem_discussions','discussion_likes','discussion_flags','community_posts',
    'notifications','push_subscriptions','push_announcements','push_broadcast_log','user_achievements',
    'user_presence','admin_audit_log','admin_settings','ai_settings','ai_logs',
    'user_certificates','mock_attempts','battles','study_plans',
    'classrooms','classroom_members','institute_enquiries','learner_feedback','referrals'] loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I enable row level security', t);
      execute format('grant select on public.%I to authenticated', t);
      execute format('drop policy if exists "Admin panel read" on public.%I', t);
      execute format('create policy "Admin panel read" on public.%I for select to authenticated using ((select public.is_admin()))', t);
    end if;
  end loop;
end $$;
-- Writes are granted only where the panel actually needs them; RLS still
-- decides which rows a caller may modify. No payment ledger writes.
do $$
declare t text; op text;
begin
  foreach t in array array['problems','problem_discussions','discussion_likes','discussion_flags','notifications','push_announcements','product_entitlements','submissions','user_presence','admin_audit_log','admin_settings','ai_settings','ai_logs'] loop
    if to_regclass('public.' || t) is not null then
      foreach op in array array['insert','update','delete'] loop
        -- Submission/presence/like management needs deletion only; audit log is append-only.
        if t in ('submissions','user_presence','discussion_likes') and op <> 'delete' then continue; end if;
        if t = 'admin_audit_log' and op <> 'insert' then continue; end if;
        execute format('grant %s on public.%I to authenticated', op, t);
        execute format('drop policy if exists %I on public.%I', 'Admin panel ' || op, t);
        if op = 'insert' then
          if t = 'admin_audit_log' then
            execute 'create policy "Admin panel insert" on public.admin_audit_log for insert to authenticated with check ((select public.is_admin()) and admin_id = (select auth.uid()))';
          else
            execute format('create policy %I on public.%I for insert to authenticated with check ((select public.is_admin()))', 'Admin panel ' || op, t);
          end if;
        elsif op = 'update' then
          execute format('create policy %I on public.%I for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()))', 'Admin panel ' || op, t);
        else
          execute format('create policy %I on public.%I for delete to authenticated using ((select public.is_admin()))', 'Admin panel ' || op, t);
        end if;
      end loop;
    end if;
  end loop;
end $$;
-- Profile UPDATE privileges are intentionally not broadened here: the live
-- user app restricts sensitive columns. Preserve its escalation protections.
drop policy if exists "Admin panel update" on public.profiles;
create policy "Admin panel update" on public.profiles for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
notify pgrst, 'reload schema';
