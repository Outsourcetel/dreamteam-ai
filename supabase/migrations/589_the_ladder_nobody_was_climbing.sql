-- 589 — collections: the ladder nobody was climbing.
--
-- Everything needed to chase an overdue invoice was already built, and none of
-- it ran. Specifically:
--
--   · `dunning_ladders` + `dunning_rungs` — a four-rung ladder is configured
--     and active: friendly at 7 days, firm at 21, final notice at 45, credit
--     hold at 60, each with a written tone and an approval requirement.
--   · `dunning_position(tenant)` — a careful function that decides where each
--     invoice sits, suppresses chasing when there is an OPEN payment promise,
--     escalates on a BROKEN one, refuses to chase an invoice whose outstanding
--     balance was never reconciled, and returns a plain-English reason for
--     every case. It has ZERO callers. Not in SQL, not in the edge functions,
--     not in the UI. It was written and never wired to anything.
--   · Executors for four accounting systems — ERPNext, Stripe, QuickBooks and
--     Xero — all registered as action_definitions.
--   · The approval gate, the audit chain, and now (587/588) routing to a named
--     human rather than a shared queue.
--
-- What was missing was one thing: something to run it. There is no cron entry
-- for dunning, and 0 collections actions have been raised in 30 days. Right
-- now `dunning_position` reports two invoices in outsourcetel-hq that are
-- actionable today — 34 and 30 days overdue, PKR 45,000 and PKR 40,000, both
-- at "Firm follow-up" — and nothing has ever asked it.
--
-- ── Three decisions worth stating ───────────────────────────────────────────
--
-- 1. DEDUPE IS CHECKED, NOT ASSUMED. `action_executions_dedupe_idx` is a plain
--    btree, NOT unique — a dedupe_key is recorded but nothing enforces it. A
--    daily sweep that trusted it would re-propose the same rung every morning
--    and rebuild the queue amplifier that was just torn down. The sweep checks
--    for an existing proposal on (invoice, stage) before raising anything.
--
-- 2. THE RUNG ADVANCES ON APPROVAL, NOT ON PROPOSAL. If cadence_stage moved
--    when the chase was merely SUGGESTED, then a chase a human declined would
--    still burn the rung, and the invoice would sit until the next one came
--    due — the ladder would climb itself whether or not anyone acted. The
--    trigger below moves it only when an approved action actually executes.
--
-- 3. AN INVOICE IS CHASED THROUGH THE SYSTEM IT CAME FROM. `send_payment_
--    reminder` is registered four times with four different executors. Picking
--    the wrong one means a reminder written into a system the customer's
--    invoice does not live in. The sweep binds on `renewal_invoices.source_
--    provider`, and if no executor matches it raises NOTHING and reports
--    `no_executor` — an approval a human grants must be one the platform can
--    actually carry out.

begin;

-- ── Which action definition can actually chase this invoice ────────────────

create or replace function dunning_action_for(
  p_tenant_id uuid, p_action_key text, p_provider text
) returns uuid
language sql stable security definer set search_path = public as $$
  select ad.id
  from action_definitions ad
  where ad.action_key = p_action_key
    and ad.status = 'active'
    and (ad.tenant_id = p_tenant_id or ad.tenant_id is null)
    -- An empty `execution` means nothing happens when a human approves it.
    -- Those rows exist (acme-telecom has three) and they are worse than
    -- missing: they produce an approval that silently does nothing.
    and coalesce(ad.execution->>'execution_key', '') <> ''
    and ad.execution->>'execution_key' like p_provider || '%'
  -- A tenant's own definition beats the shared baseline.
  order by (ad.tenant_id is not null) desc, ad.created_at asc
  limit 1;
$$;

grant execute on function dunning_action_for(uuid, text, text) to authenticated, service_role;

-- ── Whose desk this is ──────────────────────────────────────────────────────
-- Attribution matters beyond bookkeeping: the trust ladder counts approvals
-- per employee, and an action attributed to nobody cannot become evidence that
-- anybody is ready for more autonomy.

create or replace function dunning_de_for(p_tenant_id uuid)
returns uuid
language sql stable security definer set search_path = public as $$
  select de.id
  from digital_employees de
  where de.tenant_id = p_tenant_id
    and de.status = 'active'
    and (
      coalesce(de.category, '')   ~* '(financ|billing|account|revenue)'
      or coalesce(de.department,'') ~* '(financ|billing|account|revenue)'
      or de.name                  ~* '(financ|billing|account|receivab|collection)'
    )
  -- Deterministic: the same employee every day, so the audit trail reads as
  -- one desk doing the work rather than a rota nobody chose.
  order by
    (de.name ~* 'financ') desc,
    (de.name ~* '(account|receivab)') desc,
    de.created_at asc
  limit 1;
$$;

grant execute on function dunning_de_for(uuid) to authenticated, service_role;

-- ── The sweep ───────────────────────────────────────────────────────────────

create or replace function run_dunning_sweep(
  p_tenant_id uuid default null,
  p_limit     integer default 200
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  t          record;
  inv        record;
  v_de       uuid;
  v_ad       uuid;
  v_provider text;
  v_dedupe   text;
  v_gate     jsonb;
  v_decision text;
  v_raised   int := 0;
  v_skipped  int := 0;
  v_noexec   int := 0;
  v_nodesk   int := 0;
  v_tenants  int := 0;
  v_detail   jsonb := '[]'::jsonb;
begin
  for t in
    select tn.id, tn.slug from tenants tn
    where (p_tenant_id is null or tn.id = p_tenant_id)
      and tenant_is_operational(tn.id)
  loop
    v_de := dunning_de_for(t.id);
    if v_de is null then
      -- No finance-side employee exists, so there is nobody to attribute the
      -- chase to. Reported rather than attributed to an arbitrary employee.
      v_nodesk := v_nodesk + 1;
      continue;
    end if;
    v_tenants := v_tenants + 1;

    for inv in
      select d.*, ri.source_provider
      from dunning_position(t.id) d
      join renewal_invoices ri on ri.id = d.invoice_id
      where d.actionable
      order by d.days_overdue desc
      limit p_limit
    loop
      v_provider := coalesce(nullif(inv.source_provider, ''), 'erpnext');
      v_dedupe   := format('dunning:%s:%s', inv.invoice_id, inv.due_stage);

      -- Already proposed for this invoice at this rung? Checked explicitly:
      -- the dedupe index is NOT unique and enforces nothing.
      if exists (
        select 1 from action_executions ae
        where ae.tenant_id = t.id and ae.dedupe_key = v_dedupe and ae.decision <> 'failed'
      ) then
        v_skipped := v_skipped + 1;
        continue;
      end if;

      v_ad := dunning_action_for(t.id, inv.action_key, v_provider);
      if v_ad is null then
        v_noexec := v_noexec + 1;
        v_detail := v_detail || jsonb_build_object(
          'tenant', t.slug, 'invoice', inv.invoice_ref, 'skipped', 'no_executor',
          'wanted', inv.action_key, 'provider', v_provider);
        continue;
      end if;

      v_gate := decide_action_execution(
        t.id,
        format('%s — %s', inv.rung_label, inv.customer),
        'erp_financials',
        coalesce(inv.requires_approval, true),
        v_de,
        inv.outstanding_cents,
        inv.action_key,
        inv.tone
      );
      v_decision := coalesce(v_gate->>'decision', 'human_gated_destructive');

      perform record_action_execution(
        p_tenant_id            => t.id,
        p_action_definition_id => v_ad,
        p_connector_id         => null,
        p_subject_kind         => 'de',
        p_subject_id           => v_de,
        p_mode                 => 'execute',
        p_params               => jsonb_build_object(
          'external_ref',      inv.invoice_ref,
          'invoice_id',        inv.invoice_id,
          'stage',             inv.due_stage,
          'days_overdue',      inv.days_overdue,
          'outstanding_cents', inv.outstanding_cents,
          'tone',              inv.tone
        ),
        p_decision      => v_decision,
        p_destructive   => coalesce(inv.requires_approval, true),
        p_idempotent    => false,
        p_dedupe_key    => v_dedupe,
        p_request_summary => format('%s for %s — invoice %s, %s day(s) overdue.',
                              inv.rung_label, inv.customer, inv.invoice_ref, inv.days_overdue),
        p_receipt   => null,
        p_result    => null,
        -- What the human reads. The rung's own words, plus the reason the
        -- ladder produced — so the decision can be made without opening the
        -- accounting system.
        p_task_title  => format('%s: %s — %s, %s days overdue',
                           inv.rung_label, inv.customer, inv.invoice_ref, inv.days_overdue),
        p_task_detail => format(E'%s\n\nHow to pitch it: %s', inv.why, inv.tone),
        p_create_task => true,
        p_origin_kind => 'dunning_sweep',
        p_origin_id   => inv.invoice_id
      );

      v_raised := v_raised + 1;
    end loop;
  end loop;

  return jsonb_build_object(
    'tenants_swept',      v_tenants,
    'raised',             v_raised,
    'already_proposed',   v_skipped,
    'no_executor',        v_noexec,
    'tenants_without_a_finance_employee', v_nodesk,
    'detail',             v_detail
  );
end;
$$;

grant execute on function run_dunning_sweep(uuid, integer) to service_role;

-- ── The rung advances only when the chase actually happened ────────────────

create or replace function advance_dunning_cadence()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_invoice uuid;
  v_stage   int;
begin
  if new.dedupe_key is null or new.dedupe_key not like 'dunning:%' then
    return null;
  end if;
  if new.decision not in ('executed_after_approval', 'auto_executed') then
    return null;
  end if;

  v_invoice := nullif(split_part(new.dedupe_key, ':', 2), '')::uuid;
  v_stage   := nullif(split_part(new.dedupe_key, ':', 3), '')::int;
  if v_invoice is null or v_stage is null then return null; end if;

  -- greatest(): a late-executing lower rung must never drag the ladder back
  -- down and re-open a chase the customer has already had.
  update renewal_invoices
     set cadence_stage = greatest(coalesce(cadence_stage, 0), v_stage),
         updated_at    = now()
   where id = v_invoice;

  return null;
exception when others then
  -- A malformed key must not be able to roll back a real execution.
  return null;
end;
$$;

drop trigger if exists trg_advance_dunning_cadence on action_executions;
create trigger trg_advance_dunning_cadence after insert on action_executions
  for each row execute function advance_dunning_cadence();

-- ── Route collections chases to the AR team ────────────────────────────────
-- The approval a chase raises carries related_table = 'action_executions',
-- which every action approval carries — so the rule written in 588 against
-- `renewal_invoices` would not have matched it. The discriminator that DOES
-- work is the employee it is attributed to: only the finance-side employee
-- raises these. That is one more matched field than the catch-all, so it wins
-- on specificity without needing a priority number to be tuned.

do $rules$
declare
  t     record;
  v_de  uuid;
  v_ar  uuid;
begin
  for t in select id, slug from tenants loop
    v_de := dunning_de_for(t.id);
    v_ar := (select u.id from org_units u
              where u.tenant_id = t.id and u.kind = 'team' and u.name = 'Accounts Receivable'
              limit 1);
    if v_de is null or v_ar is null then continue; end if;

    insert into work_assignment_rules
      (tenant_id, name, priority, match_de_id, target_unit_id, strategy)
    select t.id, 'Collections chases → Accounts Receivable', 50, v_de, v_ar, 'lead_then_round_robin'
    where not exists (
      select 1 from work_assignment_rules w
      where w.tenant_id = t.id and w.name = 'Collections chases → Accounts Receivable');
  end loop;
end;
$rules$;

-- ── Run it, daily ───────────────────────────────────────────────────────────
-- 07:10 UTC: after the overnight ERP reconcile (erp-reconcile-nightly) so the
-- outstanding balances the ladder reads are the ones settled overnight, and
-- before a working day starts in Europe so the queue is waiting when the AR
-- desk sits down.

select cron.unschedule('dunning-sweep-daily')
where exists (select 1 from cron.job where jobname = 'dunning-sweep-daily');

select cron.schedule('dunning-sweep-daily', '10 7 * * *', $cron$select run_dunning_sweep();$cron$);

commit;
