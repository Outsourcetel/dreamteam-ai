// ============================================================
// roleCannot — the derived "what a role can't do" list (handoff 09).
//
// WHY THESE TESTS EXIST. The list is shown at the exact moment an owner
// chooses a role for a new hire. If it drifts from enforcement it becomes
// the worst kind of documentation: authoritative-looking and wrong in the
// direction of either flattery ("can" when they can't — a support call
// later) or slander ("can't" when they can — a role nobody picks).
// Deriving it from canAccessPage makes drift structurally impossible;
// these tests pin the DERIVATION ITSELF against known policy facts, so a
// future tier change that silently rewrites the guidance trips a test and
// gets looked at rather than shipped unnoticed.
//
// Every expectation here restates a decision recorded elsewhere:
// docs/29 (default deny, founder-approved), PAGE_ACCESS in navAccess.ts,
// and the mobile-gate pairing from handoff 13.
// ============================================================
import { describe, it, expect } from 'vitest';
import { roleCannot, canAccessPage } from '../src/lib/navAccess';

describe('roleCannot (derived denials)', () => {
  it('owners and admins have no denied areas', () => {
    // If an area ever lands in an owner's cannot-list, either a probe page
    // was retired (the module-load assertion should have caught it) or a
    // page was tightened past ADMIN — both are worth a human look, not a
    // silent guidance change.
    expect(roleCannot('tenant_owner')).toEqual([]);
    expect(roleCannot('tenant_admin')).toEqual([]);
  });

  it('an approver is NOT denied approvals — the area their role is named after', () => {
    expect(roleCannot('approver').join()).not.toMatch(/Approvals/);
    // …and the underlying gate agrees, desktop and phone alike (handoff 13:
    // same queue, same gate — these two lines must never diverge).
    expect(canAccessPage('approver', 'ops_human_tasks', 'tenant')).toBe(true);
    expect(canAccessPage('approver', 'mobile', 'tenant')).toBe(true);
  });

  it('a knowledge manager is NOT denied knowledge curation, but IS denied approvals', () => {
    const cannot = roleCannot('knowledge_manager').join();
    expect(cannot).not.toMatch(/Knowledge curation/);
    expect(cannot).toMatch(/Approvals/);
  });

  it('read_only and tenant_user are denied every administrative area', () => {
    for (const role of ['read_only', 'tenant_user'] as const) {
      const cannot = roleCannot(role).join();
      for (const area of ['People & access', 'Workspace settings', 'Governance', 'Hiring', 'Approvals']) {
        expect(cannot, `${role} should be denied "${area}"`).toMatch(new RegExp(area));
      }
    }
  });

  it('denials strictly shrink as the ladder rises — no role forbids something a lower tier allows', () => {
    // The ladder along the MANAGE axis. (knowledge_manager and approver sit
    // on side branches and are pinned individually above.)
    const ladder = ['read_only', 'tenant_user', 'tenant_manager', 'tenant_admin', 'tenant_owner'] as const;
    for (let i = 1; i < ladder.length; i++) {
      const lower = new Set(roleCannot(ladder[i - 1]));
      for (const area of roleCannot(ladder[i])) {
        expect(lower.has(area), `${ladder[i]} is denied "${area}" but ${ladder[i - 1]} is not — an inverted tier`).toBe(true);
      }
    }
  });

  it('counts the comparisons: the probe list is non-trivial', () => {
    // ⚠ Zero findings from zero comparisons looks exactly like a clean
    // result. read_only must be denied MOST probes — if this number
    // collapses, the probes rotted (or PAGE_ACCESS went permissive) and
    // every green above is meaningless.
    expect(roleCannot('read_only').length).toBeGreaterThanOrEqual(5);
  });
});
