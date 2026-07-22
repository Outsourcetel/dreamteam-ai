import React, { useEffect, useState } from 'react';
import { getWorkforceEconomics, setWorkforceFteCost, type WorkforceEconomics } from '../lib/employeeRecordApi';

// Whole-workforce economics (Tier-1 surfacing) — get_workforce_economics
// (mig 193) has computed this all along with zero readers: what the workforce
// did, what it cost in AI, and — once a human-cost baseline is set — the
// dollar value of the time it saved. The CFO number, made honest: real
// metrics always shown; the dollar figure only appears when the baseline it
// depends on is actually set (never an invented ROI).

const money = (n: number) => n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(n < 10 ? 2 : 0)}`;

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div>
      <p className="text-xl font-semibold text-dt-title tabular-nums">{value}</p>
      <p className="text-[11px] text-dt-support mt-0.5">{label}</p>
      {hint && <p className="text-[10px] text-dt-muted">{hint}</p>}
    </div>
  );
}

export default function WorkforceEconomicsPanel({ tenantId }: { tenantId: string }) {
  const [econ, setEcon] = useState<WorkforceEconomics | null>(null);
  const [hidden, setHidden] = useState(false);
  const [editing, setEditing] = useState(false);
  const [fte, setFte] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = () => getWorkforceEconomics(tenantId)
    .then(setEcon).catch(() => setHidden(true));
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [tenantId]);

  if (hidden || econ === null) return null;

  const hours = Math.round(econ.human_minutes_saved / 60);
  const save = async () => {
    const n = Number(fte);
    if (!Number.isFinite(n) || n <= 0) { setErr('Enter a monthly cost, e.g. 4200.'); return; }
    setSaving(true); setErr(null);
    try { await setWorkforceFteCost(n); setEditing(false); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not save.'); }
    finally { setSaving(false); }
  };

  return (
    <div className="rounded-2xl border border-dt-border bg-dt-card p-5">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
        <div>
          <h2 className="text-sm font-semibold text-dt-title">What your workforce is worth</h2>
          <p className="text-xs text-dt-muted">Live economics across every digital employee — real work, real AI cost.</p>
        </div>
        {econ.baseline_configured && !editing && (
          <button onClick={() => { setFte(''); setEditing(true); }} className="text-[11px] text-dt-support hover:text-dt-body underline">edit FTE baseline</button>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Stat label="Digital employees" value={econ.digital_employees} />
        <Stat label="Tasks run" value={econ.playbook_runs} hint={`${econ.playbook_completed} completed`} />
        <Stat label="AI spend (this period)" value={money(econ.ai_cost_usd)} hint="hard-capped by your budget" />
        {econ.baseline_configured
          ? <Stat label="Est. value of time saved" value={econ.est_value_usd != null ? money(econ.est_value_usd) : '—'} hint={`≈ ${hours} human-hour${hours === 1 ? '' : 's'}`} />
          : <Stat label="Est. value of time saved" value={<span className="text-dt-muted text-base">set baseline →</span>} />}
      </div>

      {/* Honest gate: no invented ROI — the dollar figure needs a real input. */}
      {(!econ.baseline_configured || editing) && (
        <div className="mt-4 rounded-xl border border-dt-border bg-dt-inset px-4 py-3">
          <p className="text-xs text-dt-support mb-2">
            {econ.baseline_configured ? 'Update the' : 'To turn saved time into a dollar value, enter the'} average <span className="text-dt-body font-medium">fully-loaded monthly cost of one human doing this work</span>. Nothing is estimated until you do — we won't invent an ROI.
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-1">
              <span className="text-dt-muted text-sm">$</span>
              <input value={fte} onChange={e => setFte(e.target.value)} inputMode="numeric" placeholder="4200"
                className="w-28 text-sm bg-dt-page border border-dt-border-strong rounded-lg px-2.5 py-1.5 text-dt-title placeholder-dt-faint focus:outline-none focus:border-dt-accent" />
              <span className="text-dt-muted text-xs">/ month</span>
            </div>
            <button disabled={saving} onClick={save} className="text-xs px-3 py-1.5 rounded-lg bg-dt-accent hover:brightness-110 text-white disabled:opacity-50">{saving ? 'Saving…' : 'Save baseline'}</button>
            {editing && <button onClick={() => setEditing(false)} className="text-xs px-3 py-1.5 rounded-lg border border-dt-border-strong text-dt-support">Cancel</button>}
            {err && <span className="text-xs text-rose-400">{err}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
