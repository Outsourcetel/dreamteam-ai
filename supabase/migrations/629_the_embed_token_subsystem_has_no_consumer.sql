-- 629 — the embed-token subsystem has no consumer.
--
-- Removing the `/embed` iframe (commit 21192c5) orphaned its entire backend.
-- What is left behind:
--
--   embed_tokens                table, 0 rows, no FKs, no views, NO POLICIES
--   generate_embed_token()      no callers
--   get_or_create_embed_token() no callers
--   verify_embed_token()        no callers — and EXECUTABLE BY `anon`
--
-- ⚠⚠ The anon grant is the reason this is a migration and not a cleanup ticket.
-- Migration 610 closed the default-PUBLIC-EXECUTE hole across 24 functions and
-- deliberately LEFT `verify_embed_token` reachable by `anon`, because the embed
-- widget had to call it before any session existed. That justification died
-- with the widget. On this platform `anon` is the internet
-- ([[security_anon_guard_hole]]: revoking anon alone is theatre because PUBLIC
-- includes anon — here we revoke PUBLIC, which covers both).
--
-- An anon-callable token verifier that nothing calls is pure attack surface:
-- it can be probed for timing and existence signals forever and no alarm ever
-- fires, because no legitimate traffic exists to compare against.
--
-- ⚠ A note on how safe the table actually was, because the record was wrong.
-- Several go-live docs claimed "RLS policies enforce tenant isolation" and
-- "embed_tokens: RLS on tenant_id ✅". There are **zero policies on this
-- table**. It was not leaking — RLS is ENABLED, and enabled-with-no-policies
-- denies everything — but it was safe BY ACCIDENT, not by the tenant isolation
-- that was signed off. `anon` even holds a table-level SELECT grant on it,
-- which only RLS was stopping. Nothing to fix now; the table goes.
--
-- ⚠ `drop function` with a wrong argument type is a SILENT no-op
-- ([[project_specialist_role_retired]]), so every signature below is the exact
-- `pg_get_function_identity_arguments` output, and the verify block asserts
-- each one is actually gone rather than trusting the statement ran.

begin;

-- Revoke before dropping. If a later statement fails and this migration rolls
-- back, that is fine — but if the drop were somehow skipped while the revoke
-- stood, the safer half is the one that survived.
revoke all on function verify_embed_token(p_token text, p_tenant_id uuid, p_de_id uuid) from public;
revoke all on function generate_embed_token(p_tenant_id uuid, p_de_id uuid, p_expires_in_hours integer) from public;
revoke all on function get_or_create_embed_token(p_tenant_id uuid, p_de_id uuid) from public;

drop function if exists verify_embed_token(p_token text, p_tenant_id uuid, p_de_id uuid);
drop function if exists get_or_create_embed_token(p_tenant_id uuid, p_de_id uuid);
drop function if exists generate_embed_token(p_tenant_id uuid, p_de_id uuid, p_expires_in_hours integer);

-- The table last: the functions were its only accessors.
-- No FKs point at it, no view depends on it, 0 rows.
drop table if exists embed_tokens;

do $verify$
declare
  v_fns   int;
  v_tbl   oid;
  v_refs  int;
begin
  -- 1. All three gone. Counting by NAME catches a silent no-op from a wrong
  --    argument type, which counting by signature would not.
  select count(*) into v_fns
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('generate_embed_token', 'get_or_create_embed_token', 'verify_embed_token');
  if v_fns <> 0 then
    raise exception '% embed-token function(s) survived the drop', v_fns;
  end if;

  -- 2. Table gone.
  v_tbl := to_regclass('public.embed_tokens');
  if v_tbl is not null then
    raise exception 'embed_tokens still exists';
  end if;

  -- 3. ⚠ And nothing left behind may still CALL them. This is the check that
  --    turns a drop into a safe drop: a plpgsql body referencing a dropped
  --    function compiles fine and fails at runtime, which is exactly the
  --    defect 628 had to repair.
  select count(*) into v_refs
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind in ('f', 'p')
    and (p.prosrc ilike '%embed_token%' or p.prosrc ilike '%embed_tokens%');
  if v_refs > 0 then
    raise exception '% surviving function(s) still reference the embed-token subsystem', v_refs;
  end if;

  raise notice 'embed-token subsystem removed: 3 functions + 1 table, no surviving references';
end;
$verify$;

commit;
