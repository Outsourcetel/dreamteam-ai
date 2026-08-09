-- 639 — journal entries can finally arrive.
--
-- The Accounting DE's `ledger` book reads public.journal_entries, which has
-- been EMPTY for this workspace since the day it was bound. The ERPNext
-- connector is healthy — connected, syncing hourly, zero failures — but the
-- ingest could only ever write four things: AR records, contacts,
-- opportunities and tickets. There has never been an
-- upsert_external_journal_entry. The employee was not misconfigured; the pipe
-- did not exist, so it opened an empty book, escalated, and re-raised that
-- block every day. 14 of 59 queue items in the real workspace trace to it.
--
-- ── IDEMPOTENCY NEEDED A KEY, AND THERE WAS NONE ───────────────────────────
-- journal_entries had no external reference and no unique index beyond its
-- primary key, so a re-sync would have inserted every entry again, every hour.
-- external_ref + a unique index on (tenant_id, source, external_ref) is what
-- makes the hourly sync safe to repeat. Partial, because rows created by hand
-- inside the product carry no external_ref and must not collide with each other
-- (NULLs are distinct in a unique index, but a partial index states the intent).
--
-- ── AND THE PERIMETER, LEARNED THE HARD WAY ────────────────────────────────
-- This function takes p_tenant_id AS A PARAMETER and writes into that tenant.
-- That is precisely the shape of the six cross-tenant write holes migration 636
-- closed a day ago: correct for a headless service-role ingest, catastrophic if
-- `authenticated` can reach it. The REVOKE is in this migration, not a later
-- one, and the assert proves it before this file can commit.

BEGIN;

ALTER TABLE public.journal_entries
  ADD COLUMN IF NOT EXISTS external_ref text;

CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_tenant_source_ref_uidx
  ON public.journal_entries (tenant_id, source, external_ref)
  WHERE external_ref IS NOT NULL;

CREATE OR REPLACE FUNCTION public.upsert_external_journal_entry(
  p_tenant_id    uuid,
  p_provider     text,
  p_external_ref text,
  p_entry_date   date,
  p_memo         text,
  p_debit        numeric,
  p_credit       numeric
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
BEGIN
  IF p_tenant_id IS NULL OR coalesce(btrim(p_external_ref), '') = '' THEN
    RAISE EXCEPTION 'tenant_id and external_ref are required';
  END IF;

  INSERT INTO journal_entries (tenant_id, source, external_ref, entry_date, memo, debit, credit)
  VALUES (p_tenant_id, coalesce(nullif(btrim(p_provider), ''), 'external'), btrim(p_external_ref),
          p_entry_date, nullif(btrim(p_memo), ''),
          -- debit/credit are NOT NULL. A missing figure becomes 0, never a
          -- guess: a ledger that invents an amount is worse than one that is
          -- visibly incomplete.
          coalesce(p_debit, 0), coalesce(p_credit, 0))
  ON CONFLICT (tenant_id, source, external_ref) WHERE external_ref IS NOT NULL
  DO UPDATE SET
    entry_date = excluded.entry_date,
    memo       = excluded.memo,
    debit      = excluded.debit,
    credit     = excluded.credit
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

REVOKE ALL ON FUNCTION
  public.upsert_external_journal_entry(uuid, text, text, date, text, numeric, numeric)
  FROM PUBLIC, anon, authenticated;

DO $probe$
DECLARE
  v_tenant uuid;
  v_a uuid;
  v_b uuid;
  v_n int;
BEGIN
  -- S1: NOT reachable by a client role. Checked first because this is the
  -- failure that matters most and the one this shape keeps producing.
  IF has_function_privilege('authenticated',
       'public.upsert_external_journal_entry(uuid, text, text, date, text, numeric, numeric)', 'EXECUTE')
     OR has_function_privilege('anon',
       'public.upsert_external_journal_entry(uuid, text, text, date, text, numeric, numeric)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S1 FAILED: a client role can write journal entries into any tenant';
  END IF;

  SELECT id INTO v_tenant FROM tenants WHERE slug = 'outsourcetel-hq';
  IF v_tenant IS NOT NULL THEN
    -- S2: it actually writes.
    v_a := upsert_external_journal_entry(v_tenant, 'probe639', 'PROBE-JE-1',
             current_date, 'probe entry', 100.00, 0);
    IF v_a IS NULL THEN RAISE EXCEPTION 'S2 FAILED: insert returned no id'; END IF;

    -- S3: IDEMPOTENT. The sync runs hourly; without this the ledger would grow
    -- by a full copy of itself every hour and every balance would be wrong.
    v_b := upsert_external_journal_entry(v_tenant, 'probe639', 'PROBE-JE-1',
             current_date, 'probe entry corrected', 150.00, 0);
    IF v_b IS DISTINCT FROM v_a THEN
      RAISE EXCEPTION 'S3 FAILED: re-ingesting the same entry created a SECOND row';
    END IF;

    SELECT count(*) INTO v_n FROM journal_entries
     WHERE tenant_id = v_tenant AND source = 'probe639';
    IF v_n <> 1 THEN RAISE EXCEPTION 'S3 FAILED: % rows for one external_ref', v_n; END IF;

    -- S4: the update actually took — an upsert that silently keeps the old
    -- figures would leave a corrected entry stale.
    SELECT count(*) INTO v_n FROM journal_entries
     WHERE id = v_a AND debit = 150.00 AND memo = 'probe entry corrected';
    IF v_n <> 1 THEN RAISE EXCEPTION 'S4 FAILED: the conflict path did not update the row'; END IF;

    DELETE FROM journal_entries WHERE tenant_id = v_tenant AND source = 'probe639';
  END IF;

  RAISE NOTICE '639 asserts passed: journal ingest writes, is idempotent, updates on conflict, and is closed to client roles.';
END
$probe$;

COMMIT;
