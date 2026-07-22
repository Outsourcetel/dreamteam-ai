import React, { useState, useEffect } from 'react';
import type { DigitalEmployee } from '../lib/digitalEmployeesApi';
import { supabase } from '../supabase';

interface EscalationRule {
  id: string;
  rule_type: 'topic' | 'confidence' | 'sentiment' | 'custom';
  condition: string;
  action: string;
  sla_hours?: number;
}

interface EscalationConfig {
  rules: EscalationRule[];
  default_escalation_to?: string;
}

const RULE_TYPE_LABELS: Record<string, string> = {
  topic: 'Topic-Based',
  confidence: 'Confidence-Based',
  sentiment: 'Sentiment-Based',
  custom: 'Custom Rule',
};

const ESCALATION_TARGETS = [
  { value: 'support_lead', label: 'Support Lead' },
  { value: 'support_manager', label: 'Support Manager' },
  { value: 'finance_lead', label: 'Finance Lead' },
  { value: 'finance_manager', label: 'Finance Manager' },
  { value: 'technical_lead', label: 'Technical Support Lead' },
  { value: 'product_manager', label: 'Product Manager' },
  { value: 'founder', label: 'Founder' },
  { value: 'compliance_lead', label: 'Compliance Lead' },
  { value: 'security_team', label: 'Security Team' },
];

export function SophieEscalationRules({ de }: { de: DigitalEmployee }) {
  const [config, setConfig] = useState<EscalationConfig>({ rules: [] });
  const [editingRule, setEditingRule] = useState<EscalationRule | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadConfig();
  }, [de.id]);

  const loadConfig = async () => {
    try {
      const { data } = await supabase.rpc('get_de_escalation_config', { p_de_id: de.id });
      if (data) {
        setConfig(data as EscalationConfig);
      }
    } catch (e) {
      console.error('Failed to load escalation config:', e);
    }
  };

  const handleAddRule = () => {
    setEditingRule({
      id: Date.now().toString(),
      rule_type: 'topic',
      condition: '',
      action: '',
    });
  };

  const handleSaveRule = () => {
    if (!editingRule) return;

    if (!editingRule.condition.trim() || !editingRule.action.trim()) {
      setError('Condition and action are required');
      return;
    }

    setError(null);
    const rules = config.rules.filter(r => r.id !== editingRule.id);
    setConfig({ ...config, rules: [...rules, editingRule] });
    setEditingRule(null);
  };

  const handleDeleteRule = (id: string) => {
    setConfig({ ...config, rules: config.rules.filter(r => r.id !== id) });
  };

  const handleSaveAll = async () => {
    setSaving(true);
    try {
      await supabase.rpc('set_de_escalation_config', {
        p_de_id: de.id,
        p_config: config,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      console.error('Failed to save escalation config:', e);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-sm font-semibold text-white mb-1">Escalation Routing Rules</h4>
        <p className="text-xs text-dt-support">Define when and where {de.name} escalates issues to humans.</p>
      </div>

      {/* Rules List */}
      <div className="space-y-2">
        {config.rules.length === 0 ? (
          <div className="bg-dt-card border border-dt-border rounded-lg p-4 text-center">
            <p className="text-xs text-dt-support">No escalation rules yet.</p>
            <p className="text-xs text-dt-muted mt-1">Click "Add Rule" to create one.</p>
          </div>
        ) : (
          config.rules.map(rule => (
            <div key={rule.id} className="bg-dt-card border border-dt-border rounded-lg p-3 space-y-2">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-semibold text-indigo-300 bg-indigo-900/30 px-2 py-0.5 rounded">
                      {RULE_TYPE_LABELS[rule.rule_type]}
                    </span>
                    {rule.sla_hours && (
                      <span className="text-xs text-dt-support">SLA: {rule.sla_hours}h</span>
                    )}
                  </div>
                  <p className="text-xs text-dt-support font-mono">{rule.condition}</p>
                  <p className="text-xs text-dt-support mt-1">
                    → Escalate to: <span className="text-dt-support">{ESCALATION_TARGETS.find(t => t.value === rule.action)?.label || rule.action}</span>
                  </p>
                </div>
                <div className="flex gap-1 ml-2">
                  <button
                    onClick={() => setEditingRule(rule)}
                    className="px-2 py-1 text-xs bg-dt-panel hover:bg-dt-panel rounded transition-colors"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDeleteRule(rule.id)}
                    className="px-2 py-1 text-xs bg-dt-panel hover:bg-red-900/40 text-red-300 rounded transition-colors"
                  >
                    Remove
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Rule Editor Modal */}
      {editingRule && (
        <>
          <div className="fixed inset-0 z-40 bg-dt-page/70" onClick={() => setEditingRule(null)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6 pointer-events-none">
            <div className="pointer-events-auto w-full max-w-md max-h-[90vh] overflow-y-auto bg-dt-card border border-dt-border-strong rounded-xl shadow-2xl p-4 space-y-3">
              <div>
                <h3 className="text-sm font-semibold text-white">
                  {config.rules.find(r => r.id === editingRule.id) ? 'Edit Rule' : 'Add Escalation Rule'}
                </h3>
              </div>

              <div>
                <label className="text-xs font-medium text-dt-support block mb-1">Rule Type</label>
                <select
                  value={editingRule.rule_type}
                  onChange={e => setEditingRule({ ...editingRule, rule_type: e.target.value as any })}
                  className="w-full bg-dt-page border border-dt-border-strong rounded px-2 py-1.5 text-xs text-dt-body focus:outline-none focus:border-indigo-500"
                >
                  <option value="topic">Topic-Based (if topic = X)</option>
                  <option value="confidence">Confidence-Based (if confidence &lt; X%)</option>
                  <option value="sentiment">Sentiment-Based (if customer is angry)</option>
                  <option value="custom">Custom Rule</option>
                </select>
              </div>

              <div>
                <label className="text-xs font-medium text-dt-support block mb-1">Condition</label>
                <input
                  placeholder={
                    editingRule.rule_type === 'topic' ? 'e.g., topic="billing"' :
                    editingRule.rule_type === 'confidence' ? 'e.g., confidence<50' :
                    editingRule.rule_type === 'sentiment' ? 'e.g., sentiment="angry"' :
                    'e.g., issue_type="data_export"'
                  }
                  value={editingRule.condition}
                  onChange={e => setEditingRule({ ...editingRule, condition: e.target.value })}
                  className="w-full bg-dt-page border border-dt-border-strong rounded px-2 py-1.5 text-xs text-dt-body focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="text-xs font-medium text-dt-support block mb-1">Escalate To</label>
                <select
                  value={editingRule.action}
                  onChange={e => setEditingRule({ ...editingRule, action: e.target.value })}
                  className="w-full bg-dt-page border border-dt-border-strong rounded px-2 py-1.5 text-xs text-dt-body focus:outline-none focus:border-indigo-500"
                >
                  <option value="">-- Select target --</option>
                  {ESCALATION_TARGETS.map(target => (
                    <option key={target.value} value={target.value}>{target.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-xs font-medium text-dt-support block mb-1">SLA (hours to respond)</label>
                <input
                  type="number"
                  min="0"
                  placeholder="e.g., 4"
                  value={editingRule.sla_hours || ''}
                  onChange={e => setEditingRule({ ...editingRule, sla_hours: e.target.value ? Number(e.target.value) : undefined })}
                  className="w-full bg-dt-page border border-dt-border-strong rounded px-2 py-1.5 text-xs text-dt-body focus:outline-none focus:border-indigo-500"
                />
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

      {/* Action Buttons */}
      <div className="flex gap-2 pt-2 border-t border-dt-border">
        <button
          onClick={handleAddRule}
          className="flex-1 px-3 py-2 bg-dt-panel hover:bg-dt-panel rounded text-xs font-medium transition-colors"
        >
          + Add Rule
        </button>
        <button
          onClick={handleSaveAll}
          disabled={saving}
          className="flex-1 px-3 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded text-xs font-medium transition-colors"
        >
          {saving ? 'Saving...' : 'Save All Rules'}
        </button>
        {saved && (
          <span className="text-xs text-emerald-400 self-center">✓ Saved</span>
        )}
      </div>

      <div className="border-t border-dt-border pt-2">
        <p className="text-xs text-dt-muted">
          💡 Each rule defines a condition that triggers an escalation. Rules are evaluated in order.
        </p>
      </div>
    </div>
  );
}
