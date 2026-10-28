-- Admin notification safety: atomic, retry-safe broadcasts and scoped push.
-- Requires the user app's notifications and push-subscription schema.
-- Test on a staging database before applying; this replaces shared triggers.

begin;

alter table public.notifications add column if not exists metadata jsonb default '{}'::jsonb;

-- Private idempotency ledger. A request and its notifications commit together;
-- retrying the same request after a lost response cannot send them twice.
create table if not exists public.admin_broadcast_requests (
  request_id uuid primary key,
  admin_id uuid not null,
  payload jsonb not null,
  recipients integer not null default 0,
  created_at timestamptz not null default now()
);
alter table public.admin_broadcast_requests enable row level security;
revoke all on table public.admin_broadcast_requests from public, anon, authenticated;

-- Preserve ordinary instant-push behavior, but respect the explicit push
-- choice on admin broadcasts. Dispatch every 250 IDs rather than silently
-- dropping IDs after the first 250. Targeted announcements fan out per user.
create or replace function public.pydebug_push_notification_instantly()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_base text;
  v_ids uuid[];
  v_count integer;
  v_offset integer;
  v_batch uuid[];
  v_strict boolean := false;
begin
  select exists (
    select 1 from new_rows nr
    where (nr.metadata ->> 'source' = 'admin_broadcast'
           and nr.metadata ->> 'web_push' = 'true')
       or nr.metadata ->> 'targeted_announcement' = 'true'
  ) into v_strict;

  if lower(coalesce(current_setting('app.settings.push_instant', true), 'on')) = 'off'
     or to_regnamespace('net') is null
     or to_regclass('public.push_subscriptions') is null then
    if v_strict then
      raise exception 'Instant Web Push is unavailable; no broadcast was sent';
    end if;
    return null;
  end if;

  select array_agg(nr.id order by nr.id) into v_ids
  from new_rows nr
  where exists (select 1 from public.push_subscriptions ps where ps.user_id = nr.user_id)
    and (
      (nr.metadata ->> 'source' = 'admin_broadcast' and nr.metadata ->> 'web_push' = 'true')
      or (
        nr.metadata ->> 'source' is distinct from 'admin_broadcast'
        and (
          nr.metadata ->> 'targeted_announcement' = 'true'
          or (
            coalesce(nr.type, '') not in ('new_problem', 'leaderboard_rank')
            and coalesce(nr.metadata ->> 'from_push_announcements', 'false') <> 'true'
            and not (
              coalesce(nr.type, '') = 'streak_warning'
              and coalesce(nr.metadata ->> 'milestone', 'false') <> 'true'
            )
          )
        )
      )
    );

  v_count := coalesce(cardinality(v_ids), 0);
  if v_count = 0 then return null; end if;

  v_base := rtrim(coalesce(nullif(current_setting('app.settings.pydebug_api_base', true), ''), 'https://pydebug.in'), '/');
  for v_offset in 1..v_count by 250 loop
    v_batch := v_ids[v_offset:least(v_offset + 249, v_count)];
    if cardinality(v_batch) = 1 then
      perform net.http_post(
        url := v_base || '/api/push-send',
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body := jsonb_build_object('notification_id', v_batch[1], 'source', 'db-trigger'),
        timeout_milliseconds := 5000
      );
    else
      perform net.http_post(
        url := v_base || '/api/push-send',
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body := jsonb_build_object('notification_ids', to_jsonb(v_batch), 'source', 'db-trigger'),
        timeout_milliseconds := 8000
      );
    end if;
  end loop;
  return null;
exception when others then
  -- Admin broadcasts are atomic: do not claim success when enqueueing failed.
  if v_strict then
    raise exception 'Web Push request failed; no broadcast was sent: %', sqlerrm;
  end if;
  -- Existing app-generated notifications remain resilient if push is down.
  raise warning 'pydebug instant push: webhook dispatch failed: %', sqlerrm;
  return null;
end;
$$;

-- The live user app installs this statement trigger. Recreate it explicitly so
-- the RPC behaves correctly on installations where that migration was missed.
drop trigger if exists pydebug_push_notifications_instant on public.notifications;
create trigger pydebug_push_notifications_instant
  after insert on public.notifications
  referencing new table as new_rows
  for each statement execute function public.pydebug_push_notification_instantly();

-- Existing push_announcements writers may target premium/free users. The old
-- feed-sync trigger ignored segment and wrote to every learner. Scope the feed
-- and use per-user fanout for targeted announcements rather than a global one.
create or replace function public.pydebug_on_push_announcement_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_base text;
  v_segment text := lower(btrim(coalesce(new.segment, 'all')));
  v_title text := left(btrim(coalesce(new.title, 'Announcement from PyDebug')), 120);
  v_body text := left(btrim(coalesce(new.body, 'Tap to check the latest update on PyDebug.')), 240);
  v_link text := case
    when coalesce(new.url, '') ~ '^/[A-Za-z0-9_./?=&%#-]*$'
      and left(new.url, 2) <> '//'
      and new.url !~* '^/%(2f|5c)'
      and new.url !~* '%(0a|0d)'
    then new.url else '/dashboard'
  end;
begin
  if v_segment not in ('all', 'free', 'premium') then
    raise exception 'Invalid push announcement audience';
  end if;

  if to_regclass('public.notifications') is not null and to_regclass('public.profiles') is not null then
    begin
      insert into public.notifications (user_id, type, title, message, link, metadata)
      select p.id, 'announcement', v_title, v_body, v_link,
        jsonb_build_object('announcement_id', new.id, 'from_push_announcements', true,
                           'targeted_announcement', v_segment <> 'all')
      from public.profiles p
      where (
        v_segment = 'all'
        or (v_segment = 'premium' and coalesce(p.is_premium, false)
            and (p.premium_expires_at is null or p.premium_expires_at > now()))
        or (v_segment = 'free' and not (coalesce(p.is_premium, false)
            and (p.premium_expires_at is null or p.premium_expires_at > now())))
      )
      and not exists (
        select 1 from public.notifications n
        where n.user_id = p.id and n.type = 'announcement' and n.title = v_title
          and left(n.message, 240) = v_body and n.created_at >= now() - interval '2 minutes'
      );
    exception when others then
      -- Targeted announcements depend on the per-user fanout above. Failing
      -- the insert is safer than reporting success without those notifications.
      if v_segment <> 'all' then
        raise exception 'Targeted announcement failed; no announcement was sent: %', sqlerrm;
      end if;
      raise warning 'pydebug_on_push_announcement_insert feed sync failed: %', sqlerrm;
    end;
  end if;

  -- Per-user fanout above is used for targeted announcements. Never ask the
  -- global broadcast endpoint to send those announcements to every device.
  if v_segment <> 'all' then return new; end if;
  if lower(coalesce(current_setting('app.settings.push_instant', true), 'on')) <> 'off'
     and to_regnamespace('net') is not null then
    begin
      v_base := rtrim(coalesce(nullif(current_setting('app.settings.pydebug_api_base', true), ''), 'https://pydebug.in'), '/');
      perform net.http_post(
        url := v_base || '/api/push-send',
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body := jsonb_build_object('broadcast', 'announcements', 'source', 'db-trigger'),
        timeout_milliseconds := 8000
      );
    exception when others then
      raise warning 'pydebug_on_push_announcement_insert push failed: %', sqlerrm;
    end;
  end if;
  return new;
end;
$$;

-- The user-app migration normally installs this trigger. Reattach it only
-- when the announcement table exists; the admin RPC does not depend on it.
do $$
begin
  if to_regclass('public.push_announcements') is not null then
    drop trigger if exists pydebug_push_announcements_instant on public.push_announcements;
    create trigger pydebug_push_announcements_instant
      after insert on public.push_announcements
      for each row execute function public.pydebug_on_push_announcement_insert();
  end if;
end;
$$;

create or replace function public.admin_send_broadcast(
  p_request_id uuid,
  p_title text,
  p_message text,
  p_link text,
  p_type text,
  p_audience text,
  p_web_push boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin uuid := auth.uid();
  v_title text := btrim(coalesce(p_title, ''));
  v_message text := btrim(coalesce(p_message, ''));
  v_link text := nullif(btrim(coalesce(p_link, '')), '');
  v_payload jsonb;
  v_previous public.admin_broadcast_requests%rowtype;
  v_count integer;
begin
  if v_admin is null or not coalesce(public.is_admin(), false) then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  if p_request_id is null then raise exception 'A request ID is required'; end if;
  if char_length(v_title) not between 1 and 120 or char_length(v_message) not between 1 and 500 then
    raise exception 'Title or message is empty or too long';
  end if;
  if p_type is null or p_type not in ('announcement', 'new_problem', 'leaderboard_rank')
     or p_audience is null or p_audience not in ('all', 'free', 'premium')
     or p_web_push is null then
    raise exception 'Invalid category, audience, or push setting';
  end if;
  if v_link is not null and (
    char_length(v_link) > 200 or v_link !~ '^/[A-Za-z0-9_./?=&%#-]*$'
    or left(v_link, 2) = '//' or v_link ~* '^/%(2f|5c)' or v_link ~* '%(0a|0d)'
  ) then
    raise exception 'Link must be a safe in-app path';
  end if;

  v_payload := jsonb_build_object('title', v_title, 'message', v_message, 'link', v_link,
                                 'type', p_type, 'audience', p_audience, 'web_push', p_web_push);
  insert into public.admin_broadcast_requests (request_id, admin_id, payload)
    values (p_request_id, v_admin, v_payload) on conflict (request_id) do nothing;
  if not found then
    select * into v_previous from public.admin_broadcast_requests where request_id = p_request_id;
    if v_previous.admin_id is distinct from v_admin or v_previous.payload is distinct from v_payload then
      raise exception 'Request ID belongs to a different broadcast';
    end if;
    return jsonb_build_object('recipients', v_previous.recipients,
                              'web_push_enabled', p_web_push, 'already_processed', true);
  end if;

  if p_web_push and (
    lower(coalesce(current_setting('app.settings.push_instant', true), 'on')) = 'off'
    or to_regnamespace('net') is null or to_regclass('public.push_subscriptions') is null
  ) then
    raise exception 'Instant Web Push is unavailable; no broadcast was sent';
  end if;

  insert into public.notifications (user_id, type, title, message, link, is_read, metadata)
  select p.id, p_type, v_title, v_message, v_link, false,
    jsonb_build_object('source', 'admin_broadcast', 'broadcast_id', p_request_id, 'web_push', p_web_push)
  from public.profiles p
  where p_audience = 'all'
    or (p_audience = 'premium' and coalesce(p.is_premium, false)
        and (p.premium_expires_at is null or p.premium_expires_at > now()))
    or (p_audience = 'free' and not (coalesce(p.is_premium, false)
        and (p.premium_expires_at is null or p.premium_expires_at > now())));
  get diagnostics v_count = row_count;
  update public.admin_broadcast_requests set recipients = v_count where request_id = p_request_id;
  return jsonb_build_object('recipients', v_count, 'web_push_enabled', p_web_push, 'already_processed', false);
end;
$$;

revoke all on function public.admin_send_broadcast(uuid, text, text, text, text, text, boolean) from public, anon;
grant execute on function public.admin_send_broadcast(uuid, text, text, text, text, text, boolean) to authenticated;
notify pgrst, 'reload schema';
commit;
