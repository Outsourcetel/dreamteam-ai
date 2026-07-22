import React, { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../supabase';
import type { Page } from '../types';
import { listDigitalEmployees, type DigitalEmployee } from '../lib/digitalEmployeesApi';
import {
  getDeInquiryMetrics, getDeActionMetrics, getDeCostMetricsRanged, getOutcomeMetering,
  type DeInquiryMetrics, type DeActionMetrics, type DeCostMetrics, type OutcomeMetering,
} from '../lib/api';
import { countDeOutputs } from '../lib/deWorkbenchApi';
import { useOpenEmployeeFile } from '../lib/employeeFileRoute';
import { PanelCard, Banner, TH, TD, TableScroll } from '../design/primitives';
import { LiveLoadingSkeleton } from './LiveDataStates';

// ═══════════════════════════════════════════════════════════════
// The Outcome STATEMENT (founder rework 2026-07-22): outcomes presented as a
// monthly statement, not a dashboard — one plain-language headline, then a
// payroll-style table (one row per employee: work → outcomes → value → cost),
// both money frames (metered billing + baseline savings) in ONE place, every
// row clicking through to the Employee File. Replaces the old rollup soup.
// ═══════════════════════════════════════════════════════════════

interface Econ {
  counts: { inquiries_handled: number; actions_executed: number; conversations_answered: number };
  hours_saved: number | null; monthly_saving_usd: number | null; de_cost_usd: number | null;
  roi_ratio: number | null; configured: boolean; unconfigured: string[];
}

const usd = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

export default function OutcomeStatement({ setPage }: { setPage: (p: Page) => void }) {
  const { currentTenant } = useAuth();
  const tenantId = currentTenant?.id ?? null;
  const openFile = useOpenEmployeeFile(setPage);
  const [loading, setLoading] = useState(true);
  const [des, setDes] = useState<DigitalEmployee[]>([]);
  const [inq, setInq] = useState<DeInquiryMetrics[]>([]);
  const [act, setAct] = useState<DeActionMetrics[]>([]);
  const [cost, setCost] = useState<DeCostMetrics[]>([]);
  const [om, setOm] = useState<OutcomeMetering | null>(null);
  const [econ, setEcon] = useState<Econ | null>(null);
  const [outputs, setOutputs] = useState<Map<string, { items_done: number; deliverables: number }>>(new Map());

  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const [d, i, a, c, m, e] = await Promise.all([
        listDigitalEmployees().catch(() => [] as DigitalEmployee[]),
        getDeInquiryMetrics(tenantId, 30),
        getDeActionMetrics(tenantId, 30),
        getDeCostMetricsRanged(tenantId, 30),
        getOutcomeMetering(tenantId, 30).catch(() => null),
        (async () => { try { const r = await supabase.rpc('get_de_economics', { p_tenant_id: tenantId, p_days: 30 }); return (r.data ?? null) as Econ | null; } catch { return null; } })(),
      ]);
      if (cancelled) return;
      const active = d.filter(x => x.status === 'active');
      setDes(active); setInq(i); setAct(a); setCost(c); setOm(m); setEcon(e);
      const outs = new Map<string, { items_done: number; deliverables: number }>();
      await Promise.all(active.map(async (de) => {
        try { outs.set(de.id, await countDeOutputs(de.id, 30)); } catch { /* per-row */ }
      }));
      if (!cancelled) { setOutputs(outs); setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [tenantId]);

  if (!tenantId) return <Banner tone="warn">The statement needs a live workspace.</Banner>;
  if (loading) return <div className="p-6"><LiveLoadingSkeleton rows={6} /></div>;

  const inqBy = new Map(inq.map(x => [x.de_id, x]));
  const actBy = new Map(act.map(x => [x.de_id, x]));
  const costBy = new Map(cost.map(x => [x.de_id, x]));
  const meterBy = new Map((om?.by_de ?? []).map(x => [x.de_id, x]));

  const rows = des.map(de => {
    const i = inqBy.get(de.id); const a = actBy.get(de.id); const c = costBy.get(de.id);
    const m = meterBy.get(de.id); const o = outputs.get(de.id);
    const work = (i?.total_decisions ?? 0) + (a?.executed ?? 0) + (o?.items_done ?? 0);
    return {
      de, work,
      resolutions: m?.resolutions ?? 0,
      handedOff: m?.escalations ?? 0,
      metered: (m?.amount_cents ?? 0) / 100,
      deliverables: o?.deliverables ?? 0,
      cost: c?.total_cost_usd ?? 0,
    };
  }).sort((x, y) => y.work - x.work);

  const tot = rows.reduce((s, r) => ({
    work: s.work + r.work, resolutions: s.resolutions + r.resolutions,
    handedOff: s.handedOff + r.handedOff, metered: s.metered + r.metered, cost: s.cost + r.cost,
  }), { work: 0, resolutions: 0, handedOff: 0, metered: 0, cost: 0 });

  const savings = econ?.monthly_saving_usd ?? null;
  const headline = [
    `In the last 30 days your workforce handled ${tot.work} piece${tot.work === 1 ? '' : 's'} of work`,
    tot.resolutions > 0 ? `delivered ${tot.resolutions} customer resolution${tot.resolutions === 1 ? '' : 's'} (${usd(tot.metered)} metered value)` : null,
    savings != null && savings > 0 ? `saved roughly ${usd(Math.round(savings))} against your human baselines` : null,
    `at ${usd(Number(tot.cost.toFixed(2)))} of AI cost`,
  ].filter(Boolean).join(', ') + '.';

  return (
    <div className="p-6 space-y-5">
      <PanelCard title="This month, in one sentence">
        <p className="text-base text-dt-title leading-relaxed">{headline}</p>
        {econ && !econ.configured && (
          <p className="text-xs text-amber-300 mt-2">
            Savings are partial — {econ.unconfigured.length > 0 ? `${econ.unconfigured.join(', ')} have` : 'some work types have'} no human baseline configured yet (set them on any employee's Development tab → Economics).
          </p>
        )}
      </PanelCard>

      <PanelCard title="The statement — one row per employee, last 30 days">
        {rows.length === 0 ? (
          <p className="text-sm text-dt-muted">No active employees yet.</p>
        ) : (
          <TableScroll>
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-dt-border">
                  <th className={TH}>Employee</th>
                  <th className={TH}>Work handled</th>
                  <th className={TH}>Resolutions</th>
                  <th className={TH}>Handed to you</th>
                  <th className={TH}>Documents</th>
                  <th className={TH}>Metered value</th>
                  <th className={TH}>AI cost</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.de.id} onClick={() => openFile(r.de.id)}
                    className="border-b border-dt-border last:border-b-0 cursor-pointer hover:bg-dt-panel transition-colors">
                    <td className={`${TD} font-medium text-dt-title`}>{r.de.persona_name ?? r.de.name}</td>
                    <td className={`${TD} font-mono`}>{r.work}</td>
                    <td className={`${TD} font-mono ${r.resolutions > 0 ? 'text-emerald-300' : ''}`}>{r.resolutions || '—'}</td>
                    <td className={`${TD} font-mono`}>{r.handedOff || '—'}</td>
                    <td className={`${TD} font-mono`}>{r.deliverables || '—'}</td>
                    <td className={`${TD} font-mono ${r.metered > 0 ? 'text-emerald-300' : ''}`}>{r.metered > 0 ? usd(r.metered) : '—'}</td>
                    <td className={`${TD} font-mono`}>{r.cost > 0 ? usd(Number(r.cost.toFixed(2))) : '—'}</td>
                  </tr>
                ))}
                <tr className="bg-dt-inset">
                  <td className={`${TD} font-semibold text-dt-title`}>Workforce total</td>
                  <td className={`${TD} font-mono font-semibold`}>{tot.work}</td>
                  <td className={`${TD} font-mono font-semibold text-emerald-300`}>{tot.resolutions}</td>
                  <td className={`${TD} font-mono font-semibold`}>{tot.handedOff}</td>
                  <td className={`${TD} font-mono font-semibold`}>{rows.reduce((s, r) => s + r.deliverables, 0)}</td>
                  <td className={`${TD} font-mono font-semibold text-emerald-300`}>{usd(tot.metered)}</td>
                  <td className={`${TD} font-mono font-semibold`}>{usd(Number(tot.cost.toFixed(2)))}</td>
                </tr>
              </tbody>
            </table>
          </TableScroll>
        )}
        <p className="text-[11px] text-dt-muted mt-2">Click any row for that employee's full file. Metered value uses your per-resolution price; handoffs to your team are always free.</p>
      </PanelCard>

      {om && om.by_day.length > 0 && (
        <PanelCard title="Resolutions by day">
          <div className="flex items-end gap-1 h-24">
            {om.by_day.map(d => {
              const max = Math.max(...om.by_day.map(x => x.resolutions + x.escalations), 1);
              return (
                <div key={d.day} className="flex-1 flex flex-col justify-end gap-px" title={`${d.day}: ${d.resolutions} resolved · ${d.escalations} handed off`}>
                  <div className="bg-dt-accent rounded" style={{ height: `${(d.resolutions / max) * 100}%` }} />
                  <div className="bg-dt-panel rounded" style={{ height: `${(d.escalations / max) * 100}%` }} />
                </div>
              );
            })}
          </div>
          <p className="text-[11px] text-dt-muted mt-2">Indigo = resolved by the workforce · grey = handed to your team.</p>
        </PanelCard>
      )}
    </div>
  );
}
