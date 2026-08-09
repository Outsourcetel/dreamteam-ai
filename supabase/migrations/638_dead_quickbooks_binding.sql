-- 638 — a book bound to a connector that does not exist.
--
-- Account Success DE carried a connected system `quickbooks`, binding_kind
-- 'connector', with connector_id NULL. A connector-kind binding with no
-- connector cannot be opened by anything: read_de_system hands every
-- non-internal_table binding to the connector path, which then has nothing to
-- resolve. The employee reports "one of my data sources is disconnected and
-- inaccessible" and re-raises that block every day it stays true.
--
-- This workspace runs ERPNext, not QuickBooks. The cs_manager archetype
-- declares exactly one system — `accounts` — so this row did not come from the
-- role kit and re-running install_role_systems will not bring it back.
--
-- DEACTIVATED, NOT DELETED. install_role_systems upserts on (de_id, system_key)
-- and would flip `active` back to true if the key were ever re-declared, so a
-- delete could silently return; and the row is the only record that this
-- binding once existed and was wrong. Same reasoning as retiring the specialist
-- role in migration 611: keep the row, remove the effect.
--
-- WHAT THIS DOES NOT FIX, so nobody reads more into it than it does: the
-- Accounting DE's ledger book is empty because journal entries have no ingest
-- path at all, and that is a separate, larger piece of work.

BEGIN;

UPDATE de_connected_systems s
   SET active = false,
       label  = 'QuickBooks (retired — workspace uses ERPNext; binding had no connector)'
  FROM digital_employees de, tenants t
 WHERE s.de_id = de.id
   AND s.tenant_id = t.id
   AND t.slug = 'outsourcetel-hq'
   AND s.system_key = 'quickbooks'
   AND s.binding_kind = 'connector'
   AND s.connector_id IS NULL;

DO $probe$
DECLARE
  v_left int;
  v_orphans int;
BEGIN
  -- S1: the specific row is off.
  SELECT count(*) INTO v_left
    FROM de_connected_systems s
    JOIN tenants t ON t.id = s.tenant_id
   WHERE t.slug = 'outsourcetel-hq'
     AND s.system_key = 'quickbooks'
     AND s.active;
  IF v_left > 0 THEN
    RAISE EXCEPTION 'S1 FAILED: the quickbooks binding is still active';
  END IF;

  -- S2: THE GENERAL RULE, which is the point. No ACTIVE connector-kind binding
  -- anywhere may lack a connector — in any tenant, for any employee. A book
  -- that cannot be opened is worse than an absent one, because the employee
  -- keeps trying and keeps escalating.
  SELECT count(*) INTO v_orphans
    FROM de_connected_systems s
   WHERE s.active
     AND s.binding_kind = 'connector'
     AND s.connector_id IS NULL;
  IF v_orphans > 0 THEN
    RAISE EXCEPTION 'S2 FAILED: % active connector binding(s) still have no connector', v_orphans;
  END IF;

  RAISE NOTICE '638 asserts passed: dead binding retired; no active connector binding anywhere lacks a connector.';
END
$probe$;

COMMIT;
