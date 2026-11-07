-- -----------------------------------------------------------------------------
-- Saved views: make the table writable from the panel (it was read-only) and
-- scope the writes properly.
--
-- Before this migration `authenticated` only had SELECT on public.saved_views,
-- so "save this filter" failed with a permission error. The old FOR ALL policy
-- also let any admin delete somebody else's shared view. Now:
--   * read   — your own rows, plus shared rows for admins
--   * insert — only rows where admin_id = auth.uid()
--   * update — only your own rows (with check keeps admin_id unchanged)
--   * delete — only your own rows
-- -----------------------------------------------------------------------------

drop policy if exists "Admins manage own saved views" on public.saved_views;

drop policy if exists "Admins read own or shared views" on public.saved_views;
create policy "Admins read own or shared views" on public.saved_views
  for select to authenticated
  using (admin_id = auth.uid() or (is_shared and (select public.is_admin())));

drop policy if exists "Admins insert own views" on public.saved_views;
create policy "Admins insert own views" on public.saved_views
  for insert to authenticated
  with check (admin_id = auth.uid() and (select public.is_admin()));

drop policy if exists "Admins update own views" on public.saved_views;
create policy "Admins update own views" on public.saved_views
  for update to authenticated
  using (admin_id = auth.uid())
  with check (admin_id = auth.uid());

drop policy if exists "Admins delete own views" on public.saved_views;
create policy "Admins delete own views" on public.saved_views
  for delete to authenticated
  using (admin_id = auth.uid());

grant select, insert, update, delete on public.saved_views to authenticated;
revoke all on public.saved_views from anon;
