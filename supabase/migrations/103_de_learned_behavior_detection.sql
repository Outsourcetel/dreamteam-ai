-- ============================================================
-- Migration 103: automatic learned-behavior detection — the real
-- backend for the "Self-Learning" page (last of the 8-page rebuild).
--
-- Direct structural parallel to migration 070's knowledge-gap
-- detection (embed → nearest-cluster join-or-seed via cosine distance
-- → promote once a tenant-configurable count threshold is crossed →
-- human reviews via the existing human_tasks queue → resolve on
-- applied fix → REOPEN if the same pattern recurs afterward). That
-- pipeline shape is deliberately reused wholesale rather than
-- reinvented — this migration's real contribution is a genuinely
-- different SIGNAL and a genuinely different, already-enforcing
-- ACTIVATION target.
--
-- THE SIGNAL (confirmed, by direct research, not to previously exist
-- anywhere in this schema): "a human corrected what a DE decided."
-- human_tasks.type already reserves 'override' and 'training_feedback'
-- for exactly this kind of thing, but neither has ever had a writer —
-- dead vocabulary since the earliest migrations. Rather than build a
-- new manual "tell us what should have happened" UI (a much bigger,
-- slower-to-populate lift), this derives the signal from data ALREADY
-- flowing today: evidence_run_decisions rows where decision =
-- 'needs_review', joined to their linked human_tasks row once a human
-- has actually decided it.
--   - human rejects  → the DE's proposed answer was wrong  → CORRECTION evidence
--   - human approves → the DE didn't need to be this cautious → OVERCAUTION evidence
-- Confirmed live: 57 real needs_review decisions exist today, all
-- still pending — so this pipeline starts with zero real candidates,
-- same honest-empty-state situation knowledge-gap detection started
-- in. Nothing here is faked to look busier than it is.
--
-- THE ACTIVATION (real, already-enforcing, confirmed generic across
-- Support/Account/Finance DE types by direct research):
--   - CORRECTION clusters propose inserting a new guardrail_rules row
--     (rule_type = 'blocked_phrase' or 'blocked_topic'), pattern
--     seeded from the real representative inquiry text, human edits
--     before approving. Takes effect on the very next
--     decide_inquiry_triage-equivalent evaluation for EVERY DE type —
--     zero new enforcement code, since guardrail_rules is already the
--     platform's one generic, tenant-authored pattern-matching engine.
--   - OVERCAUTION clusters point at the SPECIFIC existing
--     guardrail_rule_id the evidence shows is proven too strict
--     (evidence_run_decisions.guardrail_rule_id already links a
--     needs_review decision to the rule that triggered it) and
--     propose loosening or removing it.
-- Neither path touches trust_policies/de_autonomy — those are
-- evidence-gated promotion/demotion RPCs with their own careful
-- staleness-recheck logic (apply_trust_promotion); this migration
-- doesn't bypass that, it adds a second, narrower, guardrail-level
-- lever alongside it.
--
-- DOMAIN FIT: per docs/05_Core_Domain_Model.md, this sits between
-- #34 Recommendation (an evidence-grounded suggestion) and #29 Policy
-- (an enforced constraint a DE cannot override) — a learned behavior
-- IS a Recommendation until a human approves it, at which point it
-- becomes a real Policy row (a guardrail_rules insert/update). Design
-- Rule #10 ("DreamTeam may suggest Policy templates; it may never
-- impose Policies... without consent") is exactly why every promotion
-- here lands in a human_tasks review, never auto-applies.
-- ============================================================

-- ------------------------------------------------------------
-- 1. de_learning_policies — tenant-owned thresholds, same shape as
-- knowledge_gap_policies (070): direct RLS-gated tenant writes, no
-- RPC layer needed to tune. category null = wildcard.
-- ------------------------------------------------------------
create table if not exists de_learning_policies (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  category            text,
  min_cluster_size    integer not null default 3 check (min_cluster_size >= 2),
  window_days         integer not null default 14 check (window_days > 0),
  similarity_threshold double precision not null default 0.25 check (similarity_threshold > 0 and similarity_threshold <= 1),
  enabled             boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (tenant_id, category)
);

create index if not exists idx_de_learning_policies_tenant on de_learning_policies (tenant_id);

alter table de_learning_policies enable row level security;
alter table de_learning_policies force row level security;

create policy de_learning_policies_tenant_read on de_learning_policies
  for select using (tenant_id = auth_tenant_id());

create policy de_learning_policies_tenant_write on de_learning_policies
  for all
  using (
    tenant_id = auth_tenant_id()
    and exists (select 1 from profiles where user_id = auth.uid() and role = any (array['tenant_owner', 'tenant_admin']))
  )
  with check (
    tenant_id = auth_tenant_id()
    and exists (select 1 from profiles where user_id = auth.uid() and role = any (array['tenant_owner', 'tenant_admin']))
  );

revoke all on de_learning_policies from anon, authenticated;
grant select, insert, update, delete on de_learning_policies to authenticated;
grant all on de_learning_policies to service_role;

-- ------------------------------------------------------------
-- 2. de_learned_behavior_clusters — one row per detected pattern of
-- repeated correction or repeated overcaution, scoped per-DE (a
-- pattern in how Alex behaves is a different thing from the same
-- pattern in how Casey behaves) and per-verdict-type (never mixing
-- "the DE was wrong" evidence with "the DE was too cautious" evidence
-- in the same cluster).
-- ------------------------------------------------------------
create table if not exists de_learned_behavior_clusters (
  id                       uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null references tenants(id) on delete cascade,
  de_id                    uuid not null references digital_employees(id) on delete cascade,
  category                 text,
  verdict_type             text not null check (verdict_type in ('correction', 'overcaution')),
  representative_run_id    uuid not null references evidence_runs(id) on delete cascade,
  guardrail_rule_id        uuid references guardrail_rules(id) on delete set null,
  member_count             integer not null default 1,
  severity_score           numeric not null default 0,
  status                   text not null default 'open' check (status in ('open', 'proposed', 'resolved')),
  proposed_rule            jsonb,
  human_task_id            uuid references human_tasks(id) on delete set null,
  resulting_guardrail_rule_id uuid references guardrail_rules(id) on delete set null,
  pre_fix_avg_confidence   numeric,
  fix_applied_at           timestamptz,
  recurred_after_fix       boolean not null default false,
  recurrence_count         integer not null default 0,
  first_seen_at            timestamptz not null default now(),
  last_seen_at             timestamptz not null default now(),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index if not exists idx_de_learned_behavior_clusters_tenant_status on de_learned_behavior_clusters (tenant_id, status, last_seen_at desc);
create index if not exists idx_de_learned_behavior_clusters_de on de_learned_behavior_clusters (de_id);

alter table de_learned_behavior_clusters enable row level security;
alter table de_learned_behavior_clusters force row level security;

create policy de_learned_behavior_clusters_tenant_read on de_learned_behavior_clusters
  for select using (tenant_id = auth_tenant_id());

revoke all on de_learned_behavior_clusters from anon, authenticated;
grant select on de_learned_behavior_clusters to authenticated;
grant all on de_learned_behavior_clusters to service_role;

-- ------------------------------------------------------------
-- 3. de_learned_behavior_cluster_members — the real evidence behind a
-- cluster: which decisions, and which human verdict on each.
-- ------------------------------------------------------------
create table if not exists de_learned_behavior_cluster_members (
  id                          uuid primary key default gen_random_uuid(),
  cluster_id                  uuid not null references de_learned_behavior_clusters(id) on delete cascade,
  evidence_run_id              uuid not null references evidence_runs(id) on delete cascade,
  human_task_id                uuid references human_tasks(id) on delete set null,
  similarity_to_representative double precision,
  added_at                     timestamptz not null default now(),
  unique (evidence_run_id)
);

create index if not exists idx_de_learned_behavior_cluster_members_cluster on de_learned_behavior_cluster_members (cluster_id);

alter table de_learned_behavior_cluster_members enable row level security;
alter table de_learned_behavior_cluster_members force row level security;

create policy de_learned_behavior_cluster_members_tenant_read on de_learned_behavior_cluster_members
  for select using (
    exists (select 1 from de_learned_behavior_clusters c where c.id = cluster_id and c.tenant_id = auth_tenant_id())
  );

revoke all on de_learned_behavior_cluster_members from anon, authenticated;
grant select on de_learned_behavior_cluster_members to authenticated;
grant all on de_learned_behavior_cluster_members to service_role;

-- ------------------------------------------------------------
-- 4. feature_registry entry, same pattern as the other 8 flags
-- (068's account_de/finance_de, 070's knowledge_gap_detection).
-- ------------------------------------------------------------
insert into feature_registry (key, label, description, default_enabled, category)
values (
  'de_learned_behavior_detection',
  'Automatic Learned-Behavior Detection',
  'Notices when a Digital Employee keeps getting the same kind of correction (or keeps being unnecessarily routed for review) and proposes a real policy change for a human to approve — never applies a change on its own.',
  true,
  'de_memory'
)
on conflict (key) do nothing;

-- ------------------------------------------------------------
-- 5. get_unembedded_learned_behavior_candidates — the SQL half of the
-- established embed-elsewhere split (get_unembedded_gap_candidates,
-- poll_support_inbox_targets). A candidate is any needs_review
-- decision whose linked human_tasks row has actually been decided,
-- that isn't already embedded or already a cluster member.
-- ------------------------------------------------------------
create or replace function public.get_unembedded_learned_behavior_candidates(p_tenant_id uuid)
returns table(evidence_run_id uuid, inquiry text)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select distinct er.id, er.inquiry
  from evidence_run_decisions erd
  join evidence_runs er on er.id = erd.evidence_run_id
  join human_tasks ht on ht.id = erd.human_task_id
  join de_learning_policies p on p.tenant_id = erd.tenant_id
    and (p.category is null or p.category = erd.source_category)
    and p.enabled = true
  where erd.tenant_id = p_tenant_id
    and erd.decision = 'needs_review'
    and ht.status in ('approved', 'rejected')
    and er.inquiry_embedding is null
    and er.de_id is not null
    and er.created_at >= now() - make_interval(days => p.window_days)
    and not exists (select 1 from de_learned_behavior_cluster_members m where m.evidence_run_id = er.id)
  limit 200;
$function$;

revoke all on function public.get_unembedded_learned_behavior_candidates(uuid) from public, anon, authenticated;
grant execute on function public.get_unembedded_learned_behavior_candidates(uuid) to service_role;

-- ------------------------------------------------------------
-- 6. cluster_learned_behavior_candidates — the core detection pass.
-- Deterministic SQL, pgvector cosine distance, the same calibrated
-- floor as knowledge-gap detection. Clusters are scoped to the SAME
-- (de_id, verdict_type, category) — never mixing DEs or verdict
-- types — and for overcaution specifically, the SAME guardrail_rule_id
-- (a tight, safe scope: "this exact rule, proven too strict").
-- ------------------------------------------------------------
create or replace function public.cluster_learned_behavior_candidates(p_tenant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
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
             ht.status as task_status
      from evidence_run_decisions erd
      join evidence_runs er on er.id = erd.evidence_run_id
      join human_tasks ht on ht.id = erd.human_task_id
      where erd.tenant_id = p_tenant_id
        and erd.decision = 'needs_review'
        and ht.status in ('approved', 'rejected')
        and (v_policy.category is null or erd.source_category = v_policy.category)
        and er.inquiry_embedding is not null
        and er.de_id is not null
        and er.created_at >= now() - make_interval(days => v_policy.window_days)
        and not exists (select 1 from de_learned_behavior_cluster_members m where m.evidence_run_id = er.id)
      order by er.created_at asc
    loop
      -- reject -> the DE's proposed answer was wrong (correction evidence)
      -- approve -> the DE didn't need to be this cautious (overcaution evidence)
      v_verdict := case when v_candidate.task_status = 'rejected' then 'correction' else 'overcaution' end;

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

-- Small internal helper so the loop above doesn't need a second join
-- just to carry human_task_id into the members insert.
create or replace function public.erd_human_task_id(p_decision_id uuid)
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $function$
  select human_task_id from evidence_run_decisions where id = p_decision_id;
$function$;

revoke all on function public.erd_human_task_id(uuid) from public, anon, authenticated;
grant execute on function public.erd_human_task_id(uuid) to service_role;

revoke all on function public.cluster_learned_behavior_candidates(uuid) from public, anon, authenticated;
grant execute on function public.cluster_learned_behavior_candidates(uuid) to service_role;

-- ------------------------------------------------------------
-- 7. propose_learned_behavior — promotes a detected cluster into a
-- REAL human_tasks row (type='training_feedback' — reserved since the
-- earliest migrations, never had a writer until now). The proposed
-- rule text is composed from real evidence only (the representative
-- inquiry, or the existing rule's own pattern) — never LLM prose,
-- matching 070's own discipline. A human can edit the pattern/
-- threshold before approving (see approve_learned_behavior below).
-- ------------------------------------------------------------
create or replace function public.propose_learned_behavior(p_cluster_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_cluster        record;
  v_de_name        text;
  v_rep_inquiry    text;
  v_existing_rule  record;
  v_avg_confidence numeric;
  v_proposed       jsonb;
  v_title          text;
  v_detail         text;
  v_task_id        uuid;
begin
  select * into v_cluster from de_learned_behavior_clusters where id = p_cluster_id;
  if v_cluster.id is null or v_cluster.status <> 'open' then
    return jsonb_build_object('ok', false, 'error', 'not_open');
  end if;

  select name into v_de_name from digital_employees where id = v_cluster.de_id;
  select inquiry into v_rep_inquiry from evidence_runs where id = v_cluster.representative_run_id;

  select round(avg(erd.confidence)) into v_avg_confidence
  from de_learned_behavior_cluster_members m
  join evidence_run_decisions erd on erd.evidence_run_id = m.evidence_run_id
  where m.cluster_id = p_cluster_id;

  if v_cluster.verdict_type = 'correction' then
    v_proposed := jsonb_build_object(
      'action', 'insert_guardrail_rule',
      'rule_type', 'blocked_phrase',
      'suggested_pattern', left(regexp_replace(lower(coalesce(v_rep_inquiry, '')), '[^a-z0-9 ]', '', 'g'), 80),
      'severity', 'warning',
      'rationale', format('%s similar inquiries from %s were reviewed and corrected by a human within the current window (average confidence %s%%).',
        v_cluster.member_count, coalesce(v_de_name, 'this DE'), coalesce(v_avg_confidence, 0))
    );
    v_title := format('Learned behavior: %s keeps getting corrected on a recurring question', coalesce(v_de_name, 'a DE'));
    v_detail := format('%s similar questions were routed for review and a human corrected the answer each time — a candidate for a new guardrail rule.', v_cluster.member_count);
  else
    select * into v_existing_rule from guardrail_rules where id = v_cluster.guardrail_rule_id;
    v_proposed := jsonb_build_object(
      'action', 'loosen_guardrail_rule',
      'guardrail_rule_id', v_cluster.guardrail_rule_id,
      'current_rule_label', v_existing_rule.rule,
      'current_pattern', v_existing_rule.pattern,
      'rationale', format('%s similar inquiries from %s matched the guardrail "%s" and a human approved the answer every time within the current window (average confidence %s%%) — this rule may be too strict for this pattern.',
        v_cluster.member_count, coalesce(v_de_name, 'this DE'), coalesce(v_existing_rule.rule, '(rule)'), coalesce(v_avg_confidence, 0))
    );
    v_title := format('Learned behavior: %s is being routed for review needlessly', coalesce(v_de_name, 'a DE'));
    v_detail := format('%s similar questions were routed for review by the guardrail "%s," and a human approved the answer every time — a candidate for loosening that rule.', v_cluster.member_count, coalesce(v_existing_rule.rule, '(rule)'));
  end if;

  insert into human_tasks (
    tenant_id, type, title, detail, source, related_table, related_id, status
  ) values (
    v_cluster.tenant_id, 'training_feedback', v_title, v_detail, 'system',
    'de_learned_behavior_clusters', p_cluster_id, 'pending'
  ) returning id into v_task_id;

  update de_learned_behavior_clusters
  set status = 'proposed', proposed_rule = v_proposed, human_task_id = v_task_id,
      pre_fix_avg_confidence = v_avg_confidence, updated_at = now()
  where id = p_cluster_id;

  perform append_audit_event_internal(
    v_cluster.tenant_id, 'DreamTeam', 'system',
    format('Automatic learned-behavior detection flagged a recurring pattern (%s similar decisions, %s) for %s — "%s"',
      v_cluster.member_count, v_cluster.verdict_type, coalesce(v_de_name, 'a DE'), v_title),
    'config_change',
    jsonb_build_object('kind', 'learned_behavior_detected', 'cluster_id', p_cluster_id, 'task_id', v_task_id, 'verdict_type', v_cluster.verdict_type)
  );

  return jsonb_build_object('ok', true, 'task_id', v_task_id, 'proposed_rule', v_proposed);
end;
$function$;

revoke all on function public.propose_learned_behavior(uuid) from public, anon, authenticated;
grant execute on function public.propose_learned_behavior(uuid) to service_role;

-- ------------------------------------------------------------
-- 8. approve_learned_behavior / reject_learned_behavior — the human
-- gate. Approving REALLY inserts/updates a guardrail_rules row (the
-- one already-generic, already-enforcing lever every DE type reads
-- from) — a human may override the suggested pattern/threshold
-- before approving. Rejecting reopens the cluster (same non-dead-
-- ending discipline as reject_knowledge_revision) rather than
-- discarding real evidence.
-- ------------------------------------------------------------
create or replace function public.approve_learned_behavior(p_cluster_id uuid, p_final_pattern text default null::text, p_final_threshold bigint default null::bigint)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user          uuid := auth.uid();
  v_caller_tenant uuid;
  v_is_active     boolean;
  v_cluster       record;
  v_rule_id       uuid;
  v_pattern       text;
begin
  select * into v_cluster from de_learned_behavior_clusters where id = p_cluster_id;
  if v_cluster.id is null or v_cluster.status <> 'proposed' then
    return jsonb_build_object('ok', false, 'error', 'not_proposed');
  end if;

  select tenant_id, coalesce(is_active, true) into v_caller_tenant, v_is_active from profiles where user_id = v_user;
  if v_caller_tenant is distinct from v_cluster.tenant_id then
    return jsonb_build_object('ok', false, 'error', 'not_tenant_member');
  end if;
  if not v_is_active then
    return jsonb_build_object('ok', false, 'error', 'not_tenant_member');
  end if;

  if v_cluster.verdict_type = 'correction' then
    v_pattern := coalesce(p_final_pattern, v_cluster.proposed_rule->>'suggested_pattern');
    if coalesce(btrim(v_pattern), '') = '' then
      return jsonb_build_object('ok', false, 'error', 'pattern_required');
    end if;
    insert into guardrail_rules (tenant_id, rule, rule_type, pattern, severity, active, created_by)
    values (
      v_cluster.tenant_id,
      format('Learned behavior — %s', left(v_pattern, 60)),
      coalesce(v_cluster.proposed_rule->>'rule_type', 'blocked_phrase'),
      v_pattern, 'warning', true, v_user
    )
    returning id into v_rule_id;
  else
    v_rule_id := v_cluster.guardrail_rule_id;
    if v_rule_id is null then
      return jsonb_build_object('ok', false, 'error', 'no_target_rule');
    end if;
    if p_final_threshold is not null then
      update guardrail_rules set threshold = p_final_threshold, updated_at = now() where id = v_rule_id and tenant_id = v_cluster.tenant_id;
    elsif p_final_pattern is not null then
      update guardrail_rules set pattern = p_final_pattern, updated_at = now() where id = v_rule_id and tenant_id = v_cluster.tenant_id;
    else
      -- No override given: the evidence says this rule is too strict for
      -- this whole pattern — the honest default is to deactivate it
      -- rather than silently leave it exactly as-is (which would make
      -- "approve" a no-op).
      update guardrail_rules set active = false, updated_at = now() where id = v_rule_id and tenant_id = v_cluster.tenant_id;
    end if;
  end if;

  update de_learned_behavior_clusters
  set status = 'resolved', fix_applied_at = now(), resulting_guardrail_rule_id = v_rule_id, updated_at = now()
  where id = p_cluster_id;

  if v_cluster.human_task_id is not null then
    update human_tasks set status = 'approved', decided_by = v_user, decided_at = now() where id = v_cluster.human_task_id;
  end if;

  perform append_audit_event(
    v_cluster.tenant_id, coalesce((select full_name from profiles where user_id = v_user), 'A reviewer'), 'human',
    format('Approved a learned behavior (%s) — %s guardrail rule %s', v_cluster.verdict_type,
      case when v_cluster.verdict_type = 'correction' then 'created' else 'updated' end, v_rule_id),
    'config_change',
    jsonb_build_object('kind', 'learned_behavior_approved', 'cluster_id', p_cluster_id, 'guardrail_rule_id', v_rule_id)
  );

  return jsonb_build_object('ok', true, 'guardrail_rule_id', v_rule_id);
end;
$function$;

create or replace function public.reject_learned_behavior(p_cluster_id uuid, p_reason text default ''::text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user          uuid := auth.uid();
  v_caller_tenant uuid;
  v_is_active     boolean;
  v_cluster       record;
begin
  select * into v_cluster from de_learned_behavior_clusters where id = p_cluster_id;
  if v_cluster.id is null or v_cluster.status <> 'proposed' then
    return jsonb_build_object('ok', false, 'error', 'not_proposed');
  end if;

  select tenant_id, coalesce(is_active, true) into v_caller_tenant, v_is_active from profiles where user_id = v_user;
  if v_caller_tenant is distinct from v_cluster.tenant_id then
    return jsonb_build_object('ok', false, 'error', 'not_tenant_member');
  end if;
  if not v_is_active then
    return jsonb_build_object('ok', false, 'error', 'not_tenant_member');
  end if;

  if v_cluster.human_task_id is not null then
    update human_tasks set status = 'rejected', decided_by = v_user, decided_at = now() where id = v_cluster.human_task_id;
  end if;

  update de_learned_behavior_clusters
  set status = 'open', human_task_id = null, updated_at = now()
  where id = p_cluster_id;

  perform append_audit_event(
    v_cluster.tenant_id, coalesce((select full_name from profiles where user_id = v_user), 'A reviewer'), 'human',
    format('Rejected a proposed learned behavior (%s)%s', v_cluster.verdict_type,
      case when coalesce(p_reason, '') <> '' then ' (' || p_reason || ')' else '' end),
    'config_change',
    jsonb_build_object('kind', 'learned_behavior_rejected', 'cluster_id', p_cluster_id, 'reason', coalesce(p_reason, ''))
  );

  return jsonb_build_object('ok', true);
end;
$function$;

revoke all on function public.approve_learned_behavior(uuid, text, bigint) from public, anon, authenticated;
grant execute on function public.approve_learned_behavior(uuid, text, bigint) to authenticated;
revoke all on function public.reject_learned_behavior(uuid, text) from public, anon, authenticated;
grant execute on function public.reject_learned_behavior(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- 9. invoke_playbook_dispatch gains a 4th independent piggyback,
-- same exception-wrapped, never-blocks-the-others pattern as the
-- knowledge-gap-detection piggyback (070). No new pg_cron job.
-- ------------------------------------------------------------
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
  v_req_id4 bigint;
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

  -- Piggyback #4: automatic learned-behavior detection (103). Same
  -- independence guarantee as piggyback #3 — a failure here never
  -- blocks or is blocked by the other three.
  begin
    select net.http_post(
      url     := 'https://rfsvmhcqeiyrxivbmpel.supabase.co/functions/v1/learned-behavior-detect',
      body    := '{}'::jsonb,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-dispatch-secret', v_secret
      ),
      timeout_milliseconds := 30000
    ) into v_req_id4;
  exception when others then
    v_req_id4 := null;
  end;

  return format('health:%s queued:%s,%s,%s,%s staleness:%s', v_health, v_req_id, v_req_id2, v_req_id3, v_req_id4, v_stale::text);
end;
$function$;
