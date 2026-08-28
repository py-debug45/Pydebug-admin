# PyDebug — Admin App

Standalone admin panel for PyDebug. Deploy this as its **own** Netlify site
(separate from the user-facing app), connected to the **same Supabase project**.

## 1. Run this SQL in Supabase (SQL Editor) — required

This assumes the main user-panel tables (`profiles`, `problems`, `submissions`,
`payments`, etc.) already exist from the user app's setup. This adds what the
admin app itself needs. It is safe to run more than once (idempotent).

```sql
-- Mark who is an admin
alter table profiles add column if not exists is_admin boolean default false;

-- Security-definer helper so RLS policies can check "is this user an admin?"
-- without recursively re-triggering RLS on profiles.
create or replace function public.is_admin()
returns boolean
language sql security definer
set search_path = public
as $$
  select coalesce((select is_admin from profiles where id = auth.uid()), false);
$$;

-- RLS must actually be ON, or none of the policies below do anything.
alter table profiles enable row level security;
alter table problems enable row level security;
alter table payments enable row level security;

-- Admins can create/edit/delete problems (everyone can still just read them)
drop policy if exists "Admins can insert problems" on problems;
create policy "Admins can insert problems" on problems
  for insert with check (is_admin());

drop policy if exists "Admins can update problems" on problems;
create policy "Admins can update problems" on problems
  for update using (is_admin()) with check (is_admin());

drop policy if exists "Admins can delete problems" on problems;
create policy "Admins can delete problems" on problems
  for delete using (is_admin());

-- Admins can read every profile (for the Users page) and grant/revoke premium
drop policy if exists "Admins can read all profiles" on profiles;
create policy "Admins can read all profiles" on profiles
  for select using (is_admin());

drop policy if exists "Admins can update any profile" on profiles;
create policy "Admins can update any profile" on profiles
  for update using (is_admin()) with check (is_admin());

-- Admins can read all payments (for the revenue stat on the dashboard)
drop policy if exists "Admins can read all payments" on payments;
create policy "Admins can read all payments" on payments
  for select using (is_admin());

-- Let the signed-in user read their own profile row. Without this, the admin
-- app's own is_admin lookup is blocked by RLS before it can ever succeed.
drop policy if exists "Users can read own profile" on profiles;
create policy "Users can read own profile" on profiles
  for select using (auth.uid() = id);
```

**Fallback-account protection (recommended):** before running this, add one
known admin account via the user app, then keep a second snippet handy so you
can always recover admin access without the Table Editor:

```sql
update profiles set is_admin = true
where email = 'you@example.com'; -- change this to your own email
```

> ⚠️ Until the policies above are in place, any logged-in user can call
> Supabase directly (the anon key is public) and read/change data. The app's
> JS login check is only a UI gate — the policies are the real security
> boundary. The admin app will show a setup error if policies/schema are
> missing, so you'll know.

If you already added the `prevent_self_premium_grant` trigger from the user
app's setup (blocking users from self-granting premium), this still works
fine alongside it — that trigger explicitly allows changes when `is_admin()`
is true, so admin-panel premium grants/revokes continue to work.

### Quick sanity checks (SQL Editor)

```sql
-- Expected columns used by the admin app
select column_name from information_schema.columns
where table_name in ('profiles', 'problems', 'payments')
order by table_name, column_name;

-- Row Level Security must be ENABLED for every table above, and the
-- is_admin() policies must be listed. If rls_enabled is false, the
-- policies do nothing and the data is effectively public.
-- ("table" is a reserved word in SQL, so the alias has to be quoted.)
select c.relname as "table", c.relrowsecurity as rls_enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('profiles', 'problems', 'payments');

-- List the policies that actually exist on those tables
select tablename, policyname, cmd
from pg_policies
where schemaname = 'public'
  and tablename in ('profiles', 'problems', 'payments')
order by tablename, policyname;
```

## 2. Make your account the admin

1. Sign up for a normal account through the **user-facing app** (not this admin app) once.
2. In Supabase → **Table Editor → profiles**, find your row and set `is_admin` to `true`.
3. That's the only account that can log into this admin app.

## 3. Keys — already filled in

`js/supabaseClient.js` already has your Supabase URL + anon key (same project
as the user app). Nothing else to configure — this app makes no payment or
ads calls, so there are no other secrets involved.

## 4. Deploy

This is plain static HTML/CSS/JS with no serverless functions, so a simple
Netlify deploy works:
- Connect a **private** GitHub repo to Netlify (Import from Git), or
- Drag-and-drop this folder directly into Netlify — both work fine here,
  since (unlike the user app) there's no `netlify/functions` folder that
  drag-and-drop would fail to deploy.

Give it its own subdomain, e.g. `pydebug-admin.netlify.app`, so it's not
guessable from the main user-facing URL.

## Running the checks

The app is dependency-free static HTML/CSS/JS, but there are two test suites
you can run locally with Node (no build step, nothing to deploy):

```bash
# Pure helper functions — pagination maths, search escaping, premium expiry,
# id validation, hint normalisation. Zero dependencies.
node tests/logic.test.js

# Full page smoke tests: every admin page is rendered headlessly against a
# fake Supabase backend and asserted on (rows, stats, XSS escaping, delete /
# grant-premium flows, pagination fallback, login redirects).
npm install --no-save jsdom
node tests/dom.test.js
```

`node_modules/` is gitignored and nothing in `tests/` is shipped to Netlify —
`netlify.toml` publishes the repo root as-is with no build command.


## What's included

- `index.html` — Admin login (only `is_admin = true` accounts get in)
- `dashboard.html` — Stats overview + all problems (search/filter/edit/delete)
- `problem-form.html` — Add or edit a bug-fix / predict-output problem, with
  dynamic hints
- `users.html` — All users, with manual Grant/Revoke Premium
- `robots.txt` + `netlify.toml` headers — keeps this panel out of search
  engines and out of other people's iframes
- `tests/` — logic + headless DOM test suites (dev only)
