// ── The phone shell (handoff 13) ──────────────────────────────────────────
// ONE surface, not a shrunken copy of the other fifty-five. The case worth
// building is an owner approving a $15,600 invoice from their phone, because
// today their team waits until somebody is back at a desk.
//
// ⚠ NO SECOND SOURCE OF TRUTH. Every item here is a `DBHumanTask` from
// listHumanTasks(), decided through decideHumanTask() with the same
// p_reason_code / p_note the desktop queue sends. There is no mobile decision
// path: decide_human_task carries the group-B guard, writes the audit event
// server-side, and returns NULL on an already-decided task. A shortcut RPC
// "just for mobile" would bypass all three.
//
// ⚠ A ROUTE, NOT A BREAKPOINT. Its own Page key, so no desktop layout is ever
// asked to reflow to 375px. Anything outside decisions, alerts and today says
// so plainly rather than rendering broken.
import { useCallback, useEffect, useState } from 'react';
import { Button, Chip, Modal, INPUT_CLS } from '../../../design/primitives';
import { LiveLoadingSkeleton, LiveErrorNotice } from '../../../components/LiveDataStates';
import { useAuth } from '../../../context/AuthContext';
import {
  listHumanTasks, decideHumanTask, listActivity, DECISION_REASON_CODES,
} from '../../../lib/customerApi';
import type {
  DBHumanTask, HumanTaskType, ActivityEvent, DecisionReasonCode,
} from '../../../lib/customerApi';
import { listConnectors, connectorHealth, connectorErrorLabel } from '../../../lib/connectorApi';
import type { Connector } from '../../../lib/connectorApi';
import { getPushState, enablePush, disablePush } from '../../../lib/pushClient';
import type { PushState } from '../../../lib/pushClient';
import type { Page } from '../../../types';

// ⚠ APPROVING SOMETHING YOU HAVE NOT READ is the failure this product exists
// to prevent, so a task carrying DRAFTED CONTENT never gets an inline
// Approve — it gets "Read it", which opens the detail first. Only tasks whose
// decision rests on facts visible on the card itself can be approved in one
// tap. This list is the reason the phone shell cannot be a thinner desktop.
const READ_FIRST: HumanTaskType[] = [
  'review_gate', 'knowledge_revision', 'inquiry_review', 'training_feedback',
  'escalation', 'checklist', 'trust_demotion_notice',
];
const readFirst = (t: DBHumanTask) => READ_FIRST.includes(t.type);

function ago(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} ${hrs === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

export default function MobileShell({ setPage }: { setPage: (p: Page) => void }) {
  const { liveTenantName, authedUser } = useAuth();
  const [tab, setTab] = useState<'decisions' | 'today'>('decisions');
  const [tasks, setTasks] = useState<DBHumanTask[]>([]);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [sayNo, setSayNo] = useState<DBHumanTask | null>(null);
  const [reasonCode, setReasonCode] = useState<DecisionReasonCode | ''>('');
  const [note, setNote] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  // Push pings (spec 2026-08-10). null = still detecting; 'busy' = mid-toggle.
  const [push, setPush] = useState<PushState | 'busy' | null>(null);
  useEffect(() => { void getPushState().then(setPush).catch(() => setPush('unsupported')); }, []);
  const togglePush = async () => {
    setPush('busy');
    try { setPush(push === 'on' ? await disablePush() : await enablePush()); }
    catch (e) { setToast(e instanceof Error ? e.message : 'Could not change notifications.'); setPush(await getPushState().catch(() => 'unsupported' as const)); }
  };

  const load = useCallback(async () => {
    setError(null);
    try {
      const [t, a, c] = await Promise.all([listHumanTasks(), listActivity(30), listConnectors()]);
      setTasks(t); setActivity(a); setConnectors(c);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your decisions.');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // listHumanTasks returns every task; the queue is the pending ones, oldest
  // last (the query orders created_at descending) — same filter as desktop.
  const pending = tasks.filter(t => t.status === 'pending');
  const oldest = pending[pending.length - 1];
  const broken = connectors.filter(c => {
    const h = connectorHealth(c);
    return h === 'down' || h === 'degraded';
  });
  const open = openIdx !== null ? pending[openIdx] : undefined;

  const decide = async (task: DBHumanTask, decision: 'approved' | 'rejected',
                        capture?: { reasonCode?: DecisionReasonCode; note?: string }) => {
    setBusy(true);
    try {
      await decideHumanTask(task, decision, capture);
      setToast(decision === 'approved' ? 'Approved and sent.' : 'Declined — the employee has been told why.');
      setOpenIdx(null); setSayNo(null); setReasonCode(''); setNote('');
      await load();
    } catch (e) {
      // ⚠ SAY WHAT FAILED. A silent catch here means a person taps Approve on
      // a $15,600 invoice, sees the sheet close, and believes it went out.
      setToast(e instanceof Error ? e.message : 'That did not go through — nothing was decided.');
    } finally { setBusy(false); }
  };

  const shell = (body: React.ReactNode) => (
    <div className="min-h-screen bg-dt-page text-dt-body flex flex-col">
      {body}
      {openIdx === null && (
        <nav className="sticky bottom-0 mt-auto flex border-t border-dt-border bg-dt-panel pb-[34px]">
          {([['decisions', '✋', 'Decisions'], ['today', '≡', 'Today']] as const).map(([key, icon, label]) => (
            <button key={key} onClick={() => setTab(key)} aria-current={tab === key}
              className={`flex-1 min-h-[52px] flex flex-col items-center justify-center gap-0.5 text-[14px] ${
                tab === key ? 'text-dt-accent-text' : 'text-dt-muted'}`}>
              <span aria-hidden className="text-[17px]">{icon}</span>{label}
            </button>
          ))}
        </nav>
      )}
    </div>
  );

  if (loading) return shell(<div className="p-5"><LiveLoadingSkeleton rows={4} /></div>);
  if (error) return shell(<div className="p-5"><LiveErrorNotice message={error} onRetry={() => void load()} /></div>);

  // ── One decision, read properly ──
  if (open) {
    return shell(
      <div className="flex-1 flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-dt-border">
          <button onClick={() => setOpenIdx(null)}
            className="min-h-[44px] px-1 text-[16px] text-dt-support">← Back</button>
          <span className="text-[14px] text-dt-muted">{openIdx! + 1} of {pending.length}</span>
        </div>
        <div className="p-5 space-y-5 flex-1">
          <h1 className="text-[22px] font-semibold text-dt-title leading-snug">{open.title}</h1>
          <div>
            <p className="text-[14px] text-dt-muted mb-1">Why it stopped</p>
            <p className="text-[16px] text-dt-body leading-relaxed">{open.detail}</p>
          </div>
          <div className="rounded-xl border border-dt-border bg-dt-card divide-y divide-dt-border">
            {[
              ['Raised', ago(open.created_at)],
              ['Kind', open.type.replace(/_/g, ' ')],
              ['Started by', open.source === 'de' ? 'One of your employees' : open.source === 'chat' ? 'A conversation' : 'The system'],
            ].map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-4 px-4 py-3">
                <span className="text-[14px] text-dt-muted">{k}</span>
                <span className="text-[16px] text-dt-body text-right">{v}</span>
              </div>
            ))}
          </div>
          {toast && <p className="text-[15px] text-dt-warn">{toast}</p>}
        </div>
        <div className="sticky bottom-0 p-4 pb-[34px] space-y-2 border-t border-dt-border bg-dt-panel">
          <Button kind="primary" size="touch" className="w-full justify-center" disabled={busy}
            onClick={() => void decide(open, 'approved')}>
            {busy ? 'Sending…' : 'Approve and send it'}
          </Button>
          <div className="flex gap-2">
            <Button size="touch" className="flex-1 justify-center" disabled={busy}
              onClick={() => setOpenIdx(null)}>Not now</Button>
            <Button size="touch" className="flex-1 justify-center" disabled={busy}
              onClick={() => { setSayNo(open); setReasonCode(''); setNote(''); }}>Say no</Button>
          </div>
        </div>
        {sayNo && <SayNoSheet task={sayNo} busy={busy} reasonCode={reasonCode} note={note}
          onReason={setReasonCode} onNote={setNote} onCancel={() => setSayNo(null)}
          onConfirm={() => void decide(sayNo, 'rejected', { reasonCode: reasonCode as DecisionReasonCode, note: note.trim() || undefined })} />}
      </div>,
    );
  }

  // ── Today, read-only ──
  if (tab === 'today') {
    const byYou = activity.filter(a => a.actor_type === 'human').length;
    const pct = activity.length ? Math.round(((activity.length - byYou) / activity.length) * 100) : 100;
    return shell(
      <div className="flex-1 p-5 space-y-5">
        <h1 className="text-[22px] font-semibold text-dt-title">Today</h1>
        <div className="grid grid-cols-2 gap-3">
          <Tile n={String(activity.length)} label="handled" />
          <Tile n={`${pct}%`} label="without you" />
        </div>
        {activity.length === 0
          ? <p className="text-[16px] text-dt-support">Nothing has happened yet today.</p>
          : (
            <ul className="divide-y divide-dt-border rounded-xl border border-dt-border bg-dt-card">
              {activity.map(a => (
                <li key={a.id} className="px-4 py-3">
                  <p className="text-[16px] text-dt-body leading-snug">
                    <span className="font-medium">{a.actor_type === 'human' ? 'You' : a.actor}</span>{' '}{a.text}
                  </p>
                  <p className="text-[14px] text-dt-muted mt-0.5">{ago(a.created_at)}</p>
                </li>
              ))}
            </ul>
          )}
        <BiggerScreen setPage={setPage} />
      </div>,
    );
  }

  // ── Decisions ──
  return shell(
    <div className="flex-1 p-5 space-y-4">
      <header className="flex items-center gap-3">
        <span aria-hidden className="w-9 h-9 rounded-full bg-dt-accent-soft text-dt-accent-text grid place-items-center text-[16px] font-semibold">
          {(liveTenantName ?? authedUser?.name ?? '?').charAt(0).toUpperCase()}
        </span>
        <span className="text-[16px] text-dt-support">{liveTenantName ?? 'Your workspace'}</span>
      </header>

      {pending.length === 0 ? (
        <div className="py-8">
          <h1 className="text-[24px] font-semibold text-dt-title">All clear</h1>
          <p className="text-[16px] text-dt-support mt-1">
            Nothing needs you. Tap Today to see how the day has gone.
          </p>
        </div>
      ) : (
        <div>
          <h1 className="text-[24px] font-semibold text-dt-title">
            {pending.length} {pending.length === 1 ? 'thing needs' : 'things need'} you
          </h1>
          {oldest && (
            <p className="text-[16px] text-dt-support mt-1">
              The oldest has been waiting {ago(oldest.created_at).replace(' ago', '')}.
            </p>
          )}
        </div>
      )}

      {toast && <p className="text-[15px] text-dt-warn">{toast}</p>}

      {/* Push pings — one honest state per platform reality, never a button
          that cannot work (iOS Safari without install has no Push API). */}
      {push !== null && push !== 'unsupported' && (
        <div className="rounded-xl border border-dt-border bg-dt-card p-4">
          {push === 'on' ? (
            <div className="flex items-center justify-between gap-3">
              <p className="text-[15px] text-dt-body">Pings are on for this phone.</p>
              <Button kind="ghost" size="touch" onClick={() => void togglePush()}>Turn off</Button>
            </div>
          ) : push === 'ios_needs_install' ? (
            <p className="text-[15px] text-dt-support leading-relaxed">
              To get decision pings on iPhone, first add this app to your home
              screen: <span className="text-dt-body">Share → Add to Home Screen</span>,
              then open it from there and turn notifications on.
            </p>
          ) : push === 'denied' ? (
            <p className="text-[15px] text-dt-support leading-relaxed">
              Notifications are blocked for this site in your phone's settings —
              allow them there, then come back.
            </p>
          ) : (
            <>
              <p className="text-[15px] text-dt-support mb-2">
                Get a ping the moment a decision needs you — every one, instantly.
              </p>
              <Button kind="primary" size="touch" className="w-full justify-center"
                disabled={push === 'busy'} onClick={() => void togglePush()}>
                {push === 'busy' ? 'Setting up…' : 'Turn on notifications'}
              </Button>
            </>
          )}
        </div>
      )}

      <ul className="space-y-3">
        {pending.map((t, i) => (
          <li key={t.id} className="rounded-xl border border-dt-border bg-dt-card p-4">
            <p className="text-[17px] font-medium text-dt-title leading-snug">{t.title}</p>
            <p className="text-[15px] text-dt-support mt-1 leading-relaxed">{t.detail}</p>
            <p className="text-[14px] text-dt-muted mt-2">{ago(t.created_at)}</p>
            <div className="flex gap-2 mt-3">
              {readFirst(t) ? (
                <Button kind="primary" size="touch" className="flex-1 justify-center"
                  onClick={() => setOpenIdx(i)}>Read it</Button>
              ) : (
                <>
                  <Button kind="primary" size="touch" className="flex-1 justify-center" disabled={busy}
                    onClick={() => void decide(t, 'approved')}>Approve</Button>
                  <Button size="touch" className="flex-1 justify-center"
                    onClick={() => setOpenIdx(i)}>Details</Button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>

      {broken.length > 0 && (
        <ul className="space-y-3 pt-1">
          {broken.map(c => (
            <li key={c.id} className="rounded-xl border border-dt-warn-border bg-dt-warn-soft p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="text-[17px] font-medium text-dt-title leading-snug">
                  {c.display_name || c.provider} {connectorHealth(c) === 'down' ? 'is disconnected' : 'is failing'}
                </p>
                <Chip tone={connectorHealth(c) === 'down' ? 'danger' : 'warn'}>
                  {connectorHealth(c) === 'down' ? 'Down' : 'Degraded'}
                </Chip>
              </div>
              <p className="text-[15px] text-dt-support mt-1 leading-relaxed">
                {connectorErrorLabel(c.last_error)}
                {c.last_error_at ? ` · since ${ago(c.last_error_at)}` : ''}
              </p>
              <p className="text-[14px] text-dt-muted mt-2">
                Reconnecting it needs a bigger screen — it is waiting for you at a desk.
              </p>
            </li>
          ))}
        </ul>
      )}

      <BiggerScreen setPage={setPage} />
    </div>,
  );
}

/** ⚠ THE ROUTE ALONE WOULD HAVE BEEN UNREACHABLE. Nobody types /m — they open
 *  the app on their phone, land on a desktop layout at 375px, and conclude the
 *  product does not work on mobile. So a narrow viewport on any other page
 *  gets this instead of a broken screen, which is also what the handoff asks
 *  for ("never a broken layout").
 *
 *  It OFFERS rather than redirects: someone on a small laptop or a tablet who
 *  genuinely wants the full app can say so and is not asked again. Hijacking
 *  the route would trade one broken experience for another. */
export function useNeedsBiggerScreen(currentPage: Page) {
  const [narrow, setNarrow] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const sync = () => setNarrow(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  return {
    blocked: narrow && !dismissed && currentPage !== 'mobile',
    dismiss: () => setDismissed(true),
  };
}

/** ⚠ RENDERED INSTEAD OF THE PAGE, not over it. The first version was a
 *  `fixed inset-0` overlay and design-drift.mjs was right to fail it: covering
 *  a broken layout still renders the broken layout underneath, still runs its
 *  data fetches, and still lets a stray scroll reveal it. The handoff says
 *  "never a broken layout", so the page simply does not mount. */
export function BiggerScreenTakeover({ onPhoneView, onCarryOn }: {
  onPhoneView: () => void; onCarryOn: () => void;
}) {
  return (
    <div className="min-h-screen bg-dt-page p-6 flex flex-col justify-center gap-4">
      <h1 className="text-[24px] font-semibold text-dt-title">This needs a bigger screen</h1>
      <p className="text-[16px] text-dt-support leading-relaxed">
        This screen is built for a desk. There is a phone view for the things
        that genuinely cannot wait — decisions waiting on you, anything broken,
        and how the day has gone.
      </p>
      <Button kind="primary" size="touch" className="w-full justify-center"
        onClick={onPhoneView}>Open the phone view</Button>
      <Button size="touch" className="w-full justify-center"
        onClick={onCarryOn}>Carry on to the full app</Button>
    </div>
  );
}

function Tile({ n, label }: { n: string; label: string }) {
  return (
    <div className="rounded-xl border border-dt-border bg-dt-card p-4">
      <p className="text-[26px] font-semibold text-dt-title tabular-nums">{n}</p>
      <p className="text-[14px] text-dt-muted mt-0.5">{label}</p>
    </div>
  );
}

/** The honest edge of this surface. Everything else is a real screen that
 *  would be unusable at 375px, so it says so instead of rendering broken. */
function BiggerScreen({ setPage }: { setPage: (p: Page) => void }) {
  return (
    <div className="rounded-xl border border-dt-border bg-dt-inset p-4 mt-2">
      <p className="text-[15px] text-dt-support leading-relaxed">
        Knowledge, playbooks, people and settings need a bigger screen. They are
        not cut down here — they are waiting for you at a desk.
      </p>
      <Button size="touch" className="w-full justify-center mt-3"
        onClick={() => setPage('dashboard')}>Open the full view anyway</Button>
    </div>
  );
}

/** ⚠ The SAME reason codes the desktop queue sends. The server requires one on
 *  every rejection, and these become the training signal — a mobile-only free
 *  text box would have quietly broken that loop. */
function SayNoSheet({ task, busy, reasonCode, note, onReason, onNote, onCancel, onConfirm }: {
  task: DBHumanTask; busy: boolean; reasonCode: DecisionReasonCode | ''; note: string;
  onReason: (c: DecisionReasonCode) => void; onNote: (s: string) => void;
  onCancel: () => void; onConfirm: () => void;
}) {
  const needsNote = reasonCode === 'other';
  const ready = reasonCode !== '' && (!needsNote || note.trim().length > 0);
  return (
    <Modal onClose={onCancel} title="Why are you saying no?">
      <p className="text-[15px] text-dt-support mb-3 leading-relaxed">{task.title}</p>
      <div className="space-y-2">
        {DECISION_REASON_CODES.map(rc => (
          <button key={rc.code} onClick={() => onReason(rc.code)}
            className={`w-full text-left min-h-[52px] px-4 rounded-xl border text-[16px] ${
              reasonCode === rc.code
                ? 'border-dt-accent bg-dt-accent-soft text-dt-accent-text'
                : 'border-dt-border bg-dt-card text-dt-body'}`}>
            {rc.label}
          </button>
        ))}
      </div>
      {needsNote && (
        <textarea value={note} onChange={e => onNote(e.target.value)} rows={3}
          aria-label="Say why" placeholder="Say why, in a sentence."
          className={`${INPUT_CLS} mt-3 text-[16px]`} />
      )}
      <div className="flex gap-2 mt-4">
        <Button size="touch" className="flex-1 justify-center" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button kind="danger" size="touch" className="flex-1 justify-center"
          onClick={onConfirm} disabled={!ready || busy}>
          {busy ? 'Sending…' : 'Say no'}
        </Button>
      </div>
    </Modal>
  );
}
