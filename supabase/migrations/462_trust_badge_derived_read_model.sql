-- ============================================================================
-- Migration 462 — TRUST PROGRAM (docs/31 Q7, Architecture B) — GROUP 5
-- The badge becomes a DERIVED READ-MODEL.
--
-- digital_employees.trust_level stops being a frozen hand-written word and is
-- recomputed from the two live sources of truth, in this precedence order:
--   1. de_records_gate(tenant, de)  → gated ⇒ 'supervised' (floor; gate wins)
--   2. MAX(trust_policies.current_level) across THAT employee's policies
--        0 → 'supervised'   1 → 'established'   2 → 'trusted'   3 → 'autonomous'
-- The existing 4-word CHECK (digital_employees_trust_level_check) accommodates
-- this exactly — re-verified live 2026-07-27:
--   CHECK (trust_level = ANY ('{supervised,established,trusted,autonomous}'))
--
-- ORDERING GUARANTEE (founder-locked, unchanged here): guardrails, destructive
-- gates and spend caps sit ABOVE the dial in every enforcement path. This
-- migration touches only a DISPLAY derivation (the badge) and the cert
-- fingerprint; it changes no enforcement path and no ordering.
--
-- RECOMPUTE FIRES FROM (all writers enumerated in the three auth contexts):
--   trust_policies       AFTER UPDATE OF current_level      (promotion/demotion)
--   de_incidents         AFTER INSERT OR UPDATE OF status, severity
--   role_certifications  AFTER INSERT OR UPDATE OF status, config_fingerprint
--   de_certifications    AFTER INSERT OR UPDATE OF status
-- The whole recompute chain (trg fn → recompute fn → de_records_gate →
-- resolve_de_archetype/de_config_fingerprint) is pure SQL over tables:
-- verified live that NONE of it references can_access_de or auth.uid(), so it
-- behaves identically under user JWT, service-role JWT, and DIRECT-DB
-- (pg_cron / nested triggers, role NULL, uid NULL). The downstream audit
-- triggers on digital_employees (log_tenant_activity, log_remote_access_write)
-- were read live and are null-uid safe (early return / swallow).
--
-- REQUIRED DEVIATION (discovered, proven, fixed here — see report):
-- de_config_fingerprint_row() included digital_employees.trust_level in the
-- certification fingerprint md5, and trg_alert_cert_regression listed it in
-- its UPDATE OF columns. With a derived badge that is a self-defeating loop:
-- any promotion would change the badge → change the fingerprint → stale every
-- passed certification → records-gate the employee → force the badge back to
-- 'supervised'. A promotion would demote itself. Since the badge is now a
-- derived OUTPUT, it cannot remain part of the config INPUT fingerprint.
-- This migration removes it from both, preserving the freshness of any cert
-- that is fresh at apply time (live today: 0 of 14 passed certs are fresh, so
-- the preservation step is defensive only).
--
-- INTENDED BEHAVIOR CHANGE (docs/31 intent, not a side effect): the
-- playbook-execute on_gate derivation (supabase/functions/playbook-execute/
-- index.ts ~1970) reads this badge — a genuinely-promoted employee (max
-- ladder level >= 2, not records-gated) now derives on_gate='continue' and
-- runs gated playbook actions hands-free. Guardrails/destructive gates/spend
-- caps still apply above, unchanged. Today all 116 badges stay 'supervised'
-- (all 38 ladder policies at level 0), so day-one behavior is identical.
--
-- KNOWN LIMITS (per spec, documented not hidden):
--  * Workspace-wide policies (de_id IS NULL, 8 rows live) have no owning
--    employee; their promotions move the dial, not any badge.
--  * degraded_metrics / never_certified gate transitions (evidence_runs
--    volume, tenant opt-in flips) recompute on the NEXT incident/cert/policy
--    touch, not instantly — attaching triggers to evidence_runs would fire on
--    every run for a display value.
--  * DELETEs are not watched (only tenant teardown deletes these rows).
--  * trust_policies INSERT does not fire the badge (spec: AFTER UPDATE OF
--    current_level); seeded policies start at level 0 = 'supervised' anyway.
-- This migration writes NO audit_events rows (verified live that 'governance'
-- is not a legal category; none needed here).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- §0 — Pre-state asserts: the live objects this migration reproduces/amends
--       still look the way they were read on 2026-07-27. If a later change
--       lands first, FAIL LOUDLY instead of clobbering it.
-- ---------------------------------------------------------------------------
do $mig$
declare v_def text; v_cnt int;
begin
  select count(*) into v_cnt from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'de_config_fingerprint_row';
  if v_cnt <> 1 then
    raise exception 'mig 462 pre: expected exactly 1 de_config_fingerprint_row, found %', v_cnt;
  end if;

  select pg_get_functiondef(p.oid) into v_def from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'de_config_fingerprint_row';
  if v_def not ilike '%coalesce(d.trust\_level%' escape '\' then
    raise exception 'mig 462 pre: de_config_fingerprint_row no longer contains the badge element — it was amended after this migration was drafted; re-verify from live before applying';
  end if;
  if v_def not ilike '%concat_ws%' or v_def not ilike '%v\_guard, v\_pb%' escape '\' then
    raise exception 'mig 462 pre: de_config_fingerprint_row body shape drifted from the live version this migration reproduces — re-verify';
  end if;

  select pg_get_triggerdef(t.oid) into v_def from pg_trigger t
   where t.tgrelid = 'public.digital_employees'::regclass
     and t.tgname = 'trg_alert_cert_regression' and not t.tgisinternal;
  if v_def is null then
    raise exception 'mig 462 pre: trg_alert_cert_regression not found on digital_employees';
  end if;
  if v_def not ilike '%trust\_level%' escape '\' then
    raise exception 'mig 462 pre: trg_alert_cert_regression no longer lists the badge column — amended since drafting; re-verify';
  end if;

  -- de_records_gate must exist with the (tenant, de) → (gated, reasons) shape.
  select count(*) into v_cnt from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'de_records_gate'
     and pg_get_function_identity_arguments(p.oid) = 'p_tenant_id uuid, p_de_id uuid';
  if v_cnt <> 1 then
    raise exception 'mig 462 pre: de_records_gate(p_tenant_id uuid, p_de_id uuid) not found as a single function';
  end if;

  -- The 4-word badge CHECK must still be exactly the 4 words we map onto.
  select pg_get_constraintdef(oid) into v_def from pg_constraint
   where conrelid = 'public.digital_employees'::regclass
     and conname = 'digital_employees_trust_level_check';
  if v_def is null
     or v_def not ilike '%supervised%' or v_def not ilike '%established%'
     or v_def not ilike '%trusted%'    or v_def not ilike '%autonomous%' then
    raise exception 'mig 462 pre: digital_employees_trust_level_check is not the expected 4-word check: %', coalesce(v_def, '<missing>');
  end if;
end
$mig$;

-- ---------------------------------------------------------------------------
-- §1 — Snapshot certification freshness UNDER THE OLD FORMULA, before it
--       changes. A cert is fresh iff its stored fingerprint equals the
--       current config's fingerprint. (Live today: 0 rows — defensive.)
-- ---------------------------------------------------------------------------
drop table if exists _mig_nnn_fresh_certs;
create temp table _mig_nnn_fresh_certs as
select rc.id, rc.de_id
  from public.role_certifications rc
 where rc.status = 'passed'
   and rc.config_fingerprint is not null
   and rc.config_fingerprint = public.de_config_fingerprint(rc.de_id);

-- ---------------------------------------------------------------------------
-- §2 — Remove the badge from the certification fingerprint. Body reproduced
--       from live pg_get_functiondef (2026-07-27) with exactly one concat
--       element removed. Same signature ⇒ CREATE OR REPLACE (no drop needed).
--       NOTE: the function body deliberately never names the removed column —
--       token asserts in §8 read pg_get_functiondef including comments.
-- ---------------------------------------------------------------------------
create or replace function public.de_config_fingerprint_row(d digital_employees)
returns text
language plpgsql
stable security definer
set search_path to 'public'
as $fn$
declare v_guard text; v_pb text;
begin
  -- mig 462: the employee badge is a DERIVED read-model (recomputed from the
  -- earned ladder + records gate), so it is an output of governance state,
  -- not configuration — deriving it must never stale a certification.
  select coalesce(count(*)::text, '0') || '|' || coalesce(max(updated_at)::text, '')
    into v_guard from guardrail_rules
   where tenant_id = d.tenant_id and active and scope = 'employee' and scope_ref = d.id::text;
  select coalesce(count(*)::text, '0') || '|' || coalesce(max(version)::text, '') || '|' || coalesce(max(updated_at)::text, '')
    into v_pb from playbook_definitions
   where tenant_id = d.tenant_id and de_id = d.id and status = 'published';
  return md5(concat_ws('~',
    coalesce(d.persona_name, ''), coalesce(d.description, ''),
    coalesce(d.model_provider, ''), coalesce(d.model_id, ''),
    coalesce(d.escalation_model_id, ''), coalesce(d.escalation_threshold::text, ''),
    coalesce(d.confidence_threshold::text, ''),
    coalesce(d.required_approval::text, ''), coalesce(d.task_type, ''),
    coalesce(d.external_reply_mode, ''), coalesce(d.capabilities::text, ''),
    coalesce(d.responsibilities::text, ''), coalesce(d.channels::text, ''),
    coalesce(d.knowledge_sources::text, ''), coalesce(d.skills::text, ''),
    coalesce(d.model_config::text, ''), coalesce(d.attributes::text, ''),
    v_guard, v_pb));
end;
$fn$;

-- ---------------------------------------------------------------------------
-- §3 — Preserve freshness across the formula change: any cert fresh under the
--       old formula gets its stored fingerprint rewritten to the new-formula
--       value of the SAME (unchanged) config. Certs already stale stay stale
--       (their historical config is unrecoverable — correctly conservative).
-- ---------------------------------------------------------------------------
update public.role_certifications rc
   set config_fingerprint = public.de_config_fingerprint(rc.de_id)
  from _mig_nnn_fresh_certs f
 where f.id = rc.id;

do $mig$
declare v_broken int;
begin
  select count(*) into v_broken
    from _mig_nnn_fresh_certs f
    join public.role_certifications rc on rc.id = f.id
   where rc.config_fingerprint is distinct from public.de_config_fingerprint(rc.de_id);
  if v_broken > 0 then
    raise exception 'mig 462: % previously-fresh certification(s) became stale under the new fingerprint formula', v_broken;
  end if;
  raise notice 'mig 462: fingerprint formula updated; % fresh cert(s) preserved', (select count(*) from _mig_nnn_fresh_certs);
end
$mig$;

-- ---------------------------------------------------------------------------
-- §4 — trg_alert_cert_regression must stop watching the badge column (a
--       derived-badge write is not a config change). Column list reproduced
--       from live pg_get_triggerdef minus that one column.
-- ---------------------------------------------------------------------------
drop trigger if exists trg_alert_cert_regression on public.digital_employees;
create trigger trg_alert_cert_regression
after update of persona_name, description, model_provider, model_id,
  escalation_model_id, escalation_threshold, confidence_threshold,
  required_approval, task_type, external_reply_mode, capabilities,
  responsibilities, channels, knowledge_sources, skills, model_config, attributes
on public.digital_employees
for each row execute function public.alert_cert_regression();

-- ---------------------------------------------------------------------------
-- §5 — The derivation. recompute_de_trust_badge is pure SQL over tables plus
--       de_records_gate (itself SECURITY DEFINER, auth-free). It NEVER throws
--       into the writer: the badge is a read-model, and a display failure must
--       not abort incident recording, certification, promotion or a cron
--       sweep (the writers run in all three auth contexts). Failures surface
--       as WARNINGs in the DB log; enforcement paths (resolve_de_autonomy)
--       compute the gate live and independently, so they are never stale.
-- ---------------------------------------------------------------------------
create or replace function public.recompute_de_trust_badge(p_tenant_id uuid, p_de_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $fn$
declare
  v_gated boolean := false;
  v_max   integer;
  v_badge text;
begin
  if p_tenant_id is null or p_de_id is null then
    return;
  end if;

  -- Records gate wins: any gating record pins the badge to the floor.
  select g.gated into v_gated from public.de_records_gate(p_tenant_id, p_de_id) g;

  if coalesce(v_gated, false) then
    v_badge := 'supervised';
  else
    -- The employee's earned ladder: MAX current level across ITS policies
    -- (workspace-wide policies have no owning employee and never move a badge).
    select max(tp.current_level) into v_max
      from trust_policies tp
     where tp.tenant_id = p_tenant_id and tp.de_id = p_de_id;
    v_badge := case coalesce(v_max, 0)
                 when 0 then 'supervised'
                 when 1 then 'established'
                 when 2 then 'trusted'
                 else 'autonomous'
               end;
  end if;

  update digital_employees
     set trust_level = v_badge
   where id = p_de_id and tenant_id = p_tenant_id
     and trust_level is distinct from v_badge;
exception when others then
  -- Read-model only: never abort the governance write that fired us.
  raise warning 'recompute_de_trust_badge(%, %) failed: %', p_tenant_id, p_de_id, sqlerrm;
end;
$fn$;

create or replace function public.trg_recompute_trust_badge()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $fn$
begin
  if TG_OP = 'INSERT' then
    perform public.recompute_de_trust_badge(NEW.tenant_id, NEW.de_id);
  else
    perform public.recompute_de_trust_badge(NEW.tenant_id, NEW.de_id);
    if OLD.de_id is distinct from NEW.de_id then
      perform public.recompute_de_trust_badge(OLD.tenant_id, OLD.de_id);
    end if;
  end if;
  return null;
end;
$fn$;

-- (a) Ladder movement — apply_trust_promotion (user JWT / service-role) and
--     trust_demote (fires from AFTER-triggers on audit_events / eval_runs, so
--     ALL THREE contexts incl. cron) both UPDATE current_level. A same-value
--     touch also fires (UPDATE OF semantics) — used by the §7 proof.
drop trigger if exists trg_badge_from_trust_policy on public.trust_policies;
create trigger trg_badge_from_trust_policy
after update of current_level on public.trust_policies
for each row when (new.de_id is not null)
execute function public.trg_recompute_trust_badge();

-- (b) Incidents — writers: detect_de_incidents_internal +
--     de_governance_sweep_internal (pg_cron, DIRECT-DB), de-answer/widget-ask
--     (service-role), review_de_incident (user JWT). The sweep's
--     detail-only sla_nudged UPDATE is deliberately outside the OF list.
--     A reviewed/closed critical incident visibly restores the header chip.
drop trigger if exists trg_badge_from_incident on public.de_incidents;
create trigger trg_badge_from_incident
after insert or update of status, severity on public.de_incidents
for each row when (new.de_id is not null)
execute function public.trg_recompute_trust_badge();

-- (c) Exam certifications — writers: certify_de_from_eval / certify_de_from_sim
--     (service-role via eval-run / de-simulate; eval-run is also cron-invoked).
--     alert_cert_regression's stale_alerted-only UPDATE is deliberately
--     outside the OF list (no trigger-in-trigger churn, no cycles).
drop trigger if exists trg_badge_from_role_cert on public.role_certifications;
create trigger trg_badge_from_role_cert
after insert or update of status, config_fingerprint on public.role_certifications
for each row
execute function public.trg_recompute_trust_badge();

-- (d) Governance certifications — writers: certify_digital_employee /
--     advance_de_lifecycle / revoke_de_certification (user JWT),
--     de_governance_sweep_internal expiry flip (pg_cron, DIRECT-DB).
--     The warned_at-only UPDATE is deliberately outside the OF list.
drop trigger if exists trg_badge_from_governance_cert on public.de_certifications;
create trigger trg_badge_from_governance_cert
after insert or update of status on public.de_certifications
for each row
execute function public.trg_recompute_trust_badge();

-- ---------------------------------------------------------------------------
-- §6 — Backfill: derive every employee's badge once now. Live expectation
--       2026-07-27: all 116 stay 'supervised' (all 38 ladder policies at
--       level 0; gated employees floor to 'supervised' anyway) — so this is
--       an alignment pass, not a behavior change.
-- ---------------------------------------------------------------------------
do $mig$
declare r record; v_after text; v_total int := 0; v_changed int := 0;
begin
  for r in select id, tenant_id, trust_level from digital_employees loop
    v_total := v_total + 1;
    perform public.recompute_de_trust_badge(r.tenant_id, r.id);
    select trust_level into v_after from digital_employees where id = r.id;
    if v_after is distinct from r.trust_level then
      v_changed := v_changed + 1;
      raise notice 'mig 462 backfill: employee % badge % -> %', r.id, r.trust_level, v_after;
    end if;
  end loop;
  raise notice 'mig 462 backfill: % employees re-derived, % badge(s) changed', v_total, v_changed;
end
$mig$;

-- ---------------------------------------------------------------------------
-- §7 — Behavioral proof, inside this transaction, no auth involved:
--       plant a deliberately WRONG badge on a demo-tenant employee, then do a
--       same-value UPDATE of its policy's current_level (a value no-op, but
--       UPDATE OF fires the trigger). The badge must snap back to the derived
--       value — proving the policies-side trigger executes end-to-end and the
--       recompute genuinely WRITES (a swallowed failure cannot fake this).
--       Nothing to roll back: the end state IS the correct derived value.
-- ---------------------------------------------------------------------------
do $mig$
declare
  v_pol record;
  v_gated boolean; v_max integer;
  v_expected text; v_plant text; v_actual text;
begin
  select tp.id, tp.tenant_id, tp.de_id into v_pol
    from trust_policies tp
    join tenants t on t.id = tp.tenant_id
   where tp.de_id is not null and t.slug = 'fashion-nova'
   order by tp.created_at, tp.id limit 1;
  if v_pol.id is null then
    -- Fallback for non-production environments without the demo tenant.
    select tp.id, tp.tenant_id, tp.de_id into v_pol
      from trust_policies tp where tp.de_id is not null
     order by tp.created_at, tp.id limit 1;
  end if;
  if v_pol.id is null then
    raise notice 'mig 462 proof SKIPPED: no per-employee trust policy row in this environment';
    return;
  end if;

  -- Expected value under the exact mapping this migration installs.
  select g.gated into v_gated from public.de_records_gate(v_pol.tenant_id, v_pol.de_id) g;
  select max(current_level) into v_max
    from trust_policies where tenant_id = v_pol.tenant_id and de_id = v_pol.de_id;
  v_expected := case when coalesce(v_gated, false) then 'supervised'
                     else case coalesce(v_max, 0)
                            when 0 then 'supervised'
                            when 1 then 'established'
                            when 2 then 'trusted'
                            else 'autonomous'
                          end
                end;

  -- Plant a badge that is provably wrong so the recompute write is observable.
  v_plant := case when v_expected = 'autonomous' then 'supervised' else 'autonomous' end;
  update digital_employees set trust_level = v_plant
   where id = v_pol.de_id and tenant_id = v_pol.tenant_id;

  -- Same-value ladder touch: fires trg_badge_from_trust_policy.
  update trust_policies set current_level = current_level where id = v_pol.id;

  select trust_level into v_actual from digital_employees where id = v_pol.de_id;
  if v_actual is distinct from v_expected then
    raise exception 'mig 462 proof FAILED: policy % touch left badge % (expected %) on employee %',
      v_pol.id, coalesce(v_actual, '<null>'), v_expected, v_pol.de_id;
  end if;
  raise notice 'mig 462 proof: same-value update on policy % recomputed employee % badge to % (gated=%, max_level=%)',
    v_pol.id, v_pol.de_id, v_actual, coalesce(v_gated, false), coalesce(v_max, 0);
end
$mig$;

-- ---------------------------------------------------------------------------
-- §8 — Catalog asserts: everything landed, exactly once, on the right events.
-- ---------------------------------------------------------------------------
do $mig$
declare v_cnt int; v_def text;
begin
  -- Exactly one of each function (no stray arities).
  select count(*) into v_cnt from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'recompute_de_trust_badge';
  if v_cnt <> 1 then raise exception 'mig 462: recompute_de_trust_badge count = % (want 1)', v_cnt; end if;

  select count(*) into v_cnt from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'trg_recompute_trust_badge';
  if v_cnt <> 1 then raise exception 'mig 462: trg_recompute_trust_badge count = % (want 1)', v_cnt; end if;

  select count(*) into v_cnt from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'de_config_fingerprint_row';
  if v_cnt <> 1 then raise exception 'mig 462: de_config_fingerprint_row count = % (want 1)', v_cnt; end if;

  -- The recompute references the gate and the full 4-word mapping.
  select pg_get_functiondef(p.oid) into v_def from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'recompute_de_trust_badge';
  if v_def not ilike '%de\_records\_gate%' escape '\'
     or v_def not ilike '%''supervised''%'  or v_def not ilike '%''established''%'
     or v_def not ilike '%''trusted''%'     or v_def not ilike '%''autonomous''%'
     or v_def not ilike '%max(tp.current\_level)%' escape '\' then
    raise exception 'mig 462: recompute_de_trust_badge body missing gate reference or level mapping';
  end if;

  -- The badge column is gone from the cert fingerprint (incl. comments)...
  select pg_get_functiondef(p.oid) into v_def from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'de_config_fingerprint_row';
  if v_def ilike '%trust\_level%' escape '\' then
    raise exception 'mig 462: de_config_fingerprint_row still names the badge column';
  end if;

  -- ...and from the cert-regression trigger's watched columns.
  select pg_get_triggerdef(t.oid) into v_def from pg_trigger t
   where t.tgrelid = 'public.digital_employees'::regclass
     and t.tgname = 'trg_alert_cert_regression' and not t.tgisinternal;
  if v_def is null then
    raise exception 'mig 462: trg_alert_cert_regression missing after recreate';
  end if;
  if v_def ilike '%trust\_level%' escape '\' then
    raise exception 'mig 462: trg_alert_cert_regression still watches the badge column';
  end if;
  if v_def not ilike '%persona\_name%' escape '\' or v_def not ilike '%attributes%' then
    raise exception 'mig 462: trg_alert_cert_regression lost its config column list';
  end if;

  -- The four recompute triggers, on the right tables and events.
  select pg_get_triggerdef(t.oid) into v_def from pg_trigger t
   where t.tgrelid = 'public.trust_policies'::regclass and t.tgname = 'trg_badge_from_trust_policy';
  if v_def is null or v_def not ilike '%after update of current\_level on public.trust\_policies%' escape '\'
     or v_def not ilike '%for each row%' or v_def not ilike '%new.de\_id is not null%' escape '\'
     or v_def not ilike '%trg\_recompute\_trust\_badge()%' escape '\' then
    raise exception 'mig 462: trg_badge_from_trust_policy wrong or missing: %', coalesce(v_def, '<missing>');
  end if;

  select pg_get_triggerdef(t.oid) into v_def from pg_trigger t
   where t.tgrelid = 'public.de_incidents'::regclass and t.tgname = 'trg_badge_from_incident';
  if v_def is null or v_def not ilike '%after insert or update of%' or v_def not ilike '%status%'
     or v_def not ilike '%severity%' or v_def not ilike '%on public.de\_incidents%' escape '\'
     or v_def not ilike '%for each row%' or v_def not ilike '%new.de\_id is not null%' escape '\'
     or v_def not ilike '%trg\_recompute\_trust\_badge()%' escape '\' then
    raise exception 'mig 462: trg_badge_from_incident wrong or missing: %', coalesce(v_def, '<missing>');
  end if;

  select pg_get_triggerdef(t.oid) into v_def from pg_trigger t
   where t.tgrelid = 'public.role_certifications'::regclass and t.tgname = 'trg_badge_from_role_cert';
  if v_def is null or v_def not ilike '%after insert or update of%' or v_def not ilike '%status%'
     or v_def not ilike '%config\_fingerprint%' escape '\'
     or v_def not ilike '%on public.role\_certifications%' escape '\'
     or v_def not ilike '%for each row%'
     or v_def not ilike '%trg\_recompute\_trust\_badge()%' escape '\' then
    raise exception 'mig 462: trg_badge_from_role_cert wrong or missing: %', coalesce(v_def, '<missing>');
  end if;

  select pg_get_triggerdef(t.oid) into v_def from pg_trigger t
   where t.tgrelid = 'public.de_certifications'::regclass and t.tgname = 'trg_badge_from_governance_cert';
  if v_def is null or v_def not ilike '%after insert or update of status on public.de\_certifications%' escape '\'
     or v_def not ilike '%for each row%'
     or v_def not ilike '%trg\_recompute\_trust\_badge()%' escape '\' then
    raise exception 'mig 462: trg_badge_from_governance_cert wrong or missing: %', coalesce(v_def, '<missing>');
  end if;

  raise notice 'mig 462: all catalog asserts passed';
end
$mig$;

drop table if exists _mig_nnn_fresh_certs;

-- PostgREST schema reload (new function surface).
notify pgrst, 'reload schema';
