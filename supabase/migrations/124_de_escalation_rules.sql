-- DE-B2: per-DE structured escalation rules (constitution §3.10–3.12).
--
-- What already existed per-DE: the confidence floor (the trust dial's
-- min_confidence, Wave 1.1 cascade) — deliberately NOT duplicated
-- here. What was missing: the frustration threshold was hardcoded at
-- 50 in both triage siblings, and there was no per-employee "always
-- escalate these topics" control at all.
--
-- de_escalation_rules is the same fallback cascade as the trust dial:
-- a row for the specific DE wins, else the tenant-wide row (de_id
-- null), else the platform defaults (threshold 50, no topics).
-- Escalation ordering in triage stays: guardrails always win →
-- always-escalate topics → frustration threshold → trust dial.

create table if not exists de_escalation_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  de_id uuid references digital_employees(id) on delete cascade,  -- null = tenant-wide default
  frustration_threshold integer check (frustration_threshold is null or (frustration_threshold between 0 and 100)),
  always_escalate_topics text[] not null default '{}',
  updated_by uuid,
  updated_at timestamptz not null default now()
);

create unique index if not exists de_escalation_rules_scope_idx
  on de_escalation_rules (tenant_id, coalesce(de_id::text, ''));

alter table de_escalation_rules enable row level security;

drop policy if exists de_escalation_rules_tenant_select on de_escalation_rules;
create policy de_escalation_rules_tenant_select on de_escalation_rules
  for select to authenticated
  using (tenant_id = auth_tenant_id());

-- Writes only via the RPC below.

-- ────────────────────────────────────────────────────────────────
-- Cascade resolution: DE row → tenant row → platform defaults.
-- ────────────────────────────────────────────────────────────────
create or replace function resolve_de_escalation(p_tenant_id uuid, p_de_id uuid default null)
returns table(frustration_threshold integer, always_escalate_topics text[])
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(
      (select r.frustration_threshold from de_escalation_rules r
       where r.tenant_id = p_tenant_id and r.de_id = p_de_id and p_de_id is not null and r.frustration_threshold is not null),
      (select r.frustration_threshold from de_escalation_rules r
       where r.tenant_id = p_tenant_id and r.de_id is null and r.frustration_threshold is not null),
      50
    ) as frustration_threshold,
    coalesce(
      (select nullif(r.always_escalate_topics, '{}') from de_escalation_rules r
       where r.tenant_id = p_tenant_id and r.de_id = p_de_id and p_de_id is not null),
      (select nullif(r.always_escalate_topics, '{}') from de_escalation_rules r
       where r.tenant_id = p_tenant_id and r.de_id is null),
      '{}'::text[]
    ) as always_escalate_topics;
$$;

revoke all on function resolve_de_escalation(uuid, uuid) from public, anon;
grant execute on function resolve_de_escalation(uuid, uuid) to authenticated, service_role;

-- ────────────────────────────────────────────────────────────────
-- Configuration — owner/admin gated, Remote-Access-aware, audited.
-- Passing null threshold AND empty topics deletes the row (falls
-- back to the next tier of the cascade).
-- ────────────────────────────────────────────────────────────────
create or replace function set_de_escalation_rules(
  p_de_id uuid default null,
  p_frustration_threshold integer default null,
  p_topics text[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid;
  v_de_name text := 'workspace default';
  v_topics text[] := coalesce(p_topics, '{}'::text[]);
begin
  if p_frustration_threshold is not null and (p_frustration_threshold < 0 or p_frustration_threshold > 100) then
    raise exception 'frustration threshold must be between 0 and 100';
  end if;
  v_tenant := auth_tenant_id();
  if v_tenant is null then raise exception 'not a member of any tenant'; end if;
  if not auth_has_tenant_role(array['tenant_owner', 'tenant_admin']) then
    raise exception 'only workspace owners/admins can set escalation rules';
  end if;

  if p_de_id is not null then
    select name into v_de_name from digital_employees where id = p_de_id and tenant_id = v_tenant;
    if v_de_name is null then raise exception 'employee not found in this workspace'; end if;
  end if;

  if p_frustration_threshold is null and array_length(v_topics, 1) is null then
    delete from de_escalation_rules
    where tenant_id = v_tenant and coalesce(de_id::text, '') = coalesce(p_de_id::text, '');
    perform append_audit_event_internal(
      v_tenant, 'You', 'human',
      format('Escalation rules for %s cleared — falls back to the shared default', v_de_name),
      'config_change',
      jsonb_build_object('kind', 'escalation_rules_cleared', 'de_id', p_de_id)
    );
    return jsonb_build_object('ok', true, 'cleared', true);
  end if;

  insert into de_escalation_rules (tenant_id, de_id, frustration_threshold, always_escalate_topics, updated_by)
  values (v_tenant, p_de_id, p_frustration_threshold, v_topics, auth.uid())
  on conflict (tenant_id, coalesce(de_id::text, ''))
  do update set frustration_threshold = excluded.frustration_threshold,
                always_escalate_topics = excluded.always_escalate_topics,
                updated_by = excluded.updated_by,
                updated_at = now();

  perform append_audit_event_internal(
    v_tenant, 'You', 'human',
    format('Escalation rules for %s set — frustration threshold %s, %s always-escalate topic(s)',
      v_de_name,
      coalesce(p_frustration_threshold::text, 'inherited'),
      coalesce(array_length(v_topics, 1), 0)),
    'config_change',
    jsonb_build_object('kind', 'escalation_rules_set', 'de_id', p_de_id,
      'frustration_threshold', p_frustration_threshold, 'topics', v_topics)
  );

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function set_de_escalation_rules(uuid, integer, text[]) from public, anon;
grant execute on function set_de_escalation_rules(uuid, integer, text[]) to authenticated, service_role;

-- ────────────────────────────────────────────────────────────────
-- Consume in BOTH triage siblings. Byte-identical to their prior
-- definitions except: (a) new always-escalate-topics tier between the
-- guardrail check and the frustration check, (b) the hardcoded 50
-- becomes the resolved per-DE/tenant threshold.
-- ────────────────────────────────────────────────────────────────
create or replace function decide_inquiry_triage(p_tenant_id uuid, p_inquiry text, p_confidence integer, p_de_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
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
  --    identical matching to checkAnswerGuardrails (specialist-consult).
  for v_rule in
    select id, rule, pattern from guardrail_rules
    where tenant_id = p_tenant_id and active and severity = 'blocking'
      and rule_type in ('blocked_phrase', 'blocked_topic')
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
$$;

create or replace function decide_work_item_triage(p_tenant_id uuid, p_category text, p_inquiry text, p_confidence integer, p_de_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
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
  -- 1) Guardrail check — identical matching to decide_inquiry_triage.
  for v_rule in
    select id, rule, pattern from guardrail_rules
    where tenant_id = p_tenant_id and active and severity = 'blocking'
      and rule_type in ('blocked_phrase', 'blocked_topic')
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
$$;
