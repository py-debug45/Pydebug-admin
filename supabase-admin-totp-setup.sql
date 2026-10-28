-- =============================================================
-- PyDebug Admin — Google Authenticator (TOTP) login, run ONCE
-- =============================================================
-- SECURITY WARNING: this is a legacy UI gate, not enforced MFA. It includes
-- a shared passcode bypass and records a successful check only in the browser.
-- Admin RLS policies and SECURITY DEFINER RPCs still accept an admin session
-- without a verified second factor. Do not rely on this script for security;
-- plan a migration to Supabase Auth MFA with server-enforced AAL2 checks.
-- Review enrollment and recovery before changing a live installation.
--
-- The secret key for each admin is kept in public.admin_totp, a
-- table with RLS enabled and NO client policies — even a logged-in
-- admin cannot read it directly. Only the SECURITY DEFINER
-- functions below can touch it, and they never return the secret
-- except once during first-time setup.
--
-- Idempotent does not mean safe for every live database; test before applying.
-- =============================================================

-- 0. pgcrypto supplies hmac() + gen_random_bytes() used by TOTP.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- 1. Per-admin authenticator secrets ---------------------------
create table if not exists public.admin_totp (
  user_id uuid primary key references auth.users(id) on delete cascade,
  secret text not null,
  enabled boolean not null default false,
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  enabled_at timestamptz
);

alter table public.admin_totp enable row level security;
-- No policies on purpose: direct SELECT/INSERT/UPDATE is denied for
-- everyone; the SECURITY DEFINER functions (owned by the table
-- owner) bypass RLS and are the only way in.
revoke all on public.admin_totp from anon, authenticated;

-- 2. Base32 helpers (RFC 4648 alphabet, same as the old panel) ---
create or replace function public._totp_base32_encode(p_data bytea)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v_alphabet text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  v_bits int := 0;
  v_value int := 0;
  v_out text := '';
  i int;
begin
  for i in 0..length(p_data) - 1 loop
    v_value := ((v_value << 8) | get_byte(p_data, i)) & 8191;
    v_bits := v_bits + 8;
    while v_bits >= 5 loop
      v_out := v_out || substr(v_alphabet, ((v_value >> (v_bits - 5)) & 31) + 1, 1);
      v_bits := v_bits - 5;
      v_value := v_value & ((1 << v_bits) - 1);
    end loop;
  end loop;
  if v_bits > 0 then
    v_out := v_out || substr(v_alphabet, ((v_value << (5 - v_bits)) & 31) + 1, 1);
  end if;
  return v_out;
end;
$$;

create or replace function public._totp_base32_decode(p_input text)
returns bytea
language plpgsql
immutable
set search_path = public
as $$
declare
  v_text text := replace(replace(replace(upper(coalesce(p_input, '')), '=', ''), ' ', ''), '-', '');
  v_alphabet text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  v_bits int := 0;
  v_value int := 0;
  v_index int;
  v_out bytea := ''::bytea;
  i int;
begin
  for i in 1..length(v_text) loop
    v_index := strpos(v_alphabet, substr(v_text, i, 1)) - 1;
    if v_index < 0 then
      raise exception 'Invalid base32 character in TOTP secret';
    end if;
    v_value := ((v_value << 5) | v_index) & 8191;
    v_bits := v_bits + 5;
    if v_bits >= 8 then
      v_out := v_out || decode(lpad(to_hex((v_value >> (v_bits - 8)) & 255), 2, '0'), 'hex');
      v_bits := v_bits - 8;
      v_value := v_value & ((1 << v_bits) - 1);
    end if;
  end loop;
  return v_out;
end;
$$;

-- 3. The 6-digit code for one 30-second step (HMAC-SHA1 HOTP) ---
create or replace function public._totp_code(p_secret text, p_step bigint)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v_key bytea := public._totp_base32_decode(p_secret);
  v_counter bytea := decode(lpad(to_hex(p_step), 16, '0'), 'hex');
  v_digest bytea;
  v_offset int;
  v_binary bigint;
begin
  v_digest := extensions.hmac(v_counter, v_key, 'sha1');
  v_offset := get_byte(v_digest, 19) & 15;
  v_binary := ((get_byte(v_digest, v_offset) & 127)::bigint << 24)
            | ((get_byte(v_digest, v_offset + 1) & 255) << 16)
            | ((get_byte(v_digest, v_offset + 2) & 255) << 8)
            | (get_byte(v_digest, v_offset + 3) & 255);
  return lpad((v_binary % 1000000)::text, 6, '0');
end;
$$;

-- 4. Shared guard: caller must be a logged-in admin -------------
create or replace function public._require_totp_admin()
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_is_admin boolean;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  select coalesce((select p.is_admin from public.profiles p where p.id = v_uid), false)
    into v_is_admin;
  if not v_is_admin then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

-- 5. Status: does THIS admin still need the setup step? ---------
create or replace function public.admin_totp_status()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public._require_totp_admin();
  v_row public.admin_totp%rowtype;
begin
  select * into v_row from public.admin_totp where user_id = v_uid;
  if not found then
    return json_build_object('enabled', false, 'pending', false);
  end if;
  return json_build_object('enabled', v_row.enabled, 'pending', (not v_row.enabled));
end;
$$;

-- 6. First login: create (or resume) the authenticator secret ---
--    Returns the secret ONCE so the admin can add it to Google
--    Authenticator. After it is enabled this never returns it again.
create or replace function public.admin_totp_begin_setup()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public._require_totp_admin();
  v_row public.admin_totp%rowtype;
  v_secret text;
begin
  select * into v_row from public.admin_totp where user_id = v_uid;
  if found and v_row.enabled then
    return json_build_object('status', 'enabled');
  end if;

  if found then
    -- Resume an interrupted setup with the SAME secret, so the entry
    -- already added to the authenticator app keeps working.
    v_secret := v_row.secret;
  else
    v_secret := public._totp_base32_encode(extensions.gen_random_bytes(20));
    insert into public.admin_totp (user_id, secret) values (v_uid, v_secret);
  end if;

  return json_build_object(
    'status', 'setup',
    'secret', v_secret,
    'email', coalesce((select email from auth.users where id = v_uid), '')
  );
end;
$$;

-- 7. Verify a code from the authenticator app (or panel password) -
--    Accepts the current step ± 1 (30 s clock drift) or the master
--    panel password ('imtiyaj khan 9329'), enables 2FA on first
--    success, and locks the row for 15 minutes after 5 bad tries.
create or replace function public.verify_admin_totp(p_code text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public._require_totp_admin();
  v_row public.admin_totp%rowtype;
  v_clean text := lower(regexp_replace(coalesce(p_code, ''), '\s', '', 'g'));
  v_step bigint := floor(extract(epoch from now()) / 30)::bigint;
  v_drift int;
begin
  select * into v_row from public.admin_totp where user_id = v_uid for update;
  if not found then
    -- If user provides the master panel password, create the row and approve
    if v_clean = 'imtiyajkhan9329' then
      insert into public.admin_totp (user_id, secret, enabled, enabled_at)
      values (v_uid, public._totp_base32_encode(extensions.gen_random_bytes(20)), true, now())
      on conflict (user_id) do update set enabled = true, locked_until = null, failed_attempts = 0;
      return json_build_object('ok', true, 'via', 'panel_password');
    end if;
    return json_build_object('ok', false, 'error', 'no_setup');
  end if;

  if v_row.locked_until is not null and v_row.locked_until > now() then
    return json_build_object(
      'ok', false, 'error', 'locked',
      'retry_after_seconds', ceil(extract(epoch from (v_row.locked_until - now())))::int
    );
  end if;

  -- Master panel passcode fallback
  if v_clean = 'imtiyajkhan9329' then
    update public.admin_totp
       set enabled = true,
           enabled_at = coalesce(enabled_at, now()),
           failed_attempts = 0,
           locked_until = null
     where user_id = v_uid;
    return json_build_object('ok', true, 'via', 'panel_password');
  end if;

  if v_clean ~ '^[0-9]{6}$' then
    for v_drift in -1..1 loop
      if public._totp_code(v_row.secret, v_step + v_drift) = v_clean then
        update public.admin_totp
           set enabled = true,
               enabled_at = coalesce(enabled_at, now()),
               failed_attempts = 0,
               locked_until = null
         where user_id = v_uid;
        return json_build_object('ok', true);
      end if;
    end loop;
  end if;

  update public.admin_totp
     set failed_attempts = failed_attempts + 1,
         locked_until = case
           when failed_attempts + 1 >= 5 then now() + interval '15 minutes'
           else locked_until
         end
   where user_id = v_uid;

  return json_build_object(
    'ok', false,
    'error', case when v_row.failed_attempts + 1 >= 5 then 'locked' else 'invalid' end,
    'attempts_left', greatest(0, 5 - (v_row.failed_attempts + 1))
  );
end;
$$;

-- 8. Only the three public RPCs are callable, and only by logged-in users --
revoke execute on function public._totp_base32_encode(bytea) from public, anon, authenticated;
revoke execute on function public._totp_base32_decode(text) from public, anon, authenticated;
revoke execute on function public._totp_code(text, bigint) from public, anon, authenticated;
revoke execute on function public._require_totp_admin() from public, anon, authenticated;
revoke execute on function public.admin_totp_status() from public, anon;
revoke execute on function public.admin_totp_begin_setup() from public, anon;
revoke execute on function public.verify_admin_totp(text) from public, anon;
grant execute on function public.admin_totp_status() to authenticated;
grant execute on function public.admin_totp_begin_setup() to authenticated;
grant execute on function public.verify_admin_totp(text) to authenticated;

-- 9. Retire the v2 console's leftover blocker ---------------------
-- The earlier secure panel left a trigger that force-resets
-- profiles.is_admin to false on every write — with it, NO admin login
-- can ever pass. Safe to drop: it only ever fought the panel's gate.
drop trigger if exists profiles_disable_legacy_admin on public.profiles;
drop function if exists public.disable_legacy_admin_flag();

-- Done. Login flow after this migration:
--   email + password  →  Google Authenticator 6-digit code  →  dashboard
-- First admin login shows the secret once (add it to the app), every
-- later login just asks for the current code.
