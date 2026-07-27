-- ============================================================================
-- 461 — TRUST PROGRAM migration 4 (docs/31 Q7, Architecture B):
--       per-employee evidence honesty.
--
-- Problem (docs/31 "new finding", verified live 2026-07-27): trust_evidence_for
-- computes ALL THREE evidence sources workspace-wide — eval pass rate,
-- human-review outcomes and guardrail blocks are counted across the whole
-- tenant even when the policy is scoped to one employee (trust_policies.de_id
-- is not null; 30 of 38 live policies are employee-scoped). One employee could
-- be promoted on another's track record.
--
-- Resolved dependency (queried live 2026-07-27): guardrail_block audit_events
-- rows carry NO employee id anywhere — detail keys observed across all 26 live
-- rows: rule_id, question, rule, rule_type, channel, run_id, step_index,
-- matched, definition_id, rule_pattern, test. The actor column holds the
-- employee's DISPLAY name (persona name when set, else record name — proven
-- against supabase/functions/_shared/dePersona.ts and live rows: the
-- persona-aware match resolves 21 of 26 rows uniquely). There are ZERO
-- SQL-level writers of this category (the one grep hit,
-- provision_starter_de_internal, only contains the criteria key
-- max_guardrail_blocks); ALL production writers are edge functions
-- (de-answer, widget-ask, specialist-consult, playbook-execute) and every one
-- of them writes through the append_audit_event RPC as service_role.
-- Therefore the stamp is added at the SINK (append_audit_event, and its
-- direct-db sibling append_audit_event_internal for future SQL writers),
-- BEFORE the sha256 hash is computed — verify_audit_chain recomputes from the
-- stored detail, so stamping pre-hash keeps the tamper-evident chain intact.
-- Rows written before this migration stay unstamped and age out of the
-- 30-day evidence window naturally (the design docs/31 called for).
--
-- What changes:
--   1. append_audit_event           — stamp detail.de_id on guardrail_block
--                                     rows written by an employee actor,
--                                     when the name resolves to exactly one
--                                     employee. Pre-hash. No signature change.
--   2. append_audit_event_internal  — the same stamp for direct-db writers
--                                     (none exist today; future-proofing the
--                                     second sink so the two paths agree).
--   3. trust_evidence_for           — when the policy is employee-scoped,
--                                     evidence is scoped to that employee:
--                                     eval_runs.de_id, human_tasks.de_id, and
--                                     guardrail blocks by the detail stamp.
--                                     Tenant-scoped policies (de_id null) are
--                                     byte-for-byte today's behavior.
--   4. trust_check_guardrail_block  — the demotion trigger applies the same
--                                     honesty: an employee-scoped promoted
--                                     policy is no longer demoted by a
--                                     DIFFERENT employee's stamped block.
--                                     Unstamped rows keep the historical
--                                     demote-everything behavior (conservative
--                                     — demotion is the safety direction).
--   5. compute_trust_evidence       — the mig-447 policy-picker ordering is
--                                     corrected. The live ORDER BY key
--                                     (de_id is not null and de_id = p_de_id)
--                                     is NULL for employee-scoped rows when
--                                     p_de_id is NULL, and NULLs sort FIRST
--                                     under DESC — so p_de_id NULL (the
--                                     workspace ask) picked an EMPLOYEE-scoped
--                                     policy wherever one existed. Now:
--                                     p_de_id NULL resolves ONLY the
--                                     workspace (de_id IS NULL) policy;
--                                     p_de_id set resolves that employee's
--                                     policy with workspace fallback.
--                                     Signature and auth guards unchanged.
--
-- What does NOT change:
--   - Guardrails / destructive gates / spend caps stay ABOVE the dial in
--     every enforcement path — this migration touches only how EVIDENCE is
--     counted and how demotion targets are matched; no enforcement order.
--   - No new audit category ('guardrail_block' and 'config_change' verified
--     against the live audit_events_category_check on 2026-07-27; nothing new
--     is written here).
--   - trust_evidence_for's signature and returned jsonb shape are identical —
--     nothing new is exposed.
--   - Per-policy criteria thresholds already work (verified live: window_days,
--     min_eval_pass_rate, min_eval_samples, min_human_approval_rate,
--     min_human_samples, max_guardrail_blocks are all read from criteria with
--     coalesce defaults) — reproduced unchanged.
--   - compute_trust_evidence keeps its signature, its can_access_de guard
--     (mig 447) and its user-JWT-only construction (raises on null
--     auth.uid()); ONLY its policy-picker ordering changes (item 5 above).
--     No cron or trigger path reaches trust_evidence_for (verified against
--     cron.job and pg_proc).
--
-- EDGE-FUNCTION NOTE (cannot be edited from a SQL migration — separate
-- deploy): for exact attribution the four writers should add the employee id
-- to the detail they pass, at:
--   supabase/functions/de-answer/index.ts        ~line 1128 (has subjectDeId)
--   supabase/functions/widget-ask/index.ts       ~lines 519, 817 (has subjectDeId)
--   supabase/functions/specialist-consult/index.ts ~line 1712 (has prof.id)
--   supabase/functions/playbook-execute/index.ts ~line 1053 (actor is the
--     hardcoded label 'Playbook DE'/'Renewal DE', which never name-resolves —
--     this writer is ONLY covered once it passes the id itself)
-- The sink stamp defers to a writer-provided detail de_id (it only fills the
-- key when absent), so those edits compose cleanly whenever they ship.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- 1) append_audit_event — sink-side employee stamp for guardrail_block rows.
--    Body reproduced from live pg_get_functiondef 2026-07-27 (post-457 state);
--    the only additions are the v_block_de declaration and the stamp block,
--    placed AFTER the caller-identity branch (a user-JWT caller is rewritten
--    to actor_type 'human' there, so the stamp can only ever fire for the
--    service-role writers that legitimately act as an employee) and BEFORE
--    the advisory lock + hash, so the chain hashes the stamped detail.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.append_audit_event(p_tenant_id uuid, p_actor text, p_actor_type text, p_action text, p_category text, p_detail jsonb DEFAULT '{}'::jsonb)
 RETURNS audit_events
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_prev  text;
  v_now   timestamptz := clock_timestamp();
  v_hash  text;
  v_row   audit_events;
  v_actor text := coalesce(nullif(p_actor, ''), 'system');
  v_type  text := coalesce(nullif(p_actor_type, ''), 'system');
  v_detail jsonb := coalesce(p_detail, '{}'::jsonb);
  v_block_de uuid;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    IF NOT EXISTS (
      SELECT 1 FROM profiles WHERE user_id = auth.uid() AND tenant_id = p_tenant_id
    ) THEN
      RAISE EXCEPTION 'not a member of this tenant';
    END IF;
    -- Server-attested identity: whoever holds this JWT is a USER; what
    -- they claimed to be is preserved in detail for transparency.
    IF v_actor IS DISTINCT FROM '' AND (p_actor IS DISTINCT FROM null) THEN
      v_detail := v_detail || jsonb_build_object('claimed_actor', p_actor, 'claimed_actor_type', p_actor_type);
    END IF;
    SELECT coalesce(nullif(trim(full_name), ''), 'user') INTO v_actor
    FROM profiles WHERE user_id = auth.uid() AND tenant_id = p_tenant_id LIMIT 1;
    -- MUST be one of the audit_events actor_type CHECK values
    -- ('de','human','system'). A JWT caller is a human; using 'user' here
    -- silently broke every user-initiated audit write until it was caught
    -- by the Wave 1 end-to-end test.
    v_type := 'human';
    v_detail := v_detail || jsonb_build_object('_user_submitted', true, '_submitted_by', auth.uid());
  END IF;

  -- Per-employee attribution (trust program docs/31 Q7, item 4): a guardrail
  -- block written by an employee actor is stamped with that employee's id so
  -- employee-scoped trust policies can count an honest, per-employee block
  -- record. The actor string every writer passes is the employee's effective
  -- display name (persona name when set, else record name); the stamp is
  -- only applied when that name resolves to EXACTLY ONE employee in the
  -- tenant — ambiguous or unknown names are left unstamped rather than
  -- guessed. Writers that already provide detail.de_id win untouched. The
  -- stamp happens before the hash below, so the tamper-evident chain covers
  -- it and verify_audit_chain still passes.
  IF p_category = 'guardrail_block' AND v_type = 'de' AND NOT (v_detail ? 'de_id') THEN
    SELECT min(id) INTO v_block_de
    FROM digital_employees
    WHERE tenant_id = p_tenant_id
      AND coalesce(nullif(persona_name, ''), name) = v_actor
    HAVING count(*) = 1;
    IF v_block_de IS NOT NULL THEN
      v_detail := v_detail || jsonb_build_object('de_id', v_block_de);
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('audit_' || p_tenant_id::text));

  SELECT hash INTO v_prev
  FROM audit_events
  WHERE tenant_id = p_tenant_id
  ORDER BY created_at DESC, id DESC
  LIMIT 1;
  v_prev := coalesce(v_prev, '');

  v_hash := encode(digest(
    v_prev || p_tenant_id::text || coalesce(p_action, '') ||
    coalesce(v_detail::text, '{}') || v_now::text,
    'sha256'), 'hex');

  INSERT INTO audit_events (tenant_id, actor, actor_type, action, category, detail, prev_hash, hash, created_at)
  VALUES (p_tenant_id, v_actor, v_type, p_action, p_category, v_detail, v_prev, v_hash, v_now)
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$function$;

-- ────────────────────────────────────────────────────────────────────────────
-- 2) append_audit_event_internal — the direct-db sink gets the same stamp so
--    any future SQL-level guardrail writer is covered identically. Zero such
--    writers exist today (verified against pg_proc prosrc 2026-07-27), so
--    this is behavior-neutral on day one. Body reproduced from live
--    pg_get_functiondef; additions: v_detail/v_block_de declarations, the
--    stamp block, and hash/insert now reading v_detail (byte-equivalent to
--    the old coalesce(p_detail...) expressions when no stamp applies).
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.append_audit_event_internal(p_tenant_id uuid, p_actor text, p_actor_type text, p_action text, p_category text, p_detail jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_prev text;
  v_now  timestamptz := clock_timestamp();
  v_detail jsonb := coalesce(p_detail, '{}'::jsonb);
  v_block_de uuid;
begin
  -- Same per-employee stamp as append_audit_event (see that function's
  -- comment); kept in both sinks so the audited record does not depend on
  -- which write path a future guardrail writer picks.
  if p_category = 'guardrail_block' and p_actor_type = 'de' and not (v_detail ? 'de_id') then
    select min(id) into v_block_de
    from digital_employees
    where tenant_id = p_tenant_id
      and coalesce(nullif(persona_name, ''), name) = coalesce(nullif(p_actor, ''), 'system')
    having count(*) = 1;
    if v_block_de is not null then
      v_detail := v_detail || jsonb_build_object('de_id', v_block_de);
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtext('audit_' || p_tenant_id::text));
  select hash into v_prev from audit_events
    where tenant_id = p_tenant_id
    order by created_at desc, id desc limit 1;
  v_prev := coalesce(v_prev, '');
  insert into audit_events (tenant_id, actor, actor_type, action, category, detail, prev_hash, hash, created_at)
  values (p_tenant_id, p_actor, p_actor_type, p_action, p_category, v_detail, v_prev,
          encode(digest(v_prev || p_tenant_id::text || coalesce(p_action, '') ||
                        v_detail::text || v_now::text, 'sha256'), 'hex'),
          v_now);
end;
$function$;

-- ────────────────────────────────────────────────────────────────────────────
-- 3) trust_evidence_for — per-employee evidence scoping. Body reproduced from
--    live pg_get_functiondef 2026-07-27 (mig 306 lineage, current state). The
--    only changes are the three bracketed scoping conjuncts (one per evidence
--    source) and the updated source comments. A policy with de_id NULL takes
--    the `p_policy.de_id is null` arm of every conjunct and behaves
--    byte-for-byte as today. Signature, attributes and returned jsonb shape
--    are unchanged, so all three callers (compute_trust_evidence,
--    request_trust_promotion, apply_trust_promotion) survive untouched.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trust_evidence_for(p_policy trust_policies)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  c              jsonb := p_policy.criteria;
  v_window       integer := coalesce((c->>'window_days')::integer, 30);
  v_since        timestamptz := now() - make_interval(days => coalesce((c->>'window_days')::integer, 30));
  -- eval evidence
  v_eval_total   bigint := 0;
  v_eval_passed  bigint := 0;
  v_eval_rate    numeric := 0;
  -- human evidence
  v_h_total      bigint := 0;
  v_h_approved   bigint := 0;
  v_h_rate       numeric := 0;
  -- guardrail evidence
  v_blocks       bigint := 0;
  -- criteria thresholds
  v_min_rate     numeric := coalesce((c->>'min_eval_pass_rate')::numeric, 0.9);
  v_min_samples  integer := coalesce((c->>'min_eval_samples')::integer, 25);
  v_min_h_rate   numeric := coalesce((c->>'min_human_approval_rate')::numeric, 0.9);
  v_min_h_n      integer := coalesce((c->>'min_human_samples')::integer, 0);
  v_max_blocks   integer := coalesce((c->>'max_guardrail_blocks')::integer, 0);
  v_criteria     jsonb;
  v_eligible     boolean;
begin
  -- Source 1: Proving Ground — finished eval runs in the window. An
  -- employee-scoped policy counts only runs attributed to that employee
  -- (eval_runs.de_id); a tenant-scoped policy keeps the historical
  -- whole-workspace count.
  select coalesce(sum(total), 0), coalesce(sum(passed), 0)
    into v_eval_total, v_eval_passed
  from eval_runs
  where tenant_id = p_policy.tenant_id
    and finished_at is not null
    and finished_at >= v_since
    and status in ('passed', 'failed')
    and (p_policy.de_id is null or de_id = p_policy.de_id);
  v_eval_rate := case when v_eval_total > 0 then round(v_eval_passed::numeric / v_eval_total, 4) else 0 end;

  -- Source 2: human task outcomes in the window. invoice category
  -- reads invoice approval gates; answer categories read
  -- escalation / review outcomes (sparse until LLM activation —
  -- min_human_samples defaults to 0 there, honestly noted).
  -- An employee-scoped policy counts only tasks attributed to that
  -- employee (human_tasks.de_id); unattributed tasks are not another
  -- employee's evidence and are excluded from scoped policies.
  select count(*), count(*) filter (where status = 'approved')
    into v_h_total, v_h_approved
  from human_tasks
  where tenant_id = p_policy.tenant_id
    and status in ('approved', 'rejected')
    and decided_at is not null
    and decided_at >= v_since
    and case
      when p_policy.action_category = 'invoice_auto_send'
        then (related_table = 'renewal_invoices' or type = 'approval_gate')
      else type in ('escalation', 'review_gate')
    end
    and (p_policy.de_id is null or de_id = p_policy.de_id);
  v_h_rate := case when v_h_total > 0 then round(v_h_approved::numeric / v_h_total, 4) else 0 end;

  -- Source 3: guardrail blocks in the window. A tenant-scoped policy counts
  -- every block in the tenant (historical behavior). An employee-scoped
  -- policy counts blocks stamped with this employee's id in detail — rows
  -- written before the stamp existed carry no id and age out of the
  -- evidence window naturally.
  select count(*) into v_blocks
  from audit_events
  where tenant_id = p_policy.tenant_id
    and category = 'guardrail_block'
    and created_at >= v_since
    and (p_policy.de_id is null or detail->>'de_id' = p_policy.de_id::text);

  v_criteria := jsonb_build_array(
    jsonb_build_object(
      'key', 'eval_pass_rate', 'label', 'Evaluation pass rate',
      'actual', v_eval_rate, 'required', v_min_rate,
      'met', (v_eval_total >= v_min_samples and v_eval_rate >= v_min_rate),
      'detail', format('%s of %s evaluated answers passed in the last %s days', v_eval_passed, v_eval_total, v_window)),
    jsonb_build_object(
      'key', 'eval_samples', 'label', 'Evaluation sample size',
      'actual', v_eval_total, 'required', v_min_samples,
      'met', v_eval_total >= v_min_samples,
      'detail', format('%s evaluated answers (needs %s)', v_eval_total, v_min_samples)),
    jsonb_build_object(
      'key', 'human_approval_rate', 'label', 'Human approval rate',
      'actual', v_h_rate, 'required', v_min_h_rate,
      'met', (v_min_h_n = 0 or (v_h_total >= v_min_h_n and v_h_rate >= v_min_h_rate)),
      'detail', format('%s of %s human reviews approved in the last %s days', v_h_approved, v_h_total, v_window)),
    jsonb_build_object(
      'key', 'human_samples', 'label', 'Human review sample size',
      'actual', v_h_total, 'required', v_min_h_n,
      'met', v_h_total >= v_min_h_n,
      'detail', format('%s decided reviews (needs %s)', v_h_total, v_min_h_n)),
    jsonb_build_object(
      'key', 'guardrail_blocks', 'label', 'Guardrail blocks',
      'actual', v_blocks, 'required', v_max_blocks,
      'met', v_blocks <= v_max_blocks,
      'detail', format('%s guardrail blocks in the last %s days (max %s)', v_blocks, v_window, v_max_blocks))
  );

  select bool_and((x->>'met')::boolean) into v_eligible
  from jsonb_array_elements(v_criteria) x;

  return jsonb_build_object(
    'policy_id', p_policy.id,
    'action_category', p_policy.action_category,
    'current_level', p_policy.current_level,
    'target_level', p_policy.target_level,
    'window_days', v_window,
    'criteria', v_criteria,
    'eligible', coalesce(v_eligible, false) and p_policy.current_level < 3 and p_policy.status = 'active',
    'at_max_level', p_policy.current_level >= 3,
    'computed_at', now()
  );
end;
$function$;

-- ────────────────────────────────────────────────────────────────────────────
-- 4) trust_check_guardrail_block — the automatic-demotion trigger applies the
--    same per-employee honesty as the promotion evidence: an employee-scoped
--    promoted policy is only demoted by its own employee's stamped block.
--    Unstamped rows (pre-migration history, or a writer whose name did not
--    resolve) keep the historical demote-every-policy behavior — demotion is
--    the safety direction, so ambiguity stays conservative. Tenant-scoped
--    policies are unchanged. Zero policies are promoted above baseline today
--    (verified live), so this changes nothing on day one. Trigger context is
--    direct-db (fires inside the inserting session — in practice the
--    service-role edge-fn session); the new predicate only narrows the loop
--    and cannot raise, and the existing exception guard is preserved.
--    Body reproduced from live pg_get_functiondef 2026-07-27.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trust_check_guardrail_block()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_policy record;
begin
  if new.category <> 'guardrail_block' then
    return new;
  end if;
  begin
    for v_policy in
      select * from trust_policies
      where tenant_id = new.tenant_id and status = 'active' and current_level > baseline_level
        and coalesce((criteria->>'max_guardrail_blocks')::integer, 0) = 0
        and (de_id is null
             or new.detail->>'de_id' is null
             or de_id::text = new.detail->>'de_id')
    loop
      perform trust_demote(
        new.tenant_id, v_policy.action_category,
        'a guardrail block occurred — zero-tolerance policy',
        jsonb_build_object('audit_event_id', new.id, 'blocked_action', new.action),
        v_policy.de_id, v_policy.source_category
      );
    end loop;
  exception when others then
    raise warning 'trust_check_guardrail_block: %', sqlerrm;
  end;
  return new;
end;
$function$;

-- ────────────────────────────────────────────────────────────────────────────
-- 5) compute_trust_evidence — the policy picker resolves the scope the caller
--    ASKED for. Body reproduced from live pg_get_functiondef 2026-07-27
--    (mig 447 lineage); the ONLY change is the policy-selection WHERE/ORDER.
--
--    The live defect: ORDER BY (de_id is not null and de_id = p_de_id) DESC.
--    With p_de_id NULL, that key is NULL for every employee-scoped row, and
--    DESC ordering puts NULLs FIRST — so the workspace ask (p_de_id NULL)
--    picked an arbitrary EMPLOYEE-scoped policy wherever one existed, and the
--    workspace policy's evidence/criteria were unreachable through this RPC.
--
--    Corrected semantics:
--      p_de_id NULL → ONLY the workspace policy (de_id IS NULL) qualifies;
--      p_de_id set  → that employee's policy first, workspace fallback.
--    Guards, signature, return shape: unchanged (all three verified below).
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.compute_trust_evidence(p_de_id uuid, p_action_category text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_tenant uuid;
  v_is_active boolean;
  v_policy trust_policies;
begin
  select tenant_id, coalesce(is_active, true) into v_tenant, v_is_active from profiles where user_id = auth.uid() limit 1;
  if v_tenant is null then
    raise exception 'not a member of any tenant';
  end if;
  if not v_is_active then
    raise exception 'account is deactivated';
  end if;
  if p_de_id is not null and not public.can_access_de(p_de_id) then
    raise exception 'not_responsible_for_de';
  end if;

  -- Scope resolution (fixed here): a NULL p_de_id asks about the WORKSPACE
  -- and must never surface an employee-scoped policy; a set p_de_id prefers
  -- that employee's own policy and falls back to the workspace default.
  select * into v_policy
  from trust_policies
  where tenant_id = v_tenant
    and action_category = p_action_category
    and (de_id is null or (p_de_id is not null and de_id = p_de_id))
  order by (de_id is not null) desc
  limit 1;
  if not found then
    raise exception 'no trust policy for category %', p_action_category;
  end if;

  return trust_evidence_for(v_policy);
end;
$function$;

-- ────────────────────────────────────────────────────────────────────────────
-- Asserts — the change LANDED, or this migration refuses to commit.
-- ────────────────────────────────────────────────────────────────────────────
do $assert$
declare
  v_cnt  integer;
  v_def  text;
  v_pol  trust_policies;
  v_out  jsonb;
  v_tenant uuid;
  v_cat  text;
  v_de   uuid;
  v_pick trust_policies;
begin
  -- Rule 5: no signature changed, so each touched name must have exactly one
  -- arity in public.
  select count(*) into v_cnt from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'append_audit_event';
  if v_cnt <> 1 then raise exception 'ASSERT FAILED: append_audit_event arity count = % (want 1)', v_cnt; end if;

  select count(*) into v_cnt from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'append_audit_event_internal';
  if v_cnt <> 1 then raise exception 'ASSERT FAILED: append_audit_event_internal arity count = % (want 1)', v_cnt; end if;

  select count(*) into v_cnt from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'trust_evidence_for';
  if v_cnt <> 1 then raise exception 'ASSERT FAILED: trust_evidence_for arity count = % (want 1)', v_cnt; end if;

  select count(*) into v_cnt from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'trust_check_guardrail_block';
  if v_cnt <> 1 then raise exception 'ASSERT FAILED: trust_check_guardrail_block arity count = % (want 1)', v_cnt; end if;

  -- The three scoping conjuncts landed in trust_evidence_for, WITH their
  -- brackets (OR-precedence rule: each appended disjunction must be
  -- parenthesized before the surrounding ANDs touch it).
  v_def := pg_get_functiondef('public.trust_evidence_for(trust_policies)'::regprocedure);
  if position('(p_policy.de_id is null or de_id = p_policy.de_id)' in v_def) = 0 then
    raise exception 'ASSERT FAILED: trust_evidence_for is missing the bracketed per-employee row filter';
  end if;
  -- It must appear twice: once for eval runs, once for human tasks.
  if (length(v_def) - length(replace(v_def, '(p_policy.de_id is null or de_id = p_policy.de_id)', '')))
       / length('(p_policy.de_id is null or de_id = p_policy.de_id)') <> 2 then
    raise exception 'ASSERT FAILED: trust_evidence_for per-employee row filter must appear exactly twice (eval + human)';
  end if;
  if position('(p_policy.de_id is null or detail->>''de_id'' = p_policy.de_id::text)' in v_def) = 0 then
    raise exception 'ASSERT FAILED: trust_evidence_for is missing the bracketed guardrail-stamp filter';
  end if;
  -- The pre-existing bracketed disjunction inside the human-task CASE must
  -- have survived reproduction intact.
  if position('(related_table = ''renewal_invoices'' or type = ''approval_gate'')' in v_def) = 0 then
    raise exception 'ASSERT FAILED: trust_evidence_for lost the bracketed invoice-gate disjunction';
  end if;

  -- The stamp landed in both sinks.
  v_def := pg_get_functiondef('public.append_audit_event(uuid,text,text,text,text,jsonb)'::regprocedure);
  if position('v_block_de' in v_def) = 0 then
    raise exception 'ASSERT FAILED: append_audit_event is missing the employee stamp';
  end if;
  v_def := pg_get_functiondef('public.append_audit_event_internal(uuid,text,text,text,text,jsonb)'::regprocedure);
  if position('v_block_de' in v_def) = 0 then
    raise exception 'ASSERT FAILED: append_audit_event_internal is missing the employee stamp';
  end if;

  -- The demotion trigger's bracketed scope predicate landed, and the trigger
  -- itself is still attached to audit_events.
  v_def := pg_get_functiondef('public.trust_check_guardrail_block()'::regprocedure);
  if position('or new.detail->>''de_id'' is null' in v_def) = 0
     or position('de_id::text = new.detail->>''de_id''' in v_def) = 0 then
    raise exception 'ASSERT FAILED: trust_check_guardrail_block is missing the bracketed per-employee scope';
  end if;
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.audit_events'::regclass
      and tgname = 'trust_guardrail_block' and not tgisinternal
  ) then
    raise exception 'ASSERT FAILED: trust_guardrail_block trigger is no longer attached to audit_events';
  end if;

  -- compute_trust_evidence: one arity, the corrected picker landed, the
  -- mig-447 NULL-poisoned ordering is GONE, and the guards survived.
  select count(*) into v_cnt from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'compute_trust_evidence';
  if v_cnt <> 1 then raise exception 'ASSERT FAILED: compute_trust_evidence arity count = % (want 1)', v_cnt; end if;
  v_def := pg_get_functiondef('public.compute_trust_evidence(uuid,text)'::regprocedure);
  if position('(de_id is null or (p_de_id is not null and de_id = p_de_id))' in v_def) = 0
     or position('order by (de_id is not null) desc' in v_def) = 0 then
    raise exception 'ASSERT FAILED: compute_trust_evidence is missing the corrected scope resolution';
  end if;
  if position('(de_id is not null and de_id = p_de_id)' in v_def) > 0 then
    raise exception 'ASSERT FAILED: compute_trust_evidence still carries the mig-447 NULL-poisoned ordering key';
  end if;
  if position('can_access_de' in v_def) = 0
     or position('not a member of any tenant' in v_def) = 0
     or position('account is deactivated' in v_def) = 0 then
    raise exception 'ASSERT FAILED: compute_trust_evidence lost a mig-447 guard during reproduction';
  end if;

  -- Resolution PROOF on live data shapes, using the exact selection the
  -- function now runs (the RPC itself raises without a JWT, so the picker is
  -- proven directly). Both directions, wherever live rows allow:
  --   (1) any tenant+category holding a WORKSPACE policy: the workspace ask
  --       (p_de_id NULL) must pick de_id IS NULL — even when employee-scoped
  --       rows exist beside it (the exact shape mig 447 got wrong);
  --   (2) any employee-scoped policy: asking for that employee must pick it.
  select tp.tenant_id, tp.action_category into v_tenant, v_cat
    from trust_policies tp
   where tp.de_id is null
   order by (exists (select 1 from trust_policies t2
                      where t2.tenant_id = tp.tenant_id
                        and t2.action_category = tp.action_category
                        and t2.de_id is not null)) desc
   limit 1;
  if found then
    select * into v_pick from trust_policies
     where tenant_id = v_tenant and action_category = v_cat
       and (de_id is null or (null::uuid is not null and de_id = null::uuid))
     order by (de_id is not null) desc limit 1;
    if v_pick.de_id is not null then
      raise exception 'ASSERT FAILED: the workspace ask (p_de_id NULL) resolved an employee-scoped policy (%)', v_pick.id;
    end if;
  end if;
  select tp.tenant_id, tp.action_category, tp.de_id into v_tenant, v_cat, v_de
    from trust_policies tp where tp.de_id is not null limit 1;
  if found then
    select * into v_pick from trust_policies
     where tenant_id = v_tenant and action_category = v_cat
       and (de_id is null or (v_de is not null and de_id = v_de))
     order by (de_id is not null) desc limit 1;
    if v_pick.de_id is distinct from v_de then
      raise exception 'ASSERT FAILED: the employee ask did not resolve that employee''s own policy (picked %)', v_pick.id;
    end if;
  end if;

  -- Functional smoke, in THIS (direct-db) context: evidence still computes —
  -- returns a criteria array, never empty-instead-of-error — for one live
  -- tenant-scoped policy and one live employee-scoped policy where present.
  select * into v_pol from trust_policies where de_id is null limit 1;
  if found then
    v_out := trust_evidence_for(v_pol);
    if v_out is null or jsonb_typeof(v_out->'criteria') <> 'array' then
      raise exception 'ASSERT FAILED: trust_evidence_for returned no criteria for a tenant-scoped policy';
    end if;
  end if;
  select * into v_pol from trust_policies where de_id is not null limit 1;
  if found then
    v_out := trust_evidence_for(v_pol);
    if v_out is null or jsonb_typeof(v_out->'criteria') <> 'array' then
      raise exception 'ASSERT FAILED: trust_evidence_for returned no criteria for an employee-scoped policy';
    end if;
  end if;
end;
$assert$;

NOTIFY pgrst, 'reload schema';
