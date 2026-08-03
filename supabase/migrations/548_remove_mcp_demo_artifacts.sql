-- 548: remove the MCP demo-server test artifacts from outsourcetel-hq.
--
-- WHAT THESE WERE
-- Migration 541 made MCP a governed connector. Proving it end to end (M1/M2)
-- meant standing up a real MCP server (`mcp-demo-server`), connecting it, and
-- driving three tools through the gate: echo (safe), delete_widget (annotated
-- destructive) and poke (deliberately UN-annotated, to exercise the fail-safe
-- default). The gate did its job — all four calls stopped at a human approval
-- and NONE ever executed. The proof is in git and docs/mcp-governed-connector-design.md.
--
-- What is left behind is four pending approvals for a fake "widget" service
-- sitting in the founder's real queue, plus a connector pointing at a demo
-- endpoint. That is clutter in a production tenant, so it goes.
--
-- WHY DELETE RATHER THAN REJECT
-- `guard_human_task_decision` (mig 487) blocks deleting an undecided approval
-- and suggests cancelling with a reason. That guard is right, and this
-- migration is the sanctioned form of it — reviewed, committed, ledgered and
-- audited, rather than an ad-hoc DELETE. But the approvals are DELETED, not
-- marked rejected, for two reasons:
--   1. A rejection asserts that a human reviewed a real request and declined
--      it. No human did, and none of these was real work.
--   2. Rejections with reason codes are TRAINING SIGNAL — they feed the
--      improvement loop. Recording four fake rejections would teach the
--      workforce from events that never happened.
-- Deleting an artifact and logging that deletion is the honest record.
--
-- SCOPE: this removes DEMO DATA ONLY. The MCP capability — the `mcp` provider,
-- the mcp-client function, mcp_server_allowlist, the allowlist screen and every
-- platform-scope definition — is product and is untouched. Asserted below.
begin;

do $$
declare
  v_tenant    uuid := '5bb802e1-8e92-4eef-9a7a-ac348785d43f';
  v_connector uuid := '18d6f8ec-572f-41f6-9183-4afc33c55504';
  v_tasks     uuid[];
  v_execs     uuid[];
  v_defs      uuid[];
  v_titles    text[];
  b_tasks     int;
  b_conns     int;
  b_defs      int;
  b_execs     int;
  b_platform  int;
  b_erp       int;
  b_invoices  int;
  d           int;
begin
  -- Idempotent: if the demo connector is already gone, there is nothing to do.
  if not exists (select 1 from connectors where id = v_connector and provider = 'mcp') then
    raise notice '548: demo connector already absent — nothing to remove';
    return;
  end if;

  -- Resolve the target set FROM the connector rather than hardcoding ids, so
  -- this cannot delete a row that does not belong to the demo.
  select array_agg(id) into v_defs
    from action_definitions
   where tenant_id = v_tenant
     and scope = 'tenant'
     and provider = 'mcp'
     and execution->>'connector_id' = v_connector::text;

  select array_agg(id) into v_execs
    from action_executions
   where connector_id = v_connector;

  select array_agg(h.id), array_agg(h.title) into v_tasks, v_titles
    from human_tasks h
   where h.related_table = 'action_executions'
     and h.related_id = any(coalesce(v_execs, '{}'::uuid[]));

  select count(*) into b_tasks    from human_tasks       where tenant_id = v_tenant;
  select count(*) into b_conns    from connectors        where tenant_id = v_tenant;
  select count(*) into b_defs     from action_definitions where tenant_id = v_tenant;
  select count(*) into b_execs    from action_executions where tenant_id = v_tenant;
  select count(*) into b_platform from action_definitions where scope <> 'tenant';
  select count(*) into b_erp      from action_executions where connector_id = '7f595bec-2f73-44d2-8f89-20961ad11e0e';
  select count(*) into b_invoices from renewal_invoices  where tenant_id = v_tenant;

  -- Nothing may have executed. If a demo call somehow ran against the outside
  -- world, that is a real event and this migration must not erase its record.
  if exists (select 1 from action_executions
              where connector_id = v_connector
                and decision not in ('human_gated_destructive', 'human_gated_trust')) then
    raise exception '548: an MCP demo execution was not human-gated — refusing to delete a real action record';
  end if;

  -- Record the removal BEFORE it happens, so the audit trail survives it.
  -- `_internal` is the system-side sink (mig 475): append_audit_event demands
  -- a JWT member or service_role and would raise under a migration's identity.
  -- Never a raw INSERT — audit_events is a tamper-evident hash chain, and a
  -- hand-written row would break verify_audit_chain. The founder will see four
  -- approvals disappear from their queue; this is the entry that explains why.
  perform append_audit_event_internal(
    v_tenant, 'System cleanup (migration 548)', 'system',
    format('Removed %s MCP demo-server test approvals and their connector', coalesce(array_length(v_tasks, 1), 0)),
    -- 'config_change' is constraint-legal (audit_events_category_check) and
    -- accurate: this is an administrative removal, not a sync or an execution.
    -- The category is NOT normalised, so an invented one raises (mig 429).
    'config_change',
    jsonb_build_object(
      'kind', 'test_artifact_removal', 'connector_id', v_connector,
      'reason', 'M1/M2 governed-MCP proof artifacts; never executed; not real work',
      'human_task_ids', to_jsonb(coalesce(v_tasks, '{}'::uuid[])),
      'human_task_titles', to_jsonb(coalesce(v_titles, '{}'::text[])),
      'action_execution_ids', to_jsonb(coalesce(v_execs, '{}'::uuid[])),
      'action_definition_ids', to_jsonb(coalesce(v_defs, '{}'::uuid[]))));

  -- The sanctioned bypass (mig 487). Transaction-local: `true` scopes it to
  -- this transaction, so it cannot leak into anything else.
  perform set_config('app.allow_task_decision', 'on', true);

  delete from human_tasks       where id = any(coalesce(v_tasks, '{}'::uuid[]));
  delete from action_definitions where id = any(coalesce(v_defs, '{}'::uuid[]));
  delete from connectors        where id = v_connector;

  -- Exact deltas. Removing MORE than intended is the real risk in a cleanup.
  d := b_tasks - (select count(*) from human_tasks where tenant_id = v_tenant);
  if d <> coalesce(array_length(v_tasks, 1), 0) then
    raise exception '548: human_tasks delta % (expected %)', d, coalesce(array_length(v_tasks, 1), 0); end if;

  d := b_conns - (select count(*) from connectors where tenant_id = v_tenant);
  if d <> 1 then raise exception '548: connectors delta % (expected 1)', d; end if;

  d := b_defs - (select count(*) from action_definitions where tenant_id = v_tenant);
  if d <> coalesce(array_length(v_defs, 1), 0) then
    raise exception '548: action_definitions delta % (expected %)', d, coalesce(array_length(v_defs, 1), 0); end if;

  d := b_execs - (select count(*) from action_executions where tenant_id = v_tenant);
  if d <> coalesce(array_length(v_execs, 1), 0) then
    raise exception '548: action_executions delta % (expected %)', d, coalesce(array_length(v_execs, 1), 0); end if;

  -- The ERPNext connector shares this tenant and must be untouched.
  if not exists (select 1 from connectors where id = '7f595bec-2f73-44d2-8f89-20961ad11e0e')
    then raise exception '548: the ERPNext connector was removed'; end if;
  if (select count(*) from action_executions where connector_id = '7f595bec-2f73-44d2-8f89-20961ad11e0e') <> b_erp
    then raise exception '548: the ERPNext action ledger changed'; end if;
  if (select count(*) from renewal_invoices where tenant_id = v_tenant) <> b_invoices
    then raise exception '548: renewal_invoices changed'; end if;

  -- The MCP capability must survive the removal of its demo.
  if (select count(*) from action_definitions where scope <> 'tenant') <> b_platform
    then raise exception '548: platform-scope action_definitions changed'; end if;
  if not exists (select 1 from pg_constraint where conname = 'connectors_provider_check'
                   and pg_get_constraintdef(oid) like '%mcp%')
    then raise exception '548: the mcp provider is no longer allowed'; end if;
  if to_regclass('public.mcp_server_allowlist') is null
    then raise exception '548: mcp_server_allowlist is gone'; end if;

  -- And nothing demo-shaped may remain.
  if exists (select 1 from action_definitions where execution->>'connector_id' = v_connector::text)
    then raise exception '548: a demo action_definition survived'; end if;
  if exists (select 1 from human_tasks where title ilike '%demo server%' and status = 'pending')
    then raise exception '548: a demo-server approval is still pending'; end if;

  raise notice '548: removed % approvals, % executions, % definitions, 1 connector; ERPNext and MCP capability intact',
    coalesce(array_length(v_tasks, 1), 0), coalesce(array_length(v_execs, 1), 0), coalesce(array_length(v_defs, 1), 0);
end $$;

commit;
