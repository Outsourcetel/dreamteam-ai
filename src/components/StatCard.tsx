import React from 'react';
import { StatTile, type Tone } from '../design/primitives';

// LEGACY ADAPTER — old gradient StatCard call sites now render the Design
// System v1 StatTile (docs/design-system.md). Color names map to semantic
// tones; new code should import StatTile directly.
const TONE: Record<string, Tone> = {
  indigo: 'accent', purple: 'accent', emerald: 'ok', amber: 'warn',
  yellow: 'warn', blue: 'info', red: 'danger',
};

const StatCard = ({ label, value, sub, icon, trend, color = 'indigo' }: {
  label: string; value: string; sub?: string; icon: string; trend?: string; color?: string;
}) => (
  <StatTile
    icon={icon}
    label={label}
    value={trend ? <>{value} <span className="text-xs text-dt-ok font-normal">{trend}</span></> : value}
    sub={sub}
    tone={TONE[color] ?? 'accent'}
  />
);

export default StatCard;
