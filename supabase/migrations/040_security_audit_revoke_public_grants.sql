-- Migration 040: Adversarial multi-tenant isolation audit — correct the
-- REVOKE statements in migrations 038/039 (renumbered from 039/040 to stay
-- sequential — already applied to the live DB, file-naming-only fix).
--
-- Root cause found by re-testing live after 037/038 were applied: this
-- Postgres project grants EXECUTE to the pseudo-role PUBLIC by default at
-- function creation time for several of these functions (visible as the
-- `=X/postgres` entry in pg_proc.proacl — the empty role name before `=`
-- denotes PUBLIC). `REVOKE EXECUTE ... FROM anon, authenticated` only
-- removes a grant made TO those roles BY NAME — it does nothing to a
-- separate PUBLIC-wide grant, and anon/authenticated (like every role)
-- inherit EXECUTE through their PUBLIC membership regardless. Verified
-- live: match_knowledge_chunks, increment_tenant_token_usage, and
-- p_workspace_period_end all STILL had anon/authenticated EXECUTE access
-- after migration 037/038 supposedly revoked it — reproduced with an
-- unauthenticated anon-key RPC call to match_knowledge_chunks, which
-- executed successfully (200, not 403) with match_tenant_id set to Acme
-- Telecom's real tenant. The correct fix is `REVOKE EXECUTE ... FROM
-- PUBLIC`, which actually removes the PUBLIC-wide grant itself.
--
-- (increment_metric_tenant was already fixed correctly in a manual
-- follow-up during this same audit session, applied directly via
-- `REVOKE ... FROM PUBLIC` — recorded here too so migration history
-- matches the live database exactly.)

REVOKE EXECUTE ON FUNCTION match_knowledge_chunks(vector, uuid, double precision, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION increment_tenant_token_usage(uuid, text, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION p_workspace_period_end(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION increment_metric_tenant(uuid, text, bigint) FROM PUBLIC;

-- Re-verify (informational only — this SELECT's output appears in the
-- migration application log, not enforced by the migration itself):
-- after this runs, has_function_privilege('anon', <oid>, 'EXECUTE') and
-- the 'authenticated' equivalent must both be false for all four.

-- Belt-and-suspenders: explicitly re-grant EXECUTE to service_role by name
-- (rather than relying solely on its own PUBLIC-derived access, which we
-- are now removing) so a future audit doesn't have to re-derive that
-- service_role's access survives this revoke.
GRANT EXECUTE ON FUNCTION match_knowledge_chunks(vector, uuid, double precision, integer) TO service_role;
GRANT EXECUTE ON FUNCTION increment_tenant_token_usage(uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION p_workspace_period_end(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION increment_metric_tenant(uuid, text, bigint) TO service_role;
