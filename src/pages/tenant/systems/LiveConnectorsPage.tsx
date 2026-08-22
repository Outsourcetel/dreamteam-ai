import { useCallback, useEffect, useState } from 'react';
import { Modal, Button, Chip, Banner } from '../../../design/primitives';
import { supabase } from '../../../supabase';
import AISessionPanel from '../../../components/AISessionPanel';
import { useConfirm } from '../../../components/useDialog';
import { LiveLoadingSkeleton, LiveEmptyState } from '../../../components/LiveDataStates';
import { CustomerApiError } from '../../../lib/customerApi';
import { useIsTenantAdmin } from '../../../lib/useRoleGate';
import {
  Connector, ConnectorObject, ConnectorAction, ConnectorObjectMode,
  ConnectorProvider, ConnectorAccessMode, HubItem,
  PROVIDERS, ACCESS_MODE_EXPLAIN,
  listConnectors, listConnectorObjects, listConnectorActions,
  connectProvider, hubTest, hubSearch, hubSync, syncTickets,
  hubHealthCheck, updateConnectorFieldMap, connectorHealth,
  updateConnectorObject, updateConnectorAction, disconnectConnector, deleteConnector, hubSyncMcpTools,
  TOP_PROVIDERS, listWriteCapableProviders,
  connectorErrorLabel, fmtSince,
  IngestFilters, IngestCandidate, INGEST_TYPES, readIngestFilters,
  setIngestConfig, listIngestCandidates, decideIngestCandidates, discoverConnector,
  oauthStart, oauthAppStatus, setOAuthApp, OAUTH_CALLBACK_URL,
} from '../../../lib/connectorApi';
import {
  SystemCategory, CATEGORIES, CATEGORY_LABELS, CATEGORY_SHORT,
  MAPPABLE_FIELDS, MAPPABLE_FIELD_HELP, HEALTH_LABELS, ConnectorHealth,
} from '../../../lib/categoryContracts';
import { listAdapterTemplates } from '../../../lib/connectorApi';
import { learnToolFromSpec, listLearnedActions, setLearnedActionStatus, type LearnedAction } from '../../../lib/connectorApi';
import type { AdapterTemplate } from '../../../lib/adapterTemplates';
import { TemplateBuilderModal, ConnectFromTemplateModal, TemplateLibrary } from './TemplateBuilder';

// ============================================================
// Live Connectors page — Multi-System Connector Hub.
// Provider wizard (Salesforce / Confluence / Jira / Intercom /
// Zendesk / your own product API) → role + access-mode choice →
// server-side secrets → live test → read-through search demo →
// knowledge sync for ingest-mode knowledge systems.
// Plain-language doctrine: your systems stay yours; fetch-only means
// we look at your data to answer and never store it.
// ============================================================

const OBJECT_LABELS: Record<string, string> = { ticket: 'Tickets', user: 'Users', organization: 'Organizations' };
const ACTION_LABELS: Record<string, string> = {
  add_internal_note: 'Add internal note',
  update_status: 'Update ticket status',
};
// ── ONE WORD FOR WHETHER IT WORKS (handoff 07) ──────────────────────────
//
// Two chips used to sit side by side saying overlapping things: statusChip
// read connected/error/disconnected off the row, healthBadge read
// healthy/degraded/down/never_connected off the last check. "Connected ·
// Degraded" is two facts the owner has to reconcile before learning the one
// thing they came for. They are the same question asked twice, so they are
// now answered once — in a word, not a status enum.
function connectionState(c: Connector): { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral'; means: string } {
  const h: ConnectorHealth = connectorHealth(c);
  if (c.status === 'disconnected') return { label: 'Not connected', tone: 'neutral', means: 'Nobody has connected this system yet, or it was disconnected.' };
  if (c.status === 'error' || h === 'down') return { label: 'Not working', tone: 'danger', means: HEALTH_LABELS[h] };
  if (h === 'degraded') return { label: 'Having trouble', tone: 'warn', means: HEALTH_LABELS[h] };
  if (h === 'never_connected') return { label: 'Not checked yet', tone: 'neutral', means: HEALTH_LABELS[h] };
  return { label: 'Working', tone: 'ok', means: HEALTH_LABELS[h] };
}

// ── The 5-rung connection ladder (product doctrine) ───────────────
const CONNECTION_LADDER: { rung: string; how: string; note?: string }[] = [
  { rung: '1. Does it have an MCP server?', how: 'If your system publishes an MCP server, register it under Specialist sources — the most direct route.' },
  { rung: '2. Aggregator', how: 'One connection that covers hundreds of long-tail systems.', note: 'Available on request — built when the first customer needs it.' },
  { rung: '3. Named adapter', how: 'Salesforce, Zendesk, Confluence, Jira, Intercom — pick it below and connect with credentials.' },
  { rung: '4. Any other system', how: 'Any JSON REST API: use a template from the library, or build one in five guided steps — configuration, not code.' },
  { rung: '5. File import', how: 'No API at all? Upload documents into Knowledge and DreamTeam works from those.' },
];
const PROVIDER_ICON: Record<ConnectorProvider, string> = {
  zendesk: '🎫', salesforce: '☁️', confluence: '📘', jira: '🧩',
  intercom: '💬', generic_rest: '🔌', sharepoint: '📁', gdrive: '📄', hubspot: '🧡', slack: '#️⃣',
  notion: '📓', teams: '👥', box: '📦', freshdesk: '🌱', freshservice: '🛠️',
  servicenow: '🟢', dynamics: '🔷', github: '🐙', gitlab: '🦊', guru: '🧠', document360: '📗',
  asana: '🎯', clickup: '⬆️', monday: '📅', linear: '📐',
  stripe: '💳', shopify: '🛍️', woocommerce: '🛒', bigcommerce: '🏬', square: '⬛',
  bamboohr: '🎋', greenhouse: '🌿', lever: '🎚️', buildium: '🏢', canvas: '🎓',
  quickbooks: '💵', xero: '🧾', clio: '⚖️', gusto: '🌯', procore: '🏗️', jobber: '🔧',
  gorgias: '🛎️', front: '📨', coda: '📄', pagerduty: '🚨', sentry: '🐛',
  pipedrive: '🟩', smartsheet: '📊', wrike: '🗂️', trello: '📋', datadog: '🐕',
  close: '🎯', kustomer: '🫂', mailchimp: '🐵', gitbook: '📘',
  netsuite: '📒', powerschool: '🎒', ellucian: '🎓', toast: '🍞', athenahealth: '⚕️', epic: '🏥', cerner: '🩺',
  dropbox: '🗄️', twilio: '📱', typeform: '📝', calendly: '📆', okta: '🔐', contentful: '🗂️', template: '🧱',
  erpnext: '🧮', mcp: '🔗',
  chargebee: '🧾', clover: '🍀', zohocrm: '🟠', zohodesk: '🎟️',
};

const inputCls = 'w-full bg-dt-page border border-dt-border-strong rounded-lg text-sm text-dt-body px-3 py-2';
const selectCls = 'bg-dt-page border border-dt-border-strong rounded-lg text-xs text-dt-body px-2 py-1.5';

// ── Connect wizard ────────────────────────────────────────────────

function ConnectWizard({ onClose, onDone, onCustom, reconnect }: { onClose: () => void; onDone: (msg: string) => void; onCustom: () => void; reconnect?: Connector }) {
  // ⚠ The connectors table is owner/admin in RLS while this page is MANAGE,
  // so connecting, disconnecting and removing a system were all offered to
  // a tenant_manager and none of them would have worked. Two of the three
  // never read the row back, so they would have reported success.
  const canManageConnectors = useIsTenantAdmin();
  // Category FIRST (what kind of system), provider second (which brand).
  // On reconnect, prefill from the existing connector and jump straight to credentials.
  const [category, setCategory] = useState<SystemCategory | null>(reconnect?.category ?? null);
  const [provider, setProvider] = useState<ConnectorProvider | null>(reconnect?.provider ?? null);
  const [baseUrl, setBaseUrl] = useState(reconnect?.base_url ?? '');
  const [name, setName] = useState(reconnect?.display_name ?? '');
  const [accessMode, setAccessMode] = useState<ConnectorAccessMode>(reconnect?.access_mode ?? 'fetch_only');
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  // generic_rest endpoint config
  const [searchPath, setSearchPath] = useState('');
  const [queryParam, setQueryParam] = useState('q');
  const [itemsPath, setItemsPath] = useState('');
  const [recordPath, setRecordPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [providerQuery, setProviderQuery] = useState('');

  const meta = provider ? PROVIDERS[provider] : null;

  // Which providers can actually ACT — read live from the registered actions,
  // so a badge can never over-claim (docs/40: derived from the ladder, never a
  // hand-set flag). Empty set = everything reads-only, which is the honest
  // fallback if the lookup fails.
  const [writeCapable, setWriteCapable] = useState<Set<string>>(new Set());
  useEffect(() => { void listWriteCapableProviders().then(setWriteCapable).catch(() => {}); }, []);

  const providerCard = (p: ConnectorProvider) => {
    const m = PROVIDERS[p];
    const acts = writeCapable.has(p);
    return (
      <button key={p} onClick={() => pick(p)}
        className={`text-left rounded-xl border p-3 transition-colors ${m.implemented ? 'bg-dt-page border-dt-border hover:border-indigo-500/50' : 'bg-dt-inset border-dt-border'}`}>
        <p className="text-sm font-semibold text-dt-title">{PROVIDER_ICON[p]} {m.label}</p>
        <p className="text-[11px] text-dt-muted mt-0.5">{m.tagline}</p>
        {m.implemented
          ? (
            <p className={`text-[10px] mt-1 ${acts ? 'text-dt-ok' : 'text-dt-faint'}`}>
              {acts ? 'reads · acts (every action approval-gated)' : 'reads only'}
            </p>
          )
          : <p className="text-[10px] text-amber-400 mt-1">Registers now — adapter not built yet (honest)</p>}
      </button>
    );
  };

  const pick = (p: ConnectorProvider) => {
    setProvider(p);
    if (!category) setCategory(PROVIDERS[p].defaultCategory);
    setAccessMode(PROVIDERS[p].knowledgeSync ? 'ingest' : 'fetch_only');
    setSecrets({});
    setErr(null);
  };

  const submit = async () => {
    if (!provider || !meta) return;
    setErr(null);
    const noBaseUrl: ConnectorProvider[] = ['gdrive', 'hubspot', 'slack', 'notion', 'teams', 'box',
      'github', 'guru', 'document360', 'asana', 'clickup', 'monday', 'linear',
      'stripe', 'bigcommerce', 'square', 'bamboohr', 'greenhouse', 'lever', 'buildium',
      'front', 'coda', 'pagerduty', 'sentry',
      'pipedrive', 'smartsheet', 'wrike', 'trello', 'datadog',
      'close', 'kustomer', 'mailchimp', 'gitbook',
      'ellucian', 'toast', 'athenahealth',
      'twilio', 'typeform', 'calendly', 'contentful',
      // P4: base URL is derived from a credential field (site / merchant id /
      // Zoho data-centre domain), so the customer never types a URL.
      'chargebee', 'clover', 'zohocrm', 'zohodesk'];
    if (!noBaseUrl.includes(provider) && !baseUrl.trim()) { setErr(`${meta.baseUrlLabel} is required.`); return; }
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
        provider, displayName: name, baseUrl, category: category ?? PROVIDERS[provider].defaultCategory, accessMode, secrets, config,
        reconnectId: reconnect?.id,
      });
      onDone(test.ok
        ? `${meta.label} ${reconnect ? 'reconnected' : 'connected'} — credentials verified live${test.detail ? ` (${test.detail})` : ''}.`
        : `${meta.label} saved, but the live test failed: ${connectorErrorLabel(test.error)}`);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    // Busy guard preserved and now covering Escape as well as the backdrop.
    <Modal size="2xl"
           title={!category ? 'Connect a system — what kind is it?'
                  : !provider ? `Which system is your ${CATEGORY_SHORT[category]}?`
                  : `${reconnect ? 'Reconnect' : 'Connect'} ${meta!.label}`}
           onClose={() => { if (!busy) onClose(); }}>
          {!category ? (
            <>
              <p className="text-xs text-dt-muted mb-4">DreamTeam speaks in system categories: your Digital Employees ask "the helpdesk" or "the CRM" — whichever brand you actually run answers. Pick the category first.</p>
              <div className="grid grid-cols-2 gap-2 mb-4">
                {CATEGORIES.map(cat => (
                  <button key={cat} onClick={() => setCategory(cat)}
                    className="text-left rounded-xl border p-3 transition-colors bg-dt-page border-dt-border hover:border-indigo-500/50">
                    <p className="text-sm font-semibold text-dt-title">{CATEGORY_SHORT[cat]}</p>
                    <p className="text-[11px] text-dt-muted mt-0.5">{CATEGORY_LABELS[cat]}</p>
                  </button>
                ))}
              </div>
              <div className="rounded-xl border border-dt-border bg-dt-inset p-3">
                <p className="text-[11px] font-medium text-dt-support mb-2">How DreamTeam connects to anything — the 5-rung ladder</p>
                <div className="space-y-1.5">
                  {CONNECTION_LADDER.map(l => (
                    <div key={l.rung} className="flex items-start gap-2">
                      <span className="text-[11px] font-medium text-dt-support flex-shrink-0">{l.rung}</span>
                      <span className="text-[11px] text-dt-muted">{l.how}{l.note && <span className="text-amber-400"> {l.note}</span>}</span>
                    </div>
                  ))}
                </div>
              </div>
              <button onClick={onClose} className="mt-4 text-xs text-dt-support hover:text-dt-body">Cancel</button>
            </>
          ) : !provider ? (
            <>
              <button onClick={() => setCategory(null)} className="text-xs text-dt-muted hover:text-dt-body mb-2">← Categories</button>
              <p className="text-xs text-dt-muted mb-3">Your systems stay yours — DreamTeam works on top of them. Not listed? Rung 4: connect its API via "Your product API"; rung 5: upload files into Knowledge instead.</p>
              <input value={providerQuery} onChange={e => setProviderQuery(e.target.value)} placeholder="Search 30+ systems…"
                className={`${inputCls} mb-3`} />
              <div className="grid grid-cols-2 gap-2">
                {!providerQuery.trim() && (
                <button onClick={() => { onClose(); onCustom(); }}
                  className="text-left rounded-xl border p-3 transition-colors bg-dt-page border-indigo-500/40 hover:border-indigo-400">
                  <p className="text-sm font-semibold text-dt-title">🧱 Custom system — build a template</p>
                  <p className="text-[11px] text-dt-muted mt-0.5">Not listed? Any REST API becomes a reusable template in five guided steps — no code.</p>
                </button>
                )}
                {(() => {
                  const q = providerQuery.trim().toLowerCase();
                  const matches = (p: ConnectorProvider) => !q || `${PROVIDERS[p].label} ${PROVIDERS[p].tagline}`.toLowerCase().includes(q);
                  const all = (Object.keys(PROVIDERS) as ConnectorProvider[]).filter(p => p !== 'template');
                  // The systems most SMBs run for THIS category, first. Editorial
                  // order only — the badge on each card is derived, not curated.
                  const top = (TOP_PROVIDERS[category] ?? []).filter(p => PROVIDERS[p] && matches(p));
                  const rest = all
                    .filter(p => !top.includes(p) && matches(p))
                    .sort((a, b) => Number(PROVIDERS[b].defaultCategory === category) - Number(PROVIDERS[a].defaultCategory === category));
                  return (
                    <>
                      {top.length > 0 && (
                        <p className="col-span-2 text-[11px] font-medium text-dt-support">Most used for {CATEGORY_SHORT[category]}</p>
                      )}
                      {top.map(p => providerCard(p))}
                      {top.length > 0 && rest.length > 0 && (
                        <p className="col-span-2 text-[11px] font-medium text-dt-support mt-2">Everything else</p>
                      )}
                      {rest.map(p => providerCard(p))}
                    </>
                  );
                })()}
                <div className="text-left rounded-xl border border-dashed border-dt-border p-3 bg-dt-inset">
                  <p className="text-sm font-semibold text-dt-support">🔗 Aggregator (hundreds of systems)</p>
                  <p className="text-[11px] text-dt-muted mt-0.5">One connection covering the long tail of niche tools.</p>
                  <p className="text-[10px] text-amber-400 mt-1">Available on request — built when the first customer needs it (honest, not pretend-integrated).</p>
                </div>
              </div>
              <button onClick={onClose} className="mt-4 text-xs text-dt-support hover:text-dt-body">Cancel</button>
            </>
          ) : (
            <>
              {!reconnect && <button onClick={() => setProvider(null)} className="text-xs text-dt-muted hover:text-dt-body mb-2">← All systems</button>}
              <p className="text-xs text-dt-muted mb-4">{meta!.tagline}</p>

              {meta!.oauth ? (
                <OAuthConnectSection provider={provider!} label={meta!.label} name={name} onClose={onClose} />
              ) : (<>
              <div className="rounded-xl border border-dt-border bg-dt-inset p-3 mb-4">
                <p className="text-[11px] font-medium text-dt-support mb-1">How to get credentials</p>
                <p className="text-[11px] text-dt-muted leading-relaxed">{meta!.help}</p>
              </div>

              <div className="space-y-3">
                <div>
                  <label className="block text-xs text-dt-support mb-1">{meta!.baseUrlLabel}</label>
                  <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder={meta!.baseUrlPlaceholder} className={inputCls} />
                </div>
                {meta!.fields.map(f => (
                  <div key={f.key}>
                    <label className="block text-xs text-dt-support mb-1">{f.label}</label>
                    {f.multiline ? (
                      <textarea value={secrets[f.key] ?? ''} onChange={e => setSecrets(s => ({ ...s, [f.key]: e.target.value }))}
                        placeholder={f.placeholder} rows={5} className={`${inputCls} font-mono text-xs`} />
                    ) : (
                      <input value={secrets[f.key] ?? ''} onChange={e => setSecrets(s => ({ ...s, [f.key]: e.target.value }))}
                        type={f.secret ? 'password' : 'text'} placeholder={f.placeholder} className={inputCls} />
                    )}
                  </div>
                ))}
                {meta!.fields.some(f => f.secret) && (
                  <p className="text-[11px] text-dt-faint">Credentials are stored server-side only — never shown again, never readable from the browser, purged instantly on disconnect.</p>
                )}

                {provider === 'generic_rest' && (
                  <div className="rounded-xl border border-dt-border bg-dt-inset p-3 space-y-2">
                    <p className="text-[11px] font-medium text-dt-support">Tell DreamTeam how to search this API</p>
                    <div className="flex gap-2">
                      <div className="flex-1">
                        <label className="block text-[11px] text-dt-muted mb-1">Search path</label>
                        <input value={searchPath} onChange={e => setSearchPath(e.target.value)} placeholder="/users" className={inputCls} />
                      </div>
                      <div className="w-28">
                        <label className="block text-[11px] text-dt-muted mb-1">Query param</label>
                        <input value={queryParam} onChange={e => setQueryParam(e.target.value)} placeholder="q" className={inputCls} />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <div className="flex-1">
                        <label className="block text-[11px] text-dt-muted mb-1">Items path in the response (optional, e.g. data.results)</label>
                        <input value={itemsPath} onChange={e => setItemsPath(e.target.value)} placeholder="leave empty if the response is a list" className={inputCls} />
                      </div>
                      <div className="flex-1">
                        <label className="block text-[11px] text-dt-muted mb-1">Record path (optional, {'{ref}'} = id)</label>
                        <input value={recordPath} onChange={e => setRecordPath(e.target.value)} placeholder="/users/{ref}" className={inputCls} />
                      </div>
                    </div>
                  </div>
                )}

                <div>
                  <label className="block text-xs text-dt-support mb-1">System category</label>
                  <select value={category} onChange={e => setCategory(e.target.value as SystemCategory)} className={selectCls + ' w-full !py-2 !text-sm'}>
                    {CATEGORIES.map(cat => (
                      <option key={cat} value={cat}>{CATEGORY_LABELS[cat]}</option>
                    ))}
                  </select>
                  <p className="text-[11px] text-dt-faint mt-1">The category decides what your Digital Employees may ask this system (its canonical operations): CRMs answer "who is this customer?", helpdesks answer "have we solved this before?", knowledge bases answer "what do our docs say?".</p>
                </div>

                <div>
                  <label className="block text-xs text-dt-support mb-1">Data handling — your choice</label>
                  <div className="space-y-1.5">
                    {(['fetch_only', 'ingest'] as ConnectorAccessMode[]).map(m => (
                      <label key={m} className={`flex items-start gap-2 rounded-lg border p-2 cursor-pointer ${accessMode === m ? 'border-indigo-500/50 bg-indigo-500/5' : 'border-dt-border'}`}>
                        <input type="radio" checked={accessMode === m} onChange={() => setAccessMode(m)} className="mt-0.5" />
                        <span className="text-[11px] text-dt-support leading-relaxed">{ACCESS_MODE_EXPLAIN[m]}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-dt-support mb-1">Display name (optional)</label>
                  <input value={name} onChange={e => setName(e.target.value)} placeholder={`${meta!.label} — production`} className={inputCls} />
                </div>
              </div>

              {err && <p className="text-xs text-dt-danger mt-3">{err}</p>}
              <div className="flex gap-3 mt-5">
                <button disabled={busy} onClick={onClose} className="flex-1 px-3 py-2 rounded-lg bg-dt-panel text-dt-support hover:bg-dt-panel text-xs transition-colors disabled:opacity-50">
                  Cancel
                </button>
                <button disabled={busy || !canManageConnectors} onClick={() => void submit()} className="flex-1 px-3 py-2 rounded-lg bg-dt-accent-strong hover:bg-dt-accent-hover text-white text-xs transition-colors disabled:opacity-50">
                  {busy ? 'Testing…' : meta!.implemented ? 'Test & Save' : 'Register (no adapter yet)'}
                </button>
              </div>
              </>)}
            </>
          )}
    </Modal>
  );
}

// ── User-OAuth connect: platform app setup + "Connect with…" redirect ──
function OAuthConnectSection({ provider, label, name, onClose }: {
  provider: ConnectorProvider; label: string; name: string; onClose: () => void;
}) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [showSetup, setShowSetup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const s = await oauthAppStatus();
    const cfg = s.has(provider);
    setConfigured(cfg);
    setShowSetup(!cfg);
  }, [provider]);
  useEffect(() => { void load(); }, [load]);

  const saveApp = async () => {
    setBusy(true); setErr(null);
    try { await setOAuthApp(provider, clientId, clientSecret); setClientSecret(''); await load(); }
    catch (e) { setErr(e instanceof CustomerApiError ? e.message : 'Only platform admins can set this up.'); }
    finally { setBusy(false); }
  };
  const connect = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await oauthStart(provider, name);
      if (r.ok && r.authorize_url) { window.location.href = r.authorize_url; return; }
      setErr(r.detail || connectorErrorLabel(r.error));
    } catch (e) { setErr(e instanceof CustomerApiError ? e.message : 'Could not start sign-in.'); }
    setBusy(false);
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-dt-border bg-dt-inset p-3">
        <p className="text-[11px] text-dt-muted leading-relaxed">
          Connect by signing in — no keys to paste. You'll be sent to {label} to approve access, then returned here.
        </p>
      </div>

      {configured === false && (
        <div className="rounded-xl border border-dt-warn-border bg-dt-warn-soft p-3 space-y-1.5">
          <p className="text-[11px] text-dt-warn font-medium">One-time platform setup</p>
          <p className="text-[11px] text-dt-support">Register the {label} developer app once, and add this exact redirect URL in its settings:</p>
          <code className="block text-[10px] text-dt-support bg-dt-page rounded p-1.5 break-all">{OAUTH_CALLBACK_URL}</code>
        </div>
      )}

      {(showSetup || configured === false) && (
        <div className="rounded-xl border border-dt-border bg-dt-inset p-3 space-y-2">
          <p className="text-[11px] font-medium text-dt-support">{label} app credentials — platform admin only</p>
          <input value={clientId} onChange={e => setClientId(e.target.value)} placeholder="Client ID" className={inputCls} />
          <input value={clientSecret} onChange={e => setClientSecret(e.target.value)} type="password" placeholder="Client secret" className={inputCls} />
          <button disabled={busy || !clientId.trim()} onClick={() => void saveApp()}
            className="px-3 py-1.5 rounded-lg text-xs bg-dt-border-strong hover:bg-dt-panel text-dt-title disabled:opacity-50">
            Save app credentials
          </button>
        </div>
      )}

      {err && <p className="text-xs text-dt-danger">{err}</p>}
      <div className="flex gap-3">
        <button disabled={busy} onClick={onClose} className="flex-1 px-3 py-2 rounded-lg bg-dt-panel text-dt-support hover:bg-dt-panel text-xs disabled:opacity-50">Cancel</button>
        <button disabled={busy || configured !== true} onClick={() => void connect()}
          title={configured !== true ? 'A platform admin must add the app credentials first.' : ''}
          className="flex-1 px-3 py-2 rounded-lg bg-dt-accent-strong hover:bg-dt-accent-hover text-white text-xs disabled:opacity-50">
          {busy ? 'Starting…' : `Connect with ${label}`}
        </button>
      </div>
      {configured === true && !showSetup && (
        <button onClick={() => setShowSetup(true)} className="text-[11px] text-dt-muted hover:text-dt-body">Update app credentials</button>
      )}
    </div>
  );
}

// ── Field-map editor (plain-language key-value mapping) ──────────
function FieldMapEditor({ connector, onSave, isBusy }: {
  connector: Connector;
  onSave: (map: Record<string, string>) => void;
  isBusy: boolean;
}) {
  const [map, setMap] = useState<Record<string, string>>({ ...(connector.field_map ?? {}) });
  return (
    <div className="rounded-xl border border-dt-border bg-dt-inset p-3 mb-4">
      <p className="text-[11px] font-medium text-dt-support mb-1">Field mapping — tell DreamTeam what your fields are called</p>
      <p className="text-[11px] text-dt-faint mb-3">If your system uses different field names, map them here. Leave a field empty to keep the sensible default.</p>
      <div className="space-y-2">
        {MAPPABLE_FIELDS.map(f => (
          <div key={f} className="flex items-center gap-2">
            <span className="text-xs text-dt-support w-28 flex-shrink-0 font-mono">{f}</span>
            <input value={map[f] ?? ''} onChange={e => setMap(m => ({ ...m, [f]: e.target.value }))}
              placeholder="your field name (optional)"
              className="bg-dt-page border border-dt-border-strong rounded-lg text-xs text-dt-body px-2 py-1.5 w-52" />
            <span className="text-[10px] text-dt-faint">{MAPPABLE_FIELD_HELP[f]}</span>
          </div>
        ))}
      </div>
      <button disabled={isBusy} onClick={() => onSave(map)}
        className="mt-3 px-3 py-1.5 rounded-lg text-xs bg-dt-accent-strong hover:bg-dt-accent-hover text-white disabled:opacity-50 transition-colors">
        Save mapping
      </button>
    </div>
  );
}

// ── Ingest control — filters + review-before-ingest queue ───────────
const CAND_STATUS_META: Record<string, { label: string; cls: string }> = {
  pending: { label: 'Awaiting review', cls: 'text-dt-warn bg-dt-warn-soft' },
  approved: { label: 'Approved', cls: 'text-dt-ok bg-dt-ok-soft' },
  rejected: { label: 'Excluded', cls: 'text-dt-support bg-dt-neutral-soft' },
  ingested: { label: 'In knowledge', cls: 'text-dt-accent-text bg-dt-accent-soft' },
};
const TYPE_LABEL: Record<string, string> = { pdf: 'PDF', doc: 'Doc', slide: 'Slides', sheet: 'Sheet', text: 'Text', other: 'Other' };

function IngestControlPanel({ connector, onToast }: { connector: Connector; onToast: (m: string) => void }) {
  // ⚠ The two halves of this panel are gated DIFFERENTLY at the database, and
  // the page sits one tier wider than the stricter half:
  //   set_connector_ingest_config  owner/admin/MANAGER  — matches the page
  //   decide_ingest_candidates     owner/admin          — does not
  // A tenant_manager could set the filters and run a scan, then be refused on
  // every Approve/Exclude button in the queue those filters had just filled.
  // Scanning and the queue stay visible: seeing what WOULD be ingested is
  // exactly what a manager tuning the filters needs. Only the verdict is admin.
  const canDecideCandidates = useIsTenantAdmin();
  const [filters, setFilters] = useState<IngestFilters>(() => readIngestFilters(connector));
  const [excludeText, setExcludeText] = useState<string>(() => readIngestFilters(connector).exclude_patterns.join(', '));
  const [cands, setCands] = useState<IngestCandidate[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try { setCands(await listIngestCandidates(connector.id)); }
    catch { /* table may be empty */ }
    finally { setLoaded(true); }
  }, [connector.id]);
  useEffect(() => { void refresh(); }, [refresh]);

  const commitFilters = (next: IngestFilters) => setFilters(next);
  const toggleType = (t: string) => {
    const cur = filters.allow_types ?? [];
    const has = cur.includes(t);
    const nextList = has ? cur.filter(x => x !== t) : [...cur, t];
    commitFilters({ ...filters, allow_types: nextList.length ? nextList : null });
  };

  const saveFilters = async () => {
    setBusy('save');
    try {
      const next: IngestFilters = { ...filters, exclude_patterns: excludeText.split(',').map(s => s.trim()).filter(Boolean) };
      await setIngestConfig(connector.id, next);
      setFilters(next);
      onToast('Ingest settings saved. Run a scan to apply them.');
    } catch (e) { onToast(e instanceof CustomerApiError ? e.message : 'Could not save ingest settings.'); }
    finally { setBusy(null); }
  };

  const scan = async () => {
    setBusy('scan');
    try {
      const r = await discoverConnector(connector.id);
      if (r.ok) { onToast(`Scan complete — ${r.found ?? 0} file(s) match your filters, ${r.new ?? 0} new to review.`); await refresh(); }
      else onToast(`Scan failed: ${connectorErrorLabel(r.error)}${r.detail ? ` — ${r.detail}` : ''}`);
    } finally { setBusy(null); }
  };

  const decide = async (refs: string[] | null, decision: 'approved' | 'rejected' | 'pending') => {
    setBusy('decide');
    try { await decideIngestCandidates(connector.id, refs, decision); await refresh(); }
    catch (e) { onToast(e instanceof CustomerApiError ? e.message : 'Could not update the review queue.'); }
    finally { setBusy(null); }
  };

  const pending = cands.filter(c => c.status === 'pending');
  const approved = cands.filter(c => c.status === 'approved');
  const isBusy = busy !== null;

  return (
    <div className="rounded-xl border border-dt-border bg-dt-inset p-3 mb-4 space-y-4">
      <div>
        <p className="text-[11px] font-medium text-dt-support mb-1">What gets ingested — filters</p>
        <p className="text-[11px] text-dt-faint mb-3">
          These control which files land in knowledge <span className="text-dt-muted">and surface in live lookups</span>. They are hygiene, not a security wall —
          the real wall is least-privilege at the source: {
            connector.provider === 'gdrive' ? 'share only the intended folder(s) with the service account (it sees nothing else).'
            : connector.provider === 'notion' ? 'share only the intended pages with the Notion integration (it sees nothing else).'
            : connector.provider === 'box' ? 'grant the app access to only the intended folders in the Box Admin Console (it sees nothing else).'
            : connector.provider === 'dropbox' ? 'share only the intended folder(s) with the app, or scope the app folder (it sees nothing else).'
            : 'grant the app Sites.Selected on one dedicated site instead of Sites.Read.All (it sees nothing else).'}
        </p>
        <div className="space-y-3">
          {connector.provider !== 'notion' && (
          <div>
            <label className="block text-[11px] text-dt-support mb-1">
              {connector.provider === 'gdrive' ? 'Folder / Shared Drive ID (optional — blank = everything shared)'
                : connector.provider === 'box' ? 'Folder ID to sync (optional — blank = whole account)'
                : connector.provider === 'dropbox' ? 'Folder path to sync (optional — blank = everything shared)'
                : 'Sub-folder to sync (optional — blank = whole library)'}
            </label>
            <input value={filters.folder ?? ''} onChange={e => commitFilters({ ...filters, folder: e.target.value || null })}
              placeholder={connector.provider === 'gdrive' ? 'folder id' : connector.provider === 'box' ? 'Box folder id' : connector.provider === 'dropbox' ? '/Policies' : 'e.g. Policies/Public'} className={`${inputCls} text-xs`} />
          </div>
          )}
          <div>
            <label className="block text-[11px] text-dt-support mb-1">Exclude files/folders whose name contains (comma-separated)</label>
            <input value={excludeText} onChange={e => setExcludeText(e.target.value)}
              placeholder="draft, confidential, archive, HR" className={`${inputCls} text-xs`} />
          </div>
          <div>
            <label className="block text-[11px] text-dt-support mb-1">Only ingest these file types (none checked = all supported types)</label>
            <div className="flex flex-wrap gap-2">
              {INGEST_TYPES.map(t => {
                const on = filters.allow_types?.includes(t.key) ?? false;
                return (
                  <button key={t.key} onClick={() => toggleType(t.key)}
                    className={`px-2.5 py-1 rounded-lg text-[11px] border transition-colors ${on ? 'border-dt-accent bg-dt-accent-soft text-dt-accent-text' : 'border-dt-border-strong text-dt-support hover:border-dt-border-strong'}`}>
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs text-dt-support">
            <input type="checkbox" checked={filters.require_review} onChange={e => commitFilters({ ...filters, require_review: e.target.checked })} />
            Review before ingest — nothing enters knowledge until you approve it here
          </label>
        </div>
        <button disabled={isBusy} onClick={() => void saveFilters()}
          className="mt-3 px-3 py-1.5 rounded-lg text-xs bg-dt-accent-strong hover:bg-dt-accent-hover text-white disabled:opacity-50 transition-colors">
          {busy === 'save' ? 'Saving…' : 'Save settings'}
        </button>
      </div>

      <div className="border-t border-dt-border pt-3">
        <div className="flex items-center justify-between mb-2">
          <p className="text-[11px] font-medium text-dt-support">Review queue{loaded ? ` — ${cands.length} file(s)` : ''}</p>
          <div className="flex gap-2">
            <button disabled={isBusy} onClick={() => void scan()}
              className="px-3 py-1.5 rounded-lg text-xs text-dt-body border border-dt-border-strong hover:border-dt-border-strong disabled:opacity-50 transition-colors">
              {busy === 'scan' ? 'Scanning…' : 'Scan for documents'}
            </button>
            {pending.length > 0 && canDecideCandidates && (
              <>
                <button disabled={isBusy} onClick={() => void decide(pending.map(c => c.external_ref), 'approved')}
                  className="px-2.5 py-1.5 rounded-lg text-xs text-dt-ok border border-dt-ok-border hover:bg-dt-ok-soft disabled:opacity-50">Approve all</button>
                <button disabled={isBusy} onClick={() => void decide(pending.map(c => c.external_ref), 'rejected')}
                  className="px-2.5 py-1.5 rounded-lg text-xs text-dt-support border border-dt-border-strong hover:border-dt-border-strong disabled:opacity-50">Exclude all</button>
              </>
            )}
          </div>
        </div>

        {/* Say who decides, rather than leaving a manager to wonder where the
            buttons went. A missing control with no explanation reads as a bug. */}
        {!canDecideCandidates && pending.length > 0 && (
          <p className="mb-2 text-[11px] text-dt-faint">
            {pending.length} file(s) waiting on a decision — approving or excluding documents is done by a
            workspace owner or admin. You can still change the filters above and re-scan.
          </p>
        )}

        {!loaded ? (
          <p className="text-[11px] text-dt-faint">Loading…</p>
        ) : cands.length === 0 ? (
          <p className="text-[11px] text-dt-faint">No documents scanned yet. Click "Scan for documents" to list what would be ingested — nothing is stored until you sync.</p>
        ) : (
          <div className="rounded-lg border border-dt-border max-h-72 overflow-y-auto divide-y divide-dt-border">
            {cands.map(c => {
              const meta = CAND_STATUS_META[c.status] ?? CAND_STATUS_META.pending;
              return (
                <div key={c.id} className="flex items-center gap-2 px-3 py-2">
                  <span className="text-[10px] font-mono text-dt-muted w-10 flex-shrink-0">{TYPE_LABEL[c.file_type] ?? c.file_type}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-dt-body truncate">{c.title}</p>
                    {c.path && <p className="text-[10px] text-dt-faint truncate">{c.path}</p>}
                  </div>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${meta.cls} flex-shrink-0`}>{meta.label}</span>
                  {c.status !== 'ingested' && canDecideCandidates && (
                    <div className="flex gap-1 flex-shrink-0">
                      {c.status !== 'approved' && (
                        <button disabled={isBusy} onClick={() => void decide([c.external_ref], 'approved')}
                          className="px-2 py-0.5 rounded text-[10px] text-dt-ok border border-dt-ok-border hover:bg-dt-ok-soft disabled:opacity-50">Approve</button>
                      )}
                      {c.status !== 'rejected' && (
                        <button disabled={isBusy} onClick={() => void decide([c.external_ref], 'rejected')}
                          className="px-2 py-0.5 rounded text-[10px] text-dt-support border border-dt-border-strong hover:border-dt-border-strong disabled:opacity-50">Exclude</button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {filters.require_review && approved.length > 0 && (
          <p className="text-[11px] text-emerald-400/80 mt-2">{approved.length} file(s) approved — click "Sync knowledge" above to ingest them.</p>
        )}
        {!filters.require_review && (
          <p className="text-[11px] text-dt-faint mt-2">Review is off — "Sync knowledge" ingests every file that matches your filters directly.</p>
        )}
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────

/** §3 BREADTH — teach a tool from an OpenAPI spec, then review + publish the
 *  drafts. Nothing generated here is usable by an employee until an admin
 *  publishes it, and every published write still passes the approval gate. */
function LearnedToolsPanel({ onToast }: { onToast: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<LearnedAction[]>([]);
  const [name, setName] = useState('');
  const [specText, setSpecText] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setRows(await listLearnedActions()); } catch { setRows([]); }
  }, []);
  useEffect(() => { if (open) void load(); }, [open, load]);

  const learn = async () => {
    setErr(null);
    let spec: unknown;
    try { spec = JSON.parse(specText); } catch { setErr('That does not look like valid JSON.'); return; }
    setBusy(true);
    try {
      const r = await learnToolFromSpec(name.trim() || 'Learned tool', spec, { base_url: baseUrl.trim() || undefined });
      onToast(`Learned ${r.operation_count} action(s) as drafts — publish the ones you want your employees to use.`);
      setSpecText(''); setName(''); setBaseUrl('');
      await load();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  const flip = async (id: string, status: 'active' | 'draft') => {
    setBusy(true); setErr(null);
    try {
      await setLearnedActionStatus(id, status);
      await load();
      onToast(status === 'active' ? 'Action published — your employees can now propose it.' : 'Action unpublished.');
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  const drafts = rows.filter(r => r.status === 'draft').length;

  return (
    <div className="rounded-xl border border-dt-border bg-dt-card p-4">
      <button onClick={() => setOpen(o => !o)} className="flex items-center gap-2 text-sm font-semibold text-dt-title w-full text-left">
        <span>{open ? '▾' : '▸'}</span> Teach a tool from an API spec
        <span className="text-[11px] font-normal text-dt-muted">
          — paste an OpenAPI document to generate actions{rows.length > 0 ? ` · ${rows.length} learned${drafts ? `, ${drafts} awaiting review` : ''}` : ''}
        </span>
      </button>
      {open && (
        <div className="mt-3 space-y-4">
          <p className="text-[11px] text-dt-muted">
            Generated actions arrive as <span className="text-dt-support">drafts</span>: no employee can use one until you publish it, and every
            published write still goes through the same approval gate, guardrails and spend caps as any other action. Calls only ever go to the
            connector's own system.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Tool name (e.g. Billing API)"
              className="px-3 py-2 rounded-lg bg-dt-panel border border-dt-border text-xs text-dt-body placeholder:text-dt-muted" />
            <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="Base URL (optional)"
              className="px-3 py-2 rounded-lg bg-dt-panel border border-dt-border text-xs text-dt-body placeholder:text-dt-muted" />
          </div>
          <textarea value={specText} onChange={e => setSpecText(e.target.value)} rows={5} placeholder="Paste the OpenAPI (v2/v3) JSON here"
            className="w-full px-3 py-2 rounded-lg bg-dt-panel border border-dt-border text-xs font-mono text-dt-body placeholder:text-dt-muted" />
          {err && <div className="text-[11px] text-dt-danger">{err}</div>}
          <button disabled={busy || !specText.trim()} onClick={() => void learn()}
            className="px-3 py-1.5 rounded-lg text-xs bg-dt-accent-strong hover:bg-dt-accent-hover text-white disabled:opacity-50 transition-colors">
            {busy ? 'Working…' : 'Learn actions from this spec'}
          </button>

          {rows.length > 0 && (
            <div className="divide-y divide-dt-border border-t border-dt-border pt-1">
              {rows.map(a => {
                const destructive = a.risk?.destructive === true;
                return (
                  <div key={a.id} className="flex items-center gap-2 py-2 flex-wrap">
                    <span className="text-sm text-dt-body">{a.label}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-dt-panel text-dt-muted">{a.execution?.method ?? '—'}</span>
                    {a.status === 'active'
                      ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-dt-ok-soft text-dt-ok">published</span>
                      : <span className="text-[10px] px-1.5 py-0.5 rounded bg-dt-warn-soft text-dt-warn">draft — not usable yet</span>}
                    {destructive && <span className="text-[10px] px-1.5 py-0.5 rounded bg-dt-danger-soft text-dt-danger">writes — always human-gated</span>}
                    <button disabled={busy} onClick={() => void flip(a.id, a.status === 'active' ? 'draft' : 'active')}
                      className="ml-auto px-2.5 py-1 rounded-lg text-[11px] bg-dt-border-strong hover:bg-dt-panel text-dt-title disabled:opacity-50 transition-colors">
                      {a.status === 'active' ? 'Unpublish' : 'Publish'}
                    </button>
                    {a.description && <span className="text-[11px] text-dt-muted basis-full">{a.description}</span>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function LiveConnectorsPage() {
  const canManageConnectors = useIsTenantAdmin();
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [reconnectTarget, setReconnectTarget] = useState<Connector | null>(null);
  // W4-R: grants + DE names for the per-card access line (read-only view of
  // the same default-deny matrix Governance → Data Access manages).
  const [grants, setGrants] = useState<Array<{ subject_id: string; resource_kind: string; resource_id: string | null; resource_category: string | null; permission: string }>>([]);
  const [deNames, setDeNames] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [{ data: g }, { data: d }] = await Promise.all([
          supabase.from('data_access_grants').select('subject_id, resource_kind, resource_id, resource_category, permission'),
          supabase.from('digital_employees').select('id, name, persona_name').eq('status', 'active'),
        ]);
        if (cancelled) return;
        setGrants((g ?? []) as typeof grants);
        setDeNames(new Map(((d ?? []) as Array<{ id: string; name: string; persona_name: string | null }>).map(x => [x.id, x.persona_name ?? x.name])));
      } catch { /* grants line is best-effort */ }
    })();
    return () => { cancelled = true; };
  }, []);
  // Ledger-4 (docs/16): the generalized action layer finally gets a browser —
  // registered actions were invisible outside the approval pane.
  const [actionDefs, setActionDefs] = useState<Array<{ id: string; label: string; category: string | null; action_key: string; risk: Record<string, unknown> | null; scope: string; status: string; description: string | null }>>([]);
  const [showActions, setShowActions] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void supabase.from('action_definitions')
      .select('id, label, category, action_key, risk, scope, status, description')
      .order('category').then(({ data }) => { if (!cancelled) setActionDefs((data ?? []) as typeof actionDefs); });
    return () => { cancelled = true; };
  }, []);

  const grantsFor = (c: Connector): Array<{ name: string; level: string }> => {
    const byDe = new Map<string, string>();
    for (const g of grants) {
      const isConnector = g.resource_kind === 'connector' && g.resource_id === c.id;
      const applies = isConnector || (g.resource_kind === 'category' && g.resource_category === c.category);
      if (!applies) continue;
      const name = deNames.get(g.subject_id);
      if (!name) continue;
      const prev = byDe.get(name);
      // connector-specific beats category; write_back beats read for display
      if (!prev || isConnector || (g.permission === 'write_back' && prev !== 'write_back')) byDe.set(name, g.permission);
    }
    return [...byDe.entries()].map(([name, level]) => ({ name, level }));
  };
  const [objects, setObjects] = useState<Record<string, ConnectorObject[]>>({});
  const [actions, setActions] = useState<Record<string, ConnectorAction[]>>({});
  const [loading, setLoading] = useState(true);
  const [missingTables, setMissingTables] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [showConnect, setShowConnect] = useState(false);
  const [showAi, setShowAi] = useState(false);
  const [showBuilder, setShowBuilder] = useState(false);
  const [templates, setTemplates] = useState<AdapterTemplate[]>([]);
  const [useTemplate, setUseTemplate] = useState<AdapterTemplate | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [fieldMapFor, setFieldMapFor] = useState<string | null>(null);
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const { confirm, confirmUI } = useConfirm();
  const [ingestFor, setIngestFor] = useState<string | null>(null);

  // Read-through search demo
  const [rtQuery, setRtQuery] = useState('');
  const [rtResult, setRtResult] = useState<{ connectorId: string; items: HubItem[]; latency?: number } | null>(null);
  const [rtErr, setRtErr] = useState<string | null>(null);

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 6000); };

  const load = useCallback(async () => {
    try {
      setLoading(true);
      // Hide internal platform connectors (the "DreamTeam AI (self)" self-management
      // connector, category platform_admin) — it's plumbing a DE uses to operate
      // DreamTeam itself, not an external data source the customer connects or tests.
      const conns = (await listConnectors()).filter((c) => String(c.category) !== 'platform_admin');
      setConnectors(conns);
      try { setTemplates(await listAdapterTemplates()); } catch { setTemplates([]); /* library appears once migration 028 is applied */ }
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

  const doHealthCheck = async (c: Connector) => {
    setBusy(c.id);
    try {
      const r = await hubHealthCheck(c.id);
      showToast(r.ok
        ? 'Health check passed — this system is answering.'
        : `Health check failed: ${connectorErrorLabel(r.error)} — recorded honestly (${r.health ?? 'degraded'}).`);
      await load();
    } finally { setBusy(null); }
  };

  const saveFieldMap = async (c: Connector, map: Record<string, string>) => {
    setBusy(c.id);
    try {
      await updateConnectorFieldMap(c.id, map);
      showToast('Field mapping saved — applied the next time this system is read.');
      setFieldMapFor(null);
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
    const who = grantsFor(c).map(g => g.name);
    if (!await confirm({
      title: `Disconnect ${c.display_name || PROVIDERS[c.provider]?.label}?`,
      message: <>The stored credential is deleted straight away, and you'll need it again to reconnect.
        {who.length > 0 && <> {who.length === 1 ? `${who[0]} will stop being able` : `${who.join(', ')} will stop being able`} to reach this system.</>}</>,
      confirmLabel: 'Disconnect it',
    })) return;
    setBusy(c.id);
    try {
      await disconnectConnector(c);
      showToast('Disconnected — credential purged.');
      await load();
    } finally { setBusy(null); }
  };

  // MCP: read the server's tools and register each as an approval-gated action.
  const doMcpSync = async (c: Connector) => {
    setBusy(c.id);
    try {
      const r = await hubSyncMcpTools(c.id);
      if (!r.ok) { showToast(`Could not read the server's tools: ${connectorErrorLabel(r.error)}`); return; }
      const gated = (r.registered ?? []).filter(x => x.destructive).length;
      showToast(`${r.registered?.length ?? 0} tool(s) registered as governed actions — ${gated} require human approval.`);
      await load();
    } finally { setBusy(null); }
  };

  const doRemove = async (c: Connector) => {
    if (!await confirm({
      title: `Remove ${c.display_name || PROVIDERS[c.provider]?.label}?`,
      message: 'It disappears from this list and its settings go with it. Connecting the same system again starts from scratch.',
      confirmLabel: 'Remove it',
    })) return;
    setBusy(c.id);
    try {
      await deleteConnector(c.id);
      showToast('Connector removed.');
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
    <div className="p-6">
      <div className="mb-5 flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-dt-title">Connectors</h1>
          <p className="text-dt-support text-sm mt-1">
            Your systems of record stay yours — DreamTeam reads them live (fetch-only) or keeps a searchable working copy (ingest), and every access is audited.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowAi((v) => !v)} className="border border-dt-border-strong hover:border-indigo-500 text-dt-body text-sm px-4 py-2 rounded-lg transition-colors">
            {showAi ? 'Close assistant' : '✨ Ask about systems'}
          </button>
          {connectors.length > 0 && (
            <button onClick={() => setShowConnect(true)} className="bg-dt-accent-strong hover:bg-dt-accent-hover text-white text-sm px-4 py-2 rounded-lg transition-colors">
              + Connect a system
            </button>
          )}
        </div>
      </div>

      {showAi && (
        <div className="mb-6">
          <AISessionPanel subjectKind="workspace" subjectLabel="Connected systems"
            examples={['Which employees can write to which systems?', 'What actions are registered and which always need my approval?', 'What do I need to connect our helpdesk?']} />
        </div>
      )}

      {toast && <div className="mb-4 rounded-xl border border-dt-accent-border bg-dt-accent-soft px-4 py-3 text-xs text-dt-accent-text">{toast}</div>}
      {error && <div className="mb-4 rounded-xl border border-dt-danger-border bg-dt-danger-soft px-4 py-3 text-xs text-dt-danger">{error}</div>}

      {!loading && !missingTables && (
        <TemplateLibrary templates={templates} onUse={t => setUseTemplate(t)} onBuild={() => setShowBuilder(true)} />
      )}

      {loading ? (
        <LiveLoadingSkeleton rows={4} />
      ) : missingTables ? (
        <div className="rounded-xl border border-dt-border-strong bg-dt-card p-5">
          <p className="text-sm font-medium text-dt-body mb-1">Connector tables not yet provisioned</p>
          <p className="text-xs text-dt-support">
            Run <code className="text-dt-support bg-dt-panel px-1 py-0.5 rounded">supabase/migrations/026_connector_hub_evidence.sql</code> in the Supabase SQL Editor, then reload.
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
            {(Object.keys(PROVIDERS) as ConnectorProvider[]).filter(p => p !== 'template').slice(0, 8).map(p => (
              <button key={p} onClick={() => setShowConnect(true)} className="text-left bg-dt-card border border-dt-border hover:border-indigo-500/50 rounded-xl p-4 transition-colors">
                <p className="text-sm font-semibold text-dt-title">{PROVIDER_ICON[p]} {PROVIDERS[p].label}</p>
                <p className="text-[11px] text-dt-muted mt-0.5">{PROVIDERS[p].tagline}</p>
                <p className="text-xs text-indigo-400 mt-2">{PROVIDERS[p].implemented ? 'Connect →' : 'Register →'}</p>
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="space-y-6">
          {actionDefs.length > 0 && (
            <div className="rounded-xl border border-dt-border bg-dt-card p-4">
              <button onClick={() => setShowActions(o => !o)} className="flex items-center gap-2 text-sm font-semibold text-dt-title w-full text-left">
                <span>{showActions ? '▾' : '▸'}</span> Registered actions
                <span className="text-[11px] font-normal text-dt-muted">— {actionDefs.length} write-back action(s) your employees can propose; destructive ones always stop at your desk</span>
              </button>
              {showActions && (
                <div className="mt-3 divide-y divide-dt-border">
                  {actionDefs.map(a => {
                    const destructive = (a.risk as { destructive?: boolean } | null)?.destructive === true;
                    return (
                      <div key={a.id} className="flex items-center gap-2 py-2 flex-wrap">
                        <span className="text-sm text-dt-body">{a.label}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-dt-panel text-dt-muted">{a.category ?? 'general'}</span>
                        {destructive
                          ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-dt-danger-soft text-dt-danger">destructive — always human-gated</span>
                          : <span className="text-[10px] px-1.5 py-0.5 rounded bg-dt-ok-soft text-dt-ok">gated by guardrails + trust dial</span>}
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-dt-panel text-dt-muted">{a.scope}</span>
                        {a.description && <span className="text-[11px] text-dt-muted basis-full">{a.description}</span>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          <LearnedToolsPanel onToast={showToast} />
          {connectors.map(c => {
            const objs = objects[c.id] ?? [];
            const acts = actions[c.id] ?? [];
            const isBusy = busy === c.id;
            const meta = PROVIDERS[c.provider];
            return (
              <div key={c.id} className="rounded-2xl border border-dt-border bg-dt-card p-5">
                {/* Header */}
                <div className="flex items-start justify-between flex-wrap gap-3 mb-4">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <h2 className="text-base font-semibold text-dt-title">{PROVIDER_ICON[c.provider]} {c.display_name || meta?.label || c.provider}</h2>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-dt-panel text-dt-support uppercase tracking-wide">{c.provider.replace('_', ' ')}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-dt-accent-soft text-dt-accent-text">{CATEGORY_SHORT[c.category] ?? c.category}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${c.access_mode === 'fetch_only' ? 'bg-teal-600 text-teal-100' : 'bg-purple-600 text-purple-100'}`}>
                        {c.access_mode === 'fetch_only' ? 'fetch-only · never stored' : 'ingest · working copy'}
                      </span>
                      {(() => { const st = connectionState(c); return <Chip tone={st.tone} dot title={st.means}>{st.label}</Chip>; })()}
                    </div>
                    <p className="text-xs text-dt-muted mt-1">
                      {[c.base_url,
                        (c.last_ok_at || c.last_error_at) ? `checked ${fmtSince(c.last_ok_at || c.last_error_at)}` : null,
                        c.last_sync_at ? `last sync ${fmtSince(c.last_sync_at)}` : null,
                      ].filter(Boolean).join(' · ')}
                    </p>
                    {/* W4-R (docs/16): a green "Connected" said nothing about which
                        employee may actually USE the system — the default-deny
                        grants were invisible in this module. */}
                    <p className="text-xs mt-1">
                      {(() => {
                        const g = grantsFor(c);
                        return g.length === 0
                          ? <span className="text-dt-warn">No employee has access to this system yet — grant it in Governance → Data Access.</span>
                          : <span className="text-dt-muted">Employee access: {g.map(x => `${x.name} (${x.level.replace('_', '-')})`).join(' · ')}</span>;
                      })()}
                    </p>
                    {/* ── What broke, and who it stops ────────────────────────
                        Was a bare, literal-red-tinted text-xs line carrying the
                        raw error label and nothing else — true, and useless to the
                        person who has to decide whether it matters. The names
                        come from the SAME grants read just above, so the card
                        can say who is affected without inventing a link.
                        ⚠ It deliberately does NOT claim what the outage is
                        CAUSING (the handoff's "that's why two invoices are
                        stuck"). Nothing joins a connector failure to blocked
                        work today, and a fabricated consequence on a red
                        banner is worse than no consequence at all. */}
                    {connectorHealth(c) !== 'healthy' && c.last_error && (
                      <Banner tone="danger" className="mt-2">
                        <span className="font-medium">{connectorErrorLabel(c.last_error)}</span>
                        {(() => {
                          const g = grantsFor(c);
                          if (!g.length) return ' No employee uses this system yet, so nothing is waiting on it.';
                          const names = g.map(x => x.name);
                          return ` ${names.length === 1 ? `${names[0]} can't` : `${names.slice(0, -1).join(', ')} and ${names.slice(-1)} can't`} reach it until this is fixed.`;
                        })()}
                      </Banner>
                    )}
                  </div>
                  {/* ── The admin work stops being the first thing you see ──
                      Eight buttons used to sit in one row: Test connection,
                      Run health check, Field mapping, What gets ingested,
                      Sync knowledge, Register tools, Sync tickets, and
                      Disconnect. Field maps and ingest filters are things you
                      set up once; they were competing for attention with the
                      one button that matters when a system is down. The
                      configuration folds behind "Settings"; what stays out is
                      what you act on — reconnect it, or sync it.
                      ⚠ Every disabled= and role gate below is carried over
                      unchanged; this moved buttons, it did not open any. */}
                  <div className="flex gap-2 flex-wrap items-start">
                    <Button size="sm" disabled={isBusy} onClick={() => setSettingsFor(settingsFor === c.id ? null : c.id)}>
                      {settingsFor === c.id ? 'Hide settings' : 'Settings'}
                    </Button>
                    {meta?.knowledgeSync && (
                      <button disabled={isBusy} onClick={() => void doKnowledgeSync(c)}
                        title={c.access_mode === 'fetch_only' ? 'Fetch-only connectors refuse sync server-side — try it.' : 'Ingest help articles / pages into knowledge'}
                        className="px-3 py-1.5 rounded-lg text-xs bg-dt-accent-strong hover:bg-dt-accent-hover text-white disabled:opacity-50 transition-colors">
                        {isBusy ? 'Working…' : 'Sync knowledge'}
                      </button>
                    )}
                    {c.provider === 'mcp' && (
                      <button disabled={isBusy || c.status === 'disconnected'} onClick={() => void doMcpSync(c)}
                        title="Read this server's tool list and register each tool as an approval-gated action"
                        className="px-3 py-1.5 rounded-lg text-xs bg-dt-accent-strong hover:bg-dt-accent-hover text-white disabled:opacity-50 transition-colors">
                        {isBusy ? 'Working…' : 'Register tools'}
                      </button>
                    )}
                    {c.provider === 'zendesk' && (
                      <button disabled={isBusy || c.status === 'disconnected'} onClick={() => void doTicketSync(c)} className="px-3 py-1.5 rounded-lg text-xs bg-dt-border-strong hover:bg-dt-panel text-dt-title disabled:opacity-50 transition-colors">
                        Sync tickets
                      </button>
                    )}
                    {c.status === 'connected' ? (
                      <button disabled={isBusy || !canManageConnectors} onClick={() => void doDisconnect(c)} className="px-3 py-1.5 rounded-lg text-xs text-red-400 border border-red-500/30 hover:bg-red-600/20 disabled:opacity-50 transition-colors">
                        Disconnect
                      </button>
                    ) : (
                      <>
                        <button disabled={isBusy} onClick={() => { setReconnectTarget(c); setShowConnect(true); }} className="px-3 py-1.5 rounded-lg text-xs text-dt-ok border border-dt-ok-border hover:bg-dt-ok-soft disabled:opacity-50 transition-colors">
                          Reconnect
                        </button>
                        <button disabled={isBusy || !canManageConnectors} onClick={() => void doRemove(c)} className="px-3 py-1.5 rounded-lg text-xs text-red-400 border border-red-500/30 hover:bg-red-600/20 disabled:opacity-50 transition-colors">
                          Remove
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* The moved controls, unchanged in behaviour and gating. */}
                {settingsFor === c.id && (
                  <div className="mb-4 rounded-xl border border-dt-border-strong bg-dt-inset p-3 flex gap-2 flex-wrap">
                    <Button size="sm" disabled={isBusy || !meta?.implemented} onClick={() => void doTest(c)}>Test connection</Button>
                    <Button size="sm" disabled={isBusy || !meta?.implemented} onClick={() => void doHealthCheck(c)}>Run health check</Button>
                    {/* ⚠ connectors.update is owner/admin in RLS and this
                        page is MANAGE, so a manager could open the field map,
                        edit it and press Save — and RLS would refuse as a
                        zero-row SUCCESS, which reads as "saved" and is not.
                        I moved this button behind Settings earlier today
                        without checking its tier; the checker found it. */}
                    {canManageConnectors && (
                      <Button size="sm" disabled={isBusy} onClick={() => setFieldMapFor(fieldMapFor === c.id ? null : c.id)}>Field mapping</Button>
                    )}
                    {(['sharepoint', 'gdrive', 'notion', 'box', 'dropbox'] as ConnectorProvider[]).includes(c.provider) && (
                      <Button size="sm" disabled={isBusy} onClick={() => setIngestFor(ingestFor === c.id ? null : c.id)}>What gets ingested</Button>
                    )}
                  </div>
                )}

                {!meta?.implemented && (
                  <p className="text-xs text-dt-warn mb-3">Registered, but this system's adapter is not built yet — every call returns an honest "not implemented" until it ships.</p>
                )}

                {/* The role goes on the EDITOR, not only on the button that
                    opens it. Gating the entry point alone leaves the form one
                    stale state flag away from rendering for someone whose
                    save the database will refuse — and a guard you have to
                    reach the right way to be protected by is not a guard. */}
                {fieldMapFor === c.id && canManageConnectors && (
                  <FieldMapEditor connector={c} isBusy={isBusy} onSave={(m) => void saveFieldMap(c, m)} />
                )}

                {ingestFor === c.id && (
                  <IngestControlPanel connector={c} onToast={showToast} />
                )}

                {/* Zendesk-only: per-object mode + write-back registry */}
                {c.provider === 'zendesk' && objs.length > 0 && (
                  <>
                    <p className="text-xs font-medium text-dt-muted uppercase tracking-wider mb-2">Objects — data mode</p>
                    <div className="rounded-xl border border-dt-border overflow-hidden mb-4">
                      <table className="w-full text-sm">
                        <thead className="bg-dt-inset">
                          <tr>
                            {['Object', 'Mode', 'Interval', 'Last synced', 'Enabled'].map(h => (
                              <th key={h} className="py-2 px-3 text-left text-[11px] uppercase tracking-wide text-dt-muted font-medium">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {objs.map(o => (
                            <tr key={o.id} className="border-t border-dt-border">
                              <td className="py-2 px-3 text-dt-body">{OBJECT_LABELS[o.object_type] ?? o.object_type}</td>
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
                                ) : <span className="text-xs text-dt-faint">at action time</span>}
                              </td>
                              <td className="py-2 px-3 text-xs text-dt-support">{o.mode === 'sync' ? fmtSince(o.last_synced_at) : '—'}</td>
                              <td className="py-2 px-3">
                                <button onClick={() => void setObjField(o, { enabled: !o.enabled })}
                                  className={`text-xs px-2 py-0.5 rounded-full transition-colors ${o.enabled ? 'bg-emerald-500/20 text-emerald-400' : 'bg-dt-panel text-dt-muted'}`}>
                                  {o.enabled ? 'Enabled' : 'Disabled'}
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="text-xs font-medium text-dt-muted uppercase tracking-wider mb-2">Write-back actions — into the system of record</p>
                    <div className="flex flex-wrap gap-2 mb-4">
                      {acts.map(a => (
                        <button key={a.id} onClick={() => void toggleAction(a)}
                          className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${a.enabled
                            ? 'border-dt-accent-border bg-dt-accent-soft text-dt-accent-text'
                            : 'border-dt-border-strong bg-dt-card text-dt-muted'}`}>
                          {ACTION_LABELS[a.action_key] ?? a.action_key} · {a.enabled ? 'on' : 'off'}
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {/* Read-through search — every provider */}
                {meta?.implemented && (
                  <>
                    <p className="text-xs font-medium text-dt-muted uppercase tracking-wider mb-2">Live search (read-through)</p>
                    <div className="flex items-center gap-2 flex-wrap">
                      <input value={rtQuery} onChange={e => setRtQuery(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') void doSearch(c); }}
                        placeholder="Search this system…"
                        className="bg-dt-page border border-dt-border-strong rounded-lg text-xs text-dt-body px-3 py-1.5 w-64" />
                      <button disabled={isBusy} onClick={() => void doSearch(c)} className="px-3 py-1.5 rounded-lg text-xs text-dt-support border border-dt-border-strong hover:border-dt-border-strong disabled:opacity-50 transition-colors">
                        Search live
                      </button>
                      <span className="text-[11px] text-dt-faint">Fetched at question time — nothing stored, audit event only.</span>
                    </div>
                    {rtErr && !rtResult && <p className="text-xs text-dt-danger mt-2">{rtErr}</p>}
                    {rtResult?.connectorId === c.id && (
                      <div className="mt-3 space-y-2">
                        <p className="text-[11px] text-dt-muted">{rtResult.items.length} result(s){rtResult.latency ? ` in ${rtResult.latency}ms` : ''} — live from {meta.label}, not persisted.</p>
                        {rtResult.items.map((it, i) => (
                          <div key={i} className="rounded-xl border border-dt-border bg-dt-page p-3">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-xs font-medium text-dt-body">{it.title}</span>
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-dt-panel text-dt-support">{it.type}</span>
                              <span className="text-[10px] text-dt-faint">ref {it.ref}</span>
                              {it.url && <a href={it.url} target="_blank" rel="noreferrer" className="text-[10px] text-dt-accent-text hover:underline">open in source ↗</a>}
                            </div>
                            {it.snippet && <p className="text-[11px] text-dt-support mt-1">{it.snippet}</p>}
                          </div>
                        ))}
                        {rtResult.items.length === 0 && <p className="text-xs text-dt-muted">No matches in this system.</p>}
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showConnect && <ConnectWizard reconnect={reconnectTarget ?? undefined} onClose={() => { setShowConnect(false); setReconnectTarget(null); }} onDone={m => { showToast(m); void load(); }} onCustom={() => setShowBuilder(true)} />}
      {showBuilder && <TemplateBuilderModal onClose={() => setShowBuilder(false)} onDone={m => { showToast(m); void load(); }} />}
      {useTemplate && <ConnectFromTemplateModal template={useTemplate} onClose={() => setUseTemplate(null)} onDone={m => { showToast(m); void load(); }} />}
      {confirmUI}
    </div>
  );
}
