-- 827_a_workspace_can_be_marked_too_precious_to_delete.sql
-- ============================================================================
-- The founder tried twice to delete `outsourcetel` — 0 users, 11 idle
-- employees, 425 rows — and both attempts were refused with
--
--   the demo tenant cannot be deleted
--
-- because that workspace holds the hardcoded id
-- a0000000-0000-0000-0000-000000000001. Meanwhile outsourcetel-hq — 3 users,
-- 160 conversations, the workspace everything real happens in — has no
-- protection at all. The guard is pointed at the workspace nobody wants.
--
-- ⚠ THE OBVIOUS FIX IS THE WRONG ONE, and it would have done real damage.
-- Repointing that constant at outsourcetel-hq looks like a one-line change and
-- is not, because the id does not mean "precious" — it means SANDBOX. It is
-- read by SEVENTEEN functions plus three app files, and among them:
--
--   guard_against_demo_tenant_assignment   a trigger that REFUSES writes
--                                          assigning anything to that tenant
--   complete_signup                        steers new signups away from it
--   expire_trials                          skips it
--   seed_trust_policies                    refuses to run for it
--
-- Point that at the live workspace and the live workspace starts rejecting
-- real writes. Protection that breaks the thing it protects.
--
-- ── So: a separate flag that says one thing ────────────────────────────────
-- tenants.deletion_protected. Not "is this the demo", not "is this special" —
-- just "do not destroy this". One meaning, one reader, nothing else changes
-- behaviour on it.
--
-- Suspension is deliberately NOT gated. It is reversible, delete_tenant
-- already requires it first, and the irreversible step is the one worth
-- guarding. A flag that blocked suspension too would make the protected
-- workspace harder to operate, not safer.
--
-- ── Why a column and not another constant ──────────────────────────────────
-- The demo-tenant id is a uuid literal in seventeen places, which is why
-- moving it is a fortnight's archaeology rather than an edit. A column is
-- data: it moves with an UPDATE, it is visible to anyone reading the table,
-- and it cannot drift between seventeen copies because there is only one.
--
-- Default false, so every existing workspace is unaffected and deletion keeps
-- working exactly as it did — including for `outsourcetel`, once its OTHER
-- protection is dealt with, which is a separate decision this migration does
-- not take.
-- ============================================================================

begin;

alter table public.tenants
  add column if not exists deletion_protected boolean not null default false;

comment on column public.tenants.deletion_protected is
  'Refuses delete_tenant for this workspace. Distinct from the demo-tenant id '
  '(a0000000-...-0001), which marks a SANDBOX and is read by seventeen '
  'functions that refuse writes, skip trials and steer signups away — pointing '
  'that at a live workspace would break it. This flag means only: do not '
  'destroy this. Suspension is unaffected. See migration 827.';

-- The workspace everything real happens in.
update public.tenants
   set deletion_protected = true, updated_at = now()
 where slug = 'outsourcetel-hq';

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

  -- ── the precious rail (mig 827) ──────────────────────────────────────────
  -- Distinct from the demo-tenant check below it, and deliberately so. That
  -- one marks a SANDBOX: guard_against_demo_tenant_assignment refuses writes
  -- into it, complete_signup steers away from it, expire_trials skips it, and
  -- fourteen other functions read the same constant. Pointing THAT id at a
  -- live workspace in order to protect it would start refusing real writes to
  -- it — protection that breaks the thing it guards.
  --
  -- This flag says one thing only: do not destroy this workspace. Suspension
  -- is untouched, because suspension is reversible and delete_tenant already
  -- requires it first; the irreversible step is the one worth gating.
  IF coalesce(v_t.deletion_protected, false) THEN
    RAISE EXCEPTION 'tenant "%" is marked deletion-protected. If you really mean to delete it, clear tenants.deletion_protected first — that is a separate, deliberate act.', v_t.slug;
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

-- Proof. Absence-of-violation form (CLAUDE.md rule 3) wherever the assertion
-- touches data, so this replays into an environment holding no tenants.
do $$
declare v_def text; v_unprotected int;
begin
  select pg_get_functiondef(oid) into v_def
    from pg_proc where oid = 'public.delete_tenant_internal(uuid, text, uuid)'::regprocedure;

  -- A. The rail exists and reads the flag.
  if v_def !~ 'deletion_protected' then
    raise exception '827: delete_tenant_internal does not check deletion_protected — the column is decorative';
  end if;

  -- B. It must sit BEFORE the sweep, not after. A guard that fires once the
  --    rows are gone is not a guard.
  if position('deletion_protected' in v_def) > position('step 2: pre-sweep' in v_def) then
    raise exception '827: the deletion_protected rail runs after the sweep begins';
  end if;

  -- C. Migrations 811 and 825 must survive: this reproduces the whole body,
  --    and silently dropping either would restore a bug already paid for.
  if v_def !~ 'allow_task_decision' then
    raise exception '827: the body lost migration 811 allow_task_decision sanction';
  end if;
  if v_def ~ 'auth[.]uid[(][)]' then
    raise exception '827: the body reads auth.uid() again — migration 825 passes the actor in';
  end if;

  -- D. The flag must not have been applied to a workspace nobody named. This
  --    is phrased as "no protected tenant other than the intended one", so it
  --    is vacuously true where neither exists.
  select count(*) into v_unprotected
    from public.tenants
   where deletion_protected and slug <> 'outsourcetel-hq';
  if v_unprotected <> 0 then
    raise exception '827: % workspace(s) other than outsourcetel-hq are deletion-protected — this migration protects exactly one', v_unprotected;
  end if;
end $$;

commit;
