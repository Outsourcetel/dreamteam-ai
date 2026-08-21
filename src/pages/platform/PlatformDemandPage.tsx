import React, { useCallback, useEffect, useState } from 'react';
import {
  PageHeaderV2, PanelCard, StatTile, EmptyState, Banner, Button, Chip,
  TableScroll, TH, TD,
} from '../../design/primitives';
import {
  fetchCapabilityDemand, capabilityLabel,
  type CapabilityDemandReport, type DemandFailure, type DemandReadResult, type DemandRow,
} from '../../lib/platformDemandApi';

// ═══════════════════════════════════════════════════════════════════════════
// Platform › Customer Demand
//
// The founder's ask, verbatim (2026-08-15): *"the same flag to us at platform
// level so we know what customer asked for that need our attention to build or
// evaluate."* Migration 744 gave that signal a lifetime; migration 750 gave it
// a reader; this is the screen.
//
// It answers exactly one question: what have customers asked for that we
// cannot staff, and which should we build first.
//
// ── THE EMPTY STATE IS THE HARD PART ──────────────────────────────────────
// `discovery_capability_demand_log` holds ZERO rows today — the review lab was
// cleared on 2026-08-15 and no customer interview has run since. So an empty
// screen is the first thing anybody sees, and it MUST distinguish:
//
//   · the reader refused or broke        → we cannot tell, red notice
//   · the reader ran, history is empty   → and WHY it is empty, anchored
//
// Three structural things make that true rather than intended:
//
//   1. `fetchCapabilityDemand` returns a DISCRIMINATED union keyed on
//      `status` — NOT on `ok`; the rename is the whole subject of
//      platformDemandApi.ts's own note, because the boolean spelling does not
//      narrow under this repo's `"strict": false`. Everything that renders a
//      reassuring sentence lives inside `DemandReportBody`, which takes a
//      `CapabilityDemandReport` and can therefore only be constructed from
//      `status === 'ok'`. The failure arm carries no `report` to hand it.
//      ⚠ AND THE PAGE HOLDS ONE STATE SLOT, not two — see the note on
//      `PlatformDemandPage` below. With `report` and `failure` in separate
//      slots the union guaranteed only that the FETCH RESULT was exclusive;
//      whether the SCREEN was rested on remembering to null the other one.
//   2. The anchors arrive in the SAME object as the list (migration 750
//      returns one jsonb envelope for this reason), so this component cannot
//      hold `demand: []` without also holding how many interviews exist, when
//      the last one ran, and how many catalogue dimensions can produce a
//      demand row at all.
//   3. `gap_dimensions === 0` is called out in RED — and, ⚠ because the banner
//      is not the sentence anyone actually reads, it ALSO swings the empty
//      state's headline and closing line (see `AnchoredEmpty`). If the
//      catalogue names no unstaffed capability, this list can never fill, and
//      "nothing yet" is then a statement about the catalogue rather than about
//      our customers. A screen that cannot report a finding is theatre; this
//      one says so in the headline, not only in a banner above it.
//
// ⚠ The neighbouring Platform › System Health page has the failure this page
// avoids: `fetchPlatformConnectorHealth` returns [] on error, and the page
// renders "No connectors configured by any tenant yet." for a refusal. Named
// here, not fixed — it is a different screen and a different change.
//
// ── ORDER ──────────────────────────────────────────────────────────────────
// The server orders by tenants_surfaced, then sessions, then recency, and the
// table preserves that order rather than re-sorting. Ten sessions from one
// workspace is ONE customer asking ten times. Migration 750's probe 6
// constructs a case where the two orderings disagree and pins this one.
//
// ── NAMING THE WORKSPACE ───────────────────────────────────────────────────
// Workspaces are named on the EVIDENCE DRILL-DOWN and never on the aggregate
// row. The full argument is in migration 750's header; the short version is
// that "Acme: 4" invites an account conversation, while «"nobody chases our
// unpaid invoices" — Acme» invites a product decision, and the founder asked
// for the second one. The boundary that matters — no customer ever sees this —
// is held by the grant and by RLS, not by anonymising a screen that only
// holders of `tenants.manage` can open.
// ═══════════════════════════════════════════════════════════════════════════

const dateOf = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '—';
  return t.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

const dateTimeOf = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '—';
  return t.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** What went wrong, in words a platform operator can act on — with the
 *  server's own sentence kept underneath, never replaced by ours. */
function FailureNotice({ failure, onRetry, retrying }: {
  failure: DemandFailure; onRetry: () => void; retrying: boolean;
}) {
  const headline = failure.kind === 'not_authorised'
    ? 'You are signed in, but this screen needs tenant-management access.'
    : failure.kind === 'not_installed'
      ? 'The demand reader is not installed on this database yet.'
      : 'The demand reader did not answer.';
  const explain = failure.kind === 'not_authorised'
    ? 'Cross-tenant demand is gated on the `tenants.manage` platform capability, which by role default only a platform super-admin carries. Ask for a grant on Team & Permissions rather than working around it.'
    : failure.kind === 'not_installed'
      ? 'Migration 750 creates platform_capability_demand(). Until it is applied here, this screen has nothing to call.'
      : 'This is NOT an empty result. Nothing below should be read as "no customer has asked for anything" — we simply could not find out.';
  return (
    <Banner tone="danger">
      <p className="font-medium">{headline}</p>
      <p className="mt-1 opacity-90">{explain}</p>
      <p className="mt-2 text-xs font-mono opacity-75 break-words">{failure.message}</p>
      <div className="mt-3">
        <Button kind="secondary" size="sm" onClick={onRetry} disabled={retrying}>
          {retrying ? 'Trying again…' : 'Try again'}
        </Button>
      </div>
    </Banner>
  );
}

/** The empty state. Every sentence here is derived from a number the reader
 *  actually returned — there is no wording that would still render if the read
 *  had failed, because this component is unreachable in that case.
 *
 *  ⚠⚠ AND IT MUST NOT ASSERT A FINDING THE SCREEN CANNOT MAKE. `gap_dimensions
 *  === 0` means no interview dimension names an unstaffed capability, so the
 *  log cannot gain a row no matter what any customer says. The vacuity banner
 *  above says exactly that, in red — and the first version of this component
 *  rendered "No customer has asked for something we cannot staff." directly
 *  underneath it, plus a closing line promising "you would be looking at a red
 *  notice instead of this one" while a red notice was on screen. Empty the gap
 *  catalogue and the roadmap screen reported a clean bill of health it
 *  explicitly could not know.
 *
 *  So the headline and the closing line BOTH swing on gap_dimensions. Guarding
 *  the banner and the tile while leaving the sentence a human actually reads
 *  unguarded is the measurement-organ-lies defect wearing the fix's clothes.
 *  Pinned in tests/platform-demand-empty-state.test.ts. */
function AnchoredEmpty({ report }: { report: CapabilityDemandReport }) {
  const { sessions_on_record, latest_session_at, capabilities_watched, gap_dimensions } = report;
  // The screen can only claim "nobody asked" when asking was POSSIBLE.
  const canReportAFinding = gap_dimensions > 0;
  return (
    <EmptyState
      icon="◎"
      headline={canReportAFinding
        ? 'No customer has asked for something we cannot staff.'
        : 'This screen cannot tell you whether a customer has asked for anything.'}
    >
      {!canReportAFinding ? (
        <p>
          The reader ran and returned an empty history, but{' '}
          <strong className="text-dt-body">
            no interview dimension currently names a capability we cannot staff
          </strong>{' '}
          — so no interview could have produced a row here, whatever any customer said. The
          emptiness below is a fact about the catalogue, not about our customers, and nothing on
          this screen should be read as “nobody asked”. Restore the gap catalogue before treating
          this as an answer.
        </p>
      ) : sessions_on_record === 0 ? (
        <p>
          The reader ran and the history is empty — and so is the interview log:{' '}
          <strong className="text-dt-body">no discovery interview exists on record in any workspace</strong>.
          Nothing has been asked, so nothing could be found. This is not a clean bill of health;
          it is an absence of evidence.
        </p>
      ) : (
        <p>
          The reader ran and returned an empty history.{' '}
          <strong className="text-dt-body">
            {sessions_on_record} discovery {plural(sessions_on_record, 'interview is', 'interviews are')} on record
          </strong>{' '}
          across all workspaces, the most recent on {dateOf(latest_session_at)} — and none of them
          surfaced a need this product cannot staff.
        </p>
      )}
      <p className="mt-2">
        Watching {capabilities_watched.length}{' '}
        {plural(capabilities_watched.length, 'capability', 'capabilities')} across {gap_dimensions}{' '}
        interview {plural(gap_dimensions, 'dimension', 'dimensions')}:{' '}
        <span className="font-mono">{capabilities_watched.join(', ') || 'none'}</span>.
      </p>
      <p className="mt-2 opacity-80">
        {canReportAFinding
          ? 'If this read had failed or been refused you would be looking at a red notice instead of this one — an empty list here means the query ran.'
          : 'The read itself succeeded — this is not a failure notice. The red notice above is about what this screen is able to measure, not about whether it ran.'}
      </p>
    </EmptyState>
  );
}

/** One capability, with its evidence folded away until asked for. */
function DemandRowBlock({ row, open, onToggle }: {
  row: DemandRow; open: boolean; onToggle: () => void;
}) {
  const silent = Math.max(0, row.sessions_surfaced - row.evidence_total);
  return (
    <>
      <tr className="border-t border-dt-border align-top">
        <td className={TD}>
          <div className="font-medium text-dt-title">{capabilityLabel(row.capability)}</div>
          <div className="text-xs text-dt-muted font-mono">{row.capability}</div>
        </td>
        <td className={TD}>
          <div className="text-dt-body">{row.dimension_title || '—'}</div>
          <div className="text-xs text-dt-muted font-mono">{row.dimension_key}</div>
        </td>
        <td className={TD}>
          <Chip tone={row.tenants_surfaced > 1 ? 'warn' : 'neutral'}>
            {row.tenants_surfaced} {plural(row.tenants_surfaced, 'workspace', 'workspaces')}
          </Chip>
        </td>
        <td className={`${TD} text-dt-support`}>{row.sessions_surfaced}</td>
        <td className={`${TD} text-dt-support whitespace-nowrap`}>{dateOf(row.first_surfaced_at)}</td>
        <td className={`${TD} text-dt-support whitespace-nowrap`}>{dateOf(row.last_surfaced_at)}</td>
        <td className={TD}>
          <Button kind="ghost" size="sm" onClick={onToggle}>
            {open ? 'Hide what they said' : `What they said (${row.evidence_total})`}
          </Button>
        </td>
      </tr>
      {open && (
        <tr className="bg-dt-panel">
          <td className={TD} colSpan={7}>
            {row.evidence.length === 0 ? (
              <p className="text-xs text-dt-support py-2">
                No workspace recorded a sentence for this one.{' '}
                {row.sessions_surfaced} {plural(row.sessions_surfaced, 'session', 'sessions')} marked
                the dimension heard without quotable evidence, so there is a count here and nothing
                to read. That is a gap in the interview, not in this screen.
              </p>
            ) : (
              <div className="space-y-2 py-1">
                {row.evidence.map((e, i) => (
                  <blockquote
                    key={`${e.surfaced_at}-${i}`}
                    className="border-l-2 border-dt-accent-border pl-3 py-1"
                  >
                    <p className="text-sm text-dt-body">“{e.evidence}”</p>
                    <p className="text-xs text-dt-muted mt-0.5">
                      {e.tenant_label} · {dateTimeOf(e.surfaced_at)}
                    </p>
                  </blockquote>
                ))}
                {row.evidence_shown < row.evidence_total && (
                  <p className="text-xs text-dt-muted">
                    Showing the {row.evidence_shown} most recent of {row.evidence_total} recorded
                    {' '}{plural(row.evidence_total, 'sentence', 'sentences')}.
                  </p>
                )}
                {silent > 0 && (
                  <p className="text-xs text-dt-muted">
                    A further {silent} {plural(silent, 'session', 'sessions')} raised this without
                    recording anything quotable.
                  </p>
                )}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

/** The whole answer, rendered. Reachable ONLY from the `status: 'ok'` arm —
 *  it takes a `CapabilityDemandReport` and there is no other way to obtain
 *  one, because `fetchCapabilityDemand`'s failure arm does not carry the
 *  field. That is what makes structural property #1 a type and not a habit. */
function DemandReportBody({ report, loading, onReload }: {
  report: CapabilityDemandReport; loading: boolean; onReload: () => void;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  return (
    <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatTile
              label="Capabilities asked for"
              value={String(report.demand.length)}
              sub="Distinct unstaffed capabilities raised"
              tone={report.demand.length > 0 ? 'warn' : 'neutral'}
            />
            <StatTile
              label="Recorded demand"
              value={String(report.log_rows)}
              sub={`${plural(report.log_rows, 'row', 'rows')} in the append-only log`}
            />
            <StatTile
              label="Interviews on record"
              value={String(report.sessions_on_record)}
              sub={report.latest_session_at ? `Most recent ${dateOf(report.latest_session_at)}` : 'None have run'}
            />
            <StatTile
              label="Capabilities watched"
              value={String(report.capabilities_watched.length)}
              sub={`Across ${report.gap_dimensions} interview ${plural(report.gap_dimensions, 'dimension', 'dimensions')}`}
              tone={report.gap_dimensions === 0 ? 'danger' : 'neutral'}
            />
          </div>

          {/* ⚠ THE VACUITY BANNER. If no dimension names an unstaffed
              capability, nothing can ever reach the log and an empty screen is
              guaranteed regardless of what customers want. Saying "no demand
              yet" under that condition would be a measurement organ reporting
              on itself. */}
          {report.gap_dimensions === 0 && (
            <Banner tone="danger">
              <p className="font-medium">This screen cannot report a finding right now.</p>
              <p className="mt-1 opacity-90">
                No interview dimension currently names a capability we cannot staff, so no interview
                can produce a demand row and this list can never fill. An empty result below would be
                a statement about the catalogue, not about our customers.
              </p>
            </Banner>
          )}

          {/* An impossible pair: history exists, aggregate does not. */}
          {report.log_rows > 0 && report.demand.length === 0 && (
            <Banner tone="danger">
              <p className="font-medium">
                The log holds {report.log_rows} {plural(report.log_rows, 'row', 'rows')} and the
                aggregate returned none.
              </p>
              <p className="mt-1 opacity-90">
                These two cannot both be right. Do not read the empty list below as an answer —
                discovery_capability_demand is not reporting what discovery_capability_demand_log
                contains.
              </p>
            </Banner>
          )}

          <PanelCard
            title="What to build next"
            badge={
              report.demand.length > 0
                ? <Chip tone="warn">{report.demand.length} {plural(report.demand.length, 'capability', 'capabilities')}</Chip>
                : undefined
            }
            actions={
              <Button kind="ghost" size="sm" onClick={onReload} disabled={loading}>
                {loading ? 'Refreshing…' : 'Refresh'}
              </Button>
            }
          >
            {report.demand.length === 0 ? (
              <AnchoredEmpty report={report} />
            ) : (
              <>
                <TableScroll>
                  <table className="w-full">
                    <thead>
                      <tr>
                        <th className={TH}>Capability</th>
                        <th className={TH}>Where it came up</th>
                        <th className={TH}>Workspaces</th>
                        <th className={TH}>Sessions</th>
                        <th className={TH}>First asked</th>
                        <th className={TH}>Last asked</th>
                        <th className={TH}>Evidence</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.demand.map((row) => {
                        // ⚠ dimension_title IS PART OF THE IDENTITY, because it
                        // is part of the aggregate's GRAIN. 744 snapshots the
                        // title onto each log row so a demand row survives the
                        // dimension being renamed, and its view groups on all
                        // three columns — so one capability legitimately holds
                        // one row per title it has ever carried. Keyed on two
                        // columns those rows collide: React sees a duplicate
                        // key, and `openKey` opens BOTH drill-downs at once
                        // because the comparison below cannot tell them apart.
                        const key = `${row.capability}::${row.dimension_key}::${row.dimension_title}`;
                        return (
                          <DemandRowBlock
                            key={key}
                            row={row}
                            open={openKey === key}
                            onToggle={() => setOpenKey(openKey === key ? null : key)}
                          />
                        );
                      })}
                    </tbody>
                  </table>
                </TableScroll>
                <p className="text-xs text-dt-muted mt-3">
                  Ordered by how many workspaces raised it, not by how many sessions did — ten
                  sessions from one workspace is one customer asking ten times. Read as of{' '}
                  {dateTimeOf(report.generated_at)}.
                </p>
              </>
            )}
          </PanelCard>

          <p className="text-xs text-dt-muted">
            Rows are appended when an interview marks a dimension “heard” that names a capability
            this product does not staff. They carry no foreign keys on purpose, so a workspace’s
            stated need outlives the session, the dimension and the workspace itself — a customer
            who left is exactly the one whose unmet need is worth knowing about.
          </p>
    </>
  );
}

const PlatformDemandPage = () => {
  // ⚠⚠ ONE STATE SLOT, HOLDING THE WHOLE DISCRIMINATED RESULT — and that is
  // what makes structural property #1 above true rather than aspirational.
  //
  // The first version kept `report` and `failure` in two INDEPENDENT useState
  // slots. The union then guaranteed only that `res.report` is unreadable on
  // the failure arm; whether the SCREEN could show a stale report beside a
  // fresh error rested on one line — `setReport(null)` in the failure branch.
  // Delete that line and the red notice renders directly above "No customer
  // has asked for something we cannot staff.", which is precisely the sentence
  // this whole module exists to stop. A guarantee that survives only while
  // nobody edits a particular statement is a convention.
  //
  // Holding the result itself makes the two states genuinely exclusive: there
  // is no assignment that can produce both, because there is no `both` to
  // assign. `DemandReportBody` cannot be constructed without a
  // CapabilityDemandReport, and the failure arm has none to give it.
  const [result, setResult] = useState<DemandReadResult | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setResult(await fetchCapabilityDemand());
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="p-6 space-y-6">
      <PageHeaderV2
        title="Customer Demand"
        subtitle="What customers asked for during their setup interview that this product cannot staff today — every workspace, pooled. The aggregate says what to prioritise; the evidence says what to build."
      />

      {loading && result === null && (
        <p className="text-sm text-dt-muted">Reading the demand log…</p>
      )}

      {result && result.status === 'failed' && (
        <FailureNotice failure={result.failure} onRetry={() => void load()} retrying={loading} />
      )}

      {result && result.status === 'ok' && (
        <DemandReportBody report={result.report} loading={loading} onReload={() => void load()} />
      )}
    </div>
  );
};

export default PlatformDemandPage;
