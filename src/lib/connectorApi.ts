// ============================================================
// Systems-of-Record connector layer v1 (R2) — client API.
// Tables from supabase/migrations/017_connectors.sql; live actions
// via the connector-zendesk edge function.
//
// Doctrine: connectors declare per-object mode — 'sync' (cached
// working copy) or 'read_through' (fetched at action time, never
// persisted). Actions write BACK into the SoR. Credentials live in
// connector_secrets (service-role-only; written via the
// set_connector_secret RPC and never readable from the client).
// ============================================================
import { supabase } from '../supabase';
import { getSessionTenantId, CustomerApiError, isMissingTableError } from './customerApi';

// ── Types ─────────────────────────────────────────────────────────

export type ConnectorProvider =
  | 'zendesk' | 'salesforce' | 'confluence' | 'jira' | 'intercom'
  | 'generic_rest' | 'sharepoint';
export type ConnectorStatus = 'connected' | 'error' | 'disconnected';
export type ConnectorRole = 'product_system' | 'crm' | 'support_desk' | 'knowledge_base' | 'other';
export type ConnectorAccessMode = 'ingest' | 'fetch_only';

export interface Connector {
  id: string;
  tenant_id: string;
  provider: ConnectorProvider;
  display_name: string;
  base_url: string;
  status: ConnectorStatus;
  role: ConnectorRole;
  access_mode: ConnectorAccessMode;
  config: Record<string, unknown>;
  last_sync_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export const CONNECTOR_ROLE_LABELS: Record<ConnectorRole, string> = {
  product_system: 'Product system — where account configuration lives',
  crm: 'CRM — customers, deals, history',
  support_desk: 'Support desk — tickets & past conversations',
  knowledge_base: 'Knowledge base — docs & help articles',
  other: 'Other',
};

export const ACCESS_MODE_EXPLAIN: Record<ConnectorAccessMode, string> = {
  ingest: 'Ingest: DreamTeam keeps a searchable working copy of knowledge content. Your system stays the source of truth.',
  fetch_only: 'Fetch-only: we look at your data to answer, we never store it. Only the citation trail (title, reference, short snippet) is kept.',
};

/** Per-provider setup metadata: credential fields + how to get them. */
export interface ProviderField { key: string; label: string; placeholder: string; secret: boolean }
export interface ProviderMeta {
  label: string;
  tagline: string;
  defaultRole: ConnectorRole;
  baseUrlLabel: string;
  baseUrlPlaceholder: string;
  fields: ProviderField[];        // stored server-side via set_connector_secret; never readable back
  help: string;                    // plain-language "how to get credentials"
  knowledgeSync: boolean;          // provider can ingest articles/pages
  implemented: boolean;
}

export const PROVIDERS: Record<Exclude<ConnectorProvider, 'sharepoint'> | 'sharepoint', ProviderMeta> = {
  zendesk: {
    label: 'Zendesk', tagline: 'Support desk — tickets, past conversations, help center',
    defaultRole: 'support_desk',
    baseUrlLabel: 'Zendesk URL', baseUrlPlaceholder: 'https://acme.zendesk.com',
    fields: [
      { key: 'email', label: 'Admin email', placeholder: 'admin@acme.com', secret: false },
      { key: 'api_token', label: 'API token', placeholder: '••••••••', secret: true },
    ],
    help: 'In Zendesk: Admin Center → Apps and integrations → APIs → Zendesk API → enable Token access → Add API token. Use your admin email plus that token.',
    knowledgeSync: true, implemented: true,
  },
  salesforce: {
    label: 'Salesforce', tagline: 'CRM — accounts, cases, knowledge articles',
    defaultRole: 'crm',
    baseUrlLabel: 'Instance URL', baseUrlPlaceholder: 'https://yourorg.my.salesforce.com',
    fields: [
      { key: 'client_id', label: 'Connected app Consumer Key', placeholder: '3MVG9…', secret: false },
      { key: 'client_secret', label: 'Consumer Secret', placeholder: '••••••••', secret: true },
    ],
    help: 'Free option: sign up for a Salesforce Developer Edition at developer.salesforce.com/signup. Then Setup → App Manager → New Connected App → enable OAuth, add the "Client Credentials Flow", assign a run-as user, and copy the Consumer Key & Secret.',
    knowledgeSync: true, implemented: true,
  },
  confluence: {
    label: 'Confluence', tagline: 'Knowledge base — pages & documentation',
    defaultRole: 'knowledge_base',
    baseUrlLabel: 'Atlassian site URL', baseUrlPlaceholder: 'https://acme.atlassian.net',
    fields: [
      { key: 'email', label: 'Atlassian account email', placeholder: 'you@acme.com', secret: false },
      { key: 'api_token', label: 'API token', placeholder: '••••••••', secret: true },
    ],
    help: 'Create a free API token at id.atlassian.com → Security → Create API token. Use it with the email of the same Atlassian account.',
    knowledgeSync: true, implemented: true,
  },
  jira: {
    label: 'Jira', tagline: 'Issue tracker — bugs, past fixes, project history',
    defaultRole: 'support_desk',
    baseUrlLabel: 'Atlassian site URL', baseUrlPlaceholder: 'https://acme.atlassian.net',
    fields: [
      { key: 'email', label: 'Atlassian account email', placeholder: 'you@acme.com', secret: false },
      { key: 'api_token', label: 'API token', placeholder: '••••••••', secret: true },
    ],
    help: 'Same credentials as Confluence: a free API token from id.atlassian.com → Security → Create API token, plus your account email.',
    knowledgeSync: false, implemented: true,
  },
  intercom: {
    label: 'Intercom', tagline: 'Customer messaging — conversations & help articles',
    defaultRole: 'support_desk',
    baseUrlLabel: 'API base URL', baseUrlPlaceholder: 'https://api.intercom.io',
    fields: [
      { key: 'access_token', label: 'Access token', placeholder: '••••••••', secret: true },
    ],
    help: 'In Intercom: Settings → Integrations → Developer Hub → New app → the Access Token is on the Authentication page. A free developer workspace works for testing.',
    knowledgeSync: true, implemented: true,
  },
  generic_rest: {
    label: 'Your product API', tagline: 'Any REST API — connect your own product with zero code',
    defaultRole: 'product_system',
    baseUrlLabel: 'API base URL', baseUrlPlaceholder: 'https://api.yourproduct.com',
    fields: [
      { key: 'header_name', label: 'Auth header name (optional)', placeholder: 'Authorization', secret: false },
      { key: 'header_value', label: 'Auth header value (optional)', placeholder: 'Bearer …', secret: true },
    ],
    help: 'Point DreamTeam at any JSON REST API: give it a search endpoint (path + query parameter) and optionally a record endpoint (path with {ref}). If the API needs a key, add the header it expects — stored server-side, never shown again.',
    knowledgeSync: false, implemented: true,
  },
  sharepoint: {
    label: 'SharePoint', tagline: 'Documents — registered now, adapter coming',
    defaultRole: 'knowledge_base',
    baseUrlLabel: 'Site URL', baseUrlPlaceholder: 'https://acme.sharepoint.com/sites/kb',
    fields: [],
    help: 'SharePoint can be registered today so it appears in your system map, but its adapter is not built yet — every call returns an honest "not implemented" until it ships.',
    knowledgeSync: false, implemented: false,
  },
};

export type ConnectorObjectType = 'ticket' | 'user' | 'organization';
export type ConnectorObjectMode = 'sync' | 'read_through';

export interface ConnectorObject {
  id: string;
  connector_id: string;
  object_type: ConnectorObjectType;
  mode: ConnectorObjectMode;
  sync_interval_mins: number;
  last_synced_at: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export type ConnectorActionKey = 'add_internal_note' | 'update_status';

export interface ConnectorAction {
  id: string;
  connector_id: string;
  action_key: ConnectorActionKey;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface SyncResult {
  ok: boolean;
  pulled?: number;
  upserted?: number;
  pages?: number;
  errors?: string[];
  error?: string;
}

export interface ReadThroughResult {
  ok: boolean;
  ticket?: Record<string, unknown>;
  persisted?: boolean;
  error?: string;
}

// ── Errors / tenant plumbing (mirrors customerApi) ────────────────

import { raise, requireTenantId } from './liveShared';


// ── Connector CRUD ────────────────────────────────────────────────

export async function listConnectors(): Promise<Connector[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('connectors')
    .select('*')
    .eq('tenant_id', tid)
    .order('created_at', { ascending: true });
  if (error) raise('listConnectors', error);
  return (data ?? []) as Connector[];
}

export async function listConnectorObjects(connectorId: string): Promise<ConnectorObject[]> {
  const { data, error } = await supabase
    .from('connector_objects')
    .select('*')
    .eq('connector_id', connectorId)
    .order('object_type', { ascending: true });
  if (error) raise('listConnectorObjects', error);
  return (data ?? []) as ConnectorObject[];
}

export async function listConnectorActions(connectorId: string): Promise<ConnectorAction[]> {
  const { data, error } = await supabase
    .from('connector_actions')
    .select('*')
    .eq('connector_id', connectorId)
    .order('action_key', { ascending: true });
  if (error) raise('listConnectorActions', error);
  return (data ?? []) as ConnectorAction[];
}

export async function updateConnectorObject(
  id: string,
  updates: Partial<Pick<ConnectorObject, 'mode' | 'sync_interval_mins' | 'enabled'>>,
): Promise<ConnectorObject> {
  const { data, error } = await supabase
    .from('connector_objects')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error) raise('updateConnectorObject', error);
  return data as ConnectorObject;
}

export async function updateConnectorAction(
  id: string,
  enabled: boolean,
): Promise<ConnectorAction> {
  const { data, error } = await supabase
    .from('connector_actions')
    .update({ enabled })
    .eq('id', id)
    .select()
    .single();
  if (error) raise('updateConnectorAction', error);
  return data as ConnectorAction;
}

// ── Connect flow ──────────────────────────────────────────────────
// insert connector → set_connector_secret RPC → seed default
// objects/actions → live 'test' call. On auth failure the connector
// stays in 'error' with the reason recorded.

export interface ConnectZendeskInput {
  displayName: string;
  baseUrl: string;   // e.g. https://acme.zendesk.com
  email: string;
  apiToken: string;
}

export async function connectZendesk(
  input: ConnectZendeskInput,
): Promise<{ connector: Connector; test: { ok: boolean; error?: string } }> {
  const tid = await requireTenantId();
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
  const { data, error } = await supabase
    .from('connectors')
    .insert({
      tenant_id: tid,
      provider: 'zendesk',
      display_name: input.displayName.trim() || 'Zendesk',
      base_url: baseUrl,
      status: 'disconnected',
    })
    .select()
    .single();
  if (error) raise('connectZendesk', error);
  const connector = data as Connector;

  // Credential goes into the service-role-only table via RPC —
  // never through a normal insert, never readable back.
  const { error: secretErr } = await supabase.rpc('set_connector_secret', {
    p_connector_id: connector.id,
    p_secret: JSON.stringify({ email: input.email.trim(), api_token: input.apiToken.trim() }),
  });
  if (secretErr) raise('set_connector_secret', secretErr);

  // Default object registry: tickets sync (the working cache),
  // users/orgs read-through (never persisted).
  const { error: objErr } = await supabase.from('connector_objects').insert([
    { connector_id: connector.id, object_type: 'ticket', mode: 'sync', sync_interval_mins: 60, enabled: true },
    { connector_id: connector.id, object_type: 'user', mode: 'read_through', enabled: true },
    { connector_id: connector.id, object_type: 'organization', mode: 'read_through', enabled: true },
  ]);
  if (objErr) raise('seed connector_objects', objErr);

  // Write-back registry
  const { error: actErr } = await supabase.from('connector_actions').insert([
    { connector_id: connector.id, action_key: 'add_internal_note', enabled: true },
    { connector_id: connector.id, action_key: 'update_status', enabled: true },
  ]);
  if (actErr) raise('seed connector_actions', actErr);

  const test = await invokeConnector<{ ok: boolean; error?: string }>({
    action: 'test',
    connector_id: connector.id,
  });

  const { data: fresh } = await supabase
    .from('connectors').select('*').eq('id', connector.id).single();
  return { connector: (fresh ?? connector) as Connector, test };
}

export async function testConnector(connectorId: string): Promise<{ ok: boolean; error?: string }> {
  return invokeConnector({ action: 'test', connector_id: connectorId });
}

export async function syncTickets(connectorId: string): Promise<SyncResult> {
  return invokeConnector({ action: 'sync_tickets', connector_id: connectorId });
}

export async function readThroughTicket(
  connectorId: string,
  externalRef: string,
): Promise<ReadThroughResult> {
  return invokeConnector({ action: 'read_ticket', connector_id: connectorId, external_ref: externalRef });
}

export async function writeBack(
  connectorId: string,
  externalRef: string,
  op: ConnectorActionKey,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  return invokeConnector({ action: 'write_back', connector_id: connectorId, external_ref: externalRef, op, payload });
}

/** Disconnect: purge the secret (RPC) and mark disconnected.
 *  The connector row + object/action config are kept so a reconnect
 *  restores the same shape; the credential is gone. */
export async function disconnectConnector(connector: Connector): Promise<void> {
  const { error: purgeErr } = await supabase.rpc('purge_connector_secret', {
    p_connector_id: connector.id,
  });
  if (purgeErr) raise('purge_connector_secret', purgeErr);
  const { error } = await supabase
    .from('connectors')
    .update({ status: 'disconnected', last_error: null })
    .eq('id', connector.id);
  if (error) raise('disconnectConnector', error);
  const { appendAuditEvent } = await import('./guardrailApi');
  await appendAuditEvent({
    actor: 'You', actor_type: 'human', category: 'config_change',
    action: `Connector disconnected — ${connector.display_name || connector.provider} (${connector.base_url}); credential purged`,
    detail: { connector_id: connector.id, provider: connector.provider },
  });
}

export async function deleteConnector(connectorId: string): Promise<void> {
  const { error } = await supabase.from('connectors').delete().eq('id', connectorId);
  if (error) raise('deleteConnector', error);
}

// ── Connector Hub: generic connect flow + read-through actions ────

export interface HubItem {
  ref: string;
  type: string;
  title: string;
  snippet: string;
  url: string | null;
  raw?: unknown; // returned live, never persisted
}

export interface ConnectProviderInput {
  provider: ConnectorProvider;
  displayName: string;
  baseUrl: string;
  role: ConnectorRole;
  accessMode: ConnectorAccessMode;
  /** Credential fields (PROVIDERS[provider].fields) — sent to the
   *  server-side secret store via RPC; the client can never read them back. */
  secrets: Record<string, string>;
  /** generic_rest endpoint templates */
  config?: Record<string, unknown>;
}

export async function connectProvider(
  input: ConnectProviderInput,
): Promise<{ connector: Connector; test: { ok: boolean; error?: string; detail?: string } }> {
  const tid = await requireTenantId();
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
  const { data, error } = await supabase
    .from('connectors')
    .insert({
      tenant_id: tid,
      provider: input.provider,
      display_name: input.displayName.trim() || PROVIDERS[input.provider].label,
      base_url: baseUrl,
      role: input.role,
      access_mode: input.accessMode,
      config: input.config ?? {},
      status: 'disconnected',
    })
    .select()
    .single();
  if (error) raise('connectProvider', error);
  const connector = data as Connector;

  const secretEntries = Object.entries(input.secrets).filter(([, v]) => v.trim());
  if (secretEntries.length > 0) {
    const { error: secretErr } = await supabase.rpc('set_connector_secret', {
      p_connector_id: connector.id,
      p_secret: JSON.stringify(Object.fromEntries(secretEntries.map(([k, v]) => [k, v.trim()]))),
    });
    if (secretErr) raise('set_connector_secret', secretErr);
  }

  // Zendesk keeps its object/action registries (sync + write-back path).
  if (input.provider === 'zendesk') {
    await supabase.from('connector_objects').insert([
      { connector_id: connector.id, object_type: 'ticket', mode: input.accessMode === 'ingest' ? 'sync' : 'read_through', sync_interval_mins: 60, enabled: true },
      { connector_id: connector.id, object_type: 'user', mode: 'read_through', enabled: true },
      { connector_id: connector.id, object_type: 'organization', mode: 'read_through', enabled: true },
    ]);
    await supabase.from('connector_actions').insert([
      { connector_id: connector.id, action_key: 'add_internal_note', enabled: true },
      { connector_id: connector.id, action_key: 'update_status', enabled: true },
    ]);
  }

  const test = PROVIDERS[input.provider].implemented
    ? await invokeHub<{ ok: boolean; error?: string; detail?: string }>({ action: 'test', connector_id: connector.id })
    : { ok: false, error: 'not_implemented' };

  const { data: fresh } = await supabase
    .from('connectors').select('*').eq('id', connector.id).single();
  return { connector: (fresh ?? connector) as Connector, test };
}

export async function hubTest(connectorId: string): Promise<{ ok: boolean; error?: string; detail?: string }> {
  return invokeHub({ action: 'test', connector_id: connectorId });
}

/** Read-through search: fetched live, returned, nothing persisted but audit. */
export async function hubSearch(connectorId: string, query: string): Promise<{ ok: boolean; items: HubItem[]; error?: string; latency_ms?: number }> {
  return invokeHub({ action: 'search', connector_id: connectorId, query });
}

export async function hubFetchRecord(connectorId: string, recordType: string, externalRef: string): Promise<{ ok: boolean; items: HubItem[]; error?: string }> {
  return invokeHub({ action: 'fetch_record', connector_id: connectorId, record_type: recordType, external_ref: externalRef });
}

/** Knowledge ingest (server-side REFUSES this for fetch-only connectors). */
export async function hubSync(connectorId: string): Promise<{ ok: boolean; upserted?: number; chunked?: number; embedded?: number; error?: string; detail?: string }> {
  return invokeHub({ action: 'sync', connector_id: connectorId });
}

async function invokeHub<T = Record<string, unknown>>(
  body: Record<string, unknown>,
): Promise<T & { ok: boolean; error?: string; items: HubItem[] }> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new CustomerApiError('Not signed in.', false);
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/connector-hub`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
      'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !data?.error) throw new CustomerApiError(`HTTP ${res.status}`, false);
  return { items: [], ...data, ok: !!data.ok } as T & { ok: boolean; error?: string; items: HubItem[] };
}

// ── Edge function invocation (legacy zendesk fn — sync/write-back) ─

async function invokeConnector<T = Record<string, unknown>>(
  body: Record<string, unknown>,
): Promise<T & { ok: boolean; error?: string }> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new CustomerApiError('Not signed in.', false);
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/connector-zendesk`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
      'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !data?.error) {
    throw new CustomerApiError(`HTTP ${res.status}`, false);
  }
  return { ok: !!data.ok, ...data } as T & { ok: boolean; error?: string };
}

// ── Display helpers ───────────────────────────────────────────────

export const CONNECTOR_ERROR_LABELS: Record<string, string> = {
  zendesk_auth_failed: 'Zendesk rejected the credentials — check the email and API token.',
  zendesk_unreachable: 'Could not reach the Zendesk instance — check the subdomain URL.',
  no_credentials: 'No credentials stored for this connector — reconnect to add them.',
  invalid_credentials_format: 'Stored credentials are malformed — reconnect to replace them.',
  object_disabled: 'This object type is disabled for the connector.',
  object_not_in_sync_mode: 'This object is set to read-through — switch it to sync mode first.',
  action_disabled: 'This write-back action is disabled in the registry.',
  connector_not_found: 'Connector not found for this workspace.',
};

export function connectorErrorLabel(err: string | undefined | null): string {
  if (!err) return 'Unknown error';
  return CONNECTOR_ERROR_LABELS[err] ?? (err.startsWith('zendesk_error_')
    ? `Zendesk returned HTTP ${err.replace('zendesk_error_', '')}`
    : err);
}

export function fmtSince(iso: string | null): string {
  if (!iso) return 'never';
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? '' : 's'} ago`;
  return `${Math.round(hrs / 24)} day${hrs < 48 ? '' : 's'} ago`;
}
