import React, { useState, useEffect } from 'react';
import type { DigitalEmployee } from '../lib/digitalEmployeesApi';
import { supabase } from '../supabase';

interface AuthorityConfig {
  refund_limit?: number;
  commitment_rules?: Array<{
    id: string;
    condition: string;
    action: 'can_commit' | 'escalate_to_pm';
  }>;
}

export function DEAuthorityPanel({ de }: { de: DigitalEmployee }) {
  const [config, setConfig] = useState<AuthorityConfig>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [editingRule, setEditingRule] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadConfig();
  }, [de.id]);

  const loadConfig = async () => {
    try {
      const { data } = await supabase.rpc('get_de_authority_config', { p_de_id: de.id });
      if (data) {
        setConfig(data as AuthorityConfig);
      }
    } catch (e) {
      console.error('Failed to load authority config:', e);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await supabase.rpc('set_de_authority_config', {
        p_de_id: de.id,
        p_config: config,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      console.error('Failed to save authority config:', e);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleAddCommitmentRule = () => {
    setEditingRule({
      id: Date.now().toString(),
      condition: '',
      action: 'escalate_to_pm',
    });
  };

  const handleSaveCommitmentRule = () => {
    if (!editingRule.condition.trim()) {
      setError('Condition is required');
      return;
    }

    setError(null);
    const rules = (config.commitment_rules || []).filter(r => r.id !== editingRule.id);
    setConfig({
      ...config,
      commitment_rules: [...rules, editingRule],
    });
    setEditingRule(null);
  };

  const handleDeleteCommitmentRule = (id: string) => {
    setConfig({
      ...config,
      commitment_rules: (config.commitment_rules || []).filter(r => r.id !== id),
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <h4 className="text-sm font-semibold text-white mb-1">Authority Configuration</h4>
        <p className="text-xs text-slate-400">Define what {de.name} can autonomously approve or must escalate.</p>
      </div>

      {/* Refund Authority */}
      <div className="bg-slate-800/40 border border-slate-700/50 rounded-lg p-4 space-y-3">
        <div>
          <label className="text-xs font-medium text-slate-400 block mb-2">
            Maximum refund without approval
          </label>
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400">$</span>
            <input
              type="number"
              min="0"
              step="100"
              placeholder="1000"
              value={config.refund_limit || ''}
              onChange={e => setConfig({ ...config, refund_limit: e.target.value ? Number(e.target.value) : undefined })}
              className="flex-1 bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500"
            />
          </div>
          <p className="text-xs text-slate-500 mt-2">
            Refunds above this amount will be escalated to a manager for approval.
          </p>
        </div>
      </div>

      {/* Commitment Rules */}
      <div className="bg-slate-800/40 border border-slate-700/50 rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between mb-2">
          <div>
            <label className="text-xs font-medium text-slate-400 block">
              Commitment Rules (Delivery Dates)
            </label>
            <p className="text-xs text-slate-500 mt-1">
              Define when {de.name} can promise delivery dates.
            </p>
          </div>
        </div>

        {config.commitment_rules && config.commitment_rules.length > 0 ? (
          <div className="space-y-2">
            {config.commitment_rules.map(rule => (
              <div key={rule.id} className="bg-slate-900/50 border border-slate-600 rounded p-2 flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-mono text-slate-300">{rule.condition}</p>
                  <p className="text-xs text-slate-400 mt-1">
                    → {rule.action === 'can_commit' ? '✓ Can promise delivery date' : '→ Escalate to Product Manager'}
                  </p>
                </div>
                <div className="flex gap-1 ml-2 flex-shrink-0">
                  <button
                    onClick={() => setEditingRule(rule)}
                    className="px-2 py-1 text-xs bg-slate-700 hover:bg-slate-600 rounded transition-colors"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDeleteCommitmentRule(rule.id)}
                    className="px-2 py-1 text-xs bg-slate-700 hover:bg-red-900/40 text-red-300 rounded transition-colors"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-slate-500">No commitment rules defined. {de.name} will never promise delivery dates.</p>
        )}

        <button
          onClick={handleAddCommitmentRule}
          className="w-full px-3 py-2 text-xs bg-slate-700 hover:bg-slate-600 rounded transition-colors text-center"
        >
          + Add Commitment Rule
        </button>
      </div>

      {/* Commitment Rule Editor Modal */}
      {editingRule && (
        <>
          <div className="fixed inset-0 z-40 bg-slate-900/70" onClick={() => setEditingRule(null)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6 pointer-events-none">
            <div className="pointer-events-auto w-full max-w-md bg-slate-800 border border-slate-600 rounded-xl shadow-2xl p-4 space-y-3">
              <div>
                <h3 className="text-sm font-semibold text-white">
                  {config.commitment_rules?.find(r => r.id === editingRule.id) ? 'Edit Rule' : 'Add Commitment Rule'}
                </h3>
                <p className="text-xs text-slate-500 mt-1">When should {de.name} be allowed to commit?</p>
              </div>

              <div>
                <label className="text-xs font-medium text-slate-400 block mb-1">Condition</label>
                <input
                  placeholder="e.g., issue_type='bug_fix' AND severity='critical'"
                  value={editingRule.condition}
                  onChange={e => setEditingRule({ ...editingRule, condition: e.target.value })}
                  className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="text-xs font-medium text-slate-400 block mb-1">Action</label>
                <select
                  value={editingRule.action}
                  onChange={e => setEditingRule({ ...editingRule, action: e.target.value })}
                  className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                >
                  <option value="can_commit">✓ Can promise delivery date</option>
                  <option value="escalate_to_pm">→ Escalate to Product Manager</option>
                </select>
              </div>

              {error && (
                <div className="bg-red-900/20 border border-red-700/50 rounded p-2">
                  <p className="text-xs text-red-300">{error}</p>
                </div>
              )}

              <div className="flex gap-2 pt-1">
                <button
                  onClick={handleSaveCommitmentRule}
                  className="flex-1 px-3 py-2 bg-indigo-600 hover:bg-indigo-700 rounded text-xs font-medium transition-colors"
                >
                  Save Rule
                </button>
                <button
                  onClick={() => setEditingRule(null)}
                  className="flex-1 px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded text-xs transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Save Button */}
      <div className="flex items-center gap-2 pt-3 border-t border-slate-700">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-3 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded text-xs font-medium transition-colors"
        >
          {saving ? 'Saving...' : 'Save Authority Config'}
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
