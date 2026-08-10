-- 664_a_guard_that_skips_is_not_a_guard.sql
-- ============================================================================
-- Four functions the R0.8 sieve could not see, because the sieve looked for the
-- ABSENCE of a guard helper and these either mention one without being
-- constrained by it, or were wrongly certified safe by hand.
--
-- ⚠ THREE OF THESE WERE ON MY OWN "READ AND CLEARED" LIST. The certify ratchet
-- introduced in 662 exempts 41 routines on the strength of that reading, and at
-- least two of them leak. An allowlist is a claim, not a fact. Both are removed
-- from the exemption in this change so the gate re-arms on them.
--
-- ── 1. submit_csat — REVOKED ─────────────────────────────────────────────
-- `update de_conversations set csat_score = … where id = p_conversation_id and
-- tenant_id = p_tenant_id` with both ids supplied by the caller: a cross-tenant
-- WRITE onto a metric that feeds employee performance reporting.
-- Safe to revoke, measured rather than assumed: 0 of 455 conversations carry a
-- csat_score — the path has never written a row — and anon does not hold
-- EXECUTE, so no end-user widget depends on it.
--
-- ── 2. platform_capability_remaining_holders — REVOKED ───────────────────
-- Discloses how many vendor-platform staff hold a named capability, to any
-- signed-in customer. Its SECURITY DEFINER callers run as postgres and keep it.
--
-- ── 3. get_workforce_trust_metrics — GUARDED ─────────────────────────────
-- `v_tenant := coalesce(p_tenant_id, auth_tenant_id())`. The coalesce is the
-- defect: pass a tenant and yours is never consulted. Returns another tenant's
-- entire governance posture — whether its guardrails have ever fired, whether
-- rollback has ever been used. Cannot be revoked: WorkforceTrustPanel calls it.
-- MEMBERSHIP ONLY, no role gate — ordinary members read that panel today and
-- narrowing it is a product decision, not a security fix.
--
-- ── 4. assign_human_task — the fail-open, and why it must stay loose ──────
-- Its guard reads `if auth_tenant_id() is not null and v_task.tenant_id <>
-- auth_tenant_id()`. When the tenant is null the check is SKIPPED, not failed.
-- 418 tasks across 14 workspaces sit behind it, and it reassigns owners.
--
-- ⚠ THE ESCAPE HATCH HERE MUST BE THE LOOSE ONE, and this is the one place
-- these two functions must differ — say so, or someone will "harmonise" them.
-- `trg_human_tasks_assign` fires on INSERT, and inserts arrive from migrations,
-- cron and psql where auth.role() is NULL. The strict form
-- (`coalesce(auth.role(),'') <> 'service_role'`) would refuse those and stop
-- auto-routing — silently, because the trigger swallows exceptions. So:
--   auth.role() is not null and auth.role() <> 'service_role'
--       and v_task.tenant_id IS DISTINCT FROM auth_tenant_id()
-- An authenticated caller always has a non-null role, so the comparison always
-- runs for them, and `is distinct from` makes a NULL tenant FAIL rather than skip.
--
-- ── INSPECTED AND DELIBERATELY LEFT ──────────────────────────────────────
-- * validate_watcher_config — ⚠ MUST NOT BE REVOKED, though it looks identical
--   to the two above. `trg_validate_work_watcher` on work_watchers calls
--   validate_work_watcher, which is SECURITY INVOKER and reaches this function,
--   so the admin doing the INSERT needs EXECUTE. Revoking breaks every watcher
--   create and edit (24 rows, 15 workspaces). It is read-only, STABLE, writes
--   nothing. A pg_depend sweep does NOT catch this: the dependency is one hop
--   deeper than a direct trigger reference.
-- * get_identity_inventory — its tenant guard is correct. Adding per-DE scoping
--   is a product decision about who may read a credential inventory.
-- * get_de_cost_metrics — shows per-employee spend for every employee in the
--   caller's OWN workspace rather than only those they are responsible for.
--   Intra-tenant over-sharing, not a tenancy breach, and narrowing it is a
--   visible behaviour change. Named, not bundled.
--
-- ── HOW THIS MIGRATION EDITS THE TWO BODIES ──────────────────────────────
-- By exact-anchor replacement, not by retyping. Both bodies are ~5,000
-- characters of plpgsql; transcribing them to change one line risks a silent
-- transcription error in a security fix. Each replacement asserts the anchor
-- occurs EXACTLY ONCE before, is GONE after, and that the surrounding body
-- survived — so a drifted body fails loudly instead of being overwritten.
-- ============================================================================

begin;

-- ── 1 + 2. The two revokes ───────────────────────────────────────────────
do $$
declare
  v_sigs text[] := array[
    'submit_csat(uuid, uuid, integer)',
    'platform_capability_remaining_holders(uuid, text)'
  ];
  v_sig text;
  v_oid oid;
begin
  foreach v_sig in array v_sigs loop
    execute format('grant execute on function public.%s to service_role', v_sig);
    execute format('revoke execute on function public.%s from public, anon, authenticated', v_sig);
  end loop;

  -- Assert the RESULT, never the statement (the lesson of mig 658).
  foreach v_sig in array v_sigs loop
    -- These signatures carry TYPES ONLY, so ::regprocedure resolves them (it
    -- rejects parameter names — which is why mig 662 had to resolve differently).
    v_oid := ('public.' || v_sig)::regprocedure;
    if has_function_privilege('authenticated', v_oid, 'EXECUTE') then
      raise exception '664: authenticated STILL holds EXECUTE on %', v_sig;
    end if;
    if has_function_privilege('anon', v_oid, 'EXECUTE') then
      raise exception '664: anon STILL holds EXECUTE on %', v_sig;
    end if;
    if not has_function_privilege('service_role', v_oid, 'EXECUTE') then
      raise exception '664: service_role LOST EXECUTE on % — the platform would break', v_sig;
    end if;
  end loop;
end $$;

-- ── 3. get_workforce_trust_metrics: prove membership of the chosen tenant ─
do $$
declare
  v_old text := 'if v_tenant is null then raise exception ''not_authenticated''; end if;';
  v_new text := 'if v_tenant is null then raise exception ''not_authenticated''; end if;'
             || E'\n'
             || E'  -- mig 664: v_tenant may have been CHOSEN by the caller via p_tenant_id.\n'
             || E'  -- Prove membership of it. Membership only, deliberately: ordinary members\n'
             || E'  -- read this panel today and a role gate would newly deny them.\n'
             || E'  if coalesce(auth.role(), '''') <> ''service_role'' and not (\n'
             || E'       is_platform_admin()\n'
             || E'       or exists (select 1 from profiles p\n'
             || E'                   where p.user_id = auth.uid() and p.tenant_id = v_tenant\n'
             || E'                     and coalesce(p.is_active, true))\n'
             || E'     ) then\n'
             || E'    raise exception ''not authorized to view this workspace''''s trust metrics'';\n'
             || E'  end if;';
  v_def text := pg_get_functiondef('public.get_workforce_trust_metrics(uuid, integer)'::regprocedure);
  v_hits int;
begin
  v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  if v_hits <> 1 then
    raise exception '664: expected the not_authenticated anchor exactly once in get_workforce_trust_metrics, found % — the body has drifted, do not overwrite it blind', v_hits;
  end if;
  if v_def ilike '%mig 664%' then
    raise exception '664: get_workforce_trust_metrics already carries this change';
  end if;

  execute replace(v_def, v_old, v_new);

  v_def := pg_get_functiondef('public.get_workforce_trust_metrics(uuid, integer)'::regprocedure);
  if v_def not ilike '%not authorized to view this workspace%' then
    raise exception '664: the membership guard did not land';
  end if;
  if v_def not ilike '%is_platform_admin%' then
    raise exception '664: platform staff would be locked out of every workspace';
  end if;
  -- A distinctive token from deep in the original body: proves we replaced a
  -- line rather than truncated the function.
  if v_def not ilike '%c_min_decisions%' then
    raise exception '664: the body was truncated — the computation is gone';
  end if;
end $$;

-- ── 4. assign_human_task: the guard now refuses instead of skipping ───────
do $$
declare
  v_old text := 'if auth_tenant_id() is not null and v_task.tenant_id <> auth_tenant_id() then';
  v_new text := E'-- mig 664: NULL-SAFE, and deliberately the LOOSE service_role escape.\n'
             || E'  -- trg_human_tasks_assign fires on INSERT, and inserts arrive from\n'
             || E'  -- migrations, cron and psql where auth.role() is NULL; those must keep\n'
             || E'  -- auto-routing. The strict coalesce() form would refuse them SILENTLY,\n'
             || E'  -- because the trigger swallows exceptions. An authenticated caller always\n'
             || E'  -- has a non-null role, so the comparison always runs for them, and\n'
             || E'  -- `is distinct from` makes a NULL tenant FAIL rather than skip.\n'
             || E'  if auth.role() is not null and auth.role() <> ''service_role''\n'
             || E'     and v_task.tenant_id is distinct from auth_tenant_id() then';
  v_def text := pg_get_functiondef('public.assign_human_task(uuid, boolean)'::regprocedure);
  v_hits int;
begin
  v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  if v_hits <> 1 then
    raise exception '664: expected the fail-open guard exactly once in assign_human_task, found % — body drifted', v_hits;
  end if;

  execute replace(v_def, v_old, v_new);

  v_def := pg_get_functiondef('public.assign_human_task(uuid, boolean)'::regprocedure);
  if v_def ilike '%auth_tenant_id() is not null and v_task.tenant_id <> auth_tenant_id()%' then
    raise exception '664: the fail-open guard is still there';
  end if;
  if v_def not ilike '%is distinct from auth_tenant_id()%' then
    raise exception '664: the null-safe comparison did not land';
  end if;
  -- ⚠ This token is what keeps the AFTER INSERT trigger alive. Losing it is the
  -- failure mode that would go unnoticed, because the trigger swallows errors.
  if v_def not ilike '%service_role%' then
    raise exception '664: the service_role escape is gone — auto-routing would stop silently';
  end if;
  if v_def not ilike '%unit_has_no_members%' then
    raise exception '664: the body was truncated — the routing logic is gone';
  end if;
end $$;

-- ── 5. Prove the guard actually refuses, from a session that should fail ──
-- This block runs as postgres with auth.uid() NULL and auth.role() NULL, i.e.
-- a caller who is a member of nothing. The OLD body returned a payload here.
-- The new one must raise. An unraised call is a failed migration — this is the
-- half that makes the check capable of failing.
do $$
declare
  v_t     uuid;
  v_raised boolean := false;
begin
  select id into v_t from public.tenants limit 1;
  if v_t is null then
    raise notice '664: no tenants on this database — the behavioural proof is skipped, NOT passed';
  else
    begin
      perform public.get_workforce_trust_metrics(v_t, 30);
    exception when others then
      v_raised := true;
    end;
    if not v_raised then
      raise exception '664: get_workforce_trust_metrics still answered a caller who is a member of nothing — the guard does not bite';
    end if;
    raise notice '664: trust metrics now refuse a non-member (proven, not assumed)';
  end if;
end $$;

commit;
