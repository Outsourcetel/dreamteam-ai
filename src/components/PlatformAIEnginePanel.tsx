import React, { useCallback, useEffect, useState } from 'react';
import { savePlatformConfig } from '../lib/api';
import { invokeEdge } from '../lib/invokeEdge';

// ════════════════════════════════════════════════════════════════════════
// The AI engine, seen from the Platform Console — promised to the founder
// 2026-07-22, when the only way to reach any AI-engine surface was to
// Remote-Access INTO a tenant and open its Settings by URL.
//
// Status comes from the ai-engine-status edge function, not from the
// database: the Bedrock credential lives as an edge SECRET (env), invisible
// to any platform_config check — a page reading only the config table would
// have called the serving primary "not configured". Only the runtime can
// see both sources, so the runtime reports. Key VALUES never reach a
// browser; the function returns armed/source booleans only.
//
// The failover marker became writable on 2026-08-11 (mig 700) — before that
// every failover was recorded into a silent refusal. The panel says so
// rather than presenting an empty marker as "no failovers ever".
//
// `platform_config_set` re-checks `billing.manage` server-side; this panel
// being on a platform page is convenience, not the security boundary.
// ════════════════════════════════════════════════════════════════════════

interface Tier { provider: string; armed: boolean; source: 'config' | 'env' | 'both' | 'none' }
interface EngineStatus {
  ok?: boolean;
  tiers?: Tier[];
  configured_order?: string;
  effective_chain?: string[];
  last_failover?: string | null;
  marker_note?: string;
  detail?: string;
  error?: string;
}

const PROVIDER_LABEL: Record<string, string> = {
  anthropic: 'Anthropic (direct)',
  bedrock: 'AWS Bedrock (Claude)',
  openai: 'OpenAI',
  google: 'Google Gemini',
};
const KEY_FIELDS: { name: string; label: string; hint: string }[] = [
  { name: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', hint: 'sk-ant-…' },
  { name: 'BEDROCK_API_KEY', label: 'AWS Bedrock key', hint: 'long-term Bedrock API key' },
  { name: 'OPENAI_API_KEY', label: 'OpenAI API key', hint: 'sk-…  (arms the cross-family tier)' },
  { name: 'GOOGLE_AI_KEY', label: 'Google AI key', hint: 'AIza…  (arms the cross-family tier)' },
];

export default function PlatformAIEnginePanel() {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setProblem(null);
    const { data, error } = await invokeEdge<EngineStatus>('ai-engine-status', { body: {} });
    if (error || !data?.ok) {
      setProblem(data?.detail ?? error?.message ?? 'Could not read the engine status.');
      setStatus(null);
      return;
    }
    setStatus(data);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const saveKey = async (name: string) => {
    const v = drafts[name]?.trim();
    if (!v || savingKey) return;
    setSavingKey(name); setSaveMsg(null);
    const ok = await savePlatformConfig({ [name]: v });
    setSavingKey(null);
    if (ok) {
      setDrafts(d => ({ ...d, [name]: '' }));  // never leave a secret in state
      setSaveMsg(`${name} saved — a config key takes precedence over an edge secret of the same name.`);
      await load();
    } else {
      setSaveMsg('Save failed — this needs a platform administrator with billing access.');
    }
  };

  return (
    <div className="bg-dt-card border border-dt-border rounded-xl p-5">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-sm font-semibold text-dt-title">AI engine — providers & failover</h2>
        <button onClick={() => void load()} className="text-xs text-indigo-400 hover:text-indigo-300">Refresh</button>
      </div>
      <p className="text-xs text-dt-muted mb-4 max-w-2xl">
        The four-tier failover spine as the edge runtime actually sees it — including keys that live
        only as edge secrets. Key values never reach the browser.
      </p>

      {problem && <p className="text-xs text-red-300 mb-3">{problem}</p>}

      {status && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-4">
            {(status.tiers ?? []).map(t => (
              <div key={t.provider} className="flex items-center justify-between rounded-lg border border-dt-border bg-dt-inset px-3 py-2">
                <span className="text-xs text-dt-body">{PROVIDER_LABEL[t.provider] ?? t.provider}</span>
                {t.armed
                  ? <span className="text-[11px] px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300">armed · {t.source}</span>
                  : <span className="text-[11px] px-2 py-0.5 rounded bg-dt-neutral-soft text-dt-support">no key</span>}
              </div>
            ))}
          </div>

          <div className="mb-4 space-y-1">
            <p className="text-xs text-dt-support">
              <span className="text-dt-muted">Serving chain:</span>{' '}
              {(status.effective_chain ?? []).length > 0
                ? (status.effective_chain ?? []).map(p => PROVIDER_LABEL[p] ?? p).join('  →  ')
                : 'NO ARMED PROVIDER — the workforce cannot answer'}
            </p>
            <p className="text-xs text-dt-muted">Configured order: {status.configured_order}</p>
            <p className="text-xs text-dt-support">
              <span className="text-dt-muted">Last failover:</span>{' '}
              {status.last_failover ?? 'none recorded'}
            </p>
            {status.marker_note && <p className="text-[11px] text-dt-faint">{status.marker_note}</p>}
            {(status.effective_chain ?? []).filter(p => p === 'openai' || p === 'google').length === 0 && (
              <p className="text-[11px] text-amber-300">
                Every armed tier is the same model family — a family-wide outage has no cover. Arming
                OpenAI or Google below adds true cross-family continuity (different brain: answers are
                continuity cover until re-certified).
              </p>
            )}
          </div>
        </>
      )}

      <div className="border-t border-dt-border pt-4 space-y-3">
        {KEY_FIELDS.map(f => (
          <div key={f.name} className="flex items-center gap-2">
            <div className="w-44 shrink-0">
              <p className="text-xs text-dt-body">{f.label}</p>
              <p className="text-[10px] text-dt-faint">{f.hint}</p>
            </div>
            <input type="password" value={drafts[f.name] ?? ''} placeholder="paste to set or replace"
              onChange={e => setDrafts(d => ({ ...d, [f.name]: e.target.value }))}
              className="flex-1 bg-dt-inset border border-dt-border rounded-lg px-3 py-1.5 text-xs text-dt-body" />
            <button onClick={() => void saveKey(f.name)} disabled={!drafts[f.name]?.trim() || savingKey !== null}
              className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 text-white disabled:opacity-40">
              {savingKey === f.name ? 'Saving…' : 'Save'}
            </button>
          </div>
        ))}
        {saveMsg && <p className="text-[11px] text-dt-support">{saveMsg}</p>}
      </div>
    </div>
  );
}
