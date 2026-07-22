import React from 'react';

const StatCard = ({
  label,
  value,
  sub,
  icon,
  trend,
  color = 'indigo',
}: {
  label: string;
  value: string;
  sub?: string;
  icon: string;
  trend?: string;
  color?: string;
}) => {
  const colors: Record<string, string> = {
    indigo: 'from-indigo-500/20 to-indigo-600/10 border-indigo-500/20',
    emerald: 'from-emerald-500/20 to-emerald-600/10 border-emerald-500/20',
    amber: 'from-amber-500/20 to-amber-600/10 border-amber-500/20',
    blue: 'from-blue-500/20 to-blue-600/10 border-blue-500/20',
    purple: 'from-purple-500/20 to-purple-600/10 border-purple-500/20',
    red: 'from-red-500/20 to-red-600/10 border-red-500/20',
    yellow: 'from-amber-500/20 to-amber-600/10 border-amber-500/20',
  };
  return (
    <div
      className={`bg-gradient-to-br ${
        colors[color] || colors.indigo
      } border rounded-xl p-4`}
    >
      <div className="flex items-start justify-between mb-3">
        <span className="text-xl">{icon}</span>
        {trend && <span className="text-xs text-emerald-400">{trend}</span>}
      </div>
      <div className="text-2xl font-bold text-white mb-1">{value}</div>
      <div className="text-sm text-dt-support">{label}</div>
      {sub && <div className="text-xs text-dt-muted mt-1">{sub}</div>}
    </div>
  );
};

export default StatCard;
