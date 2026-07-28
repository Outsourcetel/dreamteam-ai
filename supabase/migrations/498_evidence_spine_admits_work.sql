-- 498_evidence_spine_admits_work.sql
-- ============================================================================
-- docs/37 MOVE 1, the measurement keystone — substrate half.
--
-- evidence_runs + evidence_run_decisions is the platform's sole evidence
-- substrate, and it is written ONLY by the three answer paths. Ten organs read
-- it — performance, inquiry metrics, economics, skills, the records gate,
-- development needs, gap clustering, knowledge revision — and every one of them
-- is archetype-BLIND: none special-cases support. So governed WORK is not
-- measured wrongly, it is not measured at all. The Renewal DE's nine real
-- escalations are why get_de_performance_metrics honestly reports NULL after
-- migration 491 rather than a fabricated 0%.
--
-- ── WHAT THE GROUNDWORK OVERTURNED ─────────────────────────────────────────
-- docs/37 prescribed: "kill the hardcoded source_category:'support' stamps
-- FIRST, or renewal work gets minted as support evidence." That instruction is
-- WRONG, and following it would have caused the damage it warned about:
--
--   * source_category is FK'd to system_categories — a CONNECTOR vocabulary of
--     11 keys. 'support' is a legitimate member (added by mig 442). The
--     archetype keys the work engine actually runs (renewal_manager, accounting,
--     billing_ar, onboarding, cs_manager, fpa) are a DIFFERENT namespace with
--     zero token overlap and no constraint.
--   * So an archetype value written there does not mislabel — it HARD-FAILS the
--     foreign key. And because record_inquiry_decision calls record_de_experience
--     unfenced, that failure would abort the entire decision write. This exact
--     shape already happened once: mig 442 records that the mig-252 gap bridge
--     inserted 'support' before it was a real category, the FK rejected it, the
--     catch swallowed it, and the bridge never once succeeded for months.
--   * Worse than the FK: resolve_experience gates memory recall by passing this
--     string to resolve_category_access, which resolves it against connector
--     categories and access grants. An archetype key there returns
--     allowed:false / no_grant — the employee could never recall its own
--     experience. A silent, permission-shaped failure.
--   * And source_category cannot be the work/answer discriminator anyway: 72 of
--     199 existing ANSWER decisions already carry 'crm', only 36 carry
--     'support'. A consumer filtering on ='support' would discard 82% of the
--     platform's real answer evidence.
--
-- Therefore: source_category STAYS in its own namespace and the answer paths'
-- 'support' stamp is left alone. The work/answer distinction gets its own
-- column, and the archetype dimension gets its own column beside it.
--
-- ── WHAT THIS MIGRATION DOES ───────────────────────────────────────────────
--   1. evidence_runs.kind — 'answer' | 'work'. Defaults to 'answer', so every
--      existing row and every existing consumer keeps its current meaning
--      until a consumer deliberately opts in (mig 499).
--   2. evidence_runs.work_category — the ARCHETYPE key, nullable, deliberately
--      NOT foreign-keyed: it is a different vocabulary from source_category and
--      94 of 116 employees have no archetype at all. This is the dimension
--      docs/37 Move 2's per-archetype performance contracts will group by.
--   3. source gains 'work_engine' — the decision vocabulary itself needs NO
--      widening, because it is already work-shaped: needs_review = handed to a
--      human, acted = the employee did it, skipped_no_access = could not reach
--      the system, blocked_guardrail = refused by policy.
--
-- NOTHING is fed into these columns yet. The writer is a separate change, and
-- the consumers must gain their dimension first — otherwise the first work row
-- would silently join the same numerator and denominator as the answers.
-- ============================================================================

alter table public.evidence_runs add column if not exists kind text not null default 'answer';
alter table public.evidence_runs add column if not exists work_category text;

do $c$
begin
  if not exists (select 1 from pg_constraint where conname = 'evidence_runs_kind_check') then
    alter table public.evidence_runs add constraint evidence_runs_kind_check
      check (kind = any (array['answer', 'work']));
  end if;
end $c$;

comment on column public.evidence_runs.kind is
  'What this run is evidence OF: an answered inquiry, or a unit of governed work. Defaults to answer so every pre-existing row and consumer keeps its meaning. Consumers that mix the two without grouping on this will blend a support conversation and a renewal case into one number.';

comment on column public.evidence_runs.work_category is
  'The ARCHETYPE key (renewal_manager, accounting, ...) this evidence belongs to. Deliberately NOT foreign-keyed and deliberately NOT source_category: that column belongs to the system_categories connector vocabulary, is FK-enforced, and is used by resolve_category_access to gate memory recall. Two namespaces, one column name — see the migration header.';

-- The work writer needs a source value of its own. The DECISION vocabulary is
-- untouched: would_act/acted were already added for the proactive act path, and
-- needs_review is the honest analogue of "raised an escalation".
do $s$
declare v_def text;
begin
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint where conname = 'evidence_run_decisions_source_check';
  if v_def is null then
    raise exception '498: evidence_run_decisions_source_check not found — refusing to guess the vocabulary';
  end if;
  if v_def ilike '%work_engine%' then
    raise notice '498: source already admits work_engine';
  else
    alter table public.evidence_run_decisions drop constraint evidence_run_decisions_source_check;
    alter table public.evidence_run_decisions add constraint evidence_run_decisions_source_check
      check (source = any (array['manual', 'proactive_trigger', 'manual_simulation', 'live_channel', 'work_engine']));
  end if;
end $s$;

-- Consumers will filter and group on kind; every one of them already filters
-- de_id is not null and scopes by tenant.
create index if not exists evidence_runs_kind_idx
  on public.evidence_runs (tenant_id, de_id, kind)
  where de_id is not null;

notify pgrst, 'reload schema';

-- ── PROOF ────────────────────────────────────────────────────────────────────
do $a$
declare n int; v_def text;
begin
  -- The columns exist and default correctly.
  if not exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='evidence_runs' and column_name='kind') then
    raise exception '498: kind column missing';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='evidence_runs' and column_name='work_category') then
    raise exception '498: work_category column missing';
  end if;

  -- EVERY existing row must still read as an answer. If this migration
  -- silently reclassified history, every metric would shift underneath us.
  select count(*) into n from evidence_runs where kind <> 'answer';
  if n <> 0 then
    raise exception '498: % existing rows were reclassified away from answer', n;
  end if;

  -- The new source value is admitted...
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint where conname = 'evidence_run_decisions_source_check';
  if v_def not ilike '%work_engine%' then
    raise exception '498: source still refuses work_engine';
  end if;
  -- ...and the four original values survive. Dropping one would break the
  -- answer paths that write them.
  if v_def not ilike '%manual%' or v_def not ilike '%proactive_trigger%'
     or v_def not ilike '%manual_simulation%' or v_def not ilike '%live_channel%' then
    raise exception '498: an existing source value was lost widening the constraint';
  end if;

  -- The decision vocabulary must NOT have been touched — reusing it is the
  -- whole point of not widening it.
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint where conname = 'evidence_run_decisions_decision_check';
  if v_def not ilike '%needs_review%' or v_def not ilike '%acted%' then
    raise exception '498: the decision vocabulary changed — it should not have';
  end if;

  -- And source_category must still be FK-guarded. If this migration had
  -- loosened it to admit archetype keys, memory recall would break silently.
  if not exists (select 1 from pg_constraint
                  where conname = 'evidence_run_decisions_source_category_fkey' and contype = 'f') then
    raise exception '498: the source_category foreign key was dropped — archetype values would now corrupt experience recall';
  end if;

  raise notice '498: substrate admits work — kind/work_category added, source widened, decision vocabulary and the category FK untouched';
end $a$;
