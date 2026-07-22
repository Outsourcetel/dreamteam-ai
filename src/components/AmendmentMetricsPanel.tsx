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
    return <div className="animate-pulse h-32 bg-dt-card rounded-lg" />;
  }

  if (!effectiveness || effectiveness.total_amendments === 0) {
    return (
      <div className="p-4 bg-dt-card border border-dt-border rounded-lg text-dt-support text-sm">
        No amendments yet. Use "Improve this {entityKind}" to get started.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Summary Stats */}
      <div className="grid grid-cols-4 gap-3">
        <div className="p-3 bg-dt-card border border-dt-border rounded">
          <div className="text-2xl font-bold text-dt-body">{effectiveness.total_amendments}</div>
          <div className="text-xs text-dt-muted">Total Amendments</div>
        </div>
        <div className="p-3 bg-dt-card border border-dt-border rounded">
          <div className="text-2xl font-bold text-green-400">{effectiveness.adoption_rate_pct}%</div>
          <div className="text-xs text-dt-muted">Adoption Rate</div>
        </div>
        <div className="p-3 bg-dt-card border border-dt-border rounded">
          <div className="text-2xl font-bold text-blue-400">+{effectiveness.avg_confidence_delta}%</div>
          <div className="text-xs text-dt-muted">Avg Confidence Gain</div>
        </div>
        <div className="p-3 bg-dt-card border border-dt-border rounded">
          <div className="text-2xl font-bold text-amber-400">{effectiveness.avg_escalation_rate_delta.toFixed(1)}</div>
          <div className="text-xs text-dt-muted">Escalation Rate Δ</div>
        </div>
      </div>

      {/* Impact History */}
      {history.length > 0 && (
        <div className="p-4 bg-dt-card border border-dt-border rounded-lg space-y-2">
          <div className="text-sm font-medium text-dt-support mb-3">Recent Amendments</div>
          {history.map(item => (
            <div key={item.metric_id} className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2 flex-1">
                <span className={`inline-block w-2 h-2 rounded-full ${
                  item.status === 'adopted' ? 'bg-green-500' : 'bg-slate-500'
                }`} />
                <span className="text-dt-support">
                  {item.status === 'adopted'
                    ? `Adopted: +${item.confidence_delta ?? 0}% confidence`
                    : 'Pending approval'}
                </span>
              </div>
              {item.status === 'adopted' && item.adopted_at && (
                <span className="text-dt-muted ml-2">{new Date(item.adopted_at).toLocaleDateString()}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
