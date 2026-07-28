-- 535_not_yet_due_is_not_minus_days_overdue.sql
-- ============================================================================
-- dunning_position explains itself in plain language, and for an invoice that
-- is not yet due it said:
--
--     "Not yet due a first approach — -23 day(s) overdue, or below the amount
--      worth chasing."
--
-- "-23 days overdue" is not a thing. Worse, the sentence gives two possible
-- reasons and leaves the reader to work out which applies. This is the text a
-- person reads while deciding whether to chase a paying customer, so it should
-- say one true thing clearly.
--
-- Now: an invoice not yet due says when it falls due. An invoice that is
-- overdue but too small to chase says that, and names the floor. They are
-- different situations and no longer share a sentence.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.dunning_position(p_tenant_id uuid)
 RETURNS TABLE (
   invoice_id uuid, invoice_ref text, customer text,
   days_overdue int, outstanding_cents bigint, current_stage int,
   due_stage int, rung_label text, tone text, action_key text,
   requires_approval boolean, actionable boolean, why text)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
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
         (r.outstanding_cents IS NOT NULL
          AND r.outstanding_cents > 0
          AND g.stage IS NOT NULL
          AND g.stage > coalesce(r.cadence_stage, 0))::boolean,
         CASE
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
                    (current_date - r.due_date)::int, (r.outstanding_cents/100.0)::text,
                    (coalesce(v_floor,0)/100.0)::text)
           WHEN g.stage <= coalesce(r.cadence_stage, 0) THEN
             format('Already at stage %s; the next rung is not due yet.', coalesce(r.cadence_stage, 0))
           ELSE format('%s day(s) overdue and %s still owed — %s is due.',
                    (current_date - r.due_date)::int, (r.outstanding_cents/100.0)::text, g.label)
         END
    FROM renewal_invoices r
    LEFT JOIN customer_accounts a ON a.id = r.account_id
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
END $fn$;

notify pgrst, 'reload schema';

DO $a$
DECLARE v_tenant uuid; n_bad int; n_future int;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE slug = 'outsourcetel-hq';

  SELECT count(*) INTO n_future FROM dunning_position(v_tenant) WHERE days_overdue < 0;
  IF n_future = 0 THEN
    RAISE EXCEPTION '535: no not-yet-due invoice present — the wording under test cannot be proven';
  END IF;

  -- Would this pass if the change were a no-op? No: every one of these rows
  -- said "-N day(s) overdue" a moment ago.
  SELECT count(*) INTO n_bad FROM dunning_position(v_tenant)
   WHERE why LIKE '%-%day(s) overdue%';
  IF n_bad > 0 THEN
    RAISE EXCEPTION '535: % row(s) still report a negative overdue count', n_bad;
  END IF;

  -- ...and they now say something USEFUL, not merely something non-negative.
  -- Only rows with a KNOWN balance: an unverified invoice reports that instead,
  -- and rightly so — it cannot be chased whatever its date. A first version of
  -- this assert demanded the due-date wording from every not-yet-due row and
  -- failed on exactly that case.
  IF EXISTS (SELECT 1 FROM dunning_position(v_tenant)
              WHERE days_overdue < 0 AND outstanding_cents IS NOT NULL AND outstanding_cents > 0
                AND why NOT LIKE 'Not due yet — payable%') THEN
    RAISE EXCEPTION '535: a not-yet-due invoice with a known balance does not say when it falls due';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM dunning_position(v_tenant) WHERE why LIKE 'Not due yet — payable%') THEN
    RAISE EXCEPTION '535: no invoice uses the new wording at all — the branch is unreachable';
  END IF;

  RAISE NOTICE '535: % not-yet-due invoice(s) now state their due date instead of a negative overdue count', n_future;
END $a$;
