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
 *   sync          — knowledge-capable providers (confluence, intercom,
 *                   salesforce knowledge, zendesk help center) ingest
 *                   articles/pages into knowledge_docs (source='connector',
 *                   external_ref) + chunk/embed via gte-small — the same
 *                   path ingest-chunks uses. REFUSED server-side when the
 *                   connector's access_mode is 'fetch_only' (the customer
 *                   said "never store"); that refusal is the doctrine.
 *
 * Auth: caller JWT → tenant, or service-role key + body.tenant_id
 * (evidence pipeline path). Credentials come from connector_secrets
 * (service-role-only table; the client can never read them back).
 *
 * HONESTY NOTES: salesforce/confluence/jira/intercom adapters are shaped
 * to the providers' documented REST APIs but remain unverified against
 * live instances until real tenant credentials exist. sharepoint returns
 * a structured not_implemented. generic_rest is fully proven against a
 * real external HTTP API.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

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
    if (field && obj[field] !== undefined) return obj[field];
    for (const f of fallbacks) if (obj[f] !== undefined) return obj[f];
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

const KNOWLEDGE_CAPABLE = new Set(['zendesk', 'salesforce', 'confluence', 'intercom']);

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
    if (!connectorId) return json({ error: 'connector_id_required' }, 400);

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
        .from('profiles').select('tenant_id').eq('user_id', userData.user.id).single();
      tenantId = profile?.tenant_id ?? null;
      if (!tenantId) return json({ error: 'no_tenant' }, 403);
    }

    const { data: connector } = await admin.from('connectors')
      .select('*').eq('id', connectorId).eq('tenant_id', tenantId).single();
    if (!connector) return json({ error: 'connector_not_found' }, 404);

    // sharepoint: registered honestly, adapter not implemented yet.
    if (connector.provider === 'sharepoint') {
      return json({ ok: false, error: 'not_implemented', detail: 'SharePoint is registered but its adapter is not built yet — documented honestly, no pretending.' }, 200);
    }

    const adapters: Record<string, typeof genericRest | typeof zendesk | typeof salesforce | typeof confluence | typeof jira | typeof intercom> = {
      zendesk, salesforce, confluence, jira, intercom, generic_rest: genericRest,
    };
    // deno-lint-ignore no-explicit-any
    const adapter: any = adapters[connector.provider];
    if (!adapter) return json({ error: 'unsupported_provider' }, 400);

    // ── Credentials (service-role-only table). generic_rest may run open. ──
    const { data: secretRow } = await admin.from('connector_secrets')
      .select('secret').eq('connector_id', connectorId).maybeSingle();
    let secret: Record<string, string> = {};
    if (secretRow?.secret) {
      try { secret = JSON.parse(secretRow.secret); } catch { return json({ error: 'invalid_credentials_format' }, 400); }
    } else if (connector.provider !== 'generic_rest') {
      return json({ error: 'no_credentials' }, 400);
    }

    const ctx: Ctx = {
      baseUrl: String(connector.base_url ?? '').replace(/\/+$/, ''),
      secret,
      config: (connector.config ?? {}) as Record<string, unknown>,
    };

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

    // ════════ test ════════
    if (action === 'test') {
      const r: TestResult = await adapter.test(ctx);
      await setStatus(r.ok ? 'connected' : 'error', r.ok ? null : (r.error ?? 'test_failed'));
      if (r.ok) await audit('config_change', `Connector test succeeded — ${connector.provider} at ${ctx.baseUrl}${r.detail ? ` (${r.detail})` : ''}`, { result: 'connected' });
      return json({ ok: r.ok, error: r.error ?? null, detail: r.detail ?? null });
    }

    // ════════ search / fetch_record / list_recent — READ-THROUGH ════════
    if (action === 'search' || action === 'fetch_record' || action === 'list_recent') {
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
      // Read-through contract: NOTHING persisted but the audit event.
      await audit('connector_sync',
        r.ok
          ? `Read-through ${action} on ${connector.provider} — ${r.items?.length ?? 0} item(s) fetched live in ${ms}ms, not persisted`
          : `Read-through ${action} on ${connector.provider} FAILED — ${r.error} (recorded honestly)`,
        { mode: 'read_through', hub_action: action, ok: r.ok, error: r.error ?? null, item_count: r.items?.length ?? 0, latency_ms: ms, persisted: false });
      return json({ ok: r.ok, items: r.items ?? [], error: r.error ?? null, latency_ms: ms, persisted: false });
    }

    // ════════ sync — knowledge ingest (REFUSED for fetch_only) ════════
    if (action === 'sync') {
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
        return json({ ok: false, error: r.error ?? 'sync_failed' }, 200);
      }
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

    return json({ error: 'unknown_action' }, 400);
  } catch (err) {
    console.error('connector-hub error:', err);
    return json({ error: String(err) }, 500);
  }
});
