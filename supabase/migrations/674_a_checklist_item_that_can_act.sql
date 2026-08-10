-- 674_a_checklist_item_that_can_act.sql
-- ==========================================================================
-- WHY: an onboarding checklist item needs to be able to name a verb (an
-- action_key) a digital employee can execute, plus the human-supplied
-- parameter answers that verb needs. This is task 1 of the
-- onboarding-item-execution plan: storage for those answers, and publish-time
-- validation that rejects a malformed or mismatched binding before it ever
-- reaches a DE. Nothing else in the plan works without this.
--
-- Definitions (label/phase/owner_type/... and now action_key/params) live
-- only on onboarding_template_versions.items and the editable draft
-- onboarding_templates.items. onboarding_projects.items_state holds only
-- mutable per-project state (key/status/assignee/note/...) and is never a
-- copy of the definition, so this migration needs no items_state backfill.
--
-- EDITED AFTER FIRST APPLY (still same day, review of task-1): the REVOKE
-- below had no has_function_privilege assertion proving its result — a
-- revoke statement is not a description of the resulting privileges (house
-- rule; see mig 658, where `revoke ... from public` silently took
-- `authenticated` down with it too). Added the three-way assertion
-- (anon=false, authenticated=false, service_role=true) to the existing do $$
-- block and re-applied to dev and prod; record_migration_applied's own
-- ON CONFLICT DO UPDATE refreshes the ledger's checksum on a content-changed
-- re-apply, which is what clears DRIFTED — this is the same edit-after-apply
-- path mig 364 documents having used on 349 and 353.
-- ==========================================================================

begin;

alter table public.onboarding_projects
  add column if not exists requirements jsonb not null default '{}'::jsonb;

comment on column public.onboarding_projects.requirements is
  'Answers to @ask parameters, keyed "<action_key>.<param>". Two verbs can both '
  'take a "territory" meaning different things; a flat key would feed one verb '
  'the other''s answer.';

-- validate_onboarding_items: existing body (read live via pg_get_functiondef
-- immediately before writing this migration) preserved verbatim. New binding
-- rules (a)-(e) are appended inside the existing per-item loop, before its
-- close. Nothing existing is removed or reordered.
--
-- Volatility: IMMUTABLE -> STABLE. The function now reads action_definitions
-- and calls auth_tenant_id(), so its result depends on database/session
-- state and is no longer a pure function of its argument. This does NOT
-- change the return contract: still text[], still what
-- publish_onboarding_template destructures via
-- `v_errors := validate_onboarding_items(v_tpl.items);`.
create or replace function public.validate_onboarding_items(p_items jsonb)
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
begin
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

    -- ---- action binding rules (a)-(e), new in mig 674 ----
    v_action_key := v_item->>'action_key';
    if v_action_key is not null and v_action_key <> '' then
      -- (a) an item that names a verb must be DE-owned; a human or "either"
      -- item cannot be bound to automated execution.
      if coalesce(v_item->>'owner_type', '') <> 'de' then
        v_errors := v_errors || format('item "%s" names an action but owner_type must be "de" to bind one', v_key);
      end if;

      -- (b) action_key must name an ACTIVE action_definition visible to this
      -- tenant. Bind by key, never by id: ids differ per environment and the
      -- same key legitimately exists across several providers.
      -- auth_tenant_id() is safe here: the only caller
      -- (publish_onboarding_template) already proved
      -- v_tpl.tenant_id = auth_tenant_id() before invoking this function,
      -- and a platform-scope definition (tenant_id is null) matches for
      -- every tenant regardless of who is calling.
      v_schema := null;
      select ad.param_schema into v_schema
      from public.action_definitions ad
      where ad.action_key = v_action_key
        and ad.status = 'active'
        and (ad.tenant_id is null or ad.tenant_id = public.auth_tenant_id())
      limit 1;

      if v_schema is null then
        v_errors := v_errors || format('item "%s" names action_key "%s" which has no active action definition visible to this workspace', v_key, v_action_key);
      else
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

-- Migs 610+630 rule (re-assert on replace): strip both default-grant
-- mechanisms. The only real caller is publish_onboarding_template, which is
-- SECURITY DEFINER owned by postgres — it reaches this function as the
-- owner regardless of grants. service_role keeps direct-call ability for
-- scripts/tests; no client ever RPCs this function directly.
revoke all on function public.validate_onboarding_items(jsonb) from public, anon, authenticated;
grant execute on function public.validate_onboarding_items(jsonb) to service_role;

-- ── Verify: requirements column landed, and bindings validate in both
-- directions plus the two rules the brief's four assertions don't exercise ──
do $$
declare
  v_ok    jsonb := '[
    {"key":"x","label":"X","phase":"config","owner_type":"de",
     "requires_signoff":false,"action_key":"configure_customer_setup",
     "params":{"external_ref":"@account","territory":"@ask"}},
    {"key":"y","label":"Y","phase":"golive","owner_type":"human",
     "requires_signoff":false}
  ]'::jsonb;
  v_bad_owner jsonb := '[
    {"key":"x","label":"X","phase":"config","owner_type":"human",
     "requires_signoff":false,"action_key":"configure_customer_setup",
     "params":{"external_ref":"@account"}},
    {"key":"y","label":"Y","phase":"golive","owner_type":"human",
     "requires_signoff":false}
  ]'::jsonb;
  v_bad_missing jsonb := '[
    {"key":"x","label":"X","phase":"config","owner_type":"de",
     "requires_signoff":false,"action_key":"configure_customer_setup",
     "params":{"territory":"@ask"}},
    {"key":"y","label":"Y","phase":"golive","owner_type":"human",
     "requires_signoff":false}
  ]'::jsonb;
  v_bad_unknown_param jsonb := '[
    {"key":"x","label":"X","phase":"config","owner_type":"de",
     "requires_signoff":false,"action_key":"configure_customer_setup",
     "params":{"external_ref":"@account","terrirory":"@ask"}},
    {"key":"y","label":"Y","phase":"golive","owner_type":"human",
     "requires_signoff":false}
  ]'::jsonb;
  v_bad_unknown_action jsonb := '[
    {"key":"x","label":"X","phase":"config","owner_type":"de",
     "requires_signoff":false,"action_key":"no_such_verb_at_all",
     "params":{}},
    {"key":"y","label":"Y","phase":"golive","owner_type":"human",
     "requires_signoff":false}
  ]'::jsonb;
  v_bad_nonscalar jsonb := '[
    {"key":"x","label":"X","phase":"config","owner_type":"de",
     "requires_signoff":false,"action_key":"configure_customer_setup",
     "params":{"external_ref":{"nested":"object"}}},
    {"key":"y","label":"Y","phase":"golive","owner_type":"human",
     "requires_signoff":false}
  ]'::jsonb;
  v_r text[];
  v_anon_exec    boolean;
  v_authed_exec  boolean;
  v_service_exec boolean;
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='onboarding_projects'
                    and column_name='requirements') then
    raise exception '674: requirements column did not land';
  end if;

  -- HALF ONE: a well-formed binding is ACCEPTED. A validator that rejects
  -- everything passes the half below and makes the feature unusable. (A
  -- second, golive-phase item is included in every fixture below so the
  -- pre-existing "needs one golive item" rule never confounds the result —
  -- the only thing under test is the binding on item "x".)
  v_r := public.validate_onboarding_items(v_ok);
  if coalesce(array_length(v_r, 1), 0) <> 0 then
    raise exception '674: a valid binding was rejected: %', v_r;
  end if;

  -- HALF TWO: a binding on a human-owned item is REJECTED, for the
  -- owner_type reason specifically (not some unrelated rule).
  v_r := public.validate_onboarding_items(v_bad_owner);
  if not exists (select 1 from unnest(v_r) e where e ilike '%owner_type%') then
    raise exception '674: a binding on a human-owned item was accepted, or rejected for the wrong reason: %', v_r;
  end if;

  -- Rule (d): a REQUIRED parameter left unnamed is rejected at publish time,
  -- not discovered at 2am. configure_customer_setup requires external_ref.
  v_r := public.validate_onboarding_items(v_bad_missing);
  if not exists (select 1 from unnest(v_r) e where e ilike '%external_ref%') then
    raise exception '674: a binding missing a REQUIRED param was accepted, or rejected for the wrong reason: %', v_r;
  end if;

  -- Rule (e): a parameter the verb does not have is rejected — a typo must
  -- not sail through and be silently dropped at execution time.
  v_r := public.validate_onboarding_items(v_bad_unknown_param);
  if not exists (select 1 from unnest(v_r) e where e ilike '%terrirory%') then
    raise exception '674: a binding naming a nonexistent parameter was accepted, or rejected for the wrong reason: %', v_r;
  end if;

  -- Rule (b), bonus (not one of the brief's four, added for pin coverage):
  -- an action_key naming no active/visible action_definition at all must be
  -- rejected, not silently treated as an unbound item.
  v_r := public.validate_onboarding_items(v_bad_unknown_action);
  if not exists (select 1 from unnest(v_r) e where e ilike '%no_such_verb_at_all%') then
    raise exception '674: a binding to a nonexistent action_key was accepted, or rejected for the wrong reason: %', v_r;
  end if;

  -- Rule (c), bonus (not one of the brief's four, added for pin coverage): a
  -- params value that is an object — not @account, @ask, or a scalar
  -- literal — must be rejected.
  v_r := public.validate_onboarding_items(v_bad_nonscalar);
  if not exists (select 1 from unnest(v_r) e where e ilike '%external_ref%' and e ilike '%scalar%') then
    raise exception '674: a non-scalar param value was accepted, or rejected for the wrong reason: %', v_r;
  end if;

  -- A REVOKE statement is not a description of the resulting privileges —
  -- assert the END STATE (house rule; see mig 658, where `revoke ... from
  -- public` silently took `authenticated` down with it because it held its
  -- reach THROUGH public rather than a named grant). Both halves: the
  -- clients that must be closed off, and the one caller that must still work.
  select has_function_privilege('anon', 'public.validate_onboarding_items(jsonb)', 'EXECUTE'),
         has_function_privilege('authenticated', 'public.validate_onboarding_items(jsonb)', 'EXECUTE'),
         has_function_privilege('service_role', 'public.validate_onboarding_items(jsonb)', 'EXECUTE')
    into v_anon_exec, v_authed_exec, v_service_exec;

  if v_anon_exec then
    raise exception '674: anon can execute validate_onboarding_items — that is the internet';
  end if;
  if v_authed_exec then
    raise exception '674: authenticated can execute validate_onboarding_items directly — it should only be reachable through publish_onboarding_template';
  end if;
  if not v_service_exec then
    raise exception '674: service_role cannot execute validate_onboarding_items — the revoke also stripped the only legitimate caller (mig 658''s failure mode)';
  end if;

  raise notice '674: bindings validate — both required halves, plus rules (b) through (e) each isolated and checked by message content; grants closed to anon/authenticated, open to service_role';
end $$;

commit;
