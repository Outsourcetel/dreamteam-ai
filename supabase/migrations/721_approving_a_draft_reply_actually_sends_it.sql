-- 721_approving_a_draft_reply_actually_sends_it.sql
-- ============================================================================
-- F-6 (docs/50 · docs/53 B-1): the phone said "Approved and sent." and sent
-- nothing. Move the draft-delivery consequence OFF the client and into the
-- decision machinery, where every surface gets it and none can skip it.
--
-- ── The defect, measured before writing a line (prod, 2026-08-12) ─────────
--   human_tasks b6cd7764-7aea-4f52-90fc-0ff869ccb5eb  status=approved
--     decided_at 2026-08-11 20:45:16+00
--   de_conversations e3c1dfc6-2850-4fbc-bec5-ee29ac18252c  status=needs_human
--   de_messages      27f98c5a-f286-48ae-aa1c-e0dfb5ace809  delivery=draft_pending
--
-- One approval, recorded and audited; the customer's reply still sitting in
-- the drafts folder eight hours later. That is the whole bug in three rows.
--
-- ── Why it happened ──────────────────────────────────────────────────────
-- `widget-ask` holds a gated reply as de_messages.delivery='draft_pending' and
-- raises an escalation task with related_table='de_conversations'. The ONLY
-- code that ever flipped that row was `approve_draft_reply`, reachable from
-- exactly one screen — the Support Inbox. Neither decide path (the desktop
-- approvals queue, the phone shell) calls it, and `decide_human_task` had no
-- hook for the class. The consequence lived in one screen's JS.
--
-- ── Why a TRIGGER and not another client hook ────────────────────────────
-- A client hook is what F-6 already is. `human_tasks` has five status-sync
-- triggers (improvement, outbound draft, amendment, entity amendment, de work
-- escalation) precisely because a consequence attached to the ROW cannot be
-- forgotten by a caller. This is the sixth, and it is what lets the phone
-- shell keep its founding rule — NO SECOND DECISION PATH — while gaining a
-- consequence it never had.
--
-- ── What it does NOT do, deliberately ────────────────────────────────────
--   * REJECT SENDS NOTHING. A decline leaves the draft `draft_pending` and the
--     conversation `needs_human`: the customer is owed a human reply, and the
--     thread must keep saying so. Only 'approved' is handled.
--   * EMAIL IS NOT TOUCHED. On an email conversation the customer is reached
--     by a carrier, not by this row — that path is outbound_drafts →
--     send-outbound. Flipping the bubble to 'sent' here would move the lie one
--     layer down instead of fixing it, so the channel gate is an ALLOW-LIST:
--     only channels the customer reads straight out of de_messages. A future
--     'sms' channel therefore fails closed rather than silently.
--   * ONE DRAFT PER APPROVAL, OLDEST FIRST. One task authorises one reply.
--     Oldest-first so two approvals on a busy thread deliver in the order the
--     customer asked, and so a second approval can never re-send the first.
--   * NOTHING IS INVENTED. A task with no pending draft (a guardrail block, a
--     plain escalation with no drafted answer) is left exactly alone.
--
-- ⚠ THE EXCEPTION BLOCK IS NOT A PLACE TO HIDE. It follows the house pattern
-- — a failed side effect must never roll back a human's decision — and that
-- is EXACTLY how a swallowed failure becomes a cheerful lie. So the swallow is
-- paired, in the same change, with a client that RE-READS the message row
-- after deciding and reports what the row actually says
-- (customerApi.decideHumanTask → decision_outcome). The row is the truth; the
-- screen quotes it. Neither half is sufficient alone.
--
-- ⚠ decided_by, not auth.uid(). The trigger fires inside decide_human_task's
-- UPDATE, so the decider is already on the row. Reading it from NEW keeps the
-- consequence correct for any writer of that row, now or later.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.sync_conversation_draft_decision()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  v_channel text;
  v_msg     uuid;
  v_after   text;
begin
  if NEW.related_table is distinct from 'de_conversations' then return NEW; end if;
  if NEW.related_id is null                                then return NEW; end if;
  -- Reject sends nothing. Said once, here, so it cannot drift.
  if NEW.status <> 'approved'                              then return NEW; end if;
  if OLD.status is not distinct from NEW.status            then return NEW; end if;

  begin
    select channel into v_channel
      from de_conversations
     where id = NEW.related_id and tenant_id = NEW.tenant_id;
    if v_channel is null then return NEW; end if;

    -- ALLOW-LIST. Only channels where the customer reads de_messages directly.
    if v_channel not in ('widget', 'hosted', 'portal', 'dock', 'exam') then
      raise warning 'sync_conversation_draft_decision: channel % is carrier-delivered; the draft stays with the outbound path (task %)',
        v_channel, NEW.id;
      return NEW;
    end if;

    select id into v_msg
      from de_messages
     where conversation_id = NEW.related_id
       and tenant_id       = NEW.tenant_id
       and delivery        = 'draft_pending'
     order by created_at asc
     limit 1;
    if v_msg is null then return NEW; end if;

    -- Approve-with-edits: the CORRECTED text is what the customer must get.
    -- Same rule as approve_draft_reply's p_edited_content, so the two paths
    -- cannot diverge on what "approved" published.
    v_after := nullif(btrim(coalesce(NEW.decision_edit->>'after', '')), '');

    update de_messages
       set delivery  = 'sent',
           escalated = false,
           content   = coalesce(v_after, content)
     where id = v_msg and delivery = 'draft_pending';

    -- Mirrors approve_draft_reply exactly: approving is taking the thread.
    update de_conversations
       set owner_user_id   = coalesce(owner_user_id, NEW.decided_by),
           status          = 'human_owned',
           last_message_at = now()
     where id = NEW.related_id;

  exception when others then
    -- Never roll back the human's decision. The client re-reads the message
    -- row and will say the reply did NOT go out — see the header.
    raise warning 'sync_conversation_draft_decision failed for task %: %', NEW.id, sqlerrm;
  end;

  return NEW;
end;
$function$;

DROP TRIGGER IF EXISTS trg_sync_conversation_draft ON public.human_tasks;
CREATE TRIGGER trg_sync_conversation_draft
AFTER UPDATE OF status ON public.human_tasks
FOR EACH ROW EXECUTE FUNCTION public.sync_conversation_draft_decision();

-- ── Perimeter (security_default_execute_grant) ────────────────────────────
-- A trigger function needs no EXECUTE grant to fire — the trigger calls it.
-- The five sibling sync_* functions all carry the default PUBLIC grant, which
-- is the exact hazard mig 610/630 closed elsewhere. This one does not.
REVOKE ALL ON FUNCTION public.sync_conversation_draft_decision() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_conversation_draft_decision() FROM anon;
REVOKE ALL ON FUNCTION public.sync_conversation_draft_decision() FROM authenticated;

-- ── Assertions. Each one can fail, and each fails for a DIFFERENT reason ──
DO $assert$
DECLARE
  v_def text;
  v_ok  boolean;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'sync_conversation_draft_decision';
  IF v_def IS NULL THEN RAISE EXCEPTION '721: the function was not created'; END IF;

  -- 1. It must be attached. A function nobody calls is the shape of F-6.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_proc  p ON p.oid = t.tgfoid
     WHERE c.relname = 'human_tasks'
       AND t.tgname  = 'trg_sync_conversation_draft'
       AND p.proname = 'sync_conversation_draft_decision'
       AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION '721: the trigger is not attached to human_tasks';
  END IF;

  -- 2. AFTER UPDATE OF status, matching the five siblings. An INSERT trigger
  --    or an unqualified UPDATE trigger would fire on the wrong events.
  IF (SELECT pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE c.relname = 'human_tasks' AND t.tgname = 'trg_sync_conversation_draft')
     NOT LIKE '%AFTER UPDATE OF status ON public.human_tasks%' THEN
    RAISE EXCEPTION '721: the trigger does not fire AFTER UPDATE OF status';
  END IF;

  -- 3. SECURITY DEFINER with a pinned search_path.
  IF NOT (SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = 'sync_conversation_draft_decision') THEN
    RAISE EXCEPTION '721: the function is not SECURITY DEFINER';
  END IF;
  IF v_def NOT LIKE '%SET search_path TO ''public''%' THEN
    RAISE EXCEPTION '721: search_path is not pinned';
  END IF;

  -- 4. Reject must send nothing. The literal guard, not a comment about it.
  IF v_def NOT LIKE '%NEW.status <> ''approved''%' THEN
    RAISE EXCEPTION '721: a rejection is not excluded — declining could send the draft';
  END IF;

  -- 5. The channel gate must be an ALLOW-LIST. A deny-list would let a future
  --    carrier channel through and re-open the same lie one layer down.
  IF v_def NOT LIKE '%not in (''widget'', ''hosted'', ''portal'', ''dock'', ''exam'')%' THEN
    RAISE EXCEPTION '721: the channel gate is not the expected allow-list';
  END IF;
  IF v_def LIKE '%= ''email''%' THEN
    RAISE EXCEPTION '721: the channel gate is a deny-list — a new channel would fail OPEN';
  END IF;

  -- 6. Exactly one draft per approval.
  IF v_def NOT LIKE '%order by created_at asc%' OR v_def NOT LIKE '%limit 1%' THEN
    RAISE EXCEPTION '721: the draft selection is not oldest-first-one-only';
  END IF;

  -- 7. Perimeter: not callable by the internet.
  SELECT has_function_privilege('authenticated', 'public.sync_conversation_draft_decision()', 'EXECUTE')
    INTO v_ok;
  IF v_ok THEN RAISE EXCEPTION '721: authenticated still holds EXECUTE'; END IF;
  SELECT has_function_privilege('anon', 'public.sync_conversation_draft_decision()', 'EXECUTE') INTO v_ok;
  IF v_ok THEN RAISE EXCEPTION '721: anon still holds EXECUTE'; END IF;

  RAISE NOTICE '721: approving a gated reply now sends it — server-side, on every surface.';
END $assert$;

NOTIFY pgrst, 'reload schema';
