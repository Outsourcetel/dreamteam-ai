-- 319_definition_of_done.sql
-- ============================================================================
-- §3 ACTION-HONESTY, Increment 1 (SQL primitives) — DEFINITION OF DONE.
--
-- A DE can mark an objective/run 'achieved' via its own mark_goal_complete /
-- mark_done while a REQUIRED side-effecting action is still merely gated (pending
-- approval, never executed). The "definition of done" is the model's say-so. This
-- lands the primitives to make done INDEPENDENTLY verifiable: assess whether the
-- required side-effects actually completed before 'achieved' may be written.
--
-- ALL INERT here — nothing calls assess/conclude/origin yet (the four terminal
-- writers + origin threading are wired in follow-up edge-fn changes). Behavior is
-- byte-identical on apply. Enforcement is gated by a two-tier flag (default OFF),
-- and even enforce only WITHHOLDS a false 'achieved' — it never grants one. GLOBAL.
-- ============================================================================

-- 1) record_action_execution → 19 args (adds origin_kind/origin_id for correlation).
--    Reproduced VERBATIM from mig 125 (highest def; only 035/045/125 define it);
--    the ONLY changes are the two trailing params + two INSERT tokens.
DROP FUNCTION IF EXISTS record_action_execution(uuid, uuid, uuid, text, uuid, text, jsonb, text, boolean, boolean, text, text, text, jsonb, text, text, boolean);
CREATE FUNCTION record_action_execution(
  p_tenant_id            uuid,
  p_action_definition_id uuid,
  p_connector_id         uuid,
  p_subject_kind         text,
  p_subject_id           uuid,
  p_mode                 text,
  p_params               jsonb,
  p_decision             text,
  p_destructive          boolean,
  p_idempotent           boolean,
  p_dedupe_key           text,
  p_request_summary      text,
  p_receipt              text,
  p_result               jsonb,
  p_task_title           text,
  p_task_detail          text,
  p_create_task          boolean default true,
  p_origin_kind          text default null,
  p_origin_id            uuid default null
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
declare
  v_task_id uuid;
  v_row_id  uuid;
  v_category text;
  v_label    text;
  v_ref      text;
begin
  if p_create_task and p_decision in ('human_gated_destructive', 'human_gated_trust') then
    insert into human_tasks (tenant_id, type, title, detail, source, related_table, related_id, status)
    values (
      p_tenant_id, 'action_approval',
      coalesce(p_task_title, 'Action awaiting approval'),
      coalesce(p_task_detail, ''), 'de', 'action_executions', null, 'pending'
    )
    returning id into v_task_id;
  end if;

  insert into action_executions (
    tenant_id, action_definition_id, connector_id, subject_kind, subject_id,
    mode, params, decision, destructive, idempotent, dedupe_key,
    request_summary, receipt, result, task_id, origin_kind, origin_id
  ) values (
    p_tenant_id, p_action_definition_id, p_connector_id, p_subject_kind, p_subject_id,
    p_mode, coalesce(p_params, '{}'::jsonb), p_decision, coalesce(p_destructive, true), coalesce(p_idempotent, false), p_dedupe_key,
    coalesce(p_request_summary, ''), p_receipt, p_result, v_task_id, p_origin_kind, p_origin_id
  )
  returning id into v_row_id;

  if v_task_id is not null then
    update human_tasks set related_id = v_row_id where id = v_task_id;
  end if;

  if p_mode = 'execute' and p_subject_id is not null then
    select category into v_category from action_definitions where id = p_action_definition_id;
    select label into v_label from action_definitions where id = p_action_definition_id;
    v_ref := coalesce(
      nullif(p_params->>'external_ref', ''),
      nullif(p_params->>'account_name', ''),
      nullif(p_params->>'account_ref', '')
    );
    if v_category is not null and v_ref is not null then
      perform record_de_experience(
        p_tenant_id, p_subject_kind, p_subject_id, v_category, v_ref,
        format('Considered action "%s" (%s)', coalesce(v_label, 'action'), coalesce(p_request_summary, '')),
        format('Decision: %s', p_decision),
        coalesce(p_receipt, case
          when p_decision in ('human_gated_destructive', 'human_gated_trust') then 'Awaiting human approval — not yet executed.'
          when p_decision = 'failed' then 'Attempted but failed — see result for detail.'
          else 'No receipt recorded.'
        end),
        null, v_row_id
      );
    end if;
  end if;

  return jsonb_build_object('id', v_row_id, 'task_id', v_task_id);
end;
$$;
REVOKE ALL ON FUNCTION record_action_execution(uuid, uuid, uuid, text, uuid, text, jsonb, text, boolean, boolean, text, text, text, jsonb, text, text, boolean, text, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION record_action_execution(uuid, uuid, uuid, text, uuid, text, jsonb, text, boolean, boolean, text, text, text, jsonb, text, text, boolean, text, uuid) TO service_role;

-- 2) New honest non-terminal run state for the withhold path (reproduce mig 188
--    array verbatim + append 'awaiting_verification').
ALTER TABLE agentic_step_runs DROP CONSTRAINT IF EXISTS agentic_step_runs_status_check;
ALTER TABLE agentic_step_runs ADD CONSTRAINT agentic_step_runs_status_check
  CHECK (status = ANY (ARRAY['running','completed','failed','budget_exceeded','max_iterations_exceeded','no_progress','blocked_llm','rate_limited','paused_gate','awaiting_verification']));

-- 3) Shadow / audit log.
CREATE TABLE IF NOT EXISTS definition_of_done_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  writer         text NOT NULL,
  scope          text,
  scope_id       uuid,
  objective_id   uuid,
  verdict        jsonb NOT NULL,
  would_withhold boolean NOT NULL,
  enforced       boolean NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE definition_of_done_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS definition_of_done_log_tenant_read ON definition_of_done_log;
CREATE POLICY definition_of_done_log_tenant_read ON definition_of_done_log
  FOR SELECT USING (tenant_id = public.auth_tenant_id());
CREATE INDEX IF NOT EXISTS definition_of_done_log_tenant_idx ON definition_of_done_log (tenant_id, created_at DESC);

-- 4) assess_definition_of_done — is every required side-effect actually done?
--    verified = (pending_count = 0) AND NOT unresolved. Fails CLOSED.
CREATE OR REPLACE FUNCTION public.assess_definition_of_done(
  p_tenant_id uuid, p_scope text, p_scope_id uuid, p_objective_id uuid default null
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
declare
  v_pending int := 0;
  v_unresolved boolean := false;
  v_gated_task uuid;
begin
  -- (a) origin-scoped gated actions: pending = a gated row whose task is still
  --     'pending', OR 'approved' but with no non-failed row resolving it.
  select count(*) into v_pending
    from action_executions ae
    join human_tasks ht on ht.id = ae.task_id
   where ae.tenant_id = p_tenant_id and ae.origin_kind = p_scope and ae.origin_id = p_scope_id
     and ae.decision in ('human_gated_destructive','human_gated_trust')
     and ( ht.status = 'pending'
        or ( ht.status = 'approved'
             and not exists (select 1 from action_executions ex where ex.resolves_task_id = ae.task_id and ex.decision <> 'failed') ) );

  -- (b) account / opportunity write-backs on this objective.
  if p_objective_id is not null then
    v_pending := v_pending
      + (select count(*) from account_writeback_requests w where w.tenant_id = p_tenant_id and w.objective_id = p_objective_id and w.status = 'pending_approval')
      + (select count(*) from opportunity_writeback_requests w where w.tenant_id = p_tenant_id and w.objective_id = p_objective_id and w.status = 'pending_approval');
  end if;

  -- (c) outbound drafts scoped to this run/item.
  v_pending := v_pending
    + (select count(*) from outbound_drafts d where d.tenant_id = p_tenant_id and d.source_kind = p_scope and d.source_ref = p_scope_id and d.status = 'pending_approval');

  -- (d) fail-CLOSED anchor: an agentic run that flagged a gate whose task is not
  --     resolved by a non-failed execution is 'unresolved' even if origin wasn't
  --     threaded — so a missing correlation can never pass as "nothing pending".
  if p_scope = 'agentic_run' then
    select last_gated_human_task_id into v_gated_task from agentic_step_runs where id = p_scope_id and tenant_id = p_tenant_id;
    if v_gated_task is not null
       and not exists (select 1 from action_executions ex where ex.resolves_task_id = v_gated_task and ex.decision <> 'failed') then
      v_unresolved := true;
    end if;
  end if;

  return jsonb_build_object(
    'verified', (coalesce(v_pending, 0) = 0) and not v_unresolved,
    'pending_count', coalesce(v_pending, 0),
    'unresolved', v_unresolved,
    'detail', jsonb_build_object('scope', p_scope, 'scope_id', p_scope_id, 'objective_id', p_objective_id)
  );
end $$;
REVOKE ALL ON FUNCTION public.assess_definition_of_done(uuid, text, uuid, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assess_definition_of_done(uuid, text, uuid, uuid) TO service_role, authenticated;

-- 5) conclude_objective_verified — the shared terminal-writer helper for objectives.
--    Reads the def-of-done mode (fails to disabled = current behavior), assesses,
--    LOGS (shadow + enforce), and only WITHHOLDS 'achieved' (→ 'in_progress', the
--    goal engine re-reviews on the next wake once evidence lands) when enforcing.
CREATE OR REPLACE FUNCTION public.conclude_objective_verified(
  p_tenant_id uuid, p_objective_id uuid, p_assessment text, p_note text default null
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
declare
  v_enforce boolean := false;
  v_master boolean; v_tenant_on boolean; v_mode text;
  v_assess jsonb; v_final text := p_assessment;
begin
  begin
    select (value = 'true') into v_master from platform_config where key = 'definition_of_done.enabled';
    if coalesce(v_master, false) then
      select is_feature_enabled_internal(p_tenant_id, 'definition_of_done') into v_tenant_on;
      if v_tenant_on is true then
        select value into v_mode from platform_config where key = 'definition_of_done.mode';
        v_enforce := coalesce(v_mode, 'shadow') = 'enforce';
      end if;
    end if;
  exception when others then v_enforce := false; end;   -- flag axis fails to current behavior

  if p_assessment = 'achieved' then
    v_assess := assess_definition_of_done(p_tenant_id, 'objective', p_objective_id, p_objective_id);
    begin
      insert into definition_of_done_log (tenant_id, writer, scope, scope_id, objective_id, verdict, would_withhold, enforced)
      values (p_tenant_id, 'objective', 'objective', p_objective_id, p_objective_id, v_assess, not (v_assess->>'verified')::boolean, v_enforce);
    exception when others then null; end;
    if v_enforce and not (v_assess->>'verified')::boolean then
      v_final := 'in_progress';   -- withhold; re-reviewed once the evidence lands
    end if;
  end if;

  update de_objectives set status = v_final, updated_at = now()
    where id = p_objective_id and tenant_id = p_tenant_id;
  return v_final;
end $$;
REVOKE ALL ON FUNCTION public.conclude_objective_verified(uuid, uuid, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.conclude_objective_verified(uuid, uuid, text, text) TO service_role;

-- 6) Flag — seeded disabled (is_feature_enabled_internal fails open on unknown key).
INSERT INTO feature_registry (key, label, description, default_enabled, category)
VALUES ('definition_of_done',
        'Verified definition of done',
        'Before a run/objective is marked done, verify its required approved actions actually executed (not just the model''s say-so). Default OFF; shadow-logs before it ever withholds. Enable per workspace.',
        false, 'governance')
ON CONFLICT (key) DO NOTHING;

NOTIFY pgrst, 'reload schema';
