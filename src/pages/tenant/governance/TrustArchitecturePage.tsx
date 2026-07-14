import React, { useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { PageHeader, th, td } from '../../../components/ui'

// ═══════════════════════════════════════════════════════════════
// GOVERNANCE — Trust & Architecture (gov_trust)
// The security-review starting point. Everything on this page is
// TRUE of the current system, three-state labeled:
//   Live      — verified in production (traceable to a migration /
//               edge function)
//   Designed  — spec/mechanism exists, hardening pending
//   Roadmap   — planned, not built
// Canonical document: docs/TRUST-AND-ARCHITECTURE.md
// Same content in demo and live mode — it describes the platform.
// ═══════════════════════════════════════════════════════════════

type Status = 'live' | 'live_pending' | 'designed' | 'roadmap'

const STATUS_META: Record<Status, { label: string; cls: string }> = {
  live: { label: 'Live', cls: 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30' },
  live_pending: { label: 'Live (pending activation)', cls: 'bg-emerald-500/10 text-emerald-300/90 border border-emerald-500/25' },
  designed: { label: 'Designed', cls: 'bg-indigo-500/15 text-indigo-300 border border-indigo-500/30' },
  roadmap: { label: 'Roadmap', cls: 'bg-slate-600/40 text-slate-400 border border-slate-600' },
}

function Chip({ status }: { status: Status }) {
  const m = STATUS_META[status]
  return <span className={`text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap ${m.cls}`}>{m.label}</span>
}

function Card({ title, status, children }: { title: string; status?: Status; children: React.ReactNode }) {
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
      <div className="flex items-center justify-between gap-3 mb-3">
        <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">{title}</p>
        {status && <Chip status={status} />}
      </div>
      {children}
    </div>
  )
}

function Row({ label, status, children }: { label: string; status: Status; children: React.ReactNode }) {
  return (
    <div className="bg-slate-900 rounded-lg px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-slate-200 font-medium">{label}</span>
        <Chip status={status} />
      </div>
      <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">{children}</p>
    </div>
  )
}

// ── Layer diagram (pure divs) ──
function LayerBox({ title, sub, tone }: { title: string; sub: string; tone: 'front' | 'core' | 'ext' }) {
  const tones = {
    front: 'border-slate-600 bg-slate-800',
    core: 'border-indigo-500/40 bg-indigo-500/5',
    ext: 'border-slate-600 bg-slate-900',
  }
  return (
    <div className={`rounded-xl border px-4 py-3 ${tones[tone]}`}>
      <p className="text-xs font-semibold text-slate-200">{title}</p>
      <p className="text-[11px] text-slate-500 mt-0.5 leading-relaxed">{sub}</p>
    </div>
  )
}

const Arrow = ({ label }: { label: string }) => (
  <div className="flex flex-col items-center py-1">
    <span className="text-[10px] text-slate-600">{label}</span>
    <span className="text-slate-600 leading-none">↓</span>
  </div>
)

// ── Data-flow walkthrough ──
const FLOW_STEPS: { title: string; body: string }[] = [
  { title: 'Browser sends', body: 'The question text plus the caller’s Supabase JWT (or a publishable widget key on the public widget). Nothing else leaves the browser.' },
  { title: 'Edge function scopes', body: 'de-answer verifies the JWT, resolves the caller’s tenant from their profile, and retrieves ONLY that tenant’s knowledge (vector-first via a tenant-guarded RPC, keyword fallback). The semantic answer cache is checked first — a hit never calls the model.' },
  { title: 'Sent to Anthropic', body: 'The retrieved knowledge chunks (~6K char cap), the tenant name, and the question — inside a grounded-only prompt requiring cited sources and a confidence score. No credentials, no customer records, no cross-tenant data.' },
  { title: 'Anthropic retains', body: 'Per Anthropic’s commercial API terms, API inputs and outputs are not used to train models. Anthropic is listed as a subprocessor below.' },
  { title: 'After the answer', body: 'Guardrail check on the answer text; confidence < 60 or model-requested escalation creates a real Human Task; the conversation persists in the tenant’s rows; a hash-chained audit event is appended.' },
]

const SUBPROCESSORS: [string, string, string][] = [
  ['Supabase (US region)', 'Auth, Postgres, edge functions, secrets', 'All tenant data'],
  ['Vercel', 'Static frontend hosting', 'No tenant data at rest'],
  ['Anthropic', 'LLM inference (commercial API — not used for training)', 'Retrieved knowledge chunks + question, per request'],
  ['GitHub', 'Source code hosting', 'No tenant data'],
]

const LIMITATIONS: [string, string, string][] = [
  ['Widget rate limiting', 'Per-isolate in-memory window (100/min/key) — resets on cold start', 'Shared counter before real volume'],
  ['Connector secret encryption', 'Service-role-only table; no client access path', 'Vault/KMS envelope encryption'],
  ['Guardrail answer check', 'Case-insensitive pattern matching (v1)', 'LLM-judge check after activation economics'],
  ['Eval publish gate', 'Client-side, soft — override is audited', 'Server-side hard gate in the ingest path'],
  ['Penetration test', 'Not yet performed', 'Before first tenant at real production volume'],
  ['SOC 2', 'Not started', 'Roadmap — the audit chain and this page are the groundwork'],
  ['RBAC enforcement', 'Roles exist; permission matrix not enforced server-side', 'Per-role policy enforcement'],
  ['SSO / SAML, SCIM', 'Not built', 'Enterprise tier trigger'],
  ['LLM activation', 'Pipeline deployed dormant (no ANTHROPIC_API_KEY set)', 'R1 activation + full end-to-end re-test'],
]

// Plain-text export for the "Copy as text" button.
const DOC_TEXT = `DreamTeam AI — Trust & Architecture (summary)
Canonical document: docs/TRUST-AND-ARCHITECTURE.md
Labels: Live = verified in production. Designed = spec exists, hardening pending. Roadmap = planned, not built.

ARCHITECTURE
Browser SPA (Vercel) → Supabase (Auth, Postgres with RLS, Edge Functions) → Anthropic API (server-side only) / tenant systems of record via connectors. The frontend never talks to Anthropic or SoRs directly.

DATA FLOW FOR ONE QUESTION
1) Browser sends question + Supabase JWT (or widget key). 2) Edge function verifies JWT, resolves tenant, retrieves only that tenant's knowledge; semantic cache checked first. 3) Sent to Anthropic: retrieved knowledge chunks (~6K cap) + tenant name + question, grounded-only prompt. 4) Per Anthropic commercial API terms, inputs/outputs are not used for training. 5) Guardrail check, confidence <60 escalates to a Human Task, conversation persisted, hash-chained audit event appended.
Activation state: the LLM step is deployed but dormant until the ANTHROPIC_API_KEY secret is set — label Live (pending activation).

TENANT ISOLATION — Live
RLS on every tenant table (tenant_id via profiles lookup, migrations 011–019). SECURITY DEFINER RPCs re-check tenant membership. Service role exists only inside edge functions. End users are traffic, not seats.

DATA MODES & SoR PRINCIPLE
Sync mode = keyed working cache (Live, Zendesk v1). Read-through = fetched at action time, nothing persisted except the audit event (Live). Write-back = actions land back in the SoR, gated + audited (Live to the credential boundary). Credentials: connector_secrets has zero authenticated policies, writes only via SECURITY DEFINER RPCs (Live). Vault/KMS envelope encryption: Designed. Per-DE credential scoping: Roadmap.

AUDIT INTEGRITY — Live
audit_events is INSERT-only: no update/delete policies plus a trigger raising on UPDATE/DELETE, verified against a direct superuser attempt. sha256 hash chain computed in append_audit_event under a per-tenant advisory lock. verify_audit_chain recomputes the chain server-side.

AI SAFETY CONTROLS
Grounded-only answering, confidence + escalation, guardrail answer checks (pattern v1): Live (pending activation). Invoice-threshold guardrails: Live and active now. Proving Ground eval suites with soft, audited publish gate: Live (pending activation). Trust dial (autonomy narrows within guardrails, never overrides them): Live in the invoice/playbook path; answer-confidence floors Designed until activation. Server-side playbook executor with immutable published definitions: Live.

IDENTITY & ACCESS
Supabase Auth seats + tenant mapping: Live. RBAC matrix / session policy / IP allowlist UI: design-preview, not enforced server-side. SSO/SAML + SCIM: Roadmap. Widget keys sha256-hashed at rest, plaintext shown once: Live. Signed tenant-issued end-user JWTs: Roadmap.

SUBPROCESSORS
Supabase (US) — all tenant data. Vercel — no tenant data at rest. Anthropic — knowledge chunks + question per request. GitHub — no tenant data. Residency: single US region v1; region selection Roadmap.

KNOWN LIMITATIONS (stated deliberately)
In-memory widget rate limiting; connector secrets pending Vault/KMS; pattern-match guardrails; client-side soft eval gate; no pen test yet; no SOC 2 yet; RBAC not enforced server-side; SSO/SCIM not built; LLM pipeline dormant until key. Real customer data is supported only in the live, RLS-backed production track — never in demo surfaces.`

export default function TrustArchitecturePage() {
  const { handleSetPage } = useAuth()
  const [copied, setCopied] = useState(false)

  const copyDoc = async () => {
    try {
      await navigator.clipboard.writeText(DOC_TEXT)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* clipboard unavailable */ }
  }

  return (
    <div className="flex-1 overflow-auto bg-slate-900 p-6">
      <div className="flex items-start justify-between gap-4">
        <PageHeader
          title="Trust & Architecture"
          subtitle="How DreamTeam is built, what data goes where, and what we haven't done yet — honestly labeled"
        />
        <button onClick={copyDoc}
          className="flex-shrink-0 text-xs px-3 py-1.5 rounded-lg bg-slate-700 border border-slate-600 text-slate-300 hover:bg-slate-600 transition-colors">
          {copied ? '✓ Copied' : 'Copy as text'}
        </button>
      </div>

      {/* Labeling legend */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 mb-6 flex flex-wrap items-center gap-x-5 gap-y-2">
        <span className="text-[11px] text-slate-500">Every claim on this page is labeled:</span>
        <span className="flex items-center gap-1.5"><Chip status="live" /><span className="text-[11px] text-slate-400">verified in production</span></span>
        <span className="flex items-center gap-1.5"><Chip status="designed" /><span className="text-[11px] text-slate-400">spec exists, hardening pending</span></span>
        <span className="flex items-center gap-1.5"><Chip status="roadmap" /><span className="text-[11px] text-slate-400">planned, not built</span></span>
        <span className="text-[11px] text-slate-600">Canonical document: docs/TRUST-AND-ARCHITECTURE.md</span>
      </div>

      <div className="space-y-6">
        {/* ── Layer diagram ── */}
        <Card title="Architecture overview">
          <div className="max-w-2xl mx-auto">
            <LayerBox tone="front" title="Browser — React SPA"
              sub="Tenant console + embeddable end-user widget. Holds only the anon key and the user's JWT — never the service role, never an LLM key, never SoR credentials." />
            <Arrow label="HTTPS · Supabase JWT / publishable widget key" />
            <LayerBox tone="core" title="Supabase — Auth · Postgres (RLS) · Edge Functions"
              sub="Row-level security on every tenant table; SECURITY DEFINER RPCs with membership guards; edge functions (de-answer, widget-ask, playbook-execute, connector-zendesk, eval-run) hold the service role and all secrets." />
            <div className="grid grid-cols-2 gap-3 mt-1">
              <div>
                <Arrow label="HTTPS · server-held API key" />
                <LayerBox tone="ext" title="Anthropic API" sub="Receives retrieved knowledge chunks + the question, per request. Commercial API — inputs/outputs not used for training." />
              </div>
              <div>
                <Arrow label="HTTPS · tenant credentials (server-side)" />
                <LayerBox tone="ext" title="Tenant systems of record" sub="Zendesk connector v1: sync, read-through, and gated write-back. DreamTeam never replaces a system of record." />
              </div>
            </div>
          </div>
        </Card>

        {/* ── Data flow walkthrough ── */}
        <Card title="Data flow — one question, end to end" status="live_pending">
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
            {FLOW_STEPS.map((s, i) => (
              <div key={s.title} className="bg-slate-900 rounded-lg p-3 border border-slate-700/60">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="w-5 h-5 rounded-full bg-indigo-500/20 text-indigo-300 flex items-center justify-center text-[10px] font-bold">{i + 1}</span>
                  <p className="text-[11px] font-semibold text-slate-200">{s.title}</p>
                </div>
                <p className="text-[11px] text-slate-400 leading-relaxed">{s.body}</p>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-slate-500 mt-3">
            Honest activation state: the pipeline is deployed but the LLM step is dormant until the ANTHROPIC_API_KEY edge secret is set — it returns an explicit
            "not configured" state instead of an answer. Auth, tenant scoping, retrieval, cache, guardrail machinery, and audit run today.
          </p>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* ── Tenant isolation ── */}
          <Card title="Tenant isolation" status="live">
            <div className="space-y-2">
              <Row label="Row-level security on every tenant table" status="live">
                Every live table carries a policy scoping reads and writes to <code className="text-slate-300">tenant_id in (select tenant_id from profiles where user_id = auth.uid())</code> — migrations 011–019.
              </Row>
              <Row label="Membership-guarded RPCs" status="live">
                SECURITY DEFINER functions (append_audit_event, verify_audit_chain, set_connector_secret, resume_playbook_on_task) re-check tenant membership before acting, or require the service role.
              </Row>
              <Row label="Service role only in edge functions" status="live">
                The browser never holds the service role. Edge functions resolve the tenant from the caller's JWT and scope every query to it.
              </Row>
              <Row label="End users are traffic, not seats" status="live">
                A tenant's customers never get auth accounts — they reach the DE only through the keyed widget surface.
              </Row>
            </div>
          </Card>

          {/* ── Audit integrity ── */}
          <Card title="Audit integrity" status="live">
            <div className="space-y-2">
              <Row label="INSERT-only, even for superuser" status="live">
                No UPDATE/DELETE policies exist on audit_events, and a trigger raises an exception on any UPDATE or DELETE — verified against a direct superuser attempt (migration 015).
              </Row>
              <Row label="sha256 hash chain" status="live">
                hash = sha256(prev_hash ‖ tenant ‖ action ‖ detail ‖ created_at), computed inside the append RPC under a per-tenant advisory lock.
              </Row>
              <Row label="Server-side chain verification" status="live">
                verify_audit_chain recomputes the whole chain in the database and reports the first broken link — the "Verify chain" button on Audit Trail.
              </Row>
              <Row label="Writers across the platform" status="live">
                Invoices, approvals, guardrail changes and blocks, DE resolutions/escalations, every playbook step, connector syncs/actions, eval runs, trust-dial changes.
              </Row>
            </div>
          </Card>
        </div>

        {/* ── Data modes & SoR ── */}
        <Card title="Data modes & the Systems-of-Record principle">
          <p className="text-[11px] text-slate-400 mb-3 leading-relaxed">
            DreamTeam never replaces a system of record — Zendesk stays the ticket SoR, billing stays the billing SoR. DreamTeam is the work layer on top; our
            permanent, proprietary data is the judgment layer (audit chain, playbook runs, guardrail decisions, approvals).
          </p>
          <div className="space-y-2">
            <Row label="Sync mode (ingest)" status="live">
              A keyed working cache (support_tickets with source + external_ref, unique per tenant+source+ref), refreshed incrementally. Zendesk connector v1.
            </Row>
            <Row label="Read-through mode (pass-through)" status="live">
              Fetched from the SoR at action time, returned, and nothing persisted except the audit event.
            </Row>
            <Row label="Write-back into the SoR" status="live">
              Internal note + status update land back in Zendesk, gated by a per-connector action registry and audited. Verified to the credential boundary; full end-to-end proof awaits a real Zendesk workspace.
            </Row>
            <Row label="Credential storage — zero client access" status="live">
              connector_secrets has RLS enabled with no authenticated policies: tenant JWTs can neither read nor write it. Writes only via SECURITY DEFINER RPCs; reads only server-side.
            </Row>
            <Row label="Vault/KMS envelope encryption of stored secrets" status="designed">
              The named hardening step for the credential table.
            </Row>
            <Row label="Per-DE credential scoping" status="roadmap">
              Credentials scoped per Digital Employee per system.
            </Row>
          </div>
        </Card>

        {/* ── AI safety ── */}
        <Card title="AI safety controls">
          <div className="space-y-2">
            <Row label="Grounded-only answering" status="live_pending">
              The DE answers exclusively from the tenant's own knowledge documents; the prompt forbids invention and requires cited source titles + a confidence score.
            </Row>
            <Row label="Confidence scoring + escalation" status="live_pending">
              Confidence below 60 (or a model-requested escalation) creates a real Human Task instead of letting the answer stand alone.
            </Row>
            <Row label="Guardrail answer checks" status="live_pending">
              Blocking rules are checked against every generated answer in both the console and widget paths; matches are withheld, escalated, and audited. Honest scope: v1 is case-insensitive pattern matching, not an LLM judge.
            </Row>
            <Row label="Guardrails in the non-LLM path" status="live">
              Invoice approval thresholds (require_approval_over_cents) are enforced today in invoice generation and the playbook executor, with a guardrail_check audit event either way.
            </Row>
            <Row label="Eval suites gate knowledge publishing" status="live_pending">
              Proving Ground golden Q&A suites run against the real deployed DE. Honest scope: the publish gate is client-side and soft — overrides are allowed and audited; the server-side hard gate is the named hardening step.
            </Row>
            <Row label="Trust dial — autonomy narrows within guardrails" status="live">
              Per-tenant, per-action autonomy that never overrides a guardrail: an invoice auto-sends only when it passes BOTH the guardrail threshold AND the dial's limit. Answer-confidence floors are stored and configurable now, wired to the answer path at activation.
            </Row>
            <Row label="Server-authoritative playbooks" status="live">
              All orchestration (steps, gates, resume) runs server-side; published playbook definitions are validated server-side and snapshotted immutably — runs never execute a live draft.
            </Row>
          </div>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* ── Identity & access ── */}
          <Card title="Identity & access">
            <div className="space-y-2">
              <Row label="Tenant seats — Supabase Auth" status="live">
                Email/password auth with per-user tenant mapping (profiles). Roles: owner / admin / manager / user.
              </Row>
              <Row label="RBAC matrix, session policy, IP allowlist" status="designed">
                Surfaced on Security &amp; Access; honest note: currently design-preview (demo data, local persistence), not enforced server-side.
              </Row>
              <Row label="Widget keys hashed at rest" status="live">
                Publishable keys stored as sha256 hashes only — plaintext shown once at generation, never stored (migration 014).
              </Row>
              <Row label="Signed tenant-issued end-user JWTs" status="roadmap">
                The tenant's backend signs; our edge verifies against their registered public key. Trigger: first embedded pilot.
              </Row>
              <Row label="SSO / SAML + SCIM" status="roadmap">
                Enterprise tier trigger.
              </Row>
            </div>
            <button onClick={() => handleSetPage('gov_security')}
              className="mt-3 text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
              View Security &amp; Access →
            </button>
          </Card>

          {/* ── Subprocessors ── */}
          <Card title="Subprocessors & data residency">
            <div className="overflow-x-auto -mx-5">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700">
                    <th className={th}>Subprocessor</th>
                    <th className={th}>Role</th>
                    <th className={th}>Data touched</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700/50">
                  {SUBPROCESSORS.map(([name, role, data]) => (
                    <tr key={name}>
                      <td className={`${td} text-slate-200 text-xs font-medium`}>{name}</td>
                      <td className={`${td} text-slate-400 text-xs`}>{role}</td>
                      <td className={`${td} text-slate-400 text-xs`}>{data}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex items-center justify-between gap-3">
              <p className="text-[11px] text-slate-500">Data residency: single US region in v1.</p>
              <Chip status="roadmap" />
            </div>
            <p className="text-[11px] text-slate-600 mt-1">Region selection is Roadmap.</p>
          </Card>
        </div>

        {/* ── Known limitations (the trust-builder) ── */}
        <div className="bg-amber-500/5 border border-amber-500/30 rounded-xl p-5">
          <div className="flex items-center justify-between gap-3 mb-2">
            <p className="text-xs font-medium text-amber-300 uppercase tracking-wider">What we haven't done yet — and when</p>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30">Stated deliberately</span>
          </div>
          <p className="text-[11px] text-slate-400 mb-3 leading-relaxed">
            A reviewer should hear these from us first. Each gap has a named hardening step; none is hidden behind marketing language.
          </p>
          <div className="overflow-x-auto -mx-5">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-amber-500/20">
                  <th className={th}>Gap</th>
                  <th className={th}>Current state</th>
                  <th className={th}>Hardening step</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-amber-500/10">
                {LIMITATIONS.map(([gap, state, step]) => (
                  <tr key={gap}>
                    <td className={`${td} text-slate-200 text-xs font-medium`}>{gap}</td>
                    <td className={`${td} text-slate-400 text-xs`}>{state}</td>
                    <td className={`${td} text-slate-400 text-xs`}>{step}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-slate-500 mt-3">
            Standing rule: real customer data is supported only in the live, RLS-backed production track described above — never in demo surfaces.
          </p>
        </div>

        {/* Cross-links */}
        <div className="flex flex-wrap gap-4 pb-2">
          <button onClick={() => handleSetPage('gov_audit')} className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">Audit Trail (verify the chain live) →</button>
          <button onClick={() => handleSetPage('gov_compliance')} className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">Compliance &amp; Guardrails →</button>
          <button onClick={() => handleSetPage('systems_connectors')} className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">Connectors →</button>
        </div>
      </div>
    </div>
  )
}
