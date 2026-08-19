-- 786_a_deny_that_could_not_be_checked_is_not_an_approval.sql
-- ==========================================================================
-- Closes a hole found by the whole-branch review of migs 768-785, then
-- reproduced end to end against production before this file was written.
--
-- THE CHAIN, each link verified separately against live code:
--   1. set_authority_rule accepts a `deny` rule on amount_cents.        ok
--   2. evaluate_authority, measure PRESENT   -> "deny".                 ok
--   3. evaluate_authority, measure ABSENT    -> "require_human", and the
--      reason object carried no trace of the deny at all.
--   4. decide_human_task deliberately ignores require_human, because on
--      the approval path a human IS present.
--   => the workspace's `deny` enforced NOTHING.
--
-- Nobody was breached: authority_rules is empty in production, so the model
-- still ships dark. But 783 is granted to owners/admins, so a customer
-- could reach that state unaided, and 409 of 412 pending approvals report
-- no amount_cents -- the unmeasured case is the normal case.
--
-- Each half of the fix is useless alone. The evaluator had ERASED the
-- severity -- all three escalate arms hard-coded 'require_human' and threw
-- r.outcome away -- so decide_human_task could not have told the difference
-- even if it had wanted to.
--
-- Three changes:
--   (1) evaluate_authority carries `rule_outcome` + `unverified` on every
--       escalate arm. The effective `outcome` is unchanged, so every
--       existing reader keeps working.
--   (2) decide_human_task refuses on an unverified deny, and refuses on a
--       NULL result instead of falling through it.
--   (3) the dimension registry stops accepting a decorative dimension.
--       `confidence` named decide_action_execution as its reader; that
--       function has never reported confidence. to_regprocedure proved the
--       function EXISTED, never that it REPORTED the dimension -- so both
--       mig 770's trigger and the certify arm waved it through.
-- ==========================================================================

begin;

-- (1) the evaluator stops erasing the severity ----------------------------
CREATE OR REPLACE FUNCTION public.evaluate_authority(p_tenant_id uuid, p_actor_kind text, p_actor_id uuid, p_category text, p_measures jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  r            record;
  v_rank       int;
  v_worst      int := 0;                  -- 0 allow, 1 human, 2 second, 3 deny
  v_reasons    jsonb := '[]'::jsonb;
  v_measures   jsonb := coalesce(p_measures, '{}'::jsonb);
  v_val        numeric;
  v_present    boolean;
  v_trips      boolean;
  v_unreadable boolean;
begin
  if p_tenant_id is null then
    return jsonb_build_object('outcome','require_human',
      'reasons', jsonb_build_array(jsonb_build_object('why','no workspace in context')));
  end if;

  -- ⛔ FAIL CLOSED ON THE ACTOR, not only on the measures. Left unguarded, an
  -- unrecognised or absent p_actor_kind, or a scoped kind with no
  -- p_actor_id, would just match nothing in the loop below and fall out
  -- through v_worst's default of 0 — permission by omission, one parameter
  -- over from the bug this function exists to end.
  --
  -- ⚠ 'role' and 'org_unit' are RULE-scoping vocabulary, not actor kinds — a
  -- rule scopes to a role or a unit, but no caller ever IS one. authority_
  -- rules_actor_shape (mig 770) already forces actor_id null for a 'role'
  -- rule, so a caller that passed ('role', <uuid>) as ITS OWN kind would
  -- match nothing in the loop below (ar.actor_kind = p_actor_kind never
  -- holds, since no rule's actor_kind is ever 'role' paired with a live
  -- actor_id) and silently fall out through v_worst's default of 0 — allow.
  -- Only the two kinds a caller can actually BE, plus 'all', are accepted.
  if p_actor_kind is null or p_actor_kind not in ('all','user','de') then
    return jsonb_build_object('outcome','require_human',
      'reasons', jsonb_build_array(jsonb_build_object(
        'why', format('unknown actor kind: %s is not a kind this evaluator recognizes', coalesce(p_actor_kind, '<null>')))));
  end if;

  if p_actor_kind <> 'all' and p_actor_id is null then
    return jsonb_build_object('outcome','require_human',
      'reasons', jsonb_build_array(jsonb_build_object(
        'why', format('unidentified actor: actor_kind %s was given with no actor_id', p_actor_kind))));
  end if;

  -- ⛔ THE ACTOR MUST RESOLVE, NOT MERELY BE WELL-SHAPED. A stale, cross-
  -- tenant, or edge-function-relayed id that names nobody in p_tenant_id
  -- would otherwise pass the shape check above and then silently lose every
  -- role- and unit-derived rule below — their EXISTS joins simply find no
  -- row — and fall out through v_worst's default of 0, returning the most
  -- permissive answer available. Do NOT silently narrow to whatever rules
  -- happen to still match; escalate instead.
  -- ⛔ AND IT MUST BE ACTIVE. Without `coalesce(is_active, true)` this guard
  -- escalates for a profile that does not EXIST but waves through one that has
  -- been DEACTIVATED — and the role arm below filters on exactly that flag, so
  -- an offboarded user resolves here, matches no role-scoped rule there, and
  -- receives the most permissive answer available. That is the likelier real
  -- case of the two: people are offboarded far more often than user ids are
  -- fabricated. It is also the same polarity trap the org-unit comment sixty
  -- lines below warns about — a filter that means "fewer grants" in
  -- has_approval_authority means "fewer restrictions" here.
  if p_actor_kind = 'user' and not exists (
       select 1 from profiles
        where user_id = p_actor_id and tenant_id = p_tenant_id
          and coalesce(is_active, true)) then
    return jsonb_build_object('outcome','require_human',
      'reasons', jsonb_build_array(jsonb_build_object(
        'why', format('unidentified actor: no active profile for user %s in this workspace', p_actor_id))));
  end if;

  if p_actor_kind = 'de' and not exists (
       select 1 from digital_employees where id = p_actor_id and tenant_id = p_tenant_id) then
    return jsonb_build_object('outcome','require_human',
      'reasons', jsonb_build_array(jsonb_build_object(
        'why', format('unidentified actor: no digital employee %s in this workspace', p_actor_id))));
  end if;

  for r in
    select ar.dimension, ar.comparator, ar.threshold, ar.outcome, ad.value_type
      from authority_rules ar
      join authority_dimensions ad on ad.dimension = ar.dimension
     where ar.tenant_id = p_tenant_id
       and ar.is_active
       -- ⛔ p_category IS NULL must NOT narrow to global-only rules.
       -- task_approval_facts can genuinely return a null category, and the
       -- strictest reading of "I don't know the category" is "every
       -- category-scoped rule applies", not "no category-scoped rule does".
       and (p_category is null or ar.category is null or ar.category = p_category)
       and (
         ar.actor_kind = 'all'
         or (ar.actor_kind = p_actor_kind and ar.actor_id = p_actor_id)
         -- ⚠ A PERSON IS ALSO REACHED BY THEIR ROLE AND THEIR ORG UNIT, and
         -- by any unit ABOVE the one they belong to. The walk direction
         -- mirrors has_approval_authority (mig 593) — an evaluator that only
         -- matched exact actor ids would fail step 2's differential against
         -- it on every role-scoped and unit-scoped row, which is 151 rows
         -- today. It does NOT mirror 593's is_active pruning: see the note
         -- at the recursive CTE below for why that pruning would fail open
         -- here.
         or (p_actor_kind = 'user' and ar.actor_kind = 'role' and exists (
               select 1 from profiles pr
                where pr.user_id = p_actor_id and pr.tenant_id = p_tenant_id
                  and coalesce(pr.is_active, true)
                  and pr.role = ar.actor_role))
         or (p_actor_kind = 'user' and ar.actor_kind = 'org_unit' and exists (
               -- ⚠ THIS WALK MUST NOT PRUNE ON is_active. mig 593 prunes an
               -- inactive intermediate unit out of a walk that computes
               -- GRANTS — losing a branch there loses authority, which
               -- fails closed. Here the walk computes a RESTRICTION's
               -- reach: losing a branch would let one inactive intermediate
               -- unit silently exempt its whole live subtree from a rule
               -- above it, which fails OPEN. Do not "restore" an is_active
               -- filter here to make this match 593 again — the polarity
               -- difference is the point, not an oversight.
               with recursive below as (
                 select ar.actor_id as id
                 union
                 select u.id from org_units u join below b on u.parent_id = b.id
               )
               select 1 from org_unit_members m
                where m.user_id = p_actor_id and m.is_active
                  and m.org_unit_id in (select id from below)))
       )
     order by ar.dimension, ar.comparator, ar.threshold, ar.id
  loop
    v_rank := 0;  -- local to this rule; only "if v_rank > v_worst" below promotes it

    -- ⛔ `?` TESTS KEY PRESENCE, NOT MEASUREMENT. {"amount_cents": null} has
    -- the key, and 74% of pending approvals carry no amount exactly that
    -- way — a JSON null must be treated like an absent key, not like zero
    -- or false.
    v_present := (v_measures ? r.dimension) and jsonb_typeof(v_measures -> r.dimension) <> 'null';

    if not v_present then
      -- ⛔ absence escalates. Never `or` past it.
      v_rank := 1;
      v_reasons := v_reasons || jsonb_build_object(
        'dimension', r.dimension, 'comparator', r.comparator, 'threshold', r.threshold,
        'outcome', 'require_human', 'rule_outcome', r.outcome, 'unverified', true,
        'why', format('unmeasured: this action did not report %s, and a rule depends on it', r.dimension));
    else
      -- ⛔ A MALFORMED MEASURE FAILS CLOSED, NOT RAISES. This function IS the
      -- fail-closed guarantee; it cannot delegate that guarantee back to a
      -- caller by letting a bad cast abort the transaction — this repo has
      -- a standing trap where `.rpc()` resolves on a Postgres error, so an
      -- unhandled exception here can read as silence, not as a refusal.
      v_unreadable := false;
      begin
        if r.value_type = 'boolean' then
          v_val := case when coalesce((v_measures->>r.dimension)::boolean, false) then 1 else 0 end;
        else
          v_val := (v_measures->>r.dimension)::numeric;
        end if;
      exception when others then
        v_unreadable := true;
      end;

      if v_unreadable then
        v_rank := 1;
        v_reasons := v_reasons || jsonb_build_object(
          'dimension', r.dimension, 'comparator', r.comparator, 'threshold', r.threshold,
          'outcome', 'require_human', 'rule_outcome', r.outcome, 'unverified', true,
          'why', format('unreadable measure: %s could not be read as %s', r.dimension, r.value_type));
      else
        v_trips := case r.comparator
          when '>'  then v_val >  r.threshold
          when '>=' then v_val >= r.threshold
          when '<'  then v_val <  r.threshold
          when '<=' then v_val <= r.threshold
          when 'is' then v_val =  r.threshold
          else null
        end;

        if v_trips is null then
          -- Unknown comparator — only reachable if the registry ever grows
          -- one this function was not updated to evaluate. Escalate, do not
          -- raise: raising is exactly what the branch above exists to stop
          -- doing, and silently not-firing is exactly the bug this whole
          -- function exists to end.
          v_rank := 1;
          v_reasons := v_reasons || jsonb_build_object(
            'dimension', r.dimension, 'comparator', r.comparator, 'threshold', r.threshold,
            'outcome', 'require_human', 'rule_outcome', r.outcome, 'unverified', true,
            'why', format('unknown comparator: %s is not understood by this evaluator', r.comparator));
        elsif not v_trips then
          continue;
        else
          v_rank := case r.outcome
            when 'deny' then 3 when 'require_second_approver' then 2 else 1 end;
          v_reasons := v_reasons || jsonb_build_object(
            'dimension', r.dimension, 'comparator', r.comparator, 'threshold', r.threshold,
            'outcome', r.outcome,
            'why', format('%s %s %s', r.dimension, r.comparator, r.threshold));
        end if;
      end if;
    end if;

    if v_rank > v_worst then v_worst := v_rank; end if;
  end loop;

  return jsonb_build_object(
    'outcome', case v_worst when 3 then 'deny' when 2 then 'require_second_approver'
                            when 1 then 'require_human' else 'allow' end,
    'reasons', v_reasons);
end
$function$
;

-- (2) the approval path refuses a deny it could not check -----------------

CREATE OR REPLACE FUNCTION public.decide_human_task(p_task_id uuid, p_decision text, p_reason_code text DEFAULT NULL::text, p_note text DEFAULT NULL::text, p_edit jsonb DEFAULT NULL::jsonb)
 RETURNS human_tasks
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid := auth_tenant_id();
  v_task   human_tasks;
  v_row    human_tasks;
  v_cat    text;
  v_amt    bigint;
  v_auth   jsonb;
  v_risk jsonb;
BEGIN
  perform set_config('app.allow_task_decision', 'on', true);   -- mig 486: sanctioned decision path
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'decision must be approved or rejected';
  END IF;
  -- A rejection with no reason teaches nothing. This is the one place the
  -- friction is worth it; a clean approval needs no code.
  IF p_decision = 'rejected' AND coalesce(btrim(p_reason_code), '') = '' THEN
    RAISE EXCEPTION 'reason_required: a rejection must carry a reason code';
  END IF;

  SELECT * INTO v_task FROM human_tasks WHERE id = p_task_id AND tenant_id = v_tenant;
  IF v_task.id IS NULL THEN RAISE EXCEPTION 'task_not_found'; END IF;

  -- DE scoping (mig 385). Null-tolerant, matching the mig-386/452 policies:
  -- an unattributed task is decidable by the whole workspace, exactly as it is
  -- visible to them. A bare guard here would be stricter than the table.
  IF v_task.de_id IS NOT NULL AND NOT public.can_access_de(v_task.de_id) THEN
    RAISE EXCEPTION 'not_responsible_for_de: this employee is not in your reporting line';
  END IF;

  -- ── mig 593: AUTHORITY ──────────────────────────────────
  -- Everything above answers "may you SEE this?". Nothing has ever asked
  -- "are you entitled to SIGN it?" — a PKR 45,000 credit hold and a five
  -- pound refund passed the identical test, and 238 of 320 pending items
  -- name no employee at all, so the scoping clause never even bit.
  --
  -- REJECTIONS ARE DELIBERATELY NOT GATED. Declining is the conservative
  -- direction, and a rule that stops someone saying "no" is not an
  -- authority model, it is a way of forcing things through.
  IF p_decision = 'approved' THEN
    SELECT category, amount_cents INTO v_cat, v_amt FROM task_approval_facts(p_task_id);
    v_auth := has_approval_authority(auth.uid(), v_tenant, v_cat, v_amt);

    IF NOT coalesce((v_auth->>'allowed')::boolean, true) THEN
      RAISE EXCEPTION 'not_authorised_to_approve: %', v_auth->>'reason';
    END IF;

    -- ── THE SECOND QUESTION (spec §3.6) ──────────────────────────────────
    -- Entitlement above answered "may you sign this at all?" — a property of
    -- a PERSON, deny-by-default, because the absence of a grant means nobody
    -- gave you that authority. This asks "does this action need more
    -- scrutiny?" — a property of an ACTION, escalate-only, because the
    -- absence of a restriction means nobody said it was dangerous.
    -- Composed, never merged: the two models have OPPOSITE polarity, and
    -- replacing one with the other would flip deny to allow for every
    -- workspace that has declared authority.
    --
    -- With authority_rules EMPTY this is exactly a no-op, which is the point:
    -- it ships dark and begins to matter only when someone writes a rule.
    v_risk := evaluate_authority(v_tenant, 'user', auth.uid(), v_cat,
                                 case when v_amt is null then '{}'::jsonb
                                      else jsonb_build_object('amount_cents', v_amt) end);

    -- A NULL RESULT IS NOT PERMISSION. `NULL = 'deny'` evaluates to NULL,
    -- not false, so without this guard a null risk result would fall straight
    -- through the test below into an approval. Same polarity error the rest
    -- of this model exists to prevent.
    IF v_risk IS NULL THEN
      RAISE EXCEPTION 'authority_evaluator_unavailable: refusing rather than approving unchecked';
    END IF;

    IF v_risk->>'outcome' = 'deny' THEN
      RAISE EXCEPTION 'not_authorised_to_approve: %',
        coalesce(v_risk->'reasons'->0->>'why', 'a workspace rule denies this');
    END IF;

    -- THE HOLE THIS MIGRATION EXISTS TO CLOSE.
    --
    -- evaluate_authority downgrades a rule it could not CHECK to
    -- `require_human`, because it cannot know whether the rule would have
    -- tripped. That is right for a require_human rule. It was catastrophic
    -- for a `deny` rule: require_human is deliberately treated as already
    -- satisfied here (a human IS approving), so a workspace's `deny` turned
    -- into an approval the moment its measure went unreported. Measured when
    -- this was found: 409 of 412 pending approvals report no amount_cents,
    -- so the unmeasured case was the normal case, not the corner.
    --
    -- The evaluator now carries the DECLARED outcome as `rule_outcome`. A
    -- deny we could not verify refuses. "We could not tell" must never be
    -- spelled the same way as "permitted".
    IF v_risk->'reasons' @> '[{"rule_outcome": "deny", "unverified": true}]'::jsonb THEN
      RAISE EXCEPTION 'not_authorised_to_approve: %',
        coalesce(
          (select x->>'why' from jsonb_array_elements(v_risk->'reasons') x
            where x->>'rule_outcome' = 'deny' and (x->>'unverified')::boolean limit 1),
          'a workspace rule denies this, and the measure it depends on was not reported');
    END IF;

    -- ⚠ require_human is ALREADY SATISFIED on this path — a human IS
    -- approving. Treating it as a refusal would make every unmeasured rule
    -- block every approval. The outcomes that bite here are `deny` above and
    -- `require_second_approver`, which is OR-ed into the existing needs_second
    -- below rather than replacing it: a second pair of eyes required by
    -- EITHER the grant model or a risk rule is still a second pair of eyes.

    -- A second pair of eyes. The first approval is RECORDED and the task
    -- stays pending; it completes when a DIFFERENT person approves.
    -- Recording rather than refusing is what stops the first approver
    -- having to remember they already looked at it.
    IF (coalesce((v_auth->>'needs_second')::boolean, false)
        OR v_risk->>'outcome' = 'require_second_approver')
       AND (v_task.first_approver_id IS NULL OR v_task.first_approver_id = auth.uid()) THEN
      UPDATE human_tasks
         SET first_approver_id = auth.uid(), first_approved_at = now(), updated_at = now()
       WHERE id = p_task_id AND status = 'pending';
      RETURN NULL;   -- contract: NULL means the caller MUST skip its hooks
    END IF;
  END IF;

  -- ⚠ The pending-only clause is the double-approval guard the caller depends
  -- on. No row back means "already decided" and the caller MUST skip its side
  -- effects (invoice send, gated-action execute, write-backs). Do not relax.
  UPDATE human_tasks
     SET status               = p_decision,
         decided_by           = auth.uid(),
         decided_at           = now(),
         updated_at           = now(),
         decision_reason_code = nullif(btrim(p_reason_code), ''),
         decision_note        = nullif(btrim(p_note), ''),
         decision_edit        = p_edit
   WHERE id = p_task_id AND tenant_id = v_tenant AND status = 'pending'
   RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN RETURN NULL; END IF;   -- already decided; caller skips hooks

  -- Governance record. 'approval' is constraint-legal (checked against
  -- audit_events_category_check); p_category is NOT normalised by
  -- append_audit_event, so an invented category would raise and abort the
  -- decision — the mig-429 lesson.
  PERFORM append_audit_event(
    v_tenant,
    coalesce((SELECT full_name FROM profiles WHERE user_id = auth.uid()), 'An approver'),
    'human',
    format('Task %s: %s%s', p_decision, v_row.title,
           CASE WHEN p_reason_code IS NOT NULL THEN ' (' || p_reason_code || ')' ELSE '' END),
    'approval',
    jsonb_build_object(
      'kind', 'human_task_decision', 'task_id', p_task_id, 'task_type', v_row.type,
      'decision', p_decision, 'reason_code', nullif(btrim(p_reason_code), ''),
      'de_id', v_row.de_id, 'edited', (p_edit IS NOT NULL),
      'related_table', v_row.related_table, 'related_id', v_row.related_id));

  RETURN v_row;
END $function$
;

-- (3) a dimension whose reader never mentions it is decorative ------------

create or replace function public.authority_dimension_reader_is_real()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $trg$
declare v_src text;
begin
  if new.reader_fn is null then
    return new;   -- no reader claimed; mig 770 already refuses rules on it
  end if;

  if to_regprocedure(new.reader_fn) is null then
    raise exception 'reader_fn_does_not_exist: % names no function', new.reader_fn;
  end if;

  select regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g') into v_src
    from pg_proc p where p.oid = to_regprocedure(new.reader_fn);

  -- NOT a proof that the function reports the dimension -- a proof that it
  -- could. A reader that never names the dimension anywhere in its body
  -- certainly does not report it, and that is the case this catches.
  -- Comments are stripped first: prose about a dimension is not a reader of
  -- it, and this repo has had three probes pass by matching their own
  -- comments.
  if v_src is null or v_src !~ new.dimension then
    raise exception 'reader_fn_never_mentions_dimension: % does not reference %, so it cannot be reporting it',
      new.reader_fn, new.dimension;
  end if;

  return new;
end
$trg$;

revoke all on function public.authority_dimension_reader_is_real() from public;
revoke all on function public.authority_dimension_reader_is_real() from anon;
revoke all on function public.authority_dimension_reader_is_real() from authenticated;

drop trigger if exists trg_authority_dimension_reader_is_real on public.authority_dimensions;
create trigger trg_authority_dimension_reader_is_real
  before insert or update on public.authority_dimensions
  for each row execute function public.authority_dimension_reader_is_real();

-- The one row already wrong. confidence has never been reported by anything;
-- with no reader, mig 770's trigger refuses rules naming it, which is the
-- honest state until something measures it.
update public.authority_dimensions set reader_fn = null where dimension = 'confidence';

-- proof, inside the migration: each guard must be able to FAIL -----------
do $verify$
declare v_ok boolean; v_caught boolean;
begin
  -- (3a) the registry REFUSES a decorative dimension
  v_caught := false;
  begin
    insert into public.authority_dimensions (dimension, value_type, reader_fn, is_active)
    values ('probe_decorative_dim', 'integer',
            'public.decide_action_execution(uuid,text,text,boolean,uuid,bigint,text,text)', true);
  exception when others then
    v_caught := sqlerrm like 'reader_fn_never_mentions_dimension%';
  end;
  if not v_caught then
    raise exception 'VERIFY FAILED: registry accepted a dimension its reader never mentions';
  end if;

  -- (3b) ...and still ACCEPTS an honest one. A guard that refuses
  --      everything is as useless as one that refuses nothing.
  insert into public.authority_dimensions (dimension, value_type, reader_fn, is_active)
  values ('amount_cents', 'integer',
          'public.decide_action_execution(uuid,text,text,boolean,uuid,bigint,text,text)', true)
  on conflict (dimension) do update set reader_fn = excluded.reader_fn;

  -- (1) the evaluator now carries the declared outcome
  select regexp_replace(prosrc,'--[^' || chr(10) || ']*','','g') ~ 'rule_outcome' into v_ok
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname='evaluate_authority';
  if not coalesce(v_ok,false) then
    raise exception 'VERIFY FAILED: evaluate_authority does not carry rule_outcome';
  end if;

  -- (2) the approval path now reads it
  select regexp_replace(prosrc,'--[^' || chr(10) || ']*','','g') ~ 'rule_outcome' into v_ok
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname='decide_human_task';
  if not coalesce(v_ok,false) then
    raise exception 'VERIFY FAILED: decide_human_task does not read rule_outcome';
  end if;
end
$verify$;

commit;
