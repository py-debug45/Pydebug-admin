# PyDebug — Admin App

Standalone admin panel for PyDebug. Deploy this as its **own** Netlify site
(separate from the user-facing app), connected to the **same Supabase project**.

## 1. Run this SQL in Supabase (SQL Editor) — required

This assumes the main user-panel tables (`profiles`, `problems`, `submissions`,
`payments`, etc.) already exist from the user app's setup. This adds what the
admin app itself needs:

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

-- Admins can create/edit/delete problems (everyone can still just read them)
create policy "Admins can insert problems" on problems for insert with check (is_admin());
create policy "Admins can update problems" on problems for update using (is_admin());
create policy "Admins can delete problems" on problems for delete using (is_admin());

-- Admins can read every profile (for the Users page) and grant/revoke premium
create policy "Admins can read all profiles" on profiles for select using (is_admin());
create policy "Admins can update any profile" on profiles for update using (is_admin());

-- Admins can read all payments (for the revenue stat on the dashboard)
create policy "Admins can read all payments" on payments for select using (is_admin());
```

If you already added the `prevent_self_premium_grant` trigger from the user
app's setup (blocking users from self-granting premium), this still works
fine alongside it — that trigger explicitly allows changes when `is_admin()`
is true, so admin-panel premium grants/revokes continue to work.

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

## What's included

- `index.html` — Admin login (only `is_admin = true` accounts get in)
- `dashboard.html` — Stats overview + all problems (search/filter/edit/delete)
- `problem-form.html` — Add or edit a bug-fix / predict-output problem, with
  dynamic hints
- `users.html` — All users, with manual Grant/Revoke Premium
