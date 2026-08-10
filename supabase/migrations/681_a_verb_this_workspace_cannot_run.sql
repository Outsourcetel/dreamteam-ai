-- 681_a_verb_this_workspace_cannot_run.sql
-- ==========================================================================
-- WHY: mig 674 let an onboarding checklist item name a verb (action_key) a
-- digital employee performs, and claimed to stop anyone binding a verb their
-- workspace cannot run. It does not. Its rule (b) checks only that an ACTIVE
-- action_definition exists and is VISIBLE to the tenant:
--
--     and (ad.tenant_id is null or ad.tenant_id = public.auth_tenant_id())
--
-- Platform actions carry tenant_id IS NULL, so they are visible to EVERY
-- tenant. 66 of the 75 definitions in production are platform-scope. A
-- workspace with no Stripe connector could bind a Stripe verb, publish green,
-- and have the employee fail at runtime in front of a customer. The certify
-- Ring-0 probe `onboarding-bindings-are-runnable` carried the identical
-- predicate and the identical hole, while its `why` claimed it prevented "a
-- promise that breaks at 2am". Both are fixed here.
--
-- ── WHY THE SIGNATURE CHANGES (p_items) -> (p_items, p_tenant_id) ─────────
-- The tenant had to become a parameter before reachability could be checked
-- at all. Read from the live catalog, mig 674 resolves it implicitly:
--
--     ... and (ad.tenant_id is null or ad.tenant_id = public.auth_tenant_id())
--
-- and auth_tenant_id() is a pure function of auth.uid() — it reads
-- profiles.user_id = auth.uid(), falling back to a platform_access_events
-- row for the same uid. It returns NULL for any caller without a JWT
-- (service_role, an edge function using the service key, cron, psql, and the
-- DO block in mig 674 itself). SECURITY DEFINER changes the PRIVILEGE the
-- body runs with, never the auth context, so being called from inside
-- publish_onboarding_template (SECURITY DEFINER, owned by postgres) does not
-- supply one; verified against the live definitions of both functions.
--
-- Was that already broken? For the real caller, no — and that is worth
-- stating precisely rather than implying a bug that is not there.
-- publish_onboarding_template is the ONLY caller in the database (checked by
-- scanning every pg_proc.prosrc and pg_views.definition) and the only caller
-- in the app (src/lib/onboardingApi.ts, a browser supabase.rpc from an
-- authenticated user). It refuses before it ever reaches the validator:
--
--     if not (v_tpl.tenant_id = auth_tenant_id()
--             and auth_has_tenant_role(array['tenant_owner','tenant_admin']))
--       then raise exception ...
--
-- and auth_has_tenant_role is likewise auth.uid()-driven, so a NULL-uid
-- caller returns false, the AND is false, and the publish is refused. No
-- production publish has ever reached mig 674's check with a NULL tenant.
--
-- What WAS silently wrong is narrower and still worth recording: on any
-- DIRECT call with no JWT, auth_tenant_id() is NULL and rule (b) degenerates
-- to "platform definitions pass, tenant definitions never do". That is
-- exactly the context mig 674's own six assertions ran in, so its
-- "a valid binding is ACCEPTED" assertion passed only because its fixture
-- verb (configure_customer_setup) happens to be platform-scope. The
-- tenant-scoped branch of its own rule was never exercised by its own pins.
--
-- Leaving the tenant implicit would have been worse after this change, not
-- merely untidy: a NULL tenant matches NO connectors, so the new reachability
-- rule would reject EVERY binding on any direct call — silently permissive
-- turning into silently total-refusal. The tenant is now named by the caller
-- that already knows it (publish_onboarding_template holds v_tpl.tenant_id
-- and has already proved it equals auth_tenant_id()), and a NULL tenant is a
-- hard RAISE rather than a guess in either direction.
--
-- DROP before CREATE, deliberately. `create or replace` with a different
-- argument list creates a SECOND OVERLOAD (this repo has been bitten by
-- error 42725), and worse here: the old 1-arg body would survive and keep
-- answering, so the fix would be invisible while looking applied. One
-- signature only. `drop ... if exists` without CASCADE, so any dependency
-- nobody knew about raises instead of being quietly dropped with it.
-- Grants do NOT survive a drop, so they are re-issued and asserted below.
--
-- ── WHAT "REACHABLE" MEANS — one definition, not a third one ──────────────
-- Lifted verbatim from the live body of get_agentic_tools_for_de, which is
-- what actually decides the tool list a DE is offered, and mirrored by
-- src/pages/tenant/entity/onboarding/VerbBinding.tsx at the picker:
--   a CONNECTED connector belonging to this tenant, whose category matches
--   the action's category and whose provider matches the action's provider
--   (or the action's provider is null / the generic 'template' provider),
--   with provider='internal' actions excluded outright.
-- Category alone is not enough — that is the bug get_agentic_tools_for_de
-- already carries a comment about: matching on category offered an
-- ERPNext-connected employee the Stripe/QuickBooks/Xero verbs in the same
-- erp_financials category, which could only ever fail.
--
-- Two notes on copying it verbatim rather than "improving" it:
--   · `ad.provider <> 'internal'` is NULL when provider IS NULL, so the
--     `ad.provider is null` branch in the next clause is unreachable in SQL's
--     three-valued logic. It is kept anyway: 0 of 75 (prod) and 0 of 66 (dev)
--     definitions have a NULL provider, so it changes nothing today, and three
--     definitions of "reachable" that disagree would be worse than the gap.
--   · the scope clause is `(scope = 'platform' or (scope = 'tenant' and
--     tenant_id = <tenant>))`, where mig 674 used `tenant_id is null or
--     tenant_id = <tenant>`. Both forms are kept, for different jobs: the
--     scope form for the reachability lookup (verbatim from
--     get_agentic_tools_for_de), the tenant_id form for the fallback lookup
--     (verbatim from mig 674, so its error message and behaviour are
--     unchanged). They agree on every live row in both environments —
--     scope='platform' with a non-null tenant_id: 0; scope='tenant' with a
--     null tenant_id: 0 — checked in dev and production before writing this.
--
-- ── THE TENSION: publish-time validation is a COURTESY, not a guarantee ────
-- A connector can be disconnected the minute after a template is published,
-- and this check cannot do anything about that. The runtime already handles
-- it properly and by design: an unreachable verb is simply not in the DE's
-- tool list, and de-work's perform_onboarding_item records the item blocked
-- and opens a human escalation rather than retrying (mig 674 Task 5,
-- Refusals 3-5). So this rule buys the template AUTHOR an answer at the
-- moment they can still act on it — nothing more, and it must not be
-- described as more.
--
-- The accepted cost: re-publishing an EXISTING template now fails if a
-- connector was disconnected since it was last published. That is the right
-- trade. Publishing is a deliberate act by an owner/admin, the error names
-- the item, the verb and the missing system, and the two fixes (reconnect the
-- connector, or unbind the verb) are both things that person can do. The
-- alternative — grandfathering bindings that were reachable once — would mean
-- the validator's answer depended on history nobody can see, and would let a
-- template that cannot run today publish green today.
--
-- No backfill, and no existing template can break: across production and dev,
-- ZERO onboarding_template_versions items and ZERO onboarding_templates draft
-- items carry an action_key at all (0 of 16 versions in prod, 0 of 317 in
-- dev). Verified immediately before writing this, not assumed.
-- ==========================================================================

begin;

drop function if exists public.validate_onboarding_items(jsonb);

create function public.validate_onboarding_items(p_items jsonb, p_tenant_id uuid)
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
  if v_n < 1 then v_errors := v_errors || 'template needs at least 1 item'; end if;
  if v_n > 50 then v_errors := v_errors || 'template cannot exceed 50 items'; end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_key := coalesce(v_item->>'key', '');
    if v_key = '' then
      v_errors := v_errors || 'every item needs a non-empty key';
    elsif v_key = any(v_keys) then
      v_errors := v_errors || format('duplicate item key "%s"', v_key);
    end if;
    v_keys := v_keys || v_key;
    if coalesce(v_item->>'label', '') = '' then
      v_errors := v_errors || format('item "%s" needs a label', v_key);
    end if;
    if coalesce(v_item->>'phase', '') not in ('kickoff', 'data', 'config', 'validation', 'golive') then
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

    -- ---- action binding rules (a)-(f); (a)-(e) from mig 674, (f) new here ----
    v_action_key := v_item->>'action_key';
    if v_action_key is not null and v_action_key <> '' then
      -- (a) an item that names a verb must be DE-owned; a human or "either"
      -- item cannot be bound to automated execution.
      if coalesce(v_item->>'owner_type', '') <> 'de' then
        v_errors := v_errors || format('item "%s" names an action but owner_type must be "de" to bind one', v_key);
      end if;

      -- (f) REACHABILITY (mig 681). Ask the strong question FIRST: is there an
      -- active definition for this key that this workspace can actually run?
      -- Predicate lifted verbatim from get_agentic_tools_for_de — see header.
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
    v_errors := v_errors || 'template needs at least one go-live phase item';
  end if;

  return v_errors;
end;
$function$;

-- The one caller, updated for the new signature. It already holds the tenant
-- and has already proved it equals auth_tenant_id() two statements earlier;
-- passing it is strictly more honest than having the validator re-derive it
-- from an auth context it may not have. Body otherwise byte-identical to the
-- live definition read immediately before writing this. `create or replace`
-- (same signature) preserves this function's existing ACL — asserted below.
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

-- Migs 610+630 rule: strip BOTH default-grant mechanisms. A DROP discards the
-- old ACL, so this is not a re-assert — it is the only thing standing between
-- the new function and Supabase's default privileges. mig 678 found that a
-- bare revoke would also have stripped service_role, which mig 674
-- deliberately left as the one role able to call this directly (scripts and
-- tests; no client ever RPCs it). Preserved and asserted, both directions.
revoke all on function public.validate_onboarding_items(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.validate_onboarding_items(jsonb, uuid) to service_role;

-- ── Verify ────────────────────────────────────────────────────────────────
-- Both directions, always: a REACHABLE binding is ACCEPTED and an UNREACHABLE
-- one is REJECTED. A validator that rejects everything would pass the second
-- half alone and make the feature unusable, which is the specific way this
-- fix could go wrong.
--
-- Fixtures are DERIVED from the live catalog, never hardcoded. mig 674 pinned
-- 'configure_customer_setup', which is reachable in production (one ERPNext
-- connector, tenant 5bb802e1) and reachable in NO tenant of the dev project —
-- a hardcoded fixture would have made this migration un-appliable in dev, and
-- "the accept assertion did not run there" is how a rejects-everything
-- validator ships.
--
-- Every fixture resolves at ACTION_KEY level, not per definition row, because
-- that is the level the validator works at. One action_key legitimately has
-- several provider rows (send_payment_reminder exists under erpnext,
-- quickbooks, stripe AND xero) and the validator accepts the key if ANY of
-- them is reachable. A fixture picked per-row would have selected the xero row
-- of a key whose erpnext row is reachable, and the "must be rejected"
-- assertions would have failed against correct behaviour.
do $$
declare
  v_tenant         uuid;
  v_key            text;
  v_schema         jsonb;
  v_params         jsonb;
  v_req            text;
  v_unreach_key    text;
  v_unreach_params jsonb;
  v_pm_tenant      uuid;
  v_pm_key         text;
  v_pm_params      jsonb;
  v_pm_provider    text;
  v_st_tenant      uuid;
  v_st_key         text;
  v_st_params      jsonb;
  v_r              text[];
  v_raised         boolean;
  v_anon_exec      boolean;
  v_authed_exec    boolean;
  v_service_exec   boolean;
  v_pub_authed     boolean;
begin
  ---------------------------------------------------------------------------
  -- FIXTURE — ONE workspace that can prove BOTH directions:
  --   (A) it CAN reach some platform verb that has a REQUIRED param  -> ACCEPT
  --   (B) it CANNOT reach some platform verb whose PROVIDER it does match, so
  --       the only thing making that verb unreachable is the CATEGORY -> REJECT
  --
  -- (B) is fussier than it looks, and the fussiness is load-bearing. An
  -- earlier draft of this migration picked the reject verb by "not reachable"
  -- alone, and got one whose provider ALSO failed to match — so deleting
  -- `c.category = ad.category` from the predicate left that assertion still
  -- passing. The mutant survived. This constraint is what kills it.
  --
  -- Using one workspace for both halves is also what makes them a pair: the
  -- same workspace accepts one verb and rejects another, which no single-
  -- direction fixture can demonstrate.
  ---------------------------------------------------------------------------
  select q.tid into v_tenant from (
    select c.tenant_id as tid
      from public.action_definitions ad
      join public.connectors c
        on c.status = 'connected'
       and c.category = ad.category
     where ad.status = 'active' and ad.scope = 'platform' and ad.provider <> 'internal'
       and (ad.provider is null or ad.provider = c.provider or ad.provider = 'template')
       and exists (select 1 from jsonb_array_elements(ad.param_schema) s
                    where coalesce((s->>'required')::boolean, false))
    intersect
    select c.tenant_id as tid
      from public.action_definitions ad
      join public.connectors c
        on c.status = 'connected'
       and (ad.provider is null or ad.provider = c.provider or ad.provider = 'template')
     where ad.status = 'active' and ad.scope = 'platform' and ad.provider <> 'internal'
       and not exists (
         select 1
           from public.action_definitions ad2
           join public.connectors c2
             on c2.tenant_id = c.tenant_id
            and c2.status = 'connected'
            and c2.category = ad2.category
          where ad2.action_key = ad.action_key
            and ad2.status = 'active'
            and ad2.provider <> 'internal'
            and (ad2.provider is null or ad2.provider = c2.provider or ad2.provider = 'template')
            and (ad2.scope = 'platform' or (ad2.scope = 'tenant' and ad2.tenant_id = c.tenant_id)))
  ) q order by q.tid limit 1;

  if v_tenant is null then
    raise exception '681: no workspace in this database can prove both directions (one reachable verb with a required param, and one unreachable only by category) — and an unproven ACCEPT is exactly the rejects-everything failure this must not ship';
  end if;

  select ad.action_key, ad.param_schema
    into v_key, v_schema
    from public.action_definitions ad
    join public.connectors c
      on c.tenant_id = v_tenant
     and c.status = 'connected'
     and c.category = ad.category
   where ad.status = 'active' and ad.scope = 'platform' and ad.provider <> 'internal'
     and (ad.provider is null or ad.provider = c.provider or ad.provider = 'template')
     and exists (select 1 from jsonb_array_elements(ad.param_schema) s
                  where coalesce((s->>'required')::boolean, false))
   order by ad.action_key
   limit 1;

  select coalesce(jsonb_object_agg(s->>'name', '@ask'), '{}'::jsonb), min(s->>'name')
    into v_params, v_req
    from jsonb_array_elements(v_schema) s
   where coalesce((s->>'required')::boolean, false);

  ---------------------------------------------------------------------------
  -- HALF ONE — a REACHABLE binding is ACCEPTED, with ZERO errors.
  ---------------------------------------------------------------------------
  v_r := public.validate_onboarding_items(
    jsonb_build_array(
      jsonb_build_object('key','x','label','X','phase','config','owner_type','de',
                         'requires_signoff',false,'action_key',v_key,'params',v_params),
      jsonb_build_object('key','y','label','Y','phase','golive','owner_type','human',
                         'requires_signoff',false)),
    v_tenant);
  if coalesce(array_length(v_r, 1), 0) <> 0 then
    raise exception '681: a REACHABLE binding (% for workspace %) was REJECTED — the feature is now unusable: %', v_key, v_tenant, v_r;
  end if;

  ---------------------------------------------------------------------------
  -- HALF TWO (i) — the SAME verb, a workspace with no connectors at all.
  -- Pins the connector join and the c.tenant_id clause. Exactly ONE error is
  -- expected: the verb is platform-scope so it stays VISIBLE and its params
  -- are still valid, so anything else firing would mean the rejection came
  -- from somewhere other than reachability.
  ---------------------------------------------------------------------------
  v_r := public.validate_onboarding_items(
    jsonb_build_array(
      jsonb_build_object('key','x','label','X','phase','config','owner_type','de',
                         'requires_signoff',false,'action_key',v_key,'params',v_params),
      jsonb_build_object('key','y','label','Y','phase','golive','owner_type','human',
                         'requires_signoff',false)),
    gen_random_uuid());
  if coalesce(array_length(v_r, 1), 0) <> 1
     or not (v_r[1] like '%"x"%' and v_r[1] like '%' || v_key || '%' and v_r[1] like '%no connected%') then
    raise exception '681: a binding unreachable for a workspace with NO connectors was accepted, or rejected without naming the item and the verb, or dragged an unrelated error along: %', v_r;
  end if;

  ---------------------------------------------------------------------------
  -- HALF TWO (ii) — CATEGORY clause. The SAME workspace that accepted HALF
  -- ONE, and a verb whose provider it DOES match but whose category it has no
  -- connected connector for. Deleting `c.category = ad.category` makes this
  -- verb reachable and turns this assertion red; nothing else here does.
  ---------------------------------------------------------------------------
  select ad.action_key,
         coalesce((select jsonb_object_agg(s->>'name', '@ask')
                     from jsonb_array_elements(ad.param_schema) s
                    where coalesce((s->>'required')::boolean, false)), '{}'::jsonb)
    into v_unreach_key, v_unreach_params
    from public.action_definitions ad
    join public.connectors c
      on c.tenant_id = v_tenant
     and c.status = 'connected'
     and (ad.provider is null or ad.provider = c.provider or ad.provider = 'template')
   where ad.status = 'active' and ad.scope = 'platform' and ad.provider <> 'internal'
     and not exists (
       select 1
         from public.action_definitions ad2
         join public.connectors c2
           on c2.tenant_id = v_tenant
          and c2.status = 'connected'
          and c2.category = ad2.category
        where ad2.action_key = ad.action_key
          and ad2.status = 'active'
          and ad2.provider <> 'internal'
          and (ad2.provider is null or ad2.provider = c2.provider or ad2.provider = 'template')
          and (ad2.scope = 'platform' or (ad2.scope = 'tenant' and ad2.tenant_id = v_tenant)))
   order by ad.action_key
   limit 1;

  if v_unreach_key is null then
    raise exception '681: the fixture workspace has no verb unreachable ONLY by category — the category clause would go unpinned, and an unpinned clause is one nobody notices losing';
  end if;

  v_r := public.validate_onboarding_items(
    jsonb_build_array(
      jsonb_build_object('key','x','label','X','phase','config','owner_type','de',
                         'requires_signoff',false,'action_key',v_unreach_key,'params',v_unreach_params),
      jsonb_build_object('key','y','label','Y','phase','golive','owner_type','human',
                         'requires_signoff',false)),
    v_tenant);
  if not exists (select 1 from unnest(v_r) e
                  where e like '%"x"%' and e like '%' || v_unreach_key || '%' and e like '%no connected%') then
    raise exception '681: verb "%" is in a category workspace % has NO connected connector for, and it was accepted (or rejected for the wrong reason): %', v_unreach_key, v_tenant, v_r;
  end if;

  ---------------------------------------------------------------------------
  -- HALF TWO (iii) — PROVIDER clause. A workspace that HAS a connected
  -- connector in the verb's category, but of a different provider. This is
  -- the ERPNext-workspace-offered-the-Stripe-verb case the clause exists for.
  -- It picks its own workspace, to widen the chance a database can supply it.
  --
  -- HONEST COVERAGE NOTE: environment-dependent. Production supplies it
  -- (tenant 5bb802e1 has erpnext/erp_financials connected, and log_invoice_note
  -- exists in that category only under xero). The dev project supplies no such
  -- pair across any of its 155 tenants. Rather than skip silently the
  -- else-branch says so out loud, and the provider clause is ALSO pinned
  -- unconditionally and synthetically in scripts/certify-mutation-test.mjs,
  -- which reads no live table at all.
  ---------------------------------------------------------------------------
  select c.tenant_id, ad.action_key, ad.provider,
         coalesce((select jsonb_object_agg(s->>'name', '@ask')
                     from jsonb_array_elements(ad.param_schema) s
                    where coalesce((s->>'required')::boolean, false)), '{}'::jsonb)
    into v_pm_tenant, v_pm_key, v_pm_provider, v_pm_params
    from public.action_definitions ad
    join public.connectors c
      on c.status = 'connected'
     and c.category = ad.category
   where ad.status = 'active' and ad.scope = 'platform'
     and ad.provider not in ('internal', 'template')
     and not exists (
       select 1
         from public.action_definitions ad2
         join public.connectors c2
           on c2.tenant_id = c.tenant_id
          and c2.status = 'connected'
          and c2.category = ad2.category
        where ad2.action_key = ad.action_key
          and ad2.status = 'active'
          and ad2.provider <> 'internal'
          and (ad2.provider is null or ad2.provider = c2.provider or ad2.provider = 'template')
          and (ad2.scope = 'platform' or (ad2.scope = 'tenant' and ad2.tenant_id = c.tenant_id)))
   order by ad.action_key, c.tenant_id
   limit 1;

  if v_pm_key is null then
    raise notice '681: NOT EXERCISED HERE — no verb in this database has a category matching some workspace''s connected connector while its provider differs, so the PROVIDER clause is not pinned by this migration in this environment. certify-mutation-test.mjs pins it synthetically and unconditionally.';
  else
    v_r := public.validate_onboarding_items(
      jsonb_build_array(
        jsonb_build_object('key','x','label','X','phase','config','owner_type','de',
                           'requires_signoff',false,'action_key',v_pm_key,'params',v_pm_params),
        jsonb_build_object('key','y','label','Y','phase','golive','owner_type','human',
                           'requires_signoff',false)),
      v_pm_tenant);
    if not exists (select 1 from unnest(v_r) e
                    where e like '%"x"%' and e like '%' || v_pm_key || '%' and e like '%no connected%') then
      raise exception '681: verb "%" (provider %) was accepted for workspace %, whose only connector in that category is a DIFFERENT provider — category alone is not reachability: %', v_pm_key, v_pm_provider, v_pm_tenant, v_r;
    end if;
    raise notice '681: PROVIDER clause exercised against live data — "%" under provider % rejected for workspace %', v_pm_key, v_pm_provider, v_pm_tenant;
  end if;

  ---------------------------------------------------------------------------
  -- HALF TWO (iv) — STATUS clause. A workspace whose connector for the verb's
  -- category and provider exists but is DISCONNECTED. This is precisely the
  -- "connector disconnected after publish, template re-published" case the
  -- header argues should fail, so it is worth proving it actually does.
  --
  -- HONEST COVERAGE NOTE: environment-dependent, same as (iii). Production
  -- supplies it (tenant a1b2c3d4 has a disconnected salesforce/crm connector).
  -- The dev project has 155 connectors and all 155 are connected. Also pinned
  -- synthetically in certify-mutation-test.mjs.
  ---------------------------------------------------------------------------
  select c.tenant_id, ad.action_key,
         coalesce((select jsonb_object_agg(s->>'name', '@ask')
                     from jsonb_array_elements(ad.param_schema) s
                    where coalesce((s->>'required')::boolean, false)), '{}'::jsonb)
    into v_st_tenant, v_st_key, v_st_params
    from public.action_definitions ad
    join public.connectors c
      on c.category = ad.category
     and (ad.provider is null or ad.provider = c.provider or ad.provider = 'template')
   where ad.status = 'active' and ad.scope = 'platform' and ad.provider <> 'internal'
     and c.status <> 'connected'
     and not exists (
       select 1
         from public.action_definitions ad2
         join public.connectors c2
           on c2.tenant_id = c.tenant_id
          and c2.status = 'connected'
          and c2.category = ad2.category
        where ad2.action_key = ad.action_key
          and ad2.status = 'active'
          and ad2.provider <> 'internal'
          and (ad2.provider is null or ad2.provider = c2.provider or ad2.provider = 'template')
          and (ad2.scope = 'platform' or (ad2.scope = 'tenant' and ad2.tenant_id = c.tenant_id)))
   order by ad.action_key, c.tenant_id
   limit 1;

  if v_st_key is null then
    raise notice '681: NOT EXERCISED HERE — no workspace in this database has a DISCONNECTED connector that would otherwise match a verb, so the STATUS clause is not pinned by this migration in this environment. certify-mutation-test.mjs pins it synthetically and unconditionally.';
  else
    v_r := public.validate_onboarding_items(
      jsonb_build_array(
        jsonb_build_object('key','x','label','X','phase','config','owner_type','de',
                           'requires_signoff',false,'action_key',v_st_key,'params',v_st_params),
        jsonb_build_object('key','y','label','Y','phase','golive','owner_type','human',
                           'requires_signoff',false)),
      v_st_tenant);
    if not exists (select 1 from unnest(v_r) e
                    where e like '%"x"%' and e like '%' || v_st_key || '%' and e like '%no connected%') then
      raise exception '681: verb "%" was accepted for workspace %, whose only matching connector is DISCONNECTED — a connector that is not connected cannot run anything: %', v_st_key, v_st_tenant, v_r;
    end if;
    raise notice '681: STATUS clause exercised against live data — "%" rejected for workspace % (matching connector disconnected)', v_st_key, v_st_tenant;
  end if;

  ---------------------------------------------------------------------------
  -- A NULL tenant is a hard RAISE, not a silent verdict in either direction.
  -- The fixture is a lone, entirely valid golive item: without the guard this
  -- call returns '{}' (no errors) rather than raising, so the assertion turns
  -- red for the right reason.
  ---------------------------------------------------------------------------
  v_raised := false;
  begin
    v_r := public.validate_onboarding_items(
      jsonb_build_array(
        jsonb_build_object('key','y','label','Y','phase','golive','owner_type','human',
                           'requires_signoff',false)),
      null);
  exception when others then
    v_raised := true;
  end;
  if not v_raised then
    raise exception '681: a NULL tenant returned a verdict instead of raising — with no workspace, reachability matches nothing and EVERY binding would be silently rejected';
  end if;

  ---------------------------------------------------------------------------
  -- mig 674's rules (a)-(e) still hold, re-expressed on the derived fixture.
  -- (Its own fixtures hardcoded configure_customer_setup, which is now
  -- correctly UNREACHABLE in dev — the rules are unchanged, the verb is not.)
  ---------------------------------------------------------------------------
  -- (a) a binding on a human-owned item is rejected, for the owner_type reason.
  v_r := public.validate_onboarding_items(
    jsonb_build_array(
      jsonb_build_object('key','x','label','X','phase','config','owner_type','human',
                         'requires_signoff',false,'action_key',v_key,'params',v_params),
      jsonb_build_object('key','y','label','Y','phase','golive','owner_type','human',
                         'requires_signoff',false)),
    v_tenant);
  if not exists (select 1 from unnest(v_r) e where e like '%owner_type%') then
    raise exception '681: a binding on a human-owned item was accepted, or rejected for the wrong reason: %', v_r;
  end if;

  -- (b) an action_key naming no definition at all is still rejected, and with
  -- mig 674's original "not visible to this workspace" wording — NOT the new
  -- reachability wording, which would send an author off connecting a system
  -- for a verb that does not exist.
  v_r := public.validate_onboarding_items(
    jsonb_build_array(
      jsonb_build_object('key','x','label','X','phase','config','owner_type','de',
                         'requires_signoff',false,'action_key','no_such_verb_at_all','params','{}'::jsonb),
      jsonb_build_object('key','y','label','Y','phase','golive','owner_type','human',
                         'requires_signoff',false)),
    v_tenant);
  if not exists (select 1 from unnest(v_r) e
                  where e like '%no_such_verb_at_all%' and e like '%no active action definition visible%') then
    raise exception '681: a binding to a nonexistent action_key was accepted, or no longer says the definition does not exist: %', v_r;
  end if;

  -- (c) a params value that is an object is rejected.
  v_r := public.validate_onboarding_items(
    jsonb_build_array(
      jsonb_build_object('key','x','label','X','phase','config','owner_type','de',
                         'requires_signoff',false,'action_key',v_key,
                         'params', v_params || jsonb_build_object(v_req, jsonb_build_object('nested','object'))),
      jsonb_build_object('key','y','label','Y','phase','golive','owner_type','human',
                         'requires_signoff',false)),
    v_tenant);
  if not exists (select 1 from unnest(v_r) e where e like '%' || v_req || '%' and e like '%scalar%') then
    raise exception '681: a non-scalar param value was accepted, or rejected for the wrong reason: %', v_r;
  end if;

  -- (d) a REQUIRED parameter left unnamed is rejected at publish time.
  v_r := public.validate_onboarding_items(
    jsonb_build_array(
      jsonb_build_object('key','x','label','X','phase','config','owner_type','de',
                         'requires_signoff',false,'action_key',v_key,'params', v_params - v_req),
      jsonb_build_object('key','y','label','Y','phase','golive','owner_type','human',
                         'requires_signoff',false)),
    v_tenant);
  if not exists (select 1 from unnest(v_r) e where e like '%missing required parameter%' and e like '%' || v_req || '%') then
    raise exception '681: a binding missing the REQUIRED param "%" was accepted, or rejected for the wrong reason: %', v_req, v_r;
  end if;

  -- (e) a parameter the verb does not have is rejected — a typo must not sail
  -- through and be silently dropped at execution time.
  v_r := public.validate_onboarding_items(
    jsonb_build_array(
      jsonb_build_object('key','x','label','X','phase','config','owner_type','de',
                         'requires_signoff',false,'action_key',v_key,
                         'params', v_params || '{"zzz_not_a_real_param":"@ask"}'::jsonb),
      jsonb_build_object('key','y','label','Y','phase','golive','owner_type','human',
                         'requires_signoff',false)),
    v_tenant);
  if not exists (select 1 from unnest(v_r) e where e like '%zzz_not_a_real_param%') then
    raise exception '681: a binding naming a nonexistent parameter was accepted, or rejected for the wrong reason: %', v_r;
  end if;

  ---------------------------------------------------------------------------
  -- GRANTS. A DROP discarded the old ACL entirely, so this asserts a state
  -- that had to be REBUILT, not merely preserved. Both directions: the
  -- clients that must be closed off, and the one role that must still work.
  -- publish_onboarding_template is checked too — it is `create or replace`d
  -- above, which SHOULD preserve its ACL, and the EXECUTE-perimeter allowlist
  -- pins it as authenticated=true. Asserting beats assuming.
  ---------------------------------------------------------------------------
  select has_function_privilege('anon', 'public.validate_onboarding_items(jsonb,uuid)', 'EXECUTE'),
         has_function_privilege('authenticated', 'public.validate_onboarding_items(jsonb,uuid)', 'EXECUTE'),
         has_function_privilege('service_role', 'public.validate_onboarding_items(jsonb,uuid)', 'EXECUTE'),
         has_function_privilege('authenticated', 'public.publish_onboarding_template(uuid)', 'EXECUTE')
    into v_anon_exec, v_authed_exec, v_service_exec, v_pub_authed;

  if v_anon_exec then
    raise exception '681: anon can execute validate_onboarding_items — that is the internet';
  end if;
  if v_authed_exec then
    raise exception '681: authenticated can execute validate_onboarding_items directly — it should only be reachable through publish_onboarding_template';
  end if;
  if not v_service_exec then
    raise exception '681: service_role cannot execute validate_onboarding_items — the DROP discarded the grant mig 674 deliberately kept (mig 658/678 failure mode)';
  end if;
  if not v_pub_authed then
    raise exception '681: authenticated lost EXECUTE on publish_onboarding_template — the replace changed the perimeter and no owner/admin can publish';
  end if;

  -- The old 1-arg signature must be GONE, not shadowed. A surviving overload
  -- would keep answering the old, tenant-blind way while everything above
  -- looked green — the 42725 trap, in its quiet form.
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'validate_onboarding_items'
                and pg_get_function_identity_arguments(p.oid) = 'p_items jsonb') then
    raise exception '681: the 1-arg validate_onboarding_items(jsonb) still exists — a second overload means the tenant-blind body is still reachable';
  end if;

  -- ...and the one caller must actually PASS the tenant. Everything above can
  -- be green while publish_onboarding_template still calls the 1-arg form that
  -- no longer exists — in which case every publish in production throws 42883
  -- and nothing here noticed. There is no auth context in a migration to drive
  -- publish_onboarding_template end to end, so this pins its source instead.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'publish_onboarding_template'
       and p.prosrc like '%validate_onboarding_items(v_tpl.items, v_tpl.tenant_id)%') then
    raise exception '681: publish_onboarding_template does not pass the tenant to the validator — with the 1-arg form dropped, every publish would fail at runtime with "function does not exist"';
  end if;

  raise notice '681: reachability enforced — reachable binding ACCEPTED, unreachable REJECTED (no connector / wrong category / wrong provider / disconnected), NULL tenant raises, mig 674 rules (a)-(e) intact, grants rebuilt closed to anon+authenticated and open to service_role, no surviving overload, caller passes the tenant';
end $$;

commit;
