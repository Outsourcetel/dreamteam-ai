import React, { useState, useEffect } from 'react';
import { supabase } from '../supabase';
import {
  listConnectors, connectProvider, disconnectConnector,
  PROVIDERS, ConnectorProvider, connectorHealth, fmtSince,
  type Connector, type ConnectorProvider as CP
} from '../lib/connectorApi';
import type { ConnectorHealth } from '../lib/categoryContracts';

interface ConnectorConfigItem {
  provider: ConnectorProvider;
  enabled: boolean;
  connector: Connector | null;
  loading: boolean;
  error: string | null;
}

export function TenantConnectorConfig() {
  const [configs, setConfigs] = useState<Record<ConnectorProvider, ConnectorConfigItem>>({} as any);
  const [activeProvider, setActiveProvider] = useState<ConnectorProvider | null>(null);
  const [credentialForm, setCredentialForm] = useState<Record<string, string>>({});
  const [savingProvider, setSavingProvider] = useState<ConnectorProvider | null>(null);
  const [savingError, setSavingError] = useState<string | null>(null);
  const [loadingInitial, setLoadingInitial] = useState(true);

  // Load existing connectors on mount
  useEffect(() => {
    loadConnectors();
  }, []);

  const loadConnectors = async () => {
    try {
      const connectors = await listConnectors();
      const configMap = {} as Record<ConnectorProvider, ConnectorConfigItem>;

      // Initialize all providers
      const providers: ConnectorProvider[] = Object.keys(PROVIDERS).filter(p => p !== 'template') as ConnectorProvider[];

      for (const provider of providers) {
        const existing = connectors.find(c => c.provider === provider);
        configMap[provider] = {
          provider,
          enabled: !!existing,
          connector: existing || null,
          loading: false,
          error: null,
        };
      }

      setConfigs(configMap);
    } catch (e) {
      console.error('Failed to load connectors:', e);
    } finally {
      setLoadingInitial(false);
    }
  };

  const handleConfigureClick = (provider: ConnectorProvider) => {
    setActiveProvider(provider);
    setSavingError(null);
    setCredentialForm({});
  };

  const handleSaveConnector = async (provider: ConnectorProvider) => {
    if (!activeProvider) return;

    setSavingProvider(provider);
    setSavingError(null);

    try {
      const meta = PROVIDERS[provider];

      // Validate required fields
      for (const field of meta.fields) {
        if (credentialForm[field.key] === '' || credentialForm[field.key] === undefined) {
          setSavingError(`${field.label} is required`);
          setSavingProvider(null);
          return;
        }
      }

      // Connect the provider
      await connectProvider({
        provider,
        displayName: meta.label,
        baseUrl: credentialForm.baseUrl || '',
        category: meta.defaultCategory,
        accessMode: 'ingest',
        secrets: Object.fromEntries(
          meta.fields.map(f => [f.key, credentialForm[f.key]])
        ),
      });

      // Reload and close
      await loadConnectors();
      setActiveProvider(null);
    } catch (e) {
      setSavingError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingProvider(null);
    }
  };

  const handleDisconnect = async (provider: ConnectorProvider) => {
    if (!confirm(`Disconnect ${PROVIDERS[provider].label}?`)) return;

    try {
      const connector = configs[provider].connector;
      if (connector) {
        await disconnectConnector(connector);
        await loadConnectors();
      }
    } catch (e) {
      console.error('Failed to disconnect:', e);
    }
  };

  if (loadingInitial) {
    return (
      <div className="space-y-3">
        {[1, 2, 3, 4].map(i => (
          <div key={i} className="h-20 bg-slate-800 rounded-lg animate-pulse" />
        ))}
      </div>
    );
  }

  // Group providers by category
  const providersByCategory: Record<string, ConnectorProvider[]> = {};
  for (const [provider, config] of Object.entries(configs) as [ConnectorProvider, ConnectorConfigItem][]) {
    const cat = PROVIDERS[provider].defaultCategory;
    if (!providersByCategory[cat]) providersByCategory[cat] = [];
    providersByCategory[cat].push(provider);
  }

  return (
    <div className="space-y-6">
      <div className="text-xs text-slate-400 mb-4">
        Select the systems Sophie should consult. When you're ready, click "Configure" to add credentials.
      </div>

      {/* Connector List by Category */}
      {Object.entries(providersByCategory).map(([category, providers]) => (
        <div key={category}>
          <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-3 ml-1">
            {category.replace(/_/g, ' ')}
          </h3>
          <div className="space-y-2">
            {providers.map(provider => {
              const config = configs[provider];
              const meta = PROVIDERS[provider];
              const health = config.connector ? connectorHealth(config.connector) : null;

              return (
                <div
                  key={provider}
                  className="bg-slate-800/60 border border-slate-700 rounded-lg p-4 flex items-center justify-between"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-medium text-white">
                        {meta.label}
                      </span>
                      {config.connector && (
                        <span className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded ${
                          health === 'healthy' ? 'bg-emerald-500/20 text-emerald-300' :
                          health === 'degraded' ? 'bg-amber-500/20 text-amber-300' :
                          'bg-red-500/20 text-red-300'
                        }`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${
                            health === 'healthy' ? 'bg-emerald-400' :
                            health === 'degraded' ? 'bg-amber-400' :
                            'bg-red-400'
                          }`} />
                          {health === 'healthy' ? 'Connected' :
                           health === 'degraded' ? 'Degraded' : 'Down'}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-500">{meta.tagline}</p>
                    {config.connector && config.connector.last_ok_at && (
                      <p className="text-xs text-slate-600 mt-1">
                        Last sync: {fmtSince(config.connector.last_ok_at)}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-2 ml-4 flex-shrink-0">
                    {config.connector ? (
                      <>
                        <button
                          onClick={() => handleConfigureClick(provider)}
                          className="px-3 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 rounded transition-colors"
                        >
                          Update
                        </button>
                        <button
                          onClick={() => handleDisconnect(provider)}
                          className="px-3 py-1.5 text-xs bg-slate-700 hover:bg-red-900/40 text-red-300 rounded transition-colors"
                        >
                          Disconnect
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => handleConfigureClick(provider)}
                        className="px-3 py-1.5 text-xs bg-indigo-600 hover:bg-indigo-700 rounded transition-colors font-medium"
                      >
                        Configure
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {/* Credential Input Modal */}
      {activeProvider && (
        <>
          <div className="fixed inset-0 z-40 bg-slate-900/70" onClick={() => setActiveProvider(null)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6 pointer-events-none">
            <div className="pointer-events-auto w-full max-w-xl max-h-[90vh] overflow-y-auto bg-slate-800 border border-slate-600 rounded-2xl shadow-2xl p-6 space-y-4">
              <div>
                <h2 className="text-sm font-semibold text-white">
                  Configure {PROVIDERS[activeProvider].label}
                </h2>
                <p className="text-xs text-slate-500 mt-1">{PROVIDERS[activeProvider].tagline}</p>
              </div>

              <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-3">
                <p className="text-xs font-medium text-slate-400 mb-1">How to get credentials</p>
                <p className="text-xs text-slate-500 leading-relaxed">{PROVIDERS[activeProvider].help}</p>
              </div>

              {/* Dynamic credential form */}
              <div className="space-y-3">
                {PROVIDERS[activeProvider].fields.map(field => (
                  <div key={field.key}>
                    <label className="block text-xs text-slate-400 mb-1 font-medium">
                      {field.label}
                    </label>
                    {field.multiline ? (
                      <textarea
                        placeholder={field.placeholder}
                        value={credentialForm[field.key] || ''}
                        onChange={e => setCredentialForm({ ...credentialForm, [field.key]: e.target.value })}
                        className="w-full bg-slate-900 border border-slate-600 rounded-lg text-sm text-slate-200 px-3 py-2 focus:outline-none focus:border-indigo-500"
                        rows={3}
                      />
                    ) : (
                      <input
                        type={field.secret ? 'password' : 'text'}
                        placeholder={field.placeholder}
                        value={credentialForm[field.key] || ''}
                        onChange={e => setCredentialForm({ ...credentialForm, [field.key]: e.target.value })}
                        className="w-full bg-slate-900 border border-slate-600 rounded-lg text-sm text-slate-200 px-3 py-2 focus:outline-none focus:border-indigo-500"
                      />
                    )}
                  </div>
                ))}

                {/* Base URL if needed */}
                {!['gdrive', 'hubspot', 'slack', 'notion', 'teams', 'box', 'github', 'stripe'].includes(activeProvider) && (
                  <div>
                    <label className="block text-xs text-slate-400 mb-1 font-medium">
                      {PROVIDERS[activeProvider].baseUrlLabel}
                    </label>
                    <input
                      type="text"
                      placeholder={PROVIDERS[activeProvider].baseUrlPlaceholder}
                      value={credentialForm.baseUrl || ''}
                      onChange={e => setCredentialForm({ ...credentialForm, baseUrl: e.target.value })}
                      className="w-full bg-slate-900 border border-slate-600 rounded-lg text-sm text-slate-200 px-3 py-2 focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                )}
              </div>

              {savingError && (
                <div className="bg-red-900/20 border border-red-700/50 rounded-lg p-3">
                  <p className="text-xs text-red-300">{savingError}</p>
                </div>
              )}

              <div className="flex gap-2 pt-2">
                <button
                  onClick={() => handleSaveConnector(activeProvider)}
                  disabled={savingProvider === activeProvider}
                  className="flex-1 px-3 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
                >
                  {savingProvider === activeProvider ? 'Connecting...' : 'Save & Connect'}
                </button>
                <button
                  onClick={() => setActiveProvider(null)}
                  disabled={savingProvider === activeProvider}
                  className="flex-1 px-3 py-2 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded-lg text-sm transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
