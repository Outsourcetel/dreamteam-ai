-- ============================================================
-- Migration 547: close the two REAL gaps found by reviewing mig 546's baseline.
--
-- 546 baselined ten work-creating writers as "pre-existing, not individually
-- audited". Tracing each caller found eight genuinely safe and TWO reachable
-- for a suspended tenant:
--
--   create_outbound_draft
--     Safe from de-work (dispatch_de_work_internal + claim_de_work_items are
--     guarded) but ALSO called by email-inbound, which has no suspension gate
--     at all. An inbound email to a dormant workspace produced a draft and an
--     approval task — the workforce acting for a suspended customer.
--
--   apply_onboarding_verification
--     Reached from onboarding-verify's check_due, which pg_cron piggybacks and
--     which selects onboarding_projects WHERE status='active' with NO tenant
--     filter — every project in every tenant, suspended or not.
--
-- Both are guarded at the FUNCTION, not at today's caller, so a future caller
-- cannot reopen the hole. Bodies regenerated mechanically from live (R1).
--
-- The remaining eight are marked reviewed with their real reason (see the
-- UPDATE below); the two fixed here no longer need an exemption at all.
-- ============================================================

-- ── create_outbound_draft ──
CREATE OR REPLACE FUNCTION public.create_outbound_draft(p_tenant_id uuid, p_de_id uuid, p_recipient text, p_channel text, p_subject text, p_body text, p_reason text DEFAULT ''::text, p_source_kind text DEFAULT 'manual'::text, p_source_ref uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_draft uuid; v_task uuid; v_name text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'create_outbound_draft is service-role only';
  end if;
  -- Mig 547: a suspended workspace drafts nothing. email-inbound has no
  -- suspension gate of its own, so an inbound email to a dormant tenant
  -- would otherwise produce a draft AND an approval task.
  if not tenant_is_operational(p_tenant_id) then
    return null;
  end if;
  if p_body is null or length(trim(p_body)) < 10 then
    raise exception 'draft body required (min 10 chars)';
  end if;
  if not exists (select 1 from digital_employees where id = p_de_id and tenant_id = p_tenant_id) then
    raise exception 'de not in tenant';
  end if;

  insert into outbound_drafts (tenant_id, de_id, recipient_ref, channel, subject, body, reason, source_kind, source_ref)
  values (p_tenant_id, p_de_id, left(coalesce(p_recipient, ''), 200),
          case when p_channel in ('email','sms','chat','other') then p_channel else 'email' end,
          left(coalesce(p_subject, ''), 200), p_body, left(coalesce(p_reason, ''), 500),
          case when p_source_kind in ('work_item','objective','conversation','manual') then p_source_kind else 'manual' end,
          p_source_ref)
  returning id into v_draft;

  select coalesce(persona_name, name, 'DE') into v_name from digital_employees where id = p_de_id;
  insert into human_tasks (tenant_id, type, source, title, detail, related_table, related_id)
  values (p_tenant_id, 'approval_gate', 'de',
    format('Outbound draft from %s — to %s', v_name, left(coalesce(p_recipient, 'recipient'), 60)),
    format(E'%s drafted an outbound %s message and needs your approval. NOTHING sends automatically — approving means you deliver it via your own channel.\n\nTo: %s\nSubject: %s\n\n%s\n\nWhy: %s',
           v_name, case when p_channel in ('email','sms','chat','other') then p_channel else 'email' end,
           coalesce(p_recipient, '—'), coalesce(nullif(p_subject, ''), '—'), p_body, coalesce(nullif(p_reason, ''), '—')),
    'outbound_drafts', v_draft)
  returning id into v_task;

  update outbound_drafts set human_task_id = v_task, updated_at = now() where id = v_draft;
  return v_draft;
end;
$function$;

-- ── apply_onboarding_verification ──
CREATE OR REPLACE FUNCTION public.apply_onboarding_verification(p_project_id uuid, p_key text, p_verified boolean, p_detail text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_proj      onboarding_projects;
  v_ver       onboarding_template_versions;
  v_def       jsonb;
  v_item      jsonb;
  v_idx       integer := -1;
  v_i         integer := 0;
  v_old       text;
  v_task_id   uuid;
  v_acct_name text;
  v_completed boolean := false;
  v_signoff   boolean;
begin
  select * into v_proj from onboarding_projects where id = p_project_id;
  -- Mig 547: onboarding-verify's check_due sweep loops EVERY active project
  -- across ALL tenants with no suspension filter, so this is the only place
  -- the check can live. A dormant workspace gains no verification tasks.
  if v_proj.id is not null and not tenant_is_operational(v_proj.tenant_id) then
    return jsonb_build_object('ok', false, 'skipped', 'tenant_suspended');
  end if;
  if not found then return jsonb_build_object('error', 'project_not_found'); end if;
  if v_proj.status <> 'active' then return jsonb_build_object('error', 'project_not_active'); end if;

  select * into v_ver from onboarding_template_versions where id = v_proj.template_version_id;
  select d into v_def from jsonb_array_elements(v_ver.items) d where d->>'key' = p_key limit 1;
  if v_def is null or v_def->'verify' is null then
    return jsonb_build_object('error', 'item_not_verifiable');
  end if;
  v_signoff := coalesce((v_def->>'requires_signoff')::boolean, false);

  for v_item in select * from jsonb_array_elements(v_proj.items_state) loop
    if v_item->>'key' = p_key then v_idx := v_i; exit; end if;
    v_i := v_i + 1;
  end loop;
  if v_idx < 0 then return jsonb_build_object('error', 'item_state_missing'); end if;
  v_old := v_item->>'status';

  if v_old in ('done', 'signed_off') then
    -- Already complete (by whatever means) — record the check for the
    -- audit trail but don't re-run completion side effects.
    v_item := v_item || jsonb_build_object(
      'last_check_at', now(), 'last_check_result', case when p_verified then 'verified' else 'not_yet' end,
      'verify_detail', left(coalesce(p_detail, ''), 300));
    update onboarding_projects set items_state = jsonb_set(items_state, array[v_idx::text], v_item) where id = p_project_id;
    return jsonb_build_object('project_id', p_project_id, 'item_key', p_key, 'changed', false, 'already_complete', true);
  end if;

  if not p_verified then
    v_item := v_item || jsonb_build_object(
      'last_check_at', now(), 'last_check_result', 'not_yet',
      'verify_detail', left(coalesce(p_detail, ''), 300));
    update onboarding_projects set items_state = jsonb_set(items_state, array[v_idx::text], v_item) where id = p_project_id;
    return jsonb_build_object('project_id', p_project_id, 'item_key', p_key, 'changed', false, 'verified', false);
  end if;

  -- Verified true: same completion shape as update_onboarding_item's
  -- done path, attributed to System rather than a human.
  v_item := v_item || jsonb_build_object(
    'status', 'done', 'done_at', now(),
    'verified_by', 'system', 'verified_at', now(),
    'last_check_at', now(), 'last_check_result', 'verified',
    'verify_detail', left(coalesce(p_detail, ''), 300));

  if v_signoff then
    insert into human_tasks (tenant_id, type, title, detail, source, related_table, related_id)
    values (v_proj.tenant_id, 'review_gate',
            format('Onboarding sign-off — %s · %s', v_def->>'label', v_proj.name),
            format('Item "%s" was CONNECTOR-VERIFIED (%s) and needs a human sign-off before the project can complete.', v_def->>'label', left(coalesce(p_detail, ''), 200)),
            'system', 'onboarding_projects', p_project_id)
    returning id into v_task_id;
    v_item := v_item || jsonb_build_object('signoff_task_id', v_task_id);
  end if;

  select name into v_acct_name from customer_accounts where id = v_proj.account_id;
  insert into activity_events (tenant_id, account_id, actor, actor_type, event_type, text)
  values (v_proj.tenant_id, v_proj.account_id, 'System', 'system', 'resolved',
          format('Onboarding — %s: connector-verified done%s (%s) — %s', v_def->>'label',
                 case when v_task_id is not null then ' · awaiting sign-off' else '' end,
                 coalesce(v_acct_name, v_proj.name), left(coalesce(p_detail, ''), 160)));

  perform append_audit_event_internal(
    v_proj.tenant_id, 'System', 'system',
    format('Onboarding item connector-verified — %s (%s): %s', v_def->>'label', v_proj.name, left(coalesce(p_detail, ''), 200)),
    'config_change',
    jsonb_build_object('kind', 'onboarding_verify', 'project_id', p_project_id, 'item_key', p_key,
                       'detail', p_detail, 'signoff_task_id', v_task_id));

  update onboarding_projects
    set items_state = jsonb_set(items_state, array[v_idx::text], v_item)
    where id = p_project_id;

  if not v_signoff then
    v_completed := onboarding_check_complete(p_project_id);
  end if;

  return jsonb_build_object('project_id', p_project_id, 'item_key', p_key, 'changed', true,
                            'verified', true, 'signoff_task_id', v_task_id, 'completed', v_completed);
end;
$function$;

-- ── Now-guarded: an exemption would be misleading. ──
delete from dormancy_writer_exemptions
 where function_name in ('create_outbound_draft', 'apply_onboarding_verification');

-- ── The eight that are genuinely safe, with the reason each was cleared. ──
update dormancy_writer_exemptions set reviewed = true, reason = v.reason
from (values
  ('create_improvement_review',  'Reviewed 2026-08-04: only caller is the de-improve edge function, dispatched solely by dispatch_de_improve_internal, which mig 430 guards. No other SQL/edge/client caller.'),
  ('open_de_escalation',         'Reviewed 2026-08-04: only caller is de-work, reached via dispatch_de_work_internal + claim_de_work_items, both guarded by mig 430.'),
  ('record_action_execution',    'Reviewed 2026-08-04: the action-LEDGER writer, called by connector-hub and playbook-execute after the gate has already run. Deliberately NOT guarded — suppressing it would erase the audit record of an action rather than prevent one.'),
  ('record_inquiry_decision',    'Reviewed 2026-08-04: callers are de-answer and widget-ask (both carry loadTenantGate, which refuses suspended tenants) and specialist-consult, reached only via poll_de_work_sources_targets, guarded by mig 430.'),
  ('promote_gap_cluster',        'Reviewed 2026-08-04: only reachable from the knowledge-gap-detect edge function, which no pg_cron job invokes — not autonomous. Revisit if it is ever scheduled.'),
  ('propose_learned_behavior',   'Reviewed 2026-08-04: only reachable from the learned-behavior-detect edge function, which no pg_cron job invokes — not autonomous. Revisit if it is ever scheduled.'),
  ('trust_demote',               'Reviewed 2026-08-04: human-driven. Its SQL callers (trust_check_*) have no cron or edge caller; the live callers are the workforce trust screens in src/. Flagged only because it lacks a literal auth.uid() reference.'),
  ('propose_computer_use_task',  'Reviewed 2026-08-04: no caller anywhere — no SQL, no edge function, no client. The computer-use feature ships default-off. Dormant code, not a live path.')
) as v(function_name, reason)
where dormancy_writer_exemptions.function_name = v.function_name;

do $assert$
declare v_n int; v_unreviewed int;
begin
  if not exists (select 1 from pg_proc where pronamespace='public'::regnamespace
                  and proname='create_outbound_draft' and prosrc ilike '%tenant_is_operational%') then
    raise exception 'mig 547: create_outbound_draft still unguarded';
  end if;
  if not exists (select 1 from pg_proc where pronamespace='public'::regnamespace
                  and proname='apply_onboarding_verification' and prosrc ilike '%tenant_is_operational%') then
    raise exception 'mig 547: apply_onboarding_verification still unguarded';
  end if;
  -- the audit must still be quiet (the two fixed ones now pass on their own)
  select count(*) into v_n from audit_unguarded_dormancy_writers();
  if v_n <> 0 then
    raise exception 'mig 547: audit noisy after fix (%)', v_n;
  end if;
  -- and nothing may remain merely "baselined"
  select count(*) into v_unreviewed from dormancy_writer_exemptions where not reviewed;
  if v_unreviewed <> 0 then
    raise exception 'mig 547: % exemption(s) still unreviewed', v_unreviewed;
  end if;
end
$assert$;
