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
    // Clean up as each tenant's own owner — RLS-scoped deletes, not a
    // service-role bypass, so this only ever touches this test's own
    // rows even if something above failed partway through.
    await tenantA.client.from('customer_accounts').delete().eq('tenant_id', tenantA.tenantId);
    await tenantB.client.from('customer_accounts').delete().eq('tenant_id', tenantB.tenantId);
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
