-- 590 — an approval the platform cannot carry out.
--
-- 589 raised two real collections chases and routed them to named people. They
-- would both have FAILED the moment anyone approved them.
--
-- The ERPNext executor requires two params:
--     if (!p.external_ref?.trim()) return { error: 'param_required' … }
--     if (!p.note?.trim())         return { error: 'param_required', 'note text is required.' }
--
-- The sweep sent `external_ref` and never sent `note`. Nothing catches that at
-- proposal time: the gate checks whether the action is ALLOWED, not whether it
-- is EXECUTABLE. So the human sees a well-written approval, approves it, and
-- the write fails afterwards — the worst shape of failure, because the person
-- has already been told the work was done as far as their screen is concerned.
--
-- 589 was careful to refuse to raise an approval when no executor exists
-- (`no_executor`) precisely so a human would never grant an approval nothing
-- could act on. Then it raised two that nothing could act on, for a different
-- reason. Checking that an executor EXISTS is not the same as checking it has
-- what it needs.
--
-- ── The other thing this makes visible ──────────────────────────────────────
-- Reading the four executors side by side, they do not do the same thing:
--
--   stripe_send_invoice_reminder     POST /invoices/{id}/send   → EMAILS THE CUSTOMER
--   xero_send_invoice_reminder       POST /Invoices/{id}/Email  → EMAILS THE CUSTOMER
--   quickbooks_send_invoice_reminder POST /invoice/{id}/send    → EMAILS THE CUSTOMER
--   erpnext_invoice_comment          POST /api/resource/Comment → an INTERNAL NOTE
--
-- Three chase the customer. The fourth writes a note on the invoice that only
-- staff can see. Both are legitimate — an internal note is exactly right for
-- the credit-hold rung, whose own tone says "Do not contact the customer" —
-- but they are not interchangeable, and the ERPNext path is the one this
-- workspace's invoices actually use. The note text below is therefore written
-- to be read by a COLLEAGUE, not sent to a customer, and the receipt already
-- says so ("Logged a dunning note on invoice … in ERPNext").
--
-- Chasing an ERPNext customer by email needs a step that does not exist yet.
-- That is named here rather than papered over.

begin;

-- ── Draft the message the chase carries ────────────────────────────────────

create or replace function dunning_note_text(
  p_stage integer, p_customer text, p_invoice_ref text,
  p_days_overdue integer, p_outstanding_cents bigint, p_currency text
) returns text
language sql immutable set search_path = public as $$
  select case coalesce(p_stage, 1)
    when 1 then format(
      'Payment reminder — invoice %s for %s is %s day(s) past due, with %s still outstanding. Likely an oversight. Ask when payment can be expected and whether anything is blocking it. No consequences to be mentioned at this stage.',
      p_invoice_ref, p_customer, p_days_overdue, money_text(p_outstanding_cents, p_currency))
    when 2 then format(
      'Second approach — invoice %s for %s is now %s day(s) past due, with %s still outstanding. Restate the amount and the age, ask for a specific payment date, and copy the account owner. Warm but direct.',
      p_invoice_ref, p_customer, p_days_overdue, money_text(p_outstanding_cents, p_currency))
    when 3 then format(
      'FINAL NOTICE — invoice %s for %s is %s day(s) past due, with %s still outstanding. State the amount, the age, what happens next and by when. No threats and no apology; this is the last message before commercial consequences.',
      p_invoice_ref, p_customer, p_days_overdue, money_text(p_outstanding_cents, p_currency))
    else format(
      'CREDIT HOLD RECOMMENDED — do not contact the customer. %s has %s outstanding on invoice %s, %s day(s) past due, and earlier approaches have not produced payment. Putting the recommendation to a human with the full history.',
      p_customer, money_text(p_outstanding_cents, p_currency), p_invoice_ref, p_days_overdue)
  end;
$$;

grant execute on function dunning_note_text(integer, text, text, integer, bigint, text) to authenticated, service_role;

-- ── Carry it on every proposal ─────────────────────────────────────────────

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
  v_note     text;
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
      v_nodesk := v_nodesk + 1;
      continue;
    end if;
    v_tenants := v_tenants + 1;

    for inv in
      select d.*, ri.source_provider, ri.source_currency
      from dunning_position(t.id) d
      join renewal_invoices ri on ri.id = d.invoice_id
      where d.actionable
      order by d.days_overdue desc
      limit p_limit
    loop
      v_provider := coalesce(nullif(inv.source_provider, ''), 'erpnext');
      v_dedupe   := format('dunning:%s:%s', inv.invoice_id, inv.due_stage);

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

      v_note := dunning_note_text(inv.due_stage, inv.customer, inv.invoice_ref,
                                  inv.days_overdue, inv.outstanding_cents, inv.source_currency);

      v_gate := decide_action_execution(
        t.id,
        format('%s — %s', inv.rung_label, inv.customer),
        'erp_financials',
        coalesce(inv.requires_approval, true),
        v_de,
        inv.outstanding_cents,
        inv.action_key,
        -- The drafted text, not just the label: guardrails scan the CONTENT,
        -- and a rule like "no commitments in writing" can only fire on words
        -- that actually leave the building.
        v_note
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
          'note',              v_note,
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
        p_task_title  => format('%s: %s — %s, %s days overdue',
                           inv.rung_label, inv.customer, inv.invoice_ref, inv.days_overdue),
        -- The human now sees the exact words that will be written, so
        -- "approve" is a decision about the message and not just the intent.
        p_task_detail => format(E'%s\n\nWhat will be written:\n%s\n\nHow to pitch it: %s',
                           inv.why, v_note, inv.tone),
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

-- ── Repair the two already sitting in someone's queue ──────────────────────
-- They are pending, so nobody has been misled yet. Left alone they would fail
-- on approval; deleting them would take work off a person's desk that is
-- genuinely owed.

do $repair$
declare r record; v_note text; v_cur text;
begin
  for r in
    select ae.id, ae.params, ae.task_id, ri.source_currency,
           d.customer, d.days_overdue, d.outstanding_cents, d.why, d.tone
    from action_executions ae
    join renewal_invoices ri on ri.id = (ae.params->>'invoice_id')::uuid
    join lateral dunning_position(ae.tenant_id) d on d.invoice_id = ri.id
    where ae.dedupe_key like 'dunning:%'
      and coalesce(ae.params->>'note', '') = ''
  loop
    v_note := dunning_note_text((r.params->>'stage')::int, r.customer, r.params->>'external_ref',
                                (r.params->>'days_overdue')::int,
                                (r.params->>'outstanding_cents')::bigint, r.source_currency);
    update action_executions
       set params = r.params || jsonb_build_object('note', v_note)
     where id = r.id;

    if r.task_id is not null then
      update human_tasks
         set detail = format(E'%s\n\nWhat will be written:\n%s\n\nHow to pitch it: %s', r.why, v_note, r.tone)
       where id = r.task_id;
    end if;
  end loop;
end;
$repair$;

commit;
