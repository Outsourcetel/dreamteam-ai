-- ═══════════════════════════════════════════════════════════════════════════
-- 371 — Tenant deletion that actually deletes, and can prove it.
--
-- delete_tenant (migration 194) is well guarded but structurally incomplete:
-- it issues three DELETEs and trusts FK cascade for everything else. Measured
-- against production on 2026-07-26, before this file:
--
--   216 public TABLES carry a tenant_id column  (+2 relations named in the
--       brief — eval_gate, pipeline_summary — are VIEWS: pg_class.relkind='v',
--       verified, so they hold no rows and are excluded, not "fixed")
--   195 of those 216 have ON DELETE CASCADE on tenant_id -> tenants
--    17 have NO foreign key to tenants at all
--     3 have ON DELETE SET NULL  (audit_logs, ai_usage_events, profiles)
--     1 has  ON DELETE NO ACTION (platform_access_events)
--
-- The 17 unreferenced tables include customers, invoices, payments, bills,
-- vendors, bank_transactions, journal_entries and the whole close_* subtree.
-- Customer PII and financial records survive tenant deletion today.
--
-- ── THREE THINGS THE AUDIT BRIEF DID NOT CATCH, FOUND WHILE MEASURING ──────
--
-- (A) DELETING A TENANT CURRENTLY MAKES A FRESH COPY OF ITS DATA.
--     log_remote_access_write() is an AFTER INSERT/UPDATE/DELETE trigger on 77
--     tenant tables. It fires when the caller is platform staff with no tenant
--     of their own — which is exactly who runs delete_tenant (measured: both
--     layer='platform' profiles have tenant_id IS NULL). On every cascaded row
--     it INSERTs into remote_access_write_log with old_data = to_jsonb(OLD):
--     a full snapshot of the row being erased.
--     Proof in production: remote_access_write_log holds 219 rows, of which
--     153 (70%) reference tenants that no longer exist — the residue of the 11
--     test tenants deleted in commit c21bae0. tenant_activity_log has 15 more.
--     168 snapshot rows of supposedly-deleted customer data, still readable.
--
-- (B) delete_tenant CANNOT SUCCEED TODAY FOR 4 OF THE 16 LIVE TENANTS.
--     guardrail_adjudications_immutable_trg is a BEFORE DELETE trigger that
--     raises unconditionally — it has no purge escape hatch, unlike the
--     audit_events guard that migration 194 deliberately gave one. And
--     guard_compliance_guardrails refuses to delete any guardrail_rules row
--     with a compliance_pack_key unless app.allow_compliance_change='on'.
--     Measured: 12 such rules across 4 distinct tenants, 2 adjudication rows.
--     Both tables CASCADE from tenants, so the cascade trips its own guards.
--     "Deletion is incomplete" was the known problem; "deletion aborts with a
--     compliance error" is the one nobody had hit yet.
--
-- (C) A COMPLETENESS CHECK OVER profiles WOULD HAVE PASSED WHILE PII SURVIVED.
--     ON DELETE SET NULL does not remove the row, it blanks the tenant_id — so
--     a "count rows where tenant_id = X" check reports zero for a row that
--     still holds the person's full_name. SET NULL launders the violation. It
--     is also how 3 NULL-tenant profiles got into production, one of which
--     broke an assertion in migration 343. See section 4 for what this file
--     does about it, and why it does not simply flip the constraint.
--
-- WHAT THIS MIGRATION DOES
--   1. A receipt table that survives the deletion it records, append-only.
--   2. A purge escape hatch for the adjudication guard (B).
--   3. Direct CASCADE FKs for 15 of the 17 orphan tables + the 2 safe SET NULL
--      conversions — structural, so the next person cannot forget them — and
--      a written argument for the 4 that deliberately do NOT get one
--      (profiles among them: constraint left alone, row deleted explicitly).
--   4. tenant_rows_remaining() — a catalog-driven residue count. No hardcoded
--      table list, because a hardcoded list is what rotted here.
--   5. delete_tenant re-issued: every existing guard preserved verbatim, plus
--      a pre-sweep, the two refill-proof DELETEs from (A), a post-delete
--      verification that RAISES on any residue, and a receipt.
--   6. (removed) A one-time sweep of the 168 pre-existing orphan rows from (A).
--      Cut deliberately: this file is ADDITIVE ONLY and runs no DELETE at apply
--      time. Disposing of historical data is a separate, explicitly-approved
--      decision — see §6 for the full reasoning and how to check what remains.
--   7. Assertions that prove all of the above without deleting a real tenant.
--
-- GLOBAL by construction: schema, constraints and functions only. No
-- tenant-scoped rows, so it reaches all 16 tenants and every future one.
-- ═══════════════════════════════════════════════════════════════════════════


-- ═══ 1. THE RECEIPT ════════════════════════════════════════════════════════
-- "Prove you deleted it" needs an answer that outlives the data. This table
-- deliberately carries a tenant_id and deliberately has NO foreign key to
-- tenants — a receipt that cascades away with the tenant is not a receipt.
-- It is the ONE table section 5 reports as retained rather than as residue,
-- and section 8 asserts that the retained set is exactly this one table.

CREATE TABLE IF NOT EXISTS public.tenant_deletion_receipts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  -- Nullable because a receipt may one day be written for a tenant whose row is
  -- already gone (a historical cleanup). delete_tenant itself always has both.
  tenant_slug       text,
  tenant_name       text,
  deleted_by        uuid,
  deleted_by_name   text,
  deleted_at        timestamptz NOT NULL DEFAULT now(),
  -- How many tenant-scoped tables the sweep visited. Recorded per deletion so
  -- a later schema change is visible as a change in this number.
  tables_swept      int    NOT NULL,
  rows_removed      bigint NOT NULL,
  -- {table: count} for tables that actually held rows. Counts, never content.
  per_table_removed jsonb  NOT NULL DEFAULT '{}'::jsonb,
  -- '{}' means the post-delete sweep found nothing. delete_tenant RAISES rather
  -- than record a non-empty value, so a receipt here is proof of zero residue.
  residual_after    jsonb  NOT NULL DEFAULT '{}'::jsonb,
  verified          boolean NOT NULL DEFAULT false,
  notes             text
);

COMMENT ON TABLE public.tenant_deletion_receipts IS
  'Append-only proof that a tenant was deleted and that the post-delete residue sweep found zero rows. Carries tenant_id with NO FK to tenants on purpose: it must survive the deletion it records. Stores counts only, never customer content.';

CREATE INDEX IF NOT EXISTS idx_tenant_deletion_receipts_tenant
  ON public.tenant_deletion_receipts (tenant_id, deleted_at DESC);

-- Platform-operations data, not tenant data. RLS on with no policy means
-- nothing but the service role and the table owner can read it; the reader
-- RPC below is the sanctioned path.
ALTER TABLE public.tenant_deletion_receipts ENABLE ROW LEVEL SECURITY;

-- A deletion receipt you can edit or delete is worth nothing. Append-only,
-- with no escape hatch at all — unlike audit_events, there is no legitimate
-- reason to purge a receipt: it holds counts, not customer data, so it is
-- never itself the subject of an erasure request.
CREATE OR REPLACE FUNCTION public.tenant_deletion_receipts_immutable()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'tenant_deletion_receipts is append-only — a deletion receipt that can be altered proves nothing';
END $function$;

DROP TRIGGER IF EXISTS tenant_deletion_receipts_no_update_delete ON public.tenant_deletion_receipts;
CREATE TRIGGER tenant_deletion_receipts_no_update_delete
  BEFORE UPDATE OR DELETE ON public.tenant_deletion_receipts
  FOR EACH ROW EXECUTE FUNCTION public.tenant_deletion_receipts_immutable();

-- Reader for the platform console. Same capability that gates seeing the
-- tenant list at all, so nobody gains visibility they did not already have.
CREATE OR REPLACE FUNCTION public.list_tenant_deletion_receipts(p_limit int DEFAULT 100)
RETURNS SETOF public.tenant_deletion_receipts
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  -- Not written as "auth.uid() is not null and ..." on purpose: anon has a
  -- NULL uid, and that shape skips the check entirely (see migration 369).
  IF coalesce(auth.role(), '') <> 'service_role'
     AND NOT resolve_platform_capability(auth.uid(), 'tenants.view')
  THEN
    RAISE EXCEPTION 'not authorized to read tenant deletion receipts';
  END IF;

  RETURN QUERY
    SELECT * FROM tenant_deletion_receipts
     ORDER BY deleted_at DESC
     LIMIT greatest(1, least(coalesce(p_limit, 100), 1000));
END $function$;

-- CREATE OR REPLACE resets grants to the PUBLIC default, so this must come
-- AFTER the body. Doing it before is how the revoke silently undoes itself.
REVOKE ALL ON ROUTINE public.list_tenant_deletion_receipts(int) FROM PUBLIC, anon;
GRANT EXECUTE ON ROUTINE public.list_tenant_deletion_receipts(int) TO authenticated;


-- ═══ 2. UNBLOCK THE CASCADE (finding B) ════════════════════════════════════
-- guardrail_adjudications is append-only because a machine overturning a
-- compliance block must be a permanent record — that stays true. But "the
-- customer's data must be erasable" and "this table can never be deleted from"
-- are in genuine conflict, and today the table wins silently by aborting the
-- deletion. Resolve it the same way migration 194 resolved it for
-- audit_events: a transaction-local flag that ONLY delete_tenant sets, so
-- every ordinary path still hits the exception.
--
-- The UPDATE half of this guard — the byte-for-byte redaction check — is
-- copied through unchanged. Only the DELETE branch gains the escape.
CREATE OR REPLACE FUNCTION public.guardrail_adjudications_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF coalesce(current_setting('app.allow_tenant_purge', true), '') = 'on' THEN
      RETURN OLD;  -- sanctioned erasure inside delete_tenant, that transaction only
    END IF;
    RAISE EXCEPTION 'guardrail_adjudications is append-only: a machine overturning a compliance block is a permanent record';
  END IF;
  IF coalesce(current_setting('app.allow_adjudication_redact', true), '') <> 'on' THEN
    RAISE EXCEPTION 'guardrail_adjudications rows cannot be edited';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.de_id, NEW.conversation_id, NEW.surface, NEW.rule_id,
      NEW.assessment, NEW.confidence, NEW.model, NEW.provider, NEW.prompt_version,
      NEW.mode, NEW.would_clear, NEW.applied, NEW.reason, NEW.content_sha256,
      NEW.audit_event_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.de_id, OLD.conversation_id, OLD.surface, OLD.rule_id,
      OLD.assessment, OLD.confidence, OLD.model, OLD.provider, OLD.prompt_version,
      OLD.mode, OLD.would_clear, OLD.applied, OLD.reason, OLD.content_sha256,
      OLD.audit_event_id, OLD.created_at)
  THEN RAISE EXCEPTION 'guardrail_adjudications: only the text previews may be redacted'; END IF;
  RETURN NEW;
END $function$;


-- ═══ 3. STRUCTURAL COVERAGE — 15 NEW CASCADE FKs, 2 CONVERSIONS ════════════
-- Prefer the FK over a DELETE statement: a constraint cannot be forgotten by
-- whoever writes the next version of delete_tenant, which is precisely how
-- these 17 tables ended up unreferenced.
--
-- Orphan pre-check (adding a FK fails if any row points at a missing parent).
-- Measured on every one of the 21 gap tables:
--   remote_access_write_log   219 rows, 153 orphaned   -> NOT given a FK, §3b
--   tenant_activity_log       236 rows,  15 orphaned   -> NOT given a FK, §3b
--   the other 19               0 orphans               -> safe to constrain
--
-- Several of these tables already cascade *transitively* — close_tasks,
-- exceptions, fin_documents and audit_evidence hang off close_workspaces;
-- knowledge_doc_access_paths off knowledge_docs; escalations off
-- conversations. That is not coverage: close_workspaces itself had no FK to
-- tenants, so the whole close_* subtree was rooted in nothing, and the other
-- links are through NULLABLE columns that leak any row where the parent
-- reference happens to be NULL. A direct FK makes each table independently
-- guaranteed rather than dependent on a chain.

-- ── 3a) indexes first ──
-- A FK whose child column is unindexed turns each parent-row delete into a
-- sequential scan of the child, and holds locks for the duration. Measured:
-- 12 of the 15 had no tenant_id-leading index. escalations, fin_accounts and
-- knowledge_doc_access_paths already do and are skipped.
CREATE INDEX IF NOT EXISTS idx_audit_evidence_tenant     ON public.audit_evidence (tenant_id);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_tenant  ON public.bank_transactions (tenant_id);
CREATE INDEX IF NOT EXISTS idx_bills_tenant              ON public.bills (tenant_id);
CREATE INDEX IF NOT EXISTS idx_close_tasks_tenant        ON public.close_tasks (tenant_id);
CREATE INDEX IF NOT EXISTS idx_close_workspaces_tenant   ON public.close_workspaces (tenant_id);
CREATE INDEX IF NOT EXISTS idx_customers_tenant          ON public.customers (tenant_id);
CREATE INDEX IF NOT EXISTS idx_exceptions_tenant         ON public.exceptions (tenant_id);
CREATE INDEX IF NOT EXISTS idx_fin_documents_tenant      ON public.fin_documents (tenant_id);
CREATE INDEX IF NOT EXISTS idx_invoices_tenant           ON public.invoices (tenant_id);
CREATE INDEX IF NOT EXISTS idx_journal_entries_tenant    ON public.journal_entries (tenant_id);
CREATE INDEX IF NOT EXISTS idx_payments_tenant           ON public.payments (tenant_id);
CREATE INDEX IF NOT EXISTS idx_vendors_tenant            ON public.vendors (tenant_id);

-- ── 3b) the FKs ──
-- Idempotent: ADD CONSTRAINT has no IF NOT EXISTS, so each is guarded by a
-- catalog lookup rather than by hoping the migration runs exactly once.
DO $fks$
DECLARE
  r record;
  -- The 15 orphan tables that CAN take a FK. remote_access_write_log and
  -- tenant_activity_log are deliberately absent — see §3c.
  v_add text[] := ARRAY[
    'audit_evidence','bank_transactions','bills','close_tasks','close_workspaces',
    'customers','escalations','exceptions','fin_accounts','fin_documents',
    'invoices','journal_entries','knowledge_doc_access_paths','payments','vendors'
  ];
  v_tbl text;
  v_orphans bigint;
BEGIN
  FOREACH v_tbl IN ARRAY v_add LOOP
    IF EXISTS (
      SELECT 1 FROM pg_constraint con
        JOIN pg_class ch ON ch.oid = con.conrelid
        JOIN pg_class rc ON rc.oid = con.confrelid
        JOIN pg_namespace n ON n.oid = ch.relnamespace
       WHERE n.nspname = 'public' AND ch.relname = v_tbl
         AND rc.relname = 'tenants' AND con.contype = 'f'
         AND con.conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a
                                  WHERE a.attrelid = ch.oid AND a.attname = 'tenant_id')]
    ) THEN
      CONTINUE;  -- already constrained (re-run of this migration)
    END IF;

    -- Fail loud and specific rather than letting Postgres emit a bare FK
    -- violation that does not say how many rows or which tenant.
    EXECUTE format(
      'SELECT count(*) FROM public.%I x WHERE x.tenant_id IS NOT NULL '
      'AND NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = x.tenant_id)', v_tbl)
      INTO v_orphans;
    IF v_orphans > 0 THEN
      RAISE EXCEPTION '371: % has % row(s) pointing at a tenant that no longer exists — that residue must be swept before the constraint can be added', v_tbl, v_orphans;
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) '
      'REFERENCES public.tenants(id) ON DELETE CASCADE',
      v_tbl, v_tbl || '_tenant_id_fkey');
    RAISE NOTICE '371: % now cascades from tenants', v_tbl;
  END LOOP;

  -- ── SET NULL -> CASCADE, for the two where SET NULL is simply wrong ──
  -- audit_logs.before_data/after_data and ai_usage_events both hold the
  -- tenant's own records; blanking tenant_id leaves them readable and
  -- unattributable. Rows that were ALREADY platform-level (tenant_id IS NULL)
  -- are untouched by a CASCADE, so nothing platform-side is lost.
  -- Measured: audit_logs 1 row / 0 orphans, ai_usage_events 0 rows / 0 orphans.
  -- Neither table has a DELETE trigger, so neither can refill during cascade.
  FOR r IN
    SELECT unnest(ARRAY['audit_logs','ai_usage_events']) AS tbl
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM public.%I x WHERE x.tenant_id IS NOT NULL '
      'AND NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = x.tenant_id)', r.tbl)
      INTO v_orphans;
    IF v_orphans > 0 THEN
      RAISE EXCEPTION '371: % has % orphaned row(s); refusing to convert its FK to CASCADE', r.tbl, v_orphans;
    END IF;
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', r.tbl, r.tbl || '_tenant_id_fkey');
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) '
      'REFERENCES public.tenants(id) ON DELETE CASCADE', r.tbl, r.tbl || '_tenant_id_fkey');
    RAISE NOTICE '371: % converted SET NULL -> CASCADE', r.tbl;
  END LOOP;
END $fks$;

-- ── 3c) FOUR tables that deliberately do NOT get a CASCADE FK ──
--
-- remote_access_write_log, tenant_activity_log
--   A FK here would BREAK every tenant deletion, not fix it. Their writers are
--   AFTER DELETE triggers on 77 and 81 tenant tables respectively, so the
--   cascade INSERTs new rows into them referencing the tenant it is in the
--   middle of deleting. The FK check runs at end of statement — after the
--   parent row is gone — and aborts the whole transaction. Note the trigger
--   bodies swallow their own errors (`exception when others then null`) but
--   NOT this one: an immediate FK check is queued as an after-row trigger on
--   the outer statement and escapes the plpgsql subtransaction.
--   They are swept by explicit DELETE, LAST, after the cascade has finished
--   writing into them. See §5 step 7.
--
-- platform_access_events (currently ON DELETE NO ACTION — left as is)
--   NO ACTION here is a tripwire worth keeping: it makes a hand-typed
--   `DELETE FROM tenants` fail instead of quietly erasing the record of which
--   platform operator entered which customer's workspace. delete_tenant
--   deletes it explicitly and the §5 step 8 sweep verifies it reached zero.
--
-- profiles (currently ON DELETE SET NULL — left as is)
--   Considered flipping it to CASCADE and decided against it. profiles is
--   referenced by six ON DELETE NO ACTION FKs from tables that OUTLIVE the
--   tenant — platform_capability_grants.granted_by, platform_invites
--   .invited_by/.redeemed_by, tenant_provisioning_requests.requested_by_user_id
--   /.reviewed_by, platform_access_events.operator_user_id. Making the FK
--   CASCADE would turn "delete a tenant" into an operation that aborts deep
--   inside a cascade with an opaque constraint name whenever any of those
--   happens to point at one of the tenant's members. Instead the row is
--   deleted EXPLICITLY in §5 step 5, where the failure can be caught and
--   reported in words. Same outcome, legible failure.
--   Leaving SET NULL in place is safe here only because nothing reaches
--   `delete from tenants` except delete_tenant; §7 asserts the explicit DELETE
--   is present so the constraint is never the last line of defence.
--   What is NOT in scope: auth.users. It lives in the auth schema, a public
--   FK cannot reach it, and the login credential survives this. Recorded on
--   every receipt in `notes` rather than glossed over.


-- ═══ 4. THE COMPLETENESS CHECK ═════════════════════════════════════════════
-- Discovered from pg_catalog at call time. A hardcoded table list is exactly
-- what decayed into a 17-table hole here; anything added to the schema later
-- is swept the first time this runs, with no edit to this file.
--
-- SECURITY DEFINER matters for correctness, not just access: postgres owns
-- this function and has rolbypassrls, so the count sees every row. Run under
-- a caller's RLS it would report a comfortable zero for data it merely cannot
-- see — a completeness check that lies is worse than no check.
CREATE OR REPLACE FUNCTION public.tenant_rows_remaining(p_tenant_id uuid)
RETURNS TABLE (table_name text, remaining_rows bigint, counts_as_residue boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  r record;
  v_n bigint;
  -- Tables that legitimately hold rows for a deleted tenant. Returned in the
  -- result set with counts_as_residue = false rather than filtered out, so a
  -- reader can see the exclusion instead of trusting it. §7 asserts this list
  -- stays exactly one element long.
  v_retained constant text[] := ARRAY['tenant_deletion_receipts'];
BEGIN
  -- session_user='postgres' is the direct-connection path (psql, db-query.mjs,
  -- this migration's own assertions). Measured: on a direct connection
  -- auth.role() and auth.uid() are both NULL, so without this the function
  -- would refuse to run for the owner role that already has rolbypassrls and
  -- owns every table — it grants nothing new. PostgREST connects as
  -- 'authenticator' and switches role, so no request from the API can reach it.
  IF session_user <> 'postgres'
     AND coalesce(auth.role(), '') <> 'service_role'
     AND NOT is_platform_admin()
     AND NOT can_admin_tenant_internal(p_tenant_id)
  THEN
    RAISE EXCEPTION 'not authorized to enumerate tenant data';
  END IF;

  FOR r IN
    SELECT c.relname::text AS rel
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
                         AND a.attname = 'tenant_id'
                         AND a.attnum > 0 AND NOT a.attisdropped
     WHERE n.nspname = 'public'
       -- Ordinary and partitioned tables only. VIEWS are excluded because they
       -- own no rows: eval_gate and pipeline_summary are relkind='v' (verified
       -- in pg_class), so counting them would double-count their base tables.
       -- Partition members are excluded so their parent is not counted twice;
       -- measured: 0 partitioned tables exist today, this is future-proofing.
       AND c.relkind IN ('r','p')
       AND NOT c.relispartition
       -- uuid only: every one of the 216 is uuid today, and a text tenant_id
       -- would make the `= $1` comparison below throw rather than mis-count.
       AND a.atttypid = 'uuid'::regtype
     ORDER BY c.relname
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE tenant_id = $1', r.rel)
      INTO v_n USING p_tenant_id;
    table_name        := r.rel;
    remaining_rows    := v_n;
    counts_as_residue := NOT (r.rel = ANY(v_retained));
    RETURN NEXT;
  END LOOP;
END $function$;

COMMENT ON FUNCTION public.tenant_rows_remaining(uuid) IS
  'Counts rows still carrying a given tenant_id across every public table that has one, discovered from pg_catalog at call time. counts_as_residue=false marks tables that are retained on purpose (the deletion receipt). Used by delete_tenant to verify its own work.';

REVOKE ALL ON ROUTINE public.tenant_rows_remaining(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON ROUTINE public.tenant_rows_remaining(uuid) TO authenticated;


-- ═══ 5. delete_tenant — same rails, now verified ═══════════════════════════
-- Every guard from migration 194 is carried through unchanged and in the same
-- order: authenticated, tenants.manage capability, tenant exists, not the demo
-- tenant, not your own tenant, must already be suspended, slug typed to
-- confirm, no sub-tenants. §7 asserts each one is still in the body, because
-- "I rewrote the function and quietly dropped a rail" is the obvious way for
-- this change to do harm.
CREATE OR REPLACE FUNCTION public.delete_tenant(p_tenant_id uuid, p_confirm_slug text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_demo_tenant_id constant uuid := 'a0000000-0000-0000-0000-000000000001';
  v_t tenants;
  v_self uuid;
  v_children int;
  v_actor text;
  v_before jsonb;
  v_rows_before bigint;
  v_tables int;
  v_after jsonb;
  v_rows_after bigint;
  v_profiles int := 0;
  -- Captured before the cascade blanks profiles.tenant_id (SET NULL) — see step 5.
  v_members uuid[] := '{}';
  v_receipt uuid;
BEGIN
  -- ── rails (verbatim from migration 194) ──────────────────────────────────
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF NOT resolve_platform_capability(auth.uid(), 'tenants.manage') THEN
    RAISE EXCEPTION 'only a platform team member with tenant-management access may delete a tenant';
  END IF;

  SELECT * INTO v_t FROM tenants WHERE id = p_tenant_id;
  IF NOT found THEN
    RAISE EXCEPTION 'tenant not found';
  END IF;

  IF p_tenant_id = v_demo_tenant_id THEN
    RAISE EXCEPTION 'the demo tenant cannot be deleted';
  END IF;

  SELECT tenant_id INTO v_self FROM profiles WHERE user_id = auth.uid();
  IF v_self IS NOT DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'you cannot delete the tenant you belong to';
  END IF;

  IF v_t.status <> 'suspended' THEN
    RAISE EXCEPTION 'suspend the tenant before deleting it — deletion is permanent and irreversible';
  END IF;

  IF coalesce(p_confirm_slug, '') <> v_t.slug THEN
    RAISE EXCEPTION 'confirmation text must exactly match the tenant slug (%)', v_t.slug;
  END IF;

  SELECT count(*) INTO v_children FROM tenants WHERE parent_tenant_id = p_tenant_id;
  IF v_children > 0 THEN
    RAISE EXCEPTION 'this tenant still has % sub-tenant(s) — delete or reassign them first', v_children;
  END IF;

  -- ── step 1: who is doing this, captured before anything is removed ───────
  SELECT full_name INTO v_actor FROM profiles WHERE user_id = auth.uid();

  -- ── step 2: pre-sweep — what is about to be destroyed ────────────────────
  -- Counted before, not after, because "rows removed" on a receipt has to be
  -- a measurement, not an inference from a post-delete count of zero.
  SELECT coalesce(jsonb_object_agg(table_name, remaining_rows)
                    FILTER (WHERE remaining_rows > 0 AND counts_as_residue), '{}'::jsonb),
         -- sum(bigint) returns numeric; cast so the receipt column and the
         -- comparison below are unambiguously integral.
         coalesce(sum(remaining_rows) FILTER (WHERE counts_as_residue), 0)::bigint,
         count(*)::int
    INTO v_before, v_rows_before, v_tables
    FROM tenant_rows_remaining(p_tenant_id);

  -- ── step 3: sanction the guarded purges, for THIS transaction only ───────
  -- set_config(..., true) is transaction-local, so the append-only posture is
  -- intact for every other statement in the database.
  PERFORM set_config('app.allow_audit_purge', 'on', true);       -- audit_events (mig 194)
  PERFORM set_config('app.allow_compliance_change', 'on', true); -- guardrail_rules w/ compliance_pack_key
  PERFORM set_config('app.allow_tenant_purge', 'on', true);      -- guardrail_adjudications (§2)

  -- ── step 4: the NO ACTION children the cascade will not take ─────────────
  DELETE FROM tenant_provisioning_requests
    WHERE proposed_parent_tenant_id = p_tenant_id OR created_tenant_id = p_tenant_id;
  DELETE FROM platform_access_events WHERE tenant_id = p_tenant_id;

  -- ── step 5: REMEMBER the members — do not delete them yet ────────────────
  -- ⚠ ORDERING IS LOAD-BEARING. An earlier version deleted profiles HERE,
  -- before the cascade, and that makes a workspace permanently undeletable the
  -- moment anyone uses it properly. Eleven FKs point at profiles with
  -- ON DELETE NO ACTION, and five of those sit on TENANT-scoped tables:
  --   tenant_api_keys.created_by            tenant_feature_overrides.set_by
  --   tenant_ip_allowlist_entries.created_by  tenant_ip_allowlists.updated_by
  --   tenant_session_policies.updated_by
  -- Those rows still exist at this point; only step 6 removes them. So the
  -- profile delete raised, and the whole transaction rolled back, for any
  -- tenant whose admin had ever created an API key or an IP allowlist entry.
  -- It does not fire on today's data purely by luck: all 8 existing
  -- tenant_feature_overrides rows were set by a PLATFORM profile, which the
  -- layer filter below excludes. The first tenant admin to use the Security
  -- page would have locked their own workspace into existence forever.
  --
  -- tenant_id is captured into an array because step 6's cascade is what
  -- BLANKS it (the FK is ON DELETE SET NULL) — after the cascade there is no
  -- longer any way to ask "who belonged to this tenant?".
  SELECT coalesce(array_agg(user_id), '{}')
    INTO v_members
    FROM profiles
   WHERE tenant_id = p_tenant_id AND layer IS DISTINCT FROM 'platform';

  -- ── step 6: the cascade ──────────────────────────────────────────────────
  DELETE FROM tenants WHERE id = p_tenant_id;

  -- ── step 6b: NOW the profiles ────────────────────────────────────────────
  -- SET NULL would otherwise blank tenant_id and leave full_name sitting in the
  -- table while a residue check keyed on tenant_id reported zero — the exact
  -- laundering described in (C) at the top of this file.
  -- `layer IS DISTINCT FROM 'platform'` was applied when the members were
  -- captured, so a platform operator can never be removed by a tenant deletion
  -- even if someone later attaches one to a tenant.
  BEGIN
    DELETE FROM profiles WHERE user_id = ANY(v_members);
    GET DIAGNOSTICS v_profiles = ROW_COUNT;
  EXCEPTION WHEN foreign_key_violation THEN
    -- Name the actual relation from sqlerrm rather than guessing: after the
    -- cascade, anything still referencing a member is PLATFORM-side, and the
    -- operator needs to know which one.
    RAISE EXCEPTION 'cannot delete tenant "%": a platform-side record still references one of its members after the cascade. Reassign or remove it first. [%]', v_t.slug, sqlerrm;
  END;

  -- ── step 7: sweep the two tables the cascade REFILLED ────────────────────
  -- Not a belt-and-braces duplicate of the cascade: these rows did not exist
  -- when step 6 began. log_remote_access_write() fires AFTER DELETE on 77
  -- tenant tables and, because the caller is platform staff with no tenant of
  -- their own, writes old_data = to_jsonb(OLD) for every row the cascade just
  -- removed. This is where the 153 orphan rows measured in production came
  -- from. Must run after step 6, and these two tables have no DELETE trigger
  -- of their own, so this does not recurse.
  DELETE FROM remote_access_write_log WHERE tenant_id = p_tenant_id;
  DELETE FROM tenant_activity_log     WHERE tenant_id = p_tenant_id;

  -- ── step 8: verify, or undo everything ───────────────────────────────────
  SELECT coalesce(jsonb_object_agg(table_name, remaining_rows)
                    FILTER (WHERE remaining_rows > 0 AND counts_as_residue), '{}'::jsonb),
         coalesce(sum(remaining_rows) FILTER (WHERE counts_as_residue), 0)::bigint
    INTO v_after, v_rows_after
    FROM tenant_rows_remaining(p_tenant_id);

  -- profiles cannot be checked by the tenant_id-keyed sweep above, because the
  -- cascade SET NULL blanks tenant_id — a surviving member reads as zero residue
  -- while still holding their full_name. That is exactly the laundering
  -- described in (C) at the top of this file, so it gets its own check keyed on
  -- the identities captured in step 5.
  IF EXISTS (SELECT 1 FROM profiles WHERE user_id = ANY(v_members)) THEN
    RAISE EXCEPTION 'deletion of "%" is INCOMPLETE — % of % member profile(s) survived. Nothing was deleted; the transaction has been rolled back.',
      v_t.slug,
      (SELECT count(*) FROM profiles WHERE user_id = ANY(v_members)),
      coalesce(array_length(v_members, 1), 0);
  END IF;

  IF v_rows_after > 0 THEN
    -- All-or-nothing on purpose. A partial deletion that returned ok:true is
    -- the exact failure this migration exists to remove, and rolling back
    -- leaves a suspended tenant that can be retried once the gap is fixed.
    RAISE EXCEPTION 'deletion of "%" is INCOMPLETE — % row(s) survived in %. Nothing was deleted; the transaction has been rolled back. Add coverage for those tables and retry.',
      v_t.slug, v_rows_after, v_after;
  END IF;

  -- ── step 9: the receipt (inserted after the sweep, so it is never counted)─
  INSERT INTO tenant_deletion_receipts (
    tenant_id, tenant_slug, tenant_name, deleted_by, deleted_by_name,
    tables_swept, rows_removed, per_table_removed, residual_after, verified, notes)
  VALUES (
    p_tenant_id, v_t.slug, v_t.name, auth.uid(), coalesce(v_actor, 'platform operator'),
    v_tables, v_rows_before, v_before, '{}'::jsonb, true,
    'Verified by tenant_rows_remaining() after deletion: 0 residual rows across '
      || v_tables || ' tenant-scoped tables. NOT covered by this receipt: auth.users '
      || 'login rows (auth schema, outside this database''s public FK graph), Supabase '
      || 'Storage objects, and any off-database backups, logs or third-party systems.')
  RETURNING id INTO v_receipt;

  RETURN jsonb_build_object(
    'ok', true,
    'deleted_tenant', p_tenant_id,
    'name', v_t.name,
    'slug', v_t.slug,
    'receipt_id', v_receipt,
    'tables_swept', v_tables,
    'rows_removed', v_rows_before,
    'profiles_removed', v_profiles,
    'residual_rows', 0,
    'not_covered', jsonb_build_array(
      'auth.users login rows (auth schema)',
      'Supabase Storage objects',
      'off-database backups, logs and third-party systems')
  );
END $function$;

-- Grants restated: CREATE OR REPLACE reset them to the PUBLIC default above.
REVOKE ALL ON ROUTINE public.delete_tenant(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON ROUTINE public.delete_tenant(uuid, text) TO authenticated;


-- ═══ 6. HISTORICAL RESIDUE — DELIBERATELY NOT TOUCHED HERE ════════════════
-- This migration is ADDITIVE ONLY. It contains no DELETE that runs at apply
-- time, by design.
--
-- An earlier draft swept the pre-existing orphans: 153 rows in
-- remote_access_write_log and 15 in tenant_activity_log (measured) that
-- reference tenants deleted in commit c21bae0 by a delete_tenant which did not
-- sweep them. Each holds an old_data/new_data jsonb snapshot of a customer row.
--
-- That cleanup is defensible — arguably it IS the erasure that should already
-- have happened. It was still removed from this file, for a reason worth
-- stating: a destructive action does not become authorised by being reasonable.
-- The purpose of this migration is to make FUTURE deletions complete. Disposing
-- of historical data is a separate decision, it is irreversible, and this
-- database has no automated backups (org is on the Supabase free plan, and
-- GET /database/backups returns an empty list).
--
-- The residue is therefore still present and still unreachable by any
-- tenant-scoped query. count_tenant_residue() below will report it for any
-- tenant id you pass. Clean it up with an explicit, separately-approved script
-- once point-in-time recovery is available.

-- ═══ 7. PROVE IT ═══════════════════════════════════════════════════════════
-- A real tenant cannot be deleted to test this, so these assert the MECHANICS:
-- the sweep finds every tenant-scoped table, the receipt survives, the rails
-- are all still in the body, and no tenant-scoped table is unaccounted for.
DO $assert$
DECLARE
  v_catalog_tables int;
  v_swept int;
  v_retained int;
  v_body text;
  v_missing text;
  v_orphans bigint;
  v_rail text;
  v_rails text[] := ARRAY[
    'not authenticated',
    'resolve_platform_capability\(auth\.uid\(\), ''tenants\.manage''\)',
    'the demo tenant cannot be deleted',
    'you cannot delete the tenant you belong to',
    'suspend the tenant before deleting it',
    'confirmation text must exactly match the tenant slug',
    'sub-tenant\(s\) — delete or reassign them first'
  ];
BEGIN
  -- ── 1. the receipt table exists, is append-only, and has NO FK to tenants ─
  IF to_regclass('public.tenant_deletion_receipts') IS NULL THEN
    RAISE EXCEPTION '371: tenant_deletion_receipts was not created';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint con
      JOIN pg_class ch ON ch.oid = con.conrelid
      JOIN pg_class rc ON rc.oid = con.confrelid
     WHERE ch.relname = 'tenant_deletion_receipts' AND rc.relname = 'tenants' AND con.contype = 'f')
  THEN
    RAISE EXCEPTION '371: the receipt table has a FK to tenants — it would cascade away with the tenant it is meant to prove was deleted';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = 'tenant_deletion_receipts' AND NOT t.tgisinternal
       AND t.tgname = 'tenant_deletion_receipts_no_update_delete')
  THEN
    RAISE EXCEPTION '371: receipts are not append-only';
  END IF;

  -- ── 2. the sweep is catalog-complete, not a list ─────────────────────────
  SELECT count(*) INTO v_catalog_tables
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id'
                       AND a.attnum > 0 AND NOT a.attisdropped
   WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relispartition
     AND a.atttypid = 'uuid'::regtype;

  -- The all-zero uuid belongs to no tenant, so this is a full 217-table sweep
  -- that reads every tenant-scoped table and can touch nothing. One call, not
  -- three: each call issues one count() per table.
  SELECT count(*),
         count(*) FILTER (WHERE NOT counts_as_residue),
         string_agg(table_name, ',') FILTER (WHERE NOT counts_as_residue)
    INTO v_swept, v_retained, v_missing
    FROM tenant_rows_remaining('00000000-0000-0000-0000-000000000000'::uuid);

  IF v_swept <> v_catalog_tables THEN
    RAISE EXCEPTION '371: the residue sweep visits % table(s) but the catalog has % with a uuid tenant_id', v_swept, v_catalog_tables;
  END IF;
  -- Exactly one table may be retained, and it must be the receipt. If a future
  -- change adds a second exclusion, this fails rather than letting data hide
  -- behind a "retained" flag.
  IF v_retained <> 1 OR coalesce(v_missing, '') <> 'tenant_deletion_receipts' THEN
    RAISE EXCEPTION '371: expected exactly one retained table (tenant_deletion_receipts), found % → [%]', v_retained, coalesce(v_missing, '(none)');
  END IF;
  v_missing := NULL;  -- reused below as the uncovered-table accumulator
  -- Views own no rows; counting them would double-count their base tables.
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname='public' AND c.relname IN ('eval_gate','pipeline_summary')
                AND c.relkind <> 'v')
  THEN
    RAISE EXCEPTION '371: eval_gate/pipeline_summary are no longer views — re-check whether they now hold rows';
  END IF;

  -- ── 3. every rail is still in the body ───────────────────────────────────
  SELECT regexp_replace(pg_get_functiondef(p.oid), '\s+', ' ', 'g') INTO v_body
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'delete_tenant' AND p.prokind = 'f';

  FOREACH v_rail IN ARRAY v_rails LOOP
    IF v_body !~ v_rail THEN
      RAISE EXCEPTION '371: delete_tenant lost a safety rail — % is no longer in the body', v_rail;
    END IF;
  END LOOP;

  -- and it must actually verify its own work
  IF v_body !~ 'tenant_rows_remaining' OR v_body !~ 'is INCOMPLETE' THEN
    RAISE EXCEPTION '371: delete_tenant does not verify its own deletion';
  END IF;
  IF v_body !~ 'tenant_deletion_receipts' THEN
    RAISE EXCEPTION '371: delete_tenant does not record a receipt';
  END IF;
  IF has_function_privilege('anon', 'public.delete_tenant(uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.tenant_rows_remaining(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.list_tenant_deletion_receipts(int)', 'EXECUTE')
  THEN
    RAISE EXCEPTION '371: one of the new/changed routines is anon-executable';
  END IF;

  -- ── 4. THE REAL CONTROL: zero tenant-scoped tables unaccounted for ───────
  -- A table is accounted for if a tenant deletion is guaranteed to clear it:
  -- either its tenant_id has a CASCADE FK to tenants, or delete_tenant names
  -- it in an explicit DELETE, or it is the retained receipt. Anything else is
  -- a hole of the same kind this migration closed, and fails here.
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO v_missing
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id'
                       AND a.attnum > 0 AND NOT a.attisdropped
   WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relispartition
     AND a.atttypid = 'uuid'::regtype
     AND c.relname <> 'tenant_deletion_receipts'
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint con
         JOIN pg_class rc ON rc.oid = con.confrelid
         JOIN pg_namespace rn ON rn.oid = rc.relnamespace
        WHERE con.contype = 'f' AND rn.nspname = 'public' AND rc.relname = 'tenants'
          AND con.conrelid = c.oid AND con.confdeltype = 'c'
          AND a.attnum = ANY(con.conkey))
     AND v_body !~* ('delete from ' || c.relname || '\M');

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '371: tenant-scoped table(s) with no CASCADE and no explicit DELETE: %', v_missing;
  END IF;

  -- ── 5. the historical residue is REPORTED, not required to be gone ───────
  -- An earlier draft swept it here and asserted zero. The sweep was removed
  -- (see §6): disposing of existing data is a separate, explicitly-approved
  -- decision, and this database has no automated backups. So this assertion is
  -- deliberately NOT a gate — it would fail this migration for a condition the
  -- migration no longer claims to fix, which is the wrong kind of red.
  --
  -- What IS asserted: from here on, delete_tenant sweeps these two tables
  -- itself (step 7), so the count can only go down. The remaining rows belong
  -- to tenants deleted BEFORE this migration.
  SELECT (SELECT count(*) FROM remote_access_write_log x
           WHERE NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = x.tenant_id))
       + (SELECT count(*) FROM tenant_activity_log x
           WHERE NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = x.tenant_id))
    INTO v_orphans;
  IF v_orphans > 0 THEN
    RAISE NOTICE '371: % pre-existing orphaned audit row(s) remain from tenants deleted before this migration. NOT swept here by design — clean up with an explicitly-approved script once PITR is available. Future deletions sweep themselves.', v_orphans;
  END IF;

  -- The real gate: delete_tenant must actually contain that self-sweep, or the
  -- count above starts growing again.
  SELECT regexp_replace(pg_get_functiondef(p.oid), '\s+', ' ', 'g') INTO v_body
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'delete_tenant';
  IF v_body !~* 'delete from remote_access_write_log'
     OR v_body !~* 'delete from tenant_activity_log' THEN
    RAISE EXCEPTION '371: delete_tenant does not sweep the audit-writeback tables — every future deletion would leave new orphans';
  END IF;

  -- ── 6. the adjudication guard still refuses ordinary deletes ─────────────
  -- It must have gained the purge branch AND kept the exception.
  SELECT regexp_replace(pg_get_functiondef(p.oid), '\s+', ' ', 'g') INTO v_body
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'guardrail_adjudications_immutable';
  IF v_body !~ 'app\.allow_tenant_purge' OR v_body !~ 'append-only' THEN
    RAISE EXCEPTION '371: the guardrail_adjudications guard is not purge-aware, or lost its append-only exception';
  END IF;

  RAISE NOTICE '371: % tenant-scoped tables swept, 1 retained (receipt), 0 unaccounted for; all 7 delete_tenant rails intact', v_catalog_tables;
END $assert$;

NOTIFY pgrst, 'reload schema';
