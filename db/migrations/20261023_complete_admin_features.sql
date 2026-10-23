-- =============================================================
-- PyDebug Admin & Platform — Complete Feature & Compatibility Migration
-- Idempotent: safe to run multiple times in Supabase SQL Editor.
-- =============================================================

-- 1. Additive columns on problems (SEO slugs, Hindi toggle, coding judge test cases)
alter table public.problems add column if not exists slug text;
alter table public.problems add column if not exists title_hi text;
alter table public.problems add column if not exists description_hi text;
alter table public.problems add column if not exists hints_hi jsonb default '[]'::jsonb;
alter table public.problems add column if not exists test_cases jsonb default '[]'::jsonb;
alter table public.problems add column if not exists admin_skip_notification boolean default false;

-- Backfill clean, collision-free slugs for problems missing one
with normalized as (
  select
    id,
    problem_number,
    created_at,
    coalesce(
      nullif(trim(both '-' from regexp_replace(lower(coalesce(title, '')), '[^a-z0-9]+', '-', 'g')), ''),
      'python-problem'
    ) as base_slug
  from public.problems
  where slug is null or btrim(slug) = ''
),
ranked as (
  select
    n.id,
    n.problem_number,
    n.base_slug,
    row_number() over (partition by n.base_slug order by n.problem_number asc nulls last, n.created_at asc, n.id asc) as rn,
    exists (
      select 1 from public.problems ex
      where ex.slug = n.base_slug and ex.id <> n.id
    ) as base_taken
  from normalized n
)
update public.problems p
set slug = case
  when r.rn = 1 and not r.base_taken then r.base_slug
  else r.base_slug || '-' || coalesce(r.problem_number::text || '-', '') || left(r.id::text, 6)
end
from ranked r
where p.id = r.id;

create unique index if not exists problems_slug_unique_idx
  on public.problems (slug)
  where slug is not null and btrim(slug) <> '';

-- 2. Fix duplicate notification triggers on problems & problem_discussions
-- Drop legacy duplicate trigger on problems (pydebug_notify_on_new_problem remains authoritative)
drop trigger if exists on_new_problem on public.problems;

create or replace function public.pydebug_notify_on_new_problem()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_type text;
  v_difficulty text;
  v_label text;
begin
  if coalesce(new.admin_skip_notification, false) then
    return new;
  end if;

  v_type := lower(trim(coalesce(new.type, '')));
  if v_type not in ('bug', 'question', 'coding') then
    return new;
  end if;

  v_label := case v_type
    when 'bug' then 'Fix the Bug'
    when 'coding' then 'Write Code'
    else 'Predict the Output'
  end;
  v_difficulty := trim(coalesce(new.difficulty, ''));

  begin
    insert into public.notifications (user_id, type, title, message, link, metadata)
    select
      p.id,
      'new_problem',
      'New Problem Added!',
      left(
        '"' || coalesce(nullif(trim(new.title), ''), 'A new problem') || '" - '
        || v_label
        || case when v_difficulty <> '' then ' (' || v_difficulty || ')' else '' end,
        180
      ),
      case
        when new.slug is not null and btrim(new.slug) <> '' then '/problems/' || new.slug
        else '/problem?id=' || new.id::text
      end,
      jsonb_build_object('problem_id', new.id, 'problem_number', new.problem_number)
    from public.profiles p
    where not exists (
      select 1
      from public.notifications n
      where n.user_id = p.id
        and n.type = 'new_problem'
        and n.created_at >= now() - interval '12 hours'
    );
  exception when others then
    null;
  end;

  return new;
end;
$$;

-- Prevent duplicate raw-UUID reply notifications when pydebug_notify_on_reply is active
do $$
begin
  if exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'problem_discussions' and t.tgname = 'pydebug_notify_on_reply'
  ) then
    create or replace function public.notify_discussion_reply()
    returns trigger
    language plpgsql
    security definer
    set search_path = public
    as $fn$
    declare
      commenter_record record;
      v_actor text;
    begin
      -- Direct replies are handled cleanly by pydebug_notify_on_reply
      if new.parent_comment_id is not null then
        return new;
      end if;

      begin
        v_actor := left(coalesce(public.pydebug_actor_name(new.user_id), 'A learner'), 60);
      exception when others then
        v_actor := 'A learner';
      end;

      for commenter_record in
        select distinct user_id
        from public.problem_discussions
        where problem_id = new.problem_id
          and user_id is not null
          and user_id <> new.user_id
          and id <> new.id
      loop
        insert into public.notifications (user_id, type, title, message, link, metadata)
        values (
          commenter_record.user_id,
          'reply',
          'New comment in a discussion you joined',
          v_actor || ' commented: "' || left(coalesce(new.content, ''), 60) || '"',
          '/problem?id=' || new.problem_id,
          jsonb_build_object('problem_id', new.problem_id, 'comment_id', new.id, 'reply_by', new.user_id)
        );
      end loop;

      return new;
    exception when others then
      return new;
    end;
    $fn$;
  end if;
end $$;

-- 3. New tables for Institute Enquiries, Learner Feedback, Classrooms & Shared Snippets
create table if not exists public.institute_enquiries (
  id uuid primary key default gen_random_uuid(),
  contact_name text not null check (char_length(btrim(contact_name)) between 1 and 120),
  institute_name text not null check (char_length(btrim(institute_name)) between 1 and 160),
  work_email text not null check (char_length(btrim(work_email)) between 3 and 160),
  student_count integer check (student_count is null or (student_count >= 1 and student_count <= 100000)),
  primary_goal text,
  expected_start text,
  notes text check (notes is null or char_length(notes) <= 3000),
  status text not null default 'new' check (status in ('new', 'contacted', 'pilot_active', 'closed')),
  admin_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.institute_enquiries enable row level security;
drop policy if exists "Anyone can submit institute enquiry" on public.institute_enquiries;
create policy "Anyone can submit institute enquiry"
  on public.institute_enquiries for insert
  with check (status = 'new' and admin_notes is null);
drop policy if exists "Admins can manage institute enquiries" on public.institute_enquiries;
create policy "Admins can manage institute enquiries"
  on public.institute_enquiries for all
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

create table if not exists public.learner_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  content text not null check (char_length(btrim(content)) between 10 and 1500),
  consent_publish boolean not null default false,
  approved boolean not null default false,
  approved_by uuid references public.profiles(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id)
);
alter table public.learner_feedback enable row level security;
drop policy if exists "Users read own or approved feedback" on public.learner_feedback;
create policy "Users read own or approved feedback"
  on public.learner_feedback for select
  using (auth.uid() = user_id or (consent_publish = true and approved = true) or (select public.is_admin()));
drop policy if exists "Users insert own feedback" on public.learner_feedback;
create policy "Users insert own feedback"
  on public.learner_feedback for insert
  with check (auth.uid() = user_id and approved = false);
drop policy if exists "Users update own feedback" on public.learner_feedback;
create policy "Users update own feedback"
  on public.learner_feedback for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id and approved = false);
drop policy if exists "Admins manage learner feedback" on public.learner_feedback;
create policy "Admins manage learner feedback"
  on public.learner_feedback for all
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

create table if not exists public.classrooms (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid references public.profiles(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 2 and 120),
  institute_name text,
  join_code text not null unique check (char_length(btrim(join_code)) between 4 and 24),
  syllabus_goal text default 'python_basics',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.classrooms enable row level security;
drop policy if exists "Teachers and admins manage classrooms" on public.classrooms;
create policy "Teachers and admins manage classrooms"
  on public.classrooms for all
  using (auth.uid() = teacher_id or (select public.is_admin()))
  with check (auth.uid() = teacher_id or (select public.is_admin()));
drop policy if exists "Authenticated users view active classrooms" on public.classrooms;
create policy "Authenticated users view active classrooms"
  on public.classrooms for select
  to authenticated
  using (is_active = true);

create table if not exists public.classroom_members (
  classroom_id uuid not null references public.classrooms(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (classroom_id, student_id)
);
alter table public.classroom_members enable row level security;
drop policy if exists "Students join and view own classroom membership" on public.classroom_members;
create policy "Students join and view own classroom membership"
  on public.classroom_members for select
  using (
    auth.uid() = student_id
    or exists (select 1 from public.classrooms c where c.id = classroom_id and c.teacher_id = auth.uid())
    or (select public.is_admin())
  );
drop policy if exists "Students insert own classroom membership" on public.classroom_members;
create policy "Students insert own classroom membership"
  on public.classroom_members for insert
  with check (auth.uid() = student_id or (select public.is_admin()));
drop policy if exists "Admins and teachers remove classroom members" on public.classroom_members;
create policy "Admins and teachers remove classroom members"
  on public.classroom_members for delete
  using (
    auth.uid() = student_id
    or exists (select 1 from public.classrooms c where c.id = classroom_id and c.teacher_id = auth.uid())
    or (select public.is_admin())
  );

create table if not exists public.shared_snippets (
  slug text primary key check (slug ~ '^[a-zA-Z0-9_-]{4,32}$'),
  user_id uuid references public.profiles(id) on delete set null,
  title text not null default 'Untitled snippet' check (char_length(title) <= 120),
  code text not null check (char_length(code) between 1 and 50000),
  views integer not null default 0,
  is_public boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.shared_snippets enable row level security;
drop policy if exists "Public can read shared snippets" on public.shared_snippets;
create policy "Public can read shared snippets"
  on public.shared_snippets for select
  using (is_public = true or auth.uid() = user_id or (select public.is_admin()));
drop policy if exists "Authenticated users create snippets" on public.shared_snippets;
create policy "Authenticated users create snippets"
  on public.shared_snippets for insert
  to authenticated
  with check (auth.uid() = user_id);
drop policy if exists "Admins manage shared snippets" on public.shared_snippets;
create policy "Admins manage shared snippets"
  on public.shared_snippets for all
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- 4. Admin RLS policies across all newer user-app tables
do $$
begin
  if to_regclass('public.user_certificates') is not null then
    execute 'drop policy if exists "Admins can read all certificates" on public.user_certificates';
    execute 'create policy "Admins can read all certificates" on public.user_certificates for select using ((select public.is_admin()))';
  end if;

  if to_regclass('public.mock_attempts') is not null then
    execute 'drop policy if exists "Admins can read all mock attempts" on public.mock_attempts';
    execute 'create policy "Admins can read all mock attempts" on public.mock_attempts for select using ((select public.is_admin()))';
  end if;

  if to_regclass('public.battles') is not null then
    execute 'drop policy if exists "Admins can read all battles" on public.battles';
    execute 'create policy "Admins can read all battles" on public.battles for select using ((select public.is_admin()))';
  end if;

  if to_regclass('public.community_posts') is not null then
    execute 'drop policy if exists "Admins can read all community posts" on public.community_posts';
    execute 'create policy "Admins can read all community posts" on public.community_posts for select using ((select public.is_admin()))';
    execute 'drop policy if exists "Admins can delete community posts" on public.community_posts';
    execute 'create policy "Admins can delete community posts" on public.community_posts for delete using ((select public.is_admin()))';
  end if;

  if to_regclass('public.discussion_flags') is not null then
    execute 'drop policy if exists "Admins can manage discussion flags" on public.discussion_flags';
    execute 'create policy "Admins can manage discussion flags" on public.discussion_flags for all using ((select public.is_admin())) with check ((select public.is_admin()))';
  end if;

  if to_regclass('public.payment_orders') is not null then
    execute 'drop policy if exists "Admins can read all payment orders" on public.payment_orders';
    execute 'create policy "Admins can read all payment orders" on public.payment_orders for select using ((select public.is_admin()))';
  end if;

  if to_regclass('public.product_entitlements') is not null then
    execute 'drop policy if exists "Admins can manage product entitlements" on public.product_entitlements';
    execute 'create policy "Admins can manage product entitlements" on public.product_entitlements for all using ((select public.is_admin())) with check ((select public.is_admin()))';
  end if;

  if to_regclass('public.push_announcements') is not null then
    execute 'drop policy if exists "Admins can manage push announcements" on public.push_announcements';
    execute 'create policy "Admins can manage push announcements" on public.push_announcements for all using ((select public.is_admin())) with check ((select public.is_admin()))';
  end if;

  if to_regclass('public.push_subscriptions') is not null then
    execute 'drop policy if exists "Admins can read push subscriptions" on public.push_subscriptions';
    execute 'create policy "Admins can read push subscriptions" on public.push_subscriptions for select using ((select public.is_admin()))';
  end if;

  if to_regclass('public.push_broadcast_log') is not null then
    execute 'drop policy if exists "Admins can read push broadcast log" on public.push_broadcast_log';
    execute 'create policy "Admins can read push broadcast log" on public.push_broadcast_log for select using ((select public.is_admin()))';
  end if;

  if to_regclass('public.study_plans') is not null then
    execute 'drop policy if exists "Admins can read all study plans" on public.study_plans';
    execute 'create policy "Admins can read all study plans" on public.study_plans for select using ((select public.is_admin()))';
  end if;

  if to_regclass('public.referrals') is not null then
    execute 'drop policy if exists "Admins can manage referrals" on public.referrals';
    execute 'create policy "Admins can manage referrals" on public.referrals for all using ((select public.is_admin())) with check ((select public.is_admin()))';
  end if;

  if to_regclass('public.teacher_history') is not null then
    execute 'drop policy if exists "Admins can read teacher history" on public.teacher_history';
    execute 'create policy "Admins can read teacher history" on public.teacher_history for select using ((select public.is_admin()))';
  end if;

  if to_regclass('public.teacher_usage') is not null then
    execute 'drop policy if exists "Admins can read teacher usage" on public.teacher_usage';
    execute 'create policy "Admins can read teacher usage" on public.teacher_usage for select using ((select public.is_admin()))';
  end if;
end $$;

-- 5a. Upgraded admin_panel_update_profile RPC
-- Fixes client self-write guard rejection during verified admin updates,
-- adds account moderation (status, status_reason, status_until), and writes audit log.
create or replace function public.admin_panel_update_profile(target_user uuid, patch jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid := auth.uid();
  v_prev_sub text := current_setting('request.jwt.claim.sub', true);
  v_prev_claims text := current_setting('request.jwt.claims', true);
  v_status text;
  v_action text := 'user_updated';
begin
  if v_caller is null or not coalesce(public.is_admin(), false) then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  if jsonb_typeof(patch) <> 'object' or exists (
    select 1 from jsonb_object_keys(patch) k
    where k not in (
      'display_name', 'xp', 'monthly_xp', 'streak', 'streak_freezes',
      'is_premium', 'premium_expires_at', 'is_admin',
      'status', 'status_reason', 'status_until'
    )
  ) then
    raise exception 'Invalid profile fields' using errcode = '22023';
  end if;

  if target_user = v_caller and patch->>'is_admin' = 'false' then
    raise exception 'Cannot remove your own admin access' using errcode = '42501';
  end if;

  if target_user = v_caller and patch ? 'status' and coalesce(patch->>'status', 'active') <> 'active' then
    raise exception 'Cannot suspend or ban your own admin account' using errcode = '42501';
  end if;

  if patch ? 'status' then
    v_status := coalesce(nullif(btrim(patch->>'status'), ''), 'active');
    if v_status not in ('active', 'muted', 'suspended', 'banned') then
      raise exception 'Invalid account status' using errcode = '22023';
    end if;
  end if;

  -- Run internal profile mutation as trusted server context so learner self-write
  -- triggers (guard_profile_self_write / prevent_self_premium_grant) allow admin changes.
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);

  update public.profiles p set
    display_name = case when patch ? 'display_name' then nullif(btrim(patch->>'display_name'), '') else p.display_name end,
    xp = case when patch ? 'xp' then greatest(0, (patch->>'xp')::integer) else p.xp end,
    monthly_xp = case when patch ? 'monthly_xp' then greatest(0, (patch->>'monthly_xp')::integer) else p.monthly_xp end,
    streak = case when patch ? 'streak' then greatest(0, (patch->>'streak')::integer) else p.streak end,
    streak_freezes = case when patch ? 'streak_freezes' then greatest(0, (patch->>'streak_freezes')::integer) else p.streak_freezes end,
    is_premium = case when patch ? 'is_premium' then (patch->>'is_premium')::boolean else p.is_premium end,
    premium_expires_at = case when patch ? 'premium_expires_at' then (patch->>'premium_expires_at')::timestamptz else p.premium_expires_at end,
    is_admin = case when patch ? 'is_admin' then (patch->>'is_admin')::boolean else p.is_admin end,
    status = case when patch ? 'status' then v_status else p.status end,
    status_reason = case when patch ? 'status_reason' then nullif(btrim(patch->>'status_reason'), '') else p.status_reason end,
    status_until = case when patch ? 'status_until' then (patch->>'status_until')::timestamptz else p.status_until end
  where p.id = target_user;

  perform set_config('request.jwt.claim.sub', coalesce(v_prev_sub, ''), true);
  perform set_config('request.jwt.claims', coalesce(v_prev_claims, ''), true);

  if not found then
    raise exception 'Profile not found' using errcode = 'P0002';
  end if;

  if patch ? 'is_premium' then
    v_action := case when (patch->>'is_premium')::boolean then 'premium_granted' else 'premium_revoked' end;
  elsif patch ? 'status' then
    v_action := 'user_status_' || v_status;
  end if;

  begin
    insert into public.admin_audit_log (admin_id, action, entity_type, entity_id, target_id, new_value, metadata)
    values (v_caller, v_action, 'profile', target_user::text, target_user::text, patch, patch);
  exception when others then
    null;
  end;
end;
$$;

revoke all on function public.admin_panel_update_profile(uuid, jsonb) from public, anon;
grant execute on function public.admin_panel_update_profile(uuid, jsonb) to authenticated;

-- 5b. Certificate revocation RPC (honours protect_certificate_snapshot trigger)
create or replace function public.admin_revoke_certificate(target_verify_id text, revoke_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid := auth.uid();
  v_prev_sub text := current_setting('request.jwt.claim.sub', true);
  v_prev_claims text := current_setting('request.jwt.claims', true);
  v_existing timestamptz;
begin
  if v_caller is null or not coalesce(public.is_admin(), false) then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  if target_verify_id is null or btrim(target_verify_id) = '' then
    raise exception 'Certificate ID required' using errcode = '22023';
  end if;

  select c.revoked_at into v_existing
  from public.user_certificates c
  where c.verify_id = btrim(target_verify_id);

  if not found then
    raise exception 'Certificate not found' using errcode = 'P0002';
  end if;

  if v_existing is not null then
    raise exception 'Certificate is already revoked' using errcode = '22023';
  end if;

  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);

  update public.user_certificates
  set revoked_at = now()
  where verify_id = btrim(target_verify_id)
    and revoked_at is null;

  perform set_config('request.jwt.claim.sub', coalesce(v_prev_sub, ''), true);
  perform set_config('request.jwt.claims', coalesce(v_prev_claims, ''), true);

  begin
    insert into public.admin_audit_log (admin_id, action, entity_type, entity_id, target_id, reason, metadata)
    values (
      v_caller,
      'certificate_revoked',
      'user_certificate',
      btrim(target_verify_id),
      btrim(target_verify_id),
      nullif(btrim(coalesce(revoke_reason, '')), ''),
      jsonb_build_object('verify_id', btrim(target_verify_id), 'reason', nullif(btrim(coalesce(revoke_reason, '')), ''))
    );
  exception when others then
    null;
  end;
end;
$$;

revoke all on function public.admin_revoke_certificate(text, text) from public, anon;
grant execute on function public.admin_revoke_certificate(text, text) to authenticated;

-- 5c. Community post moderation RPC (deletes replies + post cleanly + audits)
create or replace function public.admin_delete_community_post(target_post_id uuid, delete_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid := auth.uid();
  v_author uuid;
  v_excerpt text;
begin
  if v_caller is null or not coalesce(public.is_admin(), false) then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  select p.user_id, left(p.content, 140)
    into v_author, v_excerpt
  from public.community_posts p
  where p.id = target_post_id;

  if not found then
    raise exception 'Community post not found' using errcode = 'P0002';
  end if;

  delete from public.community_posts where parent_post_id = target_post_id;
  delete from public.community_posts where id = target_post_id;

  begin
    insert into public.admin_audit_log (admin_id, action, entity_type, entity_id, target_id, reason, metadata)
    values (
      v_caller,
      'community_post_deleted',
      'community_post',
      target_post_id::text,
      target_post_id::text,
      nullif(btrim(coalesce(delete_reason, '')), ''),
      jsonb_build_object('author_id', v_author, 'excerpt', v_excerpt)
    );
  exception when others then
    null;
  end;
end;
$$;

revoke all on function public.admin_delete_community_post(uuid, text) from public, anon;
grant execute on function public.admin_delete_community_post(uuid, text) to authenticated;

-- 5d. Discussion flag resolution RPC
create or replace function public.admin_resolve_discussion_flag(
  target_flag_id uuid,
  resolution_text text default 'reviewed',
  delete_comment boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid := auth.uid();
  v_disc_id uuid;
begin
  if v_caller is null or not coalesce(public.is_admin(), false) then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  select f.discussion_id into v_disc_id
  from public.discussion_flags f
  where f.id = target_flag_id;

  if not found then
    raise exception 'Flag not found' using errcode = 'P0002';
  end if;

  update public.discussion_flags
  set
    resolved_by = v_caller,
    resolved_at = now(),
    resolution = coalesce(nullif(btrim(resolution_text), ''), case when delete_comment then 'comment_deleted' else 'dismissed' end)
  where id = target_flag_id;

  if delete_comment and v_disc_id is not null then
    delete from public.discussion_likes where comment_id = v_disc_id;
    delete from public.problem_discussions where parent_comment_id = v_disc_id;
    delete from public.problem_discussions where id = v_disc_id;
  end if;

  begin
    insert into public.admin_audit_log (admin_id, action, entity_type, entity_id, target_id, metadata)
    values (
      v_caller,
      'discussion_flag_resolved',
      'discussion_flag',
      target_flag_id::text,
      target_flag_id::text,
      jsonb_build_object('discussion_id', v_disc_id, 'deleted_comment', delete_comment, 'resolution', resolution_text)
    );
  exception when others then
    null;
  end;
end;
$$;

revoke all on function public.admin_resolve_discussion_flag(uuid, text, boolean) from public, anon;
grant execute on function public.admin_resolve_discussion_flag(uuid, text, boolean) to authenticated;

-- 5e. Product entitlement management RPC (Pro / Exam Pack)
create or replace function public.admin_manage_entitlement(
  target_user uuid,
  target_product text,
  expires timestamptz default null,
  revoke boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid := auth.uid();
  v_prod text := lower(btrim(coalesce(target_product, '')));
begin
  if v_caller is null or not coalesce(public.is_admin(), false) then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  if v_prod not in ('pro', 'exam_pack') then
    raise exception 'Invalid product key (expected pro or exam_pack)' using errcode = '22023';
  end if;

  if revoke then
    delete from public.product_entitlements
    where user_id = target_user and product_key = v_prod;
  else
    insert into public.product_entitlements (user_id, product_key, expires_at, updated_at)
    values (
      target_user,
      v_prod,
      coalesce(expires, now() + interval '365 days'),
      now()
    )
    on conflict (user_id, product_key) do update
    set expires_at = excluded.expires_at,
        updated_at = now();
  end if;

  begin
    insert into public.admin_audit_log (admin_id, action, entity_type, entity_id, target_id, metadata)
    values (
      v_caller,
      case when revoke then 'entitlement_revoked' else 'entitlement_granted' end,
      'product_entitlement',
      target_user::text,
      target_user::text,
      jsonb_build_object('product_key', v_prod, 'expires_at', expires, 'revoked', revoke)
    );
  exception when others then
    null;
  end;
end;
$$;

revoke all on function public.admin_manage_entitlement(uuid, text, timestamptz, boolean) from public, anon;
grant execute on function public.admin_manage_entitlement(uuid, text, timestamptz, boolean) to authenticated;

-- 5f. Notification bloat hygiene RPC
-- Keeps each user's newest 3 `new_problem` alerts when older_than_days = 0,
-- or prunes auto-generated notifications older than N days.
create or replace function public.admin_prune_notifications(
  older_than_days integer default 7,
  auto_only boolean default true
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid := auth.uid();
  v_deleted integer := 0;
begin
  if v_caller is null or not coalesce(public.is_admin(), false) then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  if coalesce(older_than_days, 7) <= 0 then
    with ranked as (
      select
        id,
        row_number() over (partition by user_id, coalesce(type, 'new_problem') order by created_at desc) as rn
      from public.notifications
      where (not auto_only)
         or coalesce(type, '') in ('new_problem', 'streak_warning', 'leaderboard_rank')
         or title in ('📝 New Problem Added!', 'New Problem Added!', '🔥 Your streak is at risk!')
    ),
    del as (
      delete from public.notifications n
      using ranked r
      where n.id = r.id and r.rn > 3
      returning n.id
    )
    select count(*) into v_deleted from del;
  else
    with del as (
      delete from public.notifications n
      where n.created_at < now() - make_interval(days => older_than_days)
        and (
          (not auto_only)
          or coalesce(n.type, '') in ('new_problem', 'streak_warning', 'leaderboard_rank')
          or n.title in ('📝 New Problem Added!', 'New Problem Added!', '🔥 Your streak is at risk!')
        )
      returning n.id
    )
    select count(*) into v_deleted from del;
  end if;

  begin
    insert into public.admin_audit_log (admin_id, action, entity_type, entity_id, metadata)
    values (
      v_caller,
      'notifications_pruned',
      'notifications',
      'bulk',
      jsonb_build_object('deleted', v_deleted, 'older_than_days', older_than_days, 'auto_only', auto_only)
    );
  exception when others then
    null;
  end;

  return v_deleted;
end;
$$;

revoke all on function public.admin_prune_notifications(integer, boolean) from public, anon;
grant execute on function public.admin_prune_notifications(integer, boolean) to authenticated;

-- 5g. Instant push trigger guard (honours admin_skip_notification & status = published)
create or replace function public.pydebug_push_new_problems_instantly()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base text;
  v_rows int;
begin
  if to_regclass('public.problems') is null then return null; end if;
  if lower(coalesce(current_setting('app.settings.push_instant', true), 'on')) = 'off' then return null; end if;
  if to_regnamespace('net') is null then
    raise notice 'pydebug instant new-problem push: pg_net not installed - skipping (daily cron still delivers)';
    return null;
  end if;
  select count(*) into v_rows
    from new_rows
   where not coalesce(admin_skip_notification, false)
     and lower(trim(coalesce(type, ''))) in ('bug', 'question', 'coding')
     and coalesce(status, 'published') = 'published';
  if v_rows = 0 then return null; end if;
  v_base := rtrim(
    coalesce(nullif(current_setting('app.settings.pydebug_api_base', true), ''), 'https://pydebug.in'),
    '/'
  );
  perform net.http_post(
    url := v_base || '/api/push-send',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object('broadcast', 'new_problems', 'source', 'db-trigger'),
    timeout_milliseconds := 5000
  );
  return null;
exception when others then
  raise warning 'pydebug instant new-problem push: webhook dispatch failed: %', sqlerrm;
  return null;
end;
$$;

notify pgrst, 'reload schema';
