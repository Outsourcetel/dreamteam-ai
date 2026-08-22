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
  getPendingConversationDraft,
} from '../../../lib/customerApi';
import type {
  DBHumanTask, HumanTaskType, ActivityEvent, DecisionReasonCode,
  PendingConversationDraft,
} from '../../../lib/customerApi';
import { listConnectors, connectorHealth, connectorErrorLabel } from '../../../lib/connectorApi';
import type { Connector } from '../../../lib/connectorApi';
import { getPushState, enablePush, disablePush } from '../../../lib/pushClient';
import type { PushState } from '../../../lib/pushClient';
import type { Page } from '../../../types';
// Task 6 fix round 1 (2026-08-21): NO SECOND SOURCE OF TRUTH applies to what
// a decision is INFORMED by, not only to how it is written. This screen calls
// the exact same decideHumanTask() desktop does, so it must show the exact
// same evidence desktop now does for a trust_promotion task — same reader,
// same pure module (tests/trust-promotion.test.ts already proves it).
import { getTrustPolicyById } from '../../../lib/trustApi';
import type { TrustPolicy } from '../../../lib/trustApi';
import { trustPromotionCardCopy, isThinTrustEvidence, extractPolicyEvidence, detailIsRedundantBesideCard } from '../../../lib/trustPromotionPresentation';
import { listDigitalEmployees } from '../../../lib/digitalEmployeesApi';
import { presentError } from '../../../lib/presentError';
import { timeAgoLong } from '../../../lib/dateFormat';

// ⚠ APPROVING SOMETHING YOU HAVE NOT READ is the failure this product exists
// to prevent, so a task carrying DRAFTED CONTENT never gets an inline
// Approve — it gets "Read it", which opens the detail first. Only tasks whose
// decision rests on facts visible on the card itself can be approved in one
// tap. This list is the reason the phone shell cannot be a thinner desktop.
//
// trust_promotion (fix round 1, 2026-08-21 — coordinator review): WIDENING
// what an employee may do belongs here for the same reason
// trust_demotion_notice already did — the list was backwards on risk, since
// demotion (the safe direction) required the read and promotion did not. The
// facts a promotion decision rests on (the evidence behind it, and whether it
// is thin) are not on the list card — they load only once "Read it" is
// opened, same as the reader in HumanTasksPage.tsx's detail panel.
const READ_FIRST: HumanTaskType[] = [
  'review_gate', 'knowledge_revision', 'inquiry_review', 'training_feedback',
  'escalation', 'checklist', 'trust_demotion_notice', 'trust_promotion',
];
const readFirst = (t: DBHumanTask) => READ_FIRST.includes(t.type);

const ago = (iso: string) => timeAgoLong(iso);

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
  // ⚠ A TOAST CARRIES A TONE, because this one used to carry a lie. "Approved
  // and sent." was set from nothing but "the await did not throw" (F-6). Every
  // word below now comes from decision_outcome, which is read back out of the
  // database — and `ok` is false whenever the send did not actually happen, so
  // the message cannot be mistaken for good news at a glance.
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null);
  const say = (text: string, ok = false) => setToast({ text, ok });
  // Push pings (spec 2026-08-10). null = still detecting; 'busy' = mid-toggle.
  const [push, setPush] = useState<PushState | 'busy' | null>(null);
  useEffect(() => { void getPushState().then(setPush).catch(() => setPush('unsupported')); }, []);
  const togglePush = async () => {
    setPush('busy');
    try { setPush(push === 'on' ? await disablePush() : await enablePush()); }
    catch (e) { say(e instanceof Error ? e.message : 'Could not change notifications.'); setPush(await getPushState().catch(() => 'unsupported' as const)); }
  };

  const load = useCallback(async () => {
    setError(null);
    try {
      const [t, a, c] = await Promise.all([listHumanTasks(), listActivity(30), listConnectors()]);
      setTasks(t); setActivity(a); setConnectors(c);
    } catch (e) {
      setError(presentError(e, 'Could not load your decisions.'));
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

  // ⚠ READ IT BEFORE YOU SEND IT. Approving a gated reply now genuinely
  // delivers it (mig 721), so the person must see the words that will reach
  // the customer — not the 240-character summary the task title carries.
  // `undefined` = still looking; `null` = this task drafts nothing.
  const [draft, setDraft] = useState<PendingConversationDraft | null | undefined>(null);
  const openConvId = open?.related_table === 'de_conversations' ? open.related_id : null;
  useEffect(() => {
    if (!openConvId) { setDraft(null); return; }
    let alive = true;
    setDraft(undefined);
    void getPendingConversationDraft(openConvId)
      .then(d => { if (alive) setDraft(d); })
      .catch(() => { if (alive) setDraft(null); });
    return () => { alive = false; };
  }, [openConvId]);

  // The evidence behind a trust_promotion request — same reader as the
  // desktop ops queue (HumanTasksPage.tsx), same reason: the task's own row
  // carries no evidence, only trust_policies.pending_evidence does. Raw data
  // only; the card copy is derived inline below, next to `open`, rather than
  // stored — same discipline as `draft` above.
  // ⚠ FIX ROUND 2 (coordinator review): tri-state, not a resolved value plus
  // a separate boolean — the SAME shape `draft` two hundred lines above
  // already uses, for the reason its own comment gives ("`undefined` = still
  // looking"). `trustPolicy` used to start at `null` with a SEPARATE
  // `trustLoading` flag that also started `false` — both resolved,
  // settled-looking values — so for one real, user-visible frame between a
  // task being opened and this effect's async fetch resolving, the screen
  // could show "No trust policy is linked — approving would change nothing"
  // with Approve tappable. `undefined` now means exactly "still looking",
  // present on the very first render, no gap for a false claim to render in.
  const [trustPolicy, setTrustPolicy] = useState<TrustPolicy | null | undefined>(undefined);
  const [trustEmployeeName, setTrustEmployeeName] = useState<string | null>(null);
  const [trustLoadError, setTrustLoadError] = useState<string | null>(null);
  useEffect(() => {
    setTrustPolicy(undefined); setTrustEmployeeName(null); setTrustLoadError(null);
    if (!open || open.type !== 'trust_promotion' || !open.related_id) return;
    let alive = true;
    void getTrustPolicyById(open.related_id)
      .then(async policy => {
        if (!alive) return;
        setTrustPolicy(policy);
        // human_tasks carries no de_id for this type — only related_id, to
        // trust_policies. A tenant-scoped policy (de_id null) names no single
        // employee; the card falls back to naming the workspace instead.
        if (policy?.de_id) {
          try {
            const des = await listDigitalEmployees(true); // include retired — still the right name
            if (alive) {
              const de = des.find(d => d.id === policy.de_id);
              setTrustEmployeeName(de ? (de.persona_name || de.name) : null);
            }
          } catch { /* falls back to the workspace phrasing below */ }
        }
      })
      .catch(err => {
        if (!alive) return;
        setTrustLoadError(presentError(err, 'Could not load the evidence behind this request.'));
        // Settle OUT of "loading" on failure too — a network hiccup must not
        // leave Approve disabled forever.
        setTrustPolicy(null);
      });
    return () => { alive = false; };
  }, [open?.id, open?.type, open?.related_id]);

  const trustEvidence = trustPolicy ? extractPolicyEvidence(trustPolicy.pending_evidence) : null;
  const trustCopy = (trustPolicy && trustEvidence) ? trustPromotionCardCopy({
    employeeName: trustEmployeeName || 'This workspace',
    category: trustPolicy.action_category,
    currentLevel: trustPolicy.current_level,
    targetLevel: trustPolicy.target_level,
    evidence: trustEvidence,
    ladder: trustPolicy.effective_ladder ?? null,
  }) : null;
  const trustThin = trustEvidence ? isThinTrustEvidence(trustEvidence) : false;
  const trustLoading = open?.type === 'trust_promotion' && trustPolicy === undefined;
  // ⚠ FINAL REVIEW (2026-08-21): identical rule to the desktop ops queue, from
  // the SAME shared predicate — the "Why it stopped" paragraph below renders
  // the raw task.detail above the evidence card, and for a criteria-shaped
  // request that is the SQL-composed sentence the card supersedes, promising a
  // cap the trust ladder does not grant. Suppressed only when the card
  // actually rendered AND the evidence carries no cited decisions; a
  // pattern-shaped proposal keeps its detail, because the receipts live
  // nowhere else. See detailIsRedundantBesideCard's own header.
  const trustDetailRedundant = open?.type === 'trust_promotion'
    && !!trustCopy
    && detailIsRedundantBesideCard(trustPolicy?.pending_evidence);

  const decide = async (task: DBHumanTask, decision: 'approved' | 'rejected',
                        capture?: { reasonCode?: DecisionReasonCode; note?: string }) => {
    setBusy(true);
    try {
      const { decision_outcome: o } = await decideHumanTask(task, decision, capture);
      // ⚠ EVERY WORD HERE IS QUOTED FROM THE ROW. This is the F-6 fix's client
      // half: the RPC resolving proves only that it was called. `decided` is
      // false when nothing transitioned; `delivered` is true only when the
      // consequence was re-read and confirmed.
      if (!o.decided) say(o.detail ?? 'Nothing changed.');
      else if (decision === 'rejected') say('Declined — the employee has been told why. Nothing was sent.', true);
      else if (o.consequence === 'none') say('Approved.', true);
      else if (o.delivered) say('Approved and sent.', true);
      else say(o.detail ?? 'Approved, but nothing was sent.');
      setOpenIdx(null); setSayNo(null); setReasonCode(''); setNote('');
      await load();
    } catch (e) {
      // ⚠ SAY WHAT FAILED. A silent catch here means a person taps Approve on
      // a $15,600 invoice, sees the sheet close, and believes it went out.
      say(e instanceof Error ? e.message : 'That did not go through — nothing was decided.');
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
          {!trustDetailRedundant && (
            <div>
              <p className="text-[14px] text-dt-muted mb-1">Why it stopped</p>
              <p className="text-[16px] text-dt-body leading-relaxed">{open.detail}</p>
            </div>
          )}
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
          {/* Task 6 fix round 1: the evidence behind a trust_promotion
              request, read the same way the desktop ops queue reads it.
              Thin evidence is RAISED, not suppressed (founder ruling) — this
              never hides a no-history request, it says so, in the sentence
              and in the chip. */}
          {open.type === 'trust_promotion' && (
            <div>
              <div className="flex items-center justify-between gap-2 mb-1">
                <p className="text-[14px] text-dt-muted">Evidence behind this request</p>
                {trustThin && <Chip tone="warn">Thin evidence</Chip>}
              </div>
              {trustLoading ? (
                <p className="text-[16px] text-dt-support leading-relaxed">Loading the evidence behind this request…</p>
              ) : trustLoadError ? (
                <p className="text-[16px] text-dt-warn leading-relaxed">{trustLoadError}</p>
              ) : !trustPolicy ? (
                <p className="text-[16px] text-dt-support leading-relaxed">No trust policy is linked to this request — approving would change nothing.</p>
              ) : !trustCopy ? (
                <p className="text-[16px] text-dt-support leading-relaxed">This request carries no readable evidence snapshot.</p>
              ) : (
                <>
                  <p className="text-[16px] text-dt-body leading-relaxed rounded-xl border border-dt-border bg-dt-card p-4">
                    {trustCopy.detail}
                  </p>
                  <p className="text-[14px] text-dt-muted mt-1.5">{trustCopy.meta}</p>
                </>
              )}
            </div>
          )}
          {draft && (
            <div>
              <p className="text-[14px] text-dt-muted mb-1">
                {draft.deliverable
                  ? 'What will be sent to the customer'
                  : 'The reply that is waiting — approving here will NOT send it'}
              </p>
              <p className="text-[16px] text-dt-body leading-relaxed whitespace-pre-wrap rounded-xl border border-dt-border bg-dt-card p-4">
                {draft.content}
              </p>
              {!draft.deliverable && (
                <p className="text-[14px] text-dt-warn mt-2 leading-relaxed">
                  This {draft.channel} conversation goes out through the
                  outbound queue. Approving records your decision; sending it
                  needs the Support inbox at a desk.
                </p>
              )}
            </div>
          )}
          {toast && <p className={`text-[15px] ${toast.ok ? 'text-dt-support' : 'text-dt-warn'}`}>{toast.text}</p>}
        </div>
        <div className="sticky bottom-0 p-4 pb-[34px] space-y-2 border-t border-dt-border bg-dt-panel">
          {/* ⚠ THE BUTTON SAYS WHAT IT DOES. It read "Approve and send it" on
              every task in the queue, including the ones that send nothing —
              which is how F-6 read as normal behaviour for a day. */}
          <Button kind="primary" size="touch" className="w-full justify-center"
            disabled={busy || draft === undefined || (open.type === 'trust_promotion' && trustLoading)}
            onClick={() => void decide(open, 'approved')}>
            {busy ? 'Sending…'
              : draft === undefined ? 'Checking…'
              : open.type === 'trust_promotion' && trustLoading ? 'Checking…'
              : draft?.deliverable ? 'Approve and send it'
              : 'Approve'}
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

      {toast && (
        <p className={`text-[15px] leading-relaxed ${toast.ok ? 'text-dt-support' : 'text-dt-warn'}`}>
          {toast.text}
        </p>
      )}

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
