# PyDebug — Admin App

Standalone admin panel for PyDebug. Deploy this as its **own** Netlify site
(separate from the user-facing app), connected to the **same Supabase project**.

## 1. Run the SQL setup in Supabase (SQL Editor) — required

Open **`supabase-admin-setup.sql`** from this repo, paste it into
Supabase → **SQL Editor**, and run it. It's idempotent, so it's safe to
re-run after pulling new admin-panel upgrades.

What it does (assuming the user-panel tables `profiles`, `problems`,
`submissions`, `payments` already exist):

- Adds `profiles.is_admin` + an `is_admin()` helper for RLS checks
- Lets admins insert/update/delete `problems`
- Lets admins read all `profiles` + update any profile (premium, XP, role)
- Lets admins read all `payments` (Payments page + revenue stats)
- Lets admins read/delete `submissions` (Submissions page + analytics)

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
- `dashboard.html` — Stats + analytics charts (signups, submissions,
  difficulty & status donuts) + recent activity feed + top problems +
  all problems (search / type / difficulty / access filters, duplicate,
  edit, delete, CSV export)
- `submissions.html` — Every user's code submissions: filter by status,
  search by user/problem, view code+output in a modal, delete, CSV export
- `payments.html` — Revenue overview (total / 30-day / avg) + full payment
  log with status filter, search and CSV export
- `problem-form.html` — Add or edit a bug-fix / predict-output problem,
  with dynamic hints
- `users.html` — All users with plan/role filters, sorting (newest / most
  XP), quick Grant/Revoke Premium, CSV export — click through to…
- `user-detail.html` — Per-user overview: XP adjust, premium grant with
  expiry (lifetime / 1mo / 3mo / 1yr), make/remove admin, reset progress,
  recent submissions

Shared helpers: `js/admin-common.js` (auth gate + formatting),
`js/admin-charts.js` (dependency-free SVG charts), `js/admin-export.js`
(CSV downloads).

> Note: the Submissions / Payments / User-detail pages auto-detect their
> table's column names, so minor schema differences in the user panel won't
> break them — but the tables themselves (`submissions`, `payments`) must
> exist and the setup SQL above must have been run.
