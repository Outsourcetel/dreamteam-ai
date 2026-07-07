-- ============================================================
-- Migration 072: fix a real bug found during migration 070's own
-- live end-to-end verification (a seeded 3-question test cluster on
-- Harbor Peak Consulting reached member_count=3, the configured
-- threshold, but never promoted).
--
-- Root cause: the promotion loop's category filter used
-- `c.category is not distinct from v_policy.category`, which for a
-- tenant-wide policy (category = null, the seeded default from 071)
-- only matched clusters that ALSO had category = null. Every real
-- cluster carries the category of the inquiry that seeded it (e.g.
-- 'crm'), so a tenant-wide policy could never promote anything. The
-- candidate-selection query elsewhere in this same function already
-- used the correct precedence (`v_policy.category is null or ... =
-- v_policy.category`) — this was a one-spot inconsistency, not a
-- deeper design error, but it would have made the whole feature
-- silently inert for every tenant using the default (tenant-wide)
-- policy, which is all seven of them.
-- ============================================================
CREATE OR REPLACE FUNCTION public.cluster_gap_candidates(p_tenant_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_policy       record;
  v_candidate    record;
  v_nearest_id   uuid;
  v_nearest_status text;
  v_nearest_dist double precision;
  v_new_cluster_id uuid;
  v_frustration  integer;
  v_new_members  integer := 0;
  v_new_clusters integer := 0;
  v_reopened     integer := 0;
  v_promoted     integer := 0;
  v_cluster_id   uuid;
begin
  if not is_feature_enabled_internal(p_tenant_id, 'knowledge_gap_detection') then
    return jsonb_build_object('skipped', 'feature_disabled');
  end if;

  for v_policy in
    select * from knowledge_gap_policies where tenant_id = p_tenant_id and enabled = true
  loop
    for v_candidate in
      select erd.id as decision_id, erd.evidence_run_id, erd.confidence, erd.source_category,
             er.inquiry, er.inquiry_embedding, er.created_at
      from evidence_run_decisions erd
      join evidence_runs er on er.id = erd.evidence_run_id
      where erd.tenant_id = p_tenant_id
        and (v_policy.category is null or erd.source_category = v_policy.category)
        and erd.confidence < v_policy.min_confidence_floor
        and er.inquiry_embedding is not null
        and er.created_at >= now() - make_interval(days => v_policy.window_days)
        and not exists (select 1 from knowledge_gap_cluster_members m where m.evidence_run_id = er.id)
      order by er.created_at asc
    loop
      v_frustration := score_frustration_internal(p_tenant_id, v_candidate.inquiry);

      select c.id, c.status, rer.inquiry_embedding <=> v_candidate.inquiry_embedding
        into v_nearest_id, v_nearest_status, v_nearest_dist
      from knowledge_gap_clusters c
      join evidence_runs rer on rer.id = c.representative_run_id
      where c.tenant_id = p_tenant_id
        and (v_policy.category is null or c.category = v_candidate.source_category)
        and c.last_seen_at >= now() - make_interval(days => v_policy.window_days)
      order by rer.inquiry_embedding <=> v_candidate.inquiry_embedding asc
      limit 1;

      if v_nearest_id is not null and v_nearest_dist < v_policy.similarity_threshold then
        insert into knowledge_gap_cluster_members (cluster_id, evidence_run_id, similarity_to_representative, frustration_score)
        values (v_nearest_id, v_candidate.evidence_run_id, 1 - v_nearest_dist, v_frustration)
        on conflict (evidence_run_id) do nothing;

        if v_nearest_status = 'resolved' then
          update knowledge_gap_clusters
          set status = 'open', member_count = member_count + 1, last_seen_at = now(),
              recurred_after_fix = true, recurrence_count = recurrence_count + 1,
              severity_score = (select count(*) * (1 + coalesce(avg(frustration_score), 0) / 100.0)
                                from knowledge_gap_cluster_members where cluster_id = v_nearest_id) + 10,
              updated_at = now()
          where id = v_nearest_id;
          v_reopened := v_reopened + 1;
        else
          update knowledge_gap_clusters
          set member_count = member_count + 1, last_seen_at = now(),
              severity_score = (select count(*) * (1 + coalesce(avg(frustration_score), 0) / 100.0)
                                from knowledge_gap_cluster_members where cluster_id = v_nearest_id),
              updated_at = now()
          where id = v_nearest_id;
        end if;
        v_new_members := v_new_members + 1;
      else
        insert into knowledge_gap_clusters (tenant_id, category, representative_run_id, member_count, severity_score, status, first_seen_at, last_seen_at)
        values (p_tenant_id, v_candidate.source_category, v_candidate.evidence_run_id, 1, 1 + v_frustration / 100.0, 'open', now(), now())
        returning id into v_new_cluster_id;

        insert into knowledge_gap_cluster_members (cluster_id, evidence_run_id, similarity_to_representative, frustration_score)
        values (v_new_cluster_id, v_candidate.evidence_run_id, 1.0, v_frustration)
        on conflict (evidence_run_id) do nothing;

        v_new_clusters := v_new_clusters + 1;
      end if;
    end loop;

    -- promote any open cluster that just crossed this policy's bar
    -- (fixed: category-null policy now correctly matches every
    -- category's clusters, not just category-null ones)
    for v_cluster_id in
      select c.id from knowledge_gap_clusters c
      where c.tenant_id = p_tenant_id
        and c.status = 'open'
        and (v_policy.category is null or c.category = v_policy.category)
        and c.member_count >= v_policy.min_cluster_size
    loop
      perform promote_gap_cluster(v_cluster_id);
      v_promoted := v_promoted + 1;
    end loop;
  end loop;

  return jsonb_build_object(
    'new_members', v_new_members, 'new_clusters', v_new_clusters,
    'reopened_after_fix', v_reopened, 'promoted', v_promoted
  );
end;
$function$;
