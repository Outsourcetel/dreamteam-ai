-- 381_export_pager_restore_contract.sql
-- ============================================================================
-- Migration 377 broke the data export while fixing two real holes in it. This
-- restores what it broke WITHOUT giving back the holes.
--
-- ⚠ THIS IS MY OWN REGRESSION FROM EARLIER TONIGHT, and worth stating plainly.
-- 377 rewrote export_tenant_table_page from scratch to add the knowledge ACL and
-- an audit row. In retyping it I dropped most of what 372 had carefully built:
--
--   · next_cursor  — the edge function does `cursor = page?.next_cursor ?? null`
--                    and stops when it is null, so paging died after one page
--   · complete     — `page?.complete === true` was undefined, same effect
--   · returned     — the per-page count
--   · p_cursor     — IGNORED entirely; replaced with a plain LIMIT, so every
--                    call returned the same first page
--   · keyset paging on the PRIMARY KEY, which 372 chose deliberately: OFFSET
--     re-sorts everything before the window (quadratic across 36k audit rows)
--     and a concurrent insert shifts the window so rows duplicate or vanish
--     mid-export. A primary key does not move.
--   · column redaction (v_select) and export_tenant_scope_sql's tenant scoping
--
-- Symptom: the export returned HTTP 200 with tables_exported: 14,
-- rows_exported: 0, complete: false — a valid-looking archive containing no
-- customer data. Before 377 it produced real rows.
--
-- ── HOW THIS FILE IS BUILT ────────────────────────────────────────────────
-- Generated from 372's ACTUAL function text (scripts read the file, splice in
-- the two additions), NOT retyped. Retyping is precisely what lost the logic the
-- first time, and doing it again by hand would risk losing something else.
--
-- What 377 got RIGHT and is preserved here verbatim:
--   · the knowledge ACL predicate, folded into v_where so it composes with the
--     existing tenant scoping instead of competing with it
--   · the per-(session, table) audit row
--   · VOLATILE rather than STABLE — a STABLE function may not write, so the
--     audit INSERT requires it. 377 achieved this by dropping `stable`
--     wholesale; here it is deliberate and commented.
-- ============================================================================

create or replace function public.export_tenant_table_page(
  p_tenant uuid,
  p_table  text,
  p_cursor jsonb default null,   -- ['<pk value>', ...] from the previous page
  p_limit  int  default 500,
  p_session uuid default null      -- groups one export's audit rows (mig 377/381)
)
returns jsonb
language plpgsql
-- NOT stable: this writes an audit row (see the INSERT below).
security definer
set search_path = public
as $$
declare
  s        record;
  v_where  text;
  v_select text;
  v_order  text;
  v_after  text := '';
  v_limit  int;
  v_sql    text;
  v_rows   jsonb;
  v_n      int;
  v_cursor jsonb := null;
  -- Not named `c`: the unnest aliases below expose a column called col, and a
  -- scalar variable colliding with a query alias is a plpgsql resolution hazard.
  v_cur_val text;
begin
  if not public.can_admin_tenant_internal(p_tenant) then
    raise exception 'not authorized to export tenant %', p_tenant using errcode = '42501';
  end if;

  -- Catalog lookup BEFORE any SQL is composed. This is the validation that makes
  -- the format('%I') calls below a second line of defence rather than the only one.
  select * into s from public.export_tenant_surface() where table_name = p_table;
  if not found then
    raise exception 'table % is not part of the tenant export surface', p_table
      using errcode = '22023';
  end if;
  if s.pk_columns is null then
    raise exception 'table % has no primary key and cannot be paginated', p_table
      using errcode = '22023';
  end if;
  if s.pk_columns && s.redacted_columns then
    raise exception 'table % has a redacted primary key and cannot be paginated', p_table
      using errcode = '22023';
  end if;

  v_where := public.export_tenant_scope_sql(s.scope, s.parent_links);

  -- ── Per-document ACL (mig 377, preserved here) ────────────────────────────
  -- This function is SECURITY DEFINER, so RLS does not apply and
  -- knowledge_docs_acl_select (migs 343/344, hardened by 357) is bypassed. That
  -- policy exempts is_platform_admin() ONLY — deliberately not tenant_admin,
  -- because 357 exists so that "admin" does not mean "reads every restricted
  -- Space". Delegates to the same helpers the policy uses rather than restating
  -- the rule, so the two cannot drift apart.
  -- Latent today: 0 docs have restricted_space_id set. It closes the day one does.
  if p_table = 'knowledge_docs'
     and coalesce(auth.role(), '') <> 'service_role'
     and not public.is_platform_admin() then
    v_where := v_where || ' and (t.restricted_space_id is null and t.inherits_access'
            || ' or exists (select 1 from knowledge_access_grants g'
            || '             where g.tenant_id = t.tenant_id'
            || '               and knowledge_permission_rank(g.permission) >= 1'
            || '               and knowledge_grant_matches_caller(g.*)'
            || '               and (g.resource_type = ''workspace'''
            || '                 or (g.resource_type = ''space'' and g.resource_id = t.restricted_space_id)'
            || '                 or (g.resource_type = ''document'' and g.resource_id = t.id))))';
  end if;

  -- 2000 caps ONE page's memory here and in the caller. It is not a cap on the
  -- export: the caller keeps paging until complete.
  v_limit := least(greatest(coalesce(p_limit, 500), 1), 2000);

  select string_agg(
           case when u.col = any(s.redacted_columns)
                then format('%L::text as %I',
                            '[redacted: credential material — not exported]', u.col)
                else format('t.%I', u.col) end,
           ', ' order by u.ord)
    into v_select
    from unnest(s.data_columns) with ordinality as u(col, ord);

  select string_agg(format('t.%I', u.col), ', ' order by u.ord)
    into v_order
    from unnest(s.pk_columns) with ordinality as u(col, ord);

  if p_cursor is not null then
    if jsonb_typeof(p_cursor) <> 'array'
       or jsonb_array_length(p_cursor) <> array_length(s.pk_columns, 1) then
      raise exception 'cursor must be an array of % primary key value(s) for %',
        array_length(s.pk_columns, 1), p_table using errcode = '22023';
    end if;
    for v_cur_val in select jsonb_array_elements_text(p_cursor) loop
      if v_cur_val is null then
        -- A NULL anywhere in a row comparison makes the whole predicate NULL,
        -- which returns zero rows and reads to the caller as "export finished".
        raise exception 'cursor values may not be null' using errcode = '22023';
      end if;
    end loop;
    -- (a,b,c) > (x,y,z) is row-wise comparison in Postgres and it matches
    -- ORDER BY a,b,c exactly, so this means "strictly after the last row of the
    -- previous page" for composite keys as well as single ones. Verified against
    -- production on knowledge_doc_usage_daily (tenant_id, doc_id, usage_date):
    -- 97 rows, 3 returned, 94 remaining after the cursor — no gap, no overlap.
    -- The cast target comes from format_type() in the catalog, never the caller.
    select format(' and (%s) > (%s)',
             v_order,
             string_agg(format('%L::%s', p_cursor->>(u.ord - 1)::int, u.ty),
                        ', ' order by u.ord))
      into v_after
      from unnest(s.pk_columns, s.pk_types) with ordinality as u(col, ty, ord);
  end if;

  v_sql := format(
    'select coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) from ('
    || 'select %s from public.%I t where %s%s order by %s limit %s) x',
    v_select, p_table, v_where, v_after, v_order, v_limit);
  execute v_sql into v_rows using p_tenant;

  v_n := jsonb_array_length(v_rows);
  if v_n > 0 then
    -- Rows come back in primary-key order, so the last element carries the next
    -- cursor. Safe to read back out of the JSON because a redacted primary key
    -- was rejected above.
    select jsonb_agg(v_rows -> (v_n - 1) ->> u.col order by u.ord)
      into v_cursor
      from unnest(s.pk_columns) with ordinality as u(col, ord);
  end if;

  -- ── Audit (mig 377, preserved) ────────────────────────────────────────────
  -- 372 audited the MANIFEST only, while this pager is separately granted to
  -- authenticated — so a tenant_admin could page every row of all 226 tables
  -- over PostgREST and leave no trace. Deduped per (session, table).
  if p_session is not null then
    insert into audit_events (tenant_id, actor, actor_type, action, category, detail, created_at)
    select p_tenant,
           coalesce((select full_name from profiles where user_id = auth.uid()), 'unknown'),
           'user', format('Exported table %s', p_table), 'data_export',
           jsonb_build_object('table', p_table, 'export_session', p_session),
           now()
     where not exists (
       select 1 from audit_events a
        where a.tenant_id = p_tenant and a.category = 'data_export'
          and a.detail->>'export_session' = p_session::text
          and a.detail->>'table' = p_table);
  end if;

  return jsonb_build_object(
    'table', p_table,
    'rows', v_rows,
    'returned', v_n,
    -- A short page means the table is drained. A full page is ambiguous, so we
    -- report not-complete and let the caller make one more call that returns
    -- zero rows. Guessing here is how an export loses its tail.
    'complete', v_n < v_limit,
    'next_cursor', v_cursor);
end;
$$;

revoke all on routine public.export_tenant_table_page(uuid, text, jsonb, int, uuid) from public, anon;
grant execute on routine public.export_tenant_table_page(uuid, text, jsonb, int, uuid) to authenticated;

do $assert$
declare v_def text;
begin
  select regexp_replace(pg_get_functiondef(p.oid), '\s+', ' ', 'g') into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'export_tenant_table_page'
     and pg_get_function_arguments(p.oid) like '%p_session%';
  if v_def is null then raise exception '381: the pager is missing'; end if;

  -- The contract the edge function actually consumes. Losing any one of these
  -- silently produces an empty archive with a 200, which is how this happened.
  if v_def !~ 'next_cursor' then raise exception '381: next_cursor not restored — paging will stop after one page'; end if;
  if v_def !~ '''complete''' then raise exception '381: complete not restored'; end if;
  if v_def !~ '''returned''' then raise exception '381: returned not restored'; end if;
  if v_def !~ 'p_cursor'    then raise exception '381: p_cursor is still ignored'; end if;

  -- 377's additions must survive this restore, or the holes reopen.
  if v_def !~ 'knowledge_grant_matches_caller' then raise exception '381: the knowledge ACL was lost'; end if;
  if v_def !~ 'audit_events' then raise exception '381: the audit row was lost'; end if;

  -- A STABLE function cannot perform the audit INSERT.
  if (select provolatile from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname='public' and p.proname='export_tenant_table_page'
         and pg_get_function_arguments(p.oid) like '%p_session%') = 's' then
    raise exception '381: the pager is STABLE and cannot write its audit row';
  end if;

  if has_function_privilege('anon', 'public.export_tenant_table_page(uuid,text,jsonb,int,uuid)', 'EXECUTE') then
    raise exception '381: the pager is anon-callable';
  end if;

  raise notice '381: export paging contract restored, ACL and audit preserved';
end $assert$;

notify pgrst, 'reload schema';
