# PyDebug Admin — Feature Audit & "Professional Panel" Gap Analysis

## ✅ Shipped in this branch (2026-11-06)

| Item | Status | Where |
|---|---|---|
| Runtime settings + maintenance mode + announcement bar | **Done** | `settings.html`, `20261106_admin_platform_core.sql` |
| Feature flags / kill switches with rollout % | **Done** | `settings.html#flags` |
| Team accounts, 6 roles, permission matrix | **Done** | `settings.html#team`, `has_perm()` |
| Permission-aware sidebar + handlers + RPC checks | **Done** | `admin-common.js`, page guards |
| Admin sessions + revoke / force logout | **Done** | `settings.html#security` |
| Soft delete + Trash + restore/purge | **Done** | `trash.html`, `admin_soft_delete()` |
| ⌘K command palette + global search | **Done** | `js/admin-command.js` |
| Audit hardening (device/IP, paging, dates, CSV, append-only) | **Done** | `audit.html` |
| CSP / HSTS / no-store security headers | **Done** | `netlify.toml`, `vercel.json` |
| Refunds & disputes, email templates + logs, cohorts/LTV, health page, saved views, bulk actions | **Next** | P0-3/P0-4, P1-1…P1-20 below |

> **TL;DR (Hinglish):** Aapka panel already 70–75% "product admin" hai — users, payments, coupons,
> problems, submissions, community, certificates, notifications, audit log, AI control, 2FA.
> Jo asli gap hai wo **team/RBAC, settings, refunds, email, soft-delete/undo, global search,
> cohort analytics, system health aur governance** ka hai. Ye document priority ke hisaab se
> sab kuch list karta hai, aapke code ke exact references ke saath.

Audited at commit `3b0dead` · 15 admin pages · ~26 JS modules · 7 SQL migrations
Method: static review of every `*.html`, `js/admin-*.js`, `supabase-admin-*.sql`, `db/migrations/*`, `netlify.toml`, `vercel.json`, `tests/*`.

---

## 1. Scorecard

| Area | Maturity | Verdict |
|---|---|---|
| Authentication & 2FA | 🟢 8/10 | TOTP + panel password + admin gate. Missing session/IP logging, recovery codes, lockout policy |
| Data access security | 🟢 8/10 | RLS + `SECURITY DEFINER` RPCs + revokes. Missing CSP/HSTS, no column masking |
| Dashboard & KPIs | 🟢 7/10 | Real charts, live presence, revenue, solve rate. Missing comparison periods, alerts |
| Users | 🟡 6/10 | Good list/detail, XP/premium/moderation. No 360 timeline, notes, tags, impersonation |
| Payments & revenue | 🟡 6/10 | Orders, grants, entitlements, sachet metrics, conversion. **No refunds/disputes/invoices** |
| Coupons / affiliates | 🟢 8/10 | Full studio with presets + attribution. Missing payout ledger & tax docs |
| Content (problems) | 🟡 6/10 | CRUD + bulk-ish tools, CSV export. **No drafts, versions, review workflow, import** |
| Community & moderation | 🟡 6/10 | Posts, flags, resolve, delete. **No unified queue, strikes, appeals, SLA** |
| Notifications | 🟡 6/10 | In-app + web push broadcast + prune. **No email layer, templates, segments, scheduling** |
| Analytics | 🟡 5/10 | Funnel + campuses + sachet. **No cohorts, retention, LTV, churn, ARPU, experiments** |
| Audit log | 🟡 6/10 | Action/entity/metadata viewer. **No IP, UA, session, export, tamper-evidence, retention** |
| Team & roles | 🔴 2/10 | Single `is_admin` boolean. **No roles, invites, permission matrix, approvals** |
| Settings & flags | 🔴 2/10 | `admin_settings` table exists but **no settings page, no feature flags, no maintenance mode** |
| Ops & reliability | 🔴 2/10 | **No health page, no job monitor, no backups, no error tracking, no CI** |
| UX polish | 🟡 6/10 | Responsive, charts, toasts. **No command palette, bulk actions, skeletons, undo, saved views** |
| Compliance | 🔴 3/10 | No DPDP/GDPR export-delete, no consent log, no PII masking, no retention policy |

**Overall: ~6.8/10.** Strong as a *solo-founder control room*; thin as a *team-operated SaaS back-office*.

---

## 2. What you already have (verified in code)

| Page | What it really does |
|---|---|
| `dashboard.html` | Greeting, KPI cards, realtime presence ("who's online now"), revenue trend, signups, submissions, difficulty/status donuts, top problems, daily activity, problem table with filters + pagination + CSV, AI check summary |
| `users.html` | Search, campus/plan/status/role filters, sort, pagination, campus rollup + 1-tap tag moderation, CSV export |
| `user-detail.html` | XP set/add, streak freezes, display name, campus tag, premium grant/revoke with duration, account status (mute/suspend/ban/active) with reason, reset progress, purchases + submissions, badges, certificates |
| `payments.html` | Tabs: grants, orders, entitlements; revenue/discount/avg/conversion KPIs, plan charts, order filters, manual entitlement grant, sachet-window metrics, CSV |
| `coupons.html` | Creator/affiliate + coupon studio, presets, validation, attribution, deep analytics |
| `submissions.html` | List, detail modal, delete, filters |
| `problem-form.html` | Create/edit problems incl. write-code columns, validation |
| `community.html` | Posts, classrooms, institute enquiries, flags, learner feedback, delete with reason |
| `discussions.html` | Comments, likes, flags, resolve, delete |
| `certificates.html` | Issued certificate snapshots, revoke with reason, CSV |
| `notifications.html` | Compose/broadcast, push subscriptions, announcements, broadcast log, prune |
| `arenas.html` | Mock attempts, battles, study plans, attempt breakdown, CSV |
| `ai.html` | AI control center, interview studio, safety/watch/growth/content modules |
| `insights.html` | Funnel, campus analytics, sachet metrics, expiring premium, inactive users |
| `audit.html` | Filterable action feed with JSON metadata |

Infrastructure you already got right: RLS + `is_admin()` helper, `SECURITY DEFINER` RPCs
(`admin_panel_update_profile`, `admin_revoke_certificate`, `admin_delete_community_post`,
`admin_resolve_discussion_flag`, `admin_manage_entitlement`, `admin_prune_notifications`,
`fulfil_payment_order`), idempotent SQL, server-clock presence, realtime, self-hosted Supabase SDK,
deferred scripts + `onAdminReady()`, responsive drawer, zero-dependency chart engine, CSV export,
security headers (XFO/nosniff/referrer), `.sql`/`.md`/`/db`/`/tests` blocked at the edge.

---

## 3. The gaps, by priority

### 🔴 P0 — Ye na ho to panel "professional" nahi kehlata (risk + daily friction)

#### P0-1. Team accounts + RBAC (roles & permissions)
**Aaj:** ek `profiles.is_admin` boolean. Sab ya kuch bhi kar sakta hai, ya kuch nahi.
**Professional panels:** Owner / Admin / Moderator / Support / Finance / Content roles, per-module
permission matrix, invite-by-email, "view-only" support staff, scope-limited access.
Kisi bhi SaaS me support agent ko payment refund ka right nahi hota — yahi difference hai.

Build:
```sql
create type admin_role as enum ('owner','admin','moderator','support','finance','content');
create table admin_members (
  user_id uuid primary key references profiles(id) on delete cascade,
  role admin_role not null default 'support',
  invited_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);
create table admin_invites (id uuid pk, email text, role admin_role, token text, expires_at, accepted_at);
create or replace function is_admin() ... -- keep backward compatible: owner/admin => true
create or replace function has_perm(perm text) returns boolean ... -- 'users.write','payments.refund'
```
Then replace page-level `requireAdmin()` with `requirePerm('users.write')` and hide/disable
buttons in HTML. Keep `is_admin` as a legacy alias so the user app's RLS never breaks.

#### P0-2. Settings page + feature flags + maintenance mode
**Aaj:** `admin_settings` table exists and is granted, but **there is no settings UI anywhere**.
**Missing:** plan prices, free-tier limits, daily submission cap, XP/streak rules, signup on/off,
maintenance banner, announcement bar, support email, timezone/currency, AI on/off per feature,
kill switches.
Build: `settings.html` with grouped sections (General / Plans / Gamification / AI / Email /
Security / Danger zone) + `app_settings(key, value jsonb)`, `feature_flags(key, enabled,
rollout_percent, audience)`. Every flag read behind a cached `getFlags()` in `admin-common.js`.

#### P0-3. Refunds, disputes & order lifecycle
**Aaj:** `refunded` sirf ek status-badge string hai (`admin-common.js:386`). Koi refund flow nahi.
**Missing:** refund request → approval → gateway call → entitlement revoke → audit, partial
refunds, dispute/chargeback log, invoice + GST details, dunning (failed payment retry),
reconciliation vs Razorpay/Stripe settlements, MRR/ARR view.
Build: `refunds(order_id, amount_paise, reason, status, gateway_refund_id, requested_by,
approved_by, created_at)` + `admin_request_refund()` / `admin_approve_refund()` RPC. Money
actions must be **maker-checker** (P0-5).

#### P0-4. Email layer (templates + logs + test send)
**Aaj:** sirf in-app `notifications` + web push. Admin ke paas email bhejne/verify karne ka
koi zariya nahi, aur bounce/spam ka record nahi.
**Missing:** transactional templates (welcome, receipt, premium expiring, streak, certificate,
password reset), **delivery log** (sent/delivered/bounced/complained), preview + test-send,
unsubscribe/preferences, retry.
Build: `email_templates(key, subject, html, variables)`, `email_log(to, template, status,
provider_id, error, created_at)`, `email_preferences(user_id, marketing_opt_in)`, and a Supabase
Edge Function as the single sender (Resend/Postmark/SES). Admin UI: template list, editor with
variable chips, "send test to me", log with filters.

#### P0-5. Maker-checker approvals + destructive-action safety
**Aaj:** premium grant, entitlement grant, user ban, certificate revoke — sab ek click, koi
second approval nahi. Deletes (`problems`, `submissions`, `notifications`, community) are
**permanent** (`admin-dashboard.js:610`, `admin-submissions.js:183`, etc.).
**Missing:** approval queue for money/irreversible actions, soft delete + Trash + restore,
"type the name to confirm" for destructive ops, undo toast.
Build: `deletion_archive(table_name, row_id, payload jsonb, deleted_by, deleted_at, restored_at,
restored_by)` — write a trigger-free helper: admin RPC deletes → copy row to archive → delete.
`approvals(action, payload, requested_by, approved_by, status)` for grants/refunds/roles.

#### P0-6. Admin sessions, IP logging & real security posture
**Aaj:** `admin_audit_log` has `admin_id/action/entity/metadata` only — **no IP, no user-agent,
no session id, no admin_role value in practice** (`admin_role` column exists, default `'admin'`).
Login has client-side hints but rate limiting is Supabase's only.
**Missing:** admin session list ("Chrome on Windows, Indore, 2h ago — revoke"), idle timeout,
force logout, IP allowlist, login alert email, TOTP recovery codes, password policy, lockout
after N failures, CSP + HSTS + `Cache-Control: no-store` on admin HTML.
```
Content-Security-Policy: default-src 'self'; connect-src 'self' https://*.supabase.co wss://*.supabase.co;
img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self';
frame-ancestors 'none'; base-uri 'none'; form-action 'self'
Strict-Transport-Security: max-age=31536000; includeSubDomains
Cache-Control: no-store
```

#### P0-7. Audit log that a regulator would accept
**Aaj:** viewer works, but 300 rows max, no pagination, no export, no IP/UA, no before/after
diff UI, no retention, no immutability.
**Missing:** server-side pagination + date range, CSV/JSON export, per-admin filter, diff view
(old → new), append-only enforcement (revoke UPDATE/DELETE on the table), hash-chain or
`created_at` not-null + insert-only policy, retention job, alert on high-risk actions.
Extend: `ip inet, user_agent text, session_id uuid, request_id text`.

---

### 🟠 P1 — "Pro panel" feel aur daily speed (1–3 hafte)

| # | Feature | Why it matters | Implementation note |
|---|---|---|---|
| P1-1 | **Command palette (⌘K / Ctrl+K)** | Har pro panel me hota hai; 12 clicks → 1 keystroke | One overlay, fuzzy search over pages + users + problems + orders, arrow keys, recent items |
| P1-2 | **Global search / universal finder** | Aaj har page ka apna search box | `search_all(q)` RPC returning typed results (user, problem, order, coupon, post) |
| P1-3 | **Bulk actions + selection** | 500 users ko ek-ek karke tag karna = pain | Checkbox column, sticky action bar, bulk: premium grant, email, campus tag, status, export |
| P1-4 | **Saved views + URL state** | "Failed payments last 7d" ko bookmark karna chahiye | Serialize filters to query string, `saved_views(admin_id, page, name, query, shared)` |
| P1-5 | **User 360 timeline + internal notes + tags** | Support ka #1 tool | `user_notes(user_id, note, created_by)`, `user_tags(user_id, tag)`, merged event feed |
| P1-6 | **Read-only impersonation ("View as user")** | Bug reproduce karne ka fastest way | Edge Function issues scoped token; banner "Viewing as X", every action blocked, audited |
| P1-7 | **Unified moderation queue** | Flags community/discussions me bikhre hain | `moderation_queue` view: type, severity, report count, SLA age, assignee, actions |
| P1-8 | **Strikes, warnings & appeals** | Ban/ mute ad-hoc hai, record nahi | `user_strikes(user_id, reason, severity, expires_at, issued_by)`, auto-escalate rules |
| P1-9 | **Campaign / segment email + scheduling** | "Premium expiring in 3 days" ko email nahi bhej sakte | Segments (premium, expiring, inactive 30d, campus), preview count, schedule, A/B subject |
| P1-10 | **Notification center for admins** | Payment failed, flag spike, AI error ka pata nahi chalta | Bell + unread badge, realtime inserts, rule engine (`admin_alerts`) |
| P1-11 | **Cohort / retention / LTV dashboard** | Funnel hai, par "users 30 din baad rehte hain?" nahi | Weekly signup cohorts × retention heatmap, ARPU, LTV, churn, MRR, DAU/WAU/MAU |
| P1-12 | **Content performance & difficulty calibration** | Kaunsa problem too hard/easy? | Solve rate, attempts/solve, median time-to-solve, p-value vs target, topic coverage gaps |
| P1-13 | **Problem drafts + versions + review** | Live edit se user ko half-baked problem dikhta hai | `problem_versions`, `status: draft|review|published|archived`, scheduled publish, diff |
| P1-14 | **Bulk import/export center** | 200 problems add karne ka koi rasta nahi | CSV/JSON import with dry-run + row errors, full-DB export, scheduled export to Storage |
| P1-15 | **System health page** | "Site slow hai" ka root cause panel me dikhna chahiye | DB latency, edge function errors, job status, webhook failures, storage, queue depth |
| P1-16 | **Job / cron monitor + manual trigger** | Retention, expiry reminders, digests ka koi record nahi | `jobs(name, schedule, last_run, status, duration, error)` + `pg_cron` |
| P1-17 | **Error tracking + RUM** | Client errors silently die | Sentry (or `error_log` table + Edge Function), page load budget, slow-page report |
| P1-18 | **Backup & restore + retention tools** | Galat bulk action = data loss | Nightly `pg_dump`/table export to Storage, one-click restore, PII purge job |
| P1-19 | **DPDP/GDPR toolbox** | India DPDP Act + app stores require it | `data_requests(user_id, type export|delete, status)`, one-click user JSON export, hard-delete with audit |
| P1-20 | **Skeletons, empty states, error states** | Aaj "Loading…" text aur blank tables | Shimmer rows, actionable empty states, retry buttons, offline banner |

---

### 🟡 P2 — Scale hone ke baad (nice-to-have, but expected at maturity)

- **Plans & pricing editor** — DB-driven plans, coupons per plan, trial days, proration on upgrade/downgrade, grandfathered pricing.
- **Affiliate payouts & tax** — commission ledger, payout batches, TDS/GST-ready statements, creator dashboard, payout status.
- **GST invoices** — sequential invoice numbers, PDF download, GSTIN/B2B, credit notes for refunds.
- **Experiments / A-B testing** — `experiments(key, variants, metric)`, deterministic assignment, conversion + significance view.
- **CMS & media library** — changelog, blog, FAQ, legal pages, banners, image upload to Storage with variants, SEO fields.
- **i18n** — Hindi/English toggle for panel chrome, locale-aware dates/currency (`Intl`), translated email templates.
- **API keys & webhooks** — outbound webhooks with retries + signing + delivery log; inbound API keys with scopes and rate limits.
- **Integrations page** — Razorpay, Resend, Sentry, Slack/Telegram alerts, Google Analytics, each with "test connection".
- **Onboarding checklist** — progress card for new admins ("invite teammate → add problem → test broadcast").
- **Density + theme controls** — compact/comfortable, dark/light with persisted preference, reduced-motion already respected.
- **Print/PDF reports** — weekly founder report generated from dashboard.
- **Scheduled reports** — daily/weekly email with key metrics and anomaly highlights.
- **Anomaly alerts** — revenue -30% WoW, submissions spike, error rate >2%, refund spike.
- **Support inbox (optional)** — tickets, canned replies, CSAT, SLA timers.
- **Institution billing** — classroom seats, per-seat invoicing, institute admin delegation.
- **Audit hash chain + SIEM export** — tamper-evident append-only log, signed daily digest.
- **Staging + preview deploys + CI** — `tests/*.cjs` exist but nothing runs them automatically.
- **Schema migration runner** — a `schema_migrations` table + ordered apply script; today migrations are manual SQL pasting.
- **PWA / offline shell** — cache admin shell, queue actions, install prompt.
- **Accessibility pass** — focus traps in modals, `aria-live` for toasts, contrast check, keyboard-navigable tables.

---

## 4. Concrete defects & inconsistencies found (code-level)

| # | Finding | Where | Impact |
|---|---|---|---|
| 1 | No CSP / HSTS / `Cache-Control: no-store` | `netlify.toml`, `vercel.json` | XSS blast radius, cached admin HTML on shared devices |
| 2 | Permanent deletes everywhere, no archive | `admin-dashboard.js:610`, `admin-submissions.js:183`, `admin-discussions.js:198`, `admin-notifications.js:144` | One misclick = unrecoverable data |
| 3 | Audit log silently swallows failures (`console.warn`) | `admin-audit.js:66–88`, `admin-common.js:814` | Compliance hole: action can succeed while log fails |
| 4 | Audit fetch capped at 300 rows, no pagination/export | `admin-audit.js:19` | Real incidents invisible after a week |
| 5 | `admin_role` column never populated | `supabase-admin-setup.sql:434` | Cannot attribute actions to a role |
| 6 | `admin_settings` table exists, zero UI | DB only | Table dead-weight, no runtime config |
| 7 | Money actions single-actor | `user-detail.html`, `payments.html` | Fraud/error risk, no four-eyes control |
| 8 | `is_admin` boolean gates everything | `admin-common.js:172` | Cannot hire support staff safely |
| 9 | No email provider, only push | `admin-notifications.js` | Users without push permission get nothing |
| 10 | `window.location` logout without server-side session revoke | `admin-common.js:289` | Stolen refresh token stays valid until expiry |
| 11 | CSV export builds blob in memory for all rows | `admin-export.js` | Large exports freeze tab; no streaming |
| 12 | No skeletons, only text "Loading…" | all pages | Perceived slowness |
| 13 | Filters not in URL | `users.html`, `payments.html` | Cannot share/bookmark a view |
| 14 | Hard-coded default panel password documented in README | `README.md`, setup SQL | Must rotate on day one; add first-login forced change |
| 15 | No CI running `tests/*.cjs` | `.github` absent | Regressions ship unnoticed |

---

## 5. Recommended data model additions

```sql
-- Team & permissions
admin_members(user_id, role, invited_by, created_at, last_seen_at)
admin_invites(id, email, role, token, expires_at, accepted_at)
approvals(id, action, payload jsonb, requested_by, approved_by, status, created_at, decided_at)

-- Config
app_settings(key text primary key, value jsonb, is_public bool, updated_by, updated_at)
feature_flags(key text primary key, enabled bool, rollout_percent int, audience jsonb, updated_at)

-- Safety
deletion_archive(id, table_name, row_id, payload jsonb, deleted_by, deleted_at, restored_at, restored_by)
user_notes(id, user_id, note, created_by, created_at)
user_tags(user_id, tag, created_by)
user_strikes(id, user_id, reason, severity, expires_at, issued_by, created_at)

-- Commerce
refunds(id, order_id, amount_paise, reason, status, gateway_refund_id, requested_by, approved_by, created_at)
invoices(id, user_id, order_id, number, gstin, amount_paise, pdf_path, issued_at)
affiliate_payouts(id, creator_id, period_start, period_end, amount_paise, status, paid_at, reference)

-- Communication
email_templates(key, subject, html, variables jsonb, updated_by)
email_log(id, to_email, template_key, status, provider_id, error, created_at)
email_preferences(user_id, marketing_opt_in, product_opt_in, updated_at)

-- Analytics & ops
experiments(key, variants jsonb, metric, status)
experiment_assignments(experiment_key, user_id, variant)
saved_views(id, admin_id, page, name, query jsonb, is_shared)
jobs(name, schedule, last_run_at, last_status, last_duration_ms, last_error)
error_log(id, level, message, stack, url, user_agent, created_at)
data_requests(id, user_id, type, status, processed_by, created_at, completed_at)

-- Audit hardening
alter table admin_audit_log
  add column ip inet, add column user_agent text,
  add column session_id uuid, add column request_id text;
revoke update, delete on admin_audit_log from authenticated;  -- append-only
create table admin_sessions(id uuid pk, admin_id uuid, ip inet, user_agent text,
  created_at timestamptz, last_seen_at timestamptz, revoked_at timestamptz);
```

---

## 6. Roadmap

**Week 1 — Trust & safety (P0)**
1. RBAC + `admin_members` + `has_perm()` + permission-aware UI (sidebar hides what you can't use).
2. Settings page + `app_settings` + feature flags + maintenance banner.
3. Soft-delete archive + Trash page + restore.
4. Audit hardening: IP/UA/session, pagination, export, append-only.
5. Security headers + admin session list + revoke + idle timeout + forced password rotation.

**Week 2–3 — Commerce & comms (P0/P1)**
6. Refunds + disputes + maker-checker approval queue.
7. Email templates + delivery log + test send + preferences.
8. Segmented campaigns with scheduling and preview counts.
9. Invoice/GST basics + affiliate payout ledger.

**Week 4–6 — Speed & insight (P1)**
10. Command palette + global search + saved views + bulk actions.
11. User 360 timeline, notes, tags, read-only impersonation.
12. Unified moderation queue + strikes + appeals.
13. Cohorts/retention/LTV/ARPU + content difficulty calibration.
14. System health + jobs monitor + error tracking + backup/restore.

**Week 7+ — Maturity (P2)**
15. Experiments, CMS/media library, i18n, webhooks/API keys, integrations page,
    onboarding checklist, scheduled reports, anomaly alerts, staging + CI.

---

## 7. Acceptance criteria — "is it professional yet?"

- [ ] Har admin action ke saath role, IP, session aur before/after diff audit me hai — aur audit append-only hai.
- [ ] Support staff login kar sakta hai par refund/payout/role-change button dekh bhi nahi sakta.
- [ ] Paisa move karne wale har action ke liye doosre admin ki approval lagti hai.
- [ ] Koi bhi delete 30 din tak Trash me restore ho sakta hai.
- [ ] Koi bhi runtime config (price, limit, feature) code deploy ke bina badal sakta hai.
- [ ] ₹ refund 60 second me complete hota hai aur entitlement auto-revoke hota hai.
- [ ] "User ne email kyun nahi paya?" ka jawab 3 clicks me milta hai (email log).
- [ ] ⌘K se kisi bhi user/order/problem/page par jump hota hai.
- [ ] Cohort retention aur LTV dashboard pe hain, sirf signups nahi.
- [ ] Health page batata hai DB slow hai ya job fail hua — user complaint se pehle.
- [ ] User ka poora data export aur delete, dono ek click + audit ke saath.
- [ ] Mobile pe 4G par pehla meaningful paint < 2s, aur har table skeleton ke saath load hota hai.
