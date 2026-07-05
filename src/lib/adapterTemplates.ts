/**
 * adapterTemplates — the DECLARATIVE ADAPTER FRAMEWORK definition layer.
 * (browser mirror — the edge original lives at
 * supabase/functions/_shared/adapterTemplates.ts — keep the two files in sync.)
 *
 * Doctrine: connecting ANY REST system is CONFIGURATION (data), not code.
 * An adapter template is a jsonb document that declares:
 *   - the auth RECIPE (how credentials are presented — the actual secret
 *     VALUES always live in connector_secrets, never in the template)
 *   - the base URL shape with per-connector variables ({subdomain}, …)
 *   - how each canonical category op maps to an HTTP call
 *   - where the results live in the response (dot paths)
 *
 * The same validate function runs on SAVE and on EXECUTE — a template
 * that saves is a template that can run.
 */

import { SystemCategory, CATEGORY_OPS, legalOps } from './categoryContracts';

export type AdapterAuthType =
  | 'api_key_header' | 'bearer' | 'basic' | 'oauth2_client_credentials' | 'none';

export const AUTH_TYPES: AdapterAuthType[] = [
  'api_key_header', 'bearer', 'basic', 'oauth2_client_credentials', 'none',
];

/** Plain-language auth descriptions + which secret fields each recipe needs. */
export const AUTH_META: Record<AdapterAuthType, { label: string; help: string; secretFields: { key: string; label: string }[] }> = {
  api_key_header: {
    label: 'API key in a header — most common',
    help: 'The system gives you a key; every request carries it in a named header (e.g. X-Api-Key).',
    secretFields: [{ key: 'api_key', label: 'API key' }],
  },
  bearer: {
    label: 'Bearer token',
    help: 'A token sent as "Authorization: Bearer …" — used by HubSpot private apps, Square, and many modern APIs.',
    secretFields: [{ key: 'token', label: 'Access token' }],
  },
  basic: {
    label: 'Username + password (Basic auth)',
    help: 'Many systems use your API key as the username and a fixed word (like "X") as the password — the template help text says which.',
    secretFields: [{ key: 'username', label: 'Username (often the API key)' }, { key: 'password', label: 'Password (often just "X")' }],
  },
  oauth2_client_credentials: {
    label: 'OAuth2 client credentials',
    help: 'The system gives you a Client ID + Secret; DreamTeam exchanges them for a short-lived token automatically on every call.',
    secretFields: [{ key: 'client_id', label: 'Client ID' }, { key: 'client_secret', label: 'Client secret' }],
  },
  none: {
    label: 'No authentication',
    help: 'Open API — no credentials needed (rare outside test systems).',
    secretFields: [],
  },
};

export interface AdapterAuth {
  type: AdapterAuthType;
  /** api_key_header: which header carries the key */
  header_name?: string;
  /** oauth2_client_credentials: where to exchange id+secret for a token (may contain {vars}) */
  token_url?: string;
  /** static headers every call needs (e.g. Accept: application/json) */
  extra_headers?: Record<string, string>;
}

/** A non-secret per-connector variable declared by the template (e.g. subdomain). */
export interface AdapterVar { key: string; label: string; help?: string }

export interface AdapterOpResponse {
  /** dot path to the list of items; '' = the response root */
  items_path: string;
  id_path: string;
  title_path: string;
  url_path?: string;
  snippet_path?: string;
}

export interface AdapterOpBinding {
  method: 'GET' | 'POST';
  /** supports {query}, {ref}, and any declared {var} */
  path_template: string;
  /** query-string params; values support the same placeholders */
  query_params?: Record<string, string>;
  /** JSON body (POST); string values anywhere in it support placeholders */
  body_template?: Record<string, unknown>;
  response: AdapterOpResponse;
  /** the response is one object, not a list */
  single_item?: boolean;
}

/**
 * AdapterActionBinding — the WRITE-side sibling of AdapterOpBinding
 * (migration 035, the Generalized Action Layer). Ops are read-only
 * (GET/POST-for-search); actions carry bodies and mutate the SoR
 * (POST/PUT/PATCH/DELETE). Reuses the EXACT SAME renderTemplate/
 * renderBody/walkPath machinery — only the placeholder vocabulary
 * widens from {query}/{ref} to an arbitrary param map declared by the
 * action_definition's param_schema (e.g. {external_ref}, {status},
 * {note}, or any tenant-defined field name).
 *
 * response is OPTIONAL and, when present, is read-only metadata about
 * how to pull an id/status out of the write response for the receipt —
 * actions do not return a list of canonical items the way ops do.
 */
export interface AdapterActionBinding {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** supports any declared param name (e.g. {external_ref}) and {var} */
  path_template: string;
  query_params?: Record<string, string>;
  /** JSON body; string values anywhere in it support placeholders */
  body_template?: Record<string, unknown>;
  /** optional: where to find a confirming id/status in the response, for the receipt */
  response?: { id_path?: string; status_path?: string };
}

export interface AdapterDefinition {
  auth: AdapterAuth;
  /** e.g. "https://{subdomain}.example.com/api/v2" */
  base_url_template: string;
  variables?: AdapterVar[];
  /** category op → HTTP binding (READ side) */
  ops: Record<string, AdapterOpBinding>;
  /** action_key → HTTP binding (WRITE side, migration 035) */
  actions?: Record<string, AdapterActionBinding>;
  /** which op proves the connection works (+ a default param for it) */
  test_op?: { op: string; params?: Record<string, string> };
}

export interface AdapterTemplate {
  id: string;
  scope: 'platform' | 'tenant';
  tenant_id: string | null;
  name: string;
  description: string;
  category: SystemCategory;
  status: 'draft' | 'published';
  definition: AdapterDefinition;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// ── Validation — same function on save AND on execute ─────────────

const PLACEHOLDER_RE = /\{([a-zA-Z0-9_]+)\}/g;

function placeholdersIn(s: string): string[] {
  return [...s.matchAll(PLACEHOLDER_RE)].map((m) => m[1]);
}

function opPlaceholders(op: AdapterOpBinding): string[] {
  const out = [...placeholdersIn(op.path_template)];
  for (const v of Object.values(op.query_params ?? {})) out.push(...placeholdersIn(v));
  const walk = (node: unknown) => {
    if (typeof node === 'string') out.push(...placeholdersIn(node));
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') Object.values(node).forEach(walk);
  };
  walk(op.body_template ?? {});
  return out;
}

const ACTION_METHODS: AdapterActionBinding['method'][] = ['POST', 'PUT', 'PATCH', 'DELETE'];

function actionPlaceholders(a: AdapterActionBinding): string[] {
  const out = [...placeholdersIn(a.path_template)];
  for (const v of Object.values(a.query_params ?? {})) out.push(...placeholdersIn(v));
  const walk = (node: unknown) => {
    if (typeof node === 'string') out.push(...placeholdersIn(node));
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') Object.values(node).forEach(walk);
  };
  walk(a.body_template ?? {});
  return out;
}

/**
 * Validate one action binding against its declared params (from
 * action_definitions.param_schema — name/type/required/help per
 * param). Unlike ops (whose placeholder vocabulary is the fixed
 * {query}/{ref} pair), an action's legal placeholders are whatever the
 * caller declares as params, plus any template {var}. This is the
 * write-side twin of the `ops` validation loop in
 * validateAdapterDefinition, kept separate so a template author can
 * validate an action binding against a specific action's param list.
 */
export function validateActionBinding(
  name: string, a: AdapterActionBinding, paramNames: string[], declaredVars: Set<string>,
): string[] {
  const errors: string[] = [];
  if (!ACTION_METHODS.includes(a.method)) errors.push(`${name}: method must be one of ${ACTION_METHODS.join(', ')}.`);
  if (!a.path_template?.startsWith('/')) errors.push(`${name}: path_template must start with "/" (it is appended to the base URL).`);
  const legalPlaceholders = new Set([...paramNames, ...declaredVars]);
  for (const ph of actionPlaceholders(a)) {
    if (!legalPlaceholders.has(ph)) errors.push(`${name} uses {${ph}} but that is neither a declared param nor a template variable.`);
  }
  return errors;
}

/** Validate a definition against its category. Returns plain-language errors. */
export function validateAdapterDefinition(
  def: unknown, category: SystemCategory,
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const d = def as AdapterDefinition | null;
  if (!d || typeof d !== 'object') return { ok: false, errors: ['The template definition is missing or not an object.'] };

  // auth
  if (!d.auth || !AUTH_TYPES.includes(d.auth.type)) {
    errors.push(`auth.type must be one of: ${AUTH_TYPES.join(', ')}.`);
  } else {
    if (d.auth.type === 'api_key_header' && !d.auth.header_name?.trim()) {
      errors.push('API-key auth needs auth.header_name — which header carries the key (e.g. X-Api-Key)?');
    }
    if (d.auth.type === 'oauth2_client_credentials' && !d.auth.token_url?.trim()) {
      errors.push('OAuth2 client-credentials auth needs auth.token_url — where to exchange the ID + secret for a token.');
    }
  }

  // base URL
  if (!d.base_url_template?.trim() || !/^https?:\/\//.test(d.base_url_template.trim())) {
    errors.push('base_url_template must be a full URL starting with https:// (variables like {subdomain} are allowed).');
  }

  // declared variables
  const declaredVars = new Set((d.variables ?? []).map((v) => v.key));
  for (const v of d.variables ?? []) {
    if (!v.key?.trim() || !/^[a-zA-Z0-9_]+$/.test(v.key)) errors.push(`Variable key "${v.key}" must be letters/numbers/underscores only.`);
    if (v.key === 'query' || v.key === 'ref') errors.push(`"${v.key}" is a reserved placeholder — pick another variable name.`);
  }
  for (const ph of placeholdersIn(d.base_url_template ?? '')) {
    if (!declaredVars.has(ph)) errors.push(`base_url_template uses {${ph}} but no variable "${ph}" is declared.`);
  }

  // ops
  const legal = legalOps(category);
  const opNames = Object.keys(d.ops ?? {});
  if (opNames.length === 0) errors.push('Bind at least one operation — otherwise the template can do nothing.');
  for (const [name, op] of Object.entries(d.ops ?? {})) {
    if (!legal.includes(name)) {
      errors.push(`"${name}" is not a legal operation for the ${category} category. Legal ops: ${legal.join(', ')}.`);
      continue;
    }
    const kind = (CATEGORY_OPS[category] ?? []).find((o) => o.op === name)?.kind;
    if (op.method !== 'GET' && op.method !== 'POST') errors.push(`${name}: method must be GET or POST.`);
    if (!op.path_template?.startsWith('/')) errors.push(`${name}: path_template must start with "/" (it is appended to the base URL).`);
    if (op.body_template && op.method !== 'POST') errors.push(`${name}: body_template only makes sense with method POST.`);
    const phs = opPlaceholders(op);
    if (kind === 'search' && !phs.includes('query')) errors.push(`${name} is a search operation — its path, query params, or body must use {query} so the search words reach the API.`);
    if (kind === 'get' && !phs.includes('ref')) errors.push(`${name} fetches one record — its path, query params, or body must use {ref} (the record id).`);
    for (const ph of phs) {
      if (ph !== 'query' && ph !== 'ref' && !declaredVars.has(ph)) errors.push(`${name} uses {${ph}} but no variable "${ph}" is declared.`);
    }
    const r = op.response;
    if (!r || typeof r.items_path !== 'string') errors.push(`${name}: response.items_path is required — where in the response do the results live? Use "" if the response root IS the list.`);
    if (!r?.id_path?.trim()) errors.push(`${name}: response.id_path is required — which field is the record's id?`);
    if (!r?.title_path?.trim()) errors.push(`${name}: response.title_path is required — which field is the human-readable title?`);
  }

  // test op
  if (d.test_op) {
    if (!opNames.includes(d.test_op.op)) errors.push(`test_op "${d.test_op.op}" is not one of the bound operations (${opNames.join(', ') || 'none'}).`);
  } else if (opNames.length > 0) {
    errors.push('test_op is required — which operation proves the connection works?');
  }

  return { ok: errors.length === 0, errors };
}

// ── Dot-path walker (robust: arrays, nested; found-keys hints) ────

export interface WalkResult {
  found: boolean;
  value?: unknown;
  /** on failure: the keys that DO exist at the level where the walk died */
  keys_at_failure?: string[];
  failed_segment?: string;
}

export function walkPath(body: unknown, path: string): WalkResult {
  if (path === '' || path == null) return { found: true, value: body };
  let cur: unknown = body;
  for (const seg of path.split('.')) {
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (Number.isInteger(idx) && idx >= 0 && idx < cur.length) { cur = cur[idx]; continue; }
      return { found: false, failed_segment: seg, keys_at_failure: [`(array of ${cur.length} items — use a number index, e.g. 0)`] };
    }
    if (cur && typeof cur === 'object' && seg in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[seg];
      continue;
    }
    const keys = cur && typeof cur === 'object' ? Object.keys(cur as Record<string, unknown>).slice(0, 20) : [];
    return { found: false, failed_segment: seg, keys_at_failure: keys };
  }
  return { found: true, value: cur };
}

/** Render {placeholders} in a string. Returns missing placeholder keys. */
export function renderTemplate(
  tpl: string, values: Record<string, string>, urlEncode = false,
): { out: string; missing: string[] } {
  const missing: string[] = [];
  const out = tpl.replace(PLACEHOLDER_RE, (_, key: string) => {
    const v = values[key];
    if (v === undefined || v === null) { missing.push(key); return ''; }
    return urlEncode ? encodeURIComponent(v) : v;
  });
  return { out, missing };
}

/** Deep-render string values inside a JSON body template. */
export function renderBody(node: unknown, values: Record<string, string>, missing: string[]): unknown {
  if (typeof node === 'string') {
    const r = renderTemplate(node, values);
    missing.push(...r.missing);
    return r.out;
  }
  if (Array.isArray(node)) return node.map((n) => renderBody(n, values, missing));
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, renderBody(v, values, missing)]));
  }
  return node;
}

/**
 * renderAction — pure rendering (NO fetch) of an action binding into
 * a concrete { method, url, body } given the connector's base URL, its
 * template variables, and the caller's params. Used by BOTH
 * preview_action (render only, never call out) and execute_action
 * (render, then actually fetch) so preview and execute can never drift.
 */
export interface RenderedAction {
  ok: boolean;
  method?: string;
  url?: string;
  body?: string;
  missing?: string[];
  error?: string;
}
export function renderAction(
  baseUrlTemplate: string, binding: AdapterActionBinding, vars: Record<string, string>, params: Record<string, string>,
): RenderedAction {
  const values = { ...vars, ...params };
  const missing: string[] = [];
  const base = renderTemplate(baseUrlTemplate, values);
  missing.push(...base.missing);
  const path = renderTemplate(binding.path_template, values, true);
  missing.push(...path.missing);
  const qp = new URLSearchParams();
  for (const [k, v] of Object.entries(binding.query_params ?? {})) {
    const rv = renderTemplate(v, values);
    missing.push(...rv.missing);
    qp.set(k, rv.out);
  }
  let bodyStr: string | undefined;
  if (binding.body_template) {
    bodyStr = JSON.stringify(renderBody(binding.body_template, values, missing));
  }
  const realMissing = [...new Set(missing)];
  if (realMissing.length) {
    return { ok: false, error: 'var_missing', missing: realMissing };
  }
  const qs = qp.toString();
  const url = `${base.out.replace(/\/+$/, '')}${path.out}${qs ? (path.out.includes('?') ? '&' : '?') + qs : ''}`;
  return { ok: true, method: binding.method, url, body: bodyStr };
}
