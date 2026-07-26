// ============================================================================
// Enterprise identity — domain claim, SSO policy, SCIM tokens. Client API.
//
// WHY THIS FILE EXISTS
// An independent readiness audit scored ENTERPRISE READINESS 27/100. "Do you
// support SSO?" is question one from a buyer's IT team, and today the honest
// answer is measurable: the Supabase auth config for project rfsvmhcqeiyrxivbmpel
// reports saml_enabled = false (SAML is a Pro+ feature; the org is on FREE).
//
// WHAT THIS FILE IS WIRED TO — READ, NOT ASSUMED
// The domain and policy backends landed while this UI was being written, so the
// names and shapes below are taken from the migrations on disk, not from a
// contract sketch:
//   · supabase/migrations/373_tenant_domains.sql   — claim/list/remove RPCs,
//     tenant_domains table, DNS-TXT verification (service-role only).
//   · supabase/migrations/374_sso_policy_jit.sql   — tenant_sso_policy table +
//     tenant_sso_effective_policy view. NOTE: 374 exposes NO admin RPC; the
//     policy is an RLS-guarded TABLE the admin writes directly.
//   · supabase/migrations/375_scim_tokens.sql      — scim_tokens (hash only,
//     CHECK-enforced) + scim_token_issue/revoke and scim_tokens_list.
//   · supabase/functions/verify-domain, supabase/functions/scim — the two edge
//     functions those migrations are the back half of.
// Every name and every field below was read from those files. Where a shape is
// still a guess, it is labelled as one.
//
// DESIGN RULE FOR THIS FILE — the same one dataRightsApi.ts states, and for the
// same reason: never swallow a failure and never invent a success. A panel that
// shows "Domain verified" because a call returned null would be strictly worse
// than one that says "the verification service is not deployed here yet" — the
// entire value of the feature is that an auditor can trust what we tell them
// about who can get into the workspace.
//
// SECURITY POSTURE ENCODED HERE
//  1. NO DOMAIN CALL SENDS A tenant_id. claim/list/remove_tenant_domain each
//     resolve the tenant from auth_tenant_id() server-side (373:346-349) and
//     refuse when it is NULL. A client-supplied tenant_id on a SECURITY DEFINER
//     writer is precisely the cross-tenant hole migrations 330/365/369 spent
//     this quarter closing; this file does not reopen it.
//  2. The ONE place a tenant_id is sent is the policy upsert, because
//     tenant_sso_policy.tenant_id is the primary key and an INSERT must carry
//     it. That is safe for a reason that does not depend on this file: the RLS
//     policy is `FOR ALL USING (can_admin_tenant_internal(tenant_id)) WITH
//     CHECK (can_admin_tenant_internal(tenant_id))` (374:253-256), so a forged
//     tenant_id is rejected by Postgres, not by the browser.
//  3. NOTHING HERE CAN VERIFY A DOMAIN. Verification is
//     record_domain_verification_attempt(), which is revoked from authenticated
//     AND re-checks auth.role() = 'service_role' in its body (373:588-591) —
//     because the claimant necessarily knows their own token, so a client-
//     callable "record the result" RPC would let anyone self-verify any domain
//     on earth. This file can only ask the edge function to go look at DNS.
//  4. Signup is OPEN (disable_signup = false), so `authenticated` is one email
//     address away from anyone on the internet. Nothing in this file is a
//     permission check — every check is server-side. The client-side validation
//     below exists to give a human a good error, never to gate.
// ============================================================================
import { supabase } from '../supabase';
import { SUPABASE_URL } from './env';
import { requireTenantId } from './liveShared';

/* ── Backend entry points, each named in EXACTLY ONE place ────────────────── */

/** Verified against 373_tenant_domains.sql §5. */
export const DOMAIN_RPC = {
  /** () -> SETOF (id, domain, status, verification_token, record_name,
   *   verified_at, last_checked_at, last_error, check_count, failure_count,
   *   created_at). Admin-only: raises insufficient_privilege otherwise. */
  list: 'list_tenant_domains',
  /** (p_domain text) -> jsonb {id, domain, status, already_claimed,
   *   record_type, record_name, record_value}. Idempotent — re-claiming
   *   returns the SAME token so a published TXT record stays valid. */
  claim: 'claim_tenant_domain',
  /** (p_domain_id uuid) -> jsonb {removed, domain, was_verified}. */
  remove: 'remove_tenant_domain',
} as const;

/**
 * Edge function that resolves DNS and hands the answer to
 * record_domain_verification_attempt() for Postgres to judge.
 * Read from supabase/functions/verify-domain/index.ts:
 *   invoke('verify-domain', { body: { domain } })
 *     -> { ok, status, reason, domain, records_seen, message }
 * Refusals come back as non-2xx with the SAME body, so the message survives
 * (404 for not_found, 429 for throttled) — invokeFailure below reads it.
 *
 * On disk, but written this same session and not yet deployed. Until it is,
 * this call 404s and the panel says the verification service is not deployed —
 * out loud — rather than implying a check happened.
 */
export const VERIFY_DOMAIN_FUNCTION = 'verify-domain';

/** Policy lives in a table + view, NOT an RPC (374 exposes no admin RPC). */
export const SSO_POLICY_VIEW = 'tenant_sso_effective_policy';
export const SSO_POLICY_TABLE = 'tenant_sso_policy';

/** Verified against 375_scim_tokens.sql §3 (token administration). */
export const SCIM_RPC = {
  /** (p_tenant uuid) -> jsonb { ok, tokens: [{id, name, prefix,
   *   allow_account_adoption, created_at, last_used_at, revoked_at}] }.
   *  token_hash is deliberately absent from the projection. */
  list: 'scim_tokens_list',
  /** (p_tenant uuid, p_name text, p_allow_account_adoption boolean)
   *  -> jsonb { ok, id, token: '<plaintext, once>', prefix, name } */
  issue: 'scim_token_issue',
  /** (p_token_id uuid) -> jsonb { ok }. Sets revoked_at; never DELETEs, so an
   *  audit still shows the token existed. */
  revoke: 'scim_token_revoke',
} as const;

/**
 * Where a customer points their identity provider. 375 ships the receiving end
 * as the `scim` edge function (`ls supabase/functions` shows it), and Supabase
 * serves edge functions at <project>/functions/v1/<name>, so this is derived
 * rather than hardcoded or asked of the user.
 */
export const SCIM_BASE_URL = `${SUPABASE_URL}/functions/v1/scim`;

/**
 * Is SSO SIGN-IN actually live on this platform?
 *
 * MEASURED, NOT GUESSED: GET /v1/projects/rfsvmhcqeiyrxivbmpel/config/auth
 * returns saml_enabled = false, because SAML is a Supabase Pro+ feature and the
 * org is on the FREE plan. Nothing in the database knows this — 374 stores
 * policy, not platform capability — so it cannot be read at runtime and is
 * stated here instead, with its provenance, as a single flip point.
 *
 * FLIP THIS TO true THE DAY saml_enabled GOES true. Every "configured and
 * waiting" vs "live" sentence in the UI keys off this one constant.
 */
export const SSO_LOGIN_LIVE = false;

/* ── Errors ───────────────────────────────────────────────────────────────── */

export type SsoFailureKind =
  /** The backend piece is not deployed here, or its signature differs from
   *  what this file sends. Both are deployment facts, not user errors. */
  | 'not_deployed'
  /** The server ran and refused on permissions. */
  | 'denied'
  /** The server ran and refused on the request itself. Its sentence is kept. */
  | 'rejected'
  /** Another workspace already holds this domain. Called out separately
   *  because it is the ONE refusal that is a security event, not a typo. */
  | 'conflict'
  /** Never reached the server (offline, DNS, CORS). Nothing happened. */
  | 'unavailable'
  /** 2xx, but the payload is not the agreed contract. */
  | 'malformed'
  | 'server';

export class SsoError extends Error {
  readonly kind: SsoFailureKind;
  /** Raw server detail, kept verbatim for support. May be empty. */
  readonly detail: string;
  readonly status: number | null;
  readonly code: string | null;
  constructor(kind: SsoFailureKind, message: string, opts: { detail?: string; status?: number | null; code?: string | null } = {}) {
    super(message);
    this.name = 'SsoError';
    this.kind = kind;
    this.detail = opts.detail ?? '';
    this.status = opts.status ?? null;
    this.code = opts.code ?? null;
  }
}

/** What a panel prints when it catches something. Never throws. */
export function describeSsoError(err: unknown): { message: string; kind: SsoFailureKind; detail: string } {
  if (err instanceof SsoError) return { message: err.message, kind: err.kind, detail: err.detail };
  const m = (err as { message?: string })?.message;
  return { message: m || 'Something went wrong and we could not confirm what.', kind: 'server', detail: '' };
}

/**
 * Deliberately says WHICH workspace holds a domain: nothing. Domain ownership
 * is a cross-tenant fact, and "acme.com is held by Northwind Ltd" leaks a
 * customer relationship to anyone who can type a domain into a box — and signup
 * is open, so that is anyone. 373 takes the same line in SQL: the claim RPC
 * returns no hint that another workspace holds the domain, and the collision is
 * only named at verification time, once DNS control has been proved
 * (373:645-652). This sentence is the client half of that agreement.
 */
const CONFLICT_SENTENCE =
  'That domain is already verified by another workspace, so it cannot be verified here. If your company owns it, ask them to release it, or contact us and we will verify ownership with you directly.';

/**
 * PostgREST error → typed failure.
 * PGRST202 ("Could not find the function … in the schema cache") and SQLSTATE
 * 42883 both mean the same thing to a user: the piece is not there. Both also
 * fire when the function EXISTS but takes different argument names than this
 * file sends, which is why the message names this file.
 * 42501 is insufficient_privilege — every admin gate in 373/374 raises with
 * exactly that ERRCODE. 23505 is the partial unique index tenant_domains_verified_uq
 * firing, i.e. rule 1 (one workspace per verified domain). P0001 is a plain
 * `raise exception`, which is how 373 delivers its precise refusals, so those
 * are quoted verbatim rather than replaced with a generic sentence.
 */
function rpcFailure(rpcName: string, err: { code?: string; message?: string; details?: string }): SsoError {
  const code = err?.code ?? null;
  const message = (err?.message ?? '').trim();
  if (code === 'PGRST202' || code === '42883' || code === 'PGRST205') {
    return new SsoError('not_deployed',
      `This part of enterprise identity is not available in this environment yet (no “${rpcName}” with the arguments src/lib/ssoApi.ts sends). Nothing was changed.`,
      { detail: message, code });
  }
  if (code === '42501' || /permission denied|not a member of any workspace|only workspace owners/i.test(message)) {
    return new SsoError('denied',
      message || 'Only a workspace owner or administrator can change identity settings.',
      { detail: message, code });
  }
  if (code === '23505' || /verified_by_another_workspace|already verified/i.test(message)) {
    return new SsoError('conflict', CONFLICT_SENTENCE, { detail: message, code });
  }
  if (code === 'P0001' || code === 'P0002' || code === '23514') {
    return new SsoError('rejected', message || 'The request was refused.', { detail: message, code });
  }
  return new SsoError('server', message || 'The request failed.', { detail: err?.details ?? '', code });
}

/**
 * supabase-js v2 turns every non-2xx from an Edge Function into a
 * FunctionsHttpError whose `.message` is the useless string "Edge Function
 * returned a non-2xx status code" and whose `.context` is the raw Response
 * (@supabase/functions-js: `if (!response.ok) throw new FunctionsHttpError(response)`).
 * Reading the body is the only way to tell "not deployed yet" apart from "your
 * DNS record is not published", and those need very different sentences.
 */
async function invokeFailure(fnName: string, err: unknown): Promise<SsoError> {
  const e = err as { message?: string; context?: unknown };
  const ctx = e?.context as Response | undefined;
  if (!ctx || typeof ctx.status !== 'number') {
    return new SsoError('unavailable',
      `Could not reach the ${fnName} service, so the domain was not checked. Nothing changed.`,
      { detail: e?.message ?? '' });
  }
  let body = '';
  try { body = (await ctx.text()).slice(0, 800); } catch { /* body already consumed */ }
  let serverMessage = '';
  try {
    const parsed = JSON.parse(body) as { error?: string; message?: string; detail?: string; reason?: string };
    serverMessage = (parsed?.error || parsed?.detail || parsed?.message || parsed?.reason || '').trim();
  } catch { serverMessage = body.trim(); }

  if (ctx.status === 404) {
    return new SsoError('not_deployed',
      `The domain-verification service is not deployed to this environment yet — the platform returned 404 for “${fnName}”. Your domain was not checked, and nothing about it changed.`,
      { detail: serverMessage, status: 404 });
  }
  if (ctx.status === 401 || ctx.status === 403) {
    return new SsoError('denied', serverMessage || 'Your account is not permitted to verify domains for this workspace.', { detail: serverMessage, status: ctx.status });
  }
  if (ctx.status === 409) return new SsoError('conflict', CONFLICT_SENTENCE, { detail: serverMessage, status: 409 });
  if (ctx.status === 429) {
    return new SsoError('rejected', DOMAIN_REASON_TEXT.throttled, { detail: serverMessage, status: 429 });
  }
  if (ctx.status >= 400 && ctx.status < 500) {
    return new SsoError('rejected', serverMessage || `The verification service refused the request (status ${ctx.status}).`, { detail: serverMessage, status: ctx.status });
  }
  return new SsoError('server', serverMessage || `The verification service failed (status ${ctx.status}).`, { detail: serverMessage, status: ctx.status });
}

/* ── Domains ──────────────────────────────────────────────────────────────── */

export type DomainStatus = 'pending' | 'verified' | 'failed' | string;

export interface TenantDomain {
  id: string;
  domain: string;
  status: DomainStatus;
  /** The proof string to publish. 373 mints it as a column DEFAULT of 32
   *  CSPRNG bytes; it is the record VALUE, not an opaque handle. */
  verification_token: string | null;
  /** Fully-qualified record name, computed server-side by
   *  tenant_domain_dns_record_name() so migration, RPC, edge function and UI
   *  can never disagree about where the token lives (373:218-221). */
  record_name: string | null;
  verified_at: string | null;
  last_checked_at: string | null;
  /**
   * MACHINE-READABLE reason code, not prose — 373 says so at the column and
   * writes values like 'no_txt_record'. Never render this raw; run it through
   * explainDomainReason().
   */
  last_error: string | null;
  check_count: number;
  failure_count: number;
  created_at: string | null;
}

export interface DnsRecord { host: string; type: string; value: string }

/**
 * The record to publish. 373 supports exactly one method
 * (verification_method CHECK (… IN ('dns_txt'))), so the type is a constant
 * here rather than a field that could disagree with the server.
 */
export function dnsRecordFor(d: TenantDomain): DnsRecord | null {
  if (!d.verification_token) return null;
  return {
    // Fall back to the documented convention only if the server omitted the
    // computed name; '_dreamteam-verify.' is 373:210 verbatim.
    host: d.record_name || `_dreamteam-verify.${d.domain}`,
    type: 'TXT',
    value: d.verification_token,
  };
}

/**
 * Reason codes → sentences a non-technical admin can act on.
 *
 * Every key is a literal written by 373: 'no_txt_record' / 'token_mismatch'
 * (373:617), 'domain_verified_by_another_workspace' (373:648), 'throttled' /
 * 'not_found' / 'already_verified' (373:545-570). The DNS-layer codes come
 * from the edge function's p_dns_error and are named in 373's own comment
 * ("nxdomain / dns_timeout / …"), so they are covered too. Anything unknown
 * falls through to the raw code rather than being hidden — see
 * explainDomainReason.
 */
export const DOMAIN_REASON_TEXT: Record<string, string> = {
  no_txt_record: 'We looked up the record and found nothing there yet. Either it has not been created, or DNS has not finished publishing it — that can take a few minutes to a few hours. Leave it in place and check again.',
  token_mismatch: 'A record exists at that name, but its value does not match the one shown below. Copy the value again exactly — a truncated paste or a stray space is the usual cause.',
  nxdomain: 'The name we looked up does not exist in DNS. Check the record was created on this exact domain, and that your provider did not add the domain twice (a record named “_dreamteam-verify.acme.com” at acme.com often becomes “_dreamteam-verify.acme.com.acme.com”).',
  no_answer: 'The domain exists but returned no TXT record at that name. If you just created it, DNS has not published it yet.',
  dns_timeout: 'Your DNS provider did not answer in time. Nothing is wrong with your record as far as we can tell — try again shortly.',
  dns_error: 'The DNS lookup failed for a reason we could not classify. Try again shortly; if it keeps happening, contact us with the domain name.',
  servfail: 'Your DNS provider returned an error for this domain. That is on their side — try again shortly, or ask whoever manages your DNS.',
  domain_verified_by_another_workspace: 'You have proved you control this domain, but another workspace verified it first, and a domain can only be verified for one workspace. Ask them to release it, or contact us and we will sort it out with you.',
  throttled: 'That was checked very recently. We allow one check every 30 seconds and 50 a day per domain, so we never hammer your DNS provider. Wait a moment and try again.',
  not_found: 'We could not find that domain in this workspace. It may have been removed — reload the page.',
  already_verified: 'This domain is already verified. There is nothing left to do.',
};

/**
 * Never returns an empty string, and never hides a code it does not know: an
 * unrecognised reason is shown raw with a plain-language wrapper, because
 * "verification failed" with no reason is the single most useless string in
 * this whole flow and the thing that sends people to support.
 */
export function explainDomainReason(reason: string | null | undefined): string {
  const key = (reason ?? '').trim();
  if (!key) return '';
  return DOMAIN_REASON_TEXT[key]
    ?? `The check did not succeed, and the reason our servers gave was “${key}”. If that means nothing to you it will mean something to us — send it over.`;
}

/**
 * Free/consumer mail domains. Claiming one would attach every future gmail.com
 * signup on the internet to one workspace — the tenant-takeover primitive in
 * its purest form.
 *
 * THE SERVER IS THE ENFORCER: 373 rejects these with a CHECK constraint on the
 * table (tenant_domains_not_public_provider), so no code path present or future
 * can store one. This list is a courtesy so the user gets a sentence instead of
 * a constraint-violation round trip, and it is deliberately short rather than
 * pretending to be the same list.
 */
const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com',
  'proton.me', 'protonmail.com', 'gmx.com', 'gmx.net', 'mail.com', 'zoho.com',
  'yandex.com', 'qq.com', '163.com', 'hey.com', 'fastmail.com', 'tutanota.com',
]);

/** Reserved / non-routable names that can never be proven by public DNS. */
const UNVERIFIABLE_TLDS = ['localhost', 'local', 'internal', 'test', 'invalid', 'example', 'onion'];

export interface DomainCheck { ok: boolean; value: string; error: string }

/**
 * Normalise what a human typed into the thing we claim, and say why not.
 * Accepts what people actually paste: "https://acme.com/", "@acme.com",
 * "me@acme.com", "ACME.com.". Returns the bare lowercase host.
 *
 * Mirrors normalize_email_domain() + is_valid_email_domain() from 373 closely
 * enough to catch the common mistakes client-side, including 373's refusal of
 * non-ASCII input (it requires punycode, on the grounds that two spellings of
 * one domain would defeat the one-workspace-per-domain rule).
 *
 * THIS IS INPUT HYGIENE, NOT A SECURITY CONTROL. Every rule here is also the
 * server's job; nothing downstream may assume it ran.
 */
export function normaliseDomain(raw: string): DomainCheck {
  let v = (raw || '').trim().toLowerCase();
  const fail = (error: string): DomainCheck => ({ ok: false, value: v, error });
  if (!v) return fail('Enter the email domain your staff sign in with, for example acme.com.');

  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');   // scheme
  v = v.split(/[/?#]/)[0];                        // path/query/fragment
  if (v.includes('@')) v = v.slice(v.lastIndexOf('@') + 1); // full address or "@acme.com"
  v = v.split(':')[0];                            // port
  v = v.replace(/\.+$/, '');                      // trailing root dot

  if (!v) return fail('That did not contain a domain name.');
  // eslint-disable-next-line no-control-regex
  if (/[^\x01-\x7F]/.test(v)) {
    return fail('Enter the domain in punycode form (for example xn--80ak6aa92e.com). We do not convert accented or non-Latin spellings, because two spellings of one domain would break the rule that a domain belongs to one workspace only.');
  }
  if (v.length > 253) return fail('That is longer than a domain name can be (253 characters).');
  const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  const labels = v.split('.');
  if (labels.length < 2) return fail('Use the full domain, including the ending — acme.com, not acme.');
  if (!labels.every(l => LABEL.test(l))) return fail('That is not a valid domain name. Use letters, numbers and hyphens, like acme.com.');
  const tld = labels[labels.length - 1];
  if (/^\d+$/.test(tld)) return fail('That looks like an IP address. Claim the domain name your email uses instead.');
  if (UNVERIFIABLE_TLDS.includes(tld)) return fail(`“${tld}” is not a public domain ending, so its ownership cannot be proven by DNS.`);
  if (PUBLIC_EMAIL_DOMAINS.has(v)) {
    return fail(`${v} is a public email provider, so no single company can own it. Claim your own company domain instead — the one after the @ in your work email.`);
  }
  return { ok: true, value: v, error: '' };
}

function num(v: unknown): number { return typeof v === 'number' && Number.isFinite(v) ? v : 0; }
function str(v: unknown): string | null { return typeof v === 'string' && v ? v : null; }

function toDomain(raw: unknown): TenantDomain {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    id: String(r.id ?? ''),
    domain: String(r.domain ?? ''),
    status: (typeof r.status === 'string' ? r.status : 'pending') as DomainStatus,
    // list_tenant_domains returns `verification_token`; claim_tenant_domain
    // returns the same string as `record_value`. One type, both shapes.
    verification_token: str(r.verification_token) ?? str(r.record_value),
    record_name: str(r.record_name),
    verified_at: str(r.verified_at),
    last_checked_at: str(r.last_checked_at),
    last_error: str(r.last_error),
    check_count: num(r.check_count),
    failure_count: num(r.failure_count),
    created_at: str(r.created_at),
  };
}

export async function listTenantDomains(): Promise<TenantDomain[]> {
  const { data, error } = await supabase.rpc(DOMAIN_RPC.list);
  if (error) throw rpcFailure(DOMAIN_RPC.list, error);
  if (!Array.isArray(data)) {
    if (data == null) return [];
    throw new SsoError('malformed', `${DOMAIN_RPC.list} did not return a list of domains, so nothing is being shown as fact.`, { detail: JSON.stringify(data)?.slice(0, 300) ?? '' });
  }
  return data.map(toDomain);
}

export interface ClaimResult {
  domain: TenantDomain;
  /** 373 is idempotent by design so a published TXT record keeps working.
   *  Worth telling the user, so a second click does not read as a new claim. */
  already_claimed: boolean;
}

/** Claiming grants NOTHING until verification succeeds. True at every layer:
 *  373's partial unique index only covers status='verified'. */
export async function claimTenantDomain(domain: string): Promise<ClaimResult> {
  const check = normaliseDomain(domain);
  if (!check.ok) throw new SsoError('rejected', check.error);
  const { data, error } = await supabase.rpc(DOMAIN_RPC.claim, { p_domain: check.value });
  if (error) throw rpcFailure(DOMAIN_RPC.claim, error);
  const d = (data ?? {}) as Record<string, unknown>;
  if (!d.id || !d.domain) {
    throw new SsoError('malformed', `${DOMAIN_RPC.claim} answered in a shape this screen could not read, so we cannot show you the record to publish. Reload to see whether the domain was added.`, { detail: JSON.stringify(data)?.slice(0, 300) ?? '' });
  }
  return { domain: toDomain(d), already_claimed: d.already_claimed === true };
}

export interface RemoveResult { domain: string; was_verified: boolean }

export async function removeTenantDomain(domainId: string): Promise<RemoveResult> {
  const { data, error } = await supabase.rpc(DOMAIN_RPC.remove, { p_domain_id: domainId });
  if (error) throw rpcFailure(DOMAIN_RPC.remove, error);
  const d = (data ?? {}) as Record<string, unknown>;
  return { domain: String(d.domain ?? ''), was_verified: d.was_verified === true };
}

export interface VerifyResult {
  ok: boolean;
  status: DomainStatus;
  /** Already run through explainDomainReason — a sentence, never a code. */
  detail: string;
  /** The raw code, kept so support can be given the exact string. */
  reason: string;
}

export async function verifyTenantDomain(domain: string): Promise<VerifyResult> {
  const { data, error } = await supabase.functions.invoke(VERIFY_DOMAIN_FUNCTION, { body: { domain } });
  if (error) throw await invokeFailure(VERIFY_DOMAIN_FUNCTION, error);
  const d = (data ?? {}) as Record<string, unknown>;
  const status = typeof d.status === 'string' ? d.status : null;
  if (!status) {
    throw new SsoError('malformed',
      `${VERIFY_DOMAIN_FUNCTION} answered in a shape this screen could not read, so we cannot tell you whether the domain is verified. Reload the page to see its real state.`,
      { detail: JSON.stringify(data)?.slice(0, 300) ?? '' });
  }
  const reason = typeof d.reason === 'string' ? d.reason : '';
  const verified = status === 'verified';
  // The edge function composes its own sentence (its explain() interpolates the
  // record name and the number of TXT records it actually saw), so it beats
  // anything this file can say from the code alone. explainDomainReason is the
  // fallback for the paths that never reach the function — a stored last_error,
  // or a deployment where the function answers without a message.
  const serverMessage = typeof d.message === 'string' ? d.message.trim() : '';
  return {
    ok: verified,
    status,
    detail: serverMessage
      || (verified
        ? 'The record was found and matched. This domain is verified.'
        : explainDomainReason(reason) || 'The record has not been found yet. DNS can take a few hours to publish — leave it in place and check again.'),
    reason,
  };
}

/* ── SSO policy ───────────────────────────────────────────────────────────── */

/**
 * The ONLY two roles just-in-time provisioning can produce.
 *
 * This is not a UI opinion — it is a CHECK constraint:
 *   jit_default_role text NOT NULL DEFAULT 'tenant_user'
 *     CHECK (jit_default_role IN ('tenant_user','tenant_admin'))   [374:170-171]
 * so 'tenant_owner' and every platform_* role are structurally unreachable
 * through automatic provisioning, whatever this file does.
 *
 * 'tenant_user' is a REAL least-privilege level, not a label: 374 measured that
 * 232 of 332 RLS policies gate on tenant membership alone (auth_tenant_id())
 * while 34 additionally require auth_has_tenant_role(['tenant_owner',
 * 'tenant_admin']) — so a tenant_user passes the 232 and is refused by the 34.
 * Worth stating because the same audit flagged "UI advertises 7 roles, database
 * enforces 3" as a defect, and this is the opposite of that: two roles offered,
 * both enforced.
 */
export const JIT_ROLES = ['tenant_user', 'tenant_admin'] as const;
export type JitRole = typeof JIT_ROLES[number];

export const JIT_ROLE_LABELS: Record<string, string> = {
  tenant_user: 'Member — can use the workspace',
  tenant_admin: 'Administrator — can change the workspace, its people and its settings',
};

export const JIT_ROLE_DETAIL: Record<string, string> = {
  tenant_user: 'Sees and works in this workspace. Cannot change settings, cannot manage people, cannot reach the governance and security controls.',
  tenant_admin: 'Full control of this workspace, including who else gets in. Hands this to everyone the sign-in matches, automatically.',
};

/** Roles that can administer the workspace, for the warning in the UI. */
export const ADMIN_LEVEL_ROLES = new Set(['tenant_owner', 'tenant_admin', 'platform_super_admin']);

export interface SsoPolicy {
  /** false = no policy row exists yet. 374: "No row = not configured = JIT
   *  off" — absence must never read as permission. */
  configured: boolean;
  sso_required: boolean;
  jit_enabled: boolean;
  jit_default_role: string;
  /** Verified domains, live from tenant_domains — 374 deliberately does NOT
   *  cache this, so a removed domain stops admitting people immediately. */
  verified_domains: string[];
  /** Is SSO sign-in actually available on this platform? See SSO_LOGIN_LIVE. */
  sso_login_live: boolean;
  updated_at: string | null;
}

const DEFAULT_POLICY: Omit<SsoPolicy, 'verified_domains' | 'sso_login_live'> = {
  configured: false, sso_required: false, jit_enabled: false,
  jit_default_role: 'tenant_user', updated_at: null,
};

/**
 * Reads the effective policy view and the verified-domain list together.
 *
 * Both are needed and neither substitutes for the other: the view has no row
 * until an admin saves a policy, but domains can be verified before that — so
 * asking the view for the domain count would report zero for a workspace that
 * has verified domains and no policy yet.
 */
export async function getSsoPolicy(): Promise<SsoPolicy> {
  const tid = await requireTenantId();
  const [viewRes, domains] = await Promise.all([
    supabase.from(SSO_POLICY_VIEW).select('sso_required, jit_enabled, jit_default_role, updated_at').eq('tenant_id', tid).maybeSingle(),
    listTenantDomains().catch(() => [] as TenantDomain[]),
  ]);
  if (viewRes.error) throw rpcFailure(SSO_POLICY_VIEW, viewRes.error);
  const verified_domains = domains.filter(d => d.status === 'verified').map(d => d.domain);
  const row = viewRes.data as Record<string, unknown> | null;
  if (!row) return { ...DEFAULT_POLICY, verified_domains, sso_login_live: SSO_LOGIN_LIVE };
  return {
    configured: true,
    sso_required: row.sso_required === true,
    jit_enabled: row.jit_enabled === true,
    jit_default_role: typeof row.jit_default_role === 'string' ? row.jit_default_role : 'tenant_user',
    verified_domains,
    sso_login_live: SSO_LOGIN_LIVE,
    updated_at: str(row.updated_at),
  };
}

export interface SsoPolicyInput { sso_required: boolean; jit_enabled: boolean; jit_default_role: string }

/**
 * Upsert on tenant_sso_policy. tenant_id is the PRIMARY KEY (374:139), so
 * onConflict is the whole row identity.
 *
 * SENDING tenant_id IS SAFE HERE, and not because this file is careful: the
 * write policy is `FOR ALL USING (can_admin_tenant_internal(tenant_id)) WITH
 * CHECK (can_admin_tenant_internal(tenant_id))` (374:253-256). A caller who
 * substitutes another workspace's id gets a row-level-security violation from
 * Postgres. The client cannot widen its own reach by lying about this value.
 */
export async function setSsoPolicy(input: SsoPolicyInput): Promise<SsoPolicy> {
  if (!(JIT_ROLES as readonly string[]).includes(input.jit_default_role)) {
    // Would be refused by the CHECK constraint anyway; failing here gives a
    // sentence instead of a 23514 round trip.
    throw new SsoError('rejected', `“${input.jit_default_role}” is not a role automatic provisioning can grant. Choose Member or Administrator.`);
  }
  const tid = await requireTenantId();
  const { error } = await supabase.from(SSO_POLICY_TABLE).upsert({
    tenant_id: tid,
    sso_required: input.sso_required,
    jit_enabled: input.jit_enabled,
    jit_default_role: input.jit_default_role,
  }, { onConflict: 'tenant_id' });
  if (error) throw rpcFailure(SSO_POLICY_TABLE, error);
  // Re-read rather than assume: the view is the thing the rest of the system
  // acts on, and a trigger or constraint may have changed what was stored.
  return getSsoPolicy();
}

/* ── SCIM tokens ──────────────────────────────────────────────────────────── */

export interface ScimToken {
  id: string;
  /** Human label ("Okta production"). Never the secret. */
  name: string;
  /**
   * Non-secret identifier: 'dtscim_' + the first 6 hex chars of the token's
   * SHA-256 HASH (375:250). Derived from the hash, not from the token, so it
   * reveals nothing about the plaintext and is safe to render.
   */
  prefix: string | null;
  /** Opt-in: this token may claim an existing auth account that belongs to NO
   *  tenant. It can never claim an account belonging to a different tenant —
   *  that is refused unconditionally, with no flag (375:101-104). */
  allow_account_adoption: boolean;
  created_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

function toToken(raw: unknown): ScimToken {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    id: String(r.id ?? ''),
    name: String(r.name ?? 'Unnamed token'),
    prefix: str(r.prefix),
    allow_account_adoption: r.allow_account_adoption === true,
    created_at: str(r.created_at),
    last_used_at: str(r.last_used_at),
    revoked_at: str(r.revoked_at),
  };
}

/**
 * scim_tokens_list / scim_token_issue take p_tenant explicitly. Passing it is
 * safe for a reason that does not live in this file: both begin with
 * `IF coalesce(can_admin_tenant_internal(p_tenant), false) IS NOT TRUE THEN
 * RAISE` (375:236, 375:308) — note the coalesce, which is 375 deliberately
 * avoiding the fail-open NULL shape migration 369 had to remove elsewhere. A
 * caller who substitutes another workspace's id is refused by Postgres.
 */
export async function listScimTokens(): Promise<ScimToken[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase.rpc(SCIM_RPC.list, { p_tenant: tid });
  if (error) throw rpcFailure(SCIM_RPC.list, error);
  const rows = (data as { tokens?: unknown } | null)?.tokens;
  if (!Array.isArray(rows)) {
    if (data == null) return [];
    throw new SsoError('malformed', `${SCIM_RPC.list} did not return a list of tokens, so nothing is being shown as fact.`, { detail: JSON.stringify(data)?.slice(0, 300) ?? '' });
  }
  return rows.map(toToken);
}

export interface CreatedScimToken {
  token: ScimToken;
  /**
   * The plaintext bearer token. 375 stores only its SHA-256 hash (CHECK-
   * enforced) and says so at the table: the plaintext "is shown once at issue
   * and is unrecoverable afterwards".
   *
   * Everything that touches this value here is deliberate: it is never written
   * to localStorage, never put in a URL (a query string reaches browser
   * history, proxy logs and Referer headers), and never console.logged. The
   * panel holds it in component state and drops it when the reveal is
   * dismissed.
   */
  secret: string;
  /** Where the customer points their IdP. */
  scim_base_url: string;
}

export async function createScimToken(name: string, allowAccountAdoption = false): Promise<CreatedScimToken> {
  const trimmed = (name || '').trim();
  if (!trimmed) throw new SsoError('rejected', 'Give the token a name you will recognise later, such as “Okta production”.');
  if (trimmed.length > 80) throw new SsoError('rejected', 'Keep the name under 80 characters.');
  const tid = await requireTenantId();
  const { data, error } = await supabase.rpc(SCIM_RPC.issue, {
    p_tenant: tid,
    p_name: trimmed,
    p_allow_account_adoption: allowAccountAdoption,
  });
  if (error) throw rpcFailure(SCIM_RPC.issue, error);
  const d = (data ?? {}) as Record<string, unknown>;
  const secret = typeof d.token === 'string' && d.token ? d.token : null;
  if (!secret) {
    // Do NOT report success. A token the customer cannot copy is a token they
    // will have to revoke, and pretending otherwise wastes their time and
    // leaves a live credential nobody is tracking.
    throw new SsoError('malformed',
      'The server may have created a token but did not return its value, so there is nothing to copy. Check the list below and revoke anything you did not expect.',
      { detail: Object.keys(d).join(', ') });
  }
  return {
    token: toToken({
      id: d.id, name: d.name ?? trimmed, prefix: d.prefix,
      allow_account_adoption: allowAccountAdoption, created_at: new Date().toISOString(),
    }),
    secret,
    scim_base_url: SCIM_BASE_URL,
  };
}

export async function revokeScimToken(tokenId: string): Promise<void> {
  const { data, error } = await supabase.rpc(SCIM_RPC.revoke, { p_token_id: tokenId });
  if (error) throw rpcFailure(SCIM_RPC.revoke, error);
  const d = data as { ok?: boolean; error?: string; detail?: string } | null;
  if (d && typeof d === 'object' && d.ok === false) {
    throw new SsoError('rejected', String(d.detail || d.error || 'The token was not revoked.'));
  }
}

/* ── Shared UI helpers (kept here so all three panels agree) ──────────────── */

/** Plain-language next step per failure kind. Panels print message + this. */
export const SSO_KIND_GUIDANCE: Record<SsoFailureKind, string> = {
  not_deployed: 'This is a platform-side gap, not something you did. Nothing was changed. Contact us and we will finish setting it up.',
  denied: 'Only a workspace owner or administrator can change identity settings. Ask one of them to do it.',
  rejected: 'Nothing was changed. Correct the problem above and try again.',
  conflict: 'Nothing was changed. Domain ownership is exclusive on purpose — two workspaces can never hold the same verified domain.',
  unavailable: 'The request never reached our servers, so nothing was changed. It is safe to try again.',
  malformed: 'We could not read the answer, so do not assume the change took effect. Reload this page to see the real state.',
  server: 'Nothing was confirmed. Please try again, or contact us.',
};

export function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}
