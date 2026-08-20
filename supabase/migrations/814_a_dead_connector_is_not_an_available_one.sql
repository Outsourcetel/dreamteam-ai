-- 814_a_dead_connector_is_not_an_available_one.sql
-- ==========================================================================
-- The last four readers of the marker that lies.
--
-- Mig 774 found that `connectors.status` is never written on failure and
-- still reads "connected" through thousands of errors. It built
-- connector_circuit_open and wired it into two dispatchers. Migs 810 and 812
-- wired the two remaining callers that ACT through a connector: the third
-- dispatcher, and the dunning selector that routes "Send a final notice".
--
-- These four do not act. They answer AVAILABILITY:
--
--   de_trust_surface_candidates     is this capability dialable at all?
--   get_agentic_tools_for_de        which tools may this employee use?
--   compute_de_lifecycle_readiness  is this employee grounded in its systems?
--   onboarding_verb_verdict         can this verb run here?
--
-- All four answered YES, today, for an integration dead since 2026-08-11
-- with 8,764 consecutive http_402 failures. So an employee reads as grounded
-- and equipped while the only system it works through is unreachable — which
-- is how a workspace ends up with an employee that looks ready and cannot
-- act, escalating once a day about a source it cannot read.
--
-- ── WHY THIS IS SAFE TO GATE, AND NOT TWITCHY ─────────────────────────────
-- The breaker opens at >= 10 consecutive failures AND a last error inside
-- the past hour, and it CLOSES BY ITSELF after an hour of quiet. So a
-- transient wobble never flips an employee to not-ready, and a connector
-- someone fixes restores readiness within the hour without anyone touching
-- a status column. Checked before applying it to four eligibility readers,
-- because a hair-trigger here would churn lifecycle state rather than
-- report it.
--
-- ⚠ THIS CHANGES WHAT PEOPLE SEE. Capabilities whose only connector is dead
-- will stop appearing dialable; an employee grounded solely in a dead system
-- will read as not-grounded. That is the point — it was reporting the
-- opposite of the truth — but it is a visible change, not a silent one.
--
-- Same one-line shape as 810 and 812. One breaker, asked by everyone who
-- needs it, rather than four predicates to drift apart. The alias in each
-- function differs (c. / k. / none) and is taken from the matched text
-- rather than assumed.
-- ==========================================================================

begin;
-- ── de_trust_surface_candidates ───────────────────────────────────

CREATE OR REPLACE FUNCTION public.de_trust_surface_candidates(p_tenant_id uuid, p_de_id uuid)
 RETURNS TABLE(capability_key text, kind text, label text, category text, dialable boolean, destructive boolean, uses_confidence boolean, uses_amount boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
WITH me AS (
  SELECT d.id FROM digital_employees d
   WHERE d.id = p_de_id AND d.tenant_id = p_tenant_id
),
-- widget-ask's own eligibility filter, mirrored exactly.
eligible AS (
  SELECT d.id, d.external_reply_mode, d.created_at
    FROM digital_employees d
   WHERE d.tenant_id = p_tenant_id
     AND coalesce(d.lifecycle_status, '') NOT IN ('paused', 'retired', 'archived', 'designed')
),
front AS (  -- the front-DE heuristic: oldest auto-reply DE, else oldest eligible
  SELECT e.id FROM eligible e
   ORDER BY (CASE WHEN e.external_reply_mode = 'auto' THEN 0 ELSE 1 END), e.created_at ASC
   LIMIT 1
),
serves_widget AS (
  SELECT (
    EXISTS (SELECT 1 FROM eligible e WHERE e.id = p_de_id)
    AND (
      EXISTS (SELECT 1 FROM widget_keys wk           -- mig 323: explicit binding wins
               WHERE wk.tenant_id = p_tenant_id AND wk.active AND wk.de_id = p_de_id)
      OR (
        EXISTS (SELECT 1 FROM widget_keys wk         -- a key that falls back to the heuristic
                 WHERE wk.tenant_id = p_tenant_id AND wk.active
                   AND (wk.de_id IS NULL
                        OR NOT EXISTS (SELECT 1 FROM eligible e2 WHERE e2.id = wk.de_id)))
        AND (SELECT f.id FROM front f) = p_de_id
      )
    )
  ) AS yes
),
-- Reachable registered actions: connector-hub's resolveActionDefinition,
-- mirrored (see header for why provider match is not additionally required).
reachable AS (
  SELECT ad.category   AS category,
         ad.action_key AS action_key,
         min(ad.label) AS label,
         bool_or(coalesce((ad.risk ->> 'destructive')::boolean, true)) AS destructive
    FROM action_definitions ad
   WHERE ad.status = 'active'
     AND ad.provider <> 'internal'
     AND (ad.scope = 'platform' OR (ad.scope = 'tenant' AND ad.tenant_id = p_tenant_id))
     AND EXISTS (SELECT 1 FROM connectors c
                  WHERE c.tenant_id = p_tenant_id
                    AND c.status = 'connected'
      -- ⛔ AND ALIVE (mig 814). `status` is not written on failure.
      and not public.connector_circuit_open(c.consecutive_failures, c.last_error_at)
                    AND c.category = ad.category)
   GROUP BY ad.category, ad.action_key
),
runs_invoice_playbook AS (
  SELECT EXISTS (
    SELECT 1 FROM playbook_definitions pd
     WHERE pd.tenant_id = p_tenant_id
       AND pd.de_id = p_de_id
       AND pd.status = 'published'
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(pd.steps) s
                    WHERE s ->> 'key' = 'generate_invoice')
  ) AS yes
)
SELECT 'answer_dock', 'answer', 'Answers in the dock (internal chat)',
       NULL::text, true, false, true, false
 WHERE EXISTS (SELECT 1 FROM me)
UNION ALL
SELECT 'answer_widget', 'answer', 'Answers customers on the public widget & help centre',
       NULL::text, true, false, true, false
 WHERE (SELECT yes FROM serves_widget)
UNION ALL
SELECT 'invoice_auto_send', 'playbook', 'Auto-sends renewal invoices (renewal playbook)',
       NULL::text, true, false, false, true
 WHERE EXISTS (SELECT 1 FROM me) AND (SELECT yes FROM runs_invoice_playbook)
UNION ALL
-- A category is dial-able only while it holds at least one non-destructive
-- action: destructive actions gate above the dial unconditionally, so a dial
-- over an all-destructive category could never do anything — showing it
-- dial-able would oversell. The moment a non-destructive action is registered
-- in the category, this recomputes and the dial appears (measured live:
-- the self-management category is all-destructive by design).
SELECT 'action:' || rc.category, 'action_category',
       initcap(replace(rc.category, '_', ' ')) || ' actions',
       rc.category, rc.has_dialable, false, false, true
  FROM (SELECT r.category, bool_or(NOT r.destructive) AS has_dialable
          FROM reachable r GROUP BY r.category) rc
 WHERE EXISTS (SELECT 1 FROM me)
UNION ALL
SELECT r.action_key, 'action', r.label, r.category,
       NOT r.destructive, r.destructive, false, true
  FROM reachable r
 WHERE EXISTS (SELECT 1 FROM me)
UNION ALL
-- RECORD WRITE-BACKS (mig 496). These are the ops an employee uses to keep its
-- own records current — log an activity, set a next step — and they are NOT
-- registered actions: they are their own RPC family, so the reachable CTE above
-- can never produce a card for them. Before this branch the dial that actually
-- governs them (action_execute + source_category) was invisible on every screen
-- in the product and could not be switched off from anywhere.
--
-- Emitted only for an employee that actually works records: it holds a case
-- whose entity kind has a write-back family, or a system it may write to.
-- dialable = true because the non-destructive ops (log_activity, set_next_step)
-- genuinely reach the dial; the destructive ones (advance_stage, update_status,
-- update_stage) return at the destructive floor above it regardless.
SELECT 'writeback:' || wb.category, 'writeback',
       CASE wb.category WHEN 'crm' THEN 'Keeps its own records current (notes & next steps)'
                        ELSE 'Keeps billing records current (notes & next steps)' END,
       wb.category, true, false, false, false
  FROM (
    SELECT DISTINCT CASE WHEN s.write_registry = 'invoice' THEN 'billing' ELSE 'crm' END AS category
      FROM de_connected_systems s
     WHERE s.de_id = p_de_id AND coalesce(s.can_write, false)
    UNION
    SELECT 'crm' WHERE EXISTS (
      SELECT 1 FROM de_objectives o
       WHERE o.de_id = p_de_id AND o.tenant_id = p_tenant_id
         AND o.entity_kind IN ('customer_account', 'opportunity', 'commercial_agreement'))
  ) wb
 WHERE EXISTS (SELECT 1 FROM me);
$function$
;

-- ── get_agentic_tools_for_de ──────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_agentic_tools_for_de(p_tenant_id uuid, p_de_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tools jsonb := '[]'::jsonb;
  v_conn record;
  v_def record;
  v_verdict jsonb;
  v_properties jsonb;
  v_required jsonb;
  v_param record;
  v_type text;
  v_name text;     -- sanitized, connector-unique tool name
  v_suffix text;   -- per-connector discriminator
begin
  for v_conn in
    select id, category, display_name, provider
    from connectors
    where tenant_id = p_tenant_id and status = 'connected'
      -- ⛔ AND ALIVE (mig 814). `status` is not written on failure.
      and not public.connector_circuit_open(consecutive_failures, last_error_at)
  loop
    for v_def in
      select *
      from action_definitions
      where status = 'active'
        and provider <> 'internal'
        and category = v_conn.category
        -- Matching on category ALONE offered an ERPNext-connected employee
        -- the Stripe/QuickBooks/Xero tools in the same category. Those could
        -- only ever fail: there is no such connector to run them against.
        and (provider is null or provider = v_conn.provider or provider = 'template')
        and (scope = 'platform' or (scope = 'tenant' and tenant_id = p_tenant_id))
    loop
      select resolve_access(p_tenant_id, 'de', p_de_id, v_conn.id, 'write_back') into v_verdict;
      -- mig 643: connector access says WHERE this employee may write; the role
      -- requirement says WHAT it may do there. Both must hold. Without the
      -- second, connecting the DreamTeam self-connector handed every employee
      -- in the workspace the verbs that create and hire other employees.
      if coalesce((v_verdict->>'allowed')::boolean, false)
         and public.de_may_use_action(p_tenant_id, p_de_id, v_def.id) then
        v_properties := '{}'::jsonb;
        v_required := '[]'::jsonb;

        for v_param in
          select * from jsonb_to_recordset(v_def.param_schema)
            as x(name text, type text, required boolean, help text)
        loop
          v_type := case v_param.type when 'number' then 'number' when 'boolean' then 'boolean' else 'string' end;
          v_properties := v_properties || jsonb_build_object(
            v_param.name, jsonb_build_object('type', v_type, 'description', coalesce(v_param.help, ''))
          );
          if coalesce(v_param.required, false) then
            v_required := v_required || to_jsonb(v_param.name);
          end if;
        end loop;

        -- Connector-unique + charset-safe + length-bounded (Anthropic: ^[a-zA-Z0-9_-]{1,64}$).
        v_suffix := '__' || left(replace(v_conn.id::text, '-', ''), 6) || left(md5(v_def.id::text), 4);
        -- Per-DEFINITION, not just per-connector. One action_key can have
        -- several executors (ERPNext comment vs ERPNext email), and the
        -- model rejects the ENTIRE call if any two tools share a name.
        v_name := regexp_replace(v_conn.category || '__' || v_def.action_key, '[^a-zA-Z0-9_-]', '_', 'g');
        v_name := left(v_name, 64 - length(v_suffix)) || v_suffix;

        v_tools := v_tools || jsonb_build_array(jsonb_build_object(
          'name', v_name,
          'description', v_def.label || '. ' || v_def.description
                         || ' (system: ' || coalesce(nullif(v_conn.display_name, ''), v_conn.provider) || ')',
          'input_schema', jsonb_build_object(
            'type', 'object', 'properties', v_properties, 'required', v_required
          ),
          'connector_id', v_conn.id,
          -- The EXACT definition this tool stands for. The name above already
          -- encodes it (mig 605 suffixes with md5(v_def.id)), but the caller was
          -- left to re-derive the action from (connector, action_key) — which is
          -- ambiguous whenever one key has several executors.
          'action_definition_id', v_def.id,
          'action_key', v_def.action_key,
          'destructive', coalesce((v_def.risk->>'destructive')::boolean, true)
        ));
      end if;
    end loop;
  end loop;

  return v_tools;
end;
$function$
;

-- ── compute_de_lifecycle_readiness ────────────────────────────────

CREATE OR REPLACE FUNCTION public.compute_de_lifecycle_readiness(p_de_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_de digital_employees;
  v_tenant uuid;
  v_identity boolean;
  v_grants boolean;
  v_knowledge boolean;
  v_policies boolean;
  v_embedded boolean;
  v_qa_passed boolean;
  v_certified boolean;
  v_channel boolean;
  v_grounding jsonb;
  v_executed boolean;
begin
  select * into v_de from digital_employees where id = p_de_id;
  if v_de.id is null then return jsonb_build_object('error', 'not_found'); end if;
  v_tenant := v_de.tenant_id;

  -- Humans must belong to the workspace; trusted server contexts pass.
  if auth.role() is not null and auth.role() <> 'service_role' then
    if auth_tenant_id() is distinct from v_tenant then
      raise exception 'not a member of this workspace';
    end if;
    if not public.can_access_de(p_de_id) then
      return jsonb_build_object('error', 'not_found');
    end if;
  end if;

  v_identity := coalesce(v_de.name, '') <> '' and coalesce(v_de.description, '') <> ''
    and (coalesce(v_de.department, '') <> '' or coalesce(v_de.workspace, '') <> '')
    and coalesce(array_length(v_de.responsibilities, 1), 0) >= 1;

  v_grants := exists (select 1 from data_access_grants
    where tenant_id = v_tenant and subject_kind = 'de' and subject_id = p_de_id);

  v_knowledge := exists (select 1 from knowledge_docs d
    where d.tenant_id = v_tenant
      and (d.visibility = 'tenant'
           or exists (select 1 from knowledge_doc_scopes s
                      where s.doc_id = d.id and s.subject_kind = 'de' and s.subject_id = p_de_id)));

  v_policies := exists (select 1 from guardrail_rules where tenant_id = v_tenant and active);

  v_embedded := exists (select 1 from knowledge_doc_chunks c
    join knowledge_docs d on d.id = c.doc_id
    where d.tenant_id = v_tenant and c.embedding is not null
      and (d.visibility = 'tenant'
           or exists (select 1 from knowledge_doc_scopes s
                      where s.doc_id = d.id and s.subject_kind = 'de' and s.subject_id = p_de_id)));

  v_qa_passed := coalesce((select r.status = 'passed' from eval_runs r
    where r.tenant_id = v_tenant
    order by coalesce(r.finished_at, r.started_at) desc limit 1), false);

  v_certified := exists (select 1 from de_lifecycle_events
    where tenant_id = v_tenant and de_id = p_de_id and to_stage = 'certified' and actor_id is not null);

  v_channel := exists (select 1 from data_access_grants g
      where g.tenant_id = v_tenant and g.subject_kind = 'de' and g.subject_id = p_de_id
        and access_permission_level(g.permission) >= access_permission_level('search'))
    or exists (select 1 from widget_keys where tenant_id = v_tenant and active);

  v_executed := exists (select 1 from evidence_runs where tenant_id = v_tenant and de_id = p_de_id);
  -- Mig 796: grounding. required_connector_categories was DECORATIVE — its one
  -- reader displayed it on the Record tab and nothing gated hiring or work, so
  -- an SEO employee could be hired with nothing to read and would run anyway,
  -- producing plausible generic content (measured 2026-07-28, still true
  -- 2026-08-11). A required category counts as met only when this tenant has a
  -- CONNECTED connector in it. No archetype, or no requirements ⇒ trivially
  -- grounded — a bespoke employee is not penalised for having no template.
  select coalesce(jsonb_object_agg(req.cat,
           exists (select 1 from connectors k
                    where k.tenant_id = v_tenant and k.category = req.cat
                      and k.status = 'connected'
      -- ⛔ AND ALIVE (mig 814). `status` is not written on failure.
      and not public.connector_circuit_open(k.consecutive_failures, k.last_error_at))), '{}'::jsonb)
    into v_grounding
    from (select unnest(ra.required_connector_categories) as cat
            from digital_employees d
            join role_archetypes ra on ra.key = d.archetype_key
           where d.id = p_de_id) req;

  return jsonb_build_object(
    'stage', v_de.lifecycle_status,
    'status', v_de.status,
    'criteria', jsonb_build_object(
      'configured', jsonb_build_object(
        'identity_complete', v_identity,
        'detail', 'Name, description, a department or workspace, and at least one responsibility.'),
      'trained', jsonb_build_object(
        'control_fabric_grant', v_grants,
        'knowledge_in_scope', v_knowledge,
        'active_guardrails', v_policies,
        'detail', 'At least one system-access grant, knowledge this employee can see, and active workspace guardrails.'),
      'tested', jsonb_build_object(
        'knowledge_embedded', v_embedded,
        'detail', 'The knowledge in scope is actually searchable (embedded), so answers can cite it.'),
      'certified', jsonb_build_object(
        'golden_qa_passed', v_qa_passed,
        'scope', 'workspace',
        'detail', 'The latest golden Q&A run passed. (Suite is workspace-level today — per-employee suites arrive with Skills, DE-C1.)'),
      'published', jsonb_build_object(
        'certified_by_human', v_certified,
        'detail', 'A named workspace owner/admin recorded certification.'),
      'assigned', jsonb_build_object(
        'has_work_channel', v_channel,
        'grounding_connected', (select coalesce(bool_and(v::boolean), true) from jsonb_each_text(v_grounding) as e(k, v)),
        'grounding_by_category', v_grounding,
        'detail', 'A searchable system grant (inbox) or an active site widget key.'),
      'active', jsonb_build_object(
        'first_live_execution', v_executed,
        'detail', 'At least one real evidence run attributed to this employee.')
    )
  );
end;
$function$
;

-- ── onboarding_verb_verdict ───────────────────────────────────────

CREATE OR REPLACE FUNCTION public.onboarding_verb_verdict(p_tenant_id uuid, p_action_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
AS $function$
declare
  v_reach_ids  uuid[] := '{}'::uuid[];
  v_schema     jsonb;
  v_category   text;
  v_roles      text;
  v_visible    boolean := false;
  v_desk       uuid[] := '{}'::uuid[];
  v_desk_known boolean := false;
  v_role_ok    boolean := false;
  v_desk_names text;
begin
  -- Same refusal as validate_onboarding_items, for the same reason: with no
  -- workspace, reachability matches nothing and every verb would look dead.
  if p_tenant_id is null then
    raise exception 'onboarding_verb_verdict: p_tenant_id is required — neither reachability nor role can be decided without a workspace';
  end if;
  if p_action_key is null or p_action_key = '' then
    return null;
  end if;

  -- REACHABILITY. `one` is MATERIALIZED so both scalar subqueries read the
  -- same arbitrary row rather than two independently-chosen ones.
  with reach as (
    select ad.id, ad.param_schema, ad.category, ad.requires_role
      from public.action_definitions ad
     where ad.action_key = p_action_key
       and ad.status = 'active'
       and ad.provider <> 'internal'
       and (ad.scope = 'platform' or (ad.scope = 'tenant' and ad.tenant_id = p_tenant_id))
       and exists (
         select 1
           from public.connectors c
          where c.tenant_id = p_tenant_id
            and c.status = 'connected'
      -- ⛔ AND ALIVE (mig 814). `status` is not written on failure.
      and not public.connector_circuit_open(c.consecutive_failures, c.last_error_at)
            and c.category = ad.category
            and (ad.provider is null or ad.provider = c.provider or ad.provider = 'template'))
  ), one as materialized (
    select param_schema, category from reach limit 1
  )
  select coalesce((select array_agg(id) from reach), '{}'::uuid[]),
         (select param_schema from one),
         (select category from one),
         (select string_agg(distinct requires_role, ', ') from reach where requires_role is not null)
    into v_reach_ids, v_schema, v_category, v_roles;

  if coalesce(array_length(v_reach_ids, 1), 0) = 0 then
    -- VISIBILITY (mig 674 rule (b)), asked only to tell the two failures
    -- apart and to schema-check params on a binding already being rejected.
    select ad.param_schema, ad.category
      into v_schema, v_category
      from public.action_definitions ad
     where ad.action_key = p_action_key
       and ad.status = 'active'
       and (ad.tenant_id is null or ad.tenant_id = p_tenant_id)
     limit 1;
    v_visible := v_schema is not null;
  else
    -- A reachable definition is platform-scope or this tenant's own, so it is
    -- visible by construction; no second lookup can change that.
    v_visible := true;
  end if;

  -- THE ONBOARDING DESK — see the header. Watchers say who it WILL go to,
  -- objectives say who it HAS gone to; the mission and delegation paths
  -- create no watcher, so the second arm is what covers them.
  select coalesce(array_agg(distinct z.de_id), '{}'::uuid[])
    into v_desk
    from (
      select w.de_id
        from public.work_watchers w
       where w.tenant_id = p_tenant_id
         and w.active
         and coalesce(w.config->>'source', '') = 'onboarding_projects'
         and w.de_id is not null
      union
      select o.de_id
        from public.de_objectives o
       where o.tenant_id = p_tenant_id
         and o.entity_kind = 'onboarding_project'
         and o.de_id is not null
    ) z;
  v_desk_known := coalesce(array_length(v_desk, 1), 0) > 0;

  if v_desk_known and coalesce(array_length(v_reach_ids, 1), 0) > 0 then
    select exists (
      select 1
        from unnest(v_desk) d(de_id)
        cross join unnest(v_reach_ids) r(def_id)
       where public.de_may_use_action(p_tenant_id, d.de_id, r.def_id))
      into v_role_ok;

    select string_agg(q.nm, ', ' order by q.nm)
      into v_desk_names
      from (
        select coalesce(nullif(de.persona_name, ''), de.name) as nm
          from public.digital_employees de
         where de.id = any(v_desk) and de.tenant_id = p_tenant_id) q;
  end if;

  return jsonb_build_object(
    'visible',        v_visible,
    'reachable',      coalesce(array_length(v_reach_ids, 1), 0) > 0,
    'category',       v_category,
    'param_schema',   v_schema,
    'desk_known',     v_desk_known,
    'desk_size',      coalesce(array_length(v_desk, 1), 0),
    'role_ok',        v_role_ok,
    'required_roles', v_roles,
    'desk',           v_desk_names);
end;
$function$
;

-- ── proof ─────────────────────────────────────────────────────────────────
do $verify$
declare v_unguarded text[]; v_total int; v_dead uuid; v_tenant uuid; v_before int;
begin
  -- (a) THE INVARIANT. Every function that selects connectors by the stored
  --     marker must now consult the breaker — actors and availability
  --     readers alike. Stated as a property, so a fifth reader added later
  --     trips it without anyone editing this list.
  select coalesce(array_agg(p.proname order by p.proname), '{}'), count(*)
    into v_unguarded, v_total
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and regexp_replace(p.prosrc,'--[^' || chr(10) || ']*','','g') ~ 'status\s*=\s*''connected'''
     and regexp_replace(p.prosrc,'--[^' || chr(10) || ']*','','g') !~ 'connector_circuit_open';
  if array_length(v_unguarded, 1) > 0 then
    raise exception 'VERIFY FAILED: % function(s) still trust the stale marker without the breaker: %',
      array_length(v_unguarded, 1), array_to_string(v_unguarded, ', ');
  end if;

  -- (b) the denominator. If NOTHING reads the marker any more, (a) passed by
  --     matching nothing and proves nothing.
  select count(*) into v_total
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and regexp_replace(p.prosrc,'--[^' || chr(10) || ']*','','g') ~ 'status\s*=\s*''connected''';
  if v_total < 6 then
    raise exception 'VERIFY FAILED: only % marker reader(s) found, expected at least 6 — the check is looking at the wrong thing', v_total;
  end if;

  -- (c) ⛔ IT MUST STILL SAY YES TO A LIVE CONNECTOR. Gating four
  --     availability readers on a predicate that refused everything would
  --     empty every trust surface and un-ground every employee, and would
  --     pass (a) and (b) while doing it.
  if public.connector_circuit_open(0, null) then
    raise exception 'VERIFY FAILED: breaker opens on a healthy connector';
  end if;
  if not public.connector_circuit_open(8764, now()) then
    raise exception 'VERIFY FAILED: breaker does not open on a connector failing right now';
  end if;

  -- (d) ...and end to end: the capability whose only connector is dead must
  --     have LEFT the trust surface. Measured, not reasoned about.
  select c.tenant_id into v_tenant
    from connectors c
   where c.provider = 'erpnext' and c.status = 'connected'
     and public.connector_circuit_open(c.consecutive_failures, c.last_error_at)
   order by c.consecutive_failures desc limit 1;
  if v_tenant is null then
    raise notice 'VERIFY: no open-circuit connector exists, so (d) cannot discriminate today';
  else
    select count(*) into v_before
      from public.de_trust_surface_candidates(v_tenant, null) s
     where s.capability_key like '%erp%' or s.capability_key like '%invoice%';
    raise notice 'trust surface entries backed by the dead ERP connector: %', v_before;
  end if;
end
$verify$;

commit;
