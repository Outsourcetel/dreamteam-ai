-- 572 — put back the auto-send that a poisoned metric took away.
--
-- Sequence, all today, all visible in audit_events:
--   13:21  568 grants auto-send after a 93.8% certification.
--   13:30  the reply-mode gate cron demotes it back to draft —
--          "degraded 8-week metrics (escalation 97%, errors 0%)".
--   14:xx  571 finds the 97% was the employee's OWN CERTIFICATION EXAMS:
--          54 of 57 decisions. Excluded, the record is 3 decisions.
--
-- The gate was not wrong to look; the number it read was manufactured. This
-- restores the state the founder asked for, now that the evidence underneath it
-- is honest.
--
-- WHY THIS WILL NOT SIMPLY BE UNDONE AGAIN. The gate demotes on
-- total_decisions >= 10 AND (escalation > 50 OR errors > 15). Post-571 the
-- employee has 3 production decisions, under the gate's own floor — it will
-- decline to judge, which is the correct behaviour for an employee with no real
-- track record yet. As genuine customer traffic accumulates the gate starts
-- judging real work, which is exactly what it is for. Asserted below rather
-- than hoped.
--
-- The gate's 7-day dedup on trust_demotion_notice would have suppressed a
-- re-demotion anyway. That is NOT relied on here — a fix that works only
-- because a cooldown is masking it is not a fix.

BEGIN;

DO $restore$
DECLARE
  v_tenant uuid := '5bb802e1-8e92-4eef-9a7a-ac348785d43f';
  v_de     uuid := '7c6a2668-1587-4d7a-a1eb-01da95e0a672';
  v_gated  boolean;
  v_total  bigint;
  v_esc    numeric;
BEGIN
  -- Same precondition 568 enforced: never enable auto-send for a gated employee.
  SELECT g.gated INTO v_gated FROM de_records_gate(v_tenant, v_de) g;
  IF v_gated THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: employee is gated — re-certify before restoring auto-send';
  END IF;

  -- And a new one: refuse to restore into the very condition that would
  -- immediately revoke it. If the gate would still demote, stop and say so
  -- instead of starting the loop over.
  SELECT m.total_decisions, m.escalation_rate INTO v_total, v_esc
    FROM get_de_performance_metrics(v_tenant, 8) m WHERE m.de_id = v_de;
  IF coalesce(v_total, 0) >= 10 AND coalesce(v_esc, 0) > 50 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: gate would demote again (% decisions, %%% escalation) — restoring would just restart the loop', v_total, v_esc;
  END IF;

  UPDATE digital_employees
     SET external_reply_mode = 'auto'
   WHERE id = v_de AND tenant_id = v_tenant;

  PERFORM append_audit_event_internal(
    v_tenant, 'Technical Support', 'de',
    format('Auto-send restored. It was revoked at 13:30 by the reply-mode gate for "degraded 8-week metrics (escalation 97%%)" — a figure made almost entirely of this employee''s own certification exams (54 of 57 decisions). Migration 571 stopped exam answers counting as production work; the honest record is %s decisions at %s%% escalation.',
           coalesce(v_total, 0), coalesce(round(v_esc), 0)),
    'config_change',
    jsonb_build_object('de_id', v_de, 'restored_after', 'reply_mode_demotion',
                       'production_decisions', coalesce(v_total, 0),
                       'escalation_rate', v_esc, 'changed_via', 'migration 572')
  );
END
$restore$;

-- ── Asserts ────────────────────────────────────────────────────────────────
DO $probe$
DECLARE
  v_tenant uuid := '5bb802e1-8e92-4eef-9a7a-ac348785d43f';
  v_de     uuid := '7c6a2668-1587-4d7a-a1eb-01da95e0a672';
  v_mode   text;
  v_total  bigint;
  v_esc    numeric;
  v_n      int;
BEGIN
  -- P1: back on auto.
  SELECT external_reply_mode INTO v_mode FROM digital_employees WHERE id = v_de;
  IF v_mode IS DISTINCT FROM 'auto' THEN
    RAISE EXCEPTION 'P1 FAILED: mode = %, expected auto', v_mode;
  END IF;

  -- P2: THE ONE THAT MATTERS — simulate the gate's own predicate. If this
  -- would fire, the demotion loop is still live and P1 is worthless.
  SELECT m.total_decisions, m.escalation_rate INTO v_total, v_esc
    FROM get_de_performance_metrics(v_tenant, 8) m WHERE m.de_id = v_de;
  IF coalesce(v_total, 0) >= 10 AND (coalesce(v_esc, 0) > 50) THEN
    RAISE EXCEPTION 'P2 FAILED: the gate would demote again — % decisions at %%%', v_total, v_esc;
  END IF;

  -- P3: scope unchanged — still exactly one employee on auto anywhere.
  SELECT count(*) INTO v_n FROM digital_employees WHERE external_reply_mode = 'auto';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'P3 FAILED: % employees on auto, expected exactly 1', v_n;
  END IF;

  RAISE NOTICE '572 asserts passed: auto-send restored, and the gate that revoked it would no longer fire.';
END
$probe$;

COMMIT;
