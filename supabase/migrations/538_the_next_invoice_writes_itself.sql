-- 538_the_next_invoice_writes_itself.sql
-- ============================================================================
-- STEP 5: generate the next period's invoice from the agreement that entitles
-- it — as a DRAFT, balanced and evidenced, for a human to approve.
--
-- For a recurring-services business the renewal largely IS the next correct
-- invoice, which is why the founder put invoicing and renewals on one chain
-- rather than treating them as separate bets. The judgment in a renewal is the
-- price; the labour is producing the document. This automates the labour and
-- leaves the judgment where it belongs.
--
-- ── NOTHING IS INVENTED ────────────────────────────────────────────────────
-- The amount comes from the agreement's own baseline_value_cents. An agreement
-- with no stated value produces NO invoice and says why — the one thing worse
-- than not invoicing is invoicing a number nobody agreed. Same rule as the
-- balance, the book and the posting: absent means absent, never zero, never a
-- guess.
--
-- ── IT RIDES THE CONTROLS ALREADY BUILT ────────────────────────────────────
-- The output is a posting_draft (mig 531), so the trigger there already
-- guarantees it balances to the cent and every line names its source before it
-- can reach a reviewer. Nothing new was invented for approval or for evidence.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.propose_invoice_from_agreement(
  p_agreement_id uuid, p_period_start date, p_period_end date, p_de_id uuid DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE ag commercial_agreements; v_draft uuid; v_cust text; v_amt bigint; v_key text;
BEGIN
  SELECT * INTO ag FROM commercial_agreements WHERE id = p_agreement_id;
  IF ag.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'agreement_not_found'); END IF;
  IF p_period_end <= p_period_start THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The period must end after it starts.');
  END IF;

  v_amt := ag.baseline_value_cents;
  IF v_amt IS NULL OR v_amt <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error',
      'This agreement states no value, so there is no defensible amount to invoice. Record the contracted value first — an invoice for a guessed number is worse than a late one.');
  END IF;

  -- One invoice per agreement per period. Re-running must not raise a second.
  v_key := p_agreement_id::text || '|' || p_period_start::text;
  IF EXISTS (SELECT 1 FROM posting_drafts d
              WHERE d.tenant_id = ag.tenant_id AND d.kind = 'sales_invoice'
                AND d.payload->>'period_key' = v_key
                AND d.status <> 'rejected') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_drafted', 'period_key', v_key);
  END IF;

  v_cust := coalesce((SELECT name FROM customer_accounts WHERE id = ag.account_id),
                     ag.counterparty_name, '(unknown counterparty)');

  INSERT INTO posting_drafts (tenant_id, de_id, kind, title, rationale, posting_date, currency, payload)
  VALUES (ag.tenant_id, p_de_id, 'sales_invoice',
    format('%s — %s to %s', v_cust, to_char(p_period_start,'FMDD Mon YYYY'), to_char(p_period_end,'FMDD Mon YYYY')),
    format('Recurring charge under %L for the period %s to %s. The amount is the contracted value of %s stated on the agreement; it has not been recalculated or adjusted.',
           coalesce(ag.title,'(untitled agreement)'), to_char(p_period_start,'FMDD Mon YYYY'),
           to_char(p_period_end,'FMDD Mon YYYY'), money_text(v_amt, ag.currency)),
    current_date, coalesce(nullif(ag.currency,''), 'USD'),
    jsonb_build_object('period_key', v_key, 'period_start', p_period_start, 'period_end', p_period_end,
                       'agreement_id', ag.id, 'customer', v_cust))
  RETURNING id INTO v_draft;

  INSERT INTO posting_draft_lines (draft_id, line_no, account, description, debit_cents, credit_cents,
                                   evidence_table, evidence_id, evidence_note)
  VALUES
    (v_draft, 1, 'Debtors', format('%s — receivable', v_cust), v_amt, 0,
     'commercial_agreements', ag.id::text,
     format('Contracted value stated on agreement %L', coalesce(ag.title,'(untitled)'))),
    (v_draft, 2, 'Revenue',
     format('Services %s to %s', to_char(p_period_start,'FMDD Mon'), to_char(p_period_end,'FMDD Mon')),
     0, v_amt,
     'commercial_agreements', ag.id::text, 'Revenue for the period the agreement covers');

  UPDATE posting_drafts SET status = 'submitted' WHERE id = v_draft;

  RETURN jsonb_build_object('ok', true, 'draft_id', v_draft, 'amount', money_text(v_amt, ag.currency),
                            'awaiting', 'human approval');
END $fn$;

COMMENT ON FUNCTION public.propose_invoice_from_agreement(uuid,date,date,uuid) IS
  'Drafts the next period''s invoice from the agreement that entitles it, as a balanced and evidenced posting_draft awaiting approval. Refuses when the agreement states no value — an invoice for a guessed number is worse than a late one. One draft per agreement per period.';

REVOKE ALL ON FUNCTION public.propose_invoice_from_agreement(uuid,date,date,uuid) FROM PUBLIC;

notify pgrst, 'reload schema';

DO $a$
DECLARE
  v_tenant uuid; v_ag uuid; v_novalue uuid; v_res jsonb; v_draft uuid; v_view jsonb; v_saved bigint;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE slug = 'outsourcetel-hq';
  SELECT id INTO v_ag FROM commercial_agreements
   WHERE tenant_id = v_tenant AND baseline_value_cents > 0 LIMIT 1;
  IF v_ag IS NULL THEN RAISE EXCEPTION '538: no agreement with a stated value to test against'; END IF;

  -- ── an agreement with no stated value must produce NO invoice ───────────
  SELECT id, baseline_value_cents INTO v_novalue, v_saved FROM commercial_agreements
   WHERE tenant_id = v_tenant AND id <> v_ag LIMIT 1;
  IF v_novalue IS NOT NULL THEN
    UPDATE commercial_agreements SET baseline_value_cents = NULL WHERE id = v_novalue;
    v_res := propose_invoice_from_agreement(v_novalue, current_date, current_date + 30);
    IF (v_res->>'ok')::boolean THEN
      RAISE EXCEPTION '538: invoiced an agreement that states no value';
    END IF;
    UPDATE commercial_agreements SET baseline_value_cents = v_saved WHERE id = v_novalue;
  END IF;

  -- ── a real one drafts, balances, and cites the agreement ────────────────
  v_res := propose_invoice_from_agreement(v_ag, current_date, current_date + 30);
  IF NOT (v_res->>'ok')::boolean THEN RAISE EXCEPTION '538: refused a valid agreement: %', v_res; END IF;
  v_draft := (v_res->>'draft_id')::uuid;

  v_view := get_posting_draft(v_draft);
  IF (v_view->>'balances')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION '538: the drafted invoice does not balance: %', v_view;
  END IF;
  IF (v_view->>'status') <> 'submitted' THEN
    RAISE EXCEPTION '538: the invoice did not reach the approval gate (status %)', v_view->>'status';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_view->'lines') e
              WHERE coalesce(e->>'from','') NOT LIKE 'commercial_agreements:%') THEN
    RAISE EXCEPTION '538: a line does not cite the agreement it came from';
  END IF;

  -- ── the same period must not invoice twice ──────────────────────────────
  v_res := propose_invoice_from_agreement(v_ag, current_date, current_date + 30);
  IF (v_res->>'ok')::boolean THEN RAISE EXCEPTION '538: invoiced the same period twice'; END IF;
  IF (v_res->>'error') <> 'already_drafted' THEN
    RAISE EXCEPTION '538: the duplicate was refused for the wrong reason: %', v_res;
  END IF;

  DELETE FROM posting_drafts WHERE id = v_draft;
  IF EXISTS (SELECT 1 FROM posting_drafts WHERE tenant_id = v_tenant) THEN
    RAISE EXCEPTION '538: the self-test left a draft behind';
  END IF;

  RAISE NOTICE '538: the next invoice drafts itself from the agreement, balanced, evidenced, and waiting for a person';
END $a$;
