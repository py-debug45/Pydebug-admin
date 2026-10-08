# PyDebug Admin

Production admin console for **PyDebug** (`admin.pydebug.in`). This is a separate Vercel project that talks to the same Supabase project as `pydebug.in`.

The previous browser-side Supabase admin client has been removed. Database access now happens only in Vercel serverless functions with the service-role key; no Supabase URL/key or privileged credential is shipped to the browser.

## What is included

### Security and platform

- Plain HTML/CSS/JavaScript frontend; no framework or build step
- Five public CommonJS API functions:
  - `api/auth.js` — password login, bootstrap, TOTP, session, logout
  - `api/read.js` — all paginated reads
  - `api/write.js` — all admin mutations
  - `api/jobs.js` — broadcasts, exports, reconciliation, email tests and rebuild dispatches
  - `api/ai.js` — the Own-AI Control Center (moderation, problem factory, guards, growth, reports)
- Dependency-free PostgREST client in `api/_db.js` using global `fetch` and a 15-second timeout
- 8-hour HMAC-signed `HttpOnly; Secure; SameSite=Strict` session cookie
- Same-origin checks and a per-session CSRF token on mutations
- Login rate limit: 5 attempts per IP per 15 minutes through Upstash, fail-open with a server warning if Redis is unavailable
- Dependency-free RFC 6238 TOTP; encrypted-at-rest TOTP secrets; mandatory for `superadmin` and `finance`
- Server-side RBAC on every endpoint
- Append-only audit log with old/new values, actor role, reason and IP
- Masked emails for roles without reveal access; explicit email reveal is audited
- Strict CSP, HSTS, frame denial and `noindex/noarchive` headers
- No ads or analytics

### Admin modules

- Dashboard KPIs, 30-day signup/solve/revenue charts, cron/push alerts and recent events
- Own-AI Control Center (`/ai.html`) — the panel's own AI, restored from the legacy admin panel. Everything runs **on the server with no AI API key and no external calls**; state lives in the `ai_settings` / `ai_logs` tables (migration `0004_own_ai.sql`)
  - One master switch; background runs happen while the AI page is open (the server enforces the schedule and a 55s cross-tab lock)
  - Discussion moderation: scans comments in English + Hindi/Hinglish (leet, spaced-out and punctuated evasion included), deletes abusive ones, warns the offender
  - Auto problem factory: verified templates only — every bug-hunt problem's starter code really raises the detected Python exception (`IndexError`, `ValueError`, `TypeError`, …) and every output-prediction problem's `expected_output` is the program's real stdout, cross-checked against a real CPython interpreter (`npm run verify:ai`); exactly 3 hints per problem; mix/difficulty/per-run/hours and an optional premium mix
  - Duplicate guard and bug error-guard: auto-deletes duplicate problems (oldest wins, children included) and Fix-the-Bug problems whose code runs without raising an error
  - Growth & retention: welcome for new users, premium expiry reminders, win-back, stuck-user help and leaderboard alerts (all rate-limited per user)
  - Safety+: FAQ auto-helper replies and a copy-paste cheat scan over the last 30 days of submissions
  - Content AI: topic gap filler, per-problem variations (✦ AI button in the problem library), quality report, automatic hint repair and bulk import (JSON/CSV, every row validated first)
  - Reports: daily digest, panel health score with one-click fixes, and difficulty calibration from real solve rates
  - Local diagnostic lab and a moderation tester, plus the full AI activity log
  - RBAC: reads need `ai.read`, actions need `ai.control` plus the underlying resource permission (`problems.create/delete/edit`, `moderation.delete`); user-facing notifications need `ai.notify`; every manual mutation is audit-logged
- Users list with search, segmentation, pagination and CSV export
- User 360° view: account state, premium, progress, streak, referrals, battles, achievements, notifications and audit
- Audited premium grants/revokes, suspension, warn/mute, XP changes, progress reset, streak repair and Auth user deletion
- Payments ledger from `payment_grants` (the user app's verified-payment record): total income, per-purchase actual amount paid (discount-aware), active premium users with expiry, plan reporting, manual entitlement grant and Razorpay CSV reconciliation
- Problems CMS with drafts, publish/archive, duplicate, hints, preview, access control and notification opt-out flag
- Referral funnel, top referrers, fraud invalidation and reward revocation
- Battle completion/pool health and stuck-session cleanup
- Discussion feed and flag moderation
- Segmented push announcement composer and delivery logs
- Lifecycle email log and Resend test sends
- Growth retention cohorts, revenue/ARPU/plan mix, content difficulty, engagement and churn reports with CSV export
- App settings and admin team/role management
- Filterable audit viewer and CSV export

## 1. Run the Supabase migrations

In the **same Supabase project used by PyDebug**, open SQL Editor and run, in order:

```text
db/migrations/0001_admin.sql
db/migrations/0002_problems_battle_error.sql
db/migrations/0003_payment_ledger.sql
```

The migration is idempotent and also upgrades the legacy admin audit table in place. It creates:

- `admin_users`
- `admin_audit_log`
- `app_settings`
- `discussion_flags`
- profile/problem admin columns and indexes
- `admin_problem_stats` view

It also removes any old audit foreign key so deleting a user can never remove or rewrite historical audit records. Legacy browser-admin RLS policies and the old shared panel-password verifier are removed. If a legacy `profiles.is_admin` column exists, its values are cleared and a trigger permanently forces it false; the new `admin_users` roles become the only admin authorization source.

If the database was already migrated with `0001_admin.sql` alone, also run the two follow-up migrations (both idempotent, safe to re-run):

- `db/migrations/0002_problems_battle_error.sql` — adds `problems.battle_error`, the real Python exception class a bug-hunt problem's starter code raises. The problem library, the problem editor, the Own-AI factory and the problems CSV export all read and write it; without the column those screens fail with `column problems.battle_error does not exist`.
- `db/migrations/0004_own_ai.sql` — creates the `ai_settings` / `ai_logs` tables for the Own-AI Control Center (master switch, module toggles, factory settings, watch lock, activity log), locked to the service role only.
- `db/migrations/0003_payment_ledger.sql` — adds `payment_grants.amount_paise` (the actual amount paid, so discounted checkouts show the real price), an index for ledger reads, row level security on the payment ledger, and the legacy Razorpay `payments` table when missing. For new purchases to carry the actual paid amount, update the user site's verify-payment API to write the Razorpay captured amount into `payment_grants.amount_paise`; until then the panel falls back to a matching Razorpay `payments` row, then — for purchases made within 48 hours of the buyer's signup — the user app's 20% signup offer (₹79 / ₹399 / ₹639, whole rupees), and finally the plan list price (monthly ₹99 / six-month ₹499 / yearly ₹799).

### Existing new-problem trigger

The editor writes `problems.admin_skip_notification = true` when **Notify users on publish** is off. Because the name/body of the existing notification trigger is project-specific, the migration does not overwrite it. Update that existing trigger function so it exits without broadcasting when the flag is true. Its trigger function should include this guard before notification work:

```sql
if new.admin_skip_notification then
  return new;
end if;
```

Until that guard is added, an old insert-only trigger may still notify on inserts even when the toggle is off.

## 2. Configure Vercel environment variables

Set these in the **admin project only**. Never put values in this repository or browser files.

```text
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
ADMIN_SESSION_SECRET=
ADMIN_ALLOWED_EMAILS=
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
GITHUB_DISPATCH_TOKEN=
RESEND_API_KEY=
```

Optional for the rebuild button:

```text
GITHUB_DISPATCH_REPO=owner/main-pydebug-repo
```

Requirements:

- `ADMIN_SESSION_SECRET` must be a cryptographically random string of at least 32 characters. It also derives the TOTP encryption key. Before rotating it, reset affected encrypted TOTP values in SQL (`update admin_users set totp_enabled=false, totp_secret_encrypted=null;`) so admins can enroll again.
- `ADMIN_ALLOWED_EMAILS` is a comma-separated bootstrap allowlist. It is used **only when `admin_users` has zero rows**.
- `SUPABASE_ANON_KEY` is used server-side only for the password grant.
- `SUPABASE_SERVICE_ROLE_KEY` is used server-side only for PostgREST/Auth admin access.
- `RESEND_API_KEY` and GitHub variables are optional until those actions are used.

A safe way to generate a session secret locally is:

```bash
openssl rand -base64 48
```

## 3. First login

1. Ensure your email already has a Supabase Auth account in the PyDebug project.
2. Add that exact email to `ADMIN_ALLOWED_EMAILS`.
3. Deploy and open `/login.html`.
4. Sign in with the Supabase Auth email/password.
5. If `admin_users` is empty, the account is inserted as `superadmin`.
6. Scan/copy the displayed TOTP secret into an authenticator and verify a code.

After the first admin exists, the bootstrap allowlist cannot create further admins. Add the rest from **Settings → Admin team**.

## 4. Local checks

No runtime install is required. Run the built-in Node test suite:

```bash
npm test
npm run check
npm run verify:ai   # optional: cross-check every AI template with a real python3
```

Tests cover:

- valid, tampered and expired sessions
- TOTP generation/verification and encrypted secret storage
- role gates, including a `content_editor` rejected from the payments read endpoint with 403
- old/new audit values, reason enforcement, secret redaction and audit-write failure behavior
- the Own-AI engine: moderation scanner (English + Hindi), problem validation, premium mix, bulk import, and the full API surface (factory, guards, moderation, growth, reports, watch tick, RBAC and audit) against an in-memory database; plus real-Python behaviour for both bug and output problems (auto-skipped when `python3` is absent)

The real APIs need Vercel/local environment variables and a migrated Supabase project. Do not use production service-role credentials in a shared local environment.

## 4a. Local development server (mock data)

To click through the whole panel — including the Own-AI Control Center — without Vercel or Supabase:

```bash
PYDEBUG_ADMIN_DEV=1 npm run dev     # panel on :3000, in-memory mock on :3001
npm run smoke                        # 50-check API smoke test against it
```

`npm run smoke` logs in as both demo accounts (completing the superadmin's
real TOTP enrollment), exercises every read endpoint, all CSV export jobs, a
representative set of writes, RBAC rejections, CSRF rejection and the full
Own-AI Control Center flow (factory, guards, moderation, growth, reports and
the watch tick).

This serves the static admin UI on `http://localhost:3000` and wires `/api/*` to the **real** serverless handlers, backed by a tiny in-memory PostgREST-compatible mock on the loopback interface. Demo accounts (any password): `dev@pydebug.local` (content editor, straight in) and `root@pydebug.local` (superadmin, real TOTP enrollment on first login). All data resets on restart; the script refuses to start unless `PYDEBUG_ADMIN_DEV=1` is set and is never deployed to Vercel.

## 5. Deploy

1. Import this private repository as a new Vercel project.
2. Add all required environment variables.
3. Deploy with no framework preset/build command.
4. Attach `admin.pydebug.in` to the project.
5. Point the DNS record to Vercel as instructed by the Vercel domain screen.

`vercel.json` configures the five functions and security headers. Static admin HTML, JS and CSS are all deliberately `no-store`, so a redeploy is picked up immediately — a cached older `pages.js` once made the audit page call `/api/read` without its query string (`Missing resource parameter`).

## Roles

| Role | Main access |
|---|---|
| `superadmin` | Full platform, settings and team administration |
| `content_editor` | Problems CMS and AI Control (factory, dedup, error guard); own audit entries |
| `support` | Users/support actions, payment reads, test notifications/email; own audit |
| `finance` | Payment and reconciliation operations, premium grants, reports; own audit |
| `moderator` | User warn/mute, referrals and discussion moderation; own audit |
| `analyst` | Read-only analytics, reports and full audit; masked emails |

The browser hides inaccessible navigation for usability, but the API role checks are the actual security boundary.

## Operational notes

- List APIs default to 50 rows and cap client-requested pages at 200 rows.
- CSV export jobs are explicitly bounded to 5,000 rows (audit exports to 500 summary rows); on-screen audit details retain old/new diffs.
- A push broadcast inserts a `push_announcements` row. The existing PyDebug push worker remains responsible for delivery.
- Manual premium grants update entitlement fields but do **not** create fake Razorpay payment rows.
- Resend tests use `PyDebug <noreply@pydebug.in>`; verify that sender/domain in Resend before production use.
- User suspension only becomes an end-user enforcement boundary if the main product checks `profiles.status` during authenticated actions.
- If an administrative change succeeds but its audit insert fails, the API returns `audit_write_failed` and tells operators to stop further changes and investigate.
