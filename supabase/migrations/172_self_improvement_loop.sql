-- ═══════════════════════════════════════════════════════════════
-- 172 — Verified self-improvement loop (Frontier-20 #5)
--
-- The Decagon-style differentiator: production failure → auto-PROPOSED
-- knowledge patch → REPLAYED against the originating question + golden
-- set (de-answer replay mode / de-simulate candidate passthrough, both
-- already deployed) → HUMAN-approved → versioned apply into the KB.
--
-- The DE never edits itself silently. The spine is de_improvements: one
-- row per proposed fix, carrying the failure evidence, the patch, the
-- replay proof, and the approval linkage. apply_improvement is the ONLY
-- write path into the KB and it hard-requires an APPROVED human_tasks
-- row — enforced in Postgres, not UI convention.
--
-- Retrievability on apply: knowledge_docs.search_tsv is GENERATED ALWAYS
-- from title+content, and hybrid_match_knowledge returns lexical-only
-- matches as pseudo-chunks — so an applied patch answers questions
-- immediately, before any chunk/embedding enrichment.
-- ═══════════════════════════════════════════════════════════════

-- Candidate (dry-run) simulations must never feed certification.
alter table sim_runs add column if not exists candidate boolean not null default false;

-- Applied patches are honestly labeled — widen the source CHECK (superset).
alter table knowledge_docs drop constraint if exists knowledge_docs_source_check;
alter table knowledge_docs add constraint knowledge_docs_source_check
  check (source = any (array['upload','paste','connector','self_improvement']));

create table if not exists de_improvements (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  de_id             uuid not null references digital_employees(id) on delete cascade,
  judgment_id       uuid references eval_judgments(id) on delete set null,
  failure_question  text not null,
  failure_answer    text not null default '',
  failure_rationale text not null default '',
  proposed_title    text not null,
  proposed_content  text not null,
  -- replay proof: {before:{score,verdict}, after:{score,verdict}, golden:{sim_run_id,passed,total}}
  replay            jsonb not null default '{}'::jsonb,
  status            text not null default 'proposed'
    check (status in ('proposed','replayed','failed_replay','review_pending','approved','applied','rejected')),
  human_task_id     uuid references human_tasks(id) on delete set null,
  applied_doc_id    uuid references knowledge_docs(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists de_improvements_de_idx on de_improvements(tenant_id, de_id, created_at desc);

alter table de_improvements enable row level security;
drop policy if exists de_improvements_read on de_improvements;
create policy de_improvements_read on de_improvements for select using (
  tenant_id in (select p.tenant_id from profiles p where p.user_id = auth.uid())
  or exists (select 1 from profiles p where p.user_id = auth.uid() and p.layer = 'platform'));

-- ── record the replay outcome (edge fn calls this after the dry runs) ──
create or replace function public.record_improvement_replay(
  p_improvement_id uuid, p_replay jsonb, p_passed boolean
) returns void
language plpgsql security definer set search_path to 'public' as $function$
begin
  update de_improvements
     set replay = p_replay,
         status = case when p_passed then 'replayed' else 'failed_replay' end,
         updated_at = now()
   where id = p_improvement_id and status in ('proposed','replayed','failed_replay');
  if not found then raise exception 'improvement not found or already in review/applied'; end if;
end;
$function$;

-- ── open the human review (the approval fabric) ──
create or replace function public.create_improvement_review(p_improvement_id uuid)
returns uuid
language plpgsql security definer set search_path to 'public' as $function$
declare imp de_improvements; v_task uuid; v_name text;
begin
  select * into imp from de_improvements where id = p_improvement_id;
  if imp.id is null then raise exception 'improvement not found'; end if;
  if imp.status <> 'replayed' then
    raise exception 'improvement must have a PASSING replay before review (status is %)', imp.status;
  end if;

  select coalesce(persona_name, name, 'DE') into v_name from digital_employees where id = imp.de_id;
  insert into human_tasks (tenant_id, type, source, title, detail, related_table, related_id)
  values (imp.tenant_id, 'knowledge_revision', 'system',
    format('Approve knowledge fix proposed by %s — "%s"', v_name, left(imp.proposed_title, 80)),
    format(E'%s answered a question wrongly and proposes this knowledge fix.\n\nFailing question: %s\n\nWhy it failed: %s\n\nProposed article "%s":\n%s\n\nReplay proof: re-answering WITH this fix scored %s/100 (was %s/100); golden set %s/%s passed. Approving publishes the article scoped to this employee; rejecting discards it.',
      v_name, left(imp.failure_question, 300), left(imp.failure_rationale, 400),
      imp.proposed_title, left(imp.proposed_content, 1500),
      coalesce(imp.replay->'after'->>'score','?'), coalesce(imp.replay->'before'->>'score','?'),
      coalesce(imp.replay->'golden'->>'passed','?'), coalesce(imp.replay->'golden'->>'total','?')),
    'de_improvements', imp.id)
  returning id into v_task;

  update de_improvements set human_task_id = v_task, status = 'review_pending', updated_at = now()
   where id = p_improvement_id;
  return v_task;
end;
$function$;

-- ── apply: the ONLY write path, hard-gated on human approval ──
create or replace function public.apply_improvement(p_improvement_id uuid)
returns uuid
language plpgsql security definer set search_path to 'public' as $function$
declare imp de_improvements; v_task_status text; v_doc uuid;
begin
  select * into imp from de_improvements where id = p_improvement_id;
  if imp.id is null then raise exception 'improvement not found'; end if;
  if imp.status = 'applied' then return imp.applied_doc_id; end if;   -- idempotent
  if imp.status = 'rejected' then raise exception 'improvement was rejected'; end if;

  -- THE GATE: a linked, APPROVED human task — no approval, no KB write.
  if imp.human_task_id is null then
    raise exception 'improvement has no review task — call create_improvement_review first';
  end if;
  select status into v_task_status from human_tasks where id = imp.human_task_id;
  if v_task_status is distinct from 'approved' then
    raise exception 'improvement is not human-approved (review task status: %) — a proposed fix can only be published after explicit approval', coalesce(v_task_status, 'missing');
  end if;

  -- Versioned, scoped, honestly-sourced KB write. Scoped to the DE whose
  -- failure produced it: precise blast radius, and scoped docs never enter
  -- the tenant-wide answer cache (existing de-answer rule).
  insert into knowledge_docs (tenant_id, title, content, source, visibility, is_current, tags)
  values (imp.tenant_id, imp.proposed_title, imp.proposed_content, 'self_improvement', 'scoped', true,
          array['self-improvement'])
  returning id into v_doc;
  insert into knowledge_doc_scopes (tenant_id, doc_id, subject_kind, subject_id)
  values (imp.tenant_id, v_doc, 'de', imp.de_id);

  update de_improvements set status = 'applied', applied_doc_id = v_doc, updated_at = now()
   where id = p_improvement_id;

  insert into activity_events (tenant_id, actor, actor_type, event_type, text, confidence)
  select imp.tenant_id, coalesce(d.persona_name, d.name, 'DE'), 'system', 'config_change',
    format('Approved self-improvement published: "%s" (scoped to %s). Proposed from a failed answer, verified by replay, human-approved.',
           imp.proposed_title, coalesce(d.persona_name, d.name, 'this employee')),
    coalesce((imp.replay->'after'->>'score')::numeric, 0)
  from digital_employees d where d.id = imp.de_id;

  return v_doc;
end;
$function$;

-- ── mark rejection (when the review task is rejected) ──
create or replace function public.reject_improvement(p_improvement_id uuid)
returns void
language plpgsql security definer set search_path to 'public' as $function$
begin
  update de_improvements set status = 'rejected', updated_at = now()
   where id = p_improvement_id and status in ('review_pending','replayed');
  if not found then raise exception 'improvement not found or not in a rejectable state'; end if;
end;
$function$;

revoke all on function public.record_improvement_replay(uuid, jsonb, boolean) from public, anon;
revoke all on function public.create_improvement_review(uuid) from public, anon;
revoke all on function public.apply_improvement(uuid) from public, anon;
revoke all on function public.reject_improvement(uuid) from public, anon;
grant execute on function public.record_improvement_replay(uuid, jsonb, boolean) to service_role;
grant execute on function public.create_improvement_review(uuid) to service_role;
grant execute on function public.apply_improvement(uuid) to authenticated, service_role;
grant execute on function public.reject_improvement(uuid) to authenticated, service_role;

-- ── certification integrity: candidate (dry-run) sims can never certify ──
create or replace function public.certify_de_from_sim(
  p_de_id uuid, p_archetype_key text, p_sim_run_id uuid, p_threshold_pct integer default 80
) returns jsonb
language plpgsql security definer set search_path to 'public' as $function$
declare v_tenant uuid; v_total int; v_passed int; v_pct numeric; v_status text;
begin
  select tenant_id into v_tenant from digital_employees where id = p_de_id;
  if v_tenant is null then raise exception 'de not found'; end if;
  if auth.uid() is not null and not exists (
      select 1 from profiles p where p.user_id = auth.uid()
      and (p.layer = 'platform' or p.tenant_id = v_tenant)) then
    raise exception 'not authorized';
  end if;

  select total, passed into v_total, v_passed from sim_runs
    where id = p_sim_run_id and tenant_id = v_tenant and de_id = p_de_id
      and status in ('passed', 'failed')
      and candidate = false;   -- a dry-run with unpublished knowledge is not evidence
  if v_total is null or v_total = 0 then
    raise exception 'simulation has no results (or is a candidate dry-run, which cannot certify)';
  end if;
  v_pct := round(100.0 * v_passed / v_total, 1);
  v_status := case when v_pct >= p_threshold_pct then 'passed' else 'failed' end;

  insert into role_certifications (tenant_id, de_id, archetype_key, eval_run_id, score_pct, threshold_pct, status, evaluated_at, config_fingerprint)
  values (v_tenant, p_de_id, p_archetype_key, null, v_pct, p_threshold_pct, v_status, now(), public.de_config_fingerprint(p_de_id));

  return jsonb_build_object('status', v_status, 'score_pct', v_pct, 'threshold_pct', p_threshold_pct, 'passed', v_passed, 'total', v_total, 'from', 'simulation');
end;
$function$;
