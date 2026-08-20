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
    //
    // Hardened after the 2026-08-10 flake (failed twice inside certify, green
    // standalone and in a 7× golden-path-adjacency reproduction loop — the
    // trigger was environmental, most plausibly a parallel session loading the
    // same dev project). Three rules, none of which weaken anything:
    //   1. Each tenant's cleanup is attempted INDEPENDENTLY — one tenant's
    //      transport hiccup must not abandon the other's rows.
    //   2. Transient failures retry with backoff before they count.
    //   3. A genuine final failure still FAILS the suite — but with the full
    //      underlying error, so the next investigation starts with evidence
    //      instead of a truncated frame.
    // ⚠ 42501 IS NOT A FAILURE OF THIS SUITE, AND IT IS NOT TRANSIENT.
    // The write-perimeter migrations (714-720) revoked DELETE on
    // customer_accounts from `authenticated`, deliberately and correctly. This
    // cleanup was written when it still had that grant, so it now retries a
    // permission denial three times with backoff — which can never succeed —
    // and then fails a file whose four isolation assertions all PASSED.
    //
    // A suite that reports "tenant isolation is broken" when tenant isolation
    // is fine is worse than one that leaves rows behind, so a permission
    // denial is reported and does not fail the run. EVERY OTHER error still
    // retries and still fails: "the perimeter denied us, as designed" and
    // "cleanup genuinely broke" must not look the same.
    //
    // The rows are not abandoned to grow for ever — the nightly dev-rebuild
    // workflow restores dev from the baseline, which drops them. The real fix
    // is a service-role client or a cleanup RPC scoped to test tenants, and
    // .env.test carries only a URL and an anon key, so that needs a credential
    // decision rather than a code change. Register A-13.
    const DENIED = '42501';
    const denials: string[] = [];
    const deleteWithRetry = async (t: TestTenant, label: string) => {
      let lastErr: unknown = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const { error } = await t.client
            .from('customer_accounts')
            .delete()
            .eq('tenant_id', t.tenantId);
          if (!error) return null;
          if ((error as { code?: string }).code === DENIED) {
            denials.push(`${label} (tenant ${t.tenantId}): ${error.message}`);
            return null;               // by design, not a defect — see above
          }
          lastErr = error;             // PostgREST-level error object
        } catch (e) {
          lastErr = e;                 // transport-level rejection (fetch failed)
        }
        if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1500));
      }
      return `${label} (tenant ${t.tenantId}): ${JSON.stringify(lastErr, Object.getOwnPropertyNames(lastErr ?? {}))}`;
    };

    const failures = (
      await Promise.all([
        deleteWithRetry(tenantA, 'tenant A cleanup'),
        deleteWithRetry(tenantB, 'tenant B cleanup'),
      ])
    ).filter((f): f is string => f !== null);
    if (denials.length > 0) {
      // Loud, every run. Silence here would let the leftover rows — and the
      // register item behind them — quietly become normal.
      console.warn(
        `\n⚠ teardown could not delete ${denials.length} test tenant's rows: the write perimeter denies`
        + ` DELETE on customer_accounts to the authenticated role, which is correct (migs 714-720).`
        + ` The rows stay until the nightly dev rebuild drops them. Register A-13.\n`
        + denials.map((d) => `   ${d}`).join('\n') + '\n',
      );
    }
    if (failures.length > 0) {
      throw new Error(`teardown failed after 3 attempts each:\n${failures.join('\n')}`);
    }
  }, 60000);

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
