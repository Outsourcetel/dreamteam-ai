-- ============================================================================
-- 372_tenant_data_export.sql — let a customer get THEIR data out, by themselves.
--
-- WHY THIS EXISTS
-- The 13-agent audit scored enterprise readiness 27/100, and "the customer
-- cannot export their data" was one of the two structural holes behind that
-- number. The only thing in the database that even sounded like an export was
-- export_tenant_config() — 591 characters returning (metrics, schemas, configs),
-- i.e. CONFIG ONLY, no customer rows — and grep finds zero references to it
-- anywhere in src/. It is not a data export and nothing calls it.
--
-- This is also backup insurance the company does not otherwise have: the
-- Supabase org is on the FREE plan and the backups list is empty
-- (scripts/backup-data.mjs:9-12). That script is the OPERATOR-side answer —
-- it runs as us, over the Management API, across every tenant. This migration
-- is the CUSTOMER-side answer to the same problem: the same paging idea and the
-- same manifest-of-omissions discipline (backup-data.mjs:152-169), scoped to one
-- tenant and gated by that tenant's own admin role instead of our access token.
-- Deliberately the same thinking, not a second divergent exporter.
--
-- MEASURED SURFACE (production catalog, 2026-07-26 — all re-derived at runtime)
--   257 tables in public; 216 carry tenant_id.
--   215 of those 216 export directly. The single exclusion is widget_key_secrets
--       (widget_key_id, tenant_id, secret, algo, ...) — nothing but signing-key
--       material.
--    11 more tables carry no tenant_id but reach one through a single-column
--       foreign key, and are exported through that parent: agentic_step_messages,
--       connector_actions, connector_objects, de_deployment_stages,
--       de_learned_behavior_cluster_members, de_role_assignments,
--       de_training_feedback, knowledge_gap_cluster_members, playbook_versions,
--       specialist_sources, tenant_provisioning_requests.
--       playbook_versions alone is the customer's own procedure history. Leaving
--       it out because it happens to lack a tenant_id column would have been a
--       silent hole of exactly the kind this migration exists to close.
--   => 226 tables, 0 of them without a primary key. Nothing is hardcoded: those
--      numbers are re-derived from pg_catalog on every call, so a table added
--      tomorrow is exported tomorrow, and a table that becomes unexportable is
--      NAMED in the manifest rather than quietly disappearing from it.
--
-- WHAT IS DELIBERATELY NOT EXPORTED (named in every manifest)
--   * embedding vectors — 6 exported tables carry one; knowledge_doc_chunks
--     alone is 24 MB. Derived from the customer's own text and regenerated
--     automatically, so they would dominate the archive while adding nothing.
--   * credential material — columns matching secret/password/token_hash/api_key/
--     private_key/… ship as a redaction MARKER rather than null, because null
--     reads as "you had no value here", which would be a lie. Today that is
--     de_delegation_tokens.token_hash and embed_tokens.token_hash. Whole
--     *_secrets tables are dropped entirely.
--   * auth.users, storage objects, vault secrets, edge function source, cron
--     schedules, schema DDL, RLS policies. THIS ARCHIVE IS A DATA EXTRACT, NOT A
--     SYSTEM BACKUP, and the manifest says so in those words.
--
-- SECURITY
--   Guard is can_admin_tenant_internal(p_tenant): service_role, OR the caller's
--   own tenant AND tenant_owner/tenant_admin. Tenant A naming tenant B's uuid
--   gets 42501, because the guard compares against auth_tenant_id() rather than
--   trusting the argument. Written as a positive test — never
--   "if auth.uid() is not null and ...", the fail-open shape migration 369 had to
--   go and fix, since anon's auth.uid() is NULL and skips such a check entirely.
--   Dynamic SQL: every identifier is resolved from pg_catalog FIRST and then
--   still passed through format('%I'); a table name not on the surface raises
--   before any SQL is composed. Cursor values go through format('%L') and are
--   cast to the catalog's own format_type() name. Nothing caller-supplied ever
--   reaches the query text unquoted.
--   EXECUTE goes to `authenticated` on purpose: the tenant-export edge function
--   calls these AS THE CALLER, not as service_role, so the guard is the real gate
--   rather than decoration. anon and PUBLIC are revoked — signup is open, so
--   PUBLIC here would mean the internet.
-- ============================================================================

-- ── 1. The surface: what is exportable, derived from the catalog ────────────
-- One row per exportable table. pk_columns is NULL when a table has no primary
-- key; callers must report that rather than skip it, because a silently missing
-- table is the failure mode this whole migration exists to avoid.
create or replace function public.export_tenant_surface()
returns table (
  table_name       text,
  scope            text,     -- 'tenant_id' (own column) | 'via_parent' (join)
  pk_columns       text[],
  pk_types         text[],
  data_columns     text[],   -- what the export selects, in table order
  omitted_columns  text[],   -- embeddings: never selected at all
  redacted_columns text[],   -- credentials: selected as a marker
  parent_links     jsonb     -- [{fk_column,parent_table,parent_column}] when via_parent
)
language sql
stable
security definer
set search_path = public
as $$
  with rels as (
    select c.oid, c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     -- relkind 'r' only. eval_gate and pipeline_summary are VIEWS (confirmed in
     -- pg_class, relkind='v'), so they hold no rows of their own and exporting
     -- them would only restate rows the base tables already ship.
     where n.nspname = 'public'
       and c.relkind = 'r'
       -- connector_secrets, specialist_source_secrets, widget_key_secrets.
       -- Whole-table credential stores with no useful non-secret residue.
       and c.relname not like '%\_secrets'
       -- ⚠ PLATFORM-OPERATIONS DATA WEARING A tenant_id.
       -- tenant_deletion_receipts (migration 371) carries a tenant_id so that a
       -- receipt survives the tenant it records — which is exactly what makes a
       -- catalog-driven surface pick it up. Its own COMMENT says "Platform-
       -- operations data, not tenant data", and its only protection is
       -- RLS-with-no-policy, which the SECURITY DEFINER pager below bypasses by
       -- design. Neither migration is wrong alone; the defect only exists once
       -- both are applied, which is why it needs naming here.
       -- Excluding it also keeps the customer-facing table count stable at 226
       -- rather than silently becoming 227 the day 371 lands.
       and c.relname <> 'tenant_deletion_receipts'
  ),
  direct as (
    select r.oid, r.relname
      from rels r
     where exists (select 1 from pg_attribute a
                    where a.attrelid = r.oid and a.attname = 'tenant_id'
                      and not a.attisdropped)
  ),
  links as (
    -- Single-column FKs from a non-tenant_id table into a tenant_id table.
    -- Multi-column FKs are skipped: none exist today, and half a join key cannot
    -- be shown to be tenant-scoped.
    select k.conrelid as oid,
           (select a.attname from pg_attribute a
             where a.attrelid = k.conrelid and a.attnum = k.conkey[1]) as fk_column,
           p.relname as parent_table,
           (select a.attname from pg_attribute a
             where a.attrelid = k.confrelid and a.attnum = k.confkey[1]) as parent_column
      from pg_constraint k
      join pg_class p on p.oid = k.confrelid
     where k.contype = 'f'
       and array_length(k.conkey, 1) = 1
       and k.confrelid in (select oid from direct)
       and k.conrelid  in (select oid from rels)
       and k.conrelid not in (select oid from direct)
  ),
  child as (
    select r.oid, r.relname
      from rels r
     where r.oid in (select oid from links)
       -- platform_capability_grants and platform_invites reach a tenant only
       -- through profiles. They are OUR records about platform operators, not
       -- the customer's business data, and belong in no customer's archive.
       and r.relname not like 'platform\_%'
  ),
  src as (
    select oid, relname, 'tenant_id'::text  as scope from direct
    union all
    select oid, relname, 'via_parent'::text as scope from child
  ),
  pk as (
    select i.indrelid as oid,
           array_agg(a.attname                           order by k.ord) as cols,
           array_agg(format_type(a.atttypid, a.atttypmod) order by k.ord) as types
      from pg_index i
      cross join lateral unnest(i.indkey::int[]) with ordinality as k(attnum, ord)
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
     where i.indisprimary
     group by i.indrelid
  ),
  cols as (
    select a.attrelid as oid, a.attname, a.attnum,
           -- pgvector registers vector/halfvec in public and format_type()
           -- renders them as 'vector(384)', so match typname, not the rendered
           -- text — the reason a first pass at this found zero embedding columns.
           (t.typname in ('vector', 'halfvec')) as is_embedding,
           (a.attname ~ '^(secret|password|token_hash|api_key|private_key|client_secret|access_token|refresh_token)$'
            or a.attname ~ '_(secret|password|token_hash|api_key|private_key)$'
            or a.attname like 'encrypted\_%') as is_credential
      from pg_attribute a
      join pg_type t on t.oid = a.atttypid
     where a.attnum > 0 and not a.attisdropped
       and a.attrelid in (select oid from src)
  )
  select s.relname,
         s.scope,
         pk.cols,
         pk.types,
         (select array_agg(c.attname order by c.attnum) from cols c
           where c.oid = s.oid and not c.is_embedding),
         (select coalesce(array_agg(c.attname order by c.attnum), '{}') from cols c
           where c.oid = s.oid and c.is_embedding),
         (select coalesce(array_agg(c.attname order by c.attnum), '{}') from cols c
           where c.oid = s.oid and c.is_credential),
         (select coalesce(jsonb_agg(jsonb_build_object(
                    'fk_column',     l.fk_column,
                    'parent_table',  l.parent_table,
                    'parent_column', l.parent_column) order by l.fk_column), '[]'::jsonb)
            from links l where l.oid = s.oid)
    from src s
    -- LEFT, not INNER: a PK-less table must surface as unexportable, not vanish.
    -- All 226 have a primary key today (215 single-column, 11 composite) and this
    -- must not depend on that staying true.
    left join pk on pk.oid = s.oid
   order by s.relname;
$$;

-- ── 2. The one definition of "this tenant's rows" ───────────────────────────
-- Builds a WHERE fragment in which $1 is the tenant uuid and the exported table
-- is aliased t. A pure string builder: it takes the surface row the caller
-- already holds, so the manifest's counter and the pager cannot drift into
-- describing two different sets of rows, and neither pays for a second catalog
-- scan (the manifest would otherwise re-scan pg_catalog 226 times).
create or replace function public.export_tenant_scope_sql(
  p_scope        text,
  p_parent_links jsonb
)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  l        jsonb;
  v_mine   text;
  v_any    text := '';
  v_notyours text := '';
begin
  if p_scope = 'tenant_id' then
    return 't.tenant_id = $1';
  end if;

  -- via_parent. The rule is: at least one tenant-scoped parent is MINE, and NO
  -- tenant-scoped parent belongs to a DIFFERENT tenant. The second half is what
  -- makes this safe for the multi-parent tables — de_role_assignments points at
  -- both digital_employees and playbook_definitions, and a row whose playbook
  -- belongs to someone else is withheld from both sides rather than leaked to
  -- either.
  --
  -- "is not null and <> $1" rather than "= $1" is load-bearing, and it was a
  -- live production row that proved it: tenant_provisioning_requests has one row
  -- whose requester belongs to acme-telecom and whose reviewer is a platform
  -- admin, and a platform admin's profile has tenant_id NULL by design. A
  -- stricter "every parent must be mine" test let that NULL veto the row, so the
  -- customer's own provisioning request was withheld from the customer. A parent
  -- owned by nobody is not evidence that a row belongs to someone else.
  for l in select value from jsonb_array_elements(p_parent_links) loop
    v_mine := format(
      'exists (select 1 from public.%I p where p.%I = t.%I and p.tenant_id = $1)',
      l->>'parent_table', l->>'parent_column', l->>'fk_column');
    v_any := case when v_any = '' then v_mine else v_any || ' or ' || v_mine end;
    -- A NULL fk needs no special case: the NOT EXISTS is trivially true for it.
    v_notyours := v_notyours || format(
      ' and not exists (select 1 from public.%I p where p.%I = t.%I'
      || ' and p.tenant_id is not null and p.tenant_id <> $1)',
      l->>'parent_table', l->>'parent_column', l->>'fk_column');
  end loop;

  if v_any = '' then
    raise exception 'no tenant-scoped parent link for a via_parent table'
      using errcode = '22023';
  end if;
  return '(' || v_any || ')' || v_notyours;
end;
$$;

-- ── 3. The manifest — the honest part ───────────────────────────────────────
-- Every export starts here. p_include_counts=false skips the 226 count queries
-- for a caller that only wants the shape; counts are exact rather than
-- reltuples estimates, and on the largest table today that is a 36,073-row scan.
create or replace function public.export_tenant_manifest(
  p_tenant         uuid,
  p_include_counts boolean default true
)
returns jsonb
language plpgsql
volatile                    -- writes one audit row per export; see the end of the body
security definer
set search_path = public
as $$
declare
  s             record;
  v_sql         text;
  v_where       text;
  -- Named v_count, not n: the queries below alias pg_namespace as `n`, and a
  -- plpgsql scalar sharing a name with a table alias is a resolution conflict,
  -- not a style nit.
  v_count       bigint;
  v_tables      jsonb  := '[]'::jsonb;
  v_blocked     jsonb  := '[]'::jsonb;
  v_total       bigint := 0;
  v_nonempty    int    := 0;
  v_exportable  int    := 0;
  v_surface     text[] := '{}';
  v_public_rel  int;
  v_views       int;
  v_tenant      record;
begin
  if not public.can_admin_tenant_internal(p_tenant) then
    raise exception 'not authorized to export tenant %', p_tenant using errcode = '42501';
  end if;

  select id, slug, name, status, created_at into v_tenant
    from tenants where id = p_tenant;
  if not found then
    raise exception 'tenant % not found', p_tenant using errcode = '22023';
  end if;

  for s in select * from public.export_tenant_surface() loop
    v_surface := v_surface || s.table_name;

    -- Reasons a table cannot be exported are REPORTED, never swallowed. Both
    -- conditions are empty in production today; they exist so that the day one
    -- of them stops being empty, the customer is told instead of shortchanged.
    if s.pk_columns is null then
      v_blocked := v_blocked || jsonb_build_object(
        'table', s.table_name,
        'reason', 'no primary key — rows cannot be paginated deterministically');
      continue;
    end if;
    if s.pk_columns && s.redacted_columns then
      -- The pager derives the next cursor from the last row's primary key. A
      -- redacted PK would make that cursor a marker string and paging would stop
      -- after one page: a partial export presented as a whole one.
      v_blocked := v_blocked || jsonb_build_object(
        'table', s.table_name,
        'reason', 'primary key is credential material and is redacted, so pages cannot be chained');
      continue;
    end if;

    v_exportable := v_exportable + 1;
    v_count := null;
    if p_include_counts then
      v_where := public.export_tenant_scope_sql(s.scope, s.parent_links);
      v_sql := format('select count(*) from public.%I t where %s', s.table_name, v_where);
      execute v_sql into v_count using p_tenant;
      v_total := v_total + v_count;
      if v_count > 0 then v_nonempty := v_nonempty + 1; end if;
    end if;

    v_tables := v_tables || jsonb_build_object(
      'table', s.table_name,
      'rows', v_count,
      'scope', case when s.scope = 'tenant_id'
                    then 'rows where tenant_id = your tenant'
                    else 'rows whose parent record belongs to your tenant' end,
      'primary_key', to_jsonb(s.pk_columns),
      'columns_omitted', to_jsonb(s.omitted_columns),
      'columns_redacted', to_jsonb(s.redacted_columns),
      'parent_links', s.parent_links);
  end loop;

  select count(*) filter (where c.relkind = 'r'),
         count(*) filter (where c.relkind in ('v', 'm'))
    into v_public_rel, v_views
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'v', 'm');

  -- A bulk read of every row a tenant owns is exactly the event an auditor asks
  -- about. One row per export, on the same hash-chained trail as everything else.
  perform public.append_audit_event_internal(
    p_tenant,
    coalesce(auth.uid()::text, 'service_role'),
    case when auth.uid() is null then 'system' else 'human' end,
    'tenant_data_export_started',
    'access_control',
    jsonb_build_object(
      'tables', v_exportable,
      'rows', case when p_include_counts then v_total end,
      'counts_included', p_include_counts));

  return jsonb_build_object(
    'format_version', 1,
    'generated_at', now(),
    'tenant', jsonb_build_object(
      'id', v_tenant.id, 'slug', v_tenant.slug, 'name', v_tenant.name,
      'status', v_tenant.status, 'created_at', v_tenant.created_at),
    'counts', jsonb_build_object(
      'tables_exportable', v_exportable,
      'tables_with_rows', case when p_include_counts then v_nonempty end,
      'total_rows',       case when p_include_counts then v_total end,
      'counts_included',  p_include_counts),
    'tables', v_tables,
    'not_exportable', v_blocked,

    -- ────────────────────────────────────────────────────────────────────────
    -- Read this before treating the archive as a backup. Every list below is
    -- COMPUTED from the catalog, not typed out, so none of it can go stale.
    -- ────────────────────────────────────────────────────────────────────────
    'not_included', jsonb_build_object(
      'summary',
        'This is a data extract, not a system backup. It contains your rows. '
        || 'It cannot by itself restore a working DreamTeam workspace.',
      'user_accounts',
        'Login accounts, password hashes and SSO identities are not included. '
        || 'Your team members appear in the profiles table as records, but those '
        || 'records cannot be used to sign in anywhere.',
      'files',
        'Uploaded files held in object storage are not included. Their database '
        || 'records — paths, names, extracted text — are.',
      'credentials',
        'Connector credentials, widget signing keys and API tokens are either '
        || 'excluded outright or shown as a redaction marker. They are secrets, '
        || 'and an export carrying them would be a breach waiting for a shared drive.',
      'derived_data',
        'Search embeddings are excluded — they are computed from your own text '
        || 'and are regenerated automatically.',
      'system',
        'Application source, edge functions, scheduled jobs, database schema and '
        || 'access-control policies are not included.',
      'tables_excluded_by_name', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'table', c.relname, 'reason', 'whole-table credential store')
                 order by c.relname), '[]'::jsonb)
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r'
           and c.relname like '%\_secrets'),
      'tables_not_tenant_scoped', (
        -- Platform-wide catalogs and our own operational tables. They hold no
        -- rows attributable to a single tenant, which is precisely why they are
        -- out — but the customer gets to see the list and judge for themselves.
        select coalesce(jsonb_agg(c.relname order by c.relname), '[]'::jsonb)
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r'
           and not (c.relname = any(v_surface))
           and c.relname not like '%\_secrets'),
      'views_excluded', (
        select coalesce(jsonb_agg(c.relname order by c.relname), '[]'::jsonb)
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind in ('v', 'm')),
      'coverage', format(
        '%s of the %s tables in this database are exported for your tenant. '
        || 'The remaining %s hold no rows attributable to a single tenant or are '
        || 'listed above; a further %s database views are omitted because they '
        || 'only restate rows already included.',
        coalesce(array_length(v_surface, 1), 0),
        v_public_rel,
        v_public_rel - coalesce(array_length(v_surface, 1), 0),
        v_views)
    ));
end;
$$;

-- ── 4. One page of rows ─────────────────────────────────────────────────────
-- Keyset pagination on the primary key, NOT limit/offset. Offset re-scans and
-- re-sorts everything before the window (quadratic across 36,073 audit rows),
-- and worse, a concurrent insert shifts the window so rows are duplicated or
-- skipped mid-export. A primary key does not move, so the cursor stays valid.
-- backup-data.mjs orders by ctid (line 98-99) — it can, because it runs once
-- against a database nobody else is touching. This runs against live traffic.
create or replace function public.export_tenant_table_page(
  p_tenant uuid,
  p_table  text,
  p_cursor jsonb default null,   -- ['<pk value>', ...] from the previous page
  p_limit  int  default 500
)
returns jsonb
language plpgsql
stable
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

-- ── 5. Grants ───────────────────────────────────────────────────────────────
-- CREATE OR REPLACE resets grants and Postgres hands EXECUTE to PUBLIC by
-- default, so this has to run AFTER every body above — the mistake migration 365
-- was written to clean up, 25 routines at a time.
revoke all on function public.export_tenant_surface()                          from public, anon, authenticated;
revoke all on function public.export_tenant_scope_sql(text, jsonb)             from public, anon, authenticated;
revoke all on function public.export_tenant_manifest(uuid, boolean)            from public, anon;
revoke all on function public.export_tenant_table_page(uuid, text, jsonb, int)  from public, anon;

-- Internal helpers. The two entry points run as their owner and so need no grant
-- of their own to call these; exposing export_tenant_surface() directly would
-- hand any signed-up account a complete schema map for free.
grant execute on function public.export_tenant_surface()              to service_role;
grant execute on function public.export_tenant_scope_sql(text, jsonb) to service_role;

-- Entry points. `authenticated` is intentional: the tenant-export edge function
-- calls these with the END USER's JWT, so can_admin_tenant_internal is doing real
-- work instead of being bypassed by the service role. anon stays revoked — its
-- auth.uid() is NULL and, with signup open, anon is the internet.
grant execute on function public.export_tenant_manifest(uuid, boolean)             to authenticated, service_role;
grant execute on function public.export_tenant_table_page(uuid, text, jsonb, int)  to authenticated, service_role;

comment on function public.export_tenant_manifest(uuid, boolean) is
  'Customer data export: what your archive contains and, explicitly, what it does not. Requires tenant_owner/tenant_admin on the named tenant.';
comment on function public.export_tenant_table_page(uuid, text, jsonb, int) is
  'Customer data export: one keyset-paginated page of your tenant''s rows from one table on the export surface.';
