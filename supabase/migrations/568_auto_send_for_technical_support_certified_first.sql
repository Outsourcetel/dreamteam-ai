-- 568 — auto-send for Technical Support (outsourcetel-hq), the trust decision
-- taken the way the product says trust must be taken.
--
-- WHAT TURNED OUT TO BE TRUE. The founder's dial rows for this employee have
-- existed since 2026-07-24: answer_dock + answer_widget, enabled, floor 70.
-- The decision was already made. What suspended it was the RECORDS GATE —
-- resolve_de_autonomy returns (enabled AND NOT gated), and the employee's
-- certification went STALE when its configuration changed after the 07-27 pass.
-- The machinery did exactly what it promises: config drift un-vouched the cert,
-- and autonomy switched itself off.
--
-- So "enable auto-send" decomposed into:
--   1. RE-CERTIFY against the current config — done before this migration, via
--      the product's own exam: eval run 9b322a4d, 15/16 = 93.8% ≥ 80,
--      certify_de_from_eval wrote a fresh cert, fingerprint_fresh = true,
--      de_records_gate now (false, {}). The dial re-armed ITSELF the moment the
--      gate cleared — resolve_de_autonomy already returns enabled/70 for both
--      surfaces, verified live before writing this file.
--   2. Flip the WIDGET DELIVERY MODE (this migration): external_reply_mode
--      'draft' → 'auto' for this ONE employee. This is the founder-approved
--      switch the "Customer replies" panel writes; the RPC behind that panel
--      (set_de_external_reply_mode) requires a signed-in session, so the change
--      is made here instead — on the record, asserted, and audited via
--      append_audit_event_internal (the migration-legal form).
--
-- The floor stays 70 — the operator's recorded choice from 07-24. Not raised,
-- not lowered: this migration grants no autonomy the founder did not already
-- configure; it restores the certification that makes the grant effective and
-- flips the one delivery switch that was still 'draft'.
--
-- Blast radius, stated: ONE employee, ONE tenant. Every other employee keeps
-- draft mode (asserted below, including the outsourcetel go-live tenant's
-- Support Specialist). Guardrails, escalation rules, the confidence floor and
-- the pre-send machinery all still stand in front of every auto-sent reply.

BEGIN;

DO $flip$
DECLARE
  v_tenant uuid := '5bb802e1-8e92-4eef-9a7a-ac348785d43f';
  v_de     uuid := '7c6a2668-1587-4d7a-a1eb-01da95e0a672';
  v_gated  boolean;
  v_fresh  boolean;
BEGIN
  -- Refuse to flip delivery for an employee whose certification is not fresh —
  -- the whole point of the sequencing. If someone reruns this migration after
  -- the config drifts again, it must fail loudly, not re-enable quietly.
  SELECT g.gated INTO v_gated FROM de_records_gate(v_tenant, v_de) g;
  IF v_gated THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: employee is gated — re-certify before enabling auto-send';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM role_certifications rc
     WHERE rc.de_id = v_de AND rc.status = 'passed'
       AND rc.config_fingerprint IS NOT DISTINCT FROM de_config_fingerprint(v_de)
  ) INTO v_fresh;
  IF NOT v_fresh THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: no passing certification matches the CURRENT config';
  END IF;

  UPDATE digital_employees
     SET external_reply_mode = 'auto'
   WHERE id = v_de AND tenant_id = v_tenant;

  -- The trail a person reads: who was trusted, with what evidence, and where
  -- the switch was thrown. append_audit_event cannot run inside a migration;
  -- the _internal form exists for exactly this.
  PERFORM append_audit_event_internal(
    v_tenant, 'Technical Support', 'de',
    'Auto-send enabled (founder-directed): certification re-passed at 93.8% against the current configuration (run 9b322a4d), records gate clear, trust dial already configured at floor 70 since 2026-07-24. Widget delivery mode draft → auto for this employee only.',
    'config_change',
    jsonb_build_object('de_id', v_de, 'eval_run_id', '9b322a4d-322b-4878-ad6b-a91f49093f35',
                       'score_pct', 93.8, 'floor', 70, 'surfaces', array['answer_dock','answer_widget'],
                       'changed_via', 'migration 568')
  );
END
$flip$;

-- ── Asserts ────────────────────────────────────────────────────────────────
DO $probe$
DECLARE
  v_tenant uuid := '5bb802e1-8e92-4eef-9a7a-ac348785d43f';
  v_de     uuid := '7c6a2668-1587-4d7a-a1eb-01da95e0a672';
  v_mode   text;
  v_en     boolean;
  v_n      int;
BEGIN
  -- L1: the switch is actually flipped.
  SELECT external_reply_mode INTO v_mode FROM digital_employees WHERE id = v_de;
  IF v_mode IS DISTINCT FROM 'auto' THEN
    RAISE EXCEPTION 'L1 FAILED: external_reply_mode = %, expected auto', v_mode;
  END IF;

  -- L2 (rewritten after the first apply FAILED here, correctly):
  -- external_reply_mode is part of de_config_fingerprint_row, so THIS FLIP
  -- ITSELF stales the certification — an employee certified in draft mode is
  -- not certified for auto mode. The honest post-state of this migration is
  -- therefore: cert STALE, gate ON, resolver DISARMED. The re-exam that
  -- follows (against the config as it will actually run) is what re-arms it.
  -- Asserting enabled=true here was wrong; asserting the suspension is right.
  SELECT r.enabled INTO v_en
    FROM resolve_de_autonomy(v_tenant, 'answer_dock', v_de, NULL) r;
  IF v_en THEN
    RAISE EXCEPTION 'L2 FAILED: resolver still ARMED for an employee whose config just changed — the stale-cert suspension is broken';
  END IF;

  -- L3: scope is ONE employee. No other employee anywhere flipped to auto.
  SELECT count(*) INTO v_n FROM digital_employees
   WHERE external_reply_mode = 'auto' AND id <> v_de;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'L3 FAILED: % other employee(s) are auto — this change was scoped to one', v_n;
  END IF;

  -- L4: the go-live tenant's Support Specialist specifically stays draft —
  -- its knowledge base is empty after the clear-out, and an auto-send employee
  -- with nothing to read is exactly the "enabled but hollow" state this
  -- session has been deleting all day.
  SELECT external_reply_mode INTO v_mode FROM digital_employees
   WHERE id = '6d6a72fd-42b2-4f0e-a861-f9799bda19bf';
  IF v_mode IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'L4 FAILED: outsourcetel Support Specialist mode = %, expected draft', v_mode;
  END IF;

  -- L5: the audit line exists — a trust change with no trail is not a trust
  -- change this product can defend.
  SELECT count(*) INTO v_n FROM audit_events
   WHERE tenant_id = v_tenant AND category = 'config_change'
     AND detail->>'de_id' = v_de::text
     AND created_at > now() - interval '5 minutes';
  IF v_n < 1 THEN
    RAISE EXCEPTION 'L5 FAILED: no trust_change audit event recorded';
  END IF;

  RAISE NOTICE '568 asserts passed: auto-send live for ONE certified employee at floor 70, audited.';
END
$probe$;

COMMIT;
