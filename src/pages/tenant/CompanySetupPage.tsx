import React, { useEffect, useState } from 'react';
import { PageHeader } from '../../components/ui';
import type { Page } from '../../types';
import { useAuth } from '../../context/AuthContext';
import { INDUSTRY_TEMPLATES, industryTemplate } from '../../lib/industries';
import type { IndustryGuardrail, IndustryHire } from '../../lib/industries';
import { listDigitalEmployees, createDigitalEmployee } from '../../lib/digitalEmployeesApi';
import { listGuardrailRules, addGuardrailRule, appendAuditEvent } from '../../lib/guardrailApi';
import { updateTenant } from '../../lib/api';

// ============================================================
// Company Setup — the REAL wizard (Wave 1.1).
//
// The previous version of this page was theater: four steps that
// persisted to localStorage and a "Finish" button that navigated to
// the dashboard. Nothing was ever provisioned. This version:
//   - uses THE canonical industry list (src/lib/industries.ts — the
//     same list signup and Settings use),
//   - saves the industry choice to the tenant record,
//   - creates the selected Digital Employees for real (they start at
//     lifecycle 'designed' and walk the same gated chain as any hire),
//   - creates the selected guardrails as real, editable
//     guardrail_rules rows — every one with an enforceable pattern,
//     shown before creation,
//   - and writes an audit event recording what setup provisioned.
//
// In demo mode nothing is provisioned (honest banner instead).
// ============================================================

const STEPS = ['Industry', 'First hires', 'Guardrails', 'Review & create'];

export default function CompanySetupPage({ setPage }: { setPage: (p: Page) => void }) {
  const { currentTenant, dataMode } = useAuth();
  const isLive = dataMode === 'live';

  const [step, setStep] = useState(0);
  const [industryName, setIndustryName] = useState<string>(currentTenant?.industry ?? '');
  const [existingDeNames, setExistingDeNames] = useState<Set<string>>(new Set());
  const [existingRules, setExistingRules] = useState<Set<string>>(new Set());
  const [pickedHires, setPickedHires] = useState<Set<string>>(new Set());
  const [pickedRules, setPickedRules] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ des: string[]; rules: string[] } | null>(null);

  const template = industryTemplate(industryName || null);

  // Real current state: which recommended hires/rules already exist.
  useEffect(() => {
    if (!isLive) return;
    void (async () => {
      try {
        const [des, rules] = await Promise.all([listDigitalEmployees(), listGuardrailRules()]);
        setExistingDeNames(new Set(des.map(d => d.name.toLowerCase())));
        setExistingRules(new Set(rules.map(r => r.rule.toLowerCase())));
      } catch { /* new tenant with empty tables is fine */ }
    })();
  }, [isLive]);

  // Default selections when the industry changes: everything new.
  useEffect(() => {
    setPickedHires(new Set(template.hires.filter(h => !existingDeNames.has(h.name.toLowerCase())).map(h => h.name)));
    setPickedRules(new Set(template.guardrails.filter(g => !existingRules.has(g.rule.toLowerCase())).map(g => g.rule)));
  }, [industryName, existingDeNames, existingRules]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (set: Set<string>, key: string, apply: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key); else next.add(key);
    apply(next);
  };

  const finish = async () => {
    if (!isLive || !currentTenant?.id) return;
    setBusy(true); setError(null);
    const created: string[] = [];
    const rulesMade: string[] = [];
    try {
      // 1. Industry onto the tenant record (the real update RPC).
      if (industryName && industryName !== currentTenant.industry) {
        await updateTenant(currentTenant.id, { industry: industryName });
      }
      // 2. Real Digital Employees — lifecycle 'designed', no shortcuts.
      for (const h of template.hires) {
        if (!pickedHires.has(h.name) || existingDeNames.has(h.name.toLowerCase())) continue;
        await createDigitalEmployee({ name: h.name, description: h.description, category: h.category, department: h.department });
        created.push(h.name);
      }
      // 3. Real, editable guardrail rows — enforceable from the moment
      //    they exist.
      for (const g of template.guardrails) {
        if (!pickedRules.has(g.rule) || existingRules.has(g.rule.toLowerCase())) continue;
        await addGuardrailRule({
          rule: g.rule,
          rule_type: g.rule_type,
          pattern: g.pattern ?? null,
          threshold: g.threshold ?? null,
          severity: 'blocking',
        });
        rulesMade.push(g.rule);
      }
      // 4. Durable record of what setup did.
      await appendAuditEvent({
        actor: 'You', actor_type: 'human', category: 'config_change',
        action: `Company setup completed — industry "${industryName}", ${created.length} employee(s) hired, ${rulesMade.length} guardrail(s) created`,
        detail: { kind: 'company_setup_completed', industry: industryName, des_created: created, guardrails_created: rulesMade },
      });
      setDone({ des: created, rules: rulesMade });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Setup failed — nothing further was created.');
    }
    setBusy(false);
  };

  const canNext = step === 0 ? !!industryName : true;

  if (done) {
    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
        <PageHeader title="Company Setup" subtitle="Done — everything below is real and editable" />
        <div className="max-w-2xl rounded-2xl border border-emerald-800/50 bg-emerald-500/5 p-6">
          <h3 className="text-base font-semibold text-white mb-2">✓ Setup complete</h3>
          <p className="text-sm text-slate-300 mb-4">
            {done.des.length > 0
              ? <>Hired <span className="text-white">{done.des.join(', ')}</span> — each starts at the Designed lifecycle stage and earns its way to live work through the same gates as any employee.</>
              : 'No new employees were needed — your roster already covers the recommendations.'}
            {' '}{done.rules.length > 0
              ? <>Created {done.rules.length} enforceable guardrail{done.rules.length === 1 ? '' : 's'} — review or edit them any time.</>
              : 'No new guardrails were needed.'}
          </p>
          <div className="flex gap-3">
            <button onClick={() => setPage('workforce_des')} className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm">Meet your employees →</button>
            <button onClick={() => setPage('gov_compliance')} className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm">Review guardrails</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <PageHeader
        title="Company Setup"
        subtitle="Pick your industry, choose your first Digital Employees, and start with guardrails that actually enforce"
      />

      {!isLive && (
        <div className="mb-6 rounded-xl border border-amber-800/50 bg-amber-500/10 px-4 py-3 text-xs text-amber-300">
          Demo workspace — the wizard is fully interactive but nothing is provisioned here. In a live workspace, Finish creates real employees and guardrails.
        </div>
      )}

      {/* Step indicator */}
      <div className="flex items-center gap-2 mb-8 flex-wrap">
        {STEPS.map((s, i) => (
          <React.Fragment key={s}>
            <button
              onClick={() => (i <= step || (i === step + 1 && canNext)) && setStep(i)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs transition-colors ${
                i === step ? 'bg-indigo-600 text-white'
                : i < step ? 'bg-emerald-500/15 text-emerald-400'
                : 'bg-slate-900 border border-slate-800 text-slate-500'
              }`}
            >
              <span className="w-4 h-4 rounded-full bg-slate-950/40 flex items-center justify-center text-[9px] font-bold">
                {i < step ? '✓' : i + 1}
              </span>
              {s}
            </button>
            {i < STEPS.length - 1 && <span className="text-slate-700 text-xs">—</span>}
          </React.Fragment>
        ))}
      </div>

      {error && <div className="mb-4 rounded-xl border border-rose-800/50 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">{error}</div>}

      {/* Step 1: Industry */}
      {step === 0 && (
        <div>
          <h3 className="text-sm font-semibold text-white mb-3">Choose your industry</h3>
          <p className="text-xs text-slate-500 mb-4">
            Sets the recommended first hires and the starter guardrail set. Saved to your workspace —
            everything it creates stays editable.
          </p>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {INDUSTRY_TEMPLATES.map(ind => (
              <button
                key={ind.name}
                onClick={() => setIndustryName(ind.name)}
                className={`text-left rounded-xl border p-4 transition-all ${industryName === ind.name ? 'border-indigo-500 bg-indigo-500/10' : 'border-slate-800 bg-slate-900 hover:border-slate-600'}`}
              >
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="w-8 h-8 rounded-lg bg-slate-800 flex items-center justify-center text-slate-300">{ind.icon}</span>
                  <span className="text-sm font-semibold text-white">{ind.name}</span>
                  {industryName === ind.name && <span className="ml-auto text-indigo-400 text-xs">✓ selected</span>}
                </div>
                <p className="text-xs text-slate-400 leading-relaxed">{ind.blurb}</p>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Step 2: First hires */}
      {step === 1 && (
        <div>
          <h3 className="text-sm font-semibold text-white mb-3">First hires — {template.name}</h3>
          <p className="text-xs text-slate-500 mb-4">
            Each becomes a real Digital Employee at the Designed stage. It earns live work through the
            lifecycle gates — knowledge, testing, your certification — like any hire. Untick any you don't want.
          </p>
          <div className="space-y-3">
            {template.hires.map((h: IndustryHire) => {
              const exists = existingDeNames.has(h.name.toLowerCase());
              const picked = pickedHires.has(h.name);
              return (
                <button key={h.name} disabled={exists}
                  onClick={() => toggle(pickedHires, h.name, setPickedHires)}
                  className={`w-full flex items-center gap-4 text-left rounded-xl border p-4 transition-all ${
                    exists ? 'border-slate-800 bg-slate-900/40 opacity-60'
                    : picked ? 'border-indigo-500/60 bg-indigo-500/10' : 'border-slate-800 bg-slate-900 hover:border-slate-600'}`}
                >
                  <span className={`w-5 h-5 rounded flex items-center justify-center text-[10px] flex-shrink-0 ${exists ? 'bg-emerald-600 text-white' : picked ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-600'}`}>
                    {exists || picked ? '✓' : ''}
                  </span>
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-white">{h.name} <span className="text-xs text-slate-500 font-normal">· {h.department}</span></p>
                    <p className="text-xs text-slate-400">{h.description}</p>
                    <p className="text-[11px] text-slate-600 mt-0.5">{exists ? 'Already on your roster' : h.why}</p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Step 3: Guardrails */}
      {step === 2 && (
        <div>
          <h3 className="text-sm font-semibold text-white mb-3">Starter guardrails — {template.name}</h3>
          <p className="text-xs text-slate-500 mb-4">
            Every rule here carries a real matching pattern and enforces from the moment it exists —
            these are not policy statements. All editable later under Compliance &amp; Guardrails.
          </p>
          <div className="space-y-2">
            {template.guardrails.map((g: IndustryGuardrail) => {
              const exists = existingRules.has(g.rule.toLowerCase());
              const picked = pickedRules.has(g.rule);
              return (
                <button key={g.rule} disabled={exists}
                  onClick={() => toggle(pickedRules, g.rule, setPickedRules)}
                  className={`w-full flex items-start gap-3 text-left rounded-xl border px-4 py-3 transition-all ${
                    exists ? 'border-slate-800 bg-slate-900/40 opacity-60'
                    : picked ? 'border-indigo-500/60 bg-indigo-500/10' : 'border-slate-800 bg-slate-900 hover:border-slate-600'}`}
                >
                  <span className={`mt-0.5 w-5 h-5 rounded flex items-center justify-center text-[10px] flex-shrink-0 ${exists ? 'bg-emerald-600 text-white' : picked ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-600'}`}>
                    {exists || picked ? '✓' : ''}
                  </span>
                  <div className="flex-1">
                    <p className="text-sm text-slate-200">{g.rule}</p>
                    <p className="text-[11px] text-slate-600 mt-0.5 font-mono break-all">
                      {g.rule_type === 'require_approval_over_cents'
                        ? `threshold: $${((g.threshold ?? 0) / 100).toLocaleString()}`
                        : `matches: ${g.pattern}`}
                    </p>
                    {exists && <p className="text-[11px] text-slate-600">Already exists in your guardrails</p>}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Step 4: Review & create */}
      {step === 3 && (
        <div className="max-w-2xl">
          <h3 className="text-sm font-semibold text-white mb-3">Review</h3>
          <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5 space-y-3 mb-4 text-sm text-slate-300">
            <p><span className="text-slate-500">Industry:</span> {industryName || '—'}{industryName !== (currentTenant?.industry ?? '') ? <span className="text-[11px] text-slate-500"> (will be saved)</span> : ''}</p>
            <p><span className="text-slate-500">New employees:</span> {template.hires.filter(h => pickedHires.has(h.name) && !existingDeNames.has(h.name.toLowerCase())).map(h => h.name).join(', ') || 'none'}</p>
            <p><span className="text-slate-500">New guardrails:</span> {template.guardrails.filter(g => pickedRules.has(g.rule) && !existingRules.has(g.rule.toLowerCase())).length} rule(s)</p>
          </div>
          <button
            onClick={() => void finish()}
            disabled={busy || !isLive || !industryName}
            className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm transition-colors disabled:opacity-40"
          >
            {busy ? 'Creating…' : isLive ? 'Finish setup — create for real' : 'Finish (demo — nothing created)'}
          </button>
        </div>
      )}

      {/* Nav buttons */}
      {step < 3 && (
        <div className="flex items-center gap-3 mt-8">
          {step > 0 && (
            <button onClick={() => setStep(step - 1)} className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 text-sm transition-colors">
              ← Back
            </button>
          )}
          <button
            onClick={() => canNext && setStep(step + 1)}
            disabled={!canNext}
            className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Continue →
          </button>
        </div>
      )}
    </div>
  );
}
