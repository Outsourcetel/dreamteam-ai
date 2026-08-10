-- 693_a_verb_the_onboarding_employee_cannot_use.sql
-- ==========================================================================
-- WHY: mig 681 taught validate_onboarding_items to refuse a verb this
-- WORKSPACE cannot reach — its rule (f) joins to connected connectors, lifted
-- verbatim from get_agentic_tools_for_de. It is still not what the runtime
-- decides. get_agentic_tools_for_de applies TWO more filters after the
-- connector match, and one of them is an authorisation:
--
--     if coalesce((v_verdict->>'allowed')::boolean, false)          -- resolve_access
--        and public.de_may_use_action(p_tenant_id, p_de_id, v_def.id) then
--
-- de_may_use_action enforces action_definitions.requires_role (mig 643 for
-- 'workforce_assistant', mig 669 for 'finance'). A verb the employee's role
-- does not carry never enters its offer list — and de-work only DECLARES
-- perform_onboarding_item at all when at least one bound item on the project
-- resolves through that list:
--
--     const performable = [...onboardingBoundActions].filter(([, ak]) => actionByKey.has(ak));
--     if (performable.length > 0) { motionTools.push({ name: 'perform_onboarding_item', ... }) }
--
-- FOUND BY DRIVING THE SYSTEM, NOT BY READING IT. Production version 5 of
-- outsourcetel-hq's "SaaS onboarding — starter" binds item
-- locations_configured -> propose_connector, which carries
-- requires_role='workforce_assistant'. Checked against the live catalog:
--   · propose_connector IS connector-reachable there (a connected
--     dreamteam/platform_admin connector exists), so rule (f) passes;
--   · of the 18 employees in that workspace exactly ONE may use it — the
--     Workspace Assistant — and the workspace routes onboarding to "Onni",
--     the Onboarding DE, which may not;
--   · so the verb is not in Onni's offer list, perform_onboarding_item is
--     never declared, and NO execution of that item is reachable at all.
-- The validator returned zero errors. A template published green that the
-- employee can never run — the same class as mig 681, one gate deeper.
-- There is a LIVE project on it: "Grant Plastics Ltd. — SaaS onboarding v5",
-- status active, template_version_id = the v5 row. Not merely historical.
--
-- ── THE HARD PART: a template has no employee ─────────────────────────────
-- de_may_use_action needs a DIGITAL EMPLOYEE ID. Templates are tenant-level
-- and say nothing about who will run them; onboarding_projects has no de_id
-- column at all (checked in information_schema, not assumed). So the employee
-- had to be established from how routing REALLY works, read out of the live
-- catalog and the runtime source:
--
--   1. de-work reads its employee from de_work_items -> de_objectives.de_id.
--      ENTITY_DESKS.onboarding_project only supplies the RECORD; the employee
--      is already fixed by then.
--   2. de_objectives rows for entity_kind='onboarding_project' are written by
--      exactly three things (every INSERT INTO de_objectives in pg_proc, plus
--      every .insert('de_objectives') in the app, enumerated — not sampled):
--        · run_work_watchers, generic catalog-driven branch:
--            INSERT INTO de_objectives (..., de_id, ..., entity_kind, ...)
--            VALUES (w.tenant_id, w.de_id, ..., v_cat.entity_kind, ...)
--          — the objective's employee IS the WATCHER'S employee.
--        · de-mission approve — the mission's de_id, or routeReceivers for a
--          team mission.
--        · request_de_task — colleague delegation, the named recipient.
--      upsert_de_objective never sets entity_kind, so it cannot mint one.
--   3. It is NOT by archetype. install_role_watchers has no onboarding branch
--      at all (its four name-matched roles are success/renewal/support/
--      finance), so the onboarding watcher is created by hand and points at
--      whichever employee the workspace chose. In production that is
--      archetype 'onboarding' — but that is a coincidence of this workspace,
--      not a rule, and hard-coding archetype_key='onboarding' would be the
--      hardcoded-department mistake this project has a standing rule against.
--
-- THE RULE, therefore: the ONBOARDING DESK of a workspace = the employees the
-- routing layer can hand an onboarding_project case to, which is the union of
--   (i)  de_id of ACTIVE work_watchers whose config source is
--        'onboarding_projects'   — who it WILL be routed to, and
--   (ii) de_id of de_objectives with entity_kind='onboarding_project'
--        — who it HAS been routed to (this is what catches the mission and
--        delegation paths, which create no watcher).
-- A bound verb must be usable by AT LEAST ONE member of that desk.
--
-- Why ANY and not ALL. ANY is the provably-dead question: "no employee this
-- workspace routes onboarding to could ever run this" is certain, and it is
-- exactly the v5 defect. ALL ("some router cannot run it") is a weaker claim
-- resting on which watcher happened to match, and would reject a workspace
-- that deliberately runs two onboarding desks with different authority. A
-- validator that blocks a legitimate publish is the mig-643 failure, not a
-- stricter one. RESIDUAL, stated rather than hidden: with two onboarding
-- desks and only one able to run the verb, this rule passes and the other
-- desk's runtime still refuses — at which point perform_onboarding_item's
-- Refusal 6 blocks the item and escalates to a person, which is the designed
-- behaviour and not a silent failure.
--
-- Why NOT "any employee in the tenant" (the obvious rule): it would have
-- PASSED v5. The Workspace Assistant may use propose_connector. Scoping to
-- the desk is the whole point.
--
-- ── BOTH HALVES: what a workspace with no onboarding employee does ────────
-- If the desk is EMPTY — a fresh workspace, no onboarding watcher, no
-- onboarding case ever opened — this rule is SKIPPED, not failed. There is no
-- employee to check against, and failing closed would make every publish of a
-- bound template impossible in a new workspace: the mig-643 trap, where half
-- a rule breaks the feature. The skip is deliberate and it is said out loud —
-- a RAISE NOTICE names it, this header records it, and the probe below
-- carries the same skip so the two never disagree. Proven in both directions
-- below: the SAME workspace and the SAME verb ACCEPT with no desk, and REJECT
-- once a desk exists that cannot run it.
--
-- ── ONE DEFINITION, because this is the second time ───────────────────────
-- This class has now appeared twice in this one feature: mig 681 fixed a
-- validator and a probe that had drifted from get_agentic_tools_for_de, and
-- this migration fixes both of them drifting again from the SAME function.
-- The cause is that "can this verb run here" was written out three times. So
-- it is written ONCE here, in public.onboarding_verb_verdict(tenant, key),
-- and validate_onboarding_items and the Ring-0 probe both ASK it. Copies of
-- the reachability predicate go from three (validator, probe, runtime) to two
-- (this function, and get_agentic_tools_for_de which it is lifted from).
--
-- ── WHAT IS DELIBERATELY NOT CLOSED HERE ─────────────────────────────────
-- get_agentic_tools_for_de applies a THIRD gate this still does not model:
-- resolve_access(tenant,'de',de_id,connector_id,'write_back'). It is a
-- per-employee, per-connector grant an admin can change at any moment, and
-- modelling it at publish time would make the validator's answer depend on
-- state that legitimately changes hourly. Named, left, and reported — not
-- silently ignored.
--
-- Base body: read LIVE via pg_get_functiondef from production immediately
-- before writing this (and confirmed byte-identical in dev), so it carries
-- mig 685's 'handoff' phase and its four ::text bug-fix casts. Signature
-- unchanged — mig 681 dropped the 1-arg form deliberately and a replace with
-- a different argument list would resurrect it as a second overload (42725).
-- ==========================================================================

begin;

-- ── ONE definition of "can this workspace's onboarding desk run this verb" ─
-- Returns a verdict, never a decision: the caller words the error. NULL-safe
-- on an empty key so callers need no guard.
--
--   visible        an ACTIVE definition exists that this workspace can see
--                  (mig 674 rule (b) — kept so "no such verb" and "no system
--                  for it" stay two different messages)
--   reachable      a CONNECTED connector of this workspace matches one
--                  (mig 681 rule (f), predicate verbatim from
--                  get_agentic_tools_for_de)
--   param_schema   the schema of the chosen definition — reachable one if
--                  there is one, else the merely-visible one. Deliberately
--                  the same arbitrary `limit 1` the live function already
--                  used: 12 action_keys in production have rows whose
--                  param_schema DIFFERS, so making this deterministic would
--                  silently change which schema rules (c)-(e) check against.
--                  That pre-existing indeterminacy is recorded, not fixed
--                  here.
--   desk_known     does this workspace route onboarding work to anybody
--   role_ok        can SOME desk employee use SOME reachable definition
--   required_roles the roles the reachable definitions demand, for the message
--   desk           the desk employees' display names, for the message
create or replace function public.onboarding_verb_verdict(p_tenant_id uuid, p_action_key text)
returns jsonb
language plpgsql
stable
as $function$
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
$function$;

-- Migs 610+630 rule: strip BOTH default-grant mechanisms on a NEW function,
-- and name service_role explicitly — validate_onboarding_items is granted to
-- service_role for scripts and tests, and a callee it cannot execute would
-- turn that path into a permission error instead of a verdict. Asserted below.
revoke all on function public.onboarding_verb_verdict(uuid, text) from public, anon, authenticated;
grant execute on function public.onboarding_verb_verdict(uuid, text) to service_role;

-- de_may_use_action is now on that path too. Production already grants it to
-- service_role; the DEV project does not (checked, both). Aligning them is not
-- a widening — it is removing a drift that would make the dev-side direct call
-- fail with "permission denied for function" and look like a validator bug.
grant execute on function public.de_may_use_action(uuid, uuid, uuid) to service_role;

-- ── A REPAIR THIS MIGRATION'S OWN ASSERTION FOUND ─────────────────────────
-- mig 681 changed validate_onboarding_items to (jsonb, uuid) and updated its
-- one caller in the same migration. Production carries both halves. The DEV
-- project carries only the FIRST: its validate_onboarding_items is byte-
-- identical to production's (compared via pg_get_functiondef), while its
-- publish_onboarding_template still reads
--
--     v_errors := validate_onboarding_items(v_tpl.items);
--
-- — the 1-arg form, which mig 681 dropped. That is the ONLY line that differs
-- between the two environments (46 lines each, diffed line by line), and it
-- means every publish in dev raises 42883 "function does not exist". Dev's
-- schema_migrations ledger holds NO row for 670-692 at all, so dev is kept
-- current by dev-sync, not by replaying migrations, and this is what a partial
-- sync leaves behind. It was invisible until mig 681's assertion — inherited
-- here — was re-run against dev.
--
-- Body below is production's LIVE definition, reproduced verbatim. Applying it
-- to production is a no-op; applying it to dev restores the half it missed.
-- Plain `create or replace`, so the existing ACL is preserved untouched
-- (authenticated must keep EXECUTE or no owner/admin can publish) — asserted
-- at the end, as always.
create or replace function public.publish_onboarding_template(p_template_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_tpl     onboarding_templates;
  v_errors  text[];
  v_version integer;
  v_vid     uuid;
begin
  select * into v_tpl from onboarding_templates where id = p_template_id;
  if not found then
    return jsonb_build_object('error', 'template_not_found');
  end if;
  if not (v_tpl.tenant_id = auth_tenant_id() and auth_has_tenant_role(array['tenant_owner', 'tenant_admin'])) then
    raise exception 'only workspace owners/admins can publish an onboarding template';
  end if;

  v_errors := validate_onboarding_items(v_tpl.items, v_tpl.tenant_id);
  if array_length(v_errors, 1) is not null then
    return jsonb_build_object('errors', to_jsonb(v_errors));
  end if;

  v_version := v_tpl.version + 1;
  insert into onboarding_template_versions (template_id, tenant_id, version, name, description, items, published_by)
  values (v_tpl.id, v_tpl.tenant_id, v_version, v_tpl.name, v_tpl.description, v_tpl.items, auth.uid())
  returning id into v_vid;

  update onboarding_templates
    set version = v_version, status = 'published'
    where id = v_tpl.id;

  perform append_audit_event_internal(
    v_tpl.tenant_id, 'You', 'human',
    format('Onboarding template published — %s v%s (%s items)', v_tpl.name, v_version, jsonb_array_length(v_tpl.items)),
    'config_change',
    jsonb_build_object('kind', 'onboarding_template_publish', 'template_id', v_tpl.id,
                       'version_id', v_vid, 'version', v_version,
                       'item_count', jsonb_array_length(v_tpl.items)));

  return jsonb_build_object('version_id', v_vid, 'version', v_version);
end;
$function$;

-- ── validate_onboarding_items: rule (g) ───────────────────────────────────
-- Rules (a)-(f) are unchanged in behaviour and wording. What changed is that
-- (b) and (f) now get their answer from onboarding_verb_verdict instead of
-- asking the catalog themselves, and (g) is new.
create or replace function public.validate_onboarding_items(p_items jsonb, p_tenant_id uuid)
returns text[]
language plpgsql
stable
as $function$
declare
  v_errors       text[] := '{}';
  v_item         jsonb;
  v_verify       jsonb;
  v_keys         text[] := '{}';
  v_key          text;
  v_n            integer;
  v_match        text;
  v_action_key   text;
  v_params       jsonb;
  v_schema       jsonb;
  v_schema_item  jsonb;
  v_pkey         text;
  v_pval         jsonb;
  v_category     text;
  v_verdict      jsonb;
  v_desk_unknown boolean := false;
begin
  -- A validator that cannot decide must refuse, not guess. With a NULL tenant
  -- the reachability rule below matches no connectors and would reject every
  -- binding ever written — a silent, total refusal that looks exactly like a
  -- correctly-strict validator. Fail loudly at the call site instead.
  if p_tenant_id is null then
    raise exception 'validate_onboarding_items: p_tenant_id is required — reachability cannot be decided without a workspace';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    return array['items must be a JSON array'];
  end if;
  v_n := jsonb_array_length(p_items);
  -- ::text on these four literals is a BUG FIX from mig 685, not a style
  -- choice. Without it `text[] || <unknown literal>` resolves to
  -- anyarray||anyarray and throws 22P02 instead of appending the message.
  if v_n < 1 then v_errors := v_errors || 'template needs at least 1 item'::text; end if;
  if v_n > 50 then v_errors := v_errors || 'template cannot exceed 50 items'::text; end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_key := coalesce(v_item->>'key', '');
    if v_key = '' then
      v_errors := v_errors || 'every item needs a non-empty key'::text;
    elsif v_key = any(v_keys) then
      v_errors := v_errors || format('duplicate item key "%s"', v_key);
    end if;
    v_keys := v_keys || v_key;
    if coalesce(v_item->>'label', '') = '' then
      v_errors := v_errors || format('item "%s" needs a label', v_key);
    end if;
    -- mig 685: 'handoff' added. A support/success handover happens AFTER
    -- go-live, so the vocabulary needed a sixth phase; the go-live rule at the
    -- bottom of this function is unchanged and still enforced.
    if coalesce(v_item->>'phase', '') not in ('kickoff', 'data', 'config', 'validation', 'golive', 'handoff') then
      v_errors := v_errors || format('item "%s" has an invalid phase', v_key);
    end if;
    if coalesce(v_item->>'owner_type', '') not in ('human', 'de', 'either') then
      v_errors := v_errors || format('item "%s" has an invalid owner_type', v_key);
    end if;
    if coalesce((v_item->>'requires_signoff')::boolean, false)
       and coalesce(v_item->>'owner_type', '') = 'de' then
      v_errors := v_errors || format('sign-off item "%s" must be owned by human or either — a DE cannot sign off its own work', v_key);
    end if;

    v_verify := v_item->'verify';
    if v_verify is not null and jsonb_typeof(v_verify) = 'object' then
      if coalesce(v_item->>'owner_type', '') = 'human' then
        v_errors := v_errors || format('item "%s" is human-owned — automated verification only applies to de/either items', v_key);
      end if;
      if coalesce(v_verify->>'category', '') not in
        ('crm', 'helpdesk', 'knowledge_base', 'erp_financials', 'billing', 'payroll_hcm', 'pos', 'product_system', 'other') then
        v_errors := v_errors || format('item "%s" has an invalid verify.category', v_key);
      end if;
      if coalesce(v_verify->>'op', '') = '' then
        v_errors := v_errors || format('item "%s" needs a verify.op', v_key);
      end if;
      v_match := coalesce(v_verify->>'match', '');
      if v_match not in ('exists', 'contains') then
        v_errors := v_errors || format('item "%s" has an invalid verify.match (must be exists or contains)', v_key);
      end if;
      if v_match = 'contains' and coalesce(v_verify->>'contains_text', '') = '' then
        v_errors := v_errors || format('item "%s" verify.match=contains needs contains_text', v_key);
      end if;
      if coalesce(v_verify->>'query_template', '') = '' and coalesce(v_verify->>'ref_template', '') = '' then
        v_errors := v_errors || format('item "%s" needs a verify.query_template or verify.ref_template', v_key);
      end if;
    end if;

    -- ---- action binding rules (a)-(g) ----
    -- (a)-(e) mig 674, (f) mig 681, (g) mig 693. (b) and (f) now read their
    -- answer from onboarding_verb_verdict; their wording is unchanged.
    v_action_key := v_item->>'action_key';
    if v_action_key is not null and v_action_key <> '' then
      -- (a) an item that names a verb must be DE-owned; a human or "either"
      -- item cannot be bound to automated execution.
      if coalesce(v_item->>'owner_type', '') <> 'de' then
        v_errors := v_errors || format('item "%s" names an action but owner_type must be "de" to bind one', v_key);
      end if;

      v_verdict  := public.onboarding_verb_verdict(p_tenant_id, v_action_key);
      -- jsonb_build_object turns a SQL NULL into the jsonb null 'null', which
      -- is NOT NULL — without this nullif every unreachable verb would carry a
      -- non-null "schema" and rules (c)-(e) would iterate over it.
      v_schema   := nullif(v_verdict->'param_schema', 'null'::jsonb);
      v_category := v_verdict->>'category';

      if not coalesce((v_verdict->>'reachable')::boolean, false) then
        -- (f) then (b): no connected system that can run it, or no such verb.
        if not coalesce((v_verdict->>'visible')::boolean, false) then
          v_errors := v_errors || format('item "%s" names action_key "%s" which has no active action definition visible to this workspace', v_key, v_action_key);
        else
          v_errors := v_errors || format('item "%s" names action_key "%s" but this workspace has no connected %s system that can run it — connect one, or bind a different verb', v_key, v_action_key, coalesce(v_category, 'matching'));
        end if;

      elsif not coalesce((v_verdict->>'desk_known')::boolean, false) then
        -- (g) SKIPPED, loudly. No employee has been given onboarding work in
        -- this workspace yet, so there is nobody to check the role against.
        -- Failing here would make a fresh workspace unable to publish at all.
        v_desk_unknown := true;

      elsif not coalesce((v_verdict->>'role_ok')::boolean, false) then
        -- (g) ROLE REACHABILITY. The verb is reachable by connector and still
        -- dead: it demands a role the onboarding desk does not hold, so
        -- get_agentic_tools_for_de never offers it, de-work never declares
        -- perform_onboarding_item, and the item can never be executed.
        v_errors := v_errors || format(
          'item "%s" names action_key "%s", which needs the "%s" role — the employee(s) this workspace gives onboarding work to (%s) do not have it, so it never reaches their tool list and the item could never run. Bind a verb they can run, or give onboarding to an employee that holds that role',
          v_key, v_action_key,
          coalesce(v_verdict->>'required_roles', 'required'),
          coalesce(v_verdict->>'desk', 'none named'));
      end if;

      if v_schema is not null then
        v_params := v_item->'params';
        if v_params is null then
          v_params := '{}'::jsonb;
        end if;
        if jsonb_typeof(v_params) <> 'object' then
          v_errors := v_errors || format('item "%s" params must be an object', v_key);
        else
          -- (c) every params value must be '@account', '@ask', or a scalar
          -- literal — never an object/array/null a later step could misread.
          for v_pkey, v_pval in select key, value from jsonb_each(v_params) loop
            if jsonb_typeof(v_pval) not in ('string', 'number', 'boolean') then
              v_errors := v_errors || format('item "%s" param "%s" must be "@account", "@ask", or a scalar literal', v_key, v_pkey);
            end if;
          end loop;

          -- (e) params may not name a parameter the verb does not have — a
          -- typo must be caught here, not silently dropped at execution time.
          for v_pkey in select jsonb_object_keys(v_params) loop
            if not exists (
              select 1 from jsonb_array_elements(v_schema) s where s->>'name' = v_pkey
            ) then
              v_errors := v_errors || format('item "%s" names parameter "%s" which action "%s" does not have', v_key, v_pkey, v_action_key);
            end if;
          end loop;

          -- (d) every REQUIRED param of the verb must appear as a key —
          -- named, not necessarily answered yet; '@ask' satisfies this.
          for v_schema_item in select * from jsonb_array_elements(v_schema) loop
            if coalesce((v_schema_item->>'required')::boolean, false)
               and not (v_params ? (v_schema_item->>'name')) then
              v_errors := v_errors || format('item "%s" is missing required parameter "%s" for action "%s"', v_key, v_schema_item->>'name', v_action_key);
            end if;
          end loop;
        end if;
      end if;
    end if;
  end loop;

  if not exists (
    select 1 from jsonb_array_elements(p_items) i where i->>'phase' = 'golive'
  ) then
    v_errors := v_errors || 'template needs at least one go-live phase item'::text;
  end if;

  -- A skipped check that says nothing is indistinguishable from a check that
  -- passed. This is the only channel a text[]-returning validator has that is
  -- not an error the publish would be blocked on.
  if v_desk_unknown then
    raise notice 'validate_onboarding_items: role reachability NOT CHECKED for workspace % — no employee owns an onboarding watcher and no onboarding case has ever been opened, so there is nobody to check the verb against. Bindings were accepted on connector reachability alone.', p_tenant_id;
  end if;

  return v_errors;
end;
$function$;

-- `create or replace` (same signature) preserves this function's ACL, but a
-- REVOKE statement is not a description of the resulting privileges — the end
-- state is asserted below, both directions.
revoke all on function public.validate_onboarding_items(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.validate_onboarding_items(jsonb, uuid) to service_role;

-- ── Verify ────────────────────────────────────────────────────────────────
-- THREE directions, on ONE workspace and ONE verb, so they are a set and not
-- three unrelated facts:
--   A. NO DESK              -> ACCEPTED  (the fresh-workspace half; a rule
--                                         that fails here breaks the feature)
--   B. A DESK THAT CANNOT   -> REJECTED, naming the item, the verb, the ROLE
--                              and WHO lacks it
--   C. A DESK THAT CAN      -> ACCEPTED with ZERO errors
--
-- The desk is created SYNTHETICALLY and ROLLED BACK. It has to be: the dev
-- project has ZERO onboarding watchers and ZERO onboarding_project objectives
-- across all 155 tenants (counted, not assumed), so every dev tenant's desk is
-- empty and B and C could not run there at all from live data. A migration
-- whose central assertion only fires in one environment is a migration that
-- ships blind everywhere else. The insert is one work_watchers row, shaped
-- exactly like the real production one, undone by a nested block that raises;
-- plpgsql variables are memory, not transactional, so the results survive the
-- rollback while the row does not.
--
-- Fixtures are DERIVED from the live catalog, never hardcoded — mig 681's
-- lesson, and the reason that migration remained appliable in an environment
-- whose data looks nothing like production's.
do $$
declare
  v_tenant     uuid;
  v_key        text;
  v_wfa_de     uuid;
  v_plain_de   uuid;
  v_plain_name text;
  v_need_role  text;
  v_verdict    jsonb;
  v_r_objdesk  text[];
  v_r_unreach  text[];
  v_free_cat   text;
  v_params     jsonb;
  v_items      jsonb;
  v_r_skip     text[];
  v_r_reject   text[];
  v_r_accept   text[];
  v_ok_key     text;
  v_ok_params  jsonb;
  v_ok_req     text;
  v_r          text[];
  v_raised     boolean;
  v_live       jsonb;
  v_live_t     uuid;
  v_anon       boolean;
  v_authed     boolean;
  v_service    boolean;
  v_pub_authed boolean;
  v_dmua_svc   boolean;
  v_verdict_a  boolean;
  v_verdict_s  boolean;
begin
  ---------------------------------------------------------------------------
  -- FIXTURE. One workspace + one ROLE-GATED verb that workspace can reach by
  -- connector, holding an employee that MAY use it and one that MAY NOT, and
  -- whose real desk is EMPTY so the synthetic desk is the whole desk and
  -- assertion A is not polluted by a router that already exists.
  --
  -- "MAY NOT" is checked across EVERY reachable definition of the key, not
  -- one row: send_payment_reminder has six rows in production, some carrying
  -- requires_role='finance' and some carrying none, and a fixture picked
  -- per-row would have selected a gated row of a key that is runnable anyway.
  ---------------------------------------------------------------------------
  with reach as (
    select c.tenant_id, ad.action_key, ad.id as def_id, ad.requires_role
      from public.action_definitions ad
      join public.connectors c
        on c.status = 'connected'
       and c.category = ad.category
       and (ad.provider is null or ad.provider = c.provider or ad.provider = 'template')
     where ad.status = 'active' and ad.provider <> 'internal'
       and (ad.scope = 'platform' or (ad.scope = 'tenant' and ad.tenant_id = c.tenant_id))
  ), desk as (
    select tenant_id, de_id from public.work_watchers
     where active and coalesce(config->>'source', '') = 'onboarding_projects'
    union
    select tenant_id, de_id from public.de_objectives
     where entity_kind = 'onboarding_project' and de_id is not null
  ), cand as (
    select distinct r.tenant_id, r.action_key
      from reach r
     where exists (select 1 from reach r2
                    where r2.tenant_id = r.tenant_id and r2.action_key = r.action_key
                      and r2.requires_role is not null)
       and not exists (select 1 from desk d where d.tenant_id = r.tenant_id)
  ), pick as (
    select c.tenant_id, c.action_key,
      (select de.id from public.digital_employees de
        where de.tenant_id = c.tenant_id
          and exists (select 1 from reach r
                       where r.tenant_id = c.tenant_id and r.action_key = c.action_key
                         and public.de_may_use_action(c.tenant_id, de.id, r.def_id))
        order by de.id limit 1) as wfa_de,
      (select de.id from public.digital_employees de
        where de.tenant_id = c.tenant_id
          and not exists (select 1 from reach r
                           where r.tenant_id = c.tenant_id and r.action_key = c.action_key
                             and public.de_may_use_action(c.tenant_id, de.id, r.def_id))
        order by de.id limit 1) as plain_de
      from cand c
  )
  select p.tenant_id, p.action_key, p.wfa_de, p.plain_de
    into v_tenant, v_key, v_wfa_de, v_plain_de
    from pick p
   where p.wfa_de is not null and p.plain_de is not null
   order by p.tenant_id, p.action_key
   limit 1;

  if v_tenant is null then
    raise exception '693: no workspace in this database can prove the role rule in both directions (a reachable role-gated verb, one employee that may use it and one that may not) — an unproven ACCEPT is exactly the rejects-everything failure this must not ship';
  end if;

  select coalesce(nullif(de.persona_name, ''), de.name) into v_plain_name
    from public.digital_employees de where de.id = v_plain_de;

  -- Params come from the verdict's OWN schema, so the accept half cannot fail
  -- on rules (d)/(e) because this block guessed a different definition's shape
  -- than the validator chose.
  v_verdict := public.onboarding_verb_verdict(v_tenant, v_key);
  if not coalesce((v_verdict->>'reachable')::boolean, false) then
    raise exception '693: fixture verb "%" is not reachable for workspace % — the fixture query and onboarding_verb_verdict disagree about reachability, which means one of them is wrong', v_key, v_tenant;
  end if;
  select coalesce(jsonb_object_agg(s->>'name', '@ask'), '{}'::jsonb)
    into v_params
    from jsonb_array_elements(nullif(v_verdict->'param_schema', 'null'::jsonb)) s
   where coalesce((s->>'required')::boolean, false);
  v_need_role := v_verdict->>'required_roles';
  if v_need_role is null then
    raise exception '693: fixture verb "%" was selected as role-gated but the verdict names no required role — the fixture query and onboarding_verb_verdict disagree', v_key;
  end if;

  v_items := jsonb_build_array(
    jsonb_build_object('key', 'x', 'label', 'X', 'phase', 'config', 'owner_type', 'de',
                       'requires_signoff', false, 'action_key', v_key, 'params', v_params),
    jsonb_build_object('key', 'y', 'label', 'Y', 'phase', 'golive', 'owner_type', 'human',
                       'requires_signoff', false));

  ---------------------------------------------------------------------------
  -- A — NO DESK YET: the binding is ACCEPTED. This is the mig-643 half. If
  -- this fails, every fresh workspace is unable to publish a bound template
  -- and the feature is broken for exactly the customers who have not started.
  ---------------------------------------------------------------------------
  v_r_skip := public.validate_onboarding_items(v_items, v_tenant);
  if coalesce(array_length(v_r_skip, 1), 0) <> 0 then
    raise exception '693: workspace % has NO onboarding employee and the role-gated verb "%" was REJECTED anyway — a workspace that has not started onboarding yet can no longer publish: %', v_tenant, v_key, v_r_skip;
  end if;

  ---------------------------------------------------------------------------
  -- B — A DESK THAT CANNOT RUN IT: REJECTED, and the message must carry all
  -- four things an author needs — the item, the verb, the ROLE, and WHO.
  -- The watcher is inserted and rolled back.
  ---------------------------------------------------------------------------
  begin
    insert into public.work_watchers (tenant_id, de_id, kind, label, description, config, active)
    values (v_tenant, v_plain_de, 'state_condition',
            '693 fixture — rolled back', 'transient fixture for migration 693',
            jsonb_build_object('op', 'lt', 'field', 'progress_pct', 'value', '100',
                               'source', 'onboarding_projects'),
            true);
    v_r_reject := public.validate_onboarding_items(v_items, v_tenant);
    raise exception 'MIG693_ROLLBACK_FIXTURE';
  exception when others then
    if sqlerrm <> 'MIG693_ROLLBACK_FIXTURE' then raise; end if;
  end;

  -- All four facts, by content: the ITEM, the VERB, the ROLE THAT IS MISSING
  -- (its actual name, not the word "role"), and WHO lacks it. An author who
  -- gets three of the four cannot act on the message.
  if not exists (select 1 from unnest(v_r_reject) e
                  where e like '%"x"%'
                    and e like '%' || v_key || '%'
                    and e like '%' || v_need_role || '%'
                    and e like '%' || v_plain_name || '%') then
    raise exception '693: workspace % routes onboarding to "%", which may not use the role-gated verb "%" (needs "%") — and the binding was ACCEPTED, or rejected without naming the item, the verb, the role and who lacks it: %', v_tenant, v_plain_name, v_key, v_need_role, v_r_reject;
  end if;
  -- ...and it must be the ONLY complaint. The verb is connector-reachable and
  -- its params come from its own schema, so a second error would mean the
  -- rejection came from somewhere other than the role gate.
  if coalesce(array_length(v_r_reject, 1), 0) <> 1 then
    raise exception '693: the role rejection dragged unrelated errors along, so it is not what is being measured: %', v_r_reject;
  end if;

  ---------------------------------------------------------------------------
  -- C — A DESK THAT CAN RUN IT: ACCEPTED, with ZERO errors. Same workspace,
  -- same verb, different employee. A validator that rejected everything would
  -- pass B alone; only this half tells the two apart.
  ---------------------------------------------------------------------------
  begin
    insert into public.work_watchers (tenant_id, de_id, kind, label, description, config, active)
    values (v_tenant, v_wfa_de, 'state_condition',
            '693 fixture — rolled back', 'transient fixture for migration 693',
            jsonb_build_object('op', 'lt', 'field', 'progress_pct', 'value', '100',
                               'source', 'onboarding_projects'),
            true);
    v_r_accept := public.validate_onboarding_items(v_items, v_tenant);
    raise exception 'MIG693_ROLLBACK_FIXTURE';
  exception when others then
    if sqlerrm <> 'MIG693_ROLLBACK_FIXTURE' then raise; end if;
  end;

  if coalesce(array_length(v_r_accept, 1), 0) <> 0 then
    raise exception '693: workspace % routes onboarding to an employee that MAY use "%", and the binding was still REJECTED — the rule now blocks work that would actually run: %', v_tenant, v_key, v_r_accept;
  end if;

  ---------------------------------------------------------------------------
  -- D — THE OTHER ARM OF THE DESK. run_work_watchers is not the only thing
  -- that mints an onboarding_project objective: de-mission's approve path and
  -- request_de_task both route one directly, and neither creates a watcher.
  -- Without this, an employee who only ever received onboarding work by
  -- delegation would be invisible to the rule, and deleting the de_objectives
  -- arm would leave every assertion above still green.
  ---------------------------------------------------------------------------
  begin
    insert into public.de_objectives (tenant_id, de_id, title, description, entity_kind, entity_ref, status, priority)
    values (v_tenant, v_plain_de, '693 fixture — rolled back',
            'transient fixture for migration 693', 'onboarding_project',
            gen_random_uuid()::text, 'open', 3);
    v_r_objdesk := public.validate_onboarding_items(v_items, v_tenant);
    raise exception 'MIG693_ROLLBACK_FIXTURE';
  exception when others then
    if sqlerrm <> 'MIG693_ROLLBACK_FIXTURE' then raise; end if;
  end;

  if not exists (select 1 from unnest(v_r_objdesk) e
                  where e like '%"x"%' and e like '%' || v_need_role || '%'
                    and e like '%' || v_plain_name || '%') then
    raise exception '693: onboarding has been routed to "%" by a CASE rather than a watcher, and the role rule did not see that employee at all — the delegation and mission paths would go unchecked: %', v_plain_name, v_r_objdesk;
  end if;

  ---------------------------------------------------------------------------
  -- E — THE ROLE CHECK MUST ASK ONLY THE ROWS THE WORKSPACE CAN REACH.
  -- One action_key legitimately has several definitions, and they do NOT all
  -- carry the same requires_role: in production send_payment_reminder has six
  -- rows, four gated to 'finance' and two not. If the role check looked at
  -- every visible definition instead of only the reachable ones, a role-free
  -- row for a system this workspace does not own would excuse a reachable row
  -- it cannot use — accepted at publish, dead at runtime, which is this whole
  -- migration's failure mode wearing a different hat.
  --
  -- No live (tenant, verb) pair in either database has that shape (checked:
  -- zero rows in both), so the fixture is SYNTHESISED and rolled back — a
  -- role-free, tenant-scoped definition of the SAME verb in a category this
  -- workspace has no connected connector for. Without it this clause would be
  -- unpinned, and an unpinned clause is one nobody notices losing.
  select sc.key into v_free_cat
    from public.system_categories sc
   where not exists (select 1 from public.connectors c
                      where c.tenant_id = v_tenant and c.status = 'connected' and c.category = sc.key)
     and not exists (select 1 from public.action_definitions ad
                      where ad.scope = 'tenant' and ad.tenant_id = v_tenant
                        and ad.category = sc.key and ad.action_key = v_key)
   order by sc.key
   limit 1;

  if v_free_cat is null then
    raise notice '693: NOT EXERCISED HERE — workspace % has a connected connector in every catalogued category, so no unreachable definition of "%" can be synthesised and the reachable-rows-only clause of the role check is NOT pinned in this environment.', v_tenant, v_key;
  else
    begin
      insert into public.action_definitions (scope, tenant_id, category, action_key, label, description, provider, param_schema, requires_role, status)
      values ('tenant', v_tenant, v_free_cat, v_key, '693 fixture — rolled back',
              'transient fixture for migration 693', 'dreamteam', '[]'::jsonb, null, 'active');
      insert into public.work_watchers (tenant_id, de_id, kind, label, description, config, active)
      values (v_tenant, v_plain_de, 'state_condition',
              '693 fixture — rolled back', 'transient fixture for migration 693',
              jsonb_build_object('op', 'lt', 'field', 'progress_pct', 'value', '100',
                                 'source', 'onboarding_projects'),
              true);
      v_r_unreach := public.validate_onboarding_items(v_items, v_tenant);
      raise exception 'MIG693_ROLLBACK_FIXTURE';
    exception when others then
      if sqlerrm <> 'MIG693_ROLLBACK_FIXTURE' then raise; end if;
    end;

    if not exists (select 1 from unnest(v_r_unreach) e
                    where e like '%"x"%' and e like '%' || v_need_role || '%') then
      raise exception '693: a role-free definition of "%" in category "%" — which workspace % has NO connected connector for — excused the reachable definition it cannot use. The role check is reading rows the runtime would never offer: %', v_key, v_free_cat, v_tenant, v_r_unreach;
    end if;
  end if;

  -- Every fixture must really be gone. A leaked watcher would open real cases
  -- for a real employee on every tick, a leaked objective would wake one, and
  -- a leaked action_definition would appear in a tenant's verb picker.
  if exists (select 1 from public.work_watchers where label = '693 fixture — rolled back')
     or exists (select 1 from public.de_objectives where title = '693 fixture — rolled back')
     or exists (select 1 from public.action_definitions where label = '693 fixture — rolled back') then
    raise exception '693: a synthetic fixture survived the rollback — a migration must not leave a live router, a live case or a live verb behind';
  end if;

  raise notice '693: role rule proven four ways on workspace % / verb % — no desk ACCEPTS, a watcher desk that cannot ("%") REJECTS, a watcher desk that can ACCEPTS, a CASE-routed desk that cannot REJECTS', v_tenant, v_key, v_plain_name;

  ---------------------------------------------------------------------------
  -- THE REAL DEFECT, where the database still holds it. Environment-dependent
  -- by nature — it is one workspace's published template — so it SKIPS OUT
  -- LOUD rather than passing silently.
  ---------------------------------------------------------------------------
  select v.tenant_id, v.items into v_live_t, v_live
    from public.onboarding_template_versions v
    join public.onboarding_templates tpl on tpl.id = v.template_id and tpl.version = v.version
   where exists (select 1 from jsonb_array_elements(v.items) i
                  where coalesce(i->>'action_key', '') <> ''
                    and not coalesce((public.onboarding_verb_verdict(v.tenant_id, i->>'action_key')->>'role_ok')::boolean, false)
                    and coalesce((public.onboarding_verb_verdict(v.tenant_id, i->>'action_key')->>'desk_known')::boolean, false)
                    and coalesce((public.onboarding_verb_verdict(v.tenant_id, i->>'action_key')->>'reachable')::boolean, false))
   limit 1;
  if v_live_t is null then
    raise notice '693: NOT EXERCISED HERE — no CURRENT published template version in this database binds a verb its onboarding desk cannot use, so the live half is not pinned in this environment. The synthetic fixture above pins it unconditionally.';
  else
    v_r := public.validate_onboarding_items(v_live, v_live_t);
    if coalesce(array_length(v_r, 1), 0) = 0 then
      raise exception '693: the CURRENT published template of workspace % binds a verb its onboarding desk cannot use, and re-validating it produced NO errors — the rule does not fire on the very defect it was written for', v_live_t;
    end if;
    raise notice '693: live defect confirmed — re-validating the current published template of workspace % now reports: %', v_live_t, v_r;
  end if;

  ---------------------------------------------------------------------------
  -- mig 681's rules, re-asserted. A separate, non-role-gated fixture, because
  -- these must keep working for verbs that have no role requirement at all.
  ---------------------------------------------------------------------------
  select ad.action_key
    into v_ok_key
    from public.action_definitions ad
    join public.connectors c
      on c.tenant_id = v_tenant and c.status = 'connected' and c.category = ad.category
     and (ad.provider is null or ad.provider = c.provider or ad.provider = 'template')
   where ad.status = 'active' and ad.provider <> 'internal'
     and (ad.scope = 'platform' or (ad.scope = 'tenant' and ad.tenant_id = v_tenant))
     and exists (select 1 from jsonb_array_elements(ad.param_schema) s
                  where coalesce((s->>'required')::boolean, false))
     and not exists (select 1 from public.action_definitions ad2
                      where ad2.action_key = ad.action_key and ad2.status = 'active'
                        and ad2.requires_role is not null)
   order by ad.action_key
   limit 1;

  if v_ok_key is null then
    raise exception '693: this database has no reachable, role-free verb WITH a required parameter for workspace % — mig 674''s rules (c)-(e) would go unexercised, and an unexercised rule is one nobody notices losing', v_tenant;
  end if;

  v_verdict := public.onboarding_verb_verdict(v_tenant, v_ok_key);
  select coalesce(jsonb_object_agg(s->>'name', '@ask'), '{}'::jsonb), min(s->>'name')
    into v_ok_params, v_ok_req
    from jsonb_array_elements(nullif(v_verdict->'param_schema', 'null'::jsonb)) s
   where coalesce((s->>'required')::boolean, false);

  -- (accept) a reachable, role-free verb is still accepted with zero errors.
  v_r := public.validate_onboarding_items(
    jsonb_build_array(
      jsonb_build_object('key','x','label','X','phase','config','owner_type','de',
                         'requires_signoff',false,'action_key',v_ok_key,'params',v_ok_params),
      jsonb_build_object('key','y','label','Y','phase','golive','owner_type','human',
                         'requires_signoff',false)),
    v_tenant);
  if coalesce(array_length(v_r, 1), 0) <> 0 then
    raise exception '693: a reachable, role-free binding (%) was REJECTED — mig 681''s accept half no longer holds: %', v_ok_key, v_r;
  end if;

  -- (f) the same verb, a workspace with no connectors at all: exactly one
  -- error, the reachability one. Not the role one — with no desk AND no
  -- connector, reachability is what must speak.
  v_r := public.validate_onboarding_items(
    jsonb_build_array(
      jsonb_build_object('key','x','label','X','phase','config','owner_type','de',
                         'requires_signoff',false,'action_key',v_ok_key,'params',v_ok_params),
      jsonb_build_object('key','y','label','Y','phase','golive','owner_type','human',
                         'requires_signoff',false)),
    gen_random_uuid());
  if coalesce(array_length(v_r, 1), 0) <> 1
     or not (v_r[1] like '%"x"%' and v_r[1] like '%' || v_ok_key || '%' and v_r[1] like '%no connected%') then
    raise exception '693: a binding unreachable for a workspace with NO connectors was accepted, or rejected without naming the item and the verb, or dragged an unrelated error along: %', v_r;
  end if;

  -- (a) a binding on a human-owned item is rejected, for the owner_type reason.
  v_r := public.validate_onboarding_items(
    jsonb_build_array(
      jsonb_build_object('key','x','label','X','phase','config','owner_type','human',
                         'requires_signoff',false,'action_key',v_ok_key,'params',v_ok_params),
      jsonb_build_object('key','y','label','Y','phase','golive','owner_type','human',
                         'requires_signoff',false)),
    v_tenant);
  if not exists (select 1 from unnest(v_r) e where e like '%owner_type%') then
    raise exception '693: a binding on a human-owned item was accepted, or rejected for the wrong reason: %', v_r;
  end if;

  -- (b) an unknown action_key keeps mig 674's "not visible" wording, NOT the
  -- reachability or role wording — either would send an author off connecting
  -- a system, or changing a role, for a verb that does not exist.
  v_r := public.validate_onboarding_items(
    jsonb_build_array(
      jsonb_build_object('key','x','label','X','phase','config','owner_type','de',
                         'requires_signoff',false,'action_key','no_such_verb_at_all','params','{}'::jsonb),
      jsonb_build_object('key','y','label','Y','phase','golive','owner_type','human',
                         'requires_signoff',false)),
    v_tenant);
  if not exists (select 1 from unnest(v_r) e
                  where e like '%no_such_verb_at_all%' and e like '%no active action definition visible%') then
    raise exception '693: a binding to a nonexistent action_key was accepted, or no longer says the definition does not exist: %', v_r;
  end if;

  -- (c) a params value that is an object is rejected.
  v_r := public.validate_onboarding_items(
    jsonb_build_array(
      jsonb_build_object('key','x','label','X','phase','config','owner_type','de',
                         'requires_signoff',false,'action_key',v_ok_key,
                         'params', v_ok_params || jsonb_build_object(v_ok_req, jsonb_build_object('nested','object'))),
      jsonb_build_object('key','y','label','Y','phase','golive','owner_type','human',
                         'requires_signoff',false)),
    v_tenant);
  if not exists (select 1 from unnest(v_r) e where e like '%' || v_ok_req || '%' and e like '%scalar%') then
    raise exception '693: a non-scalar param value was accepted, or rejected for the wrong reason: %', v_r;
  end if;

  -- (d) a REQUIRED parameter left unnamed is rejected at publish time.
  v_r := public.validate_onboarding_items(
    jsonb_build_array(
      jsonb_build_object('key','x','label','X','phase','config','owner_type','de',
                         'requires_signoff',false,'action_key',v_ok_key,'params', v_ok_params - v_ok_req),
      jsonb_build_object('key','y','label','Y','phase','golive','owner_type','human',
                         'requires_signoff',false)),
    v_tenant);
  if not exists (select 1 from unnest(v_r) e where e like '%missing required parameter%' and e like '%' || v_ok_req || '%') then
    raise exception '693: a binding missing the REQUIRED param "%" was accepted, or rejected for the wrong reason: %', v_ok_req, v_r;
  end if;

  -- (e) a parameter the verb does not have is rejected.
  v_r := public.validate_onboarding_items(
    jsonb_build_array(
      jsonb_build_object('key','x','label','X','phase','config','owner_type','de',
                         'requires_signoff',false,'action_key',v_ok_key,
                         'params', v_ok_params || '{"zzz_not_a_real_param":"@ask"}'::jsonb),
      jsonb_build_object('key','y','label','Y','phase','golive','owner_type','human',
                         'requires_signoff',false)),
    v_tenant);
  if not exists (select 1 from unnest(v_r) e where e like '%zzz_not_a_real_param%') then
    raise exception '693: a binding naming a nonexistent parameter was accepted, or rejected for the wrong reason: %', v_r;
  end if;

  -- mig 685's phase vocabulary, and its bare-literal bug fix. The go-live rule
  -- is one of the four that could never report its own message.
  v_r := public.validate_onboarding_items(
    jsonb_build_array(
      jsonb_build_object('key','y','label','Y','phase','handoff','owner_type','human',
                         'requires_signoff',false)),
    v_tenant);
  if not exists (select 1 from unnest(v_r) e where e like '%go-live phase item%') then
    raise exception '693: the go-live rule stopped reporting (mig 685''s 22P02 bare-literal trap, or the rule itself): %', v_r;
  end if;
  if exists (select 1 from unnest(v_r) e where e like '%invalid phase%') then
    raise exception '693: phase "handoff" was rejected — mig 685''s sixth phase was lost: %', v_r;
  end if;

  -- A NULL tenant still raises, in BOTH functions, rather than returning a
  -- verdict nobody could have computed.
  v_raised := false;
  begin
    v_r := public.validate_onboarding_items(
      jsonb_build_array(jsonb_build_object('key','y','label','Y','phase','golive',
                                           'owner_type','human','requires_signoff',false)), null);
  exception when others then v_raised := true;
  end;
  if not v_raised then
    raise exception '693: validate_onboarding_items returned a verdict for a NULL tenant instead of raising';
  end if;

  v_raised := false;
  begin
    v_verdict := public.onboarding_verb_verdict(null, 'anything');
  exception when others then v_raised := true;
  end;
  if not v_raised then
    raise exception '693: onboarding_verb_verdict returned a verdict for a NULL tenant instead of raising';
  end if;

  ---------------------------------------------------------------------------
  -- GRANTS. Both directions on both functions, plus the callee the new path
  -- depends on. A `create or replace` PRESERVES an ACL, so the revoke above is
  -- the only thing standing between these and Supabase's default grants — and
  -- mig 658/678 both record a bare revoke taking service_role down with it.
  ---------------------------------------------------------------------------
  select has_function_privilege('anon', 'public.validate_onboarding_items(jsonb,uuid)', 'EXECUTE'),
         has_function_privilege('authenticated', 'public.validate_onboarding_items(jsonb,uuid)', 'EXECUTE'),
         has_function_privilege('service_role', 'public.validate_onboarding_items(jsonb,uuid)', 'EXECUTE'),
         has_function_privilege('authenticated', 'public.publish_onboarding_template(uuid)', 'EXECUTE'),
         has_function_privilege('anon', 'public.onboarding_verb_verdict(uuid,text)', 'EXECUTE'),
         has_function_privilege('service_role', 'public.onboarding_verb_verdict(uuid,text)', 'EXECUTE'),
         has_function_privilege('service_role', 'public.de_may_use_action(uuid,uuid,uuid)', 'EXECUTE')
    into v_anon, v_authed, v_service, v_pub_authed, v_verdict_a, v_verdict_s, v_dmua_svc;

  if v_anon then
    raise exception '693: anon can execute validate_onboarding_items — that is the internet';
  end if;
  if v_authed then
    raise exception '693: authenticated can execute validate_onboarding_items directly — it should only be reachable through publish_onboarding_template';
  end if;
  if not v_service then
    raise exception '693: service_role cannot execute validate_onboarding_items — the revoke stripped the one caller mig 674 deliberately kept';
  end if;
  if not v_pub_authed then
    raise exception '693: authenticated lost EXECUTE on publish_onboarding_template — no owner/admin can publish';
  end if;
  if v_verdict_a then
    raise exception '693: anon can execute onboarding_verb_verdict — it reads any workspace it is handed';
  end if;
  if has_function_privilege('authenticated', 'public.onboarding_verb_verdict(uuid,text)', 'EXECUTE') then
    raise exception '693: authenticated can execute onboarding_verb_verdict — a tenant id as a PARAMETER is the authorisation, and this function is handed one';
  end if;
  if not v_verdict_s then
    raise exception '693: service_role cannot execute onboarding_verb_verdict — validate_onboarding_items would fail on its direct-call path with a permission error that reads like a validator bug';
  end if;
  if not v_dmua_svc then
    raise exception '693: service_role cannot execute de_may_use_action — the same path breaks one call deeper';
  end if;

  -- The 1-arg signature must still be gone (mig 681), and the caller must
  -- still pass the tenant: everything above can be green while every real
  -- publish throws 42883.
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'validate_onboarding_items'
                and pg_get_function_identity_arguments(p.oid) = 'p_items jsonb') then
    raise exception '693: the 1-arg validate_onboarding_items(jsonb) is back — a second overload means the tenant-blind body is reachable again';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'publish_onboarding_template'
       and p.prosrc like '%validate_onboarding_items(v_tpl.items, v_tpl.tenant_id)%') then
    raise exception '693: publish_onboarding_template no longer passes the tenant to the validator — every publish would fail with "function does not exist"';
  end if;

  raise notice '693: role reachability enforced — no desk SKIPS (and says so), a desk that cannot run the verb REJECTS naming role and employee, a desk that can ACCEPTS; mig 674 rules (a)-(e), mig 681 rule (f) and mig 685''s phases all still hold; grants closed to anon+authenticated and open to service_role on both functions and on de_may_use_action';
end $$;

commit;
