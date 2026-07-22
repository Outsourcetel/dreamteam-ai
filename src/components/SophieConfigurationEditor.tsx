import React, { useState, useEffect } from 'react';
import type { DigitalEmployee } from '../lib/digitalEmployeesApi';
import { getDEConfig, saveDEConfig, resetDEConfigToTemplate, getConfigTemplateWithOverrides, type ConfigValue } from '../lib/configurationApi';

export function SophieConfigurationEditor({ de }: { de: DigitalEmployee }) {
  const [config, setConfig] = useState<ConfigValue | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [changed, setChanged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    loadConfig();
  }, [de.id]);

  const loadConfig = async () => {
    setLoading(true);
    setError(null);
    const template = await getConfigTemplateWithOverrides(de.id);
    if (template) {
      setConfig(template);
    } else {
      setError('Failed to load configuration');
    }
    setLoading(false);
  };

  const handleChange = (field: keyof ConfigValue, value: any) => {
    setConfig(prev => prev ? { ...prev, [field]: value } : null);
    setChanged(true);
    setSuccess(false);
  };

  const handleSave = async () => {
    if (!config) return;

    setSaving(true);
    setError(null);
    const result = await saveDEConfig(de.id, 'support-de-template', config);
    setSaving(false);

    if (result) {
      setChanged(false);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } else {
      setError('Failed to save configuration');
    }
  };

  const handleReset = async () => {
    if (!window.confirm('Reset to template defaults? This cannot be undone.')) return;

    setSaving(true);
    setError(null);
    const result = await resetDEConfigToTemplate(de.id);
    setSaving(false);

    if (result?.ok) {
      await loadConfig();
      setChanged(false);
    } else {
      setError('Failed to reset configuration');
    }
  };

  if (loading) {
    return <div className="animate-pulse h-96 bg-dt-card rounded-lg" />;
  }

  if (!config) {
    return <div className="text-dt-support">Unable to load configuration</div>;
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="p-3 bg-red-500/20 border border-red-500/50 rounded text-red-300 text-sm">
          {error}
        </div>
      )}

      {success && (
        <div className="p-3 bg-green-500/20 border border-green-500/50 rounded text-green-300 text-sm">
          ✓ Configuration saved successfully
        </div>
      )}

      <div className="space-y-5">
        {/* Refund Limit */}
        <div>
          <label className="block text-sm font-medium text-dt-support mb-2">
            Refund Authority Limit
          </label>
          <p className="text-xs text-dt-muted mb-2">
            Maximum refund amount this DE can approve. Requests above this escalate to a human.
          </p>
          <div className="flex items-center gap-2">
            <span className="text-dt-support">$</span>
            <input
              type="number"
              value={config.refund_limit ?? 500}
              onChange={(e) => handleChange('refund_limit', parseInt(e.target.value))}
              className="flex-1 px-3 py-2 bg-dt-panel border border-dt-border-strong rounded text-white placeholder-slate-500"
              min="0"
              max="100000"
              step="50"
            />
          </div>
        </div>

        {/* Pre-approval Strategy */}
        <div>
          <label className="block text-sm font-medium text-dt-support mb-2">
            Response Pre-Approval Strategy
          </label>
          <p className="text-xs text-dt-muted mb-2">
            Whether responses require human review before sending.
          </p>
          <select
            value={config.preapproval_strategy ?? 'rule_based'}
            onChange={(e) => handleChange('preapproval_strategy', e.target.value)}
            className="w-full px-3 py-2 bg-dt-panel border border-dt-border-strong rounded text-white"
          >
            <option value="all">Review all responses (safest)</option>
            <option value="rule_based">Rule-based review (if confidence &lt; 80%)</option>
            <option value="never">No review (fastest)</option>
          </select>
        </div>

        {/* Knowledge Sources */}
        <div>
          <label className="block text-sm font-medium text-dt-support mb-2">
            Knowledge Sources
          </label>
          <p className="text-xs text-dt-muted mb-2">
            Which systems this DE should consult when answering.
          </p>
          <div className="space-y-2">
            {['salesforce', 'zendesk', 'sharepoint', 'google_drive'].map(source => (
              <label key={source} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={(config.knowledge_sources ?? []).includes(source)}
                  onChange={(e) => {
                    const sources = config.knowledge_sources ?? [];
                    if (e.target.checked) {
                      handleChange('knowledge_sources', [...sources, source]);
                    } else {
                      handleChange('knowledge_sources', sources.filter(s => s !== source));
                    }
                  }}
                  className="rounded"
                />
                <span className="text-sm text-dt-support capitalize">{source.replace('_', ' ')}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Escalation SLA */}
        <div>
          <label className="block text-sm font-medium text-dt-support mb-2">
            Escalation SLA (minutes)
          </label>
          <p className="text-xs text-dt-muted mb-2">
            How quickly escalations should be handled.
          </p>
          <input
            type="number"
            value={config.escalation_sla_minutes ?? 60}
            onChange={(e) => handleChange('escalation_sla_minutes', parseInt(e.target.value))}
            className="w-full px-3 py-2 bg-dt-panel border border-dt-border-strong rounded text-white"
            min="1"
            max="1440"
            step="15"
          />
        </div>

        {/* Reply Mode */}
        <div>
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={config.reply_mode_enabled ?? false}
              onChange={(e) => handleChange('reply_mode_enabled', e.target.checked)}
              className="rounded"
            />
            <div>
              <span className="text-sm font-medium text-dt-support">Enable Reply-Mode (Draft Approval)</span>
              <p className="text-xs text-dt-muted mt-0.5">
                If enabled, responses require human approval before sending
              </p>
            </div>
          </label>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex gap-2 pt-4 border-t border-dt-border">
        <button
          onClick={handleSave}
          disabled={!changed || saving}
          className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded text-white text-sm font-medium transition"
        >
          {saving ? 'Saving...' : 'Save Configuration'}
        </button>
        <button
          onClick={handleReset}
          disabled={saving}
          className="px-4 py-2 bg-dt-panel hover:bg-dt-panel disabled:opacity-50 disabled:cursor-not-allowed rounded text-dt-support text-sm font-medium transition"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
