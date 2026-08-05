// ============================================================
// mcpApi — one data layer for the MCP surface.
//
// MCP support was real but had no home: connecting a server lived three
// levels inside a SPECIALIST employee's profile tab, the allowlist that
// decides which servers are permitted at all lived in a section near the
// bottom of the Data Access permissions page, and the tools themselves were
// action_definitions visible only if you already knew to look at Connectors.
// Nothing in the product was called "MCP". This module gathers the pieces so
// one page can show a server, its tools, their risk, and who may use them.
//
// It adds NO new machinery: servers are connectors (provider 'mcp'), tools
// are action_definitions written by connector-hub's sync_mcp_tools, and the
// allowlist is the same table the injection firewall reads on every call.
// ============================================================
import { supabase } from '../supabase';
import { raise, requireTenantId } from './liveShared';
import { listConnectors, hubSyncMcpTools, hubPreviewMcpTools } from './connectorApi';
import type { Connector } from './connectorApi';

/** A tool the server exposes, as it exists in the governance model. */
export interface McpTool {
  id: string;
  action_key: string;
  label: string;
  description: string;
  /** The tool's name on the MCP server (execution.mcp_tool). */
  tool_name: string;
  destructive: boolean;
  idempotent: boolean;
  /** A read that is not harmless — credential or authorization material.
   *  Not destructive, but still floored to a human (found on Resend's
   *  list-api-keys / list-oauth-grants, both correctly annotated read-only). */
  sensitive: boolean;
  status: string;
  /** What the gate will do: a read-only tool may auto-execute under trust;
   *  anything that acts — or reads credentials — is floored to a human. */
  gate: 'always human-approved' | 'may auto-run under trust';
  param_count: number;
}

/** One tool as the server publishes it, before anything is registered. */
export interface McpToolPreview {
  tool: string;
  label: string;
  description: string;
  read_only: boolean;
  destructive: boolean;
  sensitive: boolean;
  param_count: number;
  gate: string;
}

export interface McpServer {
  connector: Connector;
  tools: McpTool[];
  /** Hostname, for matching against the allowlist. */
  host: string;
  /** True when the allowlist is in strict mode and this host is NOT on it —
   *  the server exists but every call to it will be refused. */
  blockedByAllowlist: boolean;
}

function hostOf(url: string | null | undefined): string {
  try { return new URL(String(url ?? '')).hostname.toLowerCase(); } catch { return ''; }
}

/** Every MCP server this workspace has connected, with its registered tools. */
export async function listMcpServers(): Promise<McpServer[]> {
  const tid = await requireTenantId();
  const all = await listConnectors();
  const servers = all.filter((c) => c.provider === 'mcp');

  const [{ data: defs, error: defErr }, { data: allow }] = await Promise.all([
    supabase.from('action_definitions')
      .select('id, action_key, label, description, execution, risk, status, param_schema')
      .eq('tenant_id', tid).eq('provider', 'mcp'),
    supabase.from('mcp_server_allowlist').select('host').eq('tenant_id', tid),
  ]);
  if (defErr) raise('listMcpServers (action_definitions)', defErr);

  const allowHosts = new Set(((allow ?? []) as Array<{ host: string }>).map((a) => a.host.toLowerCase()));
  const strict = allowHosts.size > 0;

  const rows = (defs ?? []) as Array<{
    id: string; action_key: string; label: string | null; description: string | null;
    execution: Record<string, unknown> | null; risk: Record<string, unknown> | null;
    status: string; param_schema: unknown;
  }>;

  return servers.map((c) => {
    const host = hostOf(c.base_url);
    const tools: McpTool[] = rows
      .filter((r) => String(r.execution?.connector_id ?? '') === c.id)
      .map((r) => {
        const destructive = r.risk?.destructive === true;
        const sensitive = r.risk?.sensitive === true;
        return {
          id: r.id,
          action_key: r.action_key,
          label: r.label || r.action_key,
          description: r.description || '',
          tool_name: String(r.execution?.mcp_tool ?? ''),
          destructive,
          sensitive,
          idempotent: r.risk?.idempotent === true,
          status: r.status,
          // Not a guess: connector-hub floors anything destructive OR sensitive
          // to a human. MCP risk comes from the tool's own annotations, absent
          // annotations count as unsafe, and a credential-reading tool is
          // floored even though it mutates nothing.
          gate: (destructive || sensitive ? 'always human-approved' : 'may auto-run under trust') as McpTool['gate'],
          param_count: Array.isArray(r.param_schema) ? r.param_schema.length : 0,
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label));

    return {
      connector: c,
      tools,
      host,
      blockedByAllowlist: strict && !!host && !allowHosts.has(host),
    };
  });
}

/** What the server publishes and how each tool WOULD be gated. Writes nothing. */
export async function previewMcpTools(connectorId: string) {
  return hubPreviewMcpTools(connectorId);
}

/** Register tools as governed actions. Pass `only` to register a subset —
 *  omitting it registers everything, which on a 91-tool server buries the
 *  handful you actually wanted. Safe to re-run; tools are upserted. */
export async function syncMcpServerTools(connectorId: string, only?: string[]) {
  return hubSyncMcpTools(connectorId, only);
}

// ── Allowlist ────────────────────────────────────────────────
// The same rows the mcp-client injection firewall reads before every call.
// Empty = open (any public https server); one row = strict.

export interface McpAllowedHost {
  id: string;
  host: string;
  note: string | null;
  created_at: string;
}

export async function listMcpAllowedHosts(): Promise<McpAllowedHost[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('mcp_server_allowlist')
    .select('id, host, note, created_at')
    .eq('tenant_id', tid)
    .order('host', { ascending: true });
  if (error) raise('listMcpAllowedHosts', error);
  return (data ?? []) as McpAllowedHost[];
}

/** Normalize what a person typed into a bare hostname. */
export function normalizeHost(input: string): string {
  const raw = input.trim();
  if (!raw) return '';
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return raw.toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
  }
}

export async function addMcpAllowedHost(host: string, note: string): Promise<void> {
  const tid = await requireTenantId();
  const clean = normalizeHost(host);
  if (!clean) throw new Error('Enter the server hostname, for example mcp.example.com');
  const { error } = await supabase
    .from('mcp_server_allowlist')
    .insert({ tenant_id: tid, host: clean, note: note.trim() || null });
  if (error) raise('addMcpAllowedHost', error);
}

export async function removeMcpAllowedHost(id: string): Promise<void> {
  const { error } = await supabase.from('mcp_server_allowlist').delete().eq('id', id);
  if (error) raise('removeMcpAllowedHost', error);
}
