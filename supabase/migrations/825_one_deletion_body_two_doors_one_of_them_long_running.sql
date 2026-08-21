-- 825_one_deletion_body_two_doors_one_of_them_long_running.sql
-- ============================================================================
-- Deleting a large workspace from the Platform Console is impossible, and the
-- reason is a role setting rather than anything in the code:
--
--   `authenticated` runs with statement_timeout = 8s (Supabase's default).
--   acme-telecom is 47,763 rows and takes 22-30s to sweep, consistently.
--   Result: "canceling statement due to statement timeout", every time.
--
-- Twelve smaller workspaces (78-804 rows) deleted cleanly on 2026-08-20, so the
-- ceiling stayed invisible until the first workspace with real volume met it.
--
-- WARNING: THE OBVIOUS FIX DOES NOT WORK, and it was written and thrown away
-- before this one. Raising statement_timeout INSIDE delete_tenant cannot help:
-- the budget is armed when the statement starts, so a function cannot extend
-- the statement already running it. Proven, not assumed — the "fixed" function
-- was created inside a transaction, called with an 8s budget armed by a PRIOR
-- statement, and timed out identically to the unfixed one.
--
-- (Two earlier probes appeared to prove the opposite. They set the timeout
-- inside a DO block, which is itself one statement, so the 8s never applied to
-- anything at all. A measurement that cannot fail measures nothing.)
--
-- The shape that does work
-- ------------------------
-- service_role has no statement_timeout override, so it inherits the database
-- default of 2min — four times what this needs. An edge function running as
-- service_role can therefore finish the sweep, PROVIDED the deletion is still
-- attributed to the human who asked for it.
--
-- That is the whole design problem. delete_tenant reads auth.uid() in five
-- places, including the one that stamps tenant_deletion_receipts.deleted_by —
-- and a receipt naming the wrong person is worse than a slow delete.
--
-- So: ONE BODY, TWO DOORS.
--
--   delete_tenant_internal(tenant, slug, ACTOR)  the whole body, actor passed
--   delete_tenant(tenant, slug)                  console door, actor = auth.uid()
--   delete_tenant_as(tenant, slug, actor)        service_role door, actor = the
--                                                caller the edge function has
--                                                already VERIFIED
--
-- Not two copies of the body. This repo has paid for two-paths-one-counted
-- twice in one day (de-answer vs widget-ask on delivery=blocked; sync-dev vs
-- dev-apply), and a duplicated 250-line deletion routine is the worst possible
-- candidate for it.
--
-- Why delete_tenant_as is not a hole
-- ----------------------------------
-- It refuses anyone but service_role, and — the part that matters — the ACTOR
-- it is handed still has to hold tenants.manage on their own account. The
-- capability check inside the body now reads p_actor, so naming a user who
-- lacks it fails exactly as it would through the console. The edge function
-- cannot invent an authorised person; it can only pass one along.
--
-- What service_role CAN do is name a different authorised admin than the one
-- who actually clicked. That trust is irreducible — it is what service_role
-- means — which is precisely why the edge function must verify the caller's JWT
-- before calling this, and why it is the only caller.
-- ============================================================================

begin;

CREATE OR REPLACE FUNCTION public.delete_tenant_internal(p_tenant_id uuid, p_confirm_slug text, p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_demo_tenant_id constant uuid := 'a0000000-0000-0000-0000-000000000001';
  v_t tenants;
  v_self uuid;
  v_children int;
  v_actor text;
  v_before jsonb;
  v_rows_before bigint;
  v_tables int;
  v_after jsonb;
  v_rows_after bigint;
  v_profiles int := 0;
  -- Captured before the cascade blanks profiles.tenant_id (SET NULL) — see step 5.
  v_members uuid[] := '{}';
  v_receipt uuid;
BEGIN
  -- ── rails (verbatim from migration 194) ──────────────────────────────────
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF NOT resolve_platform_capability(p_actor, 'tenants.manage') THEN
    RAISE EXCEPTION 'only a platform team member with tenant-management access may delete a tenant';
  END IF;

  SELECT * INTO v_t FROM tenants WHERE id = p_tenant_id;
  IF NOT found THEN
    RAISE EXCEPTION 'tenant not found';
  END IF;

  IF p_tenant_id = v_demo_tenant_id THEN
    RAISE EXCEPTION 'the demo tenant cannot be deleted';
  END IF;

  SELECT tenant_id INTO v_self FROM profiles WHERE user_id = p_actor;
  IF v_self IS NOT DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'you cannot delete the tenant you belong to';
  END IF;

  IF v_t.status <> 'suspended' THEN
    RAISE EXCEPTION 'suspend the tenant before deleting it — deletion is permanent and irreversible';
  END IF;

  IF coalesce(p_confirm_slug, '') <> v_t.slug THEN
    RAISE EXCEPTION 'confirmation text must exactly match the tenant slug (%)', v_t.slug;
  END IF;

  SELECT count(*) INTO v_children FROM tenants WHERE parent_tenant_id = p_tenant_id;
  IF v_children > 0 THEN
    RAISE EXCEPTION 'this tenant still has % sub-tenant(s) — delete or reassign them first', v_children;
  END IF;

  -- ── step 1: who is doing this, captured before anything is removed ───────
  SELECT full_name INTO v_actor FROM profiles WHERE user_id = p_actor;

  -- ── step 2: pre-sweep — what is about to be destroyed ────────────────────
  -- Counted before, not after, because "rows removed" on a receipt has to be
  -- a measurement, not an inference from a post-delete count of zero.
  SELECT coalesce(jsonb_object_agg(table_name, remaining_rows)
                    FILTER (WHERE remaining_rows > 0 AND counts_as_residue), '{}'::jsonb),
         -- sum(bigint) returns numeric; cast so the receipt column and the
         -- comparison below are unambiguously integral.
         coalesce(sum(remaining_rows) FILTER (WHERE counts_as_residue), 0)::bigint,
         count(*)::int
    INTO v_before, v_rows_before, v_tables
    FROM tenant_rows_remaining(p_tenant_id);

  -- ── step 3: sanction the guarded purges, for THIS transaction only ───────
  -- set_config(..., true) is transaction-local, so the append-only posture is
  -- intact for every other statement in the database.
  PERFORM set_config('app.allow_audit_purge', 'on', true);       -- audit_events (mig 194)
  PERFORM set_config('app.allow_compliance_change', 'on', true); -- guardrail_rules w/ compliance_pack_key
  PERFORM set_config('app.allow_tenant_purge', 'on', true);      -- guardrail_adjudications (§2)
  PERFORM set_config('app.allow_task_decision', 'on', true);     -- human_tasks (mig 486) — see 811

  -- ── step 4: the NO ACTION children the cascade will not take ─────────────
  DELETE FROM tenant_provisioning_requests
    WHERE proposed_parent_tenant_id = p_tenant_id OR created_tenant_id = p_tenant_id;
  DELETE FROM platform_access_events WHERE tenant_id = p_tenant_id;

  -- ── step 5: REMEMBER the members — do not delete them yet ────────────────
  -- ⚠ ORDERING IS LOAD-BEARING. An earlier version deleted profiles HERE,
  -- before the cascade, and that makes a workspace permanently undeletable the
  -- moment anyone uses it properly. Eleven FKs point at profiles with
  -- ON DELETE NO ACTION, and five of those sit on TENANT-scoped tables:
  --   tenant_api_keys.created_by            tenant_feature_overrides.set_by
  --   tenant_ip_allowlist_entries.created_by  tenant_ip_allowlists.updated_by
  --   tenant_session_policies.updated_by
  -- Those rows still exist at this point; only step 6 removes them. So the
  -- profile delete raised, and the whole transaction rolled back, for any
  -- tenant whose admin had ever created an API key or an IP allowlist entry.
  -- It does not fire on today's data purely by luck: all 8 existing
  -- tenant_feature_overrides rows were set by a PLATFORM profile, which the
  -- layer filter below excludes. The first tenant admin to use the Security
  -- page would have locked their own workspace into existence forever.
  --
  -- tenant_id is captured into an array because step 6's cascade is what
  -- BLANKS it (the FK is ON DELETE SET NULL) — after the cascade there is no
  -- longer any way to ask "who belonged to this tenant?".
  SELECT coalesce(array_agg(user_id), '{}')
    INTO v_members
    FROM profiles
   WHERE tenant_id = p_tenant_id AND layer IS DISTINCT FROM 'platform';

  -- ── step 6: the cascade ──────────────────────────────────────────────────
  DELETE FROM tenants WHERE id = p_tenant_id;

  -- ── step 6b: NOW the profiles ────────────────────────────────────────────
  -- SET NULL would otherwise blank tenant_id and leave full_name sitting in the
  -- table while a residue check keyed on tenant_id reported zero — the exact
  -- laundering described in (C) at the top of this file.
  -- `layer IS DISTINCT FROM 'platform'` was applied when the members were
  -- captured, so a platform operator can never be removed by a tenant deletion
  -- even if someone later attaches one to a tenant.
  BEGIN
    DELETE FROM profiles WHERE user_id = ANY(v_members);
    GET DIAGNOSTICS v_profiles = ROW_COUNT;
  EXCEPTION WHEN foreign_key_violation THEN
    -- Name the actual relation from sqlerrm rather than guessing: after the
    -- cascade, anything still referencing a member is PLATFORM-side, and the
    -- operator needs to know which one.
    RAISE EXCEPTION 'cannot delete tenant "%": a platform-side record still references one of its members after the cascade. Reassign or remove it first. [%]', v_t.slug, sqlerrm;
  END;

  -- ── step 7: sweep the two tables the cascade REFILLED ────────────────────
  -- Not a belt-and-braces duplicate of the cascade: these rows did not exist
  -- when step 6 began. log_remote_access_write() fires AFTER DELETE on 77
  -- tenant tables and, because the caller is platform staff with no tenant of
  -- their own, writes old_data = to_jsonb(OLD) for every row the cascade just
  -- removed. This is where the 153 orphan rows measured in production came
  -- from. Must run after step 6, and these two tables have no DELETE trigger
  -- of their own, so this does not recurse.
  DELETE FROM remote_access_write_log WHERE tenant_id = p_tenant_id;
  DELETE FROM tenant_activity_log     WHERE tenant_id = p_tenant_id;

  -- ── step 8: verify, or undo everything ───────────────────────────────────
  SELECT coalesce(jsonb_object_agg(table_name, remaining_rows)
                    FILTER (WHERE remaining_rows > 0 AND counts_as_residue), '{}'::jsonb),
         coalesce(sum(remaining_rows) FILTER (WHERE counts_as_residue), 0)::bigint
    INTO v_after, v_rows_after
    FROM tenant_rows_remaining(p_tenant_id);

  -- profiles cannot be checked by the tenant_id-keyed sweep above, because the
  -- cascade SET NULL blanks tenant_id — a surviving member reads as zero residue
  -- while still holding their full_name. That is exactly the laundering
  -- described in (C) at the top of this file, so it gets its own check keyed on
  -- the identities captured in step 5.
  IF EXISTS (SELECT 1 FROM profiles WHERE user_id = ANY(v_members)) THEN
    RAISE EXCEPTION 'deletion of "%" is INCOMPLETE — % of % member profile(s) survived. Nothing was deleted; the transaction has been rolled back.',
      v_t.slug,
      (SELECT count(*) FROM profiles WHERE user_id = ANY(v_members)),
      coalesce(array_length(v_members, 1), 0);
  END IF;

  IF v_rows_after > 0 THEN
    -- All-or-nothing on purpose. A partial deletion that returned ok:true is
    -- the exact failure this migration exists to remove, and rolling back
    -- leaves a suspended tenant that can be retried once the gap is fixed.
    RAISE EXCEPTION 'deletion of "%" is INCOMPLETE — % row(s) survived in %. Nothing was deleted; the transaction has been rolled back. Add coverage for those tables and retry.',
      v_t.slug, v_rows_after, v_after;
  END IF;

  -- ── step 9: the receipt (inserted after the sweep, so it is never counted)─
  INSERT INTO tenant_deletion_receipts (
    tenant_id, tenant_slug, tenant_name, deleted_by, deleted_by_name,
    tables_swept, rows_removed, per_table_removed, residual_after, verified, notes)
  VALUES (
    p_tenant_id, v_t.slug, v_t.name, p_actor, coalesce(v_actor, 'platform operator'),
    v_tables, v_rows_before, v_before, '{}'::jsonb, true,
    'Verified by tenant_rows_remaining() after deletion: 0 residual rows across '
      || v_tables || ' tenant-scoped tables. NOT covered by this receipt: auth.users '
      || 'login rows (auth schema, outside this database''s public FK graph), Supabase '
      || 'Storage objects, and any off-database backups, logs or third-party systems.')
  RETURNING id INTO v_receipt;

  RETURN jsonb_build_object(
    'ok', true,
    'deleted_tenant', p_tenant_id,
    'name', v_t.name,
    'slug', v_t.slug,
    'receipt_id', v_receipt,
    'tables_swept', v_tables,
    'rows_removed', v_rows_before,
    'profiles_removed', v_profiles,
    'residual_rows', 0,
    'not_covered', jsonb_build_array(
      'auth.users login rows (auth schema)',
      'Supabase Storage objects',
      'off-database backups, logs and third-party systems')
  );
END $function$
;

comment on function public.delete_tenant_internal(uuid, text, uuid) is
  'The whole tenant-deletion body, with the acting user passed in rather than '
  'read from auth.uid(). Not called directly: use delete_tenant (console) or '
  'delete_tenant_as (service_role, via the platform edge function). See mig 825.';

-- Door 1: the console. Unchanged from every caller's point of view.
create or replace function public.delete_tenant(p_tenant_id uuid, p_confirm_slug text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  -- The same refusal this function has always given, kept here so an
  -- unauthenticated caller never reaches the body at all.
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  return public.delete_tenant_internal(p_tenant_id, p_confirm_slug, auth.uid());
end;
$fn$;

-- Door 2: service_role, for the edge function that actually has a budget.
create or replace function public.delete_tenant_as(p_tenant_id uuid, p_confirm_slug text, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  -- Only service_role. A signed-in user reaching this would be choosing their
  -- own actor, which is the one thing this door must never allow.
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'delete_tenant_as is for the platform edge function only — use delete_tenant';
  end if;
  if p_actor is null then
    raise exception 'p_actor is required: a deletion with no named actor must not be possible';
  end if;
  -- The body re-checks tenants.manage against p_actor anyway, so an
  -- unauthorised actor still fails. This is here so the refusal names why.
  if not resolve_platform_capability(p_actor, 'tenants.manage') then
    raise exception 'the named actor does not hold tenants.manage — service_role cannot manufacture authority';
  end if;
  return public.delete_tenant_internal(p_tenant_id, p_confirm_slug, p_actor);
end;
$fn$;

revoke all on function public.delete_tenant_internal(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.delete_tenant_as(uuid, text, uuid)       from public, anon, authenticated;
grant execute on function public.delete_tenant_as(uuid, text, uuid)    to service_role;

-- Proof
do $$
declare v_int text; v_console text; v_as text; v_grantees text;
begin
  select pg_get_functiondef(oid) into v_int
    from pg_proc where oid = 'public.delete_tenant_internal(uuid, text, uuid)'::regprocedure;
  select pg_get_functiondef(oid) into v_console
    from pg_proc where oid = 'public.delete_tenant(uuid, text)'::regprocedure;
  select pg_get_functiondef(oid) into v_as
    from pg_proc where oid = 'public.delete_tenant_as(uuid, text, uuid)'::regprocedure;

  -- A. ONE body. The console door must delegate, not carry a copy — a second
  --    copy is how the two drift and only one of them gets the next fix.
  if v_console ~* 'tenant_deletion_receipts' then
    raise exception '825: delete_tenant carries its own deletion body — there must be exactly one';
  end if;
  if v_console !~* 'delete_tenant_internal' then
    raise exception '825: delete_tenant does not delegate to the shared body';
  end if;

  -- B. The body must no longer read the session identity, or the actor
  --    parameter is decorative and door 2 quietly deletes as nobody.
  if v_int ~* 'auth[.]uid[(][)]' then
    raise exception '825: delete_tenant_internal still reads auth.uid() — the passed actor is not what it uses';
  end if;

  -- C. Door 2 must refuse non-service_role AND re-check the actor capability.
  if v_as !~* 'service_role' or v_as !~* 'tenants.manage' then
    raise exception '825: delete_tenant_as is missing the service_role gate or the actor capability check';
  end if;

  -- D. Neither new function may be reachable by a browser role.
  select coalesce(string_agg(distinct grantee, ','), '(none)') into v_grantees
    from information_schema.role_routine_grants
   where specific_schema = 'public'
     and routine_name in ('delete_tenant_internal', 'delete_tenant_as')
     and grantee in ('anon', 'authenticated', 'PUBLIC');
  if v_grantees <> '(none)' then
    raise exception '825: the service_role door is reachable by % — a signed-in user could name their own actor', v_grantees;
  end if;

  -- E. Migration 811's sanction must survive the refactor, or every workspace
  --    with a pending approval becomes undeletable again.
  if v_int !~* 'allow_task_decision' then
    raise exception '825: the shared body lost migration 811 allow_task_decision sanction';
  end if;
end $$;

commit;
