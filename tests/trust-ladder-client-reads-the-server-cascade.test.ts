// trust-ladder-client-reads-the-server-cascade.test.ts — migration 838's client half.
//
// ── WHAT BROKE, AND WHY THIS FILE EXISTS ────────────────────────────────────
// Migration 838 gave "what a trust step grants" a SECOND source: a role
// archetype declares a ladder, and the server resolves it through
// effective_trust_ladder — the policy's own ladder is the override, the role's
// declaration the default beneath it. The declaration is read through the
// employee's archetype at read time and is NEVER copied onto the policy, so a
// policy that inherits its role's ladder still has trust_policies.ladder NULL.
//
// The client reimplements that compile in JS, from `policy.ladder` alone:
//
//   1. earnedLadderSettings (src/lib/trustApi.ts) — and it is NOT display-only.
//      EmployeeFileSections uses its return value to decide whether to append a
//      `trust_manual_override` AUDIT EVENT. For a policy inheriting its role's
//      ladder the JS saw no ladder and fell back to the built-in reward table,
//      so a dial set ABOVE the role's earned cap scored "within earned" and NO
//      AUDIT ROW WAS WRITTEN. That is audit completeness, not cosmetics.
//
//   2. whatItGrants / levelName (src/lib/trustPromotionPresentation.ts) — fed
//      `trustPolicy.ladder ?? null` by the ops queue and the mobile shell. The
//      approval card is the surface a person reads at the moment they grant
//      autonomy, and for an inheriting policy it rendered "to Level 1" with no
//      grant clause while the server enforced the role's mode and cap.
//
// ── WHY THE FIX IS A FETCH, NOT A THIRD IMPLEMENTATION ──────────────────────
// There are already TWO definitions of the cascade (trust_ladder_settings in
// SQL, earnedLadderSettings in JS) and 838 was written specifically to stop
// there being two definitions of the ladder. So the client does not learn the
// role join: it asks the server through effective_trust_ladders(uuid[]) — one
// round trip, the server's own effective_trust_ladder, RLS-bounded — and feeds
// the answer to the JS compile it already had.
//
// ── WHY THE SIGNATURE CHANGE IS THE LOAD-BEARING PART ───────────────────────
// earnedLadderSettings now requires `effective_ladder` as a NON-OPTIONAL field.
// A caller that passes a raw TrustPolicy (where it is optional) fails to
// typecheck. That is deliberate: a runtime fallback to `policy.ladder` would
// have made every un-migrated call site silently wrong in exactly the way this
// file exists to catch, and silently wrong is how the defect shipped.
//
// Structural rather than render tests for the same reason as the sibling files:
// this repo has no jsdom, no @testing-library and no mocking convention, and
// vitest.config.ts pins environment: 'node'.
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { earnedLadderSettings } from '../src/lib/trustApi';

/** Comments are not code. Blanked rather than removed so a file cannot pass by
 *  matching the prose in its own doc comment — which in both files below
 *  describes the very thing being checked for. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

const CARD_SITES = [
  'src/pages/tenant/ops/HumanTasksPage.tsx',
  'src/pages/tenant/mobile/MobileShell.tsx',
];
const AUDIT_SITE = 'src/pages/tenant/EmployeeFileSections.tsx';

// A ladder the ROLE declares: level 1 acts within a 50,000-cent limit.
const ROLE_LADDER = [
  { level: 1, name: 'Handles routine refunds', mode: 'act_within_limits' as const,
    settings: { max_amount_cents: 50000 } },
];

describe('earnedLadderSettings compiles the EFFECTIVE ladder, not the raw column', () => {
  it('reads a role-inherited ladder — RED if it falls back to the built-in reward table', () => {
    // The exact live shape: the policy carries NO ladder of its own, and the
    // effective ladder came from the role. Before the fix this returned the
    // action_execute built-in (enabled, uncapped) or null, and either one makes
    // the audit-write decision below it wrong.
    const earned = earnedLadderSettings(
      { action_category: 'action_execute', max_level: 3, effective_ladder: ROLE_LADDER },
      1,
    );
    expect(earned, 'a role-inherited ladder must compile, not come back unknown').not.toBeNull();
    expect(earned!.enabled).toBe(true);
    expect(earned!.max_amount_cents,
      'the ROLE declared a 50,000-cent cap; anything else means the JS is not reading the effective ladder')
      .toBe(50000);
  });

  it('⛔ CONTROL: no effective ladder still falls back to the built-ins — RED if everything now claims a cap', () => {
    // Without this, the arm above passes for an implementation that returns a
    // hardcoded 50000, and every dial would be scored against a cap nobody set.
    const earned = earnedLadderSettings(
      { action_category: 'action_execute', max_level: 3, effective_ladder: null },
      1,
    );
    expect(earned?.max_amount_cents ?? null,
      'action_execute has no built-in amount cap; a non-null here means the previous arm proves nothing')
      .toBeNull();
  });

  it('level 0 is the human-gated floor whatever the role declared', () => {
    const earned = earnedLadderSettings(
      { action_category: 'action_execute', max_level: 3, effective_ladder: ROLE_LADDER },
      0,
    );
    expect(earned).toEqual({ enabled: false, max_amount_cents: null, min_confidence: null });
  });
});

describe('every surface that reads a ladder reads the effective one', () => {
  it('the approval card is fed the effective ladder on BOTH surfaces', () => {
    for (const path of CARD_SITES) {
      const src = stripComments(readFileSync(path, 'utf8'));
      expect(src, `${path} still feeds the approval card the RAW policy ladder. The card is what a person reads at the moment they grant autonomy, and for a policy inheriting its role's ladder the raw column is NULL — so it renders "to Level 1" with no grant clause while the server enforces the role's mode and cap.`)
        .not.toMatch(/ladder:\s*trustPolicy\.ladder\b/);
      expect(src, `${path} no longer passes an effective ladder to trustPromotionCardCopy at all`)
        .toMatch(/ladder:\s*trustPolicy\.effective_ladder\b/);
    }
  });

  it('the trust_manual_override audit decision is made on the effective ladder', () => {
    const src = stripComments(readFileSync(AUDIT_SITE, 'utf8'));
    // ⚠ THE POINT OF THIS ARM. earnedLadderSettings' return value decides
    // whether `exceeds` is true, and `exceeds` decides whether a
    // trust_manual_override audit row is written at all. Fed the raw column, a
    // dial set above the role's earned cap scores "within earned" and the
    // override goes unrecorded.
    expect(src, 'EmployeeFileSections still passes the whole policy to earnedLadderSettings, so the audit-write decision is made on the raw ladder column')
      .not.toMatch(/earnedLadderSettings\(\s*entry\.policy\s*,/);
    expect(src, 'the audit-write decision no longer consults an effective ladder')
      .toMatch(/earnedLadderSettings\(\s*\{[^}]*effective_ladder/);
  });

  it('the fix is a server fetch, not a third implementation of the cascade', () => {
    const api = stripComments(readFileSync('src/lib/trustApi.ts', 'utf8'));
    expect(api, 'trustApi does not call the server for the effective ladder — if the role join were reimplemented in JS there would be THREE definitions of what a step grants')
      .toMatch(/\.rpc\(\s*['"]effective_trust_ladders['"]/);
    // The JS must not learn the join. role_archetypes/archetype_key appearing
    // here would mean the cascade was copied rather than asked for.
    expect(api, 'trustApi reimplements the role join instead of asking the server for it')
      .not.toMatch(/role_archetypes|archetype_key/);
  });

  it('migration 838 ships the function the client calls', () => {
    const sql = readFileSync('supabase/migrations/838_a_role_declares_what_a_step_grants.sql', 'utf8');
    expect(sql, 'migration 838 no longer creates effective_trust_ladders(uuid[]), so the client fetch above has nothing to call')
      .toContain('function public.effective_trust_ladders(p_policy_ids uuid[])');
    expect(sql, 'effective_trust_ladders is no longer granted to authenticated, so every browser caller gets permission denied and the client silently loses the effective ladder')
      .toMatch(/grant execute on function public\.effective_trust_ladders\(uuid\[\]\)[^;]*to[^;]*authenticated/);
  });
});
