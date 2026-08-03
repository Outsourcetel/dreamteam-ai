// ============================================================
// MCP server allowlist (migration 174) — client API.
//
// Which MCP servers this workspace is willing to talk to at all. The rule the
// server enforces (mcp_host_allowed) is deliberately OPT-IN and has two modes:
//
//   NO rows  → every public MCP host is permitted (still SSRF-guarded: private,
//              loopback and link-local addresses are always refused)
//   ANY rows → ONLY the listed hosts are permitted
//
// So adding the FIRST host is not just "adding one" — it switches the whole
// workspace from open to strict. Removing the LAST one switches it back. Both
// directions are surfaced to the admin before they act.
//
// No RPC layer here on purpose: mcp_server_allowlist carries RLS that already
// restricts reads to the tenant (or a platform user) and writes to
// tenant_owner / tenant_admin, so direct table access IS the guarded path.
// ============================================================
import { supabase } from '../supabase';
import { raise, requireTenantId } from './liveShared';

export interface McpAllowlistEntry {
  id: string;
  host: string;
  note: string;
  created_at: string;
}

/** Accepts a bare host or a full URL and returns the bare lowercase hostname —
 *  the allowlist matches on host, so "https://x.com/mcp" must not be stored. */
export function normalizeMcpHost(input: string): string {
  const raw = input.trim();
  if (!raw) return '';
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return raw.replace(/^.*:\/\//, '').split('/')[0].split(':')[0].trim().toLowerCase();
  }
}

export async function listMcpAllowlist(): Promise<McpAllowlistEntry[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('mcp_server_allowlist')
    .select('id, host, note, created_at')
    .eq('tenant_id', tid)
    .order('host');
  if (error) raise('listMcpAllowlist', error);
  return (data ?? []) as McpAllowlistEntry[];
}

export async function addMcpAllowlistHost(host: string, note: string): Promise<void> {
  const tid = await requireTenantId();
  const clean = normalizeMcpHost(host);
  if (!clean) throw new Error('A server hostname is required.');
  const { error } = await supabase
    .from('mcp_server_allowlist')
    .insert({ tenant_id: tid, host: clean, note: note.trim().slice(0, 300) });
  if (error) raise('addMcpAllowlistHost', error);
}

export async function removeMcpAllowlistHost(id: string): Promise<void> {
  const { error } = await supabase.from('mcp_server_allowlist').delete().eq('id', id);
  if (error) raise('removeMcpAllowlistHost', error);
}
