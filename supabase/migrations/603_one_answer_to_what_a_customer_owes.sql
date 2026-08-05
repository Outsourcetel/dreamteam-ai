-- 603 — one answer to "what does this customer owe?".
--
-- The audit flagged "two parallel AR stacks". Measured properly, the split is
-- narrower and more lopsided than that phrase suggests, and saying so is part
-- of the work — a consolidation aimed at the wrong seam moves data for nothing.
--
--   NATIVE (demo residue)              LIVE (the spine)
--   customers            4 rows        customer_accounts    5 rows, 3 tenants
--                        acme only                          4 writers incl. the
--                        ZERO writers                       ERP sync
--   invoices             5 rows        renewal_invoices    10 rows, 3 tenants
--                        acme only                          4 writers
--                        1 writer
--
-- `payments` (9 rows) is NOT part of this. Six of its rows are `outbound` and
-- carry a `bill_id`, and a `bills` table exists with 6 rows — it is a general
-- money-movement ledger spanning payables and receivables, not a duplicate of
-- `invoice_payments`. Consolidating it would have deleted accounts-payable
-- coverage to tidy accounts receivable. Left alone deliberately.
--
-- ── What was NOT broken, checked before "fixing" it ───────────────────────
-- `get_de_worklists` labels its overdue book `source_table := 'invoices'`, and
-- counting rows in `invoices` alone shows ZERO overdue for every tenant while
-- `renewal_invoices` holds three. That reads like an employee blind to every
-- overdue invoice it has. It is not: the block is a UNION and already reads
-- both, fixed in mig 517, whose comment says so in as many words. Counting one
-- branch of a union and concluding about the function is the same mistake as
-- testing one execution path and declaring an action dead — made twice in one
-- audit. Only the misleading LABEL is corrected here.
--
-- ── What genuinely still points at the dead table ────────────────────────
-- The invoice write-back desk, and only the write-back desk:
--
--   propose_invoice_writeback           reads invoices.invoice_number
--   apply_invoice_writeback_internal    reads and UPDATES invoices.status
--   invoice_activities                  FK → invoices        (0 rows)
--   invoice_writeback_requests          FK → invoices        (0 rows)
--
-- So a digital employee proposing "mark this invoice paid" could only ever act
-- on five demo rows in one workspace, while every invoice the platform actually
-- syncs lives somewhere else. Both tables are empty and no request has ever
-- been raised, so repointing costs nothing and no data moves.
--
-- ── What is NOT migrated, on purpose ─────────────────────────────────────
-- The five `invoices` rows stay where they are. They hang off `customers`,
-- whose four rows resolve to NO `customer_accounts` row at all — so moving them
-- would mean inventing which account each demo invoice belongs to. A
-- consolidation that fabricates relationships to look complete is worse than
-- one that leaves clearly-labelled residue behind. Both tables are marked
-- deprecated instead, with their data intact.

begin;

-- ── 1. The write-back desk moves to the live spine ───────────────────────
-- Spliced from the deployed definition rather than retyped: rewriting a
-- function from memory is how mig 377 silently dropped keyset pagination.

do $splice$
declare
  v_src text;
  v_new text;
  v_hits int;
begin
  -- propose_invoice_writeback: resolve the invoice reference.
  select pg_get_functiondef(oid) into v_src from pg_proc where proname = 'propose_invoice_writeback';
  v_hits := (length(v_src) - length(replace(v_src,
    'SELECT invoice_number INTO v_inv FROM invoices WHERE id = p_invoice_id AND tenant_id = v_tenant;', '')))
    / length('SELECT invoice_number INTO v_inv FROM invoices WHERE id = p_invoice_id AND tenant_id = v_tenant;');
  if v_hits <> 1 then
    raise exception 'propose_invoice_writeback: expected 1 anchor, found % — the body changed, stop', v_hits;
  end if;
  v_new := replace(v_src,
    'SELECT invoice_number INTO v_inv FROM invoices WHERE id = p_invoice_id AND tenant_id = v_tenant;',
    'SELECT coalesce(source_external_ref, id::text) INTO v_inv FROM renewal_invoices WHERE id = p_invoice_id AND tenant_id = v_tenant;');
  execute v_new;

  -- apply_invoice_writeback_internal: read the prior status, then write it.
  select pg_get_functiondef(oid) into v_src from pg_proc where proname = 'apply_invoice_writeback_internal';
  if position('SELECT status INTO v_before FROM invoices WHERE id = r.invoice_id AND tenant_id = r.tenant_id;' in v_src) = 0
     or position('UPDATE invoices SET status = r.composed->>''to_status'' WHERE id = r.invoice_id AND tenant_id = r.tenant_id;' in v_src) = 0 then
    raise exception 'apply_invoice_writeback_internal: anchors not found — the body changed, stop';
  end if;
  v_new := replace(v_src,
    'SELECT status INTO v_before FROM invoices WHERE id = r.invoice_id AND tenant_id = r.tenant_id;',
    'SELECT status INTO v_before FROM renewal_invoices WHERE id = r.invoice_id AND tenant_id = r.tenant_id;');
  v_new := replace(v_new,
    'UPDATE invoices SET status = r.composed->>''to_status'' WHERE id = r.invoice_id AND tenant_id = r.tenant_id;',
    'UPDATE renewal_invoices SET status = r.composed->>''to_status'', updated_at = now() WHERE id = r.invoice_id AND tenant_id = r.tenant_id;');
  execute v_new;
end;
$splice$;

-- Count AFTER, on the live bodies. An assertion that only runs before the edit
-- cannot tell a successful splice from a silent no-op.
do $verify_splice$
declare v_p text; v_a text;
begin
  select prosrc into v_p from pg_proc where proname = 'propose_invoice_writeback';
  select prosrc into v_a from pg_proc where proname = 'apply_invoice_writeback_internal';

  if v_p ~ 'FROM invoices\M' then
    raise exception 'propose_invoice_writeback still reads the deprecated invoices table';
  end if;
  if v_a ~ '(FROM|UPDATE) invoices\M' then
    raise exception 'apply_invoice_writeback_internal still touches the deprecated invoices table';
  end if;
  if v_p !~ 'renewal_invoices' or v_a !~ 'renewal_invoices' then
    raise exception 'the splice did not land — neither body references renewal_invoices';
  end if;
end;
$verify_splice$;

-- ── 2. The desk's own tables follow it ───────────────────────────────────
-- Both are empty, so this is a pointer change and not a data migration. Left
-- pointing at `invoices`, the first real write-back would have been REFUSED by
-- the foreign key — an approval a human granted, failing after the fact, which
-- is the failure shape mig 590 already had to fix once.

do $fks$
declare v_acts int; v_reqs int;
begin
  select count(*) into v_acts from invoice_activities;
  select count(*) into v_reqs from invoice_writeback_requests;
  if v_acts > 0 or v_reqs > 0 then
    raise exception 'write-back tables are not empty (% activities, % requests) — repointing the FK would orphan them', v_acts, v_reqs;
  end if;
end;
$fks$;

alter table invoice_activities drop constraint if exists invoice_activities_invoice_id_fkey;
alter table invoice_activities add constraint invoice_activities_invoice_id_fkey
  foreign key (invoice_id) references renewal_invoices(id) on delete cascade;

alter table invoice_writeback_requests drop constraint if exists invoice_writeback_requests_invoice_id_fkey;
alter table invoice_writeback_requests add constraint invoice_writeback_requests_invoice_id_fkey
  foreign key (invoice_id) references renewal_invoices(id) on delete cascade;

-- ── 3. A label that made a correct function look broken ─────────────────

do $label$
declare v_src text; v_new text;
begin
  select pg_get_functiondef(oid) into v_src from pg_proc where proname = 'get_de_worklists';
  if position('source_table := ''invoices'';' in v_src) = 0 then
    raise notice 'worklist label already corrected — skipping';
    return;
  end if;
  v_new := replace(v_src, 'source_table := ''invoices'';',
                          'source_table := ''renewal_invoices + invoices'';');
  execute v_new;
end;
$label$;

-- ── 4. Say which stack is the answer ─────────────────────────────────────

comment on table invoices is
  'DEPRECATED (mig 603). The live customer-invoice table is renewal_invoices — it is what the ERP sync writes, what the dunning ladder reads, and what the write-back desk now updates. These 5 rows are demo residue in one workspace and are kept only so nothing is destroyed. Do not read this table in new code.';

comment on table customers is
  'DEPRECATED (mig 603). Superseded by customer_accounts, which is what upsert_external_ar_record and the account write-back desk write. These 4 rows are demo residue in one workspace, have NO live writer, and resolve to no customer_accounts row — which is why they were not migrated rather than mapped by guesswork.';

comment on table payments is
  'NOT part of the AR consolidation (mig 603). This is a general money-movement ledger: 6 of 9 rows are direction=outbound against bills, not invoices. It is not a duplicate of invoice_payments, which records receipts applied to renewal_invoices.';

commit;
