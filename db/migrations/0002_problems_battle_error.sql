-- PyDebug Admin v2 — migration 0002: problems.battle_error
--
-- The panel reads and writes problems.battle_error everywhere: the problem
-- library and editor (api/read.js PROBLEM_FIELDS), problem create/edit
-- (api/write.js problemPayload), the AI studio publish (api/ai.js), the
-- battles question pool and the problems CSV export (api/jobs.js).
-- Migration 0001 added the other admin problem columns (status, updated_at,
-- created_by, admin_skip_notification) but not this one, so on any database
-- migrated with 0001 alone every one of those screens failed with:
--   column problems.battle_error does not exist
--
-- Run in the SAME Supabase project as pydebug.in, after 0001_admin.sql.
-- Idempotent: safe to re-run, and a no-op on fresh installs (0001 creates
-- the column there).

alter table public.problems
  add column if not exists battle_error text;

comment on column public.problems.battle_error is
  'Bug-hunt problems: the real Python exception class raised by the starter code (e.g. IndexError). Empty for output-prediction problems.';
