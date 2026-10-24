# PyDebug — Admin App

Standalone admin panel for PyDebug. Deploy this as its **own** Netlify site
(separate from the user-facing app), connected to the **same Supabase project**.

## ⚡ Speed, mobile menu & charts — what changed

**1. The mobile menu button works again.**
`css/admin.css` declared the drawer twice: the `@media (max-width: 800px)`
block set `z-index: 1101`, but a later plain `.admin-sidebar { … z-index: 10 }`
rule (same specificity, so it wins) dropped the open drawer *behind* its own
backdrop — tapping ☰ dimmed the screen and showed nothing. All responsive
rules now live in **one** block at the end of the file, and the drawer is a
proper controller: tap to open **and** close, backdrop tap, nav-link tap and
`Esc` all close it, the page behind it stops scrolling, `aria-expanded` is
kept in sync, and switching back to desktop width can't leave it stuck.

**2. The panel is no longer slow.**
- The five AI automation files (~250 KB) were downloaded **one after another**
  and `requireAdmin()` *awaited all of them* before any page could show data.
  They now download in parallel, in the background, and only `ai.html` waits.
- `js/admin-icons.js` rebuilt a 60-token regular expression **for every text
  node** and re-walked the DOM on **every** mutation. It now compiles once,
  skips nodes with a single cheap test, batches work into one idle pass, and
  pauses its own observer while it edits.
- The dashboard pulled `submissions.select("*")` up to 10 000 rows at a time —
  every column, including stored code. It now probes the table shape once and
  asks only for the 4–5 columns it actually reads.
- Tables were built with one `createElement` **per row** plus 2–3 click
  listeners per row. Now: one DOM write and one delegated listener per table.
- Background tabs stop polling presence, pulse animations moved off
  `box-shadow` (repaint) onto transform/opacity, heavy blurs and the full-page
  gradient are dropped on phones, and `prefers-reduced-motion` is respected.

**3. Real charts.** `js/admin-charts.js` is a proper little chart engine now:
pixel-accurate sizing via `ResizeObserver` (labels stay legible on a phone
instead of being shrunk by viewBox scaling), smooth monotone-cubic lines with
gradient areas, hover/touch tooltips with a crosshair and per-series values,
rounded gradient bars with today highlighted, and donuts with hover emphasis,
a centre read-out and percentages in the legend. Still zero dependencies.

**4. Nothing can block the scripts any more.** The Supabase SDK was a single
blocking `<script>` from `cdn.jsdelivr.net`; if an ad blocker, DNS filter,
office firewall or a slow CDN got in the way, `supabase is not defined` killed
every script after it and the admin got a blank page. The SDK is now served
from this repo (`js/vendor/supabase.min.js`), every script tag is `defer`red,
`js/admin-boot.js` falls back to the CDN if the local file is ever missing,
and pages start through `onAdminReady()` so they only run once the client
really exists — with a readable banner instead of a silent blank screen.

## 1. Run the SQL setup in Supabase (SQL Editor) — required

Open **`supabase-admin-setup.sql`** from this repo, paste it into
Supabase → **SQL Editor**, and run it. It's idempotent, so it's safe to
re-run after pulling new admin-panel upgrades.

Then run **`supabase-admin-totp-setup.sql`** the same way (one time). It
adds the Google Authenticator second login step: a per-admin secret table
(locked behind RLS — even admins can't read it directly) and the
`verify_admin_totp()` / `admin_totp_status()` / `admin_totp_begin_setup()`
functions the login page calls. Login = admin email + password → 6-digit
code from Google Authenticator; the panel opens only after both.

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

## 🚑 "Login nahi ho raha" — 2-minute fix

Work through these in order. Each step removes one cause; the login page now
also tells you *which* one you hit.

1. **Admin login.** The login form uses your **PyDebug admin account**
   password (default: `imtiyaj khan 9329`). If you sign in with `imtiyaj khan 9329`,
   the panel auto-unlocks directly into the dashboard. You can also verify with a
   **6-digit code from Google Authenticator** or tap **Unlock with panel password**.
2. **Run [`supabase-admin-login-fix.sql`](supabase-admin-login-fix.sql)** in
   Supabase → SQL Editor. Edit the two config values at the top (email +
   new password) and run everything. It confirms the email, sets the account
   password, creates the missing `profiles` row, sets `is_admin = true`, and
   adds the own-row `profiles` RLS policy. The last query prints a table —
   `email_confirmed`, `has_password`, `has_profile_row`, `is_admin` must all
   be `true`.
3. **Or fix it by hand:** Supabase → Authentication → Users →
   `avenjr80@gmail.com` → *Reset password* (or *Add user* + *Auto Confirm* if
   the account does not exist), then Table Editor → `profiles` →
   `is_admin = true`, then log in.
4. **Forgot the password?** Use **Send a reset link** on the login page —
   it opens `reset-password.html`, where a new password can be set. Add
   `https://your-admin-site/reset-password.html` to Supabase →
   Authentication → **URL Configuration → Redirect URLs** once, otherwise the
   email link falls back to the project's Site URL.
5. **Still failing?** On the login page open **“Still stuck? Run a
   connection & permission check”** → **Run check**. It tests reachability,
   session, the `profiles` row, `is_admin()`, and the authenticator (TOTP)
   RPC, then **Copy report** gives you everything needed to diagnose it.

> The login page now keeps the error on screen with the exact fix instead of a
> 3-second toast, and the admin gate falls back to the `is_admin()`
> `SECURITY DEFINER` function — so a missing `profiles` SELECT policy can no
> longer log a real admin straight back out.

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

- `index.html` — Admin login (only `is_admin = true` accounts get in, and
  only after the Google Authenticator code verifies — first login shows the
  secret once so it can be added to the app).
  Every failure — wrong password, unconfirmed email, rate limit, blocked
  network, missing admin flag — stays on screen with the exact fix, plus a
  built-in connection/permission check that can copy a report.
- `reset-password.html` — the landing page for Supabase's recovery email
  (“Send a reset link” on the login page), so a forgotten account password no
  longer means a dead end.
- `supabase-admin-login-fix.sql` — one-shot SQL that repairs a login: confirms
  the email, sets a known password, creates the `profiles` row, grants
  `is_admin`, and adds the own-row read policy.
- `supabase-admin-totp-setup.sql` — the Google Authenticator (TOTP) login.
  Secrets live in `public.admin_totp` (RLS on, no client access — only the
  SECURITY DEFINER RPCs can use them), codes are verified in the database
  with a ±30 s drift window, and 5 wrong codes lock the check for 15
  minutes. The code is asked once per browser tab after the password passes;
  admins can unlock using the Google Authenticator 6-digit code or the master
  panel password (`imtiyaj khan 9329`).
- `dashboard.html` — **Live activity** (who is on the site RIGHT NOW by
  name, updates in real time + who practiced today by name) + a polished
  brand command center with real KPI comparisons (new learners and revenue
  versus the previous period), range-aware SVG growth charts (7 / 14 / 30
  days), signups, submissions, difficulty & status donuts, recent activity,
  a live AI quality brief, top problems + all problems (search / type /
  difficulty / access filters, duplicate, edit, delete, CSV export).
  Premium-user count is expiry-aware.
- `submissions.html` — Every user's progress row: filter by status, search
  by user/problem, view saved code in a modal, delete, CSV export
- `payments.html` — Revenue from the verified `payment_grants` ledger
  (total / 30-day / discounts-given / by-plan donuts) + full purchase log
  showing list price, **what Razorpay actually charged**, coupon + % + ₹
  saved, purchase date/time, premium expiry with days left, and CSV export
  (checkout orders show the same list-vs-paid split)
- `coupons.html` — **Coupon & Promo Codes Manager**: create / edit promo
  codes with a live price preview (₹149 monthly · ₹999 yearly), plan
  targeting, total & per-user limits, expiry presets, first-purchase-only
  mode, copyable share links, pause/activate, guarded delete, search /
  status filters / sorting, summary cards (active codes, redemptions,
  attributed revenue) and CSV export — all through the `admin_*_coupon`
  RPCs (direct `coupons` table access stays blocked by RLS)
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
  run buttons, problem preview with validation checklist, moderation tester,
  private code diagnostic lab for common Python mistakes, and the AI activity
  log

## 🟢 Live activity — who's on the site RIGHT NOW + who practiced today

The dashboard opens with a **Live activity** section (plus an "Active now"
stat card):

- **Live right now** — every REAL user currently using the PyDebug site,
  by name, with the page they're on and "Ns ago". A green pulsing dot shows
  it's live. This is *exact*: it updates the instant a user joins, and the
  moment a user **closes the page/app, their name disappears** (within a few
  seconds — no stale "ghost" users ever linger).
- **Practiced today** — of *all* users, the ones who opened PyDebug to
  practice today, by name, with submissions-today count and streak 🔥. The
  "Practiced today" stat card also shows the share of total users.

### How the "exact / instant" guarantee works

1. The user-facing app writes a tiny heartbeat row into
   `public.user_presence` every 25s while the site is in the foreground,
   and deletes it the instant the user closes/leaves the page.
2. The admin panel reads that table and subscribes to it via **Supabase
   Realtime**, so every heartbeat/change lands on the dashboard immediately
   (with a 25s polling fallback + a 5s local expiry tick as safety nets).
3. A user only counts as **active** while their `last_seen_at` is within the
   last **60 seconds**. Closing the page stops the heartbeats, so the name
   drops out on its own — even if the browser is force-killed before the
   leave-delete can run. Reopening the site puts them back instantly.

### One-time setup for the live list (2 steps)

1. **Re-run `supabase-admin-setup.sql`** in the Supabase SQL editor. It is
   idempotent; the new section creates `user_presence`, its RLS (users only
   ever touch their own row; admins read all) and adds the table to the
   Realtime publication.
2. **Add the heartbeat to the user-facing PyDebug app:** copy
   `js/presence-heartbeat.js` into that app's `js/` folder and add ONE script
   tag on its main pages, after the Supabase client script:

   ```html
   <script src="js/supabaseClient.js"></script>
   <script src="js/presence-heartbeat.js"></script>
   ```

   Then re-deploy the user app. From that moment, its real users populate
   "Live right now" here. Until that file is live in the user app, the list
   correctly shows *Nobody is on the site right now* (it never fakes anyone).

> **Privacy / safety:** the heartbeat stores only the user's own id and the
> page path — RLS prevents any user from reading or touching another user's
> row. The file is fully fail-safe and never affects the user app's own
> behaviour. "Active" = the site is in the *foreground*; a backgrounded tab
> (phone locked, other tab focused) drops out after 60s and reappears
> instantly on return, which is the intended "really using it right now"
> semantics.

## 🤖 Own-AI (built-in, zero API keys)

This panel ships its own AI engine — pure in-browser JavaScript, no OpenAI /
Gemini / external calls at all, so there is nothing to pay for and no key to
leak. Brain: `js/ai-brain.js`, background watcher: `js/ai-watch.js` (loaded on every protected admin page
after the authenticator check is passed), control UI: `ai.html` + `js/admin-ai.js`.

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

## 🎟️ Coupon & Promo Codes Manager (2026-10-23)

`coupons.html` + `js/admin-coupons.js` drive the Premium coupon system that
already lives in the database (`db/migrations/20261023_premium_coupons.sql`).
The `coupons` table is intentionally **not** readable through PostgREST: RLS
blocks direct access, and every operation is a `SECURITY DEFINER` RPC that
re-checks `profiles.is_admin = true` and the verified admin email. That is why
the page never calls `sb.from("coupons")` — only:

| RPC | Purpose |
| --- | --- |
| `admin_list_coupons()` | every coupon + live `usedCount`, `remainingUses`, `revenuePaise`, `isExpired` |
| `admin_upsert_coupon(...)` | create or update a code (keyed by `p_code`) |
| `admin_toggle_coupon(p_code, p_is_active)` | pause / re-activate |
| `admin_delete_coupon(p_code)` | delete — or return `{ deleted: false, deactivated: true }` and pause the coupon when paid redemptions already exist, so audit history survives |

Behaviour worth knowing:

- **Codes are permanent.** `admin_upsert_coupon` is keyed by the code, so the
  code input locks while editing. To rename a campaign, delete and re-create.
- **Pause state survives edits.** Creating a coupon sends
  `p_is_active: true`; saving an edit re-sends the coupon's *current* state, so
  editing a paused code does not silently re-activate it.
- **Delete is safe.** The RPC's response decides the toast: a real delete, or
  the "has paid redemptions → paused instead" message.
- **Share links** are `https://pydebug.in/premium?coupon=CODE` (the user panel
  reads `?coupon=` and auto-applies it at checkout).
- **Validation** mirrors the SQL constraints: code 3–24 chars `[A-Z0-9_-]`,
  discount integer 1–80, per-user 1–10, blank `max_uses` = unlimited,
  expiry must be in the future (or "No expiry"), description capped at 160.
- **Live price preview** uses the founding prices from `PYDEBUG_PLANS`
  (`js/admin-common.js`) so a discount preview never drifts from checkout.

The pure helpers (`CouponCore` in `js/admin-coupons.js`) are covered by
`node --test tests/coupons.test.cjs`; `.preview/server.cjs` runs the page with
seeded demo data and a mocked Supabase client for UI review (git-ignored).

## 💳 Real paid amounts, discounts & expiry (2026-10-24)

**The bug:** `payment_grants.amount_paise` existed but nothing ever wrote to
it, so the panel fell back to the plan catalog price. A learner who used
`DIWALI01` (20% off) and paid **₹119** for Pro Monthly, or ₹799.20 for Pro
Yearly, still showed as **₹149 / ₹999** — in the table, the revenue totals,
the donuts, the user page and the CSV export.

**The fix** (`db/migrations/20261024_payment_actual_amounts.sql` — run it in
the Supabase SQL editor once, it is idempotent):

1. `fulfil_payment_order()` now stores the Razorpay-captured amount in
   `payment_grants.amount_paise` (it already verifies that amount against the
   order, so a discount can never be mis-recorded).
2. A `BEFORE INSERT/UPDATE` trigger (`payment_grants_capture_actuals`) fills
   `amount_paise`, `coupon_code` and `discount_percent` from the linked
   `payment_orders` row, so **any** grant writer — including an older copy of
   the user app that doesn't send those columns — still records the truth.
3. Existing grants are backfilled from their checkout order.
4. `admin_record_grant_amount(p_payment_id, p_amount_paise)` lets an admin
   correct a legacy grant whose amount predates the ledger columns; it
   re-checks `is_admin()` and writes an `admin_audit_log` entry.

**What the panel shows now:** list price (struck through when discounted),
actual paid amount, coupon code + discount % + ₹ saved, full purchase
date/time, and the exact premium end date with a “N days left / Expired”
label. The Payments page also totals **Discounts given**, and the user detail
page has a **Premium purchases** table plus **Lifetime spend** (actual
amounts). The dashboard's “Lifetime revenue” is the same captured amount.

Legacy grants that predate `payment_orders` have no amount anywhere, so they
are shown with a `*` and a **Set paid ₹** button instead of silently
pretending the list price was paid; revenue totals mark how many rows are
estimates.

## Keep in sync with the user panel

- **Plan prices** (`js/admin-common.js` → `PYDEBUG_PLANS`) must match the
  user repo's `api/_plans.js`, otherwise revenue numbers will be wrong.
- **Badge list** (`js/admin-user-detail.js` → `PYDEBUG_BADGES`) mirrors the
  user repo's `js/achievements.js`.
- **After adding problems**, the user app's live grid picks them up
  automatically (it reads the DB), but the prerendered SEO pages under
  `problems/*.html` need the user repo's `scripts/prerender-problems.mjs`
  re-run to include the new content.

## Admin data access repair (2026-10-21)

For an existing live database, run these **in order**, rather than resetting
learner-table grants or disabling RLS:

1. `db/migrations/20261021_restore_admin_access.sql`
2. `db/migrations/20261021_admin_compatibility.sql`
3. `db/migrations/20261023_complete_admin_features.sql`
4. `db/migrations/20261023_fix_admin_table_grants.sql`
5. `db/migrations/20261024_payment_actual_amounts.sql` (real paid amounts +
   coupon/discount capture; see the section above)

The latest migrations are idempotent; re-run them after pulling updates. They
grant the required `authenticated` table privileges (`SELECT` / append-only
`INSERT` / admin CRUD) across `user_certificates`, `mock_attempts`,
`study_plans`, `payment_orders`, `product_entitlements`, `push_announcements`,
`push_broadcast_log`, `discussion_flags`, `referrals`, and `admin_audit_log`,
revoke excess `anon` privileges on newer tables, and reload PostgREST's schema
cache. Both table grants and RLS policies are required by PostgREST, and table
grants never bypass RLS.

Together, these migrations restore authenticated **admin-only** policies for
panel queries; anonymous visitors and ordinary learners cannot read answer
keys, the payment ledger, or admin logs. Existing learner policies are
preserved. Sensitive profile edits use `admin_panel_update_profile`, with a
server-side admin check and an explicit field allowlist, not unrestricted
profile UPDATE grants.

Insights and payment totals now paginate past PostgREST's response cap.
Revenue uses the ledger's actual `amount_paise` (the amount Razorpay
captured), then the linked order amount; the plan price is used only for
historical rows where no charged amount was ever recorded, and those rows are
labelled as estimates (`*` + **Set paid ₹**). Audit displays both server and
panel ledger formats. Run regression checks with
`node --test tests/*.test.cjs`.
