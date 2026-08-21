import React from 'react';

const Badge = ({
  label,
  color = 'slate',
}: {
  label: string;
  color?: string;
}) => {
  const colors: Record<string, string> = {
    green: 'bg-dt-ok-soft text-dt-ok border border-dt-ok-border',
    red: 'bg-dt-danger-soft text-dt-danger border border-dt-danger-border',
    yellow: 'bg-dt-warn-soft text-dt-warn border border-dt-warn-border',
    blue: 'bg-dt-info-soft text-dt-info border border-dt-info-border',
    // purple: non-core hue, kept as a tier/identity marker (e.g. "enterprise"
    // plan) per the mapping table's "non-semantic identity hues keep their
    // hue" rule — made opaque so it reads correctly in both themes.
    purple: 'bg-purple-600 text-purple-100 border border-purple-500',
    slate: 'bg-dt-neutral-soft text-dt-neutral border border-dt-neutral-border',
    indigo: 'bg-dt-accent-soft text-dt-accent-text border border-dt-accent-border',
    amber: 'bg-dt-warn-soft text-dt-warn border border-dt-warn-border',
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
