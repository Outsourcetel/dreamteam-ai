import React, { useCallback, useEffect, useState } from 'react';
import { LiveLoadingSkeleton, LiveEmptyState } from '../../../components/LiveDataStates';
import { CustomerApiError } from '../../../lib/customerApi';
import {
  Connector, ConnectorObject, ConnectorAction, ConnectorObjectMode,
  listConnectors, listConnectorObjects, listConnectorActions,
  connectZendesk, testConnector, syncTickets, readThroughTicket,
  updateConnectorObject, updateConnectorAction, disconnectConnector,
  connectorErrorLabel, fmtSince,
} from '../../../lib/connectorApi';

// ============================================================
// Live Connectors page (R2) — Systems-of-Record connector layer.
// Connect flow → per-object mode table (sync / read_through) →
// write-back action registry → sync-now → read-through demo →
// disconnect (credential purge).
// ============================================================

function statusChip(status: Connector['status']) {
  const map = {
    connected: ['bg-emerald-400', 'text-emerald-400', 'Connected'],
    error: ['bg-red-400', 'text-red-400', 'Error'],
    disconnected: ['bg-slate-600', 'text-slate-500', 'Disconnected'],
  } as const;
  const [dot, text, label] = map[status];
  return (
    <span className="flex items-center gap-1.5">
      <span className={`inline-block w-2 h-2 rounded-full ${dot}`} />
      <span className={`text-xs ${text}`}>{label}</span>
    </span>
  );
}

const OBJECT_LABELS: Record<string, string> = { ticket: 'Tickets', user: 'Users', organization: 'Organizations' };
const ACTION_LABELS: Record<string, string> = {
  add_internal_note: 'Add internal note',
  update_status: 'Update ticket status',
};

export default function LiveConnectorsPage() {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [objects, setObjects] = useState<Record<string, ConnectorObject[]>>({});
  const [actions, setActions] = useState<Record<string, ConnectorAction[]>>({});
  const [loading, setLoading] = useState(true);
  const [missingTables, setMissingTables] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [showConnect, setShowConnect] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // connector id being acted on

  // Connect form
  const [fSubdomain, setFSubdomain] = useState('');
  const [fEmail, setFEmail] = useState('');
  const [fToken, setFToken] = useState('');
  const [fName, setFName] = useState('');
  const [connectBusy, setConnectBusy] = useState(false);
  const [connectErr, setConnectErr] = useState<string | null>(null);

  // Read-through demo
  const [rtRef, setRtRef] = useState('');
  const [rtResult, setRtResult] = useState<{ connectorId: string; ticket: Record<string, unknown> } | null>(null);
  const [rtErr, setRtErr] = useState<string | null>(null);

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 5000); };

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const conns = await listConnectors();
      setConnectors(conns);
      const objMap: Record<string, ConnectorObject[]> = {};
      const actMap: Record<string, ConnectorAction[]> = {};
      await Promise.all(conns.map(async (c) => {
        [objMap[c.id], actMap[c.id]] = await Promise.all([
          listConnectorObjects(c.id), listConnectorActions(c.id),
        ]);
      }));
      setObjects(objMap);
      setActions(actMap);
      setError(null);
      setMissingTables(false);
    } catch (e) {
      if (e instanceof CustomerApiError && e.missingTables) setMissingTables(true);
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const doConnect = async () => {
    setConnectErr(null);
    const sub = fSubdomain.trim();
    if (!sub || !fEmail.trim() || !fToken.trim()) {
      setConnectErr('Subdomain, email, and API token are all required.');
      return;
    }
    const baseUrl = sub.startsWith('http') ? sub : `https://${sub.replace(/\.zendesk\.com.*$/, '')}.zendesk.com`;
    setConnectBusy(true);
    try {
      const { test } = await connectZendesk({
        displayName: fName.trim() || 'Zendesk',
        baseUrl, email: fEmail, apiToken: fToken,
      });
      setShowConnect(false);
      setFSubdomain(''); setFEmail(''); setFToken(''); setFName('');
      showToast(test.ok
        ? 'Zendesk connected — credentials verified.'
        : `Saved, but the test failed: ${connectorErrorLabel(test.error)}`);
      await load();
    } catch (e) {
      setConnectErr(e instanceof Error ? e.message : String(e));
    } finally {
      setConnectBusy(false);
    }
  };

  const doTest = async (c: Connector) => {
    setBusy(c.id);
    try {
      const r = await testConnector(c.id);
      showToast(r.ok ? 'Connection healthy.' : `Test failed: ${connectorErrorLabel(r.error)}`);
      await load();
    } finally { setBusy(null); }
  };

  const doSync = async (c: Connector) => {
    setBusy(c.id);
    try {
      const r = await syncTickets(c.id);
      showToast(r.ok
        ? `Sync complete — ${r.pulled ?? 0} pulled, ${r.upserted ?? 0} upserted into the working cache.`
        : `Sync failed: ${connectorErrorLabel(r.error)}`);
      await load();
    } finally { setBusy(null); }
  };

  const doReadThrough = async (c: Connector) => {
    setRtErr(null); setRtResult(null);
    if (!rtRef.trim()) { setRtErr('Enter a Zendesk ticket number.'); return; }
    setBusy(c.id);
    try {
      const r = await readThroughTicket(c.id, rtRef.trim());
      if (r.ok && r.ticket) setRtResult({ connectorId: c.id, ticket: r.ticket });
      else setRtErr(connectorErrorLabel(r.error));
    } finally { setBusy(null); }
  };

  const doDisconnect = async (c: Connector) => {
    if (!window.confirm(`Disconnect ${c.display_name || 'Zendesk'}? The stored credential is purged immediately; synced tickets remain as a working cache.`)) return;
    setBusy(c.id);
    try {
      await disconnectConnector(c);
      showToast('Disconnected — credential purged.');
      await load();
    } finally { setBusy(null); }
  };

  const setObjField = async (o: ConnectorObject, updates: Partial<Pick<ConnectorObject, 'mode' | 'sync_interval_mins' | 'enabled'>>) => {
    const next = await updateConnectorObject(o.id, updates);
    setObjects(prev => ({
      ...prev,
      [o.connector_id]: (prev[o.connector_id] ?? []).map(x => x.id === next.id ? next : x),
    }));
  };

  const toggleAction = async (a: ConnectorAction) => {
    const next = await updateConnectorAction(a.id, !a.enabled);
    setActions(prev => ({
      ...prev,
      [a.connector_id]: (prev[a.connector_id] ?? []).map(x => x.id === next.id ? next : x),
    }));
  };

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <div className="mb-5 flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Connectors</h1>
          <p className="text-slate-400 text-sm mt-1">
            Your systems of record stay yours — DreamTeam syncs a working copy or reads through live, and writes actions back into the source system.
          </p>
        </div>
        {connectors.length > 0 && (
          <button onClick={() => setShowConnect(true)} className="bg-indigo-600 hover:bg-indigo-500 text-white text-sm px-4 py-2 rounded-lg transition-colors">
            + Connect a system
          </button>
        )}
      </div>

      {toast && <div className="mb-4 rounded-xl border border-indigo-500/40 bg-indigo-500/10 px-4 py-3 text-xs text-indigo-200">{toast}</div>}
      {error && <div className="mb-4 rounded-xl border border-rose-800/50 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">{error}</div>}

      {loading ? (
        <LiveLoadingSkeleton rows={4} />
      ) : missingTables ? (
        <div className="rounded-xl border border-slate-700 bg-slate-900/80 p-5">
          <p className="text-sm font-medium text-slate-200 mb-1">Connector tables not yet provisioned</p>
          <p className="text-xs text-slate-400">
            Run <code className="text-slate-300 bg-slate-800 px-1 py-0.5 rounded">supabase/migrations/017_connectors.sql</code> in the Supabase SQL Editor, then reload.
          </p>
        </div>
      ) : connectors.length === 0 ? (
        <>
          <LiveEmptyState
            icon="⇄"
            title="Connect your first system"
            body="Your systems of record stay yours; DreamTeam works on top — syncing a working copy, reading through live, and writing every action back into the source system with a full audit trail."
            primaryLabel="Connect Zendesk"
            onPrimary={() => setShowConnect(true)}
          />
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-6">
            <button onClick={() => setShowConnect(true)} className="text-left bg-slate-900 border border-slate-800 hover:border-indigo-500/50 rounded-xl p-4 transition-colors">
              <p className="text-sm font-semibold text-white">Zendesk</p>
              <p className="text-[11px] text-slate-500 mt-0.5">Support · tickets sync + write-back</p>
              <p className="text-xs text-indigo-400 mt-2">Connect →</p>
            </button>
            {['Zuora', 'Salesforce', 'Workday'].map(n => (
              <div key={n} className="bg-slate-900/50 border border-slate-800/60 rounded-xl p-4 opacity-50">
                <p className="text-sm font-semibold text-slate-400">{n}</p>
                <p className="text-[11px] text-slate-600 mt-0.5">Coming soon</p>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="space-y-6">
          {connectors.map(c => {
            const objs = objects[c.id] ?? [];
            const acts = actions[c.id] ?? [];
            const isBusy = busy === c.id;
            return (
              <div key={c.id} className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
                {/* Header */}
                <div className="flex items-start justify-between flex-wrap gap-3 mb-4">
                  <div>
                    <div className="flex items-center gap-3">
                      <h2 className="text-base font-semibold text-white">{c.display_name || 'Zendesk'}</h2>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 uppercase tracking-wide">{c.provider}</span>
                      {statusChip(c.status)}
                    </div>
                    <p className="text-xs text-slate-500 mt-1">{c.base_url} · last sync {fmtSince(c.last_sync_at)}</p>
                    {c.last_error && <p className="text-xs text-red-300 mt-1">{connectorErrorLabel(c.last_error)}</p>}
                  </div>
                  <div className="flex gap-2">
                    <button disabled={isBusy} onClick={() => void doTest(c)} className="px-3 py-1.5 rounded-lg text-xs text-slate-300 border border-slate-700 hover:border-slate-500 disabled:opacity-50 transition-colors">
                      Test connection
                    </button>
                    <button disabled={isBusy || c.status === 'disconnected'} onClick={() => void doSync(c)} className="px-3 py-1.5 rounded-lg text-xs bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50 transition-colors">
                      {isBusy ? 'Working…' : 'Sync now'}
                    </button>
                    <button disabled={isBusy} onClick={() => void doDisconnect(c)} className="px-3 py-1.5 rounded-lg text-xs text-red-400 border border-red-500/30 hover:bg-red-600/20 disabled:opacity-50 transition-colors">
                      Disconnect
                    </button>
                  </div>
                </div>

                {/* Objects: per-object data mode */}
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">Objects — data mode</p>
                <div className="rounded-xl border border-slate-800 overflow-hidden mb-4">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-950/60">
                      <tr>
                        {['Object', 'Mode', 'Interval', 'Last synced', 'Enabled'].map(h => (
                          <th key={h} className="py-2 px-3 text-left text-[11px] uppercase tracking-wide text-slate-500 font-medium">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {objs.map(o => (
                        <tr key={o.id} className="border-t border-slate-800/60">
                          <td className="py-2 px-3 text-slate-200">{OBJECT_LABELS[o.object_type] ?? o.object_type}</td>
                          <td className="py-2 px-3">
                            <select
                              value={o.mode}
                              onChange={e => void setObjField(o, { mode: e.target.value as ConnectorObjectMode })}
                              className="bg-slate-950 border border-slate-700 rounded-lg text-xs text-slate-200 px-2 py-1"
                            >
                              <option value="sync">Sync (cached working copy)</option>
                              <option value="read_through">Read-through (never stored)</option>
                            </select>
                          </td>
                          <td className="py-2 px-3">
                            {o.mode === 'sync' ? (
                              <select
                                value={o.sync_interval_mins}
                                onChange={e => void setObjField(o, { sync_interval_mins: Number(e.target.value) })}
                                className="bg-slate-950 border border-slate-700 rounded-lg text-xs text-slate-200 px-2 py-1"
                              >
                                {[15, 30, 60, 240, 1440].map(m => (
                                  <option key={m} value={m}>{m < 60 ? `${m} min` : m === 60 ? '1 hr' : m === 240 ? '4 hrs' : 'Daily'}</option>
                                ))}
                              </select>
                            ) : <span className="text-xs text-slate-600">at action time</span>}
                          </td>
                          <td className="py-2 px-3 text-xs text-slate-400">{o.mode === 'sync' ? fmtSince(o.last_synced_at) : '—'}</td>
                          <td className="py-2 px-3">
                            <button
                              onClick={() => void setObjField(o, { enabled: !o.enabled })}
                              className={`text-xs px-2 py-0.5 rounded-full transition-colors ${o.enabled ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-500'}`}
                            >
                              {o.enabled ? 'Enabled' : 'Disabled'}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Write-back registry */}
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">Write-back actions — into the system of record</p>
                <div className="flex flex-wrap gap-2 mb-4">
                  {acts.map(a => (
                    <button
                      key={a.id}
                      onClick={() => void toggleAction(a)}
                      className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${a.enabled
                        ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300'
                        : 'border-slate-700 bg-slate-900 text-slate-500'}`}
                    >
                      {ACTION_LABELS[a.action_key] ?? a.action_key} · {a.enabled ? 'on' : 'off'}
                    </button>
                  ))}
                </div>

                {/* Read-through demo */}
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">Read-through demo</p>
                <div className="flex items-center gap-2 flex-wrap">
                  <input
                    value={rtRef}
                    onChange={e => setRtRef(e.target.value)}
                    placeholder="Zendesk ticket #"
                    className="bg-slate-950 border border-slate-700 rounded-lg text-xs text-slate-200 px-3 py-1.5 w-40"
                  />
                  <button disabled={isBusy} onClick={() => void doReadThrough(c)} className="px-3 py-1.5 rounded-lg text-xs text-slate-300 border border-slate-700 hover:border-slate-500 disabled:opacity-50 transition-colors">
                    Fetch live
                  </button>
                  <span className="text-[11px] text-slate-600">Fetched from Zendesk at action time — nothing stored, audit event only.</span>
                </div>
                {rtErr && <p className="text-xs text-red-300 mt-2">{rtErr}</p>}
                {rtResult?.connectorId === c.id && (
                  <pre className="mt-3 max-h-64 overflow-auto rounded-xl border border-slate-800 bg-slate-950 p-3 text-[11px] text-slate-300">
                    {JSON.stringify(rtResult.ticket, null, 2)}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Connect modal */}
      {showConnect && (
        <>
          <div className="fixed inset-0 z-40 bg-slate-950/70" onClick={() => !connectBusy && setShowConnect(false)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-8 pointer-events-none">
            <div className="pointer-events-auto w-full max-w-md bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl p-6">
              <h2 className="text-sm font-semibold text-white mb-1">Connect Zendesk</h2>
              <p className="text-xs text-slate-500 mb-4">Zendesk remains your ticket system of record. DreamTeam syncs a working copy and writes actions back.</p>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Zendesk subdomain or URL</label>
                  <input value={fSubdomain} onChange={e => setFSubdomain(e.target.value)} placeholder="acme  or  https://acme.zendesk.com"
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg text-sm text-slate-200 px-3 py-2" />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Admin email</label>
                  <input value={fEmail} onChange={e => setFEmail(e.target.value)} placeholder="admin@acme.com" type="email"
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg text-sm text-slate-200 px-3 py-2" />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">API token</label>
                  <input value={fToken} onChange={e => setFToken(e.target.value)} type="password" placeholder="••••••••••••"
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg text-sm text-slate-200 px-3 py-2" />
                  <p className="text-[11px] text-slate-600 mt-1">Stored encrypted, never shown again. Purged instantly on disconnect.</p>
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Display name (optional)</label>
                  <input value={fName} onChange={e => setFName(e.target.value)} placeholder="Zendesk — Support"
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg text-sm text-slate-200 px-3 py-2" />
                </div>
              </div>
              {connectErr && <p className="text-xs text-red-300 mt-3">{connectErr}</p>}
              <div className="flex gap-3 mt-5">
                <button disabled={connectBusy} onClick={() => setShowConnect(false)} className="flex-1 px-3 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 text-xs transition-colors disabled:opacity-50">
                  Cancel
                </button>
                <button disabled={connectBusy} onClick={() => void doConnect()} className="flex-1 px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs transition-colors disabled:opacity-50">
                  {connectBusy ? 'Testing…' : 'Test & Save'}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
