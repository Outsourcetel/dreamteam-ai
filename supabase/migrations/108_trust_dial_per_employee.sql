-- Migration 108: Trust dial, per employee (Wave 1.1).
--
-- The evidence-gated promote/demote machinery (migration 025) and its
-- category-scoping widen (migration 036) were already real; only the
-- de_id dimension was missing, and the column was already reserved on
-- trust_policies with a comment naming exactly this as "the coming
-- per-DE dial." de_autonomy never had a de_id column at all. Both
-- widened the SAME way migration 036 already proved twice: a nullable
-- column + a null-safe coalesce unique index, NULL still meaning
-- "tenant/category-wide" so nothing existing changes behavior.
--
-- THREE REAL BUGS CAUGHT AND FIXED ALONG THE WAY, unrelated to the
-- per-DE feature itself but found while touching this exact area:
--   1. seed_trust_policies()'s `on conflict (tenant_id, action_category)`
--      no longer matched the real unique index shape after migration
--      036 widened it to 3 expressions — would have thrown "no unique
--      or exclusion constraint matching ON CONFLICT" for any BRAND
--      NEW tenant with zero existing trust_policies rows (existing
--      tenants never hit this path since the list-empty check that
--      triggers seeding was already false for them).
--   2. upsertAutonomy() (src/lib/autonomyApi.ts) issued a raw
--      PostgREST upsert with `onConflict: 'tenant_id,action_type'` —
--      same class of bug, also stale since migration 036, on the
--      LIVE trust-dial Save button.
--   3. seed_trust_policies() stamped every seeded row with the
--      tenant's first-created DE's id — meaning "the trust dial" was
--      already silently tied to whichever DE happened to be created
--      first, for every tenant that ever seeded. Backfilled to NULL
--      (genuinely tenant-wide) since no UI ever offered a way to
--      choose that de_id deliberately — every existing value is an
--      artifact of the old seed default, not an intentional choice.
-- ============================================================

-- ── de_autonomy: add de_id, widen uniqueness ───────────────────────
alter table de_autonomy add column if not exists de_id uuid references digital_employees(id) on delete set null;

drop index if exists de_autonomy_tenant_action_category_uq;
create unique index if not exists de_autonomy_tenant_action_category_de_uq
  on de_autonomy (tenant_id, action_type, coalesce(source_category, ''), coalesce(de_id::text, ''));

-- ── trust_policies: backfill the first-DE artifact, widen uniqueness ─
update trust_policies set de_id = null where de_id is not null;

drop index if exists trust_policies_tenant_category_action_uq;
create unique index if not exists trust_policies_tenant_category_action_de_uq
  on trust_policies (tenant_id, action_category, coalesce(source_category, ''), coalesce(de_id::text, ''));

-- ============================================================
-- resolve_de_autonomy — the single shared cascade, called from SQL
-- triage functions AND (via RPC) from playbook-execute's TypeScript,
-- so the resolution logic is written once. Sequential tiers, same
-- style already established in decide_work_item_triage's category
-- fallback, just one dimension deeper:
--   1. exact de + category match
--   2. de match, tenant-wide category
--   3. category match, no de override      (existing behavior)
--   4. tenant/category-wide default         (existing behavior)
-- ============================================================
create or replace function resolve_de_autonomy(
  p_tenant_id       uuid,
  p_action_type     text,
  p_de_id           uuid default null,
  p_source_category text default null
) returns table(enabled boolean, max_amount_cents bigint, min_confidence integer)
language plpgsql
stable
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_row de_autonomy;
begin
  if p_de_id is not null and p_source_category is not null then
    select * into v_row from de_autonomy
    where tenant_id = p_tenant_id and action_type = p_action_type
      and de_id = p_de_id and source_category = p_source_category
    limit 1;
    if found then return query select v_row.enabled, v_row.max_amount_cents, v_row.min_confidence; return; end if;
  end if;

  if p_de_id is not null then
    select * into v_row from de_autonomy
    where tenant_id = p_tenant_id and action_type = p_action_type
      and de_id = p_de_id and source_category is null
    limit 1;
    if found then return query select v_row.enabled, v_row.max_amount_cents, v_row.min_confidence; return; end if;
  end if;

  if p_source_category is not null then
    select * into v_row from de_autonomy
    where tenant_id = p_tenant_id and action_type = p_action_type
      and de_id is null and source_category = p_source_category
    limit 1;
    if found then return query select v_row.enabled, v_row.max_amount_cents, v_row.min_confidence; return; end if;
  end if;

  select * into v_row from de_autonomy
  where tenant_id = p_tenant_id and action_type = p_action_type
    and de_id is null and source_category is null
  limit 1;
  if found then return query select v_row.enabled, v_row.max_amount_cents, v_row.min_confidence; return; end if;

  return query select false, null::bigint, null::integer;
end;
$function$;

-- service_role only: this function takes a raw p_tenant_id with no
-- caller-tenant check (by design, for edge-function callers that have
-- no auth.uid() of their own) — granting to `authenticated` would let
-- any signed-in user read ANY tenant's trust dial by passing an
-- arbitrary tenant id. Caught live via proacl inspection, same
-- default-schema-privilege trap as migration 105/107's fixes.
revoke all on function resolve_de_autonomy(uuid, text, uuid, text) from public;
revoke all on function resolve_de_autonomy(uuid, text, uuid, text) from anon;
revoke all on function resolve_de_autonomy(uuid, text, uuid, text) from authenticated;
grant execute on function resolve_de_autonomy(uuid, text, uuid, text) to service_role;

-- resolve_my_de_autonomy — the authenticated-safe wrapper: same
-- cascade, but resolves the caller's OWN tenant via auth.uid()
-- (matching compute_trust_evidence's pattern) instead of trusting a
-- raw parameter, so the frontend can resolve "what applies to this
-- employee" without needing service-role and without the cascade
-- logic being duplicated in TypeScript.
create or replace function resolve_my_de_autonomy(
  p_action_type text, p_de_id uuid default null, p_source_category text default null
) returns table(enabled boolean, max_amount_cents bigint, min_confidence integer)
language plpgsql
stable
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_tenant uuid;
  v_is_active boolean;
begin
  select tenant_id, coalesce(is_active, true) into v_tenant, v_is_active from profiles where user_id = auth.uid() limit 1;
  if v_tenant is null then
    raise exception 'not a member of any tenant';
  end if;
  if not v_is_active then
    raise exception 'account is deactivated';
  end if;
  return query select * from resolve_de_autonomy(v_tenant, p_action_type, p_de_id, p_source_category);
end;
$function$;

revoke all on function resolve_my_de_autonomy(text, uuid, text) from public;
revoke all on function resolve_my_de_autonomy(text, uuid, text) from anon;
grant execute on function resolve_my_de_autonomy(text, uuid, text) to authenticated, service_role;

-- ── trust_apply_level: add p_de_id, correct the on-conflict target
-- to the real (now 4-expression) index. Widened signature — drop the
-- old 5-arg overload explicitly (the create_onboarding_project lesson:
-- create-or-replace with an added param creates a NEW overload, it
-- does not replace the old one). ──────────────────────────────────
drop function if exists trust_apply_level(uuid, text, integer, uuid, text);

create or replace function trust_apply_level(
  p_tenant_id uuid, p_category text, p_level integer, p_actor uuid,
  p_source_category text default null, p_de_id uuid default null
) returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_s jsonb := trust_level_settings(p_category, p_level);
begin
  insert into de_autonomy (tenant_id, action_type, source_category, de_id, enabled, max_amount_cents, min_confidence, updated_by)
  values (
    p_tenant_id, p_category, p_source_category, p_de_id,
    (v_s->>'enabled')::boolean,
    nullif(v_s->>'max_amount_cents', '')::bigint,
    nullif(v_s->>'min_confidence', '')::integer,
    p_actor
  )
  on conflict (tenant_id, action_type, coalesce(source_category, ''), coalesce(de_id::text, '')) do update set
    enabled          = excluded.enabled,
    max_amount_cents = excluded.max_amount_cents,
    min_confidence   = excluded.min_confidence,
    updated_by       = excluded.updated_by,
    updated_at       = now();
end;
$$;
-- internal helper, service_role only. A fresh drop+create picks up
-- this project's default schema privileges (anon + authenticated +
-- service_role all get EXECUTE by default) — for this one that's a
-- real security regression, not just cleanliness: authenticated
-- execute would let any signed-in user call this directly and set
-- their own trust dial straight to max, completely bypassing the
-- evidence-gated request/apply_trust_promotion flow. Caught live via
-- proacl inspection immediately after applying.
revoke all on function trust_apply_level(uuid, text, integer, uuid, text, uuid) from public;
revoke all on function trust_apply_level(uuid, text, integer, uuid, text, uuid) from anon;
revoke all on function trust_apply_level(uuid, text, integer, uuid, text, uuid) from authenticated;
grant execute on function trust_apply_level(uuid, text, integer, uuid, text, uuid) to service_role;

-- ── seed_trust_policies: fix the stale on-conflict + stop tying the
-- seed to the first DE (that WAS the bug — see header). Seeds
-- genuinely tenant-wide defaults now; per-DE overrides are created
-- explicitly, same opt-in pattern as knowledge scoping / work_item_
-- framing / everything else in this codebase. ─────────────────────
create or replace function seed_trust_policies()
returns setof trust_policies
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_tenant uuid;
  v_is_active boolean;
begin
  select tenant_id, coalesce(is_active, true) into v_tenant, v_is_active from profiles where user_id = auth.uid() limit 1;
  if v_tenant is null then
    raise exception 'no tenant for the current session';
  end if;
  if not v_is_active then
    raise exception 'account is deactivated';
  end if;
  if v_tenant = 'a0000000-0000-0000-0000-000000000001'::uuid then
    raise exception 'demo tenant uses the demo story — earned trust is a live-tenant feature';
  end if;

  insert into trust_policies (tenant_id, de_id, action_category, criteria)
  values
    (v_tenant, null, 'invoice_auto_send', '{"window_days":30,"min_eval_pass_rate":0.9,"min_eval_samples":25,"min_human_approval_rate":0.9,"min_human_samples":5,"max_guardrail_blocks":0}'::jsonb),
    (v_tenant, null, 'answer_dock',       '{"window_days":30,"min_eval_pass_rate":0.9,"min_eval_samples":25,"min_human_approval_rate":0.9,"min_human_samples":0,"max_guardrail_blocks":0}'::jsonb),
    (v_tenant, null, 'answer_widget',     '{"window_days":30,"min_eval_pass_rate":0.95,"min_eval_samples":40,"min_human_approval_rate":0.9,"min_human_samples":0,"max_guardrail_blocks":0}'::jsonb)
  on conflict (tenant_id, action_category, coalesce(source_category, ''), coalesce(de_id::text, '')) do nothing;

  return query select * from trust_policies where tenant_id = v_tenant order by action_category;
end;
$$;

-- ── compute_trust_evidence: fix the latent LIMIT-1-with-no-ORDER-BY
-- ambiguity — once a de-specific row and a tenant-wide row can BOTH
-- match the same lookup, an explicit preference is required, not
-- whichever the planner happens to return first. ──────────────────
create or replace function compute_trust_evidence(p_de_id uuid, p_action_category text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'extensions'
as $function$
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

  select * into v_policy
  from trust_policies
  where tenant_id = v_tenant
    and action_category = p_action_category
    and (p_de_id is null or de_id is null or de_id = p_de_id)
  order by (de_id is not null and de_id = p_de_id) desc, (de_id is null) asc
  limit 1;
  if not found then
    raise exception 'no trust policy for category %', p_action_category;
  end if;

  return trust_evidence_for(v_policy);
end;
$function$;

-- ── decide_work_item_triage: add p_de_id, resolve via the shared
-- cascade instead of the flat category-only lookup. Widened
-- signature — drop the old 4-arg overload explicitly. ─────────────
drop function if exists decide_work_item_triage(uuid, text, text, integer);

create or replace function decide_work_item_triage(
  p_tenant_id uuid, p_category text, p_inquiry text, p_confidence integer, p_de_id uuid default null
) returns jsonb
language plpgsql
stable
security definer
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

  -- 1.5) Frustration check — same tier as decide_inquiry_triage.
  v_frustration := score_frustration_internal(p_tenant_id, p_inquiry);
  if v_frustration >= 50 then
    return jsonb_build_object(
      'decision', 'needs_review',
      'confidence', p_confidence,
      'guardrail_rule_id', null,
      'guardrail_rule', null,
      'trust_level', null,
      'frustration_score', v_frustration,
      'reasoning', format('Needs review: this %s item scored %s%% on frustration signals — routed to a human regardless of confidence (%s%%). A frustrated customer always gets a human.', p_category, v_frustration, p_confidence)
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

-- ── set_de_autonomy: the write side of the trust dial, callable by
-- workspace owners/admins directly (not just via trust_apply_level's
-- evidence-gated promotion). Routed through here rather than a direct
-- PostgREST upsert because the real unique index is expression-based
-- (coalesce(source_category,'')/coalesce(de_id::text,'')) — onConflict
-- only accepts bare column names, so no PostgREST call can target it.
-- Verified live: a raw client-side upsert against this table cannot
-- express the correct conflict target at all. ─────────────────────
create or replace function set_de_autonomy(
  p_action_type text, p_enabled boolean, p_max_amount_cents bigint default null,
  p_min_confidence integer default null, p_de_id uuid default null, p_source_category text default null
) returns de_autonomy
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_tenant uuid;
  v_role   text;
  v_is_active boolean;
  v_user   uuid := auth.uid();
  v_row    de_autonomy;
begin
  select tenant_id, role, coalesce(is_active, true) into v_tenant, v_role, v_is_active from profiles where user_id = v_user;
  if v_tenant is null then
    raise exception 'not a member of any tenant';
  end if;
  if not v_is_active then
    raise exception 'account is deactivated';
  end if;
  if v_role not in ('tenant_owner', 'tenant_admin') then
    raise exception 'only workspace owners/admins can change the trust dial';
  end if;
  if p_de_id is not null and not exists (select 1 from digital_employees where id = p_de_id and tenant_id = v_tenant) then
    raise exception 'employee not found in this workspace';
  end if;

  insert into de_autonomy (tenant_id, action_type, source_category, de_id, enabled, max_amount_cents, min_confidence, updated_by)
  values (v_tenant, p_action_type, p_source_category, p_de_id, p_enabled, p_max_amount_cents, p_min_confidence, v_user)
  on conflict (tenant_id, action_type, coalesce(source_category, ''), coalesce(de_id::text, '')) do update set
    enabled          = excluded.enabled,
    max_amount_cents = excluded.max_amount_cents,
    min_confidence   = excluded.min_confidence,
    updated_by       = excluded.updated_by,
    updated_at       = now()
  returning * into v_row;

  return v_row;
end;
$function$;

revoke all on function set_de_autonomy(text, boolean, bigint, integer, uuid, text) from public;
revoke all on function set_de_autonomy(text, boolean, bigint, integer, uuid, text) from anon;
grant execute on function set_de_autonomy(text, boolean, bigint, integer, uuid, text) to authenticated, service_role;

-- ── decide_inquiry_triage: add p_de_id (same lockstep discipline as
-- the frustration-tier addition earlier this session — both siblings
-- get identical treatment). No category dimension here, matches its
-- existing (non-category-aware) scope. Widened signature — drop the
-- old 3-arg overload explicitly. ───────────────────────────────────
drop function if exists decide_inquiry_triage(uuid, text, integer);

create or replace function decide_inquiry_triage(
  p_tenant_id uuid, p_inquiry text, p_confidence integer, p_de_id uuid default null
) returns jsonb
language plpgsql
stable
security definer
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

  -- 1.5) Frustration check.
  v_frustration := score_frustration_internal(p_tenant_id, p_inquiry);
  if v_frustration >= 50 then
    return jsonb_build_object(
      'decision', 'needs_review',
      'confidence', p_confidence,
      'guardrail_rule_id', null,
      'guardrail_rule', null,
      'trust_level', null,
      'frustration_score', v_frustration,
      'reasoning', format('Needs review: this inquiry scored %s%% on frustration signals — routed to a human regardless of confidence (%s%%). A frustrated customer always gets a human.', v_frustration, p_confidence)
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
