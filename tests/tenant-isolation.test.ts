// ============================================================
// The single highest-value automated test for a multi-tenant app:
// does Row Level Security actually stop tenant A from touching
// tenant B's data? This creates two REAL tenants through the exact
// public signup flow (not a service-role shortcut), then asserts
// cross-tenant reads/writes are invisible/rejected — using each
// tenant owner's own authenticated session, the same way a real
// attacker (or a real bug) would actually be constrained.
// ============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestTenant, TestTenant } from './helpers/testTenant';

describe('tenant isolation (RLS)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let accountAId: string;

  beforeAll(async () => {
    tenantA = await createTestTenant('Test Suite Tenant A');
    tenantB = await createTestTenant('Test Suite Tenant B');

    const { data, error } = await tenantA.client
      .from('customer_accounts')
      .insert({ tenant_id: tenantA.tenantId, name: 'Isolation Test Account' })
      .select('id')
      .single();
    if (error) throw new Error(`seed insert failed: ${error.message}`);
    accountAId = data.id;
  }, 30000);

  // ── THERE IS DELIBERATELY NO afterAll CLEANUP. ──────────────────────────
  // This suite used to delete both tenants' rows as each tenant's own owner.
  // That teardown started failing with 42501 — and it is the perimeter
  // working, not a bug or the 2026-08-10 flake it was previously hardened
  // against. Migration 717 (docs/52 Tier C, slice 1) revoked DELETE on
  // customer_accounts from `authenticated`, classified "live grant with no
  // src/ caller". That classification was right about src/ and blind to
  // tests/: the census read all 217 files under src/, the 6 asUser edge
  // clients and the 3 SECURITY INVOKER trigger functions, and no test file.
  // This teardown was the surprise caller 717's own header said could exist
  // ("absence of a caller is evidence, not proof"), surfacing exactly where
  // the founder's riskiest-last slice ordering was designed to surface it —
  // on content rows, where being wrong costs a failed content write.
  //
  // THE GRANT IS NOT COMING BACK, because a test's housekeeping is not a
  // product surface. customer_accounts_tenant_write is PERMISSIVE FOR ALL, so
  // the missing grant is the only thing stopping every non-read_only member of
  // every tenant from deleting customer accounts in PRODUCTION; restoring it
  // would also put certify's write perimeter red until someone re-pinned
  // supabase/baseline/write-allowlist.json — the single move that file forbids
  // by name ("never to make a red run green").
  //
  // So the seed row stays, and nothing here pretends otherwise. This suite has
  // no DELETE on any table and there is no SECURITY DEFINER purge RPC to call,
  // so there is nothing honest left to clean: it already abandons a tenant, a
  // profile and an auth user on every run (281 'Test Suite Tenant%' rows in the
  // dev project when this was written, against 6 leftover account rows). The
  // row is uniquely named and tenant-scoped and cannot affect a later run.
  //
  // The lost privilege is asserted below instead of being swallowed here. A
  // teardown that quietly tolerated 42501 would just as quietly tolerate the
  // grant coming back.

  it('lets a tenant owner see their own account', async () => {
    const { data, error } = await tenantA.client
      .from('customer_accounts')
      .select('id, name')
      .eq('id', accountAId)
      .maybeSingle();
    expect(error).toBeNull();
    expect(data?.name).toBe('Isolation Test Account');
  });

  it('never returns another tenant\'s account by id, even when directly queried', async () => {
    const { data, error } = await tenantB.client
      .from('customer_accounts')
      .select('id, name')
      .eq('id', accountAId)
      .maybeSingle();
    expect(error).toBeNull();
    expect(data).toBeNull();
  });

  it('never includes another tenant\'s rows in an unfiltered select', async () => {
    const { data, error } = await tenantB.client
      .from('customer_accounts')
      .select('id');
    expect(error).toBeNull();
    expect((data ?? []).some(r => r.id === accountAId)).toBe(false);
  });

  it('silently affects zero rows when attempting to update another tenant\'s account', async () => {
    const { data, error } = await tenantB.client
      .from('customer_accounts')
      .update({ name: 'Hijacked' })
      .eq('id', accountAId)
      .select('id');
    expect(error).toBeNull();
    expect(data).toEqual([]);

    // Confirm from tenant A's own session that the row is genuinely unchanged.
    const { data: stillA } = await tenantA.client
      .from('customer_accounts')
      .select('name')
      .eq('id', accountAId)
      .single();
    expect(stillA?.name).toBe('Isolation Test Account');
  });

  it('refuses a tenant owner\'s DELETE at the table grant, before RLS is consulted', async () => {
    // This is the fact that replaced the old teardown, pinned so it cannot
    // regress unnoticed. Note the shape of the refusal: 42501 is Postgres
    // rejecting the COMMAND because `authenticated` holds no DELETE on the
    // table. It is NOT the far quieter failure this repo has been bitten by
    // repeatedly — an RLS-denied write, which PostgREST reports as SUCCESS
    // with zero rows. Asserting the code rather than merely "it didn't
    // delete" is what distinguishes the two.
    const { error } = await tenantA.client
      .from('customer_accounts')
      .delete()
      .eq('tenant_id', tenantA.tenantId);
    expect(error?.code).toBe('42501');

    // Verified outside the error object: the row is still readable. A refusal
    // that reported 42501 while the delete landed anyway would satisfy the
    // assertion above and be a much worse defect.
    const { data: survived } = await tenantA.client
      .from('customer_accounts')
      .select('id')
      .eq('id', accountAId)
      .maybeSingle();
    expect(survived?.id).toBe(accountAId);
  });
});
