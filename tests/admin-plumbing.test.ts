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
    // The demo tenant is excluded for the same reason every comparable audit in
    // this repo excludes it (118 and 723 — audit_tenant_provisioning and
    // audit_tenant_feature_parity both carry this exact predicate): it is the
    // one tenant that provisioning REFUSES. Both provision_tenant_baseline_
    // internal and provision_onboarding_architect bail on this id on their
    // first line, so the connector cannot reach it through any sanctioned
    // path. It nonetheless holds an is_workforce_assistant DE, because that
    // one comes from auto_provision_new_tenant_trigger, which has no such
    // exemption — an assistant with no provisioning behind it.
    //
    // Measured 2026-08-13 before adding this: it was the ONLY row this query
    // returned, and the failure is permanent by construction, not a gap
    // anyone can close. Backfilling it a connector would not fix anything
    // either — it would move the red rather than clear it: the demo tenant's
    // assistant reaches 0 actions requiring role 'workforce_assistant' (all 12
    // real workspaces reach 4), so handing it a connector is exactly the
    // precondition that makes certify's `workspace-admin-has-an-owner` start
    // firing on it. It also has 0 profiles — there is nobody to administer it.
    //
    // What is left still bites: 12 workspaces are compared, and breaking the
    // connector predicate surfaces all 12.
    const rows = await runQuery<{ slug: string }>(`
      select t.slug from tenants t
       where t.status='active'
         and t.id <> 'a0000000-0000-0000-0000-000000000001'
         and exists (select 1 from digital_employees d
                      where d.tenant_id=t.id and coalesce(d.is_workforce_assistant,false))
         and not exists (select 1 from connectors c
                          where c.tenant_id=t.id and c.category='platform_admin' and c.status='connected')`);
    expect(rows.map((r) => r.slug), 'workspaces with an assistant but no admin connector').toEqual([]);
  });

  it('the exclusion above is scoped to the demo tenant, not hiding real workspaces', async () => {
    // An exclusion is a place a real defect can hide. This pins the blast
    // radius: exactly one active tenant is excluded, it is the one both
    // provisioning functions refuse, and the surviving population is not
    // empty — a check with nothing left to compare is theatre.
    const [{ excluded, compared }] = await runQuery<{ excluded: number; compared: number }>(`
      select
        (select count(*) from tenants t
          where t.status='active' and t.id = 'a0000000-0000-0000-0000-000000000001')::int as excluded,
        (select count(*) from tenants t
          where t.status='active' and t.id <> 'a0000000-0000-0000-0000-000000000001'
            and exists (select 1 from digital_employees d
                         where d.tenant_id=t.id and coalesce(d.is_workforce_assistant,false)))::int as compared`);
    expect(excluded, 'the demo tenant is the only thing the exclusion removes').toBe(1);
    expect(compared, 'workspaces actually compared by the check above').toBeGreaterThan(1);
  });
});
