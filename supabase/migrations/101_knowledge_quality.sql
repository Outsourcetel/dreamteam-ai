-- ============================================================
-- Migration 101: real backing for the Knowledge Quality page (5th of
-- the 8-page rebuild). No "quality/coverage" concept existed before —
-- this adds the one genuinely new piece (a real citation-to-confidence
-- correlation per document) plus a real freshness column. Everything
-- else the page needs (freshness histogram, stale queue, per-tag
-- coverage) is computable client-side from data that already exists
-- (knowledge_docs, knowledge_doc_scopes) — no new backend for those.
--
-- The citation correlation is possible because specialist-consult
-- (supabase/functions/specialist-consult/index.ts:447,458) already
-- cites a knowledge doc as {system:'DreamTeam knowledge', ref:<doc_id>,
-- ...} inside evidence_runs.steps[].citations[] — ref IS the real
-- doc id, not a display string, so a doc's real citation count and
-- the confidence/feedback of the inquiries that cited it can be
-- computed with a straightforward JSONB unnest + join. Never
-- previously surfaced anywhere.
-- ============================================================

alter table knowledge_docs add column if not exists last_verified_at timestamptz;

-- get_knowledge_doc_citation_stats — per-doc citation count, average
-- confidence of the inquiries that cited it, and how those citations'
-- evidence runs were rated by a human (evidence_feedback.verdict).
-- Zero citations for a doc is a real, meaningful signal (never used
-- to answer anything), not an error — returned as 0/null, not omitted.
create or replace function public.get_knowledge_doc_citation_stats(p_tenant_id uuid)
returns table(
  doc_id uuid,
  citation_count bigint,
  avg_confidence numeric,
  accurate_count bigint,
  needs_improvement_count bigint
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_caller_tenant uuid;
  v_is_active     boolean;
  v_is_platform   boolean := is_platform_admin();
begin
  if not v_is_platform then
    select tenant_id, coalesce(is_active, true) into v_caller_tenant, v_is_active
    from profiles where user_id = auth.uid();
    if v_caller_tenant is distinct from p_tenant_id or not v_is_active then
      raise exception 'not a member of this tenant';
    end if;
  end if;

  return query
  with cited as (
    select
      (cit->>'ref')::uuid as c_doc_id,
      er.id as c_run_id
    from evidence_runs er,
      jsonb_array_elements(coalesce(er.steps, '[]'::jsonb)) as step,
      jsonb_array_elements(coalesce(step->'citations', '[]'::jsonb)) as cit
    where er.tenant_id = p_tenant_id
      and cit->>'system' = 'DreamTeam knowledge'
      and (cit->>'ref') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ),
  conf as (
    select c.c_doc_id, avg(erd.confidence) as a_avg_confidence
    from cited c
    join evidence_run_decisions erd on erd.evidence_run_id = c.c_run_id and erd.tenant_id = p_tenant_id
    group by c.c_doc_id
  ),
  fb as (
    select c.c_doc_id,
      count(*) filter (where ef.verdict = 'accurate') as f_accurate_count,
      count(*) filter (where ef.verdict in ('needs_improvement', 'inaccurate')) as f_needs_improvement_count
    from cited c
    join evidence_feedback ef on ef.evidence_run_id = c.c_run_id and ef.tenant_id = p_tenant_id
    group by c.c_doc_id
  )
  select
    d.id,
    coalesce(ca.cnt, 0),
    conf.a_avg_confidence,
    coalesce(fb.f_accurate_count, 0),
    coalesce(fb.f_needs_improvement_count, 0)
  from knowledge_docs d
  left join (select c_doc_id, count(*) as cnt from cited group by c_doc_id) ca on ca.c_doc_id = d.id
  left join conf on conf.c_doc_id = d.id
  left join fb on fb.c_doc_id = d.id
  where d.tenant_id = p_tenant_id and d.is_current = true;
end;
$function$;

revoke all on function public.get_knowledge_doc_citation_stats(uuid) from public, anon, authenticated;
grant execute on function public.get_knowledge_doc_citation_stats(uuid) to authenticated;
