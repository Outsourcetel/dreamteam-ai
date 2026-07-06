-- ============================================================
-- Migration 036: THE GENERALIZED TRIGGER LAYER
--
-- Founder's core correction, part 2 of 2 (see memory/
-- feedback_de_genericity_test.md): "we are not replicating any other
-- support bot but a human who will not just understand the request
-- and get information from the available systems... but also will
-- act where required... build scalable DEs, playbooks, guardrails,
-- specialists."
--
-- THE GAP THIS CLOSES: retrieval was generalized (category_contracts,
-- migration 027 — any of the 9 categories). Acting was generalized
-- (action_definitions, migration 035 — any category/provider/tenant).
-- The TRIGGER was not: poll_support_inbox (migration 034) only polled
-- category='helpdesk' connectors and framed every new item as
-- "{title} — {snippet}" fed straight into a support-inquiry pipeline.
-- If Account or Finance came next, the tempting shortcut would be
-- writing poll_account_signals/poll_finance_documents as separate
-- bespoke pollers — exactly the per-department-bot pattern the
-- founder rejected. This migration removes that temptation by making
-- the trigger itself a domain-agnostic primitive.
--
-- WHAT THIS DOES:
--   1. de_autonomy / trust_policies gain a nullable source_category
--      column. This is the load-bearing genericity fix: instead of
--      adding a NEW named action_type/action_category row every time
--      a domain needs its own trust dial (the pattern migration 035
--      already used once for 'action_execute', and 034 avoided only
--      by reusing an existing category), trust for 'action_execute'
--      (and, going forward, any category-scoped decision) can now be
--      earned/dialed PER SOURCE CATEGORY without ever widening the
--      action_type/action_category CHECK enum again. NULL
--      source_category = tenant-wide (the pre-existing, unchanged
--      behavior) so every row from 025/034/035 keeps working exactly
--      as before — this is purely additive.
--   2. work_item_framing — a small, tenant-overridable table: how a
--      raw canonical item (title/snippet) becomes the plain-language
--      description fed into the evidence pipeline, per category.
--      Configuration, not hardcoded strings in application code.
--   3. poll_de_work_sources_targets — the category-agnostic successor
--      to poll_support_inbox_targets (034): identical join logic,
--      MINUS the "where c.category = 'helpdesk'" filter, PLUS the
--      connector's category returned as an output column so the
--      caller knows what kind of work it found. poll_support_inbox_
--      targets is left in place (deprecated, unused) rather than
--      dropped — no live code references it after this migration, but
--      dropping a function is a one-way door and costs nothing to
--      avoid.
--   4. decide_work_item_triage — the category-parameterized successor
--      to decide_inquiry_triage: identical guardrail-then-trust
--      composition, but resolves the trust dial by
--      (action_type='answer_widget', source_category=category) with
--      a fallback to the legacy tenant-wide row (source_category is
--      null) so existing tenant configuration (Acme's answer_widget
--      dial, set up before this migration existed) keeps working
--      unchanged. decide_inquiry_triage itself is UNTOUCHED — the
--      manual/simulation paths keep calling it exactly as before.
--   5. evidence_run_decisions.decision widens (additively) to admit
--      'would_act' and 'acted' alongside the original four — the
--      generalized poller can now honestly distinguish "this DE would
--      just answer" from "this DE actually did something", not just
--      whether it would send a reply.
--   6. resolve_action_definition_for_category — given a category (and
--      optionally a connector), find the best-fit registered,
--      non-disabled action_definition to consider acting with. Pure
--      lookup helper; the actual decide-and-call sequencing lives in
--      the edge function (SQL cannot make outbound HTTP calls).
--
-- WHAT THIS DOES NOT DO (honest limits, stated up front):
--   - This does NOT stand up a real Account or Finance DE persona.
--     It proves the TRIGGER MECHANISM generalizes — any category, any
--     connector, zero new bespoke code. Standing up a full department
--     (gap-analysis items 14/19) is a separate, smaller-than-before
--     follow-up: a persona row + charter + source/connector assignment
--     + playbook assignment + guardrail policy on top of everything
--     this migration and migration 035 already built generically.
--   - decide_inquiry_triage (034) is NOT deleted or replaced — it is
--     left exactly as it was; decide_work_item_triage is its
--     category-aware sibling, used only by the new poller.
-- ============================================================

-- ============================================================
-- 1a. de_autonomy: nullable source_category — additive, backward
-- compatible. NULL keeps meaning "tenant-wide" (every existing row's
-- exact current behavior); a non-null value scopes the SAME
-- action_type dial to one of the 9 category-contract categories.
-- ============================================================
alter table de_autonomy add column if not exists source_category text
  check (source_category is null or source_category in (
    'crm', 'helpdesk', 'knowledge_base', 'erp_financials', 'billing',
    'payroll_hcm', 'pos', 'product_system', 'other'));

alter table de_autonomy drop constraint if exists de_autonomy_tenant_id_action_type_key;
create unique index if not exists de_autonomy_tenant_action_category_uq
  on de_autonomy (tenant_id, action_type, coalesce(source_category, ''));

-- ============================================================
-- 1b. trust_policies: the same additive column + uniqueness widen,
-- so a trust POLICY (the earned-progression ladder, not just the
-- dial) can also be scoped per category — request_trust_promotion /
-- apply_trust_promotion / trust_demote all key off trust_policies.id,
-- not the (tenant, action_category) pair directly, so none of that
-- machinery needs to change; only the uniqueness and an optional
-- category tag are added.
-- ============================================================
alter table trust_policies add column if not exists source_category text
  check (source_category is null or source_category in (
    'crm', 'helpdesk', 'knowledge_base', 'erp_financials', 'billing',
    'payroll_hcm', 'pos', 'product_system', 'other'));

alter table trust_policies drop constraint if exists trust_policies_tenant_id_action_category_key;
create unique index if not exists trust_policies_tenant_category_action_uq
  on trust_policies (tenant_id, action_category, coalesce(source_category, ''));

-- ============================================================
-- 2. TABLE: work_item_framing — per-category (platform default,
-- tenant-overridable) plain-language template for turning a raw
-- canonical item (title/snippet) into the description fed into the
-- evidence pipeline. {title} and {snippet} are the only placeholders
-- (the canonical item shape every category already produces via
-- categoryContracts.ts) — deliberately simple, no template engine
-- needed for two variables.
-- ============================================================
create table if not exists work_item_framing (
  id          uuid primary key default gen_random_uuid(),
  scope       text not null check (scope in ('platform', 'tenant')),
  tenant_id   uuid references tenants(id) on delete cascade,
  category    text not null check (category in (
                'crm', 'helpdesk', 'knowledge_base', 'erp_financials', 'billing',
                'payroll_hcm', 'pos', 'product_system', 'other')),
  template    text not null,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint work_item_framing_scope_shape check (
    (scope = 'platform' and tenant_id is null) or
    (scope = 'tenant' and tenant_id is not null)
  )
);

-- NOTE: a plain `unique (scope, tenant_id, category)` table constraint
-- does NOT dedupe platform rows (tenant_id is null for all of them,
-- and standard SQL unique constraints treat every NULL as distinct
-- from every other NULL) — this migration hit that exact bug during
-- its own verification (a re-applied seed silently inserted duplicate
-- platform rows per category, which then broke
-- resolve_work_item_framing's coalesce(subquery) with "more than one
-- row returned"). Fixed with a coalesce-based expression index, the
-- same null-safe pattern data_access_grants already uses.
create unique index if not exists work_item_framing_scope_tenant_category_uq
  on work_item_framing (scope, coalesce(tenant_id::text, ''), category);

create index if not exists work_item_framing_category_idx on work_item_framing(category);
create index if not exists work_item_framing_tenant_idx on work_item_framing(tenant_id) where tenant_id is not null;

alter table work_item_framing enable row level security;
drop policy if exists "work_item_framing_read" on work_item_framing;
create policy "work_item_framing_read" on work_item_framing
  for select
  using (
    scope = 'platform'
    or tenant_id in (select tenant_id from profiles where user_id = auth.uid())
  );
-- writes only via the SECURITY DEFINER RPC below

drop trigger if exists work_item_framing_updated_at on work_item_framing;
create trigger work_item_framing_updated_at
  before update on work_item_framing
  for each row execute function update_updated_at();

-- RPC: set_work_item_framing — tenant admin/owner (or service role)
-- upserts ONE tenant-scope override for a category. Platform defaults
-- (seeded below) are never edited through this path.
create or replace function set_work_item_framing(
  p_category text,
  p_template text
) returns work_item_framing
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid;
  v_role   text;
  v_row    work_item_framing;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    select tenant_id, role into v_tenant, v_role from profiles where user_id = auth.uid();
    if v_tenant is null then
      raise exception 'not a member of any tenant';
    end if;
    if v_role not in ('tenant_owner', 'tenant_admin') then
      raise exception 'only workspace owners/admins can customize work-item framing';
    end if;
  else
    raise exception 'service-role callers must pass a tenant via the platform-seed path, not this RPC';
  end if;

  if trim(coalesce(p_template, '')) = '' then
    raise exception 'template must not be empty';
  end if;
  if position('{title}' in p_template) = 0 then
    raise exception 'template must include a {title} placeholder';
  end if;

  insert into work_item_framing (scope, tenant_id, category, template, created_by)
  values ('tenant', v_tenant, p_category, p_template, auth.uid())
  on conflict (scope, coalesce(tenant_id::text, ''), category) do update set
    template = excluded.template, updated_at = now()
  returning * into v_row;

  perform append_audit_event(
    v_tenant, coalesce((select full_name from profiles where user_id = auth.uid()), 'you'), 'human',
    format('Work-item framing customized for %s: "%s"', p_category, left(p_template, 140)),
    'config_change',
    jsonb_build_object('kind', 'work_item_framing_changed', 'category', p_category, 'template', p_template)
  );

  return v_row;
end;
$$;
revoke all on function set_work_item_framing(text, text) from public;
grant execute on function set_work_item_framing(text, text) to authenticated;

-- RPC: resolve_work_item_framing — tenant override wins, else the
-- platform default, else a generic fallback so a poll never fails
-- to render SOME description even for an unseeded category.
create or replace function resolve_work_item_framing(p_tenant_id uuid, p_category text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select template from work_item_framing where scope = 'tenant' and tenant_id = p_tenant_id and category = p_category),
    (select template from work_item_framing where scope = 'platform' and category = p_category),
    'New {category} item needs review: {title} — {snippet}'
  );
$$;
revoke all on function resolve_work_item_framing(uuid, text) from public;
grant execute on function resolve_work_item_framing(uuid, text) to authenticated, service_role;

-- Seed platform-default framings — one per category, per the
-- founder's brief. Plain language, no jargon.
insert into work_item_framing (scope, tenant_id, category, template) values
  ('platform', null, 'helpdesk',       'New support ticket: {title} — {snippet}'),
  ('platform', null, 'crm',            'New CRM record needs review: {title} — {snippet}'),
  ('platform', null, 'erp_financials', 'New financial record needs attention: {title} — {snippet}'),
  ('platform', null, 'billing',        'New financial record needs attention: {title} — {snippet}'),
  ('platform', null, 'payroll_hcm',    'New HR/payroll item: {title} — {snippet}'),
  ('platform', null, 'pos',            'New order/record: {title} — {snippet}'),
  ('platform', null, 'product_system', 'New product-system record: {title} — {snippet}'),
  ('platform', null, 'knowledge_base', 'New knowledge-base item to review: {title} — {snippet}'),
  ('platform', null, 'other',          'New item needs review: {title} — {snippet}')
on conflict (scope, coalesce(tenant_id::text, ''), category) do nothing;

-- ============================================================
-- 3. poll_de_work_sources_targets — the category-agnostic successor
-- to poll_support_inbox_targets (034). IDENTICAL join/resolution
-- logic (data_access_grants, migration 029, resolved exactly the same
-- way — connector-specific grant OR category grant, >= 'search'),
-- MINUS the "where c.category = 'helpdesk'" filter that was the
-- entire hardcode, PLUS c.category returned so the edge function
-- knows what kind of work each target represents. Still resolves the
-- WORK LIST only (SQL cannot call the network) — the edge function
-- does list_recent / framing / evidence / decide / act, mirroring
-- dispatch_due_triggers' split exactly, same as 034.
-- ============================================================
create or replace function poll_de_work_sources_targets(p_tenant_id uuid default null)
returns table (
  tenant_id uuid, connector_id uuid, connector_provider text, connector_display_name text,
  category text,
  subject_kind text, subject_id uuid, subject_name text,
  last_seen_external_ref text, last_seen_timestamp timestamptz
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  -- One row per (connector, subject) where the subject has >= 'search'
  -- access — either a direct connector grant or a category-level grant
  -- matching THAT connector's own category. ANY of the 9 categories,
  -- not just helpdesk. A tenant with no such grant on a category
  -- simply yields no rows for it — an honest no-op (skipped_no_access
  -- is reserved for a grant that existed and was then revoked
  -- mid-flight, exactly as in 034).
  select
    c.tenant_id, c.id as connector_id, c.provider, c.display_name,
    c.category,
    g.subject_kind, g.subject_id,
    coalesce(sp.name, de.name, 'DE') as subject_name,
    w.last_seen_external_ref, w.last_seen_timestamp
  from connectors c
  join data_access_grants g
    on g.tenant_id = c.tenant_id
   and ((g.resource_kind = 'connector' and g.resource_id = c.id)
        or (g.resource_kind = 'category' and g.resource_category = c.category))
   and access_permission_level(g.permission) >= access_permission_level('search')
  left join specialist_profiles sp on sp.id = g.subject_id and g.subject_kind = 'specialist'
  left join digital_employees de on de.id = g.subject_id and g.subject_kind = 'de'
  left join inbox_watch_state w on w.tenant_id = c.tenant_id and w.connector_id = c.id
  where c.status <> 'disconnected'
    and (p_tenant_id is null or c.tenant_id = p_tenant_id);
$$;

revoke all on function poll_de_work_sources_targets(uuid) from public;
grant execute on function poll_de_work_sources_targets(uuid) to service_role;

-- ============================================================
-- 4. evidence_run_decisions.decision — additive widen: 'would_act'
-- (the item qualifies for action but composition says a human must
-- approve first — the act-side sibling of 'needs_review') and 'acted'
-- (the DE actually invoked execute_action and it auto-executed or
-- executed-after-approval). The original four values are UNCHANGED
-- and remain exactly what 034 produces on the helpdesk/answer path.
-- ============================================================
alter table evidence_run_decisions drop constraint if exists evidence_run_decisions_decision_check;
alter table evidence_run_decisions add constraint evidence_run_decisions_decision_check
  check (decision in (
    'would_auto_send', 'needs_review', 'blocked_guardrail', 'skipped_no_access',
    'would_act', 'acted'
  ));

-- action_execution_id: when a decision resulted in (or awaits) a real
-- action_executions row, link it so the UI can show the receipt next
-- to the decision instead of just the intent.
alter table evidence_run_decisions add column if not exists action_execution_id uuid
  references action_executions(id) on delete set null;
alter table evidence_run_decisions add column if not exists source_category text
  check (source_category is null or source_category in (
    'crm', 'helpdesk', 'knowledge_base', 'erp_financials', 'billing',
    'payroll_hcm', 'pos', 'product_system', 'other'));

create index if not exists evidence_run_decisions_category_idx on evidence_run_decisions(source_category);

-- ============================================================
-- 5. decide_work_item_triage — category-parameterized sibling of
-- decide_inquiry_triage (034), UNCHANGED/untouched. Same guardrail-
-- always-wins -> trust-narrows-within-it composition, transplanted to
-- resolve the answer_widget trust dial PER CATEGORY (falling back to
-- the legacy tenant-wide row when no category-specific row exists —
-- so Acme's existing answer_widget configuration, set up before this
-- migration, keeps working unchanged for the helpdesk path).
-- ============================================================
create or replace function decide_work_item_triage(p_tenant_id uuid, p_category text, p_inquiry text, p_confidence integer)
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
          'reasoning', format('Blocked: guardrail rule "%s" matched this %s item — routed to a human regardless of confidence (%s%%). Guardrails always win over the trust dial.', v_rule.rule, p_category, p_confidence)
        );
      end if;
    end loop;
  end loop;

  -- 2) Trust dial (de_autonomy, action_type='answer_widget') —
  --    category-specific row first, else the legacy tenant-wide row
  --    (source_category is null). This is the SAME table/mechanism
  --    used since migration 025; only the resolution now considers
  --    source_category before falling back.
  select enabled, min_confidence into v_autonomy
  from de_autonomy
  where tenant_id = p_tenant_id and action_type = 'answer_widget'
    and source_category = p_category
  limit 1;
  if not found then
    select enabled, min_confidence into v_autonomy
    from de_autonomy
    where tenant_id = p_tenant_id and action_type = 'answer_widget'
      and source_category is null
    limit 1;
  end if;
  v_enabled := coalesce(v_autonomy.enabled, false);
  v_min_conf := v_autonomy.min_confidence;

  if v_enabled and v_min_conf is not null and p_confidence >= v_min_conf then
    return jsonb_build_object(
      'decision', 'would_auto_send',
      'confidence', p_confidence,
      'guardrail_rule_id', null,
      'guardrail_rule', null,
      'trust_level', v_min_conf,
      'reasoning', format('Would auto-send: confidence %s%% clears the trust-dial floor of %s%% for auto-answering on %s, and no guardrail blocked it. Recorded as intent only unless a registered action can act on this item.', p_confidence, v_min_conf, p_category)
    );
  end if;

  return jsonb_build_object(
    'decision', 'needs_review',
    'confidence', p_confidence,
    'guardrail_rule_id', null,
    'guardrail_rule', null,
    'trust_level', v_min_conf,
    'reasoning', case
      when not v_enabled then format('Needs review: confidence %s%%, but auto-answering on %s is not yet enabled on the trust dial (Governance -> Trust & Architecture).', p_confidence, p_category)
      else format('Needs review: confidence %s%% is below the trust-dial floor of %s%% required to auto-answer on %s.', p_confidence, coalesce(v_min_conf, 0), p_category)
    end
  );
end;
$$;

revoke all on function decide_work_item_triage(uuid, text, text, integer) from public;
grant execute on function decide_work_item_triage(uuid, text, text, integer) to service_role;

-- ============================================================
-- 6. resolve_action_definition_for_category — pure lookup: given a
-- category (and the specific connector, since a tenant-scope override
-- could differ per connector's own tenant), find the best-fit ACTIVE,
-- NON-DESTRUCTIVE-preferred action_definition to consider for
-- proactive acting. Destructive actions are still eligible to be
-- "considered" here — decide_action_execution's destructive-always-
-- gates rule (migration 035) is what actually stops them from
-- auto-executing; this function only narrows WHICH action_key the
-- poller should try. Prefers a tenant-scope row over platform-scope,
-- and (deliberately, honestly) picks the single oldest active
-- non-destructive action for the category when more than one
-- exists — a poller has no basis to choose among several candidate
-- actions without a playbook telling it which one, so v1 keeps this
-- simple and says so.
-- ============================================================
-- NOTE: returns SETOF (0 or 1 rows), not a bare composite. A bare
-- composite-returning `language sql` function called as `select *
-- from fn(...)` returns ONE ROW OF NULLS when nothing matches (a
-- well-known Postgres gotcha for scalar/composite OUT), which the
-- caller could easily mistake for "an action was found with a null
-- action_key" — SETOF returns zero rows instead, honestly.
create or replace function resolve_action_definition_for_category(p_tenant_id uuid, p_category text)
returns setof action_definitions
language sql
stable
security definer
set search_path = public
as $$
  select *
  from action_definitions
  where category = p_category
    and status = 'active'
    and (scope = 'platform' or tenant_id = p_tenant_id)
  order by
    (scope = 'tenant') desc,          -- tenant override wins
    (risk->>'destructive')::boolean asc nulls last,  -- prefer non-destructive candidates
    created_at asc
  limit 1;
$$;
revoke all on function resolve_action_definition_for_category(uuid, text) from public;
grant execute on function resolve_action_definition_for_category(uuid, text) to service_role;

-- ============================================================
-- audit_events: no new category needed — 'inquiry_triage' and
-- 'action_execution' (034/035) already cover the decide and act
-- halves of what this migration's poller does.
-- ============================================================

-- ============================================================
-- CRON PIGGYBACK — REPLACE, not add. invoke_playbook_dispatch()
-- (migration 020, extended by 034) now calls specialist-consult's
-- NEW 'poll_de_work_sources' action instead of the old
-- 'poll_support_inbox' action. No new pg_cron job; same job, same
-- schedule, same Vault-held dispatch secret. This is the "deprecate
-- cleanly, don't leave two competing pollers" step: after this
-- migration applies, the cron tick fires playbook-dispatch +
-- poll_de_work_sources — poll_support_inbox is no longer invoked by
-- anything, live or scheduled (the edge function keeps the OLD action
-- string routed to a thin honest-shim for any in-flight caller, see
-- code comment in specialist-consult).
-- ============================================================
create or replace function invoke_playbook_dispatch()
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_secret text;
  v_req_id bigint;
  v_req_id2 bigint;
begin
  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'playbook_dispatch_secret'
  limit 1;
  if v_secret is null then
    return 'no_secret';
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

  -- Piggyback: the GENERALIZED proactive trigger, any category, on
  -- the SAME 5-minute tick. Independent request; a failure here never
  -- blocks or is blocked by the playbook dispatch above.
  select net.http_post(
    url     := 'https://rfsvmhcqeiyrxivbmpel.supabase.co/functions/v1/specialist-consult',
    body    := '{"action":"poll_de_work_sources"}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-dispatch-secret', v_secret
    ),
    timeout_milliseconds := 30000
  ) into v_req_id2;

  return 'queued:' || v_req_id::text || ',' || v_req_id2::text;
end;
$$;

revoke all on function invoke_playbook_dispatch() from public;

select cron.schedule(
  'playbook-dispatch-5min',
  '*/5 * * * *',
  $$select invoke_playbook_dispatch()$$
);
