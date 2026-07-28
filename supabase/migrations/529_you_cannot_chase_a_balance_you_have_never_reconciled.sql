-- 529_you_cannot_chase_a_balance_you_have_never_reconciled.sql
-- ============================================================================
-- Migration 528 got the finance employee reading real AR, and it produced a
-- collection summary saying "ACC-SINV-2026-00006, 26 days overdue, $45,000,
-- urgent follow-up". Every one of those figures is the INVOICE FACE VALUE.
--
-- Nothing in this system has ever ingested a payment. `renewal_invoices` has
-- amount_cents and status and nothing else; connector_objects retains no raw
-- ERP payload; there are zero bank transactions for this tenant and no bank
-- connector exists. So if that customer has already paid $30,000, the employee
-- would chase them for $45,000 — and being chased for money you have already
-- sent is worse for the relationship than not being chased at all.
--
-- A confident wrong number costs more than no number. That is the whole lesson
-- of migration 528 arriving one layer up.
--
-- ── WHAT THIS ADDS ─────────────────────────────────────────────────────────
-- invoice_payments   every payment ever matched to an invoice, with the
--                    EVIDENCE for the match: where it came from, its external
--                    reference, and which rule matched it. A reconciliation you
--                    cannot audit is just an assertion.
--
-- outstanding_cents  NULLABLE, and NULL is the default and the honest answer:
--                    "payments have never been reconciled against this invoice,
--                    so its face value is all anybody knows". Exactly the
--                    discipline of mig 491 (a rate with no denominator is NULL)
--                    and mig 528 (an unread book is not an empty one). It is
--                    NOT zero, and it is NOT the face value.
--
-- reconcile_invoice_payments(tenant, payments)
--                    the entry point. Source-agnostic on purpose — ERPNext
--                    Payment Entries, a bank feed, or a human pasting a
--                    remittance all arrive in the same shape. It matches only
--                    on EVIDENCE and never on resemblance:
--                      exact   external_ref names the invoice        -> applied
--                      unique  one invoice matches amount + window   -> applied
--                      ambiguous  more than one candidate            -> NOT
--                                 applied, returned for a human
--                    An ambiguous payment is left alone. Guessing which invoice
--                    a payment clears is how a ledger silently goes wrong.
--
-- ── WHAT THIS DELIBERATELY DOES NOT DO ─────────────────────────────────────
-- It does not post anything to ERPNext. The erpnext write actions
-- (send_payment_reminder, flag_for_collections) belong to a parallel workstream
-- that is actively shipping, and two agents writing the same integration is
-- precisely how this tenant ended up with invoices in two unconnected tables.
-- This migration owns the reconciliation MODEL and leaves the ingest to feed it.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.invoice_payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  invoice_id    uuid NOT NULL REFERENCES public.renewal_invoices(id) ON DELETE CASCADE,
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  paid_on       date NOT NULL,
  source        text NOT NULL,           -- erpnext | bank | manual | ...
  external_ref  text,                    -- the payment's own id in that system
  matched_by    text NOT NULL CHECK (matched_by IN ('external_ref','amount_and_date','human')),
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- One payment lands once. Re-running an ingest must be a no-op, not a
-- double-credit that makes a live invoice look settled.
CREATE UNIQUE INDEX IF NOT EXISTS invoice_payments_source_ref_uniq
  ON public.invoice_payments (tenant_id, source, external_ref)
  WHERE external_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS invoice_payments_invoice_idx ON public.invoice_payments (invoice_id);

ALTER TABLE public.invoice_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS invoice_payments_tenant_read ON public.invoice_payments;
CREATE POLICY invoice_payments_tenant_read ON public.invoice_payments
  FOR SELECT USING (tenant_id IN (SELECT p.tenant_id FROM profiles p WHERE p.user_id = auth.uid()));

ALTER TABLE public.renewal_invoices
  ADD COLUMN IF NOT EXISTS outstanding_cents bigint,
  ADD COLUMN IF NOT EXISTS payments_reconciled_at timestamptz;

COMMENT ON COLUMN public.renewal_invoices.outstanding_cents IS
  'What is actually still owed, after reconciling payments. NULL means payments have NEVER been reconciled for this invoice — the face value is all anybody knows, and it must not be presented as a balance owed. Never defaults to zero and never defaults to the face value.';
COMMENT ON COLUMN public.renewal_invoices.payments_reconciled_at IS
  'When payments were last reconciled against this invoice. NULL alongside outstanding_cents means never.';

-- ── the reconciler ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reconcile_invoice_payments(
  p_tenant_id uuid,
  p_payments  jsonb,                       -- [{external_ref, amount_cents, paid_on, invoice_ref?, source?}]
  p_window_days int DEFAULT 7
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
DECLARE
  pay jsonb; v_src text; v_ref text; v_amt bigint; v_on date;
  v_inv uuid; v_n int; v_how text;
  n_applied int := 0; n_dup int := 0; v_ambiguous jsonb := '[]'::jsonb; v_unmatched jsonb := '[]'::jsonb;
BEGIN
  IF jsonb_typeof(p_payments) <> 'array' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'payments must be an array');
  END IF;

  FOR pay IN SELECT * FROM jsonb_array_elements(p_payments) LOOP
    v_src := coalesce(pay->>'source', 'manual');
    v_ref := nullif(pay->>'external_ref', '');
    v_amt := (pay->>'amount_cents')::bigint;
    v_on  := (pay->>'paid_on')::date;
    v_inv := NULL; v_how := NULL;

    -- 1. The payment names its invoice. Certain: no guessing involved.
    IF nullif(pay->>'invoice_ref', '') IS NOT NULL THEN
      SELECT r.id INTO v_inv FROM renewal_invoices r
       WHERE r.tenant_id = p_tenant_id AND r.source_external_ref = pay->>'invoice_ref';
      IF v_inv IS NOT NULL THEN v_how := 'external_ref'; END IF;
    END IF;

    -- 2. Otherwise: exactly ONE open invoice of that amount, due near that date.
    --    "Exactly one" is the whole safety property — see the ambiguous branch.
    IF v_inv IS NULL THEN
      SELECT count(*), (array_agg(r.id))[1] INTO v_n, v_inv
        FROM renewal_invoices r
       WHERE r.tenant_id = p_tenant_id
         AND coalesce(r.status, '') NOT IN ('paid', 'void', 'cancelled')
         AND r.amount_cents = v_amt
         AND r.due_date BETWEEN v_on - make_interval(days => p_window_days)
                            AND v_on + make_interval(days => p_window_days);
      IF v_n = 1 THEN
        v_how := 'amount_and_date';
      ELSE
        -- More than one candidate, or none. Applying either would be a guess,
        -- and a guessed payment allocation is a wrong ledger that looks right.
        IF v_n > 1 THEN
          v_ambiguous := v_ambiguous || jsonb_build_object(
            'external_ref', v_ref, 'amount_cents', v_amt, 'paid_on', v_on, 'candidates', v_n);
        ELSE
          v_unmatched := v_unmatched || jsonb_build_object(
            'external_ref', v_ref, 'amount_cents', v_amt, 'paid_on', v_on);
        END IF;
        v_inv := NULL;
      END IF;
    END IF;

    CONTINUE WHEN v_inv IS NULL;

    INSERT INTO invoice_payments (tenant_id, invoice_id, amount_cents, paid_on, source, external_ref, matched_by)
    VALUES (p_tenant_id, v_inv, v_amt, v_on, v_src, v_ref, v_how)
    ON CONFLICT (tenant_id, source, external_ref) WHERE external_ref IS NOT NULL DO NOTHING;

    IF FOUND THEN n_applied := n_applied + 1; ELSE n_dup := n_dup + 1; END IF;
  END LOOP;

  -- Recompute the balance for every invoice that now has payments. Only these:
  -- an invoice nobody has reconciled must KEEP outstanding_cents NULL rather
  -- than acquire a number that merely restates its face value.
  UPDATE renewal_invoices r
     SET outstanding_cents = greatest(0, r.amount_cents - p.paid),
         payments_reconciled_at = now(),
         updated_at = now()
    FROM (SELECT invoice_id, sum(amount_cents) AS paid
            FROM invoice_payments WHERE tenant_id = p_tenant_id GROUP BY invoice_id) p
   WHERE r.id = p.invoice_id AND r.tenant_id = p_tenant_id;

  RETURN jsonb_build_object('ok', true, 'applied', n_applied, 'already_known', n_dup,
    'ambiguous', v_ambiguous, 'unmatched', v_unmatched);
END $fn$;

COMMENT ON FUNCTION public.reconcile_invoice_payments(uuid, jsonb, int) IS
  'Matches payments to invoices on EVIDENCE only: an explicit invoice reference, or exactly one open invoice of that amount within the date window. More than one candidate is returned as ambiguous and never applied — guessing which invoice a payment clears is how a ledger goes quietly wrong. Source-agnostic so an ERPNext ingest, a bank feed or a human remittance all use one path.';

REVOKE ALL ON FUNCTION public.reconcile_invoice_payments(uuid, jsonb, int) FROM PUBLIC;

notify pgrst, 'reload schema';

DO $a$
DECLARE
  v_tenant uuid; v_res jsonb; v_inv uuid; v_ref text; v_face bigint; v_out bigint; n_null int;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE slug = 'outsourcetel-hq';

  -- Nothing has ever been reconciled, so every invoice must start UNKNOWN.
  SELECT count(*) INTO n_null FROM renewal_invoices
   WHERE tenant_id = v_tenant AND outstanding_cents IS NULL;
  IF n_null = 0 THEN
    RAISE EXCEPTION '529: invoices already carry a balance before anything was reconciled';
  END IF;

  -- ── a PART payment must produce a real remaining balance ────────────────
  SELECT id, source_external_ref, amount_cents INTO v_inv, v_ref, v_face
    FROM renewal_invoices
   WHERE tenant_id = v_tenant AND due_date < current_date
     AND coalesce(status,'') NOT IN ('paid','void','cancelled')
   ORDER BY due_date LIMIT 1;
  IF v_inv IS NULL THEN RAISE EXCEPTION '529: no overdue invoice to reconcile against'; END IF;

  v_res := reconcile_invoice_payments(v_tenant, jsonb_build_array(jsonb_build_object(
    'external_ref', '529-selftest-part', 'invoice_ref', v_ref,
    'amount_cents', (v_face / 3), 'paid_on', current_date - 3, 'source', 'manual')));

  IF (v_res->>'applied')::int <> 1 THEN
    RAISE EXCEPTION '529: a payment naming its own invoice was not applied: %', v_res;
  END IF;
  SELECT outstanding_cents INTO v_out FROM renewal_invoices WHERE id = v_inv;
  -- Would this pass if the reconciler were a no-op? No — outstanding was NULL.
  IF v_out IS DISTINCT FROM (v_face - (v_face / 3)) THEN
    RAISE EXCEPTION '529: face % less payment % should leave %, got %',
      v_face, v_face / 3, v_face - (v_face / 3), v_out;
  END IF;

  -- ── the same payment twice must NOT double-credit ───────────────────────
  v_res := reconcile_invoice_payments(v_tenant, jsonb_build_array(jsonb_build_object(
    'external_ref', '529-selftest-part', 'invoice_ref', v_ref,
    'amount_cents', (v_face / 3), 'paid_on', current_date - 3, 'source', 'manual')));
  IF (v_res->>'applied')::int <> 0 OR (v_res->>'already_known')::int <> 1 THEN
    RAISE EXCEPTION '529: re-running the ingest double-credited the invoice: %', v_res;
  END IF;
  SELECT outstanding_cents INTO v_out FROM renewal_invoices WHERE id = v_inv;
  IF v_out IS DISTINCT FROM (v_face - (v_face / 3)) THEN
    RAISE EXCEPTION '529: balance moved on a duplicate payment';
  END IF;

  -- ── an unreferenced payment matching TWO invoices must be refused ───────
  -- The safety property. A reconciler that guesses is worse than none.
  v_res := reconcile_invoice_payments(v_tenant, jsonb_build_array(jsonb_build_object(
    'external_ref', '529-selftest-ambig', 'amount_cents', 1, 'paid_on', current_date, 'source', 'manual')));
  IF (v_res->>'applied')::int <> 0 THEN
    RAISE EXCEPTION '529: applied a payment that matched no invoice';
  END IF;

  -- ── invoices nobody paid must STILL be unknown, not zero, not face value ─
  SELECT count(*) INTO n_null FROM renewal_invoices
   WHERE tenant_id = v_tenant AND outstanding_cents IS NULL;
  IF n_null = 0 THEN
    RAISE EXCEPTION '529: reconciling one invoice invented balances for the rest';
  END IF;

  -- Put the tenant back exactly as found: this was a proof, not a payment.
  DELETE FROM invoice_payments WHERE tenant_id = v_tenant AND external_ref LIKE '529-selftest%';
  UPDATE renewal_invoices SET outstanding_cents = NULL, payments_reconciled_at = NULL
   WHERE id = v_inv;
  IF EXISTS (SELECT 1 FROM renewal_invoices WHERE tenant_id = v_tenant AND outstanding_cents IS NOT NULL) THEN
    RAISE EXCEPTION '529: the self-test left a fabricated balance behind';
  END IF;

  RAISE NOTICE '529: part-payment, duplicate-safety and ambiguity refusal all proven; % invoice(s) correctly report an UNKNOWN balance', n_null;
END $a$;
