-- ============================================================
-- Migration 546: a periodic audit for work-creating writers that ignore
-- tenant suspension.
--
-- WHY. Suspension is enforced writer-by-writer, so it is only ever as complete
-- as the last person's memory. That failed twice already: mig 430 guarded the
-- twenty dispatchers but missed the staleness watchdog, which kept escalating
-- for a suspended tenant for three days (fixed in 545). Nothing in the system
-- would have told us — it was found by hand during a review. This turns
-- "remember to add the guard" into a detector.
--
-- WHAT IT IS: a REGRESSION detector, not a defect list. Today's known writers
-- are baselined as reviewed-exempt, so the audit is quiet until something NEW
-- appears — which is exactly the signal wanted: "a new work-creating path
-- forgot to ask whether the tenant is suspended."
--
-- HOW IT DECIDES. A function is flagged when it INSERTs into a table where a
-- row means the workforce did or queued something, AND it carries no
-- suspension check, AND it is not baselined. Two guard spellings are both
-- accepted, because both are genuinely in use:
--     tenant_is_operational(...)            -- the helper (mig 430)
--     status in ('active','trial')          -- the literal predicate that
--                                              predates it, e.g.
--                                              run_reply_mode_gate_internal
-- Without the second form the audit would have cried wolf on two functions
-- that are correctly guarded. (Verified: it does exactly that if omitted.)
--
-- KNOWN LIMITS, stated rather than hidden:
--   * Human-driven RPCs (those referencing auth.uid()/auth_tenant_id()) are
--     excluded. A person acting deliberately in their own workspace is a
--     different question from autonomous machinery, and including ~14 of them
--     would bury the signal. If suspended-tenant humans must also be blocked,
--     that is a separate, deliberate decision.
--   * Text matching on prosrc. A writer that inserts via dynamic SQL, or one
--     guarded only by its CALLER, is not understood — hence the baseline is a
--     review prompt, not a proof of safety.
--   * The baseline seeded below was recorded as pre-existing, NOT individually
--     audited. Reviewing those ten is a separate task.
-- ============================================================

create table if not exists public.dormancy_writer_exemptions (
  function_name text primary key,
  reason        text not null,
  reviewed      boolean not null default false,
  created_at    timestamptz not null default now()
);
comment on table public.dormancy_writer_exemptions is
  'Writers deliberately allowed to create work without a suspension check. reviewed=false means "baselined, not yet audited".';

alter table public.dormancy_writer_exemptions enable row level security;
revoke all on table public.dormancy_writer_exemptions from public, anon, authenticated;

-- ── The detector. Callable on demand; returns one row per suspect. ──
create or replace function public.audit_unguarded_dormancy_writers()
returns table(function_name text, writes_to text)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select p.proname::text,
         (select string_agg(t, ', ' order by t)
            from unnest(array['human_tasks','de_work_items','playbook_trigger_fires',
                              'staleness_escalations','de_objectives','de_incidents',
                              'de_development_items']) t
           where p.prosrc ~* ('insert\s+into\s+' || t))
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind = 'f'
    -- writes something that MEANS the workforce acted
    and p.prosrc ~* 'insert\s+into\s+(human_tasks|de_work_items|playbook_trigger_fires|staleness_escalations|de_objectives|de_incidents|de_development_items)'
    -- …with neither accepted spelling of the suspension check
    and p.prosrc not ilike '%tenant_is_operational%'
    and p.prosrc !~* 'status\s+in\s*\(\s*''active''\s*,\s*''trial''\s*\)'
    -- …and is not a human-driven RPC (see KNOWN LIMITS above)
    and p.prosrc !~* 'auth\.uid\(\)|auth_tenant_id\(\)'
    -- …and has not been reviewed and accepted
    and not exists (select 1 from dormancy_writer_exemptions x where x.function_name = p.proname)
  order by 1;
$function$;
revoke all on function public.audit_unguarded_dormancy_writers() from public, anon, authenticated;

-- ── The periodic run: alert only when something NEW shows up. ──
create or replace function public.run_dormancy_writer_audit()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_names text;
  v_count int;
begin
  select count(*), string_agg(function_name, ', ' order by function_name)
    into v_count, v_names
    from audit_unguarded_dormancy_writers();

  if v_count > 0 then
    perform raise_ops_alert(
      'dormancy_writer_unguarded',
      format('%s work-creating function(s) can queue work for a SUSPENDED workspace without checking: %s. '
             || 'Either add the suspension check, or record why it is safe in dormancy_writer_exemptions.',
             v_count, v_names),
      jsonb_build_object('kind', 'dormancy_writer_unguarded', 'count', v_count,
                         'functions', string_to_array(v_names, ', '))
    );
  end if;

  return jsonb_build_object('unguarded', v_count, 'functions', coalesce(v_names, ''));
end;
$function$;
revoke all on function public.run_dormancy_writer_audit() from public, anon, authenticated;

-- Weekly is the right cadence: this catches a NEW code path, which only
-- arrives with a deploy, and a noisy guard-rail is an ignored guard-rail.
select cron.schedule('dormancy-writer-audit-weekly', '20 6 * * 1',
                     'select public.run_dormancy_writer_audit()');

-- ── Baseline: today's writers, recorded as pre-existing and NOT yet audited.
-- Each is reachable only from a dispatcher that mig 430 already guards, or from
-- an edge function invoked by one — but that is an argument to CHECK, not a
-- proof, so reviewed=false until someone confirms each individually.
insert into dormancy_writer_exemptions (function_name, reason, reviewed) values
  ('apply_onboarding_verification', 'Baseline 2026-08-04. Service-role only; reached via the onboarding-verify cron piggyback. NOT individually audited.', false),
  ('create_improvement_review',     'Baseline 2026-08-04. Reached from de-improve, dispatched by dispatch_de_improve_internal (guarded). NOT individually audited.', false),
  ('create_outbound_draft',         'Baseline 2026-08-04. A DE tool, reached through the work engine (claim_de_work_items is guarded). NOT individually audited.', false),
  ('open_de_escalation',            'Baseline 2026-08-04. Escalation writer used by the work engine. NOT individually audited.', false),
  ('promote_gap_cluster',           'Baseline 2026-08-04. Knowledge-gap promotion. NOT individually audited.', false),
  ('propose_computer_use_task',     'Baseline 2026-08-04. Browser-operator proposal path. NOT individually audited.', false),
  ('propose_learned_behavior',      'Baseline 2026-08-04. Learned-behaviour proposal path. NOT individually audited.', false),
  ('record_action_execution',       'Baseline 2026-08-04. The action-ledger writer; its callers carry the gate. NOT individually audited.', false),
  ('record_inquiry_decision',       'Baseline 2026-08-04. Triage decision writer. NOT individually audited.', false),
  ('trust_demote',                  'Baseline 2026-08-04. Trust demotion path. NOT individually audited.', false)
on conflict (function_name) do nothing;

do $assert$
declare v_n int; v_probe int;
begin
  if not exists (select 1 from cron.job where jobname = 'dormancy-writer-audit-weekly') then
    raise exception 'mig 546: weekly audit cron not scheduled';
  end if;

  -- The baseline must leave the audit QUIET, or it will be ignored from day one.
  select count(*) into v_n from audit_unguarded_dormancy_writers();
  if v_n <> 0 then
    raise exception 'mig 546: audit is noisy at introduction (% unbaselined)', v_n;
  end if;

  -- …and it must still be capable of flagging something: with one baseline row
  -- withdrawn, that writer must reappear. A detector that can only ever return
  -- zero is worse than none.
  delete from dormancy_writer_exemptions where function_name = 'open_de_escalation';
  select count(*) into v_probe from audit_unguarded_dormancy_writers();
  insert into dormancy_writer_exemptions (function_name, reason, reviewed)
  values ('open_de_escalation', 'Baseline 2026-08-04. Escalation writer used by the work engine. NOT individually audited.', false);
  if v_probe <> 1 then
    raise exception 'mig 546: detector failed its own probe (expected 1 on withdrawal, got %)', v_probe;
  end if;
end
$assert$;
