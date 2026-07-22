import React, { useState, useEffect } from 'react';
import type { DigitalEmployee } from '../lib/digitalEmployeesApi';
import { supabase } from '../supabase';
import { listConnectors, fmtSince, type Connector } from '../lib/connectorApi';

interface KnowledgeSource {
  provider: string;
  enabled: boolean;
  last_sync?: string;
  item_count?: number;
}

interface KnowledgeScopeConfig {
  sources: KnowledgeSource[];
}

const KNOWLEDGE_PROVIDERS = [
  { provider: 'salesforce', label: 'Salesforce', category: 'crm', description: 'Customer accounts, contacts, SLA terms' },
  { provider: 'sharepoint', label: 'SharePoint', category: 'knowledge_base', description: 'Policies, procedures, processes' },
  { provider: 'google_drive', label: 'Google Drive', category: 'knowledge_base', description: 'Documents, spreadsheets' },
  { provider: 'notion', label: 'Notion', category: 'knowledge_base', description: 'Wikis, FAQs, playbooks' },
  { provider: 'confluence', label: 'Confluence', category: 'knowledge_base', description: 'Documentation, knowledge base' },
  { provider: 'gdrive', label: 'Google Workspace', category: 'knowledge_base', description: 'Docs, Sheets, Drive' },
  { provider: 'microsoft_office', label: 'Microsoft Office', category: 'knowledge_base', description: 'Word, Excel, PowerPoint' },
  { provider: 'zendesk', label: 'Zendesk Help Center', category: 'helpdesk', description: 'Support articles, FAQs' },
];

export function DEKnowledgeScopePanel({ de }: { de: DigitalEmployee }) {
  const [config, setConfig] = useState<KnowledgeScopeConfig>({ sources: [] });
  const [connectors, setConnectors] = useState<Map<string, Connector>>(new Map());
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, [de.id]);

  const loadData = async () => {
    try {
      // Load existing config
      const { data } = await supabase.rpc('get_de_knowledge_scope', { p_de_id: de.id });
      if (data) {
        setConfig(data as KnowledgeScopeConfig);
      }

      // Load available connectors
      const allConnectors = await listConnectors();
      const map = new Map<string, Connector>();
      for (const c of allConnectors) {
        map.set(c.provider, c);
      }
      setConnectors(map);
    } catch (e) {
      console.error('Failed to load knowledge scope:', e);
    } finally {
      setLoading(false);
    }
  };

  const toggleSource = (provider: string) => {
    const sources = config.sources.map(s =>
      s.provider === provider ? { ...s, enabled: !s.enabled } : s
    );
    if (!sources.find(s => s.provider === provider)) {
      sources.push({ provider, enabled: true });
    }
    setConfig({ sources });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await supabase.rpc('set_de_knowledge_scope', {
        p_de_id: de.id,
        p_config: config,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      console.error('Failed to save knowledge scope:', e);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="animate-pulse h-32 bg-dt-card rounded-lg" />;
  }

  const groupedProviders: Record<string, typeof KNOWLEDGE_PROVIDERS> = {};
  for (const p of KNOWLEDGE_PROVIDERS) {
    if (!groupedProviders[p.category]) groupedProviders[p.category] = [];
    groupedProviders[p.category].push(p);
  }

  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-sm font-semibold text-white mb-1">Knowledge Sources</h4>
        <p className="text-xs text-dt-support">Choose which systems {de.name} should consult when answering questions.</p>
      </div>

      {/* Knowledge Sources by Category */}
      {Object.entries(groupedProviders).map(([category, providers]) => (
        <div key={category}>
          <h5 className="text-xs font-medium text-dt-support uppercase tracking-wider mb-2">
            {category.replace(/_/g, ' ')}
          </h5>
          <div className="space-y-2">
            {providers.map(source => {
              const connector = connectors.get(source.provider);
              const configSource = config.sources.find(s => s.provider === source.provider);
              const enabled = configSource?.enabled ?? false;

              return (
                <label key={source.provider} className="flex items-start gap-3 p-2 rounded-lg hover:bg-dt-card cursor-pointer transition-colors">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={() => toggleSource(source.provider)}
                    className="mt-1 rounded border-dt-border-strong"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-dt-support">{source.label}</span>
                      {connector ? (
                        <span className="text-xs px-1.5 py-0.5 bg-emerald-900/30 text-emerald-300 rounded">
                          Connected
                        </span>
                      ) : (
                        <span className="text-xs px-1.5 py-0.5 bg-dt-panel text-dt-support rounded">
                          Not connected
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-dt-muted">{source.description}</p>
                    {connector && connector.last_ok_at && (
                      <p className="text-xs text-dt-faint mt-1">
                        Last synced: {fmtSince(connector.last_ok_at)}
                      </p>
                    )}
                  </div>
                </label>
              );
            })}
          </div>
        </div>
      ))}

      {/* Save Button */}
      <div className="flex items-center gap-2 pt-3 border-t border-dt-border">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-3 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded text-xs font-medium transition-colors"
        >
          {saving ? 'Saving...' : 'Save Knowledge Scope'}
        </button>
        {saved && (
          <span className="text-xs text-emerald-400">✓ Saved</span>
        )}
      </div>

      <div className="border-t border-dt-border pt-2">
        <p className="text-xs text-dt-muted">
          💡 {de.name} will only consult enabled sources when answering questions. Make sure sources are connected before enabling.
        </p>
      </div>
    </div>
  );
}
