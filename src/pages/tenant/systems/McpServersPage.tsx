import { useIsTenantAdmin } from '../../../lib/useRoleGate';
import React, { useState, useEffect, useCallback } from 'react';
import type { Page } from '../../../types';
import {
  listMcpServers, syncMcpServerTools, previewMcpTools, listMcpAllowedHosts,
  addMcpAllowedHost, removeMcpAllowedHost, normalizeHost,
} from '../../../lib/mcpApi';
import type { McpServer, McpAllowedHost, McpTool, McpToolPreview } from '../../../lib/mcpApi';
import { connectProvider, deleteConnector, PROVIDERS } from '../../../lib/connectorApi';
import { LiveLoadingSkeleton, LiveErrorNotice } from '../../../components/LiveDataStates';
import { Button, Chip, EmptyState, PanelCard, StatTile, Banner, Field, INPUT_CLS, TableScroll, TH, TD } from '../../../design/primitives';

// ============================================================
// MCP servers — the home this capability never had.
//
// Everything here already existed and was simply unfindable: connecting a
// server meant opening a SPECIALIST employee's profile and adding a source of
// type "MCP server"; the allowlist that decides which servers may be reached
// at all was a section near the bottom of the Data Access permissions page;
// and the tools were action_definitions you would only see if you already
// knew to look under Connectors. Nothing was labelled MCP.
//
// The governance claim shown on this page is not decoration. Risk comes from
// each tool's own MCP annotations, connector-hub floors anything destructive
// to a human, and an absent annotation is treated as unsafe — so a tool
// cannot quietly act on its own. The allowlist is the same table the
// injection firewall reads before every outbound call.
//
// SENSITIVE READS are shown separately because connecting a real server taught
// us that readOnlyHint alone is not enough: Resend's list-api-keys and
// list-oauth-grants are annotated read-only and are — they mutate nothing —
// yet a trusted employee could have enumerated a workspace's credentials with
// no approval and nobody watching. Those are floored to a human without being
// mislabelled destructive, and they are NOT pre-selected when registering.
// ============================================================

function ToolTable({ tools }: { tools: McpTool[] }) {
  return (
    <TableScroll>
      <table className="w-full">
        <thead>
          <tr>
            <th className={TH}>Tool</th>
            <th className={TH}>What it does</th>
            <th className={TH}>Inputs</th>
            <th className={TH}>Approval</th>
          </tr>
        </thead>
        <tbody>
          {tools.map((t) => (
            <tr key={t.id} className="border-t border-dt-border">
              <td className={TD}>
                <span className="font-medium text-dt-body">{t.label}</span>
                {t.tool_name && t.tool_name !== t.label && (
                  <span className="block text-[11px] text-dt-muted font-mono">{t.tool_name}</span>
                )}
              </td>
              <td className={`${TD} text-dt-support max-w-md`}>{t.description || '—'}</td>
              <td className={TD}>{t.param_count}</td>
              <td className={TD}>
                {t.sensitive
                  ? <Chip tone="danger">SENSITIVE READ — HUMAN-APPROVED</Chip>
                  : t.destructive
                    ? <Chip tone="warn">ALWAYS HUMAN-APPROVED</Chip>
                    : <Chip tone="ok">MAY AUTO-RUN UNDER TRUST</Chip>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

/** Look before you register. A real server can publish ~90 tools, most of them
 *  irrelevant to any given business; registering blind buries the handful that
 *  matter under a catalogue nobody reads. Sensitive reads are pre-ticked OFF —
 *  the safe default is not to hand an employee a credential-listing tool by
 *  accident. */
function ToolPicker({ tools, onCancel, onRegister, busy }: {
  tools: McpToolPreview[];
  onCancel: () => void;
  onRegister: (names: string[]) => void;
  busy: boolean;
}) {
  const safeDefault = (t: McpToolPreview) => t.read_only && !t.sensitive;
  const [picked, setPicked] = useState<Set<string>>(() => new Set(tools.filter(safeDefault).map((t) => t.tool)));
  const toggle = (name: string) => setPicked((p) => {
    const n = new Set(p); n.has(name) ? n.delete(name) : n.add(name); return n;
  });
  const setAll = (names: string[]) => setPicked(new Set(names));

  return (
    <div className="mt-3 pt-3 border-t border-dt-border">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <p className="text-xs text-dt-support">
          {tools.length} tool{tools.length === 1 ? '' : 's'} published · {picked.size} selected.
          Read-only tools are pre-selected; anything that acts, or reads credentials, is not.
        </p>
        <div className="flex items-center gap-2">
          <Button kind="secondary" size="sm" onClick={() => setAll(tools.filter(safeDefault).map((t) => t.tool))}>Safe defaults</Button>
          <Button kind="secondary" size="sm" onClick={() => setAll(tools.map((t) => t.tool))}>Select all</Button>
          <Button kind="secondary" size="sm" onClick={() => setAll([])}>None</Button>
        </div>
      </div>

      <div className="max-h-80 overflow-y-auto rounded-lg border border-dt-border divide-y divide-dt-border">
        {tools.map((t) => (
          <label key={t.tool} className="flex items-start gap-3 px-3 py-2 cursor-pointer hover:bg-dt-inset">
            <input type="checkbox" className="mt-1" checked={picked.has(t.tool)} onChange={() => toggle(t.tool)} />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-dt-body">{t.label || t.tool}</span>
                {t.sensitive
                  ? <Chip tone="danger">SENSITIVE READ</Chip>
                  : t.destructive ? <Chip tone="warn">NEEDS A HUMAN</Chip> : <Chip tone="ok">READ-ONLY</Chip>}
              </span>
              {t.description && <span className="block text-[11px] text-dt-muted truncate">{t.description}</span>}
              <span className="block text-[10px] text-dt-faint font-mono">{t.tool} · {t.param_count} input{t.param_count === 1 ? '' : 's'}</span>
            </span>
          </label>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <Button kind="primary" size="sm" disabled={busy || picked.size === 0} onClick={() => onRegister([...picked])}>
          {busy ? 'Registering…' : `Register ${picked.size} tool${picked.size === 1 ? '' : 's'}`}
        </Button>
        <Button kind="secondary" size="sm" disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function ServerCard({ s, onChanged }: { s: McpServer; onChanged: () => void }) {
  // An MCP server IS a connector row, so registering tools and
  // disconnecting are owner/admin writes on a MANAGE page. Reading which
  // servers and tools exist stays open.
  const canManageConnectors = useIsTenantAdmin();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<McpToolPreview[] | null>(null);

  const readTools = async () => {
    setBusy(true); setMsg(null); setErr(null);
    try {
      const r = await previewMcpTools(s.connector.id);
      if (!r.ok || !r.tools) setErr(r.error || r.detail || 'The server did not answer.');
      else { setPreview(r.tools); setOpen(false); }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not reach the server.');
    } finally { setBusy(false); }
  };

  const register = async (names: string[]) => {
    setBusy(true); setMsg(null); setErr(null);
    try {
      const r = await syncMcpServerTools(s.connector.id, names);
      if (!r.ok) setErr(r.error || r.detail || 'Some tools could not be registered.');
      else {
        const n = r.registered?.length ?? 0;
        const sens = r.registered?.filter((x) => x.sensitive).length ?? 0;
        setMsg(`${n} tool${n === 1 ? '' : 's'} registered${sens > 0 ? ` — ${sens} sensitive read${sens === 1 ? '' : 's'} will always need a human` : ''}.`);
        setPreview(null); setOpen(true); onChanged();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not register the tools.');
    } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!window.confirm(`Disconnect "${s.connector.display_name}"?\n\nIts registered tools stop being available to your digital employees.`)) return;
    setBusy(true);
    try { await deleteConnector(s.connector.id); onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not disconnect.'); }
    finally { setBusy(false); }
  };

  const destructive = s.tools.filter((t) => t.destructive).length;
  const sensitive = s.tools.filter((t) => t.sensitive).length;

  return (
    <PanelCard
      title={s.connector.display_name}
      badge={s.blockedByAllowlist
        ? <Chip tone="danger">BLOCKED BY ALLOWLIST</Chip>
        : <Chip tone={s.connector.status === 'connected' ? 'ok' : 'neutral'}>{String(s.connector.status).toUpperCase()}</Chip>}
      actions={
        <div className="flex items-center gap-2">
          <Button kind="secondary" size="sm" disabled={busy || !canManageConnectors} onClick={() => void readTools()}>
            {busy ? 'Reading…' : s.tools.length ? 'Re-read tools' : 'Read tools'}
          </Button>
          {s.tools.length > 0 && (
            <Button kind="secondary" size="sm" onClick={() => setOpen((v) => !v)}>
              {open ? 'Hide' : `${s.tools.length} tool${s.tools.length === 1 ? '' : 's'}`}
            </Button>
          )}
          <Button kind="secondary" size="sm" disabled={busy || !canManageConnectors} onClick={() => void remove()}>Disconnect</Button>
        </div>
      }
    >
      <p className="text-xs text-dt-muted font-mono break-all">{s.connector.base_url}</p>

      {s.blockedByAllowlist && (
        <div className="mt-2">
          <Banner tone="danger">
            This workspace is restricted to listed servers and <span className="font-mono">{s.host}</span> is
            not on the list, so every call to it is refused. Add it below, or disconnect the server.
          </Banner>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-dt-muted">
        <span>{s.tools.length} tool{s.tools.length === 1 ? '' : 's'} registered</span>
        {destructive > 0 && <span>· {destructive} always need a human</span>}
        {sensitive > 0 && <span className="text-rose-300">· {sensitive} sensitive read{sensitive === 1 ? '' : 's'}</span>}
        {s.tools.length === 0 && <span>· nothing registered yet — use “Read tools”</span>}
      </div>

      {msg && <p className="mt-2 text-xs text-emerald-300">{msg}</p>}
      {err && <p className="mt-2 text-xs text-red-300">{err}</p>}

      {preview && (
        <ToolPicker tools={preview} busy={busy} onCancel={() => setPreview(null)} onRegister={(n) => void register(n)} />
      )}

      {open && !preview && s.tools.length > 0 && (
        <div className="mt-3 pt-3 border-t border-dt-border"><ToolTable tools={s.tools} /></div>
      )}
    </PanelCard>
  );
}

function ConnectForm({ onDone }: { onDone: () => void }) {
  const canManageConnectors = useIsTenantAdmin();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!url.trim()) { setErr('Enter the server’s endpoint URL.'); return; }
    setBusy(true); setErr(null);
    try {
      const { test } = await connectProvider({
        provider: 'mcp',
        displayName: name.trim() || 'MCP server',
        baseUrl: url.trim(),
        category: PROVIDERS.mcp.defaultCategory,
        accessMode: 'fetch_only',
        secrets: token.trim() ? { token: token.trim() } : {},
      });
      if (!test.ok) setErr(test.error || test.detail || 'Connected, but the server did not answer a test call.');
      setName(''); setUrl(''); setToken('');
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not connect.');
    } finally { setBusy(false); }
  };

  return (
    <PanelCard title="Connect an MCP server">
      <p className="text-xs text-dt-support mb-3">
        Paste the server’s Streamable-HTTP endpoint. Only public https addresses are allowed —
        private and loopback addresses are refused whatever the allowlist says.
      </p>
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Name"><input className={INPUT_CLS} value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme tools" /></Field>
        <Field label="Endpoint URL"><input className={INPUT_CLS} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" /></Field>
        <Field label="Bearer token" hint="Leave blank if the server is open">
          <input className={INPUT_CLS} type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="••••••••" />
        </Field>
      </div>
      {err && <p className="mt-2 text-xs text-red-300">{err}</p>}
      <div className="mt-3">
        <Button kind="primary" size="sm" disabled={busy || !canManageConnectors} onClick={() => void submit()}>
          {busy ? 'Connecting…' : 'Connect'}
        </Button>
      </div>
    </PanelCard>
  );
}

function Allowlist({ hosts, onChanged, setPage }: {
  hosts: McpAllowedHost[]; onChanged: () => void; setPage: (p: Page) => void;
}) {
  const [host, setHost] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const strict = hosts.length > 0;

  const add = async () => {
    const clean = normalizeHost(host);
    if (!clean) { setErr('Enter the server hostname, for example mcp.example.com'); return; }
    if (hosts.some((h) => h.host === clean)) { setErr(`${clean} is already allowed.`); return; }
    if (!strict && !window.confirm(
      `Restrict this workspace to listed MCP servers only?\n\nRight now any public MCP server may be connected. Adding "${clean}" switches to strict mode: only listed servers can be reached.`,
    )) return;
    setBusy(true); setErr(null);
    try { await addMcpAllowedHost(clean, note); setHost(''); setNote(''); onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not add the host.'); }
    finally { setBusy(false); }
  };

  const remove = async (h: McpAllowedHost) => {
    if (hosts.length === 1 && !window.confirm(
      `Remove "${h.host}" — the last entry?\n\nThis returns the workspace to OPEN: any public MCP server could then be reached. Private and loopback addresses stay blocked either way.`,
    )) return;
    setBusy(true);
    try { await removeMcpAllowedHost(h.id); onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not remove the host.'); }
    finally { setBusy(false); }
  };

  return (
    <PanelCard
      title="Which servers this workspace may reach"
      badge={strict ? <Chip tone="ok">RESTRICTED — {hosts.length}</Chip> : <Chip tone="warn">OPEN — any public server</Chip>}
    >
      <p className="text-xs text-dt-support">
        {strict
          ? 'Only these hosts can be reached. A connected server that is not listed is refused on every call.'
          : 'No hosts listed, so any public MCP server may be connected. Adding one switches this workspace to strict mode.'}
      </p>

      {hosts.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {hosts.map((h) => (
            <div key={h.id} className="flex items-center justify-between gap-3 rounded-lg border border-dt-border bg-dt-inset px-3 py-2">
              <div className="min-w-0">
                <span className="text-sm font-mono text-dt-body">{h.host}</span>
                {h.note && <span className="block text-[11px] text-dt-muted truncate">{h.note}</span>}
              </div>
              <Button kind="secondary" size="sm" disabled={busy} onClick={() => void remove(h)}>Remove</Button>
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <Field label="Hostname"><input className={INPUT_CLS} value={host} onChange={(e) => setHost(e.target.value)} placeholder="mcp.example.com" /></Field>
        <Field label="Note" hint="Optional — why it is trusted"><input className={INPUT_CLS} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Vendor tool server" /></Field>
        <div className="flex items-end">
          <Button kind="secondary" size="sm" disabled={busy} onClick={() => void add()}>Allow this host</Button>
        </div>
      </div>
      {err && <p className="mt-2 text-xs text-red-300">{err}</p>}

      {/* The other half of the picture. This list decides which SERVERS may be
          reached at all; Governance → Data access decides which employees may
          use what they expose. Governance shows this list read-only and points
          back here, so there is one editor and no dead end either way. */}
      <div className="mt-4 flex items-center gap-3 flex-wrap border-t border-dt-border pt-3">
        <Button kind="secondary" size="sm" onClick={() => setPage('gov_data_access')}>
          Data access permissions →
        </Button>
        <span className="text-[10px] text-dt-faint">
          This list is about which servers are reachable. Which employee may use their tools is
          set under Governance → Data access.
        </span>
      </div>
    </PanelCard>
  );
}

const McpServersPage = ({ setPage, embedded }: { setPage: (p: Page) => void; embedded?: boolean }) => {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [hosts, setHosts] = useState<McpAllowedHost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [s, h] = await Promise.all([listMcpServers(), listMcpAllowedHosts()]);
      setServers(s); setHosts(h);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load MCP servers.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const toolCount = servers.reduce((n, s) => n + s.tools.length, 0);
  const gatedCount = servers.reduce((n, s) => n + s.tools.filter((t) => t.destructive).length, 0);
  const blocked = servers.filter((s) => s.blockedByAllowlist).length;

  const body = (
    <div className="px-6 pb-10 space-y-5">
      {error && <LiveErrorNotice message={error} onRetry={() => void refresh()} />}

      {loading ? <LiveLoadingSkeleton rows={4} /> : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatTile label="Servers connected" value={servers.length} />
            <StatTile label="Tools registered" value={toolCount} />
            <StatTile label="Always need a human" value={gatedCount} sub={toolCount > 0 ? `of ${toolCount}` : undefined} />
            <StatTile
              label="Reachability"
              value={hosts.length > 0 ? 'Restricted' : 'Open'}
              tone={blocked > 0 ? 'warn' : undefined}
              sub={blocked > 0 ? `${blocked} connected but blocked` : undefined}
            />
          </div>

          <Allowlist hosts={hosts} onChanged={() => void refresh()} setPage={setPage} />

          {servers.length === 0 ? (
            <EmptyState icon="🔗" headline="No MCP servers connected">
              An MCP server exposes tools your digital employees can use. Connect one below and
              register its tools — each becomes a governed action, and anything not explicitly
              marked read-only always needs a human.
            </EmptyState>
          ) : (
            <div className="space-y-3">
              {servers.map((s) => <ServerCard key={s.connector.id} s={s} onChanged={() => void refresh()} />)}
            </div>
          )}

          <ConnectForm onDone={() => void refresh()} />
        </>
      )}
    </div>
  );

  if (embedded) return <div className="flex-1 overflow-y-auto pt-5">{body}</div>;
  return (
    <div className="flex-1 overflow-y-auto bg-dt-page text-dt-body">
      <div className="px-6 pt-8 pb-4">
        <h1 className="text-2xl font-semibold text-dt-title">MCP servers</h1>
        <p className="text-sm text-dt-support mt-1 max-w-2xl">
          Model Context Protocol servers expose tools your digital employees can use. Every tool
          becomes a governed action — read-only tools may run under trust, anything else always
          waits for a human.
        </p>
      </div>
      {body}
    </div>
  );
};

export default McpServersPage;
