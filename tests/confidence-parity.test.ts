// ============================================================
// Confidence twin parity — compute_inquiry_confidence (SQL) vs
// computeInquiryConfidence (_shared/confidence.ts).
//
// WHY THIS EXISTS: the two content-hash twins were found capable of drifting
// silently (the test guarding them asserted the wrong thing for weeks). These
// confidence twins had NO guard at all, and the TS side is the one production
// actually runs — the SQL side is the documented contract triage gates trust.
// A drift here means the number a person sees is not the number the gate used.
//
// Same discipline as the hash test: import the REAL implementation, never a
// copy — a copy could drift alongside the thing it checks.
// ============================================================
import { describe, it, expect } from 'vitest';
import { runQuery, adminTokenAvailable } from './helpers/adminQuery';
import { computeInquiryConfidence } from '../supabase/functions/_shared/confidence.ts';

if (!adminTokenAvailable()) {
  describe.skip('confidence twin parity (no admin token)', () => { it('skipped', () => {}); });
} else {
  describe('confidence twin parity', () => {
    // The grid covers: the repriced denied shapes, the preserved failed
    // penalty, both caps, bonus saturation, and absent/zero inputs.
    const GRID: Array<Record<string, unknown>> = [
      {},
      { knowledge_hits: 1 },
      { knowledge_hits: 1, systems_denied_no_access: 1 },
      { knowledge_hits: 1, systems_denied_no_access: 2 },   // the measured 18 → 48
      { knowledge_hits: 1, systems_failed: 1 },             // must stay 33
      { knowledge_hits: 1, systems_failed: 2 },
      { knowledge_hits: 1, systems_failed: 1, systems_denied_no_access: 1 },
      { knowledge_hits: 5, history_corroborations: 3, account_context_found: true },
      { knowledge_hits: 9, history_corroborations: 9, account_context_found: true }, // ceiling 97
      { systems_failed: 9 },                                                          // floor 0
      { knowledge_hits: 3, history_corroborations: 1, account_context_found: true },  // 84
      { account_context_found: true },
    ];

    it('SQL and TypeScript agree on every grid point', async () => {
      // ONE round-trip for the whole grid. The first version did one query per
      // point and a single management-API flake read as "drift" — a parity test
      // must not be able to confuse an HTTP hiccup with a formula divergence.
      const rows = await runQuery<{ i: number; v: number }>(`
        select (j.ord - 1)::int as i, compute_inquiry_confidence(j.val)::int as v
          from jsonb_array_elements('${JSON.stringify(GRID)}'::jsonb)
               with ordinality as j(val, ord)
         order by j.ord`);
      expect(rows.length, 'grid did not round-trip — API problem, not drift').toBe(GRID.length);
      const drifted: string[] = [];
      for (const r of rows) {
        const ts = computeInquiryConfidence(GRID[r.i]);
        if (r.v !== ts) drifted.push(`${JSON.stringify(GRID[r.i])} → sql=${r.v} ts=${ts}`);
      }
      expect(drifted, 'the twins disagree — the number shown is not the number gated on').toEqual([]);
    });

    it('denied access is recorded but not priced; failure still is', async () => {
      // The semantic claim of migration 567, pinned from the test side too.
      expect(computeInquiryConfidence({ knowledge_hits: 1, systems_denied_no_access: 2 })).toBe(48);
      expect(computeInquiryConfidence({ knowledge_hits: 1, systems_failed: 1 })).toBe(33);
    });
  });
}
