/**
 * scim — SCIM 2.0 user provisioning for enterprise customers.
 *
 * WHY THIS EXISTS
 * "How do you deprovision a leaver?" is the question that follows "do you
 * support SSO?" in every enterprise security review, and today the honest
 * answer is that a human opens the Team page and clicks. This endpoint lets the
 * customer's own Okta or Entra do it — the moment HR terminates someone in the
 * IdP, they lose access here, with no human in the loop.
 *
 * It is OUR endpoint, not Supabase's, so it is independent of the Supabase
 * plan. SAML is currently blocked (saml_enabled=false, free plan); SCIM is not,
 * and works the day it is deployed.
 *
 * ── DEPLOYMENT: verify_jwt MUST BE FALSE ───────────────────────────────────
 *   node scripts/deploy.mjs --no-migrations --fn scim
 * Okta and Entra send THEIR bearer token, not a Supabase JWT. With verify_jwt
 * left on, the platform rejects every request before this code runs and the
 * IdP sees a uniform 401 it cannot diagnose. The token is authenticated by
 * scim_token_context() in the database instead — see migration 375.
 *
 * ── WHERE THE SECURITY ACTUALLY LIVES ──────────────────────────────────────
 * NOT HERE. This function holds the service-role key, and service_role bypasses
 * RLS, so nothing it does is constrained by policy. Every tenant decision is
 * therefore delegated to migration 375's functions, which take the bearer token
 * and NO tenant argument — the tenant is derived from the token's sha256 inside
 * Postgres on every single call. There is no variable in this file that names a
 * tenant, because there is no parameter through which one could be passed. A
 * bug in this file cannot widen a tenant boundary; it can only fail.
 *
 * The one thing this file must get right is not swallowing a refusal: every RPC
 * result goes through unwrap(), which treats a missing or false `ok` as a
 * failure. Fail-closed by construction, in one place.
 *
 * ── DELIBERATE DEVIATIONS FROM RFC 7643/7644 ───────────────────────────────
 * Stated because a half-spec endpoint fails Okta's and Entra's validators, and
 * a silent deviation is worse than a documented one.
 *   1. DELETE is a soft delete. RFC 7644 §3.6 permits this provided a later GET
 *      returns 404, which it does. Access is revoked identically either way;
 *      the record survives so audit attribution and rehire do too. Full
 *      reasoning at scim_user_delete in migration 375.
 *   2. NO /Groups. Returns 501. SCIM assigns no role here — provisioned users
 *      get 'agent', the same default handle_new_user() gives every signup.
 *      An IdP-driven role grant without a group model is a privilege
 *      escalation channel; elevation stays a human action in the app.
 *   3. userName MUST be an email. Supabase Auth is keyed on email, so a
 *      non-email userName could never be matched to an account.
 *   4. Changing userName updates the SCIM record but NOT the login email in
 *      auth.users. Repointing a live credential at an address the IdP operator
 *      may not control is not something a provisioning API should be able to do.
 *   5. POST /Users refuses (409) an email whose account belongs to another
 *      workspace, and — unless the token opts in to account adoption — an
 *      account that belongs to no workspace at all. This is the anti-takeover
 *      rule and it is enforced in the database, not here.
 *   6. PATCH/DELETE refuse (400 mutability) to deactivate a workspace's last
 *      remaining administrator, so an IdP cannot leave a workspace nobody can
 *      administer.
 *   7. Only `eq` filters, on userName and externalId. Anything else is a
 *      400/invalidFilter, which is the spec's own answer for an unsupported
 *      filter. These are the only filters Okta and Entra actually send for
 *      user reconciliation.
 *
 * No outbound HTTP leaves this function except to Supabase's own API, so the
 * SSRF helpers in _shared/urlSafety.ts do not apply here.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { durableRateLimited, clientIp } from '../_shared/rateLimit.ts';
import { reportEdgeError } from '../_shared/errorReport.ts';

const SCIM_CT = 'application/scim+json;charset=utf-8';

// No wildcard CORS with credentials, and no browser is meant to call this: SCIM
// is server-to-server from the IdP. OPTIONS is answered only so a misconfigured
// proxy's preflight does not look like an outage.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
};

const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';

function scimJson(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': SCIM_CT, ...extra },
  });
}

/** RFC 7644 §3.12 error envelope. `status` is a STRING in SCIM, not a number. */
function scimError(status: number, detail: string, scimType?: string) {
  const body: Record<string, unknown> = {
    schemas: [ERROR_SCHEMA],
    status: String(status),
    detail,
  };
  if (scimType) body.scimType = scimType;
  return scimJson(
    body,
    status,
    status === 401 ? { 'WWW-Authenticate': 'Bearer realm="scim"' } : {},
  );
}

/**
 * The single place an RPC result is trusted.
 *
 * Every migration-375 function returns {ok:true,...} or {ok:false,error:...}.
 * Anything that is not explicitly ok — including a transport error, a null, or
 * a shape this code does not recognise — becomes a refusal. The failure mode of
 * a mistake here is "the IdP gets an error", never "the operation proceeded
 * unchecked".
 */
type Unwrapped = { ok: true; data: Record<string, unknown> } | { ok: false; res: Response };

function unwrap(data: unknown, error: { message?: string } | null): Unwrapped {
  if (error) {
    // The RPC name and message are safe to log; no token or payload is included.
    console.error('scim rpc error:', error.message);
    return { ok: false, res: scimError(500, 'provisioning backend error') };
  }
  const d = (data ?? null) as Record<string, unknown> | null;
  if (!d || typeof d !== 'object') {
    return { ok: false, res: scimError(500, 'provisioning backend returned no result') };
  }
  if (d.ok === true) return { ok: true, data: d };

  const detail = typeof d.detail === 'string' ? d.detail : undefined;
  switch (d.error) {
    case 'unauthorized':
      return { ok: false, res: scimError(401, 'invalid or revoked SCIM token') };
    case 'not_found':
      return { ok: false, res: scimError(404, 'resource not found') };
    case 'conflict':
      return { ok: false, res: scimError(409, detail ?? 'resource already exists', 'uniqueness') };
    case 'invalid_username':
      return {
        ok: false,
        res: scimError(400, detail ?? 'userName must be the user\'s email address', 'invalidValue'),
      };
    case 'last_admin':
      // 400 + mutability, not 409: RFC 7644 §3.12's table pairs 409 with
      // uniqueness only, and this is a mutability restriction on the target.
      return { ok: false, res: scimError(400, detail ?? 'refusing to remove the last administrator', 'mutability') };
    default:
      return { ok: false, res: scimError(500, 'provisioning backend refused the request') };
  }
}

// ── SCIM request parsing ────────────────────────────────────────────────────

/** `userName eq "a@b.com"` → {attr, value}. Nothing else is accepted. */
function parseFilter(raw: string | null): { attr: string; value: string } | 'unsupported' | null {
  if (!raw || !raw.trim()) return null;
  const m = raw.trim().match(/^(\w+)\s+eq\s+["']([^"']*)["']$/i);
  if (!m) return 'unsupported';
  const attr = m[1].toLowerCase();
  if (attr !== 'username' && attr !== 'externalid') return 'unsupported';
  return { attr: attr === 'username' ? 'userName' : 'externalId', value: m[2] };
}

/**
 * Flatten a SCIM PatchOp into the flat object scim_user_patch expects.
 *
 * Okta and Entra do not agree on the wire format and both are in the wild:
 *   Okta   {"op":"replace","value":{"active":false}}          (no path)
 *   Entra  {"op":"Replace","path":"active","value":"False"}   (capitalised op,
 *                                                              stringified bool)
 *   either {"op":"replace","path":"name.givenName","value":"Ada"}
 * Accepting only one of these is the single most common reason a SCIM
 * integration "works in testing" and fails against the customer's real tenant.
 */
function flattenPatch(body: Record<string, unknown>): Record<string, unknown> | null {
  const ops = body?.Operations ?? (body as Record<string, unknown>)?.operations;
  if (!Array.isArray(ops) || ops.length === 0) return null;

  const out: Record<string, unknown> = {};
  const put = (path: string, value: unknown) => {
    const p = path.replace(/^urn:[^:]+:[^:]+:[^:]+:[^:]+:[^:]+:/i, '').toLowerCase();
    switch (p) {
      case 'active': out.active = toBool(value); break;
      case 'username': out.userName = String(value ?? ''); break;
      case 'externalid': out.externalId = String(value ?? ''); break;
      case 'displayname': out.displayName = String(value ?? ''); break;
      case 'name.givenname': out.givenName = String(value ?? ''); break;
      case 'name.familyname': out.familyName = String(value ?? ''); break;
      case 'name':
        if (value && typeof value === 'object') {
          const n = value as Record<string, unknown>;
          if (n.givenName != null) out.givenName = String(n.givenName);
          if (n.familyName != null) out.familyName = String(n.familyName);
        }
        break;
      default: break; // unknown attributes are ignored, per RFC 7644 §3.5.2
    }
  };

  for (const raw of ops) {
    const op = raw as Record<string, unknown>;
    const verb = String(op.op ?? '').toLowerCase();
    // 'remove' is not honoured for these attributes: the only removal an IdP
    // means here is deactivation, and it has an explicit spelling (active:false).
    if (verb !== 'replace' && verb !== 'add') continue;

    const path = typeof op.path === 'string' ? op.path : '';
    if (path) {
      put(path, op.value);
    } else if (op.value && typeof op.value === 'object' && !Array.isArray(op.value)) {
      for (const [k, v] of Object.entries(op.value as Record<string, unknown>)) put(k, v);
    }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The SCIM id is a uuid on our side. An IdP that has a stale or mangled id must
 * get the spec's answer (404) rather than a 500: the RPC's `p_id uuid` cast
 * would fail on anything else, and unwrap() would correctly but unhelpfully
 * call that a backend error. Okta retries 5xx and gives up on 404, so the
 * difference decides whether a bad id loops forever.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Entra sends "False"/"True" as strings often enough that === false is a bug. */
function toBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.trim().toLowerCase() === 'true';
  return Boolean(v);
}

/** Pull the primary email out of a SCIM User body when userName is absent. */
function bodyUserName(body: Record<string, unknown>): string {
  const un = typeof body.userName === 'string' ? body.userName.trim() : '';
  if (un) return un;
  const emails = Array.isArray(body.emails) ? body.emails : [];
  const primary = emails.find((e) => e && typeof e === 'object' && (e as Record<string, unknown>).primary);
  const first = primary ?? emails[0];
  const v = first && typeof first === 'object' ? (first as Record<string, unknown>).value : '';
  return typeof v === 'string' ? v.trim() : '';
}

/** meta.location needs the request URL, which the database cannot know. */
function withLocation(resource: unknown, base: string): unknown {
  if (!resource || typeof resource !== 'object') return resource;
  const r = resource as Record<string, unknown>;
  const meta = (r.meta && typeof r.meta === 'object' ? { ...(r.meta as object) } : {}) as Record<string, unknown>;
  meta.location = `${base}/Users/${r.id}`;
  return { ...r, meta };
}

// ── Static discovery documents ──────────────────────────────────────────────
// Declared honestly: `supported:false` for everything not implemented. Claiming
// a capability the endpoint does not have is how a validator passes and the
// real integration then breaks on the customer's tenant.
function serviceProviderConfig(base: string) {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    documentationUri: 'https://datatracker.ietf.org/doc/html/rfc7644',
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{
      type: 'oauthbearertoken',
      name: 'OAuth Bearer Token',
      description: 'Authentication via a workspace-scoped SCIM bearer token',
      specUri: 'https://datatracker.ietf.org/doc/html/rfc6750',
      primary: true,
    }],
    meta: { resourceType: 'ServiceProviderConfig', location: `${base}/ServiceProviderConfig` },
  };
}

function resourceTypes(base: string) {
  const user = {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
    id: 'User',
    name: 'User',
    endpoint: '/Users',
    description: 'User Account',
    schema: USER_SCHEMA,
    schemaExtensions: [],
    meta: { resourceType: 'ResourceType', location: `${base}/ResourceTypes/User` },
  };
  return {
    schemas: [LIST_SCHEMA],
    totalResults: 1, startIndex: 1, itemsPerPage: 1,
    Resources: [user],
  };
}

function schemas(base: string) {
  const attr = (
    name: string, type: string, required = false,
    mutability = 'readWrite', uniqueness = 'none', subAttributes?: unknown[],
  ) => ({
    name, type, multiValued: false, required, caseExact: false,
    mutability, returned: 'default', uniqueness,
    ...(subAttributes ? { subAttributes } : {}),
  });
  const user = {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'],
    id: USER_SCHEMA,
    name: 'User',
    description: 'User Account',
    attributes: [
      attr('userName', 'string', true, 'readWrite', 'server'),
      attr('name', 'complex', false, 'readWrite', 'none', [
        attr('givenName', 'string'), attr('familyName', 'string'), attr('formatted', 'string'),
      ]),
      attr('displayName', 'string'),
      attr('active', 'boolean'),
      attr('externalId', 'string'),
      { ...attr('emails', 'complex'), multiValued: true },
    ],
    meta: { resourceType: 'Schema', location: `${base}/Schemas/${USER_SCHEMA}` },
  };
  return {
    schemas: [LIST_SCHEMA],
    totalResults: 1, startIndex: 1, itemsPerPage: 1,
    Resources: [user],
  };
}

// ── Deprovisioning: the auth-session half ───────────────────────────────────
/**
 * BEST EFFORT, and the honest statement of what it adds.
 *
 * The real revocation already happened in the database: profiles.is_active =
 * false makes auth_tenant_id() return NULL, and 232 RLS policies call it, so
 * the leaver's very next query against any tenant table returns nothing — with
 * the access token they are already holding, no session cleanup required.
 *
 * What THIS closes is the residual hour in which that already-issued access
 * token still authenticates (it just cannot see anything) and could be
 * refreshed. Banning the auth user stops the refresh and any new sign-in.
 *
 * It is best effort because it must not be able to fail the deprovision: the
 * database transaction that revoked access has already committed by the time
 * this runs, and reporting a 500 to the IdP would make Okta retry an operation
 * that already succeeded.
 */
async function setAuthBan(admin: SupabaseClient, userId: string | null, banned: boolean) {
  if (!userId) return;
  try {
    await admin.auth.admin.updateUserById(userId, {
      // GoTrue expects a duration string; 'none' lifts an existing ban.
      ban_duration: banned ? '876000h' : 'none',
    } as { ban_duration: string });
  } catch (e) {
    console.error(`scim: could not ${banned ? 'ban' : 'unban'} auth user ${userId}:`, e);
  }
}

// ── Router ──────────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  let admin: SupabaseClient | null = null;
  try {
    const url = new URL(req.url);
    // The function may be mounted with or without a path prefix depending on
    // how the customer's IdP is configured; anchor on the function name.
    const idx = url.pathname.indexOf('/scim');
    const rest = idx >= 0 ? url.pathname.slice(idx + '/scim'.length) : url.pathname;
    const segments = rest.split('/').filter(Boolean).map(decodeURIComponent);
    const base = `${url.origin}${url.pathname.slice(0, idx >= 0 ? idx + '/scim'.length : url.pathname.length)}`;

    admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Volume limiter. The token is 256 bits of entropy so this is not what
    // protects the secret — it is what stops a misconfigured IdP sync loop or a
    // scripted probe from burning the database.
    const ip = clientIp(req);
    if (ip && await durableRateLimited(admin, `scim:${ip}`, 600, 60)) {
      return scimError(429, 'too many requests');
    }

    // ── Discovery: unauthenticated on purpose (RFC 7644 §2 allows it) ──
    // These documents are identical for every tenant and reveal nothing about
    // any of them, and an IdP commonly fetches them before the token is saved.
    const head = segments[0] ?? '';
    if (req.method === 'GET' && head === 'ServiceProviderConfig') {
      return scimJson(serviceProviderConfig(base));
    }
    if (req.method === 'GET' && head === 'ResourceTypes') return scimJson(resourceTypes(base));
    if (req.method === 'GET' && head === 'Schemas') return scimJson(schemas(base));

    if (head === 'Groups') {
      return scimError(
        501,
        'group provisioning is not implemented; roles are managed in the workspace, not by the identity provider',
      );
    }
    if (head !== 'Users') return scimError(404, 'unknown SCIM endpoint');

    // ── Everything below requires the bearer token ──
    const auth = req.headers.get('Authorization') ?? '';
    const token = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim() ?? '';
    if (!token) {
      return scimError(401, 'a SCIM bearer token is required');
    }
    // Tighter bucket for callers that keep arriving without a usable token —
    // the signature of a probe rather than of an IdP.
    if (ip && await durableRateLimited(admin, `scim-auth:${ip}`, 60, 60)) {
      return scimError(429, 'too many requests');
    }

    const id = segments[1] ?? '';
    if (segments.length > 2) return scimError(404, 'unknown SCIM endpoint');
    if (id && !UUID_RE.test(id)) return scimError(404, 'resource not found');

    // ── GET /Users  and  GET /Users/{id} ──
    if (req.method === 'GET') {
      if (!id) {
        const parsed = parseFilter(url.searchParams.get('filter'));
        if (parsed === 'unsupported') {
          return scimError(
            400,
            'only `userName eq "..."` and `externalId eq "..."` filters are supported',
            'invalidFilter',
          );
        }
        const startIndex = Number(url.searchParams.get('startIndex') ?? '1');
        const count = Number(url.searchParams.get('count') ?? '100');
        const { data, error } = await admin.rpc('scim_users_list', {
          p_token: token,
          p_user_name: parsed?.attr === 'userName' ? parsed.value : null,
          p_external_id: parsed?.attr === 'externalId' ? parsed.value : null,
          p_start_index: Number.isFinite(startIndex) ? startIndex : 1,
          p_count: Number.isFinite(count) ? count : 100,
        });
        const r = unwrap(data, error);
        if (!r.ok) return r.res;
        const resources = (r.data.resources as unknown[]) ?? [];
        return scimJson({
          schemas: [LIST_SCHEMA],
          totalResults: r.data.totalResults,
          startIndex: r.data.startIndex,
          itemsPerPage: r.data.itemsPerPage,
          Resources: resources.map((x) => withLocation(x, base)),
        });
      }

      const { data, error } = await admin.rpc('scim_user_get', { p_token: token, p_id: id });
      const r = unwrap(data, error);
      if (!r.ok) return r.res;
      return scimJson(withLocation(r.data.resource, base));
    }

    // ── POST /Users ──
    if (req.method === 'POST' && !id) {
      let body: Record<string, unknown>;
      try {
        body = await req.json();
      } catch {
        return scimError(400, 'request body is not valid JSON', 'invalidSyntax');
      }

      const userName = bodyUserName(body);
      if (!userName) return scimError(400, 'userName is required', 'invalidValue');

      const name = (body.name ?? {}) as Record<string, unknown>;
      const given = typeof name.givenName === 'string' ? name.givenName : null;
      const family = typeof name.familyName === 'string' ? name.familyName : null;
      const externalId = typeof body.externalId === 'string' ? body.externalId : null;
      const active = body.active === undefined ? true : toBool(body.active);

      // Step 1 — ask the database what this userName means for THIS token's
      // tenant. It decides; this function never does.
      const begin = await admin.rpc('scim_provision_begin', {
        p_token: token,
        p_user_name: userName,
      });
      const b = unwrap(begin.data, begin.error);
      if (!b.ok) return b.res;

      let authUserId = (b.data.user_id as string | null) ?? null;

      if (b.data.mode === 'create') {
        // createUser, not inviteUserByEmail, for two reasons. Only createUser
        // accepts app_metadata, which is writable solely by the service role and
        // is therefore trustworthy provenance that step 2 re-checks. And a SCIM
        // shadow account is not an invitation: the user signs in through the
        // customer's IdP (or the workspace's own invite flow), not through an
        // email this endpoint sends unprompted to whatever address the IdP named.
        const created = await admin.auth.admin.createUser({
          email: userName,
          email_confirm: false,
          user_metadata: {
            full_name: [given, family].filter(Boolean).join(' ') || null,
          },
          app_metadata: {
            provisioned_by: 'scim',
            // Read back by scim_user_upsert. Not a tenant the caller can choose:
            // it is echoed from what scim_provision_begin derived from the token.
            scim_tenant: b.data.tenant_id ?? null,
          },
        });
        if (created.error || !created.data?.user) {
          const msg = created.error?.message ?? 'could not create the account';
          // GoTrue says "already been registered" when the email was taken
          // between step 1 and here — a genuine race, and 409 is the right answer.
          if (/already/i.test(msg)) {
            return scimError(409, 'a user with this userName already exists', 'uniqueness');
          }
          console.error('scim createUser failed:', msg);
          return scimError(500, 'could not create the account');
        }
        authUserId = created.data.user.id;
        // handle_new_user() has now inserted a profile with tenant_id = NULL and
        // role = 'agent' — its normal, untouched behaviour. Until step 2 claims
        // that row the account is a member of nothing and can read nothing, so
        // failing between here and there leaves an inert account, not a leak.
      }

      if (!authUserId) {
        console.error('scim: provision_begin returned no user_id for mode', b.data.mode);
        return scimError(500, 'could not resolve the account to provision');
      }

      // Step 2 — link it. Re-derives every decision step 1 made rather than
      // trusting the mode it returned: the two calls are separate round trips
      // with an account creation in between, which is a TOCTOU window.
      const { data, error } = await admin.rpc('scim_user_upsert', {
        p_token: token,
        p_user_id: authUserId,
        p_user_name: userName,
        p_external_id: externalId,
        p_given_name: given,
        p_family_name: family,
        p_active: active,
      });
      const r = unwrap(data, error);
      if (!r.ok) return r.res;

      if (!active) await setAuthBan(admin, authUserId, true);

      const resource = withLocation(r.data.resource, base) as Record<string, unknown>;
      return scimJson(resource, r.data.created ? 201 : 200, {
        Location: `${base}/Users/${resource.id}`,
      });
    }

    // ── PATCH /Users/{id} ──
    if (req.method === 'PATCH' && id) {
      let body: Record<string, unknown>;
      try {
        body = await req.json();
      } catch {
        return scimError(400, 'request body is not valid JSON', 'invalidSyntax');
      }
      const changes = flattenPatch(body);
      if (!changes) {
        return scimError(400, 'no supported attributes in the PatchOp', 'invalidPath');
      }

      const { data, error } = await admin.rpc('scim_user_patch', {
        p_token: token,
        p_id: id,
        p_changes: changes,
      });
      const r = unwrap(data, error);
      if (!r.ok) return r.res;

      // Okta deprovisions with PATCH active:false far more often than DELETE,
      // so this path must revoke exactly as hard as DELETE does.
      const resource = r.data.resource as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(changes, 'active')) {
        // auth_user_id comes back FROM the RPC rather than from a table read
        // here. A `.from('scim_user_links').eq('id', id)` would run as
        // service_role and so would not be constrained by the token's tenant —
        // the one place this file could reach a row it was not authorised for.
        await setAuthBan(admin, (r.data.auth_user_id as string | null) ?? null, !toBool(resource?.active));
      }

      return scimJson(withLocation(resource, base));
    }

    // ── DELETE /Users/{id} ──
    if (req.method === 'DELETE' && id) {
      const { data, error } = await admin.rpc('scim_user_delete', { p_token: token, p_id: id });
      const r = unwrap(data, error);
      if (!r.ok) return r.res;

      await setAuthBan(admin, (r.data.auth_user_id as string | null) ?? null, true);
      return new Response(null, { status: 204, headers: CORS });
    }

    return scimError(405, `${req.method} is not supported on this resource`);
  } catch (err) {
    console.error('scim error:', err);
    await reportEdgeError('scim', err, {});
    // No err detail in the response: this endpoint is reachable by anyone
    // holding any tenant's token and an exception message can carry SQL text.
    return scimError(500, 'internal error');
  }
});
