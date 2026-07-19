import React, { useState, useEffect } from 'react';
import { getAmendmentEffectiveness, getAmendmentImpactHistory, type AmendmentEffectiveness, type AmendmentImpactItem } from '../lib/amendmentMetricsApi';

interface AmendmentMetricsPanelProps {
  entityKind: 'de' | 'playbook' | 'specialist';
  entityId: string;
}

export function AmendmentMetricsPanel({ entityKind, entityId }: AmendmentMetricsPanelProps) {
  const [effectiveness, setEffectiveness] = useState<AmendmentEffectiveness | null>(null);
  const [history, setHistory] = useState<AmendmentImpactItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadMetrics();
  }, [entityKind, entityId]);

  const loadMetrics = async () => {
    setLoading(true);
    const [eff, hist] = await Promise.all([
      getAmendmentEffectiveness(entityKind, entityId),
      getAmendmentImpactHistory(entityKind, entityId, 5),
    ]);
    setEffectiveness(eff);
    setHistory(hist || []);
    setLoading(false);
  };

  if (loading) {
    return <div className="animate-pulse h-32 bg-slate-800 rounded-lg" />;
  }

  if (!effectiveness || effectiveness.total_amendments === 0) {
    return (
      <div className="p-4 bg-slate-800/50 border border-slate-700 rounded-lg text-slate-400 text-sm">
        No amendments yet. Use "Improve this {entityKind}" to get started.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Summary Stats */}
      <div className="grid grid-cols-4 gap-3">
        <div className="p-3 bg-slate-800 border border-slate-700 rounded">
          <div className="text-2xl font-bold text-slate-200">{effectiveness.total_amendments}</div>
          <div className="text-xs text-slate-500">Total Amendments</div>
        </div>
        <div className="p-3 bg-slate-800 border border-slate-700 rounded">
          <div className="text-2xl font-bold text-green-400">{effectiveness.adoption_rate_pct}%</div>
          <div className="text-xs text-slate-500">Adoption Rate</div>
        </div>
        <div className="p-3 bg-slate-800 border border-slate-700 rounded">
          <div className="text-2xl font-bold text-blue-400">+{effectiveness.avg_confidence_delta}%</div>
          <div className="text-xs text-slate-500">Avg Confidence Gain</div>
        </div>
        <div className="p-3 bg-slate-800 border border-slate-700 rounded">
          <div className="text-2xl font-bold text-amber-400">{effectiveness.avg_escalation_rate_delta.toFixed(1)}</div>
          <div className="text-xs text-slate-500">Escalation Rate Δ</div>
        </div>
      </div>

      {/* Impact History */}
      {history.length > 0 && (
        <div className="p-4 bg-slate-800 border border-slate-700 rounded-lg space-y-2">
          <div className="text-sm font-medium text-slate-300 mb-3">Recent Amendments</div>
          {history.map(item => (
            <div key={item.metric_id} className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2 flex-1">
                <span className={`inline-block w-2 h-2 rounded-full ${
                  item.status === 'adopted' ? 'bg-green-500' : 'bg-slate-500'
                }`} />
                <span className="text-slate-400">
                  {item.status === 'adopted'
                    ? `Adopted: +${item.confidence_delta ?? 0}% confidence`
                    : 'Pending approval'}
                </span>
              </div>
              {item.status === 'adopted' && item.adopted_at && (
                <span className="text-slate-500 ml-2">{new Date(item.adopted_at).toLocaleDateString()}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
