-- 628 — the index I swapped under four upserts.
--
-- ⚠⚠ LIVE BREAKAGE, MINE, AND THE SECOND ONE FROM MIGRATION 618.
--
-- 618 replaced the de_autonomy uniqueness rule:
--
--   dropped: de_autonomy_tenant_action_category_de_uq
--            (tenant_id, action_type, coalesce(source_category,''), coalesce(de_id::text,''))
--   created: idx_de_autonomy_one_rule_per_scope
--            (tenant_id, action_type, coalesce(de_id,'0…0'::uuid),
--             coalesce(playbook_id,'0…0'::uuid), coalesce(source_category,''))
--
-- It updated set_de_autonomy to match and stopped there. THREE OTHER FUNCTIONS
-- still name the old shape, and Postgres resolves an ON CONFLICT target against
-- the indexes that exist AT EXECUTION TIME:
--
--   ERROR: 42P10: there is no unique or exclusion constraint matching the
--          ON CONFLICT specification
--
-- What that actually costs:
--
--   provision_workforce_assistant_internal  — runs from the AFTER INSERT
--       trigger on tenants, so CREATING A WORKSPACE AT ALL throws
--   provision_starter_de_internal           — reached via complete_signup →
--       provision_tenant_baseline_internal, so SIGNUP throws
--   trust_apply_level                       — every trust promotion and
--       demotion throws
--
-- Nothing reported it because no workspace has been created and no trust level
-- applied since 618 landed this morning. I found it only because I wrote a test
-- that actually provisioned a workspace instead of reading the code and
-- concluding it looked right.
--
-- ⚠⚠ THIS IS THE SAME FAILURE AS 623, FROM THE SAME MIGRATION. There I changed
-- a function's signature and fixed one of the three callers; here I changed an
-- index and fixed one of the four upserts. Both times: I fixed the instance I
-- was looking at instead of enumerating the class. The rule I wrote after 623
-- was about function overloads specifically — it should have been about ANY
-- shared structure. A unique index is an interface too.
--
-- ⚠ instantiate_role_archetype also upserts de_autonomy but uses a bare
-- `on conflict do nothing` with no target, which binds to no index and is
-- therefore immune. Left alone deliberately.
--
-- ⚠ provision_starter_de_internal has a SECOND ON CONFLICT naming
-- `action_category` — that one is on TRUST_POLICIES, a different table whose
-- index 618 never touched. Not a defect; deliberately not modified. The
-- splice below keys on `action_type`, so it cannot reach it.

begin;

do $fix$
declare
  -- ⚠ Built with quote_literal rather than hand-doubled quotes. The first
  -- attempt at this migration wrote '''' where it meant '' and emitted
  -- ''00000000-…'' into the function body — a syntax error caught only because
  -- the whole thing was dry-run with `rollback` first. Escaping by eye is how
  -- you corrupt three live functions at once.
  v_nil text := quote_literal('00000000-0000-0000-0000-000000000000');
  v_emp text := quote_literal('');
  v_old text := '(tenant_id, action_type, coalesce(source_category, ' || v_emp || '), coalesce(de_id::text, ' || v_emp || '))';
  v_new text := '(tenant_id, action_type, coalesce(de_id, ' || v_nil || '::uuid), '
             || 'coalesce(playbook_id, ' || v_nil || '::uuid), '
             || 'coalesce(source_category, ' || v_emp || '))';
  v_fns  text[] := array['provision_starter_de_internal',
                         'provision_workforce_assistant_internal',
                         'trust_apply_level'];
  v_fn    text;
  v_src   text;
  v_new_s text;
  v_before int;
  v_after  int;
  v_total  int := 0;
begin
  foreach v_fn in array v_fns loop
    -- ⚠ A function may have several overloads; fix every one of them. Assuming
    -- one is how 620 missed two functions and broke the action gate.
    for v_src in
      select pg_get_functiondef(p.oid)
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_fn
    loop
      v_before := (length(v_src) - length(replace(v_src, v_old, ''))) / nullif(length(v_old), 0);

      if coalesce(v_before, 0) = 0 then
        raise notice '% — no stale conflict target (already correct)', v_fn;
        continue;
      end if;

      v_new_s := replace(v_src, v_old, v_new);

      -- Assert AFTER as well as before: a before-only check cannot tell a
      -- successful splice from a silent no-op.
      v_after := (length(v_new_s) - length(replace(v_new_s, v_old, ''))) / nullif(length(v_old), 0);
      if coalesce(v_after, 0) <> 0 then
        raise exception '% still has % stale target(s) after the splice', v_fn, v_after;
      end if;

      execute v_new_s;
      v_total := v_total + v_before;
      raise notice '% — repaired % conflict target(s)', v_fn, v_before;
    end loop;
  end loop;

  if v_total = 0 then
    raise exception 'repaired nothing — the stale target text did not match, so this migration did not do its job';
  end if;
  raise notice 'repaired % ON CONFLICT target(s) in total', v_total;
end;
$fix$;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFY — statically that nothing stale survives, then by ACTUALLY RUNNING
-- the upsert shape that was throwing.
-- ════════════════════════════════════════════════════════════════════════
do $verify$
declare
  v_stale  int;
  v_tenant uuid;
  v_de     uuid;
  v_rows   int;
begin
  -- 1. No function anywhere may still name the old index.
  -- ⚠ prosrc, NOT pg_get_functiondef: the latter raises
  -- '"avg" is an aggregate function' the moment the scan reaches one, so a
  -- whole-catalogue sweep with it can never complete. prosrc is the body and
  -- contains the ON CONFLICT text just the same.
  --
  -- ⚠⚠ AND THE PATTERN MUST BE THE EXACT de_autonomy SHAPE, not a loose
  -- 'coalesce(de_id::text' + 'de_autonomy' pair. The loose version failed this
  -- migration on provision_starter_de_internal, which legitimately keeps
  -- `coalesce(de_id::text, '')` for its TRUST_POLICIES upsert — a different
  -- table, a different index, untouched by 618. An assertion that cannot tell
  -- those apart does not verify the fix, it just fails on a correct function.
  select count(*) into v_stale
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind in ('f', 'p')
    and p.prosrc ilike '%de_autonomy%'
    and p.prosrc like '%(tenant_id, action_type, coalesce(source_category, ''''), coalesce(de_id::text, '''')%';
  if v_stale > 0 then
    raise exception '% function(s) still reference the dropped de_autonomy index', v_stale;
  end if;

  -- 2. The real thing: run the repaired upsert twice and require the second to
  --    be a silent no-op rather than an error. Reading the text proves the
  --    splice happened; only executing it proves the target RESOLVES.
  select id into v_tenant from tenants where slug = 'outsourcetel-hq';
  select id into v_de from digital_employees
   where tenant_id = v_tenant and status = 'active' order by created_at limit 1;
  if v_tenant is null or v_de is null then
    raise notice 'no workspace/employee to exercise the upsert against';
    return;
  end if;

  insert into de_autonomy (tenant_id, action_type, source_category, de_id, enabled, min_confidence)
  values (v_tenant, 'zz_probe_628', null, v_de, false, 70)
  on conflict (tenant_id, action_type,
               coalesce(de_id, '00000000-0000-0000-0000-000000000000'::uuid),
               coalesce(playbook_id, '00000000-0000-0000-0000-000000000000'::uuid),
               coalesce(source_category, ''))
  do nothing;

  insert into de_autonomy (tenant_id, action_type, source_category, de_id, enabled, min_confidence)
  values (v_tenant, 'zz_probe_628', null, v_de, false, 70)
  on conflict (tenant_id, action_type,
               coalesce(de_id, '00000000-0000-0000-0000-000000000000'::uuid),
               coalesce(playbook_id, '00000000-0000-0000-0000-000000000000'::uuid),
               coalesce(source_category, ''))
  do nothing;

  select count(*) into v_rows from de_autonomy
   where tenant_id = v_tenant and action_type = 'zz_probe_628';
  if v_rows <> 1 then
    raise exception 'expected exactly 1 probe row after two upserts, found %', v_rows;
  end if;

  -- Clean up after myself; a probe row left behind is a rule somebody inherits.
  delete from de_autonomy where tenant_id = v_tenant and action_type = 'zz_probe_628';

  raise notice 'the de_autonomy upsert resolves and is idempotent again';
end;
$verify$;

commit;
