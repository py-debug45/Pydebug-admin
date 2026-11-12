-- =============================================================
-- PyDebug Admin — authenticator (TOTP) enrolment reset
-- =============================================================
-- Use this when the admin phone is lost / the authenticator entry was
-- deleted / the old secret is simply not known any more.
--
-- What it does (nothing more):
--   * clears ONE admin's authenticator enrolment
--       enabled = false, enabled_at = null,
--       failed_attempts = 0, locked_until = null
--   * leaves the password, the is_admin flag and every other table alone
--   * the next login on index.html shows the setup screen again with a
--     NEW secret + QR ("Open authenticator app" link), and the first
--     correct 6-digit code enrols it for good
--
-- It deliberately does NOT return or reuse the old secret: a TOTP secret
-- that can be read back later is not a second factor. A fresh one is
-- generated on the next login by admin_totp_begin_setup().
--
-- Idempotent — safe to re-run. Run it in Supabase → SQL Editor.
-- Requires supabase-admin-totp-setup.sql to have been applied once.
-- =============================================================

-- ⚙️ CONFIG — put the admin email here --------------------------
-- (the same address used on the admin login page)
drop table if exists _pydebug_totp_reset_cfg;
create temp table _pydebug_totp_reset_cfg (
  email text not null
);

insert into _pydebug_totp_reset_cfg (email)
values ('avenjr80@gmail.com');   -- 👈 change if your admin email is different

revoke all on _pydebug_totp_reset_cfg from public;

-- 🔧 1. Reset the enrolment for that admin only -----------------
with target as (
  select p.id
    from public.profiles p
   where lower(p.email) = lower((select email from _pydebug_totp_reset_cfg))
),
cleared as (
  update public.admin_totp t
     set enabled = false,
         enabled_at = null,
         failed_attempts = 0,
         locked_until = null
   where t.user_id in (select id from target)
  returning t.user_id
),
fresh as (
  -- No row at all? Create one with a brand-new secret so the next login
  -- can resume an interrupted setup instead of erroring.
  insert into public.admin_totp (user_id, secret, enabled)
  select id,
         public._totp_base32_encode(extensions.gen_random_bytes(20)),
         false
    from target
   where not exists (select 1 from public.admin_totp t where t.user_id = target.id)
  on conflict (user_id) do nothing
  returning user_id
)
select
  (select count(*) from target)  as admin_rows_found,
  (select count(*) from cleared) as enrolment_cleared,
  (select count(*) from fresh)   as enrolment_created;

-- 🔍 2. Verification — `next_login_shows_setup` must be `true` --
select p.email,
       p.is_admin,
       t.enabled,
       t.failed_attempts,
       t.locked_until,
       (not coalesce(t.enabled, false)) as next_login_shows_setup
  from public.profiles p
  left join public.admin_totp t on t.user_id = p.id
 where lower(p.email) = lower((select email from _pydebug_totp_reset_cfg));

-- If 1 row comes back with next_login_shows_setup = true, you are done:
--   1. open the admin panel → email + password
--   2. the setup screen shows the new secret / QR
--   3. add it to Google Authenticator (Authy / 1Password work too)
--   4. enter the 6-digit code → the panel opens
--
-- Notes
--   * 5 wrong codes lock the check for 15 minutes; the counter clears
--     itself once the lock expires (20261107_totp_lockout_reset.sql).
--   * There is no master passcode and no code path that reveals an
--     existing secret — by design (20261107_remove_totp_master_passcode.sql).
--   * The same reset is available inside the panel as
--     Settings → Security → "Lost the authenticator app?" (copyable SQL).
