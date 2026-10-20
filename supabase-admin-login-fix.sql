-- =============================================================
-- PyDebug Admin — "admin login nahi ho raha" one-shot fix
-- =============================================================
-- Run this ONCE in Supabase → SQL Editor when the admin panel says
-- "Invalid login credentials", "This account is not an admin yet",
-- "Admin check failed" or keeps bouncing back to the login page.
--
-- It is idempotent (safe to re-run) and does exactly this:
--   1. confirms the account's email   (Supabase refuses sign-in until then)
--   2. sets a known account password  (bcrypt, the same hash GoTrue expects)
--   3. creates the profiles row if the signup trigger never made one
--   4. sets profiles.is_admin = true  (the panel's gate)
--   5. makes sure profiles has an "own row" SELECT policy, so the panel can
--      actually read is_admin for the logged-in account
--   6. prints a verification table at the end
--
-- >>> EDIT THE TWO VALUES BELOW, THEN RUN THE WHOLE FILE. <<<
-- =============================================================

-- ⚙️ CONFIG ---------------------------------------------------
drop table if exists _pydebug_login_fix_cfg;
create temp table _pydebug_login_fix_cfg (
  email        text not null,   -- <<< your admin email
  new_password text             -- <<< new account password ('' = keep current)
);

insert into _pydebug_login_fix_cfg (email, new_password)
values (
  'avenjr80@gmail.com',   -- 👈 change if your admin email is different
  'Imtiyaj khan 9329'     -- 👈 this becomes the ACCOUNT password too
);

-- Do not show these rows to anyone else; already revoked from the panel.
revoke all on _pydebug_login_fix_cfg from public;

-- 🔧 0. Make sure the helpers/columns exist -------------------
set search_path = public, extensions;
create extension if not exists pgcrypto with schema extensions;

alter table public.profiles add column if not exists is_admin boolean default false;
alter table public.profiles enable row level security;

-- 🔐 1–4. The actual fix -------------------------------------
do $$
declare
  v_email        text;
  v_password     text;
  v_user_id      uuid;
  v_user_email   text;
  v_name         text;
  v_has_email    boolean;
  v_has_fullname boolean;
begin
  select email, new_password into v_email, v_password
  from _pydebug_login_fix_cfg limit 1;

  select u.id,
         u.email,
         coalesce(nullif(u.raw_user_meta_data->>'full_name', ''), split_part(u.email, '@', 1))
    into v_user_id, v_user_email, v_name
  from auth.users u
  where lower(u.email) = lower(v_email)
  limit 1;

  if v_user_id is null then
    raise exception
      'No Supabase auth user exists for "%". Create it first: Authentication → Users → Add user (tick Auto Confirm), then re-run this script.',
      v_email;
  end if;

  -- 1. Confirm the email. An unconfirmed address always returns
  --    "Email not confirmed" / "Invalid login credentials".
  update auth.users
     set email_confirmed_at = coalesce(email_confirmed_at, now()),
         updated_at = now()
   where id = v_user_id;
  raise notice '1/5 ✓ email confirmed for %', v_user_email;

  -- 2. Set a known password (bcrypt hash, same format GoTrue stores).
  if coalesce(btrim(v_password), '') <> '' then
    update auth.users
       set encrypted_password = crypt(v_password, gen_salt('bf')),
           updated_at = now()
     where id = v_user_id;
    raise notice '2/5 ✓ account password set — log in with the value in new_password';
  else
    raise notice '2/5 · password left unchanged (new_password was empty)';
  end if;

  -- 2b. A password identity is normally created at signup; add one if a
  --     hard-deleted/re-created user lost it. Best effort only.
  if not exists (
    select 1 from auth.identities where user_id = v_user_id and provider = 'email'
  ) then
    begin
      insert into auth.identities (
        id, user_id, provider, provider_id, identity_data,
        last_sign_in_at, created_at, updated_at
      ) values (
        gen_random_uuid(), v_user_id, 'email', v_user_id::text,
        jsonb_build_object('sub', v_user_id::text, 'email', v_user_email, 'email_verified', true),
        now(), now(), now()
      );
      raise notice '   ✓ missing email identity re-created';
    exception when others then
      raise notice '   · identity row skipped (%)', sqlerrm;
    end;
  end if;

  -- 3. profiles row — the panel reads is_admin from here.
  if not exists (select 1 from public.profiles where id = v_user_id) then
    select exists (
             select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'profiles' and column_name = 'email'
           ),
           exists (
             select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'profiles' and column_name = 'full_name'
           )
      into v_has_email, v_has_fullname;

    begin
      if v_has_email and v_has_fullname then
        insert into public.profiles (id, full_name, email) values (v_user_id, v_name, v_user_email);
      elsif v_has_fullname then
        insert into public.profiles (id, full_name) values (v_user_id, v_name);
      elsif v_has_email then
        insert into public.profiles (id, email) values (v_user_id, v_user_email);
      else
        insert into public.profiles (id) values (v_user_id);
      end if;
      raise notice '3/5 ✓ missing profiles row created';
    exception when others then
      raise notice '3/5 ✗ could not insert profiles row (%): create it manually in Table Editor → profiles', sqlerrm;
    end;
  else
    raise notice '3/5 · profiles row already existed';
  end if;

  -- 4. Grant admin.
  update public.profiles set is_admin = true where id = v_user_id;
  if found then
    raise notice '4/5 ✓ profiles.is_admin = true';
  else
    raise notice '4/5 ✗ no profiles row to update — create it manually, then re-run';
  end if;
end $$;

-- 5. Let a signed-in user read their own profiles row.
--    Without this, the login page's `.select("is_admin")` returns 0 rows and
--    a real admin is told "this account doesn't have admin access".
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'profiles'
      and policyname = 'Users can read own profile'
  ) then
    create policy "Users can read own profile"
      on public.profiles for select
      using (auth.uid() = id);
    raise notice '5/5 ✓ created RLS policy "Users can read own profile"';
  else
    raise notice '5/5 · own-row read policy already present';
  end if;
end $$;

-- Optional: also reset the PANEL password (the one asked after login).
-- Uncomment and run if the unlock screen rejects the passcode.
-- update public.admin_panel_security
--    set password_hash = crypt('Imtiyaj khan 9329', gen_salt('bf')),
--        updated_at = now()
--  where id = 1;

-- ✅ VERIFY ---------------------------------------------------
-- Expect: email_confirmed = true, has_password = true,
--         has_profile_row = true, is_admin = true
select u.id,
       u.email,
       (u.email_confirmed_at is not null) as email_confirmed,
       (u.encrypted_password is not null) as has_password,
       (p.id is not null)                 as has_profile_row,
       coalesce(p.is_admin, false)        as is_admin,
       (select count(*) from auth.identities i where i.user_id = u.id) as identities
from auth.users u
left join public.profiles p on p.id = u.id
where lower(u.email) = lower((select email from _pydebug_login_fix_cfg limit 1));

drop table if exists _pydebug_login_fix_cfg;
