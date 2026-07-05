import React, { useCallback, useEffect, useState } from 'react';
import { LiveLoadingSkeleton, LiveEmptyState } from '../../../components/LiveDataStates';
import { CustomerApiError } from '../../../lib/customerApi';
import {
  Connector, ConnectorObject, ConnectorAction, ConnectorObjectMode,
  ConnectorProvider, ConnectorRole, ConnectorAccessMode, HubItem,
  PROVIDERS, CONNECTOR_ROLE_LABELS, ACCESS_MODE_EXPLAIN,
  listConnectors, listConnectorObjects, listConnectorActions,
  connectProvider, hubTest, hubSearch, hubSync, syncTickets,
  updateConnectorObject, updateConnectorAction, disconnectConnector,
  connectorErrorLabel, fmtSince,
} from '../../../lib/connectorApi';

// ============================================================
// Live Connectors page — Multi-System Connector Hub.
// Provider wizard (Salesforce / Confluence / Jira / Intercom /
// Zendesk / your own product API) → role + access-mode choice →
// server-side secrets → live test → read-through search demo →
// knowledge sync for ingest-mode knowledge systems.
// Plain-language doctrine: your systems stay yours; fetch-only means
// we look at your data to answer and never store it.
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
const ROLE_SHORT: Record<ConnectorRole, string> = {
  product_system: 'Product system', crm: 'CRM', support_desk: 'Support desk',
  knowledge_base: 'Knowledge base', other: 'Other',
};
const PROVIDER_ICON: Record<ConnectorProvider, string> = {
  zendesk: '🎫', salesforce: '☁️', confluence: '📘', jira: '🧩',
  intercom: '💬', generic_rest: '🔌', sharepoint: '📁',
};

const inputCls = 'w-full bg-slate-950 border border-slate-700 rounded-lg text-sm text-slate-200 px-3 py-2';
const selectCls = 'bg-slate-950 border border-slate-700 rounded-lg text-xs text-slate-200 px-2 py-1.5';

// ── Connect wizard ────────────────────────────────────────────────

function ConnectWizard({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => void }) {
  const [provider, setProvider] = useState<ConnectorProvider | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<ConnectorRole>('other');
  const [accessMode, setAccessMode] = useState<ConnectorAccessMode>('fetch_only');
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  // generic_rest endpoint config
  const [searchPath, setSearchPath] = useState('');
  const [queryParam, setQueryParam] = useState('q');
  const [itemsPath, setItemsPath] = useState('');
  const [recordPath, setRecordPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const meta = provider ? PROVIDERS[provider] : null;

  const pick = (p: ConnectorProvider) => {
    setProvider(p);
    setRole(PROVIDERS[p].defaultRole);
    setAccessMode(PROVIDERS[p].knowledgeSync ? 'ingest' : 'fetch_only');
    setSecrets({});
    setErr(null);
  };

  const submit = async () => {
    if (!provider || !meta) return;
    setErr(null);
    if (!baseUrl.trim()) { setErr(`${meta.baseUrlLabel} is required.`); return; }
    if (provider === 'generic_rest' && !searchPath.trim()) { setErr('A search endpoint path is required so DreamTeam knows how to look things up.'); return; }
    setBusy(true);
    try {
      const config = provider === 'generic_rest' ? {
        endpoints: {
          search: { path: searchPath.trim(), query_param: queryParam.trim() || undefined, items_path: itemsPath.trim() || undefined },
          ...(recordPath.trim() ? { record: { path_template: recordPath.trim() } } : {}),
        },
      } : {};
      const { test } = await connectProvider({
        provider, displayName: name, baseUrl, role, accessMode, secrets, config,
      });
      onDone(test.ok
        ? `${meta.label} connected — credentials verified live${test.detail ? ` (${test.detail})` : ''}.`
        : `${meta.label} saved, but the live test failed: ${connectorErrorLabel(test.error)}`);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-slate-950/70" onClick={() => !busy && onClose()} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-6 pointer-events-none">
        <div className="pointer-events-auto w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl p-6">
          {!provider ? (
            <>
              <h2 className="text-sm font-semibold text-white mb-1">Connect a system</h2>
              <p className="text-xs text-slate-500 mb-4">Your systems stay yours — DreamTeam works on top of them. Pick what you want your Digital Employees to be able to consult.</p>
              <div className="grid grid-cols-2 gap-2">
                {(Object.keys(PROVIDERS) as ConnectorProvider[]).map(p => (
                  <button key={p} onClick={() => pick(p)}
                    className={`text-left rounded-xl border p-3 transition-colors ${PROVIDERS[p].implemented ? 'bg-slate-950 border-slate-800 hover:border-indigo-500/50' : 'bg-slate-950/50 border-slate-800/60'}`}>
                    <p className="text-sm font-semibold text-white">{PROVIDER_ICON[p]} {PROVIDERS[p].label}</p>
                    <p className="text-[11px] text-slate-500 mt-0.5">{PROVIDERS[p].tagline}</p>
                    {!PROVIDERS[p].implemented && <p className="text-[10px] text-amber-400 mt-1">Registers now — adapter not built yet (honest)</p>}
                  </button>
                ))}
              </div>
              <button onClick={onClose} className="mt-4 text-xs text-slate-400 hover:text-white">Cancel</button>
            </>
          ) : (
            <>
              <button onClick={() => setProvider(null)} className="text-xs text-slate-500 hover:text-white mb-2">← All systems</button>
              <h2 className="text-sm font-semibold text-white mb-1">Connect {meta!.label}</h2>
              <p className="text-xs text-slate-500 mb-4">{meta!.tagline}</p>

              <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 mb-4">
                <p className="text-[11px] font-medium text-slate-400 mb-1">How to get credentials</p>
                <p className="text-[11px] text-slate-500 leading-relaxed">{meta!.help}</p>
              </div>

              <div className="space-y-3">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">{meta!.baseUrlLabel}</label>
                  <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder={meta!.baseUrlPlaceholder} className={inputCls} />
                </div>
                {meta!.fields.map(f => (
                  <div key={f.key}>
                    <label className="block text-xs text-slate-400 mb-1">{f.label}</label>
                    <input value={secrets[f.key] ?? ''} onChange={e => setSecrets(s => ({ ...s, [f.key]: e.target.value }))}
                      type={f.secret ? 'password' : 'text'} placeholder={f.placeholder} className={inputCls} />
                  </div>
                ))}
                {meta!.fields.some(f => f.secret) && (
                  <p className="text-[11px] text-slate-600">Credentials are stored server-side only — never shown again, never readable from the browser, purged instantly on disconnect.</p>
                )}

                {provider === 'generic_rest' && (
                  <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 space-y-2">
                    <p className="text-[11px] font-medium text-slate-400">Tell DreamTeam how to search this API</p>
                    <div className="flex gap-2">
                      <div className="flex-1">
                        <label className="block text-[11px] text-slate-500 mb-1">Search path</label>
                        <input value={searchPath} onChange={e => setSearchPath(e.target.value)} placeholder="/users" className={inputCls} />
                      </div>
                      <div className="w-28">
                        <label className="block text-[11px] text-slate-500 mb-1">Query param</label>
                        <input value={queryParam} onChange={e => setQueryParam(e.target.value)} placeholder="q" className={inputCls} />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <div className="flex-1">
                        <label className="block text-[11px] text-slate-500 mb-1">Items path in the response (optional, e.g. data.results)</label>
                        <input value={itemsPath} onChange={e => setItemsPath(e.target.value)} placeholder="leave empty if the response is a list" className={inputCls} />
                      </div>
                      <div className="flex-1">
                        <label className="block text-[11px] text-slate-500 mb-1">Record path (optional, {'{ref}'} = id)</label>
                        <input value={recordPath} onChange={e => setRecordPath(e.target.value)} placeholder="/users/{ref}" className={inputCls} />
                      </div>
                    </div>
                  </div>
                )}

                <div>
                  <label className="block text-xs text-slate-400 mb-1">What is this system to your business?</label>
                  <select value={role} onChange={e => setRole(e.target.value as ConnectorRole)} className={selectCls + ' w-full !py-2 !text-sm'}>
                    {(Object.keys(CONNECTOR_ROLE_LABELS) as ConnectorRole[]).map(r => (
                      <option key={r} value={r}>{CONNECTOR_ROLE_LABELS[r]}</option>
                    ))}
                  </select>
                  <p className="text-[11px] text-slate-600 mt-1">The evidence pipeline routes by this: product systems answer "how is this account configured?", knowledge bases answer "what do our docs say?", support desks answer "have we solved this before?".</p>
                </div>

                <div>
                  <label className="block text-xs text-slate-400 mb-1">Data handling — your choice</label>
                  <div className="space-y-1.5">
                    {(['fetch_only', 'ingest'] as ConnectorAccessMode[]).map(m => (
                      <label key={m} className={`flex items-start gap-2 rounded-lg border p-2 cursor-pointer ${accessMode === m ? 'border-indigo-500/50 bg-indigo-500/5' : 'border-slate-800'}`}>
                        <input type="radio" checked={accessMode === m} onChange={() => setAccessMode(m)} className="mt-0.5" />
                        <span className="text-[11px] text-slate-300 leading-relaxed">{ACCESS_MODE_EXPLAIN[m]}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-slate-400 mb-1">Display name (optional)</label>
                  <input value={name} onChange={e => setName(e.target.value)} placeholder={`${meta!.label} — production`} className={inputCls} />
                </div>
              </div>

              {err && <p className="text-xs text-red-300 mt-3">{err}</p>}
              <div className="flex gap-3 mt-5">
                <button disabled={busy} onClick={onClose} className="flex-1 px-3 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 text-xs transition-colors disabled:opacity-50">
                  Cancel
                </button>
                <button disabled={busy} onClick={() => void submit()} className="flex-1 px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs transition-colors disabled:opacity-50">
                  {busy ? 'Testing…' : meta!.implemented ? 'Test & Save' : 'Register (no adapter yet)'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

// ── Page ──────────────────────────────────────────────────────────

export default function LiveConnectorsPage() {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [objects, setObjects] = useState<Record<string, ConnectorObject[]>>({});
  const [actions, setActions] = useState<Record<string, ConnectorAction[]>>({});
  const [loading, setLoading] = useState(true);
  const [missingTables, setMissingTables] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [showConnect, setShowConnect] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  // Read-through search demo
  const [rtQuery, setRtQuery] = useState('');
  const [rtResult, setRtResult] = useState<{ connectorId: string; items: HubItem[]; latency?: number } | null>(null);
  const [rtErr, setRtErr] = useState<string | null>(null);

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 6000); };

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const conns = await listConnectors();
      setConnectors(conns);
      const objMap: Record<string, ConnectorObject[]> = {};
      const actMap: Record<string, ConnectorAction[]> = {};
      await Promise.all(conns.filter(c => c.provider === 'zendesk').map(async (c) => {
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

  const doTest = async (c: Connector) => {
    setBusy(c.id);
    try {
      const r = await hubTest(c.id);
      showToast(r.ok ? `Connection healthy${r.detail ? ` — ${r.detail}` : ''}.` : `Test failed: ${connectorErrorLabel(r.error)}`);
      await load();
    } finally { setBusy(null); }
  };

  const doKnowledgeSync = async (c: Connector) => {
    setBusy(c.id);
    try {
      const r = await hubSync(c.id);
      showToast(r.ok
        ? `Knowledge sync complete — ${r.upserted ?? 0} document(s) ingested, ${r.chunked ?? 0} passages indexed.`
        : r.error === 'sync_refused_fetch_only'
          ? 'Sync refused: this connector is fetch-only by your choice — DreamTeam reads it live and never stores its content.'
          : `Sync failed: ${connectorErrorLabel(r.error)}`);
      await load();
    } finally { setBusy(null); }
  };

  const doTicketSync = async (c: Connector) => {
    setBusy(c.id);
    try {
      const r = await syncTickets(c.id);
      showToast(r.ok
        ? `Ticket sync complete — ${r.pulled ?? 0} pulled, ${r.upserted ?? 0} upserted into the working cache.`
        : `Sync failed: ${connectorErrorLabel(r.error)}`);
      await load();
    } finally { setBusy(null); }
  };

  const doSearch = async (c: Connector) => {
    setRtErr(null); setRtResult(null);
    if (!rtQuery.trim()) { setRtErr('Type something to search for.'); return; }
    setBusy(c.id);
    try {
      const r = await hubSearch(c.id, rtQuery.trim());
      if (r.ok) setRtResult({ connectorId: c.id, items: r.items, latency: r.latency_ms });
      else setRtErr(connectorErrorLabel(r.error));
    } finally { setBusy(null); }
  };

  const doDisconnect = async (c: Connector) => {
    if (!window.confirm(`Disconnect ${c.display_name || PROVIDERS[c.provider]?.label}? The stored credential is purged immediately.`)) return;
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
            Your systems of record stay yours — DreamTeam reads them live (fetch-only) or keeps a searchable working copy (ingest), and every access is audited.
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
            Run <code className="text-slate-300 bg-slate-800 px-1 py-0.5 rounded">supabase/migrations/026_connector_hub_evidence.sql</code> in the Supabase SQL Editor, then reload.
          </p>
        </div>
      ) : connectors.length === 0 ? (
        <>
          <LiveEmptyState
            icon="⇄"
            title="Connect your first system"
            body="A Digital Employee is only as good as what it can see. Connect your product API, knowledge base, CRM, and support desk — each with your choice: fetch-only (we look, never store) or ingest (searchable working copy)."
            primaryLabel="Connect a system"
            onPrimary={() => setShowConnect(true)}
          />
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-6">
            {(Object.keys(PROVIDERS) as ConnectorProvider[]).slice(0, 8).map(p => (
              <button key={p} onClick={() => setShowConnect(true)} className="text-left bg-slate-900 border border-slate-800 hover:border-indigo-500/50 rounded-xl p-4 transition-colors">
                <p className="text-sm font-semibold text-white">{PROVIDER_ICON[p]} {PROVIDERS[p].label}</p>
                <p className="text-[11px] text-slate-500 mt-0.5">{PROVIDERS[p].tagline}</p>
                <p className="text-xs text-indigo-400 mt-2">{PROVIDERS[p].implemented ? 'Connect →' : 'Register →'}</p>
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="space-y-6">
          {connectors.map(c => {
            const objs = objects[c.id] ?? [];
            const acts = actions[c.id] ?? [];
            const isBusy = busy === c.id;
            const meta = PROVIDERS[c.provider];
            return (
              <div key={c.id} className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
                {/* Header */}
                <div className="flex items-start justify-between flex-wrap gap-3 mb-4">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <h2 className="text-base font-semibold text-white">{PROVIDER_ICON[c.provider]} {c.display_name || meta?.label || c.provider}</h2>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 uppercase tracking-wide">{c.provider.replace('_', ' ')}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300">{ROLE_SHORT[c.role] ?? c.role}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${c.access_mode === 'fetch_only' ? 'bg-teal-500/15 text-teal-300' : 'bg-purple-500/15 text-purple-300'}`}>
                        {c.access_mode === 'fetch_only' ? 'fetch-only · never stored' : 'ingest · working copy'}
                      </span>
                      {statusChip(c.status)}
                    </div>
                    <p className="text-xs text-slate-500 mt-1">{c.base_url} · last sync {fmtSince(c.last_sync_at)}</p>
                    {c.last_error && <p className="text-xs text-red-300 mt-1">{connectorErrorLabel(c.last_error)}</p>}
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    <button disabled={isBusy || !meta?.implemented} onClick={() => void doTest(c)} className="px-3 py-1.5 rounded-lg text-xs text-slate-300 border border-slate-700 hover:border-slate-500 disabled:opacity-50 transition-colors">
                      Test connection
                    </button>
                    {meta?.knowledgeSync && (
                      <button disabled={isBusy} onClick={() => void doKnowledgeSync(c)}
                        title={c.access_mode === 'fetch_only' ? 'Fetch-only connectors refuse sync server-side — try it.' : 'Ingest help articles / pages into knowledge'}
                        className="px-3 py-1.5 rounded-lg text-xs bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50 transition-colors">
                        {isBusy ? 'Working…' : 'Sync knowledge'}
                      </button>
                    )}
                    {c.provider === 'zendesk' && (
                      <button disabled={isBusy || c.status === 'disconnected'} onClick={() => void doTicketSync(c)} className="px-3 py-1.5 rounded-lg text-xs bg-slate-700 hover:bg-slate-600 text-white disabled:opacity-50 transition-colors">
                        Sync tickets
                      </button>
                    )}
                    <button disabled={isBusy} onClick={() => void doDisconnect(c)} className="px-3 py-1.5 rounded-lg text-xs text-red-400 border border-red-500/30 hover:bg-red-600/20 disabled:opacity-50 transition-colors">
                      Disconnect
                    </button>
                  </div>
                </div>

                {!meta?.implemented && (
                  <p className="text-xs text-amber-400 mb-3">Registered, but this system's adapter is not built yet — every call returns an honest "not implemented" until it ships.</p>
                )}

                {/* Zendesk-only: per-object mode + write-back registry */}
                {c.provider === 'zendesk' && objs.length > 0 && (
                  <>
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
                                <select value={o.mode}
                                  onChange={e => void setObjField(o, { mode: e.target.value as ConnectorObjectMode })}
                                  className={selectCls}>
                                  <option value="sync">Sync (cached working copy)</option>
                                  <option value="read_through">Read-through (never stored)</option>
                                </select>
                              </td>
                              <td className="py-2 px-3">
                                {o.mode === 'sync' ? (
                                  <select value={o.sync_interval_mins}
                                    onChange={e => void setObjField(o, { sync_interval_mins: Number(e.target.value) })}
                                    className={selectCls}>
                                    {[15, 30, 60, 240, 1440].map(m => (
                                      <option key={m} value={m}>{m < 60 ? `${m} min` : m === 60 ? '1 hr' : m === 240 ? '4 hrs' : 'Daily'}</option>
                                    ))}
                                  </select>
                                ) : <span className="text-xs text-slate-600">at action time</span>}
                              </td>
                              <td className="py-2 px-3 text-xs text-slate-400">{o.mode === 'sync' ? fmtSince(o.last_synced_at) : '—'}</td>
                              <td className="py-2 px-3">
                                <button onClick={() => void setObjField(o, { enabled: !o.enabled })}
                                  className={`text-xs px-2 py-0.5 rounded-full transition-colors ${o.enabled ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-500'}`}>
                                  {o.enabled ? 'Enabled' : 'Disabled'}
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">Write-back actions — into the system of record</p>
                    <div className="flex flex-wrap gap-2 mb-4">
                      {acts.map(a => (
                        <button key={a.id} onClick={() => void toggleAction(a)}
                          className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${a.enabled
                            ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300'
                            : 'border-slate-700 bg-slate-900 text-slate-500'}`}>
                          {ACTION_LABELS[a.action_key] ?? a.action_key} · {a.enabled ? 'on' : 'off'}
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {/* Read-through search — every provider */}
                {meta?.implemented && (
                  <>
                    <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">Live search (read-through)</p>
                    <div className="flex items-center gap-2 flex-wrap">
                      <input value={rtQuery} onChange={e => setRtQuery(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') void doSearch(c); }}
                        placeholder="Search this system…"
                        className="bg-slate-950 border border-slate-700 rounded-lg text-xs text-slate-200 px-3 py-1.5 w-64" />
                      <button disabled={isBusy} onClick={() => void doSearch(c)} className="px-3 py-1.5 rounded-lg text-xs text-slate-300 border border-slate-700 hover:border-slate-500 disabled:opacity-50 transition-colors">
                        Search live
                      </button>
                      <span className="text-[11px] text-slate-600">Fetched at question time — nothing stored, audit event only.</span>
                    </div>
                    {rtErr && !rtResult && <p className="text-xs text-red-300 mt-2">{rtErr}</p>}
                    {rtResult?.connectorId === c.id && (
                      <div className="mt-3 space-y-2">
                        <p className="text-[11px] text-slate-500">{rtResult.items.length} result(s){rtResult.latency ? ` in ${rtResult.latency}ms` : ''} — live from {meta.label}, not persisted.</p>
                        {rtResult.items.map((it, i) => (
                          <div key={i} className="rounded-xl border border-slate-800 bg-slate-950 p-3">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-xs font-medium text-white">{it.title}</span>
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">{it.type}</span>
                              <span className="text-[10px] text-slate-600">ref {it.ref}</span>
                              {it.url && <a href={it.url} target="_blank" rel="noreferrer" className="text-[10px] text-indigo-400 hover:text-indigo-300">open in source ↗</a>}
                            </div>
                            {it.snippet && <p className="text-[11px] text-slate-400 mt-1">{it.snippet}</p>}
                          </div>
                        ))}
                        {rtResult.items.length === 0 && <p className="text-xs text-slate-500">No matches in this system.</p>}
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showConnect && <ConnectWizard onClose={() => setShowConnect(false)} onDone={m => { showToast(m); void load(); }} />}
    </div>
  );
}
