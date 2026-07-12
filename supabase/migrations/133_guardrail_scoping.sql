-- ============================================================
-- Wave 2a — Guardrail SCOPING (workspace / department / employee / playbook)
--
-- Before this migration every guardrail applied tenant-wide: the ~dozen
-- enforcement sites all filtered `where tenant_id = ... and active` only,
-- and the table's `applies_to` column was dead (always 'all', never read).
-- A tenant could not say "Finance DE may never quote a refund" without
-- also gagging Support.
--
-- This adds a real scope dimension and a single centralized resolver,
-- `guardrail_rules_for_de(tenant, de, rule_types, playbook)`, that every
-- enforcement site now calls instead of re-implementing the tenant-only
-- SELECT. The three triage/gate functions are recreated verbatim from
-- their live bodies (pulled via pg_get_functiondef) with only that one
-- query swapped, so no other behavior changes.
--
-- Scope semantics (a rule applies to a DE's evaluation when):
--   workspace  → always
--   employee   → scope_ref = the DE's id
--   department → scope_ref = the DE's free-text `department`
--   playbook   → scope_ref = the running playbook definition id
-- A null DE (anonymous/unscoped call) sees workspace rules only — the
-- exact pre-migration behavior, so nothing regresses.
--
-- frustration_signal rules stay workspace-only for now: they detect an
-- angry customer regardless of which employee is handling it, and
-- score_frustration_internal has no DE in scope. Noted, not scoped.
-- ============================================================

-- 1) Schema: scope + scope_ref. Existing rows inherit 'workspace'.
alter table guardrail_rules
  add column if not exists scope text not null default 'workspace';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'guardrail_rules_scope_check'
  ) then
    alter table guardrail_rules
      add constraint guardrail_rules_scope_check
      check (scope in ('workspace','department','employee','playbook'));
  end if;
end $$;

alter table guardrail_rules
  add column if not exists scope_ref text;

create index if not exists guardrail_rules_scope_idx
  on guardrail_rules(tenant_id, scope, scope_ref) where active;

-- 2) The single resolver every enforcement site now shares. Returns the
--    full guardrail_rules rows applicable to this DE (workspace ∪ the
--    matching employee/department/playbook rows), of the requested types,
--    active only. Callers add their own severity / ordering as before.
create or replace function guardrail_rules_for_de(
  p_tenant_id       uuid,
  p_de_id           uuid,
  p_rule_types      text[],
  p_playbook_def_id uuid default null
) returns setof guardrail_rules
language sql
stable
security definer
set search_path to 'public', 'extensions'
as $function$
  select g.*
  from guardrail_rules g
  where g.tenant_id = p_tenant_id
    and g.active
    and g.rule_type = any(p_rule_types)
    and (
          g.scope = 'workspace'
      or (g.scope = 'employee'   and p_de_id is not null
            and g.scope_ref = p_de_id::text)
      or (g.scope = 'department' and p_de_id is not null
            and g.scope_ref = (select de.department
                                 from digital_employees de
                                where de.id = p_de_id))
      or (g.scope = 'playbook'   and p_playbook_def_id is not null
            and g.scope_ref = p_playbook_def_id::text)
    );
$function$;

revoke all on function guardrail_rules_for_de(uuid, uuid, text[], uuid) from public, anon;
grant execute on function guardrail_rules_for_de(uuid, uuid, text[], uuid) to authenticated, service_role;

-- ============================================================
-- 3) Recreate the three enforcement functions from their LIVE bodies,
--    swapping only the inline guardrail SELECT for the resolver.
-- ============================================================

-- 3a) decide_inquiry_triage
create or replace function public.decide_inquiry_triage(p_tenant_id uuid, p_inquiry text, p_confidence integer, p_de_id uuid default null::uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_rule       record;
  v_text       text := lower(coalesce(p_inquiry, ''));
  v_autonomy   record;
  v_min_conf   integer;
  v_enabled    boolean;
  v_frag       text;
  v_hit        boolean;
  v_frustration integer;
  v_esc        record;
begin
  -- 1) Guardrail check — blocking blocked_topic/blocked_phrase rules,
  --    now scoped to this employee (workspace ∪ department ∪ employee).
  for v_rule in
    select g.id, g.rule, g.pattern
    from guardrail_rules_for_de(p_tenant_id, p_de_id, array['blocked_phrase','blocked_topic']) g
    where g.severity = 'blocking'
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
        return jsonb_build_object(
          'decision', 'blocked_guardrail',
          'confidence', p_confidence,
          'guardrail_rule_id', v_rule.id,
          'guardrail_rule', v_rule.rule,
          'trust_level', null,
          'frustration_score', null,
          'reasoning', format('Blocked: guardrail rule "%s" matched this inquiry — routed to a human regardless of confidence (%s%%). Guardrails always win over the trust dial.', v_rule.rule, p_confidence)
        );
      end if;
    end loop;
  end loop;

  select * into v_esc from resolve_de_escalation(p_tenant_id, p_de_id);

  -- 1.25) Always-escalate topics (DE-B2): per-employee (or workspace-
  --       default) topic patterns that always get a human, regardless
  --       of confidence — below guardrails, above everything else.
  if array_length(v_esc.always_escalate_topics, 1) is not null then
    foreach v_frag in array v_esc.always_escalate_topics loop
      v_frag := trim(both from lower(v_frag));
      if v_frag = '' then continue; end if;
      begin
        v_hit := v_text ~ v_frag;
      exception when others then
        v_hit := position(v_frag in v_text) > 0;
      end;
      if v_hit then
        return jsonb_build_object(
          'decision', 'needs_review',
          'confidence', p_confidence,
          'guardrail_rule_id', null,
          'guardrail_rule', null,
          'trust_level', null,
          'frustration_score', null,
          'reasoning', format('Needs review: this inquiry matches the always-escalate topic "%s" configured for this employee — routed to a human regardless of confidence (%s%%).', v_frag, p_confidence)
        );
      end if;
    end loop;
  end if;

  -- 1.5) Frustration check — threshold resolved per-employee with
  --      workspace fallback (was hardcoded 50).
  v_frustration := score_frustration_internal(p_tenant_id, p_inquiry);
  if v_frustration >= v_esc.frustration_threshold then
    return jsonb_build_object(
      'decision', 'needs_review',
      'confidence', p_confidence,
      'guardrail_rule_id', null,
      'guardrail_rule', null,
      'trust_level', null,
      'frustration_score', v_frustration,
      'reasoning', format('Needs review: this inquiry scored %s%% on frustration signals (threshold %s%%) — routed to a human regardless of confidence (%s%%). A frustrated customer always gets a human.', v_frustration, v_esc.frustration_threshold, p_confidence)
    );
  end if;

  -- 2) Trust dial — resolved per-employee first now (no category
  --    dimension for this sibling, matching its existing scope).
  select * into v_autonomy from resolve_de_autonomy(p_tenant_id, 'answer_widget', p_de_id, null);
  v_enabled := coalesce(v_autonomy.enabled, false);
  v_min_conf := v_autonomy.min_confidence;

  if v_enabled and v_min_conf is not null and p_confidence >= v_min_conf then
    return jsonb_build_object(
      'decision', 'would_auto_send',
      'confidence', p_confidence,
      'guardrail_rule_id', null,
      'guardrail_rule', null,
      'trust_level', v_min_conf,
      'frustration_score', v_frustration,
      'reasoning', format('Would auto-send: confidence %s%% clears the trust-dial floor of %s%% for auto-answering customers, and no guardrail blocked it. Recorded as intent only — no outbound reply channel exists yet, so nothing was actually sent.', p_confidence, v_min_conf)
    );
  end if;

  return jsonb_build_object(
    'decision', 'needs_review',
    'confidence', p_confidence,
    'guardrail_rule_id', null,
    'guardrail_rule', null,
    'trust_level', v_min_conf,
    'frustration_score', v_frustration,
    'reasoning', case
      when not v_enabled then format('Needs review: confidence %s%%, but auto-answering customers is not yet enabled on the trust dial (Governance -> Trust & Architecture).', p_confidence)
      else format('Needs review: confidence %s%% is below the trust-dial floor of %s%% required to auto-answer customers.', p_confidence, coalesce(v_min_conf, 0))
    end
  );
end;
$function$;

-- 3b) decide_work_item_triage
create or replace function public.decide_work_item_triage(p_tenant_id uuid, p_category text, p_inquiry text, p_confidence integer, p_de_id uuid default null::uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_rule       record;
  v_text       text := lower(coalesce(p_inquiry, ''));
  v_autonomy   record;
  v_min_conf   integer;
  v_enabled    boolean;
  v_frag       text;
  v_hit        boolean;
  v_frustration integer;
  v_esc        record;
begin
  -- 1) Guardrail check — now scoped to this employee (workspace ∪
  --    department ∪ employee), identical matching to the sibling.
  for v_rule in
    select g.id, g.rule, g.pattern
    from guardrail_rules_for_de(p_tenant_id, p_de_id, array['blocked_phrase','blocked_topic']) g
    where g.severity = 'blocking'
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
        return jsonb_build_object(
          'decision', 'blocked_guardrail',
          'confidence', p_confidence,
          'guardrail_rule_id', v_rule.id,
          'guardrail_rule', v_rule.rule,
          'trust_level', null,
          'frustration_score', null,
          'reasoning', format('Blocked: guardrail rule "%s" matched this %s item — routed to a human regardless of confidence (%s%%). Guardrails always win over the trust dial.', v_rule.rule, p_category, p_confidence)
        );
      end if;
    end loop;
  end loop;

  select * into v_esc from resolve_de_escalation(p_tenant_id, p_de_id);

  -- 1.25) Always-escalate topics (DE-B2) — same tier as the sibling.
  if array_length(v_esc.always_escalate_topics, 1) is not null then
    foreach v_frag in array v_esc.always_escalate_topics loop
      v_frag := trim(both from lower(v_frag));
      if v_frag = '' then continue; end if;
      begin
        v_hit := v_text ~ v_frag;
      exception when others then
        v_hit := position(v_frag in v_text) > 0;
      end;
      if v_hit then
        return jsonb_build_object(
          'decision', 'needs_review',
          'confidence', p_confidence,
          'guardrail_rule_id', null,
          'guardrail_rule', null,
          'trust_level', null,
          'frustration_score', null,
          'reasoning', format('Needs review: this %s item matches the always-escalate topic "%s" configured for this employee — routed to a human regardless of confidence (%s%%).', p_category, v_frag, p_confidence)
        );
      end if;
    end loop;
  end if;

  -- 1.5) Frustration check — threshold resolved per-employee with
  --      workspace fallback (was hardcoded 50).
  v_frustration := score_frustration_internal(p_tenant_id, p_inquiry);
  if v_frustration >= v_esc.frustration_threshold then
    return jsonb_build_object(
      'decision', 'needs_review',
      'confidence', p_confidence,
      'guardrail_rule_id', null,
      'guardrail_rule', null,
      'trust_level', null,
      'frustration_score', v_frustration,
      'reasoning', format('Needs review: this %s item scored %s%% on frustration signals (threshold %s%%) — routed to a human regardless of confidence (%s%%). A frustrated customer always gets a human.', p_category, v_frustration, v_esc.frustration_threshold, p_confidence)
    );
  end if;

  -- 2) Trust dial — resolved per-employee first now, via the shared
  --    cascade (exact de+category -> de-wide -> category-wide -> tenant-wide).
  select * into v_autonomy from resolve_de_autonomy(p_tenant_id, 'answer_widget', p_de_id, p_category);
  v_enabled := coalesce(v_autonomy.enabled, false);
  v_min_conf := v_autonomy.min_confidence;

  if v_enabled and v_min_conf is not null and p_confidence >= v_min_conf then
    return jsonb_build_object(
      'decision', 'would_auto_send',
      'confidence', p_confidence,
      'guardrail_rule_id', null,
      'guardrail_rule', null,
      'trust_level', v_min_conf,
      'frustration_score', v_frustration,
      'reasoning', format('Would auto-send: confidence %s%% clears the trust-dial floor of %s%% for auto-answering on %s, and no guardrail blocked it. Recorded as intent only unless a registered action can act on this item.', p_confidence, v_min_conf, p_category)
    );
  end if;

  return jsonb_build_object(
    'decision', 'needs_review',
    'confidence', p_confidence,
    'guardrail_rule_id', null,
    'guardrail_rule', null,
    'trust_level', v_min_conf,
    'frustration_score', v_frustration,
    'reasoning', case
      when not v_enabled then format('Needs review: confidence %s%%, but auto-answering on %s is not yet enabled on the trust dial (Governance -> Trust & Architecture).', p_confidence, p_category)
      else format('Needs review: confidence %s%% is below the trust-dial floor of %s%% required to auto-answer on %s.', p_confidence, coalesce(v_min_conf, 0), p_category)
    end
  );
end;
$function$;

-- 3c) decide_action_execution
create or replace function public.decide_action_execution(p_tenant_id uuid, p_action_label text, p_category text, p_destructive boolean, p_de_id uuid default null::uuid, p_amount_cents bigint default null::bigint, p_action_type text default 'action_execute'::text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_rule      record;
  v_text      text := lower(coalesce(p_action_label, '') || ' ' || coalesce(p_category, ''));
  v_autonomy  record;
  v_frag      text;
  v_hit       boolean;
  v_threshold bigint;
begin
  -- 0) DESTRUCTIVE ALWAYS GATES — checked first, unconditionally.
  if coalesce(p_destructive, true) then
    return jsonb_build_object(
      'decision', 'human_gated_destructive',
      'guardrail_rule_id', null, 'guardrail_rule', null, 'trust_level', null,
      'reasoning', format('This action is marked destructive — it always requires human approval regardless of trust level. This is a platform safety floor, not a per-department setting: "%s" will never auto-execute.', p_action_label)
    );
  end if;

  -- 1) Guardrail check — now scoped to this employee (workspace ∪
  --    department ∪ employee). Guardrails always win over the trust dial.
  for v_rule in
    select g.id, g.rule, g.pattern
    from guardrail_rules_for_de(p_tenant_id, p_de_id, array['blocked_phrase','blocked_topic']) g
    where g.severity = 'blocking'
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
        return jsonb_build_object(
          'decision', 'guardrail_blocked',
          'guardrail_rule_id', v_rule.id, 'guardrail_rule', v_rule.rule, 'trust_level', null,
          'reasoning', format('Blocked: guardrail rule "%s" matched this action — routed to a human regardless of trust. Guardrails always win over the trust dial.', v_rule.rule)
        );
      end if;
    end loop;
  end loop;

  -- 1.5) Amount guardrail (require_approval_over_cents) — only when the
  --      caller supplies an amount. Now scope-aware: the most specific
  --      applicable threshold (employee > playbook > department >
  --      workspace) wins, then most-recently-updated. A gate, not a block.
  if p_amount_cents is not null then
    select g.threshold into v_threshold
    from guardrail_rules_for_de(p_tenant_id, p_de_id, array['require_approval_over_cents']) g
    order by (case g.scope when 'employee' then 0 when 'playbook' then 1 when 'department' then 2 else 3 end),
             g.updated_at desc
    limit 1;
    v_threshold := coalesce(v_threshold, 1000000);  -- $10,000 platform default, same as the old TS constant
    if p_amount_cents > v_threshold then
      return jsonb_build_object(
        'decision', 'human_gated_trust',
        'guardrail_rule_id', null, 'guardrail_rule', 'require_approval_over_cents', 'trust_level', null,
        'reasoning', format('Needs approval: "%s" is for $%s, above this workspace''s $%s approval threshold. Amounts over the threshold always get a human, regardless of the trust dial.', p_action_label, round(p_amount_cents / 100.0), round(v_threshold / 100.0))
      );
    end if;
  end if;

  -- 2) Trust dial — per-employee first (Wave 1.1 cascade): exact
  --    de+category → de-wide → category-wide → tenant-wide, via the
  --    shared resolve_de_autonomy. An unconfigured dial resolves to
  --    (false, null, null) — trust is opt-in, never assumed.
  select * into v_autonomy from resolve_de_autonomy(p_tenant_id, p_action_type, p_de_id, p_category);

  if coalesce(v_autonomy.enabled, false)
     and (p_amount_cents is null
          or (v_autonomy.max_amount_cents is not null and p_amount_cents <= v_autonomy.max_amount_cents)) then
    return jsonb_build_object(
      'decision', 'auto_executed',
      'guardrail_rule_id', null, 'guardrail_rule', null, 'trust_level', 1,
      'reasoning', case
        when p_amount_cents is not null then
          format('Auto-executed: "%s" ($%s) is within both the workspace approval threshold and the earned trust-dial limit of $%s%s, and no guardrail blocked it.',
            p_action_label, round(p_amount_cents / 100.0), round(v_autonomy.max_amount_cents / 100.0),
            case when p_de_id is not null then ' resolved for this employee' else '' end)
        else
          format('Auto-executed: "%s" is not destructive, no guardrail blocked it, and the trust dial%s allows auto-executing non-destructive actions for %s.',
            p_action_label, case when p_de_id is not null then ' (resolved for this employee)' else '' end, p_category)
      end
    );
  end if;

  return jsonb_build_object(
    'decision', 'human_gated_trust',
    'guardrail_rule_id', null, 'guardrail_rule', null, 'trust_level', null,
    'reasoning', case
      when not coalesce(v_autonomy.enabled, false) then
        format('Needs approval: "%s" is not destructive, but the trust dial has not enabled auto-execution for %s %s actions yet (Governance -> Trust & Architecture).',
          p_action_label, case when p_de_id is not null then 'this employee''s' else 'this workspace''s' end, p_category)
      else
        format('Needs approval: "%s" ($%s) exceeds the trust-dial limit of %s earned so far.',
          p_action_label, round(coalesce(p_amount_cents, 0) / 100.0),
          coalesce('$' || round(v_autonomy.max_amount_cents / 100.0)::text, 'no amount'))
    end
  );
end;
$function$;
