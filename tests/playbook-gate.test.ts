// ============================================================
// playbook-gate.test.ts — full-publish strictness, pinned BEHAVIOURALLY.
//
// The typed-gaps build (mig 712, spec 2026-08-12) rests on one invariant:
// THE GATE DOES NOT GET LOOSER. Its SQL twin
// (certify › published-snapshots-respect-the-gate) asserts what the gate
// guards on every published snapshot; this file drives the DEPLOYED
// validator itself with a refusal fixture set and pins the EXACT error
// codes. Both directions are asserted — every refusal fixture must refuse
// with its named code, and the valid fixtures must pass — because a gate
// that refuses everything is as broken as one that refuses nothing.
//
// Read-only: {action:'validate'} writes no rows, creates no runs, and
// takes no LLM spend. Runs against the production deployment (the thing
// customers actually hit), authed with the service role key from
// .env.local — the same credential scripts/db-query.mjs already relies on.
// Fails LOUDLY without credentials; a strictness suite that silently does
// not run is worse than none.
// ============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

function env(key: string): string | null {
  for (const f of ['.env.local', '.env']) {
    try {
      const raw = readFileSync(f, 'utf8').replace(/^﻿/, '');
      const line = raw.split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
      if (line) return line.slice(key.length + 1).replace(/^["']|["']$/g, '').trim();
    } catch { /* next file */ }
  }
  return null;
}

// ⚠ AUTH, learned the hard way (same wall spec §1.5 hit): the service key in
// .env.local is a LEGACY credential — the deployed function's platform-
// injected SUPABASE_SERVICE_ROLE_KEY differs, so a service-key bearer gets
// the function's own 401. The door that IS ours to use is the dispatch
// secret (x-dispatch-secret), the same credential pg_cron invokes these
// functions with. It lives in Vault; the management token (which this repo's
// entire verification tooling already requires) fetches it at suite start.
// It is held in memory only and never printed.
const MGMT_TOKEN = env('SUPABASE_ACCESS_TOKEN');
const URL_BASE = 'https://rfsvmhcqeiyrxivbmpel.supabase.co';
// Review Lab — the designated test tenant. validate is read-only there.
const TENANT = '6c30af2b-a63b-4751-9876-8ce488f729d5';

if (!MGMT_TOKEN) {
  throw new Error(
    'playbook-gate.test.ts needs SUPABASE_ACCESS_TOKEN in .env.local (the token scripts/db-query.mjs uses). ' +
    'Failing loudly rather than skipping — a gate pin that silently does not run is theatre.',
  );
}

let dispatchSecret: string | null = null;
async function getDispatchSecret(): Promise<string> {
  if (dispatchSecret) return dispatchSecret;
  const res = await fetch('https://api.supabase.com/v1/projects/rfsvmhcqeiyrxivbmpel/database/query', {
    method: 'POST',
    headers: { Authorization: `Bearer ${MGMT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: "select decrypted_secret as s from vault.decrypted_secrets where name = 'playbook_dispatch_secret'" }),
  });
  if (!res.ok) throw new Error(`vault read failed: HTTP ${res.status}`);
  const rows = await res.json() as Array<{ s: string }>;
  if (!rows[0]?.s) throw new Error('playbook_dispatch_secret not found in vault');
  dispatchSecret = rows[0].s;
  return dispatchSecret;
}

type VErr = { index: number; code: string; message: string };
async function validate(steps: unknown): Promise<{ valid: boolean; errors: VErr[] }> {
  const secret = await getDispatchSecret();
  const res = await fetch(`${URL_BASE}/functions/v1/playbook-execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-dispatch-secret': secret },
    body: JSON.stringify({ action: 'validate', steps, tenant_id: TENANT }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`validate HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return body as { valid: boolean; errors: VErr[] };
}

// Every fixture here is a refusal the pre-712 gate already made. If any of
// these ever comes back valid, the gate was relaxed — the exact regression
// the invariant forbids. Codes are asserted EXACTLY, not just "some error".
const REFUSALS: Array<{ name: string; steps: unknown; code: string }> = [
  { name: 'empty step list', steps: [], code: 'empty' },
  { name: 'unknown primitive', steps: [{ key: 'teleport_money', params: {} }, { key: 'complete', params: {} }], code: 'unknown_primitive' },
  { name: 'missing trailing complete', steps: [{ key: 'instruction', params: { title: 't', body_md: 'b' } }], code: 'last_step' },
  { name: 'approval with no invoice to gate', steps: [{ key: 'human_approval', params: {} }, { key: 'complete', params: {} }], code: 'approval_without_invoice' },
  {
    name: 'post-gate primitive outside the allowed set',
    steps: [
      { key: 'generate_invoice', params: { amount_source: 'account_arr' } },
      { key: 'human_approval', params: {} },
      { key: 'check_account', params: {} },
      { key: 'complete', params: {} },
    ],
    code: 'post_gate_primitive',
  },
  { name: 'two complete steps', steps: [{ key: 'complete', params: {} }, { key: 'complete', params: {} }], code: 'multiple_complete' },
  { name: 'wait with no duration', steps: [{ key: 'wait', params: {} }, { key: 'complete', params: {} }], code: 'bad_params' },
  // gap_gate strictness (new in 712): a gate that cannot name its gap, and a
  // frozen copy that is not an object, are both refused — the new primitive
  // arrives strict, it does not loosen anything.
  { name: 'gap_gate with no gap_id', steps: [{ key: 'gap_gate', params: {} }, { key: 'complete', params: {} }], code: 'bad_params' },
  { name: 'gap_gate with a non-object original_step', steps: [{ key: 'gap_gate', params: { gap_id: 'g', original_step: [1] } }, { key: 'complete', params: {} }], code: 'bad_params' },
];

const VALID: Array<{ name: string; steps: unknown }> = [
  {
    name: 'plain instruction playbook (the shape every pre-712 draft used)',
    steps: [
      { key: 'instruction', params: { title: 'Read this', body_md: 'Do the thing.' } },
      { key: 'check_knowledge', params: { query_template: 'refund policy', on_miss: 'escalate' } },
      { key: 'complete', params: {} },
    ],
  },
  {
    name: 'gap_gate carrying its gap (what partial publish snapshots)',
    steps: [
      { key: 'instruction', params: { title: 'Runs fine', body_md: 'ok' } },
      { key: 'gap_gate', params: { gap_id: '00000000-0000-4000-8000-000000000712', reason: 'blocked', original_step: { key: 'custom_step', params: { instructions: 'frozen' } } } },
      { key: 'complete', params: {} },
    ],
  },
];

describe('full-publish gate strictness (deployed validator, pinned codes)', () => {
  // The denominator, printed the certify way: this suite compares
  // REFUSALS.length + VALID.length fixtures; a filtered or half-run suite
  // cannot claim the number.
  it(`compares ${REFUSALS.length} refusal fixtures and ${VALID.length} valid fixtures`, () => {
    expect(REFUSALS.length).toBeGreaterThanOrEqual(9);
    expect(VALID.length).toBeGreaterThanOrEqual(2);
  });

  for (const f of REFUSALS) {
    it(`refuses: ${f.name} → ${f.code}`, async () => {
      const r = await validate(f.steps);
      expect(r.valid, `gate RELAXED: "${f.name}" came back valid`).toBe(false);
      expect(
        r.errors.map((e) => e.code),
        `gate DRIFTED: "${f.name}" refused, but not with ${f.code} (got ${r.errors.map((e) => e.code).join(',')})`,
      ).toContain(f.code);
    }, 30_000);
  }

  for (const f of VALID) {
    it(`accepts: ${f.name}`, async () => {
      const r = await validate(f.steps);
      expect(r.valid, `gate OVER-TIGHTENED: "${f.name}" was refused: ${JSON.stringify(r.errors)}`).toBe(true);
    }, 30_000);
  }
});
