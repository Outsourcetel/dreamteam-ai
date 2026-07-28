-- 497_d4_renewal_records_unattended.sql
-- ============================================================================
-- FOUNDER DECISION D4, executed: "a renewal employee may update its own case
-- record and log activity without asking. Anything customer-facing or
-- financial — notices, quotes, invoices — needs a person."
--
-- Both prerequisites are now closed:
--   * mig 495 — guardrails can finally see what the employee WROTE, not just a
--     fixed internal label. Proven live: an activity note containing a legal
--     threat is now guardrail_blocked where the identical clean note is not.
--   * mig 496 — the dial the gate actually reads is now a visible, switchable
--     card on the employee's trust surface. Enabling an invisible,
--     un-turn-off-able permission would have been its own lie.
--
-- WHAT THIS OPENS, exactly six ops, all non-destructive:
--   account.log_activity      account.set_next_step
--   opportunity.log_activity  opportunity.set_next_step
--   continuity.log_activity   continuity.set_next_step
-- WHAT STAYS GATED, by the destructive floor that returns BEFORE the dial is
-- ever consulted (proven live in a 4-case test): advance_stage, update_stage,
-- update_status. And money is untouched — invoice write-backs pass category
-- 'billing', which this row does not cover.
--
-- SCOPE. The two de_autonomy rows already in every tenant are TENANT-WIDE
-- (de_id IS NULL): flipping one would open these ops for EVERY employee in the
-- workspace — 15 of them at outsourcetel-hq — which is far wider than D4
-- authorises. This writes a PER-EMPLOYEE row instead, which wins rung 1 of
-- resolve_de_autonomy and shadows the tenant-wide default for that employee
-- only. Everyone else keeps asking.
--
-- SHIPS GLOBAL, by baseline rather than by row. role_archetypes is
-- platform-level (no tenant_id), so one template row reaches every tenant
-- present and future — the same shape guardrail_templates and
-- watcher_templates already use. The hook is instantiate_role_archetype, NOT
-- install_role_kit: only ONE of the three hire paths calls install_role_kit,
-- so archetype-hired employees from the DE-driven and provisioning paths would
-- silently not inherit this — a per-path divergence invisible until audited.
--
-- HONEST NOTE, worth stating rather than burying: D4's money floor currently
-- holds by the ABSENCE of a 'billing' row, not by an explicit deny. One INSERT
-- would change that. Making it an explicit deny is a separate decision.
-- ============================================================================

alter table public.role_archetypes add column if not exists autonomy_templates jsonb not null default '[]'::jsonb;

comment on column public.role_archetypes.autonomy_templates is
  'Trust dials a newly hired employee of this role inherits, as [{action_type, source_category, enabled}]. Materialised PER-EMPLOYEE by instantiate_role_archetype so it never widens a whole workspace. Non-destructive ops only — the destructive floor sits above the dial and is not expressible here.';

update public.role_archetypes
   set autonomy_templates = '[{"action_type": "action_execute", "source_category": "crm", "enabled": true}]'::jsonb
 where key = 'renewal_manager';

-- ── the hire hook ───────────────────────────────────────────────────────────
-- LIVE definition + the template materialisation. Everything else is
-- byte-for-byte: the authorization gate, the digital_employees insert with
-- archetype_key stamped (which resolve_de_archetype reads), and the compliance
-- pack loop.
create or replace function public.instantiate_role_archetype(p_tenant_id uuid, p_archetype_key text, p_de_name text, p_persona_name text DEFAULT NULL::text)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare a role_archetypes; v_de uuid; v_pack text; v_dial jsonb;
begin
  if auth.uid() is not null and not exists (
      select 1 from profiles p where p.user_id = auth.uid()
      and (p.layer = 'platform' or (p.tenant_id = p_tenant_id and p.role in ('tenant_owner','tenant_admin','tenant_manager')))) then
    raise exception 'not authorized to hire a DE for this tenant';
  end if;
  select * into a from role_archetypes where key = p_archetype_key and status = 'active';
  if a.key is null then raise exception 'unknown archetype %', p_archetype_key; end if;

  insert into digital_employees (tenant_id, name, persona_name, description, category, department,
    lifecycle_status, trust_level, status, capabilities, responsibilities, model_provider, model_id,
    catalog_id, archetype_key)
  values (p_tenant_id, p_de_name, p_persona_name, a.description, 'Customer', a.domain,
    'designed', 'supervised', 'idle', a.required_capabilities, a.responsibilities, 'anthropic', a.recommended_model,
    a.key, a.key)
  returning id into v_de;

  -- Auto-attach the archetype's mandatory compliance packs (now populated).
  foreach v_pack in array a.compliance_pack_keys loop
    perform public.attach_compliance_pack(p_tenant_id, v_pack);
  end loop;

  -- mig 497 (D4): the role's own trust dials, materialised PER EMPLOYEE so a
  -- hire never widens the workspace. This is the only hook all three hire
  -- paths share.
  for v_dial in select * from jsonb_array_elements(coalesce(a.autonomy_templates, '[]'::jsonb)) loop
    insert into de_autonomy (tenant_id, de_id, action_type, source_category, enabled)
    values (p_tenant_id, v_de, v_dial->>'action_type', v_dial->>'source_category',
            coalesce((v_dial->>'enabled')::boolean, false))
    on conflict do nothing;
  end loop;

  return v_de;
end;
$function$;

-- ── backfill: employees hired before the template existed ───────────────────
insert into de_autonomy (tenant_id, de_id, action_type, source_category, enabled)
select d.tenant_id, d.id, t->>'action_type', t->>'source_category',
       coalesce((t->>'enabled')::boolean, false)
  from digital_employees d
  join role_archetypes a on a.key = d.archetype_key
 cross join lateral jsonb_array_elements(coalesce(a.autonomy_templates, '[]'::jsonb)) t
 where coalesce(a.autonomy_templates, '[]'::jsonb) <> '[]'::jsonb
   and not exists (
     select 1 from de_autonomy x
      where x.tenant_id = d.tenant_id and x.de_id = d.id
        and x.action_type = t->>'action_type'
        and x.source_category is not distinct from t->>'source_category');

notify pgrst, 'reload schema';

-- ── PROOF ────────────────────────────────────────────────────────────────────
do $a$
declare
  v_tenant uuid; v_de uuid; v_other uuid;
  v_res jsonb; n int; v_on boolean;
begin
  if pg_get_functiondef('public.instantiate_role_archetype(uuid,text,text,text)'::regprocedure)
       not ilike '%autonomy_templates%' then
    raise exception '497: new hires will not inherit the role dial';
  end if;

  select t.id into v_tenant from tenants t where t.slug = 'outsourcetel-hq';
  select d.id into v_de from digital_employees d
   where d.tenant_id = v_tenant and d.archetype_key = 'renewal_manager' limit 1;
  if v_tenant is null or v_de is null then
    raise notice '497: no renewal employee — behavioural proof SKIPPED';
    return;
  end if;

  -- 1. The dial the GATE reads must now resolve open for this employee.
  select r.enabled into v_on from resolve_de_autonomy(v_tenant, 'action_execute', v_de, 'crm') r;
  if not coalesce(v_on, false) then
    raise exception '497: the renewal employee still has to ask permission to write its own notes';
  end if;

  -- 2. A non-destructive record write must now auto-execute...
  v_res := decide_action_execution(v_tenant, 'Log a continuity activity', 'crm', false, v_de, NULL, 'action_execute',
                                   'Confirmed the renewal position with the account team.');
  if v_res->>'decision' <> 'auto_executed' then
    raise exception '497: a record note still gates (%) — D4 is not in force', v_res->>'decision';
  end if;

  -- 3. ...while a DESTRUCTIVE one still stops at the floor above the dial.
  v_res := decide_action_execution(v_tenant, 'Advance the case stage', 'crm', true, v_de, NULL, 'action_execute',
                                   'Move to negotiation');
  if v_res->>'decision' <> 'human_gated_destructive' then
    raise exception '497: a destructive op slipped past the floor (%) — the dial widened too far', v_res->>'decision';
  end if;

  -- 4. ...and guardrails still bite on the CONTENT (mig 495 must survive D4).
  v_res := decide_action_execution(v_tenant, 'Log a continuity activity', 'crm', false, v_de, NULL, 'action_execute',
                                   'we will threaten lawsuit if they do not pay');
  if v_res->>'decision' <> 'guardrail_blocked' then
    raise exception '497: an unattended note with blocked language was NOT stopped (%) — the safety net is off', v_res->>'decision';
  end if;

  -- 5. Money is untouched.
  v_res := decide_action_execution(v_tenant, 'Log an invoice activity', 'billing', false, v_de, NULL, 'action_execute',
                                   'Recorded a payment note.');
  if v_res->>'decision' = 'auto_executed' then
    raise exception '497: billing became unattended — D4 keeps money human';
  end if;

  -- 6. SCOPE: nobody else was widened.
  select d.id into v_other from digital_employees d
   where d.tenant_id = v_tenant and coalesce(d.archetype_key, '') <> 'renewal_manager' limit 1;
  if v_other is not null then
    v_res := decide_action_execution(v_tenant, 'Log a continuity activity', 'crm', false, v_other, NULL, 'action_execute',
                                     'A note from a different employee.');
    if v_res->>'decision' = 'auto_executed' then
      raise exception '497: a non-renewal employee was widened too — the workspace was opened, not the role';
    end if;
  end if;

  select count(*) into n from de_autonomy
   where de_id is not null and action_type = 'action_execute' and source_category = 'crm' and enabled;
  raise notice '497: D4 in force for % renewal employee(s); destructive ops, content guardrails and billing all still hold', n;
end $a$;
