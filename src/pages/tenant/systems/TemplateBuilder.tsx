import React, { useMemo, useState } from 'react';
import {
  AdapterDefinition, AdapterOpBinding, AdapterTemplate, AdapterAuthType,
  AUTH_TYPES, AUTH_META, validateAdapterDefinition,
} from '../../../lib/adapterTemplates';
import {
  SystemCategory, CATEGORIES, CATEGORY_LABELS, CATEGORY_SHORT, CATEGORY_OPS,
} from '../../../lib/categoryContracts';
import {
  ConnectorAccessMode, ACCESS_MODE_EXPLAIN,
  saveAdapterTemplate, publishAdapterTemplate, templateDryRun,
  connectFromTemplate, templateSecretFields, TemplateDryRunResult,
} from '../../../lib/connectorApi';

// ============================================================
// Template Builder — the Declarative Adapter Framework UI.
// Connecting ANY REST system becomes configuration, not code:
// 5 guided steps (name+category → auth style → base URL+variables →
// bind operations with LIVE "Test now" showing the raw response
// side-by-side with what DreamTeam extracted → save & publish).
// Written for a non-developer: plain language everywhere.
// ============================================================

const inputCls = 'w-full bg-slate-950 border border-slate-700 rounded-lg text-sm text-slate-200 px-3 py-2';
const smallInput = 'bg-slate-950 border border-slate-700 rounded-lg text-xs text-slate-200 px-2 py-1.5';

interface OpDraft {
  bound: boolean;
  method: 'GET' | 'POST';
  path_template: string;
  query_params: string;   // "key=value" per line
  body_template: string;  // raw JSON
  items_path: string;
  id_path: string;
  title_path: string;
  snippet_path: string;
  url_path: string;
  single_item: boolean;
}

const emptyOp = (): OpDraft => ({
  bound: false, method: 'GET', path_template: '', query_params: '', body_template: '',
  items_path: '', id_path: 'id', title_path: '', snippet_path: '', url_path: '', single_item: false,
});

function draftToBinding(d: OpDraft): AdapterOpBinding {
  const qp: Record<string, string> = {};
  for (const line of d.query_params.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) qp[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  let body: Record<string, unknown> | undefined;
  if (d.body_template.trim()) {
    try { body = JSON.parse(d.body_template); } catch { body = undefined; }
  }
  return {
    method: d.method,
    path_template: d.path_template.trim(),
    ...(Object.keys(qp).length ? { query_params: qp } : {}),
    ...(body ? { body_template: body } : {}),
    response: {
      items_path: d.items_path.trim(),
      id_path: d.id_path.trim(),
      title_path: d.title_path.trim(),
      ...(d.snippet_path.trim() ? { snippet_path: d.snippet_path.trim() } : {}),
      ...(d.url_path.trim() ? { url_path: d.url_path.trim() } : {}),
    },
    ...(d.single_item ? { single_item: true } : {}),
  };
}

export function TemplateBuilderModal({ onClose, onDone }: {
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<SystemCategory>('other');
  const [authType, setAuthType] = useState<AdapterAuthType>('api_key_header');
  const [headerName, setHeaderName] = useState('X-Api-Key');
  const [tokenUrl, setTokenUrl] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [vars, setVars] = useState<{ key: string; label: string; help: string }[]>([]);
  const [ops, setOps] = useState<Record<string, OpDraft>>({});
  // Test-now state (live creds, in-flight only)
  const [testVars, setTestVars] = useState<Record<string, string>>({});
  const [testSecrets, setTestSecrets] = useState<Record<string, string>>({});
  const [testParam, setTestParam] = useState('');
  const [testResult, setTestResult] = useState<{ op: string; r: TemplateDryRunResult } | null>(null);
  const [testOpName, setTestOpName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const catOps = CATEGORY_OPS[category] ?? [];

  const definition: AdapterDefinition = useMemo(() => ({
    auth: {
      type: authType,
      ...(authType === 'api_key_header' ? { header_name: headerName.trim() } : {}),
      ...(authType === 'oauth2_client_credentials' ? { token_url: tokenUrl.trim() } : {}),
    },
    base_url_template: baseUrl.trim(),
    variables: vars.filter(v => v.key.trim()).map(v => ({ key: v.key.trim(), label: v.label || v.key, ...(v.help ? { help: v.help } : {}) })),
    ops: Object.fromEntries(Object.entries(ops).filter(([, d]) => d.bound && d.path_template.trim()).map(([k, d]) => [k, draftToBinding(d)])),
    test_op: testOpName ? {
      op: testOpName,
      params: catOps.find(o => o.op === testOpName)?.kind === 'get' ? { ref: testParam || '1' } : { query: testParam || 'test' },
    } : undefined,
  }), [authType, headerName, tokenUrl, baseUrl, vars, ops, testOpName, testParam, catOps]);

  const boundOps = Object.keys(definition.ops);

  const runTest = async (op: string) => {
    setErr(null); setBusy(true); setTestResult(null);
    try {
      const kind = catOps.find(o => o.op === op)?.kind;
      const r = await templateDryRun({
        definition: { ...definition, test_op: { op } },
        category, op,
        variables: testVars, secrets: testSecrets,
        params: kind === 'get' ? { external_ref: testParam || '1' } : { query: testParam || 'test' },
      });
      setTestResult({ op, r });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const save = async (publish: boolean) => {
    setErr(null);
    const v = validateAdapterDefinition(definition, category);
    if (!v.ok) { setErr(v.errors.join(' ')); return; }
    setBusy(true);
    try {
      const id = await saveAdapterTemplate({ name, description, category, definition });
      if (publish) await publishAdapterTemplate(id, name);
      onDone(publish
        ? `Template "${name}" saved and published — connect a system from it in the template library.`
        : `Template "${name}" saved as a draft.`);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const stepTitle = [
    '', 'What system is this?', 'How does it check who you are?',
    'Where does it live?', 'What may DreamTeam ask it?', 'Save & publish',
  ][step];

  return (
    <>
      <div className="fixed inset-0 z-40 bg-slate-950/70" onClick={() => !busy && onClose()} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-6 pointer-events-none">
        <div className="pointer-events-auto w-full max-w-3xl max-h-[92vh] overflow-y-auto bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl p-6">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-sm font-semibold text-white">Custom system — step {step} of 5: {stepTitle}</h2>
            <button onClick={onClose} className="text-xs text-slate-500 hover:text-white">✕</button>
          </div>
          <p className="text-xs text-slate-500 mb-4">Connect any system that has a REST API — no code, just answers to five questions. The result is a reusable template.</p>

          {step === 1 && (
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1">System name</label>
                <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Acme Helpdesk" className={inputCls} />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">What kind of system is it?</label>
                <div className="grid grid-cols-2 gap-2">
                  {CATEGORIES.map(cat => (
                    <button key={cat} onClick={() => { setCategory(cat); setOps({}); setTestOpName(''); }}
                      className={`text-left rounded-xl border p-2.5 transition-colors ${category === cat ? 'border-indigo-500/60 bg-indigo-500/10' : 'bg-slate-950 border-slate-800 hover:border-indigo-500/40'}`}>
                      <p className="text-xs font-semibold text-white">{CATEGORY_SHORT[cat]}</p>
                      <p className="text-[10px] text-slate-500 mt-0.5">{CATEGORY_LABELS[cat]}</p>
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-slate-600 mt-1.5">The kind decides what your Digital Employees may ask it — a helpdesk answers "have we solved this before?", a CRM answers "who is this customer?".</p>
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Notes (optional)</label>
                <input value={description} onChange={e => setDescription(e.target.value)} placeholder="Anything a teammate should know about this connection" className={inputCls} />
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-2">
              {AUTH_TYPES.map(t => (
                <label key={t} className={`flex items-start gap-2 rounded-xl border p-3 cursor-pointer ${authType === t ? 'border-indigo-500/60 bg-indigo-500/5' : 'border-slate-800'}`}>
                  <input type="radio" checked={authType === t} onChange={() => setAuthType(t)} className="mt-0.5" />
                  <span>
                    <span className="text-xs font-semibold text-slate-200 block">{AUTH_META[t].label}</span>
                    <span className="text-[11px] text-slate-500">{AUTH_META[t].help}</span>
                  </span>
                </label>
              ))}
              {authType === 'api_key_header' && (
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Which header carries the key?</label>
                  <input value={headerName} onChange={e => setHeaderName(e.target.value)} placeholder="X-Api-Key" className={inputCls} />
                </div>
              )}
              {authType === 'oauth2_client_credentials' && (
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Token URL (where the ID + secret become a token)</label>
                  <input value={tokenUrl} onChange={e => setTokenUrl(e.target.value)} placeholder="https://auth.example.com/oauth/token" className={inputCls} />
                </div>
              )}
              <p className="text-[11px] text-slate-600">This template only describes HOW credentials are presented. The actual key/token values are entered when someone connects, stored server-side only, never shown again.</p>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1">API base URL</label>
                <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://{subdomain}.example.com/api/v2" className={inputCls} />
                <p className="text-[11px] text-slate-600 mt-1">If part of the URL differs per account (like a subdomain), write it in curly braces — e.g. <code className="text-slate-400">{'https://{subdomain}.example.com'}</code> — and declare it below. Whoever connects fills it in.</p>
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs text-slate-400">Variables people fill in when connecting</label>
                  <button onClick={() => setVars(v => [...v, { key: '', label: '', help: '' }])} className="text-xs text-indigo-400 hover:text-indigo-300">+ Add variable</button>
                </div>
                {vars.length === 0 && <p className="text-[11px] text-slate-600">None yet — only needed when the base URL (or a path) contains {'{placeholders}'}.</p>}
                {vars.map((v, i) => (
                  <div key={i} className="flex gap-2 mb-2">
                    <input value={v.key} onChange={e => setVars(a => a.map((x, j) => j === i ? { ...x, key: e.target.value } : x))} placeholder="subdomain" className={smallInput + ' w-32'} />
                    <input value={v.label} onChange={e => setVars(a => a.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} placeholder="Plain-language label" className={smallInput + ' flex-1'} />
                    <input value={v.help} onChange={e => setVars(a => a.map((x, j) => j === i ? { ...x, help: e.target.value } : x))} placeholder="Where to find it (optional)" className={smallInput + ' flex-1'} />
                    <button onClick={() => setVars(a => a.filter((_, j) => j !== i))} className="text-xs text-red-400">✕</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="space-y-3">
              <p className="text-[11px] text-slate-500">These are the only things a {CATEGORY_SHORT[category]} may be asked. Bind the ones this API supports — leave the rest off (DreamTeam will say "not supported" honestly). Use <code className="text-slate-400">{'{query}'}</code> for search words and <code className="text-slate-400">{'{ref}'}</code> for a record id.</p>
              {/* Test credentials — used live, in-flight only */}
              <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                <p className="text-[11px] font-medium text-slate-400 mb-2">Credentials for testing (used for the live test only — never stored from here)</p>
                <div className="flex gap-2 flex-wrap">
                  {(definition.variables ?? []).map(v => (
                    <input key={v.key} value={testVars[v.key] ?? ''} onChange={e => setTestVars(s => ({ ...s, [v.key]: e.target.value }))}
                      placeholder={v.label || v.key} className={smallInput + ' w-40'} />
                  ))}
                  {AUTH_META[authType].secretFields.map(f => (
                    <input key={f.key} type="password" value={testSecrets[f.key] ?? ''} onChange={e => setTestSecrets(s => ({ ...s, [f.key]: e.target.value }))}
                      placeholder={f.label} className={smallInput + ' w-44'} />
                  ))}
                  <input value={testParam} onChange={e => setTestParam(e.target.value)} placeholder="test search words / record id" className={smallInput + ' w-44'} />
                </div>
              </div>
              {catOps.map(o => {
                const d = ops[o.op] ?? emptyOp();
                const set = (patch: Partial<OpDraft>) => setOps(s => ({ ...s, [o.op]: { ...(s[o.op] ?? emptyOp()), ...patch } }));
                return (
                  <div key={o.op} className={`rounded-xl border p-3 ${d.bound ? 'border-indigo-500/40 bg-indigo-500/5' : 'border-slate-800 bg-slate-950/40'}`}>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={d.bound} onChange={e => set({ bound: e.target.checked })} />
                      <span className="text-xs font-semibold text-slate-200">{o.label}</span>
                      <span className="text-[10px] text-slate-600 font-mono">{o.op} · {o.kind === 'search' ? 'takes search words {query}' : 'takes a record id {ref}'}</span>
                    </label>
                    {d.bound && (
                      <div className="mt-2 space-y-2">
                        <div className="flex gap-2">
                          <select value={d.method} onChange={e => set({ method: e.target.value as 'GET' | 'POST' })} className={smallInput}>
                            <option>GET</option><option>POST</option>
                          </select>
                          <input value={d.path_template} onChange={e => set({ path_template: e.target.value })}
                            placeholder={o.kind === 'get' ? '/things/{ref}' : '/things/search'} className={smallInput + ' flex-1'} />
                          <label className="flex items-center gap-1 text-[11px] text-slate-500">
                            <input type="checkbox" checked={d.single_item} onChange={e => set({ single_item: e.target.checked })} /> response is one record
                          </label>
                        </div>
                        <div className="flex gap-2">
                          <textarea value={d.query_params} onChange={e => set({ query_params: e.target.value })}
                            placeholder={'URL parameters, one per line:\nq={query}'} rows={2} className={smallInput + ' flex-1 font-mono'} />
                          {d.method === 'POST' && (
                            <textarea value={d.body_template} onChange={e => set({ body_template: e.target.value })}
                              placeholder={'JSON body, e.g.\n{"query": "{query}", "limit": 10}'} rows={2} className={smallInput + ' flex-1 font-mono'} />
                          )}
                        </div>
                        <div className="grid grid-cols-5 gap-2">
                          {([['items_path', 'where results live (e.g. data.results, empty = whole response)'], ['id_path', 'id field'], ['title_path', 'title field'], ['snippet_path', 'summary field (optional)'], ['url_path', 'link field (optional)']] as const).map(([k, ph]) => (
                            <input key={k} value={d[k]} onChange={e => set({ [k]: e.target.value } as Partial<OpDraft>)} placeholder={ph} title={ph} className={smallInput} />
                          ))}
                        </div>
                        <button disabled={busy} onClick={() => void runTest(o.op)}
                          className="px-3 py-1.5 rounded-lg text-xs bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50">
                          {busy ? 'Calling live…' : 'Test now (live call)'}
                        </button>
                        {testResult?.op === o.op && (
                          <div className="grid grid-cols-2 gap-2">
                            <div className="rounded-lg border border-slate-800 bg-slate-950 p-2 overflow-auto max-h-56">
                              <p className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">Raw response from the API</p>
                              <pre className="text-[10px] text-slate-400 whitespace-pre-wrap break-all">{JSON.stringify(testResult.r.raw_response ?? testResult.r.errors ?? null, null, 1)?.slice(0, 3000)}</pre>
                            </div>
                            <div className="rounded-lg border border-slate-800 bg-slate-950 p-2 overflow-auto max-h-56">
                              <p className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">What DreamTeam extracted</p>
                              {testResult.r.ok ? (
                                <>
                                  <p className="text-[10px] text-emerald-400 mb-1">✓ {testResult.r.items.length} item(s) in {testResult.r.latency_ms}ms</p>
                                  {testResult.r.items.slice(0, 5).map((it, i) => (
                                    <p key={i} className="text-[10px] text-slate-300 mb-1">• <span className="font-medium">{it.title}</span> <span className="text-slate-600">(id {it.ref})</span>{it.snippet ? ` — ${it.snippet.slice(0, 80)}` : ''}</p>
                                  ))}
                                  {testResult.r.items.length === 0 && <p className="text-[10px] text-amber-400">The call worked but extracted nothing — check "where results live".</p>}
                                </>
                              ) : (
                                <p className="text-[10px] text-red-300">{testResult.r.error}{testResult.r.detail ? ` — ${testResult.r.detail}` : ''}{(testResult.r.errors ?? []).join(' ')}</p>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {step === 5 && (
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1">Which operation proves the connection works?</label>
                <select value={testOpName} onChange={e => setTestOpName(e.target.value)} className={inputCls}>
                  <option value="">— choose —</option>
                  {boundOps.map(op => <option key={op} value={op}>{op}</option>)}
                </select>
                <p className="text-[11px] text-slate-600 mt-1">When someone connects from this template, DreamTeam runs this operation once to verify their credentials.</p>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                <p className="text-[11px] text-slate-400">Summary: <span className="text-slate-200">{name || '(unnamed)'}</span> · {CATEGORY_SHORT[category]} · {AUTH_META[authType].label} · {boundOps.length} operation(s) bound{(definition.variables ?? []).length ? ` · variables: ${(definition.variables ?? []).map(v => v.key).join(', ')}` : ''}</p>
              </div>
              <p className="text-[11px] text-slate-600">Publishing makes the template available in your workspace's library so systems can be connected from it. Drafts stay editable and invisible to the connect flow.</p>
            </div>
          )}

          {err && <p className="text-xs text-red-300 mt-3 whitespace-pre-wrap">{err}</p>}
          <div className="flex gap-3 mt-5">
            {step > 1 && <button disabled={busy} onClick={() => setStep(s => s - 1)} className="px-3 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 text-xs disabled:opacity-50">← Back</button>}
            <div className="flex-1" />
            {step < 5 && (
              <button disabled={busy || (step === 1 && !name.trim()) || (step === 3 && !baseUrl.trim() && false)}
                onClick={() => setStep(s => s + 1)}
                className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs disabled:opacity-50">Next →</button>
            )}
            {step === 5 && (
              <>
                <button disabled={busy} onClick={() => void save(false)} className="px-3 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 text-xs disabled:opacity-50">Save draft</button>
                <button disabled={busy} onClick={() => void save(true)} className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs disabled:opacity-50">{busy ? 'Saving…' : 'Save & publish'}</button>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// ── Connect FROM a template ───────────────────────────────────────

export function ConnectFromTemplateModal({ template, onClose, onDone }: {
  template: AdapterTemplate;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [displayName, setDisplayName] = useState('');
  const [vars, setVars] = useState<Record<string, string>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [accessMode, setAccessMode] = useState<ConnectorAccessMode>('fetch_only');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const secretFields = templateSecretFields(template.definition);

  const submit = async () => {
    setErr(null);
    const missing = (template.definition.variables ?? []).filter(v => !vars[v.key]?.trim());
    if (missing.length) { setErr(`Please fill in: ${missing.map(v => v.label || v.key).join(', ')}`); return; }
    setBusy(true);
    try {
      const { test } = await connectFromTemplate({ template, displayName, variables: vars, secrets, accessMode });
      onDone(test.ok
        ? `${template.name} connected — verified live via the template's test operation${test.detail ? ` (${test.detail})` : ''}.`
        : `${template.name} saved, but the live test failed: ${test.error ?? 'unknown'}${test.detail ? ` — ${test.detail}` : ''}`);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-slate-950/70" onClick={() => !busy && onClose()} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-6 pointer-events-none">
        <div className="pointer-events-auto w-full max-w-lg max-h-[90vh] overflow-y-auto bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl p-6">
          <h2 className="text-sm font-semibold text-white mb-1">Connect {template.name}</h2>
          <p className="text-xs text-slate-500 mb-1">{CATEGORY_SHORT[template.category]} · {AUTH_META[template.definition.auth.type].label}</p>
          {template.scope === 'platform' && (
            <p className="text-[11px] text-amber-400 mb-3">Community template — shaped to the public API documentation, untested until connected. Verify results against your account.</p>
          )}
          {template.description && <p className="text-[11px] text-slate-500 mb-3">{template.description}</p>}
          <div className="space-y-3">
            {(template.definition.variables ?? []).map(v => (
              <div key={v.key}>
                <label className="block text-xs text-slate-400 mb-1">{v.label || v.key}</label>
                <input value={vars[v.key] ?? ''} onChange={e => setVars(s => ({ ...s, [v.key]: e.target.value }))} placeholder={v.help ?? ''} className={inputCls} />
                {v.help && <p className="text-[10px] text-slate-600 mt-0.5">{v.help}</p>}
              </div>
            ))}
            {secretFields.map(f => (
              <div key={f.key}>
                <label className="block text-xs text-slate-400 mb-1">{f.label}</label>
                <input type="password" value={secrets[f.key] ?? ''} onChange={e => setSecrets(s => ({ ...s, [f.key]: e.target.value }))} className={inputCls} />
              </div>
            ))}
            {secretFields.length > 0 && (
              <p className="text-[11px] text-slate-600">Credentials are stored server-side only — never shown again, never readable from the browser, purged instantly on disconnect.</p>
            )}
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
              <input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder={`${template.name} — production`} className={inputCls} />
            </div>
          </div>
          {err && <p className="text-xs text-red-300 mt-3">{err}</p>}
          <div className="flex gap-3 mt-5">
            <button disabled={busy} onClick={onClose} className="flex-1 px-3 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 text-xs disabled:opacity-50">Cancel</button>
            <button disabled={busy} onClick={() => void submit()} className="flex-1 px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs disabled:opacity-50">{busy ? 'Testing…' : 'Test & Save'}</button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Template library section ─────────────────────────────────────

export function TemplateLibrary({ templates, onUse, onBuild }: {
  templates: AdapterTemplate[];
  onUse: (t: AdapterTemplate) => void;
  onBuild: () => void;
}) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5 mb-6">
      <div className="flex items-start justify-between flex-wrap gap-2 mb-3">
        <div>
          <h2 className="text-sm font-semibold text-white">Template library — connect anything with a REST API</h2>
          <p className="text-xs text-slate-500 mt-0.5">A template turns a system's API into configuration: pick one, enter your credentials, done. Or build your own in five guided steps — no code.</p>
        </div>
        <button onClick={onBuild} className="px-3 py-1.5 rounded-lg text-xs bg-indigo-600 hover:bg-indigo-500 text-white">+ Build a custom template</button>
      </div>
      {templates.length === 0 ? (
        <p className="text-xs text-slate-600">No templates yet — the platform library appears once migration 028 is applied.</p>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
          {templates.map(t => (
            <div key={t.id} className="rounded-xl border border-slate-800 bg-slate-950 p-3 flex flex-col">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-xs font-semibold text-white">{t.name}</p>
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300">{CATEGORY_SHORT[t.category]}</span>
                <span className={`text-[9px] px-1.5 py-0.5 rounded ${t.scope === 'platform' ? 'bg-slate-800 text-slate-400' : 'bg-teal-500/15 text-teal-300'}`}>{t.scope === 'platform' ? 'community' : 'yours'}</span>
                {t.status === 'draft' && <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300">draft</span>}
              </div>
              <p className="text-[10px] text-slate-500 mt-1 flex-1">{t.scope === 'platform' ? 'Community template — verify against your account.' : (t.description || 'Custom template built in this workspace.')} {Object.keys(t.definition.ops ?? {}).length} operation(s).</p>
              {t.status === 'published' && (
                <button onClick={() => onUse(t)} className="mt-2 self-start px-2.5 py-1 rounded-lg text-[11px] text-indigo-300 border border-indigo-500/40 hover:bg-indigo-500/10">Use this template →</button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
