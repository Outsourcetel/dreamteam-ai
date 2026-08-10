-- 669_an_onboarding_agent_must_not_send_a_final_demand.sql
-- ============================================================================
-- The Onboarding DE's whole toolkit is seven tools, and FIVE of them are debt
-- collection. It can email a brand-new customer a final demand notice on day
-- one of their onboarding. So can Marketing, Technical Support, Patient
-- Support, Business Development and Account Success — thirteen employees in
-- all were offered `send_final_notice`.
--
-- SAME ROOT CAUSE AS MIG 643, WHICH ONLY FIXED HALF OF IT. Tools are granted by
-- CONNECTOR, never by role: hold the ERPNext connector and you are handed every
-- verb in the erp_financials category. 643 introduced `requires_role` and
-- closed the platform_admin verbs (22 employees could hire staff). The finance
-- verbs still carry requires_role = NULL, so the same hole stayed open on the
-- money side. **The offer list IS the authorisation boundary** —
-- decide_action_execution gates destructive/trust/budget but never asks whether
-- THIS employee may do this at all.
--
-- ── THE LINE THIS DRAWS, and why it is not "collections verbs are dangerous" ─
-- Each of these actions exists in TWO variants that look alike and are not:
--     send_payment_reminder  → erpnext_invoice_comment      "Log a courtesy note"
--     send_payment_reminder  → erpnext_send_invoice_email   "Email the customer"
-- One writes an internal note on an invoice. The other REACHES A CUSTOMER.
-- Only the customer-reaching variants are restricted here. Logging a note stays
-- open to anyone holding the connector, because that is a bookkeeping act with
-- no outside blast radius. Five rows across four providers qualify: erpnext ×2,
-- quickbooks, stripe, xero.
--
-- ⚠ BOTH HALVES, because 643 nearly left 11 of 12 workspaces administrable by
-- NOBODY by restricting a verb the qualifying role could not actually reach.
-- Checked against live data BEFORE writing this:
--   * de_may_use_action understands exactly ONE value today
--     ('workforce_assistant') and has NO permissive else — so setting
--     requires_role to any unrecognised string DENIES IT TO EVERYONE, including
--     the finance employees. The function must learn 'finance' in the SAME
--     migration, or this locks the money desk out of its own job.
--   * The archetypes that must keep it: billing_ar, accounting, fpa.
--     Live: Billing & Invoicing DE = billing_ar, Accounting DE = accounting,
--     Finance DE = fpa — and dunning_de_for() returns Finance DE, so the
--     collections desk keeps its own tools.
--   * Platform-wide: tenants holding a finance connector but having ZERO
--     qualifying employee = 0. Nobody is left unable to chase an invoice.
--   * The automated path cannot break: de_may_use_action has exactly one
--     caller, get_agentic_tools_for_de. run_dunning_sweep resolves through
--     dunning_action_for and never consults the offer list.
-- ============================================================================

begin;

-- ── 1. Teach the gate one new requirement. Still no permissive else. ───────
create or replace function public.de_may_use_action(
  p_tenant_id uuid, p_de_id uuid, p_action_definition_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce(
    case
      when ad.requires_role is null then true
      when ad.requires_role = 'workforce_assistant'
        then coalesce(de.is_workforce_assistant, false)
      -- mig 669: the money desk. Reaching a CUSTOMER about their unpaid
      -- invoice is a finance act, not something every employee holding the
      -- ERP connector should be able to do.
      when ad.requires_role = 'finance'
        then coalesce(de.archetype_key, '') in ('billing_ar', 'accounting', 'fpa')
      -- No permissive else. An unrecognised requirement DENIES.
      else false
    end, false)
    from action_definitions ad
    left join digital_employees de
      on de.id = p_de_id and de.tenant_id = p_tenant_id
   where ad.id = p_action_definition_id;
$function$;

-- ── 1b. Widen the vocabulary the COLUMN accepts ───────────────────────────
-- mig 643 pinned requires_role to a one-value allowlist, and it did its job:
-- the first attempt at this migration was rejected by
-- action_definitions_requires_role_check rather than quietly storing a value
-- de_may_use_action would have denied for everyone. Keep the allowlist — an
-- open text column here is a typo away from locking out a whole desk — and add
-- exactly one value, in the same migration that teaches the function to honour it.
alter table public.action_definitions
  drop constraint if exists action_definitions_requires_role_check;
alter table public.action_definitions
  add constraint action_definitions_requires_role_check
  check (requires_role is null or requires_role = any (array['workforce_assistant', 'finance']));

-- ── 2. Restrict only what reaches a customer ──────────────────────────────
update action_definitions
   set requires_role = 'finance'
 where status = 'active'
   and category in ('erp_financials', 'billing')
   and action_key in ('send_payment_reminder', 'send_final_notice')
   and (execution->>'execution_key') ilike '%send%';

-- ── 3. Prove BOTH halves, per employee, against live rows ─────────────────
do $$
declare
  v_restricted int;
  v_kept       int;
  v_lost       text;
  v_dunning_de uuid;
  v_tenant     uuid;
  v_orphan     int;
begin
  select count(*) into v_restricted
    from action_definitions where requires_role = 'finance';
  if v_restricted <> 5 then
    raise exception '669: expected 5 customer-reaching verbs restricted, got % — the WHERE clause moved', v_restricted;
  end if;

  -- The gate must still recognise the OLD value, or mig 643 silently reverts.
  if pg_get_functiondef('public.de_may_use_action(uuid,uuid,uuid)'::regprocedure)
     not ilike '%workforce_assistant%' then
    raise exception '669: the workforce_assistant branch was lost — 643 would revert';
  end if;
  if pg_get_functiondef('public.de_may_use_action(uuid,uuid,uuid)'::regprocedure)
     not ilike '%else false%' then
    raise exception '669: the deny-by-default else is gone — an unknown requirement would now ALLOW';
  end if;

  select t.id into v_tenant from tenants t where t.slug = 'outsourcetel-hq';
  if v_tenant is null then
    raise notice '669: outsourcetel-hq absent — the per-employee proof is SKIPPED, not passed';
  else
    -- ⚠ HALF ONE: the finance desk KEEPS them. Named employees, not a count.
    select count(*) into v_kept
      from digital_employees de
      cross join lateral jsonb_array_elements(
        public.get_agentic_tools_for_de(de.tenant_id, de.id)) x
      join action_definitions ad on ad.id = (x->>'action_definition_id')::uuid
     where de.tenant_id = v_tenant
       and ad.requires_role = 'finance'
       and de.archetype_key in ('billing_ar', 'accounting', 'fpa');
    if v_kept = 0 then
      raise exception '669: the finance employees can no longer reach a customer about an invoice — the money desk is locked out of its own job';
    end if;

    -- …and specifically the employee the dunning path actually picks.
    v_dunning_de := public.dunning_de_for(v_tenant);
    if v_dunning_de is not null and not exists (
      select 1 from digital_employees de
      cross join lateral jsonb_array_elements(
        public.get_agentic_tools_for_de(de.tenant_id, de.id)) x
      join action_definitions ad on ad.id = (x->>'action_definition_id')::uuid
     where de.id = v_dunning_de and ad.requires_role = 'finance') then
      raise exception '669: dunning_de_for() returns an employee that can no longer send a reminder';
    end if;

    -- ⚠ HALF TWO: everybody else LOSES them. This is the point of the change.
    select string_agg(distinct de.name, ', ') into v_lost
      from digital_employees de
      cross join lateral jsonb_array_elements(
        public.get_agentic_tools_for_de(de.tenant_id, de.id)) x
      join action_definitions ad on ad.id = (x->>'action_definition_id')::uuid
     where de.tenant_id = v_tenant
       and ad.requires_role = 'finance'
       and coalesce(de.archetype_key, '') not in ('billing_ar', 'accounting', 'fpa');
    if v_lost is not null then
      raise exception '669: these still reach a customer about money and should not: %', v_lost;
    end if;

    -- The internal note must NOT have been swept up with the emails.
    if not exists (
      select 1 from digital_employees de
      cross join lateral jsonb_array_elements(
        public.get_agentic_tools_for_de(de.tenant_id, de.id)) x
      join action_definitions ad on ad.id = (x->>'action_definition_id')::uuid
     where de.tenant_id = v_tenant
       and de.archetype_key = 'onboarding'
       and ad.action_key = 'send_payment_reminder') then
      raise notice '669: the onboarding employee also lost the internal-note variant — check that was intended';
    end if;
  end if;

  -- Platform-wide: no workspace with a finance connector is left with nobody.
  select count(*) into v_orphan
    from tenants t
   where t.status = 'active'
     and exists (select 1 from connectors c
                  where c.tenant_id = t.id and c.status = 'connected'
                    and c.category in ('erp_financials', 'billing'))
     and not exists (select 1 from digital_employees de
                      where de.tenant_id = t.id
                        and de.archetype_key in ('billing_ar', 'accounting', 'fpa'));
  if v_orphan <> 0 then
    raise exception '669: % workspace(s) hold a finance connector but no employee that may use it — the 643 mistake, repeated', v_orphan;
  end if;

  raise notice '669: reaching a customer about money is now the finance desk only; the internal note is unchanged';
end $$;

commit;
