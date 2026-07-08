/**
 * connector-hub — multi-system SoR connector layer (migration 026).
 *
 * Generalizes the connector-zendesk pattern to six providers behind one
 * adapter interface: zendesk, salesforce, confluence, jira, intercom,
 * generic_rest (+ sharepoint registered honestly as not_implemented).
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
 * HONESTY NOTES: salesforce/confluence/jira/intercom adapters are shaped
 * to the providers' documented REST APIs but remain unverified against
 * live instances until real tenant credentials exist. sharepoint returns
 * a structured not_implemented. generic_rest is fully proven against a
 * real external HTTP API.
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

const KNOWLEDGE_CAPABLE = new Set(['zendesk', 'salesforce', 'confluence', 'intercom']);

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
  admin: SupabaseClient, tenantId: string, connectorCategory: string, actionKey: string,
): Promise<{ ok: true; def: ActionDefRow } | { ok: false; error: string; detail?: string }> {
  // Tenant-scope row wins over platform-scope for the same category+key.
  const { data: rows } = await admin.from('action_definitions')
    .select('*')
    .eq('category', connectorCategory).eq('action_key', actionKey).eq('status', 'active')
    .or(`scope.eq.platform,tenant_id.eq.${tenantId}`);
  const list = (rows ?? []) as ActionDefRow[];
  const tenantRow = list.find((r) => r.scope === 'tenant' && r.tenant_id === tenantId);
  const platformRow = list.find((r) => r.scope === 'platform');
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
  const native = zendeskActions[executionKey];
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
  const native = zendeskActions[executionKey];
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

    // ── Auth: caller JWT → tenant, or service role + tenant_id ──
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    let tenantId: string | null = null;
    if (jwt === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) {
      tenantId = payload.tenant_id ?? null;
      if (!tenantId) return json({ error: 'tenant_id required for service-role calls' }, 400);
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

    // sharepoint: registered honestly, adapter not implemented yet.
    if (connector.provider === 'sharepoint') {
      return json({ ok: false, error: 'not_implemented', detail: 'SharePoint is registered but its adapter is not built yet — documented honestly, no pretending.' }, 200);
    }

    // ── Credentials (service-role-only view over Vault-encrypted
    // storage, migration 088). generic_rest and template (auth recipe
    // "none") may run open. ──
    const { data: secretRow } = await admin.from('connector_secrets_decrypted')
      .select('secret').eq('connector_id', connectorId).maybeSingle();
    let secret: Record<string, string> = {};
    if (secretRow?.secret) {
      try { secret = JSON.parse(secretRow.secret); } catch { return json({ error: 'invalid_credentials_format' }, 400); }
    } else if (connector.provider !== 'generic_rest' && connector.provider !== 'template') {
      return json({ error: 'no_credentials' }, 400);
    }

    const ctx: Ctx = {
      baseUrl: String(connector.base_url ?? '').replace(/\/+$/, ''),
      secret,
      config: (connector.config ?? {}) as Record<string, unknown>,
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

    const adapters: Record<string, typeof genericRest | typeof zendesk | typeof salesforce | typeof confluence | typeof jira | typeof intercom> = {
      zendesk, salesforce, confluence, jira, intercom, generic_rest: genericRest,
    };
    // deno-lint-ignore no-explicit-any
    const adapter: any = templateExec ? templateAdapter(templateExec) : adapters[connector.provider];
    if (!adapter) return json({ error: 'unsupported_provider' }, 400);

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
      const r: SyncResult = await adapter.syncDocs(ctx);
      if (!r.ok) {
        await setStatus('error', r.error ?? 'sync_failed');
        await recordHealth(false, r.error ?? 'sync_failed');
        return json({ ok: false, error: r.error ?? 'sync_failed' }, 200);
      }
      await recordHealth(true);
      let upserted = 0, chunked = 0, embedded = 0;
      const errors: string[] = [];
      for (const doc of (r.docs ?? []).slice(0, 50)) {
        if (!doc.content) continue;
        const { data: docRow, error: upErr } = await admin.from('knowledge_docs')
          .upsert({
            tenant_id: tenantId, title: doc.title, content: doc.content,
            source: 'connector', external_ref: doc.external_ref,
            tags: [`connector:${connector.provider}`],
          }, { onConflict: 'tenant_id,source,external_ref' })
          .select('id').single();
        if (upErr || !docRow) { errors.push(`${doc.external_ref}: ${upErr?.message}`); continue; }
        upserted++;
        // Chunk + embed — same path as ingest-chunks.
        const chunks = chunkText(`${doc.title}\n\n${doc.content}`);
        await admin.from('knowledge_doc_chunks').delete().eq('doc_id', docRow.id);
        if (chunks.length > 0) {
          const rows = [];
          for (let i = 0; i < chunks.length; i++) {
            const emb = await embedText(chunks[i]);
            if (emb) embedded++;
            rows.push({ tenant_id: tenantId, account_id: null, doc_id: docRow.id, chunk_index: i, content: chunks[i], embedding: emb });
          }
          const { error: chErr } = await admin.from('knowledge_doc_chunks').insert(rows);
          if (chErr) errors.push(`chunks ${doc.external_ref}: ${chErr.message}`);
          else chunked += chunks.length;
        }
      }
      const now = new Date().toISOString();
      await admin.from('connectors').update({ status: 'connected', last_sync_at: now, last_error: errors[0] ?? null }).eq('id', connectorId);
      await audit('connector_sync',
        `Knowledge sync from ${connector.provider} — ${upserted} doc(s) ingested into knowledge (source=connector), ${chunked} chunks, ${embedded} embedded`,
        { upserted, chunked, embedded, errors: errors.slice(0, 5) });
      return json({ ok: true, upserted, chunked, embedded, errors });
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

      const resolved = await resolveActionDefinition(admin, tenantId, category, actionKey);
      if (!resolved.ok) return json({ ok: false, error: resolved.error, detail: resolved.detail }, 200);
      const def = resolved.def;

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

      const resolved = await resolveActionDefinition(admin, tenantId, category, actionKey);
      if (!resolved.ok) return json({ ok: false, error: resolved.error, detail: resolved.detail }, 200);
      const def = resolved.def;

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
        const { data: decisionRaw } = await admin.rpc('decide_action_execution', {
          p_tenant_id: tenantId, p_action_label: def.label, p_category: category, p_destructive: def.risk.destructive,
        });
        const decision = decisionRaw as { decision: string; guardrail_rule_id: string | null; guardrail_rule: string | null; trust_level: number | null; reasoning: string };

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
