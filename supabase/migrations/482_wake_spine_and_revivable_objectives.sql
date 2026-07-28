-- 482_wake_spine_and_revivable_objectives.sql
-- ============================================================================
-- WAVE 1, ITEM 4 (foundation): the wake loop gets a memory and an exit.
--
-- Three defects, all proven live in docs/38:
--
--   1. conclude_objective_wake accepts p_note and NEVER REFERENCES IT. The
--      wake's written assessment is discarded; the only surviving copy is a
--      300-char slice in de_decision_trace. There is no per-wake output store
--      anywhere — de_objectives has 18 columns and none of them is a note.
--      Result: 1,556 wakes at outsourcetel-hq produced 6 readable assessments.
--
--   2. 'blocked' is TERMINAL. conclude_objective_wake sets next_wake_at = NULL
--      and wake_due_objectives selects only status in ('open','in_progress')
--      with next_wake_at not null — so nothing in the platform can ever wake a
--      blocked objective again. 6 objectives at hq are in that state today,
--      all disarmed. A digital employee that says "I am blocked" is switched
--      off by its own honesty.
--
--   3. Nothing measures progress between wakes, so paralysis is invisible.
--
-- What this migration does:
--   a. Creates de_objective_wakes — one row per wake, holding the assessment,
--      the FULL note, and a progress fingerprint. This is the store docs/37
--      Move 1 needs for the evidence spine (entity_kind / entity_ref /
--      source_category are carried on the row for exactly that reason), and
--      the store N6's paralysis detector needs (fingerprint equality across
--      consecutive wakes IS the "no progress" test).
--   b. begin_objective_wake opens the row (it already computes the wake number
--      and is already the atomic claim — the insert rides inside it).
--   c. conclude_objective_wake closes the row WITH the note, and on 'blocked'
--      re-arms at a 24h cadence instead of disarming forever.
--   d. wake_due_objectives and begin_objective_wake's claim admit 'blocked',
--      so a revived objective can actually be picked up.
--   e. de_objectives gains attention_flag / attention_since — the tenant-visible
--      board flag N6 requires. ops_alerts cannot serve this: list_ops_alerts
--      raises 'platform admin only', so it is invisible to the tenant.
--
-- DELIBERATELY NOT HERE: the 24h/12-wake sweep that WRITES attention_flag
-- (483), the escalation return path (483), the approvals-ledger guard (484).
-- This migration only builds the spine those depend on.
--
-- Every function below is reproduced from the LIVE definition
-- (pg_get_functiondef, 2026-07-28) with only the additions described.
-- ============================================================================

-- ── a. the per-wake store ────────────────────────────────────────────────────
create table if not exists public.de_objective_wakes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  de_id uuid not null references public.digital_employees(id) on delete cascade,
  objective_id uuid not null references public.de_objectives(id) on delete cascade,
  wake_no integer not null,
  started_at timestamptz not null default now(),
  concluded_at timestamptz,
  assessment text check (assessment is null or assessment = any (array['achieved','blocked','continue'])),
  note text not null default '',
  enqueued_count integer not null default 0,
  open_item_count integer not null default 0,
  done_item_count integer not null default 0,
  -- md5 of the ordered id:status list of the objective's work items at wake
  -- time. Equality across consecutive wakes IS "nothing moved" — computing it
  -- here makes the paralysis test a cheap comparison instead of a re-derivation.
  progress_fingerprint text,
  -- carried for docs/37 Move 1: the evidence spine needs the archetype-derived
  -- category and the entity the work was about, from the SAME row. Building the
  -- store once and feeding both consumers is the point.
  entity_kind text,
  entity_ref text,
  source_category text,
  detail jsonb not null default '{}',
  constraint de_objective_wakes_uniq unique (objective_id, wake_no)
);

create index if not exists de_objective_wakes_obj_idx
  on public.de_objective_wakes (objective_id, wake_no desc);
create index if not exists de_objective_wakes_stuck_idx
  on public.de_objective_wakes (tenant_id, de_id, concluded_at desc);

alter table public.de_objective_wakes enable row level security;

-- Read-only to tenant members, mirroring de_work_items exactly: a PERMISSIVE
-- SELECT for the tenant (or a platform-layer profile), plus the RESTRICTIVE
-- per-DE scope that the two-axes model (docs/29) requires. No write policy —
-- writes are SECURITY DEFINER only, same as every other work-engine table.
drop policy if exists de_objective_wakes_tenant_read on public.de_objective_wakes;
create policy de_objective_wakes_tenant_read on public.de_objective_wakes
  for select using (
    tenant_id in (select p.tenant_id from profiles p where p.user_id = auth.uid())
    or exists (select 1 from profiles p where p.user_id = auth.uid() and p.tenant_id is null)
  );

drop policy if exists de_objective_wakes_de_scope on public.de_objective_wakes;
create policy de_objective_wakes_de_scope on public.de_objective_wakes
  as restrictive for select using (de_id is null or can_access_de(de_id));

grant select on public.de_objective_wakes to authenticated;
revoke insert, update, delete, truncate on public.de_objective_wakes from authenticated, anon;

-- ── e. the tenant-visible board flag ─────────────────────────────────────────
alter table public.de_objectives add column if not exists attention_flag text;
alter table public.de_objectives add column if not exists attention_since timestamptz;

do $flag$
begin
  if not exists (select 1 from pg_constraint where conname = 'de_objectives_attention_flag_check') then
    alter table public.de_objectives add constraint de_objectives_attention_flag_check
      check (attention_flag is null or attention_flag = any (array['stalled','waiting_too_long','wake_spin']));
  end if;
end $flag$;

-- 'blocked' objectives are about to become wakeable, and de_objectives_wake_idx
-- is PARTIAL on status in ('open','in_progress') — without this the revived
-- sweep seq-scans.
create index if not exists de_objectives_wake_blocked_idx
  on public.de_objectives (next_wake_at)
  where next_wake_at is not null and status = 'blocked';

-- ── b. begin_objective_wake: open the wake row ───────────────────────────────
-- LIVE def + the insert. PRESERVED BYTE-FOR-BYTE: the RETURNS integer contract
-- (de-work/index.ts:964 feeds the value into its idempotency key
-- obj-<id>-w<n>-step-<m>), the WHERE clause as the atomic claim, the cadence
-- re-arm, the raise-on-null. CHANGED: status now admits 'blocked' (c/d), and
-- the wake row is opened inside the same transaction as the claim.
create or replace function public.begin_objective_wake(p_objective_id uuid)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_count integer;
  v_tenant uuid;
  v_de uuid;
  v_kind text;
  v_ref text;
  v_fp text;
  v_open int;
  v_done int;
begin
  update de_objectives
     set wake_count = wake_count + 1,
         next_wake_at = case when cadence_minutes is not null
                             then now() + make_interval(mins => cadence_minutes)
                             else now() + interval '60 minutes' end,
         updated_at = now()
   where id = p_objective_id and status in ('open', 'in_progress', 'blocked')
     and next_wake_at is not null and next_wake_at <= now()   -- the actual claim
   returning wake_count, tenant_id, de_id, entity_kind, entity_ref
        into v_count, v_tenant, v_de, v_kind, v_ref;
  if v_count is null then raise exception 'objective not wakeable (already claimed, disarmed, or closed)'; end if;

  -- Progress fingerprint: identical across consecutive wakes == nothing moved.
  select md5(coalesce(string_agg(w.id::text || ':' || w.status, '|' order by w.id), 'none')),
         count(*) filter (where w.status in ('queued','running','waiting_human')),
         count(*) filter (where w.status = 'done')
    into v_fp, v_open, v_done
    from de_work_items w
   where w.objective_id = p_objective_id;

  insert into de_objective_wakes (
    tenant_id, de_id, objective_id, wake_no,
    open_item_count, done_item_count, progress_fingerprint,
    entity_kind, entity_ref, source_category
  )
  select v_tenant, v_de, p_objective_id, v_count,
         coalesce(v_open, 0), coalesce(v_done, 0), v_fp,
         v_kind, v_ref, de.archetype_key
    from digital_employees de
   where de.id = v_de
  on conflict (objective_id, wake_no) do nothing;

  return v_count;
end;
$function$;

-- ── c. conclude_objective_wake: keep the note, re-arm on blocked ─────────────
-- LIVE def + note persistence + revivability. PRESERVED: the three-value
-- assessment vocabulary and the raise on anything else (de-work:225 passes
-- exactly these); the 'achieved' branch still disarms (a finished objective
-- SHOULD stop). CHANGED: 'blocked' re-arms at 24h instead of NULL, and the
-- note is written to the open wake row on every assessment including
-- 'continue' — which is precisely the case that produced no record at all.
create or replace function public.conclude_objective_wake(p_objective_id uuid, p_assessment text, p_note text DEFAULT NULL::text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if p_assessment = 'achieved' then
    update de_objectives set status = 'achieved', next_wake_at = null, updated_at = now()
     where id = p_objective_id and status in ('open', 'in_progress', 'blocked');
  elsif p_assessment = 'blocked' then
    -- Re-arm, do not disarm. A blocked objective must come back around so the
    -- stall can be re-assessed and re-escalated; 24h is slow enough that a
    -- genuinely blocked goal is not the hourly spin docs/38 measured.
    update de_objectives
       set status = 'blocked',
           next_wake_at = now() + interval '24 hours',
           updated_at = now()
     where id = p_objective_id and status in ('open', 'in_progress', 'blocked');
  elsif p_assessment = 'continue' then
    null;
  else
    raise exception 'assessment must be achieved | blocked | continue';
  end if;

  -- The note the platform used to throw away. Written to the most recent
  -- unconcluded wake for this objective (wake_count may have advanced if a
  -- later wake started, so anchor on the open row, not on the counter).
  update de_objective_wakes
     set concluded_at = now(),
         assessment = p_assessment,
         note = coalesce(p_note, '')
   where id = (
     select w.id from de_objective_wakes w
      where w.objective_id = p_objective_id and w.concluded_at is null
      order by w.wake_no desc
      limit 1
   );
end;
$function$;

-- ── d. wake_due_objectives: a blocked objective can be picked up ─────────────
-- LIVE def + 'blocked'. PRESERVED: tenant_is_operational (mig 430 dormancy —
-- dropping it would work suspended tenants), the 20-row hard cap, and
-- RETURNS SETOF de_objectives (de-work:942 maps rows by column name).
create or replace function public.wake_due_objectives(p_limit integer DEFAULT 5)
returns setof de_objectives
language sql
stable
security definer
set search_path to 'public'
as $function$
  select * from de_objectives
   where status in ('open', 'in_progress', 'blocked')
     and next_wake_at is not null
     and next_wake_at <= now()
     and tenant_is_operational(tenant_id)
   order by next_wake_at asc
   limit greatest(1, least(20, p_limit));
$function$;

revoke all on function public.begin_objective_wake(uuid) from public, anon, authenticated;
revoke all on function public.conclude_objective_wake(uuid, text, text) from public, anon, authenticated;
revoke all on function public.wake_due_objectives(integer) from public, anon, authenticated;

notify pgrst, 'reload schema';

-- ── PROOF ────────────────────────────────────────────────────────────────────
do $a$
declare
  v_def text;
  v_tenant uuid;
  v_de uuid;
  v_obj uuid;
  v_wake int;
  v_row record;
  n int;
begin
  -- No-op detectors: each change must be present in the LIVE definition.
  v_def := pg_get_functiondef('public.begin_objective_wake(uuid)'::regprocedure);
  if v_def not ilike '%de_objective_wakes%' then
    raise exception '482: begin_objective_wake does not open a wake row';
  end if;
  if v_def not ilike '%''blocked''%' then
    raise exception '482: begin_objective_wake still refuses to claim a blocked objective';
  end if;

  v_def := pg_get_functiondef('public.conclude_objective_wake(uuid,text,text)'::regprocedure);
  if v_def not ilike '%de_objective_wakes%' then
    raise exception '482: conclude_objective_wake still discards its note';
  end if;
  if v_def not ilike '%24 hours%' then
    raise exception '482: conclude_objective_wake still disarms blocked objectives';
  end if;

  v_def := pg_get_functiondef('public.wake_due_objectives(integer)'::regprocedure);
  if v_def not ilike '%''blocked''%' then
    raise exception '482: wake_due_objectives still cannot see a blocked objective';
  end if;
  -- The dormancy guard must have survived the recreate (mig 430).
  if v_def not ilike '%tenant_is_operational%' then
    raise exception '482: wake_due_objectives lost the mig-430 suspension guard';
  end if;

  -- BEHAVIOURAL PROOF on a fixture, through the REAL functions. A definition
  -- check alone would pass even if the insert silently no-opped.
  select t.id into v_tenant from tenants t where t.slug = 'outsourcetel-hq';
  select d.id into v_de from digital_employees d where d.tenant_id = v_tenant order by d.created_at limit 1;
  if v_tenant is null or v_de is null then
    raise notice '482: no fixture tenant/DE available — behavioural proof SKIPPED';
    return;
  end if;

  insert into de_objectives (tenant_id, de_id, title, description, status, next_wake_at, cadence_minutes)
  values (v_tenant, v_de, '[MIG482 FIXTURE] wake spine proof', 'temporary, deleted in this transaction',
          'in_progress', now() - interval '1 minute', 60)
  returning id into v_obj;

  v_wake := begin_objective_wake(v_obj);
  if v_wake is distinct from 1 then
    raise exception '482: begin_objective_wake returned % — the integer contract de-work keys its idempotency on is broken', v_wake;
  end if;

  select * into v_row from de_objective_wakes where objective_id = v_obj and wake_no = 1;
  if v_row.id is null then
    raise exception '482: no wake row was opened — the store is inert';
  end if;
  if v_row.progress_fingerprint is null then
    raise exception '482: wake row carries no progress fingerprint — the paralysis test has nothing to compare';
  end if;
  if v_row.concluded_at is not null then
    raise exception '482: wake row was born concluded';
  end if;

  -- The case the old code recorded NOTHING for: a 'continue' wake.
  perform conclude_objective_wake(v_obj, 'continue', 'MIG482 fixture note — this text is exactly what used to be discarded.');
  select * into v_row from de_objective_wakes where objective_id = v_obj and wake_no = 1;
  if v_row.concluded_at is null then
    raise exception '482: the wake was never concluded';
  end if;
  if v_row.note not like '%exactly what used to be discarded%' then
    raise exception '482: the note did not survive — this is the original defect, unfixed';
  end if;
  if v_row.assessment is distinct from 'continue' then
    raise exception '482: assessment not recorded (got %)', v_row.assessment;
  end if;

  -- Revivability: a blocked objective must stay armed and be selectable.
  update de_objectives set next_wake_at = now() - interval '1 minute' where id = v_obj;
  perform begin_objective_wake(v_obj);
  perform conclude_objective_wake(v_obj, 'blocked', 'MIG482 fixture — blocked but revivable.');
  select * into v_row from de_objectives where id = v_obj;
  if v_row.status is distinct from 'blocked' then
    raise exception '482: objective did not reach blocked (got %)', v_row.status;
  end if;
  if v_row.next_wake_at is null then
    raise exception '482: blocked objective was DISARMED — it is still terminal, the fix did not land';
  end if;

  -- ...and wake_due_objectives must actually return it once due.
  update de_objectives set next_wake_at = now() - interval '1 minute' where id = v_obj;
  select count(*) into n from wake_due_objectives(20) w where w.id = v_obj;
  if n <> 1 then
    raise exception '482: a due blocked objective is still invisible to the waker (found %)', n;
  end if;

  -- Clean up: the wake rows cascade with the objective.
  delete from de_objectives where id = v_obj;
  select count(*) into n from de_objective_wakes where objective_id = v_obj;
  if n <> 0 then
    raise exception '482: fixture wake rows survived the objective delete (% left)', n;
  end if;

  raise notice '482: wake spine proven — note persisted, blocked objective revived and re-selected, fixture cleaned up';
end $a$;
