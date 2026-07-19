import React from 'react';
import { DEPerformanceSummary } from '../../lib/workforceApi';
import { TrendingUp, DollarSign, MessageSquare, AlertCircle } from './icons';

interface PerformanceDashboardProps {
  performance: DEPerformanceSummary;
}

export function PerformanceDashboard({ performance }: PerformanceDashboardProps) {
  const metrics = [
    {
      label: 'CSAT',
      value: `${Math.round(performance.avg_csat)}%`,
      icon: TrendingUp,
      color: performance.avg_csat >= 90 ? 'text-green-400' : 'text-amber-400',
      bg: performance.avg_csat >= 90 ? 'bg-green-900' : 'bg-amber-900',
    },
    {
      label: 'Escalation Rate',
      value: `${Math.round(performance.escalation_rate)}%`,
      icon: AlertCircle,
      color: performance.escalation_rate <= 5 ? 'text-green-400' : 'text-red-400',
      bg: performance.escalation_rate <= 5 ? 'bg-green-900' : 'bg-red-900',
    },
    {
      label: 'Resolution Rate',
      value: `${Math.round(performance.resolution_rate)}%`,
      icon: MessageSquare,
      color: performance.resolution_rate >= 85 ? 'text-green-400' : 'text-amber-400',
      bg: performance.resolution_rate >= 85 ? 'bg-green-900' : 'bg-amber-900',
    },
    {
      label: 'Monthly Cost',
      value: `$${Math.round(performance.cost_this_month)}`,
      icon: DollarSign,
      color: 'text-blue-400',
      bg: 'bg-blue-900',
    },
  ];

  return (
    <div className="bg-slate-800 rounded-lg p-4">
      <h3 className="font-bold text-slate-100 mb-3">Performance: {performance.de_name}</h3>
      <div className="space-y-2">
        {metrics.map((metric) => {
          const Icon = metric.icon;
          return (
            <div key={metric.label} className={`${metric.bg} rounded p-3`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Icon className={`w-4 h-4 ${metric.color}`} />
                  <span className="text-xs text-slate-300">{metric.label}</span>
                </div>
                <span className={`font-bold text-sm ${metric.color}`}>{metric.value}</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* ROI Summary */}
      <div className="mt-4 pt-4 border-t border-slate-700">
        <div className="text-xs text-slate-400 space-y-1">
          <div className="flex justify-between">
            <span>Hours Saved:</span>
            <span className="text-slate-200 font-medium">{performance.roi_hours_saved}h</span>
          </div>
          <div className="flex justify-between">
            <span>FTE Cost:</span>
            <span className="text-slate-200 font-medium">${Math.round(performance.fte_equivalent_cost)}/day</span>
          </div>
          <div className="flex justify-between">
            <span>Stage:</span>
            <span className="text-slate-200 font-medium capitalize">{performance.current_stage}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
