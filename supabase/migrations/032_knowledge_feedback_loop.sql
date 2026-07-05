-- ============================================================
-- Migration 032: KNOWLEDGE FEEDBACK LOOP — human verdict on a
-- resolved inquiry's evidence, human-gated knowledge revision
-- requests, re-embedding on apply.
--
-- Closes the founder's loop: "how the DE will act to resolve a
-- support inquiry and send back feedback to knowledgebase whether
-- it was accurate or needs improvement with human in loop for
-- verification."
--
-- Design, consistent with the app's existing doctrine:
--   * RLS is SELECT-only on both new tables; every write goes
--     through an audited SECURITY DEFINER RPC (same shape as
--     029 data_access_grants / 030 knowledge_scopes).
--   * knowledge_docs gains a previous_version_id self-reference —
--     NOT destructive overwrite. Applying a revision INSERTS a new
--     doc row that supersedes the old one (same pattern spirit as
--     playbook_versions / onboarding_template_versions: history is
--     preserved, never mutated away).
--   * knowledge_revision_requests.proposed_body_md is SERVER-
--     ASSEMBLED from template pieces (current content + evidence
--     run gaps + reviewer notes) — never free-form LLM text. Same
--     structural anti-hallucination posture as the Scribe
--     (migration 024: payloads built server-side from a whitelisted
--     template, never model-supplied free text).
--   * decideHumanTask hook #5 (additive, guarded by
--     related_table='knowledge_revision_requests' — hooks 1-4
--     untouched).
--   * audit_events.category: reuses 'evidence_step' for the
--     feedback-submitted event and adds a new 'knowledge_revision'
--     category for the revision lifecycle (create/approve/reject/
--     apply) — kept distinct so the audit trail can be filtered by
--     "knowledge changed" independent of "evidence gathered".
-- ============================================================

-- ── audit_events: add knowledge_revision category ──
alter table audit_events drop constraint if exists audit_events_category_check;
alter table audit_events add constraint audit_events_category_check
  check (category in (
    'resolved', 'escalated', 'approval', 'guardrail_check', 'guardrail_block',
    'config_change', 'playbook_step', 'invoice',
    'connector_sync', 'connector_action', 'evidence_step', 'access_control',
    'knowledge_revision'
  ));

-- ── human_tasks: new type for the revision-approval gate ──
alter table human_tasks drop constraint if exists human_tasks_type_check;
alter table human_tasks add constraint human_tasks_type_check
  check (type in ('approval_gate', 'review_gate', 'escalation', 'override',
                  'training_feedback', 'trust_promotion', 'trust_demotion_notice',
                  'checklist', 'knowledge_revision'));

-- ── knowledge_docs: simple version chain, never destructive ──
alter table knowledge_docs add column if not exists previous_version_id uuid
  references knowledge_docs(id) on delete set null;
alter table knowledge_docs add column if not exists is_current boolean not null default true;

create index if not exists knowledge_docs_prev_version_idx
  on knowledge_docs(previous_version_id) where previous_version_id is not null;

-- ============================================================
-- TABLE: evidence_feedback — a human's verdict on one evidence
-- run's gathered evidence / answer. tenant-read RLS; writes only
-- via submit_evidence_feedback.
-- ============================================================
create table if not exists evidence_feedback (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  evidence_run_id   uuid not null references evidence_runs(id) on delete cascade,
  reviewer_user_id  uuid,
  verdict           text not null check (verdict in ('accurate', 'needs_improvement', 'inaccurate')),
  notes             text not null default '',
  created_at        timestamptz not null default now()
);

create index if not exists evidence_feedback_tenant_idx on evidence_feedback(tenant_id, created_at desc);
create index if not exists evidence_feedback_run_idx on evidence_feedback(evidence_run_id);

alter table evidence_feedback enable row level security;

drop policy if exists "evidence_feedback_tenant_select" on evidence_feedback;
create policy "evidence_feedback_tenant_select" on evidence_feedback
  for select
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));
-- writes only via submit_evidence_feedback (SECURITY DEFINER, below)

-- ============================================================
-- TABLE: knowledge_revision_requests — a proposed change to the
-- knowledge base, either to an existing doc or a brand-new one,
-- triggered by a 'needs_improvement'/'inaccurate' verdict. The
-- proposed content is TEMPLATE-ASSEMBLED server-side, never
-- free-form LLM text (same anti-hallucination posture as Scribe).
-- ============================================================
create table if not exists knowledge_revision_requests (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  source_doc_id      uuid references knowledge_docs(id) on delete set null,
  evidence_run_id    uuid not null references evidence_runs(id) on delete cascade,
  feedback_id        uuid not null references evidence_feedback(id) on delete cascade,
  proposed_title     text not null,
  proposed_body_md   text not null,
  status             text not null default 'draft'
                       check (status in ('draft', 'pending_approval', 'approved', 'rejected', 'applied')),
  created_by         uuid,
  decided_by         uuid,
  decided_at         timestamptz,
  applied_doc_id     uuid references knowledge_docs(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists knowledge_revision_requests_tenant_idx
  on knowledge_revision_requests(tenant_id, created_at desc);
create index if not exists knowledge_revision_requests_status_idx
  on knowledge_revision_requests(tenant_id, status);

alter table knowledge_revision_requests enable row level security;

drop policy if exists "knowledge_revision_requests_tenant_select" on knowledge_revision_requests;
create policy "knowledge_revision_requests_tenant_select" on knowledge_revision_requests
  for select
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));
-- writes only via submit_evidence_feedback / apply_knowledge_revision /
-- reject_knowledge_revision (all SECURITY DEFINER, below)

drop trigger if exists knowledge_revision_requests_updated_at on knowledge_revision_requests;
create trigger knowledge_revision_requests_updated_at
  before update on knowledge_revision_requests
  for each row execute function update_updated_at();

-- ============================================================
-- RPC: submit_evidence_feedback(evidence_run_id, verdict, notes)
--
-- Membership-guarded. Inserts the feedback row, audits it. When
-- verdict is 'needs_improvement' or 'inaccurate', ALSO:
--   1. builds a template-composed proposed_body_md (current doc
--      content, if any, + the run's evidence gaps/citations +
--      the reviewer's note) — never free-form LLM text
--   2. creates a knowledge_revision_requests row (status
--      'pending_approval')
--   3. creates a human_tasks row (type 'knowledge_revision')
--      pointing at it — this is decideHumanTask hook #5
-- 'accurate' verdicts create ONLY the feedback row — no revision,
-- no task (verified negative-test path).
-- ============================================================
create or replace function submit_evidence_feedback(
  p_evidence_run_id uuid,
  p_verdict         text,
  p_notes           text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user           uuid := auth.uid();
  v_tenant         uuid;
  v_caller_tenant  uuid;
  v_run            record;
  v_feedback_id    uuid;
  v_revision_id    uuid;
  v_task_id        uuid;
  v_source_doc_id  uuid;
  v_current_title  text;
  v_current_body   text;
  v_gap_lines      text := '';
  v_step           jsonb;
  v_citation       jsonb;
  v_proposed_title text;
  v_proposed_body  text;
  v_reviewer_name  text;
begin
  if p_verdict not in ('accurate', 'needs_improvement', 'inaccurate') then
    return jsonb_build_object('ok', false, 'error', 'bad_verdict');
  end if;

  select * into v_run from evidence_runs where id = p_evidence_run_id;
  if v_run.id is null then
    return jsonb_build_object('ok', false, 'error', 'evidence_run_not_found');
  end if;
  v_tenant := v_run.tenant_id;

  -- Membership guard (JWT path); a genuine service_role connection is
  -- also trusted (same test append_audit_event / set_doc_scope use).
  if v_user is not null then
    select tenant_id into v_caller_tenant from profiles where user_id = v_user;
    if v_caller_tenant is null or v_caller_tenant <> v_tenant then
      return jsonb_build_object('ok', false, 'error', 'not_tenant_member');
    end if;
  elsif coalesce(auth.role(), '') <> 'service_role' then
    return jsonb_build_object('ok', false, 'error', 'not_tenant_member');
  end if;

  select full_name into v_reviewer_name from profiles where user_id = v_user;
  v_reviewer_name := coalesce(v_reviewer_name, 'A reviewer');

  insert into evidence_feedback (tenant_id, evidence_run_id, reviewer_user_id, verdict, notes)
  values (v_tenant, p_evidence_run_id, v_user, p_verdict, coalesce(p_notes, ''))
  returning id into v_feedback_id;

  perform append_audit_event(
    v_tenant, v_reviewer_name, case when v_user is null then 'system' else 'human' end,
    v_reviewer_name || ' marked evidence run evidence as "' || p_verdict || '"'
      || case when coalesce(p_notes, '') <> '' then ' — "' || p_notes || '"' else '' end,
    'evidence_step',
    jsonb_build_object('kind', 'evidence_feedback_submitted', 'evidence_run_id', p_evidence_run_id,
      'feedback_id', v_feedback_id, 'verdict', p_verdict, 'notes', coalesce(p_notes, ''))
  );

  if p_verdict = 'accurate' then
    return jsonb_build_object('ok', true, 'feedback_id', v_feedback_id, 'revision_request_id', null, 'task_id', null);
  end if;

  -- ── Build the template-composed proposed revision ──
  -- Try to find an existing knowledge doc this evidence run cited, so
  -- the revision proposes an edit rather than always a fresh doc.
  select (c->>'ref')::uuid into v_source_doc_id
  from jsonb_array_elements(v_run.steps) s,
       jsonb_array_elements(s->'citations') c
  where s->>'kind' = 'knowledge_search' and c->>'system' = 'DreamTeam knowledge'
  limit 1;

  if v_source_doc_id is not null then
    select title, content into v_current_title, v_current_body
      from knowledge_docs where id = v_source_doc_id and tenant_id = v_tenant and is_current;
  end if;

  -- Gap lines: every non-"ok" or human-flagged step, plain-language.
  for v_step in select * from jsonb_array_elements(v_run.steps) loop
    if (v_step->>'outcome') in ('failed', 'skipped_not_connected', 'denied_no_access') then
      v_gap_lines := v_gap_lines || '- ' || coalesce(v_step->>'summary', v_step->>'kind') || E'\n';
    end if;
  end loop;

  v_proposed_title := coalesce(v_current_title, 'Follow-up: ' || left(v_run.inquiry, 80));
  v_proposed_body := coalesce(v_current_body, '') || E'\n\n'
    || '## Reviewer feedback (' || p_verdict || ')' || E'\n'
    || coalesce(nullif(p_notes, ''), '(no note provided)') || E'\n\n'
    || '## Evidence gaps noted at review time' || E'\n'
    || case when v_gap_lines = '' then '(no gaps recorded in the evidence trail)' || E'\n' else v_gap_lines end
    || E'\n## Source inquiry' || E'\n' || v_run.inquiry;

  insert into knowledge_revision_requests (
    tenant_id, source_doc_id, evidence_run_id, feedback_id,
    proposed_title, proposed_body_md, status, created_by
  ) values (
    v_tenant, v_source_doc_id, p_evidence_run_id, v_feedback_id,
    v_proposed_title, v_proposed_body, 'pending_approval', v_user
  ) returning id into v_revision_id;

  insert into human_tasks (
    tenant_id, type, title, detail, source, related_table, related_id, status
  ) values (
    v_tenant, 'knowledge_revision',
    'Review proposed knowledge update: ' || v_proposed_title,
    'Evidence run flagged "' || p_verdict || '" — a knowledge revision has been drafted for review.',
    'system', 'knowledge_revision_requests', v_revision_id, 'pending'
  ) returning id into v_task_id;

  perform append_audit_event(
    v_tenant, v_reviewer_name, case when v_user is null then 'system' else 'human' end,
    'Knowledge revision proposed from evidence feedback — "' || v_proposed_title || '"',
    'knowledge_revision',
    jsonb_build_object('kind', 'knowledge_revision_requested', 'revision_request_id', v_revision_id,
      'evidence_run_id', p_evidence_run_id, 'feedback_id', v_feedback_id, 'task_id', v_task_id,
      'source_doc_id', v_source_doc_id)
  );

  return jsonb_build_object('ok', true, 'feedback_id', v_feedback_id,
    'revision_request_id', v_revision_id, 'task_id', v_task_id);
end;
$$;

revoke all on function submit_evidence_feedback(uuid, text, text) from public;
grant execute on function submit_evidence_feedback(uuid, text, text) to authenticated, service_role;

-- ============================================================
-- RPC: apply_knowledge_revision(request_id)
-- Approve path: inserts a NEW knowledge_docs row carrying the
-- proposed content, linked via previous_version_id to the old doc
-- (if any); flips the old doc's is_current to false (never
-- destructive overwrite — history is preserved); marks the request
-- 'applied'; audits 'knowledge_revision_applied'. Does NOT itself
-- call ingest-chunks (embeddings require Edge Function context —
-- the client calls ingestDocChunks(applied_doc_id) right after this
-- RPC succeeds; the doc is fully valid, just unembedded, until then,
-- same honest-degradation posture as every other knowledge_docs row
-- before its first embed).
-- ============================================================
create or replace function apply_knowledge_revision(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user          uuid := auth.uid();
  v_caller_tenant uuid;
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
    select tenant_id into v_caller_tenant from profiles where user_id = v_user;
    if v_caller_tenant is null or v_caller_tenant <> v_req.tenant_id then
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

  return jsonb_build_object('ok', true, 'new_doc_id', v_new_doc_id, 'previous_doc_id', v_req.source_doc_id);
end;
$$;

revoke all on function apply_knowledge_revision(uuid) from public;
grant execute on function apply_knowledge_revision(uuid) to authenticated, service_role;

-- ============================================================
-- RPC: reject_knowledge_revision(request_id, reason)
-- Rejection: no doc change at all. Marks request 'rejected', audits.
-- ============================================================
create or replace function reject_knowledge_revision(p_request_id uuid, p_reason text default '')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user          uuid := auth.uid();
  v_caller_tenant uuid;
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
    select tenant_id into v_caller_tenant from profiles where user_id = v_user;
    if v_caller_tenant is null or v_caller_tenant <> v_req.tenant_id then
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

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function reject_knowledge_revision(uuid, text) from public;
grant execute on function reject_knowledge_revision(uuid, text) to authenticated, service_role;

-- ============================================================
-- Retrieval must not surface a superseded version: re-declare
-- match_doc_chunks (030) and visible_knowledge_docs (030) filtering
-- on is_current = true. Same signatures — no callers change.
-- ============================================================
create or replace function match_doc_chunks(
  p_tenant_id       uuid,
  p_account_id      uuid,
  p_query_embedding vector(384),
  p_match_count     int default 5,
  p_subject_kind    text default null,
  p_subject_id      uuid default null
)
returns table (id uuid, doc_id uuid, content text, account_id uuid, distance float, visibility text)
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and p_tenant_id not in
     (select tenant_id from profiles where user_id = auth.uid()) then
    raise exception 'tenant access denied';
  end if;
  return query
  select c.id, c.doc_id, c.content, c.account_id,
         (c.embedding <=> p_query_embedding)::float as distance,
         d.visibility
  from knowledge_doc_chunks c
  join knowledge_docs d on d.id = c.doc_id
  where c.tenant_id = p_tenant_id
    and c.embedding is not null
    and d.is_current
    and (c.account_id is null or (p_account_id is not null and c.account_id = p_account_id))
    and (
      d.visibility = 'tenant'
      or (p_subject_kind is not null and p_subject_id is not null and exists (
            select 1 from knowledge_doc_scopes s
            where s.doc_id = d.id
              and s.subject_kind = p_subject_kind
              and s.subject_id = p_subject_id))
    )
  order by
    (c.account_id is not null and c.account_id = p_account_id) desc, -- account overlay first
    c.embedding <=> p_query_embedding
  limit p_match_count;
end;
$$;

create or replace function visible_knowledge_docs(
  p_tenant_id    uuid,
  p_subject_kind text default null,
  p_subject_id   uuid default null
)
returns table (id uuid, title text, content text, tags text[], visibility text)
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and p_tenant_id not in
     (select tenant_id from profiles where user_id = auth.uid()) then
    raise exception 'tenant access denied';
  end if;
  return query
  select d.id, d.title, d.content, d.tags, d.visibility
  from knowledge_docs d
  where d.tenant_id = p_tenant_id
    and d.is_current
    and (
      d.visibility = 'tenant'
      or (p_subject_kind is not null and p_subject_id is not null and exists (
            select 1 from knowledge_doc_scopes s
            where s.doc_id = d.id
              and s.subject_kind = p_subject_kind
              and s.subject_id = p_subject_id))
    );
end;
$$;
