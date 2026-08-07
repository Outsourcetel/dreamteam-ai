// ════════════════════════════════════════════════════════════════════════════
// What one digital employee actually DID — one definition, shared.
//
// This derivation lived inline in OutcomeStatement. The roster needs the same
// numbers, and a second copy is how two screens come to disagree about what
// "handled" means — which is exactly what happened with status labels, where
// six pages had each grown their own map.
//
// ⚠ EVERY FIELD HERE IS A REAL COLUMN OR A SUM OF REAL COLUMNS. Nothing is
// modelled, estimated or inferred. The design handoff draws "1.2m avg reply"
// and "96% closed without you"; neither has a source today, so neither is
// here. A figure without a citation is not a figure to build.
// ════════════════════════════════════════════════════════════════════════════

import type { DeInquiryMetrics, DeActionMetrics } from './api';

export interface WorkSummary {
  /** Everything the employee handled in the window: decisions it made,
   *  actions it executed, work items it finished, and conversations it either
   *  resolved or handed over. Resolutions AND handoffs are both handled work —
   *  stopping to ask is still doing the job. */
  work: number;
  /** Customer conversations it finished itself. */
  resolutions: number;
  /** Conversations it stopped and passed to a person. */
  handedOff: number;
  /** Documents and other artefacts produced. */
  deliverables: number;
  /** Metered value in whole currency units, not cents. */
  metered: number;
  /** What the AI cost to do it. */
  cost: number;
}

export interface WorkSources {
  inquiry?: DeInquiryMetrics;
  action?: DeActionMetrics;
  cost?: { total_cost_usd?: number };
  metering?: { resolutions?: number; escalations?: number; amount_cents?: number };
  outputs?: { items_done?: number; deliverables?: number };
}

export function summariseWork(s: WorkSources): WorkSummary {
  const { inquiry: i, action: a, cost: c, metering: m, outputs: o } = s;
  return {
    work: (i?.total_decisions ?? 0) + (a?.executed ?? 0) + (o?.items_done ?? 0)
        + (m?.resolutions ?? 0) + (m?.escalations ?? 0),
    resolutions: m?.resolutions ?? 0,
    handedOff: m?.escalations ?? 0,
    deliverables: o?.deliverables ?? 0,
    metered: (m?.amount_cents ?? 0) / 100,
    cost: c?.total_cost_usd ?? 0,
  };
}

/** The three cells an EmployeeCard shows, already worded for an owner.
 *
 *  ⚠ Only cells with a number are returned. An employee with nothing to report
 *  gets an empty array and the card says so in a sentence, rather than showing
 *  three zeros — "0 handled" and "no data yet" look identical on a card and
 *  mean very different things. */
export function workCells(w: WorkSummary): Array<{ label: string; value: string }> {
  const cells: Array<{ label: string; value: string }> = [];
  if (w.work > 0) cells.push({ label: 'handled, 30 days', value: String(w.work) });
  if (w.resolutions > 0) cells.push({ label: 'finished itself', value: String(w.resolutions) });
  if (w.handedOff > 0) cells.push({ label: 'came to you', value: String(w.handedOff) });
  if (cells.length < 3 && w.deliverables > 0) cells.push({ label: 'documents made', value: String(w.deliverables) });
  return cells.slice(0, 3);
}
