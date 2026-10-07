-- PyDebug Admin v2 — migration 0003: payment ledger
--
-- The user app's verify-payment API records every verified Razorpay premium
-- purchase in public.payment_grants (one row per payment; payment_id is the
-- Razorpay payment id). This migration makes that ledger fully usable by the
-- admin panel:
--
--   1. amount_paise — the ACTUAL amount the user paid (discount-aware). The
--      panel prefers this column, then a matching Razorpay `payments` row,
--      then the plan list price (monthly ₹99 / six-month ₹499 / yearly ₹799).
--      Update the user app's verify-payment API to write the Razorpay
--      captured amount here so discounted checkouts show the real price paid.
--   2. a created_at index for the ledger reads.
--   3. row level security on the payment ledger (the user app's migration
--      historically left payment_grants world-readable).
--   4. the legacy `payments` table (raw Razorpay rows) — created only when
--      missing, with the columns the panel's reconciliation reads. Existing
--      tables are only extended with missing columns, never redefined.
--
-- Run in the SAME Supabase project as pydebug.in, after 0001/0002.
-- Idempotent: safe to re-run.

-- 1. Actual amount paid per verified purchase (nullable: legacy rows keep
--    null and fall back to the plan list price / matching Razorpay payment).
alter table public.payment_grants
  add column if not exists amount_paise bigint;

comment on column public.payment_grants.amount_paise is
  'Actual amount the user paid for this premium purchase, in paise (discount-aware). Null on legacy rows — the admin panel then falls back to the matching Razorpay payment or the plan list price.';

-- 2. Ledger reads are newest-first.
create index if not exists payment_grants_created_idx
  on public.payment_grants (created_at desc);

-- 3. The payment ledger must not be world-readable. The service role
--    (verify-payment API and the admin panel) bypasses RLS, so this changes
--    nothing for the app — it only closes anonymous access.
alter table public.payment_grants enable row level security;

-- 4. Legacy Razorpay ledger (optional — the panel degrades gracefully when
--    this table is absent or shaped differently).
create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  razorpay_payment_id text,
  razorpay_order_id text,
  plan text,
  amount_paise bigint,
  status text,
  created_at timestamptz not null default now()
);
alter table public.payments
  add column if not exists user_id uuid,
  add column if not exists razorpay_payment_id text,
  add column if not exists razorpay_order_id text,
  add column if not exists plan text,
  add column if not exists amount_paise bigint,
  add column if not exists status text,
  add column if not exists created_at timestamptz not null default now();
create index if not exists payments_razorpay_idx on public.payments (razorpay_payment_id);
alter table public.payments enable row level security;
revoke all on public.payments from anon, authenticated;
