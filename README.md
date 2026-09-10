# PyDebug — Admin App

Standalone admin panel for PyDebug. Deploy this as its **own** Netlify site
(separate from the user-facing app), connected to the **same Supabase project**.

## 1. Run the SQL setup in Supabase (SQL Editor) — required

Open **`supabase-admin-setup.sql`** from this repo, paste it into
Supabase → **SQL Editor**, and run it. It's idempotent, so it's safe to
re-run after pulling new admin-panel upgrades.

What it does (assuming the user-panel tables already exist):

- Adds the DB-backed admin panel password verifier and seeds the initial
  bcrypt password `imtiyaj khan 9329` (change it later with the SQL comment at
  the bottom of the setup file)
- Adds `profiles.is_admin` + an `is_admin()` helper for RLS checks
- Backfills columns the user app expects (`problem_number`,
  `submissions.code`, `display_name`, `monthly_xp`, …) and numbers any
  un-numbered problems
- Creates the `notifications` table if it doesn't exist yet
- Lets admins manage `problems`, read/update `profiles`, read
  `payment_grants` (the real payment ledger), read/delete `submissions`,
  moderate `problem_discussions` (+ likes), read `user_achievements`,
  manage `notifications`, and read hint/playground support tables

If you already added the `prevent_self_premium_grant` trigger from the user
app's setup (blocking users from self-granting premium), this still works
fine alongside it — that trigger explicitly allows changes when `is_admin()`
is true, so admin-panel premium grants/revokes keep working.

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
- Every protected page adds a second DB-backed mobile-style lock. The default
  panel password is `imtiyaj khan 9329`; it is stored as a bcrypt hash in
  `admin_panel_security`, never in browser storage, and is requested again on
  every page load/refresh.
- `dashboard.html` — Stats + analytics charts (signups, submissions,
  difficulty & status donuts) + recent activity feed + top problems +
  all problems (search / type / difficulty / access filters, duplicate,
  edit, delete, CSV export). Premium-user count is expiry-aware.
- `submissions.html` — Every user's progress row: filter by status, search
  by user/problem, view saved code in a modal, delete, CSV export
- `payments.html` — Revenue from the verified `payment_grants` ledger
  (total / 30-day / by-plan donuts) + full grant log with plan filter,
  search and CSV export
- `discussions.html` — Moderate problem comments: search, filter
  (solutions/replies), view full text, delete spam, CSV export
- `notifications.html` — Broadcast announcements to All / Free / Premium
  users' 🔔 bell + review recent notifications
- `problem-form.html` — Add or edit a problem (12 fixed topics,
  auto-suggested problem number, dynamic hints)
- `users.html` — All users with plan/role filters, sorting (newest / most
  XP), quick Grant/Revoke Premium, CSV export — click through to…
- `user-detail.html` — Per-user overview: display-name edit, XP adjust
  (total + monthly), streak freezes, premium grant with expiry
  (lifetime / 1mo / 3mo / 1yr), make/remove admin, reset progress,
  achievements grid, recent submissions
- `ai.html` — 🤖 **Own-AI Control Center** (no API key needed): master
  ON/OFF switch, per-module toggles, problem-factory settings, manual
  run buttons, problem preview with validation checklist, moderation
  tester and the AI activity log

## 🤖 Own-AI (built-in, zero API keys)

This panel ships its own AI engine — pure in-browser JavaScript, no OpenAI /
Gemini / external calls at all, so there is nothing to pay for and no key to
leak. Brain: `js/ai-brain.js`, background watcher: `js/ai-watch.js` (lazy-loaded
after the panel password is passed), control UI: `ai.html` + `js/admin-ai.js`.

- **Discussion moderation** — scans English comments for abuse/gaali
  (incl. leetspeak like `sh1t`, `f*ck`, `fuuuck`, spaced-out `f u c k`),
  spam and promo links; auto-deletes the comment and sends a ⚠️ warning
  notification to the offender. Abusive rows also get a ⚠️ badge on the
  Discussions page.
- **Problem factory** — generates Fix-the-Bug + Predict-Output problems
  with ALL fields filled + exactly 3 hints. EVERY Fix-the-Bug snippet is
  verified to RAISE a real Python error when run (SyntaxError,
  IndentationError, NameError, TypeError, ValueError, IndexError,
  KeyError, ZeroDivisionError, AttributeError, RecursionError,
  ModuleNotFoundError, FileNotFoundError, StopIteration, AssertionError,
  UnboundLocalError, NotImplementedError…) — proven by a built-in static
  detector before insert, never a silent wrong answer — and every
  Predict-Output expected output is COMPUTED from the same values in the
  code, never guessed. Use "👁️ Preview" to inspect buggy code + fixed
  reference code + the validation checklist before inserting.
- **⭐ Premium mix** — optionally marks a configurable share of factory
  problems as Premium (default 25% ≈ 2–3 of every 10, hardest first);
  gap-filler honors it too, and broadcasts mention the Premium count.
- **🧹 Bug error guard** — auto-deletes Fix-the-Bug problems (AI-made OR
  admin-added) whose code runs WITHOUT raising any Python error; hourly
  while ON, plus a manual "Delete error-free bugs now" button (dry-run +
  confirm), a ❤️ health-check entry and a 🔎 quality-report `no-error`
  flag for review.
- **Duplicate guard** — fingerprints every problem (code + output); new
  problems that already exist are skipped, and "🧹 Remove duplicates"
  deletes existing dupes (keeping the oldest), including their
  submissions/discussions.
- **Auto notifications** — offender warnings, new-problem broadcasts to
  all users (🔔 bell compatible) and welcome messages for new joiners.
- **Reports bundle** — 📰 Daily AI Digest (signups, submissions, solve
  rate, top problem, AI activity + auto-highlights, rebuilt daily while
  ON), ❤️ Panel Health Score 0–100 (topic gaps, difficulty balance,
  weak hints, incomplete problems, duplicates, live abuse, unanswered
  questions, sleeping users — each with a one-click Fix button), 🔔
  floating admin bell on every page (unread AI findings inbox), and 🎯
  Difficulty Calibration (real solve rates → suggested easy/medium/hard
  changes with Apply / Apply-all).
- **Scheduling** — while the master switch is ON and any admin page is
  open, the watcher runs moderation every minute, duplicate cleanup +
  welcome hourly, digest daily, and auto-generation every 6/12/24h
  (configurable).
- **Growth bundle** (`js/ai-growth.js`) — ⏰ premium expiry/expired
  reminders (weekly cooldown), 🥺 win-back pings for 7+ day inactive
  users with XP personalization, 💡 stuck-user encouragement after 5+
  failed attempts, 🚀 leaderboard Top-10/climb alerts from daily
  snapshots. Each with ON/OFF toggle + Run-now + daily auto-run.
- **Content bundle** (`js/ai-content.js`) — 🧩 gap filler (emptiest
  topic × difficulty cells first), ✨ one-click Variations on every
  dashboard problem row, 🔎 quality report (weak titles/descriptions/
  hints, dup numbers, bad topics) with Edit links, 💡 one-click hint
  repair from a 12-topic hint bank, 📥 bulk import (JSON/CSV) with
  AI validation (fields + duplicates) before insert.
- **Safety+ bundle** (`js/ai-safety.js`) — 🇮🇳 Hindi/Hinglish abuse
  filter (Roman + Devanagari + phrases, toggleable, merged into the
  main scanner), 🤖 FAQ auto-helper (answers 24h+ unanswered questions
  as the admin, max 10/run), 🕵️ copy-paste detector (identical code by
  3+ users — report only, never auto-punishes).
- **Sync** — toggles persist in `localStorage` instantly and sync
  best-effort to the `ai_settings` / `ai_logs` tables (created by
  `supabase-admin-setup.sql` §11) so every admin device agrees.

Shared helpers: `js/admin-common.js` (auth gate + formatting + plan prices),
`js/admin-charts.js` (dependency-free SVG charts), `js/admin-export.js`
(CSV downloads).

## Keep in sync with the user panel

- **Plan prices** (`js/admin-common.js` → `PYDEBUG_PLANS`) must match the
  user repo's `api/_plans.js`, otherwise revenue numbers will be wrong.
- **Badge list** (`js/admin-user-detail.js` → `PYDEBUG_BADGES`) mirrors the
  user repo's `js/achievements.js`.
- **After adding problems**, the user app's live grid picks them up
  automatically (it reads the DB), but the prerendered SEO pages under
  `problems/*.html` need the user repo's `scripts/prerender-problems.mjs`
  re-run to include the new content.
