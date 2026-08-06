-- 614 — one action, one executor (and two smaller duplicates).
--
-- Round 3 of the duplicate audit. The headline is a live ambiguity that has
-- been open since migration 605 and is recorded there as "STILL OPEN".
--
-- ⚠⚠ ERPNext registers TWO active action_definitions per key, differing ONLY
-- by their executor:
--
--   send_payment_reminder  ->  erpnext_invoice_comment      (an INTERNAL note)
--   send_payment_reminder  ->  erpnext_send_invoice_email   (EMAILS THE CUSTOMER)
--   send_final_notice      ->  the same pair
--
-- Migration 605 gave the two DISTINCT TOOL NAMES, so a digital employee can
-- choose between them. But connector-hub's resolveActionDefinition looks the
-- action up by (category, action_key, provider) — which matches BOTH — and
-- then takes list.find(...), i.e. THE FIRST ROW OF AN UNORDERED QUERY. There
-- is no ORDER BY. Which executor runs is arbitrary.
--
-- Measured, not assumed: send_payment_reminder has executed 12 times and every
-- one landed on the COMMENT executor; the email executor has never run. So the
-- tie has been breaking consistently — by luck, not by design. Postgres is
-- free to return those rows in a different order after any update or vacuum,
-- and the day it does, an employee that meant to leave an internal note starts
-- EMAILING CUSTOMERS instead. That is the direction that matters.
--
-- The collections path is already safe and shows the right shape:
-- run_dunning_sweep computes an execution_key and dunning_action_for matches
-- on it explicitly. Only the DE's agentic tool path is ambiguous, because it
-- passes action_key alone.
--
-- The fix is to stop throwing away the identity we already computed:
-- get_agentic_tools_for_de derives the tool name from v_def.id but never
-- returns the id. Emit it, and connector-hub can resolve exactly.

begin;

-- ── 1. The tool list carries the definition it means ─────────────────────
-- Spliced rather than retyped: this function builds a whole tool schema and
-- re-transcribing it to add one field is how a working generator acquires a
-- typo. Anchored on content, asserted before and after.
do $splice$
declare
  v_def text;
  v_old text := '          ''connector_id'', v_conn.id,';
  v_new text := '          ''connector_id'', v_conn.id,' || E'\n' ||
                '          -- The EXACT definition this tool stands for. The name above already' || E'\n' ||
                '          -- encodes it (mig 605 suffixes with md5(v_def.id)), but the caller was' || E'\n' ||
                '          -- left to re-derive the action from (connector, action_key) — which is' || E'\n' ||
                '          -- ambiguous whenever one key has several executors.' || E'\n' ||
                '          ''action_definition_id'', v_def.id,';
  v_out text;
  v_n   int;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind = 'f' and p.proname = 'get_agentic_tools_for_de';

  if v_def is null then raise exception 'get_agentic_tools_for_de is missing'; end if;

  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  if v_n <> 1 then
    raise exception 'expected exactly 1 connector_id emit, found % — refusing to splice', v_n;
  end if;

  v_out := replace(v_def, v_old, v_new);
  if v_out = v_def then raise exception 'the splice was a silent no-op'; end if;
  execute v_out;

  -- AFTER: the field must actually be there now.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'get_agentic_tools_for_de';
  if position('action_definition_id' in v_def) = 0 then
    raise exception 'action_definition_id did not land in the tool list';
  end if;
end;
$splice$;

-- ── 2. One workforce assistant per workspace, ENFORCED ───────────────────
-- THREE functions insert the built-in Workspace Assistant —
-- create_workforce_assistant_de, provision_workforce_assistant_internal, and
-- an inline copy inside the auto_provision_new_tenant trigger. Each guards
-- with "check, then insert", which is a race and three places to get wrong.
-- Today 16 tenants hold exactly 16 assistants, so nothing is broken; that is
-- an observation, not a guarantee. A partial unique index makes it one.
create unique index if not exists idx_one_workforce_assistant_per_tenant
  on digital_employees (tenant_id)
  where is_workforce_assistant;

-- ── 3. Indexes that duplicate a UNIQUE constraint ────────────────────────
-- In each pair a non-unique idx_* covers exactly the columns of a UNIQUE
-- constraint's own index. The unique index answers every query the other
-- does, so these are pure write amplification and storage.
drop index if exists idx_deployment_stages_de;      -- = de_deployment_stages_de_id_key
drop index if exists idx_billing_config_tenant;     -- = tenant_billing_config_tenant_id_key
drop index if exists idx_cost_tracking_tenant_month; -- = tenant_cost_tracking_tenant_id_billing_month_key
drop index if exists idx_tenant_toggles_tenant;     -- = tenant_feature_toggles_tenant_id_key
drop index if exists idx_usage_metrics_tenant_month; -- = tenant_usage_metrics_tenant_id_month_year_key

-- ── Prove it ─────────────────────────────────────────────────────────────
do $verify$
declare
  v_dupes int;
  v_tools jsonb;
  v_de    uuid;
  v_tid   uuid := (select id from tenants where slug = 'outsourcetel-hq');
  v_with  int;
begin
  -- The redundant indexes are gone and their unique partners remain.
  select count(*) into v_dupes from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'i' and c.relname in (
    'idx_deployment_stages_de','idx_billing_config_tenant','idx_cost_tracking_tenant_month',
    'idx_tenant_toggles_tenant','idx_usage_metrics_tenant_month');
  if v_dupes > 0 then raise exception '% redundant index(es) survived', v_dupes; end if;

  select count(*) into v_dupes from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'i' and c.relname in (
    'de_deployment_stages_de_id_key','tenant_billing_config_tenant_id_key',
    'tenant_cost_tracking_tenant_id_billing_month_key','tenant_feature_toggles_tenant_id_key',
    'tenant_usage_metrics_tenant_id_month_year_key');
  if v_dupes <> 5 then raise exception 'a UNIQUE partner index went missing (% of 5 left)', v_dupes; end if;

  -- A second assistant must now be refused, not merely avoided.
  if v_tid is not null then
    begin
      insert into digital_employees (tenant_id, name, status, is_workforce_assistant)
      values (v_tid, '__probe_second_assistant__', 'idle', true);
      raise exception 'a SECOND workforce assistant was accepted';
    exception when unique_violation then
      null;  -- correct
    end;
  end if;

  -- The tool list now names the definition, so an ambiguous key is resolvable.
  select id into v_de from digital_employees
  where tenant_id = v_tid and status = 'active' limit 1;
  if v_de is not null then
    v_tools := get_agentic_tools_for_de(v_tid, v_de);
    select count(*) into v_with
    from jsonb_array_elements(coalesce(v_tools, '[]'::jsonb)) t
    where t->'input_schema' is not null and t ? 'action_definition_id';
    -- Not every DE has connector tools; only assert when it has any at all.
    if jsonb_array_length(coalesce(v_tools, '[]'::jsonb)) > 0 and v_with = 0 then
      raise exception 'the tool list returned % tool(s) and none carried action_definition_id',
        jsonb_array_length(v_tools);
    end if;
    raise notice 'tool list: % tool(s), % carrying action_definition_id',
      jsonb_array_length(coalesce(v_tools, '[]'::jsonb)), v_with;
  end if;

  raise notice 'redundant indexes dropped, one-assistant-per-tenant enforced, tools name their definition';
end;
$verify$;

commit;
