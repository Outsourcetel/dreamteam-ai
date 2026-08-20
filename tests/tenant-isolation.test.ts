// ============================================================
// The single highest-value automated test for a multi-tenant app:
// does Row Level Security actually stop tenant A from touching
// tenant B's data? This creates two REAL tenants through the exact
// public signup flow (not a service-role shortcut), then asserts
// cross-tenant reads/writes are invisible/rejected — using each
// tenant owner's own authenticated session, the same way a real
// attacker (or a real bug) would actually be constrained.
// ============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

  afterAll(async () => {
    // ⛔ THIS DELIBERATELY DOES NOT DELETE ANYTHING, AND THAT IS THE POINT.
    //
    // It used to DELETE each tenant's customer_accounts as that tenant's own
    // owner, retrying three times with backoff and failing the suite if it
    // could not. That cleanup CANNOT succeed and has not been able to since
    // the write-perimeter work (migs 714-720) revoked DELETE on
    // customer_accounts from `authenticated`. Measured on the dev project:
    //
    //   has_table_privilege('authenticated', 'customer_accounts', 'DELETE')  false
    //   has_table_privilege('authenticated', 'customer_accounts', 'SELECT')  true
    //
    // So every run spent ~9 seconds retrying an operation the database is
    // correct to refuse, then failed the suite on 42501 — with four passing
    // tests above it. A green security suite reported as red by its own
    // cleanup, for doing exactly what it was hardened to do.
    //
    // The refusal is not an obstacle to work around: it IS the property this
    // file exists to prove, so it is asserted as a test below rather than
    // discovered in a teardown.
    //
    // ⚠ WHAT HAPPENS TO THE ROWS. They stay. Two test tenants and a handful
    // of customer_accounts rows per run accumulate in the DEV project, which
    // the nightly rebuild reclaims. Restoring cleanup would mean either a
    // service-role client — which this suite refuses on purpose, since a
    // service-role bypass in an RLS test can hide the very failure it is
    // looking for — or re-granting DELETE to `authenticated`, which would
    // undo a deliberate security decision to tidy a test.
  }, 60000);

  // The write perimeter, asserted rather than assumed. This is the check the
  // old teardown was accidentally performing and then reporting as a crash.
  it('refuses a tenant owner DELETE on customer_accounts — the write perimeter holds', async () => {
    const { error } = await tenantA.client
      .from('customer_accounts')
      .delete()
      .eq('tenant_id', tenantA.tenantId);
    // 42501 = insufficient_privilege. Not RLS filtering the rows away — the
    // role has no DELETE on this table at all, which is the stronger boundary
    // and the one migs 714-720 put there.
    expect(error?.code).toBe('42501');
  });

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
});
