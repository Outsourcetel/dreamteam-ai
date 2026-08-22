import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PanelCard, Button, Chip, EntityRow, EmptyState, Banner, Drawer, Field, INPUT_CLS,
  type Tone,
} from '../design/primitives';
import {
  listIngestionJobs, listIngestionItems, createIngestionJob,
  cancelIngestionJob, retryIngestionJob, listKnowledgeSpaces,
  type IngestionJob, type IngestionItem,
} from '../lib/knowledgeApi';

// ============================================================
// Import queue — the human-facing half of the mig-347 ingestion queue.
//
// The queue exists for imports that are slow or flaky: fetching a list of URLs,
// re-importing a folder. The worker retries what is worth retrying and gives up
// on what is not. This panel's whole job is to make that legible: what ran,
// what is still going, what failed and WHY, and the one button that helps.
//
// Deliberate choice: "Try again" is only offered when something is actually
// retryable. A retry button next to an unreadable PDF that silently re-fails is
// worse than no button — it teaches people the product is lying to them.
// ============================================================

const JOB_TONE: Record<IngestionJob['status'], Tone> = {
  queued: 'neutral',
  running: 'info',
  completed: 'ok',
  completed_with_errors: 'warn',
  failed: 'danger',
  cancelled: 'neutral',
};

const JOB_LABEL: Record<IngestionJob['status'], string> = {
  queued: 'Waiting',
  running: 'Importing',
  completed: 'Done',
  completed_with_errors: 'Done with problems',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const ITEM_TONE: Record<IngestionItem['status'], Tone> = {
  queued: 'neutral',
  running: 'info',
  succeeded: 'ok',
  failed: 'danger',
  skipped_duplicate: 'info',
  cancelled: 'neutral',
};

const ITEM_LABEL: Record<IngestionItem['status'], string> = {
  queued: 'Waiting',
  running: 'Working',
  succeeded: 'Added',
  failed: 'Failed',
  skipped_duplicate: 'Already had it',
  cancelled: 'Cancelled',
};

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
};

const isActive = (j: IngestionJob) => j.status === 'queued' || j.status === 'running';

export default function IngestionQueuePanel() {
  const [jobs, setJobs] = useState<IngestionJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openJob, setOpenJob] = useState<IngestionJob | null>(null);
  const [items, setItems] = useState<IngestionItem[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const pollRef = useRef<number | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      setJobs(await listIngestionJobs(20));
      setError(null);
    } catch (e) {
      setError((e as Error)?.message || 'Could not load the import queue.');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // The drain runs every 2 minutes on the server, so a job that is mid-flight
  // changes without the user doing anything. Poll only while something is
  // actually moving — a finished queue costs nothing.
  useEffect(() => {
    const active = jobs.some(isActive);
    if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
    if (!active) return;
    pollRef.current = window.setInterval(() => { void load(true); }, 5000);
    return () => { if (pollRef.current) window.clearInterval(pollRef.current); };
  }, [jobs, load]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(t);
  }, [notice]);

  const openDetail = async (job: IngestionJob) => {
    setOpenJob(job);
    setItemsLoading(true);
    try { setItems(await listIngestionItems(job.id)); }
    catch (e) { setNotice((e as Error)?.message || 'Could not load the item detail.'); }
    finally { setItemsLoading(false); }
  };

  const doRetry = async (job: IngestionJob) => {
    setBusy(job.id);
    try {
      const r = await retryIngestionJob(job.id);
      // Say exactly what happened, including what could NOT be retried, rather
      // than a cheerful "retrying" that quietly does nothing.
      setNotice(
        r.retried === 0
          ? `Nothing could be retried — ${r.not_retryable} item${r.not_retryable === 1 ? '' : 's'} failed for a reason trying again won't fix.`
          : `Retrying ${r.retried} item${r.retried === 1 ? '' : 's'}.${r.not_retryable > 0 ? ` ${r.not_retryable} can't be retried.` : ''}`,
      );
      await load(true);
      if (openJob?.id === job.id) await openDetail(job);
    } catch (e) {
      setNotice((e as Error)?.message || 'Retry failed.');
    } finally { setBusy(null); }
  };

  const doCancel = async (job: IngestionJob) => {
    setBusy(job.id);
    try {
      const r = await cancelIngestionJob(job.id);
      setNotice(`Cancelled. ${r.cancelled_items} item${r.cancelled_items === 1 ? '' : 's'} stopped.`);
      await load(true);
    } catch (e) {
      setNotice((e as Error)?.message || 'Could not cancel.');
    } finally { setBusy(null); }
  };

  const retryable = (j: IngestionJob) => j.failed_items > 0;

  return (
    <>
      <PanelCard
        title="Import queue"
        badge={jobs.some(isActive)
          ? <Chip tone="info" dot pulse>Working</Chip>
          : jobs.some(j => j.failed_items > 0) ? <Chip tone="warn" dot>Needs attention</Chip> : undefined}
        actions={<Button kind="primary" size="sm" onClick={() => setNewOpen(true)}>Import from web</Button>}
      >
        {notice && <Banner tone="info" className="mb-3">{notice}</Banner>}

        {loading ? (
          <div className="space-y-2" aria-busy="true">
            {[0, 1, 2].map(i => (
              <div key={i} className="h-14 rounded-xl border border-dt-border bg-dt-panel animate-pulse" />
            ))}
          </div>
        ) : error ? (
          <Banner tone="danger">
            <div className="flex items-center justify-between gap-3">
              <span>{error}</span>
              <Button size="sm" onClick={() => void load()}>Try again</Button>
            </div>
          </Banner>
        ) : jobs.length === 0 ? (
          <EmptyState
            icon="↧"
            headline="No imports yet"
            action={<Button kind="primary" size="sm" onClick={() => setNewOpen(true)}>Import from web</Button>}
          >
            Paste a list of web addresses and they'll be fetched, read and added to your
            knowledge base in the background. Anything that fails is retried automatically,
            and anything that can't be read tells you why.
          </EmptyState>
        ) : (
          <div className="space-y-2">
            {jobs.map(job => {
              const done = job.succeeded_items + job.skipped_items + job.failed_items;
              return (
                <EntityRow
                  key={job.id}
                  title={job.label}
                  chips={
                    <>
                      <Chip tone={JOB_TONE[job.status]} dot pulse={isActive(job)}>{JOB_LABEL[job.status]}</Chip>
                      {job.failed_items > 0 && <Chip tone="danger">{job.failed_items} failed</Chip>}
                      {job.skipped_items > 0 && <Chip tone="info">{job.skipped_items} already had</Chip>}
                    </>
                  }
                  meta={
                    <>
                      {done} of {job.total_items} processed
                      {job.target_collection ? ` · filed into ${job.target_collection}` : ''}
                      {' · '}{ago(job.created_at)}
                      {job.first_error ? ` · ${job.first_error.slice(0, 80)}` : ''}
                    </>
                  }
                  actions={
                    <>
                      {retryable(job) && (
                        <Button size="sm" disabled={busy === job.id} onClick={() => void doRetry(job)}>
                          {busy === job.id ? 'Working…' : 'Try again'}
                        </Button>
                      )}
                      {isActive(job) && (
                        <Button kind="ghost" size="sm" disabled={busy === job.id} onClick={() => void doCancel(job)}>
                          Cancel
                        </Button>
                      )}
                    </>
                  }
                  onOpen={() => void openDetail(job)}
                />
              );
            })}
          </div>
        )}
      </PanelCard>

      {openJob && (
        <Drawer title={openJob.label} onClose={() => { setOpenJob(null); setItems([]); }}>
          <div className="space-y-4">
            <div className="flex items-center gap-2 flex-wrap">
              <Chip tone={JOB_TONE[openJob.status]} dot>{JOB_LABEL[openJob.status]}</Chip>
              <Chip tone="ok">{openJob.succeeded_items} added</Chip>
              {openJob.skipped_items > 0 && <Chip tone="info">{openJob.skipped_items} already had</Chip>}
              {openJob.failed_items > 0 && <Chip tone="danger">{openJob.failed_items} failed</Chip>}
            </div>

            {itemsLoading ? (
              <div className="space-y-2" aria-busy="true">
                {[0, 1, 2].map(i => <div key={i} className="h-12 rounded-lg border border-dt-border bg-dt-panel animate-pulse" />)}
              </div>
            ) : items.length === 0 ? (
              <EmptyState headline="Nothing in this import">
                Every item was removed, or this import was cancelled before it started.
              </EmptyState>
            ) : (
              <ul className="space-y-2">
                {items.map(it => (
                  <li key={it.id} className="rounded-lg border border-dt-border bg-dt-panel px-3 py-2.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm text-dt-body truncate">{it.title || it.source_ref}</p>
                        {it.title && <p className="text-[11px] text-dt-muted truncate">{it.source_ref}</p>}
                      </div>
                      <Chip tone={ITEM_TONE[it.status]}>{ITEM_LABEL[it.status]}</Chip>
                    </div>
                    {it.last_error && (
                      <p className="text-xs text-dt-support mt-1.5">
                        {it.last_error}
                        {/* The distinction that decides whether trying again is
                            worth anything, said in plain words. */}
                        {it.error_kind === 'terminal'
                          ? <span className="text-dt-muted"> · trying again won't help</span>
                          : it.status === 'failed'
                            ? <span className="text-dt-muted"> · gave up after {it.attempts} attempts</span>
                            : <span className="text-dt-muted"> · will try again ({it.attempts} of {it.max_attempts})</span>}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Drawer>
      )}

      {newOpen && (
        <NewImportDrawer
          onClose={() => setNewOpen(false)}
          onQueued={async (msg) => { setNewOpen(false); setNotice(msg); await load(true); }}
        />
      )}
    </>
  );
}

/* ── Queue an import ─────────────────────────────────────────────────────── */
function NewImportDrawer({ onClose, onQueued }:
  { onClose: () => void; onQueued: (msg: string) => Promise<void> }) {
  const [urls, setUrls] = useState('');
  const [spaces, setSpaces] = useState<Array<{ id: string; name: string }>>([]);
  const [spaceId, setSpaceId] = useState<string>('');
  const [mode, setMode] = useState<'published' | 'draft'>('published');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const s = await listKnowledgeSpaces();
        setSpaces(s);
        setSpaceId(s.find(x => x.name === 'General')?.id ?? s[0]?.id ?? '');
      } catch { /* filing is optional — an import without a Space still works */ }
    })();
  }, []);

  const parsed = urls.split(/[\s,]+/).map(u => u.trim()).filter(u => /^https?:\/\//i.test(u));

  const submit = async () => {
    if (parsed.length === 0) { setErr('Add at least one web address starting with http:// or https://'); return; }
    setSaving(true); setErr(null);
    try {
      await createIngestionJob({
        label: parsed.length === 1 ? parsed[0].slice(0, 80) : `${parsed.length} pages from the web`,
        sourceKind: 'url',
        items: parsed.map(u => ({ url: u })),
        targetCollectionId: spaceId || null,
        publishMode: mode,
      });
      await onQueued(`Importing ${parsed.length} page${parsed.length === 1 ? '' : 's'}. This runs in the background — you can leave this page.`);
    } catch (e) {
      setErr((e as Error)?.message || 'Could not queue the import.');
    } finally { setSaving(false); }
  };

  return (
    <Drawer title="Import from the web" onClose={onClose}>
      <div className="space-y-4">
        {err && <Banner tone="danger">{err}</Banner>}

        <Field label="Web addresses" hint="One per line. Web pages and PDFs both work.">
          <textarea
            value={urls}
            onChange={e => setUrls(e.target.value)}
            rows={7}
            placeholder={'https://example.com/help/refunds\nhttps://example.com/help/shipping'}
            className={INPUT_CLS}
          />
        </Field>

        {parsed.length > 0 && (
          <p className="text-xs text-dt-support">
            {parsed.length} address{parsed.length === 1 ? '' : 'es'} ready. Each one is fetched and read in the
            background; if a site is slow or briefly down it's retried automatically.
          </p>
        )}

        {spaces.length > 0 && (
          <Field label="File into" hint="Where these documents will live in your library.">
            <select value={spaceId} onChange={e => setSpaceId(e.target.value)} className={INPUT_CLS}>
              {spaces.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
        )}

        <Field label="When they arrive" hint="Drafts are not used to answer anyone until you publish them.">
          <select value={mode} onChange={e => setMode(e.target.value as 'published' | 'draft')} className={INPUT_CLS}>
            <option value="published">Publish straight away — employees can answer from them</option>
            <option value="draft">Bring in as drafts for review first</option>
          </select>
        </Field>

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button kind="ghost" onClick={onClose}>Cancel</Button>
          <Button kind="primary" disabled={saving || parsed.length === 0} onClick={() => void submit()}>
            {saving ? 'Queueing…' : `Import ${parsed.length || ''}`.trim()}
          </Button>
        </div>
      </div>
    </Drawer>
  );
}
