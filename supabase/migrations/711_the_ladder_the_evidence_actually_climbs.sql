-- 711_the_ladder_the_evidence_actually_climbs.sql
-- ==========================================================================
-- Found by mig 710's OWN honest zero, minutes after it applied. The first
-- production run raised NOTHING while the Finance DE's action_execute /
-- erp_financials policy sat ELIGIBLE with four landed approvals — because
-- 710's policy mapping stopped at the MOST SPECIFIC candidate
-- (action:erp_financials) and that ladder can NEVER become eligible from
-- approvals: trust_evidence_for's else-branch counts only inquiry_review /
-- escalation / review_gate for categories it does not special-case. The
-- founder-ratified evidence routing (mig 683 D1, shipped in 586) points
-- approval evidence at `action_execute` (and invoice) policies — so a
-- mapping that stops on an approval-blind ladder starves the seam through
-- a known blind spot and reports "nothing qualifies" forever.
--
-- THE RULE, restated: the proposal must ride the ladder THE EVIDENCE
-- ACTUALLY CLIMBS. The detector now maps each group to the most specific
-- candidate policy that trust_evidence_for marks ELIGIBLE (specific-first
-- among eligible candidates, same precedence order as before). If the
-- else-branch ever learns to count approvals, proposals automatically move
-- to the more specific ladder — the precedence order is unchanged.
--
-- Enforceability verified live before writing, not assumed: the Finance DE
-- has ZERO de_autonomy rows, and decide_action_execution's chain asks
-- ['action:'||category, action_type, 'action_execute'] with the source-
-- category axis — so the dial row a promotion on the action_execute/
-- erp_financials policy writes IS the row the gate consults for this work.
-- A later per-category demotion row would out-rank it, which is the
-- machinery's own demote-wins semantics, untouched.
--
-- TWO GUARDS THE NEW MAPPING KEEPS HONEST:
--   * ONE OPEN PROPOSAL PER GROUP, ACROSS THE WHOLE CANDIDATE CHAIN: if ANY
--     candidate policy (eligible or not — e.g. a human-requested promotion
--     on the specific ladder) has an open proposal, the group is blocked.
--     Choosing "first eligible" must never manufacture a SECOND proposal
--     about the same repeated action.
--   * THE DECLINE WINDOW SPANS THE CHAIN TOO: a rejected proposal on ANY
--     candidate policy void-resets the pattern. "The founder said no to
--     widening this employee on this work recently" is true whichever rung
--     of the chain carried the no.
--
-- Everything else — the role, the writer, the grants, the briefs, the sweep
-- feed, N=3, the Ring-0 probe — is mig 710 unchanged. The probe's pins
-- (evidence_is_production / tenant_is_operational / action_execution_landed
-- / n_ok >= 3) all survive in this body, re-asserted below.
-- ==========================================================================

begin;

create or replace function public.detect_trust_widening_patterns(p_tenant_id uuid default null)
returns table (
  tenant_id            uuid,
  de_id                uuid,
  de_name              text,
  action_definition_id uuid,
  action_key           text,
  action_label         text,
  policy_id            uuid,
  policy_category      text,
  current_level        integer,
  proposed_level       integer,
  window_days          integer,
  n_approved           bigint,
  first_decided        timestamptz,
  last_decided         timestamptz,
  evidence             jsonb
)
language sql
stable
security definer
set search_path to 'public', 'extensions'
as $fn$
with decided as (
  -- (1)(2)(3): every decided approval with its gate execution and action,
  -- once per task; production evidence only; operational tenants only.
  select ht.id as task_id, ht.tenant_id as t_id, ht.de_id as d_id,
         ht.status as t_status, ht.decided_at, ht.decided_by,
         g.ad_id, g.g_action_key, g.g_label, g.g_category, g.g_destructive
    from human_tasks ht
    join lateral (
      select ae.action_definition_id as ad_id, ad.action_key as g_action_key,
             ad.label as g_label, ad.category as g_category,
             coalesce((ad.risk->>'destructive')::boolean, false) as g_destructive
        from action_executions ae
        join action_definitions ad on ad.id = ae.action_definition_id
       where (ae.task_id = ht.id or ae.resolves_task_id = ht.id)
         and ae.decision like 'human_gated%'
       order by ae.created_at desc
       limit 1
    ) g on true
   where ht.type = 'action_approval'
     and ht.status in ('approved', 'rejected')
     and ht.decided_at is not null
     and ht.de_id is not null
     and public.evidence_is_production(ht.origin)
     and public.tenant_is_operational(ht.tenant_id)
     and (p_tenant_id is null or ht.tenant_id = p_tenant_id)
),
clean as (
  -- (5): carried out AND landed, through THE shared predicate; nothing
  -- rolled back, failed, or contradicted. Both linkage columns, always —
  -- resolves_task_id was unpopulated before August (mig 642).
  select d.*,
         (d.t_status = 'approved'
          and exists (select 1 from action_executions ex
                       where (ex.task_id = d.task_id or ex.resolves_task_id = d.task_id)
                         and public.action_execution_landed(ex))
          and not exists (select 1 from action_executions ex
                           where (ex.task_id = d.task_id or ex.resolves_task_id = d.task_id)
                             and (ex.rolled_back_at is not null
                               or ex.decision = 'failed'
                               or coalesce(ex.result #>> array['ok'], 'true') = 'false'))
         ) as is_clean,
         (select max(ex.rolled_back_at) from action_executions ex
           where (ex.task_id = d.task_id or ex.resolves_task_id = d.task_id)) as rb_at
    from decided d
),
grp as (
  -- (4): destructive actions never reach a proposal — the destructive gate
  -- sits above the dial and a widened dial would open nothing.
  select c.t_id, c.d_id, c.ad_id,
         max(c.g_action_key) as g_action_key, max(c.g_label) as g_label,
         max(c.g_category) as g_category,
         greatest(
           coalesce(max(c.decided_at) filter (where c.t_status = 'rejected'), '-infinity'::timestamptz),
           coalesce(max(c.rb_at), '-infinity'::timestamptz)
         ) as base_reset
    from clean c
   group by c.t_id, c.d_id, c.ad_id
  having not bool_or(c.g_destructive)
),
pol as (
  -- (9), mig 711: the governing policy — employee-scoped, active,
  -- SPECIFIC-FIRST AMONG ELIGIBLE CANDIDATES. 710 stopped at the most
  -- specific candidate even when its evidence model is approval-blind
  -- (trust_evidence_for's else-branch), which starved the seam; the ladder
  -- proposed must be the ladder the evidence actually climbs. Eligibility
  -- (mig 692's form) already folds in status, ceiling and every criterion,
  -- and apply_trust_promotion re-verifies the SAME test at apply time.
  select g.*, p.id as pol_id, p.action_category as pol_cat,
         p.current_level as cur_level, least(3, coalesce(p.max_level, 3)) as ceiling,
         coalesce((p.criteria->>'window_days')::integer, 30) as win
    from grp g
    join lateral (
      select tp.* from trust_policies tp
       where tp.tenant_id = g.t_id and tp.de_id = g.d_id and tp.status = 'active'
         and (tp.action_category = g.g_action_key
           or tp.action_category = 'action:' || coalesce(g.g_category, '')
           or (tp.action_category = 'action_execute'
               and (tp.source_category is null or tp.source_category = g.g_category)))
         and coalesce((trust_evidence_for(tp)->>'eligible')::boolean, false)
       order by case
           when tp.action_category = g.g_action_key then 0
           when tp.action_category = 'action:' || coalesce(g.g_category, '') then 1
           when tp.source_category = g.g_category then 2
           else 3 end
       limit 1
    ) p on true
   -- ONE open proposal per group across the WHOLE candidate chain: an open
   -- proposal on ANY candidate (even an approval-blind one a human
   -- requested) blocks — first-eligible must never manufacture a second
   -- proposal about the same repeated action.
   where not exists (
     select 1 from trust_policies tpx
      join human_tasks hx on hx.id = tpx.pending_task_id and hx.status = 'pending'
     where tpx.tenant_id = g.t_id and tpx.de_id = g.d_id and tpx.status = 'active'
       and (tpx.action_category = g.g_action_key
         or tpx.action_category = 'action:' || coalesce(g.g_category, '')
         or (tpx.action_category = 'action_execute'
             and (tpx.source_category is null or tpx.source_category = g.g_category))))
),
reset_full as (
  -- (6): the void-reset moment — a decline of a prior proposal on ANY
  -- candidate policy in the chain restarts the pattern, alongside
  -- rejections and rollbacks. The founder's recent "no" about widening
  -- this employee on this work holds whichever rung carried it.
  select p.*, greatest(p.base_reset,
    coalesce((select max(h.decided_at)
                from human_tasks h
                join trust_policies tpr on tpr.id = h.related_id
               where h.type = 'trust_promotion' and h.related_table = 'trust_policies'
                 and h.status = 'rejected'
                 and tpr.tenant_id = p.t_id and tpr.de_id = p.d_id
                 and (tpr.action_category = p.g_action_key
                   or tpr.action_category = 'action:' || coalesce(p.g_category, '')
                   or (tpr.action_category = 'action_execute'
                       and (tpr.source_category is null or tpr.source_category = p.g_category)))),
             '-infinity'::timestamptz)
  ) as reset_ts
    from pol p
),
counted as (
  -- (7): count clean approvals after the reset, inside the policy's window,
  -- and carry the full citation — task, decider, timestamp, landed receipt.
  select r.*, w.n_ok, w.first_ok, w.last_ok, w.decisions
    from reset_full r
    cross join lateral (
      select count(*) as n_ok,
             min(c.decided_at) as first_ok,
             max(c.decided_at) as last_ok,
             jsonb_agg(jsonb_build_object(
               'task_id', c.task_id,
               'decided_at', c.decided_at,
               'decided_by', c.decided_by,
               'decided_by_name', coalesce(
                 (select pr.full_name from profiles pr where pr.user_id = c.decided_by),
                 'a teammate'),
               'receipt', (select left(coalesce(nullif(btrim(ex.receipt), ''), '(result recorded)'), 160)
                             from action_executions ex
                            where (ex.task_id = c.task_id or ex.resolves_task_id = c.task_id)
                              and public.action_execution_landed(ex)
                            order by ex.created_at desc limit 1)
             ) order by c.decided_at) as decisions
        from clean c
       where c.t_id = r.t_id and c.d_id = r.d_id and c.ad_id = r.ad_id
         and c.is_clean
         and c.decided_at > r.reset_ts
         and c.decided_at >= now() - make_interval(days => r.win)
    ) w
)
-- (8) the N, and (10) the chosen ladder's evidence bar re-checked whole.
-- `k.n_ok >= 3` IS the pattern floor — the Ring-0 probe pins this exact
-- token; changing N means changing it here AND there, out loud.
select k.t_id, k.d_id,
       coalesce(de.persona_name, de.name),
       k.ad_id, k.g_action_key, k.g_label,
       k.pol_id, k.pol_cat, k.cur_level,
       least(k.cur_level + 1, k.ceiling),
       k.win, k.n_ok, k.first_ok, k.last_ok,
       jsonb_build_object(
         'pattern', jsonb_build_object(
           'action_key', k.g_action_key,
           'action_definition_id', k.ad_id,
           'n_approved', k.n_ok,
           'window_days', k.win,
           'reset_at', case when k.reset_ts > '-infinity'::timestamptz
                            then to_jsonb(k.reset_ts) else 'null'::jsonb end,
           'decisions', k.decisions),
         'dial', jsonb_build_object(
           'current_level', k.cur_level,
           'proposed_level', least(k.cur_level + 1, k.ceiling),
           'current_settings', (select trust_ladder_settings(tp, k.cur_level)
                                  from trust_policies tp where tp.id = k.pol_id),
           'proposed_settings', (select trust_ladder_settings(tp, least(k.cur_level + 1, k.ceiling))
                                   from trust_policies tp where tp.id = k.pol_id)),
         'policy_evidence', (select trust_evidence_for(tp)
                               from trust_policies tp where tp.id = k.pol_id))
  from counted k
  join digital_employees de on de.id = k.d_id
 where k.n_ok >= 3
   and k.cur_level < k.ceiling
   and coalesce(((select trust_evidence_for(tp) from trust_policies tp
                   where tp.id = k.pol_id)->>'eligible')::boolean, false)
$fn$;

-- CREATE OR REPLACE preserves the ACL; re-issued so a replay from an empty
-- database lands identically, and asserted below either way.
revoke execute on function public.detect_trust_widening_patterns(uuid)
  from public, anon, authenticated;
grant execute on function public.detect_trust_widening_patterns(uuid)
  to trust_pattern_proposer, service_role;

-- ── FIRST RUN under the corrected mapping — through the real writer, under
--    the real role. ────────────────────────────────────────────────────────
do $first_run$
declare
  v_out jsonb;
begin
  v_out := public.raise_trust_widening_proposals(null);
  raise notice '711: proposer run under the corrected mapping: %', v_out;
end $first_run$;

-- ══ PROVE IT ══════════════════════════════════════════════════════════════
do $assert$
declare
  v_src   text;
  v_cnt   int;
  v_task  uuid;
  v_brief jsonb;
  v_out   jsonb;
  v_owner name;
  v_vol   "char";
begin
  -- The probe's pins all survive in the new body, and identity held.
  select p.prosrc, r.rolname, p.provolatile into v_src, v_owner, v_vol
    from pg_proc p join pg_roles r on r.oid = p.proowner
   where p.oid = 'public.detect_trust_widening_patterns(uuid)'::regprocedure;
  if v_owner <> 'postgres' or v_vol not in ('s','i') then
    raise exception '711: detector identity drifted (owner %, volatility %)', v_owner, v_vol;
  end if;
  if position('evidence_is_production' in v_src) = 0
     or position('tenant_is_operational' in v_src) = 0
     or position('action_execution_landed' in v_src) = 0
     or position('k.n_ok >= 3' in v_src) = 0 then
    raise exception '711: a load-bearing conjunct pin is gone from the detector body';
  end if;
  -- The mapping fix itself, pinned on its driving expression: eligibility
  -- INSIDE the candidate lateral (choose the ladder the evidence climbs)...
  if position($tok$and coalesce((trust_evidence_for(tp)->>'eligible')::boolean, false)
       order by case$tok$ in v_src) = 0 then
    raise exception '711: the lateral no longer requires eligibility before choosing — the mapping would stop on an approval-blind ladder again';
  end if;
  -- ...and the chain-wide one-open-proposal block.
  if position('tpx.pending_task_id' in v_src) = 0 then
    raise exception '711: the chain-wide open-proposal block is gone — first-eligible could manufacture a second proposal about the same action';
  end if;
  if has_function_privilege('anon', 'public.detect_trust_widening_patterns(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.detect_trust_widening_patterns(uuid)', 'EXECUTE')
     or has_function_privilege('public', 'public.detect_trust_widening_patterns(uuid)', 'EXECUTE') then
    raise exception '711: detector perimeter regressed';
  end if;

  -- Every open system proposal (including any the first run just raised):
  -- linked, cited >= 3 LEDGER-VERIFIED decisions, operational workspace,
  -- briefed. Skip loudly when none is open (dev).
  select count(*) into v_cnt
    from human_tasks ht join trust_policies p on p.pending_task_id = ht.id
   where ht.type = 'trust_promotion' and ht.status = 'pending' and p.requested_by is null;
  if v_cnt = 0 then
    raise notice '711: SKIPPED the drive test — no system-raised proposal is open in this environment';
  else
    for v_task in
      select ht.id from human_tasks ht
        join trust_policies p on p.pending_task_id = ht.id
       where ht.type = 'trust_promotion' and ht.status = 'pending' and p.requested_by is null
    loop
      select count(*) into v_cnt
        from trust_policies p,
             jsonb_array_elements(p.pending_evidence->'pattern'->'decisions') d
        join human_tasks h on h.id = (d->>'task_id')::uuid
       where p.pending_task_id = v_task
         and h.type = 'action_approval' and h.status = 'approved'
         and public.evidence_is_production(h.origin)
         and exists (select 1 from action_executions ex
                      where (ex.task_id = h.id or ex.resolves_task_id = h.id)
                        and public.action_execution_landed(ex));
      if v_cnt < 3 then
        raise exception '711: proposal % cites % ledger-verified decisions — below the floor', v_task, v_cnt;
      end if;
      if exists (select 1 from human_tasks ht where ht.id = v_task
                   and not tenant_is_operational(ht.tenant_id)) then
        raise exception '711: proposal % sits in a NON-OPERATIONAL workspace', v_task;
      end if;
      v_brief := public.compute_trust_proposal_brief(v_task);
      if v_brief is null or jsonb_array_length(v_brief->'evidence') = 0 then
        raise exception '711: proposal % has no computable brief: %', v_task, v_brief;
      end if;
      if not exists (select 1 from approval_briefs b where b.task_id = v_task) then
        raise exception '711: proposal % has NO stored brief row', v_task;
      end if;
      raise notice '711: proposal % verified — % ledger-confirmed citations, workspace operational, brief present', v_task, v_cnt;
    end loop;
  end if;

  -- Anti-amplification, again under the new mapping: a second run raises
  -- nothing and the detector reports zero remaining groups.
  v_out := public.raise_trust_widening_proposals(null);
  if coalesce((v_out->>'raised')::int, -1) <> 0 then
    raise exception '711: a second proposer run raised again: %', v_out;
  end if;
  select count(*) into v_cnt from public.detect_trust_widening_patterns(null);
  if v_cnt <> 0 then
    raise exception '711: detector still reports % qualifying group(s) after raising', v_cnt;
  end if;

  raise notice '711: the proposal rides the ladder the evidence actually climbs. Second run raised 0; detector reports 0 remaining.';
end $assert$;

commit;

notify pgrst, 'reload schema';
