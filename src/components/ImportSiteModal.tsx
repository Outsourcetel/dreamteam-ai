import { useCallback, useEffect, useRef, useState } from 'react';
import { invokeEdge } from '../lib/invokeEdge';
import { Button, Chip, Field, INPUT_CLS, Modal } from '../design/primitives';
import { searchKnowledgeDocs } from '../lib/knowledgeApi';

/* ═══════════════════════════════════════════════════════════════════════════
   ImportSiteModal — "give us your website address, get a knowledge base".

   WHY THIS EXISTS: of 16 workspaces, the only two genuine outside signups
   ("acs" 2026-07-24, "Harbor Peak Consulting" 2026-07-06) both died with ZERO
   knowledge documents. The acs evaluator asked four real support questions in
   twenty seconds (14:54:45 → 14:55:05) and got the same reply to all four:
   "I don't have any knowledge documents yet — upload some in Knowledge →
   Library". That reply names a LOCATION instead of offering an ACTION.

   The existing add-paths all assume the knowledge is already in the user's
   hands as text: the Library empty state opens a blank editor, and the URL
   import (LiveKnowledgeLibrary.tsx importUrl) does ONE page per paste because
   supabase/functions/extract-document/index.ts has no sitemap and no crawl.
   The user's knowledge is on their website. This modal asks for that, once.

   HONESTY CONTRACT (house rule): a partial import is REPORTED as partial.
   The summary leads with the server's own sentence, then names every page it
   could not read, could not queue, or has not finished yet — with the reason
   the server gave. Nothing landing renders as a failure, never as a muted
   success; and "still importing" and "already in your library" are shown as
   the distinct outcomes they are rather than being rounded to either pole.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Pages we ASK for. site-import clamps this to MAX_PAGES_CEILING = 50 and
 *  defaults to 20 (supabase/functions/_shared/siteDiscovery.ts:41-42), so 25 is
 *  honoured as-is. Result copy uses the limit the SERVER reports back
 *  (discovery.max_pages), never this constant — only the pre-flight hint does. */
const MAX_PAGES = 25;

const INPUT_ID = 'site-import-url';
const HINT_ID = 'site-import-hint';
const ERROR_ID = 'site-import-error';
const DIALOG_LABEL = 'Import your website';

/* ── The site-import response, as the function ACTUALLY returns it ──────────
   Read off supabase/functions/site-import/index.ts (the 200 payload at :366,
   the "already running" short-circuit at :181, the 422 dead-ends at :226/:235)
   rather than from the shape this component was first specced against. The
   real payload carries three outcomes the original spec had no room for, and
   every one of them would otherwise be MISREPORTED here:
     • pending  — the function waits a bounded ~30s then returns; unfinished
                  pages keep importing on the cron. Counting them as failures
                  (or ignoring them) would understate a working import.
     • already_in_library — a duplicate is not a failure and not a new doc.
     • publish_mode 'draft' — a member without publisher rights gets DRAFTS.
                  Telling them their pages are live would be a flat lie.
   Every field is optional here on purpose: a shape change upstream must
   degrade to a thinner summary, never to a blank one or a wrong one. */

type PageStatus = 'imported' | 'already_in_library' | 'failed' | 'pending';

interface SitePage {
  url?: string;
  title?: string | null;
  status?: PageStatus;
  doc_id?: string | null;
  error?: string | null;
  error_kind?: string | null;
}

interface DiscoverySkip { url?: string; reason?: string; explanation?: string }

interface SiteImportResponse {
  ok?: boolean;
  error?: string;
  message?: string;
  site?: string;
  job_id?: string;
  already_running?: boolean;
  publish_mode?: 'published' | 'draft';
  still_running?: boolean;
  discovery?: {
    method?: string;
    found?: number;
    queued?: number;
    max_pages?: number;
    skipped_counts?: Record<string, number>;
    skipped?: DiscoverySkip[];
    notes?: string[];
  };
  summary?: { imported?: number; already_in_library?: number; failed?: number; pending?: number; total?: number };
  pages?: SitePage[];
}

interface RunResult {
  /** The server's own sentence. It is composed to keep partial success partial
   *  (site-import/index.ts:344-364), so it leads and we never overwrite it. */
  message: string;
  alreadyRunning: boolean;
  publishMode: 'published' | 'draft';
  counts: { imported: number; already: number; failed: number; pending: number; total: number };
  pages: SitePage[];
  skips: DiscoverySkip[];
  found: number | null;
  maxPages: number | null;
}

const countBy = (pages: SitePage[], s: PageStatus) => pages.filter(p => p.status === s).length;

function toRunResult(body: SiteImportResponse): RunResult {
  const pages = Array.isArray(body.pages) ? body.pages : [];
  const s = body.summary;
  // Prefer the server's own tally; fall back to counting rows so a missing
  // `summary` thins the report instead of zeroing it.
  const counts = {
    imported: Number(s?.imported ?? countBy(pages, 'imported')),
    already: Number(s?.already_in_library ?? countBy(pages, 'already_in_library')),
    failed: Number(s?.failed ?? countBy(pages, 'failed')),
    pending: Number(s?.pending ?? countBy(pages, 'pending')),
    total: Number(s?.total ?? pages.length),
  };
  return {
    message: (body.message || '').trim(),
    alreadyRunning: body.already_running === true,
    publishMode: body.publish_mode === 'draft' ? 'draft' : 'published',
    counts,
    pages,
    skips: Array.isArray(body.discovery?.skipped) ? body.discovery!.skipped! : [],
    found: typeof body.discovery?.found === 'number' ? body.discovery.found : null,
    maxPages: typeof body.discovery?.max_pages === 'number' ? body.discovery.max_pages : null,
  };
}

/** Best available human label for a page row. */
const pageLabel = (p: SitePage) => (p.title || '').trim() || prettyPath(p.url ?? '');

/** Last meaningful path segment, for when the server gave us no title. */
function prettyPath(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean).pop();
    return seg ? decodeURIComponent(seg).replace(/[-_]+/g, ' ') : u.hostname;
  } catch {
    return url || 'page';
  }
}

/**
 * Turn what a human types ("acme.com", "www.acme.com/help", trailing spaces)
 * into a URL the edge function can accept.
 *
 * ⚠ THIS IS UX, NOT SECURITY. SSRF is a real prior incident in this codebase
 * (see project_audit_and_security_hardening memory / mig 154). The security
 * boundary is server-side — public.is_safe_external_url() and
 * supabase/functions/_shared/browserFetch.ts — and site-import is responsible
 * for enforcing it. Nothing here may be treated as a check.
 */
function normaliseUrl(raw: string): { url: string } | { problem: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { problem: 'Enter your website address first.' };
  if (/\s/.test(trimmed)) return { problem: 'That looks like more than one address — enter just one.' };

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return { problem: `“${trimmed}” isn’t a web address. Try something like acme.com.` };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { problem: 'Only http and https addresses can be imported.' };
  }
  if (!u.hostname.includes('.')) {
    return { problem: `“${u.hostname}” is missing a domain ending — try acme.com.` };
  }
  return { url: u.toString() };
}

/** mm:ss for the elapsed counter — the only progress number we can honestly show. */
function mmss(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const MACHINE_CODE_COPY: Record<string, string> = {
  no_tenant: 'This account isn’t attached to a workspace, so there’s nowhere to put the pages.',
  not_authenticated: 'Your session has expired — sign in again and retry.',
  insufficient_permission: 'Your account isn’t allowed to add knowledge to this workspace.',
};

/** Give a server sentence terminal punctuation so appending to it reads right. */
const endSentence = (s: string) => (s && !/[.!?]$/.test(s) ? `${s}.` : s);

/**
 * Read whatever the Edge Function actually said. supabase-js v2 hands back
 * `data: null` and a FunctionsHttpError whose `.context` is the raw Response
 * on any non-2xx (node_modules/@supabase/functions-js .../FunctionsClient.js
 * — `if (!response.ok) throw new FunctionsHttpError(response)`), so the
 * default `error.message` is the useless "Edge Function returned a non-2xx
 * status code". The single most likely failure today is site-import not being
 * deployed yet, which is a 404 — that must read as a deployment problem, not
 * as "your website is broken".
 */
async function describeInvokeError(err: unknown): Promise<string> {
  // err is invokeEdge's EdgeFunctionError: status + pre-parsed body, with the
  // underlying supabase-js class name (FunctionsFetchError etc.) preserved.
  const e = err as { message?: string; name?: string; status?: number; body?: Record<string, unknown> | null };
  if (typeof e?.status === 'number') {
    const parsed = (e.body ?? {}) as { error?: string; message?: string };
    let serverMessage = (parsed?.error || parsed?.message || '').trim();
    // Some refusals come back as machine codes rather than sentences
    // (site-import/index.ts:161 returns a bare 'no_tenant'). Showing the raw
    // token to a business user is the same dead end this whole modal exists
    // to remove, so codes get translated and the token kept for support.
    if (/^[a-z0-9_]+$/.test(serverMessage)) {
      serverMessage = MACHINE_CODE_COPY[serverMessage]
        ?? `The importer refused the request (${serverMessage}).`;
    }
    serverMessage = endSentence(serverMessage);

    // site-import itself only ever emits 400 / 403 / 422 / 500 (index.ts), so a
    // 404 is the PLATFORM saying the function isn't there — which is exactly
    // the state this workspace is in until the orchestrator deploys it.
    if (e.status === 404) {
      return 'The website importer isn’t deployed to this workspace yet — the server returned 404 for '
        + '“site-import”. Nothing was imported, and the other ways of adding knowledge still work.';
    }
    // 400 (bad address), 403 (no tenant / not permitted) and 422 (nothing
    // readable on the site) are all raised BEFORE anything is queued, so
    // "nothing was imported" is a fact here rather than an assumption.
    if (e.status === 400 || e.status === 403 || e.status === 422) {
      return serverMessage
        ? `${serverMessage} Nothing was imported.`
        : `The importer refused the request (status ${e.status}). Nothing was imported.`;
    }
    // 5xx can land AFTER the job was queued (the enqueue is at index.ts:269 and
    // the catch-all 500 is below it), so we must not claim nothing happened.
    return `${serverMessage || `The importer failed with status ${e.status}.`} `
      + 'Some pages may already have been queued — check your Knowledge Library in a few minutes '
      + 'before retrying, so you don’t import the same site twice.';
  }
  if (e?.name === 'FunctionsFetchError') {
    // The request may have died after the server started work, so this is
    // "we lost the result", not "nothing happened".
    return 'Lost contact with the importer before it reported back — check your connection, and check '
      + 'your Knowledge Library in a few minutes before retrying, in case pages did land.';
  }
  return e?.message || 'The importer failed and gave no reason.';
}

type Phase = 'form' | 'running' | 'done';

export interface ImportSiteModalProps {
  onClose: () => void;
  /** Fired once the run finishes with at least one document created, so the
   *  caller can refresh its list / step state. Not fired on total failure. */
  onImported?: (count: number) => void;
}

/* Arrow component, matching LiveKnowledgeLibrary's style — and deliberately
   NOT a `function`-keyword declaration whose name ends in "Modal".
   scripts/design-drift.mjs (line 32) counts such declarations per file to
   catch hand-rolled modal shells. This file contains no shell: it composes
   the primitives' <Modal>, so that metric must not tick up because of it. */
const ImportSiteModal = ({ onClose, onImported }: ImportSiteModalProps) => {
  const [raw, setRaw] = useState('');
  const [phase, setPhase] = useState<Phase>('form');
  const [problem, setProblem] = useState<string | null>(null);   // input / invocation failure
  const [target, setTarget] = useState('');                      // host being read, for copy
  const [elapsed, setElapsed] = useState(0);
  const [landedSoFar, setLandedSoFar] = useState(0);             // real docs observed mid-run
  const [result, setResult] = useState<RunResult | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // Document count as it stood BEFORE the run, so the mid-run counter measures
  // this import and not what was already in the library.
  const baselineDocsRef = useRef<number | null>(null);
  // Refs so the keyboard effect can run exactly once yet still see live values.
  const runningRef = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  runningRef.current = phase === 'running';

  const requestClose = useCallback(() => {
    // Closing mid-flight would throw away the summary — the one thing that
    // makes a partial import honest — and we cannot promise the server run
    // survives the client going away. So the dialog is busy, and says so.
    if (runningRef.current) return;
    closeRef.current();
  }, []);

  /* ── Keyboard + focus. The shared Modal (src/design/primitives.tsx:214) sets
     role="dialog" and aria-modal but has NO accessible name, NO Escape and NO
     focus trap. This app already carries ~523 unlabelled form fields; this
     dialog does not add to that debt. ─────────────────────────────────────── */
  useEffect(() => {
    const root = rootRef.current;
    const dialog = (root?.closest('[role="dialog"]') as HTMLElement | null) ?? root;
    const returnFocusTo = document.activeElement as HTMLElement | null;
    dialog?.setAttribute('aria-label', DIALOG_LABEL);

    const focusable = () => Array.from(
      (dialog ?? document).querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter(el => el.getClientRects().length > 0);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        requestClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const els = focusable();
      if (els.length === 0) return;
      const first = els[0];
      const last = els[els.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const inside = !!active && !!dialog && dialog.contains(active);
      if (e.shiftKey && (!inside || active === first)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (!inside || active === last)) { e.preventDefault(); first.focus(); }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      returnFocusTo?.focus?.();
    };
  }, [requestClose]);

  // Land the caret where the user has to type — the modal has exactly one field.
  useEffect(() => { inputRef.current?.focus(); }, []);

  // Elapsed seconds: an indeterminate bar with a real clock beside it. We have
  // no per-page callback from a single-shot invoke, so we show the one number
  // that is actually true rather than a fabricated percentage.
  useEffect(() => {
    if (phase !== 'running') return;
    const t = setInterval(() => setElapsed(s => s + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  /**
   * Poll the workspace's own document count while the run is in flight and
   * show the DELTA against the count taken just before the invoke. If
   * site-import writes page-by-page this is genuine live progress; if it
   * writes everything at the end the delta simply stays 0 and we render
   * nothing — never a misleading "0 pages" while work is actually happening.
   */
  useEffect(() => {
    if (phase !== 'running') return;
    let cancelled = false;
    let inFlight = false;   // a slow RPC must not stack up behind the interval
    const tick = async () => {
      const base = baselineDocsRef.current;
      if (inFlight || base === null) return;
      inFlight = true;
      try {
        const { total } = await searchKnowledgeDocs({ limit: 1 });
        if (!cancelled) setLandedSoFar(Math.max(0, total - base));
      } catch { /* non-fatal: the counter just never appears */ }
      finally { inFlight = false; }
    };
    const t = setInterval(() => { void tick(); }, 4000);
    return () => { cancelled = true; clearInterval(t); };
  }, [phase]);

  const start = async () => {
    const parsed = normaliseUrl(raw);
    if ('problem' in parsed) { setProblem(parsed.problem); inputRef.current?.focus(); return; }

    let host = parsed.url;
    try { host = new URL(parsed.url).hostname.replace(/^www\./, ''); } catch { /* keep the full URL */ }

    setProblem(null);
    setTarget(host);
    setElapsed(0);
    setLandedSoFar(0);
    setResult(null);
    setPhase('running');

    // Deliberately not awaited: the import must not wait on a progress-counter
    // baseline. Until it lands the counter simply stays hidden.
    baselineDocsRef.current = null;
    void searchKnowledgeDocs({ limit: 1 })
      .then(r => { baselineDocsRef.current = r.total; })
      .catch(() => { /* counter stays hidden; the import is unaffected */ });

    try {
      const { data, error } = await invokeEdge('site-import', {
        body: { url: parsed.url, max_pages: MAX_PAGES },
      });
      if (error) throw error;

      const body = (data ?? {}) as SiteImportResponse;

      // A 200 carrying `error` and no report is a failure the client must not
      // dress up as a summary. (The function's own failures come back as 4xx/5xx
      // and are handled in the catch, but this keeps a shape change honest.)
      if (body.ok === false && !body.summary && !body.pages) {
        setProblem(body.error || body.message || 'The importer reported a failure but gave no reason.');
        setPhase('form');
        return;
      }

      const run = toRunResult(body);
      setResult(run);
      setPhase('done');
      if (run.counts.imported > 0) onImported?.(run.counts.imported);
    } catch (err) {
      console.error('site-import invoke failed:', err);
      setProblem(await describeInvokeError(err));
      setPhase('form');
    }
  };

  const restart = () => { setPhase('form'); setResult(null); setProblem(null); setTimeout(() => inputRef.current?.focus(), 0); };

  /* ONE live region for the whole dialog, and it deliberately excludes the
     elapsed clock: a per-second string change inside aria-live makes a screen
     reader talk over itself every second. This sentence only changes on events
     that matter — the run starting, documents landing, the run finishing. */
  const liveMessage =
    phase === 'running'
      ? (landedSoFar > 0
        ? `Importing ${target}. ${landedSoFar} document${landedSoFar === 1 ? '' : 's'} added so far.`
        : `Importing ${target}. This takes up to about a minute.`)
      : phase === 'done' && result
        ? (result.message || `Import finished. ${result.counts.imported} imported, ${result.counts.failed} failed, ${result.counts.pending} still importing.`)
        : '';

  return (
    <Modal title={DIALOG_LABEL} onClose={requestClose} wide>
      <div ref={rootRef} className="space-y-4">
        <p className="sr-only" aria-live="polite">{liveMessage}</p>

        {/* ── FORM ─────────────────────────────────────────────────────── */}
        {phase === 'form' && (
          <>
            <p className="text-sm text-dt-support">
              Your digital employees answer only from the documents in this workspace. Point us at your
              website and we’ll read your public pages and turn them into those documents — no copying
              and pasting.
            </p>

            {/* Field (src/design/primitives.tsx:177) renders its <label> without
                htmlFor, so the input carries its own accessible name and
                description rather than relying on proximity. */}
            <Field label="Your website address">
              <p id={HINT_ID} className="text-xs text-dt-muted mb-1.5">
                Just the address — <span className="text-dt-support">acme.com</span> is enough. We read up
                to {MAX_PAGES} public pages, starting here. Pages behind a login can’t be read.
              </p>
              <input
                id={INPUT_ID}
                ref={inputRef}
                type="text"
                inputMode="url"
                autoComplete="url"
                spellCheck={false}
                value={raw}
                onChange={e => { setRaw(e.target.value); if (problem) setProblem(null); }}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void start(); } }}
                placeholder="acme.com"
                aria-label="Your website address"
                aria-describedby={problem ? `${HINT_ID} ${ERROR_ID}` : HINT_ID}
                aria-invalid={problem ? true : undefined}
                className={INPUT_CLS}
              />
              {problem && (
                <p id={ERROR_ID} role="alert" className="text-xs text-dt-danger mt-2 leading-relaxed">
                  {problem}
                </p>
              )}
            </Field>

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button kind="ghost" onClick={requestClose}>Cancel</Button>
              <Button kind="primary" onClick={() => void start()} disabled={!raw.trim()}>
                Import my website
              </Button>
            </div>
          </>
        )}

        {/* ── RUNNING ──────────────────────────────────────────────────── */}
        {phase === 'running' && (
          <div className="py-2">
            <div
              role="progressbar"
              aria-label={`Importing ${target}`}
              className="h-1.5 rounded-full bg-dt-inset overflow-hidden mb-4"
            >
              {/* Indeterminate on purpose: a single invoke gives us no page-by-page
                  signal, and a fake percentage would be a lie about real progress. */}
              <div className="h-full w-full bg-dt-accent animate-pulse" />
            </div>

            <div className="space-y-1.5">
              <p className="text-sm text-dt-body">
                Reading <span className="font-medium text-dt-title">{target}</span> — {mmss(elapsed)} elapsed
              </p>
              {landedSoFar > 0 && (
                <p className="text-sm text-dt-ok">
                  {landedSoFar} document{landedSoFar === 1 ? '' : 's'} added so far
                </p>
              )}
              {/* Bounded by design: site-import spends at most ~35s discovering
                  and ~30s waiting for the queue, then reports whatever is done
                  and marks the rest "still importing" (site-import/index.ts:62-64). */}
              <p className="text-xs text-dt-muted leading-relaxed">
                Finding your pages and reading each one — up to about a minute. Keep this open: the full
                summary, including anything that couldn’t be read, appears here when it finishes.
              </p>
            </div>
          </div>
        )}

        {/* ── RESULT — honest by construction ──────────────────────────── */}
        {phase === 'done' && result && (
          <ResultSummary
            target={target}
            result={result}
            onRestart={restart}
            onDone={onClose}
          />
        )}
      </div>
    </Modal>
  );
};

export default ImportSiteModal;

/* ─────────────────────────────────────────────────────────────────────────── */

function ResultSummary({
  target, result, onRestart, onDone,
}: {
  target: string;
  result: RunResult;
  onRestart: () => void;
  onDone: () => void;
}) {
  const { message, alreadyRunning, publishMode, counts, pages, skips, found, maxPages } = result;

  // A second import of a site already being imported short-circuits with no
  // report at all (site-import/index.ts:181). Rendering the normal summary
  // there would show "0 imported" for a run that is going fine.
  if (alreadyRunning) {
    return (
      <div className="space-y-4">
        <p className="text-base font-semibold text-dt-info">Already importing {target}</p>
        <p className="text-sm text-dt-support leading-relaxed">
          {message || `An import of ${target} is already running — a second one wasn’t started. Your pages will appear in the Knowledge Library as it finishes.`}
        </p>
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button kind="secondary" onClick={onRestart}>Import another address</Button>
          <Button kind="primary" onClick={onDone}>Done</Button>
        </div>
      </div>
    );
  }

  // "Everything was already in your library" is a benign outcome, not a
  // failure, and must not be painted red just because the new-doc count is 0.
  const allDuplicates = counts.imported === 0 && counts.pending === 0 && counts.failed === 0 && counts.already > 0;
  const nothingLanded = counts.imported === 0 && counts.pending === 0 && !allDuplicates;
  const perfect = counts.imported > 0 && counts.failed === 0 && counts.pending === 0 && skips.length === 0;
  const headlineColour = nothingLanded ? 'text-dt-danger'
    : allDuplicates ? 'text-dt-info'
      : perfect ? 'text-dt-ok' : 'text-dt-warn';

  const headline = nothingLanded
    ? 'Nothing was imported'
    : allDuplicates
      ? `Everything readable on ${target} was already in your library`
      : counts.pending > 0 && counts.imported === 0
        ? `Importing ${counts.pending} page${counts.pending === 1 ? '' : 's'} from ${target}`
        : `Imported ${counts.imported} page${counts.imported === 1 ? '' : 's'} from ${target}`;

  const failedPages = pages.filter(p => p.status === 'failed');
  const importedPages = pages.filter(p => p.status === 'imported');
  const pendingPages = pages.filter(p => p.status === 'pending');

  return (
    // Not a live region: the dialog-level sr-only region announces the outcome
    // once, so repeating it here would double-speak the summary.
    <div className="space-y-4">
      <div>
        <p className={`text-base font-semibold ${headlineColour}`}>{headline}</p>
        {/* The server composes this sentence specifically so partial success
            stays partial — it leads, and the client never rewrites it. */}
        {message && <p className="text-sm text-dt-support mt-1.5 leading-relaxed">{message}</p>}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={counts.imported > 0 ? 'ok' : 'neutral'} dot>{counts.imported} imported</Chip>
        {counts.pending > 0 && <Chip tone="info" dot pulse>{counts.pending} still importing</Chip>}
        {counts.already > 0 && <Chip tone="neutral">{counts.already} already in your library</Chip>}
        {counts.failed > 0 && <Chip tone="danger">{counts.failed} failed</Chip>}
        {skips.length > 0 && <Chip tone="warn">{skips.length} not queued</Chip>}
        {found !== null && <Chip tone="neutral">{found} found on the site</Chip>}
      </div>

      {/* An ordinary member can import but not publish, so the queue lands
          drafts instead (site-import/index.ts:270-279). Saying "live" here
          would be false for exactly the users this feature is meant to help. */}
      {publishMode === 'draft' && counts.imported + counts.pending > 0 && (
        <p className="text-xs text-dt-warn leading-relaxed">
          These pages landed as <span className="font-medium">drafts awaiting review</span>, because your
          account can add knowledge but not publish it. Your employees won’t answer from them until
          someone with publishing rights approves them in the Knowledge Library.
        </p>
      )}
      {publishMode === 'published' && counts.imported > 0 && (
        <p className="text-xs text-dt-muted leading-relaxed">
          These are in your Knowledge Library now and your employees can answer from them. Worth reading
          over — anything that reads wrong on your website reads wrong in an answer too.
        </p>
      )}
      {counts.pending > 0 && (
        <p className="text-xs text-dt-info leading-relaxed">
          The remaining {counts.pending} {counts.pending === 1 ? 'page is' : 'pages are'} still being
          imported in the background. You can close this — they’ll appear in the Knowledge Library on
          their own.
        </p>
      )}
      {maxPages !== null && found !== null && found > maxPages && (
        <p className="text-xs text-dt-muted leading-relaxed">
          {found} pages were found but this run was limited to {maxPages}, so the rest were never opened.
        </p>
      )}

      {importedPages.length > 0 && (
        <PageList heading={`Imported (${importedPages.length})`} noteClass="text-dt-body"
          rows={importedPages.map(p => ({ url: p.url ?? '', note: pageLabel(p) }))} />
      )}
      {pendingPages.length > 0 && (
        <PageList heading={`Still importing (${pendingPages.length})`} noteClass="text-dt-info"
          rows={pendingPages.map(p => ({ url: p.url ?? '', note: pageLabel(p) }))} />
      )}
      {failedPages.length > 0 && (
        <PageList heading={`Couldn’t be read (${failedPages.length})`} noteClass="text-dt-danger"
          rows={failedPages.map(p => ({ url: p.url ?? '', note: (p.error || '').trim() || 'no reason given' }))} />
      )}
      {skips.length > 0 && (
        <PageList heading={`Not queued (${skips.length})`} noteClass="text-dt-muted"
          rows={skips.map(s => ({ url: s.url ?? '', note: s.explanation || s.reason || 'no reason given' }))} />
      )}

      <div className="flex items-center justify-end gap-2 pt-1">
        <Button kind="secondary" onClick={onRestart}>
          {nothingLanded ? 'Try another address' : 'Import another address'}
        </Button>
        <Button kind="primary" onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}

/** Every page we touched is nameable — a count alone would let a partial run
 *  read as a clean one. Long URLs scroll inside this box, never the page. */
function PageList({ heading, rows, noteClass }: {
  heading: string;
  rows: { url: string; note: string }[];
  noteClass: string;
}) {
  return (
    <section>
      <h4 className="text-[11px] uppercase tracking-wide text-dt-muted mb-1.5">{heading}</h4>
      <ul className="max-h-40 overflow-y-auto rounded-lg border border-dt-border bg-dt-inset divide-y divide-dt-border">
        {rows.map((r, i) => (
          <li key={`${r.url}-${i}`} className="px-3 py-1.5">
            <p className={`text-xs ${noteClass} truncate`} title={r.note}>{r.note}</p>
            <p className="text-[11px] text-dt-faint truncate" title={r.url}>{r.url}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
