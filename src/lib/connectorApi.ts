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

export type ConnectorProvider = 'zendesk';
export type ConnectorStatus = 'connected' | 'error' | 'disconnected';

export interface Connector {
  id: string;
  tenant_id: string;
  provider: ConnectorProvider;
  display_name: string;
  base_url: string;
  status: ConnectorStatus;
  last_sync_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

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

// ── Edge function invocation ──────────────────────────────────────

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
