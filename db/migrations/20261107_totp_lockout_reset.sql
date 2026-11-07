-- -----------------------------------------------------------------------------
-- TOTP lockout: reset the attempt counter once the lock has expired.
--
-- After a lockout the row kept `failed_attempts = 5`, so the very first wrong
-- code after the 15 minutes immediately locked the account again. The counter
-- is now cleared when the lock expires, giving the admin a full set of tries.
-- Correct codes are unaffected (they already reset the row on success).
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

  -- Lock expired: start from a clean slate instead of carrying the old count.
  if v_row.locked_until is not null then
    update public.admin_totp
       set failed_attempts = 0, locked_until = null
     where user_id = v_uid;
    v_row.failed_attempts := 0;
    v_row.locked_until := null;
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
