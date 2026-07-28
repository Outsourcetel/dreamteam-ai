-- 531_a_posting_a_human_can_trust_in_thirty_seconds.sql
-- ============================================================================
-- The founder's model, and he is right: the employee DRAFTS the bookkeeping,
-- submits it for approval, and only then does it post. Not autonomy — a
-- complete loop with a gate in the middle. Market research the same day found
-- every credible vendor has converged on exactly that shape; almost none of
-- them say so, and several market the opposite of what their own documentation
-- describes.
--
-- Two of the three legs already exist here. The gate is real
-- (claim_gated_action_execution / decide_action_execution / record_action_
-- execution / record_action_rollback). What does NOT exist, in this codebase or
-- in the parallel ERP workstream, is the thing in the middle:
--
--   A PROPOSED POSTING THAT IS SAFE TO PUT IN FRONT OF A PERSON.
--
-- Today an employee's finance output is a markdown document. A human cannot
-- approve a markdown document into a ledger — they would have to re-derive
-- every figure, which is the work they were trying to avoid. Approval is only
-- cheap if the arithmetic is already guaranteed and every number says where it
-- came from.
--
-- ── THE CONTROL, AND WHY IT IS AT THIS LAYER ───────────────────────────────
-- A human reviewing a journal entry should be deciding ONE thing: "is this the
-- right treatment?" They should never be checking whether debits equal credits,
-- and they should never have to go and find out where a number came from.
--
-- So a draft CANNOT leave 'draft' unless, enforced in the database:
--   · it balances to the cent, and
--   · every single line names the evidence it came from.
-- An unbalanced or unevidenced posting cannot physically reach a reviewer. That
-- is a control an auditor can be shown, not a prompt instruction the model may
-- ignore on a bad day.
--
-- ── DELIBERATELY PROVIDER-AGNOSTIC ─────────────────────────────────────────
-- This produces a PAYLOAD and a decision record. It does not call ERPNext.
-- The erpnext executor (execution_key 'erpnext_invoice_comment' and siblings)
-- lives in another workstream's worktree and is NOT on main — the action
-- definitions are registered in this shared database while the deployed
-- connector-hub has no executor for them, so every erpnext execution ever
-- created sits human_gated with no receipt. Building a second executor is how
-- this tenant got two unconnected invoice tables. Whoever owns the connector
-- posts the payload; this owns whether the payload deserves to be posted.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.posting_drafts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  de_id          uuid REFERENCES public.digital_employees(id) ON DELETE SET NULL,
  kind           text NOT NULL CHECK (kind IN ('journal_entry','sales_invoice','payment_entry')),
  title          text NOT NULL,
  -- Why this posting exists at all, in the employee's own words. The reviewer
  -- reads this first and everything else only if it does not obviously follow.
  rationale      text NOT NULL,
  posting_date   date NOT NULL,
  currency       text NOT NULL DEFAULT 'USD',
  -- The exact fields the target system needs, assembled by whoever proposes.
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  status         text NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','submitted','approved','posted','rejected','failed','reversed')),
  -- Binding to the existing gate. Nothing new invented for approval.
  human_task_id  uuid REFERENCES public.human_tasks(id) ON DELETE SET NULL,
  execution_id   uuid REFERENCES public.action_executions(id) ON DELETE SET NULL,
  posted_ref     text,                    -- the document's id in the target system
  posted_at      timestamptz,
  reversal_of    uuid REFERENCES public.posting_drafts(id) ON DELETE SET NULL,
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.posting_draft_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id       uuid NOT NULL REFERENCES public.posting_drafts(id) ON DELETE CASCADE,
  line_no        int  NOT NULL,
  account        text NOT NULL,
  description    text,
  debit_cents    bigint NOT NULL DEFAULT 0 CHECK (debit_cents  >= 0),
  credit_cents   bigint NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  -- WHERE THIS NUMBER CAME FROM. Not optional, and not free text at the table
  -- level: a row must name the table and row it was derived from, so a reviewer
  -- (or an auditor, later) can go and look.
  evidence_table text NOT NULL,
  evidence_id    text NOT NULL,
  evidence_note  text,
  -- A line is a debit or a credit, never both and never neither. Catching this
  -- here rather than in the payload means a malformed line cannot be built.
  CONSTRAINT posting_line_one_side CHECK (
    (debit_cents > 0 AND credit_cents = 0) OR (credit_cents > 0 AND debit_cents = 0)),
  UNIQUE (draft_id, line_no)
);

CREATE INDEX IF NOT EXISTS posting_drafts_tenant_status_idx ON public.posting_drafts (tenant_id, status);
CREATE INDEX IF NOT EXISTS posting_draft_lines_draft_idx    ON public.posting_draft_lines (draft_id);

ALTER TABLE public.posting_drafts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.posting_draft_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS posting_drafts_tenant_read ON public.posting_drafts;
CREATE POLICY posting_drafts_tenant_read ON public.posting_drafts
  FOR SELECT USING (tenant_id IN (SELECT p.tenant_id FROM profiles p WHERE p.user_id = auth.uid()));
DROP POLICY IF EXISTS posting_draft_lines_tenant_read ON public.posting_draft_lines;
CREATE POLICY posting_draft_lines_tenant_read ON public.posting_draft_lines
  FOR SELECT USING (draft_id IN (
    SELECT d.id FROM posting_drafts d
     WHERE d.tenant_id IN (SELECT p.tenant_id FROM profiles p WHERE p.user_id = auth.uid())));

-- ── the control: an unbalanced or unevidenced posting cannot reach a human ──
CREATE OR REPLACE FUNCTION public.posting_draft_gate()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $fn$
DECLARE v_dr bigint; v_cr bigint; v_lines int; v_bad int;
BEGIN
  -- Only guard the transition OUT of draft. Editing a draft is free.
  IF NEW.status = 'draft' OR NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF NEW.status IN ('rejected', 'failed') THEN
    RETURN NEW;  -- refusing or failing a posting needs no arithmetic
  END IF;

  SELECT count(*), coalesce(sum(debit_cents),0), coalesce(sum(credit_cents),0)
    INTO v_lines, v_dr, v_cr
    FROM posting_draft_lines WHERE draft_id = NEW.id;

  IF v_lines = 0 THEN
    RAISE EXCEPTION 'This posting has no lines. Nothing can be submitted for approval until it does.';
  END IF;

  -- A payment entry settles an existing document and is single-sided by nature;
  -- a journal entry and an invoice must balance.
  IF NEW.kind IN ('journal_entry', 'sales_invoice') AND v_dr <> v_cr THEN
    RAISE EXCEPTION 'This posting does not balance: debits %, credits %, difference %. A reviewer must never be asked to check the arithmetic.',
      (v_dr/100.0), (v_cr/100.0), ((v_dr - v_cr)/100.0);
  END IF;

  SELECT count(*) INTO v_bad FROM posting_draft_lines
   WHERE draft_id = NEW.id
     AND (coalesce(trim(evidence_table),'') = '' OR coalesce(trim(evidence_id),'') = '');
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% line(s) do not say where the figure came from. Every line must name its source before a human is asked to approve it.', v_bad;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_posting_draft_gate ON public.posting_drafts;
CREATE TRIGGER trg_posting_draft_gate
  BEFORE UPDATE ON public.posting_drafts
  FOR EACH ROW EXECUTE FUNCTION public.posting_draft_gate();

COMMENT ON TABLE public.posting_drafts IS
  'A proposed accounting posting: drafted by an employee, reviewed by a human, then posted by whichever connector owns the target system. A draft cannot leave draft status unless it balances to the cent and every line names its evidence — enforced by trigger, so it is a control an auditor can be shown rather than a prompt the model may ignore.';
COMMENT ON COLUMN public.posting_draft_lines.evidence_table IS
  'The table this figure was derived from (e.g. renewal_invoices, invoice_payments). With evidence_id it must be enough for a reviewer to go and look. Not optional.';

-- ── one place to read a draft the way a reviewer needs to see it ────────────
CREATE OR REPLACE FUNCTION public.get_posting_draft(p_draft_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
DECLARE d posting_drafts; v_lines jsonb; v_dr bigint; v_cr bigint;
BEGIN
  SELECT * INTO d FROM posting_drafts WHERE id = p_draft_id;
  IF d.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;

  IF auth.role() IS NOT NULL AND auth.role() <> 'service_role' THEN
    IF NOT EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = auth.uid() AND p.tenant_id = d.tenant_id) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'not_found');
    END IF;
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'line', l.line_no, 'account', l.account, 'description', l.description,
           'debit',  CASE WHEN l.debit_cents  > 0 THEN (l.debit_cents /100.0) END,
           'credit', CASE WHEN l.credit_cents > 0 THEN (l.credit_cents/100.0) END,
           'from', l.evidence_table || ':' || l.evidence_id,
           'why', l.evidence_note) ORDER BY l.line_no), '[]'::jsonb),
         coalesce(sum(l.debit_cents),0), coalesce(sum(l.credit_cents),0)
    INTO v_lines, v_dr, v_cr
    FROM posting_draft_lines l WHERE l.draft_id = d.id;

  RETURN jsonb_build_object(
    'ok', true, 'id', d.id, 'kind', d.kind, 'title', d.title, 'rationale', d.rationale,
    'posting_date', d.posting_date, 'currency', d.currency, 'status', d.status,
    'lines', v_lines,
    'total_debit', (v_dr/100.0), 'total_credit', (v_cr/100.0),
    'balances', (v_dr = v_cr),
    'posted_ref', d.posted_ref, 'posted_at', d.posted_at,
    'payload', d.payload);
END $fn$;

REVOKE ALL ON FUNCTION public.get_posting_draft(uuid) FROM PUBLIC;

notify pgrst, 'reload schema';

DO $a$
DECLARE
  v_tenant uuid; v_de uuid; v_draft uuid; v_inv uuid; v_ref text; v_amt bigint;
  v_err text; v_view jsonb;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE slug = 'outsourcetel-hq';
  SELECT d.id INTO v_de FROM digital_employees d
   WHERE d.tenant_id = v_tenant AND d.archetype_key = 'accounting' LIMIT 1;

  -- Build a REAL draft against a REAL overdue ERP invoice, the way the
  -- accounting employee would: recognise the receivable it can actually see.
  SELECT id, source_external_ref, amount_cents INTO v_inv, v_ref, v_amt
    FROM renewal_invoices
   WHERE tenant_id = v_tenant AND due_date < current_date
     AND coalesce(status,'') NOT IN ('paid','void','cancelled')
   ORDER BY due_date LIMIT 1;
  IF v_inv IS NULL THEN RAISE EXCEPTION '531: no real invoice to draft against'; END IF;

  INSERT INTO posting_drafts (tenant_id, de_id, kind, title, rationale, posting_date, payload)
  VALUES (v_tenant, v_de, 'journal_entry',
    format('Recognise receivable — %s', v_ref),
    format('Invoice %s is issued and unpaid. Recognising the receivable and the revenue against it. Figures taken from the ERP invoice record, not restated.', v_ref),
    current_date, jsonb_build_object('probe', true))
  RETURNING id INTO v_draft;

  -- ── an UNBALANCED posting must be refused ────────────────────────────────
  INSERT INTO posting_draft_lines (draft_id, line_no, account, description, debit_cents, credit_cents, evidence_table, evidence_id)
  VALUES (v_draft, 1, 'Debtors', 'Receivable', v_amt, 0, 'renewal_invoices', v_inv::text);

  BEGIN
    UPDATE posting_drafts SET status = 'submitted' WHERE id = v_draft;
    RAISE EXCEPTION '531: an unbalanced journal entry was allowed through to a human';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE '531:%' THEN RAISE; END IF;
    IF v_err NOT LIKE '%does not balance%' THEN
      RAISE EXCEPTION '531: refused for the wrong reason: %', v_err;
    END IF;
  END;

  -- ── a line with NO EVIDENCE must be refused, even when it balances ───────
  INSERT INTO posting_draft_lines (draft_id, line_no, account, description, debit_cents, credit_cents, evidence_table, evidence_id)
  VALUES (v_draft, 2, 'Revenue', 'Services revenue', 0, v_amt, '  ', '  ');

  BEGIN
    UPDATE posting_drafts SET status = 'submitted' WHERE id = v_draft;
    RAISE EXCEPTION '531: a line with no stated source reached a human';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE '531:%' THEN RAISE; END IF;
    IF v_err NOT LIKE '%where the figure came from%' THEN
      RAISE EXCEPTION '531: refused for the wrong reason: %', v_err;
    END IF;
  END;

  -- ── balanced AND evidenced: now it may go to a person ────────────────────
  UPDATE posting_draft_lines
     SET evidence_table = 'renewal_invoices', evidence_id = v_inv::text,
         evidence_note = 'Face value of the ERP invoice'
   WHERE draft_id = v_draft AND line_no = 2;

  UPDATE posting_drafts SET status = 'submitted' WHERE id = v_draft;

  v_view := get_posting_draft(v_draft);
  IF (v_view->>'balances')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION '531: a submitted posting reports itself unbalanced: %', v_view;
  END IF;
  IF jsonb_array_length(v_view->'lines') <> 2 THEN
    RAISE EXCEPTION '531: the reviewer view lost lines';
  END IF;
  -- Every line must tell the reviewer where to look.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_view->'lines') e
              WHERE coalesce(e->>'from','') NOT LIKE 'renewal_invoices:%') THEN
    RAISE EXCEPTION '531: a line in the reviewer view does not cite its source';
  END IF;

  -- A refusal needs no arithmetic — it must not be blocked by the gate.
  UPDATE posting_drafts SET status = 'rejected' WHERE id = v_draft;

  -- Put the tenant back: this was a proof, not a posting.
  DELETE FROM posting_drafts WHERE id = v_draft;
  IF EXISTS (SELECT 1 FROM posting_drafts WHERE tenant_id = v_tenant) THEN
    RAISE EXCEPTION '531: the self-test left a draft behind';
  END IF;

  RAISE NOTICE '531: unbalanced refused, unevidenced refused, balanced+evidenced accepted, reviewer view cites every source';
END $a$;
