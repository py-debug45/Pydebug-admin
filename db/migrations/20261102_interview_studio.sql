-- Interview Studio — additive Write-Code judge compatibility
-- Safe to re-run. No learner permissions are widened and no existing rows are
-- deleted. The admin panel's existing problems RLS policies continue to apply.

alter table public.problems add column if not exists test_cases jsonb default '[]'::jsonb;
alter table public.problems add column if not exists solution_code text;
alter table public.problems add column if not exists status text default 'published';

-- Existing problems remain visible exactly as before; only newly generated
-- Interview Studio rows default explicitly to draft until an admin publishes.
update public.problems set status = 'published' where status is null;
alter table public.problems alter column status set default 'published';

comment on column public.problems.test_cases is
  'Write-Code judge cases: JSON array of {call, expected}; Interview Studio stores 8+ deterministic cases.';
comment on column public.problems.solution_code is
  'Optional reference Python implementation used by the admin preview / learner editorial integrations.';
comment on column public.problems.status is
  'Publishing state used by the user app: draft, published, or archived.';
