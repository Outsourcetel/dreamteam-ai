-- 536_money_should_read_like_money.sql
-- ============================================================================
-- dunning_position told a human "45000.000000000000 still owed". That is a
-- numeric cast leaking into a sentence somebody reads while deciding whether to
-- chase a paying customer. Twelve decimal places on a round figure also makes
-- the number harder to check at a glance, which is the opposite of the point.
--
-- Money now reads as money: thousands separated, two decimals, currency taken
-- from the invoice rather than assumed. FM strips the padding to_char adds.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.money_text(p_cents bigint, p_currency text DEFAULT NULL)
 RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $fn$
  SELECT CASE WHEN p_cents IS NULL THEN 'unknown'
              ELSE coalesce(nullif(p_currency,'') || ' ', '')
                   || to_char(p_cents / 100.0, 'FM999,999,999,990.00') END;
$fn$;

COMMENT ON FUNCTION public.money_text(bigint, text) IS
  'Formats cents for a sentence a person reads. NULL is the word "unknown", never 0.00 — an unverified balance must not look like a settled one.';

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
                    (current_date - r.due_date)::int, money_text(r.outstanding_cents, r.source_currency),
                    money_text(coalesce(v_floor,0), r.source_currency))
           WHEN g.stage <= coalesce(r.cadence_stage, 0) THEN
             format('Already at stage %s; the next rung is not due yet.', coalesce(r.cadence_stage, 0))
           ELSE format('%s day(s) overdue and %s still owed — %s is due.',
                    (current_date - r.due_date)::int, money_text(r.outstanding_cents, r.source_currency), g.label)
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
DECLARE v_tenant uuid; n_raw int; n_ok int;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE slug = 'outsourcetel-hq';
  -- Would this pass if the change were a no-op? No: every actionable row said
  -- "45000.000000000000" a moment ago.
  SELECT count(*) INTO n_raw FROM dunning_position(v_tenant) WHERE why ~ '\.[0-9]{4,}';
  IF n_raw > 0 THEN RAISE EXCEPTION '536: % row(s) still print a raw numeric', n_raw; END IF;

  SELECT count(*) INTO n_ok FROM dunning_position(v_tenant) WHERE why ~ '[0-9],[0-9]{3}\.[0-9]{2} still owed';
  IF n_ok = 0 THEN RAISE EXCEPTION '536: no row shows a properly formatted amount'; END IF;

  -- NULL must stay a word, never a number that could pass for a real balance.
  IF money_text(NULL) <> 'unknown' THEN RAISE EXCEPTION '536: an unknown balance formats as a number'; END IF;
  RAISE NOTICE '536: % row(s) now read money as money', n_ok;
END $a$;
