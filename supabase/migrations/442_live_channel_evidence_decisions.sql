-- 442_live_channel_evidence_decisions.sql
-- ============================================================================
-- docs/31 pre-start commitment #4, part 1: open the evidence-decision pipe.
--
-- Three stacked defects made outsourcetel-hq record ZERO decisions in 242
-- answers (all proven live 2026-07-27, docs/32 trace):
--   [1] de-answer/widget-ask only attempted a decision write in one rare
--       corner (escalated + zero sources) — fixed in the edge functions.
--   [2] that corner inserted source_category 'support', which violates the
--       FK to system_categories (mig 107) — the catch swallowed it. The
--       mig-252 "gap bridge" NEVER succeeded once: zero source='live_channel'
--       rows exist in any tenant, ever.
--   [3] record_inquiry_decision — the ONLY writer that also opens the
--       Experience ledger — has been broken outright since mig 212 dropped
--       evidence_runs.specialist_id: the live body still selects it, so every
--       call raises 42703 and rolls back. Newest decision row anywhere is
--       2026-07-14. specialist-consult's rpc error is unchecked, so proactive
--       triage decisions have been silently dropped since.
--
-- This migration: (1) makes 'support' a real category; (2) repairs the column
-- reference and adds p_existing_human_task_id so live-channel callers that
-- already opened an escalation task don't get a duplicate inquiry_review task.
-- The old 13-arg signature is DROPPED in the same file — two arities both
-- matching old call shapes is exactly how mig 377 broke the export pager.
--
-- NO BACKFILL for the 13 orphan evidence_runs: their confidence was never
-- stored; fabricating decisions over old test chatter would poison the
-- metrics this repair exists to make honest.
-- ============================================================================

insert into system_categories (key, label, description)
values ('support', 'Support', 'Live support conversations — chat dock and website widget')
on conflict (key) do nothing;

drop function if exists record_inquiry_decision(uuid, uuid, uuid, text, text, text, integer, uuid, integer, text, text, text, integer);

create or replace function record_inquiry_decision(
  p_tenant_id uuid, p_evidence_run_id uuid, p_connector_id uuid,
  p_external_ref text, p_source text, p_decision text, p_confidence integer,
  p_guardrail_rule_id uuid, p_trust_level integer, p_reasoning text,
  p_inquiry_title text, p_source_category text default null,
  p_frustration_score integer default null,
  p_existing_human_task_id uuid default null
) returns jsonb language plpgsql security definer
set search_path to 'public', 'extensions' as $$
declare
  v_task_id uuid; v_row_id uuid; v_run record;
  v_subject_kind text; v_subject_id uuid; v_ref text;
begin
  if p_decision = 'needs_review' then
    if p_existing_human_task_id is not null then
      v_task_id := p_existing_human_task_id;
    else
      insert into human_tasks (tenant_id, type, title, detail, source, related_table, related_id, status)
      values (p_tenant_id, 'inquiry_review',
        format('Review inquiry — %s', left(coalesce(p_inquiry_title, '(no subject)'), 120)),
        p_reasoning, 'de', 'evidence_runs', p_evidence_run_id, 'pending')
      returning id into v_task_id;
    end if;
  end if;

  insert into evidence_run_decisions (
    tenant_id, evidence_run_id, connector_id, external_ref, source, decision,
    confidence, guardrail_rule_id, trust_level, reasoning, human_task_id,
    source_category, frustration_score
  ) values (
    p_tenant_id, p_evidence_run_id, p_connector_id, p_external_ref, p_source, p_decision,
    p_confidence, p_guardrail_rule_id, p_trust_level, p_reasoning, v_task_id,
    p_source_category, p_frustration_score
  )
  on conflict (evidence_run_id) do update set
    decision = excluded.decision, confidence = excluded.confidence,
    guardrail_rule_id = excluded.guardrail_rule_id, trust_level = excluded.trust_level,
    reasoning = excluded.reasoning,
    human_task_id = coalesce(evidence_run_decisions.human_task_id, excluded.human_task_id),
    source_category = coalesce(excluded.source_category, evidence_run_decisions.source_category),
    frustration_score = coalesce(excluded.frustration_score, evidence_run_decisions.frustration_score)
  returning id into v_row_id;

  -- Experience door (migs 044/045) — logic unchanged; now selects
  -- specialist_de_id (the pre-212 column name no longer exists, and naming it
  -- here would trip the token assert below — the mig-428 lesson).
  select de_id, specialist_de_id, account_ref into v_run from evidence_runs where id = p_evidence_run_id;
  if v_run.de_id is not null then
    v_subject_kind := 'de'; v_subject_id := v_run.de_id;
  elsif v_run.specialist_de_id is not null then
    v_subject_kind := 'specialist'; v_subject_id := v_run.specialist_de_id;
  end if;
  v_ref := coalesce(nullif(p_external_ref, ''), nullif(v_run.account_ref, ''));

  if v_subject_id is not null and p_source_category is not null and v_ref is not null then
    perform record_de_experience(
      p_tenant_id, v_subject_kind, v_subject_id, p_source_category, v_ref,
      format('%s inquiry via %s (source: %s)', initcap(replace(p_source_category, '_', ' ')), coalesce(p_inquiry_title, '(untitled)'), p_source),
      format('Decision: %s%s', p_decision, case when p_confidence is not null then format(' (confidence %s%%)', p_confidence) else '' end),
      p_reasoning, p_evidence_run_id, null);
  end if;

  return jsonb_build_object('id', v_row_id, 'human_task_id', v_task_id);
end; $$;

revoke all on routine record_inquiry_decision(uuid, uuid, uuid, text, text, text, integer, uuid, integer, text, text, text, integer, uuid) from public, anon, authenticated;
grant execute on routine record_inquiry_decision(uuid, uuid, uuid, text, text, text, integer, uuid, integer, text, text, text, integer, uuid) to service_role;

-- ── Assert the repair landed, in-migration (a silent no-op is the worst outcome) ──
do $assert$
declare v_def text; v_n int;
begin
  if not exists (select 1 from system_categories where key = 'support') then
    raise exception '442: support category did not land';
  end if;

  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'record_inquiry_decision';
  if v_n <> 1 then
    raise exception '442: expected exactly 1 record_inquiry_decision, found % — overload ambiguity would 300 every PostgREST call', v_n;
  end if;

  select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'record_inquiry_decision';
  if v_def not like '%specialist_de_id%' then
    raise exception '442: the column repair did not land';
  end if;
  if replace(v_def, 'specialist_de_id', '') like '%specialist_id%' then
    raise exception '442: a reference to the dropped specialist_id column survived';
  end if;
  if v_def not like '%p_existing_human_task_id%' then
    raise exception '442: the duplicate-task guard parameter is missing';
  end if;

  -- The exact statement that has raised 42703 on every call since mig 212:
  perform de_id, specialist_de_id, account_ref from evidence_runs limit 0;
end $assert$;

notify pgrst, 'reload schema';
