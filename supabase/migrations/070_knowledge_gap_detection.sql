-- ============================================================
-- Migration 070: automatic knowledge-gap detection — closes gap-
-- analysis item 23. Today a knowledge gap is only ever created when a
-- human marks an answer "needs improvement" (migration 032). This
-- makes the platform notice its own gaps, the same way it already
-- proactively notices support tickets (034/036), at-risk accounts
-- (037), and stale/overdue items (042) — without ever bypassing the
-- human-approval gate every other knowledge change already goes
-- through.
--
-- DESIGN, in the order it runs:
--   1. A resolved inquiry scores below a tenant's confidence floor
--      SPECIFICALLY because no knowledge was found (not access-
--      denial, not a broken connector — those already have their own
--      handling) — that's a gap CANDIDATE, not yet a gap.
--   2. Its text gets embedded (gte-small, same model as everything
--      else on this platform) by a companion edge function
--      (knowledge-gap-detect) piggybacked onto the existing 5-minute
--      dispatch tick — no new pg_cron job.
--   3. cluster_gap_candidates() (pure SQL, pgvector cosine distance,
--      the same calibrated 0.25 floor already proven live on
--      hybrid_match_knowledge) groups candidates into clusters. A
--      SINGLE low-confidence answer is never actionable — only a
--      cluster crossing a tenant-configurable minimum size within a
--      tenant-configurable window promotes.
--   4. promote_gap_cluster() inserts into the EXACT SAME
--      knowledge_revision_requests queue a human's "needs
--      improvement" click already creates (a system-authored
--      evidence_feedback row satisfies the existing FK — zero change
--      to apply_knowledge_revision/reject_knowledge_revision's core
--      logic). Never auto-publishes; always human-gated.
--   5. Closed loop: if a cluster that already had a fix APPLIED
--      (apply_knowledge_revision's new additive hook marks it
--      resolved) gets NEW members later, that recurrence is the
--      signal the fix didn't actually work — the cluster reopens
--      with an elevated severity rather than the system silently
--      trusting that "published" means "solved."
--
-- Two pieces ship LLM-gated (root_cause_category, reviewer_summary) —
-- columns exist now, populated only once ANTHROPIC_API_KEY exists;
-- until then they stay null and the deterministic pipeline above is
-- the whole feature, not a placeholder.
-- ============================================================

-- ============================================================
-- 1. guardrail_rules gains one new rule_type value. Reuses the exact
-- tenant-configurable pattern-matching table that already powers
-- blocked_phrase/blocked_topic — a frustration_signal rule scores
-- gap-candidate severity instead of gating an answer. No new
-- matching engine, no new table.
-- ============================================================
alter table guardrail_rules drop constraint if exists guardrail_rules_rule_type_check;
alter table guardrail_rules add constraint guardrail_rules_rule_type_check
  check (rule_type = any (array['blocked_topic', 'blocked_phrase', 'require_approval_over_cents', 'max_discount_pct', 'frustration_signal']));

-- ============================================================
-- 2. knowledge_gap_policies — tenant-owned thresholds, same shape as
-- staleness_policies (042): the tenant edits its own rows directly
-- via RLS, no RPC layer needed to tune. One row per (tenant,
-- category) — category null means "applies to every category this
-- tenant doesn't have a more specific row for."
-- ============================================================
create table if not exists knowledge_gap_policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  category text,
  min_confidence_floor integer not null default 60 check (min_confidence_floor between 0 and 100),
  min_cluster_size integer not null default 3 check (min_cluster_size >= 2),
  window_days integer not null default 7 check (window_days > 0),
  similarity_threshold double precision not null default 0.25 check (similarity_threshold > 0 and similarity_threshold <= 1),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, category)
);

create index if not exists idx_knowledge_gap_policies_tenant on knowledge_gap_policies (tenant_id);

alter table knowledge_gap_policies enable row level security;
alter table knowledge_gap_policies force row level security;

create policy knowledge_gap_policies_tenant_read on knowledge_gap_policies
  for select using (tenant_id = auth_tenant_id());

create policy knowledge_gap_policies_tenant_write on knowledge_gap_policies
  for all
  using (
    tenant_id = auth_tenant_id()
    and exists (select 1 from profiles where user_id = auth.uid() and role = any (array['tenant_owner', 'tenant_admin']))
  )
  with check (
    tenant_id = auth_tenant_id()
    and exists (select 1 from profiles where user_id = auth.uid() and role = any (array['tenant_owner', 'tenant_admin']))
  );

revoke all on knowledge_gap_policies from anon, authenticated;
grant select, insert, update, delete on knowledge_gap_policies to authenticated;
grant all on knowledge_gap_policies to service_role;

-- ============================================================
-- 3. knowledge_gap_clusters — one row per detected pattern. Lifecycle
-- mirrors staleness_escalations' open/resolved shape, plus the
-- fix-effectiveness pair that makes the loop genuinely closed rather
-- than "detect and forget."
-- ============================================================
create table if not exists knowledge_gap_clusters (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  category text,
  representative_run_id uuid not null references evidence_runs(id) on delete cascade,
  member_count integer not null default 1,
  severity_score numeric not null default 0,
  root_cause_category text check (root_cause_category in ('missing', 'unretrievable', 'contradicted', 'stale')),
  reviewer_summary text,
  status text not null default 'open' check (status in ('open', 'revision_requested', 'resolved')),
  revision_request_id uuid references knowledge_revision_requests(id) on delete set null,
  pre_fix_avg_confidence numeric,
  fix_applied_at timestamptz,
  recurred_after_fix boolean not null default false,
  recurrence_count integer not null default 0,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_knowledge_gap_clusters_tenant_status on knowledge_gap_clusters (tenant_id, status, last_seen_at desc);

alter table knowledge_gap_clusters enable row level security;
alter table knowledge_gap_clusters force row level security;

create policy knowledge_gap_clusters_tenant_read on knowledge_gap_clusters
  for select using (tenant_id = auth_tenant_id());

revoke all on knowledge_gap_clusters from anon, authenticated;
grant select on knowledge_gap_clusters to authenticated;
grant all on knowledge_gap_clusters to service_role;

-- ============================================================
-- 4. knowledge_gap_cluster_members — which inquiries make up a
-- cluster. This is what lets a reviewer actually see the evidence
-- behind a detected gap, not just a bare count — the same
-- transparency standard every other automated decision on this
-- platform is held to.
-- ============================================================
create table if not exists knowledge_gap_cluster_members (
  id uuid primary key default gen_random_uuid(),
  cluster_id uuid not null references knowledge_gap_clusters(id) on delete cascade,
  evidence_run_id uuid not null references evidence_runs(id) on delete cascade,
  similarity_to_representative double precision,
  frustration_score integer not null default 0 check (frustration_score between 0 and 100),
  added_at timestamptz not null default now(),
  unique (evidence_run_id)
);

create index if not exists idx_knowledge_gap_cluster_members_cluster on knowledge_gap_cluster_members (cluster_id);

alter table knowledge_gap_cluster_members enable row level security;
alter table knowledge_gap_cluster_members force row level security;

create policy knowledge_gap_cluster_members_tenant_read on knowledge_gap_cluster_members
  for select using (
    exists (select 1 from knowledge_gap_clusters c where c.id = cluster_id and c.tenant_id = auth_tenant_id())
  );

revoke all on knowledge_gap_cluster_members from anon, authenticated;
grant select on knowledge_gap_cluster_members to authenticated;
grant all on knowledge_gap_cluster_members to service_role;

-- ============================================================
-- 5. evidence_runs.inquiry_embedding — nullable, populated only for
-- genuine gap candidates (not every inquiry), keeping embedding cost
-- proportional to actual signal, not to traffic. Partial HNSW index
-- since most rows will never have one.
-- ============================================================
alter table evidence_runs add column if not exists inquiry_embedding vector(384);

create index if not exists idx_evidence_runs_inquiry_embedding
  on evidence_runs using hnsw (inquiry_embedding vector_cosine_ops)
  where inquiry_embedding is not null;

-- ============================================================
-- 6. 8th feature_registry entry, same pattern as the other 7.
-- ============================================================
insert into feature_registry (key, label, description, default_enabled, category)
values (
  'knowledge_gap_detection',
  'Automatic Knowledge-Gap Detection',
  'Notices recurring patterns of unanswered questions on its own and proposes a knowledge update for review — without waiting for a human to flag an answer as wrong.',
  true,
  'de_memory'
)
on conflict (key) do nothing;

-- ============================================================
-- 7. score_frustration_internal — deterministic pattern-match scoring
-- against tenant-configured frustration_signal guardrail_rules, using
-- the IDENTICAL fragment-matching loop decide_inquiry_triage already
-- uses for blocked_phrase/blocked_topic (034). No new matching
-- engine. Internal-only: revoked from anon/authenticated/public.
-- ============================================================
create or replace function public.score_frustration_internal(p_tenant_id uuid, p_text text)
returns integer
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_rule   record;
  v_text   text := lower(coalesce(p_text, ''));
  v_frag   text;
  v_hit    boolean;
  v_score  integer := 0;
begin
  for v_rule in
    select id, pattern from guardrail_rules
    where tenant_id = p_tenant_id and active and rule_type = 'frustration_signal'
  loop
    if v_rule.pattern is null then continue; end if;
    foreach v_frag in array string_to_array(v_rule.pattern, '|') loop
      v_frag := trim(both from lower(v_frag));
      if v_frag = '' then continue; end if;
      begin
        v_hit := v_text ~ v_frag;
      exception when others then
        v_hit := position(v_frag in v_text) > 0;
      end;
      if v_hit then
        v_score := v_score + 25;
        exit;
      end if;
    end loop;
  end loop;

  return least(100, v_score);
end;
$function$;

revoke all on function public.score_frustration_internal(uuid, text) from public, anon, authenticated;
grant execute on function public.score_frustration_internal(uuid, text) to service_role;

-- ============================================================
-- 8. get_unembedded_gap_candidates — the SQL half of the split this
-- codebase already established (poll_support_inbox_targets resolves
-- the worklist in SQL, the edge function does the HTTP/runtime work).
-- Returns exactly the rows the edge function needs to embed, for
-- every enabled policy's window/floor, tenant-membership-free since
-- it's service-role-only.
-- ============================================================
create or replace function public.get_unembedded_gap_candidates(p_tenant_id uuid)
returns table(evidence_run_id uuid, inquiry text)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select distinct er.id, er.inquiry
  from evidence_run_decisions erd
  join evidence_runs er on er.id = erd.evidence_run_id
  join knowledge_gap_policies p on p.tenant_id = erd.tenant_id
    and (p.category is null or p.category = erd.source_category)
    and p.enabled = true
  where erd.tenant_id = p_tenant_id
    and erd.confidence < p.min_confidence_floor
    and er.inquiry_embedding is null
    and er.created_at >= now() - make_interval(days => p.window_days)
    -- knowledge-caused shortfall only: zero knowledge hits, not an
    -- access-denial or a system failure (those already have their
    -- own handling elsewhere on this platform).
    and coalesce((er.confidence_inputs->>'knowledge_hits')::int, 0) = 0
    and coalesce((er.confidence_inputs->>'systems_denied_no_access')::int, 0) = 0
    and coalesce((er.confidence_inputs->>'systems_failed')::int, 0) = 0
  limit 200;
$function$;

revoke all on function public.get_unembedded_gap_candidates(uuid) from public, anon, authenticated;
grant execute on function public.get_unembedded_gap_candidates(uuid) to service_role;

-- ============================================================
-- 9. cluster_gap_candidates — the core detection pass. Pure SQL, no
-- LLM required. For every enabled policy, walks embedded-but-
-- unclustered candidates and either joins the nearest cluster within
-- the calibrated similarity floor or seeds a new one. Promotes any
-- cluster crossing its policy's min_cluster_size. Reopens a RESOLVED
-- cluster that gets a new member — that recurrence-after-fix is the
-- closed-loop signal a shipped fix didn't actually work.
-- ============================================================
create or replace function public.cluster_gap_candidates(p_tenant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
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
    for v_cluster_id in
      select c.id from knowledge_gap_clusters c
      where c.tenant_id = p_tenant_id
        and c.status = 'open'
        and c.category is not distinct from v_policy.category
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

revoke all on function public.cluster_gap_candidates(uuid) from public, anon, authenticated;
grant execute on function public.cluster_gap_candidates(uuid) to service_role;

-- ============================================================
-- 10. promote_gap_cluster — plugs a detected cluster into the EXACT
-- SAME human-review queue submit_evidence_feedback (032) already
-- uses. A system-authored evidence_feedback row (reviewer_user_id =
-- null, the same "system" actor pattern used everywhere else on this
-- platform for cron-driven writes) satisfies knowledge_revision_
-- requests.feedback_id's existing NOT NULL FK — zero schema change,
-- and apply_knowledge_revision/reject_knowledge_revision need no
-- changes to their core logic since they already operate on any
-- pending-approval row regardless of where it came from.
--
-- proposed_body_md stays server-composed from real evidence, exactly
-- like the human-triggered path — the representative inquiry, up to
-- 3 member excerpts, and the measured average confidence. Never LLM
-- prose; reviewer_summary (populated separately, LLM-gated, null
-- until ANTHROPIC_API_KEY exists) is the one field allowed to be
-- generative, because it never leaves the human-review screen.
-- ============================================================
create or replace function public.promote_gap_cluster(p_cluster_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_cluster        record;
  v_rep_inquiry    text;
  v_excerpts       text := '';
  v_member         record;
  v_avg_confidence numeric;
  v_feedback_id    uuid;
  v_revision_id    uuid;
  v_task_id        uuid;
  v_proposed_title text;
  v_proposed_body  text;
  v_excerpt_count  integer := 0;
begin
  select * into v_cluster from knowledge_gap_clusters where id = p_cluster_id;
  if v_cluster.id is null or v_cluster.status <> 'open' then
    return jsonb_build_object('ok', false, 'error', 'not_open');
  end if;

  select inquiry into v_rep_inquiry from evidence_runs where id = v_cluster.representative_run_id;

  for v_member in
    select er.inquiry
    from knowledge_gap_cluster_members m
    join evidence_runs er on er.id = m.evidence_run_id
    where m.cluster_id = p_cluster_id and er.id <> v_cluster.representative_run_id
    order by m.added_at asc
    limit 3
  loop
    v_excerpt_count := v_excerpt_count + 1;
    v_excerpts := v_excerpts || format('%s. "%s"%s', v_excerpt_count, left(v_member.inquiry, 200), E'\n');
  end loop;

  select round(avg(erd.confidence)) into v_avg_confidence
  from knowledge_gap_cluster_members m
  join evidence_run_decisions erd on erd.evidence_run_id = m.evidence_run_id
  where m.cluster_id = p_cluster_id;

  insert into evidence_feedback (tenant_id, evidence_run_id, reviewer_user_id, verdict, notes)
  values (
    v_cluster.tenant_id, v_cluster.representative_run_id, null, 'needs_improvement',
    format('Auto-detected: %s similar questions went unanswered in the current window.', v_cluster.member_count)
  )
  returning id into v_feedback_id;

  v_proposed_title := 'Recurring gap: ' || left(v_rep_inquiry, 80);
  v_proposed_body :=
    '## Detected pattern' || E'\n'
    || format('%s customers asked something like this within the same window, and none of them got a good answer (average confidence: %s%%).', v_cluster.member_count, coalesce(v_avg_confidence, 0)) || E'\n\n'
    || '## Representative question' || E'\n' || coalesce(v_rep_inquiry, '') || E'\n\n'
    || case when v_excerpts <> '' then '## Other questions in this pattern' || E'\n' || v_excerpts || E'\n' else '' end
    || '## No existing knowledge adequately covered this' || E'\n'
    || 'This is a detected pattern, not a drafted answer — write or link the content that actually resolves it.';

  insert into knowledge_revision_requests (
    tenant_id, source_doc_id, evidence_run_id, feedback_id,
    proposed_title, proposed_body_md, status, created_by
  ) values (
    v_cluster.tenant_id, null, v_cluster.representative_run_id, v_feedback_id,
    v_proposed_title, v_proposed_body, 'pending_approval', null
  ) returning id into v_revision_id;

  insert into human_tasks (
    tenant_id, type, title, detail, source, related_table, related_id, status
  ) values (
    v_cluster.tenant_id, 'knowledge_revision',
    'Review detected knowledge gap: ' || v_proposed_title,
    format('%s similar low-confidence questions were automatically detected as a recurring pattern.', v_cluster.member_count),
    'system', 'knowledge_revision_requests', v_revision_id, 'pending'
  ) returning id into v_task_id;

  update knowledge_gap_clusters
  set status = 'revision_requested', revision_request_id = v_revision_id,
      pre_fix_avg_confidence = v_avg_confidence, updated_at = now()
  where id = p_cluster_id;

  perform append_audit_event_internal(
    v_cluster.tenant_id, 'DreamTeam', 'system',
    format('Automatic knowledge-gap detection flagged a recurring pattern (%s similar questions) — "%s"', v_cluster.member_count, v_proposed_title),
    'knowledge_revision',
    jsonb_build_object('kind', 'knowledge_gap_detected', 'cluster_id', p_cluster_id,
      'revision_request_id', v_revision_id, 'task_id', v_task_id, 'member_count', v_cluster.member_count)
  );

  return jsonb_build_object('ok', true, 'revision_request_id', v_revision_id, 'task_id', v_task_id);
end;
$function$;

revoke all on function public.promote_gap_cluster(uuid) from public, anon, authenticated;
grant execute on function public.promote_gap_cluster(uuid) to service_role;

-- ============================================================
-- 11. apply_knowledge_revision gains one additive hook at the end:
-- if the applied request is the one a gap cluster is waiting on, mark
-- that cluster resolved and stamp fix_applied_at. Everything above
-- this hook is byte-identical to the live definition. Harmless no-op
-- for every human-triggered revision, since no cluster points at
-- those.
-- ============================================================
create or replace function public.apply_knowledge_revision(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user          uuid := auth.uid();
  v_caller_tenant uuid;
  v_is_active     boolean;
  v_req           record;
  v_new_doc_id    uuid;
  v_actor_name    text;
begin
  select * into v_req from knowledge_revision_requests where id = p_request_id;
  if v_req.id is null then
    return jsonb_build_object('ok', false, 'error', 'request_not_found');
  end if;
  if v_req.status <> 'pending_approval' then
    return jsonb_build_object('ok', false, 'error', 'not_pending', 'status', v_req.status);
  end if;

  if v_user is not null then
    select tenant_id, coalesce(is_active, true) into v_caller_tenant, v_is_active from profiles where user_id = v_user;
    if v_caller_tenant is null or v_caller_tenant <> v_req.tenant_id then
      return jsonb_build_object('ok', false, 'error', 'not_tenant_member');
    end if;
    if not v_is_active then
      return jsonb_build_object('ok', false, 'error', 'not_tenant_member');
    end if;
  elsif coalesce(auth.role(), '') <> 'service_role' then
    return jsonb_build_object('ok', false, 'error', 'not_tenant_member');
  end if;

  select coalesce(full_name, 'A reviewer') into v_actor_name from profiles where user_id = v_user;
  v_actor_name := coalesce(v_actor_name, 'A reviewer');

  insert into knowledge_docs (
    tenant_id, title, content, source, tags, previous_version_id, is_current, visibility
  )
  select
    v_req.tenant_id, v_req.proposed_title, v_req.proposed_body_md, 'paste',
    coalesce((select tags from knowledge_docs where id = v_req.source_doc_id), '{}'),
    v_req.source_doc_id, true,
    coalesce((select visibility from knowledge_docs where id = v_req.source_doc_id), 'tenant')
  returning id into v_new_doc_id;

  if v_req.source_doc_id is not null then
    update knowledge_docs set is_current = false where id = v_req.source_doc_id;
  end if;

  update knowledge_revision_requests
    set status = 'applied', decided_by = v_user, decided_at = now(), applied_doc_id = v_new_doc_id
    where id = p_request_id;

  perform append_audit_event(
    v_req.tenant_id, v_actor_name, case when v_user is null then 'system' else 'human' end,
    v_actor_name || ' approved and applied a knowledge revision — "' || v_req.proposed_title || '"',
    'knowledge_revision',
    jsonb_build_object('kind', 'knowledge_revision_applied', 'revision_request_id', p_request_id,
      'new_doc_id', v_new_doc_id, 'previous_doc_id', v_req.source_doc_id)
  );

  -- Additive: if a gap cluster was waiting on this exact request,
  -- mark it resolved and stamp when the fix landed. Recurrence after
  -- this point (cluster_gap_candidates reopening it) is the honest
  -- signal the fix didn't actually work.
  update knowledge_gap_clusters
  set status = 'resolved', fix_applied_at = now(), updated_at = now()
  where revision_request_id = p_request_id and status = 'revision_requested';

  return jsonb_build_object('ok', true, 'new_doc_id', v_new_doc_id, 'previous_doc_id', v_req.source_doc_id);
end;
$function$;

-- ============================================================
-- 12. reject_knowledge_revision gains the mirror-image additive hook:
-- if a human rejects a gap-triggered proposal, reopen the cluster
-- (rather than leaving it permanently dead-ended at
-- 'revision_requested') so it can keep accumulating and re-promote
-- later if the pattern persists. Everything above this hook is
-- byte-identical to the live definition.
-- ============================================================
create or replace function public.reject_knowledge_revision(p_request_id uuid, p_reason text default ''::text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user          uuid := auth.uid();
  v_caller_tenant uuid;
  v_is_active     boolean;
  v_req           record;
  v_actor_name    text;
begin
  select * into v_req from knowledge_revision_requests where id = p_request_id;
  if v_req.id is null then
    return jsonb_build_object('ok', false, 'error', 'request_not_found');
  end if;
  if v_req.status <> 'pending_approval' then
    return jsonb_build_object('ok', false, 'error', 'not_pending', 'status', v_req.status);
  end if;

  if v_user is not null then
    select tenant_id, coalesce(is_active, true) into v_caller_tenant, v_is_active from profiles where user_id = v_user;
    if v_caller_tenant is null or v_caller_tenant <> v_req.tenant_id then
      return jsonb_build_object('ok', false, 'error', 'not_tenant_member');
    end if;
    if not v_is_active then
      return jsonb_build_object('ok', false, 'error', 'not_tenant_member');
    end if;
  elsif coalesce(auth.role(), '') <> 'service_role' then
    return jsonb_build_object('ok', false, 'error', 'not_tenant_member');
  end if;

  select coalesce(full_name, 'A reviewer') into v_actor_name from profiles where user_id = v_user;
  v_actor_name := coalesce(v_actor_name, 'A reviewer');

  update knowledge_revision_requests
    set status = 'rejected', decided_by = v_user, decided_at = now()
    where id = p_request_id;

  perform append_audit_event(
    v_req.tenant_id, v_actor_name, case when v_user is null then 'system' else 'human' end,
    v_actor_name || ' rejected a proposed knowledge revision — "' || v_req.proposed_title || '"'
      || case when coalesce(p_reason, '') <> '' then ' (' || p_reason || ')' else '' end,
    'knowledge_revision',
    jsonb_build_object('kind', 'knowledge_revision_rejected', 'revision_request_id', p_request_id, 'reason', coalesce(p_reason, ''))
  );

  -- Additive: a rejected gap-triggered proposal reopens its cluster
  -- rather than dead-ending it — the underlying pattern may still be
  -- real even if this particular draft wasn't the right fix.
  update knowledge_gap_clusters
  set status = 'open', revision_request_id = null, updated_at = now()
  where revision_request_id = p_request_id and status = 'revision_requested';

  return jsonb_build_object('ok', true);
end;
$function$;

-- ============================================================
-- 13. invoke_playbook_dispatch gains one more piggyback — the
-- embedding half of gap detection needs an edge function (Postgres
-- can't compute gte-small embeddings itself), so this fires the SAME
-- way playbook-execute and specialist-consult already do: one more
-- net.http_post on the existing 5-minute tick, no new pg_cron job,
-- wrapped so a failure here can never block or be blocked by the
-- other three piggybacks. The edge function itself calls
-- cluster_gap_candidates() once embeddings are written, so this
-- single HTTP call covers both halves of the pipeline.
-- ============================================================
create or replace function public.invoke_playbook_dispatch()
returns text
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_secret  text;
  v_req_id  bigint;
  v_req_id2 bigint;
  v_req_id3 bigint;
  v_t       record;
  v_health  integer := 0;
  v_stale   jsonb;
begin
  for v_t in
    select distinct ca.tenant_id
    from customer_accounts ca
    left join health_score_config c on c.tenant_id = ca.tenant_id
    where c.last_computed_at is null or c.last_computed_at < now() - interval '24 hours'
  loop
    perform compute_tenant_health_service(v_t.tenant_id);
    v_health := v_health + 1;
  end loop;

  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'playbook_dispatch_secret'
  limit 1;
  if v_secret is null then
    return format('health:%s no_secret', v_health);
  end if;

  select net.http_post(
    url     := 'https://rfsvmhcqeiyrxivbmpel.supabase.co/functions/v1/playbook-execute',
    body    := '{"action":"dispatch"}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-dispatch-secret', v_secret
    ),
    timeout_milliseconds := 30000
  ) into v_req_id;

  select net.http_post(
    url     := 'https://rfsvmhcqeiyrxivbmpel.supabase.co/functions/v1/specialist-consult',
    body    := '{"action":"poll_de_work_sources"}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-dispatch-secret', v_secret
    ),
    timeout_milliseconds := 30000
  ) into v_req_id2;

  begin
    v_stale := check_staleness();
  exception when others then
    v_stale := jsonb_build_object('error', sqlerrm);
  end;

  -- Piggyback #3: automatic knowledge-gap detection (070). Independent
  -- request; a failure here never blocks or is blocked by the two
  -- dispatch calls above.
  begin
    select net.http_post(
      url     := 'https://rfsvmhcqeiyrxivbmpel.supabase.co/functions/v1/knowledge-gap-detect',
      body    := '{}'::jsonb,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-dispatch-secret', v_secret
      ),
      timeout_milliseconds := 30000
    ) into v_req_id3;
  exception when others then
    v_req_id3 := null;
  end;

  return format('health:%s queued:%s,%s,%s staleness:%s', v_health, v_req_id, v_req_id2, v_req_id3, v_stale::text);
end;
$function$;
