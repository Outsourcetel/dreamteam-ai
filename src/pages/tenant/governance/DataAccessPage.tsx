import React, { useCallback, useEffect, useState } from 'react';
import { PageHeader } from '../../../components/ui';
import { listConnectors, Connector } from '../../../lib/connectorApi';
import { CATEGORIES, CATEGORY_LABELS, SystemCategory } from '../../../lib/categoryContracts';
import {
  AccessGrant, AccessSubject, AccessDenialEvent, AccessPermission,
  PERMISSION_LABELS, PERMISSION_EXPLAIN,
  listAccessGrants, listAccessSubjects, listRecentDenials,
  setAccessGrant, revokeAccessGrant, effectiveGrant,
} from '../../../lib/accessGrantsApi';
import { LiveLoadingSkeleton, LiveEmptyState } from '../../../components/LiveDataStates';
import {
  McpAllowlistEntry, listMcpAllowlist, addMcpAllowlistHost, removeMcpAllowlistHost, normalizeMcpHost,
} from '../../../lib/mcpAllowlistApi';

// ============================================================
// GOVERNANCE — Data Access (migration 029).
//
// The access matrix: which Digital Employee or Specialist may touch
// which connected system, and how deeply. DEFAULT-DENY — no grant
// means every request is refused server-side (the edge functions
// check on every call; this page only edits the rules).
//
// Two layers, resolved exactly like the server does:
//   1. Category defaults  — "this DE may read any helpdesk system"
//   2. Per-system override — beats the category default for that
//      one connector
// ============================================================

const selectCls = 'text-xs bg-dt-page border border-dt-border-strong rounded-lg px-2 py-1.5 text-white focus:outline-none focus:border-indigo-500 disabled:opacity-40';
const PERMS: AccessPermission[] = ['search', 'read', 'ingest', 'write_back'];

const fmtDate = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const CAT_SHORT: Record<SystemCategory, string> = {
  crm: 'CRM', helpdesk: 'Helpdesk', knowledge_base: 'Knowledge base',
  erp_financials: 'ERP / Financials', billing: 'Billing', payroll_hcm: 'Payroll / HCM',
  pos: 'Point of sale', product_system: 'Product system', other: 'Other',
};
const SENSITIVE: Set<SystemCategory> = new Set(['erp_financials', 'billing', 'payroll_hcm']);

export default function DataAccessPage() {
  const [subjects, setSubjects] = useState<AccessSubject[]>([]);
  const [grants, setGrants] = useState<AccessGrant[]>([]);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [denials, setDenials] = useState<AccessDenialEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingCell, setSavingCell] = useState<string | null>(null);
  const [lastChange, setLastChange] = useState<string | null>(null);
  // MCP server allowlist — opt-in: no rows = open, any row = strict.
  const [mcpAllow, setMcpAllow] = useState<McpAllowlistEntry[]>([]);
  const [mcpHostInput, setMcpHostInput] = useState('');
  const [mcpNoteInput, setMcpNoteInput] = useState('');
  const [mcpBusy, setMcpBusy] = useState(false);
  const [mcpError, setMcpError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [subs, grs, conns, dens, mcpHosts] = await Promise.all([
        listAccessSubjects(), listAccessGrants(),
        listConnectors().catch(() => [] as Connector[]),
        listRecentDenials().catch(() => [] as AccessDenialEvent[]),
        listMcpAllowlist().catch(() => [] as McpAllowlistEntry[]),
      ]);
      setSubjects(subs); setGrants(grs); setConnectors(conns); setDenials(dens);
      setMcpAllow(mcpHosts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Demo sessions have no live tenant — that's not an error, it's the boundary.
      setError(/no tenant/i.test(msg)
        ? 'This is a live-workspace feature — sign into your live workspace to manage which digital employees can access which systems. (Demo companies have no real connected systems to govern.)'
        : msg);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const categoryGrant = (s: AccessSubject, cat: SystemCategory): AccessPermission | null =>
    grants.find((g) => g.subject_kind === s.kind && g.subject_id === s.id
      && g.resource_kind === 'category' && g.resource_category === cat)?.permission ?? null;

  const connectorOverride = (s: AccessSubject, connectorId: string): AccessPermission | null =>
    grants.find((g) => g.subject_kind === s.kind && g.subject_id === s.id
      && g.resource_kind === 'connector' && g.resource_id === connectorId)?.permission ?? null;

  const changeCategory = async (s: AccessSubject, cat: SystemCategory, value: string) => {
    const key = `${s.kind}:${s.id}:cat:${cat}`;
    setSavingCell(key); setError(null);
    try {
      if (value === 'none') {
        await revokeAccessGrant({ kind: s.kind, id: s.id }, { resource_kind: 'category', resource_category: cat });
        setLastChange(`${s.name} — ${CAT_SHORT[cat]} default removed (back to default-deny). Audited.`);
      } else {
        await setAccessGrant({ kind: s.kind, id: s.id }, { resource_kind: 'category', resource_category: cat }, value as AccessPermission);
        setLastChange(`${s.name} — ${CAT_SHORT[cat]} default set to ${PERMISSION_LABELS[value as AccessPermission]}. Audited.`);
      }
      setGrants(await listAccessGrants());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setSavingCell(null); }
  };

  const changeConnector = async (s: AccessSubject, c: Connector, value: string) => {
    const key = `${s.kind}:${s.id}:conn:${c.id}`;
    setSavingCell(key); setError(null);
    try {
      if (value === 'inherit') {
        await revokeAccessGrant({ kind: s.kind, id: s.id }, { resource_kind: 'connector', resource_id: c.id });
        setLastChange(`${s.name} — override removed on ${c.display_name || c.provider}; the category default (or default-deny) applies again. Audited.`);
      } else {
        await setAccessGrant({ kind: s.kind, id: s.id }, { resource_kind: 'connector', resource_id: c.id }, value as AccessPermission);
        setLastChange(`${s.name} — ${c.display_name || c.provider} set to ${PERMISSION_LABELS[value as AccessPermission]} (overrides the category default). Audited.`);
      }
      setGrants(await listAccessGrants());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setSavingCell(null); }
  };

  // ── MCP allowlist ──
  // Adding the first host, or removing the last, switches the whole workspace
  // between open and strict. Neither happens without saying so first.
  const addMcpHost = async () => {
    const clean = normalizeMcpHost(mcpHostInput);
    if (!clean) { setMcpError('Enter the server hostname, for example mcp.example.com'); return; }
    if (mcpAllow.some(e => e.host === clean)) { setMcpError(`${clean} is already allowed.`); return; }
    if (mcpAllow.length === 0 && !window.confirm(
      `Restrict this workspace to listed MCP servers only?\n\n`
      + `Right now any public MCP server may be connected. Adding "${clean}" switches to strict mode: `
      + `from then on ONLY servers on this list can be connected or called — including any already connected.`)) return;
    setMcpBusy(true); setMcpError(null);
    try {
      await addMcpAllowlistHost(clean, mcpNoteInput);
      setMcpHostInput(''); setMcpNoteInput('');
      setLastChange(`${clean} added to the MCP server allowlist.`);
      await load();
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : String(err));
    } finally { setMcpBusy(false); }
  };

  const removeMcpHost = async (entry: McpAllowlistEntry) => {
    const isLast = mcpAllow.length === 1;
    if (!window.confirm(isLast
      ? `Remove "${entry.host}" — the last entry?\n\nThis returns the workspace to OPEN: any public MCP server could then be connected. Private and loopback addresses stay blocked either way.`
      : `Remove "${entry.host}"? Servers on that host can no longer be connected or called.`)) return;
    setMcpBusy(true); setMcpError(null);
    try {
      await removeMcpAllowlistHost(entry.id);
      setLastChange(`${entry.host} removed from the MCP server allowlist.`);
      await load();
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : String(err));
    } finally { setMcpBusy(false); }
  };

  // In strict mode, an already-connected MCP server whose host is NOT listed is
  // silently refused server-side — surface it rather than let it fail quietly.
  const blockedMcpConnectors = mcpAllow.length === 0 ? [] : connectors.filter(c => {
    if (c.provider !== 'mcp') return false;
    const host = normalizeMcpHost(String((c.config as Record<string, unknown> | null)?.mcp_url ?? c.base_url ?? ''));
    return !!host && !mcpAllow.some(e => e.host === host);
  });

  if (loading) {
    return (
      <div className="p-6">
        <PageHeader title="Data Access" subtitle="Which digital employee or specialist may touch which connected system." />
        <LiveLoadingSkeleton rows={4} />
      </div>
    );
  }

  return (
    <div className="p-6">
      <PageHeader
        title="Data Access"
        subtitle="Default-deny: a digital employee or specialist can only touch a connected system you grant here. Enforced on the server, on every call."
      />
      {error && <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 mb-4 text-xs text-red-300">{error}</div>}
      {lastChange && <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl px-4 py-3 mb-4 text-xs text-emerald-300">{lastChange}</div>}

      {/* Permission ladder legend */}
      <div className="rounded-2xl border border-dt-border bg-dt-card p-5 mb-6">
        <h3 className="text-sm font-semibold text-white mb-2">How permissions work</h3>
        <p className="text-[11px] text-dt-muted mb-3">
          Permissions stack — each level includes everything below it. A system-specific setting beats the category default.
          No setting at all means <span className="text-dt-support">no access</span> — that is the default for everything.
        </p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          {(['none', ...PERMS] as const).map((p) => (
            <div key={p} className="rounded-xl border border-dt-border bg-dt-inset p-3">
              <p className="text-xs font-medium text-white mb-1">{PERMISSION_LABELS[p]}</p>
              <p className="text-[10px] text-dt-muted leading-relaxed">{PERMISSION_EXPLAIN[p]}</p>
            </div>
          ))}
        </div>
      </div>

      {subjects.length === 0 ? (
        <div className="mb-6">
          <LiveEmptyState icon="◎" title="No digital employees or specialists yet" body="Hire one and its access rules appear here." />
        </div>
      ) : (
        <>
          {/* 1. Category defaults */}
          <div className="rounded-2xl border border-dt-border bg-dt-card p-5 mb-6">
            <h3 className="text-sm font-semibold text-white mb-1">Category defaults</h3>
            <p className="text-[11px] text-dt-muted mb-3">
              "May read any helpdesk system" — applies to every connected system of that kind, current and future.
              Financial, billing and payroll categories are never granted by default.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[900px]">
                <thead>
                  <tr>
                    <th className="text-left text-[10px] font-medium text-dt-muted uppercase tracking-wider px-3 py-2">Who</th>
                    {CATEGORIES.map((cat) => (
                      <th key={cat} className="text-left text-[10px] font-medium uppercase tracking-wider px-2 py-2" title={CATEGORY_LABELS[cat]}>
                        <span className={SENSITIVE.has(cat) ? 'text-amber-400' : 'text-dt-muted'}>
                          {CAT_SHORT[cat]}{SENSITIVE.has(cat) ? ' ⚠' : ''}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {subjects.map((s) => (
                    <tr key={`${s.kind}:${s.id}`} className="border-t border-dt-border">
                      <td className="px-3 py-2 whitespace-nowrap">
                        <p className="text-xs font-medium text-white">{s.name}</p>
                        <p className="text-[10px] text-dt-muted">{s.detail}</p>
                      </td>
                      {CATEGORIES.map((cat) => {
                        const cur = categoryGrant(s, cat) ?? 'none';
                        const key = `${s.kind}:${s.id}:cat:${cat}`;
                        return (
                          <td key={cat} className="px-2 py-2">
                            <select
                              className={selectCls}
                              value={cur}
                              disabled={savingCell === key}
                              title={PERMISSION_EXPLAIN[cur as AccessPermission] ?? PERMISSION_EXPLAIN.none}
                              onChange={(e) => void changeCategory(s, cat, e.target.value)}
                            >
                              <option value="none">None</option>
                              {PERMS.map((p) => <option key={p} value={p}>{PERMISSION_LABELS[p]}</option>)}
                            </select>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* 2. Per-system overrides */}
          <div className="rounded-2xl border border-dt-border bg-dt-card p-5 mb-6">
            <h3 className="text-sm font-semibold text-white mb-1">Connected systems — per-system overrides</h3>
            <p className="text-[11px] text-dt-muted mb-3">
              A setting here beats the category default for that one system. "Inherit" falls back to the category default
              (or to no access when none is set).
            </p>
            {connectors.length === 0 ? (
              <LiveEmptyState icon="⇄" title="No systems connected yet" body="Connect one in Systems → Connectors and it appears here." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[700px]">
                  <thead>
                    <tr>
                      <th className="text-left text-[10px] font-medium text-dt-muted uppercase tracking-wider px-3 py-2">Who</th>
                      {connectors.map((c) => (
                        <th key={c.id} className="text-left text-[10px] font-medium text-dt-muted uppercase tracking-wider px-2 py-2">
                          <span className="text-dt-support normal-case">{c.display_name || c.provider}</span>
                          <span className="block text-dt-faint normal-case font-normal">{CAT_SHORT[c.category] ?? c.category}</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {subjects.map((s) => (
                      <tr key={`${s.kind}:${s.id}`} className="border-t border-dt-border">
                        <td className="px-3 py-2 whitespace-nowrap">
                          <p className="text-xs font-medium text-white">{s.name}</p>
                          <p className="text-[10px] text-dt-muted">{s.detail}</p>
                        </td>
                        {connectors.map((c) => {
                          const override = connectorOverride(s, c.id);
                          const eff = effectiveGrant(grants, s, c.id, c.category);
                          const key = `${s.kind}:${s.id}:conn:${c.id}`;
                          return (
                            <td key={c.id} className="px-2 py-2">
                              <select
                                className={selectCls}
                                value={override ?? 'inherit'}
                                disabled={savingCell === key}
                                title={override
                                  ? PERMISSION_EXPLAIN[override]
                                  : eff.permission
                                    ? `Inherits "${PERMISSION_LABELS[eff.permission]}" from the ${CAT_SHORT[c.category] ?? c.category} category default.`
                                    : 'No grant anywhere — all access to this system is refused (default-deny).'}
                                onChange={(e) => void changeConnector(s, c, e.target.value)}
                              >
                                <option value="inherit">
                                  {eff.via === 'category' && eff.permission ? `Inherit (${PERMISSION_LABELS[eff.permission]})` : 'Inherit (no access)'}
                                </option>
                                {PERMS.map((p) => <option key={p} value={p}>{PERMISSION_LABELS[p]}</option>)}
                              </select>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {/* Recent denials */}
      <div className="rounded-2xl border border-rose-500/20 bg-rose-500/5 p-5 mb-6">
        <h3 className="text-sm font-semibold text-white mb-1">Recent denials</h3>
        <p className="text-[11px] text-dt-muted mb-3">
          Every refused request is recorded in the audit trail. If a digital employee keeps hitting a wall it genuinely needs,
          grant it above — if it doesn't need it, the wall is doing its job.
        </p>
        {denials.length === 0 ? (
          <LiveEmptyState icon="◇" title="No denials recorded" body="Nothing has been refused yet." />
        ) : (
          <div className="space-y-1.5">
            {denials.map((d) => (
              <div key={d.id} className="rounded-xl border border-dt-border bg-dt-inset px-3 py-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-300">denied</span>
                  <span className="text-xs text-dt-support">{d.detail.connector_label ?? 'connected system'}</span>
                  {d.detail.op && <span className="text-[10px] text-dt-muted font-mono">{d.detail.op}</span>}
                  {d.detail.needed && (
                    <span className="text-[10px] text-dt-muted">
                      needed {d.detail.needed}, had {d.detail.has ?? 'no grant'}
                    </span>
                  )}
                  <span className="text-[10px] text-dt-faint ml-auto whitespace-nowrap">{fmtDate(d.created_at)}</span>
                </div>
                <p className="text-[11px] text-dt-muted mt-0.5">{d.action}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* MCP server allowlist — which MCP servers may be connected at all */}
      <div className="rounded-2xl border border-dt-border bg-dt-card p-5">
        <div className="flex items-start justify-between gap-3 flex-wrap mb-1">
          <h3 className="text-sm font-semibold text-white">MCP servers this workspace will talk to</h3>
          <span className={`text-[10px] px-2 py-0.5 rounded ${mcpAllow.length === 0 ? 'bg-amber-500/15 text-amber-300' : 'bg-emerald-500/15 text-emerald-300'}`}>
            {mcpAllow.length === 0 ? 'Open — any public MCP server' : `Restricted — ${mcpAllow.length} server${mcpAllow.length === 1 ? '' : 's'}`}
          </span>
        </div>
        <p className="text-[11px] text-dt-muted mb-3">
          An MCP server exposes tools your digital employees can use. Whichever mode you are in, private, loopback
          and link-local addresses are always refused, and every tool a server exposes still runs through the
          approval gate — anything not explicitly read-only needs a human.
        </p>

        {mcpError && <p className="text-[11px] text-red-300 mb-2">{mcpError}</p>}

        {mcpAllow.length === 0 ? (
          <p className="text-[11px] text-dt-muted mb-3">
            No servers listed, so <span className="text-amber-300">any public MCP server may be connected</span>.
            Add one below to switch this workspace to strict mode, where only the servers you list are allowed.
          </p>
        ) : (
          <div className="space-y-1.5 mb-3">
            {mcpAllow.map(e => (
              <div key={e.id} className="flex items-center gap-2 rounded-lg border border-dt-border bg-dt-inset px-3 py-2">
                <span className="text-xs text-white font-mono">{e.host}</span>
                {e.note && <span className="text-[11px] text-dt-muted truncate">{e.note}</span>}
                <span className="text-[10px] text-dt-faint ml-auto whitespace-nowrap">{fmtDate(e.created_at)}</span>
                <button disabled={mcpBusy} onClick={() => void removeMcpHost(e)}
                  className="text-[11px] text-red-400 hover:text-red-300 disabled:opacity-50">Remove</button>
              </div>
            ))}
          </div>
        )}

        {blockedMcpConnectors.length > 0 && (
          <p className="text-[11px] text-amber-300 mb-3">
            ⚠ {blockedMcpConnectors.length} connected MCP server{blockedMcpConnectors.length === 1 ? ' is' : 's are'} not on this list
            ({blockedMcpConnectors.map(c => c.display_name || c.base_url).join(', ')}) — calls to {blockedMcpConnectors.length === 1 ? 'it' : 'them'} are refused until you add the host.
          </p>
        )}

        <div className="flex gap-2 flex-wrap items-end">
          <div className="flex-1 min-w-[180px]">
            <label className="block text-[11px] text-dt-support mb-1">Server hostname</label>
            <input value={mcpHostInput} onChange={e => setMcpHostInput(e.target.value)} placeholder="mcp.example.com"
              className="w-full bg-dt-page border border-dt-border-strong rounded-lg text-xs text-white px-3 py-2 focus:outline-none focus:border-indigo-500" />
          </div>
          <div className="flex-1 min-w-[180px]">
            <label className="block text-[11px] text-dt-support mb-1">Note (optional)</label>
            <input value={mcpNoteInput} onChange={e => setMcpNoteInput(e.target.value)} placeholder="what this server is for"
              className="w-full bg-dt-page border border-dt-border-strong rounded-lg text-xs text-white px-3 py-2 focus:outline-none focus:border-indigo-500" />
          </div>
          <button disabled={mcpBusy || !mcpHostInput.trim()} onClick={() => void addMcpHost()}
            className="px-3 py-2 rounded-lg text-xs bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50 transition-colors">
            {mcpBusy ? 'Saving…' : 'Allow this server'}
          </button>
        </div>
        <p className="text-[10px] text-dt-faint mt-2">
          Paste a hostname or a full URL — only the host is stored, because that is what the rule matches on.
          Only a workspace owner or admin can change this list.
        </p>
      </div>

      {/* Honest limits */}
      <div className="rounded-2xl border border-dt-border bg-dt-card p-5">
        <h3 className="text-sm font-semibold text-white mb-2">What this does and doesn't cover (honest)</h3>
        <ul className="text-[11px] text-dt-muted space-y-1.5 list-disc pl-4">
          <li><span className="text-dt-support">Covered:</span> every machine-driven call to a connected system — the evidence pipeline, playbook connector steps, and Scribe write-backs — is checked server-side on every request.</li>
          <li><span className="text-dt-support">Humans are separate:</span> your own clicks in the connector wizard (test, health check, dry run) are governed by workspace roles, not this matrix.</li>
          <li><span className="text-dt-support">Internal knowledge is workspace-wide (v1):</span> documents uploaded to DreamTeam knowledge are readable by every DE and specialist. Named upgrade: per-DE knowledge scopes.</li>
          <li><span className="text-dt-support">Write-back grants don't skip approvals:</span> a write still goes through the existing human gates — the grant only decides whether the request may exist at all.</li>
        </ul>
      </div>
    </div>
  );
}
