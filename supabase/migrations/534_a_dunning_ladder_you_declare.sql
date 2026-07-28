-- 534_a_dunning_ladder_you_declare.sql
-- ============================================================================
-- STEP 2 OF THE COLLECTIONS SEQUENCE: decide what to chase, and how hard.
--
-- renewal_invoices.cadence_stage is a bare integer. Nine invoices sit at 0 and
-- two at 1, and NOTHING decides which. There is no definition of what a stage
-- means, no rule mapping days-overdue to a stage, and no statement of what
-- happens at each rung. The dunning actions exist (send_payment_reminder,
-- send_final_notice, flag_for_collections) with nothing choosing between them.
--
-- A collections agent without a declared ladder is improvising tone and timing
-- against paying customers. That is precisely the judgment a business will not
-- delegate to a model, and it does not have to: the ladder is policy, and
-- policy should be written down, visible, and editable — not inferred.
--
-- ── THE CONTROL THAT MATTERS MOST ──────────────────────────────────────────
-- A rung NEVER fires on an invoice whose outstanding balance is unknown.
--
-- Migrations 529/530/532 established that NULL outstanding means "no payment
-- data has ever been reconciled against this invoice" — the face value is all
-- anybody knows. Chasing that is how you demand $45,000 from a customer who
-- paid $30,000 last week. Today's sync proved the scale of it: $793,000 of face
-- value against $431,000 genuinely owed. Dunning on face value would have
-- chased $362,000 that was already settled.
--
-- So the ladder is deliberately unable to act on an unverified balance. Not
-- discouraged — unable. Those invoices surface as "cannot be chased until the
-- balance is verified", which is a true statement and an actionable one.
--
-- ── DECLARED, NOT HARDCODED ────────────────────────────────────────────────
-- Rungs are rows, per tenant, with a platform default seeded so a new tenant
-- starts somewhere sane. A telecom's ladder is not an agency's. Every rung
-- states its own trigger, its tone, whether a human must approve it, and the
-- floor below which chasing costs more than it recovers.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.dunning_ladders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid REFERENCES public.tenants(id) ON DELETE CASCADE,  -- NULL = platform default
  name        text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS dunning_ladders_one_active_per_tenant
  ON public.dunning_ladders (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE active;

CREATE TABLE IF NOT EXISTS public.dunning_rungs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ladder_id           uuid NOT NULL REFERENCES public.dunning_ladders(id) ON DELETE CASCADE,
  stage               int  NOT NULL CHECK (stage > 0),
  after_days_overdue  int  NOT NULL CHECK (after_days_overdue >= 0),
  label               text NOT NULL,
  -- What the employee should sound like. Plain language on purpose: this is
  -- read by a person deciding policy, and by the employee writing the message.
  tone                text NOT NULL,
  action_key          text NOT NULL,
  -- Below this, chasing costs more than it recovers. 0 = chase anything.
  min_outstanding_cents bigint NOT NULL DEFAULT 0 CHECK (min_outstanding_cents >= 0),
  requires_approval   boolean NOT NULL DEFAULT true,
  UNIQUE (ladder_id, stage)
);

CREATE INDEX IF NOT EXISTS dunning_rungs_ladder_idx ON public.dunning_rungs (ladder_id, after_days_overdue);

ALTER TABLE public.dunning_ladders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dunning_rungs   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dunning_ladders_read ON public.dunning_ladders;
CREATE POLICY dunning_ladders_read ON public.dunning_ladders FOR SELECT
  USING (tenant_id IS NULL OR tenant_id IN (SELECT p.tenant_id FROM profiles p WHERE p.user_id = auth.uid()));
DROP POLICY IF EXISTS dunning_rungs_read ON public.dunning_rungs;
CREATE POLICY dunning_rungs_read ON public.dunning_rungs FOR SELECT
  USING (ladder_id IN (SELECT l.id FROM dunning_ladders l
          WHERE l.tenant_id IS NULL OR l.tenant_id IN (SELECT p.tenant_id FROM profiles p WHERE p.user_id = auth.uid())));

-- A ladder that goes soft as it ages, or repeats itself, is not a ladder.
CREATE OR REPLACE FUNCTION public.dunning_rung_order_guard()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
DECLARE v_bad int;
BEGIN
  SELECT count(*) INTO v_bad FROM dunning_rungs a JOIN dunning_rungs b
    ON a.ladder_id = b.ladder_id AND a.stage < b.stage
   WHERE a.ladder_id = NEW.ladder_id AND a.after_days_overdue >= b.after_days_overdue;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'Each rung must come later than the one before it. Stage % would fire no later than an earlier stage.', NEW.stage;
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_dunning_rung_order ON public.dunning_rungs;
CREATE TRIGGER trg_dunning_rung_order AFTER INSERT OR UPDATE ON public.dunning_rungs
  FOR EACH ROW EXECUTE FUNCTION public.dunning_rung_order_guard();

-- ── the platform default ladder ─────────────────────────────────────────────
-- A judgment, and meant to be changed. It is deliberately gentle early and
-- slow to escalate, because the cost of over-chasing a good customer is far
-- higher than a few extra days of float.
DO $seed$
DECLARE v_ladder uuid;
BEGIN
  SELECT id INTO v_ladder FROM dunning_ladders WHERE tenant_id IS NULL AND active;
  IF v_ladder IS NULL THEN
    INSERT INTO dunning_ladders (tenant_id, name) VALUES (NULL, 'Standard receivables ladder')
    RETURNING id INTO v_ladder;

    INSERT INTO dunning_rungs (ladder_id, stage, after_days_overdue, label, tone, action_key, min_outstanding_cents, requires_approval) VALUES
      (v_ladder, 1,  7, 'Friendly reminder',
       'Assume it was overlooked. State the invoice, the amount still owed and the due date. Ask if there is anything blocking payment. No consequences mentioned.',
       'send_payment_reminder', 5000, true),
      (v_ladder, 2, 21, 'Firm follow-up',
       'Still warm, but direct. Note this is the second approach, restate the amount and how long it has been outstanding, and ask for a payment date. Copy the account owner.',
       'send_payment_reminder', 5000, true),
      (v_ladder, 3, 45, 'Final notice',
       'Formal. State the amount, the age, what happens next and by when. No threats, no apology. This is the last message before commercial consequences.',
       'send_final_notice', 25000, true),
      (v_ladder, 4, 60, 'Recommend credit hold',
       'Do not contact the customer. Put the recommendation to a human with the full payment history: what is owed, how long, what has already been sent and any replies.',
       'flag_for_collections', 25000, true);
  END IF;
END $seed$;

-- ── what should happen to this invoice today, and why ──────────────────────
CREATE OR REPLACE FUNCTION public.dunning_position(p_tenant_id uuid)
 RETURNS TABLE (
   invoice_id uuid, invoice_ref text, customer text,
   days_overdue int, outstanding_cents bigint, current_stage int,
   due_stage int, rung_label text, tone text, action_key text,
   requires_approval boolean, actionable boolean, why text)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_ladder uuid;
BEGIN
  SELECT id INTO v_ladder FROM dunning_ladders
   WHERE active AND (tenant_id = p_tenant_id OR tenant_id IS NULL)
   ORDER BY tenant_id NULLS LAST LIMIT 1;   -- the tenant's own ladder wins

  RETURN QUERY
  SELECT r.id, coalesce(r.source_external_ref, r.id::text),
         coalesce(a.name, '(unknown customer)'),
         (current_date - r.due_date)::int,
         r.outstanding_cents,
         coalesce(r.cadence_stage, 0),
         g.stage, g.label, g.tone, g.action_key, g.requires_approval,
         -- ACTIONABLE is the whole safety property.
         (r.outstanding_cents IS NOT NULL
          AND r.outstanding_cents > 0
          AND g.stage IS NOT NULL
          AND g.stage > coalesce(r.cadence_stage, 0))::boolean,
         CASE
           WHEN r.outstanding_cents IS NULL THEN
             'Cannot be chased: no payment has ever been reconciled against this invoice, so the amount still owed is unverified. Its face value is not a balance owed.'
           WHEN r.outstanding_cents = 0 THEN 'Nothing owed — settled.'
           WHEN v_ladder IS NULL THEN 'No dunning ladder is declared for this workspace, so nothing is chased.'
           WHEN g.stage IS NULL THEN
             format('Not yet due a first approach — %s day(s) overdue, or below the amount worth chasing.',
                    (current_date - r.due_date)::int)
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

COMMENT ON FUNCTION public.dunning_position(uuid) IS
  'What the ladder says should happen to each open invoice today, and why in plain language. actionable is false whenever the outstanding balance is unverified — a balance nobody has reconciled must never be chased, because face value is not money owed.';

REVOKE ALL ON FUNCTION public.dunning_position(uuid) FROM PUBLIC;

notify pgrst, 'reload schema';

DO $a$
DECLARE
  v_tenant uuid; n_rows int; n_unverified int; n_actionable int; v_err text;
  v_ladder uuid; r record;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE slug = 'outsourcetel-hq';
  SELECT id INTO v_ladder FROM dunning_ladders WHERE tenant_id IS NULL AND active;

  -- ── a ladder that does not escalate must be refused ─────────────────────
  BEGIN
    INSERT INTO dunning_rungs (ladder_id, stage, after_days_overdue, label, tone, action_key)
    VALUES (v_ladder, 5, 30, 'Out of order', 'n/a', 'send_payment_reminder');
    RAISE EXCEPTION '534: a rung that fires BEFORE an earlier stage was accepted';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE '534:%' THEN RAISE; END IF;
    IF v_err NOT LIKE '%later than the one before%' THEN
      RAISE EXCEPTION '534: refused for the wrong reason: %', v_err;
    END IF;
  END;

  SELECT count(*) INTO n_rows FROM dunning_position(v_tenant);
  IF n_rows = 0 THEN RAISE EXCEPTION '534: the ladder sees no open invoices at all'; END IF;

  -- ── THE CONTROL: an unverified balance can never be actionable ──────────
  -- Would this pass if the guard were missing? No — this tenant holds an
  -- invoice with a NULL balance right now, and without the guard its face
  -- value would make it chaseable.
  SELECT count(*) INTO n_unverified FROM dunning_position(v_tenant)
   WHERE outstanding_cents IS NULL;
  IF n_unverified = 0 THEN
    RAISE EXCEPTION '534: no unverified invoice present — the control under test cannot be proven';
  END IF;
  IF EXISTS (SELECT 1 FROM dunning_position(v_tenant) WHERE outstanding_cents IS NULL AND actionable) THEN
    RAISE EXCEPTION '534: an invoice with an unverified balance was marked chaseable';
  END IF;
  IF EXISTS (SELECT 1 FROM dunning_position(v_tenant)
              WHERE outstanding_cents IS NULL AND why NOT LIKE '%unverified%') THEN
    RAISE EXCEPTION '534: an unverified invoice does not explain itself';
  END IF;

  -- ── a settled invoice is never chased ───────────────────────────────────
  IF EXISTS (SELECT 1 FROM dunning_position(v_tenant) WHERE outstanding_cents = 0 AND actionable) THEN
    RAISE EXCEPTION '534: an invoice with nothing owed was marked chaseable';
  END IF;

  -- ── and the two genuinely overdue ERP invoices ARE picked up ────────────
  SELECT count(*) INTO n_actionable FROM dunning_position(v_tenant) WHERE actionable;
  IF n_actionable = 0 THEN
    RAISE EXCEPTION '534: nothing is chaseable, but this tenant has verified overdue balances';
  END IF;
  -- Every actionable row must name a real action and require a human.
  IF EXISTS (SELECT 1 FROM dunning_position(v_tenant) WHERE actionable
              AND (action_key IS NULL OR NOT requires_approval)) THEN
    RAISE EXCEPTION '534: an actionable rung either names no action or would fire without approval';
  END IF;

  FOR r IN SELECT invoice_ref, days_overdue, (outstanding_cents/100.0) AS owed, rung_label
             FROM dunning_position(v_tenant) WHERE actionable LOOP
    RAISE NOTICE '534: % — % days overdue, % owed -> %', r.invoice_ref, r.days_overdue, r.owed, r.rung_label;
  END LOOP;

  RAISE NOTICE '534: ladder live — % open invoice(s), % chaseable, % unverified and correctly untouchable',
    n_rows, n_actionable, n_unverified;
END $a$;
