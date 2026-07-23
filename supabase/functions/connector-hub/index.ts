/**
 * connector-hub — multi-system SoR connector layer (migration 026).
 *
 * Generalizes the connector-zendesk pattern behind one adapter interface.
 * As of 2026-07-22 (W4-A header correction, docs/16) the registry holds
 * ~68 native adapters + category-op translators + generic_rest + template
 * adapters — every user-selectable provider has real HTTP-calling code.
 *
 * Actions:
 *   test          — credential/reachability check; sets connector status
 *   search        — { query } → normalized items [{ref,title,snippet,url}]
 *                   READ-THROUGH: fetched live, returned, NOTHING persisted
 *                   except the audit event.
 *   fetch_record  — { record_type, external_ref } → one record, read-through
 *   list_recent   — { record_type? } → recent items, read-through
 *   category_op   — THE CATEGORY CONTRACT (migration 027): the app
 *                   speaks category language ({op, params}); the op is
 *                   validated against the connector's category
 *                   (op_not_legal_for_category), translated to the
 *                   provider adapter (op_not_supported when the
 *                   provider honestly can't), results normalized to
 *                   the canonical shape with the customer's field_map
 *                   applied. Read-through: nothing persisted but audit.
 *   health_check  — runs test() and updates call-driven health fields
 *                   (last_ok_at / last_error_at / consecutive_failures;
 *                   health computed: healthy/degraded/down/never_connected).
 *                   Every other action also updates health on its way out.
 *   sync          — knowledge-capable providers (confluence, intercom,
 *                   salesforce knowledge, zendesk help center) ingest
 *                   articles/pages into knowledge_docs (source='connector',
 *                   external_ref) + chunk/embed via gte-small — the same
 *                   path ingest-chunks uses. REFUSED server-side when the
 *                   connector's access_mode is 'fetch_only' (the customer
 *                   said "never store"); that refusal is the doctrine.
 *   preview_action — THE GENERALIZED ACTION LAYER (migration 035), preview
 *                   half: { action_key, params, subject_kind?, subject_id? }
 *                   → resolves the action_definition, validates params,
 *                   RENDERS the exact request (method/URL/body) via
 *                   renderAction (template provider) or a native
 *                   provider's preview branch — WITHOUT calling the
 *                   external system. Returns a plain-language receipt
 *                   preview ("This will change ticket #4521's status
 *                   from Open to Resolved"). No side effects beyond a
 *                   lightweight action_executions row (mode='preview').
 *   execute_action — the execute half. Order: (1) data_access_grants
 *                   write_back check (resolve_access, same as Scribe),
 *                   (2) decide_action_execution (destructive-always-
 *                   gates, THEN guardrail-always-wins, THEN trust-
 *                   narrows-within-it — same composition family as
 *                   generateInvoice/decide_inquiry_triage), (3) on
 *                   auto-execute or human-approved re-entry: actually
 *                   calls the external system and records a plain-
 *                   language RECEIPT (never raw JSON) on the audit
 *                   event, the action_executions row, and the
 *                   human_task if one existed.
 *
 * Auth: caller JWT → tenant, or service-role key + body.tenant_id
 * (evidence pipeline path). Credentials come from connector_secrets
 * (service-role-only table; the client can never read them back).
 *
 * DATA ACCESS GRANTS (migration 029): calls made ON BEHALF OF a machine
 * subject carry subject_kind ('de'|'specialist') + subject_id; every
 * data action then requires a server-side grant (resolve_access,
 * default-deny). search/list_recent → 'search', fetch/get ops → 'read',
 * sync → 'ingest'. Denials return structured `access_denied` and are
 * audited (data_access_denied). Human wizard calls carry no subject.
 *
 * HONESTY NOTES (corrected 2026-07-22): every adapter is shaped to its
 * provider's documented REST API, but MOST remain unverified against live
 * instances until real tenant credentials exist — "implemented" means the
 * code path is real, not that it has been proven on a live account.
 * Verified live so far: zendesk, generic_rest. sharepoint HAS a full
 * Graph adapter (an older note here claimed otherwise).
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  SystemCategory, CanonicalItem, getCategoryOp, legalOps, computeHealth,
} from '../_shared/categoryContracts.ts';
import {
  AdapterDefinition, AdapterActionBinding, AUTH_META, validateAdapterDefinition,
  walkPath, renderTemplate, renderBody, renderAction,
} from '../_shared/adapterTemplates.ts';
import { isSafeExternalUrl } from '../_shared/urlSafety.ts';
import { OAUTH_PROVIDERS } from '../_shared/oauthProviders.ts';
import { extractText, getDocumentProxy } from 'https://esm.sh/unpdf@0.12.1';
import { resolveTenantWithRemoteAccess } from '../_shared/resolveTenant.ts';
import { contentHash } from '../_shared/contentHash.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

// ── Normalized result shape every adapter returns ──
export interface HubItem {
  ref: string;          // the SoR's own id
  type: string;         // ticket | case | page | issue | article | account | record | conversation
  title: string;
  snippet: string;      // ≤400 chars for transport; evidence persists ≤200
  url: string | null;
  raw?: unknown;        // full payload — returned, NEVER persisted
}
interface AdapterResult { ok: boolean; items?: HubItem[]; error?: string; detail?: string }
interface TestResult { ok: boolean; error?: string; detail?: string }
interface SyncDoc { external_ref: string; title: string; content: string; url: string | null }
interface SyncResult { ok: boolean; docs?: SyncDoc[]; error?: string; detail?: string }

interface Ctx {
  baseUrl: string;
  secret: Record<string, string>;
  config: Record<string, unknown>;
  // Set for user-OAuth connectors so the token-refresh helper can persist a
  // freshly refreshed access token back to this connector.
  connectorId?: string;
  admin?: SupabaseClient;
  // Set for the DreamTeam self-connector so its self-management executors
  // know which tenant they are building machinery for.
  tenantId?: string;
}

const clip = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const stripHtml = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

async function httpJson(url: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; body: unknown; error?: string }> {
  if (!isSafeExternalUrl(url)) {
    return { ok: false, status: 0, body: null, error: 'blocked: refusing to fetch a non-public or internal address' };
  }
  try {
    const res = await fetch(url, init);
    const body = await res.json().catch(() => null);
    if (res.status === 401 || res.status === 403) return { ok: false, status: res.status, body, error: 'auth_failed' };
    if (!res.ok) return { ok: false, status: res.status, body, error: `http_${res.status}` };
    return { ok: true, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: null, error: `unreachable: ${String(e).slice(0, 140)}` };
  }
}

// ════════════════════════════════════════════════════════════════
// ADAPTERS — one interface: test / search / fetchRecord / listRecent
// (+ syncDocs for knowledge-capable providers)
// ════════════════════════════════════════════════════════════════

// ── zendesk ── secrets: { email, api_token } ──
const zendesk = {
  auth: (c: Ctx) => 'Basic ' + btoa(`${c.secret.email}/token:${c.secret.api_token}`),
  async test(c: Ctx): Promise<TestResult> {
    const r = await httpJson(`${c.baseUrl}/api/v2/users/me.json`, { headers: { Authorization: this.auth(c) } });
    const me = (r.body as { user?: { id?: number | null; email?: string } } | null)?.user;
    if (!r.ok || !me?.id) return { ok: false, error: r.error ?? 'auth_failed' };
    return { ok: true, detail: `authenticated as ${me.email ?? 'unknown'}` };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const r = await httpJson(`${c.baseUrl}/api/v2/search.json?query=${encodeURIComponent(query)}&per_page=10`,
      { headers: { Authorization: this.auth(c) } });
    if (!r.ok) return { ok: false, error: r.error };
    const results = (r.body as { results?: Array<Record<string, unknown>> })?.results ?? [];
    return {
      ok: true,
      items: results.slice(0, 10).map((t) => ({
        ref: String(t.id ?? ''), type: String(t.result_type ?? 'ticket'),
        title: clip(t.subject ?? t.title ?? t.name ?? '(untitled)', 160),
        snippet: clip(t.description ?? t.body ?? '', 400),
        url: t.url ? String(t.url).replace('/api/v2/tickets/', '/agent/tickets/').replace('.json', '') : null,
        raw: t,
      })),
    };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const r = await httpJson(`${c.baseUrl}/api/v2/tickets/${encodeURIComponent(ref)}.json`, { headers: { Authorization: this.auth(c) } });
    if (!r.ok) return { ok: false, error: r.error };
    const t = (r.body as { ticket?: Record<string, unknown> })?.ticket ?? {};
    return { ok: true, items: [{ ref, type: 'ticket', title: clip(t.subject, 160), snippet: clip(t.description, 400), url: `${c.baseUrl}/agent/tickets/${ref}`, raw: t }] };
  },
  async listRecent(c: Ctx): Promise<AdapterResult> {
    const r = await httpJson(`${c.baseUrl}/api/v2/tickets.json?sort_by=updated_at&sort_order=desc&per_page=10`, { headers: { Authorization: this.auth(c) } });
    if (!r.ok) return { ok: false, error: r.error };
    const list = (r.body as { tickets?: Array<Record<string, unknown>> })?.tickets ?? [];
    return { ok: true, items: list.map((t) => ({ ref: String(t.id), type: 'ticket', title: clip(t.subject, 160), snippet: clip(t.description, 400), url: `${c.baseUrl}/agent/tickets/${t.id}`, raw: t })) };
  },
  async syncDocs(c: Ctx): Promise<SyncResult> {
    // Zendesk Help Center articles (Guide) — knowledge-capable path.
    const r = await httpJson(`${c.baseUrl}/api/v2/help_center/articles.json?per_page=50`, { headers: { Authorization: this.auth(c) } });
    if (!r.ok) return { ok: false, error: r.error };
    const arts = (r.body as { articles?: Array<Record<string, unknown>> })?.articles ?? [];
    return { ok: true, docs: arts.map((a) => ({ external_ref: `zendesk:${a.id}`, title: clip(a.title, 200), content: stripHtml(String(a.body ?? '')), url: a.html_url ? String(a.html_url) : null })) };
  },
};

// ════════════════════════════════════════════════════════════════
// NATIVE ACTION EXECUTORS — the GENERALIZED ACTION LAYER's write-side
// counterpart to the read-side adapter objects above. A native
// provider's action_definition.execution = { execution_key } names one
// of these branches (as opposed to provider='template', which renders
// through adapter_templates.actions + renderAction). Each executor
// implements BOTH halves — render() for preview (no fetch) and run()
// for execute (actually calls out) — sharing the exact same request-
// building code so preview and execute can never drift.
// ════════════════════════════════════════════════════════════════
interface ActionRenderResult { ok: boolean; method?: string; url?: string; body?: unknown; error?: string; detail?: string }
interface ActionRunResult { ok: boolean; status?: number; raw?: unknown; error?: string; detail?: string; receipt?: string }

interface NativeAction {
  render(c: Ctx, params: Record<string, string>): ActionRenderResult;
  run(c: Ctx, params: Record<string, string>): Promise<ActionRunResult>;
}

const ZENDESK_STATUS_VALUES = ['open', 'pending', 'hold', 'solved'];

const zendeskActions: Record<string, NativeAction> = {
  zendesk_add_internal_note: {
    render(c, p) {
      if (!p.external_ref) return { ok: false, error: 'param_required', detail: 'external_ref (ticket number) is required.' };
      if (!p.note?.trim()) return { ok: false, error: 'param_required', detail: 'note text is required.' };
      return {
        ok: true, method: 'PUT',
        url: `${c.baseUrl}/api/v2/tickets/${encodeURIComponent(p.external_ref)}.json`,
        body: { ticket: { comment: { body: p.note, public: false } } },
      };
    },
    async run(c, p) {
      const r = this.render(c, p);
      if (!r.ok) return { ok: false, error: r.error, detail: r.detail };
      const res = await httpJson(r.url!, { method: 'PUT', headers: { Authorization: zendesk.auth(c), 'Content-Type': 'application/json' }, body: JSON.stringify(r.body) });
      if (!res.ok) return { ok: false, status: res.status, error: res.error, raw: res.body };
      return { ok: true, status: res.status, raw: res.body, receipt: `Added an internal note to ticket #${p.external_ref} (not visible to the customer).` };
    },
  },
  zendesk_update_status: {
    render(c, p) {
      if (!p.external_ref) return { ok: false, error: 'param_required', detail: 'external_ref (ticket number) is required.' };
      if (!ZENDESK_STATUS_VALUES.includes(p.status)) return { ok: false, error: 'param_invalid', detail: `status must be one of: ${ZENDESK_STATUS_VALUES.join(', ')}.` };
      return {
        ok: true, method: 'PUT',
        url: `${c.baseUrl}/api/v2/tickets/${encodeURIComponent(p.external_ref)}.json`,
        body: { ticket: { status: p.status } },
      };
    },
    async run(c, p) {
      const r = this.render(c, p);
      if (!r.ok) return { ok: false, error: r.error, detail: r.detail };
      // Fetch current status first so the receipt can say "from X to Y".
      const before = await zendesk.fetchRecord(c, 'ticket', p.external_ref);
      const prevStatus = before.ok ? String((before.items?.[0]?.raw as Record<string, unknown> | undefined)?.status ?? 'unknown') : 'unknown';
      const res = await httpJson(r.url!, { method: 'PUT', headers: { Authorization: zendesk.auth(c), 'Content-Type': 'application/json' }, body: JSON.stringify(r.body) });
      if (!res.ok) return { ok: false, status: res.status, error: res.error, raw: res.body };
      return { ok: true, status: res.status, raw: res.body, receipt: `Updated ticket #${p.external_ref}'s status from ${prevStatus} to ${p.status}.` };
    },
  },
  zendesk_reply_to_ticket: {
    render(c, p) {
      if (!p.external_ref) return { ok: false, error: 'param_required', detail: 'external_ref (ticket number) is required.' };
      if (!p.body?.trim()) return { ok: false, error: 'param_required', detail: 'reply body text is required.' };
      return {
        ok: true, method: 'PUT',
        url: `${c.baseUrl}/api/v2/tickets/${encodeURIComponent(p.external_ref)}.json`,
        body: { ticket: { comment: { body: p.body, public: true } } },
      };
    },
    async run(c, p) {
      const r = this.render(c, p);
      if (!r.ok) return { ok: false, error: r.error, detail: r.detail };
      const res = await httpJson(r.url!, { method: 'PUT', headers: { Authorization: zendesk.auth(c), 'Content-Type': 'application/json' }, body: JSON.stringify(r.body) });
      if (!res.ok) return { ok: false, status: res.status, error: res.error, raw: res.body };
      return { ok: true, status: res.status, raw: res.body, receipt: `Posted a public reply on ticket #${p.external_ref} — the customer will see it.` };
    },
  },
  // DE-A5: tag/categorize — the triage op the support day-loop was
  // missing (note/reply/status already existed). additional_tags is
  // Zendesk's append-safe form: it never removes existing tags, which
  // is also what makes this action honestly idempotent.
  zendesk_add_tags: {
    render(c, p) {
      if (!p.external_ref) return { ok: false, error: 'param_required', detail: 'external_ref (ticket number) is required.' };
      const tags = (p.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean);
      if (tags.length === 0) return { ok: false, error: 'param_required', detail: 'tags (comma-separated) is required.' };
      return {
        ok: true, method: 'PUT',
        url: `${c.baseUrl}/api/v2/tickets/${encodeURIComponent(p.external_ref)}.json`,
        body: { ticket: { additional_tags: tags } },
      };
    },
    async run(c, p) {
      const r = this.render(c, p);
      if (!r.ok) return { ok: false, error: r.error, detail: r.detail };
      const res = await httpJson(r.url!, { method: 'PUT', headers: { Authorization: zendesk.auth(c), 'Content-Type': 'application/json' }, body: JSON.stringify(r.body) });
      if (!res.ok) return { ok: false, status: res.status, error: res.error, raw: res.body };
      const tagList = (p.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean).join(', ');
      return { ok: true, status: res.status, raw: res.body, receipt: `Tagged ticket #${p.external_ref} with: ${tagList}.` };
    },
  },
};

// ── salesforce ── secrets: { instance_url, client_id, client_secret }
// OAuth2 client-credentials flow against a Developer Edition connected app.
const salesforce = {
  async token(c: Ctx): Promise<{ ok: boolean; token?: string; instance?: string; error?: string }> {
    const instance = (c.secret.instance_url ?? c.baseUrl).replace(/\/+$/, '');
    const r = await httpJson(`${instance}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: c.secret.client_id ?? '',
        client_secret: c.secret.client_secret ?? '',
      }).toString(),
    });
    const b = r.body as { access_token?: string; instance_url?: string; error_description?: string } | null;
    if (!r.ok || !b?.access_token) return { ok: false, error: b?.error_description ?? r.error ?? 'oauth_failed' };
    return { ok: true, token: b.access_token, instance: b.instance_url ?? instance };
  },
  async soql(c: Ctx, q: string) {
    const t = await this.token(c);
    if (!t.ok) return { ok: false as const, error: t.error, records: [] as Array<Record<string, unknown>> };
    const r = await httpJson(`${t.instance}/services/data/v60.0/query?q=${encodeURIComponent(q)}`,
      { headers: { Authorization: `Bearer ${t.token}` } });
    if (!r.ok) return { ok: false as const, error: r.error, records: [] };
    return { ok: true as const, records: (r.body as { records?: Array<Record<string, unknown>> })?.records ?? [], instance: t.instance };
  },
  async test(c: Ctx): Promise<TestResult> {
    const t = await this.token(c);
    if (!t.ok) return { ok: false, error: t.error };
    return { ok: true, detail: `OAuth2 client-credentials token issued by ${t.instance}` };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const safe = query.replace(/['\\%_]/g, ' ').trim().slice(0, 80);
    const items: HubItem[] = [];
    // Cases by Subject/Description
    const cases = await this.soql(c, `SELECT Id, CaseNumber, Subject, Description, Status FROM Case WHERE Subject LIKE '%${safe}%' OR Description LIKE '%${safe}%' ORDER BY LastModifiedDate DESC LIMIT 5`);
    if (!cases.ok) return { ok: false, error: cases.error };
    for (const r of cases.records) items.push({ ref: String(r.Id), type: 'case', title: `Case ${r.CaseNumber}: ${clip(r.Subject, 120)}`, snippet: clip(r.Description, 400), url: cases.instance ? `${cases.instance}/lightning/r/Case/${r.Id}/view` : null, raw: r });
    // Knowledge articles when the org has them (best-effort; absent in many orgs)
    const kav = await this.soql(c, `SELECT Id, Title, Summary, UrlName FROM Knowledge__kav WHERE PublishStatus='Online' AND Title LIKE '%${safe}%' LIMIT 5`);
    if (kav.ok) for (const r of kav.records) items.push({ ref: String(r.Id), type: 'article', title: clip(r.Title, 160), snippet: clip(r.Summary, 400), url: null, raw: r });
    // Accounts by name
    const acc = await this.soql(c, `SELECT Id, Name, Industry, Description FROM Account WHERE Name LIKE '%${safe}%' LIMIT 3`);
    if (acc.ok) for (const r of acc.records) items.push({ ref: String(r.Id), type: 'account', title: clip(r.Name, 160), snippet: clip(`${r.Industry ?? ''} ${r.Description ?? ''}`, 400), url: acc.instance ? `${acc.instance}/lightning/r/Account/${r.Id}/view` : null, raw: r });
    return { ok: true, items };
  },
  async fetchRecord(c: Ctx, type: string, ref: string): Promise<AdapterResult> {
    const sobject = type === 'account' ? 'Account' : type === 'case' ? 'Case' : type || 'Account';
    const t = await this.token(c);
    if (!t.ok) return { ok: false, error: t.error };
    const r = await httpJson(`${t.instance}/services/data/v60.0/sobjects/${encodeURIComponent(sobject)}/${encodeURIComponent(ref)}`,
      { headers: { Authorization: `Bearer ${t.token}` } });
    if (!r.ok) return { ok: false, error: r.error };
    const rec = r.body as Record<string, unknown>;
    return { ok: true, items: [{ ref, type: sobject.toLowerCase(), title: clip(rec.Name ?? rec.Subject ?? ref, 160), snippet: clip(rec.Description ?? JSON.stringify(rec), 400), url: `${t.instance}/lightning/r/${sobject}/${ref}/view`, raw: rec }] };
  },
  async listRecent(c: Ctx): Promise<AdapterResult> {
    const cases = await this.soql(c, `SELECT Id, CaseNumber, Subject, Status FROM Case ORDER BY LastModifiedDate DESC LIMIT 10`);
    if (!cases.ok) return { ok: false, error: cases.error };
    return { ok: true, items: cases.records.map((r) => ({ ref: String(r.Id), type: 'case', title: `Case ${r.CaseNumber}: ${clip(r.Subject, 120)}`, snippet: `Status: ${r.Status}`, url: cases.instance ? `${cases.instance}/lightning/r/Case/${r.Id}/view` : null, raw: r })) };
  },
  async syncDocs(c: Ctx): Promise<SyncResult> {
    const kav = await this.soql(c, `SELECT Id, Title, Summary, ArticleBody__c FROM Knowledge__kav WHERE PublishStatus='Online' LIMIT 50`);
    if (!kav.ok) {
      // Orgs without Knowledge enabled: honest structured miss.
      return { ok: false, error: kav.error ?? 'knowledge_not_available_in_org' };
    }
    return { ok: true, docs: kav.records.map((r) => ({ external_ref: `salesforce:${r.Id}`, title: clip(r.Title, 200), content: stripHtml(String(r.ArticleBody__c ?? r.Summary ?? '')), url: null })) };
  },
};

// ── confluence ── secrets: { email, api_token } · base_url = https://x.atlassian.net ──
const atlassianAuth = (c: Ctx) => 'Basic ' + btoa(`${c.secret.email}:${c.secret.api_token}`);
const confluence = {
  async test(c: Ctx): Promise<TestResult> {
    const r = await httpJson(`${c.baseUrl}/wiki/rest/api/space?limit=1`, { headers: { Authorization: atlassianAuth(c) } });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'Confluence spaces endpoint reachable with these credentials' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const cql = `text ~ "${query.replace(/"/g, ' ')}"`;
    const r = await httpJson(`${c.baseUrl}/wiki/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=8&expand=body.storage`,
      { headers: { Authorization: atlassianAuth(c) } });
    if (!r.ok) return { ok: false, error: r.error };
    const results = (r.body as { results?: Array<Record<string, unknown>> })?.results ?? [];
    return {
      ok: true,
      items: results.map((p) => {
        const body = (p as { body?: { storage?: { value?: string } } }).body?.storage?.value ?? '';
        const links = (p as { _links?: { webui?: string } })._links;
        return { ref: String(p.id), type: 'page', title: clip(p.title, 160), snippet: clip(stripHtml(body), 400), url: links?.webui ? `${c.baseUrl}/wiki${links.webui}` : null, raw: { id: p.id, title: p.title } };
      }),
    };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const r = await httpJson(`${c.baseUrl}/wiki/rest/api/content/${encodeURIComponent(ref)}?expand=body.storage`,
      { headers: { Authorization: atlassianAuth(c) } });
    if (!r.ok) return { ok: false, error: r.error };
    const p = r.body as { id?: unknown; title?: unknown; body?: { storage?: { value?: string } }; _links?: { webui?: string } };
    return { ok: true, items: [{ ref, type: 'page', title: clip(p.title, 160), snippet: clip(stripHtml(p.body?.storage?.value ?? ''), 400), url: p._links?.webui ? `${c.baseUrl}/wiki${p._links.webui}` : null, raw: p }] };
  },
  async listRecent(c: Ctx): Promise<AdapterResult> {
    const r = await httpJson(`${c.baseUrl}/wiki/rest/api/content?type=page&orderby=history.lastUpdated desc&limit=10`,
      { headers: { Authorization: atlassianAuth(c) } });
    if (!r.ok) return { ok: false, error: r.error };
    const results = (r.body as { results?: Array<Record<string, unknown>> })?.results ?? [];
    return { ok: true, items: results.map((p) => ({ ref: String(p.id), type: 'page', title: clip(p.title, 160), snippet: '', url: null, raw: { id: p.id } })) };
  },
  async syncDocs(c: Ctx): Promise<SyncResult> {
    const r = await httpJson(`${c.baseUrl}/wiki/rest/api/content?type=page&limit=50&expand=body.storage`,
      { headers: { Authorization: atlassianAuth(c) } });
    if (!r.ok) return { ok: false, error: r.error };
    const results = (r.body as { results?: Array<Record<string, unknown>> })?.results ?? [];
    return {
      ok: true,
      docs: results.map((p) => ({
        external_ref: `confluence:${p.id}`,
        title: clip(p.title, 200),
        content: stripHtml((p as { body?: { storage?: { value?: string } } }).body?.storage?.value ?? ''),
        url: (p as { _links?: { webui?: string } })._links?.webui ? `${c.baseUrl}/wiki${(p as { _links?: { webui?: string } })._links!.webui}` : null,
      })),
    };
  },
};

// ── jira ── same Atlassian creds · base_url = https://x.atlassian.net ──
const jira = {
  async test(c: Ctx): Promise<TestResult> {
    const r = await httpJson(`${c.baseUrl}/rest/api/3/myself`, { headers: { Authorization: atlassianAuth(c) } });
    const me = r.body as { emailAddress?: string; displayName?: string } | null;
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: `authenticated as ${me?.displayName ?? me?.emailAddress ?? 'unknown'}` };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const jql = `text ~ "${query.replace(/"/g, ' ')}" ORDER BY updated DESC`;
    const r = await httpJson(`${c.baseUrl}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=8&fields=summary,description,status`,
      { headers: { Authorization: atlassianAuth(c) } });
    if (!r.ok) return { ok: false, error: r.error };
    const issues = (r.body as { issues?: Array<Record<string, unknown>> })?.issues ?? [];
    return {
      ok: true,
      items: issues.map((i) => {
        const f = (i.fields ?? {}) as Record<string, unknown>;
        return { ref: String(i.key), type: 'issue', title: `${i.key}: ${clip(f.summary, 140)}`, snippet: clip(extractAdfText(f.description), 400), url: `${c.baseUrl}/browse/${i.key}`, raw: { key: i.key, fields: { summary: f.summary, status: f.status } } };
      }),
    };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const r = await httpJson(`${c.baseUrl}/rest/api/3/issue/${encodeURIComponent(ref)}?fields=summary,description,status,resolution`,
      { headers: { Authorization: atlassianAuth(c) } });
    if (!r.ok) return { ok: false, error: r.error };
    const i = r.body as { key?: unknown; fields?: Record<string, unknown> };
    const f = i.fields ?? {};
    return { ok: true, items: [{ ref, type: 'issue', title: `${i.key}: ${clip(f.summary, 140)}`, snippet: clip(extractAdfText(f.description), 400), url: `${c.baseUrl}/browse/${i.key}`, raw: i }] };
  },
  async listRecent(c: Ctx): Promise<AdapterResult> {
    return this.search(c, 'ORDER BY updated DESC').catch(() => ({ ok: false, error: 'jql_failed' }));
  },
};
// Jira Cloud descriptions are Atlassian Document Format — walk for text.
function extractAdfText(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(extractAdfText).join(' ');
  if (typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if (typeof o.text === 'string') return o.text;
    if (o.content) return extractAdfText(o.content);
  }
  return '';
}

// ── intercom ── secrets: { access_token } · base_url = https://api.intercom.io ──
const intercom = {
  hdrs: (c: Ctx) => ({ Authorization: `Bearer ${c.secret.access_token}`, Accept: 'application/json', 'Content-Type': 'application/json', 'Intercom-Version': '2.11' }),
  async test(c: Ctx): Promise<TestResult> {
    const r = await httpJson(`${c.baseUrl}/me`, { headers: this.hdrs(c) });
    const me = r.body as { email?: string; name?: string } | null;
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: `authenticated as ${me?.name ?? me?.email ?? 'workspace token'}` };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const items: HubItem[] = [];
    // Help Center articles
    const a = await httpJson(`${c.baseUrl}/articles/search?phrase=${encodeURIComponent(query)}`, { headers: this.hdrs(c) });
    if (a.ok) {
      const arts = ((a.body as { data?: { articles?: Array<Record<string, unknown>> } })?.data?.articles) ?? [];
      for (const art of arts.slice(0, 5)) items.push({ ref: String(art.id), type: 'article', title: clip(art.title, 160), snippet: clip(stripHtml(String(art.body ?? '')), 400), url: art.url ? String(art.url) : null, raw: { id: art.id, title: art.title } });
    }
    // Past conversations mentioning the query
    const conv = await httpJson(`${c.baseUrl}/conversations/search`, {
      method: 'POST', headers: this.hdrs(c),
      body: JSON.stringify({ query: { field: 'source.body', operator: '~', value: query }, pagination: { per_page: 5 } }),
    });
    if (conv.ok) {
      const convs = ((conv.body as { conversations?: Array<Record<string, unknown>> })?.conversations) ?? [];
      for (const cv of convs) {
        const src = (cv.source ?? {}) as Record<string, unknown>;
        items.push({ ref: String(cv.id), type: 'conversation', title: clip(src.subject || `Conversation ${cv.id}`, 160), snippet: clip(stripHtml(String(src.body ?? '')), 400), url: null, raw: { id: cv.id, state: cv.state } });
      }
    }
    if (!a.ok && !conv.ok) return { ok: false, error: a.error ?? conv.error };
    return { ok: true, items };
  },
  async fetchRecord(c: Ctx, type: string, ref: string): Promise<AdapterResult> {
    const path = type === 'conversation' ? `/conversations/${ref}` : `/articles/${ref}`;
    const r = await httpJson(`${c.baseUrl}${path}`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const b = r.body as Record<string, unknown>;
    return { ok: true, items: [{ ref, type: type || 'article', title: clip(b.title ?? `#${ref}`, 160), snippet: clip(stripHtml(String(b.body ?? JSON.stringify(b))), 400), url: b.url ? String(b.url) : null, raw: b }] };
  },
  async listRecent(c: Ctx): Promise<AdapterResult> {
    const r = await httpJson(`${c.baseUrl}/conversations?per_page=10`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const convs = (r.body as { conversations?: Array<Record<string, unknown>> })?.conversations ?? [];
    return { ok: true, items: convs.map((cv) => ({ ref: String(cv.id), type: 'conversation', title: `Conversation ${cv.id}`, snippet: `state: ${cv.state}`, url: null, raw: { id: cv.id } })) };
  },
  async syncDocs(c: Ctx): Promise<SyncResult> {
    const r = await httpJson(`${c.baseUrl}/articles?per_page=50`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const arts = (r.body as { data?: Array<Record<string, unknown>> })?.data ?? [];
    return { ok: true, docs: arts.map((a) => ({ external_ref: `intercom:${a.id}`, title: clip(a.title, 200), content: stripHtml(String(a.body ?? '')), url: a.url ? String(a.url) : null })) };
  },
};

// ── generic_rest ── how a customer's OWN product API connects.
// config.endpoints: {
//   search: { path, method?, query_param, items_path?, ref_field?, title_field?, snippet_field?, url_field? },
//   record: { path_template }   // "{ref}" is replaced
//   test?:  { path }
// }
// secrets (optional): { header_name, header_value }
const genericRest = {
  hdrs(c: Ctx): Record<string, string> {
    const h: Record<string, string> = { Accept: 'application/json' };
    if (c.secret.header_name && c.secret.header_value) h[c.secret.header_name] = c.secret.header_value;
    return h;
  },
  endpoints(c: Ctx) { return ((c.config.endpoints ?? {}) as Record<string, Record<string, string>>); },
  pick(obj: Record<string, unknown>, field: string | undefined, fallbacks: string[]): unknown {
    // Scalars only — objects/arrays would stringify to "[object Object]".
    const scalar = (v: unknown) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
    if (field && scalar(obj[field])) return obj[field];
    for (const f of fallbacks) if (scalar(obj[f])) return obj[f];
    return undefined;
  },
  dig(body: unknown, path: string | undefined): unknown {
    if (!path) return body;
    let cur: unknown = body;
    for (const key of path.split('.')) {
      if (cur && typeof cur === 'object') cur = (cur as Record<string, unknown>)[key];
      else return undefined;
    }
    return cur;
  },
  async test(c: Ctx): Promise<TestResult> {
    const ep = this.endpoints(c);
    const path = ep.test?.path ?? ep.search?.path ?? '/';
    const r = await httpJson(`${c.baseUrl}${path}`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: `GET ${path} → HTTP ${r.status}` };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const ep = this.endpoints(c).search;
    if (!ep?.path) return { ok: false, error: 'no_search_endpoint_configured' };
    return this.searchEp(c, ep, query);
  },
  /** Run a search against an arbitrary endpoint binding (used by category ops). */
  async searchEp(c: Ctx, ep: Record<string, string>, query: string): Promise<AdapterResult> {
    const sep = ep.path.includes('?') ? '&' : '?';
    const url = `${c.baseUrl}${ep.path}${ep.query_param ? `${sep}${ep.query_param}=${encodeURIComponent(query)}` : ''}`;
    const r = await httpJson(url, { method: ep.method ?? 'GET', headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const listRaw = this.dig(r.body, ep.items_path);
    const list = Array.isArray(listRaw) ? listRaw : Array.isArray(r.body) ? r.body as unknown[] : [];
    return {
      ok: true,
      items: (list as Array<Record<string, unknown>>).slice(0, 10).map((o) => ({
        ref: String(this.pick(o, ep.ref_field, ['id', 'ref', 'key']) ?? ''),
        type: 'record',
        title: clip(this.pick(o, ep.title_field, ['title', 'name', 'subject']) ?? '(untitled)', 160),
        snippet: clip(this.pick(o, ep.snippet_field, ['body', 'description', 'summary', 'text']) ?? '', 400),
        url: (this.pick(o, ep.url_field, ['url', 'html_url']) as string | undefined) ?? null,
        raw: o,
      })),
    };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const ep = this.endpoints(c).record;
    if (!ep?.path_template) return { ok: false, error: 'no_record_endpoint_configured' };
    return this.recordEp(c, ep, ref);
  },
  /** Fetch one record via an arbitrary endpoint binding (used by category ops). */
  async recordEp(c: Ctx, ep: Record<string, string>, ref: string): Promise<AdapterResult> {
    const r = await httpJson(`${c.baseUrl}${ep.path_template.replace('{ref}', encodeURIComponent(ref))}`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const o = (r.body ?? {}) as Record<string, unknown>;
    return { ok: true, items: [{ ref, type: 'record', title: clip(this.pick(o, undefined, ['title', 'name', 'subject']) ?? `record ${ref}`, 160), snippet: clip(this.pick(o, undefined, ['body', 'description', 'summary', 'company']) ?? JSON.stringify(o), 400), url: null, raw: o }] };
  },
  async listRecent(c: Ctx): Promise<AdapterResult> {
    // Recent = the search endpoint without a query.
    const ep = this.endpoints(c).search;
    if (!ep?.path) return { ok: false, error: 'no_search_endpoint_configured' };
    const r = await httpJson(`${c.baseUrl}${ep.path}`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const listRaw = this.dig(r.body, ep.items_path);
    const list = Array.isArray(listRaw) ? listRaw : Array.isArray(r.body) ? r.body as unknown[] : [];
    return { ok: true, items: (list as Array<Record<string, unknown>>).slice(0, 10).map((o) => ({ ref: String(this.pick(o, ep.ref_field, ['id']) ?? ''), type: 'record', title: clip(this.pick(o, ep.title_field, ['title', 'name']) ?? '(untitled)', 160), snippet: clip(this.pick(o, ep.snippet_field, ['body', 'description']) ?? '', 400), url: null, raw: o })) };
  },
};

// ════════════════════════════════════════════════════════════════
// TEMPLATE EXECUTOR — the Declarative Adapter Framework (migration
// 028). A template is DATA: auth recipe + base-URL shape + per-op
// HTTP bindings + response dot-paths. This executor turns that data
// into live calls with STRUCTURED errors for every failure class so
// a non-developer can debug a template from the builder UI:
//   var_missing · auth_failed · op_not_bound · http_NNN ·
//   unreachable · path_not_found_in_response (with the keys found)
// Secret VALUES come only from connector_secrets (or in-flight for
// dry runs) — a template never contains a credential.
// ════════════════════════════════════════════════════════════════

interface TemplateExec {
  def: AdapterDefinition;
  vars: Record<string, string>;    // non-secret per-connector variables
  secret: Record<string, string>;  // credential values (never from the template)
}
interface TemplateOpResult extends AdapterResult {
  raw_response?: unknown;   // returned to the builder for side-by-side debugging; never persisted
  url?: string;             // the URL actually called (no secrets in it)
}

async function templateAuthHeaders(
  t: TemplateExec,
): Promise<{ ok: true; headers: Record<string, string> } | { ok: false; error: string; detail?: string }> {
  const headers: Record<string, string> = { Accept: 'application/json', ...(t.def.auth.extra_headers ?? {}) };
  const a = t.def.auth;
  const need = (keys: string[]): string | null => {
    const missing = keys.filter((k) => !t.secret[k]?.trim());
    return missing.length ? missing.join(', ') : null;
  };
  switch (a.type) {
    case 'none': return { ok: true, headers };
    case 'api_key_header': {
      const m = need(['api_key']);
      if (m) return { ok: false, error: 'no_credentials', detail: `Missing secret field(s): ${m}` };
      headers[a.header_name ?? 'X-Api-Key'] = t.secret.api_key;
      return { ok: true, headers };
    }
    case 'bearer': {
      const m = need(['token']);
      if (m) return { ok: false, error: 'no_credentials', detail: `Missing secret field(s): ${m}` };
      headers.Authorization = `Bearer ${t.secret.token}`;
      return { ok: true, headers };
    }
    case 'basic': {
      if (!t.secret.username?.trim() && !t.secret.password?.trim()) {
        return { ok: false, error: 'no_credentials', detail: 'Missing secret field(s): username (and/or password)' };
      }
      headers.Authorization = 'Basic ' + btoa(`${t.secret.username ?? ''}:${t.secret.password ?? ''}`);
      return { ok: true, headers };
    }
    case 'oauth2_client_credentials': {
      const m = need(['client_id', 'client_secret']);
      if (m) return { ok: false, error: 'no_credentials', detail: `Missing secret field(s): ${m}` };
      const tokenUrl = renderTemplate(a.token_url ?? '', t.vars);
      if (tokenUrl.missing.length) return { ok: false, error: 'var_missing', detail: `token_url needs variable(s): ${tokenUrl.missing.join(', ')}` };
      const r = await httpJson(tokenUrl.out, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: t.secret.client_id, client_secret: t.secret.client_secret,
        }).toString(),
      });
      const b = r.body as { access_token?: string; error_description?: string; error?: string } | null;
      if (!r.ok || !b?.access_token) {
        return { ok: false, error: 'auth_failed', detail: `Token exchange at ${tokenUrl.out} failed: ${b?.error_description ?? b?.error ?? r.error ?? `HTTP ${r.status}`}` };
      }
      headers.Authorization = `Bearer ${b.access_token}`;
      return { ok: true, headers };
    }
    default: return { ok: false, error: 'invalid_template_definition', detail: `Unknown auth type "${(a as { type?: string }).type}"` };
  }
}

const scalarOrJson = (v: unknown, n: number): string => {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return clip(v, n);
  try { return clip(JSON.stringify(v), n); } catch { return ''; }
};

async function runTemplateOp(
  t: TemplateExec, opName: string, params: { query?: string; ref?: string },
): Promise<TemplateOpResult> {
  const binding = t.def.ops?.[opName];
  if (!binding) {
    return { ok: false, error: 'op_not_bound', detail: `This template has no binding for "${opName}". Bound operations: ${Object.keys(t.def.ops ?? {}).join(', ') || 'none'}.` };
  }
  const values = { ...t.vars, query: params.query ?? '', ref: params.ref ?? '' };
  const missing: string[] = [];

  const base = renderTemplate(t.def.base_url_template, values);
  missing.push(...base.missing);
  const path = renderTemplate(binding.path_template, values, true);
  missing.push(...path.missing);
  const qp = new URLSearchParams();
  for (const [k, v] of Object.entries(binding.query_params ?? {})) {
    const rv = renderTemplate(v, values);
    missing.push(...rv.missing);
    qp.set(k, rv.out);
  }
  let body: string | undefined;
  if (binding.body_template && binding.method === 'POST') {
    body = JSON.stringify(renderBody(binding.body_template, values, missing));
  }
  const realMissing = [...new Set(missing)].filter((k) => k !== 'query' && k !== 'ref');
  if (realMissing.length) {
    return { ok: false, error: 'var_missing', detail: `This connection is missing variable value(s): ${realMissing.join(', ')}. Fill them in the connection settings.` };
  }

  const auth = await templateAuthHeaders(t);
  if (!auth.ok) return { ok: false, error: auth.error, detail: auth.detail };
  const headers = { ...auth.headers, ...(body ? { 'Content-Type': 'application/json' } : {}) };

  const qs = qp.toString();
  const url = `${base.out.replace(/\/+$/, '')}${path.out}${qs ? (path.out.includes('?') ? '&' : '?') + qs : ''}`;
  const r = await httpJson(url, { method: binding.method, headers, body });
  if (!r.ok) {
    return {
      ok: false, url, raw_response: r.body,
      error: r.error ?? `http_${r.status}`,
      detail: r.error === 'auth_failed'
        ? `The API at ${url} rejected the credentials (HTTP ${r.status}). Check the auth recipe and the secret values.`
        : `HTTP ${r.status} from ${url}${r.body ? ` — ${scalarOrJson(r.body, 200)}` : ''}`,
    };
  }

  // Walk to the items
  const itemsPath = binding.response.items_path ?? '';
  const walked = walkPath(r.body, itemsPath);
  if (!walked.found) {
    return {
      ok: false, url, raw_response: r.body, error: 'path_not_found_in_response',
      detail: `items_path "${itemsPath}" died at segment "${walked.failed_segment}". Keys actually present there: ${(walked.keys_at_failure ?? []).join(', ') || '(none — value is not an object)'}. Adjust "where results live" and test again.`,
    };
  }
  let list: Array<Record<string, unknown>>;
  if (binding.single_item) list = [walked.value as Record<string, unknown>];
  else if (Array.isArray(walked.value)) list = (walked.value as Array<Record<string, unknown>>).slice(0, 10);
  else if (walked.value && typeof walked.value === 'object') list = [walked.value as Record<string, unknown>];
  else {
    return {
      ok: false, url, raw_response: r.body, error: 'path_not_found_in_response',
      detail: `items_path "${itemsPath}" points at a ${typeof walked.value}, not a list or record. Point it at the array of results ("" if the whole response is the list).`,
    };
  }

  const items: HubItem[] = [];
  for (const o of list) {
    if (!o || typeof o !== 'object') continue;
    const id = walkPath(o, binding.response.id_path);
    if (!id.found && items.length === 0 && o === list[0]) {
      return {
        ok: false, url, raw_response: r.body, error: 'path_not_found_in_response',
        detail: `id_path "${binding.response.id_path}" not found in the first result. Keys actually present: ${(id.keys_at_failure ?? Object.keys(o).slice(0, 20)).join(', ')}.`,
      };
    }
    const title = walkPath(o, binding.response.title_path);
    const snippet = binding.response.snippet_path ? walkPath(o, binding.response.snippet_path) : { found: false } as const;
    const urlW = binding.response.url_path ? walkPath(o, binding.response.url_path) : { found: false } as const;
    items.push({
      ref: scalarOrJson(id.found ? id.value : '', 120),
      type: 'record',
      title: title.found ? scalarOrJson(title.value, 160) || '(untitled)' : '(untitled)',
      snippet: snippet.found ? scalarOrJson(snippet.value, 400) : '',
      url: urlW.found && typeof urlW.value === 'string' ? urlW.value : null,
      raw: o,
    });
  }
  return { ok: true, items, url, raw_response: r.body };
}

/** Resolve a connector's template row + validated definition. */
async function resolveTemplate(
  admin: SupabaseClient, templateId: string | null, tenantId: string,
): Promise<{ ok: true; template: { id: string; name: string; category: string; definition: AdapterDefinition } } | { ok: false; error: string; detail?: string }> {
  if (!templateId) return { ok: false, error: 'template_not_linked', detail: 'This connector has no adapter template linked — reconnect it from a template.' };
  const { data: tpl } = await admin.from('adapter_templates')
    .select('id, name, category, definition, scope, tenant_id, status')
    .eq('id', templateId).maybeSingle();
  if (!tpl || (tpl.scope === 'tenant' && tpl.tenant_id !== tenantId)) {
    return { ok: false, error: 'template_not_found', detail: 'The adapter template linked to this connector no longer exists (or belongs to another workspace).' };
  }
  const v = validateAdapterDefinition(tpl.definition, tpl.category as SystemCategory);
  if (!v.ok) return { ok: false, error: 'invalid_template_definition', detail: v.errors.join(' · ') };
  return { ok: true, template: { id: tpl.id, name: tpl.name, category: tpl.category, definition: tpl.definition as AdapterDefinition } };
}

/** Build the standard adapter interface from a template so the shared
 *  test / search / fetch_record / list_recent paths work unchanged. */
function templateAdapter(t: TemplateExec) {
  const firstOfKind = (kind: 'search' | 'get') =>
    Object.keys(t.def.ops).find((op) => op.startsWith(kind === 'search' ? 'search' : 'get'));
  return {
    async test(_c: Ctx): Promise<TestResult> {
      const testOp = t.def.test_op?.op ?? firstOfKind('search') ?? Object.keys(t.def.ops)[0];
      const p = t.def.test_op?.params ?? {};
      const r = await runTemplateOp(t, testOp, { query: p.query ?? 'test', ref: p.ref ?? '' });
      if (!r.ok) return { ok: false, error: r.error, detail: r.detail };
      return { ok: true, detail: `${testOp} answered with ${r.items?.length ?? 0} item(s) via the template executor` };
    },
    async search(_c: Ctx, query: string): Promise<AdapterResult> {
      const op = firstOfKind('search');
      if (!op) return { ok: false, error: 'op_not_supported', detail: 'This template binds no search operation.' };
      return runTemplateOp(t, op, { query });
    },
    async fetchRecord(_c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
      const op = firstOfKind('get');
      if (!op) return { ok: false, error: 'op_not_supported', detail: 'This template binds no single-record operation.' };
      return runTemplateOp(t, op, { ref });
    },
    async listRecent(_c: Ctx): Promise<AdapterResult> {
      const op = firstOfKind('search');
      if (!op) return { ok: false, error: 'op_not_supported', detail: 'This template binds no search operation.' };
      return runTemplateOp(t, op, { query: '' });
    },
  };
}

// ════════════════════════════════════════════════════════════════
// DOCUMENT-REPOSITORY ADAPTERS (app-only, no per-user OAuth redirect)
// SharePoint via Microsoft Graph client-credentials; Google Drive via a
// service-account JWT-bearer grant. Both are knowledge-capable: syncDocs
// pulls document text into the corpus, extracting PDFs (and Office files
// converted to PDF) with unpdf — the same reader the extract-document
// edge function uses.
// ════════════════════════════════════════════════════════════════

const MAX_DOC_CHARS = 200_000;   // per-document text cap handed to the ingester
// WS8 STEP 8 cap-lift (P4): safe only AFTER content_hash skip (mig 286) makes
// unchanged docs near-free AND ingestDoc defers embedding to the drain (no inline
// embed). Was 100. Held at 200 (not higher) per the adversarial review: (a) one
// invocation must reliably finish walking+fetching+storing this many docs within
// the edge wall-clock, and (b) one sync must not enqueue more null-embedding
// chunks than embed-backfill-drain can clear per interval (~4/2min). Corpora
// beyond this cap are surfaced as `truncated` (below), not silently dropped;
// paging the rest via connector_sync_cursors is the deferred follow-up.
const MAX_SYNC_FILES = 200;      // files ingested per sync run

// ── Ingest control (migration 138): filters live in config.ingest ──
interface IngestFilters {
  exclude_patterns?: string[];   // skip any file/folder whose path contains one of these (case-insensitive)
  allow_types?: string[] | null; // if set, only these coarse types ingest (pdf|doc|slide|sheet|text)
  folder?: string | null;        // SharePoint sub-folder path / Google Drive folder id to scope to
  require_review?: boolean;      // if true, only approved candidates ingest
}
interface Candidate { external_ref: string; title: string; path: string; file_type: string; size_bytes: number | null }

// Coarse, ingest-relevant file type from a name and/or MIME.
function fileTypeOf(name: string, mime?: string): string {
  const l = (name ?? '').toLowerCase();
  if (/\.pdf$/.test(l) || mime === 'application/pdf') return 'pdf';
  if (/\.(docx?|odt|rtf)$/.test(l) || mime === 'application/vnd.google-apps.document') return 'doc';
  if (/\.(pptx?|odp)$/.test(l) || mime === 'application/vnd.google-apps.presentation') return 'slide';
  if (/\.(xlsx?|csv|ods)$/.test(l) || mime === 'application/vnd.google-apps.spreadsheet') return 'sheet';
  if (/\.(txt|md|json|html?|xml)$/.test(l) || (mime ?? '').startsWith('text/')) return 'text';
  return 'other';
}
function isExcluded(name: string, path: string, patterns?: string[]): boolean {
  if (!patterns?.length) return false;
  const hay = `${path}/${name}`.toLowerCase();
  return patterns.some((p) => { const s = String(p ?? '').trim().toLowerCase(); return s.length > 0 && hay.includes(s); });
}
// A candidate is INGESTABLE if its type is extractable, allowed by the
// allow-list (if any), and not excluded by pattern.
function candidatePasses(c: Candidate, f: IngestFilters): boolean {
  if (c.file_type === 'other') return false;                        // can't extract text
  if (f.allow_types?.length && !f.allow_types.includes(c.file_type)) return false;
  if (isExcluded(c.title, c.path, f.exclude_patterns)) return false;
  return true;
}

// Enforce the SAME exclusions on live read-through results (search /
// fetch_record / list_recent) as on ingest — so an excluded or out-of-scope
// file never surfaces even in a live lookup. Security-focused: folder scope
// + exclude patterns are hard; allow_types only applies when the customer
// set one (read-through isn't about extractability, so 'other' is allowed
// through unless a type allow-list is configured).
const INGEST_CONTROL_PROVIDERS = new Set(['sharepoint', 'gdrive', 'notion', 'box', 'dropbox']);
function readThroughFilterItems(provider: string, items: HubItem[] | undefined, f: IngestFilters): HubItem[] {
  const list = items ?? [];
  if (!INGEST_CONTROL_PROVIDERS.has(provider)) return list;
  if (!(f.exclude_patterns?.length || f.allow_types?.length || f.folder)) return list;
  const scope = String(f.folder ?? '').replace(/^\/+|\/+$/g, '').toLowerCase();
  return list.filter((it) => {
    const raw = (it.raw ?? {}) as Record<string, unknown>;
    const name = it.title || String(raw.name ?? '');
    const mime = String(raw.mimeType ?? '');
    const pr = raw.parentReference as { path?: string } | undefined;
    const path = pr?.path ? String(pr.path).replace(/^.*root:\/?/, '') : '';
    // folder scope only applies where items carry a path (sharepoint); skip for notion (no folders)
    if (scope && path && !`${path}/${name}`.toLowerCase().includes(scope)) return false;
    if (isExcluded(name, path, f.exclude_patterns)) return false;
    // allow_types only filters TYPED items — untyped (e.g. Notion pages → 'other') pass through
    if (f.allow_types?.length) { const t = fileTypeOf(name, mime); if (t !== 'other' && !f.allow_types.includes(t)) return false; }
    return true;
  });
}

async function pdfBytesToText(bytes: Uint8Array): Promise<string> {
  try {
    const pdf = await getDocumentProxy(bytes);
    const { text } = await extractText(pdf, { mergePages: true });
    return (Array.isArray(text) ? text.join('\n\n') : String(text ?? '')).trim();
  } catch { return ''; }
}

// A binary/text fetch that still honours the SSRF guard on the (fixed,
// vendor-owned) URL. httpJson can't be used — it JSON-parses the body.
async function safeFetch(url: string, init: RequestInit = {}): Promise<Response | null> {
  if (!isSafeExternalUrl(url)) return null;
  try {
    const res = await fetch(url, init);
    return res.ok ? res : null;
  } catch { return null; }
}

const b64url = (bytes: Uint8Array): string => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

// ── Google service-account → access token (RS256 JWT-bearer grant) ──
async function googleAccessToken(saJson: string, scope: string): Promise<{ ok: boolean; token?: string; error?: string }> {
  let sa: { client_email?: string; private_key?: string; token_uri?: string };
  try { sa = JSON.parse(saJson); } catch { return { ok: false, error: 'invalid_service_account_json' }; }
  if (!sa.client_email || !sa.private_key) return { ok: false, error: 'service_account_missing_client_email_or_private_key' };
  const tokenUri = sa.token_uri ?? 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const signingInput = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iss: sa.client_email, scope, aud: tokenUri, iat: now, exp: now + 3600 })}`;
  let jwt: string;
  try {
    const pem = sa.private_key.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s+/g, '');
    const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, key, new TextEncoder().encode(signingInput));
    jwt = `${signingInput}.${b64url(new Uint8Array(sig))}`;
  } catch (e) {
    return { ok: false, error: `could_not_sign_jwt: ${String((e as Error)?.message ?? e).slice(0, 80)}` };
  }
  const r = await httpJson(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }).toString(),
  });
  const b = r.body as { access_token?: string; error_description?: string; error?: string } | null;
  if (!r.ok || !b?.access_token) return { ok: false, error: b?.error_description ?? b?.error ?? r.error ?? 'jwt_bearer_failed' };
  return { ok: true, token: b.access_token };
}

// ── SharePoint (Microsoft Graph, app-only) ──
// secrets: { tenant_id (Azure AD directory id), client_id, client_secret }
// base_url: the site, e.g. https://acme.sharepoint.com/sites/kb
const GRAPH = 'https://graph.microsoft.com/v1.0';
const sharepoint = {
  async token(c: Ctx): Promise<{ ok: boolean; token?: string; error?: string }> {
    const tenant = (c.secret.tenant_id ?? '').trim();
    if (!tenant) return { ok: false, error: 'missing_tenant_id' };
    const r = await httpJson(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: c.secret.client_id ?? '',
        client_secret: c.secret.client_secret ?? '',
        scope: 'https://graph.microsoft.com/.default',
      }).toString(),
    });
    const b = r.body as { access_token?: string; error_description?: string } | null;
    if (!r.ok || !b?.access_token) return { ok: false, error: b?.error_description ?? r.error ?? 'oauth_failed' };
    return { ok: true, token: b.access_token };
  },
  siteSegment(baseUrl: string): string {
    // Graph addresses a site as {hostname}:{server-relative-path}:
    try {
      const u = new URL(baseUrl);
      const path = u.pathname.replace(/\/+$/, '');
      return path ? `${u.hostname}:${path}:` : u.hostname;
    } catch { return baseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, ''); }
  },
  async siteId(c: Ctx, token: string): Promise<{ ok: boolean; id?: string; error?: string }> {
    const r = await httpJson(`${GRAPH}/sites/${this.siteSegment(c.baseUrl)}`, { headers: { Authorization: `Bearer ${token}` } });
    const b = r.body as { id?: string } | null;
    if (!r.ok || !b?.id) return { ok: false, error: r.error ?? 'site_not_found' };
    return { ok: true, id: b.id };
  },
  async test(c: Ctx): Promise<TestResult> {
    const t = await this.token(c);
    if (!t.ok) return { ok: false, error: t.error };
    const s = await this.siteId(c, t.token!);
    if (!s.ok) return { ok: false, error: s.error };
    return { ok: true, detail: `app-only token issued; SharePoint site reachable` };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const t = await this.token(c);
    if (!t.ok) return { ok: false, error: t.error };
    const s = await this.siteId(c, t.token!);
    if (!s.ok) return { ok: false, error: s.error };
    const r = await httpJson(`${GRAPH}/sites/${s.id}/drive/root/search(q='${encodeURIComponent(query)}')?$top=10`, { headers: { Authorization: `Bearer ${t.token}` } });
    if (!r.ok) return { ok: false, error: r.error };
    const items = (r.body as { value?: Array<Record<string, unknown>> })?.value ?? [];
    return { ok: true, items: items.slice(0, 10).map((it) => ({ ref: String(it.id ?? ''), type: 'document', title: clip(it.name, 160), snippet: clip(it.description ?? '', 400), url: it.webUrl ? String(it.webUrl) : null, raw: it })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const t = await this.token(c);
    if (!t.ok) return { ok: false, error: t.error };
    const s = await this.siteId(c, t.token!);
    if (!s.ok) return { ok: false, error: s.error };
    const r = await httpJson(`${GRAPH}/sites/${s.id}/drive/items/${encodeURIComponent(ref)}`, { headers: { Authorization: `Bearer ${t.token}` } });
    if (!r.ok) return { ok: false, error: r.error };
    const it = r.body as Record<string, unknown>;
    return { ok: true, items: [{ ref, type: 'document', title: clip(it.name, 160), snippet: clip(it.description ?? '', 400), url: it.webUrl ? String(it.webUrl) : null, raw: it }] };
  },
  async listRecent(c: Ctx): Promise<AdapterResult> {
    const t = await this.token(c);
    if (!t.ok) return { ok: false, error: t.error };
    const s = await this.siteId(c, t.token!);
    if (!s.ok) return { ok: false, error: s.error };
    const r = await httpJson(`${GRAPH}/sites/${s.id}/drive/root/children?$top=10&$orderby=lastModifiedDateTime desc`, { headers: { Authorization: `Bearer ${t.token}` } });
    if (!r.ok) return { ok: false, error: r.error };
    const items = (r.body as { value?: Array<Record<string, unknown>> })?.value ?? [];
    return { ok: true, items: items.filter((it) => it.file).map((it) => ({ ref: String(it.id), type: 'document', title: clip(it.name, 160), snippet: '', url: it.webUrl ? String(it.webUrl) : null, raw: it })) };
  },
  // List candidate files (filters applied) WITHOUT extracting text.
  async discoverDocs(c: Ctx, f: IngestFilters): Promise<{ ok: boolean; candidates?: Candidate[]; error?: string }> {
    const t = await this.token(c);
    if (!t.ok) return { ok: false, error: t.error };
    const s = await this.siteId(c, t.token!);
    if (!s.ok) return { ok: false, error: s.error };
    const auth = { Authorization: `Bearer ${t.token}` };
    const scope = String(f.folder ?? '').replace(/^\/+|\/+$/g, '').toLowerCase();
    const out: Candidate[] = [];
    const queue: Array<{ id: string; path: string }> = [{ id: 'root', path: '' }];
    let folders = 0;
    while (queue.length && out.length < MAX_SYNC_FILES && folders < 60) {
      const cur = queue.shift()!;
      folders++;
      const listUrl = cur.id === 'root'
        ? `${GRAPH}/sites/${s.id}/drive/root/children?$top=200`
        : `${GRAPH}/sites/${s.id}/drive/items/${cur.id}/children?$top=200`;
      const r = await httpJson(listUrl, { headers: auth });
      if (!r.ok) break;
      const items = (r.body as { value?: Array<Record<string, unknown>> })?.value ?? [];
      for (const it of items) {
        if (out.length >= MAX_SYNC_FILES) break;
        const name = String(it.name ?? '');
        const childPath = cur.path ? `${cur.path}/${name}` : name;
        if (it.folder) { queue.push({ id: String(it.id), path: childPath }); continue; }
        if (!it.file) continue;
        if (scope && !childPath.toLowerCase().startsWith(scope)) continue;   // folder scope
        const cand: Candidate = { external_ref: `sharepoint:${it.id}`, title: clip(name, 200), path: cur.path, file_type: fileTypeOf(name), size_bytes: typeof it.size === 'number' ? it.size : null };
        if (candidatePasses(cand, f)) out.push(cand);
      }
    }
    return { ok: true, candidates: out };
  },
  // Extract text for a set of approved candidates (creds resolved once).
  async fetchTexts(c: Ctx, items: Candidate[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const t = await this.token(c);
    if (!t.ok) return out;
    const s = await this.siteId(c, t.token!);
    if (!s.ok) return out;
    for (const it of items) {
      out[it.external_ref] = await sharepointFetchText(String(s.id), it.external_ref.replace(/^sharepoint:/, ''), it.file_type, t.token!);
    }
    return out;
  },
  // Direct sync (review off) = discover + fetch each matching file.
  async syncDocs(c: Ctx, f: IngestFilters = {}): Promise<SyncResult> {
    const d = await this.discoverDocs(c, f);
    if (!d.ok) return { ok: false, error: d.error };
    const cands = d.candidates ?? [];
    if (!cands.length) return { ok: false, error: 'no_readable_documents', detail: 'No text-extractable documents matched your ingest settings.' };
    const texts = await this.fetchTexts(c, cands);
    const docs: SyncDoc[] = cands.map((cd) => ({ external_ref: cd.external_ref, title: cd.title, content: texts[cd.external_ref] ?? '', url: null })).filter((dd) => dd.content);
    if (!docs.length) return { ok: false, error: 'no_readable_documents', detail: 'Matching files had no extractable text.' };
    return { ok: true, docs };
  },
};

// Extract text for one SharePoint item, keyed on coarse file type.
async function sharepointFetchText(siteId: string, itemId: string, fileType: string, token: string): Promise<string> {
  const auth = { Authorization: `Bearer ${token}` };
  const base = `${GRAPH}/sites/${siteId}/drive/items/${itemId}/content`;
  if (fileType === 'text') {
    const res = await safeFetch(base, { headers: auth });
    if (!res) return '';
    const raw = await res.text();
    const looksHtml = /<\/?[a-z][\s\S]*>/i.test(raw.slice(0, 4000));
    return (looksHtml ? stripHtml(raw) : raw).slice(0, MAX_DOC_CHARS);
  }
  if (fileType === 'pdf') {
    const res = await safeFetch(base, { headers: auth });
    return res ? (await pdfBytesToText(new Uint8Array(await res.arrayBuffer()))).slice(0, MAX_DOC_CHARS) : '';
  }
  if (fileType === 'doc' || fileType === 'slide' || fileType === 'sheet') {
    // Graph converts Office documents to PDF on the fly; unpdf reads them.
    const res = await safeFetch(`${base}?format=pdf`, { headers: auth });
    return res ? (await pdfBytesToText(new Uint8Array(await res.arrayBuffer()))).slice(0, MAX_DOC_CHARS) : '';
  }
  return '';
}

// ── Google Drive (service account, read-only) ──
// secrets: { service_account_json } ; base_url: optional folder / shared-drive id to scope to
const DRIVE = 'https://www.googleapis.com/drive/v3';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const DRIVE_SHARED = 'supportsAllDrives=true&includeItemsFromAllDrives=true';
const gdrive = {
  token(c: Ctx): Promise<{ ok: boolean; token?: string; error?: string }> {
    return googleAccessToken(c.secret.service_account_json ?? '', DRIVE_SCOPE);
  },
  async test(c: Ctx): Promise<TestResult> {
    const t = await this.token(c);
    if (!t.ok) return { ok: false, error: t.error };
    const r = await httpJson(`${DRIVE}/files?pageSize=1&fields=files(id)&${DRIVE_SHARED}`, { headers: { Authorization: `Bearer ${t.token}` } });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'service-account token issued; Google Drive reachable' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const t = await this.token(c);
    if (!t.ok) return { ok: false, error: t.error };
    const q = `fullText contains ${JSON.stringify(query)} and trashed=false`;
    const r = await httpJson(`${DRIVE}/files?q=${encodeURIComponent(q)}&pageSize=10&fields=files(id,name,mimeType,webViewLink)&${DRIVE_SHARED}`, { headers: { Authorization: `Bearer ${t.token}` } });
    if (!r.ok) return { ok: false, error: r.error };
    const files = (r.body as { files?: Array<Record<string, unknown>> })?.files ?? [];
    return { ok: true, items: files.slice(0, 10).map((f) => ({ ref: String(f.id), type: 'document', title: clip(f.name, 160), snippet: '', url: f.webViewLink ? String(f.webViewLink) : null, raw: f })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const t = await this.token(c);
    if (!t.ok) return { ok: false, error: t.error };
    const r = await httpJson(`${DRIVE}/files/${encodeURIComponent(ref)}?fields=id,name,mimeType,webViewLink&${DRIVE_SHARED}`, { headers: { Authorization: `Bearer ${t.token}` } });
    if (!r.ok) return { ok: false, error: r.error };
    const f = r.body as Record<string, unknown>;
    return { ok: true, items: [{ ref, type: 'document', title: clip(f.name, 160), snippet: '', url: f.webViewLink ? String(f.webViewLink) : null, raw: f }] };
  },
  async listRecent(c: Ctx): Promise<AdapterResult> {
    const t = await this.token(c);
    if (!t.ok) return { ok: false, error: t.error };
    const r = await httpJson(`${DRIVE}/files?q=trashed=false&orderBy=modifiedTime desc&pageSize=10&fields=files(id,name,mimeType,webViewLink)&${DRIVE_SHARED}`, { headers: { Authorization: `Bearer ${t.token}` } });
    if (!r.ok) return { ok: false, error: r.error };
    const files = (r.body as { files?: Array<Record<string, unknown>> })?.files ?? [];
    return { ok: true, items: files.map((f) => ({ ref: String(f.id), type: 'document', title: clip(f.name, 160), snippet: '', url: f.webViewLink ? String(f.webViewLink) : null, raw: f })) };
  },
  async discoverDocs(c: Ctx, f: IngestFilters): Promise<{ ok: boolean; candidates?: Candidate[]; error?: string }> {
    const t = await this.token(c);
    if (!t.ok) return { ok: false, error: t.error };
    const folder = String(f.folder ?? c.baseUrl ?? '').trim().replace(/^https?:\/\/[^ ]*\/folders\//, '').replace(/[?#].*$/, '');
    let q = "trashed=false and mimeType!='application/vnd.google-apps.folder'";
    if (folder) q = `'${folder.replace(/'/g, '')}' in parents and ${q}`;
    const r = await httpJson(`${DRIVE}/files?q=${encodeURIComponent(q)}&pageSize=${MAX_SYNC_FILES}&fields=files(id,name,mimeType,size)&${DRIVE_SHARED}`, { headers: { Authorization: `Bearer ${t.token}` } });
    if (!r.ok) return { ok: false, error: r.error };
    const files = (r.body as { files?: Array<Record<string, unknown>> })?.files ?? [];
    const out: Candidate[] = [];
    for (const fl of files) {
      if (out.length >= MAX_SYNC_FILES) break;
      const name = String(fl.name ?? '');
      const cand: Candidate = { external_ref: `gdrive:${fl.id}`, title: clip(name, 200), path: '', file_type: fileTypeOf(name, String(fl.mimeType ?? '')), size_bytes: fl.size != null ? Number(fl.size) : null };
      if (candidatePasses(cand, f)) out.push(cand);
    }
    return { ok: true, candidates: out };
  },
  async fetchTexts(c: Ctx, items: Candidate[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const t = await this.token(c);
    if (!t.ok) return out;
    for (const it of items) {
      out[it.external_ref] = await gdriveFetchText(it.external_ref.replace(/^gdrive:/, ''), it.file_type, t.token!);
    }
    return out;
  },
  async syncDocs(c: Ctx, f: IngestFilters = {}): Promise<SyncResult> {
    const d = await this.discoverDocs(c, f);
    if (!d.ok) return { ok: false, error: d.error };
    const cands = d.candidates ?? [];
    if (!cands.length) return { ok: false, error: 'no_readable_documents', detail: 'No text-extractable files matched your ingest settings.' };
    const texts = await this.fetchTexts(c, cands);
    const docs: SyncDoc[] = cands.map((cd) => ({ external_ref: cd.external_ref, title: cd.title, content: texts[cd.external_ref] ?? '', url: null })).filter((dd) => dd.content);
    if (!docs.length) return { ok: false, error: 'no_readable_documents', detail: 'Matching files had no extractable text.' };
    return { ok: true, docs };
  },
};

// Extract text for one Drive file, keyed on coarse file type.
async function gdriveFetchText(id: string, fileType: string, token: string): Promise<string> {
  const auth = { Authorization: `Bearer ${token}` };
  if (fileType === 'doc' || fileType === 'slide') {
    const res = await safeFetch(`${DRIVE}/files/${id}/export?mimeType=text/plain`, { headers: auth });
    return res ? (await res.text()).slice(0, MAX_DOC_CHARS) : '';
  }
  if (fileType === 'sheet') {
    const res = await safeFetch(`${DRIVE}/files/${id}/export?mimeType=text/csv`, { headers: auth });
    return res ? (await res.text()).slice(0, MAX_DOC_CHARS) : '';
  }
  if (fileType === 'pdf') {
    const res = await safeFetch(`${DRIVE}/files/${id}?alt=media&${DRIVE_SHARED}`, { headers: auth });
    return res ? (await pdfBytesToText(new Uint8Array(await res.arrayBuffer()))).slice(0, MAX_DOC_CHARS) : '';
  }
  if (fileType === 'text') {
    const res = await safeFetch(`${DRIVE}/files/${id}?alt=media&${DRIVE_SHARED}`, { headers: auth });
    if (!res) return '';
    const raw = await res.text();
    const looksHtml = /<\/?[a-z][\s\S]*>/i.test(raw.slice(0, 4000));
    return (looksHtml ? stripHtml(raw) : raw).slice(0, MAX_DOC_CHARS);
  }
  return '';   // uploaded Office/binary files: Drive can't export them — skipped honestly
}

// ════════════════════════════════════════════════════════════════

const KNOWLEDGE_CAPABLE = new Set(['zendesk', 'salesforce', 'confluence', 'intercom', 'sharepoint', 'gdrive', 'notion', 'box', 'servicenow', 'guru', 'document360', 'dropbox']);

// ════════════════════════════════════════════════════════════════
// THE GENERALIZED ACTION LAYER (migration 035) — resolve + render +
// run any action_definitions row, mirroring resolveTemplate/
// templateAdapter's shape for the write side. A registered action is
// either provider='template' (rendered via adapter_templates.actions +
// renderAction — reuses the EXACT variable-substitution engine the
// read-side ops use) or a named provider (execution.execution_key
// names a NativeAction implemented in this file, e.g. zendeskActions).
// ════════════════════════════════════════════════════════════════
interface ActionDefRow {
  id: string; scope: string; tenant_id: string | null; category: string;
  action_key: string; label: string; description: string;
  provider: string; template_id: string | null;
  param_schema: Array<{ name: string; type: string; required?: boolean; help?: string }>;
  risk: { destructive: boolean; idempotent: boolean };
  execution: Record<string, unknown>;
  status: string;
}

async function resolveActionDefinition(
  admin: SupabaseClient, tenantId: string, connectorCategory: string, actionKey: string, connectorProvider?: string,
): Promise<{ ok: true; def: ActionDefRow } | { ok: false; error: string; detail?: string }> {
  // Tenant-scope row wins over platform-scope for the same category+key.
  const { data: rows } = await admin.from('action_definitions')
    .select('*')
    .eq('category', connectorCategory).eq('action_key', actionKey).eq('status', 'active')
    .or(`scope.eq.platform,tenant_id.eq.${tenantId}`);
  const list = (rows ?? []) as ActionDefRow[];
  const tenantRow = list.find((r) => r.scope === 'tenant' && r.tenant_id === tenantId);
  // A category can now have MANY providers registered (helpdesk = zendesk +
  // freshdesk + …), so pick the platform row whose provider matches THIS
  // connector; fall back to the first platform row for single-provider
  // categories (back-compat) — never cross-fire one provider's executor at
  // another provider's connector.
  const platformRow = (connectorProvider && list.find((r) => r.scope === 'platform' && r.provider === connectorProvider))
    || list.find((r) => r.scope === 'platform');
  const def = tenantRow ?? platformRow;
  if (!def) {
    return { ok: false, error: 'action_not_registered', detail: `No active action "${actionKey}" is registered for the ${connectorCategory} category.` };
  }
  return { ok: true, def };
}

function validateActionParams(
  def: ActionDefRow, params: Record<string, unknown>,
): { ok: true; values: Record<string, string> } | { ok: false; error: string; detail: string } {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const p of def.param_schema ?? []) {
    const v = params[p.name];
    if (v === undefined || v === null || v === '') {
      if (p.required) missing.push(p.name);
      continue;
    }
    values[p.name] = String(v);
  }
  if (missing.length) {
    return { ok: false, error: 'params_missing', detail: `Missing required param(s): ${missing.join(', ')}.` };
  }
  return { ok: true, values };
}

/** Plain-language RECEIPT PREVIEW — "This will change ticket #4521's
 *  status from Open to Resolved" — never a raw JSON diff. Generic
 *  fallback covers any action_definition; the two seeded Zendesk
 *  actions get a slightly friendlier phrasing since their param names
 *  are known ahead of time. */
function plainLanguagePreview(def: ActionDefRow, values: Record<string, string>): string {
  if (def.action_key === 'update_status' && values.external_ref && values.status) {
    return `This will change ticket #${values.external_ref}'s status to ${values.status}.`;
  }
  if (def.action_key === 'add_internal_note' && values.external_ref) {
    return `This will add an internal note to ticket #${values.external_ref} (not visible to the customer).`;
  }
  if (def.action_key === 'reply_to_ticket' && values.external_ref) {
    return `This will post a PUBLIC reply on ticket #${values.external_ref} — the customer will see it immediately.`;
  }
  const parts = Object.entries(values).map(([k, v]) => `${k}=${String(v).slice(0, 80)}`).join(', ');
  return `This will run "${def.label}"${parts ? ` with ${parts}` : ''}.`;
}

interface ActionRenderOutcome { ok: boolean; method?: string; url?: string; body?: unknown; error?: string; detail?: string }

/** Render (never call out) — shared by preview_action AND the first
 *  half of execute_action, so the two can never show different requests. */
async function renderRegisteredAction(
  admin: SupabaseClient, def: ActionDefRow, ctx: Ctx, values: Record<string, string>,
): Promise<ActionRenderOutcome> {
  if (def.provider === 'template') {
    if (!def.template_id) return { ok: false, error: 'template_not_linked' };
    const { data: tpl } = await admin.from('adapter_templates').select('definition').eq('id', def.template_id).maybeSingle();
    const adef = tpl?.definition as AdapterDefinition | undefined;
    const binding: AdapterActionBinding | undefined = adef?.actions?.[def.action_key];
    if (!binding) return { ok: false, error: 'action_not_bound', detail: `The linked template has no action binding for "${def.action_key}".` };
    const vars = (ctx.config?.template_vars ?? {}) as Record<string, string>;
    const rendered = renderAction(adef!.base_url_template, binding, vars, values);
    if (!rendered.ok) return { ok: false, error: rendered.error ?? 'var_missing', detail: `Missing variable(s): ${(rendered.missing ?? []).join(', ')}` };
    return { ok: true, method: rendered.method, url: rendered.url, body: rendered.body ? JSON.parse(rendered.body) : undefined };
  }
  // Native provider — execution.execution_key names a NativeAction.
  const executionKey = String(def.execution?.execution_key ?? '');
  const native = NATIVE_ACTIONS[executionKey];
  if (!native) return { ok: false, error: 'execution_not_implemented', detail: `No native execution path for "${executionKey}".` };
  const r = native.render(ctx, values);
  return r;
}

/** Actually run (calls the external system) — used only by execute_action
 *  after all gates pass, never by preview_action. */
async function runRegisteredAction(
  admin: SupabaseClient, def: ActionDefRow, ctx: Ctx, values: Record<string, string>,
): Promise<ActionRunResult & { url?: string }> {
  if (def.provider === 'template') {
    if (!def.template_id) return { ok: false, error: 'template_not_linked' };
    const { data: tpl } = await admin.from('adapter_templates').select('definition').eq('id', def.template_id).maybeSingle();
    const adef = tpl?.definition as AdapterDefinition | undefined;
    const binding: AdapterActionBinding | undefined = adef?.actions?.[def.action_key];
    if (!binding) return { ok: false, error: 'action_not_bound' };
    const vars = (ctx.config?.template_vars ?? {}) as Record<string, string>;
    const rendered = renderAction(adef!.base_url_template, binding, vars, values);
    if (!rendered.ok) return { ok: false, error: rendered.error ?? 'var_missing', detail: `Missing variable(s): ${(rendered.missing ?? []).join(', ')}` };
    const auth = await templateAuthHeaders({ def: adef!, vars, secret: ctx.secret });
    if (!auth.ok) return { ok: false, error: auth.error, detail: auth.detail };
    const headers = { ...auth.headers, ...(rendered.body ? { 'Content-Type': 'application/json' } : {}) };
    const res = await httpJson(rendered.url!, { method: rendered.method, headers, body: rendered.body });
    if (!res.ok) return { ok: false, status: res.status, error: res.error, raw: res.body, url: rendered.url };
    return {
      ok: true, status: res.status, raw: res.body, url: rendered.url,
      receipt: `${def.label} succeeded (HTTP ${res.status}) against ${rendered.url}.`,
    };
  }
  const executionKey = String(def.execution?.execution_key ?? '');
  const native = NATIVE_ACTIONS[executionKey];
  if (!native) return { ok: false, error: 'execution_not_implemented' };
  return native.run(ctx, values);
}

// ════════════════════════════════════════════════════════════════
// CATEGORY CONTRACT translation layer — the app talks in canonical
// category ops; this table translates each (provider, op) to the
// provider adapter. An op the provider cannot honestly serve is
// simply absent → structured `op_not_supported`.
// generic_rest is special: a customer binds category ops to their own
// API paths via config.endpoints.category_ops[op]; search_*/get_* ops
// fall back to the generic search/record endpoints when unbound.
// ════════════════════════════════════════════════════════════════

interface OpParams { query?: string; external_ref?: string }
type OpTranslator = (c: Ctx, p: OpParams) => Promise<AdapterResult>;

// ── hubspot ── secret: { access_token } (private-app token). One build
// covers CRM (companies/contacts/deals) + Service Hub (tickets). Base URL
// is fixed for all accounts, so no per-tenant base_url. Read-through; not a
// document corpus, so no syncDocs / not knowledge-capable.
const HUBSPOT = 'https://api.hubapi.com';
const hubspot = {
  hdrs: (c: Ctx) => ({ Authorization: `Bearer ${c.secret.access_token ?? ''}`, 'Content-Type': 'application/json' }),
  async searchObject(c: Ctx, objectType: string, query: string, properties: string[], sorts?: Array<Record<string, string>>) {
    const r = await httpJson(`${HUBSPOT}/crm/v3/objects/${objectType}/search`, {
      method: 'POST', headers: this.hdrs(c),
      body: JSON.stringify({ query: query || undefined, limit: 10, properties, ...(sorts ? { sorts } : {}) }),
    });
    if (!r.ok) return { ok: false as const, error: r.error, results: [] as Array<Record<string, unknown>> };
    return { ok: true as const, results: (r.body as { results?: Array<Record<string, unknown>> })?.results ?? [] };
  },
  async test(c: Ctx): Promise<TestResult> {
    const r = await httpJson(`${HUBSPOT}/crm/v3/objects/contacts?limit=1`, { headers: this.hdrs(c) });
    if (r.status === 401 || r.status === 403) return { ok: false, error: 'auth_failed' };
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'HubSpot private-app token verified (CRM read access)' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const items: HubItem[] = [];
    const tk = await this.searchObject(c, 'tickets', query, ['subject', 'content', 'hs_pipeline_stage']);
    if (tk.ok) for (const t of tk.results.slice(0, 5)) { const p = (t.properties ?? {}) as Record<string, unknown>; items.push({ ref: String(t.id), type: 'ticket', title: clip(p.subject || `Ticket ${t.id}`, 160), snippet: clip(stripHtml(String(p.content ?? '')), 400), url: `https://app.hubspot.com/contacts/tickets/${t.id}`, raw: t }); }
    const co = await this.searchObject(c, 'companies', query, ['name', 'domain', 'industry']);
    if (co.ok) for (const x of co.results.slice(0, 3)) { const p = (x.properties ?? {}) as Record<string, unknown>; items.push({ ref: String(x.id), type: 'account', title: clip(p.name || p.domain || `Company ${x.id}`, 160), snippet: clip(`${p.industry ?? ''} ${p.domain ?? ''}`, 400), url: null, raw: x }); }
    const dl = await this.searchObject(c, 'deals', query, ['dealname', 'dealstage', 'amount']);
    if (dl.ok) for (const x of dl.results.slice(0, 3)) { const p = (x.properties ?? {}) as Record<string, unknown>; items.push({ ref: String(x.id), type: 'opportunity', title: clip(p.dealname || `Deal ${x.id}`, 160), snippet: clip(`Stage: ${p.dealstage ?? '?'} · Amount: ${p.amount ?? '?'}`, 400), url: null, raw: x }); }
    return { ok: true, items };
  },
  async fetchRecord(c: Ctx, type: string, ref: string): Promise<AdapterResult> {
    const objectType = type === 'account' ? 'companies' : type === 'opportunity' ? 'deals' : type === 'ticket' ? 'tickets' : type === 'contact' ? 'contacts' : (type || 'tickets');
    const r = await httpJson(`${HUBSPOT}/crm/v3/objects/${objectType}/${encodeURIComponent(ref)}?properties=subject,content,name,domain,industry,dealname,amount,dealstage,firstname,lastname,email`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const rec = r.body as { properties?: Record<string, unknown> };
    const p = rec.properties ?? {};
    const title = String(p.subject || p.name || p.dealname || `${p.firstname ?? ''} ${p.lastname ?? ''}`.trim() || p.email || ref);
    return { ok: true, items: [{ ref, type, title: clip(title, 160), snippet: clip(stripHtml(String(p.content ?? p.domain ?? '')), 400), url: null, raw: rec }] };
  },
  async listRecent(c: Ctx): Promise<AdapterResult> {
    const r = await this.searchObject(c, 'tickets', '', ['subject', 'hs_pipeline_stage'], [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }]);
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, items: r.results.map((t) => { const p = (t.properties ?? {}) as Record<string, unknown>; return { ref: String(t.id), type: 'ticket', title: clip(p.subject || `Ticket ${t.id}`, 160), snippet: '', url: `https://app.hubspot.com/contacts/tickets/${t.id}`, raw: t }; }) };
  },
};

// ── slack ── secret: { token } (User OAuth Token xoxp- with search:read for
// message search; bot tokens can read channels but not search). Fixed base,
// so no per-tenant base_url. Read-through: search past messages/answers as a
// knowledge source. Posting replies is a follow-on write-back action.
const SLACK = 'https://slack.com/api';
const slack = {
  // Slack returns HTTP 200 with { ok:false, error } on logical failures.
  async api(c: Ctx, method: string, params: Record<string, string>): Promise<{ ok: boolean; body?: Record<string, unknown>; error?: string }> {
    const qs = new URLSearchParams(params).toString();
    const r = await httpJson(`${SLACK}/${method}${qs ? `?${qs}` : ''}`, { headers: { Authorization: `Bearer ${c.secret.token ?? ''}` } });
    const body = (r.body ?? null) as Record<string, unknown> | null;
    if (!r.ok && !body) return { ok: false, error: r.error };
    if (!body?.ok) {
      const e = String(body?.error ?? r.error ?? 'slack_error');
      return { ok: false, error: e === 'invalid_auth' || e === 'not_authed' ? 'auth_failed' : e };
    }
    return { ok: true, body };
  },
  async test(c: Ctx): Promise<TestResult> {
    const r = await this.api(c, 'auth.test', {});
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: `authenticated to ${r.body?.team ?? 'workspace'} as ${r.body?.user ?? 'token'}` };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const r = await this.api(c, 'search.messages', { query, count: '10' });
    if (!r.ok) {
      if (r.error === 'not_allowed_token_type') return { ok: false, error: 'slack_needs_user_token' };
      return { ok: false, error: r.error };
    }
    const matches = ((r.body?.messages as { matches?: Array<Record<string, unknown>> } | undefined)?.matches) ?? [];
    return {
      ok: true,
      items: matches.slice(0, 10).map((m) => {
        const ch = (m.channel ?? {}) as Record<string, unknown>;
        return { ref: `${ch.id ?? ''}:${m.ts ?? ''}`, type: 'message', title: clip(`#${ch.name ?? 'dm'} — ${m.username ?? m.user ?? ''}`, 160), snippet: clip(String(m.text ?? ''), 400), url: m.permalink ? String(m.permalink) : null, raw: { channel: ch.id, ts: m.ts } };
      }),
    };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const [channel, ts] = ref.split(':');
    if (!channel || !ts) return { ok: false, error: 'bad_ref' };
    const r = await this.api(c, 'conversations.history', { channel, latest: ts, oldest: ts, inclusive: 'true', limit: '1' });
    if (!r.ok) return { ok: false, error: r.error };
    const m = (((r.body?.messages as Array<Record<string, unknown>>) ?? [])[0] ?? {}) as Record<string, unknown>;
    return { ok: true, items: [{ ref, type: 'message', title: clip(`Message in ${channel}`, 160), snippet: clip(String(m.text ?? ''), 400), url: null, raw: m }] };
  },
  async listRecent(c: Ctx): Promise<AdapterResult> {
    const ch = await this.api(c, 'conversations.list', { types: 'public_channel', limit: '5', exclude_archived: 'true' });
    if (!ch.ok) return { ok: false, error: ch.error };
    const channels = ((ch.body?.channels as Array<Record<string, unknown>>) ?? []);
    if (!channels.length) return { ok: true, items: [] };
    const first = channels[0];
    const h = await this.api(c, 'conversations.history', { channel: String(first.id), limit: '8' });
    if (!h.ok) return { ok: true, items: [] };
    const msgs = ((h.body?.messages as Array<Record<string, unknown>>) ?? []);
    return { ok: true, items: msgs.map((m) => ({ ref: `${first.id}:${m.ts}`, type: 'message', title: clip(`#${first.name}`, 160), snippet: clip(String(m.text ?? ''), 400), url: null, raw: { ts: m.ts } })) };
  },
};

// Slack write-back — post a message/reply (the DE answering in-channel).
// Requires the token to have chat:write. Merged into NATIVE_ACTIONS below.
const slackActions: Record<string, NativeAction> = {
  slack_post_message: {
    render(_c, p) {
      if (!p.channel?.trim()) return { ok: false, error: 'param_required', detail: 'channel (id or #name) is required.' };
      if (!p.text?.trim()) return { ok: false, error: 'param_required', detail: 'text is required.' };
      const body: Record<string, unknown> = { channel: p.channel.trim(), text: p.text };
      if (p.thread_ts?.trim()) body.thread_ts = p.thread_ts.trim();
      return { ok: true, method: 'POST', url: `${SLACK}/chat.postMessage`, body };
    },
    async run(c, p) {
      const r = this.render(c, p);
      if (!r.ok) return { ok: false, error: r.error, detail: r.detail };
      const res = await httpJson(r.url!, { method: 'POST', headers: { Authorization: `Bearer ${c.secret.token ?? ''}`, 'Content-Type': 'application/json' }, body: JSON.stringify(r.body) });
      const b = res.body as { ok?: boolean; error?: string; ts?: string } | null;
      if (!b?.ok) return { ok: false, status: res.status, error: b?.error ?? res.error ?? 'slack_post_failed', raw: res.body };
      return { ok: true, status: res.status, raw: res.body, receipt: `Posted a message to ${p.channel} in Slack.` };
    },
  },
};

// NATIVE_ACTIONS (all write-side executors, keyed by execution_key) is
// defined AFTER every <provider>Actions object below, so its spread doesn't
// hit an uninitialized const at module load. Used only at request time.

// ── notion ── secret: { token } (internal integration token). Fixed base;
// the integration only sees pages explicitly shared with it. Knowledge-
// capable: syncDocs ingests shared page text.
const NOTION = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
function notionTitle(obj: Record<string, unknown>): string {
  const props = (obj.properties ?? {}) as Record<string, { type?: string; title?: Array<{ plain_text?: string }> }>;
  for (const k of Object.keys(props)) {
    const pr = props[k];
    if (pr?.type === 'title' && Array.isArray(pr.title)) return pr.title.map((t) => t.plain_text ?? '').join('') || 'Untitled';
  }
  const dbTitle = obj.title as Array<{ plain_text?: string }> | undefined;
  if (Array.isArray(dbTitle)) return dbTitle.map((t) => t.plain_text ?? '').join('') || 'Untitled';
  return 'Untitled';
}
function notionBlockText(blocks: Array<Record<string, unknown>>): string {
  const out: string[] = [];
  for (const b of blocks) {
    const type = String(b.type ?? '');
    const data = (b[type] ?? {}) as { rich_text?: Array<{ plain_text?: string }> };
    if (Array.isArray(data.rich_text)) { const t = data.rich_text.map((r) => r.plain_text ?? '').join(''); if (t.trim()) out.push(t); }
  }
  return out.join('\n');
}
const notion = {
  hdrs: (c: Ctx) => ({ Authorization: `Bearer ${c.secret.token ?? ''}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' }),
  async test(c: Ctx): Promise<TestResult> {
    const r = await httpJson(`${NOTION}/users/me`, { headers: this.hdrs(c) });
    if (r.status === 401) return { ok: false, error: 'auth_failed' };
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'Notion integration token verified' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const r = await httpJson(`${NOTION}/search`, { method: 'POST', headers: this.hdrs(c), body: JSON.stringify({ query, page_size: 10 }) });
    if (!r.ok) return { ok: false, error: r.error };
    const results = (r.body as { results?: Array<Record<string, unknown>> })?.results ?? [];
    return { ok: true, items: results.slice(0, 10).map((o) => ({ ref: String(o.id), type: o.object === 'database' ? 'database' : 'page', title: clip(notionTitle(o), 160), snippet: '', url: o.url ? String(o.url) : null, raw: { id: o.id } })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const pg = await httpJson(`${NOTION}/pages/${encodeURIComponent(ref)}`, { headers: this.hdrs(c) });
    const title = pg.ok ? notionTitle(pg.body as Record<string, unknown>) : ref;
    const url = pg.ok ? ((pg.body as { url?: string }).url ?? null) : null;
    const bl = await httpJson(`${NOTION}/blocks/${encodeURIComponent(ref)}/children?page_size=50`, { headers: this.hdrs(c) });
    const text = bl.ok ? notionBlockText(((bl.body as { results?: Array<Record<string, unknown>> })?.results) ?? []) : '';
    return { ok: true, items: [{ ref, type: 'page', title: clip(title, 160), snippet: clip(text, 400), url, raw: { id: ref } }] };
  },
  async listRecent(c: Ctx): Promise<AdapterResult> {
    const r = await httpJson(`${NOTION}/search`, { method: 'POST', headers: this.hdrs(c), body: JSON.stringify({ page_size: 10, sort: { direction: 'descending', timestamp: 'last_edited_time' } }) });
    if (!r.ok) return { ok: false, error: r.error };
    const results = (r.body as { results?: Array<Record<string, unknown>> })?.results ?? [];
    return { ok: true, items: results.map((o) => ({ ref: String(o.id), type: 'page', title: clip(notionTitle(o), 160), snippet: '', url: o.url ? String(o.url) : null, raw: { id: o.id } })) };
  },
  async discoverDocs(c: Ctx, f: IngestFilters): Promise<{ ok: boolean; candidates?: Candidate[]; error?: string }> {
    const r = await httpJson(`${NOTION}/search`, { method: 'POST', headers: this.hdrs(c), body: JSON.stringify({ page_size: MAX_SYNC_FILES, filter: { value: 'page', property: 'object' } }) });
    if (!r.ok) return { ok: false, error: r.error };
    const pages = (r.body as { results?: Array<Record<string, unknown>> })?.results ?? [];
    const out: Candidate[] = [];
    for (const p of pages) {
      if (out.length >= MAX_SYNC_FILES) break;
      const cand: Candidate = { external_ref: `notion:${p.id}`, title: clip(notionTitle(p), 200), path: '', file_type: 'text', size_bytes: null };
      if (candidatePasses(cand, f)) out.push(cand);
    }
    return { ok: true, candidates: out };
  },
  async fetchTexts(c: Ctx, items: Candidate[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const it of items) {
      const id = it.external_ref.replace(/^notion:/, '');
      const bl = await httpJson(`${NOTION}/blocks/${encodeURIComponent(id)}/children?page_size=100`, { headers: this.hdrs(c) });
      out[it.external_ref] = bl.ok ? notionBlockText(((bl.body as { results?: Array<Record<string, unknown>> })?.results) ?? []).slice(0, MAX_DOC_CHARS) : '';
    }
    return out;
  },
  async syncDocs(c: Ctx, f: IngestFilters = {}): Promise<SyncResult> {
    const d = await this.discoverDocs(c, f);
    if (!d.ok) return { ok: false, error: d.error };
    const cands = d.candidates ?? [];
    if (!cands.length) return { ok: false, error: 'no_readable_pages', detail: 'No pages shared with this Notion integration match your ingest settings.' };
    const texts = await this.fetchTexts(c, cands);
    const docs: SyncDoc[] = cands.map((cd) => ({ external_ref: cd.external_ref, title: cd.title, content: texts[cd.external_ref] ?? '', url: null })).filter((dd) => dd.content);
    if (!docs.length) return { ok: false, error: 'no_readable_pages', detail: 'Matching pages had no text.' };
    return { ok: true, docs };
  },
};

// ── teams ── secret: { tenant_id, client_id, client_secret } (Graph app-only,
// same shape as SharePoint). Reads channel messages via the Graph Search API —
// which needs the PROTECTED ChannelMessage.Read.All permission (admin consent +
// Microsoft approval, metered). Honest error until granted. Read-through search.
const teams = {
  async token(c: Ctx): Promise<{ ok: boolean; token?: string; error?: string }> {
    const tenant = (c.secret.tenant_id ?? '').trim();
    if (!tenant) return { ok: false, error: 'missing_tenant_id' };
    const r = await httpJson(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: c.secret.client_id ?? '', client_secret: c.secret.client_secret ?? '', scope: 'https://graph.microsoft.com/.default' }).toString(),
    });
    const b = r.body as { access_token?: string; error_description?: string } | null;
    if (!r.ok || !b?.access_token) return { ok: false, error: b?.error_description ?? r.error ?? 'oauth_failed' };
    return { ok: true, token: b.access_token };
  },
  async test(c: Ctx): Promise<TestResult> {
    const t = await this.token(c);
    if (!t.ok) return { ok: false, error: t.error };
    const r = await httpJson(`${GRAPH}/teams?$top=1`, { headers: { Authorization: `Bearer ${t.token}` } });
    if (r.status === 403) return { ok: false, error: 'graph_permission_missing' };
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'Microsoft Graph app-only token verified (Teams read access)' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const t = await this.token(c);
    if (!t.ok) return { ok: false, error: t.error };
    const r = await httpJson(`${GRAPH}/search/query`, {
      method: 'POST', headers: { Authorization: `Bearer ${t.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ entityTypes: ['chatMessage'], query: { queryString: query }, from: 0, size: 10 }] }),
    });
    if (r.status === 403) return { ok: false, error: 'graph_permission_missing' };
    if (!r.ok) return { ok: false, error: r.error };
    const hits = (((r.body as { value?: Array<{ hitsContainers?: Array<{ hits?: Array<Record<string, unknown>> }> }> })?.value?.[0]?.hitsContainers?.[0]?.hits) ?? []);
    return {
      ok: true,
      items: hits.slice(0, 10).map((h) => {
        const rs = (h.resource ?? {}) as { id?: unknown; from?: { user?: { displayName?: string }; application?: { displayName?: string } }; body?: { content?: string }; webUrl?: string };
        const from = rs.from?.user?.displayName ?? rs.from?.application?.displayName ?? '';
        return { ref: String(rs.id ?? h.hitId ?? ''), type: 'message', title: clip(`Teams — ${from}`, 160), snippet: clip(stripHtml(String(rs.body?.content ?? h.summary ?? '')), 400), url: rs.webUrl ? String(rs.webUrl) : null, raw: { id: rs.id } };
      }),
    };
  },
  fetchRecord(_c: Ctx, _type: string, _ref: string): Promise<AdapterResult> {
    return Promise.resolve({ ok: false, error: 'fetch_by_id_unsupported', detail: 'Teams messages are returned inline by search.' });
  },
  listRecent(_c: Ctx): Promise<AdapterResult> {
    return Promise.resolve({ ok: true, items: [] });
  },
};

// ── box ── secret: { client_id, client_secret, enterprise_id } (Client
// Credentials Grant, app-only — no user redirect). Enterprise file store;
// knowledge-capable via syncDocs (text + PDF; Box has no on-the-fly convert).
const BOX = 'https://api.box.com/2.0';
const box = {
  async token(c: Ctx): Promise<{ ok: boolean; token?: string; error?: string }> {
    const r = await httpJson('https://api.box.com/oauth2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: c.secret.client_id ?? '', client_secret: c.secret.client_secret ?? '', box_subject_type: 'enterprise', box_subject_id: c.secret.enterprise_id ?? '' }).toString(),
    });
    const b = r.body as { access_token?: string; error_description?: string } | null;
    if (!r.ok || !b?.access_token) return { ok: false, error: b?.error_description ?? r.error ?? 'oauth_failed' };
    return { ok: true, token: b.access_token };
  },
  async test(c: Ctx): Promise<TestResult> {
    const t = await this.token(c);
    if (!t.ok) return { ok: false, error: t.error };
    const r = await httpJson(`${BOX}/users/me`, { headers: { Authorization: `Bearer ${t.token}` } });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'Box app token verified' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const t = await this.token(c);
    if (!t.ok) return { ok: false, error: t.error };
    const r = await httpJson(`${BOX}/search?query=${encodeURIComponent(query)}&limit=10&type=file`, { headers: { Authorization: `Bearer ${t.token}` } });
    if (!r.ok) return { ok: false, error: r.error };
    const entries = (r.body as { entries?: Array<Record<string, unknown>> })?.entries ?? [];
    return { ok: true, items: entries.slice(0, 10).map((e) => ({ ref: String(e.id), type: 'document', title: clip(e.name, 160), snippet: clip(e.description ?? '', 400), url: `https://app.box.com/file/${e.id}`, raw: { id: e.id, name: e.name } })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const t = await this.token(c);
    if (!t.ok) return { ok: false, error: t.error };
    const r = await httpJson(`${BOX}/files/${encodeURIComponent(ref)}`, { headers: { Authorization: `Bearer ${t.token}` } });
    if (!r.ok) return { ok: false, error: r.error };
    const f = r.body as { name?: unknown; description?: unknown };
    return { ok: true, items: [{ ref, type: 'document', title: clip(f.name, 160), snippet: clip(f.description ?? '', 400), url: `https://app.box.com/file/${ref}`, raw: f }] };
  },
  async listRecent(c: Ctx): Promise<AdapterResult> {
    const t = await this.token(c);
    if (!t.ok) return { ok: false, error: t.error };
    const r = await httpJson(`${BOX}/folders/0/items?limit=10&sort=date&direction=DESC&fields=id,name,type`, { headers: { Authorization: `Bearer ${t.token}` } });
    if (!r.ok) return { ok: false, error: r.error };
    const entries = (r.body as { entries?: Array<Record<string, unknown>> })?.entries ?? [];
    return { ok: true, items: entries.filter((e) => e.type === 'file').map((e) => ({ ref: String(e.id), type: 'document', title: clip(e.name, 160), snippet: '', url: `https://app.box.com/file/${e.id}`, raw: { id: e.id } })) };
  },
  async discoverDocs(c: Ctx, f: IngestFilters): Promise<{ ok: boolean; candidates?: Candidate[]; error?: string }> {
    const t = await this.token(c);
    if (!t.ok) return { ok: false, error: t.error };
    const auth = { Authorization: `Bearer ${t.token}` };
    const out: Candidate[] = [];
    const queue: Array<{ id: string; path: string }> = [{ id: String(f.folder || '0'), path: '' }];
    let folders = 0;
    while (queue.length && out.length < MAX_SYNC_FILES && folders < 40) {
      const cur = queue.shift()!;
      folders++;
      const r = await httpJson(`${BOX}/folders/${cur.id}/items?limit=200&fields=id,name,type,size`, { headers: auth });
      if (!r.ok) break;
      const entries = (r.body as { entries?: Array<Record<string, unknown>> })?.entries ?? [];
      for (const e of entries) {
        if (out.length >= MAX_SYNC_FILES) break;
        const name = String(e.name ?? '');
        const childPath = cur.path ? `${cur.path}/${name}` : name;
        if (e.type === 'folder') { queue.push({ id: String(e.id), path: childPath }); continue; }
        if (e.type !== 'file') continue;
        const ft = fileTypeOf(name);
        if (ft !== 'text' && ft !== 'pdf') continue;   // Box: no on-the-fly convert — text + PDF only
        const cand: Candidate = { external_ref: `box:${e.id}`, title: clip(name, 200), path: cur.path, file_type: ft, size_bytes: typeof e.size === 'number' ? e.size : null };
        if (candidatePasses(cand, f)) out.push(cand);
      }
    }
    return { ok: true, candidates: out };
  },
  async fetchTexts(c: Ctx, items: Candidate[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const t = await this.token(c);
    if (!t.ok) return out;
    for (const it of items) out[it.external_ref] = await boxFileText(it.external_ref.replace(/^box:/, ''), it.file_type, t.token!);
    return out;
  },
  async syncDocs(c: Ctx, f: IngestFilters = {}): Promise<SyncResult> {
    const d = await this.discoverDocs(c, f);
    if (!d.ok) return { ok: false, error: d.error };
    const cands = d.candidates ?? [];
    if (!cands.length) return { ok: false, error: 'no_readable_documents', detail: 'No text/PDF files match your ingest settings.' };
    const texts = await this.fetchTexts(c, cands);
    const docs: SyncDoc[] = cands.map((cd) => ({ external_ref: cd.external_ref, title: cd.title, content: texts[cd.external_ref] ?? '', url: `https://app.box.com/file/${cd.external_ref.replace(/^box:/, '')}` })).filter((dd) => dd.content);
    if (!docs.length) return { ok: false, error: 'no_readable_documents', detail: 'Matching files had no extractable text.' };
    return { ok: true, docs };
  },
};
async function boxFileText(id: string, ft: string, token: string): Promise<string> {
  const res = await safeFetch(`${BOX}/files/${id}/content`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res) return '';
  if (ft === 'pdf') return (await pdfBytesToText(new Uint8Array(await res.arrayBuffer()))).slice(0, MAX_DOC_CHARS);
  const raw = await res.text();
  const looksHtml = /<\/?[a-z][\s\S]*>/i.test(raw.slice(0, 4000));
  return (looksHtml ? stripHtml(raw) : raw).slice(0, MAX_DOC_CHARS);
}

// ── freshdesk / freshservice ── secret: { api_key } · base_url = the account
// subdomain. Basic auth (api_key as username). Tickets as the helpdesk surface.
const freshAuth = (c: Ctx) => 'Basic ' + btoa(`${c.secret.api_key ?? ''}:X`);
function freshTicketItems(tickets: unknown, baseUrl: string, path: string, query?: string): HubItem[] {
  const list = Array.isArray(tickets) ? (tickets as Array<Record<string, unknown>>) : [];
  const q = (query ?? '').toLowerCase();
  const filtered = q ? list.filter((t) => String(t.subject ?? '').toLowerCase().includes(q) || String(t.description_text ?? '').toLowerCase().includes(q)) : list;
  return filtered.slice(0, 10).map((t) => ({ ref: String(t.id), type: 'ticket', title: clip(t.subject || `Ticket ${t.id}`, 160), snippet: clip(stripHtml(String(t.description_text ?? t.description ?? '')), 400), url: `${baseUrl}${path}${t.id}`, raw: { id: t.id, status: t.status } }));
}
function makeFreshAdapter(ticketPath: string) {
  return {
    async test(c: Ctx): Promise<TestResult> {
      const r = await httpJson(`${c.baseUrl}/api/v2/tickets?per_page=1`, { headers: { Authorization: freshAuth(c) } });
      if (r.status === 401 || r.status === 403) return { ok: false, error: 'auth_failed' };
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, detail: 'API key verified' };
    },
    async search(c: Ctx, query: string): Promise<AdapterResult> {
      const r = await httpJson(`${c.baseUrl}/api/v2/tickets?per_page=30&order_by=updated_at&order_type=desc`, { headers: { Authorization: freshAuth(c) } });
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, items: freshTicketItems(r.body, c.baseUrl, ticketPath, query) };
    },
    async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
      const r = await httpJson(`${c.baseUrl}/api/v2/tickets/${encodeURIComponent(ref)}`, { headers: { Authorization: freshAuth(c) } });
      if (!r.ok) return { ok: false, error: r.error };
      const t = r.body as Record<string, unknown>;
      return { ok: true, items: [{ ref, type: 'ticket', title: clip(t.subject || `Ticket ${ref}`, 160), snippet: clip(stripHtml(String(t.description_text ?? t.description ?? '')), 400), url: `${c.baseUrl}${ticketPath}${ref}`, raw: t }] };
    },
    async listRecent(c: Ctx): Promise<AdapterResult> {
      const r = await httpJson(`${c.baseUrl}/api/v2/tickets?per_page=10&order_by=updated_at&order_type=desc`, { headers: { Authorization: freshAuth(c) } });
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, items: freshTicketItems(r.body, c.baseUrl, ticketPath) };
    },
  };
}
const freshdesk = makeFreshAdapter('/a/tickets/');
const freshservice = makeFreshAdapter('/a/tickets/');

// ── servicenow ── secret: { username, password } · base = instance URL.
// Helpdesk (incidents) + KB (kb_knowledge, syncDocs). Table API, Basic auth.
const snAuth = (c: Ctx) => 'Basic ' + btoa(`${c.secret.username ?? ''}:${c.secret.password ?? ''}`);
const servicenow = {
  async table(c: Ctx, table: string, qs: string): Promise<{ ok: boolean; error?: string; result: Array<Record<string, unknown>> }> {
    const r = await httpJson(`${c.baseUrl}/api/now/table/${table}?${qs}`, { headers: { Authorization: snAuth(c), Accept: 'application/json' } });
    if (r.status === 401 || r.status === 403) return { ok: false, error: 'auth_failed', result: [] };
    if (!r.ok) return { ok: false, error: r.error, result: [] };
    return { ok: true, result: ((r.body as { result?: Array<Record<string, unknown>> })?.result) ?? [] };
  },
  async test(c: Ctx): Promise<TestResult> {
    const r = await this.table(c, 'incident', 'sysparm_limit=1');
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'ServiceNow instance reachable with these credentials' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const q = encodeURIComponent(query.replace(/[\^=]/g, ' '));
    const r = await this.table(c, 'incident', `sysparm_query=short_descriptionLIKE${q}^ORdescriptionLIKE${q}^ORDERBYDESCsys_updated_on&sysparm_limit=8&sysparm_fields=sys_id,number,short_description,description,state`);
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, items: r.result.map((t) => ({ ref: String(t.sys_id), type: 'ticket', title: clip(`${t.number}: ${t.short_description ?? ''}`, 160), snippet: clip(t.description, 400), url: `${c.baseUrl}/nav_to.do?uri=incident.do?sys_id=${t.sys_id}`, raw: { sys_id: t.sys_id, state: t.state } })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const r = await this.table(c, 'incident', `sysparm_query=sys_id=${encodeURIComponent(ref)}&sysparm_limit=1`);
    if (!r.ok) return { ok: false, error: r.error };
    const t = r.result[0] ?? {};
    return { ok: true, items: [{ ref, type: 'ticket', title: clip(`${t.number ?? ''}: ${t.short_description ?? ''}`, 160), snippet: clip(t.description, 400), url: `${c.baseUrl}/nav_to.do?uri=incident.do?sys_id=${ref}`, raw: t }] };
  },
  async listRecent(c: Ctx): Promise<AdapterResult> {
    const r = await this.table(c, 'incident', 'sysparm_query=ORDERBYDESCsys_updated_on&sysparm_limit=10&sysparm_fields=sys_id,number,short_description');
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, items: r.result.map((t) => ({ ref: String(t.sys_id), type: 'ticket', title: clip(`${t.number}: ${t.short_description ?? ''}`, 160), snippet: '', url: `${c.baseUrl}/nav_to.do?uri=incident.do?sys_id=${t.sys_id}`, raw: { sys_id: t.sys_id } })) };
  },
  async syncDocs(c: Ctx): Promise<SyncResult> {
    const r = await this.table(c, 'kb_knowledge', 'sysparm_query=workflow_state=published^ORDERBYDESCsys_updated_on&sysparm_limit=50&sysparm_fields=sys_id,short_description,text');
    if (!r.ok) return { ok: false, error: r.error };
    const docs = r.result.map((k) => ({ external_ref: `servicenow:${k.sys_id}`, title: clip(k.short_description, 200), content: stripHtml(String(k.text ?? '')).slice(0, MAX_DOC_CHARS), url: `${c.baseUrl}/kb_view.do?sysparm_article=${k.sys_id}` })).filter((d) => d.content);
    if (!docs.length) return { ok: false, error: 'no_published_articles', detail: 'No published knowledge articles found.' };
    return { ok: true, docs };
  },
};
const servicenowActions: Record<string, NativeAction> = {
  servicenow_add_work_note: {
    render(c, p) {
      if (!p.external_ref) return { ok: false, error: 'param_required', detail: 'external_ref (incident sys_id) is required.' };
      if (!p.note?.trim()) return { ok: false, error: 'param_required', detail: 'note text is required.' };
      return { ok: true, method: 'PATCH', url: `${c.baseUrl}/api/now/table/incident/${encodeURIComponent(p.external_ref)}`, body: { work_notes: p.note } };
    },
    async run(c, p) {
      const r = this.render(c, p);
      if (!r.ok) return { ok: false, error: r.error, detail: r.detail };
      const res = await httpJson(r.url!, { method: 'PATCH', headers: { Authorization: snAuth(c), 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(r.body) });
      if (!res.ok) return { ok: false, status: res.status, error: res.error, raw: res.body };
      return { ok: true, status: res.status, raw: res.body, receipt: `Added a work note to incident ${p.external_ref}.` };
    },
  },
};

// ── dynamics ── secret: { tenant_id, client_id, client_secret } · base = org
// URL (https://org.crm.dynamics.com). Entra client-credentials → Dataverse.
const dynamics = {
  async token(c: Ctx): Promise<{ ok: boolean; token?: string; error?: string }> {
    const tenant = (c.secret.tenant_id ?? '').trim();
    if (!tenant) return { ok: false, error: 'missing_tenant_id' };
    const r = await httpJson(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: c.secret.client_id ?? '', client_secret: c.secret.client_secret ?? '', scope: `${c.baseUrl.replace(/\/+$/, '')}/.default` }).toString(),
    });
    const b = r.body as { access_token?: string; error_description?: string } | null;
    if (!r.ok || !b?.access_token) return { ok: false, error: b?.error_description ?? r.error ?? 'oauth_failed' };
    return { ok: true, token: b.access_token };
  },
  async odata(c: Ctx, token: string, path: string): Promise<{ ok: boolean; error?: string; value: Array<Record<string, unknown>> }> {
    const r = await httpJson(`${c.baseUrl.replace(/\/+$/, '')}/api/data/v9.2/${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0' } });
    if (!r.ok) return { ok: false, error: r.error, value: [] };
    return { ok: true, value: ((r.body as { value?: Array<Record<string, unknown>> })?.value) ?? [] };
  },
  async test(c: Ctx): Promise<TestResult> {
    const t = await this.token(c);
    if (!t.ok) return { ok: false, error: t.error };
    const r = await httpJson(`${c.baseUrl.replace(/\/+$/, '')}/api/data/v9.2/WhoAmI`, { headers: { Authorization: `Bearer ${t.token}`, Accept: 'application/json' } });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'Dynamics 365 Dataverse reachable (app-only token verified)' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const t = await this.token(c);
    if (!t.ok) return { ok: false, error: t.error };
    const q = query.replace(/'/g, "''");
    const items: HubItem[] = [];
    const acc = await this.odata(c, t.token!, `accounts?$filter=contains(name,'${encodeURIComponent(q)}')&$select=accountid,name,websiteurl&$top=5`);
    if (acc.ok) for (const a of acc.value) items.push({ ref: String(a.accountid), type: 'account', title: clip(a.name, 160), snippet: clip(a.websiteurl, 400), url: `${c.baseUrl}/main.aspx?pagetype=entityrecord&etn=account&id=${a.accountid}`, raw: a });
    const inc = await this.odata(c, t.token!, `incidents?$filter=contains(title,'${encodeURIComponent(q)}')&$select=incidentid,title,ticketnumber,description&$top=5`);
    if (inc.ok) for (const i of inc.value) items.push({ ref: String(i.incidentid), type: 'conversation', title: clip(`${i.ticketnumber ?? ''} ${i.title ?? ''}`, 160), snippet: clip(i.description, 400), url: null, raw: i });
    const opp = await this.odata(c, t.token!, `opportunities?$filter=contains(name,'${encodeURIComponent(q)}')&$select=opportunityid,name,estimatedvalue&$top=5`);
    if (opp.ok) for (const o of opp.value) items.push({ ref: String(o.opportunityid), type: 'opportunity', title: clip(o.name, 160), snippet: clip(`Est. value: ${o.estimatedvalue ?? '?'}`, 400), url: null, raw: o });
    return { ok: true, items };
  },
  async fetchRecord(c: Ctx, type: string, ref: string): Promise<AdapterResult> {
    const t = await this.token(c);
    if (!t.ok) return { ok: false, error: t.error };
    const set = type === 'account' ? 'accounts' : type === 'opportunity' ? 'opportunities' : type === 'conversation' ? 'incidents' : 'accounts';
    const r = await httpJson(`${c.baseUrl.replace(/\/+$/, '')}/api/data/v9.2/${set}(${encodeURIComponent(ref)})`, { headers: { Authorization: `Bearer ${t.token}`, Accept: 'application/json' } });
    if (!r.ok) return { ok: false, error: r.error };
    const rec = r.body as Record<string, unknown>;
    return { ok: true, items: [{ ref, type, title: clip(rec.name ?? rec.title ?? rec.fullname ?? ref, 160), snippet: clip(rec.description ?? rec.websiteurl ?? '', 400), url: null, raw: rec }] };
  },
  async listRecent(c: Ctx): Promise<AdapterResult> {
    const t = await this.token(c);
    if (!t.ok) return { ok: false, error: t.error };
    const r = await this.odata(c, t.token!, 'incidents?$select=incidentid,title,ticketnumber&$orderby=modifiedon desc&$top=10');
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, items: r.value.map((i) => ({ ref: String(i.incidentid), type: 'conversation', title: clip(`${i.ticketnumber ?? ''} ${i.title ?? ''}`, 160), snippet: '', url: null, raw: i })) };
  },
};

// ── github ── secret: { token } (PAT) · fixed base api.github.com.
// product_system: issues (search_records / get_record) + comment write.
const GITHUB = 'https://api.github.com';
const github = {
  hdrs: (c: Ctx) => ({ Authorization: `Bearer ${c.secret.token ?? ''}`, Accept: 'application/vnd.github+json', 'User-Agent': 'DreamTeam-DE' }),
  async test(c: Ctx): Promise<TestResult> {
    const r = await httpJson(`${GITHUB}/user`, { headers: this.hdrs(c) });
    if (r.status === 401) return { ok: false, error: 'auth_failed' };
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: `authenticated as ${(r.body as { login?: string })?.login ?? 'token'}` };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const r = await httpJson(`${GITHUB}/search/issues?q=${encodeURIComponent(query)}&per_page=10`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const items = ((r.body as { items?: Array<Record<string, unknown>> })?.items) ?? [];
    return { ok: true, items: items.map((i) => { const repo = String(i.repository_url ?? '').replace(`${GITHUB}/repos/`, ''); return { ref: `${repo}/${i.number}`, type: 'record', title: clip(`#${i.number} ${i.title ?? ''}`, 160), snippet: clip(i.body, 400), url: i.html_url ? String(i.html_url) : null, raw: { number: i.number, state: i.state } }; }) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const m = ref.match(/^(.+)\/(\d+)$/);
    if (!m) return { ok: false, error: 'bad_ref', detail: 'ref must be owner/repo/number.' };
    const r = await httpJson(`${GITHUB}/repos/${m[1]}/issues/${m[2]}`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const i = r.body as Record<string, unknown>;
    return { ok: true, items: [{ ref, type: 'record', title: clip(`#${i.number} ${i.title ?? ''}`, 160), snippet: clip(i.body, 400), url: i.html_url ? String(i.html_url) : null, raw: i }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> {
    return this.search(c, 'is:issue is:open sort:updated-desc');
  },
};
const githubActions: Record<string, NativeAction> = {
  github_add_comment: {
    render(_c, p) {
      const m = (p.external_ref ?? '').match(/^(.+)\/(\d+)$/);
      if (!m) return { ok: false, error: 'param_required', detail: 'external_ref must be owner/repo/number.' };
      if (!p.body?.trim()) return { ok: false, error: 'param_required', detail: 'body is required.' };
      return { ok: true, method: 'POST', url: `${GITHUB}/repos/${m[1]}/issues/${m[2]}/comments`, body: { body: p.body } };
    },
    async run(c, p) {
      const r = this.render(c, p);
      if (!r.ok) return { ok: false, error: r.error, detail: r.detail };
      const res = await httpJson(r.url!, { method: 'POST', headers: { ...github.hdrs(c), 'Content-Type': 'application/json' }, body: JSON.stringify(r.body) });
      if (!res.ok) return { ok: false, status: res.status, error: res.error, raw: res.body };
      return { ok: true, status: res.status, raw: res.body, receipt: `Commented on ${p.external_ref} in GitHub.` };
    },
  },
};

// ── gitlab ── secret: { token } (PAT) · base = gitlab.com or self-managed.
// product_system: issues (search) + note write.
const gitlab = {
  hdrs: (c: Ctx) => ({ 'PRIVATE-TOKEN': c.secret.token ?? '' }),
  async test(c: Ctx): Promise<TestResult> {
    const r = await httpJson(`${c.baseUrl}/api/v4/user`, { headers: this.hdrs(c) });
    if (r.status === 401) return { ok: false, error: 'auth_failed' };
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: `authenticated as ${(r.body as { username?: string })?.username ?? 'token'}` };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const r = await httpJson(`${c.baseUrl}/api/v4/search?scope=issues&search=${encodeURIComponent(query)}&per_page=10`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const items = Array.isArray(r.body) ? (r.body as Array<Record<string, unknown>>) : [];
    return { ok: true, items: items.map((i) => ({ ref: `${i.project_id}/${i.iid}`, type: 'record', title: clip(`#${i.iid} ${i.title ?? ''}`, 160), snippet: clip(i.description, 400), url: i.web_url ? String(i.web_url) : null, raw: { iid: i.iid, state: i.state } })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const m = ref.match(/^(\d+)\/(\d+)$/);
    if (!m) return { ok: false, error: 'bad_ref', detail: 'ref must be projectId/iid.' };
    const r = await httpJson(`${c.baseUrl}/api/v4/projects/${m[1]}/issues/${m[2]}`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const i = r.body as Record<string, unknown>;
    return { ok: true, items: [{ ref, type: 'record', title: clip(`#${i.iid} ${i.title ?? ''}`, 160), snippet: clip(i.description, 400), url: i.web_url ? String(i.web_url) : null, raw: i }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> {
    return httpJson(`${c.baseUrl}/api/v4/issues?scope=all&order_by=updated_at&per_page=10`, { headers: this.hdrs(c) }).then((r) => {
      if (!r.ok) return { ok: false, error: r.error };
      const items = Array.isArray(r.body) ? (r.body as Array<Record<string, unknown>>) : [];
      return { ok: true, items: items.map((i) => ({ ref: `${i.project_id}/${i.iid}`, type: 'record', title: clip(`#${i.iid} ${i.title ?? ''}`, 160), snippet: '', url: i.web_url ? String(i.web_url) : null, raw: { iid: i.iid } })) };
    });
  },
};
const gitlabActions: Record<string, NativeAction> = {
  gitlab_add_note: {
    render(c, p) {
      const m = (p.external_ref ?? '').match(/^(\d+)\/(\d+)$/);
      if (!m) return { ok: false, error: 'param_required', detail: 'external_ref must be projectId/iid.' };
      if (!p.body?.trim()) return { ok: false, error: 'param_required', detail: 'body is required.' };
      return { ok: true, method: 'POST', url: `${c.baseUrl}/api/v4/projects/${m[1]}/issues/${m[2]}/notes`, body: { body: p.body } };
    },
    async run(c, p) {
      const r = this.render(c, p);
      if (!r.ok) return { ok: false, error: r.error, detail: r.detail };
      const res = await httpJson(r.url!, { method: 'POST', headers: { ...gitlab.hdrs(c), 'Content-Type': 'application/json' }, body: JSON.stringify(r.body) });
      if (!res.ok) return { ok: false, status: res.status, error: res.error, raw: res.body };
      return { ok: true, status: res.status, raw: res.body, receipt: `Added a note to GitLab issue ${p.external_ref}.` };
    },
  },
};

// ── guru ── secret: { username, api_token } · fixed base. knowledge_base +
// syncDocs. Basic auth (user:token).
const GURU = 'https://api.getguru.com/api/v1';
const guruAuth = (c: Ctx) => 'Basic ' + btoa(`${c.secret.username ?? ''}:${c.secret.api_token ?? ''}`);
const guru = {
  async test(c: Ctx): Promise<TestResult> {
    const r = await httpJson(`${GURU}/teams`, { headers: { Authorization: guruAuth(c) } });
    if (r.status === 401 || r.status === 403) return { ok: false, error: 'auth_failed' };
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'Guru API token verified' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const r = await httpJson(`${GURU}/search/query?searchTerms=${encodeURIComponent(query)}&maxResults=10`, { headers: { Authorization: guruAuth(c) } });
    if (!r.ok) return { ok: false, error: r.error };
    const cards = Array.isArray(r.body) ? (r.body as Array<Record<string, unknown>>) : [];
    return { ok: true, items: cards.slice(0, 10).map((cd) => ({ ref: String(cd.id), type: 'article', title: clip(cd.preferredPhrase || cd.title, 160), snippet: clip(stripHtml(String(cd.content ?? '')), 400), url: cd.slug ? `https://app.getguru.com/card/${cd.slug}` : null, raw: { id: cd.id } })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const r = await httpJson(`${GURU}/cards/${encodeURIComponent(ref)}`, { headers: { Authorization: guruAuth(c) } });
    if (!r.ok) return { ok: false, error: r.error };
    const cd = r.body as Record<string, unknown>;
    return { ok: true, items: [{ ref, type: 'article', title: clip(cd.preferredPhrase || ref, 160), snippet: clip(stripHtml(String(cd.content ?? '')), 400), url: null, raw: cd }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
  async syncDocs(c: Ctx): Promise<SyncResult> {
    const r = await httpJson(`${GURU}/search/query?searchTerms=&maxResults=50`, { headers: { Authorization: guruAuth(c) } });
    if (!r.ok) return { ok: false, error: r.error };
    const cards = Array.isArray(r.body) ? (r.body as Array<Record<string, unknown>>) : [];
    const docs = cards.map((cd) => ({ external_ref: `guru:${cd.id}`, title: clip(cd.preferredPhrase || 'Card', 200), content: stripHtml(String(cd.content ?? '')).slice(0, MAX_DOC_CHARS), url: null })).filter((d) => d.content);
    if (!docs.length) return { ok: false, error: 'no_cards', detail: 'No Guru cards returned.' };
    return { ok: true, docs };
  },
};

// ── document360 ── secret: { api_token } · fixed base. knowledge_base +
// syncDocs. NOTE: v2 API article traversal (versions → categories → articles)
// is multi-step and response shapes vary by plan — verify against live creds.
const D360 = 'https://apihub.document360.io/v2';
const d360 = {
  hdrs: (c: Ctx) => ({ api_token: c.secret.api_token ?? '', Accept: 'application/json' }),
  async articleList(c: Ctx): Promise<{ ok: boolean; error?: string; articles: Array<Record<string, unknown>> }> {
    const v = await httpJson(`${D360}/ProjectVersions`, { headers: this.hdrs(c) });
    if (!v.ok) return { ok: false, error: v.error, articles: [] };
    const versions = ((v.body as { data?: Array<Record<string, unknown>> })?.data) ?? (Array.isArray(v.body) ? (v.body as Array<Record<string, unknown>>) : []);
    const arts: Array<Record<string, unknown>> = [];
    for (const ver of versions.slice(0, 1)) {
      const cats = await httpJson(`${D360}/ProjectVersions/${ver.id}/categories`, { headers: this.hdrs(c) });
      const catList = ((cats.body as { data?: Array<Record<string, unknown>> })?.data) ?? (Array.isArray(cats.body) ? (cats.body as Array<Record<string, unknown>>) : []);
      const walk = (nodes: Array<Record<string, unknown>>) => { for (const n of nodes) { if (Array.isArray(n.articles)) arts.push(...(n.articles as Array<Record<string, unknown>>)); if (Array.isArray(n.child_categories)) walk(n.child_categories as Array<Record<string, unknown>>); } };
      walk(catList);
    }
    return { ok: true, articles: arts };
  },
  async test(c: Ctx): Promise<TestResult> {
    const r = await httpJson(`${D360}/ProjectVersions`, { headers: this.hdrs(c) });
    if (r.status === 401 || r.status === 403) return { ok: false, error: 'auth_failed' };
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'Document360 API token verified' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const l = await this.articleList(c);
    if (!l.ok) return { ok: false, error: l.error };
    const ql = query.toLowerCase();
    const filtered = l.articles.filter((a) => !ql || String(a.title ?? '').toLowerCase().includes(ql));
    return { ok: true, items: filtered.slice(0, 10).map((a) => ({ ref: String(a.id), type: 'article', title: clip(a.title, 160), snippet: '', url: a.url ? String(a.url) : null, raw: { id: a.id } })) };
  },
  fetchRecord(_c: Ctx, _type: string, _ref: string): Promise<AdapterResult> {
    return Promise.resolve({ ok: false, error: 'fetch_by_id_unsupported', detail: 'Document360 articles are returned by search / ingested by sync.' });
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
  async syncDocs(c: Ctx): Promise<SyncResult> {
    const l = await this.articleList(c);
    if (!l.ok) return { ok: false, error: l.error };
    const docs: SyncDoc[] = [];
    for (const a of l.articles.slice(0, MAX_SYNC_FILES)) {
      const content = stripHtml(String(a.html_content ?? a.content ?? '')).slice(0, MAX_DOC_CHARS);
      if (content) docs.push({ external_ref: `d360:${a.id}`, title: clip(a.title, 200), content, url: a.url ? String(a.url) : null });
    }
    if (!docs.length) return { ok: false, error: 'no_article_content', detail: 'No inline article content found — this Document360 plan may require fetching each article separately.' };
    return { ok: true, docs };
  },
};

// ── asana ── secret: { token } (PAT) · fixed base. product_system (tasks) +
// comment write.
const ASANA = 'https://app.asana.com/api/1.0';
const asana = {
  hdrs: (c: Ctx) => ({ Authorization: `Bearer ${c.secret.token ?? ''}` }),
  async workspace(c: Ctx): Promise<string | null> {
    const r = await httpJson(`${ASANA}/workspaces?limit=1`, { headers: this.hdrs(c) });
    if (!r.ok) return null;
    const ws = ((r.body as { data?: Array<{ gid?: string }> })?.data) ?? [];
    return ws[0]?.gid ?? null;
  },
  async test(c: Ctx): Promise<TestResult> {
    const r = await httpJson(`${ASANA}/users/me`, { headers: this.hdrs(c) });
    if (r.status === 401) return { ok: false, error: 'auth_failed' };
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: `authenticated as ${((r.body as { data?: { name?: string } })?.data?.name) ?? 'token'}` };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const ws = await this.workspace(c);
    if (!ws) return { ok: false, error: 'no_workspace' };
    const r = await httpJson(`${ASANA}/workspaces/${ws}/typeahead?resource_type=task&query=${encodeURIComponent(query)}&count=10&opt_fields=name`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const tasks = ((r.body as { data?: Array<Record<string, unknown>> })?.data) ?? [];
    return { ok: true, items: tasks.map((t) => ({ ref: String(t.gid), type: 'record', title: clip(t.name, 160), snippet: '', url: `https://app.asana.com/0/0/${t.gid}`, raw: { gid: t.gid } })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const r = await httpJson(`${ASANA}/tasks/${encodeURIComponent(ref)}?opt_fields=name,notes,completed`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const t = ((r.body as { data?: Record<string, unknown> })?.data) ?? {};
    return { ok: true, items: [{ ref, type: 'record', title: clip(t.name, 160), snippet: clip(t.notes, 400), url: `https://app.asana.com/0/0/${ref}`, raw: t }] };
  },
  async listRecent(c: Ctx): Promise<AdapterResult> {
    const ws = await this.workspace(c);
    if (!ws) return { ok: false, error: 'no_workspace' };
    const r = await httpJson(`${ASANA}/tasks?workspace=${ws}&assignee=me&limit=10&opt_fields=name&completed_since=now`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: true, items: [] };
    const tasks = ((r.body as { data?: Array<Record<string, unknown>> })?.data) ?? [];
    return { ok: true, items: tasks.map((t) => ({ ref: String(t.gid), type: 'record', title: clip(t.name, 160), snippet: '', url: `https://app.asana.com/0/0/${t.gid}`, raw: { gid: t.gid } })) };
  },
};
const asanaActions: Record<string, NativeAction> = {
  asana_add_comment: {
    render(_c, p) {
      if (!p.external_ref) return { ok: false, error: 'param_required', detail: 'external_ref (task gid) is required.' };
      if (!p.text?.trim()) return { ok: false, error: 'param_required', detail: 'text is required.' };
      return { ok: true, method: 'POST', url: `${ASANA}/tasks/${encodeURIComponent(p.external_ref)}/stories`, body: { data: { text: p.text } } };
    },
    async run(c, p) {
      const r = this.render(c, p);
      if (!r.ok) return { ok: false, error: r.error, detail: r.detail };
      const res = await httpJson(r.url!, { method: 'POST', headers: { ...asana.hdrs(c), 'Content-Type': 'application/json' }, body: JSON.stringify(r.body) });
      if (!res.ok) return { ok: false, status: res.status, error: res.error, raw: res.body };
      return { ok: true, status: res.status, raw: res.body, receipt: `Commented on Asana task ${p.external_ref}.` };
    },
  },
};

// All native write-side executors, keyed by execution_key. Defined here —
// after every <provider>Actions object — so the spread is safe at module load.
// ════════════════════════════════════════════════════════════════
// DreamTeam self-management — "the product operating itself".
//
// A Digital Employee that has been trained on the DreamTeam knowledge
// base can, from a customer's stated requirement, DRAFT the setup to
// onboard them: a new Digital Employee, a draft playbook, a specialist
// desk, or a proposed connector. Every one of these action_definitions
// is registered destructive:true, so decide_action_execution ALWAYS
// routes it to human approval — the employee proposes, a human reviews
// and approves, and only THEN is anything created. This is the deliberate,
// gated opening of the door the `provider <> 'internal'` wall keeps shut:
// these use provider 'dreamteam' (a real executor), never 'internal'.
//
// Safety properties held here:
//  - No credentials are ever handled by the employee. propose_connector
//    creates a DISCONNECTED shell; a human authenticates it separately.
//  - New Digital Employees are created at lifecycle 'designed' / trust
//    'supervised' — they cannot themselves answer or act until a human
//    walks them through the lifecycle gates.
//  - Playbooks are created as 'draft'; a human refines and publishes.
//  - Writes go through the service-role admin client already on the Ctx,
//    scoped to c.tenantId (the connector's own tenant) — never cross-tenant.
const dtSlug = (s: string) =>
  (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'item';
const dtSuffix = () => crypto.randomUUID().slice(0, 6);

// Wave 5 safety ceiling: a generous per-tenant hard cap on what the
// Onboarding Architect can create — a belt-and-suspenders backstop against
// a runaway (every build is already human-approved, and a single agentic
// run is capped at max_iterations). Returns an error message if over cap.
async function dtQuota(c: Ctx, table: string, cap: number, noun: string): Promise<string | null> {
  if (!c.admin || !c.tenantId) return 'no_admin_context';
  const { count } = await c.admin.from(table).select('id', { count: 'exact', head: true }).eq('tenant_id', c.tenantId);
  if ((count ?? 0) >= cap) return `This workspace has reached its limit of ${cap} ${noun}. Remove some before adding more.`;
  return null;
}

const dreamteamActions: Record<string, NativeAction> = {
  // Hire a DE from a pre-built role archetype (mig 162). Delegates to
  // instantiate_role_archetype, which applies persona/capabilities/model
  // and auto-attaches the archetype's mandatory compliance packs — all in
  // one gated step. Same safety envelope as dt_create_digital_employee
  // (designed/supervised, cert-gated before go-live).
  dt_hire_from_archetype: {
    render(_c, p) {
      if (!p.archetype_key?.trim()) return { ok: false, error: 'param_required', detail: 'archetype_key is required.' };
      if (!p.de_name?.trim()) return { ok: false, error: 'param_required', detail: 'de_name is required.' };
      return { ok: true, method: 'INTERNAL', url: 'dreamteam://hire_from_archetype', body: p };
    },
    async run(c, p) {
      if (!c.admin || !c.tenantId) return { ok: false, error: 'no_admin_context' };
      if (!p.archetype_key?.trim() || !p.de_name?.trim()) return { ok: false, error: 'param_required', detail: 'archetype_key and de_name are required.' };
      const deCap = await dtQuota(c, 'digital_employees', 50, 'Digital Employees');
      if (deCap) return { ok: false, error: 'quota_exceeded', detail: deCap };
      const { data, error } = await c.admin.rpc('instantiate_role_archetype', {
        p_tenant_id: c.tenantId,
        p_archetype_key: p.archetype_key.trim().slice(0, 60),
        p_de_name: p.de_name.trim().slice(0, 120),
        p_persona_name: p.persona_name?.trim()?.slice(0, 60) || null,
      });
      if (error) return { ok: false, error: 'hire_failed', detail: error.message };
      return { ok: true, raw: { de_id: data, archetype: p.archetype_key.trim() },
        receipt: `Hired "${p.de_name.trim()}" from the "${p.archetype_key.trim()}" archetype at lifecycle "designed", trust "supervised" — persona, capabilities, model and any compliance packs applied. It still needs knowledge and must pass certification before going live.` };
    },
  },
  dt_create_digital_employee: {
    render(_c, p) {
      if (!p.name?.trim()) return { ok: false, error: 'param_required', detail: 'name (the role/label) is required.' };
      return { ok: true, method: 'INTERNAL', url: 'dreamteam://create_digital_employee', body: p };
    },
    async run(c, p) {
      if (!c.admin || !c.tenantId) return { ok: false, error: 'no_admin_context' };
      if (!p.name?.trim()) return { ok: false, error: 'param_required', detail: 'name is required.' };
      const deCap = await dtQuota(c, 'digital_employees', 50, 'Digital Employees');
      if (deCap) return { ok: false, error: 'quota_exceeded', detail: deCap };
      const category = p.category === 'Internal' ? 'Internal' : 'Customer';
      const model = p.model_id && /^claude-/.test(p.model_id) ? p.model_id : 'claude-sonnet-5';
      const { data, error } = await c.admin.from('digital_employees').insert({
        tenant_id: c.tenantId, name: p.name.trim().slice(0, 120),
        persona_name: p.persona_name?.trim()?.slice(0, 60) || null,
        category, department: p.department?.trim()?.slice(0, 80) || null,
        description: p.description?.slice(0, 1000) || null,
        model_id: model, lifecycle_status: 'designed', status: 'idle', trust_level: 'supervised',
      }).select('id').single();
      if (error) return { ok: false, error: 'create_failed', detail: error.message };
      // Back-attach any playbooks that were drafted for this employee before
      // it existed (approval order no longer matters — migration 146).
      let attached = 0;
      if (data?.id) {
        const { data: linked } = await c.admin.from('playbook_definitions')
          .update({ de_id: data.id })
          .eq('tenant_id', c.tenantId).is('de_id', null)
          .ilike('intended_de_name', p.name.trim()).select('id');
        attached = linked?.length ?? 0;
      }
      return { ok: true, raw: { de_id: data?.id, attached_playbooks: attached },
        receipt: `Created Digital Employee "${p.name.trim()}" (${category}, model ${model}) at lifecycle stage "designed", trust "supervised"${attached ? `, and linked ${attached} playbook(s) already drafted for it` : ''}. It still needs knowledge, guardrails and certification before it can go live.` };
    },
  },
  dt_draft_playbook: {
    render(_c, p) {
      if (!p.name?.trim()) return { ok: false, error: 'param_required', detail: 'name is required.' };
      return { ok: true, method: 'INTERNAL', url: 'dreamteam://draft_playbook', body: p };
    },
    async run(c, p) {
      if (!c.admin || !c.tenantId) return { ok: false, error: 'no_admin_context' };
      if (!p.name?.trim()) return { ok: false, error: 'param_required', detail: 'name is required.' };
      const pbCap = await dtQuota(c, 'playbook_definitions', 100, 'playbooks');
      if (pbCap) return { ok: false, error: 'quota_exceeded', detail: pbCap };
      const outline = (p.outline ?? p.description ?? '').slice(0, 4000).trim();
      // Build a REAL, runnable step sequence (not an empty draft):
      //  load the record → run the procedure as a SMART step (the agentic
      //  loop reads the instructions and routes to knowledge / connectors /
      //  rules on its own) → optional specialist accuracy check → human
      //  approval → complete. Every step is a genuine playbook primitive.
      const wantsSpecialist = String(p.needs_specialist ?? '').toLowerCase() === 'true' || !!p.specialist_key;
      const steps: Array<Record<string, unknown>> = [
        { key: 'check_account', label: 'Load the record', params: {} },
        { key: 'agentic_step', label: p.name.trim().slice(0, 60),
          params: { goal_template: outline || `Carry out: ${p.name.trim()}. Use your knowledge, connected systems and your employer's rules as needed.` } },
      ];
      if (wantsSpecialist) {
        steps.push({ key: 'consult_specialist', label: 'Accuracy check',
          params: { profile_key: String(p.specialist_key ?? 'technical').slice(0, 60),
            question_template: `Review this "${p.name.trim()}" for {{account.name}} — is it correct and complete?`,
            min_confidence: 60, on_low: 'escalate' } });
      }
      steps.push({ key: 'human_approval', label: 'Human review',
        params: { title_template: `Review — ${p.name.trim()} for {{account.name}}`, task_type: 'approval_gate' } });
      steps.push({ key: 'complete', label: 'Done', params: {} });

      // Best-effort: attach to the employee this was built for (by role name).
      let deId: string | null = null;
      if (p.for_de?.trim()) {
        const { data: de } = await c.admin.from('digital_employees')
          .select('id').eq('tenant_id', c.tenantId).ilike('name', p.for_de.trim()).limit(1).maybeSingle();
        deId = (de as { id?: string } | null)?.id ?? null;
      }

      const { data, error } = await c.admin.from('playbook_definitions').insert({
        tenant_id: c.tenantId, key: `${dtSlug(p.name)}_${dtSuffix()}`,
        name: p.name.trim().slice(0, 120),
        description: (p.description ?? outline ?? '').slice(0, 2000) || 'Proposed by the Onboarding Architect.',
        status: 'draft', steps, de_id: deId,
        // Record the intended employee even if it doesn't exist yet, so
        // dt_create_digital_employee can back-attach (order-independent).
        intended_de_name: p.for_de?.trim()?.slice(0, 120) || null,
      }).select('id').single();
      if (error) return { ok: false, error: 'create_failed', detail: error.message };
      const attach = deId ? ` and attached it to ${p.for_de!.trim()}` : '';
      return { ok: true, raw: { playbook_id: data?.id },
        receipt: `Drafted a runnable playbook "${p.name.trim()}" — ${steps.length} real steps (load the record → run the procedure as a smart step${wantsSpecialist ? ' → specialist accuracy check' : ''} → human approval → complete)${attach}. A human can refine and publish it in the Playbook Builder.` };
    },
  },
  dt_create_specialist: {
    render(_c, p) {
      if (!p.name?.trim()) return { ok: false, error: 'param_required', detail: 'name is required.' };
      return { ok: true, method: 'INTERNAL', url: 'dreamteam://create_specialist', body: p };
    },
    async run(c, p) {
      if (!c.admin || !c.tenantId) return { ok: false, error: 'no_admin_context' };
      if (!p.name?.trim()) return { ok: false, error: 'param_required', detail: 'name is required.' };
      // Specialists are Digital Employees now (migrations 208/211).
      const spCap = await dtQuota(c, 'digital_employees', 60, 'digital employees');
      if (spCap) return { ok: false, error: 'quota_exceeded', detail: spCap };
      const { data, error } = await c.admin.from('digital_employees').insert({
        tenant_id: c.tenantId, catalog_id: 'support_agent',
        name: p.name.trim().slice(0, 120), persona_name: p.name.trim().slice(0, 60),
        category: 'Internal', is_specialist: true, specialist_key: `${dtSlug(p.name)}_${dtSuffix()}`,
        description: (p.charter ?? p.description ?? '').slice(0, 300) || null,
        charter: { mission: (p.charter ?? p.description ?? '').slice(0, 2000) },
        lifecycle_status: 'designed', status: 'active', trust_level: 'supervised',
      }).select('id').single();
      if (error) return { ok: false, error: 'create_failed', detail: error.message };
      return { ok: true, raw: { specialist_id: data?.id },
        receipt: `Created specialist "${p.name.trim()}" (a Digital Employee). Assign it to the Digital Employees that need this expertise.` };
    },
  },
  dt_propose_connector: {
    render(_c, p) {
      if (!p.provider?.trim()) return { ok: false, error: 'param_required', detail: 'provider is required.' };
      return { ok: true, method: 'INTERNAL', url: 'dreamteam://propose_connector', body: p };
    },
    async run(c, p) {
      if (!c.admin || !c.tenantId) return { ok: false, error: 'no_admin_context' };
      const connCap = await dtQuota(c, 'connectors', 40, 'connectors');
      if (connCap) return { ok: false, error: 'quota_exceeded', detail: connCap };
      const provider = (p.provider ?? '').trim().toLowerCase();
      const builtIn = ['zendesk', 'salesforce', 'confluence', 'jira', 'intercom', 'generic_rest', 'sharepoint'];
      const useProvider = builtIn.includes(provider) ? provider : 'generic_rest';
      const { data, error } = await c.admin.from('connectors').insert({
        tenant_id: c.tenantId, provider: useProvider,
        base_url: (p.base_url ?? 'https://example.com').slice(0, 300),
        category: (p.category ?? 'product_system').trim().slice(0, 40),
        status: 'disconnected',
        display_name: (p.display_name ?? `${provider || useProvider} (proposed)`).slice(0, 120),
      }).select('id').single();
      if (error) return { ok: false, error: 'create_failed', detail: error.message };
      const note = builtIn.includes(provider) ? '' : ` (mapped to a generic REST connector — "${provider}" isn't a built-in yet)`;
      return { ok: true, raw: { connector_id: data?.id },
        receipt: `Proposed a "${provider || useProvider}" connector${note}, created DISCONNECTED. A human must add credentials and connect it — the employee handled no credentials.` };
    },
  },
};

// ── freshdesk write-side (EXEC-1) — the SAME 4 canonical helpdesk ops the
// Zendesk executor exposes (reply / internal note / status / tags), so the DE
// works a Freshdesk ticket exactly as it works a Zendesk one; the category
// layer already routes by connector.provider. Basic auth (api_key:X). Status
// is numeric in Freshdesk — mapped from the canonical names here. ──
const FRESH_STATUS: Record<string, number> = { open: 2, pending: 3, resolved: 4, closed: 5 };
const freshdeskActions: Record<string, NativeAction> = {
  freshdesk_add_internal_note: {
    render(c, p) {
      if (!p.external_ref) return { ok: false, error: 'param_required', detail: 'external_ref (ticket id) is required.' };
      if (!p.note?.trim()) return { ok: false, error: 'param_required', detail: 'note text is required.' };
      return { ok: true, method: 'POST', url: `${c.baseUrl}/api/v2/tickets/${encodeURIComponent(p.external_ref)}/notes`, body: { body: p.note, private: true } };
    },
    async run(c, p) {
      const r = this.render(c, p);
      if (!r.ok) return { ok: false, error: r.error, detail: r.detail };
      const res = await httpJson(r.url!, { method: 'POST', headers: { Authorization: freshAuth(c), 'Content-Type': 'application/json' }, body: JSON.stringify(r.body) });
      if (!res.ok) return { ok: false, status: res.status, error: res.error, raw: res.body };
      return { ok: true, status: res.status, raw: res.body, receipt: `Added a private note to Freshdesk ticket #${p.external_ref} (not visible to the customer).` };
    },
  },
  freshdesk_reply_to_ticket: {
    render(c, p) {
      if (!p.external_ref) return { ok: false, error: 'param_required', detail: 'external_ref (ticket id) is required.' };
      if (!p.body?.trim()) return { ok: false, error: 'param_required', detail: 'reply body text is required.' };
      return { ok: true, method: 'POST', url: `${c.baseUrl}/api/v2/tickets/${encodeURIComponent(p.external_ref)}/reply`, body: { body: p.body } };
    },
    async run(c, p) {
      const r = this.render(c, p);
      if (!r.ok) return { ok: false, error: r.error, detail: r.detail };
      const res = await httpJson(r.url!, { method: 'POST', headers: { Authorization: freshAuth(c), 'Content-Type': 'application/json' }, body: JSON.stringify(r.body) });
      if (!res.ok) return { ok: false, status: res.status, error: res.error, raw: res.body };
      return { ok: true, status: res.status, raw: res.body, receipt: `Posted a public reply on Freshdesk ticket #${p.external_ref} — the customer will see it.` };
    },
  },
  freshdesk_update_status: {
    render(c, p) {
      if (!p.external_ref) return { ok: false, error: 'param_required', detail: 'external_ref (ticket id) is required.' };
      if (!(p.status in FRESH_STATUS)) return { ok: false, error: 'param_invalid', detail: `status must be one of: ${Object.keys(FRESH_STATUS).join(', ')}.` };
      return { ok: true, method: 'PUT', url: `${c.baseUrl}/api/v2/tickets/${encodeURIComponent(p.external_ref)}`, body: { status: FRESH_STATUS[p.status] } };
    },
    async run(c, p) {
      const r = this.render(c, p);
      if (!r.ok) return { ok: false, error: r.error, detail: r.detail };
      const res = await httpJson(r.url!, { method: 'PUT', headers: { Authorization: freshAuth(c), 'Content-Type': 'application/json' }, body: JSON.stringify(r.body) });
      if (!res.ok) return { ok: false, status: res.status, error: res.error, raw: res.body };
      return { ok: true, status: res.status, raw: res.body, receipt: `Set Freshdesk ticket #${p.external_ref} status to "${p.status}".` };
    },
  },
  freshdesk_add_tags: {
    render(c, p) {
      if (!p.external_ref) return { ok: false, error: 'param_required', detail: 'external_ref (ticket id) is required.' };
      if (!p.tags?.trim()) return { ok: false, error: 'param_required', detail: 'tags (comma-separated) is required.' };
      // Freshdesk PUT replaces the whole tag array; run() fetches current tags
      // first and merges so this is ADD, not replace.
      return { ok: true, method: 'PUT', url: `${c.baseUrl}/api/v2/tickets/${encodeURIComponent(p.external_ref)}`, body: {} };
    },
    async run(c, p) {
      const r = this.render(c, p);
      if (!r.ok) return { ok: false, error: r.error, detail: r.detail };
      const add = (p.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean);
      const cur = await httpJson(`${c.baseUrl}/api/v2/tickets/${encodeURIComponent(p.external_ref)}`, { headers: { Authorization: freshAuth(c) } });
      const existing = Array.isArray((cur.body as { tags?: string[] } | null)?.tags) ? (cur.body as { tags: string[] }).tags : [];
      const merged = [...new Set([...existing, ...add])];
      const res = await httpJson(r.url!, { method: 'PUT', headers: { Authorization: freshAuth(c), 'Content-Type': 'application/json' }, body: JSON.stringify({ tags: merged }) });
      if (!res.ok) return { ok: false, status: res.status, error: res.error, raw: res.body };
      return { ok: true, status: res.status, raw: res.body, receipt: `Tagged Freshdesk ticket #${p.external_ref} with: ${add.join(', ')}.` };
    },
  },
};

const NATIVE_ACTIONS: Record<string, NativeAction> = { ...zendeskActions, ...freshdeskActions, ...slackActions, ...servicenowActions, ...githubActions, ...gitlabActions, ...asanaActions, ...dreamteamActions };

// ── clickup ── secret: { token } (personal token, raw — not Bearer) · fixed
// base. product_system (tasks).
const CLICKUP = 'https://api.clickup.com/api/v2';
const clickup = {
  hdrs: (c: Ctx) => ({ Authorization: c.secret.token ?? '' }),
  async team(c: Ctx): Promise<string | null> {
    const r = await httpJson(`${CLICKUP}/team`, { headers: this.hdrs(c) });
    if (!r.ok) return null;
    const teams = ((r.body as { teams?: Array<{ id?: string }> })?.teams) ?? [];
    return teams[0]?.id ?? null;
  },
  async test(c: Ctx): Promise<TestResult> {
    const r = await httpJson(`${CLICKUP}/user`, { headers: this.hdrs(c) });
    if (r.status === 401) return { ok: false, error: 'auth_failed' };
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'ClickUp token verified' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const team = await this.team(c);
    if (!team) return { ok: false, error: 'no_team' };
    const r = await httpJson(`${CLICKUP}/team/${team}/task?order_by=updated&reverse=true&page=0`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const tasks = ((r.body as { tasks?: Array<Record<string, unknown>> })?.tasks) ?? [];
    const ql = query.toLowerCase();
    const filtered = ql ? tasks.filter((t) => String(t.name ?? '').toLowerCase().includes(ql)) : tasks;
    return { ok: true, items: filtered.slice(0, 10).map((t) => ({ ref: String(t.id), type: 'record', title: clip(t.name, 160), snippet: clip(t.text_content ?? t.description ?? '', 400), url: t.url ? String(t.url) : null, raw: { id: t.id } })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const r = await httpJson(`${CLICKUP}/task/${encodeURIComponent(ref)}`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const t = r.body as Record<string, unknown>;
    return { ok: true, items: [{ ref, type: 'record', title: clip(t.name, 160), snippet: clip(t.text_content ?? t.description ?? '', 400), url: t.url ? String(t.url) : null, raw: t }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
};

// ── monday ── secret: { token } · fixed base. GraphQL. product_system.
const MONDAY = 'https://api.monday.com/v2';
const monday = {
  async gql(c: Ctx, query: string): Promise<{ ok: boolean; error?: string; data: Record<string, unknown> | null }> {
    const r = await httpJson(MONDAY, { method: 'POST', headers: { Authorization: c.secret.token ?? '', 'Content-Type': 'application/json', 'API-Version': '2024-01' }, body: JSON.stringify({ query }) });
    const b = r.body as { data?: Record<string, unknown>; errors?: Array<{ message?: string }> } | null;
    if (!r.ok) return { ok: false, error: r.error, data: null };
    if (b?.errors?.length) return { ok: false, error: String(b.errors[0]?.message ?? 'monday_error'), data: null };
    return { ok: true, data: b?.data ?? null };
  },
  async test(c: Ctx): Promise<TestResult> {
    const r = await this.gql(c, '{ me { id name } }');
    if (!r.ok) return { ok: false, error: (r.error ?? '').toLowerCase().includes('auth') ? 'auth_failed' : r.error };
    return { ok: true, detail: `authenticated as ${((r.data?.me as { name?: string })?.name) ?? 'token'}` };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const r = await this.gql(c, '{ boards(limit:10){ id name items_page(limit:25){ items { id name url } } } }');
    if (!r.ok) return { ok: false, error: r.error };
    const ql = query.toLowerCase();
    const items: HubItem[] = [];
    for (const b of ((r.data?.boards as Array<{ name?: string; items_page?: { items?: Array<Record<string, unknown>> } }>) ?? [])) {
      for (const it of (b.items_page?.items ?? [])) {
        if (items.length >= 10) break;
        if (!ql || String(it.name ?? '').toLowerCase().includes(ql)) items.push({ ref: String(it.id), type: 'record', title: clip(it.name, 160), snippet: clip(b.name, 400), url: it.url ? String(it.url) : null, raw: { id: it.id } });
      }
    }
    return { ok: true, items: items.slice(0, 10) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const r = await this.gql(c, `{ items(ids:[${JSON.stringify(ref)}]){ id name url column_values{ text } } }`);
    if (!r.ok) return { ok: false, error: r.error };
    const it = (((r.data?.items as Array<Record<string, unknown>>) ?? [])[0]) ?? {};
    const cols = ((it.column_values as Array<{ text?: string }>) ?? []).map((cv) => cv.text).filter(Boolean).join(' · ');
    return { ok: true, items: [{ ref, type: 'record', title: clip(it.name, 160), snippet: clip(cols, 400), url: it.url ? String(it.url) : null, raw: it }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
};

// ── linear ── secret: { api_key } · fixed base. GraphQL. product_system.
const LINEAR = 'https://api.linear.app/graphql';
const linear = {
  async gql(c: Ctx, query: string, variables?: Record<string, unknown>): Promise<{ ok: boolean; error?: string; data: Record<string, unknown> | null }> {
    const r = await httpJson(LINEAR, { method: 'POST', headers: { Authorization: c.secret.api_key ?? '', 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
    const b = r.body as { data?: Record<string, unknown>; errors?: Array<{ message?: string }> } | null;
    if (!r.ok) return { ok: false, error: r.error, data: null };
    if (b?.errors?.length) return { ok: false, error: String(b.errors[0]?.message ?? 'linear_error'), data: null };
    return { ok: true, data: b?.data ?? null };
  },
  async test(c: Ctx): Promise<TestResult> {
    const r = await this.gql(c, '{ viewer { id name } }');
    if (!r.ok) return { ok: false, error: (r.error ?? '').toLowerCase().includes('auth') ? 'auth_failed' : r.error };
    return { ok: true, detail: `authenticated as ${((r.data?.viewer as { name?: string })?.name) ?? 'token'}` };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const r = await this.gql(c, 'query($q:String!){ issues(filter:{ or:[{title:{containsIgnoreCase:$q}},{description:{containsIgnoreCase:$q}}] }, first:10){ nodes { id identifier title description url } } }', { q: query });
    if (!r.ok) return { ok: false, error: r.error };
    const nodes = ((r.data?.issues as { nodes?: Array<Record<string, unknown>> })?.nodes) ?? [];
    return { ok: true, items: nodes.map((n) => ({ ref: String(n.id), type: 'record', title: clip(`${n.identifier ?? ''} ${n.title ?? ''}`, 160), snippet: clip(n.description, 400), url: n.url ? String(n.url) : null, raw: { id: n.id } })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const r = await this.gql(c, 'query($id:String!){ issue(id:$id){ id identifier title description url } }', { id: ref });
    if (!r.ok) return { ok: false, error: r.error };
    const n = (r.data?.issue as Record<string, unknown>) ?? {};
    return { ok: true, items: [{ ref, type: 'record', title: clip(`${n.identifier ?? ''} ${n.title ?? ''}`, 160), snippet: clip(n.description, 400), url: n.url ? String(n.url) : null, raw: n }] };
  },
  async listRecent(c: Ctx): Promise<AdapterResult> {
    const r = await this.gql(c, '{ issues(first:10){ nodes { id identifier title url } } }');
    if (!r.ok) return { ok: false, error: r.error };
    const nodes = ((r.data?.issues as { nodes?: Array<Record<string, unknown>> })?.nodes) ?? [];
    return { ok: true, items: nodes.map((n) => ({ ref: String(n.id), type: 'record', title: clip(`${n.identifier ?? ''} ${n.title ?? ''}`, 160), snippet: '', url: n.url ? String(n.url) : null, raw: { id: n.id } })) };
  },
};

// ── stripe ── secret: { api_key } · fixed base. billing (invoices/subs).
const STRIPE = 'https://api.stripe.com/v1';
const stripe = {
  hdrs: (c: Ctx) => ({ Authorization: `Bearer ${c.secret.api_key ?? ''}` }),
  async test(c: Ctx): Promise<TestResult> {
    const r = await httpJson(`${STRIPE}/customers?limit=1`, { headers: this.hdrs(c) });
    if (r.status === 401) return { ok: false, error: 'auth_failed' };
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'Stripe secret key verified' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const r = await httpJson(`${STRIPE}/invoices?limit=25`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const data = ((r.body as { data?: Array<Record<string, unknown>> })?.data) ?? [];
    const ql = query.toLowerCase();
    const f = ql ? data.filter((i) => String(i.number ?? '').toLowerCase().includes(ql) || String(i.customer_email ?? '').toLowerCase().includes(ql)) : data;
    return { ok: true, items: f.slice(0, 10).map((i) => ({ ref: String(i.id), type: 'invoice', title: clip(`${i.number ?? i.id} — ${i.customer_email ?? ''}`, 160), snippet: clip(`${(Number(i.total) || 0) / 100} ${String(i.currency ?? '').toUpperCase()} · ${i.status ?? ''}`, 400), url: i.hosted_invoice_url ? String(i.hosted_invoice_url) : null, raw: { id: i.id, status: i.status } })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const r = await httpJson(`${STRIPE}/invoices/${encodeURIComponent(ref)}`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const i = r.body as Record<string, unknown>;
    return { ok: true, items: [{ ref, type: 'invoice', title: clip(`${i.number ?? ref}`, 160), snippet: clip(`${(Number(i.total) || 0) / 100} ${String(i.currency ?? '').toUpperCase()} · ${i.status ?? ''}`, 400), url: i.hosted_invoice_url ? String(i.hosted_invoice_url) : null, raw: i }] };
  },
  async subscription(c: Ctx, ref: string): Promise<AdapterResult> {
    const r = await httpJson(`${STRIPE}/subscriptions/${encodeURIComponent(ref)}`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const s = r.body as Record<string, unknown>;
    return { ok: true, items: [{ ref, type: 'subscription', title: clip(`Subscription ${ref} · ${s.status ?? ''}`, 160), snippet: clip(`customer ${s.customer ?? ''}`, 400), url: null, raw: s }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
};

// ── shopify ── secret: { access_token } · base = store.myshopify.com. pos.
const shopify = {
  hdrs: (c: Ctx) => ({ 'X-Shopify-Access-Token': c.secret.access_token ?? '', Accept: 'application/json' }),
  async test(c: Ctx): Promise<TestResult> {
    const r = await httpJson(`${c.baseUrl}/admin/api/2024-01/shop.json`, { headers: this.hdrs(c) });
    if (r.status === 401 || r.status === 403) return { ok: false, error: 'auth_failed' };
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'Shopify Admin API token verified' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const r = await httpJson(`${c.baseUrl}/admin/api/2024-01/orders.json?status=any&limit=25`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const orders = ((r.body as { orders?: Array<Record<string, unknown>> })?.orders) ?? [];
    const ql = query.toLowerCase();
    const f = ql ? orders.filter((o) => String(o.name ?? '').toLowerCase().includes(ql) || String(o.email ?? '').toLowerCase().includes(ql)) : orders;
    return { ok: true, items: f.slice(0, 10).map((o) => ({ ref: String(o.id), type: 'order', title: clip(`${o.name} — ${o.email ?? ''}`, 160), snippet: clip(`${o.total_price ?? ''} ${o.currency ?? ''} · ${o.financial_status ?? ''} · ${o.fulfillment_status ?? 'unfulfilled'}`, 400), url: null, raw: { id: o.id } })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const r = await httpJson(`${c.baseUrl}/admin/api/2024-01/orders/${encodeURIComponent(ref)}.json`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const o = ((r.body as { order?: Record<string, unknown> })?.order) ?? {};
    return { ok: true, items: [{ ref, type: 'order', title: clip(`${o.name} — ${o.email ?? ''}`, 160), snippet: clip(`${o.total_price ?? ''} ${o.currency ?? ''} · ${o.financial_status ?? ''}`, 400), url: null, raw: o }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
};

// ── woocommerce ── secret: { consumer_key, consumer_secret } · base = store URL. pos.
const woocommerce = {
  auth: (c: Ctx) => 'Basic ' + btoa(`${c.secret.consumer_key ?? ''}:${c.secret.consumer_secret ?? ''}`),
  async test(c: Ctx): Promise<TestResult> {
    const r = await httpJson(`${c.baseUrl}/wp-json/wc/v3/orders?per_page=1`, { headers: { Authorization: this.auth(c) } });
    if (r.status === 401) return { ok: false, error: 'auth_failed' };
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'WooCommerce keys verified' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const r = await httpJson(`${c.baseUrl}/wp-json/wc/v3/orders?per_page=10&search=${encodeURIComponent(query)}`, { headers: { Authorization: this.auth(c) } });
    if (!r.ok) return { ok: false, error: r.error };
    const orders = Array.isArray(r.body) ? (r.body as Array<Record<string, unknown>>) : [];
    return { ok: true, items: orders.slice(0, 10).map((o) => ({ ref: String(o.id), type: 'order', title: clip(`#${o.number ?? o.id} — ${(o.billing as { email?: string })?.email ?? ''}`, 160), snippet: clip(`${o.total ?? ''} ${o.currency ?? ''} · ${o.status ?? ''}`, 400), url: null, raw: { id: o.id } })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const r = await httpJson(`${c.baseUrl}/wp-json/wc/v3/orders/${encodeURIComponent(ref)}`, { headers: { Authorization: this.auth(c) } });
    if (!r.ok) return { ok: false, error: r.error };
    const o = r.body as Record<string, unknown>;
    return { ok: true, items: [{ ref, type: 'order', title: clip(`#${o.number ?? ref}`, 160), snippet: clip(`${o.total ?? ''} ${o.currency ?? ''} · ${o.status ?? ''}`, 400), url: null, raw: o }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
};

// ── bigcommerce ── secret: { store_hash, access_token } · fixed base. pos.
const bigcommerce = {
  base: (c: Ctx) => `https://api.bigcommerce.com/stores/${c.secret.store_hash ?? ''}`,
  hdrs: (c: Ctx) => ({ 'X-Auth-Token': c.secret.access_token ?? '', Accept: 'application/json' }),
  async test(c: Ctx): Promise<TestResult> {
    const r = await httpJson(`${this.base(c)}/v2/store`, { headers: this.hdrs(c) });
    if (r.status === 401) return { ok: false, error: 'auth_failed' };
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'BigCommerce token verified' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const r = await httpJson(`${this.base(c)}/v2/orders?limit=25&sort=date_created:desc`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const orders = Array.isArray(r.body) ? (r.body as Array<Record<string, unknown>>) : [];
    const ql = query.toLowerCase();
    const f = ql ? orders.filter((o) => String(o.id).includes(query) || String((o.billing_address as { email?: string })?.email ?? '').toLowerCase().includes(ql)) : orders;
    return { ok: true, items: f.slice(0, 10).map((o) => ({ ref: String(o.id), type: 'order', title: clip(`Order #${o.id} — ${(o.billing_address as { email?: string })?.email ?? ''}`, 160), snippet: clip(`${o.total_inc_tax ?? ''} ${o.currency_code ?? ''} · ${o.status ?? ''}`, 400), url: null, raw: { id: o.id } })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const r = await httpJson(`${this.base(c)}/v2/orders/${encodeURIComponent(ref)}`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const o = r.body as Record<string, unknown>;
    return { ok: true, items: [{ ref, type: 'order', title: clip(`Order #${ref}`, 160), snippet: clip(`${o.total_inc_tax ?? ''} ${o.currency_code ?? ''} · ${o.status ?? ''}`, 400), url: null, raw: o }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
};

// ── square ── secret: { access_token } · fixed base. pos.
const SQUARE = 'https://connect.squareup.com/v2';
const square = {
  hdrs: (c: Ctx) => ({ Authorization: `Bearer ${c.secret.access_token ?? ''}`, 'Square-Version': '2024-01-18', 'Content-Type': 'application/json' }),
  async location(c: Ctx): Promise<string | null> {
    const r = await httpJson(`${SQUARE}/locations`, { headers: this.hdrs(c) });
    if (!r.ok) return null;
    const locs = ((r.body as { locations?: Array<{ id?: string }> })?.locations) ?? [];
    return locs[0]?.id ?? null;
  },
  async test(c: Ctx): Promise<TestResult> {
    const r = await httpJson(`${SQUARE}/locations`, { headers: this.hdrs(c) });
    if (r.status === 401) return { ok: false, error: 'auth_failed' };
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'Square access token verified' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const loc = await this.location(c);
    if (!loc) return { ok: false, error: 'no_location' };
    const r = await httpJson(`${SQUARE}/orders/search`, { method: 'POST', headers: this.hdrs(c), body: JSON.stringify({ location_ids: [loc], limit: 20, sort: { sort_field: 'CREATED_AT', sort_order: 'DESC' } }) });
    if (!r.ok) return { ok: false, error: r.error };
    const orders = ((r.body as { orders?: Array<Record<string, unknown>> })?.orders) ?? [];
    const ql = query.toLowerCase();
    const f = ql ? orders.filter((o) => String(o.id).toLowerCase().includes(ql)) : orders;
    return { ok: true, items: f.slice(0, 10).map((o) => ({ ref: String(o.id), type: 'order', title: clip(`Order ${String(o.id).slice(0, 8)} · ${o.state ?? ''}`, 160), snippet: clip(`${(Number((o.total_money as { amount?: number })?.amount) || 0) / 100} ${(o.total_money as { currency?: string })?.currency ?? ''}`, 400), url: null, raw: { id: o.id } })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const r = await httpJson(`${SQUARE}/orders/${encodeURIComponent(ref)}`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const o = ((r.body as { order?: Record<string, unknown> })?.order) ?? {};
    return { ok: true, items: [{ ref, type: 'order', title: clip(`Order ${String(ref).slice(0, 8)}`, 160), snippet: clip(`${(Number((o.total_money as { amount?: number })?.amount) || 0) / 100}`, 400), url: null, raw: o }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
};

// ── bamboohr ── secret: { subdomain, api_key } · fixed base. payroll_hcm.
const bamboohr = {
  base: (c: Ctx) => `https://api.bamboohr.com/api/gateway.php/${c.secret.subdomain ?? ''}`,
  auth: (c: Ctx) => 'Basic ' + btoa(`${c.secret.api_key ?? ''}:x`),
  async test(c: Ctx): Promise<TestResult> {
    const r = await httpJson(`${this.base(c)}/v1/employees/directory`, { headers: { Authorization: this.auth(c), Accept: 'application/json' } });
    if (r.status === 401) return { ok: false, error: 'auth_failed' };
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'BambooHR API key verified' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const r = await httpJson(`${this.base(c)}/v1/employees/directory`, { headers: { Authorization: this.auth(c), Accept: 'application/json' } });
    if (!r.ok) return { ok: false, error: r.error };
    const emps = ((r.body as { employees?: Array<Record<string, unknown>> })?.employees) ?? [];
    const ql = query.toLowerCase();
    const f = ql ? emps.filter((e) => `${e.firstName} ${e.lastName} ${e.workEmail}`.toLowerCase().includes(ql)) : emps;
    return { ok: true, items: f.slice(0, 10).map((e) => ({ ref: String(e.id), type: 'employee', title: clip(`${e.firstName ?? ''} ${e.lastName ?? ''}`, 160), snippet: clip(`${e.jobTitle ?? ''} · ${e.department ?? ''}`, 400), url: null, raw: { id: e.id } })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const r = await httpJson(`${this.base(c)}/v1/employees/${encodeURIComponent(ref)}?fields=firstName,lastName,jobTitle,department,workEmail,hireDate,supervisor`, { headers: { Authorization: this.auth(c), Accept: 'application/json' } });
    if (!r.ok) return { ok: false, error: r.error };
    const e = r.body as Record<string, unknown>;
    return { ok: true, items: [{ ref, type: 'employee', title: clip(`${e.firstName ?? ''} ${e.lastName ?? ''}`, 160), snippet: clip(`${e.jobTitle ?? ''} · ${e.department ?? ''} · ${e.workEmail ?? ''}`, 400), url: null, raw: e }] };
  },
  async timeOff(c: Ctx, query: string): Promise<AdapterResult> {
    const now = new Date();
    const start = new Date(now.getTime() - 30 * 864e5).toISOString().slice(0, 10);
    const end = new Date(now.getTime() + 90 * 864e5).toISOString().slice(0, 10);
    const r = await httpJson(`${this.base(c)}/v1/time_off/requests?start=${start}&end=${end}`, { headers: { Authorization: this.auth(c), Accept: 'application/json' } });
    if (!r.ok) return { ok: false, error: r.error };
    const reqs = Array.isArray(r.body) ? (r.body as Array<Record<string, unknown>>) : [];
    const ql = query.toLowerCase();
    const f = ql ? reqs.filter((t) => String((t.employee as { displayName?: string })?.displayName ?? t.name ?? '').toLowerCase().includes(ql)) : reqs;
    return { ok: true, items: f.slice(0, 10).map((t) => ({ ref: String(t.id), type: 'time_off', title: clip(`${(t.employee as { displayName?: string })?.displayName ?? t.name ?? 'Time off'} · ${(t.type as { name?: string })?.name ?? ''}`, 160), snippet: clip(`${t.start ?? ''} → ${t.end ?? ''} · ${t.status ?? ''}`, 400), url: null, raw: { id: t.id } })) };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
};

// ── greenhouse ── secret: { api_key } · fixed base (Harvest). product_system.
const greenhouse = {
  auth: (c: Ctx) => 'Basic ' + btoa(`${c.secret.api_key ?? ''}:`),
  async test(c: Ctx): Promise<TestResult> {
    const r = await httpJson('https://harvest.greenhouse.io/v1/candidates?per_page=1', { headers: { Authorization: this.auth(c) } });
    if (r.status === 401) return { ok: false, error: 'auth_failed' };
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'Greenhouse Harvest key verified' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const r = await httpJson('https://harvest.greenhouse.io/v1/candidates?per_page=25', { headers: { Authorization: this.auth(c) } });
    if (!r.ok) return { ok: false, error: r.error };
    const cands = Array.isArray(r.body) ? (r.body as Array<Record<string, unknown>>) : [];
    const ql = query.toLowerCase();
    const f = ql ? cands.filter((cd) => `${cd.first_name} ${cd.last_name}`.toLowerCase().includes(ql)) : cands;
    return { ok: true, items: f.slice(0, 10).map((cd) => ({ ref: String(cd.id), type: 'record', title: clip(`${cd.first_name ?? ''} ${cd.last_name ?? ''}`, 160), snippet: clip(String(cd.company ?? (cd.applications as Array<{ jobs?: Array<{ name?: string }> }>)?.[0]?.jobs?.[0]?.name ?? ''), 400), url: cd.url ? String(cd.url) : null, raw: { id: cd.id } })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const r = await httpJson(`https://harvest.greenhouse.io/v1/candidates/${encodeURIComponent(ref)}`, { headers: { Authorization: this.auth(c) } });
    if (!r.ok) return { ok: false, error: r.error };
    const cd = r.body as Record<string, unknown>;
    return { ok: true, items: [{ ref, type: 'record', title: clip(`${cd.first_name ?? ''} ${cd.last_name ?? ''}`, 160), snippet: clip(String(cd.company ?? ''), 400), url: null, raw: cd }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
};

// ── lever ── secret: { api_key } · fixed base. product_system.
const lever = {
  auth: (c: Ctx) => 'Basic ' + btoa(`${c.secret.api_key ?? ''}:`),
  async test(c: Ctx): Promise<TestResult> {
    const r = await httpJson('https://api.lever.co/v1/opportunities?limit=1', { headers: { Authorization: this.auth(c) } });
    if (r.status === 401) return { ok: false, error: 'auth_failed' };
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'Lever API key verified' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const r = await httpJson('https://api.lever.co/v1/opportunities?limit=25', { headers: { Authorization: this.auth(c) } });
    if (!r.ok) return { ok: false, error: r.error };
    const data = ((r.body as { data?: Array<Record<string, unknown>> })?.data) ?? [];
    const ql = query.toLowerCase();
    const f = ql ? data.filter((o) => String(o.name ?? '').toLowerCase().includes(ql)) : data;
    return { ok: true, items: f.slice(0, 10).map((o) => ({ ref: String(o.id), type: 'record', title: clip(o.name, 160), snippet: clip(String(o.headline ?? (o.stage as { text?: string })?.text ?? ''), 400), url: (o.urls as { show?: string })?.show ? String((o.urls as { show?: string }).show) : null, raw: { id: o.id } })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const r = await httpJson(`https://api.lever.co/v1/opportunities/${encodeURIComponent(ref)}`, { headers: { Authorization: this.auth(c) } });
    if (!r.ok) return { ok: false, error: r.error };
    const o = ((r.body as { data?: Record<string, unknown> })?.data) ?? {};
    return { ok: true, items: [{ ref, type: 'record', title: clip(o.name, 160), snippet: clip(String(o.headline ?? ''), 400), url: null, raw: o }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
};

// ── buildium ── secret: { client_id, client_secret } · fixed base. product_system.
const buildium = {
  hdrs: (c: Ctx) => ({ 'x-buildium-client-id': c.secret.client_id ?? '', 'x-buildium-client-secret': c.secret.client_secret ?? '', Accept: 'application/json' }),
  async test(c: Ctx): Promise<TestResult> {
    const r = await httpJson('https://api.buildium.com/v1/leases?limit=1', { headers: this.hdrs(c) });
    if (r.status === 401 || r.status === 403) return { ok: false, error: 'auth_failed' };
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'Buildium credentials verified' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const r = await httpJson('https://api.buildium.com/v1/leases?limit=25&orderby=Id desc', { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const leases = Array.isArray(r.body) ? (r.body as Array<Record<string, unknown>>) : [];
    const ql = query.toLowerCase();
    const f = ql ? leases.filter((l) => JSON.stringify(l).toLowerCase().includes(ql)) : leases;
    return { ok: true, items: f.slice(0, 10).map((l) => ({ ref: String(l.Id), type: 'record', title: clip(`Lease ${l.Id} · ${l.LeaseStatus ?? ''}`, 160), snippet: clip(`Unit ${l.UnitId ?? ''} · ${l.LeaseFromDate ?? ''} → ${l.LeaseToDate ?? ''}`, 400), url: null, raw: { id: l.Id } })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const r = await httpJson(`https://api.buildium.com/v1/leases/${encodeURIComponent(ref)}`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const l = r.body as Record<string, unknown>;
    return { ok: true, items: [{ ref, type: 'record', title: clip(`Lease ${ref}`, 160), snippet: clip(String(l.LeaseStatus ?? ''), 400), url: null, raw: l }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
};

// ── canvas ── secret: { token } · base = institution URL. product_system.
const canvas = {
  hdrs: (c: Ctx) => ({ Authorization: `Bearer ${c.secret.token ?? ''}` }),
  async test(c: Ctx): Promise<TestResult> {
    const r = await httpJson(`${c.baseUrl}/api/v1/courses?per_page=1`, { headers: this.hdrs(c) });
    if (r.status === 401) return { ok: false, error: 'auth_failed' };
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'Canvas access token verified' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const r = await httpJson(`${c.baseUrl}/api/v1/courses?per_page=25`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const courses = Array.isArray(r.body) ? (r.body as Array<Record<string, unknown>>) : [];
    const ql = query.toLowerCase();
    const f = ql ? courses.filter((co) => String(co.name ?? '').toLowerCase().includes(ql)) : courses;
    return { ok: true, items: f.slice(0, 10).map((co) => ({ ref: String(co.id), type: 'record', title: clip(co.name, 160), snippet: clip(`${co.course_code ?? ''} · ${co.workflow_state ?? ''}`, 400), url: `${c.baseUrl}/courses/${co.id}`, raw: { id: co.id } })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const r = await httpJson(`${c.baseUrl}/api/v1/courses/${encodeURIComponent(ref)}`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const co = r.body as Record<string, unknown>;
    return { ok: true, items: [{ ref, type: 'record', title: clip(co.name, 160), snippet: clip(String(co.course_code ?? ''), 400), url: `${c.baseUrl}/courses/${ref}`, raw: co }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
};

// ── user-OAuth token refresh ── returns a valid access token for an
// OAuth connector, refreshing (and persisting) via the refresh token when
// the stored access token has expired. Client id/secret come from the
// Vault-encrypted platform_config OAuth app config.
async function oauthAccessToken(c: Ctx, provider: string): Promise<{ ok: boolean; token?: string; error?: string }> {
  const s = c.secret as Record<string, unknown>;
  const access = String(s.access_token ?? '');
  const expiresAt = Number(s.expires_at ?? 0);
  if (access && Date.now() < expiresAt) return { ok: true, token: access };
  const refresh = String(s.refresh_token ?? '');
  const meta = OAUTH_PROVIDERS[provider];
  if (!refresh || !meta || !c.admin || !c.connectorId) return access ? { ok: true, token: access } : { ok: false, error: 'token_expired_no_refresh' };
  const { data: clientId } = await c.admin.rpc('platform_config_get', { p_key: `oauth:${provider}:client_id` });
  const { data: clientSecret } = await c.admin.rpc('platform_config_get', { p_key: `oauth:${provider}:client_secret` });
  if (!clientId || !clientSecret) return { ok: false, error: 'oauth_app_not_configured' };
  const useBasic = (meta.tokenAuth ?? 'basic') === 'basic';
  const rBody: Record<string, string> = { grant_type: 'refresh_token', refresh_token: refresh };
  const rHeaders: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (useBasic) rHeaders.Authorization = 'Basic ' + btoa(`${clientId}:${clientSecret}`);
  else { rBody.client_id = String(clientId); rBody.client_secret = String(clientSecret); }
  const res = await fetch(meta.tokenUrl, { method: 'POST', headers: rHeaders, body: new URLSearchParams(rBody).toString() });
  const tok = await res.json().catch(() => null) as { access_token?: string; refresh_token?: string; expires_in?: number } | null;
  if (!res.ok || !tok?.access_token) return { ok: false, error: 'refresh_failed' };
  const next = { ...s, access_token: tok.access_token, refresh_token: tok.refresh_token ?? refresh, expires_at: Date.now() + (Number(tok.expires_in ?? 3600) - 60) * 1000 };
  await c.admin.rpc('set_connector_secret_sysadmin', { p_connector_id: c.connectorId, p_secret: JSON.stringify(next) });
  s.access_token = tok.access_token; s.refresh_token = next.refresh_token; s.expires_at = next.expires_at;
  return { ok: true, token: tok.access_token };
}

// ── quickbooks ── user-OAuth · realm_id from callback · erp_financials.
const QBO = 'https://quickbooks.api.intuit.com/v3/company';
const quickbooks = {
  realm: (c: Ctx) => String((c.secret as Record<string, unknown>).realm_id ?? ''),
  async q(c: Ctx, query: string): Promise<{ ok: boolean; error?: string; rows: Record<string, unknown> }> {
    const t = await oauthAccessToken(c, 'quickbooks');
    if (!t.ok) return { ok: false, error: t.error, rows: {} };
    const r = await httpJson(`${QBO}/${this.realm(c)}/query?query=${encodeURIComponent(query)}&minorversion=65`, { headers: { Authorization: `Bearer ${t.token}`, Accept: 'application/json' } });
    if (!r.ok) return { ok: false, error: r.error, rows: {} };
    return { ok: true, rows: ((r.body as { QueryResponse?: Record<string, unknown> })?.QueryResponse) ?? {} };
  },
  async test(c: Ctx): Promise<TestResult> {
    const t = await oauthAccessToken(c, 'quickbooks');
    if (!t.ok) return { ok: false, error: t.error };
    const realm = this.realm(c);
    const r = await httpJson(`${QBO}/${realm}/companyinfo/${realm}?minorversion=65`, { headers: { Authorization: `Bearer ${t.token}`, Accept: 'application/json' } });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'QuickBooks company reachable' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const res = await this.q(c, 'SELECT * FROM Invoice ORDERBY MetaData.LastUpdatedTime DESC MAXRESULTS 15');
    if (!res.ok) return { ok: false, error: res.error };
    const invs = ((res.rows.Invoice as Array<Record<string, unknown>>) ?? []);
    const ql = query.toLowerCase();
    const f = ql ? invs.filter((i) => String(i.DocNumber ?? '').toLowerCase().includes(ql) || String((i.CustomerRef as { name?: string })?.name ?? '').toLowerCase().includes(ql)) : invs;
    return { ok: true, items: f.slice(0, 10).map((i) => ({ ref: String(i.Id), type: 'invoice', title: clip(`Invoice ${i.DocNumber ?? i.Id} — ${(i.CustomerRef as { name?: string })?.name ?? ''}`, 160), snippet: clip(`${i.TotalAmt ?? ''} · balance ${i.Balance ?? ''} · due ${i.DueDate ?? ''}`, 400), url: null, raw: { id: i.Id } })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const res = await this.q(c, `SELECT * FROM Invoice WHERE Id = '${ref.replace(/'/g, '')}'`);
    if (!res.ok) return { ok: false, error: res.error };
    const i = ((res.rows.Invoice as Array<Record<string, unknown>>) ?? [])[0] ?? {};
    return { ok: true, items: [{ ref, type: 'invoice', title: clip(`Invoice ${i.DocNumber ?? ref}`, 160), snippet: clip(`${i.TotalAmt ?? ''} · balance ${i.Balance ?? ''}`, 400), url: null, raw: i }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
};

// ── xero ── user-OAuth · xero_tenant_id from callback · erp_financials.
const XERO = 'https://api.xero.com/api.xro/2.0';
const xero = {
  async hdrs(c: Ctx): Promise<Record<string, string> | null> {
    const t = await oauthAccessToken(c, 'xero');
    if (!t.ok) return null;
    return { Authorization: `Bearer ${t.token}`, 'Xero-tenant-id': String((c.secret as Record<string, unknown>).xero_tenant_id ?? ''), Accept: 'application/json' };
  },
  async test(c: Ctx): Promise<TestResult> {
    const h = await this.hdrs(c);
    if (!h) return { ok: false, error: 'auth_failed' };
    const r = await httpJson(`${XERO}/Organisation`, { headers: h });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'Xero organisation reachable' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const h = await this.hdrs(c);
    if (!h) return { ok: false, error: 'auth_failed' };
    const r = await httpJson(`${XERO}/Invoices?order=UpdatedDateUTC DESC&page=1`, { headers: h });
    if (!r.ok) return { ok: false, error: r.error };
    const invs = ((r.body as { Invoices?: Array<Record<string, unknown>> })?.Invoices) ?? [];
    const ql = query.toLowerCase();
    const f = ql ? invs.filter((i) => String(i.InvoiceNumber ?? '').toLowerCase().includes(ql) || String((i.Contact as { Name?: string })?.Name ?? '').toLowerCase().includes(ql)) : invs;
    return { ok: true, items: f.slice(0, 10).map((i) => ({ ref: String(i.InvoiceID), type: 'invoice', title: clip(`${i.InvoiceNumber ?? i.InvoiceID} — ${(i.Contact as { Name?: string })?.Name ?? ''}`, 160), snippet: clip(`${i.Total ?? ''} ${i.CurrencyCode ?? ''} · ${i.Status ?? ''}`, 400), url: null, raw: { id: i.InvoiceID } })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const h = await this.hdrs(c);
    if (!h) return { ok: false, error: 'auth_failed' };
    const r = await httpJson(`${XERO}/Invoices/${encodeURIComponent(ref)}`, { headers: h });
    if (!r.ok) return { ok: false, error: r.error };
    const i = (((r.body as { Invoices?: Array<Record<string, unknown>> })?.Invoices) ?? [])[0] ?? {};
    return { ok: true, items: [{ ref, type: 'invoice', title: clip(`${i.InvoiceNumber ?? ref}`, 160), snippet: clip(`${i.Total ?? ''} ${i.CurrencyCode ?? ''} · ${i.Status ?? ''}`, 400), url: null, raw: i }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
};

// ── clio ── user-OAuth · product_system (matters).
const CLIO = 'https://app.clio.com/api/v4';
const clio = {
  async test(c: Ctx): Promise<TestResult> {
    const t = await oauthAccessToken(c, 'clio');
    if (!t.ok) return { ok: false, error: t.error };
    const r = await httpJson(`${CLIO}/users/who_am_i.json`, { headers: { Authorization: `Bearer ${t.token}` } });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'Clio reachable' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const t = await oauthAccessToken(c, 'clio');
    if (!t.ok) return { ok: false, error: t.error };
    const r = await httpJson(`${CLIO}/matters.json?query=${encodeURIComponent(query)}&limit=10&fields=id,display_number,description,status`, { headers: { Authorization: `Bearer ${t.token}` } });
    if (!r.ok) return { ok: false, error: r.error };
    const data = ((r.body as { data?: Array<Record<string, unknown>> })?.data) ?? [];
    return { ok: true, items: data.map((m) => ({ ref: String(m.id), type: 'record', title: clip(`${m.display_number ?? ''} ${m.description ?? ''}`, 160), snippet: clip(String(m.status ?? ''), 400), url: null, raw: { id: m.id } })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const t = await oauthAccessToken(c, 'clio');
    if (!t.ok) return { ok: false, error: t.error };
    const r = await httpJson(`${CLIO}/matters/${encodeURIComponent(ref)}.json?fields=id,display_number,description,status`, { headers: { Authorization: `Bearer ${t.token}` } });
    if (!r.ok) return { ok: false, error: r.error };
    const m = ((r.body as { data?: Record<string, unknown> })?.data) ?? {};
    return { ok: true, items: [{ ref, type: 'record', title: clip(`${m.display_number ?? ''} ${m.description ?? ''}`, 160), snippet: clip(String(m.status ?? ''), 400), url: null, raw: m }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
};

// ── gusto ── user-OAuth · payroll_hcm (employees, time off). Resolves the
// company from /v1/me. NOTE: /v1/me role shape varies — verify with live creds.
const GUSTO = 'https://api.gusto.com';
const gusto = {
  async company(token: string): Promise<string | null> {
    const r = await httpJson(`${GUSTO}/v1/me`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const roles = (r.body as { roles?: { payroll_admin?: { companies?: Array<{ uuid?: string }> } } })?.roles;
    return roles?.payroll_admin?.companies?.[0]?.uuid ?? null;
  },
  async test(c: Ctx): Promise<TestResult> {
    const t = await oauthAccessToken(c, 'gusto');
    if (!t.ok) return { ok: false, error: t.error };
    const r = await httpJson(`${GUSTO}/v1/me`, { headers: { Authorization: `Bearer ${t.token}` } });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'Gusto reachable' };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const t = await oauthAccessToken(c, 'gusto');
    if (!t.ok) return { ok: false, error: t.error };
    const r = await httpJson(`${GUSTO}/v1/employees/${encodeURIComponent(ref)}`, { headers: { Authorization: `Bearer ${t.token}` } });
    if (!r.ok) return { ok: false, error: r.error };
    const e = r.body as Record<string, unknown>;
    const job = (e.jobs as Array<{ title?: string }>)?.[0]?.title ?? '';
    return { ok: true, items: [{ ref, type: 'employee', title: clip(`${e.first_name ?? ''} ${e.last_name ?? ''}`, 160), snippet: clip(`${job} · ${e.email ?? ''}`, 400), url: null, raw: e }] };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const t = await oauthAccessToken(c, 'gusto');
    if (!t.ok) return { ok: false, error: t.error };
    const cid = await this.company(t.token!);
    if (!cid) return { ok: false, error: 'no_company' };
    const r = await httpJson(`${GUSTO}/v1/companies/${cid}/employees`, { headers: { Authorization: `Bearer ${t.token}` } });
    if (!r.ok) return { ok: false, error: r.error };
    const emps = Array.isArray(r.body) ? (r.body as Array<Record<string, unknown>>) : [];
    const ql = query.toLowerCase();
    const f = ql ? emps.filter((e) => `${e.first_name} ${e.last_name} ${e.email}`.toLowerCase().includes(ql)) : emps;
    return { ok: true, items: f.slice(0, 10).map((e) => ({ ref: String(e.uuid ?? e.id), type: 'employee', title: clip(`${e.first_name ?? ''} ${e.last_name ?? ''}`, 160), snippet: clip(String((e.jobs as Array<{ title?: string }>)?.[0]?.title ?? ''), 400), url: null, raw: { id: e.uuid ?? e.id } })) };
  },
  async timeOff(c: Ctx, query: string): Promise<AdapterResult> {
    const t = await oauthAccessToken(c, 'gusto');
    if (!t.ok) return { ok: false, error: t.error };
    const cid = await this.company(t.token!);
    if (!cid) return { ok: false, error: 'no_company' };
    const r = await httpJson(`${GUSTO}/v1/companies/${cid}/time_off_requests`, { headers: { Authorization: `Bearer ${t.token}` } });
    if (!r.ok) return { ok: false, error: r.error };
    const reqs = Array.isArray(r.body) ? (r.body as Array<Record<string, unknown>>) : [];
    const ql = query.toLowerCase();
    const f = ql ? reqs.filter((rq) => String((rq.employee as { full_name?: string })?.full_name ?? '').toLowerCase().includes(ql)) : reqs;
    return { ok: true, items: f.slice(0, 10).map((rq) => ({ ref: String(rq.uuid ?? rq.id), type: 'time_off', title: clip(`${(rq.employee as { full_name?: string })?.full_name ?? 'Time off'} · ${rq.request_type ?? ''}`, 160), snippet: clip(String(rq.status ?? ''), 400), url: null, raw: { id: rq.uuid ?? rq.id } })) };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
};

// ── procore ── user-OAuth · product_system (projects). Resolves company from
// /companies; ref = companyId/projectId. Verify field shapes with live creds.
const PROCORE = 'https://api.procore.com/rest/v1.0';
const procore = {
  async company(token: string): Promise<string | null> {
    const r = await httpJson(`${PROCORE}/companies`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const cs = Array.isArray(r.body) ? (r.body as Array<{ id?: string | number }>) : [];
    return cs[0]?.id != null ? String(cs[0].id) : null;
  },
  async test(c: Ctx): Promise<TestResult> {
    const t = await oauthAccessToken(c, 'procore');
    if (!t.ok) return { ok: false, error: t.error };
    const r = await httpJson(`${PROCORE}/companies`, { headers: { Authorization: `Bearer ${t.token}` } });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'Procore reachable' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const t = await oauthAccessToken(c, 'procore');
    if (!t.ok) return { ok: false, error: t.error };
    const cid = await this.company(t.token!);
    if (!cid) return { ok: false, error: 'no_company' };
    const r = await httpJson(`${PROCORE}/projects?company_id=${cid}`, { headers: { Authorization: `Bearer ${t.token}` } });
    if (!r.ok) return { ok: false, error: r.error };
    const projs = Array.isArray(r.body) ? (r.body as Array<Record<string, unknown>>) : [];
    const ql = query.toLowerCase();
    const f = ql ? projs.filter((p) => String(p.name ?? '').toLowerCase().includes(ql)) : projs;
    return { ok: true, items: f.slice(0, 10).map((p) => ({ ref: `${cid}/${p.id}`, type: 'record', title: clip(p.name, 160), snippet: clip(`${p.project_number ?? ''} · ${p.stage ?? ''}`, 400), url: null, raw: { id: p.id } })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const t = await oauthAccessToken(c, 'procore');
    if (!t.ok) return { ok: false, error: t.error };
    const [cid, pid] = ref.split('/');
    const r = await httpJson(`${PROCORE}/projects/${encodeURIComponent(pid ?? ref)}?company_id=${cid ?? ''}`, { headers: { Authorization: `Bearer ${t.token}` } });
    if (!r.ok) return { ok: false, error: r.error };
    const p = r.body as Record<string, unknown>;
    return { ok: true, items: [{ ref, type: 'record', title: clip(p.name, 160), snippet: clip(String(p.project_number ?? ''), 400), url: null, raw: p }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
};

// ── jobber ── user-OAuth · GraphQL · product_system (jobs). Field/version
// shapes should be confirmed against live creds.
const JOBBER = 'https://api.getjobber.com/api/graphql';
const jobber = {
  async gql(c: Ctx, query: string): Promise<{ ok: boolean; error?: string; data: Record<string, unknown> | null }> {
    const t = await oauthAccessToken(c, 'jobber');
    if (!t.ok) return { ok: false, error: t.error, data: null };
    const r = await httpJson(JOBBER, { method: 'POST', headers: { Authorization: `Bearer ${t.token}`, 'Content-Type': 'application/json', 'X-JOBBER-GRAPHQL-VERSION': '2023-11-15' }, body: JSON.stringify({ query }) });
    const b = r.body as { data?: Record<string, unknown>; errors?: Array<{ message?: string }> } | null;
    if (!r.ok) return { ok: false, error: r.error, data: null };
    if (b?.errors?.length) return { ok: false, error: String(b.errors[0]?.message ?? 'jobber_error'), data: null };
    return { ok: true, data: b?.data ?? null };
  },
  async test(c: Ctx): Promise<TestResult> {
    const r = await this.gql(c, '{ jobs(first:1){ nodes { id } } }');
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'Jobber reachable' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const r = await this.gql(c, '{ jobs(first:15){ nodes { id jobNumber title client { name } } } }');
    if (!r.ok) return { ok: false, error: r.error };
    const nodes = ((r.data?.jobs as { nodes?: Array<Record<string, unknown>> })?.nodes) ?? [];
    const ql = query.toLowerCase();
    const f = ql ? nodes.filter((j) => String(j.title ?? '').toLowerCase().includes(ql) || String((j.client as { name?: string })?.name ?? '').toLowerCase().includes(ql)) : nodes;
    return { ok: true, items: f.slice(0, 10).map((j) => ({ ref: String(j.id), type: 'record', title: clip(`#${j.jobNumber ?? ''} ${j.title ?? ''}`, 160), snippet: clip(String((j.client as { name?: string })?.name ?? ''), 400), url: null, raw: { id: j.id } })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const r = await this.gql(c, `{ job(id:${JSON.stringify(ref)}){ id jobNumber title } }`);
    if (!r.ok) return { ok: false, error: r.error };
    const j = (r.data?.job as Record<string, unknown>) ?? {};
    return { ok: true, items: [{ ref, type: 'record', title: clip(`#${j.jobNumber ?? ''} ${j.title ?? ''}`, 160), snippet: '', url: null, raw: j }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
};

// ── gorgias ── secret: { email, api_key } · base = store URL. helpdesk (e-comm).
const gorgias = {
  auth: (c: Ctx) => 'Basic ' + btoa(`${c.secret.email ?? ''}:${c.secret.api_key ?? ''}`),
  async test(c: Ctx): Promise<TestResult> {
    const r = await httpJson(`${c.baseUrl}/api/tickets?limit=1`, { headers: { Authorization: this.auth(c) } });
    if (r.status === 401 || r.status === 403) return { ok: false, error: 'auth_failed' };
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'Gorgias credentials verified' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const r = await httpJson(`${c.baseUrl}/api/tickets?limit=20&order_by=updated_datetime:desc`, { headers: { Authorization: this.auth(c) } });
    if (!r.ok) return { ok: false, error: r.error };
    const data = ((r.body as { data?: Array<Record<string, unknown>> })?.data) ?? [];
    const ql = query.toLowerCase();
    const f = ql ? data.filter((t) => `${t.subject ?? ''} ${(t.customer as { email?: string })?.email ?? ''}`.toLowerCase().includes(ql)) : data;
    return { ok: true, items: f.slice(0, 10).map((t) => ({ ref: String(t.id), type: 'ticket', title: clip(`#${t.id} ${t.subject ?? ''}`, 160), snippet: clip(`${(t.customer as { email?: string })?.email ?? ''} · ${t.status ?? ''}`, 400), url: null, raw: { id: t.id } })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const r = await httpJson(`${c.baseUrl}/api/tickets/${encodeURIComponent(ref)}`, { headers: { Authorization: this.auth(c) } });
    if (!r.ok) return { ok: false, error: r.error };
    const t = r.body as Record<string, unknown>;
    return { ok: true, items: [{ ref, type: 'ticket', title: clip(`#${ref} ${t.subject ?? ''}`, 160), snippet: clip(String(t.status ?? ''), 400), url: null, raw: t }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
};

// ── front ── secret: { token } · fixed base. helpdesk (shared inbox).
const FRONT = 'https://api2.frontapp.com';
const front = {
  hdrs: (c: Ctx) => ({ Authorization: `Bearer ${c.secret.token ?? ''}`, 'Content-Type': 'application/json' }),
  async test(c: Ctx): Promise<TestResult> {
    const r = await httpJson(`${FRONT}/me`, { headers: this.hdrs(c) });
    if (r.status === 401) return { ok: false, error: 'auth_failed' };
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'Front token verified' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const path = query.trim() ? `/conversations/search/${encodeURIComponent(query)}` : '/conversations';
    const r = await httpJson(`${FRONT}${path}?limit=15`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const results = ((r.body as { _results?: Array<Record<string, unknown>>; results?: Array<Record<string, unknown>> })?._results) ?? ((r.body as { results?: Array<Record<string, unknown>> })?.results) ?? [];
    return { ok: true, items: results.slice(0, 10).map((cv) => ({ ref: String(cv.id), type: 'ticket', title: clip(String(cv.subject || `Conversation ${cv.id}`), 160), snippet: clip(String(cv.status ?? ''), 400), url: null, raw: { id: cv.id } })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const r = await httpJson(`${FRONT}/conversations/${encodeURIComponent(ref)}`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const cv = r.body as Record<string, unknown>;
    return { ok: true, items: [{ ref, type: 'ticket', title: clip(String(cv.subject || ref), 160), snippet: clip(String(cv.status ?? ''), 400), url: null, raw: cv }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
};

// ── coda ── secret: { api_token } · fixed base. knowledge_base (docs/pages).
const CODA = 'https://coda.io/apis/v1';
const coda = {
  hdrs: (c: Ctx) => ({ Authorization: `Bearer ${c.secret.api_token ?? ''}` }),
  async test(c: Ctx): Promise<TestResult> {
    const r = await httpJson(`${CODA}/whoami`, { headers: this.hdrs(c) });
    if (r.status === 401) return { ok: false, error: 'auth_failed' };
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'Coda API token verified' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const r = await httpJson(`${CODA}/docs?limit=25${query.trim() ? `&query=${encodeURIComponent(query)}` : ''}`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const items = ((r.body as { items?: Array<Record<string, unknown>> })?.items) ?? [];
    return { ok: true, items: items.slice(0, 10).map((d) => ({ ref: String(d.id), type: 'article', title: clip(d.name, 160), snippet: clip(String((d.folder as { name?: string })?.name ?? ''), 400), url: d.browserLink ? String(d.browserLink) : null, raw: { id: d.id } })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const r = await httpJson(`${CODA}/docs/${encodeURIComponent(ref)}`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const d = r.body as Record<string, unknown>;
    return { ok: true, items: [{ ref, type: 'article', title: clip(d.name, 160), snippet: '', url: d.browserLink ? String(d.browserLink) : null, raw: d }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
};

// ── pagerduty ── secret: { api_key } · fixed base. product_system (incidents).
const PAGERDUTY = 'https://api.pagerduty.com';
const pagerduty = {
  hdrs: (c: Ctx) => ({ Authorization: `Token token=${c.secret.api_key ?? ''}`, Accept: 'application/vnd.pagerduty+json;version=2' }),
  async test(c: Ctx): Promise<TestResult> {
    const r = await httpJson(`${PAGERDUTY}/users?limit=1`, { headers: this.hdrs(c) });
    if (r.status === 401) return { ok: false, error: 'auth_failed' };
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'PagerDuty API key verified' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const r = await httpJson(`${PAGERDUTY}/incidents?limit=20&sort_by=created_at:desc`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const incidents = ((r.body as { incidents?: Array<Record<string, unknown>> })?.incidents) ?? [];
    const ql = query.toLowerCase();
    const f = ql ? incidents.filter((i) => `${i.title ?? ''} ${i.incident_number ?? ''}`.toLowerCase().includes(ql)) : incidents;
    return { ok: true, items: f.slice(0, 10).map((i) => ({ ref: String(i.id), type: 'record', title: clip(`#${i.incident_number} ${i.title ?? ''}`, 160), snippet: clip(`${i.status ?? ''} · ${i.urgency ?? ''}`, 400), url: i.html_url ? String(i.html_url) : null, raw: { id: i.id } })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const r = await httpJson(`${PAGERDUTY}/incidents/${encodeURIComponent(ref)}`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const i = ((r.body as { incident?: Record<string, unknown> })?.incident) ?? {};
    return { ok: true, items: [{ ref, type: 'record', title: clip(`#${i.incident_number ?? ''} ${i.title ?? ''}`, 160), snippet: clip(`${i.status ?? ''}`, 400), url: i.html_url ? String(i.html_url) : null, raw: i }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
};

// ── sentry ── secret: { token } · fixed base. product_system (issues/errors).
const SENTRY = 'https://sentry.io/api/0';
const sentry = {
  hdrs: (c: Ctx) => ({ Authorization: `Bearer ${c.secret.token ?? ''}` }),
  async org(c: Ctx): Promise<string | null> {
    const r = await httpJson(`${SENTRY}/organizations/`, { headers: this.hdrs(c) });
    if (!r.ok) return null;
    const orgs = Array.isArray(r.body) ? (r.body as Array<{ slug?: string }>) : [];
    return orgs[0]?.slug ?? null;
  },
  async test(c: Ctx): Promise<TestResult> {
    const r = await httpJson(`${SENTRY}/organizations/`, { headers: this.hdrs(c) });
    if (r.status === 401) return { ok: false, error: 'auth_failed' };
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'Sentry token verified' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const org = await this.org(c);
    if (!org) return { ok: false, error: 'no_organization' };
    const r = await httpJson(`${SENTRY}/organizations/${org}/issues/?query=${encodeURIComponent(query || 'is:unresolved')}&limit=15`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const issues = Array.isArray(r.body) ? (r.body as Array<Record<string, unknown>>) : [];
    return { ok: true, items: issues.slice(0, 10).map((i) => ({ ref: String(i.id), type: 'record', title: clip(i.title, 160), snippet: clip(`${i.culprit ?? ''} · ${i.count ?? ''} events`, 400), url: i.permalink ? String(i.permalink) : null, raw: { id: i.id } })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const r = await httpJson(`${SENTRY}/issues/${encodeURIComponent(ref)}/`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const i = r.body as Record<string, unknown>;
    return { ok: true, items: [{ ref, type: 'record', title: clip(i.title, 160), snippet: clip(String(i.culprit ?? ''), 400), url: i.permalink ? String(i.permalink) : null, raw: i }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, 'is:unresolved'); },
};

// ── pipedrive ── secret: { api_token } · fixed base. crm (query-param auth).
const PIPEDRIVE = 'https://api.pipedrive.com/v1';
const pipedrive = {
  tok: (c: Ctx) => encodeURIComponent(c.secret.api_token ?? ''),
  async test(c: Ctx): Promise<TestResult> {
    const r = await httpJson(`${PIPEDRIVE}/users/me?api_token=${this.tok(c)}`, {});
    if (r.status === 401) return { ok: false, error: 'auth_failed' };
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'Pipedrive API token verified' };
  },
  async searchType(c: Ctx, kind: string, query: string): Promise<Array<Record<string, unknown>>> {
    const r = await httpJson(`${PIPEDRIVE}/${kind}/search?term=${encodeURIComponent(query || 'a')}&api_token=${this.tok(c)}`, {});
    if (!r.ok) return [];
    return (((r.body as { data?: { items?: Array<{ item?: Record<string, unknown> }> } })?.data?.items) ?? []).map((x) => x.item ?? {});
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const orgs = await this.searchType(c, 'organizations', query);
    const deals = await this.searchType(c, 'deals', query);
    const items: HubItem[] = [];
    for (const o of orgs.slice(0, 5)) items.push({ ref: String(o.id), type: 'account', title: clip(o.name, 160), snippet: '', url: null, raw: { id: o.id } });
    for (const d of deals.slice(0, 5)) items.push({ ref: String(d.id), type: 'opportunity', title: clip(d.title, 160), snippet: clip(`value ${d.value ?? ''} · ${d.status ?? ''}`, 400), url: null, raw: { id: d.id } });
    return { ok: true, items };
  },
  async fetchRecord(c: Ctx, type: string, ref: string): Promise<AdapterResult> {
    const set = type === 'opportunity' ? 'deals' : type === 'conversation' ? 'persons' : 'organizations';
    const r = await httpJson(`${PIPEDRIVE}/${set}/${encodeURIComponent(ref)}?api_token=${this.tok(c)}`, {});
    if (!r.ok) return { ok: false, error: r.error };
    const d = ((r.body as { data?: Record<string, unknown> })?.data) ?? {};
    return { ok: true, items: [{ ref, type, title: clip(d.name ?? d.title ?? ref, 160), snippet: clip(String(d.status ?? d.value ?? ''), 400), url: null, raw: d }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
};

// ── smartsheet ── secret: { token } · fixed base. product_system.
const SMARTSHEET = 'https://api.smartsheet.com/2.0';
const smartsheet = {
  hdrs: (c: Ctx) => ({ Authorization: `Bearer ${c.secret.token ?? ''}` }),
  async test(c: Ctx): Promise<TestResult> {
    const r = await httpJson(`${SMARTSHEET}/users/me`, { headers: this.hdrs(c) });
    if (r.status === 401) return { ok: false, error: 'auth_failed' };
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'Smartsheet token verified' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const path = query.trim() ? `/search?query=${encodeURIComponent(query)}` : '/sheets?pageSize=15';
    const r = await httpJson(`${SMARTSHEET}${path}`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const results = query.trim()
      ? (((r.body as { results?: Array<Record<string, unknown>> })?.results) ?? [])
      : (((r.body as { data?: Array<Record<string, unknown>> })?.data) ?? []);
    return { ok: true, items: results.slice(0, 10).map((x) => ({ ref: String(x.objectId ?? x.id), type: 'record', title: clip(x.text ?? x.name, 160), snippet: clip(String(x.objectType ?? ''), 400), url: x.permalink ? String(x.permalink) : null, raw: { id: x.objectId ?? x.id } })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const r = await httpJson(`${SMARTSHEET}/sheets/${encodeURIComponent(ref)}`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const s = r.body as Record<string, unknown>;
    return { ok: true, items: [{ ref, type: 'record', title: clip(s.name, 160), snippet: clip(`${(s.rows as unknown[])?.length ?? 0} rows`, 400), url: s.permalink ? String(s.permalink) : null, raw: s }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
};

// ── wrike ── secret: { token } · fixed base. product_system.
const WRIKE = 'https://www.wrike.com/api/v4';
const wrike = {
  hdrs: (c: Ctx) => ({ Authorization: `Bearer ${c.secret.token ?? ''}` }),
  async test(c: Ctx): Promise<TestResult> {
    const r = await httpJson(`${WRIKE}/account`, { headers: this.hdrs(c) });
    if (r.status === 401) return { ok: false, error: 'auth_failed' };
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'Wrike token verified' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const r = await httpJson(`${WRIKE}/tasks?limit=25&fields=["description"]`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const tasks = ((r.body as { data?: Array<Record<string, unknown>> })?.data) ?? [];
    const ql = query.toLowerCase();
    const f = ql ? tasks.filter((t) => String(t.title ?? '').toLowerCase().includes(ql)) : tasks;
    return { ok: true, items: f.slice(0, 10).map((t) => ({ ref: String(t.id), type: 'record', title: clip(t.title, 160), snippet: clip(t.description ?? t.status ?? '', 400), url: t.permalink ? String(t.permalink) : null, raw: { id: t.id } })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const r = await httpJson(`${WRIKE}/tasks/${encodeURIComponent(ref)}`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const t = (((r.body as { data?: Array<Record<string, unknown>> })?.data) ?? [])[0] ?? {};
    return { ok: true, items: [{ ref, type: 'record', title: clip(t.title, 160), snippet: clip(t.description ?? '', 400), url: t.permalink ? String(t.permalink) : null, raw: t }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
};

// ── trello ── secret: { api_key, token } · fixed base. product_system.
const TRELLO = 'https://api.trello.com/1';
const trello = {
  auth: (c: Ctx) => `key=${encodeURIComponent(c.secret.api_key ?? '')}&token=${encodeURIComponent(c.secret.token ?? '')}`,
  async test(c: Ctx): Promise<TestResult> {
    const r = await httpJson(`${TRELLO}/members/me?${this.auth(c)}`, {});
    if (r.status === 401) return { ok: false, error: 'auth_failed' };
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'Trello credentials verified' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    if (!query.trim()) {
      const r = await httpJson(`${TRELLO}/members/me/cards?limit=15&${this.auth(c)}`, {});
      if (!r.ok) return { ok: false, error: r.error };
      const cards = Array.isArray(r.body) ? (r.body as Array<Record<string, unknown>>) : [];
      return { ok: true, items: cards.slice(0, 10).map((cd) => ({ ref: String(cd.id), type: 'record', title: clip(cd.name, 160), snippet: '', url: cd.url ? String(cd.url) : null, raw: { id: cd.id } })) };
    }
    const r = await httpJson(`${TRELLO}/search?query=${encodeURIComponent(query)}&modelTypes=cards&cards_limit=15&${this.auth(c)}`, {});
    if (!r.ok) return { ok: false, error: r.error };
    const cards = ((r.body as { cards?: Array<Record<string, unknown>> })?.cards) ?? [];
    return { ok: true, items: cards.slice(0, 10).map((cd) => ({ ref: String(cd.id), type: 'record', title: clip(cd.name, 160), snippet: clip(cd.desc, 400), url: cd.url ? String(cd.url) : null, raw: { id: cd.id } })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const r = await httpJson(`${TRELLO}/cards/${encodeURIComponent(ref)}?${this.auth(c)}`, {});
    if (!r.ok) return { ok: false, error: r.error };
    const cd = r.body as Record<string, unknown>;
    return { ok: true, items: [{ ref, type: 'record', title: clip(cd.name, 160), snippet: clip(cd.desc, 400), url: cd.url ? String(cd.url) : null, raw: cd }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
};

// ── datadog ── secret: { api_key, app_key } · fixed base. product_system.
const DATADOG = 'https://api.datadoghq.com';
const datadog = {
  hdrs: (c: Ctx) => ({ 'DD-API-KEY': c.secret.api_key ?? '', 'DD-APPLICATION-KEY': c.secret.app_key ?? '' }),
  async test(c: Ctx): Promise<TestResult> {
    const r = await httpJson(`${DATADOG}/api/v1/validate`, { headers: { 'DD-API-KEY': c.secret.api_key ?? '' } });
    if (r.status === 401 || r.status === 403) return { ok: false, error: 'auth_failed' };
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'Datadog API key verified' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const r = await httpJson(`${DATADOG}/api/v1/monitor`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const monitors = Array.isArray(r.body) ? (r.body as Array<Record<string, unknown>>) : [];
    const ql = query.toLowerCase();
    const f = ql ? monitors.filter((m) => String(m.name ?? '').toLowerCase().includes(ql)) : monitors;
    return { ok: true, items: f.slice(0, 10).map((m) => ({ ref: String(m.id), type: 'record', title: clip(m.name, 160), snippet: clip(`${m.type ?? ''} · ${(m.overall_state ?? '')}`, 400), url: null, raw: { id: m.id } })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const r = await httpJson(`${DATADOG}/api/v1/monitor/${encodeURIComponent(ref)}`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const m = r.body as Record<string, unknown>;
    return { ok: true, items: [{ ref, type: 'record', title: clip(m.name, 160), snippet: clip(`${m.type ?? ''} · ${m.overall_state ?? ''}`, 400), url: null, raw: m }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
};

// ── close ── secret: { api_key } · fixed base. crm.
const CLOSE = 'https://api.close.com/api/v1';
const close = {
  auth: (c: Ctx) => 'Basic ' + btoa(`${c.secret.api_key ?? ''}:`),
  async test(c: Ctx): Promise<TestResult> {
    const r = await httpJson(`${CLOSE}/me/`, { headers: { Authorization: this.auth(c) } });
    if (r.status === 401) return { ok: false, error: 'auth_failed' };
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'Close API key verified' };
  },
  async leads(c: Ctx, query: string): Promise<Array<Record<string, unknown>>> {
    const r = await httpJson(`${CLOSE}/lead/?${query.trim() ? `query=${encodeURIComponent(query)}&` : ''}_limit=15`, { headers: { Authorization: this.auth(c) } });
    if (!r.ok) return [];
    return ((r.body as { data?: Array<Record<string, unknown>> })?.data) ?? [];
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const leads = await this.leads(c, query);
    return { ok: true, items: leads.slice(0, 10).map((l) => ({ ref: String(l.id), type: 'account', title: clip(l.display_name ?? l.name, 160), snippet: clip(String(l.description ?? ''), 400), url: l.html_url ? String(l.html_url) : null, raw: { id: l.id } })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const r = await httpJson(`${CLOSE}/lead/${encodeURIComponent(ref)}/`, { headers: { Authorization: this.auth(c) } });
    if (!r.ok) return { ok: false, error: r.error };
    const l = r.body as Record<string, unknown>;
    return { ok: true, items: [{ ref, type: 'account', title: clip(l.display_name ?? ref, 160), snippet: clip(String(l.description ?? ''), 400), url: l.html_url ? String(l.html_url) : null, raw: l }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
};

// ── kustomer ── secret: { api_key } · fixed base. helpdesk (conversations).
const KUSTOMER = 'https://api.kustomerapp.com/v1';
const kustomer = {
  hdrs: (c: Ctx) => ({ Authorization: `Bearer ${c.secret.api_key ?? ''}`, 'Content-Type': 'application/json' }),
  async test(c: Ctx): Promise<TestResult> {
    const r = await httpJson(`${KUSTOMER}/conversations?page[size]=1`, { headers: this.hdrs(c) });
    if (r.status === 401) return { ok: false, error: 'auth_failed' };
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'Kustomer API key verified' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const r = await httpJson(`${KUSTOMER}/conversations?page[size]=20`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const data = ((r.body as { data?: Array<Record<string, unknown>> })?.data) ?? [];
    const ql = query.toLowerCase();
    const f = ql ? data.filter((cv) => String((cv.attributes as { name?: string })?.name ?? '').toLowerCase().includes(ql)) : data;
    return { ok: true, items: f.slice(0, 10).map((cv) => { const a = (cv.attributes ?? {}) as Record<string, unknown>; return { ref: String(cv.id), type: 'ticket', title: clip(a.name || `Conversation ${cv.id}`, 160), snippet: clip(`${a.status ?? ''} · ${a.priority ?? ''}`, 400), url: null, raw: { id: cv.id } }; }) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const r = await httpJson(`${KUSTOMER}/conversations/${encodeURIComponent(ref)}`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const cv = ((r.body as { data?: Record<string, unknown> })?.data) ?? {};
    const a = (cv.attributes ?? {}) as Record<string, unknown>;
    return { ok: true, items: [{ ref, type: 'ticket', title: clip(a.name || ref, 160), snippet: clip(String(a.status ?? ''), 400), url: null, raw: cv }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
};

// ── mailchimp ── secret: { api_key } (dc in suffix) · derived base. other (campaigns).
const mcBase = (c: Ctx) => { const k = c.secret.api_key ?? ''; const dc = k.includes('-') ? k.split('-').pop() : 'us1'; return `https://${dc}.api.mailchimp.com/3.0`; };
const mailchimp = {
  auth: (c: Ctx) => 'Basic ' + btoa(`anystring:${c.secret.api_key ?? ''}`),
  async test(c: Ctx): Promise<TestResult> {
    const r = await httpJson(`${mcBase(c)}/ping`, { headers: { Authorization: this.auth(c) } });
    if (r.status === 401) return { ok: false, error: 'auth_failed' };
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'Mailchimp API key verified' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const r = await httpJson(`${mcBase(c)}/campaigns?count=20&sort_field=create_time&sort_dir=DESC`, { headers: { Authorization: this.auth(c) } });
    if (!r.ok) return { ok: false, error: r.error };
    const camps = ((r.body as { campaigns?: Array<Record<string, unknown>> })?.campaigns) ?? [];
    const ql = query.toLowerCase();
    const f = ql ? camps.filter((m) => String((m.settings as { title?: string; subject_line?: string })?.title ?? (m.settings as { subject_line?: string })?.subject_line ?? '').toLowerCase().includes(ql)) : camps;
    return { ok: true, items: f.slice(0, 10).map((m) => { const s = (m.settings ?? {}) as Record<string, unknown>; return { ref: String(m.id), type: 'record', title: clip(s.title || s.subject_line || `Campaign ${m.id}`, 160), snippet: clip(`${m.status ?? ''} · ${(m.emails_sent ?? 0)} sent`, 400), url: (m.archive_url) ? String(m.archive_url) : null, raw: { id: m.id } }; }) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const r = await httpJson(`${mcBase(c)}/campaigns/${encodeURIComponent(ref)}`, { headers: { Authorization: this.auth(c) } });
    if (!r.ok) return { ok: false, error: r.error };
    const m = r.body as Record<string, unknown>;
    const s = (m.settings ?? {}) as Record<string, unknown>;
    return { ok: true, items: [{ ref, type: 'record', title: clip(s.title || s.subject_line || ref, 160), snippet: clip(String(m.status ?? ''), 400), url: null, raw: m }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
};

// ── gitbook ── secret: { token } · fixed base. knowledge_base (spaces). Org/space
// traversal shapes should be confirmed against live creds.
const GITBOOK = 'https://api.gitbook.com/v1';
const gitbook = {
  hdrs: (c: Ctx) => ({ Authorization: `Bearer ${c.secret.token ?? ''}` }),
  async spaces(c: Ctx): Promise<Array<Record<string, unknown>>> {
    const o = await httpJson(`${GITBOOK}/orgs`, { headers: this.hdrs(c) });
    const orgs = ((o.body as { items?: Array<{ id?: string }> })?.items) ?? [];
    if (!orgs.length) return [];
    const s = await httpJson(`${GITBOOK}/orgs/${orgs[0].id}/spaces`, { headers: this.hdrs(c) });
    return ((s.body as { items?: Array<Record<string, unknown>> })?.items) ?? [];
  },
  async test(c: Ctx): Promise<TestResult> {
    const r = await httpJson(`${GITBOOK}/user`, { headers: this.hdrs(c) });
    if (r.status === 401) return { ok: false, error: 'auth_failed' };
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'GitBook token verified' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const spaces = await this.spaces(c);
    const ql = query.toLowerCase();
    const f = ql ? spaces.filter((s) => String(s.title ?? '').toLowerCase().includes(ql)) : spaces;
    return { ok: true, items: f.slice(0, 10).map((s) => ({ ref: String(s.id), type: 'article', title: clip(s.title, 160), snippet: '', url: (s.urls as { app?: string })?.app ? String((s.urls as { app?: string }).app) : null, raw: { id: s.id } })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const r = await httpJson(`${GITBOOK}/spaces/${encodeURIComponent(ref)}`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const s = r.body as Record<string, unknown>;
    return { ok: true, items: [{ ref, type: 'article', title: clip(s.title, 160), snippet: '', url: (s.urls as { app?: string })?.app ? String((s.urls as { app?: string }).app) : null, raw: s }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
};

// ════════════════════════════════════════════════════════════════
// GATED / REGULATED-VERTICAL CONNECTORS (NetSuite, PowerSchool, Ellucian,
// Toast, athenahealth, Epic, Cerner). The auth machinery is real; access is
// gated by partner programs / district provisioning / per-health-system
// authorization + BAA — none self-serve. Endpoint/field shapes must be
// confirmed against a live, authorized instance.
// ════════════════════════════════════════════════════════════════

const b64std = (buf: ArrayBuffer): string => { let bin = ''; for (const x of new Uint8Array(buf)) bin += String.fromCharCode(x); return btoa(bin); };

// client-credentials OAuth2 token (Basic or body-style client auth).
async function clientCredsToken(tokenUrl: string, clientId: string, clientSecret: string, scope?: string, style: 'basic' | 'body' = 'basic'): Promise<{ ok: boolean; token?: string; error?: string }> {
  const body = new URLSearchParams({ grant_type: 'client_credentials', ...(scope ? { scope } : {}) });
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (style === 'basic') headers.Authorization = 'Basic ' + btoa(`${clientId}:${clientSecret}`);
  else { body.set('client_id', clientId); body.set('client_secret', clientSecret); }
  const r = await httpJson(tokenUrl, { method: 'POST', headers, body: body.toString() });
  const b = r.body as { access_token?: string; error_description?: string; error?: string } | null;
  if (!r.ok || !b?.access_token) return { ok: false, error: b?.error_description ?? b?.error ?? r.error ?? 'token_failed' };
  return { ok: true, token: b.access_token };
}

// SMART-on-FHIR Backend Services token (RS256 JWT client assertion).
async function fhirBackendToken(c: Ctx): Promise<{ ok: boolean; token?: string; error?: string }> {
  const clientId = (c.secret.client_id ?? '').trim();
  const tokenUrl = (c.secret.token_url ?? '').trim();
  const pem = c.secret.private_key ?? '';
  if (!clientId || !tokenUrl || !pem) return { ok: false, error: 'missing_client_id_token_url_or_private_key' };
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const jti = `${now}-${Math.random().toString(36).slice(2)}`;
  const signingInput = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iss: clientId, sub: clientId, aud: tokenUrl, jti, exp: now + 300, iat: now })}`;
  let assertion: string;
  try {
    const der = Uint8Array.from(atob(pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '')), (x) => x.charCodeAt(0));
    const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, key, new TextEncoder().encode(signingInput));
    assertion = `${signingInput}.${b64url(new Uint8Array(sig))}`;
  } catch (e) { return { ok: false, error: `could_not_sign_assertion: ${String((e as Error)?.message ?? e).slice(0, 60)}` }; }
  const r = await httpJson(tokenUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: assertion, scope: c.secret.scope || 'system/*.read' }).toString(),
  });
  const b = r.body as { access_token?: string; error_description?: string } | null;
  if (!r.ok || !b?.access_token) return { ok: false, error: b?.error_description ?? r.error ?? 'fhir_token_failed' };
  return { ok: true, token: b.access_token };
}

// Shared FHIR R4 read surface (Epic, Cerner). base_url = the org FHIR base.
function makeFhirAdapter(label: string) {
  return {
    async test(c: Ctx): Promise<TestResult> {
      const t = await fhirBackendToken(c);
      if (!t.ok) return { ok: false, error: t.error };
      const r = await httpJson(`${c.baseUrl.replace(/\/+$/, '')}/Patient?_count=1`, { headers: { Authorization: `Bearer ${t.token}`, Accept: 'application/fhir+json' } });
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, detail: `${label} FHIR endpoint reachable (SMART backend token issued)` };
    },
    async search(c: Ctx, query: string): Promise<AdapterResult> {
      const t = await fhirBackendToken(c);
      if (!t.ok) return { ok: false, error: t.error };
      const q = query.trim() ? `name=${encodeURIComponent(query)}&` : '';
      const r = await httpJson(`${c.baseUrl.replace(/\/+$/, '')}/Patient?${q}_count=10`, { headers: { Authorization: `Bearer ${t.token}`, Accept: 'application/fhir+json' } });
      if (!r.ok) return { ok: false, error: r.error };
      const entries = ((r.body as { entry?: Array<{ resource?: Record<string, unknown> }> })?.entry) ?? [];
      return { ok: true, items: entries.slice(0, 10).map((e) => { const p = e.resource ?? {}; const nm = ((p.name as Array<{ text?: string; family?: string; given?: string[] }>) ?? [])[0]; return { ref: String(p.id), type: 'record', title: clip(nm?.text || `${(nm?.given ?? []).join(' ')} ${nm?.family ?? ''}`.trim() || `Patient ${p.id}`, 160), snippet: clip(`${p.gender ?? ''} · ${p.birthDate ?? ''}`, 400), url: null, raw: { id: p.id } }; }) };
    },
    async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
      const t = await fhirBackendToken(c);
      if (!t.ok) return { ok: false, error: t.error };
      const r = await httpJson(`${c.baseUrl.replace(/\/+$/, '')}/Patient/${encodeURIComponent(ref)}`, { headers: { Authorization: `Bearer ${t.token}`, Accept: 'application/fhir+json' } });
      if (!r.ok) return { ok: false, error: r.error };
      const p = r.body as Record<string, unknown>;
      const nm = ((p.name as Array<{ text?: string }>) ?? [])[0];
      return { ok: true, items: [{ ref, type: 'record', title: clip(nm?.text || `Patient ${ref}`, 160), snippet: clip(`${p.gender ?? ''} · ${p.birthDate ?? ''}`, 400), url: null, raw: p }] };
    },
    listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
  };
}
const epic = makeFhirAdapter('Epic');
const cerner = makeFhirAdapter('Oracle Health (Cerner)');

// ── netsuite ── secret: { account_id, consumer_key, consumer_secret, token_id,
// token_secret } · base = SuiteTalk REST base. OAuth 1.0a (TBA), HMAC-SHA256.
const nsPctEncode = (s: string) => encodeURIComponent(s).replace(/[!*'()]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
async function nsAuthHeader(c: Ctx, method: string, url: string): Promise<string> {
  const oauth: Record<string, string> = {
    oauth_consumer_key: c.secret.consumer_key ?? '',
    oauth_token: c.secret.token_id ?? '',
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_nonce: Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
    oauth_version: '1.0',
  };
  const u = new URL(url);
  const params: Record<string, string> = { ...oauth };
  for (const [k, v] of u.searchParams) params[k] = v;
  const baseParams = Object.keys(params).sort().map((k) => `${nsPctEncode(k)}=${nsPctEncode(params[k])}`).join('&');
  const sigBase = `${method.toUpperCase()}&${nsPctEncode(`${u.origin}${u.pathname}`)}&${nsPctEncode(baseParams)}`;
  const signingKey = `${nsPctEncode(c.secret.consumer_secret ?? '')}&${nsPctEncode(c.secret.token_secret ?? '')}`;
  const hk = await crypto.subtle.importKey('raw', new TextEncoder().encode(signingKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = b64std(await crypto.subtle.sign('HMAC', hk, new TextEncoder().encode(sigBase)));
  const realm = (c.secret.account_id ?? '').toUpperCase().replace(/-/g, '_');
  const hp: Record<string, string> = { ...oauth, oauth_signature: sig };
  return `OAuth realm="${realm}", ` + Object.keys(hp).sort().map((k) => `${nsPctEncode(k)}="${nsPctEncode(hp[k])}"`).join(', ');
}
const netsuite = {
  async req(c: Ctx, path: string): Promise<{ ok: boolean; error?: string; body: unknown }> {
    const url = `${c.baseUrl.replace(/\/+$/, '')}${path}`;
    const auth = await nsAuthHeader(c, 'GET', url);
    const r = await httpJson(url, { headers: { Authorization: auth, 'Content-Type': 'application/json', Prefer: 'transient' } });
    return { ok: r.ok, error: r.error, body: r.body };
  },
  async test(c: Ctx): Promise<TestResult> {
    const r = await this.req(c, '/record/v1/invoice?limit=1');
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'NetSuite SuiteTalk reachable (TBA signature accepted)' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const r = await this.req(c, '/record/v1/invoice?limit=20');
    if (!r.ok) return { ok: false, error: r.error };
    const items = ((r.body as { items?: Array<Record<string, unknown>> })?.items) ?? [];
    const ql = query.toLowerCase();
    const f = ql ? items.filter((i) => String(i.tranId ?? i.id ?? '').toLowerCase().includes(ql)) : items;
    return { ok: true, items: f.slice(0, 10).map((i) => ({ ref: String(i.id), type: 'invoice', title: clip(`Invoice ${i.tranId ?? i.id}`, 160), snippet: clip(String(i.total ?? ''), 400), url: null, raw: { id: i.id } })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const r = await this.req(c, `/record/v1/invoice/${encodeURIComponent(ref)}`);
    if (!r.ok) return { ok: false, error: r.error };
    const i = r.body as Record<string, unknown>;
    return { ok: true, items: [{ ref, type: 'invoice', title: clip(`Invoice ${i.tranId ?? ref}`, 160), snippet: clip(String(i.total ?? ''), 400), url: null, raw: i }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
};

// ── powerschool ── secret: { client_id, client_secret } · base = district URL.
// client-credentials. product_system (students).
const powerschool = {
  async token(c: Ctx) { return clientCredsToken(`${c.baseUrl.replace(/\/+$/, '')}/oauth/access_token`, c.secret.client_id ?? '', c.secret.client_secret ?? '', undefined, 'basic'); },
  async test(c: Ctx): Promise<TestResult> {
    const t = await this.token(c);
    if (!t.ok) return { ok: false, error: t.error };
    return { ok: true, detail: 'PowerSchool token issued (plugin must be installed by the district)' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const t = await this.token(c);
    if (!t.ok) return { ok: false, error: t.error };
    const r = await httpJson(`${c.baseUrl.replace(/\/+$/, '')}/ws/v1/district/student?pagesize=25`, { headers: { Authorization: `Bearer ${t.token}`, Accept: 'application/json' } });
    if (!r.ok) return { ok: false, error: r.error };
    const students = (((r.body as { students?: { student?: Array<Record<string, unknown>> } })?.students?.student)) ?? [];
    const ql = query.toLowerCase();
    const f = ql ? students.filter((s) => JSON.stringify((s.name ?? {})).toLowerCase().includes(ql)) : students;
    return { ok: true, items: f.slice(0, 10).map((s) => { const nm = (s.name ?? {}) as { first_name?: string; last_name?: string }; return { ref: String((s.id as unknown) ?? ''), type: 'record', title: clip(`${nm.first_name ?? ''} ${nm.last_name ?? ''}`, 160), snippet: '', url: null, raw: { id: s.id } }; }) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const t = await this.token(c);
    if (!t.ok) return { ok: false, error: t.error };
    const r = await httpJson(`${c.baseUrl.replace(/\/+$/, '')}/ws/v1/student/${encodeURIComponent(ref)}`, { headers: { Authorization: `Bearer ${t.token}`, Accept: 'application/json' } });
    if (!r.ok) return { ok: false, error: r.error };
    const s = ((r.body as { student?: Record<string, unknown> })?.student) ?? {};
    const nm = (s.name ?? {}) as { first_name?: string; last_name?: string };
    return { ok: true, items: [{ ref, type: 'record', title: clip(`${nm.first_name ?? ''} ${nm.last_name ?? ''}`, 160), snippet: '', url: null, raw: s }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
};

// ── ellucian (Ethos) ── secret: { api_key } · fixed base. api-key→session token.
const ELLUCIAN = 'https://integrate.elluciancloud.com';
const ellucian = {
  async token(c: Ctx): Promise<{ ok: boolean; token?: string; error?: string }> {
    const r = await httpJson(`${ELLUCIAN}/auth`, { method: 'POST', headers: { Authorization: `Bearer ${c.secret.api_key ?? ''}` } });
    if (r.status === 401) return { ok: false, error: 'auth_failed' };
    // Ethos returns the token as the plain response body.
    const tok = typeof r.body === 'string' ? r.body : String((r.body as { token?: string })?.token ?? '');
    if (!r.ok || !tok) return { ok: false, error: r.error ?? 'ethos_token_failed' };
    return { ok: true, token: tok };
  },
  async test(c: Ctx): Promise<TestResult> {
    const t = await this.token(c);
    if (!t.ok) return { ok: false, error: t.error };
    return { ok: true, detail: 'Ellucian Ethos session token issued' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const t = await this.token(c);
    if (!t.ok) return { ok: false, error: t.error };
    const r = await httpJson(`${ELLUCIAN}/api/persons?criteria=${encodeURIComponent(JSON.stringify({ names: [{ lastName: query }] }))}`, { headers: { Authorization: `Bearer ${t.token}`, Accept: 'application/json' } });
    if (!r.ok) return { ok: false, error: r.error };
    const persons = Array.isArray(r.body) ? (r.body as Array<Record<string, unknown>>) : [];
    return { ok: true, items: persons.slice(0, 10).map((p) => ({ ref: String(p.id), type: 'record', title: clip(JSON.stringify(p.names ?? p.id), 160), snippet: '', url: null, raw: { id: p.id } })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const t = await this.token(c);
    if (!t.ok) return { ok: false, error: t.error };
    const r = await httpJson(`${ELLUCIAN}/api/persons/${encodeURIComponent(ref)}`, { headers: { Authorization: `Bearer ${t.token}`, Accept: 'application/json' } });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, items: [{ ref, type: 'record', title: clip(`Person ${ref}`, 160), snippet: '', url: null, raw: r.body }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
};

// ── toast ── secret: { client_id, client_secret, restaurant_guid } · fixed base.
// client-credentials (partner-gated). pos (orders).
const TOAST = 'https://ws-api.toasttab.com';
const toast = {
  async token(c: Ctx): Promise<{ ok: boolean; token?: string; error?: string }> {
    const r = await httpJson(`${TOAST}/authentication/v1/authentication/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: c.secret.client_id ?? '', clientSecret: c.secret.client_secret ?? '', userAccessType: 'TOAST_MACHINE_CLIENT' }),
    });
    const tok = ((r.body as { token?: { accessToken?: string } })?.token?.accessToken);
    if (!r.ok || !tok) return { ok: false, error: r.error ?? 'toast_token_failed' };
    return { ok: true, token: tok };
  },
  rhdr: (c: Ctx, token: string) => ({ Authorization: `Bearer ${token}`, 'Toast-Restaurant-External-ID': c.secret.restaurant_guid ?? '' }),
  async test(c: Ctx): Promise<TestResult> {
    const t = await this.token(c);
    if (!t.ok) return { ok: false, error: t.error };
    return { ok: true, detail: 'Toast partner token issued' };
  },
  async search(c: Ctx, _query: string): Promise<AdapterResult> {
    const t = await this.token(c);
    if (!t.ok) return { ok: false, error: t.error };
    const r = await httpJson(`${TOAST}/orders/v2/ordersBulk?pageSize=15`, { headers: this.rhdr(c, t.token!) });
    if (!r.ok) return { ok: false, error: r.error };
    const orders = Array.isArray(r.body) ? (r.body as Array<Record<string, unknown>>) : [];
    return { ok: true, items: orders.slice(0, 10).map((o) => ({ ref: String(o.guid), type: 'order', title: clip(`Order ${String(o.guid).slice(0, 8)}`, 160), snippet: clip(String(o.source ?? ''), 400), url: null, raw: { guid: o.guid } })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const t = await this.token(c);
    if (!t.ok) return { ok: false, error: t.error };
    const r = await httpJson(`${TOAST}/orders/v2/orders/${encodeURIComponent(ref)}`, { headers: this.rhdr(c, t.token!) });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, items: [{ ref, type: 'order', title: clip(`Order ${String(ref).slice(0, 8)}`, 160), snippet: '', url: null, raw: r.body }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
};

// ── athenahealth ── secret: { client_id, client_secret, practiceid } · fixed
// base. client-credentials (marketplace-gated + BAA). other (patients).
const ATHENA = 'https://api.platform.athenahealth.com';
const athenahealth = {
  async token(c: Ctx) { return clientCredsToken(`${ATHENA}/oauth2/v1/token`, c.secret.client_id ?? '', c.secret.client_secret ?? '', 'athena/service/Athenanet.MDP.*', 'basic'); },
  async test(c: Ctx): Promise<TestResult> {
    const t = await this.token(c);
    if (!t.ok) return { ok: false, error: t.error };
    return { ok: true, detail: 'athenahealth token issued (marketplace access + BAA required for PHI)' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const t = await this.token(c);
    if (!t.ok) return { ok: false, error: t.error };
    const r = await httpJson(`${ATHENA}/v1/${encodeURIComponent(c.secret.practiceid ?? '')}/patients?limit=15${query.trim() ? `&lastname=${encodeURIComponent(query)}` : ''}`, { headers: { Authorization: `Bearer ${t.token}` } });
    if (!r.ok) return { ok: false, error: r.error };
    const patients = ((r.body as { patients?: Array<Record<string, unknown>> })?.patients) ?? (Array.isArray(r.body) ? (r.body as Array<Record<string, unknown>>) : []);
    return { ok: true, items: patients.slice(0, 10).map((p) => ({ ref: String(p.patientid), type: 'record', title: clip(`${p.firstname ?? ''} ${p.lastname ?? ''}`, 160), snippet: clip(String(p.dob ?? ''), 400), url: null, raw: { id: p.patientid } })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const t = await this.token(c);
    if (!t.ok) return { ok: false, error: t.error };
    const r = await httpJson(`${ATHENA}/v1/${encodeURIComponent(c.secret.practiceid ?? '')}/patients/${encodeURIComponent(ref)}`, { headers: { Authorization: `Bearer ${t.token}` } });
    if (!r.ok) return { ok: false, error: r.error };
    const p = (Array.isArray(r.body) ? (r.body as Array<Record<string, unknown>>)[0] : (r.body as Record<string, unknown>)) ?? {};
    return { ok: true, items: [{ ref, type: 'record', title: clip(`${p.firstname ?? ''} ${p.lastname ?? ''}`, 160), snippet: clip(String(p.dob ?? ''), 400), url: null, raw: p }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
};

// ── dropbox ── user-OAuth · knowledge_base + syncDocs (text/PDF). Mirrors Box:
// discover (filters) + fetchTexts (extract chosen) + review-queue integration.
const DROPBOX = 'https://api.dropboxapi.com/2';
const DROPBOX_CONTENT = 'https://content.dropboxapi.com/2';
async function dropboxFileText(path: string, fileType: string, token: string): Promise<string> {
  const res = await safeFetch(`${DROPBOX_CONTENT}/files/download`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Dropbox-API-Arg': JSON.stringify({ path }) } });
  if (!res) return '';
  if (fileType === 'pdf') return (await pdfBytesToText(new Uint8Array(await res.arrayBuffer()))).slice(0, MAX_DOC_CHARS);
  const raw = await res.text();
  const looksHtml = /<\/?[a-z][\s\S]*>/i.test(raw.slice(0, 4000));
  return (looksHtml ? stripHtml(raw) : raw).slice(0, MAX_DOC_CHARS);
}
const dropbox = {
  async rpc(token: string, path: string, body: unknown): Promise<{ ok: boolean; error?: string; body: Record<string, unknown> | null }> {
    const r = await httpJson(`${DROPBOX}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, ...(body !== null ? { 'Content-Type': 'application/json' } : {}) }, body: body !== null ? JSON.stringify(body) : undefined });
    return { ok: r.ok, error: r.error, body: (r.body ?? null) as Record<string, unknown> | null };
  },
  async test(c: Ctx): Promise<TestResult> {
    const t = await oauthAccessToken(c, 'dropbox');
    if (!t.ok) return { ok: false, error: t.error };
    const r = await this.rpc(t.token!, '/users/get_current_account', null);
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'Dropbox account reachable' };
  },
  async discoverDocs(c: Ctx, f: IngestFilters): Promise<{ ok: boolean; candidates?: Candidate[]; error?: string }> {
    const t = await oauthAccessToken(c, 'dropbox');
    if (!t.ok) return { ok: false, error: t.error };
    const out: Candidate[] = [];
    let r = await this.rpc(t.token!, '/files/list_folder', { path: f.folder ? f.folder : '', recursive: true, limit: 500 });
    let guard = 0;
    while (r.ok && guard < 10 && out.length < MAX_SYNC_FILES) {
      guard++;
      const entries = ((r.body?.entries as Array<Record<string, unknown>>) ?? []);
      for (const e of entries) {
        if (out.length >= MAX_SYNC_FILES) break;
        if (e['.tag'] !== 'file') continue;
        const name = String(e.name ?? '');
        const ft = fileTypeOf(name);
        if (ft !== 'text' && ft !== 'pdf') continue;
        const path = String(e.path_display ?? e.path_lower ?? '');
        const cand: Candidate = { external_ref: `dropbox:${e.id}|${path}`, title: clip(name, 200), path: path.replace(/\/[^/]*$/, '').replace(/^\//, ''), file_type: ft, size_bytes: typeof e.size === 'number' ? e.size : null };
        if (candidatePasses(cand, f)) out.push(cand);
      }
      if (r.body?.has_more) r = await this.rpc(t.token!, '/files/list_folder/continue', { cursor: r.body.cursor });
      else break;
    }
    return { ok: true, candidates: out };
  },
  async fetchTexts(c: Ctx, items: Candidate[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const t = await oauthAccessToken(c, 'dropbox');
    if (!t.ok) return out;
    for (const it of items) { const path = it.external_ref.split('|').slice(1).join('|'); out[it.external_ref] = await dropboxFileText(path, it.file_type, t.token!); }
    return out;
  },
  async syncDocs(c: Ctx, f: IngestFilters = {}): Promise<SyncResult> {
    const d = await this.discoverDocs(c, f);
    if (!d.ok) return { ok: false, error: d.error };
    const cands = d.candidates ?? [];
    if (!cands.length) return { ok: false, error: 'no_readable_documents', detail: 'No text/PDF files match your ingest settings.' };
    const texts = await this.fetchTexts(c, cands);
    const docs: SyncDoc[] = cands.map((cd) => ({ external_ref: cd.external_ref, title: cd.title, content: texts[cd.external_ref] ?? '', url: null })).filter((dd) => dd.content);
    if (!docs.length) return { ok: false, error: 'no_readable_documents', detail: 'Matching files had no extractable text.' };
    return { ok: true, docs };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const t = await oauthAccessToken(c, 'dropbox');
    if (!t.ok) return { ok: false, error: t.error };
    const r = await this.rpc(t.token!, '/files/search_v2', { query: query || 'a', options: { max_results: 15 } });
    if (!r.ok) return { ok: false, error: r.error };
    const matches = ((r.body?.matches as Array<{ metadata?: { metadata?: Record<string, unknown> } }>) ?? []);
    return { ok: true, items: matches.slice(0, 10).map((m) => { const md = m.metadata?.metadata ?? {}; return { ref: `dropbox:${md.id}|${md.path_display ?? ''}`, type: 'article', title: clip(md.name, 160), snippet: '', url: null, raw: { id: md.id } }; }) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const t = await oauthAccessToken(c, 'dropbox');
    if (!t.ok) return { ok: false, error: t.error };
    const path = ref.split('|').slice(1).join('|');
    const r = await this.rpc(t.token!, '/files/get_metadata', { path });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, items: [{ ref, type: 'article', title: clip(r.body?.name, 160), snippet: '', url: null, raw: r.body }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
};

// ── twilio ── secret: { account_sid, auth_token } · fixed base. other (messages).
const twilio = {
  auth: (c: Ctx) => 'Basic ' + btoa(`${c.secret.account_sid ?? ''}:${c.secret.auth_token ?? ''}`),
  base: (c: Ctx) => `https://api.twilio.com/2010-04-01/Accounts/${c.secret.account_sid ?? ''}`,
  async test(c: Ctx): Promise<TestResult> {
    const r = await httpJson(`${this.base(c)}.json`, { headers: { Authorization: this.auth(c) } });
    if (r.status === 401) return { ok: false, error: 'auth_failed' };
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'Twilio credentials verified' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const r = await httpJson(`${this.base(c)}/Messages.json?PageSize=20`, { headers: { Authorization: this.auth(c) } });
    if (!r.ok) return { ok: false, error: r.error };
    const msgs = ((r.body as { messages?: Array<Record<string, unknown>> })?.messages) ?? [];
    const ql = query.toLowerCase();
    const f = ql ? msgs.filter((m) => `${m.body ?? ''} ${m.from ?? ''} ${m.to ?? ''}`.toLowerCase().includes(ql)) : msgs;
    return { ok: true, items: f.slice(0, 10).map((m) => ({ ref: String(m.sid), type: 'record', title: clip(`${m.from} → ${m.to}`, 160), snippet: clip(`${m.body ?? ''} · ${m.status ?? ''}`, 400), url: null, raw: { sid: m.sid } })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const r = await httpJson(`${this.base(c)}/Messages/${encodeURIComponent(ref)}.json`, { headers: { Authorization: this.auth(c) } });
    if (!r.ok) return { ok: false, error: r.error };
    const m = r.body as Record<string, unknown>;
    return { ok: true, items: [{ ref, type: 'record', title: clip(`${m.from} → ${m.to}`, 160), snippet: clip(String(m.body ?? ''), 400), url: null, raw: m }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
};

// ── typeform ── secret: { token } · fixed base. product_system (forms).
const TYPEFORM = 'https://api.typeform.com';
const typeform = {
  hdrs: (c: Ctx) => ({ Authorization: `Bearer ${c.secret.token ?? ''}` }),
  async test(c: Ctx): Promise<TestResult> {
    const r = await httpJson(`${TYPEFORM}/me`, { headers: this.hdrs(c) });
    if (r.status === 401) return { ok: false, error: 'auth_failed' };
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'Typeform token verified' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const r = await httpJson(`${TYPEFORM}/forms?page_size=20${query.trim() ? `&search=${encodeURIComponent(query)}` : ''}`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const items = ((r.body as { items?: Array<Record<string, unknown>> })?.items) ?? [];
    return { ok: true, items: items.slice(0, 10).map((fm) => ({ ref: String(fm.id), type: 'record', title: clip(fm.title, 160), snippet: '', url: (fm._links as { display?: string })?.display ? String((fm._links as { display?: string }).display) : null, raw: { id: fm.id } })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const r = await httpJson(`${TYPEFORM}/forms/${encodeURIComponent(ref)}`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const fm = r.body as Record<string, unknown>;
    return { ok: true, items: [{ ref, type: 'record', title: clip(fm.title, 160), snippet: clip(`${(fm.fields as unknown[])?.length ?? 0} fields`, 400), url: null, raw: fm }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
};

// ── calendly ── secret: { token } · fixed base. product_system (events).
const CALENDLY = 'https://api.calendly.com';
const calendly = {
  hdrs: (c: Ctx) => ({ Authorization: `Bearer ${c.secret.token ?? ''}`, 'Content-Type': 'application/json' }),
  async org(c: Ctx): Promise<string | null> {
    const r = await httpJson(`${CALENDLY}/users/me`, { headers: this.hdrs(c) });
    if (!r.ok) return null;
    return String((r.body as { resource?: { current_organization?: string } })?.resource?.current_organization ?? '') || null;
  },
  async test(c: Ctx): Promise<TestResult> {
    const r = await httpJson(`${CALENDLY}/users/me`, { headers: this.hdrs(c) });
    if (r.status === 401) return { ok: false, error: 'auth_failed' };
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'Calendly token verified' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const org = await this.org(c);
    if (!org) return { ok: false, error: 'no_organization' };
    const r = await httpJson(`${CALENDLY}/scheduled_events?organization=${encodeURIComponent(org)}&count=20`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const events = ((r.body as { collection?: Array<Record<string, unknown>> })?.collection) ?? [];
    const ql = query.toLowerCase();
    const f = ql ? events.filter((e) => String(e.name ?? '').toLowerCase().includes(ql)) : events;
    return { ok: true, items: f.slice(0, 10).map((e) => { const uri = String(e.uri ?? ''); return { ref: uri.split('/').pop() ?? uri, type: 'record', title: clip(e.name, 160), snippet: clip(`${e.status ?? ''} · ${e.start_time ?? ''}`, 400), url: null, raw: { uri } }; }) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const r = await httpJson(`${CALENDLY}/scheduled_events/${encodeURIComponent(ref)}`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const e = ((r.body as { resource?: Record<string, unknown> })?.resource) ?? {};
    return { ok: true, items: [{ ref, type: 'record', title: clip(e.name, 160), snippet: clip(`${e.status ?? ''} · ${e.start_time ?? ''}`, 400), url: null, raw: e }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
};

// ── okta ── secret: { token } · base = org URL. product_system (users).
const okta = {
  hdrs: (c: Ctx) => ({ Authorization: `SSWS ${c.secret.token ?? ''}`, Accept: 'application/json' }),
  async test(c: Ctx): Promise<TestResult> {
    const r = await httpJson(`${c.baseUrl.replace(/\/+$/, '')}/api/v1/users?limit=1`, { headers: this.hdrs(c) });
    if (r.status === 401) return { ok: false, error: 'auth_failed' };
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'Okta token verified' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const r = await httpJson(`${c.baseUrl.replace(/\/+$/, '')}/api/v1/users?limit=15${query.trim() ? `&q=${encodeURIComponent(query)}` : ''}`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const users = Array.isArray(r.body) ? (r.body as Array<Record<string, unknown>>) : [];
    return { ok: true, items: users.slice(0, 10).map((u) => { const p = (u.profile ?? {}) as Record<string, unknown>; return { ref: String(u.id), type: 'record', title: clip(`${p.firstName ?? ''} ${p.lastName ?? ''}`.trim() || p.email, 160), snippet: clip(`${p.email ?? ''} · ${u.status ?? ''}`, 400), url: null, raw: { id: u.id } }; }) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const r = await httpJson(`${c.baseUrl.replace(/\/+$/, '')}/api/v1/users/${encodeURIComponent(ref)}`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const u = r.body as Record<string, unknown>;
    const p = (u.profile ?? {}) as Record<string, unknown>;
    return { ok: true, items: [{ ref, type: 'record', title: clip(`${p.firstName ?? ''} ${p.lastName ?? ''}`.trim() || p.email, 160), snippet: clip(String(p.email ?? ''), 400), url: null, raw: u }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
};

// ── contentful ── secret: { space_id, access_token } · derived base. knowledge_base.
const contentful = {
  base: (c: Ctx) => `https://cdn.contentful.com/spaces/${c.secret.space_id ?? ''}`,
  hdrs: (c: Ctx) => ({ Authorization: `Bearer ${c.secret.access_token ?? ''}` }),
  entryTitle: (fields: Record<string, unknown>) => String(fields.title ?? fields.name ?? fields.heading ?? Object.values(fields)[0] ?? 'Entry'),
  async test(c: Ctx): Promise<TestResult> {
    const r = await httpJson(`${this.base(c)}/entries?limit=1`, { headers: this.hdrs(c) });
    if (r.status === 401) return { ok: false, error: 'auth_failed' };
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, detail: 'Contentful token verified' };
  },
  async search(c: Ctx, query: string): Promise<AdapterResult> {
    const r = await httpJson(`${this.base(c)}/entries?limit=15${query.trim() ? `&query=${encodeURIComponent(query)}` : ''}`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const items = ((r.body as { items?: Array<{ sys?: { id?: string }; fields?: Record<string, unknown> }> })?.items) ?? [];
    return { ok: true, items: items.slice(0, 10).map((e) => ({ ref: String(e.sys?.id), type: 'article', title: clip(this.entryTitle(e.fields ?? {}), 160), snippet: '', url: null, raw: { id: e.sys?.id } })) };
  },
  async fetchRecord(c: Ctx, _type: string, ref: string): Promise<AdapterResult> {
    const r = await httpJson(`${this.base(c)}/entries/${encodeURIComponent(ref)}`, { headers: this.hdrs(c) });
    if (!r.ok) return { ok: false, error: r.error };
    const e = r.body as { fields?: Record<string, unknown> };
    return { ok: true, items: [{ ref, type: 'article', title: clip(this.entryTitle(e.fields ?? {}), 160), snippet: '', url: null, raw: e }] };
  },
  listRecent(c: Ctx): Promise<AdapterResult> { return this.search(c, ''); },
};

const sfSoqlItems = (
  records: Array<Record<string, unknown>>, instance: string | undefined,
  sobject: string, type: string,
  titleOf: (r: Record<string, unknown>) => string,
  snippetOf: (r: Record<string, unknown>) => string,
): HubItem[] => records.map((r) => ({
  ref: String(r.Id), type,
  title: clip(titleOf(r), 160), snippet: clip(snippetOf(r), 400),
  url: instance ? `${instance}/lightning/r/${sobject}/${r.Id}/view` : null, raw: r,
}));

const soqlSafe = (q: string) => q.replace(/['\\%_]/g, ' ').trim().slice(0, 80);

const PROVIDER_OP_TRANSLATORS: Record<string, Record<string, OpTranslator>> = {
  salesforce: {
    // crm
    search_accounts: async (c, p) => {
      const r = await salesforce.soql(c, `SELECT Id, Name, Industry, Description FROM Account WHERE Name LIKE '%${soqlSafe(p.query ?? '')}%' LIMIT 10`);
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, items: sfSoqlItems(r.records, r.instance, 'Account', 'account', (x) => String(x.Name ?? ''), (x) => `${x.Industry ?? ''} ${x.Description ?? ''}`) };
    },
    get_account: (c, p) => salesforce.fetchRecord(c, 'account', p.external_ref ?? ''),
    search_conversations: async (c, p) => {
      const s = soqlSafe(p.query ?? '');
      const r = await salesforce.soql(c, `SELECT Id, CaseNumber, Subject, Description, Status FROM Case WHERE Subject LIKE '%${s}%' OR Description LIKE '%${s}%' ORDER BY LastModifiedDate DESC LIMIT 10`);
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, items: sfSoqlItems(r.records, r.instance, 'Case', 'conversation', (x) => `Case ${x.CaseNumber}: ${x.Subject ?? ''}`, (x) => String(x.Description ?? '')) };
    },
    search_opportunities: async (c, p) => {
      const r = await salesforce.soql(c, `SELECT Id, Name, StageName, Amount, CloseDate FROM Opportunity WHERE Name LIKE '%${soqlSafe(p.query ?? '')}%' ORDER BY LastModifiedDate DESC LIMIT 10`);
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, items: sfSoqlItems(r.records, r.instance, 'Opportunity', 'opportunity', (x) => String(x.Name ?? ''), (x) => `Stage: ${x.StageName ?? '?'} · Amount: ${x.Amount ?? '?'} · Close: ${x.CloseDate ?? '?'}`) };
    },
    // knowledge_base (Knowledge__kav — absent in many orgs; honest error then)
    search_articles: async (c, p) => {
      const r = await salesforce.soql(c, `SELECT Id, Title, Summary, UrlName FROM Knowledge__kav WHERE PublishStatus='Online' AND Title LIKE '%${soqlSafe(p.query ?? '')}%' LIMIT 10`);
      if (!r.ok) return { ok: false, error: r.error ?? 'knowledge_not_available_in_org' };
      return { ok: true, items: sfSoqlItems(r.records, undefined, 'Knowledge__kav', 'article', (x) => String(x.Title ?? ''), (x) => String(x.Summary ?? '')) };
    },
    get_article: async (c, p) => {
      const r = await salesforce.soql(c, `SELECT Id, Title, Summary FROM Knowledge__kav WHERE Id='${soqlSafe(p.external_ref ?? '')}' LIMIT 1`);
      if (!r.ok) return { ok: false, error: r.error ?? 'knowledge_not_available_in_org' };
      return { ok: true, items: sfSoqlItems(r.records, undefined, 'Knowledge__kav', 'article', (x) => String(x.Title ?? ''), (x) => String(x.Summary ?? '')) };
    },
    // helpdesk (Service Cloud) — Cases surfaced as tickets, so a Salesforce
    // connector set to the "helpdesk" category acts as a support desk.
    search_tickets: async (c, p) => {
      const s = soqlSafe(p.query ?? '');
      const r = await salesforce.soql(c, `SELECT Id, CaseNumber, Subject, Description, Status FROM Case WHERE Subject LIKE '%${s}%' OR Description LIKE '%${s}%' ORDER BY LastModifiedDate DESC LIMIT 10`);
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, items: sfSoqlItems(r.records, r.instance, 'Case', 'ticket', (x) => `Case ${x.CaseNumber}: ${x.Subject ?? ''}`, (x) => String(x.Description ?? '')) };
    },
    get_ticket: (c, p) => salesforce.fetchRecord(c, 'case', p.external_ref ?? ''),
  },
  zendesk: {
    search_tickets: (c, p) => zendesk.search(c, p.query ?? ''),
    get_ticket: (c, p) => zendesk.fetchRecord(c, 'ticket', p.external_ref ?? ''),
    search_articles: async (c, p) => {
      const r = await httpJson(`${c.baseUrl}/api/v2/help_center/articles/search.json?query=${encodeURIComponent(p.query ?? '')}&per_page=10`,
        { headers: { Authorization: zendesk.auth(c) } });
      if (!r.ok) return { ok: false, error: r.error };
      const arts = (r.body as { results?: Array<Record<string, unknown>> })?.results ?? [];
      return { ok: true, items: arts.map((a) => ({ ref: String(a.id), type: 'article', title: clip(a.title, 160), snippet: clip(stripHtml(String(a.body ?? '')), 400), url: a.html_url ? String(a.html_url) : null, raw: a })) };
    },
  },
  jira: {
    search_tickets: (c, p) => jira.search(c, p.query ?? ''),
    get_ticket: (c, p) => jira.fetchRecord(c, 'issue', p.external_ref ?? ''),
  },
  hubspot: {
    // crm — companies as accounts, deals as opportunities, tickets as conversations
    search_accounts: async (c, p) => {
      const r = await hubspot.searchObject(c, 'companies', p.query ?? '', ['name', 'domain', 'industry']);
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, items: r.results.map((x) => { const q = (x.properties ?? {}) as Record<string, unknown>; return { ref: String(x.id), type: 'account', title: clip(q.name || q.domain || `Company ${x.id}`, 160), snippet: clip(`${q.industry ?? ''} ${q.domain ?? ''}`, 400), url: null, raw: x }; }) };
    },
    get_account: (c, p) => hubspot.fetchRecord(c, 'account', p.external_ref ?? ''),
    search_conversations: async (c, p) => {
      const r = await hubspot.searchObject(c, 'tickets', p.query ?? '', ['subject', 'content', 'hs_pipeline_stage']);
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, items: r.results.map((x) => { const q = (x.properties ?? {}) as Record<string, unknown>; return { ref: String(x.id), type: 'conversation', title: clip(q.subject || `Ticket ${x.id}`, 160), snippet: clip(stripHtml(String(q.content ?? '')), 400), url: `https://app.hubspot.com/contacts/tickets/${x.id}`, raw: x }; }) };
    },
    search_opportunities: async (c, p) => {
      const r = await hubspot.searchObject(c, 'deals', p.query ?? '', ['dealname', 'dealstage', 'amount']);
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, items: r.results.map((x) => { const q = (x.properties ?? {}) as Record<string, unknown>; return { ref: String(x.id), type: 'opportunity', title: clip(q.dealname || `Deal ${x.id}`, 160), snippet: clip(`Stage: ${q.dealstage ?? '?'} · Amount: ${q.amount ?? '?'}`, 400), url: null, raw: x }; }) };
    },
    // helpdesk — Service Hub tickets
    search_tickets: async (c, p) => {
      const r = await hubspot.searchObject(c, 'tickets', p.query ?? '', ['subject', 'content', 'hs_pipeline_stage']);
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, items: r.results.map((x) => { const q = (x.properties ?? {}) as Record<string, unknown>; return { ref: String(x.id), type: 'ticket', title: clip(q.subject || `Ticket ${x.id}`, 160), snippet: clip(stripHtml(String(q.content ?? '')), 400), url: `https://app.hubspot.com/contacts/tickets/${x.id}`, raw: x }; }) };
    },
    get_ticket: (c, p) => hubspot.fetchRecord(c, 'ticket', p.external_ref ?? ''),
  },
  slack: {
    // knowledge_base — past Slack messages/answers as searchable knowledge
    search_articles: (c, p) => slack.search(c, p.query ?? ''),
    get_article: (c, p) => slack.fetchRecord(c, 'message', p.external_ref ?? ''),
  },
  notion: {
    search_articles: (c, p) => notion.search(c, p.query ?? ''),
    get_article: (c, p) => notion.fetchRecord(c, 'page', p.external_ref ?? ''),
  },
  teams: {
    search_articles: (c, p) => teams.search(c, p.query ?? ''),
    get_article: (c, p) => teams.fetchRecord(c, 'message', p.external_ref ?? ''),
  },
  box: {
    search_articles: (c, p) => box.search(c, p.query ?? ''),
    get_article: (c, p) => box.fetchRecord(c, 'document', p.external_ref ?? ''),
  },
  freshdesk: {
    search_tickets: (c, p) => freshdesk.search(c, p.query ?? ''),
    get_ticket: (c, p) => freshdesk.fetchRecord(c, 'ticket', p.external_ref ?? ''),
  },
  freshservice: {
    search_tickets: (c, p) => freshservice.search(c, p.query ?? ''),
    get_ticket: (c, p) => freshservice.fetchRecord(c, 'ticket', p.external_ref ?? ''),
  },
  servicenow: {
    search_tickets: (c, p) => servicenow.search(c, p.query ?? ''),
    get_ticket: (c, p) => servicenow.fetchRecord(c, 'incident', p.external_ref ?? ''),
    search_articles: async (c, p) => {
      const q = encodeURIComponent((p.query ?? '').replace(/[\^=]/g, ' '));
      const r = await servicenow.table(c, 'kb_knowledge', `sysparm_query=short_descriptionLIKE${q}^ORtextLIKE${q}&sysparm_limit=10&sysparm_fields=sys_id,short_description,text`);
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, items: r.result.map((k) => ({ ref: String(k.sys_id), type: 'article', title: clip(k.short_description, 160), snippet: clip(stripHtml(String(k.text ?? '')), 400), url: `${c.baseUrl}/kb_view.do?sysparm_article=${k.sys_id}`, raw: { sys_id: k.sys_id } })) };
    },
  },
  dynamics: {
    search_accounts: (c, p) => dynamics.search(c, p.query ?? '').then((r) => ({ ...r, items: (r.items ?? []).filter((i) => i.type === 'account') })),
    get_account: (c, p) => dynamics.fetchRecord(c, 'account', p.external_ref ?? ''),
    search_conversations: (c, p) => dynamics.search(c, p.query ?? '').then((r) => ({ ...r, items: (r.items ?? []).filter((i) => i.type === 'conversation') })),
    search_opportunities: (c, p) => dynamics.search(c, p.query ?? '').then((r) => ({ ...r, items: (r.items ?? []).filter((i) => i.type === 'opportunity') })),
  },
  github: {
    search_records: (c, p) => github.search(c, p.query ?? ''),
    get_record: (c, p) => github.fetchRecord(c, 'record', p.external_ref ?? ''),
  },
  gitlab: {
    search_records: (c, p) => gitlab.search(c, p.query ?? ''),
    get_record: (c, p) => gitlab.fetchRecord(c, 'record', p.external_ref ?? ''),
  },
  guru: {
    search_articles: (c, p) => guru.search(c, p.query ?? ''),
    get_article: (c, p) => guru.fetchRecord(c, 'article', p.external_ref ?? ''),
  },
  document360: {
    search_articles: (c, p) => d360.search(c, p.query ?? ''),
    get_article: (c, p) => d360.fetchRecord(c, 'article', p.external_ref ?? ''),
  },
  asana: {
    search_records: (c, p) => asana.search(c, p.query ?? ''),
    get_record: (c, p) => asana.fetchRecord(c, 'record', p.external_ref ?? ''),
  },
  clickup: {
    search_records: (c, p) => clickup.search(c, p.query ?? ''),
    get_record: (c, p) => clickup.fetchRecord(c, 'record', p.external_ref ?? ''),
  },
  monday: {
    search_records: (c, p) => monday.search(c, p.query ?? ''),
    get_record: (c, p) => monday.fetchRecord(c, 'record', p.external_ref ?? ''),
  },
  linear: {
    search_records: (c, p) => linear.search(c, p.query ?? ''),
    get_record: (c, p) => linear.fetchRecord(c, 'record', p.external_ref ?? ''),
  },
  stripe: {
    search_invoices: (c, p) => stripe.search(c, p.query ?? ''),
    get_subscription: (c, p) => stripe.subscription(c, p.external_ref ?? ''),
  },
  shopify: {
    search_orders: (c, p) => shopify.search(c, p.query ?? ''),
    get_order: (c, p) => shopify.fetchRecord(c, 'order', p.external_ref ?? ''),
  },
  woocommerce: {
    search_orders: (c, p) => woocommerce.search(c, p.query ?? ''),
    get_order: (c, p) => woocommerce.fetchRecord(c, 'order', p.external_ref ?? ''),
  },
  bigcommerce: {
    search_orders: (c, p) => bigcommerce.search(c, p.query ?? ''),
    get_order: (c, p) => bigcommerce.fetchRecord(c, 'order', p.external_ref ?? ''),
  },
  square: {
    search_orders: (c, p) => square.search(c, p.query ?? ''),
    get_order: (c, p) => square.fetchRecord(c, 'order', p.external_ref ?? ''),
  },
  bamboohr: {
    get_employee: (c, p) => bamboohr.fetchRecord(c, 'employee', p.external_ref ?? ''),
    search_time_off: (c, p) => bamboohr.timeOff(c, p.query ?? ''),
  },
  greenhouse: {
    search_records: (c, p) => greenhouse.search(c, p.query ?? ''),
    get_record: (c, p) => greenhouse.fetchRecord(c, 'record', p.external_ref ?? ''),
  },
  lever: {
    search_records: (c, p) => lever.search(c, p.query ?? ''),
    get_record: (c, p) => lever.fetchRecord(c, 'record', p.external_ref ?? ''),
  },
  buildium: {
    search_records: (c, p) => buildium.search(c, p.query ?? ''),
    get_record: (c, p) => buildium.fetchRecord(c, 'record', p.external_ref ?? ''),
  },
  canvas: {
    search_records: (c, p) => canvas.search(c, p.query ?? ''),
    get_record: (c, p) => canvas.fetchRecord(c, 'record', p.external_ref ?? ''),
  },
  quickbooks: {
    search_invoices: (c, p) => quickbooks.search(c, p.query ?? ''),
    get_invoice: (c, p) => quickbooks.fetchRecord(c, 'invoice', p.external_ref ?? ''),
  },
  xero: {
    search_invoices: (c, p) => xero.search(c, p.query ?? ''),
    get_invoice: (c, p) => xero.fetchRecord(c, 'invoice', p.external_ref ?? ''),
  },
  clio: {
    search_records: (c, p) => clio.search(c, p.query ?? ''),
    get_record: (c, p) => clio.fetchRecord(c, 'record', p.external_ref ?? ''),
  },
  gusto: {
    get_employee: (c, p) => gusto.fetchRecord(c, 'employee', p.external_ref ?? ''),
    search_time_off: (c, p) => gusto.timeOff(c, p.query ?? ''),
  },
  procore: {
    search_records: (c, p) => procore.search(c, p.query ?? ''),
    get_record: (c, p) => procore.fetchRecord(c, 'record', p.external_ref ?? ''),
  },
  jobber: {
    search_records: (c, p) => jobber.search(c, p.query ?? ''),
    get_record: (c, p) => jobber.fetchRecord(c, 'record', p.external_ref ?? ''),
  },
  gorgias: {
    search_tickets: (c, p) => gorgias.search(c, p.query ?? ''),
    get_ticket: (c, p) => gorgias.fetchRecord(c, 'ticket', p.external_ref ?? ''),
  },
  front: {
    search_tickets: (c, p) => front.search(c, p.query ?? ''),
    get_ticket: (c, p) => front.fetchRecord(c, 'ticket', p.external_ref ?? ''),
  },
  coda: {
    search_articles: (c, p) => coda.search(c, p.query ?? ''),
    get_article: (c, p) => coda.fetchRecord(c, 'article', p.external_ref ?? ''),
  },
  pagerduty: {
    search_records: (c, p) => pagerduty.search(c, p.query ?? ''),
    get_record: (c, p) => pagerduty.fetchRecord(c, 'record', p.external_ref ?? ''),
  },
  sentry: {
    search_records: (c, p) => sentry.search(c, p.query ?? ''),
    get_record: (c, p) => sentry.fetchRecord(c, 'record', p.external_ref ?? ''),
  },
  pipedrive: {
    search_accounts: async (c, p) => { const orgs = await pipedrive.searchType(c, 'organizations', p.query ?? ''); return { ok: true, items: orgs.slice(0, 10).map((o) => ({ ref: String(o.id), type: 'account', title: clip(o.name, 160), snippet: '', url: null, raw: { id: o.id } })) }; },
    get_account: (c, p) => pipedrive.fetchRecord(c, 'account', p.external_ref ?? ''),
    search_conversations: async (c, p) => { const ps = await pipedrive.searchType(c, 'persons', p.query ?? ''); return { ok: true, items: ps.slice(0, 10).map((x) => ({ ref: String(x.id), type: 'conversation', title: clip(x.name, 160), snippet: '', url: null, raw: { id: x.id } })) }; },
    search_opportunities: async (c, p) => { const ds = await pipedrive.searchType(c, 'deals', p.query ?? ''); return { ok: true, items: ds.slice(0, 10).map((d) => ({ ref: String(d.id), type: 'opportunity', title: clip(d.title, 160), snippet: clip(`value ${d.value ?? ''}`, 400), url: null, raw: { id: d.id } })) }; },
  },
  smartsheet: {
    search_records: (c, p) => smartsheet.search(c, p.query ?? ''),
    get_record: (c, p) => smartsheet.fetchRecord(c, 'record', p.external_ref ?? ''),
  },
  wrike: {
    search_records: (c, p) => wrike.search(c, p.query ?? ''),
    get_record: (c, p) => wrike.fetchRecord(c, 'record', p.external_ref ?? ''),
  },
  trello: {
    search_records: (c, p) => trello.search(c, p.query ?? ''),
    get_record: (c, p) => trello.fetchRecord(c, 'record', p.external_ref ?? ''),
  },
  datadog: {
    search_records: (c, p) => datadog.search(c, p.query ?? ''),
    get_record: (c, p) => datadog.fetchRecord(c, 'record', p.external_ref ?? ''),
  },
  close: {
    search_accounts: (c, p) => close.search(c, p.query ?? ''),
    get_account: (c, p) => close.fetchRecord(c, 'account', p.external_ref ?? ''),
  },
  kustomer: {
    search_tickets: (c, p) => kustomer.search(c, p.query ?? ''),
    get_ticket: (c, p) => kustomer.fetchRecord(c, 'ticket', p.external_ref ?? ''),
  },
  mailchimp: {
    search_records: (c, p) => mailchimp.search(c, p.query ?? ''),
    get_record: (c, p) => mailchimp.fetchRecord(c, 'record', p.external_ref ?? ''),
  },
  gitbook: {
    search_articles: (c, p) => gitbook.search(c, p.query ?? ''),
    get_article: (c, p) => gitbook.fetchRecord(c, 'article', p.external_ref ?? ''),
  },
  netsuite: {
    search_invoices: (c, p) => netsuite.search(c, p.query ?? ''),
    get_invoice: (c, p) => netsuite.fetchRecord(c, 'invoice', p.external_ref ?? ''),
  },
  powerschool: {
    search_records: (c, p) => powerschool.search(c, p.query ?? ''),
    get_record: (c, p) => powerschool.fetchRecord(c, 'record', p.external_ref ?? ''),
  },
  ellucian: {
    search_records: (c, p) => ellucian.search(c, p.query ?? ''),
    get_record: (c, p) => ellucian.fetchRecord(c, 'record', p.external_ref ?? ''),
  },
  toast: {
    search_orders: (c, p) => toast.search(c, p.query ?? ''),
    get_order: (c, p) => toast.fetchRecord(c, 'order', p.external_ref ?? ''),
  },
  athenahealth: {
    search_records: (c, p) => athenahealth.search(c, p.query ?? ''),
    get_record: (c, p) => athenahealth.fetchRecord(c, 'record', p.external_ref ?? ''),
  },
  epic: {
    search_records: (c, p) => epic.search(c, p.query ?? ''),
    get_record: (c, p) => epic.fetchRecord(c, 'record', p.external_ref ?? ''),
  },
  cerner: {
    search_records: (c, p) => cerner.search(c, p.query ?? ''),
    get_record: (c, p) => cerner.fetchRecord(c, 'record', p.external_ref ?? ''),
  },
  dropbox: {
    search_articles: (c, p) => dropbox.search(c, p.query ?? ''),
    get_article: (c, p) => dropbox.fetchRecord(c, 'article', p.external_ref ?? ''),
  },
  twilio: {
    search_records: (c, p) => twilio.search(c, p.query ?? ''),
    get_record: (c, p) => twilio.fetchRecord(c, 'record', p.external_ref ?? ''),
  },
  typeform: {
    search_records: (c, p) => typeform.search(c, p.query ?? ''),
    get_record: (c, p) => typeform.fetchRecord(c, 'record', p.external_ref ?? ''),
  },
  calendly: {
    search_records: (c, p) => calendly.search(c, p.query ?? ''),
    get_record: (c, p) => calendly.fetchRecord(c, 'record', p.external_ref ?? ''),
  },
  okta: {
    search_records: (c, p) => okta.search(c, p.query ?? ''),
    get_record: (c, p) => okta.fetchRecord(c, 'record', p.external_ref ?? ''),
  },
  contentful: {
    search_articles: (c, p) => contentful.search(c, p.query ?? ''),
    get_article: (c, p) => contentful.fetchRecord(c, 'article', p.external_ref ?? ''),
  },
  intercom: {
    search_tickets: async (c, p) => {
      // conversations only — articles come via search_articles
      const conv = await httpJson(`${c.baseUrl}/conversations/search`, {
        method: 'POST', headers: intercom.hdrs(c),
        body: JSON.stringify({ query: { field: 'source.body', operator: '~', value: p.query ?? '' }, pagination: { per_page: 10 } }),
      });
      if (!conv.ok) return { ok: false, error: conv.error };
      const convs = ((conv.body as { conversations?: Array<Record<string, unknown>> })?.conversations) ?? [];
      return {
        ok: true,
        items: convs.map((cv) => {
          const src = (cv.source ?? {}) as Record<string, unknown>;
          return { ref: String(cv.id), type: 'ticket', title: clip(src.subject || `Conversation ${cv.id}`, 160), snippet: clip(stripHtml(String(src.body ?? '')), 400), url: null, raw: cv };
        }),
      };
    },
    get_ticket: (c, p) => intercom.fetchRecord(c, 'conversation', p.external_ref ?? ''),
    search_articles: async (c, p) => {
      const a = await httpJson(`${c.baseUrl}/articles/search?phrase=${encodeURIComponent(p.query ?? '')}`, { headers: intercom.hdrs(c) });
      if (!a.ok) return { ok: false, error: a.error };
      const arts = ((a.body as { data?: { articles?: Array<Record<string, unknown>> } })?.data?.articles) ?? [];
      return { ok: true, items: arts.slice(0, 10).map((art) => ({ ref: String(art.id), type: 'article', title: clip(art.title, 160), snippet: clip(stripHtml(String(art.body ?? '')), 400), url: art.url ? String(art.url) : null, raw: art })) };
    },
    get_article: (c, p) => intercom.fetchRecord(c, 'article', p.external_ref ?? ''),
  },
  confluence: {
    search_articles: (c, p) => confluence.search(c, p.query ?? ''),
    get_article: (c, p) => confluence.fetchRecord(c, 'page', p.external_ref ?? ''),
  },
};

/**
 * generic_rest category-op resolution:
 *   1. explicit binding config.endpoints.category_ops[op] — a customer
 *      binds any category op to their own API path
 *   2. fallback: search-kind ops → the generic search endpoint,
 *      get-kind ops → the generic record endpoint
 */
function genericRestOp(c: Ctx, opDef: { op: string; kind: 'search' | 'get' }, p: OpParams): Promise<AdapterResult> | null {
  const eps = genericRest.endpoints(c) as Record<string, Record<string, string>> & { category_ops?: Record<string, Record<string, string>> };
  const bound = (eps.category_ops ?? {})[opDef.op];
  if (bound) {
    if (opDef.kind === 'get') {
      if (!bound.path_template) return null;
      return genericRest.recordEp(c, bound, p.external_ref ?? '');
    }
    if (!bound.path) return null;
    return genericRest.searchEp(c, bound, p.query ?? '');
  }
  if (opDef.kind === 'get' && eps.record?.path_template) return genericRest.recordEp(c, eps.record, p.external_ref ?? '');
  if (opDef.kind === 'search' && eps.search?.path) return genericRest.searchEp(c, eps.search, p.query ?? '');
  return null;
}

/** Normalize HubItems → canonical shape, applying the connector's field_map
 *  ({canonical_field: source_field}) against the raw payload. */
function toCanonical(
  items: HubItem[], objectName: string,
  connector: { display_name: string; provider: string; base_url: string; field_map?: Record<string, string> | null },
): CanonicalItem[] {
  const fmap = (connector.field_map ?? {}) as Record<string, string>;
  const mapped = (raw: Record<string, unknown> | null, canonical: string, fallback: string) => {
    const src = fmap[canonical];
    if (src && raw && raw[src] !== undefined && raw[src] !== null) return String(raw[src]);
    return fallback;
  };
  return items.map((i) => {
    const raw = (i.raw && typeof i.raw === 'object') ? i.raw as Record<string, unknown> : null;
    const externalRef = mapped(raw, 'external_ref', i.ref);
    const urlMapped = fmap.url && raw && raw[fmap.url] ? String(raw[fmap.url]) : i.url;
    return {
      id: externalRef,
      external_ref: externalRef,
      url: urlMapped,
      title: clip(mapped(raw, 'title', i.title), 160),
      snippet: clip(mapped(raw, 'snippet', i.snippet), 400),
      object: objectName,
      source_system: connector.display_name || connector.provider,
      source_provider: connector.provider,
      raw_fields: i.raw, // pass-through, returned live, NEVER persisted
    };
  });
}

async function embedText(text: string): Promise<number[] | null> {
  try {
    // deno-lint-ignore no-explicit-any
    const SupabaseAI = (globalThis as any).Supabase?.ai;
    if (!SupabaseAI) return null;
    const session = new SupabaseAI.Session('gte-small');
    const out = await session.run(text.slice(0, 4000), { mean_pool: true, normalize: true });
    const vec = Array.from(out as Iterable<number>);
    return vec.length === 384 ? vec : null;
  } catch { return null; }
}

// Same chunking policy as ingest-chunks (1500/200).
function chunkText(text: string): string[] {
  const clean = (text || '').trim();
  if (!clean) return [];
  if (clean.length <= 1500) return [clean];
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + 1500, clean.length);
    if (end < clean.length) {
      const window = clean.slice(start, end);
      const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('. '), window.lastIndexOf(' '));
      if (cut > 600) end = start + cut;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start = Math.max(end - 200, start + 1);
  }
  return chunks;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const payload = await req.json().catch(() => ({}));
    const action: string = payload.action ?? '';
    const connectorId: string = payload.connector_id ?? '';
    if (!action) return json({ error: 'action_required' }, 400);
    // template_dry_run runs BEFORE a connector exists (the builder's "Test now").
    if (!connectorId && action !== 'template_dry_run') return json({ error: 'connector_id_required' }, 400);

    const admin: SupabaseClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // ── Auth: caller JWT → tenant, or service role / dispatch secret + tenant_id
    //    (dispatch secret = same dual pattern as de-answer / ingest-chunks —
    //    lets the dispatch cron and headless flows drive registered actions
    //    without a browser session; the asserted tenant is used verbatim). ──
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const dispatchSecret = Deno.env.get('PLAYBOOK_DISPATCH_SECRET') ?? '';
    const headerSecret = req.headers.get('x-dispatch-secret') ?? '';
    const isServiceRole = jwt === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const isDispatchCron = dispatchSecret !== '' && headerSecret === dispatchSecret;
    let tenantId: string | null = null;
    if (isServiceRole || isDispatchCron) {
      tenantId = payload.tenant_id ?? null;
      if (!tenantId) return json({ error: 'tenant_id required for service calls' }, 400);
    } else {
      const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
      if (userErr || !userData?.user) return json({ error: 'unauthorized' }, 401);
      const { data: profile } = await admin
        .from('profiles').select('tenant_id, layer').eq('user_id', userData.user.id).single();
      tenantId = await resolveTenantWithRemoteAccess(admin, userData.user.id, profile?.tenant_id, profile?.layer, payload.tenant_id);
      if (!tenantId) return json({ error: 'no_tenant' }, 403);
    }

    // ── Feature gate: connector_hub can be turned off per tenant from
    // the Platform Console (feature_registry / tenant_feature_overrides,
    // migration 050/068). is_feature_enabled_internal has no caller-auth
    // check of its own (safe here since it's called with the service-
    // role client, and tenantId above is already resolved/authorized).
    const { data: connectorHubOn } = await admin.rpc('is_feature_enabled_internal', {
      p_tenant_id: tenantId,
      p_feature_key: 'connector_hub',
    });
    if (connectorHubOn === false) {
      return json({ error: 'feature_disabled', detail: 'Connector Hub is not enabled for this workspace.' }, 403);
    }

    // ════════ template_dry_run — the builder's "Test now" ════════
    // Runs a template definition live against creds ENTERED IN THE
    // BUILDER, before anything is saved. The secrets travel in-flight
    // only (TLS), are used for this one call, and are NEVER stored.
    // Returns the raw response side-by-side with the extracted items
    // so a non-developer can adjust paths until it works.
    if (action === 'template_dry_run') {
      const def = payload.definition as AdapterDefinition | undefined;
      const category = String(payload.category ?? 'other') as SystemCategory;
      const op = String(payload.op ?? '').trim();
      if (!def || !op) return json({ error: 'definition_and_op_required' }, 400);
      const v = validateAdapterDefinition(def, category);
      if (!v.ok) return json({ ok: false, error: 'invalid_template_definition', errors: v.errors }, 200);
      if (!legalOps(category).includes(op)) {
        return json({ ok: false, error: 'op_not_legal_for_category', detail: `"${op}" is not a ${category} operation. Legal ops: ${legalOps(category).join(', ')}.`, legal_ops: legalOps(category) }, 200);
      }
      const t: TemplateExec = {
        def,
        vars: (payload.variables ?? {}) as Record<string, string>,
        secret: (payload.secrets ?? {}) as Record<string, string>,  // in-flight only, never stored
      };
      const started = Date.now();
      const r = await runTemplateOp(t, op, {
        query: typeof payload.params?.query === 'string' ? payload.params.query : undefined,
        ref: typeof payload.params?.external_ref === 'string' ? payload.params.external_ref : undefined,
      });
      await admin.rpc('append_audit_event', {
        p_tenant_id: tenantId,
        p_actor: 'Template builder (dry run)', p_actor_type: 'human',
        p_action: r.ok
          ? `Template dry run — ${category}.${op} answered with ${r.items?.length ?? 0} item(s) in ${Date.now() - started}ms; nothing stored`
          : `Template dry run — ${category}.${op} failed: ${r.error} (structured error returned to the builder)`,
        p_category: 'connector_action',
        p_detail: { mode: 'template_dry_run', category, op, ok: r.ok, error: r.error ?? null, item_count: r.items?.length ?? 0, persisted: false },
      });
      return json({
        ok: r.ok, op, category,
        items: r.items ?? [], error: r.error ?? null, detail: r.detail ?? null,
        url_called: r.url ?? null,
        // clipped raw response for the side-by-side debug view — never persisted
        raw_response: (() => {
          try {
            const s = JSON.stringify(r.raw_response ?? null);
            return s.length <= 8000 ? (r.raw_response ?? null) : s.slice(0, 8000) + '… (clipped)';
          } catch { return scalarOrJson(r.raw_response, 8000); }
        })(),
        latency_ms: Date.now() - started, persisted: false,
      });
    }

    const { data: connector } = await admin.from('connectors')
      .select('*').eq('id', connectorId).eq('tenant_id', tenantId).single();
    if (!connector) return json({ error: 'connector_not_found' }, 404);

    // ════════ DATA ACCESS GRANTS (migration 029) — default-deny ════════
    // Callers acting AS a machine subject (a DE or a specialist) pass
    // subject_kind + subject_id; every data action then requires a grant
    // resolved server-side (connector-specific beats category; no grant =
    // DENY). Direct human wizard calls (test / health_check / dry-run)
    // carry no subject and are unaffected — humans are governed by app
    // RLS + roles, not this table.
    const subjectKind: string | null =
      payload.subject_kind === 'de' || payload.subject_kind === 'specialist' ? payload.subject_kind : null;
    const subjectId: string | null =
      subjectKind && typeof payload.subject_id === 'string' && payload.subject_id ? payload.subject_id : null;

    /** Returns null when allowed (or no subject); a structured denial Response otherwise. */
    const enforceAccess = async (needed: 'search' | 'read' | 'ingest' | 'write_back', opLabel: string): Promise<Response | null> => {
      if (!subjectKind || !subjectId) return null;
      const { data: verdict, error: raErr } = await admin.rpc('resolve_access', {
        p_tenant_id: tenantId, p_subject_kind: subjectKind, p_subject_id: subjectId,
        p_connector_id: connectorId, p_needed: needed,
      });
      if (raErr) return json({ ok: false, error: 'access_check_failed', detail: raErr.message }, 500);
      const v = verdict as { allowed: boolean; reason: string; has: string | null; via: string | null };
      if (v.allowed) return null;
      await admin.rpc('append_audit_event', {
        p_tenant_id: tenantId,
        p_actor: `${subjectKind === 'de' ? 'DE' : 'Specialist'} ${subjectId.slice(0, 8)}`,
        p_actor_type: 'de',
        p_action: `Data access DENIED — ${subjectKind} attempted ${opLabel} on ${connector.display_name || connector.provider} (needs ${needed}, has ${v.has ?? 'no grant'}). Default-deny: no data left the system.`,
        p_category: 'access_control',
        p_detail: {
          kind: 'data_access_denied', subject_kind: subjectKind, subject_id: subjectId,
          connector_id: connectorId, connector_label: connector.display_name || connector.provider,
          op: opLabel, needed, has: v.has, reason: v.reason,
        },
      });
      return json({
        ok: false, error: 'access_denied',
        denial: { subject_kind: subjectKind, subject_id: subjectId, connector_id: connectorId, needed, has: v.has, reason: v.reason },
        detail: `Access denied by this workspace's data access rules: this ${subjectKind === 'de' ? 'digital employee' : 'specialist'} needs "${needed}" permission on ${connector.display_name || connector.provider} and has ${v.has ? `only "${v.has}"` : 'no grant'}. An admin can change this under Governance → Data Access.`,
      }, 200);
    };

    // ── Credentials (service-role-only view over Vault-encrypted
    // storage, migration 088). generic_rest and template (auth recipe
    // "none") may run open. ──
    const { data: secretRow } = await admin.from('connector_secrets_decrypted')
      .select('secret').eq('connector_id', connectorId).maybeSingle();
    let secret: Record<string, string> = {};
    if (secretRow?.secret) {
      try { secret = JSON.parse(secretRow.secret); } catch { return json({ error: 'invalid_credentials_format' }, 400); }
    } else if (connector.provider !== 'generic_rest' && connector.provider !== 'template' && connector.provider !== 'dreamteam') {
      return json({ error: 'no_credentials' }, 400);
    }

    const ctx: Ctx = {
      baseUrl: String(connector.base_url ?? '').replace(/\/+$/, ''),
      secret,
      config: (connector.config ?? {}) as Record<string, unknown>,
      connectorId,
      admin,
      tenantId,
    };

    // ── template provider: resolve the declarative adapter (DATA → adapter) ──
    let templateExec: TemplateExec | null = null;
    let templateName: string | null = null;
    if (connector.provider === 'template') {
      const resolved = await resolveTemplate(admin, connector.template_id ?? null, tenantId);
      if (!resolved.ok) return json({ ok: false, error: resolved.error, detail: resolved.detail }, 200);
      templateExec = {
        def: resolved.template.definition,
        vars: ((connector.config as Record<string, unknown> | null)?.template_vars ?? {}) as Record<string, string>,
        secret,
      };
      templateName = resolved.template.name;
    }

    // deno-lint-ignore no-explicit-any
    const adapters: Record<string, any> = {
      zendesk, salesforce, confluence, jira, intercom, generic_rest: genericRest, sharepoint, gdrive, hubspot, slack, notion, teams, box, freshdesk, freshservice,
      servicenow, dynamics, github, gitlab, guru, document360: d360, asana, clickup, monday, linear,
      stripe, shopify, woocommerce, bigcommerce, square, bamboohr, greenhouse, lever, buildium, canvas,
      quickbooks, xero, clio, gusto, procore, jobber,
      gorgias, front, coda, pagerduty, sentry,
      pipedrive, smartsheet, wrike, trello, datadog,
      close, kustomer, mailchimp, gitbook,
      netsuite, powerschool, ellucian, toast, athenahealth, epic, cerner,
      dropbox, twilio, typeform, calendly, okta, contentful,
    };
    // deno-lint-ignore no-explicit-any
    const adapter: any = templateExec ? templateAdapter(templateExec) : adapters[connector.provider];
    // The 'dreamteam' self-connector has no read adapter — it is write-only,
    // serving the platform-builder actions via NATIVE_ACTIONS at execute time.
    // execute_action never dereferences `adapter`, so it may run without one.
    if (!adapter && connector.provider !== 'dreamteam') return json({ error: 'unsupported_provider' }, 400);

    const audit = (category: string, actionText: string, detail: Record<string, unknown>) =>
      admin.rpc('append_audit_event', {
        p_tenant_id: tenantId,
        p_actor: `${connector.provider} connector (${connector.display_name || connector.base_url})`,
        p_actor_type: 'system',
        p_action: actionText,
        p_category: category,
        p_detail: { connector_id: connectorId, provider: connector.provider, ...detail },
      });

    const setStatus = (status: string, lastError: string | null) =>
      admin.from('connectors').update({ status, last_error: lastError }).eq('id', connectorId);

    // ── Call-driven health: every adapter-backed call updates it.
    // Success resets consecutive_failures; failure increments and
    // stores the honest error. No cron — health is call-driven
    // (scheduled checks arrive with the first paying tenant).
    let failures = Number(connector.consecutive_failures ?? 0);
    const recordHealth = async (ok: boolean, error?: string | null) => {
      const now = new Date().toISOString();
      if (ok) {
        failures = 0;
        await admin.from('connectors').update({ last_ok_at: now, consecutive_failures: 0 }).eq('id', connectorId);
      } else {
        failures += 1;
        await admin.from('connectors').update({
          last_error_at: now, last_error: (error ?? 'unknown_error').slice(0, 300),
          consecutive_failures: failures,
        }).eq('id', connectorId);
      }
      return computeHealth({ last_ok_at: ok ? now : connector.last_ok_at, last_error_at: ok ? connector.last_error_at : now, consecutive_failures: failures });
    };

    // ════════ test ════════
    if (action === 'test') {
      const r: TestResult = await adapter.test(ctx);
      await setStatus(r.ok ? 'connected' : 'error', r.ok ? null : (r.error ?? 'test_failed'));
      const health = await recordHealth(r.ok, r.error);
      if (r.ok) await audit('config_change', `Connector test succeeded — ${connector.provider} at ${ctx.baseUrl}${r.detail ? ` (${r.detail})` : ''}`, { result: 'connected' });
      return json({ ok: r.ok, error: r.error ?? null, detail: r.detail ?? null, health });
    }

    // ════════ health_check — run test() and update call-driven health ════════
    if (action === 'health_check') {
      const started = Date.now();
      const r: TestResult = await adapter.test(ctx);
      const health = await recordHealth(r.ok, r.error);
      await audit('connector_action',
        `Health check on ${connector.provider} — ${r.ok ? 'healthy' : `failed: ${r.error}`} (${Date.now() - started}ms) → ${health}`,
        { hub_action: 'health_check', ok: r.ok, error: r.error ?? null, health, latency_ms: Date.now() - started });
      return json({ ok: r.ok, health, error: r.error ?? null, detail: r.detail ?? null, checked_at: new Date().toISOString() });
    }

    // ════════ category_op — the CATEGORY CONTRACT entry point ════════
    // The app speaks category language (helpdesk.search_tickets); this
    // validates the op against the connector's category, translates to
    // the provider adapter, and returns canonical-shaped results.
    if (action === 'category_op') {
      const op = String(payload.op ?? '').trim();
      if (!op) return json({ error: 'op_required' }, 400);
      const category = String(connector.category ?? 'other') as SystemCategory;
      const opDef = getCategoryOp(category, op);
      if (!opDef) {
        return json({
          ok: false, error: 'op_not_legal_for_category',
          detail: `"${op}" is not a ${category} operation. Legal ops for ${category}: ${legalOps(category).join(', ')}.`,
          category, legal_ops: legalOps(category),
        }, 200);
      }
      const p: OpParams = {
        query: typeof payload.params?.query === 'string' ? payload.params.query : undefined,
        external_ref: typeof payload.params?.external_ref === 'string' ? payload.params.external_ref : undefined,
      };
      if (opDef.kind === 'search' && !p.query?.trim()) return json({ error: 'params.query_required' }, 400);
      if (opDef.kind === 'get' && !p.external_ref?.trim()) return json({ error: 'params.external_ref_required' }, 400);

      // Access grants: search-kind ops need "search"; get-kind ops open
      // a record and need "read".
      const denied = await enforceAccess(opDef.kind === 'get' ? 'read' : 'search', `${category}.${op}`);
      if (denied) return denied;

      const started = Date.now();
      let r: AdapterResult | null = null;
      if (templateExec) {
        // Declarative adapter: the op binding IS the translation.
        const tr = await runTemplateOp(templateExec, op, { query: p.query, ref: p.external_ref });
        if (!tr.ok && tr.error === 'op_not_bound') {
          const ms0 = Date.now() - started;
          await audit('connector_action',
            `Category op ${category}.${op} on template "${templateName}" — op not bound in the template (documented honestly)`,
            { mode: 'read_through', hub_action: 'category_op', category, op, ok: false, error: 'op_not_supported', template: templateName, latency_ms: ms0, persisted: false });
          return json({ ok: false, error: 'op_not_supported', detail: tr.detail, category, op, template: templateName }, 200);
        }
        r = { ok: tr.ok, items: tr.items, error: tr.error, detail: tr.detail };
      } else if (connector.provider === 'generic_rest') {
        r = await (genericRestOp(ctx, opDef, p) ?? Promise.resolve(null));
        if (r === null) {
          return json({
            ok: false, error: 'op_not_supported',
            detail: `This API has no endpoint bound for "${op}". Bind one under config.endpoints.category_ops.${op} (or configure the generic search/record endpoints).`,
            category, op,
          }, 200);
        }
      } else {
        const translator = PROVIDER_OP_TRANSLATORS[connector.provider]?.[op];
        if (!translator) {
          return json({
            ok: false, error: 'op_not_supported',
            detail: `${connector.provider} has no adapter for "${op}" — documented honestly, no pretending.`,
            category, op,
          }, 200);
        }
        r = await translator(ctx, p);
      }
      const ms = Date.now() - started;
      const health = await recordHealth(r.ok, r.error);
      if (r.ok) {
        r.items = readThroughFilterItems(connector.provider, r.items, ((ctx.config as { ingest?: IngestFilters })?.ingest ?? {}) as IngestFilters);
      }
      const items = r.ok ? toCanonical(r.items ?? [], opDef.object, connector) : [];
      await audit('connector_action',
        r.ok
          ? `Category op ${category}.${op} on ${connector.provider} — ${items.length} ${opDef.object}(s) fetched live in ${ms}ms, not persisted`
          : `Category op ${category}.${op} on ${connector.provider} FAILED — ${r.error} (recorded honestly)`,
        { mode: 'read_through', hub_action: 'category_op', category, op, ok: r.ok, error: r.error ?? null, item_count: items.length, latency_ms: ms, health, persisted: false, ...(templateName ? { template: templateName } : {}) });
      return json({ ok: r.ok, category, op, object: opDef.object, items, error: r.error ?? null, detail: r.detail ?? null, latency_ms: ms, health, persisted: false, ...(templateName ? { template: templateName } : {}) });
    }

    // ════════ search / fetch_record / list_recent — READ-THROUGH ════════
    if (action === 'search' || action === 'fetch_record' || action === 'list_recent') {
      // Access grants: search/list_recent → "search"; fetch_record opens
      // a full record → "read".
      const denied = await enforceAccess(action === 'fetch_record' ? 'read' : 'search', action);
      if (denied) return denied;
      const started = Date.now();
      let r: AdapterResult;
      if (action === 'search') {
        const query = String(payload.query ?? '').trim();
        if (!query) return json({ error: 'query_required' }, 400);
        r = await adapter.search(ctx, query);
      } else if (action === 'fetch_record') {
        const ref = String(payload.external_ref ?? '').trim();
        if (!ref) return json({ error: 'external_ref_required' }, 400);
        r = await adapter.fetchRecord(ctx, String(payload.record_type ?? ''), ref);
      } else {
        r = await adapter.listRecent(ctx);
      }
      if (r.ok) {
        r.items = readThroughFilterItems(connector.provider, r.items, ((ctx.config as { ingest?: IngestFilters })?.ingest ?? {}) as IngestFilters);
      }
      const ms = Date.now() - started;
      const health = await recordHealth(r.ok, r.error);
      // Read-through contract: NOTHING persisted but the audit event.
      await audit('connector_sync',
        r.ok
          ? `Read-through ${action} on ${connector.provider} — ${r.items?.length ?? 0} item(s) fetched live in ${ms}ms, not persisted`
          : `Read-through ${action} on ${connector.provider} FAILED — ${r.error} (recorded honestly)`,
        { mode: 'read_through', hub_action: action, ok: r.ok, error: r.error ?? null, item_count: r.items?.length ?? 0, latency_ms: ms, persisted: false });
      return json({ ok: r.ok, items: r.items ?? [], error: r.error ?? null, latency_ms: ms, health, persisted: false });
    }

    // ════════ sync — knowledge ingest (REFUSED for fetch_only) ════════
    // ════════ discover — list source documents into the review queue ════════
    // Applies the connector's ingest filters, then upserts candidates.
    // Prior approve/reject decisions are PRESERVED (only new files are added
    // as 'pending'); nothing is ingested here.
    if (action === 'discover') {
      if (!KNOWLEDGE_CAPABLE.has(connector.provider) || typeof (adapter as { discoverDocs?: unknown }).discoverDocs !== 'function') {
        return json({ ok: false, error: 'discover_not_supported_for_provider', detail: `${connector.provider} does not support document discovery — use it directly.` }, 400);
      }
      const filters = ((ctx.config as { ingest?: IngestFilters })?.ingest ?? {}) as IngestFilters;
      const d = await adapter.discoverDocs(ctx, filters);
      if (!d.ok) {
        await recordHealth(false, d.error ?? 'discover_failed');
        return json({ ok: false, error: d.error ?? 'discover_failed' }, 200);
      }
      await recordHealth(true);
      const cands: Candidate[] = (d.candidates ?? []).slice(0, MAX_SYNC_FILES);
      const { data: existingRows } = await admin.from('connector_ingest_candidates')
        .select('external_ref').eq('connector_id', connectorId);
      const seen = new Set((existingRows ?? []).map((r: { external_ref: string }) => r.external_ref));
      const fresh = cands.filter((c2) => !seen.has(c2.external_ref));
      if (fresh.length) {
        await admin.from('connector_ingest_candidates').insert(fresh.map((c2) => ({
          tenant_id: tenantId, connector_id: connectorId, external_ref: c2.external_ref,
          title: c2.title, path: c2.path, file_type: c2.file_type, size_bytes: c2.size_bytes,
        })));
      }
      const { data: allRows } = await admin.from('connector_ingest_candidates')
        .select('status').eq('connector_id', connectorId);
      const counts: Record<string, number> = { pending: 0, approved: 0, rejected: 0, ingested: 0 };
      for (const r of allRows ?? []) counts[(r as { status: string }).status] = (counts[(r as { status: string }).status] ?? 0) + 1;
      await audit('connector_sync', `Document scan on ${connector.provider} — ${cands.length} matched filters, ${fresh.length} new for review`, { found: cands.length, new: fresh.length, ...counts });
      return json({ ok: true, found: cands.length, new: fresh.length, ...counts });
    }

    if (action === 'sync') {
      // Access grants: syncing stores content in DreamTeam → "ingest".
      const denied = await enforceAccess('ingest', 'sync');
      if (denied) return denied;
      if (connector.access_mode === 'fetch_only') {
        // THE DOCTRINE, enforced server-side: the customer chose
        // "look, never store" — sync is refused no matter who asks.
        await audit('connector_sync',
          `Sync attempt REFUSED — ${connector.provider} connector is fetch-only by the customer's choice; nothing was stored`,
          { refused: true, reason: 'access_mode_fetch_only' });
        return json({ ok: false, error: 'sync_refused_fetch_only', detail: 'This connector is fetch-only: DreamTeam reads it live to answer, and never stores its content.' }, 403);
      }
      if (!KNOWLEDGE_CAPABLE.has(connector.provider) || typeof adapter.syncDocs !== 'function') {
        return json({ ok: false, error: 'sync_not_supported_for_provider', detail: `${connector.provider} has no knowledge ingest path; use read-through search instead.` }, 400);
      }

      // Ingest one document (upsert knowledge_docs + re-chunk + embed).
      const ingestDoc = async (doc: SyncDoc): Promise<{ ok: boolean; chunks: number; embedded: number; error?: string }> => {
        if (!doc.content) return { ok: false, chunks: 0, embedded: 0, error: 'empty' };
        const newHash = await contentHash(`${doc.title}\n\n${doc.content}`);
        const { data: docRow, error: upErr } = await admin.from('knowledge_docs').upsert({
          tenant_id: tenantId, title: doc.title, content: doc.content,
          source: 'connector', external_ref: doc.external_ref, tags: [`connector:${connector.provider}`],
        }, { onConflict: 'tenant_id,source,external_ref' }).select('id, content_hash').single();
        if (upErr || !docRow) return { ok: false, chunks: 0, embedded: 0, error: upErr?.message ?? 'upsert_failed' };
        // WS8 STEP 1 (mig 286) — THE STORM-KILLER: skip re-chunk + re-embed when
        // the NORMALIZED content is unchanged (content_hash still matches AND the
        // doc already has chunks). Was: every sync deleted + re-embedded every
        // chunk of every doc, so a nightly connector re-embedded the whole corpus.
        // (content_hash on the upserted row is the PRIOR value — it's not in the
        // SET clause, so RETURNING gives the old hash to compare against.)
        if (docRow.content_hash === newHash) {
          const { count } = await admin.from('knowledge_doc_chunks').select('id', { count: 'exact', head: true }).eq('doc_id', docRow.id);
          if ((count ?? 0) > 0) return { ok: true, chunks: count ?? 0, embedded: 0 };
        }
        const chunks = chunkText(`${doc.title}\n\n${doc.content}`);
        await admin.from('knowledge_doc_chunks').delete().eq('doc_id', docRow.id);
        let chErr: string | undefined;
        if (chunks.length > 0) {
          // WS8 STEP 7 (inline→drain): store chunks WITHOUT embedding here and let
          // embed-backfill-drain embed them (bounded 4/call). Inline synchronous
          // embedding of every chunk of every doc is what made a lifted file cap
          // OOM the worker; deferring it makes a large sync cheap + resumable.
          // The doc is keyword-searchable immediately; semantic lands as the
          // drain catches up (and the mig-286 skip means only CHANGED docs enqueue).
          const rows = chunks.map((content, i) => ({ tenant_id: tenantId, account_id: null, doc_id: docRow.id, chunk_index: i, content, embedding: null }));
          const ins = await admin.from('knowledge_doc_chunks').insert(rows);
          if (ins.error) chErr = ins.error.message;
        }
        // Stamp the hash so the NEXT sync of unchanged content skips (above).
        if (!chErr) await admin.from('knowledge_docs').update({ content_hash: newHash }).eq('id', docRow.id);
        return { ok: true, chunks: chErr ? 0 : chunks.length, embedded: 0, error: chErr };
      };

      const filters = ((ctx.config as { ingest?: IngestFilters })?.ingest ?? {}) as IngestFilters;
      const reviewMode = filters.require_review === true && typeof (adapter as { fetchTexts?: unknown }).fetchTexts === 'function';

      let docs: SyncDoc[] = [];
      if (reviewMode) {
        // Review on: ingest ONLY the files an admin has approved.
        const { data: approved } = await admin.from('connector_ingest_candidates')
          .select('external_ref,file_type,title').eq('connector_id', connectorId).eq('status', 'approved');
        // Cap review-mode fetches at the per-sync limit too (was uncapped —
        // fetched ALL approved files' text into memory before the ingest slice).
        const items: Candidate[] = (approved ?? []).slice(0, MAX_SYNC_FILES).map((a: { external_ref: string; file_type: string; title: string }) =>
          ({ external_ref: a.external_ref, title: a.title, path: '', file_type: a.file_type, size_bytes: null }));
        if (!items.length) {
          return json({ ok: true, upserted: 0, chunked: 0, embedded: 0, detail: 'No approved documents to ingest yet — scan, then approve the files you want in the review queue.' });
        }
        const texts = await adapter.fetchTexts(ctx, items);
        docs = items.map((it) => ({ external_ref: it.external_ref, title: it.title, content: texts[it.external_ref] ?? '', url: null }));
        await recordHealth(true);
      } else {
        // Review off: walk the source with filters applied, ingest matches.
        const r: SyncResult = await adapter.syncDocs(ctx, filters);
        if (!r.ok) {
          await setStatus('error', r.error ?? 'sync_failed');
          await recordHealth(false, r.error ?? 'sync_failed');
          return json({ ok: false, error: r.error ?? 'sync_failed' }, 200);
        }
        await recordHealth(true);
        docs = r.docs ?? [];
      }

      const truncated = docs.length > MAX_SYNC_FILES;   // corpus bigger than one sync run — surfaced, never silently dropped
      let upserted = 0, chunked = 0, embedded = 0;
      const errors: string[] = [];
      const ingestedRefs: string[] = [];
      for (const doc of docs.slice(0, MAX_SYNC_FILES)) {   // WS8 cap-lift (embedding is deferred to the drain, so this no longer OOMs)
        const res = await ingestDoc(doc);
        if (!res.ok) { if (res.error && res.error !== 'empty') errors.push(`${doc.external_ref}: ${res.error}`); continue; }
        upserted++; chunked += res.chunks; embedded += res.embedded;
        if (res.error) errors.push(`chunks ${doc.external_ref}: ${res.error}`);
        ingestedRefs.push(doc.external_ref);
      }
      if (reviewMode && ingestedRefs.length) {
        await admin.from('connector_ingest_candidates')
          .update({ status: 'ingested', ingested_at: new Date().toISOString() })
          .eq('connector_id', connectorId).in('external_ref', ingestedRefs);
      }
      const now = new Date().toISOString();
      await admin.from('connectors').update({ status: 'connected', last_sync_at: now, last_error: errors[0] ?? null }).eq('id', connectorId);
      await audit('connector_sync',
        `Knowledge sync from ${connector.provider}${reviewMode ? ' (approved only)' : ''} — ${upserted} doc(s) ingested into knowledge (source=connector), ${chunked} chunks, ${embedded} embedded`,
        { upserted, chunked, embedded, review_mode: reviewMode, errors: errors.slice(0, 5) });
      return json({ ok: true, upserted, chunked, embedded, errors,
        walked: docs.length, truncated,
        detail: truncated
          ? `Ingested ${MAX_SYNC_FILES} of ${docs.length} documents this run; the remaining ${docs.length - MAX_SYNC_FILES} exceed the per-sync limit and aren't ingested yet. Embeddings finish in the background.`
          : (embedded === 0 && chunked > 0 ? 'Chunks stored — embeddings are indexing in the background.' : undefined) });
    }

    // ════════ preview_action — THE GENERALIZED ACTION LAYER, preview ════════
    // Resolves the action_definition, validates params, RENDERS the exact
    // request (method/URL/body) WITHOUT calling the external system.
    // Returns a plain-language receipt PREVIEW. No side effects beyond a
    // lightweight action_executions row (mode='preview') for traceability.
    if (action === 'preview_action') {
      const actionKey = String(payload.action_key ?? '').trim();
      if (!actionKey) return json({ error: 'action_key_required' }, 400);
      const category = String(connector.category ?? 'other');

      const resolved = await resolveActionDefinition(admin, tenantId, category, actionKey, String(connector.provider ?? ""));
      if (!resolved.ok) return json({ ok: false, error: resolved.error, detail: resolved.detail }, 200);
      const def = resolved.def;
      if (def.provider === 'internal') {
        return json({ ok: false, error: 'internal_action', detail: `"${def.label}" is an internal platform action executed by the playbook engine, not through a connector.` }, 200);
      }

      const params = (payload.params ?? {}) as Record<string, unknown>;
      const validated = validateActionParams(def, params);
      if (!validated.ok) return json({ ok: false, error: validated.error, detail: validated.detail }, 200);

      const rendered = await renderRegisteredAction(admin, def, ctx, validated.values);
      if (!rendered.ok) {
        return json({ ok: false, error: rendered.error, detail: rendered.detail, action_key: actionKey, label: def.label }, 200);
      }

      const summary = plainLanguagePreview(def, validated.values);
      await admin.rpc('record_action_execution', {
        p_tenant_id: tenantId, p_action_definition_id: def.id, p_connector_id: connectorId,
        p_subject_kind: subjectKind, p_subject_id: subjectId,
        p_mode: 'preview', p_params: validated.values, p_decision: 'previewed',
        p_destructive: def.risk.destructive, p_idempotent: def.risk.idempotent, p_dedupe_key: null,
        p_request_summary: summary, p_receipt: null, p_result: null,
        p_task_title: null, p_task_detail: null,
      });
      await audit('connector_action',
        `Action PREVIEWED — ${def.label} on ${connector.display_name || connector.provider} — ${summary} (nothing sent)`,
        { kind: 'action_preview', action_definition_id: def.id, action_key: actionKey, category, method: rendered.method, url: rendered.url, persisted: false });

      return json({
        ok: true, action_key: actionKey, label: def.label,
        preview: { method: rendered.method, url: rendered.url, body: rendered.body ?? null },
        receipt_preview: summary,
        risk: def.risk, persisted: false,
      });
    }

    // ════════ execute_action — THE GENERALIZED ACTION LAYER, execute ════════
    // 1. data_access_grants write_back check (resolve_access — same as Scribe).
    // 2. decide_action_execution: destructive-always-gates (checked FIRST,
    //    unconditionally) -> guardrail-always-wins -> trust-narrows-within-it.
    // 3. auto-execute or (when payload.approved_task_id is supplied, meaning
    //    a human already approved the gated task) actually call the
    //    external system and record a plain-language RECEIPT.
    if (action === 'execute_action') {
      const actionKey = String(payload.action_key ?? '').trim();
      if (!actionKey) return json({ error: 'action_key_required' }, 400);
      const category = String(connector.category ?? 'other');

      const resolved = await resolveActionDefinition(admin, tenantId, category, actionKey, String(connector.provider ?? ""));
      if (!resolved.ok) return json({ ok: false, error: resolved.error, detail: resolved.detail }, 200);
      const def = resolved.def;
      if (def.provider === 'internal') {
        return json({ ok: false, error: 'internal_action', detail: `"${def.label}" is an internal platform action executed by the playbook engine, not through a connector.` }, 200);
      }

      const params = (payload.params ?? {}) as Record<string, unknown>;
      const validated = validateActionParams(def, params);
      if (!validated.ok) return json({ ok: false, error: validated.error, detail: validated.detail }, 200);

      // ── 1. Data access grants: write_back is necessary, never sufficient. ──
      if (subjectKind && subjectId) {
        const { data: verdict } = await admin.rpc('resolve_access', {
          p_tenant_id: tenantId, p_subject_kind: subjectKind, p_subject_id: subjectId,
          p_connector_id: connectorId, p_needed: 'write_back',
        });
        const v = verdict as { allowed: boolean; has: string | null; reason: string };
        if (!v.allowed) {
          await admin.rpc('append_audit_event', {
            p_tenant_id: tenantId, p_actor: `${subjectKind === 'de' ? 'DE' : 'Specialist'} ${subjectId.slice(0, 8)}`, p_actor_type: 'de',
            p_action: `Action REFUSED by data access rules — ${def.label} on ${connector.display_name || connector.provider} (needs write_back, has ${v.has ?? 'no grant'})`,
            p_category: 'access_control',
            p_detail: { kind: 'data_access_denied', action_key: actionKey, connector_id: connectorId, needed: 'write_back', has: v.has, reason: v.reason },
          });
          return json({
            ok: false, error: 'access_denied',
            detail: `This ${subjectKind === 'de' ? 'digital employee' : 'specialist'} does not have write-back permission on that system${v.has ? ` (it has only "${v.has}")` : ''}. An admin can grant it under Governance → Data Access.`,
          }, 200);
        }
      }

      // The plain-language summary needs only the definition + validated
      // values — computed BEFORE any rendering/gating so it is available
      // for the human_task detail even when the action is gated (a
      // destructive action must be gated WITHOUT ever attempting to
      // render or call the external system first).
      const summary = plainLanguagePreview(def, validated.values);
      const dedupeKey = def.risk.idempotent ? null : `${def.id}:${JSON.stringify(validated.values)}`;

      // Already-approved re-entry: a human_task tied to a prior
      // human_gated_* execution row was just approved; the caller
      // (resolveActionExecution) passes the row id to execute directly,
      // skipping decide_action_execution (it already ran once).
      const approvedExecutionId = typeof payload.approved_execution_id === 'string' ? payload.approved_execution_id : null;

      if (!approvedExecutionId) {
        // ── 2. THE COMPOSITION: destructive-always-gates, THEN guardrail,
        //    THEN trust — decide_action_execution implements all three in
        //    that exact order (see migration 035 for the SQL).
        // p_de_id (migration 125): the trust tier now resolves through
        // the per-employee cascade — a DE subject's own dial override
        // applies to registered actions, not just triage (the Wave 1.1
        // completion this sibling never received).
        // Resolve the transaction amount so the money gates — approval threshold
        // (require_approval_over_cents), per-DE spend caps (spend_cap_daily_cents),
        // and the trust dollar-ceiling — actually fire. Convention: a param named
        // 'amount_cents' (already in cents; the only money param in the registry).
        // Passing null here is what silently disabled all three (audit critical).
        const amtRaw = (validated.values as Record<string, unknown>)['amount_cents'];
        const hasAmountParam = def.param_schema.some((p) => p.name === 'amount_cents');
        let amountCents: number | null = null;
        if (typeof amtRaw === 'number' && Number.isFinite(amtRaw)) amountCents = Math.round(amtRaw);
        else if (typeof amtRaw === 'string' && /^\d+$/.test(amtRaw.trim())) amountCents = parseInt(amtRaw.trim(), 10);

        const { data: decisionRaw } = await admin.rpc('decide_action_execution', {
          p_tenant_id: tenantId, p_action_label: def.label, p_category: category, p_destructive: def.risk.destructive,
          p_de_id: subjectKind === 'de' ? subjectId : null,
          p_amount_cents: amountCents, p_action_type: def.action_key,
        });
        let decision = decisionRaw as { decision: string; guardrail_rule_id: string | null; guardrail_rule: string | null; trust_level: number | null; reasoning: string };

        // Fail closed: a money action whose amount we could NOT read must never
        // auto-execute an unbounded value — route it to a human instead.
        if (hasAmountParam && amountCents === null && decision.decision === 'auto_executed') {
          decision = { ...decision, decision: 'human_gated_trust',
            reasoning: 'The amount for this monetary action could not be determined, so it was routed to a human for approval rather than auto-executed.' };
        }

        if (decision.decision !== 'auto_executed') {
          // Gated — create the human_task, do NOT call the external system.
          const taskTitle = `Approve action — ${def.label} (${connector.display_name || connector.provider})`;
          const taskDetail = `${decision.reasoning} Preview: ${summary}`;
          const { data: rec } = await admin.rpc('record_action_execution', {
            p_tenant_id: tenantId, p_action_definition_id: def.id, p_connector_id: connectorId,
            p_subject_kind: subjectKind, p_subject_id: subjectId,
            p_mode: 'execute', p_params: validated.values, p_decision: decision.decision,
            p_destructive: def.risk.destructive, p_idempotent: def.risk.idempotent, p_dedupe_key: dedupeKey,
            p_request_summary: summary, p_receipt: null, p_result: null,
            p_task_title: taskTitle, p_task_detail: taskDetail,
          });
          await audit('approval',
            `Action GATED — ${def.label} on ${connector.display_name || connector.provider}: ${decision.reasoning}`,
            { kind: 'action_gated', action_definition_id: def.id, action_key: actionKey, category, decision: decision.decision, guardrail_rule_id: decision.guardrail_rule_id, task_id: (rec as { task_id?: string })?.task_id ?? null });
          return json({
            ok: true, gated: true, decision: decision.decision, reasoning: decision.reasoning,
            task_id: (rec as { task_id?: string })?.task_id ?? null,
            execution_id: (rec as { id?: string })?.id ?? null,
            receipt_preview: summary,
          });
        }
      }

      // ── 3. Auto-execute (or human-approved re-entry) — actually call. ──
      const outcome = await runRegisteredAction(admin, def, ctx, validated.values);
      const finalDecision = approvedExecutionId ? 'executed_after_approval' : 'auto_executed';
      const { data: rec2 } = await admin.rpc('record_action_execution', {
        p_tenant_id: tenantId, p_action_definition_id: def.id, p_connector_id: connectorId,
        p_subject_kind: subjectKind, p_subject_id: subjectId,
        p_mode: 'execute', p_params: validated.values,
        p_decision: outcome.ok ? finalDecision : 'failed',
        p_destructive: def.risk.destructive, p_idempotent: def.risk.idempotent, p_dedupe_key: dedupeKey,
        p_request_summary: summary, p_receipt: outcome.receipt ?? null,
        p_result: { ok: outcome.ok, status: outcome.status ?? null, error: outcome.error ?? null },
        p_task_title: null, p_task_detail: null,
      });
      await audit('connector_action',
        outcome.ok
          ? `Action EXECUTED — ${outcome.receipt ?? def.label}`
          : `Action FAILED — ${def.label} on ${connector.display_name || connector.provider}: ${outcome.error} (recorded honestly)`,
        { kind: 'action_execution', action_definition_id: def.id, action_key: actionKey, category, ok: outcome.ok, receipt: outcome.receipt ?? null, error: outcome.error ?? null });

      return json({
        ok: outcome.ok, gated: false, receipt: outcome.receipt ?? null,
        error: outcome.error ?? null, detail: outcome.detail ?? null,
        execution_id: (rec2 as { id?: string })?.id ?? null,
      });
    }

    return json({ error: 'unknown_action' }, 400);
  } catch (err) {
    console.error('connector-hub error:', err);
    return json({ error: String(err) }, 500);
  }
});
