// ============================================================================
// presentError must translate infrastructure and NEVER touch a governed refusal.
//
// The second half is the one that matters. This product's differentiator is
// that it declines things and says why; CLAUDE.md records "a governed refusal
// reported to the user as success" as a defect already paid for. A helper that
// tidied "This employee isn't cleared to work billing" into "Something went
// wrong" would be that same defect in a politer voice — so the verbatim rule is
// asserted before anything else here.
//
// PROVEN ABLE TO FAIL, and the measurement corrected the guess. Emptying the
// GOVERNED set turns exactly ONE test red — test 3 — not the three I expected.
// That is worth writing down rather than rounding up, because it says something
// true about the design: for most refusal text the verbatim rule and the
// plain-Error path agree, so the GOVERNED set only bites when a refusal
// LEGITIMATELY MENTIONS AN INTERNAL NOUN and would otherwise be withheld by the
// internals filter. Test 3 is therefore the load-bearing one here, and the
// others document intent rather than guard it. Disabling LOOKS_INTERNAL turns
// three red (7, 8, 12). Both measured 2026-08-22.
// ============================================================================
import { describe, it, expect } from 'vitest';
import { presentError, isGovernedRefusal } from '../src/lib/presentError';

const pg = (code: string, message: string, details = '') => ({ code, message, details, hint: '' });

describe('a governed refusal reaches the user unchanged', () => {
  it('1. passes a P0001 raise verbatim', () => {
    const refusal = "This employee isn't cleared to work billing.";
    expect(presentError(pg('P0001', refusal))).toBe(refusal);
  });

  it('2. passes P0002 and a CHECK violation verbatim', () => {
    expect(presentError(pg('P0002', 'no such draft in this workspace'))).toBe('no such draft in this workspace');
    expect(presentError(pg('23514', 'a rejection must carry a reason code'))).toBe('a rejection must carry a reason code');
  });

  it('3. does not translate a refusal even when it mentions a table name', () => {
    // A governed refusal outranks the internals filter: the author wrote it for
    // a reader, and second-guessing that is how a real refusal gets swallowed.
    const refusal = 'You cannot approve an action on knowledge_docs without a second signer.';
    expect(presentError(pg('P0001', refusal))).toBe(refusal);
  });

  it('4. reports which errors are refusals', () => {
    expect(isGovernedRefusal(pg('P0001', 'x'))).toBe(true);
    expect(isGovernedRefusal(pg('42501', 'x'))).toBe(false);
    expect(isGovernedRefusal(new Error('x'))).toBe(false);
  });
});

describe('infrastructure is translated, never shown', () => {
  it('5. turns a missing function into something actionable', () => {
    const out = presentError(pg('PGRST202', 'Could not find the function public.decide_human_tasks(...) in the schema cache'));
    expect(out).not.toContain('schema cache');
    expect(out).not.toContain('public.');
    expect(out).toMatch(/not available in this workspace yet/i);
  });

  it('6. turns permission denied into who can do it instead', () => {
    const out = presentError(pg('42501', 'permission denied for table knowledge_docs'));
    expect(out).not.toContain('knowledge_docs');
    expect(out).toMatch(/permission/i);
    expect(out).toMatch(/owner or administrator/i);
  });

  it('7. withholds raw Postgres text that carries no code at all', () => {
    const out = presentError(new Error('column "de_id" of relation "human_tasks" does not exist'));
    expect(out).not.toContain('de_id');
    expect(out).not.toContain('human_tasks');
  });

  it('8. withholds a duplicate-key dump', () => {
    const out = presentError(new Error('duplicate key value violates unique constraint "tenant_domains_verified_uq"'));
    expect(out).not.toContain('tenant_domains_verified_uq');
  });

  it('9. never returns an empty string', () => {
    for (const v of [undefined, null, '', {}, 0, false, new Error('')]) {
      expect(presentError(v).length, `empty result for ${JSON.stringify(v)}`).toBeGreaterThan(10);
    }
  });
});

describe('messages authored for a person survive', () => {
  it('10. shows a plain Error our own code threw', () => {
    expect(presentError(new Error('Pick a start date before you publish this.')))
      .toBe('Pick a start date before you publish this.');
  });

  it('11. lifts an edge function refusal out of the response body', () => {
    const e = Object.assign(new Error('Edge Function returned a non-2xx status code'),
      { status: 403, body: { detail: 'Only a workspace owner can teach a new tool from an API spec.' } });
    expect(presentError(e)).toBe('Only a workspace owner can teach a new tool from an API spec.');
  });

  it('12. does NOT lift a body detail that is really internals', () => {
    const e = Object.assign(new Error('x'), { status: 500, body: { detail: 'relation "de_spend_ledger" does not exist' } });
    const out = presentError(e);
    expect(out).not.toContain('de_spend_ledger');
  });

  it('13. honours a caller-supplied fallback', () => {
    expect(presentError(null, 'We could not save the trust dial.')).toBe('We could not save the trust dial.');
  });
});

describe('a network failure reads as a network failure', () => {
  // ⚠ THIS CAUGHT A REGRESSION THE CODEMOD INTRODUCED, and the order matters:
  // these assertions were written to FAIL first, then the helper was fixed.
  //
  // The sites converted here previously read
  //     setErr(e instanceof Error ? e.message : 'Could not save changes.')
  // and postgrest-js returns a PLAIN OBJECT (not an Error) for fetch failures —
  // PostgrestBuilder.ts:443-450, the FetchError path, distinct from the
  // `new PostgrestError(...)` path used for real Postgres errors. So the old
  // ternary fell to the author's fallback and the user read
  // "Could not save changes."
  //
  // Naively, presentError(e, fallback) then found a `message` with no code and
  // no internal-looking words, and returned "TypeError: Failed to fetch" —
  // strictly worse than what it replaced. A browser exception string is not an
  // improvement on a sentence someone wrote.
  it('14. does not show a raw fetch exception', () => {
    const plain = { message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' };
    const out = presentError(plain, 'Could not save changes.');
    expect(out).not.toContain('TypeError');
    expect(out).not.toContain('Failed to fetch');
    expect(out).toMatch(/connection|network|reach|try again/i);
  });

  it('15. treats a thrown TypeError from fetch the same way', () => {
    const out = presentError(new TypeError('Failed to fetch'), 'Could not save changes.');
    expect(out).not.toContain('TypeError');
    expect(out).toMatch(/connection|network|reach|try again/i);
  });

  it('16. and an aborted request', () => {
    const out = presentError(new DOMException('The operation was aborted.', 'AbortError'));
    expect(out).toMatch(/too long|timed out|try again|connection|network/i);
  });

  it('17. but still shows a plain sentence our own code threw', () => {
    // The network rule must not swallow authored copy that happens to be short.
    expect(presentError(new Error('Pick a start date first.'))).toBe('Pick a start date first.');
  });
});
