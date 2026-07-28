-- 493_reclassify_hollow_completions.sql
-- ============================================================================
-- docs/37 Move 0, block 1b: work that was never done stops claiming it was.
--
-- Wave 1 fixed the SOURCE — a text-only model reply now becomes waiting_human
-- with the full question and a routed escalation. These are the rows written
-- BEFORE that, by the old fallback:
--     summary = resp.content.filter(...).join(' ').slice(0, 500) || 'completed'
-- which stamped any reply-without-a-tool-call as 'done'. Verbatim, one of them:
--     "I understand. You're asking me to retrieve recent journal entries and
--      source records for reconciliation purposes. However, I need to let you
--      know what I can and cannot do with the tools available to me... **What I
--      need from you:** 1. **System access:** Which accounting system(s)..."
-- — filed as completed work.
--
-- THE RULE. Four clauses, all required. A false reclassification is worse than
-- leaving the row, so this is structural, never semantic:
--   (1) status = 'done'
--   (2) length(result->>'summary') = 500      -- the slice(0,500) fingerprint
--   (3) no de_decision_trace row with tool='mark_done' for this item
--                                             -- the model never called the
--                                             -- only tool that means finished
--   (4) updated_at < 2026-07-28 03:16:00+00   -- the Wave-1 deploy boundary
-- Each clause independently selects the SAME 36 rows, and each independently
-- excludes the SAME single genuine row (371 chars, with a mark_done trace).
-- That triple agreement is why the rule is safe. Clause (4) is not redundant
-- going forward: it stops this rule ever touching a row completed by the new
-- def-of-done release path in connector-hub, which also has no mark_done trace.
-- Content heuristics were REJECTED — a '?' appears in only 17 of the 36,
-- because the truncation frequently cuts the question mark off.
--
-- TARGET STATUS: 'cancelled', not 'waiting_human'. All 21 existing
-- waiting_human rows are ROUTED (21/21 carry an exception, 20/21 a human task);
-- these 36 carry neither, and both unblock paths are driven from an exception
-- or a task — so they would sit forever while the Employee File banner counted
-- them as work needing a person. That trades one lie for a subtler one.
-- 'cancelled' matches the shape decide_de_exception already writes.
--
-- THE TRAP THIS MIGRATION MUST NOT SPRING: claim_de_work_items will only claim
-- an item whose predecessor is 'done'. Six non-done children depend directly on
-- affected rows, and each carries a live pending approval. The moment a person
-- answers one, resume_de_work_from_decision queues it — and a 'cancelled'
-- parent can never satisfy the gate, so that item and its 14 descendants would
-- die silently. Their depends_on is therefore NULLed here. NOT cascade-
-- cancelled: those six are live approvals a human is expected to answer, and
-- the human's answer is precisely the input the predecessor failed to obtain.
--
-- EVIDENCE IS PRESERVED. result->>'summary' is NOT overwritten — that truncated
-- text is the only surviving record of what was actually being asked. The
-- reclassification is recorded alongside it, and the human-readable reason goes
-- in last_error, which the Work tab already renders.
--
-- updated_at is deliberately NOT touched: de_work_items has no triggers, and
-- the stall sweep tests max(updated_at) per objective — bumping it would buy
-- every affected objective a 24-hour exemption from wake-spin detection.
--
-- SECOND SURFACE, fixed here too: the Employee File Record tab reads its
-- 'Outcome' chip from a FROZEN COPY in otel_spans.attributes, not from
-- de_work_items. Reclassifying alone would leave 36 chips still saying 'done' —
-- the lie would simply relocate to a screen nobody re-checked.
--
-- FOUNDER-VISIBLE CONSEQUENCE, stated plainly: the public proof page counter
-- 'Work items completed' drops from 37 to 1. That is the honest number.
-- ============================================================================

do $reclass$
declare
  v_boundary constant timestamptz := timestamptz '2026-07-28 03:16:00+00';
  v_affected uuid[];
  n_affected int;
  n_children int;
  n_spans int;
  n_genuine int;
begin
  -- Freeze the target set ONCE, so every later statement operates on exactly
  -- the rows the rule selected and nothing can drift between statements.
  select array_agg(w.id) into v_affected
    from de_work_items w
   where w.status = 'done'
     and length(w.result->>'summary') = 500
     and w.updated_at < v_boundary
     and not exists (select 1 from de_decision_trace d
                      where d.run_ref = w.id::text and d.tool = 'mark_done');

  n_affected := coalesce(array_length(v_affected, 1), 0);

  -- The census said 36. If reality disagrees, something changed underneath this
  -- migration and it must not guess.
  if n_affected <> 36 then
    raise exception '493: expected exactly 36 hollow completions, found % — refusing to guess', n_affected;
  end if;

  -- The genuine completion must be OUTSIDE the set. If the rule ever swept it
  -- up, the rule is wrong and no amount of counting would reveal it.
  if 'd6d9561c-9717-4503-b307-1850f46322f5'::uuid = any(v_affected) then
    raise exception '493: the rule selected the one genuinely-completed item — aborting';
  end if;

  -- ── the dependency repair, BEFORE the flip ────────────────────────────────
  -- A vacuous dependency: the predecessor produced nothing, so there is nothing
  -- to wait for. Only non-done children — the done ones are themselves affected
  -- and are being cancelled anyway.
  with repaired as (
    update de_work_items c
       set depends_on = null
     where c.depends_on = any(v_affected)
       and c.status <> 'done'
    returning c.id
  )
  select count(*) into n_children from repaired;

  -- ── the flip ──────────────────────────────────────────────────────────────
  -- Note the absence of updated_at: see the header.
  update de_work_items w
     set status = 'cancelled',
         last_error = 'Not actually completed: the employee replied with a question instead of finishing, and the old runtime recorded that reply as completion. Reclassified by migration 493.',
         result = coalesce(w.result, '{}'::jsonb) || jsonb_build_object(
           'reclassified', jsonb_build_object(
             'from', 'done',
             'by', 'migration 493',
             'rule', 'text-only reply mis-stamped done by the pre-Wave-1 runtime',
             'at', now()))
   where w.id = any(v_affected);

  -- ── the frozen copy on the Record tab ─────────────────────────────────────
  with spans as (
    update otel_spans s
       set attributes = s.attributes || jsonb_build_object(
             'dreamteam.status', 'cancelled',
             'dreamteam.reclassified_by', 'migration 493')
     where s.name = 'invoke_agent de-work'
       and s.parent_span_id is null
       and (s.attributes->>'dreamteam.work_item_id')::uuid = any(v_affected)
       and s.attributes->>'dreamteam.status' = 'done'
    returning s.span_id
  )
  select count(*) into n_spans from spans;

  -- ── proof ─────────────────────────────────────────────────────────────────
  select count(*) into n_genuine from de_work_items where status = 'done';
  if n_genuine <> 1 then
    raise exception '493: expected exactly 1 genuine completion to remain, found %', n_genuine;
  end if;

  -- Nothing may be left claiming a cancelled predecessor.
  if exists (
    select 1 from de_work_items c
     join de_work_items p on p.id = c.depends_on
    where p.status = 'cancelled' and c.status in ('queued', 'waiting_human')
  ) then
    raise exception '493: a live item still depends on a cancelled predecessor — it would never be claimable';
  end if;

  -- The evidence must survive.
  if exists (select 1 from de_work_items where id = any(v_affected)
              and coalesce(length(result->>'summary'), 0) <> 500) then
    raise exception '493: the original question text was destroyed — that was the only record of what was asked';
  end if;

  -- And the Record tab must agree with the work table.
  if exists (
    select 1 from otel_spans s
     where s.name = 'invoke_agent de-work' and s.parent_span_id is null
       and (s.attributes->>'dreamteam.work_item_id')::uuid = any(v_affected)
       and s.attributes->>'dreamteam.status' = 'done'
  ) then
    raise exception '493: the Record tab still shows these as done — the lie relocated';
  end if;

  raise notice '493: % hollow completions reclassified, % dependencies repaired, % Record-tab spans corrected, 1 genuine completion preserved',
    n_affected, n_children, n_spans;
end $reclass$;
