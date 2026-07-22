import React, { useState, useEffect } from 'react';
import type { DigitalEmployee } from '../lib/digitalEmployeesApi';
import { supabase } from '../supabase';

interface EscalationConfig {
  escalation_routes: string[] | null;
  always_escalate_to: string | null;
  sla_hours: number;
}

export function EscalationConfiguration({ de }: { de: DigitalEmployee }) {
  const [config, setConfig] = useState<EscalationConfig>({
    escalation_routes: [],
    always_escalate_to: null,
    sla_hours: 24,
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    // Load escalation config from DE charter or settings
    if (de.id) {
      loadConfig();
    }
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

  const handleSave = async () => {
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
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-dt-card border border-dt-border rounded-xl p-5 space-y-4">
      <div>
        <h4 className="text-sm font-semibold text-white mb-1">Escalation Configuration</h4>
        <p className="text-xs text-dt-support">Define how this DE escalates to humans when needed.</p>
      </div>

      <div className="space-y-4">
        {/* Escalation Routes */}
        <div>
          <label className="text-xs font-medium text-dt-support block mb-2">
            Escalation Routes (topics/conditions)
          </label>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="support-lead"
                checked={config.escalation_routes?.includes('support_lead') ?? false}
                onChange={(e) => {
                  const routes = config.escalation_routes ?? [];
                  if (e.target.checked && !routes.includes('support_lead')) {
                    setConfig({ ...config, escalation_routes: [...routes, 'support_lead'] });
                  } else {
                    setConfig({ ...config, escalation_routes: routes.filter(r => r !== 'support_lead') });
                  }
                }}
                className="rounded border-dt-border-strong"
              />
              <label htmlFor="support-lead" className="text-sm text-dt-support cursor-pointer">
                Support Lead (topic-based escalations)
              </label>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="finance"
                checked={config.escalation_routes?.includes('finance') ?? false}
                onChange={(e) => {
                  const routes = config.escalation_routes ?? [];
                  if (e.target.checked && !routes.includes('finance')) {
                    setConfig({ ...config, escalation_routes: [...routes, 'finance'] });
                  } else {
                    setConfig({ ...config, escalation_routes: routes.filter(r => r !== 'finance') });
                  }
                }}
                className="rounded border-dt-border-strong"
              />
              <label htmlFor="finance" className="text-sm text-dt-support cursor-pointer">
                Finance Lead (billing/refund questions)
              </label>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="founder"
                checked={config.always_escalate_to === 'founder'}
                onChange={(e) => {
                  if (e.target.checked) {
                    setConfig({ ...config, always_escalate_to: 'founder' });
                  } else {
                    setConfig({ ...config, always_escalate_to: null });
                  }
                }}
                className="rounded border-dt-border-strong"
              />
              <label htmlFor="founder" className="text-sm text-dt-support cursor-pointer">
                Always escalate to Founder (high-risk decisions)
              </label>
            </div>
          </div>
        </div>

        {/* SLA Configuration */}
        <div>
          <label htmlFor="sla" className="text-xs font-medium text-dt-support block mb-2">
            Approval SLA (hours to respond)
          </label>
          <select
            id="sla"
            value={config.sla_hours}
            onChange={(e) => setConfig({ ...config, sla_hours: Number(e.target.value) })}
            className="w-full bg-dt-panel border border-dt-border-strong rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-slate-500"
          >
            <option value={1}>1 hour (urgent)</option>
            <option value={4}>4 hours</option>
            <option value={24}>24 hours (standard)</option>
            <option value={48}>48 hours</option>
          </select>
          <p className="text-xs text-dt-muted mt-1">
            Escalation tasks will trigger alerts if not reviewed within this window.
          </p>
        </div>

        {/* Save Button */}
        <div className="flex items-center gap-2 pt-2">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-3 py-2 bg-indigo-600 hover:bg-indigo-700 rounded text-sm font-medium transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save Configuration'}
          </button>
          {saved && (
            <span className="text-xs text-emerald-400">✓ Saved</span>
          )}
        </div>
      </div>

      <div className="border-t border-dt-border pt-3">
        <p className="text-xs text-dt-muted">
          💡 These settings control how {de.name} escalates decisions to humans. Configure by topic for flexibility or always escalate for highest governance.
        </p>
      </div>
    </div>
  );
}
