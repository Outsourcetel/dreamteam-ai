-- 720_a_promotion_that_cannot_silently_do_nothing.sql
-- ==========================================================================
-- WHY: `src/lib/workforceApi.ts` promoted a digital employee's deployment
-- stage with a direct PostgREST UPDATE on `de_deployment_stages`. That table
-- has RLS enabled and exactly ONE policy — "Tenant members can view DE
-- stages", SELECT. There is no PERMISSIVE UPDATE policy for `authenticated`
-- or `public`, so RLS matched zero rows and PostgREST returned SUCCESS WITH
-- NO ERROR. The client read `error === null` and reported the promotion had
-- happened. This is the trap this repo already recorded once as "RLS-denied
-- write = PostgREST SUCCESS, 0 rows" (project_role_gated_ui_audit), and
-- docs/52 §5 held the UPDATE grant back from the Tier B revoke precisely so
-- that closing it would not convert a silent lie into a bare 42501 without
-- someone owning the feature. This migration owns it.
--
-- HONEST SCOPE NOTE, because the framing matters. `promoteDeploymentStage`
-- has ZERO call sites: grepped repo-wide, the only references are its own
-- definition and docs/52. There is no promotion button in the product today.
-- The lie is therefore LATENT — a wired-and-loaded function that would report
-- a false success the first time anyone rendered a button for it — not a
-- defect users are hitting. Stated plainly so nobody reads this migration as
-- an incident report.
--
-- POLICY vs RPC — the call, and the evidence behind it.
--
-- What `stage` actually gates, enumerated rather than assumed:
--   · src/components/workforce/DETrainingPanel.tsx:60 — the human training
--     panel renders ONLY for 'shadow' | 'co-pilot'. Stage decides whether a
--     supervising human is offered the correction surface at all.
--   · supabase/functions/de-training-capture/index.ts:100-125 — reads stage +
--     stage_metrics to answer "should_promote_stage".
--   · get_de_performance_summary (migs 492/708) — reports `current_stage`.
--   · Written at provisioning only: auto_provision_new_tenant and
--     create_workforce_assistant_de insert 'live'.
-- What it does NOT gate: de_autonomy, trust_policies, decide_action_execution,
-- routing, guardrails, advance_de_lifecycle. So `stage` is NOT the enforced
-- authority axis — `digital_employees.lifecycle_status` is, and docs/23:119
-- names this mig-195 table a "dead parallel lifecycle".
--
-- A PERMISSIVE UPDATE policy was still rejected. `stage` is bare TEXT with no
-- CHECK; a policy would hand the browser an unvalidated, unattributed write
-- that can set any employee to any string, skip rungs, and leave no record of
-- who reduced supervision or why — strictly worse than today's no-op. It
-- would also keep the table grant, so the write perimeter could never close
-- to the keep-set. The repo already has one pattern for a governed change to
-- a digital employee's stage — advance_de_lifecycle: SECURITY DEFINER, tenant
-- derived from auth_tenant_id(), owner/admin only, transition validated, and
-- an audit event in the same statement. This is that pattern, applied to the
-- second axis.
--
-- WHO MAY PROMOTE: tenant_owner or tenant_admin, in the employee's own
-- workspace. Deliberately NARROWER than the SELECT policy, which also admits
-- tenant_manager — seeing which rung an employee is on is not the same
-- authority as moving it.
--
-- Production data at the time of writing: 12 rows, every one 'live', every
-- one a Workspace Assistant. The only transition reachable today is
-- live → retired, which makes a required reason the whole audit trail.
-- ==========================================================================

begin;

-- ── 1. The governed promotion ─────────────────────────────────────────────
-- Every refusal RAISES. None of them returns a shrug the caller could read as
-- success — that failure mode is the entire reason this file exists.
create or replace function public.promote_de_deployment_stage(p_de_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tenant     uuid;
  v_de_name    text;
  v_lifecycle  text;
  v_from       text;
  v_to         text;
  v_actor_name text;
  v_reason     text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  v_tenant := auth_tenant_id();
  if v_tenant is null then
    raise exception 'not a member of any workspace';
  end if;
  if not auth_has_tenant_role(array['tenant_owner', 'tenant_admin']) then
    raise exception 'only workspace owners/admins can promote a digital employee''s deployment stage';
  end if;

  -- Tenancy is DERIVED, never a parameter (security_cross_tenant_read_perimeter:
  -- a tenant-id argument on a SECURITY DEFINER function IS the authorisation).
  select de.name, de.lifecycle_status into v_de_name, v_lifecycle
    from digital_employees de
   where de.id = p_de_id and de.tenant_id = v_tenant;
  if v_de_name is null then
    raise exception 'employee not found in this workspace';
  end if;
  if v_lifecycle in ('retired', 'archived') then
    raise exception 'this employee is retired — its deployment stage is closed';
  end if;

  if v_reason is null then
    raise exception 'a promotion needs a reason — promotion_reason is the only record of who reduced supervision and why';
  end if;

  select s.stage into v_from
    from de_deployment_stages s
   where s.de_id = p_de_id
     for update;
  if v_from is null then
    raise exception 'this employee has no deployment stage to promote';
  end if;

  v_to := case v_from
    when 'shadow'   then 'co-pilot'
    when 'co-pilot' then 'live'
    when 'live'     then 'retired'
    else null
  end;
  if v_to is null then
    raise exception 'cannot promote from "%" — the ladder is shadow → co-pilot → live → retired, and "%" has no next rung', v_from, v_from;
  end if;

  select full_name into v_actor_name from profiles where user_id = auth.uid();

  update de_deployment_stages
     set stage             = v_to,
         stage_promoted_at = now(),
         promotion_reason  = v_reason,
         updated_at        = now()
   where de_id = p_de_id;

  -- The belt for the exact defect being fixed: never return ok on a write
  -- that moved nothing. Unreachable given the FOR UPDATE above — which is
  -- why it is cheap, and why it stays.
  if not found then
    raise exception 'promotion matched no row for employee % — refusing to report success', p_de_id;
  end if;

  perform append_audit_event_internal(
    v_tenant,
    coalesce(v_actor_name, 'A workspace admin'),
    'human',
    format('%s promoted from %s to %s — "%s"', v_de_name, v_from, v_to, left(v_reason, 160)),
    'config_change',
    jsonb_build_object('kind', 'de_deployment_stage_promotion',
                       'de_id', p_de_id, 'from', v_from, 'to', v_to)
  );

  return jsonb_build_object('ok', true, 'de_id', p_de_id,
                            'from', v_from, 'to', v_to, 'reason', v_reason);
end $$;

-- The default-EXECUTE hole (migs 610+630): revoke, then grant deliberately.
-- CREATE OR REPLACE preserves grants, so this must be stated every time.
revoke all on function public.promote_de_deployment_stage(uuid, text) from public, anon, authenticated;
grant execute on function public.promote_de_deployment_stage(uuid, text) to authenticated;

-- ── 2. Close the direct write, and prove both halves ──────────────────────
do $$
declare
  n_dml_before int;
  n_dml_after  int;
  n_sel_before int;
  n_sel_after  int;
begin
  select count(*) into n_dml_before from information_schema.role_table_grants g
   where g.table_schema = 'public' and g.grantee = 'authenticated'
     and g.privilege_type in ('INSERT', 'UPDATE', 'DELETE')
     and exists (select 1 from pg_class c
                  where c.relname = g.table_name
                    and c.relnamespace = 'public'::regnamespace and c.relkind = 'r');
  select count(*) into n_sel_before from information_schema.role_table_grants
   where table_schema = 'public' and grantee = 'authenticated' and privilege_type = 'SELECT';

  -- Named privilege, one table. NEVER `all` — docs/52 §7.2: `revoke all`
  -- would take SELECT with it and blank the stage the training panel reads.
  execute 'revoke update on table public.de_deployment_stages from authenticated';

  select count(*) into n_dml_after from information_schema.role_table_grants g
   where g.table_schema = 'public' and g.grantee = 'authenticated'
     and g.privilege_type in ('INSERT', 'UPDATE', 'DELETE')
     and exists (select 1 from pg_class c
                  where c.relname = g.table_name
                    and c.relnamespace = 'public'::regnamespace and c.relkind = 'r');
  select count(*) into n_sel_after from information_schema.role_table_grants
   where table_schema = 'public' and grantee = 'authenticated' and privilege_type = 'SELECT';

  -- A REVOKE reports nothing either way. Assert the resulting privileges.
  if has_table_privilege('authenticated', 'public.de_deployment_stages', 'UPDATE') then
    raise exception 'the direct UPDATE is still held by authenticated — the silent no-op survives';
  end if;

  -- BOTH HALVES. Over-revoking here is the mig-643 shape wearing the other
  -- mask: the panel that reads the stage would go blank instead.
  if not has_table_privilege('authenticated', 'public.de_deployment_stages', 'SELECT') then
    raise exception 'OVER-REVOKED: authenticated lost SELECT on de_deployment_stages — DETrainingPanel and getDeploymentStage read it';
  end if;
  if not has_table_privilege('service_role', 'public.de_deployment_stages', 'UPDATE')
     or not has_table_privilege('postgres', 'public.de_deployment_stages', 'UPDATE') then
    raise exception 'OVER-REVOKED: service_role/postgres lost UPDATE — provisioning and the RPC''s definer both need it';
  end if;
  if n_dml_after <> n_dml_before - 1 then
    raise exception 'expected exactly ONE grant to disappear; authenticated DML grants went % -> %', n_dml_before, n_dml_after;
  end if;
  if n_sel_after <> n_sel_before then
    raise exception 'OVER-REVOKED: authenticated SELECT count went % -> %', n_sel_before, n_sel_after;
  end if;

  -- The EXECUTE perimeter for the replacement (migs 610+630 doctrine).
  if not has_function_privilege('authenticated', 'public.promote_de_deployment_stage(uuid, text)', 'EXECUTE') then
    raise exception 'authenticated cannot EXECUTE the replacement — promotion would be impossible for everyone';
  end if;
  if has_function_privilege('anon', 'public.promote_de_deployment_stage(uuid, text)', 'EXECUTE')
     or has_function_privilege('public', 'public.promote_de_deployment_stage(uuid, text)', 'EXECUTE') then
    raise exception 'promote_de_deployment_stage is EXECUTE-granted to anon/public — the default-grant hole re-opened';
  end if;

  raise notice 'mig 720: de_deployment_stages UPDATE revoked from authenticated (DML surface % -> %, SELECT unchanged at %); promote_de_deployment_stage(uuid,text) EXECUTE = authenticated only.',
    n_dml_before, n_dml_after, n_sel_after;
end $$;

commit;
