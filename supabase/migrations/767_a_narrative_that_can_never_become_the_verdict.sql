-- 767_a_narrative_that_can_never_become_the_verdict.sql
-- ==========================================================================
-- WHY: the second half of the founder's Stage C decision — "deterministic
-- verdict + optional AI narrative alongside, clearly marked AI-written, and
-- NEVER the verdict."
--
-- docs/54 names this the biggest single decision in the review: it puts an LLM
-- into a path that is currently fully deterministic and auditable. So the
-- schema is built so that the LLM CANNOT reach the verdict, rather than merely
-- being asked not to.
--
-- THE SEPARATION, structurally:
--   · verdict / summary / metrics_snapshot are written ONLY by
--     run_de_performance_review_internal (mig 765). Deterministic SQL.
--   · ai_narrative / ai_narrative_model / ai_narrative_at are written ONLY by
--     set_review_narrative below, which names those three columns in its
--     UPDATE and touches nothing else. It cannot write a verdict because it
--     does not mention one.
--   · the two never share a writer, so a narration failure, a prompt
--     injection, or a model hallucination changes prose and nothing else.
--
-- The stored model and timestamp are not decoration: a narrative with no
-- recorded author is a sentence the reader cannot weigh. The UI is expected to
-- label it AI-written from ai_narrative_model.
--
-- ⚠ THE ENFORCEMENT IS CHECKABLE, NOT PROMISED. The probe at the end asserts
-- that exactly ONE routine in the database writes ai_narrative. If a second
-- writer ever appears — a convenience RPC, a backfill, an edge function taking
-- a shortcut — that count changes and this migration's own test fails. A
-- separation that cannot be tested is a separation that quietly stops holding.
--
-- INSTRUCTIONS: per workspace, with a per-employee override (founder decision,
-- 2026-08-18). Two rows at most apply to any review — the employee's, else the
-- workspace default — resolved by resolve_review_narrative_settings. Both live
-- in one table with two PARTIAL unique indexes rather than two tables, so the
-- resolver reads one place and "which row won" is answerable.
--
-- Instructions are TENANT FREE TEXT and therefore untrusted input to a model.
-- Nothing here interpolates them into SQL; the edge function is responsible
-- for wrapping them with _shared/injectionSafety.ts before they reach a
-- prompt. The worst case this design admits is misleading PROSE beside a
-- correct verdict — never a wrong verdict.
-- ==========================================================================

begin;

-- ── Where the narrative lives ────────────────────────────────────────────
alter table public.de_performance_reviews
  add column if not exists ai_narrative       text,
  add column if not exists ai_narrative_model text,
  add column if not exists ai_narrative_at    timestamptz;

comment on column public.de_performance_reviews.ai_narrative is
  'Optional AI-written commentary. NEVER the verdict — see mig 767. Written only by set_review_narrative().';
comment on column public.de_performance_reviews.ai_narrative_model is
  'Which model wrote ai_narrative. A narrative with no recorded author cannot be weighed by the reader.';

-- ── Where the instructions live ──────────────────────────────────────────
create table if not exists public.de_review_narrative_settings (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  -- NULL = the workspace default. Non-NULL = an override for one employee.
  de_id        uuid references public.digital_employees(id) on delete cascade,
  enabled      boolean not null default false,
  instructions text,
  updated_by   uuid,
  updated_at   timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

-- One workspace default per tenant, one override per employee. Partial
-- indexes because NULL de_id must be unique per tenant, which a plain
-- UNIQUE(tenant_id, de_id) would NOT enforce — NULLs do not collide.
create unique index if not exists de_review_narrative_settings_tenant_default
  on public.de_review_narrative_settings (tenant_id) where de_id is null;
create unique index if not exists de_review_narrative_settings_per_de
  on public.de_review_narrative_settings (tenant_id, de_id) where de_id is not null;

alter table public.de_review_narrative_settings enable row level security;

drop policy if exists de_review_narrative_settings_read on public.de_review_narrative_settings;
create policy de_review_narrative_settings_read
  on public.de_review_narrative_settings for select
  using (tenant_id = public.auth_tenant_id());

-- No write policy on purpose: writes go through the RPC below, which checks
-- role. A PERMISSIVE write policy plus a table grant would be a second path
-- to the same state, and this repo has paid for two-paths-one-counted before.
revoke all on table public.de_review_narrative_settings from public;
revoke all on table public.de_review_narrative_settings from anon;
grant select on table public.de_review_narrative_settings to authenticated;

-- ── Resolve: employee override first, workspace default second ───────────
create or replace function public.resolve_review_narrative_settings(
  p_tenant_id uuid,
  p_de_id     uuid
)
returns table (enabled boolean, instructions text, scope text)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $fn$
  select s.enabled, s.instructions,
         case when s.de_id is null then 'workspace' else 'employee' end
    from public.de_review_narrative_settings s
   where s.tenant_id = p_tenant_id
     and (s.de_id = p_de_id or s.de_id is null)
   -- Specific first. Same shape as the autonomy chain (mig 618): the more
   -- specific row wins, and there is at most one of each.
   order by (s.de_id is not null) desc
   limit 1;
$fn$;

revoke all on function public.resolve_review_narrative_settings(uuid, uuid) from public;
revoke all on function public.resolve_review_narrative_settings(uuid, uuid) from anon;
revoke all on function public.resolve_review_narrative_settings(uuid, uuid) from authenticated;
grant execute on function public.resolve_review_narrative_settings(uuid, uuid) to service_role;

-- ── Set instructions (owner/admin only) ──────────────────────────────────
create or replace function public.set_review_narrative_settings(
  p_enabled      boolean,
  p_instructions text default null,
  p_de_id        uuid    default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $fn$
declare
  v_tenant uuid := auth_tenant_id();
  v_id     uuid;
begin
  if v_tenant is null then raise exception 'not_authenticated'; end if;
  if not auth_has_tenant_role(array['tenant_owner','tenant_admin']) then
    raise exception 'insufficient_role';
  end if;

  -- An employee override may only name an employee of THIS workspace. A
  -- tenant id resolved from the caller is authorisation; a de_id supplied by
  -- the caller is an assertion, and gets checked.
  if p_de_id is not null and not exists (
      select 1 from digital_employees d where d.id = p_de_id and d.tenant_id = v_tenant) then
    raise exception 'de_not_in_workspace';
  end if;

  if length(coalesce(p_instructions, '')) > 2000 then
    raise exception 'instructions_too_long: % characters, limit 2000', length(p_instructions);
  end if;

  -- ⚠ ON CONFLICT matches ONE index, and these are two PARTIAL indexes with
  -- different predicates. Branch on which row is being written — a single
  -- statement naming either target would raise on the other kind rather than
  -- fall through to it.
  if p_de_id is not null then
    insert into de_review_narrative_settings (tenant_id, de_id, enabled, instructions, updated_by)
    values (v_tenant, p_de_id, coalesce(p_enabled, false), nullif(btrim(coalesce(p_instructions,'')), ''), auth.uid())
    on conflict (tenant_id, de_id) where de_id is not null
    do update set enabled = excluded.enabled, instructions = excluded.instructions,
                  updated_by = excluded.updated_by, updated_at = now()
    returning id into v_id;
  else
    insert into de_review_narrative_settings (tenant_id, de_id, enabled, instructions, updated_by)
    values (v_tenant, null, coalesce(p_enabled, false), nullif(btrim(coalesce(p_instructions,'')), ''), auth.uid())
    on conflict (tenant_id) where de_id is null
    do update set enabled = excluded.enabled, instructions = excluded.instructions,
                  updated_by = excluded.updated_by, updated_at = now()
    returning id into v_id;
  end if;

  return v_id;
end
$fn$;

revoke all on function public.set_review_narrative_settings(boolean, text, uuid) from public;
revoke all on function public.set_review_narrative_settings(boolean, text, uuid) from anon;
grant execute on function public.set_review_narrative_settings(boolean, text, uuid) to authenticated;

-- ── The ONLY writer of a narrative ───────────────────────────────────────
-- It names three columns. It cannot write a verdict, a summary or a metrics
-- snapshot, because it does not mention them. That is the separation.
create or replace function public.set_review_narrative(
  p_review_id uuid,
  p_narrative text,
  p_model     text
)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $fn$
declare v_n int;
begin
  if coalesce(btrim(p_narrative), '') = '' then
    raise exception 'narrative_empty: refusing to store an empty commentary';
  end if;
  if coalesce(btrim(p_model), '') = '' then
    raise exception 'model_required: a narrative with no recorded author cannot be weighed';
  end if;

  update de_performance_reviews
     set ai_narrative       = p_narrative,
         ai_narrative_model = p_model,
         ai_narrative_at    = now()
   where id = p_review_id;

  get diagnostics v_n = row_count;
  return v_n = 1;
end
$fn$;

revoke all on function public.set_review_narrative(uuid, text, text) from public;
revoke all on function public.set_review_narrative(uuid, text, text) from anon;
revoke all on function public.set_review_narrative(uuid, text, text) from authenticated;
grant execute on function public.set_review_narrative(uuid, text, text) to service_role;

-- ── THE SEPARATION IS ASSERTED, NOT PROMISED ─────────────────────────────
-- Exactly one routine may write ai_narrative. If a second ever appears this
-- fails at apply time rather than being discovered later.
do $sep$
declare
  v_writers int;
  v_names   text;
begin
  select count(*), string_agg(p.proname, ', ' order by p.proname)
    into v_writers, v_names
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~ 'ai_narrative\s*=';
  if v_writers <> 1 then
    raise exception 'narrative_writer_count: expected exactly 1, found % (%)', v_writers, v_names;
  end if;
  raise notice 'separation holds: ai_narrative has exactly one writer (%)', v_names;
end
$sep$;

commit;
