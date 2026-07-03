// ============================================================
// ROI / VALUE ROLLUP — single source of truth for "what is this
// saving me?" Derived strictly from the per-DE numbers asserted
// on the Performance page (IntelligencePages METRICS):
//   TCP — Alex 847 tasks @ $1.40 (human baseline $14.20)
//         Casey 312 @ $2.10 ($31.50) · Riley 178 @ $1.85 ($18.70)
//   PWC — Morgan 241 @ $2.60 ($42.00) · Avery 94 @ $6.80 ($185.00)
// No invented precision: savings are an ESTIMATE vs the human
// baseline the Performance page already shows.
// Consumed by DashboardPage and PerformancePage.
// ============================================================

import type { CompanyId } from './companies';

export interface RoiDEInput {
  name: string;
  tasks: number;
  costPerTask: number;       // $ per task, DE
  humanCostPerTask: number;  // $ per task, human baseline
}

export const ROI_INPUTS: Record<CompanyId, RoiDEInput[]> = {
  tcp: [
    { name: 'Alex', tasks: 847, costPerTask: 1.40, humanCostPerTask: 14.20 },
    { name: 'Casey', tasks: 312, costPerTask: 2.10, humanCostPerTask: 31.50 },
    { name: 'Riley', tasks: 178, costPerTask: 1.85, humanCostPerTask: 18.70 },
  ],
  pwc: [
    { name: 'Morgan', tasks: 241, costPerTask: 2.60, humanCostPerTask: 42.00 },
    { name: 'Avery', tasks: 94, costPerTask: 6.80, humanCostPerTask: 185.00 },
  ],
};

export interface RoiSummary {
  tasks: number;
  deCost: number;
  humanCost: number;
  savings: number;
  savingsPct: number;   // rounded whole %
  /** Human-readable derivation, e.g. for a title attribute. */
  formula: string;
}

const usd = (n: number) =>
  '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

/** Compact $ format: $2.2K / $25.2K */
export const roiK = (n: number) => `$${(n / 1000).toFixed(1)}K`;

export function computeRoi(companyId: CompanyId): RoiSummary {
  const inputs = ROI_INPUTS[companyId];
  const tasks = inputs.reduce((s, d) => s + d.tasks, 0);
  const deCost = inputs.reduce((s, d) => s + d.tasks * d.costPerTask, 0);
  const humanCost = inputs.reduce((s, d) => s + d.tasks * d.humanCostPerTask, 0);
  const savings = humanCost - deCost;
  const savingsPct = Math.round((savings / humanCost) * 100);
  const formula = inputs
    .map(d => `${d.name}: ${d.tasks} tasks × $${d.costPerTask.toFixed(2)} DE (vs $${d.humanCostPerTask.toFixed(2)} human) = ${usd(d.tasks * d.costPerTask)} vs ${usd(d.tasks * d.humanCostPerTask)}`)
    .join(' · ') + ` — total ${usd(deCost)} DE vs ${usd(humanCost)} human baseline = ${usd(savings)} estimated savings (${savingsPct}%)`;
  return { tasks, deCost, humanCost, savings, savingsPct, formula };
}
