-- 731 — the admin plumbing grants are asserted, not assumed
--
-- Review of 730 (the platform_admin connector moving into baseline
-- provisioning) found a real gap, not a live defect: 730 issued bare
-- `revoke`/`grant` DDL for the new function
-- provision_platform_admin_connector_internal and never verified it took
-- effect, and it re-asserted NOTHING for the two existing functions it
-- edited — provision_onboarding_architect and provision_tenant_baseline_internal
-- — even though `create or replace` PRESERVES whatever grants a function
-- already had. Production is correct today on all three (checked live before
-- writing a line here: proacl identical on all three,
-- `{postgres=X/postgres,service_role=X/postgres}` — no anon, no authenticated,
-- no bare PUBLIC entry). But "correct today" is not the same claim as "proven
-- by this migration", and the doctrine this repo already settled on (migs
-- 610, 630, 722) is exactly that gap: a REVOKE is a request, not a
-- description of where you ended up. 730 is applied and ledger-checksummed,
-- so it is not edited here — this is the missing proof, as its own migration.
--
-- Not editing 730 also means this migration re-issues the same revoke/grant
-- pair for all three functions rather than skipping the ones that "should
-- already be right" — re-issuing is idempotent (a REVOKE of a privilege
-- nobody holds, or a GRANT of one already held, is a safe no-op), and it is
-- what makes this migration self-sufficient: apply it to a database that
-- somehow reached this point with one of the three still wrong, and it fixes
-- itself instead of only auditing.
--
-- Checked, not assumed, that all three genuinely want IDENTICAL treatment
-- before writing identical DDL three times: live proacl matches across all
-- three (above), and neither provision_onboarding_architect nor
-- provision_tenant_baseline_internal is ever called via `.rpc()` from src/ or
-- supabase/functions/ (grepped both trees — the only hits are the generated
-- src/types/database.types.ts signatures, not call sites). Both are reached
-- exclusively from other SQL (provision_onboarding_architect from the
-- trg_provision_onboarding_architect trigger; provision_tenant_baseline_internal
-- from provisioning scripts running as service_role), matching
-- provision_platform_admin_connector_internal's own shape. None of the three
-- needs anything the others do not.
--
-- ── THE VERIFY BLOCK, AND THE TRAP IT HAS TO DODGE ────────────────────────
-- has_function_privilege(role, function, privilege) ERRORS — 42883, function
-- does not exist — if the signature text does not resolve to a real function,
-- rather than returning false. Confirmed by driving it (read-only, against
-- production, before writing this migration):
--   has_function_privilege('authenticated','public.this_function_does_not_exist_xyz(uuid)','execute')
--     -> ERROR 42883
-- A typo'd signature in the verify block below would therefore still abort
-- the migration (loud, not silent) but for the wrong reason — "name does not
-- resolve" instead of "grant is wrong" — so every signature used below was
-- confirmed live (regprocedure cast, pg_proc) immediately before writing it:
-- all three resolve to `(uuid)`.
--
-- The doctrine also asks that PUBLIC be checked, not only anon/authenticated.
-- has_function_privilege accepts the literal role name 'public' as a documented
-- special case meaning "the PUBLIC pseudo-role" — confirmed live (returned a
-- real boolean, false, not an error) rather than assumed from the docs. That
-- makes it possible to check all four roles (public, anon, authenticated,
-- service_role) with the same function and the same full-signature form
-- ('public.fn(uuid)'), which is what migration 685 already used per-function
-- for anon/authenticated/service_role — this migration extends the identical
-- pattern to PUBLIC and to all three functions 730 touched.
--
-- Each of the 12 checks below (4 roles x 3 functions) was proven capable of
-- firing before being trusted, not merely written and assumed correct:
--   * the "must be false" checks (public/anon/authenticated) were proven
--     capable of returning TRUE — and therefore capable of raising — by
--     running the identical expression against install_starter_onboarding_template,
--     which migration 685 deliberately granted to authenticated:
--     has_function_privilege('authenticated','public.install_starter_onboarding_template()','execute')
--     -> true. The same boolean machinery, exercised on a real positive case.
--   * the "must be true" check (service_role) is already proven both ways by
--     722's own drive-test elsewhere in this repo (a revoked role's trigger
--     genuinely stops firing); here it is additionally cross-checked against
--     the live proacl inspected above, which agrees exactly.
--
-- ── BOTH HALVES ────────────────────────────────────────────────────────────
-- Asserting only "authenticated cannot" would pass against a function nobody
-- can call at all — its own outage, invisible to a revoke-only check. Every
-- one of the 12 assertions pairs a "must not" with a "must" on the same
-- function, per migs 610/630/722's rule.

begin;

-- ── Re-issue, idempotently, for all three ─────────────────────────────────
revoke execute on function public.provision_platform_admin_connector_internal(uuid) from public, anon, authenticated;
grant  execute on function public.provision_platform_admin_connector_internal(uuid) to service_role;

revoke execute on function public.provision_onboarding_architect(uuid) from public, anon, authenticated;
grant  execute on function public.provision_onboarding_architect(uuid) to service_role;

revoke execute on function public.provision_tenant_baseline_internal(uuid) from public, anon, authenticated;
grant  execute on function public.provision_tenant_baseline_internal(uuid) to service_role;

-- ── Assert the RESULT, both directions, all three functions ──────────────
do $$
declare
  r          record;
  v_checked  int    := 0;
  v_bad      text[] := '{}';
begin
  for r in
    select * from (values
      ('provision_platform_admin_connector_internal(uuid)'),
      ('provision_onboarding_architect(uuid)'),
      ('provision_tenant_baseline_internal(uuid)')
    ) as t(sig)
  loop
    v_checked := v_checked + 1;

    -- half one, three roles: must NOT be able to execute.
    if has_function_privilege('public', 'public.' || r.sig, 'execute') then
      v_bad := array_append(v_bad, format('%s: PUBLIC can execute — should not', r.sig));
    end if;
    if has_function_privilege('anon', 'public.' || r.sig, 'execute') then
      v_bad := array_append(v_bad, format('%s: anon can execute — should not', r.sig));
    end if;
    if has_function_privilege('authenticated', 'public.' || r.sig, 'execute') then
      v_bad := array_append(v_bad, format('%s: authenticated can execute — should not', r.sig));
    end if;

    -- half two: must be able to execute, or provisioning itself breaks.
    if not has_function_privilege('service_role', 'public.' || r.sig, 'execute') then
      v_bad := array_append(v_bad, format('%s: service_role CANNOT execute — provisioning would break', r.sig));
    end if;
  end loop;

  -- A loop over an empty set would report a clean sweep of nothing — this
  -- migration names exactly 3 functions, so anything else is a bug in the
  -- migration itself, not a passing result.
  if v_checked <> 3 then
    raise exception '731 vacuity guard: checked % function(s), expected exactly 3', v_checked;
  end if;

  if coalesce(array_length(v_bad, 1), 0) > 0 then
    raise exception '731: % of 12 grant assertion(s) failed: %', array_length(v_bad, 1), array_to_string(v_bad, ' | ');
  end if;

  raise notice '731: all 12 grant assertions passed (public/anon/authenticated cannot execute, service_role can — across all 3 functions 730 touched)';
end $$;

commit;
