/**
 * connector-zendesk — Systems-of-Record connector v1 (R2).
 *
 * Doctrine: DreamTeam never replaces the SoR. Zendesk stays the ticket
 * system of record. This function implements the three data movements:
 *   - sync_tickets  : SoR → working cache (support_tickets, upsert on
 *                     tenant+source+external_ref). Capped at 300/run.
 *   - read_ticket   : read-through — fetched live, returned, NOTHING
 *                     persisted except an audit event.
 *   - write_back    : action written INTO the SoR (add_internal_note /
 *                     update_status), audited on our side.
 *   - test          : credential check via GET /api/v2/users/me.json.
 *
 * Auth: caller JWT (tenant resolved from profiles). Credentials are read
 * with the service role from connector_secrets_decrypted, a view over
 * Vault-encrypted storage (no authenticated access, migration 088).
 * Secret format: JSON { email, api_token } — Zendesk basic auth
 * "{email}/token:{api_token}".
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { isSafeExternalUrl } from '../_shared/urlSafety.ts';
import { resolveTenantWithRemoteAccess } from '../_shared/resolveTenant.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

const SYNC_PAGE_SIZE = 100;
const SYNC_MAX_PER_RUN = 300;

// Zendesk status → support_tickets status mapping (documented):
//   new/open → open · pending/hold → pending · solved/closed → resolved
function mapStatus(zd: string): string {
  switch (zd) {
    case 'new':
    case 'open': return 'open';
    case 'pending':
    case 'hold': return 'pending';
    case 'solved':
    case 'closed': return 'resolved';
    default: return 'open';
  }
}

// Zendesk priority → p1..p4 (urgent→p1, high→p2, normal→p3, low→p4)
function mapPriority(zd: string | null): string {
  switch (zd) {
    case 'urgent': return 'p1';
    case 'high': return 'p2';
    case 'low': return 'p4';
    default: return 'p3';
  }
}

interface ZendeskCreds { email: string; api_token: string }

function authHeader(creds: ZendeskCreds): string {
  return 'Basic ' + btoa(`${creds.email}/token:${creds.api_token}`);
}

async function zdFetch(
  baseUrl: string,
  creds: ZendeskCreds,
  path: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; status: number; body: unknown; error?: string }> {
  const url = baseUrl.replace(/\/+$/, '') + path;
  if (!isSafeExternalUrl(url)) {
    return { ok: false, status: 0, body: null, error: 'blocked: refusing to fetch a non-public or internal address' };
  }
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        'Authorization': authHeader(creds),
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
  } catch (e) {
    return { ok: false, status: 0, body: null, error: `zendesk_unreachable: ${String(e)}` };
  }
  const body = await res.json().catch(() => null);
  if (res.status === 401 || res.status === 403) {
    return { ok: false, status: res.status, body, error: 'zendesk_auth_failed' };
  }
  if (!res.ok) {
    return { ok: false, status: res.status, body, error: `zendesk_error_${res.status}` };
  }
  return { ok: true, status: res.status, body };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const payload = await req.json().catch(() => ({}));
    const action: string = payload.action ?? '';
    const connectorId: string = payload.connector_id ?? '';
    if (!action) return json({ error: 'action_required' }, 400);
    if (!connectorId) return json({ error: 'connector_id_required' }, 400);

    // ── Auth: resolve the caller from their JWT ──
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: 'unauthorized' }, 401);

    const { data: profile } = await admin
      .from('profiles').select('tenant_id, layer').eq('user_id', userData.user.id).single();
    const tenantId = await resolveTenantWithRemoteAccess(admin, userData.user.id, profile?.tenant_id, profile?.layer, payload.tenant_id);
    if (!tenantId) return json({ error: 'no_tenant' }, 403);

    // ── Connector must belong to the caller's tenant ──
    const { data: connector } = await admin
      .from('connectors')
      .select('*')
      .eq('id', connectorId)
      .eq('tenant_id', tenantId)
      .single();
    if (!connector) return json({ error: 'connector_not_found' }, 404);
    if (connector.provider !== 'zendesk') return json({ error: 'unsupported_provider' }, 400);

    // ── Credentials (service-role-only view over Vault-encrypted
    // storage, migration 088) ──
    const { data: secretRow } = await admin
      .from('connector_secrets_decrypted')
      .select('secret')
      .eq('connector_id', connectorId)
      .single();
    if (!secretRow?.secret) return json({ error: 'no_credentials' }, 400);
    let creds: ZendeskCreds;
    try {
      creds = JSON.parse(secretRow.secret);
      if (!creds.email || !creds.api_token) throw new Error('bad shape');
    } catch {
      return json({ error: 'invalid_credentials_format' }, 400);
    }

    const audit = (category: string, actionText: string, detail: Record<string, unknown>) =>
      admin.rpc('append_audit_event', {
        p_tenant_id: tenantId,
        p_actor: `Zendesk connector (${connector.display_name || connector.base_url})`,
        p_actor_type: 'system',
        p_action: actionText,
        p_category: category,
        p_detail: { connector_id: connectorId, provider: 'zendesk', ...detail },
      });

    const setStatus = (status: string, lastError: string | null) =>
      admin.from('connectors')
        .update({ status, last_error: lastError })
        .eq('id', connectorId);

    // ════════ action: test ════════
    if (action === 'test') {
      const r = await zdFetch(connector.base_url, creds, '/api/v2/users/me.json');
      // Zendesk returns 200 with user:null id:null for bad tokens sometimes;
      // treat a null user id as auth failure too.
      const me = (r.body as { user?: { id?: number | null; email?: string } } | null)?.user;
      const authed = r.ok && !!me?.id;
      if (!authed) {
        const errKey = r.error ?? 'zendesk_auth_failed';
        await setStatus('error', errKey);
        return json({ ok: false, error: errKey }, 200);
      }
      await setStatus('connected', null);
      await audit('config_change', `Connector test succeeded — authenticated to ${connector.base_url} as ${me.email ?? 'unknown'}`, { result: 'connected' });
      return json({ ok: true, user_email: me.email ?? null });
    }

    // ════════ action: sync_tickets (SoR → working cache) ════════
    if (action === 'sync_tickets') {
      // per-object registry: ticket object must be enabled and in sync mode
      const { data: obj } = await admin
        .from('connector_objects')
        .select('*')
        .eq('connector_id', connectorId)
        .eq('object_type', 'ticket')
        .single();
      if (!obj || !obj.enabled) return json({ error: 'object_disabled' }, 400);
      if (obj.mode !== 'sync') return json({ error: 'object_not_in_sync_mode' }, 400);

      const sinceIso = obj.last_synced_at ?? '1970-01-01T00:00:00Z';
      const sinceEpoch = Math.floor(new Date(sinceIso).getTime() / 1000);

      let url = `/api/v2/incremental/tickets.json?start_time=${sinceEpoch}&per_page=${SYNC_PAGE_SIZE}`;
      let pulled = 0, upserted = 0, pages = 0;
      const errors: string[] = [];

      while (url && pulled < SYNC_MAX_PER_RUN) {
        const r = await zdFetch(connector.base_url, creds, url);
        if (!r.ok) {
          await setStatus('error', r.error ?? 'sync_failed');
          return json({ ok: false, error: r.error ?? 'sync_failed' }, 200);
        }
        const body = r.body as {
          tickets?: Array<Record<string, unknown>>;
          next_page?: string | null;
          end_of_stream?: boolean;
        };
        const tickets = body.tickets ?? [];
        pages++;
        for (const t of tickets) {
          if (pulled >= SYNC_MAX_PER_RUN) break;
          pulled++;
          // Account match: requester org external_ref when present, else null.
          let accountId: string | null = null;
          const orgId = t.organization_id != null ? String(t.organization_id) : null;
          if (orgId) {
            const { data: acct } = await admin
              .from('customer_accounts')
              .select('id')
              .eq('tenant_id', tenantId)
              .eq('external_ref', orgId)
              .maybeSingle();
            accountId = acct?.id ?? null;
          }
          const row = {
            tenant_id: tenantId,
            account_id: accountId,
            subject: String(t.subject ?? t.raw_subject ?? '(no subject)'),
            body: String(t.description ?? ''),
            status: mapStatus(String(t.status ?? 'open')),
            priority: mapPriority(t.priority == null ? null : String(t.priority)),
            source: 'zendesk',
            external_ref: String(t.id),
          };
          const { error: upErr } = await admin
            .from('support_tickets')
            .upsert(row, { onConflict: 'tenant_id,source,external_ref' });
          if (upErr) errors.push(`ticket ${t.id}: ${upErr.message}`);
          else upserted++;
        }
        if (body.end_of_stream || !body.next_page || tickets.length === 0) break;
        url = body.next_page.replace(connector.base_url.replace(/\/+$/, ''), '');
      }

      const now = new Date().toISOString();
      await admin.from('connector_objects')
        .update({ last_synced_at: now }).eq('id', obj.id);
      await admin.from('connectors')
        .update({ status: 'connected', last_sync_at: now, last_error: errors.length ? errors[0] : null })
        .eq('id', connectorId);
      await audit('connector_sync',
        `Zendesk ticket sync — pulled ${pulled}, upserted ${upserted} into working cache (${pages} page${pages === 1 ? '' : 's'})`,
        { pulled, upserted, pages, errors: errors.slice(0, 5), since: sinceIso, cap: SYNC_MAX_PER_RUN });
      return json({ ok: true, pulled, upserted, pages, errors });
    }

    // ════════ action: read_ticket (read-through — nothing persisted) ════════
    if (action === 'read_ticket') {
      const ref = String(payload.external_ref ?? '').trim();
      if (!ref) return json({ error: 'external_ref_required' }, 400);
      const r = await zdFetch(connector.base_url, creds, `/api/v2/tickets/${encodeURIComponent(ref)}.json`);
      if (!r.ok) return json({ ok: false, error: r.error ?? 'read_failed' }, 200);
      // Persist NOTHING but the audit record — this is the read-through contract.
      await audit('connector_sync',
        `Read-through access — Zendesk ticket #${ref} fetched live, not persisted`,
        { mode: 'read_through', external_ref: ref, persisted: false });
      return json({ ok: true, ticket: (r.body as { ticket?: unknown })?.ticket ?? r.body, persisted: false });
    }

    // ════════ action: write_back (action INTO the SoR) ════════
    if (action === 'write_back') {
      const ref = String(payload.external_ref ?? '').trim();
      const op = String(payload.op ?? '');
      const p = (payload.payload ?? {}) as Record<string, unknown>;
      if (!ref) return json({ error: 'external_ref_required' }, 400);
      if (op !== 'add_internal_note' && op !== 'update_status') return json({ error: 'unsupported_op' }, 400);

      // write-back registry: op must be enabled
      const { data: act } = await admin
        .from('connector_actions')
        .select('enabled')
        .eq('connector_id', connectorId)
        .eq('action_key', op)
        .maybeSingle();
      if (!act || !act.enabled) return json({ error: 'action_disabled' }, 400);

      let zdBody: Record<string, unknown>;
      if (op === 'add_internal_note') {
        const note = String(p.note ?? '').trim();
        if (!note) return json({ error: 'note_required' }, 400);
        zdBody = { ticket: { comment: { body: note, public: false } } };
      } else {
        const status = String(p.status ?? '');
        if (!['open', 'pending', 'hold', 'solved'].includes(status)) {
          return json({ error: 'invalid_status' }, 400);
        }
        zdBody = { ticket: { status } };
      }

      const r = await zdFetch(connector.base_url, creds, `/api/v2/tickets/${encodeURIComponent(ref)}.json`, {
        method: 'PUT',
        body: JSON.stringify(zdBody),
      });
      if (!r.ok) return json({ ok: false, error: r.error ?? 'write_back_failed' }, 200);

      await audit('connector_action',
        op === 'add_internal_note'
          ? `Write-back — internal note added to Zendesk ticket #${ref}`
          : `Write-back — Zendesk ticket #${ref} status set to ${String(p.status)}`,
        { op, external_ref: ref, payload: p });
      return json({ ok: true, op, external_ref: ref });
    }

    return json({ error: 'unknown_action' }, 400);
  } catch (err) {
    console.error('connector-zendesk error:', err);
    return json({ error: String(err) }, 500);
  }
});
