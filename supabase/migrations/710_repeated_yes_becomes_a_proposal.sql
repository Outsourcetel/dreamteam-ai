-- 710_repeated_yes_becomes_a_proposal.sql
-- ==========================================================================
-- GAP 2 (founder-approved): "human approval decisions currently teach the
-- system nothing." Measured before writing: they already teach it HALF of
-- something — mig 682/692's trust_evidence_for counts production-origin
-- action_approval decisions toward action_execute policies, and one policy
-- (outsourcetel-hq's Finance DE, action_execute/erp_financials) has sat
-- ELIGIBLE with nobody asking for the promotion. The whole apply side exists
-- and is proven live: trust_promotion human task → decide_human_task hook #4
-- → apply_trust_promotion (self-approval blocked, evidence RE-VERIFIED at
-- apply) → trust_apply_level → de_autonomy, with trust_demote + its two
-- triggers able to undo any of it automatically. What does NOT exist is the
-- seam that RAISES the proposal: request_trust_promotion demands a signed-in
-- human on the Employee File page (auth.uid() membership check, mig 419
-- guard), so repeated identical approvals accumulate evidence that nobody
-- ever converts into a founder-facing decision. 29:1 decision bottleneck,
-- and the one surface that could shrink it was wired and starved.
--
-- THIS MIGRATION BUILDS ONLY THE MISSING SEAM. No new decision path, no new
-- privilege path, no new dial writer:
--
--   * detect_trust_widening_patterns() — a READER. For each
--     (tenant, employee, action) group of decided approvals it applies the
--     pattern test spelled out below and returns the groups that qualify.
--   * raise_trust_widening_proposals() — a WRITER that files the EXISTING
--     trust_promotion task shape (the one apply_trust_promotion already
--     resolves) with the evidence cited in plain language. Approving it
--     routes through the machinery that already exists, unchanged.
--   * the proposal gets an approval brief through mig 705's machinery —
--     verified here to actually happen, because 705's trigger WHEN clause
--     was action_approval-only and would have silently skipped it.
--   * the DAILY governance sweep (existing cron, 06:45) gains step (e)
--     calling the proposer — no new cron. A breaker that guards nobody
--     (mig 625) taught this repo that built-but-unfed is a defect class;
--     the Ring-0 probe's sweep-unfed arm makes that state a red bar.
--
-- ── THE PATTERN TEST, conjunct by conjunct ────────────────────────────────
--   (1) type = 'action_approval', decided, de_id present. Groups are keyed
--       (tenant, employee, action_definition) — NOT (tenant, action) alone —
--       because the dial being widened is per-employee by founder decision
--       ("rules belong at EMPLOYEE level; no default may apply to all",
--       2026-08-06). Evidence earned by one employee must never widen
--       another's dial.
--   (2) evidence_is_production(origin) — an exam decision NEVER counts
--       toward widening trust (migs 682/707; the self-closing autonomy trap).
--   (3) tenant_is_operational(tenant_id) — a suspended workspace produces
--       NOTHING. acme-telecom's 79 zombie pending approvals are pending, not
--       decided, so they fail (1) too; this conjunct is what excludes its 2
--       DECIDED approvals as well.
--   (4) the action is NOT destructive. The destructive gate sits ABOVE the
--       dial by architecture — widening trust on a destructive action opens
--       nothing, and a green badge on a door that cannot open is the mig-692
--       lie. This single conjunct is why kinetic's 8 decided approvals
--       (create_digital_employee ×4 etc., all destructive platform_admin
--       verbs) produce no proposal.
--   (5) an approval counts only when it was CARRIED OUT AND LANDED: at least
--       one linked execution passes action_execution_landed (mig 679, THE
--       one definition) and NO linked execution is rolled back, failed, or
--       contradicted by its own result.
--   (6) VOID-RESET: the pattern restarts from zero at the latest of — a
--       rejection in the group, a rollback in the group, a DECLINED prior
--       proposal on the governing policy. Only approvals decided AFTER that
--       moment count. This is the stated re-raise window: after a decline,
--       all N must re-accumulate from scratch; "one new approval" does not
--       reopen the question the founder just closed.
--   (7) window: the governing policy's own window_days (default 30) — the
--       same window trust_evidence_for uses, so the proposal and the
--       apply-time re-verification look at the same horizon.
--   (8) N >= 3 identical clean approvals. WHY 3: it is the founder-ratified
--       human-evidence floor — mig 683 D3 set min_human_samples >= 3 on
--       every action-shaped ladder (the Finance DE's proven criteria). A
--       group threshold BELOW the policy floor would raise proposals the
--       policy itself refuses at apply time (stale-check), manufacturing
--       decline-noise; a higher one wastes exactly the founder clicks this
--       gap exists to save. N is a floor on the PATTERN; the policy's own
--       criteria still apply in full through conjunct (10).
--   (9) the group maps to an ACTIVE, employee-scoped trust policy,
--       specific-first (action_key > action:<category> > action_execute
--       with matching source_category > action_execute unscoped),
--       mirroring the dial's own specific-first resolution (mig 618). The
--       policy must be below its ceiling (least(3, max_level), mig 692) and
--       have NO open proposal (pending_task_id — ONE open proposal per
--       group, enforced at the policy the group maps to).
--  (10) trust_evidence_for(policy) says ELIGIBLE — the existing evidence
--       bar (approval rate, guardrail blocks, sample floors) must ALSO
--       pass. The pattern is necessary, never sufficient.
--
-- ── ⛔ THE AUTHORITY BOUNDARY — privilege, not promise ────────────────────
-- The proposer must have ZERO ability to move a dial, decide a task, or
-- execute anything. Mig 705's construction, reused:
--   * a NOLOGIN role `trust_pattern_proposer` OWNS the writer (SECURITY
--     DEFINER ⇒ it is the runtime identity);
--   * the role holds EXACTLY: EXECUTE on the detector (postgres-owned,
--     STABLE — the engine itself refuses writes inside it), INSERT on
--     human_tasks (RLS-scoped to pending trust_promotion rows with no
--     de_id), column-scoped UPDATE on trust_policies limited to the four
--     request-bookkeeping columns (pending_task_id, pending_evidence,
--     requested_by, requested_at) plus SELECT on the two columns the WHERE
--     clause reads, EXECUTE on append_audit_event_internal (append-only)
--     and on refresh_approval_briefs_internal (the mig-705 brief writer —
--     advisory output only);
--   * it holds NO UPDATE/DELETE on human_tasks (status IS the decision), NO
--     EXECUTE on decide_human_task / apply_trust_promotion /
--     trust_apply_level / trust_demote / set_de_autonomy, NO write of any
--     kind on de_autonomy (the dial) or approval_authority (the limits),
--     and NO UPDATE on trust_policies.current_level/max_level/status.
--   * Ring-0 probe `trust-proposer-cannot-decide`
--     (scripts/trust-proposer-boundary.mjs) re-asserts all of this every
--     certify run — privilege proof AND evidence proof (every OPEN
--     system-raised proposal must cite >= 3 decisions that the LEDGER,
--     re-read at probe time, confirms as approved + production + landed;
--     stored citations are never trusted as truth, mig 642's lesson) —
--     with the denominator printed.
--
-- requested_by is left NULL on system-raised proposals: there is no human
-- requester to self-approve, and NULL is the marker the probe uses to hold
-- system proposals to the evidence bar. apply_trust_promotion's self-approval
-- block reads `auth.uid() = requested_by`, which never fires on NULL —
-- correct: ANY human teammate deciding it is the independent judgment.
--
-- ── WHAT IS DELIBERATELY LEFT ALONE ───────────────────────────────────────
--   * request_trust_promotion / apply_trust_promotion / trust_apply_level /
--     trust_demote: UNTOUCHED. The proposal is the same task shape the
--     existing hook resolves.
--   * The demotion path: untouched, and by construction able to undo
--     anything a proposal widens (trust_demote floors at baseline_level).
--   * trust_evidence_for's else-branch (action:<category> policies count
--     only inquiry_review/escalation/review_gate, never action_approval) —
--     FOUND, NOT FIXED: it means a category-scoped ladder cannot become
--     eligible from approvals alone. Founder-ratified criteria (mig 683)
--     shipped over that branch; changing what counts as evidence is a
--     product decision, not a side effect of this seam. Named in the report.
--   * Auto-approve: still does not exist, still a founder decision.
-- ==========================================================================

begin;

-- ── 0. The role. NOLOGIN; granted to postgres so this migration can
--      own-transfer and so the daily sweep (running as postgres) can call
--      the writer it owns. ────────────────────────────────────────────────
do $role$
begin
  if not exists (select 1 from pg_roles where rolname = 'trust_pattern_proposer') then
    create role trust_pattern_proposer nologin;
  end if;
end $role$;

grant trust_pattern_proposer to postgres;
grant usage on schema public to trust_pattern_proposer;
-- CREATE is needed only for the ownership transfer below and is revoked at
-- the end of this migration: a role that exists to file proposals has no
-- business creating objects.
grant create on schema public to trust_pattern_proposer;

-- ── 1. THE DETECTOR — a reader. postgres-owned (RLS-bypassing, like mig
--      705's evidence readers: its population deliberately spans tenants),
--      STABLE so the engine itself refuses any write attempted inside it,
--      EXECUTE only for the proposer role and the service role — its output
--      names other tenants' evidence, so `authenticated` never reaches it. ─
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
  -- (9): the governing policy — employee-scoped, active, specific-first
  -- (the dial's own resolution order, mig 618), below its ceiling (692),
  -- with no OPEN proposal (one open proposal per group).
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
       order by case
           when tp.action_category = g.g_action_key then 0
           when tp.action_category = 'action:' || coalesce(g.g_category, '') then 1
           when tp.source_category = g.g_category then 2
           else 3 end
       limit 1
    ) p on true
   where p.pending_task_id is null
      or not exists (select 1 from human_tasks h
                      where h.id = p.pending_task_id and h.status = 'pending')
),
reset_full as (
  -- (6): the void-reset moment — a decline of a prior proposal on this
  -- policy restarts the pattern alongside rejections and rollbacks.
  select p.*, greatest(p.base_reset,
    coalesce((select max(h.decided_at) from human_tasks h
               where h.type = 'trust_promotion' and h.related_table = 'trust_policies'
                 and h.related_id = p.pol_id and h.status = 'rejected'),
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
-- (8) the N, and (10) the existing evidence bar. `k.n_ok >= 3` IS the
-- pattern floor — the Ring-0 probe pins this exact token; changing N means
-- changing it here AND there, out loud.
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

comment on function public.detect_trust_widening_patterns(uuid) is
  'GAP 2 pattern detector — READ ONLY. Returns (tenant, employee, action) '
  'groups where >= 3 identical human approvals (production evidence, every '
  'one landed via mig 679''s shared predicate, zero rejections/rollbacks '
  'since the last void-reset) map to an active employee-scoped trust policy '
  'that mig 682/692''s trust_evidence_for independently marks eligible. It '
  'proposes nothing, decides nothing, writes nothing — STABLE enforces that. '
  'Ring-0 probe trust-proposer-cannot-decide holds the boundary.';

revoke execute on function public.detect_trust_widening_patterns(uuid)
  from public, anon, authenticated;
grant execute on function public.detect_trust_widening_patterns(uuid)
  to trust_pattern_proposer, service_role;

-- ── 2. The proposer role's write surface, exactly and only ────────────────
-- INSERT on human_tasks, RLS-scoped to the one row shape a proposal is.
-- (Restrictive policy human_tasks_de_scope_write passes because de_id IS
-- NULL — the same shape request_trust_promotion has always inserted.)
grant insert on public.human_tasks to trust_pattern_proposer;

-- human_tasks' EXISTING policies reference auth_tenant_id() and
-- can_access_de() — both EXECUTE-revoked from PUBLIC by the perimeter work —
-- and Postgres does NOT guarantee short-circuit order across policy
-- expressions, so the role must be able to EVALUATE them even though both
-- return NULL/false in its JWT-less context (mig 705 hit exactly this on
-- auth_tenant_id and had to grant it to approval_brief_writer).
grant execute on function public.auth_tenant_id() to trust_pattern_proposer;
grant execute on function public.can_access_de(uuid) to trust_pattern_proposer;

drop policy if exists human_tasks_proposer_insert on public.human_tasks;
create policy human_tasks_proposer_insert on public.human_tasks
  for insert to trust_pattern_proposer
  with check (type = 'trust_promotion' and de_id is null and status = 'pending');

-- trust_policies: the four request-bookkeeping columns ONLY (the same four
-- request_trust_promotion writes), plus SELECT on the two columns the
-- writer's WHERE reads. current_level is NOT in this list — the probe
-- asserts that in both directions.
grant select (id, pending_task_id) on public.trust_policies to trust_pattern_proposer;
grant update (pending_task_id, pending_evidence, requested_by, requested_at)
  on public.trust_policies to trust_pattern_proposer;

drop policy if exists trust_policies_proposer_update on public.trust_policies;
create policy trust_policies_proposer_update on public.trust_policies
  for update to trust_pattern_proposer
  using (true) with check (true);

-- ⚠ The UPDATE policy alone is NOT enough: an UPDATE whose WHERE clause
-- reads columns also has SELECT policies applied to that read (PG docs, and
-- PROVEN on dev — without this policy the writer's UPDATE matched 0 rows
-- SILENTLY and a second sweep re-raised the same proposal). The column
-- grants above still bound what it can read to (id, pending_task_id).
drop policy if exists trust_policies_proposer_read on public.trust_policies;
create policy trust_policies_proposer_read on public.trust_policies
  for select to trust_pattern_proposer
  using (true);

-- The audit chain (append-only) and the mig-705 brief writer (advisory
-- output only) are the role's two reachable side channels; neither can
-- decide anything, and the probe's reachable-decider sweep re-checks their
-- bodies every run rather than trusting this sentence.
grant execute on function public.append_audit_event_internal(uuid, text, text, text, text, jsonb)
  to trust_pattern_proposer;
grant execute on function public.refresh_approval_briefs_internal(uuid)
  to trust_pattern_proposer;

-- ── 2b. CLOSE PUBLIC ON THE DECISION/DIAL CLASS — found by this migration's
--       own boundary assert, which refused to apply on dev: PUBLIC still
--       held EXECUTE there on apply_trust_promotion and on STALE overloads
--       of trust_apply_level / trust_demote / set_de_autonomy (the
--       658/659 class — the same revoke landed differently on two
--       databases; prod carries NO PUBLIC grant on any of the five).
--       Without this, `trust_pattern_proposer` — and every other role —
--       inherits the apply hook through PUBLIC and the boundary is theatre
--       on dev while looking identical to prod. Dynamic over pg_proc so
--       stale arities are covered; the named grants prod intends are then
--       restored explicitly (a REVOKE is not a description of the resulting
--       privileges — asserted below, both directions). ────────────────────
do $close$
declare
  f record;
begin
  -- SWEEP-DRIVEN, not a hand-written list: any non-trigger function whose
  -- body matches the decider/dial patterns (the SAME patterns the boundary
  -- assert and the Ring-0 probe use) and is still PUBLIC-executable loses
  -- that grant, service_role explicitly re-granted (the repo convention for
  -- internal callers; a bare revoke stripping service_role is the mig-678
  -- dev failure). On prod this loop finds NOTHING (verified before writing:
  -- migs 610/630 closed PUBLIC); on dev it found apply_trust_promotion,
  -- stale overloads of trust_apply_level / trust_demote / set_de_autonomy,
  -- plus instantiate_role_archetype, retire_digital_employee and
  -- set_trust_ladder.
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind in ('f', 'p')
       and p.prorettype <> 'trigger'::regtype
       and has_function_privilege('public', p.oid, 'EXECUTE')
       and (regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* 'update\s+(public\.)?human_tasks'
         or regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* '\mdecide_human_task\s*\('
         or regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* '\mapply_trust_promotion\s*\('
         or regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* '\mtrust_apply_level\s*\('
         or regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* '\mset_de_autonomy\s*\('
         or regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* '\mtrust_demote\s*\('
         or regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* 'insert\s+into\s+(public\.)?de_autonomy'
         or regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* 'update\s+(public\.)?de_autonomy')
  loop
    execute format('revoke execute on function %s from public', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
    raise notice '710: closed PUBLIC EXECUTE on % (drift from prod, where this class carries no PUBLIC grant)', f.sig;
  end loop;
end $close$;

-- The UI-facing members of the class keep their NAMED authenticated grant
-- (prod's intended, allowlist-pinned surface — verified against
-- supabase/baseline/execute-allowlist.json before writing: each of these is
-- authed=true, anon=false there). Re-issued so an environment where
-- authenticated held them only THROUGH PUBLIC does not lose the product
-- feature to the security fix.
grant execute on function public.decide_human_task(uuid, text, text, text, jsonb)
  to authenticated, service_role;
grant execute on function public.apply_trust_promotion(uuid, text)
  to authenticated, service_role;
grant execute on function public.set_de_autonomy(text, boolean, bigint, integer, uuid, text, uuid)
  to authenticated, service_role;
grant execute on function public.instantiate_role_archetype(uuid, text, text, text)
  to authenticated, service_role;
grant execute on function public.retire_digital_employee(uuid, text)
  to authenticated, service_role;
grant execute on function public.set_trust_ladder(uuid, jsonb, text, jsonb, boolean)
  to authenticated, service_role;

-- ── 3. THE PROPOSER — the writer, owned by the boundary role. ─────────────
create or replace function public.raise_trust_widening_proposals(p_tenant_id uuid default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public', 'extensions'
as $fn$
declare
  r         record;
  v_task    uuid;
  v_title   text;
  v_detail  text;
  v_lines   text;
  v_examined integer := 0;
  v_raised   integer := 0;
  v_tasks    uuid[] := '{}';
  v_done     uuid[] := '{}';
begin
  for r in select * from public.detect_trust_widening_patterns(p_tenant_id) loop
    v_examined := v_examined + 1;
    -- One open proposal per policy, even when two action groups map to the
    -- same ladder in a single sweep.
    if r.policy_id = any(v_done) then continue; end if;
    v_done := v_done || r.policy_id;
    v_task := gen_random_uuid();

    select string_agg(format('- %s, approved by %s. Receipt: %s',
             to_char((d->>'decided_at')::timestamptz, 'YYYY-MM-DD'),
             d->>'decided_by_name',
             coalesce(d->>'receipt', '(none)')), e'\n' order by d->>'decided_at')
      into v_lines
      from jsonb_array_elements(r.evidence->'pattern'->'decisions') d;

    v_title := left(format('Trust proposal — %s: "%s" approved and landed %s times; widen to level %s',
                 r.de_name, coalesce(r.action_label, r.action_key), r.n_approved, r.proposed_level), 300);

    v_detail :=
      format('A human said yes to the same thing %s times. %s asked to run "%s" and a person approved it '
             || 'on every occasion between %s and %s — each run was carried out and LANDED (receipts below), '
             || 'zero rejections, nothing rolled back, production work only (exam activity never counts).',
             r.n_approved, r.de_name, coalesce(r.action_label, r.action_key),
             to_char(r.first_decided, 'YYYY-MM-DD'), to_char(r.last_decided, 'YYYY-MM-DD'))
      || e'\n\n' || v_lines
      || e'\n\n'
      || format('Approving widens ONE dial through the existing trust machinery: "%s" moves from level %s to level %s '
             || '(proposed settings: %s). The evidence is re-verified at the moment of approval and the request is '
             || 'refused if it has gone stale; automatic demotion (a guardrail block or an evaluation regression) '
             || 'can take the widened level away at any time. Rejecting keeps everything gated exactly as today, '
             || 'and this proposal will NOT be re-raised until the full pattern re-accumulates from scratch after '
             || 'this decline. Raised automatically by the trust pattern detector — no human requested it.',
             r.policy_category, r.current_level, r.proposed_level,
             coalesce((r.evidence->'dial'->'proposed_settings')::text, '(defaults)'));

    insert into human_tasks (id, tenant_id, type, title, detail, source, related_table, related_id, status)
    values (v_task, r.tenant_id, 'trust_promotion', v_title, v_detail,
            'system', 'trust_policies', r.policy_id, 'pending');

    -- The linkage apply_trust_promotion resolves the task through. NULL
    -- requested_by = system-raised (no requester to self-approve; the
    -- probe's marker for holding it to the evidence bar).
    update trust_policies
       set pending_task_id = v_task,
           pending_evidence = r.evidence,
           requested_by = null,
           requested_at = now()
     where id = r.policy_id;

    perform public.append_audit_event_internal(
      r.tenant_id, 'Trust pattern detector', 'system',
      format('Trust-widening proposal raised — %s identical landed approvals of "%s" by %s; "%s" level %s -> %s awaits a human decision',
             r.n_approved, coalesce(r.action_label, r.action_key), r.de_name,
             r.policy_category, r.current_level, r.proposed_level),
      'config_change',
      jsonb_build_object('kind', 'trust_widening_proposed',
        'policy_id', r.policy_id, 'task_id', v_task, 'de_id', r.de_id,
        'action_key', r.action_key, 'n_approved', r.n_approved,
        'from_level', r.current_level, 'to_level', r.proposed_level,
        'evidence', r.evidence));

    -- The brief: mig 705's AFTER INSERT trigger wrote a provisional one
    -- BEFORE the policy linkage existed (same statement, earlier moment);
    -- refresh it now so the stored brief is right from birth. Advisory
    -- overlay — its failure must never cost the proposal.
    begin
      perform public.refresh_approval_briefs_internal(r.tenant_id);
    exception when others then
      null;
    end;

    v_raised := v_raised + 1;
    v_tasks := v_tasks || v_task;
  end loop;

  return jsonb_build_object('examined', v_examined, 'raised', v_raised,
                            'task_ids', to_jsonb(v_tasks));
end $fn$;

comment on function public.raise_trust_widening_proposals(uuid) is
  'GAP 2 proposer — files the EXISTING trust_promotion task shape for every '
  'group detect_trust_widening_patterns qualifies, with the evidence cited '
  'in plain language. Runs AS trust_pattern_proposer, which cannot decide a '
  'task, move a dial, or touch approval limits — the boundary is privilege, '
  'held by Ring-0 probe trust-proposer-cannot-decide. Approving the task '
  'routes through decide_human_task -> apply_trust_promotion, unchanged.';

revoke execute on function public.raise_trust_widening_proposals(uuid)
  from public, anon, authenticated;
grant execute on function public.raise_trust_widening_proposals(uuid)
  to service_role;

alter function public.raise_trust_widening_proposals(uuid)
  owner to trust_pattern_proposer;

-- ── 4. THE BRIEF — mig 705's machinery, verified rather than assumed.
--      Its trigger WHEN clause was `type = 'action_approval'` and
--      compute_approval_brief returned NULL for anything else: the proposal
--      would have reached the founder with no brief while the header above
--      promised one. One pipeline, widened; no second brief path. ─────────

-- 4a. The proposal brief reader. Same construction as compute_approval_brief
--     (postgres-owned, STABLE, SECDEF): rail-composed lines, no model call.
create or replace function public.compute_trust_proposal_brief(p_task_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
declare
  t          record;
  pol        trust_policies;
  pat        jsonb;
  n          integer;
  ev         jsonb := '[]'::jsonb;
  v_attention text[] := '{}';
  v_caution   text[] := '{}';
  v_risk     text;
  v_headline text;
begin
  select ht.id, ht.tenant_id, ht.type, ht.status, tn.status as tenant_status
    into t
    from human_tasks ht
    left join tenants tn on tn.id = ht.tenant_id
   where ht.id = p_task_id;
  if not found or t.type <> 'trust_promotion' then
    return null;
  end if;

  select p.* into pol from trust_policies p where p.pending_task_id = p_task_id;

  if pol.id is null then
    ev := ev || to_jsonb('No trust policy is linked to this proposal — approving would decide the task and change NOTHING (the apply hook would no-op).'::text);
    v_attention := array_append(v_attention, 'nothing is behind the button');
  else
    ev := ev || to_jsonb(format('Approving widens "%s" from level %s to level %s for one employee. Evidence is re-verified at apply time; automatic demotion can undo it.',
            pol.action_category, pol.current_level,
            least(pol.current_level + 1, least(3, coalesce(pol.max_level, 3))))::text);

    pat := pol.pending_evidence->'pattern';
    if pat is not null and jsonb_typeof(pat) = 'object' then
      n := coalesce((pat->>'n_approved')::integer, 0);
      ev := ev || to_jsonb(format('%s identical production approvals of "%s" in the last %s days — every one landed, zero rejections. Raised automatically by the pattern detector.',
              n, pat->>'action_key', pat->>'window_days')::text);
      if n < 3 then
        ev := ev || to_jsonb('The citation names fewer decisions than the pattern floor (3) — this proposal should not exist in this state.'::text);
        v_attention := array_append(v_attention, 'cites fewer decisions than the pattern floor');
      end if;
    else
      ev := ev || to_jsonb('Requested by a person from the employee file (no pattern citation) — the policy criteria were met at request time and are re-verified at apply.'::text);
      v_caution := array_append(v_caution, 'human-requested; review the criteria evidence');
    end if;
  end if;

  -- Workspace standing — same rule and same wording family as mig 705.
  if t.tenant_status = 'suspended' or t.tenant_status is null then
    ev := ev || to_jsonb(('This workspace is ' || coalesce(t.tenant_status, 'gone')
          || ' — nothing will execute until it is reinstated.')::text);
    v_attention := array_append(v_attention, 'workspace is ' || coalesce(t.tenant_status, 'gone'));
  elsif t.tenant_status <> 'active' and t.tenant_status <> 'trial' then
    ev := ev || to_jsonb(('Workspace status: ' || t.tenant_status || '.')::text);
  end if;

  if array_length(v_attention, 1) is not null then
    v_risk := 'attention';
    v_headline := 'Needs attention — ' || array_to_string(v_attention, '; ') || '.';
  elsif array_length(v_caution, 1) is not null then
    v_risk := 'caution';
    v_headline := 'Worth a look — ' || array_to_string(v_caution, '; ') || '.';
  else
    v_risk := 'routine';
    v_headline := format('Looks routine — %s identical landed approvals earned this; approving widens one dial, and demotion can undo it.', coalesce(n, 0));
  end if;

  return jsonb_build_object(
    'risk', v_risk,
    'headline', v_headline,
    'evidence', ev,
    'category', 'trust_promotion',
    'amount_cents', null
  );
end $fn$;

comment on function public.compute_trust_proposal_brief(uuid) is
  'ADVISORY ONLY — the trust-proposal face of mig 705''s brief layer. '
  'Deterministic, rail-composed, STABLE. Called by compute_approval_brief '
  'for type=trust_promotion tasks; never decides anything.';

revoke execute on function public.compute_trust_proposal_brief(uuid)
  from public, anon, authenticated;
grant execute on function public.compute_trust_proposal_brief(uuid)
  to approval_brief_writer, service_role;

-- 4b. compute_approval_brief learns to dispatch. Body is mig 705's VERBATIM
--     except the two-line dispatch at the top (the type test widens and the
--     trust_promotion branch delegates). Regenerated from the applied
--     migration text, not retyped from memory (the mig-377 rule).
create or replace function public.compute_approval_brief(p_task_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
declare
  t          record;
  ex         record;
  v_category text;
  v_amount   bigint;
  v_appr     int := 0;
  v_rej      int := 0;
  v_last     date;
  v_exact    boolean := false;
  v_landed   int := 0;
  v_landed_at date;
  v_batch    int := 0;
  v_dials    record;
  ev         jsonb := '[]'::jsonb;
  v_attention text[] := '{}';
  v_caution   text[] := '{}';
  v_risk     text;
  v_headline text;
  v_money    text;
begin
  select ht.id, ht.tenant_id, ht.type, ht.status, ht.updated_at,
         tn.status as tenant_status
    into t
    from human_tasks ht
    left join tenants tn on tn.id = ht.tenant_id
   where ht.id = p_task_id;
  if not found or t.type not in ('action_approval', 'trust_promotion') then
    return null;
  end if;
  -- mig 710: a trust-widening proposal gets its own rail-composed brief.
  if t.type = 'trust_promotion' then
    return public.compute_trust_proposal_brief(p_task_id);
  end if;

  -- The gated execution behind the button, by EITHER linkage column —
  -- resolves_task_id was unpopulated before August (mig 642's lesson: a
  -- linkage column is not a fact, so read both).
  select ae.id, ae.action_definition_id, ae.request_summary,
         ad.action_key, ad.category, ad.label,
         coalesce((ad.risk->>'destructive')::boolean, false) as destructive
    into ex
    from action_executions ae
    join action_definitions ad on ad.id = ae.action_definition_id
   where (ae.task_id = p_task_id or ae.resolves_task_id = p_task_id)
     and ae.decision like 'human_gated%'
   order by ae.created_at desc
   limit 1;

  -- Category and amount through THE definition the authority gate itself
  -- reads (mig 593) — never a re-derivation that can drift from it.
  select f.category, f.amount_cents into v_category, v_amount
    from task_approval_facts(p_task_id) f;

  -- ── Evidence line: the executor ─────────────────────────────────────────
  if ex.id is null then
    ev := ev || to_jsonb('No executor is linked to this approval — approving would mark it approved and send nothing.'::text);
    v_attention := array_append(v_attention, 'nothing is behind the button');
  else
    ev := ev || to_jsonb(('Action: ' || coalesce(ex.label, ex.action_key)
          || ' (' || coalesce(ex.category, 'uncategorised') || ').'
          || case when ex.destructive
                  then ' Destructive — approving sends or changes something outside the platform.'
                  else '' end)::text);
  end if;

  -- ── Evidence line: identical prior decisions (same workspace, same
  --    action definition — the strictest honest meaning of "identical") ──
  if ex.id is not null then
    select count(distinct h2.id) filter (where h2.status = 'approved'),
           count(distinct h2.id) filter (where h2.status = 'rejected'),
           max(h2.decided_at)::date
      into v_appr, v_rej, v_last
      from human_tasks h2
      join action_executions ae2
        on (ae2.task_id = h2.id or ae2.resolves_task_id = h2.id)
     where h2.tenant_id = t.tenant_id
       and h2.type = 'action_approval'
       and h2.status in ('approved','rejected')
       and ae2.action_definition_id = ex.action_definition_id;

    if coalesce(v_appr,0) + coalesce(v_rej,0) = 0 then
      ev := ev || to_jsonb('No prior decision on this action in this workspace — this is the first of its kind here.'::text);
      v_caution := array_append(v_caution, 'first of its kind here');
    else
      ev := ev || to_jsonb((v_appr || ' identical prior request(s) approved in this workspace'
            || case when v_last is not null then ' (most recent ' || v_last || ')' else '' end
            || '; ' || v_rej || ' rejected.')::text);
      if v_rej > 0 and v_appr = 0 then
        v_attention := array_append(v_attention, 'every prior identical request was rejected');
      elsif v_rej > 0 then
        v_caution := array_append(v_caution, 'this action has been rejected here before');
      end if;
    end if;

    -- Exact repeat: the same request summary, already decided.
    select exists (
      select 1 from human_tasks h3
        join action_executions ae3
          on (ae3.task_id = h3.id or ae3.resolves_task_id = h3.id)
       where h3.tenant_id = t.tenant_id and h3.type = 'action_approval'
         and h3.status in ('approved','rejected')
         and ae3.action_definition_id = ex.action_definition_id
         and ae3.request_summary is not distinct from ex.request_summary
    ) into v_exact;
    if v_exact then
      ev := ev || to_jsonb('This exact request (same summary) has been decided here before.'::text);
    end if;

    -- Did the work actually LAND when it was approved? Through THE shared
    -- predicate (mig 679), never an open-coded copy.
    select count(*), max(ex2.created_at)::date into v_landed, v_landed_at
      from action_executions ex2
     where ex2.tenant_id = t.tenant_id
       and ex2.action_definition_id = ex.action_definition_id
       and public.action_execution_landed(ex2);
    if v_landed > 0 then
      ev := ev || to_jsonb(('The last execution of this action here landed ('
            || v_landed_at || '); ' || v_landed || ' landed in total.')::text);
    elsif coalesce(v_appr,0) > 0 then
      ev := ev || to_jsonb('Approved runs of this action have NEVER landed in this workspace — approval has not been producing results.'::text);
      v_caution := array_append(v_caution, 'past approvals never landed');
    else
      ev := ev || to_jsonb('This action has never executed in this workspace.'::text);
    end if;

    -- Batch context: how many of this same thing are queued right now.
    select count(*) into v_batch
      from human_tasks h4
      join action_executions ae4
        on (ae4.task_id = h4.id or ae4.resolves_task_id = h4.id)
     where h4.tenant_id = t.tenant_id and h4.type = 'action_approval'
       and h4.status = 'pending' and h4.id <> p_task_id
       and ae4.action_definition_id = ex.action_definition_id;
    if v_batch > 0 then
      ev := ev || to_jsonb(('One of ' || (v_batch + 1) || ' pending requests for this same action in this queue.')::text);
    end if;

    if ex.destructive and coalesce(v_appr,0) = 0 then
      v_attention := array_append(v_attention, 'destructive with no precedent');
    end if;
  end if;

  -- ── Evidence line: the money against the workspace's dials (migs 626/7) ─
  if v_amount is null then
    ev := ev || to_jsonb('No amount is attached to this request.'::text);
  else
    v_money := '$' || to_char(round(v_amount / 100.0, 2), 'FM999,999,999,990.00');
    select count(*) as n,
           bool_or(a.max_amount_cents is null) as unlimited,
           max(a.max_amount_cents) as ceiling,
           min(a.second_approver_above_cents) as second_above
      into v_dials
      from approval_authority a
     where a.tenant_id = t.tenant_id and a.is_active
       and (a.category is null or a.category = v_category);
    if coalesce(v_dials.n, 0) = 0 then
      ev := ev || to_jsonb((v_money || ' attached; no approval limits are declared for this kind of work, so the permissive default applies.')::text);
    elsif coalesce(v_dials.unlimited, false) or v_amount <= coalesce(v_dials.ceiling, 0) then
      ev := ev || to_jsonb((v_money || ' is within this workspace''s approval limits'
            || case when coalesce(v_dials.unlimited, false) then ' (an unlimited grant exists)'
                    else ' (top ceiling $' || to_char(round(v_dials.ceiling / 100.0, 2), 'FM999,999,999,990.00') || ')' end
            || '.')::text);
    else
      ev := ev || to_jsonb((v_money || ' is ABOVE every declared ceiling for this kind of work (max $'
            || to_char(round(coalesce(v_dials.ceiling,0) / 100.0, 2), 'FM999,999,999,990.00') || ').')::text);
      v_attention := array_append(v_attention, 'amount above every declared ceiling');
    end if;
    if v_dials.second_above is not null and v_amount > v_dials.second_above then
      -- min() across ALL matching grants, so this is the most conservative
      -- threshold — an unlimited owner may not need the second signature.
      -- "may", honestly, never "will".
      ev := ev || to_jsonb(('Crosses the lowest second-signature threshold ($'
            || to_char(round(v_dials.second_above / 100.0, 2), 'FM999,999,999,990.00')
            || ') — depending on who approves, a second approver may be required.')::text);
      v_caution := array_append(v_caution, 'may need a second signature');
    end if;
  end if;

  -- ── Evidence line: workspace standing. Only SUSPENSION is the dormancy
  --    state where deciding achieves nothing (tenant-suspension machinery);
  --    'trial' operates normally and must not cry wolf — a rank that flags
  --    every trial workspace teaches people to ignore 'attention'. ────────
  if t.tenant_status = 'suspended' or t.tenant_status is null then
    ev := ev || to_jsonb(('This workspace is ' || coalesce(t.tenant_status, 'gone')
          || ' — nothing will execute until it is reinstated.')::text);
    v_attention := array_append(v_attention, 'workspace is ' || coalesce(t.tenant_status, 'gone'));
  elsif t.tenant_status <> 'active' and t.tenant_status <> 'trial' then
    ev := ev || to_jsonb(('Workspace status: ' || t.tenant_status || '.')::text);
  end if;

  -- ── The rank and the advisory sentence — rail-composed, never a model ───
  if array_length(v_attention, 1) is not null then
    v_risk := 'attention';
    v_headline := 'Needs attention — ' || array_to_string(v_attention, '; ') || '.';
  elsif array_length(v_caution, 1) is not null then
    v_risk := 'caution';
    v_headline := 'Worth a look — ' || array_to_string(v_caution, '; ') || '.';
  else
    v_risk := 'routine';
    v_headline := 'Looks routine — ' || v_appr || ' identical prior approval(s), none rejected'
      || case when v_landed > 0 then ', and the last run landed.' else '.' end;
  end if;

  return jsonb_build_object(
    'risk', v_risk,
    'headline', v_headline,
    'evidence', ev,
    'category', v_category,
    'amount_cents', v_amount
  );
end $fn$;

-- CREATE OR REPLACE preserves the ACL (approval_brief_writer + service_role,
-- nobody else) — re-asserted below anyway.

-- 4c. The population reader includes proposals now.
create or replace function public.pending_approval_briefables(p_tenant_id uuid)
returns table (task_id uuid, task_updated_at timestamptz)
language sql
stable
security definer
set search_path to 'public'
as $fn$
  select ht.id, ht.updated_at
    from human_tasks ht
   where ht.tenant_id = p_tenant_id
     and ht.type in ('action_approval', 'trust_promotion')
     and ht.status = 'pending';
$fn$;

-- 4d. The birth trigger covers proposals too.
drop trigger if exists trg_approval_brief_on_new_task on human_tasks;
create trigger trg_approval_brief_on_new_task
  after insert on human_tasks
  for each row
  when (new.type in ('action_approval', 'trust_promotion') and new.status = 'pending')
  execute function public.approval_brief_on_new_task();

-- ── 5. THE FEED — step (e) on the EXISTING daily governance sweep (cron
--      de-governance-sweep-daily, 06:45). Body regenerated from the LIVE
--      production definition read on 2026-08-12 (pg_get_functiondef), not
--      retyped — steps (a)-(d) are byte-identical; only the declaration of
--      v_prop, step (e) and the return key are new. No new cron. ──────────
create or replace function public.de_governance_sweep_internal()
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_cert record;
  v_pip record;
  v_inc record;
  m record;
  v_warned integer := 0;
  v_expired integer := 0;
  v_pip_completed integer := 0;
  v_pip_failed integer := 0;
  v_sla integer := 0;
  v_de_name text;
  v_passing boolean;
  v_prop jsonb;
begin
  -- (a) Expiring within 14 days → one warning audit event per cert.
  for v_cert in
    select c.*, de.name as de_name from de_certifications c
    join digital_employees de on de.id = c.de_id
    where c.status = 'active' and c.warned_at is null
      and c.expires_at <= now() + interval '14 days' and c.expires_at > now()
      and tenant_is_operational(c.tenant_id)
  loop
    update de_certifications set warned_at = now() where id = v_cert.id;
    perform append_audit_event_internal(
      v_cert.tenant_id, 'Governance sweep', 'system',
      format('%s''s %s certification expires %s — recertify to keep it current', v_cert.de_name, v_cert.cert_type, to_char(v_cert.expires_at, 'YYYY-MM-DD')),
      'config_change',
      jsonb_build_object('kind', 'certification_expiring', 'cert_id', v_cert.id, 'de_id', v_cert.de_id)
    );
    v_warned := v_warned + 1;
  end loop;

  -- (b) Expired → status flip + incident (dedup via unique source key).
  for v_cert in
    select c.*, de.name as de_name from de_certifications c
    join digital_employees de on de.id = c.de_id
    where c.status = 'active' and c.expires_at <= now()
      and tenant_is_operational(c.tenant_id)
  loop
    update de_certifications set status = 'expired' where id = v_cert.id;
    insert into de_incidents (tenant_id, de_id, kind, severity, title, detail, source_table, source_id, occurred_at)
    values (v_cert.tenant_id, v_cert.de_id, 'certification_expired', 'warning',
      format('%s certification expired — %s', initcap(v_cert.cert_type), v_cert.de_name),
      jsonb_build_object('cert_id', v_cert.id, 'cert_type', v_cert.cert_type, 'scope', v_cert.scope,
                         'issued_by', v_cert.issued_by_name, 'expired_at', v_cert.expires_at),
      'de_certifications', v_cert.id, v_cert.expires_at)
    on conflict (tenant_id, source_table, source_id) do nothing;
    v_expired := v_expired + 1;
  end loop;

  -- (c) Overdue open PIPs → RE-MEASURE on a fresh 4-week window: now
  --     passing → completed (closed loop); still failing → 'failed' +
  --     CRITICAL incident for human trust review.
  for v_pip in
    select i.* from de_development_items i
    where i.item_type = 'pip' and i.source = 'detected'
      and i.status in ('proposed', 'in_progress') and i.due_date < current_date
      and tenant_is_operational(i.tenant_id)
  loop
    select name into v_de_name from digital_employees where id = v_pip.de_id;
    v_passing := false;
    for m in select * from get_de_performance_metrics(v_pip.tenant_id, 4) where de_id = v_pip.de_id loop
      v_passing := m.total_decisions >= 10
        and m.escalation_rate <= 50 and m.avg_confidence >= 50 and m.error_rate <= 15;
    end loop;

    if v_passing then
      update de_development_items set status = 'completed', completed_at = now(), updated_at = now() where id = v_pip.id;
      perform append_audit_event_internal(
        v_pip.tenant_id, 'Governance sweep', 'system',
        format('%s met its Performance Improvement Plan targets — PIP closed', coalesce(v_de_name, 'Employee')),
        'config_change',
        jsonb_build_object('kind', 'pip_completed', 'item_id', v_pip.id, 'de_id', v_pip.de_id)
      );
      v_pip_completed := v_pip_completed + 1;
    else
      update de_development_items set status = 'failed', updated_at = now() where id = v_pip.id;
      insert into de_incidents (tenant_id, de_id, kind, severity, title, detail, source_table, source_id, occurred_at)
      values (v_pip.tenant_id, v_pip.de_id, 'pip_failed', 'critical',
        format('Performance Improvement Plan failed — %s', coalesce(v_de_name, 'employee')),
        jsonb_build_object('item_id', v_pip.id, 'due_date', v_pip.due_date,
          'consequence', v_pip.consequence,
          'next_step', 'A human decides here: trust reduction, added approval gates, or pause (Pause is on the employee profile).'),
        'de_development_items', v_pip.id, now())
      on conflict (tenant_id, source_table, source_id) do nothing;
      v_pip_failed := v_pip_failed + 1;
    end if;
  end loop;

  -- (d) §10.3: critical incidents should be reviewed within 48 hours —
  --     one nudge each (detail flag dedup).
  for v_inc in
    select * from de_incidents
    where status = 'open' and severity = 'critical'
      and created_at < now() - interval '48 hours'
      and coalesce(detail->>'sla_nudged', '') = ''
      and tenant_is_operational(tenant_id)
  loop
    update de_incidents set detail = detail || '{"sla_nudged": true}'::jsonb where id = v_inc.id;
    perform append_audit_event_internal(
      v_inc.tenant_id, 'Governance sweep', 'system',
      format('Critical incident open past the 48-hour review window: %s', left(v_inc.title, 160)),
      'config_change',
      jsonb_build_object('kind', 'incident_sla_nudge', 'incident_id', v_inc.id, 'de_id', v_inc.de_id)
    );
    v_sla := v_sla + 1;
  end loop;

  -- (e) mig 710: repeated identical human approvals become a trust-widening
  --     PROPOSAL (never a decision — a human still approves it, through
  --     decide_human_task, like every other task). SECURITY DEFINER
  --     dispatch: the callee is owned by trust_pattern_proposer, so this
  --     step runs with that role's privileges, which cannot decide or move
  --     a dial. Errors are captured, not swallowed silently — they ride in
  --     the return payload; a proposer failure must not cost steps (a)-(d).
  begin
    v_prop := public.raise_trust_widening_proposals(null);
  exception when others then
    v_prop := jsonb_build_object('error', sqlerrm);
  end;

  return jsonb_build_object('cert_warnings', v_warned, 'certs_expired', v_expired,
    'pips_completed', v_pip_completed, 'pips_failed', v_pip_failed, 'sla_nudges', v_sla,
    'trust_proposals', coalesce(v_prop, '{}'::jsonb));
end;
$function$;

-- ── 6. FIRST RUN — on the environment being migrated, through the REAL
--      writer under the REAL role (SECURITY DEFINER dispatch), so every
--      grant and policy above is exercised at apply time, not trusted. ────
do $first_run$
declare
  v_out jsonb;
begin
  v_out := public.raise_trust_widening_proposals(null);
  raise notice '710: first proposer run: %', v_out;
end $first_run$;

-- ══ PROVE IT ══════════════════════════════════════════════════════════════
do $assert$
declare
  v_cnt    int;
  v_owner  name;
  v_vol    "char";
  v_secdef boolean;
  v_src    text;
  v_task   uuid;
  v_brief  jsonb;
  v_out    jsonb;
  v_col    text;
begin
  -- ── A. THE BOUNDARY, asserted not stated (a REVOKE is not a description
  --       of the resulting privileges; these answer THROUGH inheritance). ──
  if has_function_privilege('trust_pattern_proposer',
       'public.decide_human_task(uuid,text,text,text,jsonb)', 'EXECUTE') then
    raise exception '710: trust_pattern_proposer can EXECUTE decide_human_task — the proposer can decide, the one thing it must never do';
  end if;
  if has_function_privilege('trust_pattern_proposer',
       'public.apply_trust_promotion(uuid,text)', 'EXECUTE') then
    raise exception '710: trust_pattern_proposer can EXECUTE apply_trust_promotion — it could apply its own proposal';
  end if;
  if has_function_privilege('trust_pattern_proposer',
       'public.trust_apply_level(uuid,text,integer,uuid,text,uuid)', 'EXECUTE') then
    raise exception '710: trust_pattern_proposer can EXECUTE trust_apply_level — a direct path to the dial';
  end if;
  if has_function_privilege('trust_pattern_proposer',
       'public.trust_demote(uuid,text,text,jsonb,uuid,text)', 'EXECUTE') then
    raise exception '710: trust_pattern_proposer can EXECUTE trust_demote — the dial, from the other side';
  end if;
  if has_table_privilege('trust_pattern_proposer', 'public.human_tasks', 'UPDATE')
     or has_table_privilege('trust_pattern_proposer', 'public.human_tasks', 'DELETE') then
    raise exception '710: trust_pattern_proposer can UPDATE/DELETE human_tasks — status IS the decision';
  end if;
  if has_table_privilege('trust_pattern_proposer', 'public.de_autonomy', 'INSERT')
     or has_table_privilege('trust_pattern_proposer', 'public.de_autonomy', 'UPDATE')
     or has_table_privilege('trust_pattern_proposer', 'public.de_autonomy', 'DELETE')
     or has_any_column_privilege('trust_pattern_proposer', 'public.de_autonomy', 'UPDATE') then
    raise exception '710: trust_pattern_proposer holds a write privilege on de_autonomy — THE dial';
  end if;
  if has_table_privilege('trust_pattern_proposer', 'public.approval_authority', 'INSERT')
     or has_table_privilege('trust_pattern_proposer', 'public.approval_authority', 'UPDATE')
     or has_table_privilege('trust_pattern_proposer', 'public.approval_authority', 'DELETE')
     or has_any_column_privilege('trust_pattern_proposer', 'public.approval_authority', 'UPDATE') then
    raise exception '710: trust_pattern_proposer holds a write privilege on approval_authority — the limits';
  end if;
  -- Column scope on trust_policies, BOTH directions: the four bookkeeping
  -- columns yes, the level/status columns never.
  foreach v_col in array array['current_level', 'max_level', 'status', 'criteria', 'ladder', 'action_category', 'de_id'] loop
    if has_column_privilege('trust_pattern_proposer', 'public.trust_policies', v_col, 'UPDATE') then
      raise exception '710: trust_pattern_proposer can UPDATE trust_policies.% — outside the request-bookkeeping columns', v_col;
    end if;
  end loop;
  foreach v_col in array array['pending_task_id', 'pending_evidence', 'requested_by', 'requested_at'] loop
    if not has_column_privilege('trust_pattern_proposer', 'public.trust_policies', v_col, 'UPDATE') then
      raise exception '710: trust_pattern_proposer LOST UPDATE on trust_policies.% — proposals would silently stop', v_col;
    end if;
  end loop;
  if not has_table_privilege('trust_pattern_proposer', 'public.human_tasks', 'INSERT') then
    raise exception '710: trust_pattern_proposer LOST INSERT on human_tasks — it can no longer file a proposal';
  end if;

  -- Nothing the role can reach (excluding uncallable trigger fns) may write
  -- the queue, call a decider, or reach the dial.
  select count(*) into v_cnt
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind in ('f','p')
     and p.prorettype <> 'trigger'::regtype
     and has_function_privilege('trust_pattern_proposer', p.oid, 'EXECUTE')
     and (regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* 'update\s+(public\.)?human_tasks'
       or regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* '\mdecide_human_task\s*\('
       or regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* '\mapply_trust_promotion\s*\('
       or regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* '\mtrust_apply_level\s*\('
       or regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* '\mset_de_autonomy\s*\('
       or regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* '\mtrust_demote\s*\('
       or regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* 'insert\s+into\s+(public\.)?de_autonomy'
       or regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* 'update\s+(public\.)?de_autonomy');
  if v_cnt > 0 then
    raise exception '710: % function(s) reachable by trust_pattern_proposer can decide, write the queue, or move a dial — the two-paths trap', v_cnt;
  end if;

  -- ── B. Identity: the writer runs AS the role; the readers cannot write. ─
  select r.rolname, p.prosecdef into v_owner, v_secdef
    from pg_proc p join pg_roles r on r.oid = p.proowner
   where p.oid = 'public.raise_trust_widening_proposals(uuid)'::regprocedure;
  if v_owner <> 'trust_pattern_proposer' or not v_secdef then
    raise exception '710: raise_trust_widening_proposals is owned by % (secdef %) — the boundary role is not its runtime identity', v_owner, v_secdef;
  end if;
  select r.rolname, p.provolatile into v_owner, v_vol
    from pg_proc p join pg_roles r on r.oid = p.proowner
   where p.oid = 'public.detect_trust_widening_patterns(uuid)'::regprocedure;
  if v_owner <> 'postgres' then
    raise exception '710: detect_trust_widening_patterns is owned by % — the reader bypasses RLS deliberately and must stay under postgres', v_owner;
  end if;
  if v_vol not in ('s','i') then
    raise exception '710: detect_trust_widening_patterns is VOLATILE — a reader that may write is a writer in waiting';
  end if;

  -- The detector still carries its load-bearing conjuncts and the N.
  select p.prosrc into v_src from pg_proc p
   where p.oid = 'public.detect_trust_widening_patterns(uuid)'::regprocedure;
  if position('evidence_is_production' in v_src) = 0 then
    raise exception '710: the detector lost the exam axis — an exam decision could count toward widening trust (the mig-571/682/707 class)';
  end if;
  if position('tenant_is_operational' in v_src) = 0 then
    raise exception '710: the detector lost the suspension filter — a suspended workspace could grow proposals';
  end if;
  if position('action_execution_landed' in v_src) = 0 then
    raise exception '710: the detector no longer requires landed executions — approvals nobody carried out would count';
  end if;
  if position('k.n_ok >= 3' in v_src) = 0 then
    raise exception '710: the pattern floor (N=3, mig 683''s founder-ratified human-evidence floor) is gone or changed silently';
  end if;
  if position($tok$'trust_promotion' and h.related_table = 'trust_policies'$tok$ in v_src) = 0 then
    raise exception '710: the declined-proposal void-reset is gone — a declined proposal could be re-raised on stale evidence';
  end if;

  -- ── C. Perimeter — anon/authenticated/PUBLIC reach nothing new. ─────────
  if has_function_privilege('anon', 'public.detect_trust_widening_patterns(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.detect_trust_widening_patterns(uuid)', 'EXECUTE')
     or has_function_privilege('public', 'public.detect_trust_widening_patterns(uuid)', 'EXECUTE') then
    raise exception '710: detect_trust_widening_patterns is reachable by anon/authenticated/PUBLIC — its output spans tenants';
  end if;
  if has_function_privilege('anon', 'public.raise_trust_widening_proposals(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.raise_trust_widening_proposals(uuid)', 'EXECUTE')
     or has_function_privilege('public', 'public.raise_trust_widening_proposals(uuid)', 'EXECUTE') then
    raise exception '710: raise_trust_widening_proposals is reachable by anon/authenticated/PUBLIC';
  end if;
  if has_function_privilege('anon', 'public.compute_trust_proposal_brief(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.compute_trust_proposal_brief(uuid)', 'EXECUTE')
     or has_function_privilege('public', 'public.compute_trust_proposal_brief(uuid)', 'EXECUTE') then
    raise exception '710: compute_trust_proposal_brief is reachable by anon/authenticated/PUBLIC';
  end if;
  if not has_function_privilege('service_role', 'public.raise_trust_widening_proposals(uuid)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.detect_trust_widening_patterns(uuid)', 'EXECUTE') then
    raise exception '710: service_role lost EXECUTE on the seam';
  end if;
  -- Section 2b, both directions: PUBLIC holds nothing on the decision/dial
  -- class, and the UI-facing named grants survived the revoke (a security
  -- fix that breaks a live feature is not a fix).
  select count(*) into v_cnt
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('decide_human_task', 'apply_trust_promotion',
                       'trust_apply_level', 'trust_demote', 'set_de_autonomy')
     and has_function_privilege('public', p.oid, 'EXECUTE');
  if v_cnt > 0 then
    raise exception '710: PUBLIC still holds EXECUTE on % member(s) of the decision/dial class', v_cnt;
  end if;
  if not has_function_privilege('authenticated', 'public.decide_human_task(uuid,text,text,text,jsonb)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.apply_trust_promotion(uuid,text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.set_de_autonomy(text,boolean,bigint,integer,uuid,text,uuid)', 'EXECUTE') then
    raise exception '710: an authenticated UI surface lost its decide/dial RPC in the PUBLIC revoke — the 658-class strip, caught';
  end if;

  -- mig 705's perimeter survives the brief replaces (CREATE OR REPLACE
  -- preserves ACLs — asserted, not assumed).
  if has_function_privilege('anon', 'public.compute_approval_brief(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.compute_approval_brief(uuid)', 'EXECUTE') then
    raise exception '710: compute_approval_brief lost its mig-705 perimeter in the replace';
  end if;
  if not has_function_privilege('approval_brief_writer', 'public.compute_approval_brief(uuid)', 'EXECUTE') then
    raise exception '710: approval_brief_writer lost EXECUTE on compute_approval_brief';
  end if;
  if not has_function_privilege('trust_pattern_proposer', 'public.refresh_approval_briefs_internal(uuid)', 'EXECUTE') then
    raise exception '710: the proposer cannot refresh briefs — proposals would be born with a stale provisional brief';
  end if;

  -- ── D. The trigger covers proposals, and mig 705's own coverage stands. ─
  select pg_get_triggerdef(tg.oid) into v_src
    from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'human_tasks'
     and tg.tgname = 'trg_approval_brief_on_new_task';
  if v_src is null then
    raise exception '710: trg_approval_brief_on_new_task is gone';
  end if;
  if v_src not ilike '%trust_promotion%' or v_src not ilike '%action_approval%' then
    raise exception '710: the brief trigger does not cover both task types: %', v_src;
  end if;

  -- ── E. THE SWEEP IS FED — built-but-unfed is the mig-625 breaker defect.
  select p.prosrc into v_src from pg_proc p
   where p.oid = 'public.de_governance_sweep_internal()'::regprocedure;
  if position('raise_trust_widening_proposals' in v_src) = 0 then
    raise exception '710: de_governance_sweep_internal does not call the proposer — the seam is built and starved';
  end if;

  -- ── F. DRIVE IT — every proposal the first run raised is real, linked,
  --       cited and briefed. On an environment where nothing qualifies
  --       (dev carries no decided approvals), skip LOUDLY. ────────────────
  select count(*) into v_cnt
    from human_tasks ht
    join trust_policies p on p.pending_task_id = ht.id
   where ht.type = 'trust_promotion' and ht.status = 'pending'
     and p.requested_by is null;
  if v_cnt = 0 then
    raise notice '710: SKIPPED the drive test — no system-raised proposal is open in this environment (nothing qualified at N=3)';
  else
    for v_task in
      select ht.id from human_tasks ht
        join trust_policies p on p.pending_task_id = ht.id
       where ht.type = 'trust_promotion' and ht.status = 'pending'
         and p.requested_by is null
    loop
      -- the citation: >= 3 decisions, re-verified against the LEDGER (a
      -- stored citation is a stored marker, never truth — mig 642).
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
        raise exception '710: proposal % cites % ledger-verified landed production decisions — below the floor of 3', v_task, v_cnt;
      end if;
      -- suspended tenants must have produced nothing
      if exists (select 1 from human_tasks ht where ht.id = v_task
                   and not tenant_is_operational(ht.tenant_id)) then
        raise exception '710: proposal % was raised in a NON-OPERATIONAL workspace', v_task;
      end if;
      -- the brief exists and carries the proposal contract
      v_brief := public.compute_trust_proposal_brief(v_task);
      if v_brief is null
         or v_brief->>'risk' not in ('routine','caution','attention')
         or coalesce(btrim(v_brief->>'headline'), '') = ''
         or jsonb_typeof(v_brief->'evidence') <> 'array'
         or jsonb_array_length(v_brief->'evidence') = 0 then
        raise exception '710: compute_trust_proposal_brief broke its contract on %: %', v_task, v_brief;
      end if;
      if not exists (select 1 from approval_briefs b where b.task_id = v_task) then
        raise exception '710: proposal % has NO stored brief row — mig 705''s trigger/refresh did not cover it', v_task;
      end if;
      raise notice '710: proposal % verified — cited decisions ledger-checked, workspace operational, brief present', v_task;
    end loop;
  end if;

  -- ── G. ANTI-AMPLIFICATION — a second run raises NOTHING (every qualified
  --       group now has its one open proposal), and the detector agrees. ──
  v_out := public.raise_trust_widening_proposals(null);
  if coalesce((v_out->>'raised')::int, -1) <> 0 then
    raise exception '710: a second proposer run raised % more proposal(s) — one-open-proposal does not hold: %', v_out->>'raised', v_out;
  end if;
  select count(*) into v_cnt from public.detect_trust_widening_patterns(null);
  if v_cnt <> 0 then
    raise exception '710: the detector still reports % qualifying group(s) after raising — the pending-proposal exclusion is broken', v_cnt;
  end if;
  raise notice '710: second run raised 0 (%). Detector reports 0 remaining qualifying groups.', v_out;

  raise notice '710: the seam is live. Repeated identical landed approvals now become ONE founder-facing proposal on the existing queue, briefed by mig 705''s layer, decided only through decide_human_task, applied only by apply_trust_promotion, undoable by trust_demote. The proposer role can file and cite — nothing else.';
end $assert$;

-- The ownership transfer is done; the proposer does not get to keep CREATE.
revoke create on schema public from trust_pattern_proposer;

commit;

notify pgrst, 'reload schema';
