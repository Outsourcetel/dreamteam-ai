-- 772_one_evaluator_strictest_wins_absence_escalates.sql
-- ==========================================================================
-- WHY: docs/54 item 2. ONE evaluator, so a person and a digital employee are
-- judged by the same function against the same measures. Two paths measuring
-- separately diverge — mig 755 had to unpick exactly that between
-- list_de_trust_surface and decide_action_execution.
--
-- ⛔ ABSENCE ESCALATES. The clause this replaces reads
--     `p_amount_cents is null or (...)`
-- which is why 115 declared money limits bind on 0.6% of approvals: a missing
-- measure was treated as permission. Here a rule whose dimension is absent
-- from p_measures returns require_human, reason 'unmeasured'.
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
begin
  if p_tenant_id is null then
    return jsonb_build_object('outcome','require_human',
      'reasons', jsonb_build_array(jsonb_build_object('why','no workspace in context')));
  end if;

  for r in
    select ar.dimension, ar.comparator, ar.threshold, ar.outcome, ad.value_type
      from authority_rules ar
      join authority_dimensions ad on ad.dimension = ar.dimension
     where ar.tenant_id = p_tenant_id
       and ar.is_active
       and (ar.category is null or ar.category = p_category)
       and (
         ar.actor_kind = 'all'
         or (ar.actor_kind = p_actor_kind and ar.actor_id = p_actor_id)
         -- ⚠ A PERSON IS ALSO REACHED BY THEIR ROLE AND THEIR ORG UNIT, and
         -- by any unit ABOVE the one they belong to. This mirrors
         -- has_approval_authority exactly, because step 2 proves the cutover
         -- with a differential against it — an evaluator that only matched
         -- exact actor ids would fail that differential on every role-scoped
         -- and unit-scoped row, which is 151 rows today.
         or (p_actor_kind = 'user' and ar.actor_kind = 'role' and exists (
               select 1 from profiles pr
                where pr.user_id = p_actor_id and pr.tenant_id = p_tenant_id
                  and coalesce(pr.is_active, true)
                  and pr.role = ar.actor_role))
         or (p_actor_kind = 'user' and ar.actor_kind = 'org_unit' and exists (
               with recursive below as (
                 select ar.actor_id as id
                 union
                 select u.id from org_units u join below b on u.parent_id = b.id where u.is_active
               )
               select 1 from org_unit_members m
                where m.user_id = p_actor_id and m.is_active
                  and m.org_unit_id in (select id from below)))
       )
  loop
    v_present := v_measures ? r.dimension;

    if not v_present then
      -- ⛔ absence escalates. Never `or` past it.
      v_rank := 1;
      v_reasons := v_reasons || jsonb_build_object(
        'dimension', r.dimension, 'comparator', r.comparator, 'threshold', r.threshold,
        'outcome', 'require_human',
        'why', format('unmeasured: this action did not report %s, and a rule depends on it', r.dimension));
    else
      if r.value_type = 'boolean' then
        v_val := case when coalesce((v_measures->>r.dimension)::boolean, false) then 1 else 0 end;
      else
        v_val := (v_measures->>r.dimension)::numeric;
      end if;

      v_trips := case r.comparator
        when '>'  then v_val >  r.threshold
        when '>=' then v_val >= r.threshold
        when '<'  then v_val <  r.threshold
        when '<=' then v_val <= r.threshold
        when 'is' then v_val =  r.threshold
        else false
      end;

      if not v_trips then continue; end if;

      v_rank := case r.outcome
        when 'deny' then 3 when 'require_second_approver' then 2 else 1 end;
      v_reasons := v_reasons || jsonb_build_object(
        'dimension', r.dimension, 'comparator', r.comparator, 'threshold', r.threshold,
        'outcome', r.outcome,
        'why', format('%s %s %s', r.dimension, r.comparator, r.threshold));
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
