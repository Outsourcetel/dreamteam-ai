import React, { useState, useEffect, useCallback } from 'react';
import type { Page } from '../../../types';
import {
  listMcpServers, syncMcpServerTools, listMcpAllowedHosts, addMcpAllowedHost,
  removeMcpAllowedHost, normalizeHost,
} from '../../../lib/mcpApi';
import type { McpServer, McpAllowedHost, McpTool } from '../../../lib/mcpApi';
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
                {t.destructive
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

function ServerCard({ s, onChanged }: { s: McpServer; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const sync = async () => {
    setBusy(true); setMsg(null); setErr(null);
    try {
      const r = await syncMcpServerTools(s.connector.id);
      if (!r.ok) setErr(r.error || r.detail || 'The server did not answer.');
      else { setMsg(`${r.tool_count ?? r.registered?.length ?? 0} tool(s) registered.`); setOpen(true); onChanged(); }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not reach the server.');
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

  return (
    <PanelCard
      title={s.connector.display_name}
      badge={s.blockedByAllowlist
        ? <Chip tone="danger">BLOCKED BY ALLOWLIST</Chip>
        : <Chip tone={s.connector.status === 'connected' ? 'ok' : 'neutral'}>{String(s.connector.status).toUpperCase()}</Chip>}
      actions={
        <div className="flex items-center gap-2">
          <Button kind="secondary" size="sm" disabled={busy} onClick={() => void sync()}>
            {busy ? 'Reading…' : s.tools.length ? 'Re-read tools' : 'Register tools'}
          </Button>
          {s.tools.length > 0 && (
            <Button kind="secondary" size="sm" onClick={() => setOpen((v) => !v)}>
              {open ? 'Hide' : `${s.tools.length} tool${s.tools.length === 1 ? '' : 's'}`}
            </Button>
          )}
          <Button kind="secondary" size="sm" disabled={busy} onClick={() => void remove()}>Disconnect</Button>
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
        {s.tools.length === 0 && <span>· nothing registered yet — use “Register tools”</span>}
      </div>

      {msg && <p className="mt-2 text-xs text-emerald-300">{msg}</p>}
      {err && <p className="mt-2 text-xs text-red-300">{err}</p>}

      {open && s.tools.length > 0 && (
        <div className="mt-3 pt-3 border-t border-dt-border"><ToolTable tools={s.tools} /></div>
      )}
    </PanelCard>
  );
}

function ConnectForm({ onDone }: { onDone: () => void }) {
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
        <Button kind="primary" size="sm" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Connecting…' : 'Connect'}
        </Button>
      </div>
    </PanelCard>
  );
}

function Allowlist({ hosts, onChanged }: { hosts: McpAllowedHost[]; onChanged: () => void }) {
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

          <Allowlist hosts={hosts} onChanged={() => void refresh()} />

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
