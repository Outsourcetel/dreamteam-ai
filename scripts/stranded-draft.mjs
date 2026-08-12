// ============================================================================
// stranded-draft.mjs — Ring-0: an approval that told a person a reply went out
// when the reply is still sitting in the drafts folder.
//
// WHY THIS EXISTS. F-6 (docs/50 row 95, docs/53 B-1). The phone shell's
// decision card carried a button reading "Approve and send it" and a toast
// reading "Approved and sent." Neither decide path — not the phone, not the
// desktop approvals queue — ever called `approve_draft_reply`, the only code
// in the product that flips a gated reply to `sent`. The consequence lived in
// ONE screen's JavaScript (the Support inbox), so approving from anywhere else
// recorded the decision, wrote the audit event, closed the task, and left the
// customer's answer undelivered.
//
// Measured in production before the fix, and the reason this probe exists in
// data form rather than as a code-shape lint:
//
//     human_tasks      b6cd7764-7aea-4f52-90fc-0ff869ccb5eb  approved 08-11 20:45
//     de_conversations e3c1dfc6-2850-4fbc-bec5-ee29ac18252c  needs_human
//     de_messages      27f98c5a-f286-48ae-aa1c-e0dfb5ace809  draft_pending
//
// ⚠ WHY THE EXISTING RING-0 PROBE COULD NOT SEE IT (docs/50 F-7). The
// unexecutable-approval probe starts every arm from a JOIN to
// `action_executions`. A gated REPLY has no action_execution — its consequence
// is a column on `de_messages`. The whole class was invisible to the gate that
// looks exactly like the gate that should have caught it. This one starts from
// the conversation instead.
//
// ── THE ARMS ───────────────────────────────────────────────────────────────
//
//  1. `stranded` (VIOLATION) — an approved task pointing at a conversation on
//     a self-delivering channel whose reply was drafted BEFORE the decision
//     and is STILL `draft_pending`. That is the defect, stated in rows.
//     Scoped to decisions taken from migration 721 onward. NOT because older
//     rows are acceptable — arm 5 prints every one of them by id — but because
//     a red keyed to history can never go green, and a gate nobody can clear
//     is a gate people learn to ignore.
//
//  2. `mechanism-missing` / `mechanism-disabled` (VIOLATION) — the trigger
//     that makes arm 1 stay green must EXIST, be ENABLED, and be attached to
//     the right event. ⚠ THIS IS THE ARM THAT STOPS THE PROBE BEING THEATRE.
//     Arm 1 finds nothing on a quiet week whether the fix is installed or
//     deleted; those two states must not look alike.
//
//  3. `mechanism-loosened` (VIOLATION) — the two properties that make the fix
//     safe rather than merely present: a REJECTION must not send (a decline
//     that delivers the reply is worse than the original bug), and the channel
//     gate must be an ALLOW-LIST (a deny-list lets a future carrier channel
//     through, which is the same lie one layer down).
//
//  4. `undeliverable-promise` (VIOLATION) — a pending approval on an
//     email-channel conversation that holds a `draft_pending` bubble and NO
//     outbound_drafts row to carry it. Approving cannot deliver it and mig 721
//     deliberately will not pretend otherwise, so the person is being asked to
//     approve a send with nothing behind it.
//
//  5. `note` — the denominators, always. Approved conversation-linked tasks
//     compared, drafts examined, and the pre-fix stranded rows listed by id.
//     ⚠⚠ ZERO FINDINGS FROM ZERO COMPARISONS LOOKS EXACTLY LIKE A CLEAN
//     RESULT. Arm 2 is the standing comparison that is always available, so
//     this probe can never be green from having looked at nothing.
//
// ⚠ THE CHANNEL LIST IS LIFTED FROM THE MIGRATION, NOT PARAPHRASED. It must
// equal the allow-list in `sync_conversation_draft_decision` and the one in
// `customerApi.SELF_DELIVERING_CHANNELS`. Arm 3 reads the live function body
// for exactly this reason: a probe whose rule disagrees with the runtime's
// manufactures findings and misses real ones in the same pass.
// ============================================================================

/** Channels where the customer reads `de_messages` directly, so flipping the
 *  row IS the delivery. Must match migration 721's allow-list. */
export const SELF_DELIVERING_CHANNELS = ['widget', 'hosted', 'portal', 'dock', 'exam'];

export function strandedDraftSql() {
  const channels = SELF_DELIVERING_CHANNELS.map((c) => `'${c}'`).join(', ');
  return `
with fix as (
  -- The boundary for arm 1. If the ledger row is missing the fix is not
  -- installed as far as this probe is concerned, so the boundary becomes
  -- 'the beginning of time' and every stranded row is a violation.
  select coalesce(min(coalesce(applied_at, recorded_at)), '-infinity'::timestamptz) as at
    from public.schema_migrations
   where filename = '721_approving_a_draft_reply_actually_sends_it.sql'
),
trg as (
  select t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) as def, p.prosrc
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_proc  p on p.oid = t.tgfoid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'human_tasks'
     and t.tgname = 'trg_sync_conversation_draft' and not t.tgisinternal
),
-- Every approved decision that pointed at a conversation, with the reply that
-- was already drafted when it was taken. This is the population arm 1 judges.
decided as (
  select h.id as task_id, h.tenant_id, h.decided_at, c.id as conv_id, c.channel,
         m.id as msg_id, m.delivery, m.created_at as drafted_at
    from public.human_tasks h
    join public.de_conversations c on c.id = h.related_id and c.tenant_id = h.tenant_id
    left join public.de_messages m
           on m.conversation_id = c.id
          and m.delivery = 'draft_pending'
          -- <= not <: the draft must have EXISTED when the decision was taken.
          -- A later draft (the customer asked again) is not a stranding. The
          -- boundary case is real — a decision taken in the same transaction as
          -- the draft shares now(), and a strict < silently drops it, which is
          -- how this probe first reported "0 drafts" against a fixture built to
          -- be stranded.
          and m.created_at <= coalesce(h.decided_at, h.updated_at)
   where h.related_table = 'de_conversations'
     and h.status = 'approved'
     and c.channel in (${channels})
)

-- ── ARM 1: the defect itself, since the fix landed ────────────────────────
select format(
    'stranded — task %s (workspace %s) was approved at %s and told a person the reply had gone out; de_messages %s on conversation %s is STILL draft_pending. This is F-6 recurring: the decision path stopped applying the draft consequence.',
    d.task_id, d.tenant_id, d.decided_at, d.msg_id, d.conv_id) as violation,
  null::text as note
from decided d, fix f
where d.msg_id is not null and d.decided_at >= f.at

union all

-- ── ARM 2: the mechanism must be present, enabled and correctly attached ──
select 'mechanism-missing — trg_sync_conversation_draft is not attached to human_tasks. Migration 721 moved the draft-delivery consequence onto the row precisely so no caller could skip it; without the trigger every approval outside the Support inbox silently strands its reply again, and arm 1 will look clean on any week nobody approves anything.' as violation,
       null::text as note
where not exists (select 1 from trg)

union all

select format('mechanism-disabled — trg_sync_conversation_draft exists but tgenabled = %L (expected O). A disabled trigger is indistinguishable from a deleted one at runtime.', t.tgenabled) as violation,
       null::text as note
from trg t where t.tgenabled <> 'O'

union all

select format('mechanism-misattached — trg_sync_conversation_draft fires on the wrong event: %s', t.def) as violation,
       null::text as note
from trg t where t.def not like '%%AFTER UPDATE OF status ON public.human_tasks%%'

union all

-- ── ARM 3: the two properties that make it safe, read out of the live body ─
select 'mechanism-loosened — sync_conversation_draft_decision no longer restricts itself to approvals. A DECLINE that delivers the reply is a worse defect than the one this replaced: the person said no and the customer got the answer anyway.' as violation,
       null::text as note
from trg t where t.prosrc not like '%%NEW.status <> ''approved''%%'

union all

select 'mechanism-loosened — the channel gate in sync_conversation_draft_decision is no longer the expected allow-list (widget, hosted, portal, dock, exam). A deny-list fails OPEN: a future carrier-delivered channel would have its bubble flipped to sent with nothing actually carrying it, which is F-6 one layer down.' as violation,
       null::text as note
from trg t where t.prosrc not like '%%not in (''widget'', ''hosted'', ''portal'', ''dock'', ''exam'')%%'

union all

-- ── ARM 4: a pending approval that CANNOT deliver what it appears to ──────
select format(
    'undeliverable-promise — task %s (workspace %s) is pending on email conversation %s, which holds a draft_pending reply and NO outbound_drafts row to carry it. Approving records a decision and delivers nothing; the person must be told that here, not discover it from the customer.',
    h.id, h.tenant_id, c.id) as violation,
  null::text as note
from public.human_tasks h
join public.de_conversations c on c.id = h.related_id and c.tenant_id = h.tenant_id
where h.related_table = 'de_conversations' and h.status = 'pending' and c.channel = 'email'
  and exists (select 1 from public.de_messages m where m.conversation_id = c.id and m.delivery = 'draft_pending')
  and not exists (
    select 1 from public.outbound_drafts o
     where o.source_kind = 'conversation' and o.source_ref = c.id
       and o.status in ('pending_approval', 'approved'))

union all

-- ── ARM 5: the denominators, printed on every run, pass or fail ───────────
select null::text as violation,
  format('stranded-draft: compared %s approved conversation-linked decision(s) against %s draft(s) still pending; %s stranded since the fix landed, %s from before it. Mechanism: %s.',
    (select count(*) from decided),
    (select count(*) from decided where msg_id is not null),
    (select count(*) from decided d, fix f where d.msg_id is not null and d.decided_at >= f.at),
    (select count(*) from decided d, fix f where d.msg_id is not null and d.decided_at <  f.at),
    coalesce((select 'trg_sync_conversation_draft present, tgenabled=' || t.tgenabled::text from trg t), 'ABSENT')
  ) as note

union all

-- Pre-fix strandings, named individually. Not violations (see the header) —
-- but each one is a real customer reply a real person was told had been sent,
-- so none of them gets to disappear into an aggregate.
select null::text as violation,
  format('stranded-draft (PRE-FIX, not a violation — a person was still told this went out): task %s · conversation %s · message %s · approved %s',
    d.task_id, d.conv_id, d.msg_id, d.decided_at) as note
from decided d, fix f
where d.msg_id is not null and d.decided_at < f.at
`;
}
