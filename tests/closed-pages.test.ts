// ============================================================================
// closed-pages — the nine descoped pages must not be reachable by TYPING a URL.
//
// WHY THIS FILE EXISTS. A review on 2026-08-20 proved that every page in this
// app is reachable by address, and that the ONLY gate on a typed URL is
// canAccessPage: src/lib/pageRoutes.ts builds URL_TO_PAGE as the exact reverse
// of PAGE_TO_URL, App.tsx's URLSync reads it on cold load and on back/forward,
// and AuthContext's handleSetPage is an authedUser check plus canAccessPage and
// nothing else. The Sidebar hides NAV ENTRIES; it does not gate the router.
//
// The nine — entity_vendor{,_sourcing,_contracts,_management} and
// entity_workforce{,_talent,_onboarding,_development,_payroll} — were descoped
// by the founder on 2026-07-09 (commit a5f03af6: "Vendor Management and
// Workforce/HR both stay design-preview demos, not real backends") and then
// left routed for another six weeks, eight of them at ALL_TENANT (read_only
// included) and the ninth, payroll, at MANAGE.
//
// ⚠⚠ THE CONTROL IS THE POINT OF THIS FILE. Every assertion below is a NEGATIVE
// — "canAccessPage says no", "URL_TO_PAGE has no such address". A negative test
// passes green on a broken import, a renamed export, a typo in a page key, or a
// harness that never called anything. So each block is paired with a POSITIVE
// on a page that is still live: if the control ever stops saying YES, the greens
// beside it mean nothing and this file goes red instead of lying.
//
// ⚠ The nine are no longer members of the `Page` union, so they are cast in
// through `unknown`. That is not a workaround — it is exactly the shape of the
// thing being tested. A bookmarked URL arrives as an arbitrary STRING; the
// question is what the real gate does when handed one of these strings, and the
// cast is how a test written in TypeScript asks a runtime question.
// ============================================================================
import { describe, it, expect } from 'vitest';
import { canAccessPage } from '../src/lib/navAccess';
import { PAGE_TO_URL, URL_TO_PAGE } from '../src/lib/pageRoutes';
import type { Page, UserRole } from '../src/types';

/** The nine closed keys, as strings — they are deliberately not `Page`s. */
const CLOSED = [
  'entity_vendor',
  'entity_vendor_sourcing',
  'entity_vendor_contracts',
  'entity_vendor_management',
  'entity_workforce',
  'entity_workforce_talent',
  'entity_workforce_onboarding',
  'entity_workforce_development',
  'entity_workforce_payroll',
] as const;

/** The nine addresses a customer could have bookmarked. */
const CLOSED_URLS = [
  '/vendor',
  '/vendor/sourcing',
  '/vendor/contracts',
  '/vendor/management',
  '/workforce-entity',
  '/workforce-entity/talent',
  '/workforce-entity/onboarding',
  '/workforce-entity/development',
  '/workforce-entity/payroll',
] as const;

/** EVERY member of UserRole, platform tiers included. Hand-listed on purpose:
 *  UserRole is a type, so it has no runtime members to enumerate, and a
 *  derived-from-nothing list is how a role quietly escapes a sweep. The count
 *  is asserted below against navAccess's own behaviour. */
const ALL_ROLES: UserRole[] = [
  'dt_super_admin', 'dt_god_access', 'dt_support', 'dt_billing',
  'tenant_owner', 'tenant_admin', 'tenant_manager',
  'knowledge_manager', 'approver', 'tenant_user', 'read_only',
];

const LAYERS = [undefined, 'platform', 'tenant', 'end_user'] as const;

/** A page that is unambiguously still open to everyone, used as the control. */
const LIVE_CONTROL = 'dashboard' as Page;
/** A page that is open only to the manage tier — proves the harness can also
 *  say NO for a reason that is a POLICY rather than an absence. */
const MANAGE_CONTROL = 'gov_audit' as Page;

const asPage = (k: string) => k as unknown as Page;

describe('the nine descoped pages are closed, not merely hidden', () => {
  it('CONTROL: the harness can still say YES — the real canAccessPage is loaded', () => {
    // If this import were broken, renamed or tree-shaken to a stub, every
    // negative below would pass for the wrong reason. It must fail here first.
    expect(typeof canAccessPage).toBe('function');
    let yeses = 0;
    for (const role of ALL_ROLES) {
      for (const layer of LAYERS) {
        if (canAccessPage(role, LIVE_CONTROL, layer)) yeses++;
      }
    }
    // 11 roles x 4 layers = 44 probes; dashboard is ALL_TENANT and every DT
    // role/platform layer passes too, so every single one must be YES.
    expect(yeses).toBe(ALL_ROLES.length * LAYERS.length);
  });

  it('CONTROL: the harness can still say NO for a policy reason, not just absence', () => {
    // gov_audit is MANAGE. read_only must be refused — proving a NO here is
    // canAccessPage deciding, not canAccessPage failing to exist.
    expect(canAccessPage('read_only', MANAGE_CONTROL, 'tenant')).toBe(false);
    expect(canAccessPage('tenant_owner', MANAGE_CONTROL, 'tenant')).toBe(true);
  });

  it('canAccessPage says NO for all nine, for every role, on every layer', () => {
    let probes = 0;
    for (const key of CLOSED) {
      for (const role of ALL_ROLES) {
        for (const layer of LAYERS) {
          probes++;
          expect(
            canAccessPage(role, asPage(key), layer),
            `${role} (layer ${String(layer)}) can still open ${key}`,
          ).toBe(false);
        }
      }
    }
    // ⚠ COUNT THE COMPARISONS. Zero findings from zero probes looks exactly
    // like a clean result — 9 keys x 11 roles x 4 layers.
    expect(probes).toBe(9 * ALL_ROLES.length * LAYERS.length);
    expect(probes).toBe(396);
  });

  it('NO holds even for a platform operator holding every DE relation', () => {
    // canAccessPage has a fourth axis (assignment relations) and a
    // platform-operator bypass. Both are checked AFTER `if (!allowed) return
    // false`, so an absent key beats them — but "should" and "does" are
    // different sentences, so the widest possible caller is probed directly.
    for (const key of CLOSED) {
      expect(canAccessPage('dt_super_admin', asPage(key), 'platform',
        ['manager', 'executive', 'owner'] as never)).toBe(false);
      expect(canAccessPage('tenant_owner', asPage(key), 'tenant',
        ['manager', 'executive', 'owner'] as never)).toBe(false);
    }
  });

  it('the nine URLs are not addresses any more — URL_TO_PAGE has never heard of them', () => {
    for (const url of CLOSED_URLS) {
      expect(URL_TO_PAGE[url], `${url} still resolves to a page`).toBeUndefined();
    }
    // CONTROL: the map is populated and the lookup works.
    expect(URL_TO_PAGE['/dashboard']).toBe('dashboard');
    expect(Object.keys(URL_TO_PAGE).length).toBeGreaterThan(50);
  });

  it('no route map entry survives under any other address', () => {
    // Belt to the braces above: the URL could have been renamed rather than
    // removed, which URL_TO_PAGE['/vendor'] alone would not catch.
    const mapped = Object.keys(PAGE_TO_URL);
    for (const key of CLOSED) {
      expect(mapped, `${key} is still in PAGE_TO_URL`).not.toContain(key);
    }
    // CONTROL: the map is the real one and contains real pages.
    expect(mapped).toContain('dashboard');
    expect(mapped.length).toBeGreaterThan(50);
  });

  it('workforce_chat is NOT closed — it was not in the founder\'s instruction', () => {
    // ⚠ Deliberate. The descope named the vendor and workforce-ENTITY pages
    // only. workforce_chat is a different surface (/workforce/chat) and remains
    // reachable at ALL_TENANT. This line exists so nobody later reads the nine
    // above as "workforce was closed" and quietly widens it — or reads its
    // continued reachability as an oversight this pass missed.
    expect(canAccessPage('read_only', 'workforce_chat' as Page, 'tenant')).toBe(true);
    expect(PAGE_TO_URL['workforce_chat' as Page]).toBe('/workforce/chat');
  });
});
