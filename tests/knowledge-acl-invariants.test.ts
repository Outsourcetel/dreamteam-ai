// ============================================================
// Knowledge ACL invariants — regression protection for the security layer
// built in migrations 341-360.
//
// WHY THIS EXISTS, specifically:
// every one of these assertions corresponds to a defect that was actually
// shipped and then found, most of them in the same session that built the
// feature. In-migration DO $assert$ blocks caught them at apply time, but they
// run ONCE. Nothing stopped migration 361 from quietly undoing any of it.
//
// The recurring shape, which appeared FOUR separate times:
//     an RPC gate is worthless if the underlying table is client-writable.
// So these tests check pg_policy AND has_table_privilege, not one or the other.
//
// These are INVARIANT tests (does the security layer have the right shape?),
// complementary to tenant-isolation.test.ts, which is a BEHAVIOURAL test
// (does a real signed-in user get the right rows?). Both are needed; neither
// substitutes for the other.
//
// Read-only against the live catalog — see helpers/adminQuery.ts.
// ============================================================
import { describe, it, expect } from 'vitest';
import { runQuery, scalar, adminTokenAvailable } from './helpers/adminQuery';

if (!adminTokenAvailable()) {
  throw new Error(
    'knowledge-acl-invariants needs SUPABASE_ACCESS_TOKEN in .env.local (the same token scripts/db-query.mjs uses). ' +
    'Failing loudly rather than skipping: a security suite that silently does not run is worse than no suite.',
  );
}

const q = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('knowledge ACL invariants', () => {
  // ── The FOR ALL trap (migs 344, 357) ────────────────────────────────────
  // Postgres ORs permissive policies, so ONE surviving FOR ALL policy silently
  // defeats every command-scoped policy beside it.
  it('knowledge_docs has no FOR ALL policy', async () => {
    const n = await scalar<number>(q(`
      select count(*)::int from pg_policies
       where tablename = 'knowledge_docs' and cmd = 'ALL'`));
    expect(n, 'a FOR ALL policy would OR-defeat all four ACL policies').toBe(0);
  });

  it('knowledge_docs has exactly the four command-scoped ACL policies', async () => {
    const rows = await runQuery<{ cmd: string }>(q(`
      select cmd from pg_policies where tablename = 'knowledge_docs' order by cmd`));
    expect(rows.map(r => r.cmd).sort()).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  });

  it('knowledge_collections has no FOR ALL policy', async () => {
    // Mig 284 shipped one; it survived 341/343/344/356 and let any member
    // PATCH is_restricted=false to unlock a restricted Space. Closed in 357.
    const n = await scalar<number>(q(`
      select count(*)::int from pg_policies
       where tablename = 'knowledge_collections' and cmd = 'ALL'`));
    expect(n, 'any member could unlock a restricted Space directly').toBe(0);
  });

  // ── Grant/revoke escalation guards (mig 356) ────────────────────────────
  it('granting cannot exceed the caller’s own level', async () => {
    const def = await scalar<string>(q(`
      select pg_get_functiondef(p.oid) from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname='public' and p.proname='grant_knowledge_access' limit 1`));
    expect(def, 'without this a manager grants full access and is granted it back')
      .toMatch(/v_want > v_my/);
    expect(def, 'principals must be verified in the caller’s workspace')
      .toMatch(/not a member of this workspace/);
  });

  it('revoking cannot exceed the caller’s level, and cannot empty a workspace of admins', async () => {
    const def = await scalar<string>(q(`
      select pg_get_functiondef(p.oid) from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname='public' and p.proname='revoke_knowledge_access' limit 1`));
    expect(def).toMatch(/above your level/);
    expect(def, 'the last full-access grant must not be removable').toMatch(/last full-access grant/);
  });

  // ── Group membership is a grant (mig 358) ──────────────────────────────
  it('group membership changes are ceilinged by what the group holds', async () => {
    const rows = await runQuery<{ proname: string; def: string }>(q(`
      select p.proname, pg_get_functiondef(p.oid) as def from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname='public' and p.proname in ('add_group_member','remove_group_member')`));
    expect(rows.length).toBe(2);
    for (const r of rows) {
      // Without this, a manager adds themselves to a group holding full access
      // and has it a second later — laundering around the grant guard.
      expect(r.def, `${r.proname} has no group-level ceiling`).toMatch(/knowledge_group_max_level/);
    }
  });

  // ── The one-way door (mig 359) ─────────────────────────────────────────
  // The distinction that stops "Restricted" bricking a space forever.
  it('administration ignores is_restricted; content access honours it', async () => {
    const admin = await scalar<string>(q(`
      select pg_get_functiondef(p.oid) from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname='public' and p.proname='knowledge_my_admin_level' limit 1`));
    expect(admin, 'deriving admin level from the content resolver makes restricting irreversible')
      .not.toMatch(/knowledge_space_level_for/);
    expect(admin).toMatch(/resource_type = 'workspace'/);

    const content = await scalar<string>(q(`
      select pg_get_functiondef(p.oid) from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname='public' and p.proname='knowledge_space_level_for' limit 1`));
    expect(content, 'content access must still be shut off by restriction')
      .toMatch(/v_restricted/);
  });

  it('the filing RPCs are permission-guarded', async () => {
    // Un-filing a doc rebuilds the closure, nulls restricted_space_id, and
    // releases it from its locked room. Both were unguarded until 359.
    const rows = await runQuery<{ proname: string; def: string }>(q(`
      select p.proname, pg_get_functiondef(p.oid) as def from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname='public' and p.proname in ('assign_doc_collection','unassign_doc_collection')`));
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.def, `${r.proname} is unguarded`).toMatch(/insufficient_permission/);
      expect(r.def, `${r.proname} does not check edit access`).toMatch(/knowledge_effective_level/);
    }
  });

  // ── Enumeration + write-lockdown on the closure (mig 360) ──────────────
  it('closure tables are read-only and scoped by the hidden-space predicate', async () => {
    const rows = await runQuery<{ tablename: string; cmd: string; qual: string | null }>(q(`
      select tablename, cmd, qual from pg_policies
       where tablename in ('knowledge_doc_access_paths','knowledge_doc_collections')`));
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.cmd, `${r.tablename} gained a write policy`).toBe('SELECT');
      expect(r.qual ?? '', `${r.tablename} is enumerable`)
        .toMatch(/knowledge_collection_is_hidden_from_caller/);
    }
  });

  // ── Retrieval carries every layer (migs 345, 346, 357) ─────────────────
  it('retrieval enforces permissions, lifecycle and restricted spaces, and reports withholding', async () => {
    const def = await scalar<string>(q(`
      select pg_get_functiondef(p.oid) from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname='public' and p.proname='hybrid_match_knowledge' limit 1`));
    expect(def, 'the human ACL is not applied to ranking').toMatch(/permitted_docs/);
    expect(def, 'a narrowed corpus is invisible to the model without this').toMatch(/withheld_count/);
    expect(def, 'drafts would reach answers').toMatch(/lifecycle_status = 'published'/);
    expect(def, 'restricted material would answer an unidentified asker')
      .toMatch(/v_actor is not null or vd\.restricted_space_id is null/);
    // Acting-user spoofing: a logged-in caller may only ever act as themselves.
    expect(def).toMatch(/case when auth\.uid\(\) is not null then auth\.uid\(\)/);
  });

  it('the retrieval ACL flag is enabled by default', async () => {
    // The "Restricted" preset promises employees will not answer from a locked
    // space. With this flag off that promise is false.
    const on = await scalar<boolean>(q(`
      select default_enabled from feature_registry where key = 'knowledge_acl_retrieval'`));
    expect(on, 'the permissions UI makes a security claim this flag backs').toBe(true);
  });

  // ── Lifecycle transitions (mig 349) ────────────────────────────────────
  it('lifecycle transitions are gated at the table, before the auto-archive trigger', async () => {
    const rows = await runQuery<{ tgname: string }>(q(`
      select tgname from pg_trigger
       where tgrelid = 'public.knowledge_docs'::regclass
         and tgname in ('knowledge_lifecycle_authz_trg','knowledge_lifecycle_sync_trg')
       order by tgname`));
    expect(rows.map(r => r.tgname)).toEqual([
      'knowledge_lifecycle_authz_trg', 'knowledge_lifecycle_sync_trg',
    ]);
    // Same-timing triggers fire in NAME order; authz must sort first so a
    // system archive-on-supersede is not authorised as if a human did it.
    expect(rows[0].tgname < rows[1].tgname).toBe(true);
  });

  // ── One content-hash algorithm (migs 352, 353) ─────────────────────────
  it('the SQL hash twin still agrees with what ingest-chunks writes', async () => {
    const mismatches = await scalar<number>(q(`
      select count(*)::int from knowledge_docs d
       where d.content is not null
         and d.content_hash is distinct from public.knowledge_content_hash(d.title, d.content)`));
    expect(mismatches, 'TypeScript and SQL have drifted — dedupe silently stops working').toBe(0);
  });

  // ── Nothing knowledge-related is reachable anonymously ─────────────────
  it('no knowledge RPC is executable by anon', async () => {
    const rows = await runQuery<{ proname: string }>(q(`
      select p.proname from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prokind = 'f'
         and (p.proname like '%knowledge%' or p.proname like '%ingestion%'
              or p.proname like '%principal_group%' or p.proname like '%platform_shelf%')
         and has_function_privilege('anon', p.oid, 'EXECUTE')`));
    expect(rows.map(r => r.proname), 'anon has a NULL auth.uid(), same as service-role').toEqual([]);
  });

  it('the platform shelf write path is not reachable by tenant users', async () => {
    // Mig 338 revoked from "public, anon" where 334 used "public, anon,
    // authenticated" — one word, and any logged-in user could rewrite the
    // product guide every workspace is answered from.
    const rows = await runQuery<{ proname: string }>(q(`
      select p.proname from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('publish_platform_shelf_doc','dismiss_platform_kb_change',
                           'list_platform_kb_review_queue','get_platform_kb_health')
         and has_function_privilege('authenticated', p.oid, 'EXECUTE')`));
    expect(rows.map(r => r.proname)).toEqual([]);
  });

  // ── Tenant isolation on every new table ────────────────────────────────
  it('every knowledge ACL table has RLS enabled', async () => {
    const rows = await runQuery<{ relname: string }>(q(`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
         and c.relname in ('knowledge_access_grants','knowledge_principal_groups',
                           'knowledge_principal_group_members','knowledge_doc_access_paths',
                           'knowledge_ingestion_jobs','knowledge_ingestion_items')
         and not c.relrowsecurity`));
    expect(rows.map(r => r.relname), 'a table without RLS is readable across tenants').toEqual([]);
  });

  it('grant and group tables have no client write policy', async () => {
    // Writes go through RPCs precisely so the escalation guards cannot be
    // stepped around with a direct PostgREST insert.
    const rows = await runQuery<{ tablename: string; cmd: string }>(q(`
      select tablename, cmd from pg_policies
       where tablename in ('knowledge_access_grants','knowledge_principal_groups',
                           'knowledge_principal_group_members')
         and cmd <> 'SELECT'`));
    expect(rows, 'granting yourself access must not be one PostgREST call away').toEqual([]);
  });
});
