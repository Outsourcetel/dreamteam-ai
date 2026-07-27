-- 473_knowledge_proposal_entity_guard.sql
-- ============================================================================
-- THE ENTITY-GUARD (fix-pass 2026-07-28 — BINDING companion to the
-- development-program migration; the program may not ship without it).
--
-- The self-denial failure class: the knowledge-improve organ (de-improve)
-- grades a proposed article by groundedness against the EXISTING knowledge
-- base. When the KB is missing documentation about something that actually
-- exists in the workspace — an employee, a connector, a capability — a
-- proposal that teaches the DE to DENY that thing ("we do not have a
-- Technical Specialist", "we don't integrate with HubSpot") scores HIGH,
-- because denial is perfectly consistent with an incomplete KB. Replay then
-- confirms it (the replayed answer agrees with the denial), and a plausible-
-- looking revision reaches a human who has no signal that the premise —
-- not the answer — may be what is broken.
--
-- Minimum-honest countermeasure, built where proposals are BORN:
-- de-improve inserts the proposal into de_improvements (edge fn, repo read
-- 2026-07-28 — the ONLY writer; create_improvement_review then turns it into
-- the human_tasks 'knowledge_revision' review). A BEFORE INSERT trigger on
-- de_improvements — the single point that covers the edge fn without an edge
-- redeploy, mirroring the auto-grant migration's reasoning — tags every
-- proposal's NEW `detail` jsonb with:
--
--   1. outcome_kind — 'kb_missing' when the trigger evidence is
--      zero-knowledge-hits (gap-cluster proposals whose representative
--      evidence run recorded knowledge_hits = 0 — the data the organ already
--      has; nothing is invented), else 'wrong_answer' (judgment-driven
--      proposals judged a REAL answer below standard; gap clusters whose
--      representative run DID have knowledge hits likewise mean the KB spoke
--      and was wrong).
--   2. entity_match {name, kind} + possible_kb_gap: true — when the
--      proposal's title+content names a LIVE entity of the tenant:
--      digital_employees (active; name, persona_name, and the name without
--      its ' DE'/' Specialist' suffix) or connectors (display_name,
--      provider). Whole-word, case-insensitive; terms under 3 chars are
--      skipped as noise; longest term wins so 'Billing & Invoicing DE'
--      outranks a bare provider token.
--
-- The review surface (HumanTasksPage, src edit in this fix-pass) renders a
-- LOUD banner on entity_match — "the KB may be MISSING documentation rather
-- than the answer being wrong" — and a quiet chip for kb_missing.
--
-- House rules: the trigger function contains ZERO caller-identity predicates
-- (organ path runs under service-role edge inserts today and must keep
-- working under user JWT and direct-DB/pg_cron — asserted by body sweep);
-- SECURITY DEFINER + pinned search_path; tagging errors are swallowed with a
-- WARNING (a tagging failure must never abort a proposal insert); explicit
-- REVOKEs with PUBLIC named; behavioural probe in the asserts (rolled back).
-- This tags NEW proposals only — the 4 pre-existing de_improvements rows in
-- review/failed states keep detail = '{}' and the UI treats absence as
-- "untagged", never as "safe".
-- ============================================================================

-- ── 1. The tag store ────────────────────────────────────────────────────────
alter table de_improvements
  add column if not exists detail jsonb not null default '{}'::jsonb;

comment on column de_improvements.detail is
  'Machine-written review signals (fix-pass 2026-07-28): {outcome_kind: kb_missing|wrong_answer, entity_match?: {name, kind}, possible_kb_gap?: true}. Stamped at insert by trg_de_improvements_entity_guard; empty on rows that predate it.';

-- ── 2. The tagger ───────────────────────────────────────────────────────────
create or replace function public.de_improvements_entity_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_text text;
  v_hits int;
  v_outcome text;
  v_match_name text;
  v_match_kind text;
  r record;
begin
  begin
    -- (1) outcome_kind, from data the organ already recorded.
    v_outcome := 'wrong_answer';
    if new.gap_cluster_id is not null then
      select coalesce((er.confidence_inputs->>'knowledge_hits')::int, 0) into v_hits
      from knowledge_gap_clusters g
      join evidence_runs er on er.id = g.representative_run_id
      where g.id = new.gap_cluster_id;
      if v_hits is not null and v_hits = 0 then
        v_outcome := 'kb_missing';
      end if;
    end if;

    -- (2) entity match: live workspace entities named by the proposal text.
    v_text := coalesce(new.proposed_title, '') || ' ' || coalesce(new.proposed_content, '');
    for r in
      select * from (
        select coalesce(nullif(d.persona_name, ''), d.name) as display,
               t.term, 'digital_employee'::text as kind
        from digital_employees d
        cross join lateral (values
          (d.name),
          (nullif(d.persona_name, '')),
          (nullif(regexp_replace(d.name, '\s+(DE|Specialist)\s*$', '', 'i'), d.name))
        ) as t(term)
        where d.tenant_id = new.tenant_id and d.status = 'active'
        union all
        select coalesce(nullif(c.display_name, ''), c.provider) as display,
               t.term, 'connector'::text as kind
        from connectors c
        cross join lateral (values (nullif(c.display_name, '')), (c.provider)) as t(term)
        where c.tenant_id = new.tenant_id
      ) cand
      where cand.term is not null and length(btrim(cand.term)) >= 3
      order by length(cand.term) desc
    loop
      if v_text ~* ('\m' || regexp_replace(btrim(r.term), '([.\\+*?\[\]\^\$(){}=!<>|:#&-])', '\\\1', 'g') || '\M') then
        v_match_name := r.display;
        v_match_kind := r.kind;
        exit;
      end if;
    end loop;

    new.detail := coalesce(new.detail, '{}'::jsonb)
      || jsonb_build_object('outcome_kind', v_outcome)
      || case when v_match_name is not null
              then jsonb_build_object(
                     'entity_match', jsonb_build_object('name', v_match_name, 'kind', v_match_kind),
                     'possible_kb_gap', true)
              else '{}'::jsonb end;
  exception when others then
    -- Tagging is advisory — it must never abort proposal creation.
    raise warning 'de_improvements_entity_guard tagging skipped for %: %', new.id, sqlerrm;
  end;
  return new;
end $$;

revoke all on function public.de_improvements_entity_guard() from PUBLIC, anon, authenticated;

drop trigger if exists trg_de_improvements_entity_guard on de_improvements;
create trigger trg_de_improvements_entity_guard
  before insert on de_improvements
  for each row
  execute function public.de_improvements_entity_guard();

-- ── 3. Asserts ──────────────────────────────────────────────────────────────
do $assert$
declare
  v_def text;
  v_n int;
  v_probe_detail jsonb;
  v_tenant uuid;
  v_de uuid;
  v_de_name text;
begin
  -- Column shape.
  select count(*) into v_n from information_schema.columns
   where table_schema = 'public' and table_name = 'de_improvements'
     and column_name = 'detail' and data_type = 'jsonb' and is_nullable = 'NO';
  if v_n <> 1 then raise exception '473: detail column missing or wrong shape'; end if;

  -- Trigger armed, once.
  select count(*) into v_n from pg_trigger
   where tgrelid = 'de_improvements'::regclass and not tgisinternal
     and tgname = 'trg_de_improvements_entity_guard';
  if v_n <> 1 then raise exception '473: entity-guard trigger missing'; end if;

  -- Organ-path sweep (the three-context rule): the deployed tagger body must
  -- contain no caller-identity predicate. This assert fails the moment anyone
  -- adds auth.* or can_access_de to the function — under cron/service
  -- contexts those are NULL and would silently blind or break tagging.
  select pg_get_functiondef(p.oid) into v_def from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'de_improvements_entity_guard';
  if v_def like '%auth.%' then raise exception '473: identity predicate found in the tagger'; end if;
  if v_def like '%can_access_de%' then raise exception '473: caller-scoping found in the tagger'; end if;

  -- Perimeter closed.
  if has_function_privilege('anon', 'public.de_improvements_entity_guard()', 'execute')
     or has_function_privilege('authenticated', 'public.de_improvements_entity_guard()', 'execute') then
    raise exception '473: tagger executable by the perimeter';
  end if;

  -- Behavioural probe (the assert question — fails if tagging does not fire):
  -- insert a synthetic proposal naming a REAL active DE of a real tenant,
  -- capture the stamped detail, then roll the row back via a sentinel
  -- exception so nothing persists. Skipped honestly only if no tenant has an
  -- active DE (impossible on this database — 71 active DEs live 2026-07-28).
  select d.tenant_id, d.id, coalesce(nullif(d.persona_name, ''), d.name)
    into v_tenant, v_de, v_de_name
  from digital_employees d
  where d.status = 'active' and length(coalesce(nullif(d.persona_name, ''), d.name)) >= 3
  limit 1;
  if v_de is null then
    raise notice '473: no active DE to probe the entity-guard against — behavioural check skipped';
  else
    begin
      insert into de_improvements
        (tenant_id, de_id, failure_question, failure_answer, failure_rationale,
         proposed_title, proposed_content)
      values
        (v_tenant, v_de, 'entity-guard probe', '', '',
         'Probe: policy about ' || v_de_name,
         'This probe article mentions ' || v_de_name || ' and is rolled back immediately.')
      returning detail into v_probe_detail;
      raise exception using errcode = 'P0999', message = 'entity_guard_probe_rollback';
    exception when others then
      if sqlerrm <> 'entity_guard_probe_rollback' then
        raise exception '473: probe insert itself failed: %', sqlerrm;
      end if;
    end;
    if v_probe_detail is null
       or v_probe_detail->'entity_match'->>'name' is distinct from v_de_name
       or (v_probe_detail->>'possible_kb_gap')::boolean is distinct from true
       or v_probe_detail->>'outcome_kind' is distinct from 'wrong_answer' then
      raise exception '473: entity-guard probe not tagged as expected — got %', v_probe_detail;
    end if;
  end if;
end $assert$;

notify pgrst, 'reload schema';

-- ============================================================================
-- Post-apply verification (read-only, for the applying session):
--
--   -- the tagger's deployed body:
--   select pg_get_functiondef(p.oid) from pg_proc p
--    where p.pronamespace='public'::regnamespace
--      and p.proname='de_improvements_entity_guard';
--
--   -- after the next real proposal lands:
--   select id, proposed_title, detail from de_improvements
--    where detail <> '{}'::jsonb order by created_at desc limit 5;
--
-- KNOWN LIMITS (stated, not hidden): (i) matching is lexical — an article
-- that denies a capability without naming its entity is not caught; this is
-- the MINIMUM-honest version, and the outcome_kind chip still marks every
-- zero-knowledge-hit proposal. (ii) Generic entity names ('Technical
-- Support') will sometimes flag articles that merely mention the team — the
-- banner asks a question rather than blocking, so a false positive costs a
-- reviewer one glance. (iii) Rows predating this migration stay untagged.
-- ============================================================================
