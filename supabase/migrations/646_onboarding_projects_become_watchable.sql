-- 646_onboarding_projects_become_watchable.sql
-- ============================================================================
-- An onboarding project is the record of a customer being set up. Nothing
-- watched it. `onboarding_projects` was not in watch_source_catalog, so no
-- watcher could name it, no case could open against it, and — because de-work
-- resolves its desk from the objective's entity_kind — an onboarding case would
-- have arrived carrying no facts at all.
--
-- This registers it as a first-class watchable source: one catalog row and
-- three field rows. It INSTALLS NO WATCHER. Registration makes the source
-- nameable; deciding that a given workspace should open a case per project is a
-- separate act, for a reason set out at the bottom.
--
-- WHY REGISTRATION IS ENOUGH TO BE SAFE. The generic watcher arms build their
-- SQL from THIS TABLE and nowhere else — identifiers via %I from a
-- platform-owned registry (RLS on, SELECT-only, no tenant write path),
-- values USING-bound, operators through the sql_op() whitelist, base predicates
-- through build_base_predicates' closed CASE (is_null / is_not_null /
-- ge_current_date). Adding a row extends what can be watched without widening
-- what can be expressed. That is the closed-library law from mig 505.
--
-- FOUR ROWS, and the shapes matter:
--   · default_horizons is JSONB, not a text[]. It looks like a list and is not
--     one; a Postgres array literal here fails on insert.
--   · legacy_bespoke = FALSE. The three original sources carry TRUE because
--     run_work_watchers still has hand-written branches for them reproduced
--     byte-for-byte. This source has no bespoke branch and must fall to the
--     generic catalog-driven evaluator — which is the whole point of the
--     registry existing.
--   · base_predicates excludes finished work (`completed_at IS NULL`), the same
--     way `opportunities` excludes closed ones. Without it a completed project
--     stays eligible forever and the employee is handed work that is done.
--
-- EXACTLY ONCE is not asserted by hope: work_watcher_matches carries
-- UNIQUE (watcher_id, occurrence_key), so a second tick over the same project
-- cannot open a second case. Verified below rather than assumed.
--
-- ⚠ THE OVERLAP, STATED RATHER THAN SILENTLY RESOLVED. Onboarding employees
-- already run a `schedule` watcher ("Daily onboarding progress review",
-- interval 1440). That is a daily SHIFT — it has no source and does not read
-- projects. Per-project cases would therefore not double-process a record
-- through the same mechanism, but the employee would receive both a daily sweep
-- and a case per project. Which of those is the real unit of work is a founder
-- decision about how onboarding should run, not a schema question, so this
-- migration deliberately stops at making the choice POSSIBLE.
-- ============================================================================

begin;

-- ── 1. The source. ────────────────────────────────────────────────────────
insert into watch_source_catalog (
  source_key, entity_kind, domain_category, table_name, id_column, tenant_column,
  label_columns, status_column, base_predicates, subject_columns, supports_kinds,
  require_domain_grant, legacy_bespoke, default_horizons, active)
values (
  'onboarding_projects', 'onboarding_project', 'product_system',
  'onboarding_projects', 'id', 'tenant_id',
  array['name'], 'status',
  -- Work that is finished is not work.
  '[{"op":"is_null","col":"completed_at"}]'::jsonb,
  -- These become plan.subject, which de-work now renders into the prompt. They
  -- are the facts an employee needs to act: who, what state, by when, how far.
  array['name', 'status', 'target_golive', 'progress_pct', 'account_id'],
  array['date_horizon', 'state_condition'],
  false,          -- internal table, like customer_accounts — no connector grant
  false,          -- generic evaluator, NOT a bespoke branch
  '[30, 14, 7]'::jsonb,   -- JSONB. Not a text[]; a list literal fails here.
  true)
on conflict (source_key) do update set
  entity_kind          = excluded.entity_kind,
  domain_category      = excluded.domain_category,
  table_name           = excluded.table_name,
  id_column            = excluded.id_column,
  tenant_column        = excluded.tenant_column,
  label_columns        = excluded.label_columns,
  status_column        = excluded.status_column,
  base_predicates      = excluded.base_predicates,
  subject_columns      = excluded.subject_columns,
  supports_kinds       = excluded.supports_kinds,
  require_domain_grant = excluded.require_domain_grant,
  legacy_bespoke       = excluded.legacy_bespoke,
  default_horizons     = excluded.default_horizons,
  active               = excluded.active;

-- ── 2. The three fields a watcher may name. ───────────────────────────────
insert into watch_source_fields (source_key, role, column_name, value_type, allowed_ops, label)
values
  ('onboarding_projects', 'date',  'target_golive', 'date',    array[]::text[],                              'Go-live date'),
  ('onboarding_projects', 'state', 'status',        'text',    array['eq','neq'],                            'Status'),
  ('onboarding_projects', 'state', 'progress_pct',  'numeric', array['lt','lte','gt','gte','eq','neq'],      'Progress (%)')
-- The key is (source_key, ROLE, column_name) — role is part of it, so the same
-- column can legitimately appear as both a date and a state field. Naming only
-- (source_key, column_name) fails outright: 42P10, no matching constraint.
on conflict (source_key, role, column_name) do update set
  value_type  = excluded.value_type,
  allowed_ops = excluded.allowed_ops,
  label       = excluded.label;

-- ── 3. Prove the registry actually accepts real watcher shapes. ───────────
-- Storage is not usability. A row that sits in the catalog but that the
-- validator refuses is a source nobody can watch, and we have shipped exactly
-- that before (a template stored fine and failed the wizard's own validator).
-- So this runs the SAME validator the installer runs.
do $$
declare
  v_tenant uuid;
  v_de     uuid;
  v_err    text;
  v_idx    int;
  v_cols   int;
begin
  -- The idempotency guarantee, checked rather than believed: without this index
  -- a second tick over the same project opens a second case.
  select count(*) into v_idx from pg_indexes
   where schemaname = 'public' and tablename = 'work_watcher_matches'
     and indexdef ilike '%UNIQUE%' and indexdef ilike '%watcher_id%'
     and indexdef ilike '%occurrence_key%';
  if v_idx = 0 then
    raise exception '646: work_watcher_matches has no unique (watcher_id, occurrence_key) — one project could open many cases';
  end if;

  -- Every column named in the catalog must exist on the table. A typo here is
  -- a watcher that fails at TICK time, in a cron, where nobody is watching.
  select count(*) into v_cols
    from unnest(array['name','status','target_golive','progress_pct','account_id',
                      'id','tenant_id','completed_at']) c
   where not exists (select 1 from information_schema.columns
                      where table_schema='public' and table_name='onboarding_projects'
                        and column_name = c);
  if v_cols > 0 then
    raise exception '646: % catalog column(s) do not exist on onboarding_projects', v_cols;
  end if;

  select id into v_tenant from tenants where status = 'active' order by created_at limit 1;
  select id into v_de from digital_employees where tenant_id = v_tenant limit 1;
  if v_tenant is null or v_de is null then
    raise notice '646: no active tenant/employee here — validator check skipped (expected on dev/replay)';
    return;
  end if;

  -- NOTE THE SHAPE, learned the hard way when this assertion failed: a
  -- state_condition names its field/op/value at the TOP LEVEL of config, not
  -- nested under a `condition` object. And the horizon list key is
  -- `horizons_days` — plural — so a singular `horizon_days` is silently ignored
  -- rather than rejected. Both are the kind of thing that would have shipped as
  -- a watcher that validates fine and watches nothing.
  v_err := validate_watcher_config('date_horizon',
    jsonb_build_object('source', 'onboarding_projects', 'date_field', 'target_golive',
                       'horizons_days', jsonb_build_array(30, 14, 7)),
    v_tenant, v_de);
  if v_err is not null then
    raise exception '646: the validator refuses a go-live horizon watcher: %', v_err;
  end if;

  v_err := validate_watcher_config('state_condition',
    jsonb_build_object('source', 'onboarding_projects',
                       'field', 'progress_pct', 'op', 'lt', 'value', '100'),
    v_tenant, v_de);
  if v_err is not null then
    raise exception '646: the validator refuses a progress watcher: %', v_err;
  end if;

  -- And the negative half: a column NOT in the registry must be refused, or the
  -- registry is decoration rather than a boundary.
  v_err := validate_watcher_config('state_condition',
    jsonb_build_object('source', 'onboarding_projects',
                       'field', 'items_state', 'op', 'eq', 'value', 'x'),
    v_tenant, v_de);
  if v_err is null then
    raise exception '646: the validator ACCEPTED a column that is not in the registry — the closed library is open';
  end if;

  raise notice '646: onboarding_projects registered; horizon + progress watchers validate, an unregistered column is refused';
end $$;

commit;
