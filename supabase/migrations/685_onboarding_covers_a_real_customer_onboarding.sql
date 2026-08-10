-- 685_onboarding_covers_a_real_customer_onboarding.sql
-- ==========================================================================
-- WHY: the starter onboarding checklist described the middle of an
-- implementation and nothing on either side of it. It began at "Kickoff call
-- held" — after the deal was already handed over, after somebody had already
-- decided who owns the customer, and without ever asking the customer what
-- they need — and it ended at "Go-live", as though a production cutover were
-- the end of onboarding rather than the moment support and success take over.
--
-- This is not a hypothetical gap. Two escalations are PENDING in production
-- against Grant Plastics Ltd. right now, and each names a step this template
-- did not have:
--
--   "Cannot find recorded requirements for Grant Plastics Ltd. Before
--    configuring any onboarding items, I need the documented customer
--    requirements (employee count, locations, leave rules, billing
--    preferences, custom needs). Per SOP: never assume defaults or copy
--    another customer's settings."          -> there was no DISCOVERY step
--
--   "No executive sponsor or day-to-day contact is recorded for Grant
--    Plastics Ltd. ... identify the account owner or relationship holder"
--                                           -> there was no OWNERSHIP step
--
-- The employee was right to stop in both cases. It stopped because the
-- checklist told it to configure things nobody had established. Adding these
-- steps is what turns a repeated escalation into a scheduled question.
--
-- ── THE PHASE VOCABULARY (enumerated, not guessed) ────────────────────────
-- A support/success handover happens AFTER go-live, so the five-phase
-- vocabulary needed a sixth. Every place it is encoded, found by reading the
-- live catalog (pg_proc/pg_views/pg_constraint for the phase LITERAL, not the
-- similarly-spelled target_golive column) and by grepping the app:
--
--   1. public.validate_onboarding_items  — the `not in (...)` allow-list
--                                          AND the "needs a golive item" rule
--   2. public.install_starter_onboarding_template  — seeded item list
--   3. public.provision_tenant_baseline_internal   — seeded item list AGAIN
--   4. src/lib/onboardingApi.ts — the OnboardingPhase union AND the PHASES
--      array AND currentPhase's hardcoded 'golive' fallback
--
-- There is NO check constraint on phase (verified against pg_constraint) and
-- no view encodes it. create_onboarding_project and get_de_worklists match a
-- naive '%golive%' grep only through the target_golive COLUMN — neither
-- carries the phase vocabulary. The UI (CustomerOnboardingLive.tsx) is
-- entirely PHASES-driven — the phase rail, the grouping, and the editor's
-- dropdown all iterate the array — so it needs no per-phase edit.
--
-- Adding a phase is purely additive to the validator: the allow-list widens,
-- and the "template needs at least one go-live phase item" rule is untouched
-- and still enforced (pinned below in both directions). No existing template
-- in any workspace can fail validation because of this change.
--
-- ── A PRE-EXISTING BUG, FOUND BY THE PIN THAT HAD TO PROVE THAT ───────────
-- Writing the pin for "the go-live rule survived" is what found that the rule
-- could never report at all. FOUR of the validator's rules append a BARE
-- STRING LITERAL to a text[]:
--
--     v_errors := v_errors || 'template needs at least one go-live phase item';
--
-- With an untyped literal, `text[] || unknown` resolves to anyarray||anyarray
-- rather than anyarray||anyelement, so Postgres tries to parse the message AS
-- an array and raises 22P02 "malformed array literal". Every OTHER rule in
-- this function appends format(...), which returns typed text and is fine —
-- which is exactly why nobody noticed.
--
-- Confirmed against the LIVE production function before changing anything
-- (read-only pg_temp probe, not inferred from reading the source):
--
--   no go-live item   -> THREW 22P02: malformed array literal: "template
--                        needs at least one go-live phase item"
--   empty items array -> THREW 22P02: ... "template needs at least 1 item"
--   empty item key    -> THREW 22P02: ... "every item needs a non-empty key"
--   CONTROL bad owner_type (format path) -> returned its message normally
--   CONTROL valid template               -> returned {} normally
--
-- Effect on users: publish was still REFUSED, so this never let a bad
-- template through — the failure was in the safe direction. But the caller
-- got a raised Postgres error instead of the structured errors[] list the
-- publish UI renders, so four of the validator's rules have never once shown
-- their message. The fix is `::text` on those four literals and nothing else.
-- It is in scope because this migration replaces this function anyway, and
-- because the pin the brief asked for — prove adding a phase does not break
-- the go-live rule — cannot be written while the rule throws instead of
-- answering. All four repaired branches are pinned below.
--
-- ── THE TWO SEED PATHS, MADE ONE ──────────────────────────────────────────
-- The starter item list was written out IN FULL in two different functions:
-- install_starter_onboarding_template (the "Install starter template" button)
-- and provision_tenant_baseline_internal (what a brand-new workspace gets).
-- They were byte-identical, and nothing checked that they stayed that way —
-- the "two paths, one counted" shape from the debt map. Editing the list in
-- one place and not the other would have given new tenants a different
-- onboarding from tenants who clicked the button, silently and forever.
--
-- Rather than assert the two copies agree, this migration deletes the second
-- copy: public.starter_onboarding_template() now holds the description and
-- the items ONCE, and both seed paths read it. Drift is no longer something
-- to detect; it is something that cannot be expressed.
--
-- ── WHAT IS DELIBERATELY *NOT* HERE: a "progress tracking" checkbox ───────
-- The founder's list named progress tracking alongside the other four. It is
-- not modelled as a checklist item, and that is a decision, not an omission.
--
-- Progress on an onboarding is already a COMPUTED property, in two places
-- that both derive from item state: onboarding_projects.progress_pct, and
-- currentPhase() which drives the phase rail on the project page. A "Progress
-- tracked" checkbox would be a box a human ticks that changes nothing, means
-- nothing, and — because it counts toward progress_pct itself — would make
-- the number it claims to track go up merely by being ticked. That is the
-- promise-with-no-mechanism this whole workstream exists to remove.
--
-- What IS a real, one-off, completable act is agreeing the plan and the
-- reporting cadence with the customer, so `onboarding_plan_agreed` is the
-- item that ships. The RECURRING half — actually sending a status update
-- every week — is a cadence, and a cadence belongs to a driver on a schedule
-- (the collections/dunning driver is the working example in this repo), not
-- to a one-off checklist row. That is recommended, not built here.
--
-- ── OWNER_TYPE IS SET HONESTLY ────────────────────────────────────────────
-- None of the six new items is marked `de`. That is not modesty; at runtime
-- de-work's perform_onboarding_item REFUSES any item whose owner_type is not
-- exactly 'de', so `de` is a promise that an employee will DO the thing, and
-- a bound verb is what makes it true. The verbs this workspace can actually
-- reach were read from the catalog before deciding (the mig 681 reachability
-- predicate, run for outsourcetel-hq): ERPNext customer/collections verbs,
-- Stripe documentation lookups, and platform_admin verbs like
-- book_appointment and hire_from_archetype. Not one of them gathers
-- requirements, assigns an internal owner, takes a sales handover, or briefs
-- a support team. `either` is used where a person normally acts but an
-- employee can genuinely record the outcome (record_onboarding_step works on
-- either/human items); `human` where only a person can decide. An item marked
-- `de` with no verb behind it is exactly the defect this plan has been
-- fixing, and there is a pin below that fails if a later edit introduces one.
--
-- ── TENANT SAFETY ─────────────────────────────────────────────────────────
-- Templates are PER-TENANT. Read before writing: 15 workspaces own a
-- "SaaS onboarding — starter", 14 of them byte-identical to the seed
-- (items md5 329f3c9522113a29ff8f4b067a6c866f) and published at v1, and
-- outsourcetel-hq's is a DRAFT at v3 carrying a verb binding on
-- locations_configured. Those 14 are NOT touched by this migration — a
-- published template is a version somebody's projects may be pinned to, and
-- rewriting it is destroying their work. outsourcetel-hq's draft is EXTENDED
-- IN PLACE by a key-wise merge: where a key already exists in the draft, the
-- draft's own item wins (bindings, edited labels, everything), and only
-- genuinely new keys are inserted. Any key in the draft that the canonical
-- list does not name is kept too. The binding is captured before the merge
-- and asserted after it, in the same block.
--
-- Nothing here re-points a project or publishes anything. Publishing requires
-- a signed-in owner/admin and is deliberately left as the founder's step; the
-- draft is prepared and validated, not shipped.
-- ==========================================================================

begin;

-- Snapshot the other tenants' templates BEFORE anything runs, so "we did not
-- touch them" is a comparison rather than an assurance.
create temporary table _685_before on commit drop as
select tpl.id, tpl.tenant_id, tpl.status, md5(tpl.items::text) as items_md5,
       jsonb_array_length(tpl.items) as n_items
from public.onboarding_templates tpl;

-- ── 1. ONE definition of the starter template ─────────────────────────────
-- Description and items together: both were duplicated across the two seed
-- paths, so both are single-sourced here.
create or replace function public.starter_onboarding_template()
returns jsonb
language sql
immutable
as $function$
  select jsonb_build_object(
    'description',
    '16-step implementation checklist: kickoff (sales handover, ownership, discovery) '
    '→ data → config → validation → go-live → support/success handoff. Sign-off gates '
    'on discovery, settings, leave rules, UAT, go-live, and the handover.',
    'items',
    $items$[
      {"key":"sales_handover","label":"Sales handover received","phase":"kickoff","owner_type":"human","requires_signoff":false,"description":"The deal team hands over what was actually sold: scope, commitments, promised dates, pricing, and the customer contacts. Delivery starts from what was promised, not from a guess."},
      {"key":"account_owner_assigned","label":"Internal account owner assigned","phase":"kickoff","owner_type":"human","requires_signoff":false,"description":"Name the person who owns this customer internally — the day-to-day contact and the executive sponsor. Nothing downstream has an owner until this does."},
      {"key":"kickoff_call","label":"Kickoff call held","phase":"kickoff","owner_type":"human","requires_signoff":false,"description":"Intro call: goals, timeline, points of contact."},
      {"key":"discovery_requirements","label":"Discovery — customer requirements documented","phase":"kickoff","owner_type":"either","requires_signoff":true,"description":"Employee count, locations, leave rules, billing preferences, and anything custom — written down against this account. Configuration must never assume defaults or copy another customer's settings, so this is signed off before any of it starts."},
      {"key":"onboarding_plan_agreed","label":"Onboarding plan and check-in cadence agreed","phase":"kickoff","owner_type":"human","requires_signoff":false,"description":"Milestones, target go-live, and how often we report progress to the customer. This is the one-off agreement; ongoing progress is computed from this checklist, not ticked off here."},
      {"key":"data_export_received","label":"Data export received from customer","phase":"data","owner_type":"either","requires_signoff":false,"description":"Customer sends their employee/location export (CSV or spreadsheet)."},
      {"key":"employees_imported","label":"Employees imported","phase":"data","owner_type":"de","requires_signoff":false,"description":"Employee records loaded and normalized in the platform."},
      {"key":"locations_configured","label":"Locations configured","phase":"config","owner_type":"de","requires_signoff":false,"description":"Sites, time zones, and operating hours set up."},
      {"key":"settings_review","label":"Account settings reviewed","phase":"config","owner_type":"human","requires_signoff":true,"description":"Human sign-off on core account configuration."},
      {"key":"leave_rules_configured","label":"Leave rules configured","phase":"config","owner_type":"either","requires_signoff":true,"description":"Accrual, carryover, and approval chains — needs human sign-off."},
      {"key":"test_scenario_run","label":"Test scenario run","phase":"validation","owner_type":"de","requires_signoff":false,"description":"End-to-end test with sample data."},
      {"key":"uat_approved","label":"UAT approved by customer","phase":"validation","owner_type":"human","requires_signoff":true,"description":"Customer confirms acceptance testing passed."},
      {"key":"training_session","label":"Training session delivered","phase":"golive","owner_type":"human","requires_signoff":false,"description":"Admin + end-user training completed."},
      {"key":"go_live","label":"Go-live","phase":"golive","owner_type":"human","requires_signoff":true,"description":"Production cutover — final human sign-off."},
      {"key":"post_golive_checkin","label":"Post-go-live check-in with the customer","phase":"handoff","owner_type":"either","requires_signoff":false,"description":"First check-in after cutover: confirm the customer is actually using it, catch anything that broke in production, and log what support needs to know."},
      {"key":"support_handoff","label":"Support and success handover","phase":"handoff","owner_type":"human","requires_signoff":true,"description":"Brief the support and success owners on the configuration, the quirks, and the open risks, and transfer day-to-day ownership. Onboarding is finished when someone else owns the customer, not when the system goes live."}
    ]$items$::jsonb
  );
$function$;

comment on function public.starter_onboarding_template() is
  'The starter onboarding template, defined ONCE. Both seed paths '
  '(install_starter_onboarding_template and provision_tenant_baseline_internal) '
  'read this; before mig 685 each carried its own full copy of the list and '
  'nothing checked that they agreed.';

revoke all on function public.starter_onboarding_template() from public, anon, authenticated;
grant execute on function public.starter_onboarding_template() to service_role;

-- ── 2. validate_onboarding_items — the phase allow-list gains 'handoff' ───
-- Body read live via pg_get_functiondef immediately before writing this and
-- reproduced verbatim; the ONLY change is 'handoff' in the phase allow-list
-- on the line marked below. The signature stays (jsonb, uuid) — mig 681
-- dropped the 1-arg form deliberately and a `create or replace` with a
-- different argument list would resurrect it as a second overload (42725).
create or replace function public.validate_onboarding_items(p_items jsonb, p_tenant_id uuid)
returns text[]
language plpgsql
stable
as $function$
declare
  v_errors      text[] := '{}';
  v_item        jsonb;
  v_verify      jsonb;
  v_keys        text[] := '{}';
  v_key         text;
  v_n           integer;
  v_match       text;
  v_action_key  text;
  v_params      jsonb;
  v_schema      jsonb;
  v_schema_item jsonb;
  v_pkey        text;
  v_pval        jsonb;
  v_category    text;
  v_reachable   boolean;
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
  -- ::text on these four literals is a BUG FIX, not a style change — see the
  -- header. Without it `text[] || <unknown literal>` resolves to
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

    -- ---- action binding rules (a)-(f); (a)-(e) from mig 674, (f) from 681 ----
    v_action_key := v_item->>'action_key';
    if v_action_key is not null and v_action_key <> '' then
      -- (a) an item that names a verb must be DE-owned; a human or "either"
      -- item cannot be bound to automated execution.
      if coalesce(v_item->>'owner_type', '') <> 'de' then
        v_errors := v_errors || format('item "%s" names an action but owner_type must be "de" to bind one', v_key);
      end if;

      -- (f) REACHABILITY (mig 681). Ask the strong question FIRST: is there an
      -- active definition for this key that this workspace can actually run?
      -- Predicate lifted verbatim from get_agentic_tools_for_de — see mig 681.
      -- Bind by key, never by id: ids differ per environment and the same key
      -- legitimately exists across several providers. Taking the schema from
      -- the REACHABLE definition (not just any visible one) also means rules
      -- (c)-(e) below check the params against the executor that will actually
      -- receive them.
      v_schema := null;
      v_category := null;
      select ad.param_schema, ad.category
        into v_schema, v_category
        from public.action_definitions ad
       where ad.action_key = v_action_key
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
       limit 1;
      v_reachable := v_schema is not null;

      if not v_reachable then
        -- (b) VISIBILITY, unchanged from mig 674 — still asked, but now only
        -- to tell the two failures apart, and to schema-check the params even
        -- on a binding that is going to be rejected (an author fixing the
        -- connector should not then discover a second, separate param error).
        select ad.param_schema, ad.category
          into v_schema, v_category
          from public.action_definitions ad
         where ad.action_key = v_action_key
           and ad.status = 'active'
           and (ad.tenant_id is null or ad.tenant_id = p_tenant_id)
         limit 1;

        if v_schema is null then
          v_errors := v_errors || format('item "%s" names action_key "%s" which has no active action definition visible to this workspace', v_key, v_action_key);
        else
          v_errors := v_errors || format('item "%s" names action_key "%s" but this workspace has no connected %s system that can run it — connect one, or bind a different verb', v_key, v_action_key, coalesce(v_category, 'matching'));
        end if;
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

  return v_errors;
end;
$function$;

-- Migs 610+630 rule (re-assert on replace): strip both default-grant
-- mechanisms, then hand back only what is needed. publish_onboarding_template
-- is SECURITY DEFINER owned by postgres and reaches this as the owner
-- regardless of grants; service_role keeps direct-call ability for scripts and
-- for the assertions below. No client ever RPCs this directly.
revoke all on function public.validate_onboarding_items(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.validate_onboarding_items(jsonb, uuid) to service_role;

-- ── 3. install_starter_onboarding_template — reads the single source ──────
-- Body otherwise verbatim from the live catalog; the inline v_items literal
-- and the inline description are replaced by the shared function.
create or replace function public.install_starter_onboarding_template()
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_tenant uuid;
  v_is_active boolean;
  v_tpl_id uuid;
  v_pub    jsonb;
  v_spec   jsonb := starter_onboarding_template();
begin
  select coalesce(is_active, true) into v_is_active from profiles where user_id = auth.uid() limit 1;
  if v_is_active is false then
    raise exception 'account is deactivated';
  end if;
  v_tenant := auth_tenant_id();
  if v_tenant is null then
    raise exception 'no tenant for caller';
  end if;

  select id into v_tpl_id from onboarding_templates
    where tenant_id = v_tenant and name = 'SaaS onboarding — starter' limit 1;
  if v_tpl_id is not null then
    return jsonb_build_object('template_id', v_tpl_id, 'already_installed', true);
  end if;

  insert into onboarding_templates (tenant_id, name, description, items)
  values (v_tenant, 'SaaS onboarding — starter',
          v_spec->>'description',
          v_spec->'items')
  returning id into v_tpl_id;

  v_pub := publish_onboarding_template(v_tpl_id);
  return jsonb_build_object('template_id', v_tpl_id, 'already_installed', false) || v_pub;
end;
$function$;

-- Client-callable RPC (src/lib/onboardingApi.ts installStarterTemplate), so
-- `authenticated` MUST keep EXECUTE — but `anon` must not, and on the DEV
-- project anon DID hold it before this migration (prod did not). A
-- `create or replace` preserves existing grants, so that hole would have
-- survived untouched; it is closed here and asserted below in both directions.
revoke all on function public.install_starter_onboarding_template() from public, anon;
grant execute on function public.install_starter_onboarding_template() to authenticated, service_role;

-- ── 4. provision_tenant_baseline_internal — reads the same single source ──
-- Body otherwise verbatim from the live catalog; only the onboarding-template
-- block changes, from an inlined copy of the item list to the shared function.
create or replace function public.provision_tenant_baseline_internal(p_tenant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare v_demo_tenant_id constant uuid := 'a0000000-0000-0000-0000-000000000001';
  v_tpl_id uuid; v_seeded_guardrails int := 0; v_seeded_template boolean := false;
  v_spec jsonb;
begin
  if p_tenant_id is null or p_tenant_id = v_demo_tenant_id then return jsonb_build_object('ok', false, 'error', 'refusing to provision null or the demo tenant'); end if;
  if not exists (select 1 from tenants where id = p_tenant_id) then return jsonb_build_object('ok', false, 'error', 'tenant not found'); end if;

  perform reconcile_tenant_feature(p_tenant_id, fr.key, true) from feature_registry fr where fr.default_enabled = true;

  insert into guardrail_rules (tenant_id, rule, rule_type, pattern, severity, applies_to, active)
  select p_tenant_id, r.rule, r.rule_type, r.pattern, r.severity, 'all', true
  from (values
    ('Explicit escalation demand', 'frustration_signal', 'speak to a manager|speak with a manager|this is unacceptable|totally unacceptable', 'warning'),
    ('Repeated-contact frustration', 'frustration_signal', 'third time i|already told you|i''ve asked this before|keep asking', 'warning'),
    ('Churn/cancellation threat', 'frustration_signal', 'cancel(l)?ing my (subscription|account|plan)|switching to a competitor|find another (provider|vendor)', 'warning'),
    ('Strong negative sentiment', 'frustration_signal', 'worst support|completely useless|waste of (my )?time|ridiculous that', 'warning'),
    ('No unilateral refund promises', 'blocked_phrase', 'refund', 'blocking'),
    ('No legal-threat language in outputs — route to a human', 'blocked_phrase', 'legal action|lawsuit|sue you|attorney|court|legally liable|garnish|seize your assets', 'blocking')
  ) as r(rule, rule_type, pattern, severity)
  where not exists (select 1 from guardrail_rules g where g.tenant_id = p_tenant_id and g.rule = r.rule);
  get diagnostics v_seeded_guardrails = row_count;

  if not exists (select 1 from guardrail_rules g where g.tenant_id = p_tenant_id and g.rule_type = 'require_approval_over_cents') then
    insert into guardrail_rules (tenant_id, rule, rule_type, threshold, severity, applies_to, active)
    values (p_tenant_id, 'Actions over $10,000 always require human approval', 'require_approval_over_cents', 1000000, 'blocking', 'all', true);
    v_seeded_guardrails := v_seeded_guardrails + 1;
  end if;

  if not exists (select 1 from onboarding_templates t where t.tenant_id = p_tenant_id and t.name = 'SaaS onboarding — starter') then
    -- mig 685: the item list used to be written out again, right here. It is
    -- now read from the one place that defines it.
    v_spec := starter_onboarding_template();
    insert into onboarding_templates (tenant_id, name, description, items)
    values (p_tenant_id, 'SaaS onboarding — starter', v_spec->>'description', v_spec->'items')
    returning id into v_tpl_id;
    insert into onboarding_template_versions (template_id, tenant_id, version, name, description, items, published_by)
    select v_tpl_id, p_tenant_id, 1, t.name, t.description, t.items, null from onboarding_templates t where t.id = v_tpl_id;
    update onboarding_templates set version = 1, status = 'published' where id = v_tpl_id;
    v_seeded_template := true;
  end if;

  -- mig 550: the Technical Specialist block that used to live here is GONE.
  -- Migration 512 retired that employee in all 15 existing workspaces after
  -- finding 2 consultations in the platform's entire history; seeding a new
  -- one into every new workspace contradicted that decision. 'specialist_
  -- seeded' is kept in the payload, always false, so callers do not break.

  -- mig 627: a new workspace gets its approval limits with everything else,
  -- from the same function that backfilled the existing ones.
  perform seed_approval_baseline(p_tenant_id);

  if v_seeded_guardrails > 0 or v_seeded_template then
    perform append_audit_event_internal(p_tenant_id, 'DreamTeam', 'system',
      format('Workspace baseline provisioned — %s starter guardrail(s)%s. Connectors are the remaining setup step (they need your own system credentials).',
        v_seeded_guardrails, case when v_seeded_template then ', starter onboarding template' else '' end),
      'config_change', jsonb_build_object('kind', 'tenant_baseline_provisioned', 'guardrails_seeded', v_seeded_guardrails, 'template_seeded', v_seeded_template));
  end if;
  return jsonb_build_object('ok', true, 'guardrails_seeded', v_seeded_guardrails, 'template_seeded', v_seeded_template, 'specialist_seeded', false);
end; $function$;

revoke all on function public.provision_tenant_baseline_internal(uuid) from public, anon, authenticated;
grant execute on function public.provision_tenant_baseline_internal(uuid) to service_role;

-- ── 5. Extend outsourcetel-hq's DRAFT in place, and prove nothing was lost ─
-- Key-wise merge: the draft's own item wins on every key it already has, so a
-- binding or an edited label survives by construction rather than by care.
-- Only genuinely new keys are inserted, in canonical order; any key the draft
-- has that the canonical list does not name is kept and appended.
do $$
declare
  v_tpl_id     uuid;
  v_old        jsonb;
  v_new        jsonb := '[]'::jsonb;
  v_canon      jsonb := public.starter_onboarding_template()->'items';
  v_item       jsonb;
  v_existing   jsonb;
  v_old_desc   text;
  v_bound_before int;
  v_bound_after  int;
  v_keys_lost  text[];
  v_binding    jsonb;
begin
  select tpl.id, tpl.items, tpl.description
    into v_tpl_id, v_old, v_old_desc
  from public.onboarding_templates tpl
  join public.tenants t on t.id = tpl.tenant_id
  where t.slug = 'outsourcetel-hq'
    and tpl.name = 'SaaS onboarding — starter'
    and tpl.status = 'draft'
  limit 1;

  if v_tpl_id is null then
    -- SKIP LOUDLY. On the dev project the slug may not exist at all; a silent
    -- pass here would look identical to a successful merge.
    raise notice '685 SKIPPED: no DRAFT "SaaS onboarding — starter" for tenant slug outsourcetel-hq in this database — nothing merged, and the merge assertions below did not run';
    return;
  end if;

  select count(*) into v_bound_before
  from jsonb_array_elements(v_old) i where i ? 'action_key';

  -- canonical order first, existing item wins on any shared key
  for v_item in select * from jsonb_array_elements(v_canon) loop
    select i into v_existing
      from jsonb_array_elements(v_old) i
     where i->>'key' = v_item->>'key'
     limit 1;
    v_new := v_new || jsonb_build_array(coalesce(v_existing, v_item));
    v_existing := null;
  end loop;

  -- ...then anything the draft has that the canonical list does not name. A
  -- tenant-authored item is work, and this migration does not delete work.
  for v_item in select * from jsonb_array_elements(v_old) loop
    if not exists (select 1 from jsonb_array_elements(v_canon) c where c->>'key' = v_item->>'key') then
      v_new := v_new || jsonb_build_array(v_item);
    end if;
  end loop;

  update public.onboarding_templates
     set items = v_new,
         -- Only refresh the description if it is still the stock string this
         -- repo seeded. If somebody edited it, that is their words, not ours.
         description = case
           when v_old_desc = '10-step implementation checklist: kickoff → data → config → validation → go-live. Sign-off gates on settings, leave rules, UAT, and go-live.'
             then public.starter_onboarding_template()->>'description'
           else v_old_desc
         end
   where id = v_tpl_id;

  -- ── assertions on the merge, in the block that performed it ─────────────
  -- (i) NOTHING WAS LOST: every key present before is present after.
  select coalesce(array_agg(k), '{}') into v_keys_lost
  from (
    select i->>'key' as k from jsonb_array_elements(v_old) i
    except
    select i->>'key' from jsonb_array_elements(v_new) i
  ) s;
  if array_length(v_keys_lost, 1) > 0 then
    raise exception '685: the merge DROPPED existing item key(s) from outsourcetel-hq''s draft: %', v_keys_lost;
  end if;

  -- (ii) EVERY BINDING SURVIVED — count, and then content.
  select count(*) into v_bound_after
  from jsonb_array_elements(v_new) i where i ? 'action_key';
  if v_bound_after <> v_bound_before then
    raise exception '685: outsourcetel-hq had % bound item(s) before the merge and % after', v_bound_before, v_bound_after;
  end if;

  if v_bound_before = 0 then
    raise notice '685 SKIPPED (partial): outsourcetel-hq''s draft carried NO verb binding in this database, so the binding-content assertion had nothing to check (the count assertion above still ran: 0 before, 0 after)';
  else
    select i into v_binding
      from jsonb_array_elements(v_new) i
     where i->>'key' = 'locations_configured' and i ? 'action_key';
    if v_binding is null then
      raise exception '685: the locations_configured verb binding is GONE from outsourcetel-hq''s draft after the merge';
    end if;
    if v_binding->>'action_key' <> 'configure_customer_setup' then
      raise exception '685: locations_configured is bound to "%" — expected configure_customer_setup', v_binding->>'action_key';
    end if;
    if not (v_binding->'params' @> '{"external_ref":"@account","territory":"@ask","default_price_list":"@ask","payment_terms":"@ask"}'::jsonb) then
      raise exception '685: the locations_configured binding lost parameters — params are now %', v_binding->'params';
    end if;
    raise notice '685: outsourcetel-hq binding SURVIVED intact — configure_customer_setup with external_ref/territory/default_price_list/payment_terms';
  end if;

  raise notice '685: outsourcetel-hq draft extended in place — % items before, % after, % binding(s) preserved',
    jsonb_array_length(v_old), jsonb_array_length(v_new), v_bound_after;
end $$;

-- ── 6. Verify ─────────────────────────────────────────────────────────────
do $$
declare
  v_tenant      uuid;
  v_items       jsonb := public.starter_onboarding_template()->'items';
  v_r           text[];
  v_n           int;
  v_missing     text[];
  v_de_items    text[];
  v_ok_handoff  jsonb;
  v_bad_phase   jsonb;
  v_only_handoff jsonb;
  v_many        jsonb;
  v_touched     int;
  v_anon        boolean;
  v_authed      boolean;
  v_service     boolean;
begin
  -- A tenant to validate against. Reachability needs a real workspace; any
  -- tenant will do because nothing in the shipped list binds a verb.
  select id into v_tenant from public.tenants order by created_at limit 1;
  if v_tenant is null then
    raise exception '685 CANNOT VERIFY: no tenants exist in this database — the validator assertions need a workspace and must not be skipped quietly';
  end if;

  -- ── PIN 1: the new phase is ACCEPTED. Half one of the required pair — a
  -- validator that rejects everything would pass PIN 2 and make the feature
  -- unusable.
  v_ok_handoff := '[
    {"key":"g","label":"G","phase":"golive","owner_type":"human","requires_signoff":false},
    {"key":"h","label":"H","phase":"handoff","owner_type":"human","requires_signoff":false}
  ]'::jsonb;
  v_r := public.validate_onboarding_items(v_ok_handoff, v_tenant);
  if coalesce(array_length(v_r, 1), 0) <> 0 then
    raise exception '685: a handoff-phase item was REJECTED — the new phase did not land: %', v_r;
  end if;

  -- ── PIN 2: an unknown phase is still REJECTED, by the phase rule
  -- specifically. Half two — proves the allow-list was WIDENED, not deleted.
  v_bad_phase := '[
    {"key":"g","label":"G","phase":"golive","owner_type":"human","requires_signoff":false},
    {"key":"x","label":"X","phase":"postgolive","owner_type":"human","requires_signoff":false}
  ]'::jsonb;
  v_r := public.validate_onboarding_items(v_bad_phase, v_tenant);
  if not exists (select 1 from unnest(v_r) e where e ilike '%"x"%' and e ilike '%invalid phase%') then
    raise exception '685: phase "postgolive" was ACCEPTED, or rejected for the wrong reason — the allow-list is no longer an allow-list: %', v_r;
  end if;

  -- ── PIN 3: the pre-existing go-live rule SURVIVED the phase addition. A
  -- template of handoff items with no go-live item must still be refused;
  -- this is the rule the brief warned adding a phase could quietly break.
  v_only_handoff := '[
    {"key":"h","label":"H","phase":"handoff","owner_type":"human","requires_signoff":false}
  ]'::jsonb;
  begin
    v_r := public.validate_onboarding_items(v_only_handoff, v_tenant);
  exception when others then
    raise exception '685: the go-live rule still THROWS % (%) instead of returning its message — this is the branch that could never report', sqlstate, sqlerrm;
  end;
  if not exists (select 1 from unnest(v_r) e where e ilike '%go-live%') then
    raise exception '685: a template with NO go-live item was accepted — adding the handoff phase broke the go-live rule: %', v_r;
  end if;

  -- ── PIN 3b: all FOUR bare-literal branches now RETURN their message
  -- instead of throwing 22P02. Each is checked by message content, so a
  -- branch that throws (the old behaviour) or reports the wrong thing fails.
  -- The go-live branch above is the fourth; the other three are here.
  begin
    v_r := public.validate_onboarding_items('[]'::jsonb, v_tenant);
  exception when others then
    raise exception '685: the empty-template rule still THROWS % (%) instead of returning its message', sqlstate, sqlerrm;
  end;
  if not exists (select 1 from unnest(v_r) e where e ilike '%at least 1 item%') then
    raise exception '685: an empty template did not report "needs at least 1 item": %', v_r;
  end if;

  begin
    v_r := public.validate_onboarding_items(
      '[{"key":"","label":"L","phase":"golive","owner_type":"human","requires_signoff":false}]'::jsonb,
      v_tenant);
  exception when others then
    raise exception '685: the empty-key rule still THROWS % (%) instead of returning its message', sqlstate, sqlerrm;
  end;
  if not exists (select 1 from unnest(v_r) e where e ilike '%non-empty key%') then
    raise exception '685: an item with an empty key did not report it: %', v_r;
  end if;

  -- 51 items — one over the cap. Built rather than typed out.
  begin
    select jsonb_agg(jsonb_build_object(
             'key', 'k' || g, 'label', 'L' || g, 'phase', 'golive',
             'owner_type', 'human', 'requires_signoff', false))
      into v_many
      from generate_series(1, 51) g;
    v_r := public.validate_onboarding_items(v_many, v_tenant);
  exception when others then
    raise exception '685: the 50-item cap still THROWS % (%) instead of returning its message', sqlstate, sqlerrm;
  end;
  if not exists (select 1 from unnest(v_r) e where e ilike '%exceed 50 items%') then
    raise exception '685: 51 items did not trip the 50-item cap: %', v_r;
  end if;

  -- ── PIN 4: the list we actually ship VALIDATES. Everything above can be
  -- green while the shipped template itself fails to publish.
  v_r := public.validate_onboarding_items(v_items, v_tenant);
  if coalesce(array_length(v_r, 1), 0) <> 0 then
    raise exception '685: the shipped starter template does not pass its own validator: %', v_r;
  end if;

  -- ── PIN 5: shape of the shipped list — the founder's five are present and
  -- the original ten were not dropped on the way.
  v_n := jsonb_array_length(v_items);
  if v_n <> 16 then
    raise exception '685: the starter template has % items, expected 16', v_n;
  end if;

  select coalesce(array_agg(k), '{}') into v_missing
  from unnest(array[
    -- the original ten, none of which may be lost
    'kickoff_call','data_export_received','employees_imported','locations_configured',
    'settings_review','leave_rules_configured','test_scenario_run','uat_approved',
    'training_session','go_live',
    -- the six new ones
    'sales_handover','account_owner_assigned','discovery_requirements',
    'onboarding_plan_agreed','post_golive_checkin','support_handoff'
  ]) k
  where not exists (select 1 from jsonb_array_elements(v_items) i where i->>'key' = k);
  if array_length(v_missing, 1) > 0 then
    raise exception '685: the starter template is missing item key(s): %', v_missing;
  end if;

  if not exists (select 1 from jsonb_array_elements(v_items) i where i->>'phase' = 'handoff') then
    raise exception '685: the starter template has no handoff-phase item — the post-go-live handover is the point of this migration';
  end if;

  -- ── PIN 6 (HONESTY RATCHET): none of the six new items may claim `de`.
  -- de-work refuses to PERFORM anything that is not owner_type 'de', so 'de'
  -- is a promise an employee will do the work, and only a bound verb makes it
  -- true. None of these six has one. If a later edit marks one 'de' without
  -- binding a verb, this fails.
  select coalesce(array_agg(i->>'key'), '{}') into v_de_items
  from jsonb_array_elements(v_items) i
  where i->>'owner_type' = 'de'
    and i->>'key' in ('sales_handover','account_owner_assigned','discovery_requirements',
                      'onboarding_plan_agreed','post_golive_checkin','support_handoff')
    and not (i ? 'action_key');
  if array_length(v_de_items, 1) > 0 then
    raise exception '685: item(s) % are marked owner_type "de" with no action_key — a DE-owned item with no verb behind it is a promise with no mechanism', v_de_items;
  end if;

  -- ── PIN 7: ONE definition, not two. Both seed paths must READ the shared
  -- function, and neither may still carry its own copy of the list.
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'install_starter_onboarding_template'
                    and p.prosrc like '%starter_onboarding_template()%') then
    raise exception '685: install_starter_onboarding_template does not read the shared definition';
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'provision_tenant_baseline_internal'
                    and p.prosrc like '%starter_onboarding_template()%') then
    raise exception '685: provision_tenant_baseline_internal does not read the shared definition — a new workspace would get a different onboarding from one that clicked the button, which is exactly the drift this removes';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public'
                and p.proname in ('install_starter_onboarding_template', 'provision_tenant_baseline_internal')
                and p.prosrc like '%"key":"kickoff_call"%') then
    raise exception '685: a seed path still carries its own inlined copy of the item list — two paths, one counted';
  end if;

  -- ── PIN 8: the other tenants were NOT touched. Compared against the
  -- snapshot taken before anything ran, not asserted from intent.
  select count(*) into v_touched
  from public.onboarding_templates tpl
  join _685_before b on b.id = tpl.id
  join public.tenants t on t.id = tpl.tenant_id
  where md5(tpl.items::text) <> b.items_md5
    and not (t.slug = 'outsourcetel-hq' and tpl.name = 'SaaS onboarding — starter');
  if v_touched > 0 then
    raise exception '685: % template(s) outside outsourcetel-hq''s starter draft were modified — published templates other workspaces'' projects may be pinned to must not be rewritten', v_touched;
  end if;
  if not exists (select 1 from _685_before) then
    raise exception '685: the before-snapshot is empty, so PIN 8 compared nothing — a check that cannot fail is theatre';
  end if;

  -- ── PIN 9: grants, END STATE, both directions. A revoke statement is not a
  -- description of the resulting privileges (mig 658).
  select has_function_privilege('anon', 'public.validate_onboarding_items(jsonb,uuid)', 'EXECUTE'),
         has_function_privilege('authenticated', 'public.validate_onboarding_items(jsonb,uuid)', 'EXECUTE'),
         has_function_privilege('service_role', 'public.validate_onboarding_items(jsonb,uuid)', 'EXECUTE')
    into v_anon, v_authed, v_service;
  if v_anon or v_authed then
    raise exception '685: validate_onboarding_items reachable by anon=% authenticated=% — it is only meant to be reached through publish_onboarding_template', v_anon, v_authed;
  end if;
  if not v_service then
    raise exception '685: service_role lost EXECUTE on validate_onboarding_items — the revoke took the only legitimate direct caller with it (mig 658''s failure mode)';
  end if;

  select has_function_privilege('anon', 'public.starter_onboarding_template()', 'EXECUTE'),
         has_function_privilege('authenticated', 'public.starter_onboarding_template()', 'EXECUTE'),
         has_function_privilege('service_role', 'public.starter_onboarding_template()', 'EXECUTE')
    into v_anon, v_authed, v_service;
  if v_anon or v_authed then
    raise exception '685: starter_onboarding_template reachable by anon=% authenticated=%', v_anon, v_authed;
  end if;
  if not v_service then
    raise exception '685: service_role cannot execute starter_onboarding_template';
  end if;

  select has_function_privilege('anon', 'public.install_starter_onboarding_template()', 'EXECUTE'),
         has_function_privilege('authenticated', 'public.install_starter_onboarding_template()', 'EXECUTE'),
         has_function_privilege('service_role', 'public.install_starter_onboarding_template()', 'EXECUTE')
    into v_anon, v_authed, v_service;
  if v_anon then
    raise exception '685: anon can execute install_starter_onboarding_template — that is the internet seeding templates';
  end if;
  if not v_authed then
    raise exception '685: authenticated LOST EXECUTE on install_starter_onboarding_template — that is the "Install starter template" button, and the revoke just broke it';
  end if;
  if not v_service then
    raise exception '685: service_role cannot execute install_starter_onboarding_template';
  end if;

  select has_function_privilege('anon', 'public.provision_tenant_baseline_internal(uuid)', 'EXECUTE'),
         has_function_privilege('authenticated', 'public.provision_tenant_baseline_internal(uuid)', 'EXECUTE'),
         has_function_privilege('service_role', 'public.provision_tenant_baseline_internal(uuid)', 'EXECUTE')
    into v_anon, v_authed, v_service;
  if v_anon or v_authed then
    raise exception '685: provision_tenant_baseline_internal reachable by anon=% authenticated=% — a tenant-provisioning function must not be client-callable', v_anon, v_authed;
  end if;
  if not v_service then
    raise exception '685: service_role cannot execute provision_tenant_baseline_internal — new workspaces would stop being provisioned';
  end if;

  raise notice '685: handoff phase ACCEPTED and unknown phase still REJECTED; go-live rule intact; shipped 16-item list validates; all 10 original + 6 new keys present; no new item claims "de" without a verb; one definition read by both seed paths; % other template(s) modified; grants asserted in both directions on all four functions', v_touched;
end $$;

commit;
