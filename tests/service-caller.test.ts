// The auth boundary this replaces broke silently on a platform key rotation.
// These cases are the ones that matter: it must accept a CURRENT key, refuse
// everything else, and — the part that cost an hour — say WHICH it was.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const LEGACY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' + btoa(JSON.stringify({ role: 'service_role', exp: 9e9 })) + '.sig-legacy';
const ROTATED = 'sb_secret_' + 'r'.repeat(40);
const SECOND = 'sb_secret_' + 's'.repeat(40);
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' + btoa(JSON.stringify({ role: 'anon', exp: 9e9 })) + '.sig-anon';
const USERJWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' + btoa(JSON.stringify({ role: 'authenticated', sub: 'u1', exp: 9e9 })) + '.sig-user';

const env: Record<string, string | undefined> = {};
(globalThis as any).Deno = { env: { get: (k: string) => env[k] } };
const { serviceCaller } = await import('../supabase/functions/_shared/serviceCaller.ts');

beforeEach(() => { for (const k of Object.keys(env)) delete env[k]; });

describe('serviceCaller — accepts current credentials, refuses everything else', () => {
  it('accepts the injected SUPABASE_SERVICE_ROLE_KEY', () => {
    env.SUPABASE_SERVICE_ROLE_KEY = ROTATED;
    expect(serviceCaller(ROTATED).service).toBe(true);
  });

  it('accepts a key from the NEW plural SUPABASE_SECRET_KEYS — the format nothing read before, in all three encodings', () => {
    env.SUPABASE_SECRET_KEYS = JSON.stringify([ROTATED, SECOND]);
    expect(serviceCaller(SECOND).service).toBe(true);
    env.SUPABASE_SECRET_KEYS = JSON.stringify([{ api_key: SECOND }]);
    expect(serviceCaller(SECOND).service).toBe(true);
    env.SUPABASE_SECRET_KEYS = `${ROTATED}, ${SECOND}`;
    expect(serviceCaller(SECOND).service).toBe(true);
  });

  it('REFUSES a user JWT, an anon key, and junk — RED if the boundary ever widens', () => {
    env.SUPABASE_SERVICE_ROLE_KEY = ROTATED;
    expect(serviceCaller(USERJWT).service).toBe(false);
    expect(serviceCaller(ANON).service).toBe(false);
    expect(serviceCaller('x'.repeat(200)).service).toBe(false);
  });

  it('REFUSES everything when the env holds nothing — an empty env must not make an empty header valid', () => {
    expect(serviceCaller('').service).toBe(false);
    env.SUPABASE_SERVICE_ROLE_KEY = '';
    expect(serviceCaller('').service).toBe(false);
    env.SUPABASE_SERVICE_ROLE_KEY = '   ';
    expect(serviceCaller('   ').service).toBe(false);
  });

  it('names a STALE service key rather than saying "user JWT required" — the whole point of the exercise', () => {
    env.SUPABASE_SERVICE_ROLE_KEY = ROTATED;
    const v = serviceCaller(LEGACY);
    expect(v.service).toBe(false);
    expect(v.service === false && v.looksLikeStaleServiceKey).toBe(true);
    // …and a genuine user JWT must NOT be mislabelled as a stale service key.
    const u = serviceCaller(USERJWT);
    expect(u.service === false && u.looksLikeStaleServiceKey).toBe(false);
  });

  it('an unreadable SECRET_KEYS encoding degrades to no extra keys — never throws on the auth path', () => {
    env.SUPABASE_SERVICE_ROLE_KEY = ROTATED;
    env.SUPABASE_SECRET_KEYS = '{ this is not json';
    expect(() => serviceCaller(ROTATED)).not.toThrow();
    expect(serviceCaller(ROTATED).service).toBe(true);
    expect(serviceCaller(SECOND).service).toBe(false);
  });
});

// ⚠ THE ONE PROPERTY NO BEHAVIOURAL TEST CAN PIN. Swapping timingSafeEqual for
// `a === b` leaves every assertion above GREEN — the results are identical, only
// the timing differs, and vitest cannot see timing. Measured: that mutation was
// the one inversion of six that did not go red. So the property is pinned at the
// source, which is this repo's established answer for a claim behaviour cannot
// carry. RED if the compare degrades to a short-circuiting one.
describe('the constant-time compare is pinned at the source, because behaviour cannot pin it', () => {
  it('the bearer compare accumulates over every byte and never returns early', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('supabase/functions/_shared/serviceCaller.ts', 'utf8');
    const fn = src.slice(src.indexOf('function timingSafeEqual'), src.indexOf('const USABLE'));
    expect(fn.length, 'timingSafeEqual has moved — this pin is no longer reading it').toBeGreaterThan(120);
    expect(fn).toMatch(/diff \|= a\.charCodeAt\(i\) \^ b\.charCodeAt\(i\)/);
    expect(fn).toMatch(/return diff === 0/);
    // The failure mode being excluded: an early return inside the loop.
    expect(fn.slice(fn.indexOf('for ('))).not.toMatch(/return (true|false)/);
  });
});

// ⚠ THE RATCHET. The defect was not that one function got this wrong — it was
// that TWENTY-FOUR functions each spelled the same auth decision inline, so a
// platform key rotation broke all of them at once and no single place could be
// fixed. RED if any edge function goes back to comparing a bearer against the
// service key itself, in any of the spellings that existed on 2026-08-18.
describe('no edge function compares a bearer to the service key directly', () => {
  it('every service-caller decision goes through the one helper', async () => {
    const { execSync } = await import('node:child_process');
    const hits = execSync(
      "grep -rn \"=== Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')\|bearer === svc\|jwt === svc\|authHeader === svc\" "
      + 'supabase/functions --include=index.ts || true',
      { encoding: 'utf8' },
    ).split('\n').filter(Boolean);
    expect(hits, `these compare a bearer to the rotating key directly:\n${hits.join('\n')}`).toEqual([]);

    // Vacuity: the helper must actually be in use somewhere, or the assertion
    // above passes on a repo that simply deleted every service path.
    const users = execSync("grep -rl 'serviceCaller(' supabase/functions --include=index.ts || true", { encoding: 'utf8' })
      .split('\n').filter(Boolean);
    expect(users.length, 'nothing uses the helper — the check above is vacuous').toBeGreaterThan(20);
  });
});
