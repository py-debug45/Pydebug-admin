-- Both the server admin and this panel share the existing audit ledger.
alter table public.admin_audit_log add column if not exists entity_type text;
alter table public.admin_audit_log add column if not exists entity_id text;
alter table public.admin_audit_log add column if not exists metadata jsonb not null default '{}'::jsonb;
grant insert (admin_id,action,entity_type,entity_id,metadata) on public.admin_audit_log to authenticated;
grant usage on sequence public.admin_audit_log_id_seq to authenticated;
drop policy if exists "Admin panel insert" on public.admin_audit_log;
create policy "Admin panel insert" on public.admin_audit_log for insert to authenticated
with check ((select public.is_admin()) and admin_id = (select auth.uid()));
-- Sensitive profile columns stay unavailable to ordinary direct UPDATEs.
create or replace function public.admin_panel_update_profile(target_user uuid, patch jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not coalesce(public.is_admin(),false) then raise exception 'Admin access required' using errcode='42501'; end if;
  if jsonb_typeof(patch) <> 'object' or exists (
    select 1 from jsonb_object_keys(patch) k where k not in
    ('display_name','xp','monthly_xp','streak','streak_freezes','is_premium','premium_expires_at','is_admin')
  ) then raise exception 'Invalid profile fields'; end if;
  if target_user = auth.uid() and patch->>'is_admin' = 'false' then raise exception 'Cannot remove your own admin access'; end if;
  update public.profiles p set
    display_name = case when patch ? 'display_name' then patch->>'display_name' else p.display_name end,
    xp = case when patch ? 'xp' then (patch->>'xp')::integer else p.xp end,
    monthly_xp = case when patch ? 'monthly_xp' then (patch->>'monthly_xp')::integer else p.monthly_xp end,
    streak = case when patch ? 'streak' then (patch->>'streak')::integer else p.streak end,
    streak_freezes = case when patch ? 'streak_freezes' then (patch->>'streak_freezes')::integer else p.streak_freezes end,
    is_premium = case when patch ? 'is_premium' then (patch->>'is_premium')::boolean else p.is_premium end,
    premium_expires_at = case when patch ? 'premium_expires_at' then (patch->>'premium_expires_at')::timestamptz else p.premium_expires_at end,
    is_admin = case when patch ? 'is_admin' then (patch->>'is_admin')::boolean else p.is_admin end
  where p.id = target_user;
  if not found then raise exception 'Profile not found'; end if;
end $$;
revoke all on function public.admin_panel_update_profile(uuid,jsonb) from public, anon;
grant execute on function public.admin_panel_update_profile(uuid,jsonb) to authenticated;
notify pgrst, 'reload schema';
-- Newer server ledger requires these fields; older panel-only schemas don't.
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='admin_audit_log' and column_name='admin_role') then
    alter table public.admin_audit_log alter column admin_role set default 'admin';
    alter table public.admin_audit_log alter column resource set default 'admin-panel';
  end if;
end $$;
