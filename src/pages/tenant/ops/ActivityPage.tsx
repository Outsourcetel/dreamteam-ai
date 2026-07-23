import React, { useState, useEffect } from 'react';
import { useAuth } from '../../../context/AuthContext';
import { PageHeader } from '../../../components/ui';
import { LiveEmptyState } from '../../../components/LiveDataStates';
import type { Page } from '../../../types';
import type { CompanyId } from '../../../data/companies';

// Found in the 2026-07-09 adversarial go-live audit: this page had NO
// live/demo gate at all — a real tenant clicking "Activity Log" saw
// this fabricated seed timeline (fake names, fake dollar figures)
// unconditionally, presented as their own operational history. Fixed
// the same way every other page in this codebase already handles
// this (VendorPages.tsx/WorkforcePages.tsx's NotYetAvailable pattern)
// — except real per-DE activity genuinely exists (ops_de_activity /
// DEActivityPage.tsx, wired to real evidence_runs data), so this
// points there instead of a generic "not built" message.
function ActivityLogNotYetAvailable({ setPage }: { setPage: (p: Page) => void }) {
  return (
    <div className="p-6">
      <PageHeader title="Activity Log" subtitle="Org-wide activity stream" />
      <LiveEmptyState
        icon="◈"
        title="This org-wide feed isn't built yet"
        body="This page's org-wide event stream is still a design preview. For real, live per-employee activity, see DE at Work — or the immutable Audit Trail for the compliance record."
        primaryLabel="Open DE at Work"
        onPrimary={() => setPage('ops_de_activity')}
        secondaryLabel="Open Audit Trail"
        onSecondary={() => setPage('gov_audit')}
      />
    </div>
  );
}

// ── Types ─────────────────────────────────────────────────────────

type ActivityType = 'resolved' | 'escalated' | 'kb_gap' | 'error' | 'config_change' | 'guardrail_block';

interface ActivityRow {
  id: string;
  type: ActivityType;
  de: string;          // DE name or 'System'/'Human'
  entity: string;      // Customer / Workforce / Vendor / Governance / Knowledge
  hour: string;        // group bucket, e.g. '14:00 — Today'
  time: string;
  text: string;
  confidence?: number;
}

// ── Seed data — extends the DashboardPage activity seeds ──────────

const TCP_ACTIVITY: ActivityRow[] = [
  // 14:00 hour (dashboard seeds live here)
  { id: 'a1', type: 'resolved', de: 'Alex', entity: 'Customer', hour: '14:00 — Today', time: '14:22', text: 'Alex resolved — "How do I reset 2FA?"', confidence: 94 },
  { id: 'a2', type: 'escalated', de: 'Alex', entity: 'Customer', hour: '14:00 — Today', time: '14:16', text: 'Alex escalated — API auth bug to L2', confidence: 58 },
  { id: 'a3', type: 'kb_gap', de: 'Alex', entity: 'Knowledge', hour: '14:00 — Today', time: '14:09', text: 'Gap detected — "Webhook retry logic" (23 queries)' },
  { id: 'a4', type: 'resolved', de: 'Casey', entity: 'Customer', hour: '14:00 — Today', time: '14:02', text: 'Casey sent renewal invoice — Harbor Tech $67K' },
  // 13:00
  { id: 'a5', type: 'resolved', de: 'Riley', entity: 'Workforce', hour: '13:00 — Today', time: '13:53', text: 'Riley completed onboarding checklist — new hire #4' },
  { id: 'a6', type: 'escalated', de: 'Casey', entity: 'Customer', hour: '13:00 — Today', time: '13:39', text: 'Casey flagged at-risk — Apex Systems (health: 34)', confidence: 34 },
  { id: 'a7', type: 'resolved', de: 'Alex', entity: 'Customer', hour: '13:00 — Today', time: '13:24', text: 'Alex resolved 3 tickets — billing questions', confidence: 91 },
  { id: 'a8', type: 'resolved', de: 'Riley', entity: 'Workforce', hour: '13:00 — Today', time: '13:00', text: 'Riley processed onboarding — new hire Jordan K.' },
  // 12:00
  { id: 'a9', type: 'kb_gap', de: 'Alex', entity: 'Knowledge', hour: '12:00 — Today', time: '12:15', text: 'Alex submitted KB article — "Rate limiting guide" (pending review)' },
  { id: 'a10', type: 'resolved', de: 'Alex', entity: 'Customer', hour: '12:00 — Today', time: '12:08', text: 'Alex resolved — SSO login loop, Meridian Group', confidence: 87 },
  { id: 'a11', type: 'resolved', de: 'Casey', entity: 'Customer', hour: '12:00 — Today', time: '12:01', text: 'Casey confirmed payment received — Northwind Labs $22.4K' },
  // 11:00
  { id: 'a12', type: 'resolved', de: 'Alex', entity: 'Customer', hour: '11:00 — Today', time: '11:47', text: 'Alex resolved ticket #4815 — billing question', confidence: 92 },
  { id: 'a13', type: 'resolved', de: 'Casey', entity: 'Customer', hour: '11:00 — Today', time: '11:30', text: 'Casey sent renewal email cadence — 3 accounts' },
  { id: 'a14', type: 'error', de: 'Riley', entity: 'Workforce', hour: '11:00 — Today', time: '11:12', text: 'Riley: Workday connector timeout — retrying' },
  { id: 'a15', type: 'resolved', de: 'Alex', entity: 'Customer', hour: '11:00 — Today', time: '11:04', text: 'Alex resolved — data export question, Sunrise Media', confidence: 89 },
  // 10:00
  { id: 'a16', type: 'resolved', de: 'Alex', entity: 'Customer', hour: '10:00 — Today', time: '10:51', text: 'Alex resolved — webhook signature validation query', confidence: 84 },
  { id: 'a17', type: 'error', de: 'Riley', entity: 'Workforce', hour: '10:00 — Today', time: '10:00', text: 'Workday connector timeout — sync failed, attempt 2' },
  { id: 'a18', type: 'resolved', de: 'Casey', entity: 'Customer', hour: '10:00 — Today', time: '10:22', text: 'Casey updated renewal stage — 2 accounts to "Committed"' },
  { id: 'a19', type: 'escalated', de: 'Alex', entity: 'Customer', hour: '10:00 — Today', time: '10:15', text: 'Alex routed feature request to Product — bulk user import', confidence: 66 },
  // 09:00
  { id: 'a20', type: 'guardrail_block', de: 'Alex', entity: 'Governance', hour: '09:00 — Today', time: '09:45', text: 'BLOCKED: Alex attempted SLA commitment outside standard tier — guardrail DE-R2' },
  { id: 'a21', type: 'resolved', de: 'Alex', entity: 'Customer', hour: '09:00 — Today', time: '09:38', text: 'Alex resolved 5 tickets — morning batch', confidence: 90 },
  { id: 'a22', type: 'kb_gap', de: 'Casey', entity: 'Knowledge', hour: '09:00 — Today', time: '09:20', text: 'Gap detected — "Multi-currency invoicing" (Casey, 11 queries)' },
  { id: 'a23', type: 'resolved', de: 'Riley', entity: 'Workforce', hour: '09:00 — Today', time: '09:05', text: 'Riley answered 4 HR policy questions — benefits enrollment' },
  // Yesterday
  { id: 'a24', type: 'config_change', de: 'Human', entity: 'Governance', hour: 'Yesterday', time: '16:30', text: 'Guardrails updated v2.2→v2.3 — added SLA-tier restriction (Alex), by K. Douglas' },
  { id: 'a25', type: 'resolved', de: 'Alex', entity: 'Customer', hour: 'Yesterday', time: '15:10', text: 'Alex resolved 8 tickets — batch shift', confidence: 88 },
  { id: 'a26', type: 'escalated', de: 'Casey', entity: 'Customer', hour: 'Yesterday', time: '15:00', text: 'Casey flagged at-risk — Apex Systems, escalated to AE' },
  { id: 'a27', type: 'resolved', de: 'Riley', entity: 'Workforce', hour: 'Yesterday', time: '14:00', text: 'Riley approved leave request — P. Sharma' },
  { id: 'a28', type: 'config_change', de: 'Human', entity: 'Workforce', hour: 'Yesterday', time: '11:20', text: 'Riley learning rate changed to Medium — by HR Manager' },
  { id: 'a29', type: 'kb_gap', de: 'Alex', entity: 'Knowledge', hour: 'Yesterday', time: '09:00', text: 'KB gap flagged — "Webhook retry logic" (initial detection)' },
  { id: 'a30', type: 'error', de: 'Riley', entity: 'Workforce', hour: 'Yesterday', time: '08:45', text: 'Recertification overdue — Riley flagged for recert' },
  { id: 'a31', type: 'resolved', de: 'Casey', entity: 'Customer', hour: 'Yesterday', time: '08:30', text: 'Casey closed renewal — Harbor Tech $67,000 (Closed Won)' },
  { id: 'a32', type: 'resolved', de: 'Alex', entity: 'Customer', hour: 'Yesterday', time: '08:10', text: 'Alex resolved — API pagination question', confidence: 93 },
];

const PWC_ACTIVITY: ActivityRow[] = [
  // 14:00
  { id: 'p1', type: 'resolved', de: 'Avery', entity: 'Customer', hour: '14:00 — Today', time: '14:05', text: 'Avery completed tax research — Q2 corp memo', confidence: 91 },
  { id: 'p2', type: 'escalated', de: 'Avery', entity: 'Customer', hour: '14:00 — Today', time: '14:02', text: 'Avery escalated memo to partner review' },
  { id: 'p3', type: 'escalated', de: 'Morgan', entity: 'Customer', hour: '14:00 — Today', time: '14:00', text: 'GDPR request — overdue response escalated to partner' },
  // 13:00
  { id: 'p4', type: 'kb_gap', de: 'Avery', entity: 'Knowledge', hour: '13:00 — Today', time: '13:48', text: 'Gap detected — "FATCA filing for dual-nationals"' },
  { id: 'p5', type: 'resolved', de: 'Morgan', entity: 'Customer', hour: '13:00 — Today', time: '13:33', text: 'Morgan completed KYC — new client onboarding' },
  { id: 'p6', type: 'resolved', de: 'Avery', entity: 'Customer', hour: '13:00 — Today', time: '13:18', text: 'Avery reviewed 14 workpapers — Harbor Financial', confidence: 88 },
  { id: 'p7', type: 'resolved', de: 'Morgan', entity: 'Customer', hour: '13:00 — Today', time: '13:05', text: 'Morgan sent engagement status update — 3 clients' },
  // 12:00
  { id: 'p8', type: 'error', de: 'Morgan', entity: 'Customer', hour: '12:00 — Today', time: '12:18', text: 'GDPR response overdue — escalated to human' },
  { id: 'p9', type: 'resolved', de: 'Morgan', entity: 'Customer', hour: '12:00 — Today', time: '12:04', text: 'Morgan prepared credit note — $12,400 (awaiting approval)' },
  // 11:00
  { id: 'p10', type: 'resolved', de: 'Avery', entity: 'Customer', hour: '11:00 — Today', time: '11:40', text: 'Avery answered specialist query — state tax nexus (from Morgan)', confidence: 90 },
  { id: 'p11', type: 'resolved', de: 'Morgan', entity: 'Customer', hour: '11:00 — Today', time: '11:00', text: 'Morgan completed KYC — new engagement #E-2247' },
  { id: 'p12', type: 'kb_gap', de: 'Morgan', entity: 'Knowledge', hour: '11:00 — Today', time: '11:15', text: 'Gap detected — "KYC documentation for trusts"' },
  // 10:00
  { id: 'p13', type: 'resolved', de: 'Avery', entity: 'Customer', hour: '10:00 — Today', time: '10:30', text: 'Avery filed research summary — IRS Notice 2026-14' },
  { id: 'p14', type: 'config_change', de: 'Human', entity: 'Governance', hour: '10:00 — Today', time: '10:05', text: 'Morgan review-gate threshold raised to 72% — by Risk & Compliance' },
  // 09:00
  { id: 'p15', type: 'resolved', de: 'Morgan', entity: 'Customer', hour: '09:00 — Today', time: '09:44', text: 'Morgan logged client meeting notes — Sterling Trust' },
  { id: 'p16', type: 'escalated', de: 'Morgan', entity: 'Customer', hour: '09:00 — Today', time: '09:12', text: 'Client complaint routed — SLA breach concern, Sterling Trust' },
  // Yesterday
  { id: 'p17', type: 'resolved', de: 'Avery', entity: 'Customer', hour: 'Yesterday', time: '16:20', text: 'Avery delivered memo — R&D credit analysis' },
  { id: 'p18', type: 'resolved', de: 'Morgan', entity: 'Customer', hour: 'Yesterday', time: '16:00', text: 'Morgan sent engagement update — Harbor Financial' },
  { id: 'p19', type: 'escalated', de: 'Morgan', entity: 'Customer', hour: 'Yesterday', time: '14:30', text: 'KYC screening hit — routed to Risk & Compliance' },
  { id: 'p20', type: 'config_change', de: 'Human', entity: 'Governance', hour: 'Yesterday', time: '11:00', text: 'Independence-check reminder rule added — by Quality & Risk' },
  { id: 'p21', type: 'resolved', de: 'Avery', entity: 'Customer', hour: 'Yesterday', time: '10:15', text: 'Avery completed 6 research requests — weekly batch', confidence: 92 },
  { id: 'p22', type: 'resolved', de: 'Morgan', entity: 'Customer', hour: 'Yesterday', time: '09:30', text: 'Morgan sent DocuSign envelope — Sterling Trust advisory letter' },
];

const ACTIVITY: Record<CompanyId, ActivityRow[]> = { tcp: TCP_ACTIVITY, pwc: PWC_ACTIVITY };

// ── Style helpers — extend DashboardPage palettes ─────────────────

function dotColor(type: ActivityType): string {
  if (type === 'resolved') return 'bg-emerald-400';
  if (type === 'escalated') return 'bg-amber-400';
  if (type === 'kb_gap') return 'bg-blue-400';
  if (type === 'config_change') return 'bg-slate-500';
  if (type === 'guardrail_block') return 'bg-red-500';
  return 'bg-red-400';
}

function borderColor(type: ActivityType): string {
  if (type === 'resolved') return 'border-l-emerald-500';
  if (type === 'escalated') return 'border-l-amber-500';
  if (type === 'kb_gap') return 'border-l-blue-500';
  if (type === 'config_change') return 'border-l-slate-500';
  if (type === 'guardrail_block') return 'border-l-red-600';
  return 'border-l-red-500';
}

const TYPE_LABELS: Record<ActivityType, string> = {
  resolved: 'Resolved', escalated: 'Escalated', kb_gap: 'KB Gap',
  error: 'Error', config_change: 'Config Change', guardrail_block: 'Guardrail Block',
};

// ── Page ──────────────────────────────────────────────────────────

export default function ActivityPage({ setPage }: { setPage: (p: Page) => void }) {
  const { activeCompanyId } = useAuth();
  const rows = ACTIVITY[activeCompanyId];

  const [deFilter, setDeFilter] = useState<string>('all');
  const [entityFilter, setEntityFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<ActivityType | 'all'>('all');

  useEffect(() => { setDeFilter('all'); setEntityFilter('all'); setTypeFilter('all'); }, [activeCompanyId]);

  return <ActivityLogNotYetAvailable setPage={setPage} />;

  const des = Array.from(new Set(rows.map(r => r.de)));
  const entities = Array.from(new Set(rows.map(r => r.entity)));

  const visible = rows.filter(r =>
    (deFilter === 'all' || r.de === deFilter) &&
    (entityFilter === 'all' || r.entity === entityFilter) &&
    (typeFilter === 'all' || r.type === typeFilter)
  );

  // Group by hour, preserving seed order
  const hours: { hour: string; items: ActivityRow[] }[] = [];
  visible.forEach(r => {
    const bucket = hours.find(h => h.hour === r.hour);
    if (bucket) bucket.items.push(r);
    else hours.push({ hour: r.hour, items: [r] });
  });

  const linkFor = (r: ActivityRow): { page: Page; label: string } | null => {
    if (r.type === 'kb_gap') return { page: 'knowledge_gaps', label: 'Open in Gap Detection →' };
    if (r.type === 'guardrail_block') return { page: 'gov_audit', label: 'Open in Audit Trail →' };
    if (r.type === 'config_change') return { page: 'gov_audit', label: 'Open in Audit Trail →' };
    return null;
  };

  const selectCls = 'bg-dt-card border border-dt-border rounded-lg px-3 py-1.5 text-xs text-dt-support focus:outline-none focus:border-dt-border-strong';

  return (
    <div className="p-6">
      <PageHeader
        title="Activity Log"
        subtitle={`Org-wide live activity stream — ${rows.length} events across every Digital Employee, entity, and guardrail`}
      />
      <p className="-mt-3 mb-5 text-xs text-dt-muted">
        Operational stream: what your workforce is doing right now. For the immutable compliance record, see the{' '}
        <button onClick={() => setPage('gov_audit')} className="text-indigo-400 hover:text-indigo-300 transition-colors">
          Audit Trail →
        </button>
      </p>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-6 flex-wrap">
        <select value={deFilter} onChange={e => setDeFilter(e.target.value)} className={selectCls}>
          <option value="all">All DEs</option>
          {des.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <select value={entityFilter} onChange={e => setEntityFilter(e.target.value)} className={selectCls}>
          <option value="all">All entities</option>
          {entities.map(en => <option key={en} value={en}>{en}</option>)}
        </select>
        <div className="flex gap-1.5 flex-wrap">
          {(['all', 'resolved', 'escalated', 'kb_gap', 'error', 'config_change', 'guardrail_block'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTypeFilter(t)}
              className={`px-2.5 py-1.5 rounded-full text-[11px] transition-colors ${typeFilter === t ? 'bg-indigo-600 text-white' : 'bg-dt-card border border-dt-border text-dt-support hover:text-dt-body'}`}
            >
              {t === 'all' ? 'All types' : TYPE_LABELS[t]}
            </button>
          ))}
        </div>
        <span className="text-xs text-dt-faint ml-auto">{visible.length} events shown</span>
      </div>

      {/* Timeline grouped by hour */}
      <div className="space-y-6">
        {hours.length === 0 && (
          <div className="text-center py-10 border border-dashed border-dt-border rounded-xl">
            <p className="text-dt-muted text-sm">No activity matches the current filters.</p>
          </div>
        )}
        {hours.map(bucket => (
          <div key={bucket.hour}>
            <div className="flex items-center gap-3 mb-2">
              <span className="text-[10px] font-bold tracking-widest text-dt-muted uppercase whitespace-nowrap">{bucket.hour}</span>
              <div className="flex-1 h-px bg-dt-panel" />
              <span className="text-[10px] text-dt-faint">{bucket.items.length} events</span>
            </div>
            <div className="space-y-1.5 ml-1 pl-4 border-l border-dt-border">
              {bucket.items.map(r => {
                const link = linkFor(r);
                return (
                  <div
                    key={r.id}
                    className={`flex items-start gap-3 px-3 py-2.5 rounded-lg border-l-2 ${borderColor(r.type)} ${r.type === 'guardrail_block' ? 'bg-red-500/5' : 'bg-dt-card'} hover:bg-dt-panel transition-colors`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 ${dotColor(r.type)}`} />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-dt-support leading-tight">{r.text}</div>
                      <div className="flex items-center gap-2 mt-1 text-[10px] text-dt-faint">
                        <span className="font-mono">{r.time}</span>
                        <span className="px-1.5 py-0.5 rounded bg-dt-panel text-dt-muted">{TYPE_LABELS[r.type]}</span>
                        <span>{r.de}</span>
                        <span>· {r.entity}</span>
                        {link && (
                          <button onClick={() => setPage(link.page)} className="text-indigo-400 hover:text-indigo-300 transition-colors ml-1">
                            {link.label}
                          </button>
                        )}
                      </div>
                    </div>
                    {r.confidence !== undefined && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-dt-panel text-dt-support flex-shrink-0">{r.confidence}%</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
