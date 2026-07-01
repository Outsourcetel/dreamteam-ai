import React, { useState } from 'react';
import type { AuthUser, Tenant } from '../../types';

type Phase = 'Discovery' | 'Configuration' | 'Training' | 'Go-Live' | 'Hypercare' | 'Complete';
type Health = 'on-track' | 'at-risk' | 'blocked' | 'complete';

interface Milestone {
  label: string;
  dueDate: string;
  done: boolean;
  deAssisted: boolean;
}

interface Implementation {
  id: string;
  customer: string;
  csm: string;
  implementer: string;
  phase: Phase;
  health: Health;
  startDate: string;
  targetGoLive: string;
  daysToGoLive: number;
  completionPct: number;
  arr: string;
  plan: string;
  milestones: Milestone[];
  deActivity: string[];
  blockers: string[];
}

const PHASES: Phase[] = ['Discovery', 'Configuration', 'Training', 'Go-Live', 'Hypercare', 'Complete'];

const PHASE_INDEX: Record<Phase, number> = {
  Discovery: 0, Configuration: 1, Training: 2, 'Go-Live': 3, Hypercare: 4, Complete: 5,
};

const implementations: Implementation[] = [
  {
    id: 'i1', customer: 'Meridian Corp', csm: 'Elena V.', implementer: 'James O.',
    phase: 'Configuration', health: 'at-risk', startDate: '2026-06-01', targetGoLive: '2026-07-15',
    daysToGoLive: 14, completionPct: 48, arr: '$84,000', plan: 'Enterprise',
    milestones: [
      { label: 'Kickoff & discovery call', dueDate: 'Jun 3', done: true, deAssisted: false },
      { label: 'Data mapping & connector setup', dueDate: 'Jun 10', done: true, deAssisted: true },
      { label: 'Digital Employee configuration', dueDate: 'Jun 20', done: true, deAssisted: true },
      { label: 'Knowledge Base upload (200+ articles)', dueDate: 'Jul 1', done: false, deAssisted: true },
      { label: 'User acceptance testing', dueDate: 'Jul 8', done: false, deAssisted: false },
      { label: 'Staff training sessions', dueDate: 'Jul 12', done: false, deAssisted: true },
      { label: 'Go-live sign-off', dueDate: 'Jul 15', done: false, deAssisted: false },
    ],
    deActivity: [
      'Onboarding DE drafted 14 welcome emails for Meridian users',
      'Knowledge DE indexed 147 Confluence articles automatically',
      'Support DE configured with Meridian-specific escalation rules',
    ],
    blockers: ['KB upload stalled — awaiting legal sign-off on article content', 'IT blocked connector to legacy CRM — escalated'],
  },
  {
    id: 'i2', customer: 'TechCore Inc', csm: 'Sarah M.', implementer: 'Elena V.',
    phase: 'Training', health: 'on-track', startDate: '2026-05-15', targetGoLive: '2026-07-10',
    daysToGoLive: 9, completionPct: 72, arr: '$67,000', plan: 'Growth',
    milestones: [
      { label: 'Kickoff & discovery call', dueDate: 'May 17', done: true, deAssisted: false },
      { label: 'Connector setup (Zendesk + Slack)', dueDate: 'May 25', done: true, deAssisted: true },
      { label: 'DE configuration', dueDate: 'Jun 5', done: true, deAssisted: true },
      { label: 'KB seeded from Confluence', dueDate: 'Jun 15', done: true, deAssisted: true },
      { label: 'Staff training — wave 1', dueDate: 'Jul 3', done: true, deAssisted: true },
      { label: 'Staff training — wave 2', dueDate: 'Jul 7', done: false, deAssisted: true },
      { label: 'Go-live sign-off', dueDate: 'Jul 10', done: false, deAssisted: false },
    ],
    deActivity: [
      'Training DE delivered 3 sessions to 24 TechCore employees',
      'Knowledge DE generated 6 training quizzes from KB content',
      'Support DE shadowed 140 conversations for calibration',
    ],
    blockers: [],
  },
  {
    id: 'i3', customer: 'Delta Logistics', csm: 'James O.', implementer: 'Priya N.',
    phase: 'Discovery', health: 'on-track', startDate: '2026-06-20', targetGoLive: '2026-08-15',
    daysToGoLive: 45, completionPct: 18, arr: '$31,000', plan: 'Growth',
    milestones: [
      { label: 'Kickoff & discovery call', dueDate: 'Jun 22', done: true, deAssisted: false },
      { label: 'Requirements gathering', dueDate: 'Jul 1', done: true, deAssisted: true },
      { label: 'Technical scoping', dueDate: 'Jul 8', done: false, deAssisted: false },
      { label: 'Connector setup', dueDate: 'Jul 20', done: false, deAssisted: true },
      { label: 'DE configuration', dueDate: 'Aug 1', done: false, deAssisted: true },
      { label: 'Go-live', dueDate: 'Aug 15', done: false, deAssisted: false },
    ],
    deActivity: [
      'Onboarding DE sent requirements checklist to Delta stakeholders',
      'Knowledge DE identified 3 documentation gaps from discovery call notes',
    ],
    blockers: [],
  },
  {
    id: 'i4', customer: 'Pinnacle Group', csm: 'Elena V.', implementer: 'James O.',
    phase: 'Hypercare', health: 'on-track', startDate: '2026-04-01', targetGoLive: '2026-06-01',
    daysToGoLive: -30, completionPct: 92, arr: '$43,000', plan: 'Enterprise',
    milestones: [
      { label: 'All phases complete', dueDate: 'Jun 1', done: true, deAssisted: true },
      { label: 'Hypercare monitoring (30 days)', dueDate: 'Jul 1', done: false, deAssisted: true },
      { label: 'CSAT survey + handoff to CS', dueDate: 'Jul 5', done: false, deAssisted: true },
    ],
    deActivity: [
      'Support DE resolving 94% of Pinnacle tickets without escalation',
      'CS DE sent 30-day check-in to all Pinnacle managers',
      'Knowledge DE flagged 2 stale articles for refresh',
    ],
    blockers: [],
  },
  {
    id: 'i5', customer: 'Novus Systems', csm: 'James O.', implementer: 'Sarah M.',
    phase: 'Configuration', health: 'blocked', startDate: '2026-06-10', targetGoLive: '2026-07-30',
    daysToGoLive: 29, completionPct: 35, arr: '$36,000', plan: 'Starter',
    milestones: [
      { label: 'Kickoff', dueDate: 'Jun 12', done: true, deAssisted: false },
      { label: 'Connector setup', dueDate: 'Jun 22', done: true, deAssisted: true },
      { label: 'DE configuration', dueDate: 'Jul 5', done: false, deAssisted: true },
      { label: 'KB upload', dueDate: 'Jul 15', done: false, deAssisted: true },
      { label: 'Go-live', dueDate: 'Jul 30', done: false, deAssisted: false },
    ],
    deActivity: ['Knowledge DE waiting on content from Novus — 0 articles uploaded'],
    blockers: ['Customer unresponsive for 11 days — champion changed role', 'No KB content received — implementation blocked'],
  },
  {
    id: 'i6', customer: 'Oaktree Financial', csm: 'Elena V.', implementer: 'Priya N.',
    phase: 'Complete', health: 'complete', startDate: '2026-03-01', targetGoLive: '2026-05-15',
    daysToGoLive: -47, completionPct: 100, arr: '$52,000', plan: 'Enterprise',
    milestones: [
      { label: 'All milestones complete', dueDate: 'May 15', done: true, deAssisted: true },
    ],
    deActivity: ['Live — all DEs operating at target SLA'],
    blockers: [],
  },
];

const HEALTH_STYLE: Record<Health, string> = {
  'on-track': 'text-emerald-400 bg-emerald-400/10 border-emerald-500/20',
  'at-risk': 'text-amber-400 bg-amber-400/10 border-amber-500/20',
  'blocked': 'text-red-400 bg-red-400/10 border-red-500/20',
  'complete': 'text-slate-400 bg-slate-700/50 border-slate-600/20',
};

const HEALTH_DOT: Record<Health, string> = {
  'on-track': 'bg-emerald-400',
  'at-risk': 'bg-amber-400',
  'blocked': 'bg-red-400',
  'complete': 'bg-slate-500',
};

const ImplementationWorkspacePage = ({ user, tenant }: { user?: AuthUser; tenant?: Tenant }) => {
  const accent = tenant?.primaryColor || '#6366f1';
  const [expanded, setExpanded] = useState<string | null>(null);
  const [healthFilter, setHealthFilter] = useState<Health | 'all'>('all');

  const active = implementations.filter(i => i.health !== 'complete');
  const onTrack = implementations.filter(i => i.health === 'on-track').length;
  const atRisk = implementations.filter(i => i.health === 'at-risk' || i.health === 'blocked').length;
  const avgDays = Math.round(
    active.filter(i => i.daysToGoLive > 0).reduce((s, i) => s + i.daysToGoLive, 0) /
    Math.max(1, active.filter(i => i.daysToGoLive > 0).length)
  );
  const deTasks = implementations.flatMap(i => i.deActivity).length;

  const filtered = implementations.filter(i =>
    healthFilter === 'all' || i.health === healthFilter
  );

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Implementation Workspace</h1>
          <p className="text-slate-400 text-sm mt-1">Track customer onboarding from kickoff through go-live and hypercare</p>
        </div>
        <button className="flex items-center gap-2 px-4 py-2 rounded-xl text-white text-sm font-medium"
          style={{ backgroundColor: accent }}>
          + New Implementation
        </button>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {[
          { label: 'Active Implementations', value: String(active.length), sub: `${implementations.filter(i => i.health === 'complete').length} completed`, icon: '⊞', up: true },
          { label: 'On Track', value: `${onTrack}/${active.length}`, sub: `${atRisk} need attention`, icon: '◎', up: onTrack >= atRisk },
          { label: 'Avg Days to Go-Live', value: String(avgDays), sub: 'Across active projects', icon: '◷', up: avgDays < 30 },
          { label: 'DE Tasks Completed', value: String(deTasks), sub: 'This implementation cycle', icon: '⚡', up: true },
        ].map((k, i) => (
          <div key={i} className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <div className="flex items-start justify-between mb-3">
              <span className="text-lg text-slate-400">{k.icon}</span>
              <span className={`text-xs font-medium ${k.up ? 'text-emerald-400' : 'text-amber-400'}`}>{k.sub}</span>
            </div>
            <div className="text-2xl font-bold text-white mb-1">{k.value}</div>
            <div className="text-xs text-slate-400">{k.label}</div>
          </div>
        ))}
      </div>

      {/* Phase funnel */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 mb-6">
        <h2 className="text-sm font-semibold text-white mb-4">Implementation Pipeline</h2>
        <div className="flex items-center gap-1 overflow-x-auto">
          {PHASES.map((phase, i) => {
            const count = implementations.filter(imp => imp.phase === phase).length;
            return (
              <React.Fragment key={phase}>
                <div className="flex-1 min-w-[80px] text-center">
                  <div className="bg-slate-800 rounded-lg p-3 mb-1.5">
                    <div className="text-xl font-bold text-white">{count}</div>
                    <div className="text-xs text-slate-500 mt-0.5">{phase}</div>
                  </div>
                  {count > 0 && (
                    <div className="flex justify-center gap-0.5">
                      {implementations.filter(imp => imp.phase === phase).map(imp => (
                        <div key={imp.id} className={`w-1.5 h-1.5 rounded-full ${HEALTH_DOT[imp.health]}`} title={imp.customer} />
                      ))}
                    </div>
                  )}
                </div>
                {i < PHASES.length - 1 && (
                  <div className="text-slate-700 text-lg flex-shrink-0">›</div>
                )}
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {/* Filter + Project list */}
      <div className="flex items-center gap-2 mb-4">
        <span className="text-xs text-slate-500">Filter:</span>
        {(['all', 'on-track', 'at-risk', 'blocked', 'complete'] as const).map(h => (
          <button key={h} onClick={() => setHealthFilter(h)}
            className={`px-3 py-1 rounded-lg text-xs font-medium transition-all capitalize ${
              healthFilter === h ? 'text-white' : 'text-slate-400 hover:text-white bg-slate-800'
            }`}
            style={healthFilter === h ? { backgroundColor: accent } : {}}>
            {h}
          </button>
        ))}
      </div>

      <div className="space-y-3">
        {filtered.map(imp => {
          const isExpanded = expanded === imp.id;
          const doneMilestones = imp.milestones.filter(m => m.done).length;
          const currentPhaseIdx = PHASE_INDEX[imp.phase];
          return (
            <div key={imp.id} className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden hover:border-slate-700 transition-all">
              {/* Row */}
              <button
                className="w-full p-4 text-left"
                onClick={() => setExpanded(isExpanded ? null : imp.id)}
              >
                <div className="flex items-center gap-4">
                  {/* Health dot */}
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${HEALTH_DOT[imp.health]}`} />

                  {/* Customer + meta */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-semibold text-white">{imp.customer}</span>
                      <span className={`text-xs px-1.5 py-0.5 rounded border font-medium ${HEALTH_STYLE[imp.health]}`}>
                        {imp.health}
                      </span>
                      <span className="text-xs text-slate-500">{imp.plan}</span>
                      <span className="text-xs text-slate-500">{imp.arr}</span>
                    </div>
                    {/* Phase progress bar */}
                    <div className="flex items-center gap-2">
                      <div className="flex gap-0.5 flex-1">
                        {PHASES.slice(0, -1).map((ph, i) => (
                          <div key={ph} className="flex-1 h-1.5 rounded-full overflow-hidden bg-slate-800">
                            <div
                              className="h-full rounded-full transition-all"
                              style={{
                                width: i < currentPhaseIdx ? '100%' : i === currentPhaseIdx ? '60%' : '0%',
                                backgroundColor: i < currentPhaseIdx ? '#10b981' : accent,
                              }}
                            />
                          </div>
                        ))}
                      </div>
                      <span className="text-xs text-slate-500 flex-shrink-0">{imp.phase}</span>
                    </div>
                  </div>

                  {/* Right meta */}
                  <div className="text-right flex-shrink-0 hidden md:block">
                    <div className="text-xs text-white font-medium">
                      {imp.health === 'complete' ? 'Live' : imp.daysToGoLive > 0 ? `${imp.daysToGoLive}d to go-live` : 'In hypercare'}
                    </div>
                    <div className="text-xs text-slate-500">{doneMilestones}/{imp.milestones.length} milestones</div>
                  </div>

                  {/* CSM/implementer */}
                  <div className="flex-shrink-0 hidden lg:flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full bg-slate-700 text-xs flex items-center justify-center text-slate-400" title={imp.csm}>{imp.csm[0]}</div>
                    <div className="w-6 h-6 rounded-full bg-slate-700 text-xs flex items-center justify-center text-slate-400" title={imp.implementer}>{imp.implementer[0]}</div>
                  </div>

                  <span className="text-slate-600 text-sm flex-shrink-0">{isExpanded ? '▲' : '▼'}</span>
                </div>
              </button>

              {/* Expanded detail */}
              {isExpanded && (
                <div className="border-t border-slate-800 p-4 grid grid-cols-1 lg:grid-cols-3 gap-6">
                  {/* Milestones */}
                  <div className="lg:col-span-2">
                    <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Milestones</h3>
                    <div className="space-y-2">
                      {imp.milestones.map((m, i) => (
                        <div key={i} className={`flex items-center gap-3 p-2.5 rounded-lg ${m.done ? 'bg-emerald-500/5' : 'bg-slate-800/40'}`}>
                          <div className={`w-4 h-4 rounded flex items-center justify-center flex-shrink-0 text-xs ${m.done ? 'bg-emerald-500 text-white' : 'border border-slate-600 text-transparent'}`}>
                            {m.done ? '✓' : ''}
                          </div>
                          <span className={`flex-1 text-xs ${m.done ? 'text-slate-400 line-through' : 'text-white'}`}>{m.label}</span>
                          {m.deAssisted && <span className="text-xs text-indigo-400 bg-indigo-400/10 px-1.5 py-0.5 rounded">DE</span>}
                          <span className="text-xs text-slate-600 flex-shrink-0">{m.dueDate}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Right panel */}
                  <div className="space-y-4">
                    {/* DE Activity */}
                    <div>
                      <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">DE Activity</h3>
                      <div className="space-y-1.5">
                        {imp.deActivity.map((act, i) => (
                          <div key={i} className="flex items-start gap-2 text-xs">
                            <span className="text-indigo-400 mt-0.5">⚡</span>
                            <span className="text-slate-400">{act}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Blockers */}
                    {imp.blockers.length > 0 && (
                      <div>
                        <h3 className="text-xs font-semibold text-red-400 uppercase tracking-wide mb-2">Blockers</h3>
                        <div className="space-y-1.5">
                          {imp.blockers.map((b, i) => (
                            <div key={i} className="flex items-start gap-2 text-xs p-2 bg-red-500/5 border border-red-500/10 rounded-lg">
                              <span className="text-red-400 mt-0.5">!</span>
                              <span className="text-slate-400">{b}</span>
                            </div>
                          ))}
                        </div>
                        <button className="mt-2 text-xs px-3 py-1.5 rounded-lg text-white w-full transition-all"
                          style={{ backgroundColor: accent }}>
                          Escalate to CSM
                        </button>
                      </div>
                    )}

                    {/* Meta */}
                    <div className="space-y-1 text-xs">
                      <div className="flex justify-between"><span className="text-slate-500">CSM</span><span className="text-white">{imp.csm}</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">Implementer</span><span className="text-white">{imp.implementer}</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">Started</span><span className="text-white">{imp.startDate}</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">Target go-live</span><span className="text-white">{imp.targetGoLive}</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">Overall progress</span><span className="text-white">{imp.completionPct}%</span></div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default ImplementationWorkspacePage;
