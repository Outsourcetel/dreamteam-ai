// ============================================================
// EDGE TWIN of src/lib/onboardingTypes.ts.
//
// The two copies exist because the Deno edge runtime cannot import from src/
// and the browser bundle cannot import Deno code — the same reason
// _shared/categoryContracts.ts and _shared/adapterTemplates.ts have browser
// siblings. The duplication is deliberate and approved; `certify` ›
// contract-parity (tests/contract-parity.test.ts) is what stops it drifting,
// and it now compares THIS pair too.
//
// Keep the body byte-identical to the browser copy. Anything that must differ
// belongs outside resolveParams, in the caller that builds the ResolveCtx.
// ============================================================
export interface ItemBinding { action_key: string; params: Record<string, string> }
export interface ResolveCtx {
  accountExternalRef: string | null;
  requirements: Record<string, string>;
}
export interface Resolved { params: Record<string, string>; missing: string[] }

/** Fills a binding's params. '@account' comes from the project's customer,
 *  '@ask' from the recorded requirements keyed '<action_key>.<param>', and
 *  anything else is a literal. Unanswered '@ask' values are NAMED, never
 *  guessed — the whole point is an escalation a person can act on. */
export function resolveParams(b: ItemBinding, ctx: ResolveCtx): Resolved {
  const params: Record<string, string> = {};
  const missing: string[] = [];
  for (const [name, spec] of Object.entries(b.params ?? {})) {
    if (spec === '@account') {
      if (ctx.accountExternalRef) params[name] = ctx.accountExternalRef;
      else missing.push(name);
    } else if (spec === '@ask') {
      const v = ctx.requirements?.[`${b.action_key}.${name}`];
      if (v !== undefined && v !== '') params[name] = v;
      else missing.push(name);
    } else {
      params[name] = spec;
    }
  }
  return { params, missing };
}
