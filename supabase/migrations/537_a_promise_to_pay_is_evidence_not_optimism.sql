-- 537_a_promise_to_pay_is_evidence_not_optimism.sql
-- ============================================================================
-- STEP 4: the thing that separates a collections agent from a dunning robot.
--
-- A robot sends rung 2 on day 21 regardless. A collector remembers that on day
-- 18 the customer said "paying on the 30th", stops chasing until the 30th, and
-- comes back harder on the 31st if nothing arrived. Every practitioner account
-- of collections describes this as the actual job; no product researched today
-- does it well, because it needs memory plus judgment rather than a schedule.
--
-- ── A PROMISE IS EVIDENCE, WITH ALL THE OBLIGATIONS THAT IMPLIES ───────────
-- Recording that a customer promised to pay is an assertion about something
-- they said. Get it wrong and you either stop chasing money nobody promised, or
-- accuse someone of breaking a promise they never made. So a promise carries
-- WHERE IT CAME FROM and cannot exist without it — the same discipline the
-- posting lines got in 531.
--
-- ── KEPT IS DERIVED, NEVER ASSERTED ────────────────────────────────────────
-- The hard part. When the promised date arrives you must say whether it was
-- honoured, and the ONLY honest source is the balance. So:
--   the balance fell by at least the promised amount  -> kept
--   the balance did not move, and we can see it       -> broken
--   we cannot see the balance                         -> UNVERIFIABLE
-- The third is not a failure state, it is the truth. Marking a promise "broken"
-- because payments were not ingested would escalate a good customer on the
-- strength of our own missing data. Same rule as 529/530/534, one layer up.
--
-- ── SUPPRESSION IS THE POINT ───────────────────────────────────────────────
-- An open promise stops the ladder for that invoice until the promised date
-- plus a grace period. A BROKEN promise does the opposite — it is a stronger
-- signal than age alone, so the ladder no longer waits for the next rung's day
-- count. That is what a collector does, and it is why this belongs in the
-- policy layer rather than in a prompt.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.payment_promises (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  invoice_id        uuid NOT NULL REFERENCES public.renewal_invoices(id) ON DELETE CASCADE,
  promised_cents    bigint NOT NULL CHECK (promised_cents > 0),
  promised_on       date NOT NULL,
  -- Grace before a promise counts as broken. Declared, because "the cheque is
  -- in the post" is worth three days and a wire is worth one.
  grace_days        int NOT NULL DEFAULT 2 CHECK (grace_days >= 0),
  -- WHERE THIS CAME FROM. A promise nobody can trace is hearsay.
  source            text NOT NULL CHECK (source IN ('email','call','portal','human','other')),
  evidence_ref      text,
  evidence_note     text NOT NULL,
  -- The balance when the promise was made, so "did it move" is answerable
  -- later without re-deriving history.
  balance_at_promise_cents bigint,
  status            text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','kept','broken','unverifiable','superseded')),
  settled_at        timestamptz,
  settled_note      text,
  recorded_by_de    uuid REFERENCES public.digital_employees(id) ON DELETE SET NULL,
  recorded_by_user  uuid,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payment_promises_open_idx
  ON public.payment_promises (tenant_id, invoice_id) WHERE status = 'open';

ALTER TABLE public.payment_promises ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payment_promises_read ON public.payment_promises;
CREATE POLICY payment_promises_read ON public.payment_promises FOR SELECT
  USING (tenant_id IN (SELECT p.tenant_id FROM profiles p WHERE p.user_id = auth.uid()));

COMMENT ON TABLE public.payment_promises IS
  'A customer said they would pay, by when, and how we know. An open promise suppresses the dunning ladder; a broken one accelerates it. Whether it was kept is DERIVED from the balance moving — never asserted — and is "unverifiable" when payments have not been reconciled, because escalating on our own missing data is not collections.';

-- ── record one, with the guards that make it trustworthy ───────────────────
CREATE OR REPLACE FUNCTION public.record_payment_promise(
  p_invoice_id uuid, p_promised_cents bigint, p_promised_on date,
  p_source text, p_evidence_note text, p_evidence_ref text DEFAULT NULL,
  p_grace_days int DEFAULT 2, p_de_id uuid DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_inv renewal_invoices; v_id uuid;
BEGIN
  SELECT * INTO v_inv FROM renewal_invoices WHERE id = p_invoice_id;
  IF v_inv.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'invoice_not_found'); END IF;

  IF coalesce(trim(p_evidence_note), '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'error',
      'A promise needs to say where it came from. Record what the customer actually said and where.');
  END IF;

  -- You cannot take a promise against a balance you have never verified: the
  -- amount promised would be measured against a face value nobody checked.
  IF v_inv.outstanding_cents IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error',
      'This invoice has no verified balance yet, so a promise against it cannot be checked later. Reconcile payments first.');
  END IF;

  IF p_promised_on < current_date THEN
    RETURN jsonb_build_object('ok', false, 'error', 'A promise to pay in the past is not a promise.');
  END IF;
  IF p_promised_cents > v_inv.outstanding_cents THEN
    RETURN jsonb_build_object('ok', false, 'error',
      format('Promised %s but only %s is owed.',
             money_text(p_promised_cents, v_inv.source_currency),
             money_text(v_inv.outstanding_cents, v_inv.source_currency)));
  END IF;

  -- A new promise on the same invoice replaces the old one; a customer who
  -- re-promises has not made two commitments.
  UPDATE payment_promises SET status = 'superseded', settled_at = now(),
         settled_note = 'Replaced by a later promise on the same invoice.'
   WHERE invoice_id = p_invoice_id AND status = 'open';

  INSERT INTO payment_promises (tenant_id, invoice_id, promised_cents, promised_on, grace_days,
                                source, evidence_ref, evidence_note,
                                balance_at_promise_cents, recorded_by_de)
  VALUES (v_inv.tenant_id, p_invoice_id, p_promised_cents, p_promised_on, greatest(0, coalesce(p_grace_days,2)),
          p_source, p_evidence_ref, p_evidence_note, v_inv.outstanding_cents, p_de_id)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'promise_id', v_id,
    'suppresses_chasing_until', p_promised_on + greatest(0, coalesce(p_grace_days,2)));
END $fn$;

-- ── settle the ones whose day has come, from the balance alone ─────────────
CREATE OR REPLACE FUNCTION public.settle_due_payment_promises()
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE n_kept int; n_broken int; n_unver int;
BEGIN
  WITH due AS (
    SELECT p.id, p.promised_cents, p.balance_at_promise_cents, r.outstanding_cents
      FROM payment_promises p JOIN renewal_invoices r ON r.id = p.invoice_id
     WHERE p.status = 'open'
       AND current_date > p.promised_on + p.grace_days
       AND tenant_is_operational(p.tenant_id)
  ), judged AS (
    SELECT id,
      CASE
        -- No verified balance today: we cannot say. Saying "broken" here would
        -- escalate a customer over OUR missing data.
        WHEN outstanding_cents IS NULL OR balance_at_promise_cents IS NULL THEN 'unverifiable'
        WHEN (balance_at_promise_cents - outstanding_cents) >= promised_cents THEN 'kept'
        ELSE 'broken'
      END AS verdict,
      coalesce(balance_at_promise_cents - outstanding_cents, 0) AS moved
      FROM due
  )
  UPDATE payment_promises p SET status = j.verdict, settled_at = now(),
         settled_note = CASE j.verdict
           WHEN 'kept'   THEN format('Balance fell by %s, covering the %s promised.',
                                     money_text(j.moved), money_text(p.promised_cents))
           WHEN 'broken' THEN format('Promised %s by %s; the balance moved %s.',
                                     money_text(p.promised_cents), to_char(p.promised_on,'FMDD Mon'), money_text(j.moved))
           ELSE 'The balance on this invoice is not verified, so whether the promise was kept cannot be established.'
         END
    FROM judged j WHERE p.id = j.id;

  SELECT count(*) FILTER (WHERE status='kept'   AND settled_at > now() - interval '1 minute'),
         count(*) FILTER (WHERE status='broken' AND settled_at > now() - interval '1 minute'),
         count(*) FILTER (WHERE status='unverifiable' AND settled_at > now() - interval '1 minute')
    INTO n_kept, n_broken, n_unver FROM payment_promises;

  RETURN jsonb_build_object('ok', true, 'kept', n_kept, 'broken', n_broken, 'unverifiable', n_unver);
END $fn$;

REVOKE ALL ON FUNCTION public.record_payment_promise(uuid,bigint,date,text,text,text,int,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.settle_due_payment_promises() FROM PUBLIC;

SELECT cron.schedule('settle-payment-promises-daily', '20 6 * * *',
                     $c$select settle_due_payment_promises()$c$);

notify pgrst, 'reload schema';

-- ── the ladder learns to wait, and to remember a broken promise ────────────
CREATE OR REPLACE FUNCTION public.dunning_position(p_tenant_id uuid)
 RETURNS TABLE(invoice_id uuid, invoice_ref text, customer text, days_overdue integer, outstanding_cents bigint, current_stage integer, due_stage integer, rung_label text, tone text, action_key text, requires_approval boolean, actionable boolean, why text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_ladder uuid; v_first_rung int; v_floor bigint;
BEGIN
  SELECT id INTO v_ladder FROM dunning_ladders
   WHERE active AND (tenant_id = p_tenant_id OR tenant_id IS NULL)
   ORDER BY tenant_id NULLS LAST LIMIT 1;

  -- The first rung's terms, so an invoice that has not reached it can say
  -- exactly what it is waiting for rather than listing possibilities.
  SELECT d.after_days_overdue, d.min_outstanding_cents INTO v_first_rung, v_floor
    FROM dunning_rungs d WHERE d.ladder_id = v_ladder ORDER BY d.stage LIMIT 1;

  RETURN QUERY
  SELECT r.id, coalesce(r.source_external_ref, r.id::text),
         coalesce(a.name, '(unknown customer)'),
         (current_date - r.due_date)::int,
         r.outstanding_cents,
         coalesce(r.cadence_stage, 0),
         g.stage, g.label, g.tone, g.action_key, g.requires_approval,
         (pr.id IS NULL                       -- an open promise stops the ladder
          AND r.outstanding_cents IS NOT NULL
          AND r.outstanding_cents > 0
          AND g.stage IS NOT NULL
          AND g.stage > coalesce(r.cadence_stage, 0))::boolean,
         CASE
           WHEN pr.id IS NOT NULL THEN
             format('Not chasing: %s promised %s by %s. Holding until %s.',
                    coalesce(a.name,'the customer'), money_text(pr.promised_cents, r.source_currency),
                    to_char(pr.promised_on,'FMDD Mon'), to_char(pr.promised_on + pr.grace_days,'FMDD Mon'))
           WHEN br.id IS NOT NULL AND r.outstanding_cents IS NOT NULL AND r.outstanding_cents > 0 THEN
             format('%s day(s) overdue and %s still owed. A promise to pay by %s was not kept — escalate rather than wait for the next rung.',
                    (current_date - r.due_date)::int, money_text(r.outstanding_cents, r.source_currency),
                    to_char(br.promised_on,'FMDD Mon'))
           WHEN r.outstanding_cents IS NULL THEN
             'Cannot be chased: no payment has ever been reconciled against this invoice, so the amount still owed is unverified. Its face value is not a balance owed.'
           WHEN r.outstanding_cents = 0 THEN 'Nothing owed — settled.'
           WHEN v_ladder IS NULL THEN 'No dunning ladder is declared for this workspace, so nothing is chased.'
           -- Not yet due. Say when it IS due, not a negative overdue count.
           WHEN r.due_date > current_date THEN
             format('Not due yet — payable %s, in %s day(s).',
                    to_char(r.due_date, 'FMDD Mon YYYY'), (r.due_date - current_date)::int)
           -- Overdue, but the ladder has not reached it.
           WHEN g.stage IS NULL AND (current_date - r.due_date) < coalesce(v_first_rung, 0) THEN
             format('%s day(s) overdue. The first approach is due at %s day(s).',
                    (current_date - r.due_date)::int, coalesce(v_first_rung, 0))
           WHEN g.stage IS NULL THEN
             format('%s day(s) overdue, but %s owed is below the %s this workspace bothers to chase.',
                    (current_date - r.due_date)::int, money_text(r.outstanding_cents, r.source_currency),
                    money_text(coalesce(v_floor,0), r.source_currency))
           WHEN g.stage <= coalesce(r.cadence_stage, 0) THEN
             format('Already at stage %s; the next rung is not due yet.', coalesce(r.cadence_stage, 0))
           ELSE format('%s day(s) overdue and %s still owed — %s is due.',
                    (current_date - r.due_date)::int, money_text(r.outstanding_cents, r.source_currency), g.label)
         END
    FROM renewal_invoices r
    LEFT JOIN customer_accounts a ON a.id = r.account_id
    -- An OPEN promise whose day has not passed suppresses chasing entirely.
    LEFT JOIN LATERAL (
      SELECT p.* FROM payment_promises p
       WHERE p.invoice_id = r.id AND p.status = 'open'
         AND current_date <= p.promised_on + p.grace_days
       ORDER BY p.created_at DESC LIMIT 1) pr ON true
    -- The most recent BROKEN promise, which makes the case stronger, not weaker.
    LEFT JOIN LATERAL (
      SELECT p.* FROM payment_promises p
       WHERE p.invoice_id = r.id AND p.status = 'broken'
       ORDER BY p.promised_on DESC LIMIT 1) br ON true
    LEFT JOIN LATERAL (
      SELECT d.* FROM dunning_rungs d
       WHERE d.ladder_id = v_ladder
         AND (current_date - r.due_date) >= d.after_days_overdue
         AND coalesce(r.outstanding_cents, 0) >= d.min_outstanding_cents
       ORDER BY d.stage DESC LIMIT 1
    ) g ON true
   WHERE r.tenant_id = p_tenant_id
     AND coalesce(r.status, '') NOT IN ('paid', 'void', 'cancelled')
     AND r.due_date IS NOT NULL
   ORDER BY (current_date - r.due_date) DESC;
END $function$
;

DO $a$
DECLARE
  v_tenant uuid; v_inv uuid; v_unver uuid; v_res jsonb; v_pid uuid;
  v_owed bigint; n_before int; n_after int; v_why text; v_act boolean;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE slug = 'outsourcetel-hq';
  SELECT invoice_id, outstanding_cents INTO v_inv, v_owed
    FROM dunning_position(v_tenant) WHERE actionable ORDER BY days_overdue DESC LIMIT 1;
  IF v_inv IS NULL THEN RAISE EXCEPTION '537: no chaseable invoice to test against'; END IF;
  SELECT id INTO v_unver FROM renewal_invoices
   WHERE tenant_id = v_tenant AND outstanding_cents IS NULL LIMIT 1;

  SELECT count(*) INTO n_before FROM dunning_position(v_tenant) WHERE actionable;

  -- ── a promise needs evidence ────────────────────────────────────────────
  v_res := record_payment_promise(v_inv, 1000, current_date + 5, 'call', '   ');
  IF (v_res->>'ok')::boolean THEN RAISE EXCEPTION '537: a promise with no evidence was recorded'; END IF;

  -- ── you cannot promise against an unverified balance ────────────────────
  IF v_unver IS NOT NULL THEN
    v_res := record_payment_promise(v_unver, 1000, current_date + 5, 'call', 'Said they would pay');
    IF (v_res->>'ok')::boolean THEN
      RAISE EXCEPTION '537: a promise was accepted against an invoice with no verified balance';
    END IF;
  END IF;

  -- ── you cannot promise more than is owed, or promise in the past ────────
  v_res := record_payment_promise(v_inv, v_owed + 100000, current_date + 5, 'call', 'Overpromise');
  IF (v_res->>'ok')::boolean THEN RAISE EXCEPTION '537: promised more than was owed'; END IF;
  v_res := record_payment_promise(v_inv, 1000, current_date - 1, 'call', 'Backdated');
  IF (v_res->>'ok')::boolean THEN RAISE EXCEPTION '537: accepted a promise to pay in the past'; END IF;

  -- ── a good promise records, and STOPS the chasing ───────────────────────
  v_res := record_payment_promise(v_inv, v_owed, current_date + 5, 'email',
             'Customer replied on the invoice thread: "we will settle this on the 2nd".', 'msg-537-probe');
  IF NOT (v_res->>'ok')::boolean THEN RAISE EXCEPTION '537: a well-evidenced promise was refused: %', v_res; END IF;
  v_pid := (v_res->>'promise_id')::uuid;

  SELECT actionable, why INTO v_act, v_why FROM dunning_position(v_tenant) WHERE invoice_id = v_inv;
  -- Would this pass if suppression were missing? No — this invoice was
  -- actionable a moment ago and is the oldest overdue in the book.
  IF v_act THEN RAISE EXCEPTION '537: still chasing an invoice the customer has promised to pay'; END IF;
  IF v_why NOT LIKE 'Not chasing:%promised%' THEN
    RAISE EXCEPTION '537: the hold is not explained to the reader: %', v_why;
  END IF;
  SELECT count(*) INTO n_after FROM dunning_position(v_tenant) WHERE actionable;
  IF n_after >= n_before THEN RAISE EXCEPTION '537: the chase list did not shrink'; END IF;

  -- ── a BROKEN promise accelerates rather than protects ───────────────────
  UPDATE payment_promises SET status = 'broken', promised_on = current_date - 3, settled_at = now()
   WHERE id = v_pid;
  SELECT actionable, why INTO v_act, v_why FROM dunning_position(v_tenant) WHERE invoice_id = v_inv;
  IF NOT v_act THEN RAISE EXCEPTION '537: a broken promise left the invoice unchaseable'; END IF;
  IF v_why NOT LIKE '%was not kept%' THEN
    RAISE EXCEPTION '537: a broken promise is not surfaced to the reader: %', v_why;
  END IF;

  -- ── settlement is DERIVED: no balance movement, and it is not "kept" ────
  UPDATE payment_promises SET status = 'open', settled_at = NULL,
         promised_on = current_date - 5, grace_days = 1 WHERE id = v_pid;
  PERFORM settle_due_payment_promises();
  IF (SELECT status FROM payment_promises WHERE id = v_pid) <> 'broken' THEN
    RAISE EXCEPTION '537: nothing was paid and the promise was not judged broken';
  END IF;

  -- ...and with no verified balance it must be UNVERIFIABLE, never broken.
  UPDATE payment_promises SET status='open', settled_at=NULL, balance_at_promise_cents=NULL WHERE id = v_pid;
  PERFORM settle_due_payment_promises();
  IF (SELECT status FROM payment_promises WHERE id = v_pid) <> 'unverifiable' THEN
    RAISE EXCEPTION '537: a promise was judged on a balance we cannot see';
  END IF;

  DELETE FROM payment_promises WHERE tenant_id = v_tenant AND evidence_ref = 'msg-537-probe';
  IF EXISTS (SELECT 1 FROM payment_promises WHERE tenant_id = v_tenant) THEN
    RAISE EXCEPTION '537: the self-test left a promise behind';
  END IF;

  RAISE NOTICE '537: promises hold the ladder, broken ones accelerate it, and "kept" is derived from the balance or not claimed at all';
END $a$;
