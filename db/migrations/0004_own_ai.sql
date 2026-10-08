-- PyDebug Admin v2 — migration 0004: Own-AI Control Center tables
--
-- Brings back the legacy admin panel's Own-AI feature on the v2 server-only
-- architecture. The engine (lib/server/own-ai.js) runs entirely on the server
-- with the service-role key, so these tables are locked down: RLS is enabled
-- and NO anon/authenticated policy is created — only service_role can touch
-- them. (Migration 0001 already dropped the old browser-side admin policies
-- named "Admins can manage ai settings" / "Admins can manage ai logs".)
--
-- Run in the SAME Supabase project as pydebug.in, after 0001-0003.
-- Idempotent: safe to re-run.

-- ai_settings: key/value store for the Own-AI control state so every admin
-- device agrees. Keys: "control" (master switch + module toggles + factory
-- settings), "lastruns" (per-module last-run timestamps for the watch tick),
-- "digest" (last built daily digest), "leaderboard" (rank snapshot),
-- "watch_lock" (cross-tab tick lock), "bell_seen:<admin uuid>" (per-admin
-- bell read marker).
create table if not exists public.ai_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.ai_settings add column if not exists value jsonb not null default '{}'::jsonb;
alter table public.ai_settings add column if not exists updated_at timestamptz not null default now();
alter table public.ai_settings enable row level security;
revoke all on public.ai_settings from anon, authenticated;
drop policy if exists "Admins can manage ai settings" on public.ai_settings;

-- ai_logs: the Own-AI activity log (moderation removals, factory inserts,
-- guard cleanups, growth/safety runs, digest builds). Written by the server
-- engine; read by the AI Control page and the topbar AI bell.
create table if not exists public.ai_logs (
  id uuid primary key default gen_random_uuid(),
  level text not null default 'info',
  action text not null,
  detail text,
  created_at timestamptz not null default now()
);
alter table public.ai_logs add column if not exists level text not null default 'info';
alter table public.ai_logs add column if not exists action text not null default '';
alter table public.ai_logs add column if not exists detail text;
alter table public.ai_logs add column if not exists created_at timestamptz not null default now();
alter table public.ai_logs enable row level security;
revoke all on public.ai_logs from anon, authenticated;
drop policy if exists "Admins can manage ai logs" on public.ai_logs;
create index if not exists ai_logs_created_at_idx on public.ai_logs (created_at desc);
create index if not exists ai_logs_action_idx on public.ai_logs (action);

-- Service role only (the v2 panel never exposes these tables to the browser).
grant all on public.ai_settings to service_role;
grant select, insert, delete on public.ai_logs to service_role;
revoke update on public.ai_logs from service_role;
