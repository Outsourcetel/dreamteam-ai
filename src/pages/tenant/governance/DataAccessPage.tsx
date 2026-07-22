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

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [subs, grs, conns, dens] = await Promise.all([
        listAccessSubjects(), listAccessGrants(),
        listConnectors().catch(() => [] as Connector[]),
        listRecentDenials().catch(() => [] as AccessDenialEvent[]),
      ]);
      setSubjects(subs); setGrants(grs); setConnectors(conns); setDenials(dens);
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
