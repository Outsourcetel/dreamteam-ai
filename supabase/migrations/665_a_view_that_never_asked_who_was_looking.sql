-- 665_a_view_that_never_asked_who_was_looking.sql
-- ============================================================================
-- public.eval_gate was readable by the ANONYMOUS INTERNET. Not inferred from
-- grants — fetched, with nothing but the public anon key:
--
--   GET /rest/v1/eval_gate?select=tenant_id,status,total,passed,failed
--   [{"tenant_id":"5bb802e1…","status":"passed","total":16,"passed":16,"failed":0},
--    {"tenant_id":"a0000000…","status":"failed","total":2, "passed":0, "failed":2},
--    {"tenant_id":"a1b2c3d4…","status":"failed","total":20,"passed":19,"failed":1}]
--
-- Three tenants' identifiers and their certification-exam records, to anyone.
--
-- ── WHY. A VIEW IS A SECURITY DEFINER FUNCTION IN TABLE CLOTHING ─────────
-- A view executes with its OWNER's privileges unless `security_invoker = true`.
-- eval_gate is owned by postgres, which is BYPASSRLS, so the policy on its base
-- table — `eval_runs_tenant_read USING (tenant_id = auth_tenant_id())` — was
-- never evaluated. Not weakened, not mis-scoped: never consulted.
--
-- The proof that this is the whole story, and that the base data is otherwise
-- sound: anon fetching the BASE TABLE gets
--   {"code":"42501","message":"permission denied for function auth_tenant_id"}
-- because the policy DOES fire there and anon may not even evaluate it. Same
-- for pipeline_summary. Only the view leaked, and only because it never asked.
--
-- ── THE FIX IS THE HOUSE IDIOM, NOT A NEW ONE ────────────────────────────
-- Two sibling views already set it: pipeline_summary and
-- tenant_sso_effective_policy. eval_gate is the one that did not. Measured
-- across every view in `public` owned by a BYPASSRLS role that reads an
-- RLS-protected table, eval_gate was the ONLY offender — a genuine one-off,
-- not the tip of a class.
--
-- ⚠ BOTH HALVES. security_invoker moves the privilege check onto the CALLER,
-- so the caller now needs SELECT on the base table too. Verified before
-- writing this: authenticated holds SELECT on eval_runs, the tenant policy
-- exists (without it, invoker mode would deny EVERYONE and blind the panel),
-- and there is live data for each tenant. The one consumer,
-- src/lib/evalApi.ts:187, already filters `.eq('tenant_id', tid)` with its own
-- session tenant — so for the legitimate caller this changes nothing at all.
-- ============================================================================

begin;

-- The fix: ask who is looking.
alter view public.eval_gate set (security_invoker = true);

-- Defence in depth. Invoker mode alone already closes it (anon cannot evaluate
-- auth_tenant_id), but nothing anonymous has any business reading eval results,
-- and an explicit revoke states that intent where the next reader will see it.
revoke select on public.eval_gate from anon;

do $$
declare
  v_opts     text := coalesce((select array_to_string(reloptions, ',') from pg_class
                                where oid = 'public.eval_gate'::regclass), '');
  v_class    int;
begin
  -- (a) The fix landed.
  if v_opts not ilike '%security_invoker=true%' then
    raise exception '665: eval_gate still runs as its owner — RLS is still bypassed';
  end if;

  -- (b) …and the internet can no longer read it.
  if has_table_privilege('anon', 'public.eval_gate', 'SELECT') then
    raise exception '665: anon still holds SELECT on eval_gate';
  end if;

  -- (c) ⚠ THE OTHER HALF. Invoker mode charges the CALLER for the base table.
  -- This migration only revokes from anon, so authenticated's grant on the view
  -- is untouched — the real panel risk is invoker mode needing base-table
  -- SELECT. Enforce that WHERE the panel is actually wired (prod: authenticated
  -- holds the view). On dev, authenticated has no grant on eval_gate at all — a
  -- grant-drift gap, not something this migration caused — so the check would be
  -- vacuous; SKIP LOUDLY rather than fail, so an absent-grant dev cannot teach
  -- anyone to delete the assertion.
  if has_table_privilege('authenticated', 'public.eval_gate', 'SELECT') then
    if not has_table_privilege('authenticated', 'public.eval_runs', 'SELECT') then
      raise exception '665: authenticated cannot read eval_runs, so invoker mode blinds the view';
    end if;
    if not exists (select 1 from pg_policy where polrelid = 'public.eval_runs'::regclass) then
      raise exception '665: eval_runs has NO policy — invoker mode would deny every caller';
    end if;
  else
    raise notice '665: authenticated holds no grant on eval_gate here (dev grant-drift) — the panel-liveness half is SKIPPED, not passed';
  end if;

  -- (d) THE CLASS, recounted — and split by WHO can reach it, because the two
  -- halves are different severities. `anon` is the internet: an anon-reachable
  -- RLS-bypassing view is exactly what eval_gate was, and it MUST be zero after
  -- this. `authenticated` is a logged-in user reading across tenants: real, but
  -- the same severity as the SECDEF-function class handled elsewhere, and it is
  -- surfaced as a NOTICE rather than failing this migration — so a dev database
  -- carrying a drifted view (e.g. tenant_sso_effective_policy, which is
  -- security_invoker on prod but not always on dev) cannot block a prod-correct
  -- fix, while still being named rather than hidden.
  select count(*) into v_class
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    join pg_roles r on r.oid = c.relowner and r.rolbypassrls
   where c.relkind in ('v','m')
     and coalesce(array_to_string(c.reloptions, ','), '') not ilike '%security_invoker=true%'
     and has_table_privilege('anon', c.oid, 'SELECT')
     and exists (select 1 from pg_depend d
                   join pg_rewrite rw on rw.oid = d.objid
                   join pg_class t on t.oid = d.refobjid
                  where rw.ev_class = c.oid and d.refclassid = 'pg_class'::regclass
                    and t.relkind = 'r' and t.relrowsecurity and t.oid <> c.oid);
  if v_class <> 0 then
    raise exception '665: % view(s) still bypass RLS while reachable by ANON — the internet can read across tenants', v_class;
  end if;

  -- The authenticated-reachable remainder, named, non-blocking.
  declare v_authed text; begin
    select string_agg(c.relname, ', ' order by c.relname) into v_authed
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      join pg_roles r on r.oid = c.relowner and r.rolbypassrls
     where c.relkind in ('v','m')
       and coalesce(array_to_string(c.reloptions, ','), '') not ilike '%security_invoker=true%'
       and not has_table_privilege('anon', c.oid, 'SELECT')
       and has_table_privilege('authenticated', c.oid, 'SELECT')
       and exists (select 1 from pg_depend d
                     join pg_rewrite rw on rw.oid = d.objid
                     join pg_class t on t.oid = d.refobjid
                    where rw.ev_class = c.oid and d.refclassid = 'pg_class'::regclass
                      and t.relkind = 'r' and t.relrowsecurity and t.oid <> c.oid);
    if v_authed is not null then
      raise notice '665: authenticated-reachable RLS-bypass view(s) remain (separate, lesser class; fix with security_invoker): %', v_authed;
    end if;
  end;

  raise notice '665: eval_gate now asks who is looking; 0 anon-reachable RLS-bypassing views remain';
end $$;

commit;
