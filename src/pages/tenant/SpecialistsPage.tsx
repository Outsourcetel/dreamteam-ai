import React from 'react';
import { useAuth } from '../../context/AuthContext';
import { PageHeader, th, td } from '../../components/ui';
import SpecialistLive from './SpecialistLive';
import type { Page } from '../../types';
import type { CompanyId } from '../../data/companies';

// ── Types ─────────────────────────────────────────────────────────

export type SpecialistDomain = 'technical' | 'legal' | 'finance_deep' | 'people';

interface Consultation {
  id: string;
  requestingDE: string;
  question: string;
  resolution: string;
  duration: string;
  date: string;
}

interface DomainData {
  title: string;
  icon: string;
  description: string;
  consultations: Consultation[];
  statsMonth: number;
  avgResponse: string;
  topRequester: string;
}

// ── Seed data ─────────────────────────────────────────────────────

const TCP_DOMAINS: Record<SpecialistDomain, DomainData> = {
  technical: {
    title: 'Technical Specialist', icon: '⚙',
    description: 'Deep engineering knowledge — API internals, architecture, and debugging — consulted when a primary DE hits the edge of its technical depth.',
    statsMonth: 14, avgResponse: '2.1 min', topRequester: 'Alex',
    consultations: [
      { id: 'c1', requestingDE: 'Alex', question: 'Webhook signature validation failing intermittently on customer proxy setups — root cause?', resolution: 'Identified clock-skew tolerance issue; workaround (5-min skew window) merged into Alex\'s answer.', duration: '3 min', date: '2026-07-03' },
      { id: 'c2', requestingDE: 'Alex', question: 'Does the bulk-export API support cursor pagination beyond 10K records?', resolution: 'Confirmed keyset pagination path from API internals docs; example query provided.', duration: '1 min', date: '2026-07-02' },
      { id: 'c3', requestingDE: 'Casey', question: 'Customer asking whether SSO migration affects API tokens mid-renewal.', resolution: 'Token invalidation rules retrieved; renewal answer updated with migration checklist.', duration: '2 min', date: '2026-07-01' },
      { id: 'c4', requestingDE: 'Alex', question: 'Rate-limit burst behavior on Enterprise tier after June restructure?', resolution: '2× burst for 60 seconds confirmed from ENG-2380; added to draft KB article.', duration: '1 min', date: '2026-06-30' },
      { id: 'c5', requestingDE: 'Alex', question: 'Is the reported data-loss scenario possible during region failover?', resolution: 'Escalated to human engineering — beyond knowledge-backed confidence floor.', duration: '8 min', date: '2026-06-27' },
    ],
  },
  legal: {
    title: 'Legal Specialist', icon: '§',
    description: 'Contract terms, data-processing agreements, and liability language — consulted before any DE commits the company in writing.',
    statsMonth: 6, avgResponse: '4.8 min', topRequester: 'Casey',
    consultations: [
      { id: 'c1', requestingDE: 'Casey', question: 'Customer requests 24-month term with termination-for-convenience — within standard paper?', resolution: 'Not standard; flagged clause and routed contract to human legal review.', duration: '4 min', date: '2026-07-02' },
      { id: 'c2', requestingDE: 'Alex', question: 'Customer asks if we sign their DPA instead of ours.', resolution: 'Policy retrieved: third-party DPAs require legal review; Alex responded with process and timeline.', duration: '2 min', date: '2026-07-01' },
      { id: 'c3', requestingDE: 'Casey', question: 'Can auto-renewal notice period be shortened to 15 days for one account?', resolution: 'Jurisdiction check passed; 15-day rider template provided with approval gate.', duration: '6 min', date: '2026-06-29' },
      { id: 'c4', requestingDE: 'Riley', question: 'Contractor asking about IP assignment in their agreement.', resolution: 'Standard clause explanation retrieved; sensitive follow-ups routed to human counsel.', duration: '3 min', date: '2026-06-26' },
      { id: 'c5', requestingDE: 'Casey', question: 'Liability cap language for the Harbor Tech renewal amendment.', resolution: 'Standard 12-month-fees cap confirmed; non-standard requests escalate to legal.', duration: '5 min', date: '2026-06-24' },
    ],
  },
  finance_deep: {
    title: 'Finance Specialist', icon: '$',
    description: 'Revenue recognition, tax treatment, and complex billing — consulted for finance questions beyond day-to-day invoicing.',
    statsMonth: 9, avgResponse: '3.5 min', topRequester: 'Casey',
    consultations: [
      { id: 'c1', requestingDE: 'Casey', question: 'How to book a mid-term upgrade with credit for unused portion of annual plan?', resolution: 'Proration and rev-rec schedule retrieved; invoice built with credit memo pattern.', duration: '4 min', date: '2026-07-03' },
      { id: 'c2', requestingDE: 'Casey', question: 'Customer requesting invoice in EUR while contract is USD.', resolution: 'Multi-currency policy gap detected — logged to Knowledge Gaps; interim manual process used.', duration: '7 min', date: '2026-07-01' },
      { id: 'c3', requestingDE: 'Alex', question: 'Customer disputes sales tax on their invoice — exemption certificate claims.', resolution: 'Exemption verification steps retrieved; ticket routed to billing with checklist.', duration: '2 min', date: '2026-06-30' },
      { id: 'c4', requestingDE: 'Casey', question: 'Write-off threshold for a $1,900 disputed overage?', resolution: 'Within Casey\'s $2,500 write-off limit; policy citation attached to the decision log.', duration: '1 min', date: '2026-06-28' },
      { id: 'c5', requestingDE: 'Riley', question: 'Payroll cost-center split for a dual-team hire.', resolution: 'Allocation policy retrieved; HRBP confirmation gate applied.', duration: '3 min', date: '2026-06-25' },
    ],
  },
  people: {
    title: 'People Specialist', icon: '◉',
    description: 'Employment policy edge cases, compensation frameworks, and compliance-sensitive HR questions beyond Riley\'s day-to-day scope.',
    statsMonth: 7, avgResponse: '5.2 min', topRequester: 'Riley',
    consultations: [
      { id: 'c1', requestingDE: 'Riley', question: 'Parental-leave stacking with PTO across a year boundary — allowed?', resolution: 'Policy interaction resolved from handbook §4.2 and §6.1; answer validated by HRBP.', duration: '6 min', date: '2026-07-02' },
      { id: 'c2', requestingDE: 'Riley', question: 'Remote employee relocating to a new state — payroll and policy impact?', resolution: 'State registration checklist retrieved; case routed to HRBP for tax registration.', duration: '8 min', date: '2026-06-30' },
      { id: 'c3', requestingDE: 'Riley', question: 'Can a manager view a direct report\'s full leave history?', resolution: 'Access policy confirmed: summary yes, medical detail no. Answer sent with citation.', duration: '2 min', date: '2026-06-27' },
      { id: 'c4', requestingDE: 'Alex', question: 'Employee asking a benefits question inside a support ticket — where to route?', resolution: 'Cross-entity handoff executed: ticket transferred to Riley with context.', duration: '1 min', date: '2026-06-26' },
      { id: 'c5', requestingDE: 'Riley', question: 'Visa-dependent employee asking about international remote work.', resolution: 'Restricted topic — immigration questions always route to human counsel per guardrail.', duration: '4 min', date: '2026-06-23' },
    ],
  },
};

const PWC_DOMAINS: Record<SpecialistDomain, DomainData> = {
  technical: {
    title: 'Technical Specialist', icon: '⚙',
    description: 'Systems and data questions arising inside engagements — consulted by client-facing DEs when technical depth is needed.',
    statsMonth: 4, avgResponse: '3.0 min', topRequester: 'Morgan',
    consultations: [
      { id: 'c1', requestingDE: 'Morgan', question: 'Client asking about our data-retention architecture for the engagement portal.', resolution: 'Retention schedule and encryption posture retrieved; response approved by IT.', duration: '4 min', date: '2026-07-02' },
      { id: 'c2', requestingDE: 'Avery', question: 'Bulk-extract format from client\'s ERP for workpaper ingestion.', resolution: 'Extract template matched from prior engagement; instructions sent to client.', duration: '2 min', date: '2026-07-01' },
      { id: 'c3', requestingDE: 'Morgan', question: 'Secure file-transfer options for a client without SFTP.', resolution: 'Approved transfer channels listed; SharePoint external-share process applied.', duration: '3 min', date: '2026-06-28' },
      { id: 'c4', requestingDE: 'Morgan', question: 'Client portal SSO integration timeline question.', resolution: 'Standard onboarding steps retrieved; IT consulted for the timeline commitment.', duration: '5 min', date: '2026-06-25' },
      { id: 'c5', requestingDE: 'Avery', question: 'OCR accuracy limits for scanned K-1 ingestion.', resolution: 'Known limitation documented; manual-review threshold added to the workflow.', duration: '2 min', date: '2026-06-23' },
    ],
  },
  legal: {
    title: 'Legal Specialist', icon: '§',
    description: 'Engagement terms, privilege, and regulatory exposure — consulted before client commitments with legal weight.',
    statsMonth: 8, avgResponse: '5.5 min', topRequester: 'Morgan',
    consultations: [
      { id: 'c1', requestingDE: 'Morgan', question: 'Client requests indemnification language beyond standard engagement letter.', resolution: 'Non-standard clause — routed to general counsel with risk summary.', duration: '6 min', date: '2026-07-02' },
      { id: 'c2', requestingDE: 'Morgan', question: 'GDPR data-subject request scope — does it cover engagement workpapers?', resolution: 'Scope rules retrieved; workpapers partially in scope, legal review confirmed.', duration: '8 min', date: '2026-07-01' },
      { id: 'c3', requestingDE: 'Avery', question: 'Is a draft memo privileged if shared with the client\'s external auditor?', resolution: 'Privilege analysis retrieved — waiver risk flagged; partner decision required.', duration: '7 min', date: '2026-06-29' },
      { id: 'c4', requestingDE: 'Morgan', question: 'Subpoena received referencing a former client — response process?', resolution: 'Litigation-hold protocol triggered; escalated to general counsel immediately.', duration: '2 min', date: '2026-06-26' },
      { id: 'c5', requestingDE: 'Morgan', question: 'Non-solicit language in a subcontractor agreement.', resolution: 'Standard clause confirmed within delegation; signed under standard approval.', duration: '4 min', date: '2026-06-24' },
    ],
  },
  finance_deep: {
    title: 'Finance Specialist — Avery', icon: '$',
    description: 'PWC runs a dedicated specialist DE for deep finance and tax work: Avery, the Tax Research DE, is consulted on demand by client-facing DEs.',
    statsMonth: 12, avgResponse: '4.2 min', topRequester: 'Morgan',
    consultations: [
      { id: 'c1', requestingDE: 'Morgan', question: 'Client asking about state tax nexus after opening a remote office.', resolution: 'Avery ran nexus analysis; summary merged into Morgan\'s client response.', duration: '4 min', date: '2026-07-03' },
      { id: 'c2', requestingDE: 'Morgan', question: 'FATCA implications for a dual-national beneficial owner during KYC.', resolution: 'Gap detected — "FATCA filing for dual-nationals" logged; interim answer partner-reviewed.', duration: '9 min', date: '2026-07-01' },
      { id: 'c3', requestingDE: 'Morgan', question: 'R&D credit eligibility question raised in a client status call.', resolution: 'Avery\'s recent memo retrieved and adapted; delivered after partner sign-off.', duration: '3 min', date: '2026-06-30' },
      { id: 'c4', requestingDE: 'Morgan', question: 'Client\'s CFO asking about IRS Notice 2026-14 impact.', resolution: 'Avery\'s filed summary attached with plain-English cover note.', duration: '2 min', date: '2026-06-27' },
      { id: 'c5', requestingDE: 'Morgan', question: 'Transfer-pricing documentation deadline for the new subsidiary.', resolution: 'Deadline table retrieved; engagement team notified with lead time.', duration: '4 min', date: '2026-06-24' },
    ],
  },
  people: {
    title: 'People Specialist', icon: '◉',
    description: 'Partner-track policy, secondment, and HR edge cases — consulted when engagement staffing questions exceed knowledge-backed scope.',
    statsMonth: 3, avgResponse: '6.0 min', topRequester: 'Morgan',
    consultations: [
      { id: 'c1', requestingDE: 'Morgan', question: 'Client requesting a named senior on-site 3 days/week — staffing policy?', resolution: 'Secondment policy retrieved; resourcing request routed to staffing partner.', duration: '5 min', date: '2026-07-01' },
      { id: 'c2', requestingDE: 'Avery', question: 'Independence rules for a staff member whose spouse joined the client.', resolution: 'Independence conflict confirmed — staff rotation initiated per policy.', duration: '8 min', date: '2026-06-27' },
      { id: 'c3', requestingDE: 'Morgan', question: 'Can engagement hours be split across two billing codes for one person?', resolution: 'Time-coding policy retrieved; approved pattern shared with the team.', duration: '3 min', date: '2026-06-24' },
      { id: 'c4', requestingDE: 'Morgan', question: 'Client feedback on a team member — where does it get recorded?', resolution: 'Performance-input process retrieved; feedback routed to engagement manager.', duration: '4 min', date: '2026-06-20' },
      { id: 'c5', requestingDE: 'Avery', question: 'CPE credit eligibility for client-site training delivered.', resolution: 'CPE policy retrieved; documentation checklist provided.', duration: '2 min', date: '2026-06-18' },
    ],
  },
};

const DOMAINS: Record<CompanyId, Record<SpecialistDomain, DomainData>> = { tcp: TCP_DOMAINS, pwc: PWC_DOMAINS };

// ── Page ──────────────────────────────────────────────────────────

export default function SpecialistsPage({ domain, setPage }: { domain: SpecialistDomain; setPage: (p: Page) => void }) {
  const { activeCompanyId } = useAuth();

  // ── LIVE branch (migration 024): Technical is the proven install;
  // other domains reuse the same framework — honest "coming" card.
  if (true) {
    if (domain === 'technical') return <SpecialistLive setPage={setPage} />;
    const names: Record<SpecialistDomain, string> = {
      technical: 'Technical', legal: 'Legal', finance_deep: 'Finance', people: 'People',
    };
    return (
      <div className="p-6">
        <PageHeader
          title={`${names[domain]} Specialist`}
          subtitle="Specialists are consulted on demand by primary DEs — configurable sources, grounded answers, gated write-backs"
        />
        <div className="rounded-2xl border border-dt-border bg-dt-card p-10 text-center max-w-2xl">
          <p className="text-sm text-dt-support font-medium mb-1">Configure coming — install pattern proven on Technical</p>
          <p className="text-xs text-dt-muted mb-4 leading-relaxed">
            The {names[domain]} Specialist reuses the exact framework shipped with the Technical Specialist:
            profile charter, per-source access modes (ingest / fetch-only / reference), media library with quality flags,
            grounded consultations, and the always-gated Scribe. It's configuration, not new machinery.
          </p>
          <button
            onClick={() => setPage('specialist_technical')}
            className="text-sm px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
          >
            Open the Technical Specialist →
          </button>
        </div>
      </div>
    );
  }

  const data = DOMAINS[activeCompanyId][domain];
  const hasDedicatedDE = activeCompanyId === 'pwc' && domain === 'finance_deep';

  const flowSteps = [
    { label: 'Customer DE', sub: 'handling a conversation', color: 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300' },
    { label: 'Detects specialist need', sub: 'confidence below floor on a deep-domain question', color: 'border-amber-500/40 bg-amber-500/10 text-amber-300' },
    { label: hasDedicatedDE ? 'Queries Avery (Specialist DE)' : 'Queries specialist knowledge', sub: hasDedicatedDE ? 'dedicated Tax Research DE' : 'knowledge-backed, no dedicated DE', color: 'border-purple-500/40 bg-purple-500/10 text-purple-300' },
    { label: 'Response merged', sub: 'into the customer conversation, cited', color: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' },
  ];

  return (
    <div className="p-6">
      <PageHeader
        title={`${data.title}`}
        subtitle="Specialist functions work like consultants in the GP/Specialist model — primary DEs consult them on demand instead of every DE carrying deep-domain knowledge"
      />

      {/* Model card: dedicated DE vs knowledge-backed */}
      <div className={`rounded-2xl border p-5 mb-6 ${hasDedicatedDE ? 'border-purple-500/30 bg-purple-500/5' : 'border-dt-border bg-dt-card'}`}>
        {hasDedicatedDE ? (
          <div className="flex items-center gap-4">
            <span className="w-11 h-11 rounded-xl bg-purple-600/20 border border-purple-500/30 flex items-center justify-center text-purple-400 font-semibold text-lg">A</span>
            <div className="flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm font-semibold text-white">Avery</p>
                <span className="text-xs text-dt-support">Tax Research DE</span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-400 font-medium">Specialist</span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400">active</span>
              </div>
              <p className="text-xs text-dt-support mt-1">This domain has a dedicated specialist DE. Avery answers consultations directly, with mandatory partner review before client delivery.</p>
            </div>
            <button onClick={() => setPage('workforce_des')} className="text-xs text-purple-400 hover:text-purple-300 transition-colors flex-shrink-0">Open profile →</button>
          </div>
        ) : (
          <div className="flex items-start gap-4">
            <span className="w-11 h-11 rounded-xl bg-dt-panel border border-dt-border-strong flex items-center justify-center text-dt-support text-lg">{data.icon}</span>
            <div>
              <p className="text-sm font-semibold text-white mb-1">No dedicated DE — knowledge-backed</p>
              <p className="text-xs text-dt-support leading-relaxed">{data.description} Consultations are answered from curated specialist knowledge collections; anything below the confidence floor routes to a human expert.</p>
            </div>
          </div>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        {[
          { label: 'Consultations this month', value: String(data.statsMonth) },
          { label: 'Avg specialist response', value: data.avgResponse },
          { label: 'Top requesting DE', value: data.topRequester },
        ].map(s => (
          <div key={s.label} className="bg-dt-card border border-dt-border rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-wide text-dt-muted mb-1">{s.label}</p>
            <p className="text-xl font-bold text-white">{s.value}</p>
          </div>
        ))}
      </div>

      {/* Consultation flow diagram */}
      <div className="rounded-2xl border border-dt-border bg-dt-card p-5 mb-6">
        <h3 className="text-sm font-semibold text-white mb-4">Consultation flow</h3>
        <div className="flex items-stretch gap-2 flex-wrap">
          {flowSteps.map((s, i) => (
            <React.Fragment key={s.label}>
              <div className={`flex-1 min-w-40 rounded-xl border px-3 py-3 ${s.color}`}>
                <p className="text-xs font-semibold">{s.label}</p>
                <p className="text-[10px] text-dt-support mt-0.5">{s.sub}</p>
              </div>
              {i < flowSteps.length - 1 && <span className="self-center text-dt-faint">→</span>}
            </React.Fragment>
          ))}
        </div>
        <p className="text-[11px] text-dt-muted mt-3">The customer never sees the handoff — the specialist answer is merged into the primary DE's response with full source citation in the audit trail.</p>
      </div>

      {/* Consultation log */}
      <div className="rounded-2xl border border-dt-border bg-dt-card overflow-hidden">
        <div className="px-5 pt-4 pb-2">
          <p className="text-xs font-medium text-dt-muted uppercase tracking-wider">Consultation Log</p>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-dt-inset">
            <tr>
              <th className={th}>Date</th>
              <th className={th}>Requesting DE</th>
              <th className={th}>Question</th>
              <th className={th}>Resolution</th>
              <th className={th}>Duration</th>
            </tr>
          </thead>
          <tbody>
            {data.consultations.map(c => (
              <tr key={c.id} className="border-t border-dt-border hover:bg-dt-panel transition-colors">
                <td className={`${td} text-xs text-dt-muted font-mono whitespace-nowrap`}>{c.date}</td>
                <td className={td}>
                  <button onClick={() => setPage('workforce_des')} className="flex items-center gap-1.5 text-xs text-dt-support hover:text-indigo-300 transition-colors">
                    <span className="w-5 h-5 rounded-full bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 text-[9px] font-semibold">{c.requestingDE[0]}</span>
                    {c.requestingDE}
                  </button>
                </td>
                <td className={`${td} text-xs text-dt-support leading-relaxed`}>{c.question}</td>
                <td className={`${td} text-xs text-dt-support leading-relaxed`}>{c.resolution}</td>
                <td className={`${td} text-xs text-dt-muted whitespace-nowrap`}>{c.duration}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
