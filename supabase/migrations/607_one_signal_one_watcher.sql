-- 607 — one signal, one watcher.
--
-- 606 installed intake per EMPLOYEE. Three roles in outsourcetel-hq match the
-- finance family — Finance DE, Accounting DE, Billing & Invoicing DE — so all
-- three received "Invoice coming due (14/7/1 day)". The same invoice reaching
-- the same horizon would have opened THREE objectives, one per employee, and
-- three employees would each have prepared the same reminder.
--
-- That is the queue amplifier again (mig 583), rebuilt by my own installer
-- eight migrations after removing it, and it is the same shape as the two
-- parallel AR stacks: one fact, several owners, no way to tell which answer is
-- the real one.
--
-- A watcher describes a SIGNAL — "an invoice is coming due" — not an employee's
-- job description. A signal has one owner. Whoever holds it can consult or
-- delegate; what must not happen is three employees independently discovering
-- the same invoice.
--
-- Caught before any tick fired, so no duplicate objective was ever created.

begin;

-- ── Remove the duplicates 606 created, keeping one owner per signal ──────
-- Earliest wins: it is deterministic, and where a workspace already had a
-- watcher for that signal before 606 ran, that pre-existing one is the keeper.

with ranked as (
  select w.id,
         row_number() over (
           partition by w.tenant_id, w.kind, coalesce(w.config->>'source',''), w.label
           order by w.created_at asc, w.id asc
         ) as rn
  from work_watchers w
  where w.active
)
delete from work_watchers w
using ranked r
where w.id = r.id and r.rn > 1;

-- ── Make the duplication impossible, not merely undone ───────────────────
-- A partial unique index is the difference between "we tidied it" and "it
-- cannot happen again". Only ACTIVE watchers are constrained: a retired one
-- should not block re-creating the signal later.
create unique index if not exists idx_work_watchers_one_owner_per_signal
  on work_watchers (tenant_id, kind, (coalesce(config->>'source', '')), label)
  where active;

-- ── The installer stops creating them ────────────────────────────────────

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
  v_taken    int := 0;
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
    -- Deterministic, so which employee owns a signal does not depend on the
    -- order rows happen to come back in.
    order by de.created_at asc, de.id asc
  loop
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
      v_kind := 'date_horizon'; v_source := 'renewal_invoices';
      v_label := 'Invoice coming due (14/7/1 day)';
      v_desc  := 'Prepare for an invoice falling due — confirm the balance and that the customer has what they need to pay.';
      v_config := jsonb_build_object('source','renewal_invoices','date_field','due_date',
                    'horizons_days', jsonb_build_array(14,7,1),
                    'status_filter', jsonb_build_array('sent','awaiting_approval','pending_generation'));

    else
      v_norole := v_norole + 1;
      v_detail := v_detail || jsonb_build_object('de', d.name, 'skipped', 'no catalogued source for this role');
      continue;
    end if;

    -- ⚠ THE SIGNAL, not the employee. Three finance-family roles in one
    -- workspace must not each watch the same invoices.
    if exists (
      select 1 from work_watchers w
      where w.tenant_id = p_tenant_id and w.active and w.kind = v_kind
        and coalesce(w.config->>'source','') = v_source and w.label = v_label
    ) then
      -- Distinguish "this employee already had it" from "a colleague owns it".
      if exists (
        select 1 from work_watchers w
        where w.de_id = d.id and w.active and w.kind = v_kind
          and coalesce(w.config->>'source','') = v_source and w.label = v_label
      ) then
        v_existing := v_existing + 1;
      else
        v_taken := v_taken + 1;
        v_detail := v_detail || jsonb_build_object('de', d.name, 'skipped', 'a colleague already owns this signal', 'signal', v_label);
      end if;
      continue;
    end if;

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
    'skipped_owned_by_a_colleague', v_taken,
    'skipped_source_empty', v_nodata, 'skipped_no_catalogued_source', v_norole,
    'detail', v_detail);
end;
$$;

grant execute on function install_role_watchers(uuid) to service_role;

do $verify$
declare v_dupes int;
begin
  select count(*) into v_dupes from (
    select tenant_id, kind, coalesce(config->>'source',''), label
    from work_watchers where active
    group by 1,2,3,4 having count(*) > 1) d;
  if v_dupes > 0 then
    raise exception '% signals still have more than one owner', v_dupes;
  end if;

  -- Re-running must be a no-op now, not a second helping.
  perform install_role_watchers(id) from tenants where slug = 'outsourcetel-hq';
  select count(*) into v_dupes from (
    select tenant_id, kind, coalesce(config->>'source',''), label
    from work_watchers where active
    group by 1,2,3,4 having count(*) > 1) d;
  if v_dupes > 0 then
    raise exception 're-running the installer created % duplicate signals', v_dupes;
  end if;

  raise notice 'one owner per signal, and the installer is idempotent';
end;
$verify$;

commit;
