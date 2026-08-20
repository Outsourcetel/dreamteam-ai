-- 804_how_far_is_this_employee_from_earning_more.sql
-- ==========================================================================
-- WHY NOBODY EVER CLIMBS.
--
-- Measured across all 90 live trust policies before writing this:
--
--   current_level = 0        90 of 90        nobody has EVER been promoted
--   promotion requests ever   3              1 approved, 1 rejected, 1 pending
--   demotion notices pending 10
--
-- And the reason, counted per unmet criterion:
--
--   human_samples          86 of 90   <- the wall
--   human_approval_rate    86 of 90   <- same population
--   eval_pass_rate         29
--   eval_samples           27
--   guardrail_blocks        8
--
-- 86 of 90 policies need 3-5 DECIDED human reviews in the last 30 days and
-- have zero. Not because the employee did nothing — because the reviews it
-- raised are sitting undecided in a 413-deep queue whose oldest item is 45
-- days old. The loop closes on itself:
--
--   employee escalates -> nobody decides -> 0 decided reviews in 30 days
--   -> cannot be promoted -> stays at level 0 -> escalates everything
--   -> back to the start
--
-- So the ladder is not broken and does not need rebuilding. Every piece
-- works: seed_de_trust_policy, request_trust_promotion, apply_trust_promotion,
-- trust_evidence_for, and all of them are wired to the employee file. What is
-- missing is that the DISTANCE is invisible. `trust_evidence_for` is computed
-- one policy at a time, inside one employee's file, so nothing ever says "your
-- workforce is 2 decisions away from its first promotion" — or that 86 of 90
-- are stuck behind the same thing.
--
-- ⛔ THIS DOES NOT RE-IMPLEMENT ELIGIBILITY.
--
-- request_trust_promotion gates on trust_evidence_for(policy)->>'eligible'.
-- This reader calls THAT function, on the same policy row. A second opinion
-- about who is ready would drift from the gate the moment either changed, and
-- this repo has paid for that twice in a week — mig 789 reconciling a sweep
-- that judged against constants the review had abandoned, and mig 786 where a
-- severity was erased between two functions that each looked right alone.
--
-- The end-to-end assertion below is the one that matters: for a policy this
-- reader calls not-ready, request_trust_promotion must actually refuse.
-- ==========================================================================

begin;

create or replace function public.list_trust_readiness()
returns table (
  policy_id            uuid,
  de_id                uuid,
  de_name              text,
  category             text,
  current_level        integer,
  max_level            integer,
  eligible             boolean,
  unmet_count          integer,
  unmet                jsonb,
  waiting_on_decisions boolean,
  pending_decisions    bigint
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $fn$
  with mine as (
    select tp.*
      from trust_policies tp
      join digital_employees d on d.id = tp.de_id
     where tp.tenant_id = auth_tenant_id()
       and tp.status = 'active'
       and d.lifecycle_status in ('assigned', 'active', 'improving')
       -- Same second axis every other trust entry point uses: role tier is not
       -- enough, the caller must be on this employee's reporting line.
       and public.can_access_de(tp.de_id)
  ),
  ev as (
    -- ONE call per policy. The same function request_trust_promotion gates on,
    -- so "ready" here and "accepted" there cannot disagree.
    select m.*, public.trust_evidence_for(m.*::trust_policies) as evidence
      from mine m
  )
  select
    e.id                                                as policy_id,
    e.de_id,
    d.name                                              as de_name,
    coalesce(e.action_category, e.source_category, '(uncategorised)') as category,
    e.current_level,
    e.max_level,
    coalesce((e.evidence->>'eligible')::boolean, false)  as eligible,
    coalesce(jsonb_array_length(u.unmet), 0)             as unmet_count,
    coalesce(u.unmet, '[]'::jsonb)                       as unmet,
    -- Is this employee stuck behind the human queue specifically? That is the
    -- difference between "needs more time" and "needs YOU".
    coalesce(u.unmet @> '[{"key":"human_samples"}]'::jsonb
          or u.unmet @> '[{"key":"human_approval_rate"}]'::jsonb, false) as waiting_on_decisions,
    coalesce(p.n, 0)                                     as pending_decisions
  from ev e
  join digital_employees d on d.id = e.de_id
  left join lateral (
    select jsonb_agg(jsonb_build_object(
             'key', c->>'key', 'detail', c->>'detail',
             'actual', c->>'actual', 'required', c->>'required')
             order by c->>'key') as unmet
      from jsonb_array_elements(e.evidence->'criteria') c
     where coalesce((c->>'met')::boolean, false) = false
  ) u on true
  left join lateral (
    select count(*) as n from human_tasks t
     where t.tenant_id = e.tenant_id and t.de_id = e.de_id and t.status = 'pending'
  ) p on true
  -- Closest to ready first. A workspace wants to know who is two decisions
  -- away, not who is furthest from ever qualifying.
  order by coalesce((e.evidence->>'eligible')::boolean, false) desc,
           coalesce(jsonb_array_length(u.unmet), 0) asc,
           d.name;
$fn$;

revoke all on function public.list_trust_readiness() from public;
revoke all on function public.list_trust_readiness() from anon;
grant execute on function public.list_trust_readiness() to authenticated;

-- ── proof ─────────────────────────────────────────────────────────────────
do $verify$
declare
  v_u uuid; v_t uuid; v_rows int; v_notready record; v_refused boolean;
begin
  select tp.tenant_id into v_t
    from trust_policies tp join digital_employees d on d.id = tp.de_id
   where tp.status = 'active' and d.lifecycle_status in ('assigned','active','improving')
   limit 1;
  select p.user_id into v_u from profiles p
   where p.tenant_id = v_t and coalesce(p.is_active, true)
     and p.role in ('tenant_owner','tenant_admin') limit 1;
  if v_u is null then
    raise exception 'VERIFY FAILED: no admin in a workspace with live trust policies — nothing below would be measured';
  end if;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_u, 'role', 'authenticated')::text, true);

  -- (a) it returns something
  select count(*) into v_rows from public.list_trust_readiness();
  if v_rows = 0 then
    raise exception 'VERIFY FAILED: no readiness rows for a workspace that has live policies';
  end if;

  -- (b) it reports a REASON, not just a verdict. A board that says "not ready"
  --     without saying what is missing is the thing this replaces.
  if not exists (select 1 from public.list_trust_readiness()
                  where eligible = false and unmet_count > 0) then
    raise exception 'VERIFY FAILED: every not-ready row has an empty unmet list';
  end if;

  -- (c) Agreement with the gate: a policy this reader calls not-ready must be
  --     refused by request_trust_promotion.
  --
  --     ⚠ BE HONEST ABOUT WHAT THIS PROVES TODAY: NOTHING. The gate currently
  --     refuses every policy in production, so "not-ready implies refused"
  --     holds trivially and this arm cannot fail on this data. It is a
  --     REGRESSION GUARD for the day the first policy becomes eligible — the
  --     day it would actually matter that the board and the gate agree. The
  --     assertion that can fail today is (d).
  select * into v_notready from public.list_trust_readiness()
   where eligible = false limit 1;
  if v_notready.policy_id is null then
    raise notice 'VERIFY SKIPPED: every policy is eligible, so disagreement cannot be tested';
  else
    v_refused := false;
    begin
      perform public.request_trust_promotion(v_notready.policy_id);
    exception when others then
      v_refused := sqlerrm like '%not eligible%';
    end;
    if not v_refused then
      raise exception 'VERIFY FAILED: readiness says policy % is NOT ready, but request_trust_promotion accepted it', v_notready.policy_id;
    end if;
  end if;

  -- (d) ⛔ THE ONE THAT CAN FAIL TODAY. Two lateral joins hang off every row.
  --     A lateral that returns no row silently DROPS the policy if it is not
  --     LEFT joined, and one that returns several silently MULTIPLIES it. Both
  --     failures look like a working board — just one with the wrong employees
  --     on it, which is worse than an empty one.
  --
  --     Compared against the source set, not against itself.
  declare
    v_expected int; v_got int; v_distinct int;
  begin
    select count(*) into v_expected
      from trust_policies tp join digital_employees d on d.id = tp.de_id
     where tp.tenant_id = auth_tenant_id() and tp.status = 'active'
       and d.lifecycle_status in ('assigned','active','improving')
       and public.can_access_de(tp.de_id);
    select count(*), count(distinct policy_id) into v_got, v_distinct
      from public.list_trust_readiness();
    if v_got <> v_expected then
      raise exception 'VERIFY FAILED: % accessible policies but the board shows % — a lateral join is dropping or adding rows', v_expected, v_got;
    end if;
    if v_distinct <> v_got then
      raise exception 'VERIFY FAILED: % rows for % distinct policies — a lateral fanned out', v_got, v_distinct;
    end if;
    if v_expected = 0 then
      raise exception 'VERIFY FAILED: the comparison above ran against zero policies and proved nothing';
    end if;
  end;
end
$verify$;

commit;
