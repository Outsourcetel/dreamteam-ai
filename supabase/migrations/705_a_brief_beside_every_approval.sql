-- 705_a_brief_beside_every_approval.sql
-- ==========================================================================
-- GAP 1 (founder-approved): "AI asks for decisions but never helps make them."
--
-- Every pending `action_approval` reaches the human as a raw request: no
-- risk ranking, no evidence, no sense of whether this exact thing has been
-- approved eleven times before. Measured on production the day this was
-- written: 90 pending approvals; 54 of the 89 with an executor have a
-- same-workspace, same-action decided precedent; 47 are EXACT repeats
-- (same request summary) of something already decided; the 30-day human
-- decision ratio is 315 created : 31 decided.
--
-- This migration adds an ADVISORY BRIEF beside every pending approval:
-- deterministic, SQL-derived evidence lines plus a rail-computed risk rank
-- (routine / caution / attention) and a one-sentence advisory headline.
-- NO model call anywhere: every line is computable from the ledger, so a
-- model would add cost without information. Per-brief cost: $0.00.
--
-- ── ⛔ THE AUTHORITY BOUNDARY — the entire point ──────────────────────────
-- The advisory layer must have ZERO write paths into decisions. It never
-- calls decide_human_task, never touches human_tasks.status, never
-- auto-approves, never sends anything. That is enforced by PRIVILEGE, not
-- by promise:
--
--   * a dedicated NOLOGIN role `approval_brief_writer` is the runtime
--     identity of every function that WRITES a brief (they are SECURITY
--     DEFINER and OWNED by that role);
--   * the role holds EXACTLY: EXECUTE on two read-only (STABLE — the
--     engine itself refuses writes inside STABLE) evidence readers, and
--     SELECT/INSERT/UPDATE on `approval_briefs`. It holds NO grant of any
--     kind on `human_tasks` and NO EXECUTE on `decide_human_task`;
--   * Ring-0 probe `advisory-layer-cannot-decide` (scripts/
--     advisory-boundary.mjs) re-asserts all of this on every certify run,
--     plus a coverage half counting pending approvals WITHOUT a brief.
--
-- Auto-approve is EXPLICITLY out of scope (Gap 2, a founder decision).
--
-- ── FRESHNESS: compute-on-read, no new cron ──────────────────────────────
-- A stored brief is a stored marker, and this repo has paid four times for
-- reading a stored marker as current truth. So the READ path
-- (`list_approval_briefs`) recomputes every pending brief for the caller's
-- workspace before returning — the table is the audit trail and the
-- coverage census, never the UI's source of staleness. An AFTER INSERT
-- trigger writes the first brief the moment an approval is raised, so a
-- workspace nobody has opened still counts as covered. No scheduled job.
--
-- ── WHY THE READERS ARE OWNED BY postgres AND THE WRITERS BY THE ROLE ────
-- human_tasks carries RESTRICTIVE policies (`de_id is null or
-- can_access_de(de_id)`) that would blind a JWT-less trigger context. The
-- two READERS are therefore postgres-owned SECURITY DEFINER (owner bypasses
-- RLS) but STABLE — provolatile is pinned, so they cannot write — and
-- EXECUTE on them is granted ONLY to approval_brief_writer and
-- service_role, never to authenticated: their task/tenant parameter would
-- otherwise be the authorisation (the mig-662 class). The caller-facing
-- wrapper takes NO parameters and derives the tenant from auth_tenant_id().
-- ==========================================================================

begin;

-- ── 0. The role. NOLOGIN; granted to postgres so migrations can own-transfer
--      and replace the functions it owns. ────────────────────────────────
do $role$
begin
  if not exists (select 1 from pg_roles where rolname = 'approval_brief_writer') then
    create role approval_brief_writer nologin;
  end if;
end $role$;

grant approval_brief_writer to postgres;

-- The role must be able to LOOK UP objects in public (usage, permanent) and
-- must hold CREATE there for the duration of the ownership transfers below —
-- ALTER FUNCTION ... OWNER TO checks the NEW owner's CREATE on the schema.
-- CREATE is revoked again at the end of this migration: a role that exists
-- only to write briefs has no business creating objects.
grant usage on schema public to approval_brief_writer;
grant create on schema public to approval_brief_writer;

-- On production auth_tenant_id() carries NO PUBLIC grant (the perimeter work
-- stripped it; dev still had it via PUBLIC — the migration's own assert
-- caught the difference before anything shipped). The wrapper derives the
-- caller's workspace from it, and the RLS policies on approval_briefs
-- reference it while running AS this role, so the grant is explicit.
grant execute on function public.auth_tenant_id() to approval_brief_writer;

-- ── 1. The table. One brief per task, keyed by task_id — human_tasks is
--      guarded and gets NO new columns. ───────────────────────────────────
create table if not exists approval_briefs (
  task_id         uuid primary key references human_tasks(id) on delete cascade,
  tenant_id       uuid not null references tenants(id) on delete cascade,
  risk            text not null check (risk in ('routine','caution','attention')),
  headline        text not null,
  -- deterministic evidence lines, a jsonb array of strings
  evidence        jsonb not null default '[]'::jsonb,
  computed_at     timestamptz not null default now(),
  -- the task's updated_at AT COMPUTE TIME. A brief older than the row's
  -- last change is stale; the read path recomputes regardless, so this is
  -- for audit and for anything else that ever reads the table directly.
  task_changed_at timestamptz
);

create index if not exists idx_approval_briefs_tenant on approval_briefs(tenant_id);

alter table approval_briefs enable row level security;

-- Supabase's default privileges hand new tables to anon/authenticated —
-- revoke first, then grant exactly what is meant. Tenant members may READ
-- their own workspace's briefs; only the brief writer (and service_role,
-- which bypasses RLS) may write.
revoke all on approval_briefs from public, anon, authenticated;
grant select on approval_briefs to authenticated;
grant select, insert, update on approval_briefs to approval_brief_writer;

drop policy if exists approval_briefs_tenant_read on approval_briefs;
create policy approval_briefs_tenant_read on approval_briefs
  for select using (tenant_id = auth_tenant_id());

-- The writer role's own path. PERMISSIVE policies OR together per-role, and
-- this one is scoped `to approval_brief_writer`, so it widens nothing for
-- anyone else.
drop policy if exists approval_briefs_writer_all on approval_briefs;
create policy approval_briefs_writer_all on approval_briefs
  for all to approval_brief_writer using (true) with check (true);

-- ── 2. READER 1 — the evidence, computed. Read-only by construction:
--      STABLE, so the engine refuses any write attempted inside it. ───────
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
  if not found or t.type <> 'action_approval' then
    return null;
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
      ev := ev || to_jsonb(('Crosses the second-signature threshold ($'
            || to_char(round(v_dials.second_above / 100.0, 2), 'FM999,999,999,990.00')
            || ') — two different approvers are required.')::text);
      v_caution := array_append(v_caution, 'needs a second signature');
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

comment on function public.compute_approval_brief(uuid) is
  'ADVISORY ONLY. Deterministic, SQL-derived evidence for one pending '
  'action_approval: precedent count, exact-repeat, landed history (via THE '
  'shared predicate, mig 679), amount vs the approval dials (migs 626/627), '
  'workspace standing — plus a rail-computed risk rank. STABLE on purpose: '
  'the engine itself refuses any write attempted inside it. It never '
  'decides anything; Ring-0 probe advisory-layer-cannot-decide holds the '
  'boundary.';

revoke execute on function public.compute_approval_brief(uuid)
  from public, anon, authenticated;
grant execute on function public.compute_approval_brief(uuid)
  to approval_brief_writer, service_role;

-- ── 3. READER 2 — which tasks need a brief. Same shape, same reasons. ─────
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
     and ht.type = 'action_approval'
     and ht.status = 'pending';
$fn$;

revoke execute on function public.pending_approval_briefables(uuid)
  from public, anon, authenticated;
grant execute on function public.pending_approval_briefables(uuid)
  to approval_brief_writer, service_role;

-- ── 4. THE WRITER — owned by the boundary role. Upserts briefs for every
--      pending approval of ONE tenant. The tenant parameter is safe here
--      because nothing callable by `authenticated` reaches this function:
--      only the no-argument wrapper below (which derives the tenant from
--      auth_tenant_id()) and service_role. ───────────────────────────────
create or replace function public.refresh_approval_briefs_internal(p_tenant_id uuid)
returns int
language plpgsql
volatile
security definer
set search_path to 'public'
as $fn$
declare
  r record;
  b jsonb;
  n int := 0;
begin
  for r in select * from public.pending_approval_briefables(p_tenant_id) loop
    b := public.compute_approval_brief(r.task_id);
    if b is null then continue; end if;
    insert into approval_briefs (task_id, tenant_id, risk, headline, evidence, computed_at, task_changed_at)
    values (r.task_id, p_tenant_id, b->>'risk', b->>'headline',
            coalesce(b->'evidence', '[]'::jsonb), now(), r.task_updated_at)
    on conflict (task_id) do update
      set risk = excluded.risk,
          headline = excluded.headline,
          evidence = excluded.evidence,
          computed_at = excluded.computed_at,
          task_changed_at = excluded.task_changed_at;
    n := n + 1;
  end loop;
  return n;
end $fn$;

revoke execute on function public.refresh_approval_briefs_internal(uuid)
  from public, anon, authenticated;
grant execute on function public.refresh_approval_briefs_internal(uuid)
  to service_role;

alter function public.refresh_approval_briefs_internal(uuid)
  owner to approval_brief_writer;

-- ── 5. THE CALLER-FACING READ. No parameters — the tenant is derived, never
--      supplied. Recomputes before returning, so a stale stored brief can
--      never be served on the deciding surface (compute-on-read; the
--      staleness anchor task_changed_at is audit, not truth). ─────────────
create or replace function public.list_approval_briefs()
returns table (task_id uuid, risk text, headline text, evidence jsonb, computed_at timestamptz)
language plpgsql
volatile
security definer
set search_path to 'public'
as $fn$
declare
  v_tenant uuid;
begin
  v_tenant := auth_tenant_id();
  if v_tenant is null then
    return; -- no workspace, no briefs: the queue itself still renders
  end if;
  perform public.refresh_approval_briefs_internal(v_tenant);
  return query
    select b.task_id, b.risk, b.headline, b.evidence, b.computed_at
      from approval_briefs b
      join public.pending_approval_briefables(v_tenant) p on p.task_id = b.task_id;
end $fn$;

revoke execute on function public.list_approval_briefs()
  from public, anon;
grant execute on function public.list_approval_briefs()
  to authenticated, service_role;

alter function public.list_approval_briefs()
  owner to approval_brief_writer;

-- ── 6. COVERAGE AT BIRTH — an AFTER INSERT trigger, not a cron. A brief a
--      failure here must never cost a task, so everything is swallowed;
--      the read path recomputes anyway. ──────────────────────────────────
create or replace function public.approval_brief_on_new_task()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  b jsonb;
begin
  b := public.compute_approval_brief(new.id);
  if b is not null then
    insert into approval_briefs (task_id, tenant_id, risk, headline, evidence, computed_at, task_changed_at)
    values (new.id, new.tenant_id, b->>'risk', b->>'headline',
            coalesce(b->'evidence', '[]'::jsonb), now(), new.updated_at)
    on conflict (task_id) do update
      set risk = excluded.risk,
          headline = excluded.headline,
          evidence = excluded.evidence,
          computed_at = excluded.computed_at,
          task_changed_at = excluded.task_changed_at;
  end if;
  return null;
exception when others then
  -- The brief is an overlay. Losing it must never roll back the approval
  -- request itself.
  return null;
end $fn$;

revoke execute on function public.approval_brief_on_new_task()
  from public, anon, authenticated;

alter function public.approval_brief_on_new_task()
  owner to approval_brief_writer;

drop trigger if exists trg_approval_brief_on_new_task on human_tasks;
create trigger trg_approval_brief_on_new_task
  after insert on human_tasks
  for each row
  when (new.type = 'action_approval' and new.status = 'pending')
  execute function public.approval_brief_on_new_task();

-- ── 7. BACKFILL — every workspace with a pending approval gets its briefs
--      now, so the coverage probe starts from zero missing. ──────────────
do $backfill$
declare
  r record;
  n int;
  total int := 0;
begin
  for r in select distinct tenant_id from human_tasks
            where type = 'action_approval' and status = 'pending' loop
    n := public.refresh_approval_briefs_internal(r.tenant_id);
    total := total + coalesce(n, 0);
  end loop;
  raise notice '705: backfilled % brief(s)', total;
end $backfill$;

-- ══ PROVE IT ══════════════════════════════════════════════════════════════
do $assert$
declare
  v_cnt   int;
  v_task  uuid;
  v_brief jsonb;
  v_vol   "char";
  v_owner name;
  v_trg   text;
  v_missing int;
  v_briefs  int;
begin
  -- ── A. THE BOUNDARY, asserted not stated. has_function_privilege and
  --       has_table_privilege answer INCLUDING inheritance through PUBLIC —
  --       a REVOKE is not a description of the resulting privileges. ──────
  if has_function_privilege('approval_brief_writer',
       'public.decide_human_task(uuid,text,text,text,jsonb)', 'EXECUTE') then
    raise exception '705: approval_brief_writer can EXECUTE decide_human_task — the advisory layer can decide, which is the one thing it must never do';
  end if;
  if has_table_privilege('approval_brief_writer', 'public.human_tasks', 'INSERT')
     or has_table_privilege('approval_brief_writer', 'public.human_tasks', 'UPDATE')
     or has_table_privilege('approval_brief_writer', 'public.human_tasks', 'DELETE') then
    raise exception '705: approval_brief_writer holds a WRITE privilege on human_tasks';
  end if;

  -- Nothing the role can reach (excluding uncallable trigger-returning
  -- functions) may write the queue or call the decider.
  select count(*) into v_cnt
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind in ('f','p')
     and p.prorettype <> 'trigger'::regtype
     and has_function_privilege('approval_brief_writer', p.oid, 'EXECUTE')
     and (regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* 'update\s+(public\.)?human_tasks'
       or regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* '\mdecide_human_task\s*\(');
  if v_cnt > 0 then
    raise exception '705: % function(s) reachable by approval_brief_writer can write human_tasks or call decide_human_task', v_cnt;
  end if;

  -- ── B. The writers really run AS the role, and the readers really cannot
  --       write. A writer owned by postgres has every privilege and makes
  --       the boundary vacuous; a VOLATILE reader is a writer in waiting. ──
  select r.rolname into v_owner from pg_proc p join pg_roles r on r.oid = p.proowner
   where p.oid = 'public.list_approval_briefs()'::regprocedure;
  if v_owner <> 'approval_brief_writer' then
    raise exception '705: list_approval_briefs is owned by % — the boundary role is not its runtime identity', v_owner;
  end if;
  select r.rolname into v_owner from pg_proc p join pg_roles r on r.oid = p.proowner
   where p.oid = 'public.refresh_approval_briefs_internal(uuid)'::regprocedure;
  if v_owner <> 'approval_brief_writer' then
    raise exception '705: refresh_approval_briefs_internal is owned by %', v_owner;
  end if;
  select r.rolname into v_owner from pg_proc p join pg_roles r on r.oid = p.proowner
   where p.oid = 'public.approval_brief_on_new_task()'::regprocedure;
  if v_owner <> 'approval_brief_writer' then
    raise exception '705: approval_brief_on_new_task is owned by %', v_owner;
  end if;

  select provolatile into v_vol from pg_proc
   where oid = 'public.compute_approval_brief(uuid)'::regprocedure;
  if v_vol not in ('s','i') then
    raise exception '705: compute_approval_brief is VOLATILE (%) — a reader that may write is not a reader', v_vol;
  end if;
  select provolatile into v_vol from pg_proc
   where oid = 'public.pending_approval_briefables(uuid)'::regprocedure;
  if v_vol not in ('s','i') then
    raise exception '705: pending_approval_briefables is VOLATILE (%)', v_vol;
  end if;

  -- ── C. The EXECUTE perimeter of every new function, both directions. ────
  if has_function_privilege('anon', 'public.compute_approval_brief(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.compute_approval_brief(uuid)', 'EXECUTE')
     or has_function_privilege('public', 'public.compute_approval_brief(uuid)', 'EXECUTE') then
    raise exception '705: compute_approval_brief is reachable by anon/authenticated/PUBLIC — its task-id parameter would become the authorisation';
  end if;
  if has_function_privilege('anon', 'public.pending_approval_briefables(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.pending_approval_briefables(uuid)', 'EXECUTE')
     or has_function_privilege('public', 'public.pending_approval_briefables(uuid)', 'EXECUTE') then
    raise exception '705: pending_approval_briefables is reachable by anon/authenticated/PUBLIC';
  end if;
  if has_function_privilege('anon', 'public.refresh_approval_briefs_internal(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.refresh_approval_briefs_internal(uuid)', 'EXECUTE')
     or has_function_privilege('public', 'public.refresh_approval_briefs_internal(uuid)', 'EXECUTE') then
    raise exception '705: refresh_approval_briefs_internal is reachable by anon/authenticated/PUBLIC — a tenant-id parameter IS authorisation there';
  end if;
  if not has_function_privilege('authenticated', 'public.list_approval_briefs()', 'EXECUTE') then
    raise exception '705: authenticated LOST EXECUTE on list_approval_briefs — the queue surface cannot fetch its briefs';
  end if;
  if has_function_privilege('anon', 'public.list_approval_briefs()', 'EXECUTE') then
    raise exception '705: anon can execute list_approval_briefs — that is the internet';
  end if;
  if not has_function_privilege('service_role', 'public.compute_approval_brief(uuid)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.refresh_approval_briefs_internal(uuid)', 'EXECUTE') then
    raise exception '705: service_role lost EXECUTE on a brief function';
  end if;
  if not has_function_privilege('approval_brief_writer', 'public.compute_approval_brief(uuid)', 'EXECUTE')
     or not has_function_privilege('approval_brief_writer', 'public.pending_approval_briefables(uuid)', 'EXECUTE') then
    raise exception '705: approval_brief_writer cannot reach its own evidence readers';
  end if;
  if not has_function_privilege('approval_brief_writer', 'public.auth_tenant_id()', 'EXECUTE') then
    raise exception '705: approval_brief_writer cannot execute auth_tenant_id — list_approval_briefs would fail at its first line';
  end if;

  -- ── D. The trigger: attached, AFTER INSERT, narrowed to pending
  --       action_approval rows. ───────────────────────────────────────────
  select pg_get_triggerdef(tg.oid) into v_trg
    from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'human_tasks'
     and tg.tgname = 'trg_approval_brief_on_new_task';
  if v_trg is null then
    raise exception '705: trg_approval_brief_on_new_task is not attached to human_tasks';
  end if;
  if v_trg not ilike '%after insert on%' then
    raise exception '705: the brief trigger is not AFTER INSERT: %', v_trg;
  end if;
  if v_trg not ilike '%action_approval%' or v_trg not ilike '%pending%' then
    raise exception '705: the brief trigger lost its WHEN narrowing: %', v_trg;
  end if;

  -- ── E. RLS on the new table, and the policy shape. ─────────────────────
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'public' and c.relname = 'approval_briefs' and c.relrowsecurity) then
    raise exception '705: approval_briefs has no row level security';
  end if;
  if has_table_privilege('authenticated', 'public.approval_briefs', 'INSERT')
     or has_table_privilege('authenticated', 'public.approval_briefs', 'UPDATE')
     or has_table_privilege('authenticated', 'public.approval_briefs', 'DELETE') then
    raise exception '705: authenticated can WRITE approval_briefs — briefs must only ever be written by the rail';
  end if;

  -- ── F. DRIVE IT. A real pending approval, through the real reader. On an
  --       environment with no pending approvals (dev), skip LOUDLY — an
  --       assertion that fails for want of test data teaches people to
  --       delete assertions. ─────────────────────────────────────────────
  select ht.id into v_task from human_tasks ht
   where ht.type = 'action_approval' and ht.status = 'pending' limit 1;
  if v_task is null then
    raise notice '705: SKIPPED the drive test — no pending action_approval exists in this environment';
  else
    v_brief := public.compute_approval_brief(v_task);
    if v_brief is null
       or v_brief->>'risk' not in ('routine','caution','attention')
       or coalesce(btrim(v_brief->>'headline'), '') = ''
       or jsonb_typeof(v_brief->'evidence') <> 'array'
       or jsonb_array_length(v_brief->'evidence') = 0 then
      raise exception '705: compute_approval_brief broke its contract on task %: %', v_task, v_brief;
    end if;
  end if;

  -- ── G. COVERAGE — count the comparisons, not just the findings. ────────
  select count(*) into v_missing
    from human_tasks ht
   where ht.type = 'action_approval' and ht.status = 'pending'
     and not exists (select 1 from approval_briefs b where b.task_id = ht.id);
  select count(*) into v_briefs from approval_briefs;
  raise notice '705: coverage — % pending approval(s) without a brief, % brief(s) stored', v_missing, v_briefs;
  if v_missing > 0 then
    raise exception '705: % pending approval(s) have NO brief after the backfill', v_missing;
  end if;

  raise notice '705: advisory briefs live. The writer runs as approval_brief_writer, which cannot decide, cannot write the queue, and reaches nothing that can. Every brief line is rail-computed; no model is called anywhere. Per-brief cost: $0.';
end $assert$;

-- The ownership transfers are done; the brief writer does not get to keep
-- CREATE. (USAGE stays — it is how the role resolves the objects it reads.)
revoke create on schema public from approval_brief_writer;

commit;

notify pgrst, 'reload schema';
