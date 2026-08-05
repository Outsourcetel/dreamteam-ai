-- 606 — intake for the roles that had none.
--
-- 50 of 56 active digital employees have no watcher. All 12 watchers that
-- exist belong to ONE workspace. So when a tenant provisions a Finance DE or an
-- Account Success DE, no intake comes with it and the employee sits idle
-- forever — which is most of the answer to "why do 47 employees do nothing".
--
-- ── What already exists, and is NOT rebuilt here ─────────────────────────
-- Everything. `work_watchers` (schedule | state_condition | date_horizon |
-- metric_threshold | inbox), `watch_source_catalog` with six sources,
-- `watch_source_fields` with the per-source column metadata, a GENERIC
-- dynamic-SQL branch in run_work_watchers that drives off that catalogue, and
-- a 5-minute cron. It provably works: it opened the two account-health
-- objectives that ran today.
--
-- I nearly concluded the opposite. run_work_watchers opens with
-- `IF w.kind = 'date_horizon' AND v_src = 'customer_accounts'`, which reads
-- like the engine only handles one source. Those are legacy FAST PATHS — the
-- `legacy_bespoke` flag in the catalogue marks exactly which — and generic
-- branches follow at the bottom for everything else. Reading only the first
-- branch would have had me rebuild a working engine.
--
-- The gap is not machinery. It is that nobody ever created the rows.
--
-- ── Grounded, or not created ─────────────────────────────────────────────
-- A watcher whose source table is EMPTY for its tenant cannot ever fire. There
-- are already twelve watchers reporting last_match_count = 0, and adding more
-- would make the intake surface look busier while changing nothing.
--
-- So install_role_watchers() checks the source has rows for THAT tenant before
-- creating anything, and reports what it skipped and why. Measured now:
--
--     de_conversations       14 tenants have rows
--     customer_accounts       3
--     renewal_invoices        3
--     opportunities           0   ← no watcher can be grounded
--     commercial_agreements   0
--     support_tickets         0
--
-- ⚠ DELIBERATELY NOT ADDED: an overdue-invoice watcher. run_dunning_sweep
-- (mig 589) already owns that signal and routes it to a named human. A second
-- driver on the same rows would double every chase — the exact duplication the
-- last two days were spent removing. The invoice watcher here fires BEFORE the
-- due date, which is a different job: remind, rather than chase.

begin;

create or replace function install_role_watchers(p_tenant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  d          record;
  v_created  int := 0;
  v_existing int := 0;
  v_nodata   int := 0;
  v_norole   int := 0;
  v_detail   jsonb := '[]'::jsonb;
  v_kind     text;
  v_source   text;
  v_label    text;
  v_desc     text;
  v_config   jsonb;
  v_rows     bigint;
begin
  for d in
    select de.id, de.name, de.tenant_id
    from digital_employees de
    where de.tenant_id = p_tenant_id and de.status = 'active'
  loop
    -- One watcher per role, chosen for the signal that role actually acts on.
    -- Matched on the ROLE NAME because that is what provisioning sets and what
    -- stays stable across tenants.
    if d.name ~* '(account success|customer success)' then
      v_kind := 'state_condition'; v_source := 'customer_accounts';
      v_label := 'Account turned at-risk';
      v_desc  := 'Open a save case when an account is flagged at-risk.';
      v_config := jsonb_build_object('op','eq','field','status','value','at_risk',
                    'source','customer_accounts','response_window', jsonb_build_object('unit','days','amount',3));

    elsif d.name ~* 'renewal' then
      v_kind := 'date_horizon'; v_source := 'customer_accounts';
      v_label := 'Renewal approaching (90/60/30 day)';
      v_desc  := 'Open a renewal case as each notice window is reached.';
      v_config := jsonb_build_object('source','customer_accounts','date_field','renewal_date',
                    'horizons_days', jsonb_build_array(90,60,30),
                    'status_filter', jsonb_build_array('active','at_risk'));

    elsif d.name ~* '(support|helpdesk|service desk)' then
      v_kind := 'state_condition'; v_source := 'de_conversations';
      v_label := 'Conversation handed to a person and waiting';
      v_desc  := 'A customer thread was escalated to a human. Pick it up, or prepare what the human needs to close it.';
      v_config := jsonb_build_object('op','eq','field','status','value','human_owned',
                    'source','de_conversations','response_window', jsonb_build_object('unit','days','amount',1));

    elsif d.name ~* '(finance|accounting|billing|invoic)' then
      -- BEFORE due, not after. run_dunning_sweep owns overdue.
      v_kind := 'date_horizon'; v_source := 'renewal_invoices';
      v_label := 'Invoice coming due (14/7/1 day)';
      v_desc  := 'Prepare for an invoice falling due — confirm the balance and that the customer has what they need to pay.';
      v_config := jsonb_build_object('source','renewal_invoices','date_field','due_date',
                    'horizons_days', jsonb_build_array(14,7,1),
                    'status_filter', jsonb_build_array('sent','awaiting_approval','pending_generation'));

    else
      -- Workspace Assistant, Website & Growth, Business Development and the
      -- rest: no CATALOGUED source describes what they act on. Inventing one
      -- would produce a watcher that never fires and a roster that looks
      -- covered. Counted and named instead.
      v_norole := v_norole + 1;
      v_detail := v_detail || jsonb_build_object('de', d.name, 'skipped', 'no catalogued source for this role');
      continue;
    end if;

    -- Already has one of this kind? Do not duplicate; twelve of these already
    -- exist and re-running must be safe.
    if exists (
      select 1 from work_watchers w
      where w.de_id = d.id and w.active and w.kind = v_kind
        and coalesce(w.config->>'source', 'customer_accounts') = v_source
    ) then
      v_existing := v_existing + 1;
      continue;
    end if;

    -- Grounded? An empty source cannot fire, ever.
    execute format('select count(*) from %I where tenant_id = $1', v_source)
      into v_rows using p_tenant_id;
    if v_rows = 0 then
      v_nodata := v_nodata + 1;
      v_detail := v_detail || jsonb_build_object('de', d.name, 'skipped', 'source is empty', 'source', v_source);
      continue;
    end if;

    insert into work_watchers (tenant_id, de_id, kind, label, description, config, active)
    values (p_tenant_id, d.id, v_kind, v_label, v_desc, v_config, true);
    v_created := v_created + 1;
    v_detail := v_detail || jsonb_build_object('de', d.name, 'created', v_label, 'source', v_source, 'source_rows', v_rows);
  end loop;

  return jsonb_build_object(
    'created', v_created, 'already_had_one', v_existing,
    'skipped_source_empty', v_nodata, 'skipped_no_catalogued_source', v_norole,
    'detail', v_detail);
end;
$$;

grant execute on function install_role_watchers(uuid) to service_role;

-- ── Install across every operational workspace ───────────────────────────

do $install$
declare
  t       record;
  v_res   jsonb;
  v_total int := 0;
  v_empty int := 0;
  v_norole int := 0;
begin
  for t in select id, slug from tenants where tenant_is_operational(id) loop
    v_res := install_role_watchers(t.id);
    v_total  := v_total  + (v_res->>'created')::int;
    v_empty  := v_empty  + (v_res->>'skipped_source_empty')::int;
    v_norole := v_norole + (v_res->>'skipped_no_catalogued_source')::int;
  end loop;
  raise notice 'watchers created: % | skipped (empty source): % | skipped (no catalogued source): %',
    v_total, v_empty, v_norole;
end;
$install$;

do $verify$
declare v_des_with int; v_des_total int; v_ungrounded int;
begin
  select count(*) into v_des_total from digital_employees where status = 'active';
  select count(distinct de_id) into v_des_with from work_watchers where active;

  -- Every watcher this migration created must sit on a source that has rows.
  select count(*) into v_ungrounded
  from work_watchers w
  where w.active and w.config ? 'source'
    and w.config->>'source' = 'de_conversations'
    and not exists (select 1 from de_conversations c where c.tenant_id = w.tenant_id);
  if v_ungrounded > 0 then
    raise exception '% conversation watchers point at an empty source', v_ungrounded;
  end if;

  raise notice 'employees with intake: % of % active', v_des_with, v_des_total;
end;
$verify$;

commit;
