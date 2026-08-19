-- 772_one_evaluator_strictest_wins_absence_escalates.sql
-- ==========================================================================
-- WHY: docs/54 item 2. ONE evaluator, so a person and a digital employee are
-- judged by the same function against the same measures. Two paths measuring
-- separately diverge — mig 755 had to unpick exactly that between
-- list_de_trust_surface and decide_action_execution.
--
-- ⛔ ABSENCE ESCALATES — AT EVERY LAYER THIS FUNCTION TOUCHES, not only the
-- measures. The clause this replaces reads `p_amount_cents is null or (...)`,
-- which is why 115 declared money limits bind on 0.6% of approvals: a
-- missing measure was treated as permission. Fix round 1 found the same
-- disease one level down, three more times:
--   · a JSON-null measure value (`{"amount_cents": null}`) still satisfies
--     `?` — the key is PRESENT — so a null was reaching the comparison and
--     tripping `false` (numeric) or `coalesce(...,false)` (boolean) instead
--     of escalating. 74% of pending approvals carry no amount this way.
--   · every input except p_tenant_id was trusted: an unrecognised
--     p_actor_kind, a scoped kind with no p_actor_id, or a null p_category
--     each silently NARROWED the matching rule set and returned a MORE
--     permissive verdict than "I don't know" warrants.
--   · a measure that fails to parse (`{"amount_cents":"n/a"}`) used to abort
--     the whole function with a Postgres exception — worse than permissive,
--     because `.rpc()` resolves on a Postgres error and a caller that
--     doesn't check for one would treat the failure as silence.
-- All four now escalate to require_human with a reason instead.
--
-- FINAL REVIEW FIX WAVE found the actor check still failed open, one layer
-- further in than fix round 1 reached:
--   · the actor-kind whitelist accepted 'role' and 'org_unit', which are
--     RULE-scoping vocabulary, not actor kinds — no caller ever IS a role or
--     a unit, and authority_rules_actor_shape (mig 770) forces actor_id null
--     for a 'role' rule, so a caller passing ('role', <uuid>) matched
--     nothing in the loop and fell out through v_worst's default of 0.
--   · a well-shaped actor was never checked for EXISTING. A stale,
--     cross-tenant, or edge-function-relayed id that names nobody in
--     p_tenant_id silently lost every role- and unit-derived rule (their
--     EXISTS joins just find no row) and returned the most permissive
--     answer available.
-- Both now escalate to require_human instead of narrowing silently.
--
-- STRICTEST WINS: deny > require_second_approver > require_human > allow. A
-- rule can only ever tighten, so a customer may add one without auditing the
-- rest — and a narrow rule can never silently cancel a broad one, which is
-- the shape that produced docs/54 item 18/9.
--
-- INERT. Nothing calls this yet; the cutover is step 2 of the spec.
-- ==========================================================================

begin;

create or replace function public.evaluate_authority(
  p_tenant_id  uuid,
  p_actor_kind text,
  p_actor_id   uuid,
  p_category   text,
  p_measures   jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $fn$
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
        'outcome', 'require_human',
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
          'outcome', 'require_human',
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
            'outcome', 'require_human',
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
$fn$;

-- Internal judgement. The gates call it in step 2; nothing on the browser
-- perimeter ever does. Default EXECUTE (migs 610 + 630) closed explicitly.
revoke all on function public.evaluate_authority(uuid, text, uuid, text, jsonb) from public;
revoke all on function public.evaluate_authority(uuid, text, uuid, text, jsonb) from anon;
revoke all on function public.evaluate_authority(uuid, text, uuid, text, jsonb) from authenticated;
grant execute on function public.evaluate_authority(uuid, text, uuid, text, jsonb) to service_role;

commit;
