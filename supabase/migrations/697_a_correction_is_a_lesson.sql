-- 697_a_correction_is_a_lesson.sql
-- ============================================================================
-- WHY (gap G-E part 2, 2026-08-11): decision_edit — the (before, after) pair
-- a human writes when they CORRECT an employee's proposed work before
-- approving it — was write-only platform-wide. The decide UI captures it
-- (HumanTasksPage, two surfaces), decide_human_task stores it (mig 455), and
-- NOTHING anywhere read it. The single most valuable training signal the
-- platform can receive fed nothing.
--
-- Fix: the learned-behavior organ's two SQL halves learn to see corrections.
--   1. Candidate pool widens: a DECIDED task carrying an edit is a candidate
--      even when the machine thought the work was fine (erd.decision was not
--      'needs_review') — that is precisely when learning matters most.
--   2. Verdict semantics fixed: an edited-then-approved decision is a
--      CORRECTION (the human changed the content), not 'overcaution'.
--      Rejected stays correction; un-edited approval stays overcaution.
--   3. While in these bodies, the organ is aligned with the 682 doctrine:
--      evidence_is_production(ht.origin) now guards the WHOLE candidate set.
--      Learning behavior patterns from marked exercises is the exact trap
--      [[exam-vs-production-evidence]] documents; this is a deliberate,
--      documented TIGHTENING of the existing needs_review arm too.
--
-- Both functions are reproduced FROM THEIR LIVE BODIES (pg_get_functiondef
-- read this session) with only the changes above; asserts below re-prove the
-- unchanged guards. Honest limitation: zero decision_edit rows exist anywhere
-- yet, so the correction arm cannot be exercised against live data — the
-- asserts prove predicate presence, perimeter, and fn-vs-independent-recount
-- agreement, and the first real edited decision is the live proof.
-- ============================================================================

begin;

create or replace function public.get_unembedded_learned_behavior_candidates(p_tenant_id uuid)
returns table(evidence_run_id uuid, inquiry text)
language sql stable security definer set search_path to 'public'
as $function$
  select distinct er.id, er.inquiry
  from evidence_run_decisions erd
  join evidence_runs er on er.id = erd.evidence_run_id
  join human_tasks ht on ht.id = erd.human_task_id
  join de_learning_policies p on p.tenant_id = erd.tenant_id
    and (p.category is null or p.category = erd.source_category)
    and p.enabled = true
  where erd.tenant_id = p_tenant_id
    and (erd.decision = 'needs_review' or ht.decision_edit is not null)
    and ht.status in ('approved', 'rejected')
    and evidence_is_production(ht.origin)
    and er.inquiry_embedding is null
    and er.de_id is not null
    and er.created_at >= now() - make_interval(days => p.window_days)
    and not exists (select 1 from de_learned_behavior_cluster_members m where m.evidence_run_id = er.id)
  limit 200;
$function$;

create or replace function public.cluster_learned_behavior_candidates(p_tenant_id uuid)
returns jsonb
language plpgsql security definer set search_path to 'public', 'extensions'
as $function$
declare
  v_policy        record;
  v_candidate     record;
  v_verdict       text;
  v_nearest_id    uuid;
  v_nearest_status text;
  v_nearest_dist  double precision;
  v_new_cluster_id uuid;
  v_new_members   integer := 0;
  v_new_clusters  integer := 0;
  v_reopened      integer := 0;
  v_promoted      integer := 0;
  v_cluster_id    uuid;
begin
  if not is_feature_enabled_internal(p_tenant_id, 'de_learned_behavior_detection') then
    return jsonb_build_object('skipped', 'feature_disabled');
  end if;

  for v_policy in
    select * from de_learning_policies where tenant_id = p_tenant_id and enabled = true
  loop
    for v_candidate in
      select erd.id as decision_id, erd.evidence_run_id, erd.confidence, erd.source_category,
             erd.guardrail_rule_id, er.inquiry, er.inquiry_embedding, er.created_at, er.de_id,
             ht.status as task_status, ht.decision_edit
      from evidence_run_decisions erd
      join evidence_runs er on er.id = erd.evidence_run_id
      join human_tasks ht on ht.id = erd.human_task_id
      where erd.tenant_id = p_tenant_id
        and (erd.decision = 'needs_review' or ht.decision_edit is not null)
        and ht.status in ('approved', 'rejected')
        and evidence_is_production(ht.origin)
        and (v_policy.category is null or erd.source_category = v_policy.category)
        and er.inquiry_embedding is not null
        and er.de_id is not null
        and er.created_at >= now() - make_interval(days => v_policy.window_days)
        and not exists (select 1 from de_learned_behavior_cluster_members m where m.evidence_run_id = er.id)
      order by er.created_at asc
    loop
      -- reject -> the DE's proposed answer was wrong (correction evidence)
      -- edit   -> the human CHANGED the content before approving (correction)
      -- plain approve -> the DE didn't need to be this cautious (overcaution)
      v_verdict := case when v_candidate.task_status = 'rejected'
                          or v_candidate.decision_edit is not null
                        then 'correction' else 'overcaution' end;

      select c.id, c.status, rer.inquiry_embedding <=> v_candidate.inquiry_embedding
        into v_nearest_id, v_nearest_status, v_nearest_dist
      from de_learned_behavior_clusters c
      join evidence_runs rer on rer.id = c.representative_run_id
      where c.tenant_id = p_tenant_id
        and c.de_id = v_candidate.de_id
        and c.verdict_type = v_verdict
        and (v_policy.category is null or c.category = v_candidate.source_category)
        and (v_verdict = 'correction' or c.guardrail_rule_id is not distinct from v_candidate.guardrail_rule_id)
        and c.last_seen_at >= now() - make_interval(days => v_policy.window_days)
      order by rer.inquiry_embedding <=> v_candidate.inquiry_embedding asc
      limit 1;

      if v_nearest_id is not null and v_nearest_dist < v_policy.similarity_threshold then
        insert into de_learned_behavior_cluster_members (cluster_id, evidence_run_id, human_task_id, similarity_to_representative)
        values (v_nearest_id, v_candidate.evidence_run_id, erd_human_task_id(v_candidate.decision_id), 1 - v_nearest_dist)
        on conflict (evidence_run_id) do nothing;

        if v_nearest_status = 'resolved' then
          update de_learned_behavior_clusters
          set status = 'open', member_count = member_count + 1, last_seen_at = now(),
              recurred_after_fix = true, recurrence_count = recurrence_count + 1,
              severity_score = (select count(*) from de_learned_behavior_cluster_members where cluster_id = v_nearest_id) + 10,
              updated_at = now()
          where id = v_nearest_id;
          v_reopened := v_reopened + 1;
        else
          update de_learned_behavior_clusters
          set member_count = member_count + 1, last_seen_at = now(),
              severity_score = (select count(*) from de_learned_behavior_cluster_members where cluster_id = v_nearest_id),
              updated_at = now()
          where id = v_nearest_id;
        end if;
        v_new_members := v_new_members + 1;
      else
        insert into de_learned_behavior_clusters (
          tenant_id, de_id, category, verdict_type, representative_run_id, guardrail_rule_id,
          member_count, severity_score, status, first_seen_at, last_seen_at
        )
        values (
          p_tenant_id, v_candidate.de_id, v_candidate.source_category, v_verdict, v_candidate.evidence_run_id,
          case when v_verdict = 'overcaution' then v_candidate.guardrail_rule_id else null end,
          1, 1, 'open', now(), now()
        )
        returning id into v_new_cluster_id;

        insert into de_learned_behavior_cluster_members (cluster_id, evidence_run_id, human_task_id, similarity_to_representative)
        values (v_new_cluster_id, v_candidate.evidence_run_id, erd_human_task_id(v_candidate.decision_id), 1.0)
        on conflict (evidence_run_id) do nothing;

        v_new_clusters := v_new_clusters + 1;
      end if;
    end loop;

    for v_cluster_id in
      select c.id from de_learned_behavior_clusters c
      where c.tenant_id = p_tenant_id
        and c.status = 'open'
        and c.category is not distinct from v_policy.category
        and c.member_count >= v_policy.min_cluster_size
    loop
      perform propose_learned_behavior(v_cluster_id);
      v_promoted := v_promoted + 1;
    end loop;
  end loop;

  return jsonb_build_object(
    'new_members', v_new_members, 'new_clusters', v_new_clusters,
    'reopened_after_fix', v_reopened, 'promoted', v_promoted
  );
end;
$function$;

-- Migs 610+630 rule (re-assert on replace): strip both default-grant
-- mechanisms; the callers are the learned-behavior edge fn (service role).
revoke all on function public.get_unembedded_learned_behavior_candidates(uuid) from public, anon, authenticated;
grant execute on function public.get_unembedded_learned_behavior_candidates(uuid) to service_role;
revoke all on function public.cluster_learned_behavior_candidates(uuid) from public, anon, authenticated;
grant execute on function public.cluster_learned_behavior_candidates(uuid) to service_role;

-- ── Verify ──
do $$
declare
  v_def text;
  v_n int;
  v_fn_count int;
  v_recount int;
  v_t record;
begin
  -- (1) Candidates fn: widened predicate + production guard, exactly once each.
  select pg_get_functiondef(oid) into v_def from pg_proc
   where proname = 'get_unembedded_learned_behavior_candidates' and pronamespace = 'public'::regnamespace;
  v_n := (length(v_def) - length(replace(v_def, 'ht.decision_edit is not null', ''))) / length('ht.decision_edit is not null');
  if v_n <> 1 then raise exception '697: candidates fn edit-predicate count % (want 1)', v_n; end if;
  if v_def not like '%evidence_is_production(ht.origin)%' then
    raise exception '697: candidates fn lost the production-evidence guard';
  end if;
  if v_def not like '%m.evidence_run_id = er.id%' then
    raise exception '697: candidates fn lost the already-clustered dedup';
  end if;

  -- (2) Cluster fn: widened predicate, corrected verdict, production guard,
  --     and the guards that must survive the reproduce-from-live.
  select pg_get_functiondef(oid) into v_def from pg_proc
   where proname = 'cluster_learned_behavior_candidates' and pronamespace = 'public'::regnamespace;
  if v_def not like '%or v_candidate.decision_edit is not null%' then
    raise exception '697: cluster fn verdict does not treat an edit as a correction';
  end if;
  if v_def not like '%evidence_is_production(ht.origin)%' then
    raise exception '697: cluster fn lost the production-evidence guard';
  end if;
  if v_def not like '%is_feature_enabled_internal%' then
    raise exception '697: cluster fn lost the feature-flag gate';
  end if;
  if v_def not like '%min_cluster_size%' then
    raise exception '697: cluster fn lost the promotion threshold';
  end if;
  if v_def not like '%propose_learned_behavior%' then
    raise exception '697: cluster fn lost the human-gated promotion call';
  end if;

  -- (3) Perimeter closed on both.
  if has_function_privilege('anon', 'public.get_unembedded_learned_behavior_candidates(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.get_unembedded_learned_behavior_candidates(uuid)', 'execute') then
    raise exception '697: candidates fn executable by the perimeter';
  end if;
  if has_function_privilege('anon', 'public.cluster_learned_behavior_candidates(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.cluster_learned_behavior_candidates(uuid)', 'execute') then
    raise exception '697: cluster fn executable by the perimeter';
  end if;

  -- (4) Fn-vs-independent-recount agreement, summed across every tenant with
  --     an enabled policy (the seed guarantees at least 16 — refuse vacuous).
  select count(*) into v_n from de_learning_policies where enabled;
  if v_n = 0 then raise exception '697: zero enabled policies — recount would be vacuous'; end if;

  v_fn_count := 0; v_recount := 0;
  for v_t in select distinct tenant_id from de_learning_policies where enabled loop
    v_fn_count := v_fn_count + (select count(*) from get_unembedded_learned_behavior_candidates(v_t.tenant_id));
    v_recount := v_recount + (
      select count(distinct er.id)
      from evidence_run_decisions erd
      join evidence_runs er on er.id = erd.evidence_run_id
      join human_tasks ht on ht.id = erd.human_task_id
      join de_learning_policies p on p.tenant_id = erd.tenant_id
        and (p.category is null or p.category = erd.source_category) and p.enabled
      where erd.tenant_id = v_t.tenant_id
        and (erd.decision = 'needs_review' or ht.decision_edit is not null)
        and ht.status in ('approved','rejected')
        and evidence_is_production(ht.origin)
        and er.inquiry_embedding is null and er.de_id is not null
        and er.created_at >= now() - make_interval(days => p.window_days)
        and not exists (select 1 from de_learned_behavior_cluster_members m where m.evidence_run_id = er.id));
  end loop;
  if v_fn_count <> v_recount then
    raise exception '697: fn says % candidates, independent recount says % — disagreeing measurements', v_fn_count, v_recount;
  end if;

  raise notice '697: corrections are lessons — % candidate(s) platform-wide today (0 expected until escalations are decided or a first edit is made); predicates, guards and perimeter all proven', v_fn_count;
end $$;

commit;
