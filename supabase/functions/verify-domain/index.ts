/**
 * verify-domain — proves a workspace controls a domain it has claimed, by
 * looking for a DNS TXT record only the domain's operator could publish.
 *
 * ── WHY THIS FUNCTION DELIBERATELY DECIDES NOTHING ─────────────────────────
 * A verified domain tells the identity layer "every future @acme.com signup
 * belongs to this workspace". Signup is open on this project, so anyone can
 * create a workspace, become its tenant_owner, and reach this endpoint. If this
 * function were the thing that said "verified", then whoever can make this
 * function say it owns any domain they like.
 *
 * So it does not say it. It resolves DNS and hands the raw TXT strings to
 * record_domain_verification_attempt (migration 373), and POSTGRES compares
 * them against the stored token. Concretely, this file never reads
 * verification_token at all — there is no code path here that could leak it,
 * short-circuit the comparison, or be edited into doing so. That is why the
 * token comparison lives next to the token: one place to review, not two.
 *
 * The two RPCs used here refuse any caller whose auth.role() is not
 * 'service_role', in their own bodies, and are revoked from `authenticated`.
 * A tenant admin CAN read their own token (they must, to publish the record) —
 * which is exactly why they must not be able to call the recording RPC and hand
 * it straight back. See migration 373 section 6.
 *
 * ── WHY Deno.resolveDns AND NOT DNS-over-HTTPS ─────────────────────────────
 * A DoH provider on this path would be a third party who can lie about a TXT
 * record, i.e. a supply-chain dependency inside a trust boundary, plus an
 * outbound HTTP call built from a user-supplied domain (an SSRF surface the
 * _shared/urlSafety.ts guards exist to prevent). Deno.resolveDns takes a name,
 * not a URL: nothing is fetched, no user input reaches a URL parser, and the
 * SSRF guards are correctly not involved here.
 *
 * ── RATE LIMITING, IN TWO PLACES ON PURPOSE ────────────────────────────────
 * An endpoint that performs an attacker-chosen DNS query on demand is a DNS
 * amplifier pointed at someone else's nameservers. The durable per-tenant and
 * per-IP limiters below stop the flood; a 30-second per-domain floor and a
 * 50/day cap live in claim_domain_verification_slot as an atomic predicate on
 * an UPDATE, because SQL is not redeployable by mistake and two isolates racing
 * a read-then-check would both get through.
 *
 * Idempotent: an already-verified domain returns 'verified' immediately and
 * never touches DNS.
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.112.3';
import { reportEdgeError } from '../_shared/errorReport.ts';
import { durableRateLimited, clientIp } from '../_shared/rateLimit.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

const DNS_TIMEOUT_MS = 5_000;

/**
 * What DNS actually said. `reason` is a stable machine token — the same
 * vocabulary the RPC stores in tenant_domains.last_error — so the UI, the audit
 * trail and this function never drift into three different spellings of the
 * same failure.
 */
type DnsOutcome =
  | { kind: 'records'; records: string[] }
  | { kind: 'error'; reason: string };

function isNotFound(err: unknown): boolean {
  // Deno.errors.NotFound covers both NXDOMAIN and NODATA (name exists, no TXT).
  // Checked by name as well, because the edge runtime has historically wrapped
  // resolver errors and an instanceof-only test would silently reclassify every
  // "no record" as a generic failure — the single most common real outcome.
  if (err instanceof Deno.errors.NotFound) return true;
  const name = (err as { name?: string })?.name ?? '';
  return name === 'NotFound';
}

function isTimeout(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? '';
  return name === 'TimeoutError' || name === 'AbortError';
}

async function resolveTxt(name: string): Promise<DnsOutcome> {
  try {
    // TXT answers arrive as an array of records, each an array of
    // character-strings that the client must concatenate: a value longer than
    // 255 bytes is split by the protocol, and joining is the client's job. Not
    // joining here would make a long token silently un-matchable.
    const raw = await Deno.resolveDns(name, 'TXT', {
      signal: AbortSignal.timeout(DNS_TIMEOUT_MS),
    }) as string[][];
    return { kind: 'records', records: raw.map((chunks) => chunks.join('').trim()) };
  } catch (err) {
    if (isTimeout(err)) return { kind: 'error', reason: 'dns_timeout' };
    if (isNotFound(err)) return { kind: 'error', reason: 'no_txt_record' };
    return { kind: 'error', reason: 'dns_error' };
  }
}

/**
 * Distinguish "the record isn't there yet" from "this domain doesn't exist".
 * Those are completely different problems — one is waiting for propagation, the
 * other is a typo — and telling an admin the wrong one costs them an afternoon.
 *
 * Heuristic, and labelled as one: resolvers do not expose NXDOMAIN vs NODATA
 * through this API, so we ask whether the apex answers anything at all. Runs
 * ONLY on the failure path, so it adds at most two queries to a check that has
 * already failed — never to the happy path.
 */
async function looksLikeNxdomain(domain: string): Promise<boolean> {
  for (const rt of ['A', 'NS'] as const) {
    try {
      const res = await Deno.resolveDns(domain, rt, {
        signal: AbortSignal.timeout(DNS_TIMEOUT_MS),
      });
      if (Array.isArray(res) && res.length > 0) return false;
    } catch (err) {
      if (!isNotFound(err)) return false; // a timeout proves nothing either way
    }
  }
  return true;
}

/** Machine reason -> something an admin can act on. */
function explain(reason: string, recordName: string, domain: string, seen: number): string {
  switch (reason) {
    case 'token_matched':
      return `Verified. DreamTeam found the expected TXT record at ${recordName}.`;
    case 'already_verified':
      return `${domain} is already verified for this workspace.`;
    case 'no_txt_record':
      return `No TXT record found at ${recordName}. Add it at your DNS provider, then try again — some providers take up to an hour to publish a new record.`;
    case 'nxdomain':
      return `${domain} does not resolve at all — no A or NS records answered. Check the spelling of the domain before adding the TXT record.`;
    case 'token_mismatch':
      return `A TXT record exists at ${recordName}, but ${seen === 1 ? 'its value does' : `none of the ${seen} values there do`} not match this workspace's verification token. Copy the token again exactly, including the "dreamteam-domain-verification=" prefix, and remove any older DreamTeam record.`;
    case 'dns_timeout':
      return `The lookup for ${recordName} timed out. Your nameservers did not answer in ${DNS_TIMEOUT_MS / 1000} seconds — this is usually temporary.`;
    case 'dns_error':
      return `The DNS lookup for ${recordName} failed. If this keeps happening, check that ${domain} has working nameservers.`;
    case 'domain_verified_by_another_workspace':
      // Safe to say plainly: they just proved DNS control, so they own the
      // domain. The other workspace is never named.
      return `You control ${domain}, but it is already verified by a different DreamTeam workspace. A domain can only be verified once. Have that workspace remove it, or contact support.`;
    case 'throttled':
      return `Too many checks for ${domain} just now. Wait 30 seconds and try again.`;
    case 'not_found':
      return `That domain claim no longer exists in this workspace.`;
    default:
      return `Verification did not complete (${reason}).`;
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    if (req.method !== 'POST') return json({ error: 'POST required' }, 405);

    // The runtime may not expose the DNS resolver. Say so precisely instead of
    // throwing a TypeError that reaches the admin as "verification failed" and
    // sends them hunting through their DNS settings for our problem.
    if (typeof Deno.resolveDns !== 'function') {
      return json({
        error: 'dns_unavailable',
        message: 'Domain verification is temporarily unavailable: this server cannot perform DNS lookups. Nothing is wrong with your DNS record.',
      }, 503);
    }

    // Accepts EITHER shape. src/lib/ssoApi.ts (the admin panel) sends
    // { domain }; a scripted caller holding a row id sends { domain_id }.
    // Neither is resolved here — both go to claim_domain_verification_slot,
    // which matches on tenant_id in the same query, so a domain string cannot
    // be used to reach another workspace's row.
    let body: { domain_id?: string; domain?: string };
    try {
      body = await req.json();
    } catch {
      return json({ error: 'a JSON body with domain or domain_id is required' }, 400);
    }
    const domainId = typeof body?.domain_id === 'string' ? body.domain_id : null;
    const domainStr = typeof body?.domain === 'string' ? body.domain.slice(0, 260) : null;
    if (!domainId && !domainStr) {
      return json({ error: 'domain or domain_id is required' }, 400);
    }
    if (domainId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(domainId)) {
      return json({ error: 'domain_id must be a uuid' }, 400);
    }

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // ── Who is asking ──
    // Same shape as invite-team-member: resolve the caller from their own JWT
    // and require workspace admin. Note what is NOT trusted from the client —
    // the tenant. It comes from the caller's profile row and is passed to the
    // RPCs, which match it against the domain's tenant_id in SQL. So even a bug
    // here cannot verify a domain belonging to someone else.
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!jwt) return json({ error: 'unauthorized' }, 401);
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: 'unauthorized' }, 401);

    const { data: profile } = await admin
      .from('profiles')
      .select('tenant_id, role, full_name, is_active')
      .eq('user_id', userData.user.id)
      .single();
    if (!profile?.tenant_id) return json({ error: 'not a member of any workspace' }, 403);
    if (!profile.is_active) return json({ error: 'account is deactivated' }, 403);
    if (!['tenant_owner', 'tenant_admin'].includes(profile.role)) {
      return json({ error: 'only workspace owners and admins can verify a domain' }, 403);
    }
    const tenantId: string = profile.tenant_id;

    // ── Flood control, before any DNS traffic leaves the box ──
    // durableRateLimited FAILS OPEN by design (see _shared/rateLimit.ts: an
    // outage of the counter table must not take the feature down). That is
    // acceptable here only because it is not the last line: the 30-second
    // per-domain floor and 50/day cap in claim_domain_verification_slot are an
    // atomic predicate on an UPDATE and cannot fail open. These two limiters
    // exist to stop a caller cycling through many domain_ids to sidestep the
    // per-domain floor.
    const ip = clientIp(req);
    if (await durableRateLimited(admin, `verify-domain:tenant:${tenantId}`, 20, 3600)) {
      return json({ error: 'rate_limited', message: 'Too many verification attempts from this workspace in the last hour. Try again shortly.' }, 429);
    }
    if (ip && await durableRateLimited(admin, `verify-domain:ip:${ip}`, 40, 3600)) {
      return json({ error: 'rate_limited', message: 'Too many verification attempts. Try again shortly.' }, 429);
    }

    // ── Claim a check slot. Atomic in SQL: ownership, the already-verified
    // short circuit, the 30s floor and the daily cap are one UPDATE. ──
    const { data: slot, error: slotErr } = await admin.rpc('claim_domain_verification_slot', {
      p_tenant: tenantId,
      p_domain_id: domainId,
      p_domain: domainStr,
    });
    if (slotErr) throw new Error(`claim_domain_verification_slot: ${slotErr.message}`);

    // The record name comes from the RPC (tenant_domain_dns_record_name) rather
    // than being re-derived here, so the label the admin is told to create and
    // the label we look up can never drift apart.
    if (!slot?.ok) {
      const reason: string = slot?.reason ?? 'not_found';
      const d: string = slot?.domain ?? '';
      const rn: string = slot?.record_name ?? '';
      if (reason === 'already_verified') {
        return json({ ok: true, status: 'verified', reason, domain: d, message: explain(reason, rn, d, 0) });
      }
      return json(
        { ok: false, status: slot?.status ?? 'pending', reason, domain: d, message: explain(reason, rn, d, 0) },
        reason === 'throttled' ? 429 : 404,
      );
    }

    // The id comes back from the slot RPC rather than from the request, so the
    // recording call below always names the row the slot was actually taken on.
    // If the caller sent { domain }, this is the only place the id exists.
    const resolvedId: string = slot.domain_id;
    const domain: string = slot.domain;
    const recordName: string = slot.record_name;

    // ── The actual proof of control ──
    const outcome = await resolveTxt(recordName);

    let txtRecords: string[] | null = null;
    let dnsError: string | null = null;

    if (outcome.kind === 'records') {
      txtRecords = outcome.records;
      // An empty answer set reaches the RPC as an empty array, which it reports
      // as 'no_txt_record' — same as a NotFound. Kept as one reason because the
      // admin's fix is identical.
    } else {
      dnsError = outcome.reason === 'no_txt_record' && await looksLikeNxdomain(domain)
        ? 'nxdomain'
        : outcome.reason;
    }

    // ── Postgres decides. This function only reports. ──
    const { data: result, error: recErr } = await admin.rpc('record_domain_verification_attempt', {
      p_tenant: tenantId,
      p_domain_id: resolvedId,
      p_txt_records: txtRecords,
      p_dns_error: dnsError,
    });
    if (recErr) throw new Error(`record_domain_verification_attempt: ${recErr.message}`);

    const status: string = result?.status ?? 'pending';
    const reason: string = result?.reason ?? dnsError ?? 'unknown';
    const seen: number = result?.records_seen ?? txtRecords?.length ?? 0;

    return json({
      ok: status === 'verified',
      status,
      reason,
      domain,
      record_name: recordName,
      records_seen: seen,
      verified_at: result?.verified_at ?? null,
      message: explain(reason, recordName, domain, seen),
    });
  } catch (err) {
    console.error('verify-domain error:', err);
    await reportEdgeError('verify-domain', err, {});
    return json({ error: String(err) }, 500);
  }
});
