import React, { useState, useEffect } from 'react';
import type { DigitalEmployee } from '../lib/digitalEmployeesApi';
import { supabase } from '../supabase';

interface ConfigAuditEntry {
  timestamp: string;
  changed_by: string;
  action: string;
  details: string;
}

export function SophieConfigurationSummary({ de }: { de: DigitalEmployee }) {
  const [configs, setConfigs] = useState<Record<string, any>>({});
  const [auditLog, setAuditLog] = useState<ConfigAuditEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadConfigurations();
  }, [de.id]);

  const loadConfigurations = async () => {
    try {
      // Load all configurations in parallel
      const [authority, escalation, knowledge, approval] = await Promise.all([
        supabase.rpc('get_de_authority_config', { p_de_id: de.id }),
        supabase.rpc('get_de_escalation_config', { p_de_id: de.id }),
        supabase.rpc('get_de_knowledge_scope', { p_de_id: de.id }),
        supabase.rpc('get_de_preapproval_config', { p_de_id: de.id }),
      ]);

      setConfigs({
        authority: authority.data || {},
        escalation: escalation.data || {},
        knowledge: knowledge.data || {},
        approval: approval.data || {},
      });

      // Load audit log
      const { data: logs } = await supabase.rpc('get_de_config_audit_log', { p_de_id: de.id });
      if (logs) {
        setAuditLog(logs);
      }
    } catch (e) {
      console.error('Failed to load configurations:', e);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return <div className="animate-pulse h-48 bg-dt-card rounded-lg" />;
  }

  const authority = configs.authority || {};
  const escalation = configs.escalation || {};
  const knowledge = configs.knowledge || {};
  const approval = configs.approval || {};

  return (
    <div className="space-y-6">
      <div>
        <h4 className="text-sm font-semibold text-white mb-1">{de.name} Configuration Summary</h4>
        <p className="text-xs text-dt-support">Complete overview of how {de.name} is configured to operate.</p>
      </div>

      {/* Configuration Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Identity Card */}
        <div className="bg-dt-card border border-dt-border rounded-lg p-4 space-y-2">
          <h5 className="text-xs font-semibold text-indigo-300 uppercase tracking-wider">Identity</h5>
          <div className="space-y-1">
            <div>
              <p className="text-xs text-dt-muted">Display Name</p>
              <p className="text-sm text-white font-medium">{de.name}</p>
            </div>
            <div>
              <p className="text-xs text-dt-muted">Domain</p>
              <p className="text-sm text-white font-medium">Support</p>
            </div>
            <div>
              <p className="text-xs text-dt-muted">Status</p>
              <p className="text-sm text-emerald-300">Active</p>
            </div>
          </div>
        </div>

        {/* Authority Card */}
        <div className="bg-dt-card border border-dt-border rounded-lg p-4 space-y-2">
          <h5 className="text-xs font-semibold text-indigo-300 uppercase tracking-wider">Authority</h5>
          <div className="space-y-1">
            <div>
              <p className="text-xs text-dt-muted">Refund Limit</p>
              <p className="text-sm text-white font-mono">
                ${authority.refund_limit || 'Not set'}
              </p>
            </div>
            <div>
              <p className="text-xs text-dt-muted">Commitment Rules</p>
              <p className="text-sm text-white">
                {authority.commitment_rules?.length || 0} rules defined
              </p>
            </div>
          </div>
        </div>

        {/* Knowledge Card */}
        <div className="bg-dt-card border border-dt-border rounded-lg p-4 space-y-2">
          <h5 className="text-xs font-semibold text-indigo-300 uppercase tracking-wider">Knowledge</h5>
          <div className="space-y-1">
            <div>
              <p className="text-xs text-dt-muted">Active Sources</p>
              <p className="text-sm text-white">
                {knowledge.sources?.filter((s: any) => s.enabled).length || 0} enabled
              </p>
            </div>
            <div>
              <p className="text-xs text-dt-muted">Last Sync</p>
              <p className="text-sm text-dt-support">
                {knowledge.sources?.find((s: any) => s.last_sync)?.last_sync ? 'Recently' : 'Never'}
              </p>
            </div>
          </div>
        </div>

        {/* Escalation Card */}
        <div className="bg-dt-card border border-dt-border rounded-lg p-4 space-y-2">
          <h5 className="text-xs font-semibold text-indigo-300 uppercase tracking-wider">Escalation</h5>
          <div className="space-y-1">
            <div>
              <p className="text-xs text-dt-muted">Active Rules</p>
              <p className="text-sm text-white">
                {escalation.rules?.length || 0} rules configured
              </p>
            </div>
            <div>
              <p className="text-xs text-dt-muted">Default Target</p>
              <p className="text-sm text-white">
                {escalation.default_escalation_to || 'Support Lead'}
              </p>
            </div>
          </div>
        </div>

        {/* Approval Card */}
        <div className="bg-dt-card border border-dt-border rounded-lg p-4 space-y-2">
          <h5 className="text-xs font-semibold text-indigo-300 uppercase tracking-wider">Pre-Approval</h5>
          <div className="space-y-1">
            <div>
              <p className="text-xs text-dt-muted">Strategy</p>
              <p className="text-sm text-white font-medium capitalize">
                {approval.strategy || 'rule_based'}
              </p>
            </div>
            <div>
              <p className="text-xs text-dt-muted">Rules / Timeout</p>
              <p className="text-sm text-white">
                {approval.rules?.length || 0} rules · {approval.review_timeout_minutes || 30}m
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Audit Log */}
      <div className="bg-dt-card border border-dt-border rounded-lg p-4 space-y-3">
        <h5 className="text-xs font-semibold text-indigo-300 uppercase tracking-wider">Configuration Audit Trail</h5>

        {auditLog.length > 0 ? (
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {auditLog.map((entry, idx) => (
              <div key={idx} className="bg-dt-inset border border-dt-border/30 rounded p-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-dt-support">{entry.action}</p>
                    <p className="text-xs text-dt-muted mt-0.5">{entry.details}</p>
                  </div>
                  <div className="text-xs text-dt-faint flex-shrink-0 text-right">
                    <p>{entry.changed_by}</p>
                    <p className="text-slate-700 mt-0.5">{new Date(entry.timestamp).toLocaleDateString()}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-dt-muted">No configuration changes yet.</p>
        )}
      </div>

      {/* Quick Links */}
      <div className="border-t border-dt-border pt-3">
        <p className="text-xs text-dt-muted mb-2">Edit configuration:</p>
        <div className="flex flex-wrap gap-2">
          <button className="px-2 py-1 text-xs bg-dt-panel hover:bg-dt-panel rounded transition-colors">
            Edit Identity
          </button>
          <button className="px-2 py-1 text-xs bg-dt-panel hover:bg-dt-panel rounded transition-colors">
            Edit Authority
          </button>
          <button className="px-2 py-1 text-xs bg-dt-panel hover:bg-dt-panel rounded transition-colors">
            Edit Knowledge
          </button>
          <button className="px-2 py-1 text-xs bg-dt-panel hover:bg-dt-panel rounded transition-colors">
            Edit Escalation
          </button>
          <button className="px-2 py-1 text-xs bg-dt-panel hover:bg-dt-panel rounded transition-colors">
            Edit Approval
          </button>
        </div>
      </div>
    </div>
  );
}
