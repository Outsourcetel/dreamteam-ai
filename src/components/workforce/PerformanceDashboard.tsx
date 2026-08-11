import React from 'react';
import { DEPerformanceSummary } from '../../lib/workforceApi';
import { TrendingUp, DollarSign, MessageSquare, AlertCircle } from './icons';

interface PerformanceDashboardProps {
  performance: DEPerformanceSummary;
}

/** A rate the platform never measured must not render as a number.
 *
 *  mig 491 stopped the SQL fabricating these (missing evidence used to be
 *  coalesced to 0, so an employee with nine real escalations displayed "0%").
 *  That fix only reaches the screen if the client stops doing the same thing:
 *  Math.round(null) is 0 in JavaScript, so a pure-SQL fix would have been
 *  invisible here. A genuine 0 still renders as 0 — the distinction is the
 *  whole point. */
const measured = (v: number | null | undefined): v is number =>
  v !== null && v !== undefined && !Number.isNaN(Number(v));

export function PerformanceDashboard({ performance }: PerformanceDashboardProps) {
  const NOT_MEASURED = 'Not measured';
  const neutral = { color: 'text-dt-muted', bg: 'bg-dt-inset' };
  const metrics = [
    {
      label: 'CSAT',
      value: measured(performance.avg_csat) ? `${Math.round(performance.avg_csat)}%` : NOT_MEASURED,
      icon: TrendingUp,
      ...(measured(performance.avg_csat)
        ? { color: performance.avg_csat >= 90 ? 'text-green-400' : 'text-amber-400',
            bg: performance.avg_csat >= 90 ? 'bg-green-900' : 'bg-amber-900' }
        : neutral),
    },
    {
      label: 'Escalation Rate',
      value: measured(performance.escalation_rate) ? `${Math.round(performance.escalation_rate)}%` : NOT_MEASURED,
      icon: AlertCircle,
      ...(measured(performance.escalation_rate)
        ? { color: performance.escalation_rate <= 5 ? 'text-green-400' : 'text-red-400',
            bg: performance.escalation_rate <= 5 ? 'bg-green-900' : 'bg-red-900' }
        : neutral),
    },
    {
      label: 'Resolution Rate',
      value: measured(performance.resolution_rate) ? `${Math.round(performance.resolution_rate)}%` : NOT_MEASURED,
      icon: MessageSquare,
      ...(measured(performance.resolution_rate)
        ? { color: performance.resolution_rate >= 85 ? 'text-green-400' : 'text-amber-400',
            bg: performance.resolution_rate >= 85 ? 'bg-green-900' : 'bg-amber-900' }
        : neutral),
    },
    {
      label: 'Monthly Cost',
      value: measured(performance.cost_this_month) ? `$${Math.round(performance.cost_this_month)}` : NOT_MEASURED,
      icon: DollarSign,
      ...(measured(performance.cost_this_month) ? { color: 'text-blue-400', bg: 'bg-blue-900' } : neutral),
    },
  ];

  return (
    <div className="bg-dt-card rounded-lg p-4">
      <h3 className="font-bold text-dt-title mb-3">Performance: {performance.de_name}</h3>
      <div className="space-y-2">
        {metrics.map((metric) => {
          const Icon = metric.icon;
          return (
            <div key={metric.label} className={`${metric.bg} rounded p-3`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Icon className={`w-4 h-4 ${metric.color}`} />
                  <span className="text-xs text-dt-support">{metric.label}</span>
                </div>
                <span className={`font-bold text-sm ${metric.color}`}>{metric.value}</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* ROI Summary — mig 708: hours saved was executions × an invented
          0.5h; an unmeasured number renders as "Not measured", never a guess.
          The daily figure is real AI spend, and is labeled as such. */}
      <div className="mt-4 pt-4 border-t border-dt-border">
        <div className="text-xs text-dt-support space-y-1">
          <div className="flex justify-between">
            <span>Hours Saved:</span>
            <span className={measured(performance.roi_hours_saved) ? 'text-dt-body font-medium' : 'text-dt-muted'}>
              {measured(performance.roi_hours_saved) ? `${performance.roi_hours_saved}h` : NOT_MEASURED}
            </span>
          </div>
          <div className="flex justify-between">
            <span>AI Spend:</span>
            <span className="text-dt-body font-medium">${Math.round(performance.fte_equivalent_cost)}/day</span>
          </div>
          <div className="flex justify-between">
            <span>Stage:</span>
            <span className="text-dt-body font-medium capitalize">{performance.current_stage}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
