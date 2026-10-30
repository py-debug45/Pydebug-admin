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
