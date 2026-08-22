/**
 * DataExportPanel — "give me my data", and an honest account of what you got.
 *
 * WHY: an independent readiness audit scored ENTERPRISE READINESS 27/100, and
 * one of the named holes was that a customer cannot export their data. The only
 * thing in the database that looked like an export, export_tenant_config(uuid),
 * returns (metrics, schemas, configs) — no customer rows at all — and is
 * referenced nowhere in src/. So this panel is the first place in the product
 * where "export my data" means the customer's data.
 *
 * THE ONE DESIGN RULE HERE: the manifest is the product, not a footnote.
 * 216 of the 257 public tables carry a tenant_id, so any export is a judgement
 * about which of those to include — and a customer who leaves this screen not
 * knowing what was left out has been misled even if every included row is
 * correct. `not_included` therefore renders as a full-width block directly
 * under the result, at warn/danger weight, never inside a collapsed section and
 * never below the fold of table rows. When the server fails to send that list
 * at all, the panel says it cannot confirm completeness rather than assuming
 * the list was empty (see dataRightsApi.requestTenantExport).
 *
 * Not mounted anywhere yet — routing is the orchestrator's call after review.
 */
import { useEffect, useRef, useState } from 'react';
import {
  Banner, Button, Chip, EmptyState, PanelCard, TableScroll, TD, TH,
} from '../design/primitives';
import {
  describeDataRightsError, downloadTextFile, requestTenantExport,
  type ExportResult,
} from '../lib/dataRightsApi';

type Phase = 'idle' | 'running' | 'done' | 'error';

/** Stable DOM anchor so DeleteWorkspacePanel's "Export first" button can put
 *  this panel in front of the user in one click without the two components
 *  needing a shared parent or a router. */
export const EXPORT_PANEL_ANCHOR_ID = 'dt-data-export-panel';

/** Guidance that depends on WHY it failed. "Not deployed" is our problem and
 *  the customer should not go hunting through their own settings for it. */
const KIND_GUIDANCE: Record<string, string> = {
  not_deployed: 'This is a platform-side gap, not something you can fix from your settings. Nothing was created and nothing was changed.',
  denied: 'Exports are limited to workspace owners and admins. Ask an owner to run it, or ask us to grant you the access.',
  rejected: 'The request never started, so no partial file exists.',
  unavailable: 'The request did not reach our servers. Nothing was created — it is safe to try again.',
  malformed: 'Do not treat this as a completed export. Please send us the timestamp and we will investigate.',
  server: 'Nothing usable was produced. Please try again, and send us the timestamp if it repeats.',
};

function bytes(n: number | null): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function DataExportPanel() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [failure, setFailure] = useState<{ message: string; kind: string; detail: string } | null>(null);
  const resultRef = useRef<HTMLDivElement | null>(null);

  // Elapsed seconds instead of a fake progress bar: supabase.functions.invoke
  // is one request with no progress events, so a bar would be an animation
  // pretending to be information.
  useEffect(() => {
    if (phase !== 'running') return;
    const started = Date.now();
    const id = window.setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(id);
  }, [phase]);

  const run = async () => {
    setPhase('running');
    setElapsed(0);
    setResult(null);
    setFailure(null);
    try {
      const res = await requestTenantExport({});
      setResult(res);
      setPhase('done');
      // Move the reader to the manifest — the point of the whole interaction.
      window.setTimeout(() => resultRef.current?.focus(), 0);
    } catch (err) {
      console.error('DataExportPanel.run:', err);
      setFailure(describeDataRightsError(err));
      setPhase('error');
    }
  };

  const manifestFilename = `export-manifest-${new Date().toISOString().slice(0, 10)}.json`;

  // Any one of the three gap channels means there IS something to disclose.
  const ex = result?.manifest.exclusions;
  const exclusionCount = ex ? ex.notes.length + ex.lists.length + ex.blocked.length : 0;

  return (
    <div id={EXPORT_PANEL_ANCHOR_ID} tabIndex={-1} className="focus:outline-none">
    <PanelCard
      title="Export your data"
      badge={phase === 'done' ? <Chip tone="ok" dot>Export ready</Chip> : undefined}
    >
      <div className="space-y-5">
        <p className="text-sm text-dt-support leading-relaxed max-w-3xl">
          Takes a copy of your workspace’s records and packages them for download. Your data stays exactly
          where it is — exporting changes nothing and deletes nothing. Every export comes with a manifest
          listing each table, how many rows it contained, and anything that was left out.
        </p>

        {/* There is deliberately NO format picker. An earlier version offered
            JSON and CSV; the exporter supports neither choice — it always emits
            NDJSON, and the string "format" does not appear anywhere in
            supabase/functions/tenant-export/index.ts. The result header then
            printed "CSV" over an NDJSON file. Offering a choice that is silently
            ignored is worse than offering none, so this states what you get. */}
        <div className="rounded-lg border border-dt-border bg-dt-inset px-3 py-2.5">
          <p className="text-sm font-medium text-dt-body">Format: NDJSON</p>
          <p className="mt-0.5 text-xs text-dt-muted">
            One JSON object per line, one file per table. Streams without loading the
            whole workspace into memory, and every common data tool reads it.
          </p>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <Button kind="primary" onClick={run} disabled={phase === 'running'}>
            {phase === 'running' ? 'Preparing your export…' : phase === 'done' ? 'Run another export' : 'Create export'}
          </Button>
          {/* One aria-live region owns every status sentence, so a screen
              reader hears state changes without the whole panel re-announcing. */}
          <p aria-live="polite" className="text-xs text-dt-muted">
            {phase === 'running'
              ? `Working… ${elapsed}s elapsed. Large workspaces can take a few minutes — keep this tab open.`
              : phase === 'done'
                // Never claim the manifest is a full account when the reader
                // failed to verify part of it — the warnings block says so and
                // this line must not contradict it.
                ? (result && result.warnings.length > 0
                    ? 'Export finished, but this screen could not fully verify it. Read the notes below.'
                    : 'Export finished. The manifest below is the exporter’s account of what it contains.')
                : ''}
          </p>
        </div>

        {phase === 'error' && failure && (
          <Banner tone="danger">
            <p className="font-medium">Export failed — no file was produced.</p>
            <p className="mt-1 text-dt-body">{failure.message}</p>
            {KIND_GUIDANCE[failure.kind] && <p className="mt-1 text-dt-support">{KIND_GUIDANCE[failure.kind]}</p>}
            {failure.detail && failure.detail !== failure.message && (
              <p className="mt-2 text-xs text-dt-muted break-words">
                <span className="uppercase tracking-wide">Server detail:</span> {failure.detail}
              </p>
            )}
          </Banner>
        )}

        {phase === 'done' && result && (
          // tabIndex -1 so focus can be moved here after a run; the section is
          // labelled for anyone who lands on it out of context.
          <div ref={resultRef} tabIndex={-1} aria-label="Export result" className="space-y-4 focus:outline-none">

            {/* ── What you got ─────────────────────────────────────────── */}
            <div className="rounded-xl border border-dt-border bg-dt-inset px-4 py-3">
              <div className="flex items-baseline gap-x-6 gap-y-1 flex-wrap">
                <span className="text-sm text-dt-body">
                  <strong className="text-dt-title">{result.manifest.tables.length.toLocaleString()}</strong> tables
                </span>
                <span className="text-sm text-dt-body">
                  <strong className="text-dt-title">
                    {result.manifest.total_rows == null ? '—' : result.manifest.total_rows.toLocaleString()}
                  </strong> rows
                </span>
                <span className="text-xs text-dt-muted uppercase tracking-wide">NDJSON</span>
                {result.manifest.generated_at && (
                  <span className="text-xs text-dt-muted">Generated {new Date(result.manifest.generated_at).toLocaleString()}</span>
                )}
              </div>

              <div className="flex items-center gap-2 flex-wrap mt-3">
                {result.download ? (
                  // An anchor the customer clicks — never an automatic
                  // download. The link is the server's own signed URL.
                  // The primary-button recipe is inlined rather than reused
                  // because primitives.Button renders a <button>, and a
                  // download needs a real <a href download> to behave
                  // correctly (right-click "save as", middle-click, screen
                  // readers announcing it as a link).
                  <a
                    href={result.download.url}
                    download={result.download.filename ?? undefined}
                    className="inline-flex items-center justify-center gap-1.5 font-medium rounded-lg transition-colors text-sm px-4 py-2 bg-dt-accent-strong hover:bg-dt-accent-hover text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dt-accent"
                  >
                    Download {result.download.filename ?? 'export'}
                    {bytes(result.download.size_bytes) ? ` (${bytes(result.download.size_bytes)})` : ''}
                  </a>
                ) : (
                  <Chip tone="warn">No download link was returned — see the notes below</Chip>
                )}
                <Button
                  kind="secondary"
                  size="sm"
                  onClick={() => downloadTextFile(manifestFilename, JSON.stringify(result.raw, null, 2))}
                >
                  Save manifest (JSON)
                </Button>
              </div>

              {result.download?.expires_at && (
                <p className="text-xs text-dt-warn mt-2">
                  This link expires {new Date(result.download.expires_at).toLocaleString()}. Download it before then;
                  after that you will need to run the export again.
                </p>
              )}
              {!result.download && (
                <p className="text-xs text-dt-support mt-2">
                  The export ran and reported the contents below, but sent no file to download. The manifest is
                  a record of what was counted — it is not your data. Do not treat this as a completed export.
                </p>
              )}
            </div>

            {/* ── WHAT IS NOT IN HERE — deliberately above the table list.
                Prose caveats first (they are the ones that change a decision:
                "your login accounts are not in this file"), then the itemised
                lists, then tables the exporter could not export at all. ──── */}
            {exclusionCount > 0 ? (
              <Banner tone="warn">
                <p className="font-medium">What is NOT in this export</p>
                <p className="mt-1 text-dt-body">
                  Read this before you rely on the export or delete your workspace. If you need anything named
                  here, tell us now — after deletion we cannot go back for it.
                </p>

                {result.manifest.exclusions.notes.length > 0 && (
                  <dl className="mt-2.5 space-y-2">
                    {result.manifest.exclusions.notes.map(n => (
                      <div key={n.label}>
                        <dt className="text-xs font-medium text-dt-title">{n.label}</dt>
                        <dd className="text-xs text-dt-body">{n.text}</dd>
                      </div>
                    ))}
                  </dl>
                )}

                {result.manifest.exclusions.lists.map(l => (
                  <details key={l.label} className="mt-2.5">
                    {/* Collapsed ONLY for the long machine lists (200+ table
                        names). The prose above — the part that changes what a
                        customer does — is never behind a toggle. */}
                    <summary className="text-xs font-medium text-dt-title cursor-pointer">
                      {l.label} ({l.items.length})
                    </summary>
                    <ul className="mt-1.5 grid gap-x-6 gap-y-0.5 sm:grid-cols-2 text-xs text-dt-body">
                      {l.items.map((item, i) => <li key={`${item}-${i}`} className="font-mono break-all">{item}</li>)}
                    </ul>
                  </details>
                ))}

                {result.manifest.exclusions.blocked.length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs font-medium text-dt-title">
                      Tables the exporter could not export ({result.manifest.exclusions.blocked.length})
                    </p>
                    <ul className="mt-1 text-xs text-dt-body space-y-0.5">
                      {result.manifest.exclusions.blocked.map(b => (
                        <li key={b.table}>
                          <span className="font-mono break-all">{b.table}</span>
                          <span className="text-dt-support"> — {b.reason}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </Banner>
            ) : result.manifest.exclusions.reported ? (
              <Banner tone="info">
                <p className="font-medium">The exporter reported nothing excluded.</p>
                <p className="mt-1 text-dt-support">
                  That is the exporter’s own account of its work, listed table by table below — check it against
                  what you expect to see.
                </p>
              </Banner>
            ) : null /* the "could not confirm" case is raised as a warning below */}

            {result.manifest.coverage && (
              <p className="text-xs text-dt-support">{result.manifest.coverage}</p>
            )}

            {/* ── Contract deviations — our uncertainty, stated ─────────── */}
            {result.warnings.length > 0 && (
              <Banner tone="danger">
                <p className="font-medium">This screen could not fully verify the export</p>
                <ul className="mt-1.5 space-y-1 text-dt-body list-disc pl-5">
                  {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              </Banner>
            )}

            {/* ── The itemised manifest ────────────────────────────────── */}
            {result.manifest.tables.length > 0 ? (
              <div>
                <h3 className="text-sm font-medium text-dt-body mb-2">What the export contains</h3>
                <TableScroll>
                  <table className="w-full">
                    <caption className="sr-only">Tables included in this export, with row counts and any columns held back</caption>
                    <thead className="bg-dt-panel">
                      <tr>
                        <th scope="col" className={TH}>Table</th>
                        <th scope="col" className={`${TH} text-right`}>Rows</th>
                        <th scope="col" className={TH}>Columns held back</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...result.manifest.tables]
                        .sort((a, b) => (b.rows ?? -1) - (a.rows ?? -1) || a.table.localeCompare(b.table))
                        .map(t => (
                          <tr key={t.table} className="border-t border-dt-border">
                            <td className={`${TD} font-mono text-xs break-all`}>
                              {t.table}
                              {t.scope && <span className="block text-[11px] text-dt-muted font-sans">{t.scope}</span>}
                            </td>
                            <td className={`${TD} text-right tabular-nums whitespace-nowrap`}>
                              {t.rows == null
                                ? <span className="text-dt-muted">not counted</span>
                                : t.rows.toLocaleString()}
                            </td>
                            {/* A table can be "included" and still be missing
                                columns. Burying that in the raw JSON would be
                                exactly the kind of quiet omission this panel
                                exists to prevent. */}
                            <td className={`${TD} text-xs`}>
                              {t.columns_omitted.length === 0 && t.columns_redacted.length === 0
                                ? <span className="text-dt-muted">—</span>
                                : (
                                  <span className="text-dt-warn font-mono break-all">
                                    {[...t.columns_omitted, ...t.columns_redacted.map(c => `${c} (masked)`)].join(', ')}
                                  </span>
                                )}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </TableScroll>
              </div>
            ) : (
              <EmptyState headline="The manifest listed no tables">
                Nothing was reported as exported. Treat this run as failed and tell us about it.
              </EmptyState>
            )}
          </div>
        )}

        {phase === 'idle' && (
          <p className="text-xs text-dt-muted">
            Nothing is sent anywhere else. The export is generated for you and downloaded by you.
          </p>
        )}
      </div>
    </PanelCard>
    </div>
  );
}
