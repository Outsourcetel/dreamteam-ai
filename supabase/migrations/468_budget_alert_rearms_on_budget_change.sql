-- 468_budget_alert_rearms_on_budget_change.sql
-- ============================================================================
-- The AI-budget alert stops warning when the budget changes. Found while
-- resolving two stale budget alerts for Outsourcetel.
--
-- ── The gap ──────────────────────────────────────────────────────────────
-- check_tenant_ai_budget suppresses a duplicate on (kind, tenant_id, period):
--
--     where not exists (select 1 from ops_alerts a
--       where a.kind = v_kind
--         and a.detail->>'tenant_id' = p_tenant_id::text
--         and a.detail->>'period'    = v_period)
--
-- One alert per tenant, per kind, per MONTH. Sensible on its own — once a
-- budget is exhausted usage only climbs, so repeating the warning adds nothing.
--
-- But the THRESHOLD MOVES WHEN THE BUDGET MOVES, and the key does not follow.
-- Outsourcetel's actual history this month:
--
--     22 Jul  ai_budget_exhausted    566,850 of   400,000   ← alerted
--     23 Jul  ai_budget_approaching  776,981 of   970,000   ← alerted (budget raised)
--     now                          1,399,553 of 5,000,000   ← raised again
--
-- 80% of the current budget is 4,000,000 tokens. If usage crosses that in July,
-- **no alert fires** — an ai_budget_approaching row already exists for period
-- 2026-07. The warning that matters most, on the largest budget, is the one
-- guaranteed to be silent. The next genuine warning for this tenant is 1 August.
--
-- ── The fix: include the budget in the key ───────────────────────────────
-- One alert per (tenant, kind, BUDGET, month). Raising or lowering the budget
-- re-arms the warning, because crossing 80% of a different number is a
-- different fact. Everything else is unchanged.
--
-- ── What is deliberately NOT changed ─────────────────────────────────────
-- The key still ignores resolved_at. Tempting to mirror check_dispatch_failures
-- (which re-alerts once an alert is acknowledged and closed), but the semantics
-- differ: a dispatch failure is a discrete event that may recur, whereas being
-- over budget is a CONTINUOUS state. Re-arming on resolve would mean that
-- acknowledging the alert immediately re-raises it while you are still over —
-- which trains people to ignore the banner, the exact failure this project
-- already has with alerts nobody clears.
--
-- The approaching → exhausted transition already works and needs nothing: the
-- kind changes, so the key changes.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text;
  a_key text := '         and a.detail->>''period'' = v_period';
  v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='check_tenant_ai_budget';
  IF v_src IS NULL THEN RAISE EXCEPTION '468: check_tenant_ai_budget not found'; END IF;

  IF v_src LIKE '%a.detail->>''budget''%' THEN
    RAISE NOTICE '468: the budget is already in the dedupe key';
    RETURN;
  END IF;

  v_hits := (length(v_src) - length(replace(v_src, a_key, ''))) / length(a_key);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION '468: expected 1 dedupe period clause, found % — the body changed, refusing to guess', v_hits;
  END IF;

  v_new := replace(v_src, a_key, a_key || chr(10) ||
    '         -- Budget is part of the key (mig 468): 80% of a different number' || chr(10) ||
    '         -- is a different fact, so raising or lowering the ceiling re-arms' || chr(10) ||
    '         -- the warning. Without this the alert goes quiet for the rest of' || chr(10) ||
    '         -- the month exactly when the ceiling has just moved.' || chr(10) ||
    '         and a.detail->>''budget'' = v_budget::text');

  IF v_new = v_src THEN RAISE EXCEPTION '468: the edit did not land'; END IF;
  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE
  v_def text; v_res jsonb;
  v_tenant uuid := '5bb802e1-8e92-4eef-9a7a-ac348785d43f';
  v_period text := to_char(date_trunc('month', now()), 'YYYY-MM');
  v_would_suppress_old boolean; v_would_suppress_new boolean;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='check_tenant_ai_budget';

  IF v_def NOT LIKE '%a.detail->>''budget'' = v_budget::text%' THEN
    RAISE EXCEPTION '468: the budget is not in the dedupe key';
  END IF;
  -- The rest of the key must survive: dropping tenant or period would turn one
  -- alert per tenant per month into one alert EVER, across all tenants.
  IF v_def NOT LIKE '%a.detail->>''tenant_id'' = p_tenant_id::text%'
     OR v_def NOT LIKE '%a.detail->>''period'' = v_period%' THEN
    RAISE EXCEPTION '468: the tenant or period key was lost — alerts would over-suppress';
  END IF;
  -- The threshold and the two kinds are the product behaviour, not plumbing.
  IF v_def NOT LIKE '%0.8%' THEN
    RAISE EXCEPTION '468: the 80%% threshold was lost in the rewrite';
  END IF;
  IF v_def NOT LIKE '%ai_budget_approaching%' OR v_def NOT LIKE '%ai_budget_exhausted%' THEN
    RAISE EXCEPTION '468: a budget alert kind was lost';
  END IF;
  IF v_def NOT LIKE '%no ceiling%' AND v_def NOT LIKE '%v_budget <= 0%' THEN
    RAISE EXCEPTION '468: the no-ceiling early return was lost — budgetless tenants would be evaluated';
  END IF;

  -- ⚠ LOGICAL PROOF OF THE RE-ARM, evaluated against the real rows rather than
  -- asserted. The OLD key (kind+tenant+period) still matches the July row, so
  -- it WOULD have suppressed. The NEW key adds the current budget, which no row
  -- carries, so it WOULD alert. That difference is the entire fix.
  SELECT EXISTS (SELECT 1 FROM ops_alerts a
                  WHERE a.kind = 'ai_budget_approaching'
                    AND a.detail->>'tenant_id' = v_tenant::text
                    AND a.detail->>'period' = v_period)
    INTO v_would_suppress_old;

  SELECT EXISTS (SELECT 1 FROM ops_alerts a
                  WHERE a.kind = 'ai_budget_approaching'
                    AND a.detail->>'tenant_id' = v_tenant::text
                    AND a.detail->>'period' = v_period
                    AND a.detail->>'budget' = (SELECT monthly_token_budget::text
                                                 FROM tenants WHERE id = v_tenant))
    INTO v_would_suppress_new;

  IF NOT v_would_suppress_old THEN
    RAISE NOTICE '468: no July row for this tenant — the re-arm proof is vacuous here, but the key change stands';
  ELSIF v_would_suppress_new THEN
    RAISE EXCEPTION '468: the new key still suppresses at the current budget — the re-arm does not work';
  ELSE
    RAISE NOTICE '468: proven — old key suppressed at the current budget, new key does not.';
  END IF;

  -- Behavioural: still returns its contract, and must NOT alert right now
  -- (1.4M of 5M is 28%, well under the threshold).
  SELECT public.check_tenant_ai_budget(v_tenant) INTO v_res;
  IF v_res->>'allowed' IS NULL OR v_res->>'budget' IS NULL THEN
    RAISE EXCEPTION '468: the function no longer returns its contract';
  END IF;
  IF EXISTS (SELECT 1 FROM ops_alerts
              WHERE kind LIKE 'ai_budget%' AND resolved_at IS NULL) THEN
    RAISE EXCEPTION '468: an alert was raised at 28%% of budget — the threshold is wrong';
  END IF;

  RAISE NOTICE '468: budget alerts now re-arm when the ceiling moves. Current: % ', v_res::text;
END $assert$;

NOTIFY pgrst, 'reload schema';
