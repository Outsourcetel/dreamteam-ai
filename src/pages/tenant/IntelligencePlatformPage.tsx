import React, { useState } from 'react';
import {
  useIntelligenceConfig,
  PROVIDER_MODELS,
  EMBEDDING_MODELS,
  ModelProvider,
  EmbeddingProvider,
} from '../../lib/useIntelligenceConfig';

const PROVIDER_META: Record<ModelProvider, { name: string; icon: string; color: string }> = {
  anthropic: { name: 'Anthropic', icon: '◈', color: 'text-orange-400 border-orange-500/30 bg-orange-500/10' },
  openai:    { name: 'OpenAI', icon: '⊕', color: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' },
  google:    { name: 'Google', icon: '◎', color: 'text-sky-400 border-sky-500/30 bg-sky-500/10' },
  azure:     { name: 'Azure', icon: '⊞', color: 'text-blue-400 border-blue-500/30 bg-blue-500/10' },
  aws:       { name: 'AWS Bedrock', icon: '⚡', color: 'text-amber-400 border-amber-500/30 bg-amber-500/10' },
};

const EMBED_META: Record<EmbeddingProvider, { name: string; note: string }> = {
  supabase: { name: 'Supabase pgvector', note: 'Built-in. No extra cost. 384-dim vectors.' },
  openai:   { name: 'OpenAI Embeddings', note: 'Higher quality. Requires OpenAI key. 1536 or 3072 dims.' },
  cohere:   { name: 'Cohere Embeddings', note: 'Multilingual support. Requires Cohere key. 1024 dims.' },
};

const SAFETY_INFO = {
  strict:     'All outputs reviewed; high-confidence threshold; no ambiguous content passed to users.',
  balanced:   'Confidence threshold 0.55; auto-approve routine tasks; escalate edge cases.',
  permissive: 'Minimal gating. Suitable only for internal-only DEs with human review downstream.',
};

export default function IntelligencePlatformPage() {
  const { config, updateConfig, currentModel, fallbackModel } = useIntelligenceConfig();
  const [saved, setSaved] = useState(false);
  const [tab, setTab] = useState<'model' | 'embedding' | 'safety'>('model');

  const save = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const providerModels = PROVIDER_MODELS[config.provider] ?? [];
  const fallbackProviderModels = config.fallbackProvider ? PROVIDER_MODELS[config.fallbackProvider] ?? [] : [];

  return (
    <div className="flex flex-col h-full overflow-hidden bg-slate-950">
      {/* Header */}
      <div className="px-8 pt-8 pb-0 flex-shrink-0">
        <div className="flex items-start justify-between mb-6">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs text-slate-500 uppercase tracking-widest">Platform</span>
              <span className="text-slate-700">/</span>
              <span className="text-xs text-indigo-400 uppercase tracking-widest">Intelligence Platform</span>
            </div>
            <h1 className="text-2xl font-bold text-white">Intelligence Platform</h1>
            <p className="text-slate-400 text-sm mt-1">
              Configure model providers, embedding engine, and safety thresholds without touching code.
              Your Digital Employees are provider-agnostic — swap models here, nothing else changes.
            </p>
          </div>
          <button
            onClick={save}
            className={`px-5 py-2.5 rounded-xl text-sm font-semibold transition-all ${
              saved ? 'bg-emerald-600 text-white' : 'bg-indigo-600 hover:bg-indigo-500 text-white'
            }`}
          >
            {saved ? '✓ Saved' : 'Save Configuration'}
          </button>
        </div>

        {/* Active summary bar */}
        <div className="flex gap-3 mb-5">
          {[
            { label: 'Active Provider', value: PROVIDER_META[config.provider]?.name },
            { label: 'Model', value: currentModel?.name ?? config.modelId },
            { label: 'Confidence Threshold', value: `${Math.round(config.confidenceThreshold * 100)}%` },
            { label: 'Safety Level', value: config.safetyLevel.charAt(0).toUpperCase() + config.safetyLevel.slice(1) },
            { label: 'Embedding', value: EMBED_META[config.embeddingProvider]?.name },
          ].map(s => (
            <div key={s.label} className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-2.5 flex-1">
              <div className="text-xs text-slate-500 mb-0.5">{s.label}</div>
              <div className="text-sm font-semibold text-white truncate">{s.value}</div>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-slate-800">
          {([
            { id: 'model', label: 'Language Model', icon: '⚛' },
            { id: 'embedding', label: 'Embedding Engine', icon: '◈' },
            { id: 'safety', label: 'Safety & Thresholds', icon: '⚠' },
          ] as const).map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 transition-colors ${
                tab === t.id ? 'border-indigo-500 text-white' : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              <span>{t.icon}</span>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-8 py-6">

        {/* ── LANGUAGE MODEL ── */}
        {tab === 'model' && (
          <div className="space-y-6">
            {/* Primary provider */}
            <div>
              <h3 className="text-sm font-semibold text-slate-300 mb-3">Primary Provider</h3>
              <div className="grid grid-cols-5 gap-3">
                {(Object.keys(PROVIDER_META) as ModelProvider[]).map(p => {
                  const meta = PROVIDER_META[p];
                  const active = config.provider === p;
                  return (
                    <button
                      key={p}
                      onClick={() => {
                        const models = PROVIDER_MODELS[p];
                        updateConfig({ provider: p, modelId: models[0]?.id ?? '' });
                      }}
                      className={`flex flex-col items-center gap-2 p-4 rounded-xl border transition-all ${
                        active ? `${meta.color} border-current` : 'bg-slate-900 border-slate-700 hover:border-slate-500 text-slate-400'
                      }`}
                    >
                      <span className="text-2xl">{meta.icon}</span>
                      <span className="text-xs font-semibold">{meta.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Model selection */}
            <div>
              <h3 className="text-sm font-semibold text-slate-300 mb-3">Model</h3>
              <div className="space-y-2">
                {providerModels.map(model => {
                  const active = config.modelId === model.id;
                  return (
                    <button
                      key={model.id}
                      onClick={() => updateConfig({ modelId: model.id })}
                      className={`w-full flex items-center gap-4 p-4 rounded-xl border text-left transition-all ${
                        active ? 'bg-indigo-500/10 border-indigo-500/40' : 'bg-slate-900 border-slate-800 hover:border-slate-600'
                      }`}
                    >
                      <div className={`w-4 h-4 rounded-full border-2 flex-shrink-0 ${active ? 'border-indigo-500 bg-indigo-500' : 'border-slate-600'}`} />
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-white">{model.name}</span>
                          {model.supportsVision && <span className="text-xs px-1.5 py-0.5 bg-sky-500/10 text-sky-400 rounded">Vision</span>}
                          {model.supportsFunctionCalling && <span className="text-xs px-1.5 py-0.5 bg-violet-500/10 text-violet-400 rounded">Tools</span>}
                        </div>
                        <div className="text-xs text-slate-400 mt-0.5">
                          {(model.contextWindow / 1000).toFixed(0)}K context ·{' '}
                          ${model.costPer1kInput}/1K input · ${model.costPer1kOutput}/1K output
                        </div>
                      </div>
                      <div className="text-xs text-slate-500 font-mono">{model.id}</div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Temperature + tokens */}
            <div className="grid grid-cols-2 gap-6">
              <div>
                <h3 className="text-sm font-semibold text-slate-300 mb-2">Temperature</h3>
                <p className="text-xs text-slate-500 mb-3">Lower = more predictable. Higher = more creative. 0.3 recommended for business tasks.</p>
                <div className="flex items-center gap-3">
                  <input
                    type="range" min={0} max={1} step={0.05}
                    value={config.temperature}
                    onChange={e => updateConfig({ temperature: parseFloat(e.target.value) })}
                    className="flex-1 accent-indigo-500"
                  />
                  <div className="w-12 text-center">
                    <span className="text-sm font-semibold text-white">{config.temperature.toFixed(2)}</span>
                  </div>
                </div>
                <div className="flex justify-between text-xs text-slate-600 mt-1">
                  <span>Precise</span><span>Balanced</span><span>Creative</span>
                </div>
              </div>
              <div>
                <h3 className="text-sm font-semibold text-slate-300 mb-2">Max Tokens (Output)</h3>
                <p className="text-xs text-slate-500 mb-3">Maximum tokens the model will generate per response. Controls cost and response length.</p>
                <div className="flex items-center gap-3">
                  <input
                    type="range" min={256} max={4096} step={128}
                    value={config.maxTokens}
                    onChange={e => updateConfig({ maxTokens: parseInt(e.target.value) })}
                    className="flex-1 accent-indigo-500"
                  />
                  <div className="w-16 text-center">
                    <span className="text-sm font-semibold text-white">{config.maxTokens.toLocaleString()}</span>
                  </div>
                </div>
                <div className="flex justify-between text-xs text-slate-600 mt-1">
                  <span>256</span><span>2K</span><span>4K</span>
                </div>
              </div>
            </div>

            {/* Fallback model */}
            <div>
              <h3 className="text-sm font-semibold text-slate-300 mb-1">Fallback Model</h3>
              <p className="text-xs text-slate-500 mb-3">Used automatically if the primary model is unavailable or returns an error.</p>
              <div className="flex gap-3">
                <select
                  value={config.fallbackProvider ?? ''}
                  onChange={e => {
                    const p = e.target.value as ModelProvider;
                    updateConfig({ fallbackProvider: p, fallbackModelId: PROVIDER_MODELS[p]?.[0]?.id });
                  }}
                  className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-indigo-500"
                >
                  {(Object.keys(PROVIDER_MODELS) as ModelProvider[]).map(p => (
                    <option key={p} value={p}>{PROVIDER_META[p].name}</option>
                  ))}
                </select>
                <select
                  value={config.fallbackModelId ?? ''}
                  onChange={e => updateConfig({ fallbackModelId: e.target.value })}
                  className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-indigo-500"
                >
                  {fallbackProviderModels.map(m => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
              </div>
              {fallbackModel && (
                <p className="text-xs text-slate-500 mt-1">
                  {fallbackModel.name} · {(fallbackModel.contextWindow / 1000).toFixed(0)}K context · ${fallbackModel.costPer1kInput}/1K input
                </p>
              )}
            </div>

            {/* BYOK */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <h3 className="text-sm font-semibold text-white">Bring Your Own API Key (BYOK)</h3>
                  <p className="text-xs text-slate-400">Use your own model provider account and key instead of the platform key.</p>
                </div>
                <button
                  onClick={() => updateConfig({ byokEnabled: !config.byokEnabled })}
                  className={`w-10 h-5 rounded-full relative transition-all ${config.byokEnabled ? 'bg-indigo-600' : 'bg-slate-700'}`}
                >
                  <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${config.byokEnabled ? 'left-5' : 'left-0.5'}`} />
                </button>
              </div>
              {config.byokEnabled && (
                <div className="mt-3 p-3 bg-amber-500/5 border border-amber-500/20 rounded-lg">
                  <p className="text-xs text-amber-300">
                    To use your own key, add it as a Supabase Edge Function secret named{' '}
                    <code className="text-amber-200 font-mono bg-amber-900/20 px-1 rounded">TENANT_{'{TENANT_ID}'}_API_KEY</code>.
                    Keys are never stored in the frontend or returned to the browser.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── EMBEDDING ENGINE ── */}
        {tab === 'embedding' && (
          <div className="space-y-6">
            <div>
              <h3 className="text-sm font-semibold text-slate-300 mb-3">Embedding Provider</h3>
              <div className="space-y-3">
                {(Object.keys(EMBED_META) as EmbeddingProvider[]).map(ep => {
                  const meta = EMBED_META[ep];
                  const active = config.embeddingProvider === ep;
                  return (
                    <button
                      key={ep}
                      onClick={() => {
                        const models = EMBEDDING_MODELS[ep];
                        updateConfig({ embeddingProvider: ep, embeddingModelId: models[0]?.id ?? '' });
                      }}
                      className={`w-full flex items-start gap-4 p-4 rounded-xl border text-left transition-all ${
                        active ? 'bg-indigo-500/10 border-indigo-500/40' : 'bg-slate-900 border-slate-800 hover:border-slate-600'
                      }`}
                    >
                      <div className={`mt-0.5 w-4 h-4 rounded-full border-2 flex-shrink-0 ${active ? 'border-indigo-500 bg-indigo-500' : 'border-slate-600'}`} />
                      <div>
                        <div className="text-sm font-semibold text-white">{meta.name}</div>
                        <div className="text-xs text-slate-400 mt-0.5">{meta.note}</div>
                        <div className="flex gap-2 mt-2">
                          {EMBEDDING_MODELS[ep].map(m => (
                            <button
                              key={m.id}
                              onClick={e => { e.stopPropagation(); updateConfig({ embeddingProvider: ep, embeddingModelId: m.id }); }}
                              className={`text-xs px-2 py-1 rounded border transition-all ${
                                config.embeddingModelId === m.id && active
                                  ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40'
                                  : 'bg-slate-800 text-slate-400 border-slate-700'
                              }`}
                            >
                              {m.name} ({m.dims}d)
                            </button>
                          ))}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
              <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Why does this matter?</h4>
              <p className="text-xs text-slate-400">
                Embeddings determine how well your Knowledge Hub articles are retrieved during conversations.
                Changing the provider will require re-embedding all existing articles — this happens automatically overnight after you save.
                Higher dimensions = more semantic accuracy but more storage and retrieval latency.
              </p>
            </div>
          </div>
        )}

        {/* ── SAFETY & THRESHOLDS ── */}
        {tab === 'safety' && (
          <div className="space-y-6">
            <div>
              <h3 className="text-sm font-semibold text-slate-300 mb-3">Safety Level</h3>
              <div className="grid grid-cols-3 gap-3">
                {(['strict', 'balanced', 'permissive'] as const).map(level => {
                  const active = config.safetyLevel === level;
                  const color = level === 'strict' ? 'emerald' : level === 'balanced' ? 'indigo' : 'amber';
                  return (
                    <button
                      key={level}
                      onClick={() => updateConfig({ safetyLevel: level })}
                      className={`p-4 rounded-xl border text-left transition-all ${
                        active
                          ? `bg-${color}-500/10 border-${color}-500/40`
                          : 'bg-slate-900 border-slate-700 hover:border-slate-500'
                      }`}
                    >
                      <div className={`text-sm font-semibold capitalize mb-1 ${active ? `text-${color}-300` : 'text-white'}`}>{level}</div>
                      <p className="text-xs text-slate-400">{SAFETY_INFO[level]}</p>
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <h3 className="text-sm font-semibold text-slate-300 mb-2">Confidence Threshold</h3>
              <p className="text-xs text-slate-500 mb-3">
                Below this confidence score, DE responses go to Approval Queue instead of auto-sending.
                Currently: <strong className="text-white">{Math.round(config.confidenceThreshold * 100)}%</strong>
              </p>
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
                <div className="flex items-center gap-4 mb-3">
                  <input
                    type="range" min={0.3} max={0.95} step={0.05}
                    value={config.confidenceThreshold}
                    onChange={e => updateConfig({ confidenceThreshold: parseFloat(e.target.value) })}
                    className="flex-1 accent-indigo-500"
                  />
                  <div className="w-14 bg-slate-800 rounded-lg px-2 py-1.5 text-center">
                    <span className="text-sm font-bold text-white">{Math.round(config.confidenceThreshold * 100)}%</span>
                  </div>
                </div>

                {/* Visual scale */}
                <div className="relative h-3 bg-gradient-to-r from-red-900/50 via-amber-900/50 to-emerald-900/50 rounded-full overflow-hidden">
                  <div
                    className="absolute top-0 left-0 h-full bg-indigo-500/30 rounded-full transition-all"
                    style={{ width: `${config.confidenceThreshold * 100}%` }}
                  />
                  <div
                    className="absolute top-0 bottom-0 w-0.5 bg-white transition-all"
                    style={{ left: `${config.confidenceThreshold * 100}%` }}
                  />
                </div>
                <div className="flex justify-between text-xs text-slate-600 mt-1">
                  <span>30% — high automation</span>
                  <span>95% — mostly human-reviewed</span>
                </div>

                <div className="mt-4 grid grid-cols-3 gap-3 text-center text-xs">
                  <div className="bg-red-500/5 border border-red-500/10 rounded-lg p-2">
                    <div className="text-red-400 font-semibold">Below {Math.round(config.confidenceThreshold * 100)}%</div>
                    <div className="text-slate-500 mt-0.5">→ Approval Queue</div>
                  </div>
                  <div className="bg-amber-500/5 border border-amber-500/10 rounded-lg p-2">
                    <div className="text-amber-400 font-semibold">{Math.round(config.confidenceThreshold * 100)}%–79%</div>
                    <div className="text-slate-500 mt-0.5">→ Auto-send + Flag</div>
                  </div>
                  <div className="bg-emerald-500/5 border border-emerald-500/10 rounded-lg p-2">
                    <div className="text-emerald-400 font-semibold">80%+</div>
                    <div className="text-slate-500 mt-0.5">→ Auto-send</div>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-indigo-500/5 border border-indigo-500/20 rounded-xl p-4">
              <p className="text-xs text-indigo-300">
                <strong>Note:</strong> Safety level and confidence threshold interact. Strict mode overrides this threshold and routes everything below 80% for approval regardless of the slider value. These settings are logged in your audit trail with the timestamp and the admin who made the change.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
