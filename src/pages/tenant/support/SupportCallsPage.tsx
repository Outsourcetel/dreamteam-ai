import { useState, useEffect, useCallback } from 'react';
import type { Page } from '../../../types';
import { listVoiceCalls, listOrphanVoiceMessages } from '../../../lib/voiceApi';
import type { VoiceCall, VoiceCallMessage } from '../../../lib/voiceApi';
import { LiveLoadingSkeleton, LiveErrorNotice } from '../../../components/LiveDataStates';
import { Button, Chip, EmptyState, PanelCard, StatTile, Banner } from '../../../design/primitives';
import { presentError } from '../../../lib/presentError';
import { timeAgoLong } from '../../../lib/dateFormat';

// ============================================================
// Calls — review what the voice channel actually did (docs/42).
//
// Everything here was already being captured and had no reader: the call as a
// unit of work, its transcript and recording pointer in the audit chain, and
// the messages callers left. Before this page they surfaced only as a row
// reading "Phone call" in the generic activity feed — indistinguishable from a
// typed question, with the transcript invisible.
//
// Read-only by design. Acting on a call happens where action already lives:
// the callback task in the review queue (mig 577). This page is for judging
// whether the employee handled the call well, which is what a voice
// certification will eventually be graded on.
// ============================================================

function duration(sec: number | null): string {
  if (sec == null) return '—';
  const s = Math.round(sec);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

const when = timeAgoLong;

/** A transcript is a dialogue; rendering it as a paragraph makes it unreadable
 *  and hides who said what — which is the whole point of reviewing a call. */
function Transcript({ text }: { text: string }) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return (
    <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
      {lines.map((line, i) => {
        const m = line.match(/^(AI|User|Assistant|Caller|Bot)\s*:\s*(.*)$/i);
        const who = m ? m[1].toLowerCase() : null;
        const body = m ? m[2] : line;
        const isAI = who === 'ai' || who === 'assistant' || who === 'bot';
        return (
          <div key={i} className="flex gap-2 text-sm">
            <span className={`shrink-0 text-[10px] uppercase tracking-wide pt-0.5 w-12 ${isAI ? 'text-dt-accent-text' : 'text-dt-muted'}`}>
              {who ? (isAI ? 'DE' : 'Caller') : ''}
            </span>
            <span className={isAI ? 'text-dt-body' : 'text-dt-support'}>{body}</span>
          </div>
        );
      })}
    </div>
  );
}

function MessageRow({ m }: { m: VoiceCallMessage }) {
  const done = m.task_status === 'approved';
  return (
    <div className="rounded-lg border border-dt-border bg-dt-inset p-3">
      <div className="flex items-center justify-between gap-3 mb-1">
        <span className="text-sm font-medium text-dt-body">
          {m.caller_name || 'A caller'}
          {m.caller_phone && <span className="text-dt-muted font-normal"> · {m.caller_phone}</span>}
        </span>
        {m.task_status === null
          ? <Chip tone="danger">NO CALLBACK TASK</Chip>
          : done ? <Chip tone="ok">CALLED BACK</Chip> : <Chip tone="warn">AWAITING CALLBACK</Chip>}
      </div>
      <p className="text-sm text-dt-support">{m.message}</p>
    </div>
  );
}

function CallCard({ c }: { c: VoiceCall }) {
  const [open, setOpen] = useState(false);
  return (
    <PanelCard
      title={c.inquiry}
      badge={<Chip tone="neutral">{duration(c.duration_seconds)}</Chip>}
      actions={
        <div className="flex items-center gap-2">
          {c.recording_url && (
            <a href={c.recording_url} target="_blank" rel="noopener noreferrer">
              <Button kind="secondary" size="sm">Recording</Button>
            </a>
          )}
          {(c.transcript || c.messages.length > 0) && (
            <Button kind="secondary" size="sm" onClick={() => setOpen((v) => !v)}>
              {open ? 'Hide' : 'Transcript'}
            </Button>
          )}
        </div>
      }
    >
      <p className="text-sm text-dt-support">{c.summary}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-dt-muted">
        <span>{when(c.created_at)}</span>
        {c.de_name && <span>· answered by {c.de_name}</span>}
        {c.messages.length > 0 && <span>· {c.messages.length} message{c.messages.length === 1 ? '' : 's'} left</span>}
        {!c.transcript && <span>· no transcript captured</span>}
      </div>

      {c.messages.length > 0 && (
        <div className="mt-3 space-y-2">
          {c.messages.map((m) => <MessageRow key={m.id} m={m} />)}
        </div>
      )}

      {open && (
        <div className="mt-3 pt-3 border-t border-dt-border">
          {c.transcript
            ? <Transcript text={c.transcript} />
            : <p className="text-xs text-dt-muted">No transcript was captured for this call — the platform never posted an end-of-call report.</p>}
        </div>
      )}
    </PanelCard>
  );
}

const SupportCallsPage = ({ setPage, embedded }: { setPage: (p: Page) => void; embedded?: boolean }) => {
  const [calls, setCalls] = useState<VoiceCall[]>([]);
  const [orphans, setOrphans] = useState<VoiceCallMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [c, o] = await Promise.all([listVoiceCalls(), listOrphanVoiceMessages()]);
      setCalls(c); setOrphans(o);
    } catch (e) {
      setError(presentError(e, 'Could not load calls.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const totalMessages = calls.reduce((n, c) => n + c.messages.length, 0) + orphans.length;
  const awaiting = [...calls.flatMap((c) => c.messages), ...orphans]
    .filter((m) => m.task_status === 'pending').length;
  const totalSec = calls.reduce((n, c) => n + (c.duration_seconds ?? 0), 0);

  const body = (
    <div className="px-6 pb-10 space-y-5">
      {error && <LiveErrorNotice message={error} onRetry={() => void refresh()} />}

      {loading ? <LiveLoadingSkeleton rows={4} /> : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatTile label="Calls handled" value={calls.length} />
            <StatTile label="Time on the phone" value={duration(totalSec || null)} />
            <StatTile label="Messages taken" value={totalMessages} />
            <StatTile
              label="Awaiting callback"
              value={awaiting}
              tone={awaiting > 0 ? 'warn' : undefined}
              sub={awaiting > 0 ? 'someone is waiting' : 'nobody waiting'}
              onClick={() => setPage('ops_human_tasks')}
            />
          </div>

          {orphans.length > 0 && (
            <PanelCard title="Messages from calls with no completed record">
              <Banner tone="info">
                These callers left a message but the platform never posted an end-of-call report for
                their call — usually a hang-up. The message and its callback task still stand.
              </Banner>
              <div className="mt-3 space-y-2">
                {orphans.map((m) => <MessageRow key={m.id} m={m} />)}
              </div>
            </PanelCard>
          )}

          {calls.length === 0 && orphans.length === 0 ? (
            <EmptyState
              icon="📞"
              headline="No calls yet"
              action={<Button kind="secondary" onClick={() => void refresh()}>Refresh</Button>}
            >
              When a Digital Employee answers the phone, the call lands here with its summary,
              transcript, recording and anything the caller asked for.
            </EmptyState>
          ) : (
            <div className="space-y-3">
              {calls.map((c) => <CallCard key={c.id} c={c} />)}
            </div>
          )}
        </>
      )}
    </div>
  );

  if (embedded) return <div className="flex-1 overflow-y-auto pt-5">{body}</div>;
  return (
    <div className="flex-1 overflow-y-auto bg-dt-page text-dt-body">
      <div className="px-6 pt-8 pb-4">
        <h1 className="text-2xl font-semibold text-dt-title">Calls</h1>
        <p className="text-sm text-dt-support mt-1 max-w-2xl">
          Every phone call the workforce handled — what was said, what was promised, and whether
          anyone has followed up.
        </p>
      </div>
      {body}
    </div>
  );
};

export default SupportCallsPage;
