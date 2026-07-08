-- ============================================================
-- Migration 080: migration 079's own anon-grant sweep left a real gap
-- — found by this migration's own live verification (`set role anon;
-- select auth_tenant_id();` still succeeded after 079 supposedly
-- fixed it), not assumed clean.
--
-- ROOT CAUSE: `anon` is automatically a member of the PostgreSQL
-- pseudo-role `PUBLIC` — every role is. Revoking a grant made
-- DIRECTLY to `anon` does nothing if the function ALSO carries a
-- separate EXECUTE grant to `PUBLIC` itself (the implicit grant every
-- new function gets at CREATE FUNCTION time, unless a migration
-- explicitly revokes it) — `anon` still executes it through PUBLIC
-- membership regardless. 079 only ever revoked `... from anon`; it
-- needed `... from public` too. This is the same shape of mistake
-- documented before in this project's history (a bare `revoke ...
-- from public` failing to catch a *named*-role grant) — this time in
-- the opposite direction (a named-role revoke failing to catch the
-- PUBLIC grant underneath it). Same lesson, either direction: always
-- re-run the actual check after a grant-hygiene fix, never assume the
-- SQL did what it reads like it should.
--
-- A live query after 079 found exactly 10 functions still holding a
-- PUBLIC-level grant (including is_platform_admin — the single most
-- important gate in the whole codebase, "fixed" in migration 078 with
-- the same incomplete anon-only revoke). Every one already carries a
-- real internal guard (confirmed by the same audit that produced 079
-- — auth.uid()/auth_tenant_id() resolving to null or empty for an
-- unauthenticated caller, or trigger-only functions never directly
-- invocable in a way that matters) — this closes the grant hygiene
-- gap, no application logic changes.
-- ============================================================

-- Trigger-only functions: never directly invoked by any client role,
-- so revoking from PUBLIC entirely (no re-grant) is correct — nothing
-- legitimate calls these outside Postgres's own trigger mechanism.
revoke all on function public.guard_against_demo_tenant_assignment() from public;
revoke all on function public.handle_new_user() from public;
revoke all on function public.invalidate_answer_cache() from public;
revoke all on function public.trust_check_eval_regression() from public;
revoke all on function public.trust_check_guardrail_block() from public;

-- Real application functions: revoke the PUBLIC grant, then restore
-- exactly the access legitimate callers need (authenticated for
-- direct client calls; service_role for edge-function-invoked paths),
-- matching the explicit revoke/grant pattern every properly-hardened
-- function elsewhere in this codebase already follows.
revoke all on function public.auth_tenant_id() from public;
grant execute on function public.auth_tenant_id() to authenticated, service_role;

revoke all on function public.is_platform_admin() from public;
grant execute on function public.is_platform_admin() to authenticated, service_role;

revoke all on function public.detect_exceptions(uuid, uuid) from public;
grant execute on function public.detect_exceptions(uuid, uuid) to authenticated, service_role;

revoke all on function public.ingest_document(uuid, uuid, text, text, jsonb, uuid) from public;
grant execute on function public.ingest_document(uuid, uuid, text, text, jsonb, uuid) to authenticated, service_role;

revoke all on function public.resolve_exception(uuid, text, text, uuid, text) from public;
grant execute on function public.resolve_exception(uuid, text, text, uuid, text) to authenticated, service_role;
