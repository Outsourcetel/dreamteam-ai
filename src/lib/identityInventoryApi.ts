// ============================================================
// Identity & Credential Inventory (migration 044) — client API.
//
// Gap-analysis item 26: the single view a security reviewer asks for
// first — which Digital Employee or Specialist holds which live
// grant, on which connected system, with what trust level and
// connector health. READ-ONLY. Calls the get_identity_inventory RPC,
// which does its own explicit tenant-membership check server-side
// (never trusts a client-supplied tenant id at face value).
//
// NEVER exposes secret values — only a has_stored_credential
// boolean, matching connector_secrets' zero-client-access model
// (migration 017): the table has no SELECT policy for anyone but
// service_role, so even if this file tried to read it directly, it
// couldn't. This file only reads the RPC's boolean projection.
// ============================================================
import { supabase } from '../supabase';
import { raise, requireTenantId } from './liveShared';
import type { SystemCategory } from './categoryContracts';
import type { AccessPermission } from './accessGrantsApi';

export interface PossibleAction {
  action_key: string;
  label: string;
  destructive: boolean;
}

export interface IdentityInventoryRow {
  subject_kind: 'de' | 'specialist';
  subject_id: string;
  subject_name: string;
  subject_label: string;
  subject_role: string;
  subject_status: string;
  connector_id: string | null;
  connector_name: string | null;
  connector_provider: string | null;
  connector_category: SystemCategory | null;
  connector_status: 'connected' | 'error' | 'disconnected' | null;
  connector_last_ok_at: string | null;
  connector_last_error_at: string | null;
  connector_consecutive_failures: number | null;
  has_stored_credential: boolean;
  permission: AccessPermission | null;
  permission_via: 'connector' | 'category' | null;
  trust_current_level: number | null;
  trust_target_level: number | null;
  autonomy_enabled: boolean | null;
  possible_actions: PossibleAction[];
}

/** One subject, with its systems grouped for rendering. */
export interface IdentitySubject {
  kind: 'de' | 'specialist';
  id: string;
  name: string;
  label: string;
  role: string;
  status: string;
  systems: {
    connectorId: string;
    connectorName: string;
    provider: string;
    category: SystemCategory;
    connectorStatus: 'connected' | 'error' | 'disconnected';
    lastOkAt: string | null;
    lastErrorAt: string | null;
    consecutiveFailures: number;
    hasCredential: boolean;
    permission: AccessPermission;
    permissionVia: 'connector' | 'category';
    trustCurrentLevel: number | null;
    trustTargetLevel: number | null;
    autonomyEnabled: boolean | null;
    possibleActions: PossibleAction[];
  }[];
}

export async function fetchIdentityInventory(): Promise<IdentitySubject[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase.rpc('get_identity_inventory', { p_tenant_id: tid });
  if (error) raise('fetchIdentityInventory', error);
  const rows = (data ?? []) as IdentityInventoryRow[];

  const bySubject = new Map<string, IdentitySubject>();
  for (const r of rows) {
    const key = `${r.subject_kind}:${r.subject_id}`;
    let subj = bySubject.get(key);
    if (!subj) {
      subj = {
        kind: r.subject_kind, id: r.subject_id, name: r.subject_name,
        label: r.subject_label, role: r.subject_role, status: r.subject_status,
        systems: [],
      };
      bySubject.set(key, subj);
    }
    if (r.connector_id) {
      subj.systems.push({
        connectorId: r.connector_id,
        connectorName: r.connector_name ?? r.connector_provider ?? 'connected system',
        provider: r.connector_provider ?? '',
        category: r.connector_category as SystemCategory,
        connectorStatus: (r.connector_status ?? 'disconnected') as 'connected' | 'error' | 'disconnected',
        lastOkAt: r.connector_last_ok_at,
        lastErrorAt: r.connector_last_error_at,
        consecutiveFailures: r.connector_consecutive_failures ?? 0,
        hasCredential: r.has_stored_credential,
        permission: r.permission as AccessPermission,
        permissionVia: r.permission_via as 'connector' | 'category',
        trustCurrentLevel: r.trust_current_level,
        trustTargetLevel: r.trust_target_level,
        autonomyEnabled: r.autonomy_enabled,
        possibleActions: r.possible_actions ?? [],
      });
    }
  }
  return Array.from(bySubject.values()).sort((a, b) => a.name.localeCompare(b.name));
}
