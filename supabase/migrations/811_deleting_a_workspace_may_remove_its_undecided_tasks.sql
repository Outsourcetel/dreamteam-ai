-- 811_deleting_a_workspace_may_remove_its_undecided_tasks.sql
-- ============================================================================
-- Reported by the founder, who tried to delete a tenant and got:
--
--   human_tasks: an undecided approval cannot be deleted
--   (task 38550a47-3abe-444d-afa0-ac3c8aa3bf2e).
--   Decide it first — cancelling with a reason is a decision.
--
-- That guard (mig 486, guard_human_task_decision) is right, and it is right
-- for the reason it says: nobody should quietly DELETE an approval instead of
-- deciding it, because the decision is the record. But it fires on the row,
-- not on the intent, and it cannot tell "somebody is disposing of an
-- inconvenient approval" from "this entire workspace is being destroyed".
--
-- In the second case there is no decision left to preserve. The tenant, its
-- employees, its conversations and the approval's own subject are all going.
-- Refusing here does not protect a decision; it makes the workspace
-- undeletable, and the only ways out are to hand-decide every pending task in
-- a workspace nobody wants, or to delete the rows around the guard.
--
-- ── The fix is one line, in a list that already exists ──────────────────────
-- delete_tenant step 3 already sanctions three guarded purges for the duration
-- of its own transaction, with the reasoning written next to them:
--
--   PERFORM set_config('app.allow_audit_purge',      'on', true);
--   PERFORM set_config('app.allow_compliance_change','on', true);
--   PERFORM set_config('app.allow_tenant_purge',     'on', true);
--
-- app.allow_task_decision — the flag guard_human_task_decision reads, and the
-- one decide_human_task sets — was simply never added. This adds it.
--
-- ── Why this does not weaken the guard ──────────────────────────────────────
-- set_config(..., true) is TRANSACTION-LOCAL, so every other statement in the
-- database still meets the guard unchanged. And it is set at step 3, which is
-- only reached after all of delete_tenant's rails have passed:
--
--   · auth.uid() is not null
--   · resolve_platform_capability(uid, 'tenants.manage')
--   · the tenant is not the demo tenant
--   · it is NOT the caller's own tenant
--   · its status is already 'suspended'
--   · p_confirm_slug matches the tenant slug EXACTLY
--   · it has no child tenants
--
-- A caller who has cleared all seven has not stumbled into deleting an
-- approval by accident. Everyone else meets exactly the guard they met before.
--
-- The body below is delete_tenant AS IT IS LIVE with that single line added,
-- and nothing else changed.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.delete_tenant(p_tenant_id uuid, p_confirm_slug text)
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
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF NOT resolve_platform_capability(auth.uid(), 'tenants.manage') THEN
    RAISE EXCEPTION 'only a platform team member with tenant-management access may delete a tenant';
  END IF;

  SELECT * INTO v_t FROM tenants WHERE id = p_tenant_id;
  IF NOT found THEN
    RAISE EXCEPTION 'tenant not found';
  END IF;

  IF p_tenant_id = v_demo_tenant_id THEN
    RAISE EXCEPTION 'the demo tenant cannot be deleted';
  END IF;

  SELECT tenant_id INTO v_self FROM profiles WHERE user_id = auth.uid();
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
  SELECT full_name INTO v_actor FROM profiles WHERE user_id = auth.uid();

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
    p_tenant_id, v_t.slug, v_t.name, auth.uid(), coalesce(v_actor, 'platform operator'),
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

-- ── Proof ───────────────────────────────────────────────────────────────────
-- Schema assertions only, so this migration replays into an empty environment
-- (CLAUDE.md rule 3). The behavioural proof — an actual tenant delete with a
-- pending task — is in the commit message, driven in a rolled-back transaction
-- against real data, because doing it here would need rows this migration
-- cannot assume exist.
do $$
declare v_def text;
begin
  select pg_get_functiondef(oid) into v_def
    from pg_proc where oid = 'public.delete_tenant(uuid, text)'::regprocedure;

  if v_def !~ 'allow_task_decision' then
    raise exception '811: delete_tenant does not sanction app.allow_task_decision — a workspace with any pending approval is undeletable.';
  end if;

  -- The rails must still be there. A future edit that keeps the sanction and
  -- drops a rail would turn this migration from a fix into a hole.
  if v_def !~ 'tenants.manage' or v_def !~ 'suspend' or v_def !~ 'p_confirm_slug' then
    raise exception '811: delete_tenant lost one of the rails that make sanctioning safe (capability / suspended / slug confirmation).';
  end if;

  -- And the guard itself must still refuse everyone else.
  select pg_get_functiondef(oid) into v_def
    from pg_proc where oid = 'public.guard_human_task_decision()'::regprocedure;
  if v_def !~ 'cannot be deleted' then
    raise exception '811: guard_human_task_decision no longer refuses deletion of an undecided approval — this migration narrows that guard, it does not remove it.';
  end if;
end $$;
