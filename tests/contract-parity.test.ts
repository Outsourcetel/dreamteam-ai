// ============================================================
// Twin-contract parity — the browser copy and the edge copy of the shared
// contracts must agree on everything both export.
//
// WHY: src/lib/* and supabase/functions/_shared/* are maintained as parallel
// files because the browser bundle cannot import Deno code. They have already
// drifted once in a way that mattered (an op renamed in one copy and not the
// other would make the UI offer operations the executor rejects — or worse,
// the reverse). Divergence is ALLOWED for browser-only conveniences
// (CATEGORY_SHORT, AUTH_META); it is a defect for anything the two runtimes
// must agree on: the category ops, the auth types, the placeholder rules and
// the render/date behavior.
//
// This imports BOTH copies and compares the load-bearing exports value-by-
// value, so a drift fails the suite (and certify) the day it is introduced,
// not the day a client hits it.
// ============================================================
import { describe, it, expect } from 'vitest';

import * as browserContracts from '../src/lib/categoryContracts';
import * as edgeContracts from '../supabase/functions/_shared/categoryContracts.ts';
import * as browserAdapters from '../src/lib/adapterTemplates';
import * as edgeAdapters from '../supabase/functions/_shared/adapterTemplates.ts';
import * as browserOnboarding from '../src/lib/onboardingTypes';
import * as edgeOnboarding from '../supabase/functions/_shared/onboardingTypes.ts';

describe('twin-contract parity (browser vs edge)', () => {
  it('category contracts agree exactly', () => {
    expect(browserContracts.CATEGORIES).toEqual(edgeContracts.CATEGORIES);
    expect(browserContracts.CATEGORY_OPS).toEqual(edgeContracts.CATEGORY_OPS);
    expect(browserContracts.CATEGORY_LABELS).toEqual(edgeContracts.CATEGORY_LABELS);
  });

  it('adapter framework vocabulary agrees exactly', () => {
    expect(browserAdapters.AUTH_TYPES).toEqual(edgeAdapters.AUTH_TYPES);
  });

  it('placeholder and date semantics agree behaviorally', () => {
    // Compare BEHAVIOR, not source text — the copies legitimately differ in
    // comments and browser-only exports. What must never differ is what a
    // template MEANS.
    for (const key of ['query', 'ref', 'today', 'days_ago_28', 'days_ago_7', 'customer_id', 'nope-not-valid']) {
      expect(browserAdapters.isFrameworkPlaceholder(key), `isFrameworkPlaceholder(${key})`)
        .toBe(edgeAdapters.isFrameworkPlaceholder(key));
    }
    const now = new Date('2026-08-09T12:00:00Z');
    expect(browserAdapters.dateValues(now)).toEqual(edgeAdapters.dateValues(now));

    const tpl = 'https://api.example.com/{a}/x?d={days_ago_28}&q={query}';
    const vals = { a: 'A', query: 'Q', ...browserAdapters.dateValues(now) };
    expect(browserAdapters.renderTemplate(tpl, vals)).toEqual(edgeAdapters.renderTemplate(tpl, vals));
  });

  // The onboarding binding resolver. The browser copy fills the wizard's
  // "what is still unanswered" hints; the edge copy decides what a digital
  // employee actually SENDS to a customer's system (de-work's
  // perform_onboarding_item). A drift between them is not cosmetic: the UI
  // would show an item ready while the employee escalates, or — the direction
  // that costs money — the employee would fill a param the UI never asked a
  // human to answer. Compared behaviourally over the cases that matter,
  // including both "missing" branches and the per-verb key scoping.
  it('onboarding param resolution agrees exactly', () => {
    const binding = {
      action_key: 'configure_customer_setup',
      params: { external_ref: '@account', territory: '@ask', payment_terms: 'Net 30' },
    };
    const cases: Array<{ b: typeof binding; ctx: { accountExternalRef: string | null; requirements: Record<string, string> } }> = [
      // everything answered
      { b: binding, ctx: { accountExternalRef: 'Grant Plastics Ltd.', requirements: { 'configure_customer_setup.territory': 'United Kingdom' } } },
      // unanswered @ask
      { b: binding, ctx: { accountExternalRef: 'Grant Plastics Ltd.', requirements: {} } },
      // empty-string @ask is unanswered, not answered-with-blank
      { b: binding, ctx: { accountExternalRef: 'X', requirements: { 'configure_customer_setup.territory': '' } } },
      // a bare key belongs to no verb and must not be read
      { b: binding, ctx: { accountExternalRef: 'X', requirements: { territory: 'Wrong' } } },
      // another verb's answer for the same param name must not be read
      { b: binding, ctx: { accountExternalRef: 'X', requirements: { 'other_verb.territory': 'Wrong' } } },
      // no customer reference on file → @account is missing, never guessed
      { b: { action_key: 'setup', params: { company_id: '@account' } }, ctx: { accountExternalRef: null, requirements: {} } },
      // no params at all
      { b: { action_key: 'setup', params: {} }, ctx: { accountExternalRef: 'X', requirements: {} } },
    ];
    for (const c of cases) {
      const b = browserOnboarding.resolveParams(c.b, c.ctx);
      const e = edgeOnboarding.resolveParams(c.b, c.ctx);
      expect(e, JSON.stringify(c)).toEqual(b);
    }
  });

  it('the validator verdict agrees on a known-good and a known-bad definition', () => {
    const good = {
      auth: { type: 'bearer' },
      base_url_template: 'https://api.example.com/v1',
      variables: [],
      ops: {
        search_posts: {
          method: 'GET', path_template: '/posts', query_params: { q: '{query}' },
          response: { items_path: 'data', id_path: 'id', title_path: 'title' },
        },
      },
    };
    const bad = { ...good, ops: { list_posts: { ...good.ops.search_posts, path_template: '/p/{query}' } } };
    for (const def of [good, bad]) {
      const b = browserAdapters.validateAdapterDefinition(def as never, 'social');
      const e = edgeAdapters.validateAdapterDefinition(def as never, 'social');
      expect(b.ok, JSON.stringify(def.ops)).toBe(e.ok);
      expect(b.errors).toEqual(e.errors);
    }
  });
});
