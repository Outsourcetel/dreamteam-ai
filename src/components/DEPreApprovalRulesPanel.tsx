import React, { useState, useEffect } from 'react';
import type { DigitalEmployee } from '../lib/digitalEmployeesApi';
import { supabase } from '../supabase';

interface PreApprovalRule {
  id: string;
  rule_type: 'confidence' | 'response_type' | 'customer_tier' | 'sentiment' | 'custom';
  condition: string;
  requires_approval: boolean;
}

interface PreApprovalConfig {
  strategy: 'all' | 'rule_based' | 'never';
  rules?: PreApprovalRule[];
  review_timeout_minutes?: number;
  on_timeout?: 'escalate' | 'send';
}

const RULE_LABELS: Record<string, string> = {
  confidence: 'Confidence Threshold',
  response_type: 'Response Type',
  customer_tier: 'Customer Tier',
  sentiment: 'Sentiment Detection',
  custom: 'Custom Rule',
};

export function DEPreApprovalRulesPanel({ de }: { de: DigitalEmployee }) {
  const [config, setConfig] = useState<PreApprovalConfig>({ strategy: 'rule_based' });
  const [editingRule, setEditingRule] = useState<PreApprovalRule | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadConfig();
  }, [de.id]);

  const loadConfig = async () => {
    try {
      const { data } = await supabase.rpc('get_de_preapproval_config', { p_de_id: de.id });
      if (data) {
        setConfig(data as PreApprovalConfig);
      }
    } catch (e) {
      console.error('Failed to load pre-approval config:', e);
    }
  };

  const handleAddRule = () => {
    setEditingRule({
      id: Date.now().toString(),
      rule_type: 'confidence',
      condition: '',
      requires_approval: true,
    });
  };

  const handleSaveRule = () => {
    if (!editingRule || !editingRule.condition.trim()) {
      setError('Condition is required');
      return;
    }

    setError(null);
    const rules = (config.rules || []).filter(r => r.id !== editingRule.id);
    setConfig({
      ...config,
      rules: [...rules, editingRule],
    });
    setEditingRule(null);
  };

  const handleDeleteRule = (id: string) => {
    setConfig({
      ...config,
      rules: (config.rules || []).filter(r => r.id !== id),
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await supabase.rpc('set_de_preapproval_config', {
        p_de_id: de.id,
        p_config: config,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      console.error('Failed to save pre-approval config:', e);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-sm font-semibold text-white mb-1">Response Pre-Approval Rules</h4>
        <p className="text-xs text-dt-support">Define when {de.name}'s responses need human review before sending.</p>
      </div>

      {/* Strategy Selection */}
      <div className="bg-dt-card border border-dt-border rounded-lg p-3 space-y-2">
        <label className="text-xs font-medium text-dt-support block">Pre-Approval Strategy</label>
        <div className="space-y-1.5">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="strategy"
              value="all"
              checked={config.strategy === 'all'}
              onChange={e => setConfig({ ...config, strategy: 'all' })}
              className="rounded border-dt-border-strong"
            />
            <span className="text-xs text-dt-support">Review ALL responses (safest)</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="strategy"
              value="rule_based"
              checked={config.strategy === 'rule_based'}
              onChange={e => setConfig({ ...config, strategy: 'rule_based' })}
              className="rounded border-dt-border-strong"
            />
            <span className="text-xs text-dt-support">Rule-based (see rules below)</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="strategy"
              value="never"
              checked={config.strategy === 'never'}
              onChange={e => setConfig({ ...config, strategy: 'never' })}
              className="rounded border-dt-border-strong"
            />
            <span className="text-xs text-dt-support">Never review (fastest)</span>
          </label>
        </div>
      </div>

      {/* Rules (if rule-based) */}
      {config.strategy === 'rule_based' && (
        <div className="bg-dt-card border border-dt-border rounded-lg p-3 space-y-2">
          <div className="text-xs font-medium text-dt-support">Rules</div>

          {config.rules && config.rules.length > 0 ? (
            config.rules.map(rule => (
              <div key={rule.id} className="bg-dt-inset border border-dt-border-strong rounded p-2 flex items-start justify-between text-xs">
                <div className="flex-1 min-w-0">
                  <span className="font-semibold text-indigo-300">{RULE_LABELS[rule.rule_type]}</span>
                  <p className="text-dt-support mt-1 font-mono">{rule.condition}</p>
                  <p className="text-dt-muted mt-1">
                    {rule.requires_approval ? '→ Require human review' : '→ Can send automatically'}
                  </p>
                </div>
                <div className="flex gap-1 ml-2 flex-shrink-0">
                  <button
                    onClick={() => setEditingRule(rule)}
                    className="px-2 py-1 bg-dt-panel hover:bg-dt-panel rounded text-xs transition-colors"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDeleteRule(rule.id)}
                    className="px-2 py-1 bg-dt-panel hover:bg-red-900/40 text-red-300 rounded text-xs transition-colors"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))
          ) : (
            <p className="text-xs text-dt-muted">No rules defined.</p>
          )}

          <button
            onClick={handleAddRule}
            className="w-full px-2 py-1.5 text-xs bg-dt-panel hover:bg-dt-panel rounded transition-colors text-center"
          >
            + Add Rule
          </button>
        </div>
      )}

      {/* Timeout Configuration */}
      {config.strategy === 'rule_based' && (
        <div className="bg-dt-card border border-dt-border rounded-lg p-3 space-y-2">
          <div>
            <label className="text-xs font-medium text-dt-support block mb-1">Review Timeout</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="1"
                value={config.review_timeout_minutes || 30}
                onChange={e => setConfig({ ...config, review_timeout_minutes: Number(e.target.value) })}
                className="w-16 bg-dt-page border border-dt-border-strong rounded px-2 py-1 text-xs text-dt-body focus:outline-none focus:border-indigo-500"
              />
              <span className="text-xs text-dt-support">minutes</span>
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-dt-support block mb-1">If review times out:</label>
            <div className="space-y-1">
              <label className="flex items-center gap-2 cursor-pointer text-xs">
                <input
                  type="radio"
                  name="timeout"
                  value="escalate"
                  checked={(config.on_timeout || 'escalate') === 'escalate'}
                  onChange={e => setConfig({ ...config, on_timeout: 'escalate' })}
                  className="rounded border-dt-border-strong"
                />
                <span className="text-dt-support">Escalate instead (safe)</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer text-xs">
                <input
                  type="radio"
                  name="timeout"
                  value="send"
                  checked={(config.on_timeout || 'escalate') === 'send'}
                  onChange={e => setConfig({ ...config, on_timeout: 'send' })}
                  className="rounded border-dt-border-strong"
                />
                <span className="text-dt-support">Send anyway (risky)</span>
              </label>
            </div>
          </div>
        </div>
      )}

      {/* Rule Editor Modal */}
      {editingRule && (
        <>
          <div className="fixed inset-0 z-40 bg-dt-page/70" onClick={() => setEditingRule(null)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6 pointer-events-none">
            <div className="pointer-events-auto w-full max-w-md bg-dt-card border border-dt-border-strong rounded-xl shadow-2xl p-4 space-y-3">
              <h3 className="text-sm font-semibold text-white">
                {config.rules?.find(r => r.id === editingRule.id) ? 'Edit Rule' : 'Add Pre-Approval Rule'}
              </h3>

              <div>
                <label className="text-xs font-medium text-dt-support block mb-1">Rule Type</label>
                <select
                  value={editingRule.rule_type}
                  onChange={e => setEditingRule({ ...editingRule, rule_type: e.target.value as any })}
                  className="w-full bg-dt-page border border-dt-border-strong rounded px-2 py-1.5 text-xs text-dt-body focus:outline-none focus:border-indigo-500"
                >
                  <option value="confidence">Confidence &lt; X%</option>
                  <option value="response_type">Response contains keyword</option>
                  <option value="customer_tier">Customer tier</option>
                  <option value="sentiment">Customer sentiment</option>
                  <option value="custom">Custom condition</option>
                </select>
              </div>

              <div>
                <label className="text-xs font-medium text-dt-support block mb-1">Condition</label>
                <input
                  placeholder={
                    editingRule.rule_type === 'confidence' ? 'e.g., confidence<80' :
                    editingRule.rule_type === 'response_type' ? 'e.g., contains="refund"' :
                    editingRule.rule_type === 'customer_tier' ? 'e.g., tier="enterprise"' :
                    'e.g., sentiment="angry"'
                  }
                  value={editingRule.condition}
                  onChange={e => setEditingRule({ ...editingRule, condition: e.target.value })}
                  className="w-full bg-dt-page border border-dt-border-strong rounded px-2 py-1.5 text-xs text-dt-body focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="flex items-center gap-2 cursor-pointer text-xs">
                  <input
                    type="checkbox"
                    checked={editingRule.requires_approval}
                    onChange={e => setEditingRule({ ...editingRule, requires_approval: e.target.checked })}
                    className="rounded border-dt-border-strong"
                  />
                  <span className="text-dt-support">Require human review</span>
                </label>
              </div>

              {error && (
                <div className="bg-red-900/20 border border-red-700/50 rounded p-2">
                  <p className="text-xs text-red-300">{error}</p>
                </div>
              )}

              <div className="flex gap-2 pt-1">
                <button
                  onClick={handleSaveRule}
                  className="flex-1 px-3 py-2 bg-indigo-600 hover:bg-indigo-700 rounded text-xs font-medium transition-colors"
                >
                  Save Rule
                </button>
                <button
                  onClick={() => setEditingRule(null)}
                  className="flex-1 px-3 py-2 bg-dt-panel hover:bg-dt-panel rounded text-xs transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Save Button */}
      <div className="flex items-center gap-2 pt-3 border-t border-dt-border">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-3 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded text-xs font-medium transition-colors"
        >
          {saving ? 'Saving...' : 'Save Approval Config'}
        </button>
        {saved && (
          <span className="text-xs text-emerald-400">✓ Saved</span>
        )}
        {error && (
          <span className="text-xs text-red-400">{error}</span>
        )}
      </div>
    </div>
  );
}
