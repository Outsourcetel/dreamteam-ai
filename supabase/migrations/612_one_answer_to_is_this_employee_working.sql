-- 612 — one answer to "is this employee working?"
--
-- `digital_employees` carries TWO state columns and nothing kept them in step:
--
--   status           active | idle | disabled                 (default 'idle')
--   lifecycle_status designed → configured → trained → tested → certified →
--                    published → assigned → active → improving → paused →
--                    retired → archived                       (default 'designed')
--
-- Both are legitimate and they are NOT duplicates: lifecycle says how far an
-- employee got through being built and hired; status is the operational switch.
-- `advance_de_lifecycle` proves the intent — it sets status='active' only when
-- advancing to assigned/active and otherwise leaves the switch alone. So a
-- published employee may honestly sit idle.
--
-- What was wrong is that ONE combination is self-contradictory, and 17 rows
-- were in it:
--
--   lifecycle_status='designed' AND status='active'
--   → switched on, while never configured, trained, tested, certified or
--     published. The chain says you cannot be working before you exist.
--
-- Measured, not assumed: all 17 are auto-provisioned built-ins — 16 Workspace
-- Assistants (one per workspace) and one legacy Onboarding Specialist — and
-- between them they have ONE conversation, zero evidence runs, zero work items
-- and zero executed actions. They were never "working"; they were mislabelled.
--
-- ROOT CAUSE: two writers set the switch and let the pipeline default.
--   create_workforce_assistant_de  — INSERT names status, never lifecycle_status
--   auto_provision_new_tenant      — its own inline copy of the same INSERT,
--                                    same omission (and a duplicate in its own
--                                    right: two places create one built-in)
-- Neither is a typo you would catch reading it; the column simply is not named,
-- so it silently takes 'designed'.
--
-- This does NOT collapse the two columns into one. Losing the distinction would
-- throw away a real fact — "published but not currently switched on" is 15 rows
-- and a legitimate state.

begin;

-- ── The rule, written once ───────────────────────────────────────────────
-- Immutable and cheap enough to sit in a CHECK: nothing pre-publication may be
-- switched on, and nothing paused or terminal may be anything but off. Between
-- published and improving the switch is free — that is the whole point of
-- having two columns.
create or replace function de_status_allowed(p_lifecycle text, p_status text)
returns boolean
language sql immutable as $$
  select case
    when p_lifecycle in ('designed','configured','trained','tested','certified')
      then p_status in ('idle','disabled')
    when p_lifecycle in ('paused','retired','archived')
      then p_status = 'disabled'
    else true
  end;
$$;

revoke execute on function de_status_allowed(text, text) from public;
grant execute on function de_status_allowed(text, text) to authenticated, service_role;

-- ── Backfill: the PIPELINE wins, the switch yields ───────────────────────
--
-- ⚠⚠ MY FIRST ATTEMPT WAS WRONG AND THE PLATFORM CAUGHT IT.
-- I began by promoting the 16 Workspace Assistants to lifecycle 'published',
-- reasoning that a built-in ships ready. `gate_de_certification()` refused:
--
--   cannot advance to "published": it has not passed role certification.
--   Run its eval/simulation and certify it first.
--
-- That guard is right and I was about to route around it. Marking an
-- uncertified employee "published" is precisely the false-green this codebase
-- keeps having to remove — it would have made 16 employees look certified when
-- not one of them has ever been evaluated.
--
-- So the correction goes the other way, uniformly: an employee cannot be
-- switched ON before it has been published. The switch moves, not the stage.
--
-- Verified this breaks nothing first: both places that reach the in-app
-- assistant (workforce-chat and provision-workforce-assistants) look it up by
-- `is_workforce_assistant` alone and never filter on status, so the dock
-- assistant stays reachable exactly as before.
update digital_employees
   set status = 'idle', updated_at = now()
 where status = 'active'
   and lifecycle_status in ('designed','configured','trained','tested','certified');

-- ── Stop the two writers producing it again ──────────────────────────────
-- A BEFORE INSERT normaliser rather than a splice into two long function
-- bodies: it covers both writers, and any future one with the same omission.
-- ⚠ It fires on EVERY insert (a BEFORE INSERT trigger always does — the
-- mig-597 lesson), so it must be a no-op unless the combination is actually
-- illegal. It never touches a row that is already coherent.
create or replace function normalise_de_state()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not de_status_allowed(NEW.lifecycle_status, NEW.status) then
    -- The STAGE is authoritative; the switch is coerced to a legal value.
    -- Never the reverse: promoting the stage to justify the switch would walk
    -- straight past gate_de_certification, which exists to stop exactly that.
    if NEW.lifecycle_status in ('paused','retired','archived') then
      NEW.status := 'disabled';
    else
      NEW.status := 'idle';
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_normalise_de_state on digital_employees;
create trigger trg_normalise_de_state
  before insert on digital_employees
  for each row execute function normalise_de_state();

-- ── resume must restore a COHERENT pair ──────────────────────────────────
-- It restored status='active' regardless of the stage it restored to, so
-- pausing a not-yet-published employee and resuming it would land straight
-- back in the contradiction — and, after this migration, fail the constraint.
do $splice$
declare
  v_def text;
  v_old text := 'update digital_employees set lifecycle_status = v_back_to, status = ''active'', updated_at = now()';
  v_new text := 'update digital_employees set lifecycle_status = v_back_to, status = case when v_back_to in (''designed'',''configured'',''trained'',''tested'',''certified'') then ''idle'' else ''active'' end, updated_at = now()';
  v_out text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind = 'f' and p.proname = 'resume_digital_employee';

  if v_def is null then raise exception 'resume_digital_employee is missing'; end if;
  if position(v_old in v_def) = 0 then
    raise exception 'resume anchor not found — refusing to splice';
  end if;

  v_out := replace(v_def, v_old, v_new);
  if v_out = v_def then raise exception 'resume splice was a silent no-op'; end if;
  execute v_out;
end;
$splice$;

-- ── Make it impossible, not merely tidy ──────────────────────────────────
alter table digital_employees
  add constraint digital_employees_status_matches_lifecycle
  check (de_status_allowed(lifecycle_status, status));

-- ── Prove it ─────────────────────────────────────────────────────────────
do $verify$
declare
  v_bad   int;
  v_total int;
  v_asst  int;
  v_tid   uuid := (select id from tenants where slug = 'outsourcetel-hq');
  v_probe uuid;
  v_stat  text;
  v_life  text;
begin
  select count(*) into v_bad from digital_employees
  where not de_status_allowed(lifecycle_status, status);
  if v_bad > 0 then raise exception '% row(s) still contradict themselves', v_bad; end if;

  select count(*) into v_total from digital_employees;
  select count(*) into v_asst from digital_employees where is_workforce_assistant;

  -- The normaliser must actually fire — an insert in the shape both provisioning
  -- writers use (switch on, pipeline left at its default) has to come back
  -- coherent, WITHOUT the stage being promoted past certification.
  if v_tid is not null then
    insert into digital_employees (tenant_id, name, status, is_workforce_assistant)
    values (v_tid, '__probe_state__', 'active', true)
    returning id, status, lifecycle_status into v_probe, v_stat, v_life;

    if v_stat <> 'idle' then
      raise exception 'the normaliser did not fire — status came back as %', v_stat;
    end if;
    if v_life <> 'designed' then
      raise exception 'the normaliser PROMOTED the stage to % — it must never do that', v_life;
    end if;
    delete from digital_employees where id = v_probe;
  end if;

  -- ...and the constraint must actually refuse an update into the bad state.
  begin
    update digital_employees set status = 'active'
    where lifecycle_status = 'retired' and id = (
      select id from digital_employees where lifecycle_status = 'retired' limit 1);
    raise exception 'the constraint let a retired employee be switched on';
  exception when check_violation then
    null;  -- correct
  end;

  raise notice 'state reconciled: 0 contradictions across % employees (% assistants), normaliser and constraint both proven',
    v_total, v_asst;
end;
$verify$;

commit;
