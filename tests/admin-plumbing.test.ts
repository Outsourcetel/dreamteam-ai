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

  it('every tenant-creation path reaches the connector, not just the two that call baseline', async () => {
    // mig 730 moved the connector from provision_onboarding_architect — which
    // runs from an AFTER INSERT ON tenants trigger and therefore covers EVERY
    // tenant — into provision_tenant_baseline_internal, which only
    // complete_signup and approve_subtenant_request call. request_subtenant's
    // self-serve branch (the platform console's "Provision Tenant") inserts
    // the tenants row itself, so mig 732 gave it the helper directly.
    //
    // Enumerated from the catalog rather than listed by hand: a FOURTH
    // creation path added later is caught by the same assertion.
    const rows = await runQuery<{ proname: string; reaches: boolean }>(`
      select p.proname,
             pg_get_functiondef(p.oid) ~* 'provision_platform_admin_connector_internal|provision_tenant_baseline_internal' as reaches
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prokind in ('f','p')
         and p.prosrc ~* 'insert\\s+into\\s+(public\\.)?tenants\\y'
       order by 1`);
    // Zero paths examined would pass the filter below having compared nothing.
    expect(rows.length, 'functions that create a tenants row').toBeGreaterThanOrEqual(3);
    expect(
      rows.filter((r) => !r.reaches).map((r) => r.proname),
      'tenant-creation paths that never reach the platform_admin connector',
    ).toEqual([]);
  });

  it('every workspace that has an assistant also has the connector, whatever its status', async () => {
    // ⚠ NOT filtered to status='active'. Every tenant is BORN 'trial'
    // (complete_signup and request_subtenant both insert status='trial'), and
    // expire_trials() moves a lapsed trial to 'suspended' on a timer — so an
    // active-only assertion was blind for the entire window in which a newly
    // provisioned workspace is newly broken, and then blind again afterwards.
    // Measured before widening (2026-08-13): all three statuses, demo tenant
    // exempt, returns zero rows.
    const rows = await runQuery<{ slug: string; status: string }>(`
      select t.slug, t.status from tenants t
         -- Provisioning deliberately skips the demo tenant — both
         -- provision_onboarding_architect (v_demo) and
         -- provision_tenant_baseline_internal (v_demo_tenant_id) refuse to
         -- provision it by id. It genuinely has an assistant and genuinely
         -- lacks the connector, but the system never promised it one, so
         -- asserting coverage here would assert a promise nobody made. Same
         -- exclusion audit_tenant_feature_parity and audit_tenant_provisioning
         -- use (migration 723) — match the house convention, not a new one.
       where t.id <> 'a0000000-0000-0000-0000-000000000001'
         and exists (select 1 from digital_employees d
                      where d.tenant_id=t.id and coalesce(d.is_workforce_assistant,false))
         and not exists (select 1 from connectors c
                          where c.tenant_id=t.id and c.category='platform_admin' and c.status='connected')`);
    expect(
      rows.map((r) => `${r.slug} (${r.status})`),
      'workspaces with an assistant but no admin connector',
    ).toEqual([]);
  });
});

// Reads the shipped probe out of scripts/certify.mjs. Bounded by the NEXT
// probe's `name:` key rather than a fixed character count — the old 1600-char
// window stopped covering the probe the moment it grew, and a window that
// silently ends early makes every `not.toMatch` below pass on text it never
// read.
async function shippedProbeText(): Promise<string> {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync('scripts/certify.mjs', 'utf8');
  const start = src.indexOf("name: 'workspace-admin-has-an-owner'");
  expect(start, 'probe not found in scripts/certify.mjs').toBeGreaterThan(-1);
  const next = src.indexOf("\n    name: '", start + 10);
  const probe = src.slice(start, next > -1 ? next : src.length);
  // Landmarks: if the window drifted off the probe, fail here rather than in
  // an assertion that would read as a clean pass.
  expect(probe, 'extraction window missed the probe body').toContain('get_agentic_tools_for_de');
  return probe;
}

run('the admin gate cannot be silenced by removing the connector', () => {
  it('examines a workspace with an assistant regardless of its connectors', async () => {
    // The old probe required a connected platform_admin connector before it
    // would look at a tenant at all — so deleting that connector made the
    // check go quiet on exactly the workspace it was meant to protect.
    // Assert on the shipped probe text: the connector must not appear as a
    // precondition alongside the tenant-status filter.
    const probe = await shippedProbeText();
    expect(probe).toContain('is_workforce_assistant');
    expect(probe).not.toMatch(/exists\s*\(\s*select 1 from connectors/);
  });

  it('...or by leaving the workspace on trial', async () => {
    // The second precondition, one layer out. complete_signup and
    // request_subtenant both create tenants with status='trial', and
    // expire_trials() moves a lapsed trial to 'suspended' — so an
    // `active`-only probe was silent for the whole window in which a
    // newly-provisioned workspace is newly broken, and silent again on the
    // far side of it. A status filter is something a single UPDATE can use to
    // quiet the alarm, which is exactly what the connector precondition was.
    const probe = await shippedProbeText();
    expect(probe, 'the probe must not filter tenants by status').not.toMatch(
      /\bstatus\s*(=|<>|!=|in)\s*[('"]/i,
    );
  });

  it('says how many workspaces it examined, so a clean pass is not a silent one', async () => {
    // F4. The probe sits behind two gates it can be emptied through (the demo
    // id, and "has an assistant"), so "no violations found" and "nothing
    // examined" render identically. Run the SHIPPED SQL and require a real
    // denominator behind the silence.
    const probe = await shippedProbeText();
    const open = probe.indexOf('sql: `');
    const sql = probe.slice(open + 6, probe.indexOf('`', open + 6));
    expect(sql.length, 'probe SQL not extracted').toBeGreaterThan(200);

    const rows = await runQuery<{ violation: string | null; note: string | null }>(sql);
    const violations = rows.filter((r) => r.violation != null).map((r) => r.violation);
    const notes = rows.filter((r) => r.note != null).map((r) => r.note as string);
    expect(violations, 'workspaces nobody can administer').toEqual([]);
    expect(notes.length, 'the probe must emit exactly one denominator row').toBe(1);
    const examined = Number(/examined (\d+) workspace/.exec(notes[0])?.[1] ?? 0);
    expect(examined, `zero examined is not a clean pass — ${notes[0]}`).toBeGreaterThan(0);
  });
});
