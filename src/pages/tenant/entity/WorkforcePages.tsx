import React from 'react';
import { useAuth } from '../../../context/AuthContext';
import type { Page } from '../../../types';
import type { CompanyId } from '../../../data/companies';
import { PageHeader, th, td } from '../../../components/ui';

// ============================================================
// Workforce entity pages: Overview, Talent, Onboarding,
// Development, Payroll. Riley (HR & People DE, confidence 83,
// needs recertification) serves the TCP workforce; PWC has no
// workforce DE — consistent with WorkforceDEsPage roster.
// ============================================================



// ── Overview ───────────────────────────────────────────────────

interface WfStage {
  page: Page;
  label: string;
  icon: string;
  stat: string;
  statColor: string;
}

const WF_STAGES: Record<CompanyId, WfStage[]> = {
  tcp: [
    { page: 'entity_workforce_talent', label: 'Talent', icon: '◎', stat: '2 open roles', statColor: 'text-indigo-300' },
    { page: 'entity_workforce_onboarding', label: 'Onboarding', icon: '⚙', stat: '1 in progress', statColor: 'text-amber-300' },
    { page: 'entity_workforce_development', label: 'Performance & Dev', icon: '↗', stat: 'Cycle opens Jul 15', statColor: 'text-emerald-300' },
    { page: 'entity_workforce_payroll', label: 'Payroll & Benefits', icon: '$', stat: 'Next run Jul 15', statColor: 'text-slate-300' },
  ],
  pwc: [
    { page: 'entity_workforce_talent', label: 'Talent', icon: '◎', stat: '1 open role', statColor: 'text-indigo-300' },
    { page: 'entity_workforce_onboarding', label: 'Onboarding', icon: '⚙', stat: 'None in progress', statColor: 'text-slate-500' },
    { page: 'entity_workforce_development', label: 'Performance & Dev', icon: '↗', stat: 'Cycle opens Aug 1', statColor: 'text-emerald-300' },
    { page: 'entity_workforce_payroll', label: 'Payroll & Benefits', icon: '$', stat: 'Next run Jul 15', statColor: 'text-slate-300' },
  ],
};

const HEADCOUNT_STATS: Record<CompanyId, { label: string; value: string; sub: string; color: string }[]> = {
  tcp: [
    { label: 'Employees', value: '42', sub: 'across 5 teams', color: 'text-white' },
    { label: 'Open roles', value: '2', sub: 'both actively interviewing', color: 'text-indigo-300' },
    { label: 'Onboarding', value: '1', sub: 'this week (Jordan K.)', color: 'text-amber-300' },
    { label: 'Retention', value: '94%', sub: 'trailing 12 months', color: 'text-emerald-300' },
  ],
  pwc: [
    { label: 'Staff', value: '118', sub: 'across 3 practice areas', color: 'text-white' },
    { label: 'Open roles', value: '1', sub: 'Senior Tax Associate', color: 'text-indigo-300' },
    { label: 'Onboarding', value: '0', sub: 'none in progress', color: 'text-slate-400' },
    { label: 'Retention', value: '91%', sub: 'trailing 12 months', color: 'text-emerald-300' },
  ],
};

export const WorkforceOverviewPage = ({ setPage }: { setPage: (p: Page) => void }) => {
  const { activeCompanyId, activeCompany } = useAuth();
  const stages = WF_STAGES[activeCompanyId];
  const stats = HEADCOUNT_STATS[activeCompanyId];
  const isTcp = activeCompanyId === 'tcp';

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Our People</h1>
        <p className="text-slate-400 text-sm mt-1">The humans and their DE partner</p>
        <p className="text-xs text-slate-600 mt-0.5">{activeCompany.name} · {activeCompany.industry}</p>
      </div>

      {/* Journey bar */}
      <div className="mb-8">
        <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Employee journey</h2>
        <div className="flex items-stretch gap-1 overflow-x-auto pb-2">
          {stages.map((s, i) => (
            <React.Fragment key={s.page}>
              <button
                onClick={() => setPage(s.page)}
                className="flex-shrink-0 w-44 text-left rounded-xl p-3.5 border border-slate-800 bg-slate-900 hover:border-indigo-500/50 hover:bg-indigo-500/5 transition-all group"
              >
                <div className="text-lg mb-1.5">{s.icon}</div>
                <p className="text-xs font-semibold text-white leading-tight mb-1 group-hover:text-indigo-200">{s.label}</p>
                <p className={`text-xs font-medium ${s.statColor}`}>{s.stat}</p>
              </button>
              {i < stages.length - 1 && (
                <div className="flex-shrink-0 self-center text-slate-700 text-lg px-0.5">→</div>
              )}
            </React.Fragment>
          ))}
        </div>
      </div>

      {/* DE card / no-DE callout */}
      <div className="mb-8">
        <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Digital Employees on this entity</h2>
        {isTcp ? (
          <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-indigo-600 flex items-center justify-center text-white text-sm font-bold flex-shrink-0">R</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-400" />
                  <span className="text-sm font-semibold text-white">Riley</span>
                </div>
                <p className="text-xs text-slate-400">HR &amp; People DE — onboarding, leave, policy queries, org chart</p>
              </div>
              <div className="text-right flex-shrink-0">
                <p className="text-sm font-bold text-emerald-400">83%</p>
                <p className="text-[10px] text-slate-500">confidence</p>
              </div>
              <button onClick={() => setPage('workforce_des')} className="text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 border border-slate-700 transition-colors flex-shrink-0">
                Manage →
              </button>
            </div>
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
              <span className="text-amber-400 text-sm">⚠</span>
              <p className="text-xs text-amber-300">Recertification was due on 2026-06-01. Riley needs recertification — action required.</p>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-dashed border-slate-800 bg-slate-900/40 px-4 py-4 flex-wrap">
            <p className="text-xs text-slate-500">Workforce operations handled by humans — no workforce DE assigned yet.</p>
            <button onClick={() => setPage('workforce_des')} className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">Assign a DE →</button>
          </div>
        )}
      </div>

      {/* Headcount stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {stats.map(s => (
          <div key={s.label} className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">{s.label}</p>
            <p className={`text-xl font-bold ${s.color}`}>{s.value}</p>
            <p className="text-xs text-slate-500 mt-0.5">{s.sub}</p>
          </div>
        ))}
      </div>
    </div>
  );
};

// ── Talent ─────────────────────────────────────────────────────

interface Role {
  title: string;
  team: string;
  opened: string;
  sourced: number;
  screening: number;
  interview: number;
  offer: number;
}

const ROLES: Record<CompanyId, Role[]> = {
  tcp: [
    { title: 'Senior Backend Engineer', team: 'Engineering', opened: 'May 28', sourced: 34, screening: 8, interview: 4, offer: 1 },
    { title: 'CS Manager', team: 'Customer Success', opened: 'Jun 12', sourced: 21, screening: 6, interview: 2, offer: 0 },
  ],
  pwc: [
    { title: 'Senior Tax Associate', team: 'Tax Practice', opened: 'Jun 2', sourced: 27, screening: 9, interview: 3, offer: 0 },
  ],
};

export const WorkforceTalentPage = ({ setPage: _setPage }: { setPage?: (p: Page) => void }) => {
  const { activeCompanyId } = useAuth();
  const roles = ROLES[activeCompanyId];
  const totals = roles.reduce(
    (acc, r) => ({ sourced: acc.sourced + r.sourced, screening: acc.screening + r.screening, interview: acc.interview + r.interview, offer: acc.offer + r.offer }),
    { sourced: 0, screening: 0, interview: 0, offer: 0 },
  );
  const funnel = [
    { stage: 'Sourced', count: totals.sourced, color: 'bg-indigo-500' },
    { stage: 'Screening', count: totals.screening, color: 'bg-indigo-400' },
    { stage: 'Interview', count: totals.interview, color: 'bg-emerald-500' },
    { stage: 'Offer', count: totals.offer, color: 'bg-emerald-400' },
  ];
  const maxCount = funnel[0].count || 1;

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <PageHeader
        title="Talent — Our People"
        subtitle={`${roles.length} open role${roles.length === 1 ? '' : 's'} — pipeline tracked from sourcing to offer`}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
          <h3 className="text-sm font-semibold text-white mb-3">Open roles</h3>
          <div className="overflow-x-auto rounded-xl border border-slate-800">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-slate-800">
                  {['Role', 'Team', 'Opened', 'Sourced', 'Screening', 'Interview', 'Offer'].map(h => <th key={h} className={th}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {roles.map((r, i) => (
                  <tr key={r.title} className={`border-b border-slate-800/60 hover:bg-slate-800/30 transition-colors ${i === roles.length - 1 ? 'border-b-0' : ''}`}>
                    <td className={`${td} font-medium text-white`}>{r.title}</td>
                    <td className={`${td} text-slate-400 text-xs`}>{r.team}</td>
                    <td className={`${td} text-slate-500 text-xs whitespace-nowrap`}>{r.opened}</td>
                    <td className={`${td} text-slate-300 text-xs`}>{r.sourced}</td>
                    <td className={`${td} text-slate-300 text-xs`}>{r.screening}</td>
                    <td className={`${td} text-indigo-300 text-xs`}>{r.interview}</td>
                    <td className={`${td} text-xs ${r.offer > 0 ? 'text-emerald-300 font-medium' : 'text-slate-600'}`}>{r.offer}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-[11px] text-slate-500">Recruiting is human-led; interview scheduling and candidate comms are candidates for DE automation.</p>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
          <h3 className="text-sm font-semibold text-white mb-4">Candidate funnel</h3>
          <div className="space-y-3">
            {funnel.map(f => (
              <div key={f.stage}>
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="text-slate-400">{f.stage}</span>
                  <span className="text-white font-medium">{f.count}</span>
                </div>
                <div className="h-3 bg-slate-800 rounded-full overflow-hidden">
                  <div className={`h-full rounded-full ${f.color}`} style={{ width: `${(f.count / maxCount) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-slate-500 mt-4">Combined pipeline across all open roles.</p>
        </div>
      </div>
    </div>
  );
};

// ── Onboarding ─────────────────────────────────────────────────

interface OnboardTask {
  task: string;
  owner: 'Riley' | 'Human';
  ownerDetail?: string;
  done: boolean;
}

const JORDAN_TASKS: OnboardTask[] = [
  { task: 'Offer letter signed & filed', owner: 'Riley', done: true },
  { task: 'Accounts provisioned (email, Slack, Jira)', owner: 'Riley', done: true },
  { task: 'Laptop shipped & received', owner: 'Human', ownerDetail: 'IT Ops', done: true },
  { task: 'Benefits enrollment initiated', owner: 'Riley', done: true },
  { task: 'Week-1 buddy assigned', owner: 'Human', ownerDetail: 'Eng Manager', done: false },
  { task: 'Security & compliance training', owner: 'Riley', done: false },
  { task: '30-day check-in scheduled', owner: 'Riley', done: false },
  { task: '90-day goals agreed with manager', owner: 'Human', ownerDetail: 'Eng Manager', done: false },
];

export const WorkforceOnboardingPage = ({ setPage: _setPage }: { setPage?: (p: Page) => void }) => {
  const { activeCompanyId } = useAuth();
  const isTcp = activeCompanyId === 'tcp';
  const doneCount = JORDAN_TASKS.filter(t => t.done).length;
  const pct = Math.round((doneCount / JORDAN_TASKS.length) * 100);

  if (!isTcp) {
    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
        <PageHeader title="Onboarding — Our People" subtitle="New-hire onboarding checklists and progress" />
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-800 bg-slate-900/40 p-12 text-center">
          <div className="w-12 h-12 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-center text-xl mb-4">⚙</div>
          <p className="text-sm font-medium text-slate-300 mb-1">No onboarding in progress</p>
          <p className="text-xs text-slate-500 max-w-sm">When a candidate accepts an offer, their onboarding checklist appears here automatically.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <PageHeader title="Onboarding — Our People" subtitle="1 new hire onboarding this week — Riley runs the checklist, humans own the judgment calls" />

      <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5 max-w-3xl">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <div>
            <h3 className="text-sm font-semibold text-white">Jordan K. — Backend Engineer</h3>
            <p className="text-xs text-slate-500 mt-0.5">Week 1 of 4 · started Jun 30</p>
          </div>
          <div className="text-right">
            <p className="text-sm font-bold text-indigo-300">{pct}%</p>
            <p className="text-[10px] text-slate-500">{doneCount} of {JORDAN_TASKS.length} tasks</p>
          </div>
        </div>
        <div className="h-2 bg-slate-800 rounded-full overflow-hidden mb-5">
          <div className="h-full rounded-full bg-indigo-500" style={{ width: `${pct}%` }} />
        </div>
        <div className="space-y-2">
          {JORDAN_TASKS.map(t => (
            <div key={t.task} className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 ${t.done ? 'border-slate-800 bg-slate-900/40' : 'border-slate-800 bg-slate-900'}`}>
              <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] flex-shrink-0 ${t.done ? 'bg-emerald-500/20 text-emerald-400' : 'border border-slate-700 text-slate-600'}`}>
                {t.done ? '✓' : ''}
              </span>
              <span className={`flex-1 text-xs ${t.done ? 'text-slate-500 line-through' : 'text-slate-200'}`}>{t.task}</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 ${t.owner === 'Riley' ? 'bg-indigo-500/15 text-indigo-300' : 'bg-slate-800 text-slate-400'}`}>
                {t.owner === 'Riley' ? 'Riley (DE)' : t.ownerDetail || 'Human'}
              </span>
            </div>
          ))}
        </div>
        <p className="mt-4 text-[11px] text-slate-500">
          Riley executes routine steps automatically and nudges human owners when their tasks come due.
        </p>
      </div>
    </div>
  );
};

// ── Performance & Development ──────────────────────────────────

const SKILLS: Record<CompanyId, { skill: string; strong: number; developing: number; gap: number }[]> = {
  tcp: [
    { skill: 'Backend engineering', strong: 9, developing: 3, gap: 1 },
    { skill: 'Frontend engineering', strong: 6, developing: 2, gap: 0 },
    { skill: 'Customer success', strong: 5, developing: 3, gap: 1 },
    { skill: 'Data & analytics', strong: 3, developing: 2, gap: 2 },
    { skill: 'Security', strong: 2, developing: 1, gap: 1 },
  ],
  pwc: [
    { skill: 'Tax advisory', strong: 24, developing: 8, gap: 2 },
    { skill: 'Audit & assurance', strong: 31, developing: 10, gap: 1 },
    { skill: 'Advisory & consulting', strong: 18, developing: 7, gap: 3 },
    { skill: 'Data analytics', strong: 9, developing: 6, gap: 4 },
  ],
};

export const WorkforceDevelopmentPage = ({ setPage: _setPage }: { setPage?: (p: Page) => void }) => {
  const { activeCompanyId } = useAuth();
  const isTcp = activeCompanyId === 'tcp';
  const skills = SKILLS[activeCompanyId];
  const cycle = isTcp
    ? { name: 'H2 2026 review cycle', opens: 'Jul 15', completion: 0, selfReviews: '0 of 42 submitted', note: 'Self-reviews open Jul 15; manager reviews due Aug 8.' }
    : { name: 'H2 2026 review cycle', opens: 'Aug 1', completion: 0, selfReviews: '0 of 118 submitted', note: 'Partner calibration scheduled for late August.' };

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <PageHeader title="Performance & Development — Our People" subtitle="Review cycles, skills coverage, and development plans" />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5 h-fit">
          <h3 className="text-sm font-semibold text-white mb-1">{cycle.name}</h3>
          <p className="text-xs text-slate-500 mb-4">Opens {cycle.opens}</p>
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="text-slate-400">Completion</span>
            <span className="text-white font-medium">{cycle.completion}%</span>
          </div>
          <div className="h-2 bg-slate-800 rounded-full overflow-hidden mb-3">
            <div className="h-full rounded-full bg-indigo-500" style={{ width: `${cycle.completion}%` }} />
          </div>
          <p className="text-xs text-slate-400 mb-1">{cycle.selfReviews}</p>
          <p className="text-[11px] text-slate-500">{cycle.note}</p>
        </div>

        <div className="lg:col-span-2 rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
          <h3 className="text-sm font-semibold text-white mb-3">Skills matrix</h3>
          <div className="overflow-x-auto rounded-xl border border-slate-800">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-slate-800">
                  {['Skill area', 'Strong', 'Developing', 'Gap'].map(h => <th key={h} className={th}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {skills.map((s, i) => (
                  <tr key={s.skill} className={`border-b border-slate-800/60 hover:bg-slate-800/30 transition-colors ${i === skills.length - 1 ? 'border-b-0' : ''}`}>
                    <td className={`${td} font-medium text-white`}>{s.skill}</td>
                    <td className={`${td} text-emerald-300 text-xs`}>{s.strong}</td>
                    <td className={`${td} text-indigo-300 text-xs`}>{s.developing}</td>
                    <td className={`${td} text-xs ${s.gap > 1 ? 'text-amber-300' : s.gap === 1 ? 'text-slate-300' : 'text-slate-600'}`}>{s.gap || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-[11px] text-slate-500">Gap counts feed hiring priorities on the Talent page.</p>
        </div>
      </div>
    </div>
  );
};

// ── Payroll & Benefits ─────────────────────────────────────────

const PAYROLL: Record<CompanyId, { date: string; headcount: number; gross: string; benefits: { label: string; value: string }[] }> = {
  tcp: {
    date: 'Jul 15, 2026',
    headcount: 42,
    gross: '$487K',
    benefits: [
      { label: 'Health plan enrollment', value: '40 of 42 (95%)' },
      { label: '401(k) participation', value: '35 of 42 (83%)' },
      { label: 'Open enrollment window', value: 'Nov 1 – Nov 15' },
    ],
  },
  pwc: {
    date: 'Jul 15, 2026',
    headcount: 118,
    gross: '$1.34M',
    benefits: [
      { label: 'Health plan enrollment', value: '112 of 118 (95%)' },
      { label: 'Pension participation', value: '104 of 118 (88%)' },
      { label: 'Open enrollment window', value: 'Oct 15 – Oct 31' },
    ],
  },
};

export const WorkforcePayrollPage = ({ setPage }: { setPage?: (p: Page) => void }) => {
  const { activeCompanyId } = useAuth();
  const data = PAYROLL[activeCompanyId];
  const isTcp = activeCompanyId === 'tcp';

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <PageHeader title="Payroll & Benefits — Our People" subtitle="Payroll runs, benefits enrollment, and approval gates" />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Next payroll run */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
          <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Next payroll run</p>
          <p className="text-2xl font-bold text-white">{data.date}</p>
          <div className="mt-4 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400">Headcount</span>
              <span className="text-white font-medium">{data.headcount}</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400">Estimated gross</span>
              <span className="text-white font-medium">{data.gross}</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400">Status</span>
              <span className="text-indigo-300 font-medium">{isTcp ? 'Riley preparing' : 'In preparation'}</span>
            </div>
          </div>
        </div>

        {/* Benefits */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
          <h3 className="text-sm font-semibold text-white mb-4">Benefits enrollment</h3>
          <div className="space-y-3">
            {data.benefits.map(b => (
              <div key={b.label} className="flex items-center justify-between text-xs">
                <span className="text-slate-400">{b.label}</span>
                <span className="text-white font-medium">{b.value}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Approval gate note */}
        <div className="rounded-2xl border border-indigo-500/30 bg-indigo-500/5 p-5">
          <h3 className="text-sm font-semibold text-indigo-200 mb-2">{isTcp ? 'Riley prepares, human approves' : 'Human-run with approval gate'}</h3>
          <p className="text-xs text-slate-400 leading-relaxed mb-3">
            {isTcp
              ? 'Riley assembles the payroll register and flags anomalies. The run never executes without a human sign-off — an Approval Gate routes it to the CS Manager per DE configuration.'
              : 'Payroll is prepared by the finance team. An approval gate requires partner sign-off before any run executes. Assigning a workforce DE would automate register preparation.'}
          </p>
          {setPage && (
            <button onClick={() => setPage(isTcp ? 'workforce_des' : 'entity_workforce')} className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
              {isTcp ? 'View approval-gate config →' : 'Back to Our People overview →'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
