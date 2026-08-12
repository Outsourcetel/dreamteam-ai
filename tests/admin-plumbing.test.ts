// ============================================================
// ADMIN PLUMBING IS NOT AN EMPLOYEE'S JOB
//
// The platform_admin self-connector is what makes a workspace administrable.
// Until now it was created as a side effect of provisioning the Onboarding
// Architect — so retiring that employee would have silently removed a
// workspace's ability to administer itself, AND made the certify check that
// watches for exactly that condition start passing vacuously.
//
// Read-only: runQuery() refuses anything that is not a lone SELECT/WITH.
// ============================================================
import { describe, it, expect } from 'vitest';
import { runQuery, adminTokenAvailable } from './helpers/adminQuery';

const run = adminTokenAvailable() ? describe : describe.skip;

run('the platform_admin connector is baseline plumbing', () => {
  it('is created by the baseline, not by the architect', async () => {
    const [{ baseline_has, architect_has }] = await runQuery<{ baseline_has: boolean; architect_has: boolean }>(`
      select
        (select pg_get_functiondef(p.oid) ilike '%provision_platform_admin_connector_internal%'
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname='public' and p.proname='provision_tenant_baseline_internal') as baseline_has,
        (select pg_get_functiondef(p.oid) ilike '%insert into connectors%'
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname='public' and p.proname='provision_onboarding_architect') as architect_has`);
    expect(baseline_has, 'baseline provisioning must create the platform_admin connector').toBe(true);
    expect(architect_has, 'the architect must no longer insert connectors directly').toBe(false);
  });

  it('the helper is idempotent by construction', async () => {
    // It must find-then-insert, never insert blindly: provisioning re-runs.
    const [{ def }] = await runQuery<{ def: string }>(`
      select pg_get_functiondef(p.oid) as def from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname='public' and p.proname='provision_platform_admin_connector_internal'`);
    expect(def).toMatch(/select\s+id\s+into/i);
  });

  it('every active workspace that has an assistant also has the connector', async () => {
    const rows = await runQuery<{ slug: string }>(`
      select t.slug from tenants t
       where t.status='active'
         -- Provisioning deliberately skips the demo tenant — both
         -- provision_onboarding_architect (v_demo) and
         -- provision_tenant_baseline_internal (v_demo_tenant_id) refuse to
         -- provision it by id. It genuinely has an assistant and genuinely
         -- lacks the connector, but the system never promised it one, so
         -- asserting coverage here would assert a promise nobody made. Same
         -- exclusion audit_tenant_feature_parity and audit_tenant_provisioning
         -- use (migration 723) — match the house convention, not a new one.
         and t.id <> 'a0000000-0000-0000-0000-000000000001'
         and exists (select 1 from digital_employees d
                      where d.tenant_id=t.id and coalesce(d.is_workforce_assistant,false))
         and not exists (select 1 from connectors c
                          where c.tenant_id=t.id and c.category='platform_admin' and c.status='connected')`);
    expect(rows.map((r) => r.slug), 'workspaces with an assistant but no admin connector').toEqual([]);
  });
});

run('the admin gate cannot be silenced by removing the connector', () => {
  it('examines a workspace with an assistant regardless of its connectors', async () => {
    // The old probe required a connected platform_admin connector before it
    // would look at a tenant at all — so deleting that connector made the
    // check go quiet on exactly the workspace it was meant to protect.
    // Assert on the shipped probe text: the connector must not appear as a
    // precondition alongside the tenant-status filter.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('scripts/certify.mjs', 'utf8');
    const start = src.indexOf("name: 'workspace-admin-has-an-owner'");
    expect(start, 'probe not found').toBeGreaterThan(-1);
    const probe = src.slice(start, start + 1600);
    expect(probe).toContain('is_workforce_assistant');
    expect(probe).not.toMatch(/exists\s*\(\s*select 1 from connectors/);
  });
});
