-- 540_hq_workspace_cleared_verification.sql
-- ============================================================================
-- Founder request: clear OutsourceTel's workspace so fresh actions run against a
-- clean slate, with the knowledge base and Workforce Assistant untouched here
-- and in every other tenant.
--
-- BACKED UP FIRST: backups/outsourcetel-hq-2026-07-30/ — 23,430 rows across 115
-- tables. Data restore has never been drilled on this project, so the deletion
-- is irreversible in practice and that snapshot is the only way back.
--
-- ── WHY THIS IS A VERIFICATION, NOT THE DELETE ─────────────────────────────
-- The first attempt ran every delete in one transaction and hit a gateway
-- timeout, rolling back entirely. The cause is worth recording:
-- trg_remote_access_audit and trg_tenant_activity_log FIRE ON DELETE, so
-- removing 23k rows also writes ~23k audit rows. The clear was therefore run in
-- seven batches, with activity_events and tenant_activity_log deleted LAST so
-- the earlier batches' own audit writes did not refill them.
--
-- A one-off data operation is not a schema change and does not belong in a
-- migration. What belongs here is the ASSERTION that the line was drawn exactly
-- where it was meant to be.
--
-- ── audit_events AND de_token_usage WERE DELIBERATELY KEPT ─────────────────
-- audit_events is hash-chained and read by verify_audit_chain; deleting rows
-- breaks it, and mig 549 exists because a FALSE break in that chain cost real
-- time. It is a record of history, not operational state — clearing it would
-- not make the next action fresher, only destroy the evidence spine.
-- de_token_usage is the only record of what this platform has ever spent
-- against an LLM provider, and is currently evidence in an account appeal.
-- Deleting spend history while contesting a suspension would be indefensible.
-- ============================================================================

DO $verify$
DECLARE
  v_tenant uuid; n_know int; n_chunks int; n_plat int; n_de int; n_wa int;
  n_work int; n_tasks int; n_conv int; n_inv int; n_acct int;
  n_audit int; n_defs int; n_guard int; n_watch int; n_tok int;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE slug = 'outsourcetel-hq';
  IF v_tenant IS NULL THEN RAISE EXCEPTION '540: outsourcetel-hq not found'; END IF;

  -- ── the workspace is clear ──────────────────────────────────────────────
  SELECT count(*) INTO n_work  FROM de_work_items     WHERE tenant_id = v_tenant;
  SELECT count(*) INTO n_tasks FROM human_tasks       WHERE tenant_id = v_tenant;
  SELECT count(*) INTO n_conv  FROM de_conversations  WHERE tenant_id = v_tenant;
  SELECT count(*) INTO n_inv   FROM renewal_invoices  WHERE tenant_id = v_tenant;
  SELECT count(*) INTO n_acct  FROM customer_accounts WHERE tenant_id = v_tenant;
  IF n_work + n_tasks + n_conv + n_inv + n_acct > 0 THEN
    RAISE EXCEPTION '540: not clear — % work, % tasks, % conversations, % invoices, % accounts remain',
      n_work, n_tasks, n_conv, n_inv, n_acct;
  END IF;

  -- ── KNOWLEDGE SURVIVED, here and platform-wide ──────────────────────────
  SELECT count(*) INTO n_know   FROM knowledge_docs       WHERE tenant_id = v_tenant;
  SELECT count(*) INTO n_chunks FROM knowledge_doc_chunks WHERE tenant_id = v_tenant;
  SELECT count(*) INTO n_plat   FROM platform_knowledge_docs;
  IF n_know = 0 OR n_chunks = 0 THEN
    RAISE EXCEPTION '540: tenant knowledge destroyed (% docs, % chunks)', n_know, n_chunks;
  END IF;
  IF n_plat = 0 THEN
    RAISE EXCEPTION '540: the DreamTeam AI knowledge shelf was destroyed';
  END IF;

  -- ── THE EMPLOYEES SURVIVED, including the one named explicitly ──────────
  SELECT count(*) INTO n_de FROM digital_employees WHERE tenant_id = v_tenant;
  IF n_de < 16 THEN RAISE EXCEPTION '540: expected 16 employees, found %', n_de; END IF;
  SELECT count(*) INTO n_wa FROM digital_employees
   WHERE name ILIKE '%assistant%' OR coalesce(persona_name, '') ILIKE '%assistant%';
  IF n_wa = 0 THEN RAISE EXCEPTION '540: no Workforce Assistant survives in any tenant'; END IF;

  -- ── and what makes them work ────────────────────────────────────────────
  SELECT count(*) INTO n_defs  FROM playbook_definitions WHERE tenant_id = v_tenant;
  SELECT count(*) INTO n_guard FROM guardrail_rules      WHERE tenant_id = v_tenant;
  SELECT count(*) INTO n_watch FROM work_watchers        WHERE tenant_id = v_tenant;
  IF n_defs = 0 OR n_guard = 0 OR n_watch = 0 THEN
    RAISE EXCEPTION '540: configuration was cleared with the work (% defs, % guardrails, % watchers)',
      n_defs, n_guard, n_watch;
  END IF;
  -- Watchers must have forgotten what they saw, or nothing re-opens.
  IF EXISTS (SELECT 1 FROM work_watchers WHERE tenant_id = v_tenant AND last_run_at IS NOT NULL) THEN
    RAISE EXCEPTION '540: a watcher still remembers its last run and will not re-open old cases';
  END IF;

  -- ── the records that must never be cleared ──────────────────────────────
  SELECT count(*) INTO n_audit FROM audit_events   WHERE tenant_id = v_tenant;
  SELECT count(*) INTO n_tok   FROM de_token_usage WHERE tenant_id = v_tenant;
  IF n_audit < 13000 THEN
    RAISE EXCEPTION '540: audit history was deleted (% left) — the chain is broken', n_audit;
  END IF;
  IF n_tok < 1400 THEN
    RAISE EXCEPTION '540: LLM spend history was deleted (% left)', n_tok;
  END IF;

  RAISE NOTICE '540: clear. Kept % knowledge doc(s), % chunk(s), % platform doc(s), % employee(s), % playbook(s), % guardrail(s), % watcher(s), % audit event(s), % usage row(s).',
    n_know, n_chunks, n_plat, n_de, n_defs, n_guard, n_watch, n_audit, n_tok;
END $verify$;
