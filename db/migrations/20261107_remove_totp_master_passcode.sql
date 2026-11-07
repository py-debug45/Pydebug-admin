-- -----------------------------------------------------------------------------
-- Remove the hard-coded master panel passcode from the 2FA check.
--
-- `verify_admin_totp()` used to accept a fixed string in two places: as a
-- fallback when no authenticator row existed (it would even create and enable
-- one), and as an alternative to the 6-digit code. Because the same string was
-- also shipped in `js/admin-login.js` and shown on the login page, it was a
-- public 2FA bypass.
--
-- After this migration the only accepted input is a real TOTP code (30 s step,
-- ±1 step drift), with the existing 5-attempts / 15-minute lockout. Breaking
-- the enrolment is a deliberate, owner-only SQL action — see
-- `settings.html` → Security → "Lost the authenticator app?".
-- -----------------------------------------------------------------------------

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
    return json_build_object('ok', false, 'error', 'no_setup');
  end if;

  if v_row.locked_until is not null and v_row.locked_until > now() then
    return json_build_object(
      'ok', false, 'error', 'locked',
      'retry_after_seconds', ceil(extract(epoch from (v_row.locked_until - now())))::int
    );
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

revoke all on function public.verify_admin_totp(text) from public, anon;
grant execute on function public.verify_admin_totp(text) to authenticated;
