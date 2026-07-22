import React from 'react';

const Badge = ({
  label,
  color = 'slate',
}: {
  label: string;
  color?: string;
}) => {
  const colors: Record<string, string> = {
    green: 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30',
    red: 'bg-red-500/20 text-red-300 border border-red-500/30',
    yellow: 'bg-amber-500/20 text-amber-300 border border-amber-500/30',
    blue: 'bg-blue-500/20 text-blue-300 border border-blue-500/30',
    purple: 'bg-purple-500/20 text-purple-300 border border-purple-500/30',
    slate: 'bg-slate-500/20 text-dt-support border border-slate-500/30',
    indigo: 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30',
    amber: 'bg-amber-500/20 text-amber-300 border border-amber-500/30',
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
        colors[color] || colors.slate
      }`}
    >
      {label}
    </span>
  );
};

export default Badge;
