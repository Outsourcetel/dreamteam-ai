-- 701_a_chase_the_platform_can_actually_carry_out.sql
-- ==========================================================================
-- WHY. `run_dunning_sweep` raises real collections approvals about real money
-- and routes them to named people. It writes `p_connector_id => null` on every
-- one of them. The approved re-entry path — the ONLY way a human decision
-- turns into an external write — begins with this line in connector-hub
-- (supabase/functions/connector-hub/index.ts:6186, read live today):
--
--     const connectorId: string = payload.connector_id ?? '';
--     if (!connectorId && action !== 'template_dry_run')
--       return json({ error: 'connector_id_required' }, 400);
--
-- and `resolveActionExecution` (src/lib/connectorApi.ts:1561) hands it the
-- STORED column verbatim:
--
--     await executeAction(row.connector_id, def.action_key, params,
--                         { approvedExecutionId: row.id });
--
-- So a sweep-raised approval cannot be carried out. Not "fails loudly" —
-- `invokeHub` does not throw when the payload carries an `error` key, and
-- `resolveActionExecution` discards the return value, so the human task flips
-- to `approved`, the screen says the work is done, and nothing was sent.
--
-- The autonomous path is shut off by the same column from the other side:
-- `due_approved_actions` (live body) requires `ae.connector_id is not null`,
-- so the approved-action driver cannot see a sweep row either. That filter is
-- CORRECT — a row it cannot route is a row it must not attempt — and it is
-- left exactly as it is. It is named here because it is why this defect has
-- been invisible: the driver reports nothing wrong, it reports nothing at all.
--
-- ── THIS WAS ALREADY KNOWN AND NOT ACTED ON ─────────────────────────────
-- Migration 677's header states it verbatim ("the sweep passes
-- `p_connector_id => null`, and `due_approved_actions` requires
-- `ae.connector_id is not null`, so the approved-action driver can never pick
-- up a sweep-raised approval either"). It was named and deferred there
-- because 677 was about the ladder, not the sweep. This migration is the
-- deferred half.
--
-- Migration 590 is the same defect wearing different clothes — it is titled
-- "an approval the platform cannot carry out" and it fixed a MISSING PARAM.
-- Its closing sentence is the rule this migration applies to the next field
-- along: "Checking that an executor EXISTS is not the same as checking it has
-- what it needs." An executor with no connector has not got what it needs.
--
-- ── MEASURED ON PRODUCTION, 2026-08-11 ──────────────────────────────────
--   * 2 action_executions carry `connector_id is null`. They are ALL of the
--     null-connector rows in the table (186 rows total).
--   * Both: origin_kind `dunning_sweep`, decision `human_gated_destructive`,
--     execution_key `erpnext_invoice_comment`, tenant `outsourcetel-hq`,
--     human_task type `action_approval`, status **pending**, assigned to a
--     named user in the "Accounts Receivable" role. They are precisely the
--     rows a person is being asked to approve.
--   * Both resolve to EXACTLY ONE connector under the rule below
--     (7f595bec…, provider `erpnext`, category `erp_financials`, connected).
--   * No tenant in the database has more than one connected connector sharing
--     a provider+category pair, so the refuse-on-ambiguity branch costs
--     nothing today and is there for the day it does not.
--
-- ⚠ HONESTY, because the two questions are easy to conflate: this is NOT why
-- nothing has executed since 2026-08-05. Nothing has executed because all
-- four pending `action_approval` rows in that workspace are still UNDECIDED.
-- The defect has not fired yet. It fires the first time somebody clicks
-- Approve — which is the reason to fix it now rather than after.
--
-- ── THE RULE, and why it is this one ────────────────────────────────────
-- The pairing already used everywhere else in this codebase is
-- connector.category ↔ action_definition.category, connector.provider ↔
-- action_definition.provider. `get_agentic_tools_for_de` (mig 074) walks
-- `connectors where tenant_id = ? and status = 'connected'` and joins
-- definitions on `category`; connector-hub's `resolveActionDefinition` walks
-- the same edge in the opposite direction (connector → category + provider →
-- definition). `dunning_connector_for` is that same edge, inverted, and
-- nothing else. No new concept is introduced.
--
-- It is a separate small STABLE function rather than a subquery inside the
-- sweep for one reason and it is not tidiness: the sweep needs a live tenant,
-- a finance employee, an overdue invoice and a ladder before it will produce a
-- single row, and a resolution rule that can only be exercised through all of
-- that is a rule nobody will ever test in both directions. Split out, it is
-- driven directly on dev with real rows, five ways, before this file ships.
-- It also matches the shape of its three siblings exactly — `dunning_de_for`,
-- `dunning_action_for`, `dunning_execution_key` — which is what the sweep
-- already looks like.
--
-- ⚠ EXACTLY ONE, or nothing. `dunning_action_for` picks deterministically
-- among candidates (`order by … limit 1`); this function REFUSES. The two are
-- not inconsistent, they are answering different questions. A definition
-- picked wrongly is a wrong VERB and mig 614 made the caller name it; a
-- connector picked wrongly is a write into the wrong company's ERP. Where the
-- blast radius is another tenant's system, connector-hub's own precedent is
-- the one to follow (index.ts:2186 — "AMBIGUOUS AND UNSPECIFIED: refuse
-- rather than guess … the FIRST ROW OF AN UNORDERED QUERY"). An unroutable
-- chase is not raised at all, which is what 589 already does for a missing
-- executor and is strictly better than an approval nobody can honour.
--
-- ── THE TWO EXISTING ROWS: BACK-FILLED, and the argument for it ─────────
-- Back-filling `connector_id` on a pending approval about real money is a
-- data change and it is not made lightly. The alternative — leave them, let a
-- person re-raise — was examined first and IS NOT AVAILABLE. The sweep's own
-- idempotency guard is
--
--     where ae.tenant_id = t.id and ae.dedupe_key = v_dedupe
--       and ae.decision <> 'failed'
--
-- so while these two rows exist in any non-failed state the sweep SKIPS those
-- invoices forever. "Leave them for a person to re-raise" therefore means
-- "those two customers are never chased at stage 2 again" unless somebody
-- deletes ledger rows by hand, which is worse than what is being fixed.
--
-- What the back-fill changes: the routing field the sweep should have written.
-- What it does not change: the decision, the recipient, the amount, the note
-- text, the task, its status, its assignee, or who decides. Both rows remain
-- `human_gated_destructive` and both tasks remain `pending`. Nothing here
-- approves, executes, or claims anything — this migration touches exactly one
-- column, and the WHERE clause below refuses any row whose task is no longer
-- pending, so a decision already taken can never be re-routed after the fact.
--
-- The count is ASSERTED rather than assumed, and the assertion is written so
-- it is meaningful on dev (where the table is empty and 0 rows is the right
-- answer) and on production (where 2 is): after this block, no pending
-- dunning_sweep approval may carry a null connector. If either row failed to
-- resolve, the migration aborts and nothing is written.
--
-- ── NAMED AND LEFT ──────────────────────────────────────────────────────
-- 1. TWO MORE HOLES ON THE SAME RE-ENTRY PATH, fixed in the same change but
--    in TypeScript, not here, because that is where they live:
--      a) `resolveActionExecution` reads `row.action_definition_id` to look up
--         the action_key and then THROWS THE ID AWAY. connector-hub's
--         `resolveActionDefinition` refuses with `action_ambiguous` when a key
--         has more than one executor and the caller did not say which — and
--         `send_payment_reminder` on erpnext has exactly two live executors
--         (`erpnext_invoice_comment` and `erpnext_send_invoice_email`, the
--         second registered 2026-08-05). So every pending erpnext reminder in
--         production — including the two rows with a connector already set —
--         would have failed on approval even after this migration. Mig 614
--         made the DE tool list carry `action_definition_id` for exactly this
--         reason; the approval path was never updated to match.
--      b) both refusals are SILENT. `invokeHub` returns rather than throws
--         when the payload has an `error`, and the hook discards the result.
--         The sibling hook four lines above it in `decideHumanTask` (hook #5,
--         knowledge revisions) was hardened against precisely this and carries
--         the comment "⚠ THE RESULT WAS DISCARDED"; the action hook was not.
-- 2. `due_approved_actions` keeps `ae.connector_id is not null`. It is a
--    correct guard, not the bug, and with the sweep fixed it stops excluding
--    anything. The driver is disabled anyway
--    (`approved_action_driver.enabled_at` is empty on production today).
-- 3. The sweep still records whatever `decide_action_execution` returns with
--    `p_receipt => null`. If that were ever `auto_executed` the ledger would
--    claim an execution the sweep never performed — mig 677 named this and it
--    is unchanged here because `inv.requires_approval` defaults true and
--    destructive-always-gates, so the branch is unreachable today. It is a
--    latent second bug and it is not this migration's.
-- ==========================================================================

begin;

-- ── THE RULE ──────────────────────────────────────────────────────────────
create or replace function public.dunning_connector_for(
  p_tenant_id            uuid,
  p_action_definition_id uuid
) returns uuid
language sql
stable
security definer
set search_path = public
as $function$
  -- The connector that carries out THIS definition for THIS tenant: same
  -- category, same provider, connected. Exactly one, or nothing — a second
  -- candidate collapses the whole thing to null rather than choosing a
  -- company's ERP by row order. (`array_agg(…)[1]` rather than `min()`:
  -- there is no `min(uuid)` in Postgres, and under `count(*) = 1` the array
  -- holds exactly one element, so the subscript is not a choice.)
  select case when count(*) = 1 then (array_agg(c.id))[1] end
  from connectors c
  join action_definitions ad on ad.id = p_action_definition_id
  where c.tenant_id = p_tenant_id
    and c.status    = 'connected'
    and c.category  = ad.category
    and c.provider  = ad.provider;
$function$;

comment on function public.dunning_connector_for(uuid, uuid) is
  'The connector a dunning approval must be carried out through: the tenant''s '
  'single CONNECTED connector whose category and provider match the action '
  'definition''s. Null when there is none OR more than one — an approval the '
  'platform cannot route unambiguously must never be raised. Inverts the same '
  'category+provider edge connector-hub''s resolveActionDefinition walks '
  'forwards. See mig 701.';

-- Same perimeter as its three siblings (`dunning_action_for` and
-- `dunning_de_for` both sit at postgres=X | service_role=X today, read from
-- pg_proc.proacl). anon and authenticated are NAMED roles in Supabase, so
-- `revoke from public` alone would leave them holding it; service_role is
-- granted EXPLICITLY because a bare revoke on a fresh function strips the
-- EXECUTE it was inheriting through PUBLIC. Asserted below, not stated.
revoke execute on function public.dunning_connector_for(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.dunning_connector_for(uuid, uuid)
  to service_role;

-- ── THE SWEEP ─────────────────────────────────────────────────────────────
-- Body preserved verbatim from the live catalog definition read on
-- 2026-08-11 except for: the two new declarations, the resolution block after
-- the executor check, `p_connector_id => v_conn`, and the new return key.
-- `create or replace` PRESERVES the existing grants (postgres, service_role);
-- that is asserted at the bottom rather than trusted.
create or replace function public.run_dunning_sweep(
  p_tenant_id uuid default null,
  p_limit     integer default 200
) returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  t          record;
  inv        record;
  v_de       uuid;
  v_ad       uuid;
  v_conn     uuid;
  v_provider text;
  v_exec     text;
  v_dedupe   text;
  v_note     text;
  v_mail     jsonb;
  v_emails   boolean;
  v_org      text;
  v_params   jsonb;
  v_gate     jsonb;
  v_decision text;
  v_content  text;
  v_detail_txt text;
  v_raised   int := 0;
  v_skipped  int := 0;
  v_noexec   int := 0;
  v_noconn   int := 0;
  v_nodesk   int := 0;
  v_emailed  int := 0;
  v_noaddr   int := 0;
  v_tenants  int := 0;
  v_detail   jsonb := '[]'::jsonb;
begin
  for t in
    select tn.id, tn.slug, tn.name from tenants tn
    where (p_tenant_id is null or tn.id = p_tenant_id)
      and tenant_is_operational(tn.id)
  loop
    v_de := dunning_de_for(t.id);
    if v_de is null then
      v_nodesk := v_nodesk + 1;
      continue;
    end if;
    v_tenants := v_tenants + 1;
    v_org := coalesce(nullif(t.name, ''), 'Accounts Receivable');

    for inv in
      select d.*, ri.source_provider, ri.source_currency, ri.due_date, ri.contact_email
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

      v_exec := dunning_execution_key(v_provider, inv.action_key,
                                      nullif(btrim(coalesce(inv.contact_email,'')), '') is not null);
      v_ad   := dunning_action_for(t.id, inv.action_key, v_exec);
      if v_ad is null then
        v_noexec := v_noexec + 1;
        v_detail := v_detail || jsonb_build_object(
          'tenant', t.slug, 'invoice', inv.invoice_ref, 'skipped', 'no_executor',
          'wanted', inv.action_key, 'provider', v_provider, 'execution_key', v_exec);
        continue;
      end if;

      -- KNOWING WHICH VERB IS NOT KNOWING WHICH SYSTEM. Without this, the row
      -- is raised with a null connector and the approved re-entry path returns
      -- `connector_id_required` — silently, after the human has been told the
      -- work is done. Same refusal shape as `no_executor` directly above, for
      -- the same reason 589 introduced that one.
      v_conn := dunning_connector_for(t.id, v_ad);
      if v_conn is null then
        v_noconn := v_noconn + 1;
        v_detail := v_detail || jsonb_build_object(
          'tenant', t.slug, 'invoice', inv.invoice_ref, 'skipped', 'no_connector',
          'wanted', inv.action_key, 'provider', v_provider, 'execution_key', v_exec,
          'why', 'no single connected connector in this workspace matches the executor''s provider and category');
        continue;
      end if;

      v_emails := (v_exec = 'erpnext_send_invoice_email'
                   or v_exec like '%_send_invoice_reminder');
      v_note   := dunning_note_text(inv.due_stage, inv.customer, inv.invoice_ref,
                                    inv.days_overdue, inv.outstanding_cents, inv.source_currency);
      v_mail   := dunning_email(inv.due_stage, inv.customer, inv.invoice_ref, inv.days_overdue,
                                inv.outstanding_cents, inv.source_currency, inv.due_date, v_org);

      -- The internal note and the customer email are built from the same facts
      -- but are never the same string. The note tells a colleague how to pitch
      -- it; the email is what a customer reads.
      if v_emails and v_mail is not null then
        v_params := jsonb_build_object(
          'external_ref', inv.invoice_ref,
          'recipient',    inv.contact_email,
          'subject',      v_mail->>'subject',
          'body',         v_mail->>'body',
          'invoice_id',   inv.invoice_id, 'stage', inv.due_stage,
          'days_overdue', inv.days_overdue, 'outstanding_cents', inv.outstanding_cents);
        v_content := v_mail->>'body';
        v_detail_txt := format(E'%s\n\nThis EMAILS THE CUSTOMER at %s.\n\nSubject: %s\n\n%s',
                          inv.why, inv.contact_email, v_mail->>'subject', v_mail->>'body');
        v_emailed := v_emailed + 1;
      else
        -- No address, or a rung that must not reach the customer.
        v_params := jsonb_build_object(
          'external_ref', inv.invoice_ref, 'note', v_note,
          'invoice_id',   inv.invoice_id, 'stage', inv.due_stage,
          'days_overdue', inv.days_overdue, 'outstanding_cents', inv.outstanding_cents,
          'tone', inv.tone);
        v_content := v_note;
        if inv.action_key <> 'flag_for_collections'
           and nullif(btrim(coalesce(inv.contact_email,'')), '') is null then
          v_noaddr := v_noaddr + 1;
          v_detail_txt := format(E'%s\n\n⚠ THE CUSTOMER WILL NOT SEE THIS. No email address is recorded on invoice %s, so this writes an internal note in ERPNext instead of chasing anyone. Add a contact email to the invoice and re-run to send a real reminder.\n\nWhat will be written:\n%s',
                            inv.why, inv.invoice_ref, v_note);
        else
          v_detail_txt := format(E'%s\n\nInternal note only — the customer is not contacted at this stage.\n\nWhat will be written:\n%s',
                            inv.why, v_note);
        end if;
      end if;

      v_gate := decide_action_execution(
        t.id,
        format('%s — %s', inv.rung_label, inv.customer),
        'erp_financials',
        coalesce(inv.requires_approval, true),
        v_de,
        inv.outstanding_cents,
        inv.action_key,
        -- Guardrails scan the CONTENT, so they must see the words that will
        -- actually leave the building, not a summary of them.
        v_content
      );
      v_decision := coalesce(v_gate->>'decision', 'human_gated_destructive');

      perform record_action_execution(
        p_tenant_id            => t.id,
        p_action_definition_id => v_ad,
        p_connector_id         => v_conn,
        p_subject_kind         => 'de',
        p_subject_id           => v_de,
        p_mode                 => 'execute',
        p_params               => v_params,
        p_decision      => v_decision,
        p_destructive   => coalesce(inv.requires_approval, true),
        p_idempotent    => false,
        p_dedupe_key    => v_dedupe,
        p_request_summary => format('%s for %s — invoice %s, %s day(s) overdue.%s',
                              inv.rung_label, inv.customer, inv.invoice_ref, inv.days_overdue,
                              case when v_emails and v_mail is not null
                                   then ' Emails the customer.' else ' Internal note only.' end),
        p_receipt   => null,
        p_result    => null,
        p_task_title  => format('%s%s: %s — %s, %s days overdue',
                           case when v_emails and v_mail is not null then 'Email ' else '' end,
                           inv.rung_label, inv.customer, inv.invoice_ref, inv.days_overdue),
        p_task_detail => v_detail_txt,
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
    'emails_drafted',     v_emailed,
    'notes_only_no_address', v_noaddr,
    'already_proposed',   v_skipped,
    'no_executor',        v_noexec,
    'no_connector',       v_noconn,
    'tenants_without_a_finance_employee', v_nodesk,
    'detail',             v_detail
  );
end;
$function$;

-- ── THE TWO ROWS ALREADY RAISED ───────────────────────────────────────────
-- One column, on rows that are still awaiting a decision. Argued in full in
-- the header. Nothing is approved, claimed or executed here.
do $backfill$
declare
  v_updated int;
  v_stuck   int;
begin
  update action_executions ae
     set connector_id = public.dunning_connector_for(ae.tenant_id, ae.action_definition_id)
    from human_tasks ht
   where ht.id = ae.task_id
     and ae.connector_id is null
     and ae.origin_kind  = 'dunning_sweep'
     and ae.decision like 'human_gated%'
     and ae.receipt is null
     and ae.rolled_back_at is null
     -- ⚠ A DECISION ALREADY TAKEN IS HISTORY. Re-routing a decided approval
     -- after the fact would rewrite what a person signed off on.
     and ht.status = 'pending'
     and public.dunning_connector_for(ae.tenant_id, ae.action_definition_id) is not null;
  get diagnostics v_updated = row_count;
  raise notice '701: back-filled connector_id on % pending dunning approval(s)', v_updated;

  -- Meaningful on BOTH environments: dev has no action_executions at all and
  -- 0 is the correct answer there; production has exactly 2 and both resolve.
  -- If a row could not be routed, this aborts and writes nothing.
  select count(*) into v_stuck
    from action_executions ae
    join human_tasks ht on ht.id = ae.task_id
   where ae.connector_id is null
     and ae.origin_kind = 'dunning_sweep'
     and ae.decision like 'human_gated%'
     and ht.status = 'pending';
  if v_stuck > 0 then
    raise exception '701: % pending dunning approval(s) still carry a null connector — they cannot be resolved to a single connected connector, and raising/leaving them is the defect this migration exists to remove', v_stuck;
  end if;
end $backfill$;

-- ── ASSERTIONS ────────────────────────────────────────────────────────────
do $assert$
declare
  v_src text;
  v_n   int;
begin
  -- A. The rule itself is SHAPED right.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'dunning_connector_for'
      and pg_get_function_identity_arguments(p.oid) = 'p_tenant_id uuid, p_action_definition_id uuid'
      and p.provolatile = 's' and p.prosecdef
      and array_to_string(p.proconfig, ',') like '%search_path=public%')
  then
    raise exception '701: dunning_connector_for is missing, or lost STABLE / SECURITY DEFINER / its pinned search_path — a SECDEF function without a pinned search_path is the hole mig 610 exists for';
  end if;

  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'dunning_connector_for';
  -- ⚠ STRIP THE COMMENTS FIRST. `prosrc` is the whole body, prose included, so
  -- a bare substring pin is satisfied by a comment MENTIONING the thing it is
  -- supposed to be pinning. Two pins in the first draft of this block passed
  -- against a deliberately broken function for exactly that reason — the
  -- ambiguity guard and the mig-589 refusal both survived deletion because
  -- the words still appeared in the commentary above them. Caught by
  -- mutation-testing the pins, which is the only way that is ever caught.
  v_src := regexp_replace(v_src, '--[^\n]*', '', 'g');

  -- ⚠ REGEX, not LIKE, on every source pin below. `%a%=>%null%` matches across
  -- the WHOLE body: `p_connector_id => v_conn` followed sixteen lines later by
  -- `p_receipt => null` satisfies it, so the LIKE form of the central pin here
  -- fires on the FIXED function and can never fire on the broken one. A pin
  -- that is green when it should be red and red when it should be green is
  -- worse than no pin. Each pattern below is anchored to one expression.
  if v_src !~ 'count\(\*\)\s*=\s*1' then
    raise exception '701: dunning_connector_for no longer refuses on ambiguity — it would pick one company''s ERP over another by row order';
  end if;
  if v_src !~ 'c\.status\s*=\s*''connected''' then
    raise exception '701: dunning_connector_for no longer requires a CONNECTED connector — an approval would be routed to a system nobody is authenticated against';
  end if;
  if v_src !~ 'c\.tenant_id\s*=\s*p_tenant_id' then
    raise exception '701: dunning_connector_for lost its tenant scope — this is SECURITY DEFINER and takes the tenant as a PARAMETER, so that is a cross-tenant write route';
  end if;
  if v_src !~ 'c\.provider\s*=\s*ad\.provider' or v_src !~ 'c\.category\s*=\s*ad\.category' then
    raise exception '701: dunning_connector_for no longer pairs on BOTH provider and category — that pair IS the edge connector-hub resolves in the other direction';
  end if;

  -- B. The sweep actually USES it, and no longer hardcodes null.
  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'run_dunning_sweep';
  v_src := regexp_replace(v_src, '--[^\n]*', '', 'g');   -- code only; see above

  if v_src ~ 'p_connector_id\s*=>\s*null' then
    raise exception '701: run_dunning_sweep still passes p_connector_id => null — the approved re-entry path returns connector_id_required and the approval is unexecutable';
  end if;
  if v_src !~ 'p_connector_id\s*=>\s*v_conn' then
    raise exception '701: run_dunning_sweep does not record the resolved connector';
  end if;

  select count(*) into v_n from regexp_matches(v_src, 'dunning_connector_for\(', 'g');
  if v_n <> 1 then
    raise exception '701: expected exactly one dunning_connector_for call in run_dunning_sweep, found % — a second call site means the rule is being asked twice and could answer differently', v_n;
  end if;

  if v_src !~ 'if\s+v_conn\s+is\s+null\s+then' then
    raise exception '701: the sweep no longer REFUSES when the connector cannot be resolved — it would go back to raising approvals nobody can carry out, which is mig 590''s defect returning by a different field';
  end if;
  if v_src !~ '''skipped'',\s*''no_connector''' or v_src !~ '''no_connector''\s*,\s*v_noconn' then
    raise exception '701: the refusal is no longer reported in the sweep result — a silent skip is how this class of defect stays invisible for a week';
  end if;
  -- The refusal must come BEFORE anything is written, not after.
  if position('dunning_connector_for(' in v_src) > position('record_action_execution(' in v_src) then
    raise exception '701: the connector is resolved AFTER the row is written — the check would be decoration';
  end if;
  -- Everything 589/590 already guaranteed must still be there.
  if v_src !~ '''skipped'',\s*''no_executor''' or v_src !~ '''no_executor''\s*,\s*v_noexec' then
    raise exception '701: the mig-589 no_executor refusal was lost in the rewrite';
  end if;
  if v_src !~ 'dunning_note_text\(' or v_src !~ '''note''\s*,\s*v_note' then
    raise exception '701: the mig-590 note param was lost in the rewrite — the ERPNext executor requires it and the approval would fail after a human approved it';
  end if;
  if v_src !~ 'ae\.decision\s*<>\s*''failed''' then
    raise exception '701: the sweep lost its idempotency guard and would re-raise a chase on every run';
  end if;

  -- C. THE PERIMETER, asserted rather than stated.
  if has_function_privilege('anon', 'public.dunning_connector_for(uuid, uuid)', 'EXECUTE') then
    raise exception '701: anon can execute dunning_connector_for — anon is the internet';
  end if;
  if has_function_privilege('authenticated', 'public.dunning_connector_for(uuid, uuid)', 'EXECUTE') then
    raise exception '701: authenticated can execute dunning_connector_for';
  end if;
  -- `has_function_privilege('public', …)` — the mig-679 form. NOT a proacl
  -- string match: every grantee entry contains "=X/", so `proacl like '%=X/%'`
  -- is true whenever ANYONE holds EXECUTE, including the service_role grant
  -- three lines below that this migration deliberately makes.
  if has_function_privilege('public', 'public.dunning_connector_for(uuid, uuid)', 'EXECUTE') then
    raise exception '701: PUBLIC still holds EXECUTE on dunning_connector_for — revoking the named roles alone is theatre (mig 610)';
  end if;
  if not has_function_privilege('service_role', 'public.dunning_connector_for(uuid, uuid)', 'EXECUTE') then
    raise exception '701: service_role LOST EXECUTE on dunning_connector_for — the sweep runs as the service role and a bare revoke strips the grant it was inheriting through PUBLIC';
  end if;
  -- create-or-replace preserves grants. Trust nothing; check.
  if not has_function_privilege('service_role', 'public.run_dunning_sweep(uuid, integer)', 'EXECUTE') then
    raise exception '701: service_role LOST EXECUTE on run_dunning_sweep — the sweep would stop running entirely';
  end if;
  if has_function_privilege('anon', 'public.run_dunning_sweep(uuid, integer)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.run_dunning_sweep(uuid, integer)', 'EXECUTE') then
    raise exception '701: run_dunning_sweep''s perimeter regressed — anon or authenticated can now raise collections approvals';
  end if;

  -- D. Nothing was decided, claimed or executed by this migration. Scoped to
  -- exactly the rows the back-fill could reach — a sweep row whose task has
  -- since been decided and carried out will legitimately be `executed_after_
  -- approval` with a receipt, and this must not fail the day that happens.
  if exists (
    select 1 from action_executions ae
    join human_tasks ht on ht.id = ae.task_id
    where ae.origin_kind = 'dunning_sweep'
      and ht.status = 'pending'
      and (ae.decision not like 'human_gated%'
           or ae.receipt is not null
           or ae.resolves_task_id is not null))
  then
    raise exception '701: a pending dunning approval is no longer an undecided gate — this migration must change ONE routing column and nothing else';
  end if;
end $assert$;

commit;
