# Supabase privilege escalations — three requests that need `supabase_admin`

**Project:** `rfsvmhcqeiyrxivbmpel` (production)
**Raised:** 2026-08-21
**Contact:** bkhan@outsourcetel.com
**Status of every item below:** measured on production, inside transactions that
were rolled back. Nothing here is inferred from documentation.

---

## Read this first — why we are asking rather than doing

The `postgres` role on this project is **not** a superuser and is **not** a
member of `supabase_admin` or `supabase_storage_admin`:

```sql
select rolsuper from pg_roles where rolname = 'postgres';   -- false
select r.rolname from pg_auth_members m
  join pg_roles r on r.oid = m.roleid
  join pg_roles g on g.oid = m.member
 where g.rolname = 'postgres';
-- anon, approval_brief_writer, authenticated, authenticator,
-- pg_create_subscription, pg_monitor, pg_read_all_data, pg_signal_backend,
-- service_role, supabase_privileged_role, trust_pattern_proposer
```

Every grant in the three items below has a **grantor** we are not and cannot
become. PostgreSQL does not raise when the revoker is not the grantor — it
issues a `WARNING` and continues, and the Management API discards warnings. So
the obvious repair **runs clean, reports success, and removes nothing.** We
have deliberately shipped no migration for any of these, because one would have
applied cleanly, entered our migration ledger, and closed the finding having
done nothing at all.

Two of the three have a direct precedent in Supabase's own defaults: schemas
`cron` and `vault` are already scoped so that neither `anon` nor
`authenticated` holds `USAGE`. These are scoping requests in that style, not
novel ones.

---

## Request 1 — schema `net` (pg_net) is reachable by `anon` and `authenticated`

**Internal id:** A-3 · **Severity:** latent, not live (see *Exposure* below) ·
**Owner of the objects:** `supabase_admin`

### What is open

Sixteen objects in schema `net` are reachable by `anon` and/or `authenticated`:

| what | how many | how |
|---|---|---|
| routines (`http_post`, `http_get`, `http_delete`, `_http_collect_response`, `wake`, `worker_restart`, …) | 12 | `proacl` is `NULL`, i.e. the built-in default, which for a function **is** `EXECUTE TO PUBLIC` |
| `net.http_request_queue`, `net._http_response` | 2 | an **explicit** `PUBLIC` grant of `arwdDxtm` |
| `net.http_request_queue_id_seq` | 1 | as above |
| schema `net` itself | 1 | `USAGE` granted to `PUBLIC`, `anon` and `authenticated` **by name** |

The table grants are the sharp end. They are not "can call `http_post`" — they
are *insert straight into the worker's queue* and *select every response body*,
and **queue rows carry the `Authorization` header of every internal dispatch
this project makes.**

### Evidence it is open

```sql
select has_function_privilege('anon', 'net.http_post(text,jsonb,jsonb,jsonb,integer)', 'EXECUTE');  -- true
select has_schema_privilege('anon', 'net', 'USAGE');                                                -- true
select has_table_privilege('anon', 'net.http_request_queue', 'INSERT');                             -- true
select relacl from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'net' and c.relname = 'http_request_queue';
-- {supabase_admin=arwdDxtm/supabase_admin,=arwdDxtm/supabase_admin}
--                                        ^ the leading '=' is PUBLIC
```

### Evidence we cannot fix it

Driven on production, 2026-08-21, top level, inside a rolled-back transaction:

```sql
revoke execute on function net.http_post(text,jsonb,jsonb,jsonb,integer) from anon, authenticated;  -- OK
revoke execute on function net.http_post(text,jsonb,jsonb,jsonb,integer) from public;               -- OK
revoke usage   on schema   net                                            from anon, authenticated, public;  -- OK
revoke all     on table    net.http_request_queue                         from public;              -- OK
-- afterwards:
--   anon EXECUTE on net.http_post       : STILL TRUE
--   anon USAGE   on schema net          : STILL TRUE
--   anon INSERT  on net.http_request_queue : STILL TRUE
```

The only visible effect is a disguise: `proacl` moves from `NULL` to
`{=X/supabase_admin,supabase_admin=X/supabase_admin}` — the ACL is
**materialised** and nothing is removed.

### What we are asking you to run — as `supabase_admin`

```sql
revoke usage on schema net from public, anon, authenticated;

revoke all on all tables    in schema net from public, anon, authenticated;
revoke all on all sequences in schema net from public, anon, authenticated;
revoke all on all functions in schema net from public, anon, authenticated;

alter default privileges for role supabase_admin in schema net
  revoke all on tables    from public, anon, authenticated;
alter default privileges for role supabase_admin in schema net
  revoke all on functions from public, anon, authenticated;
alter default privileges for role supabase_admin in schema net
  revoke all on sequences from public, anon, authenticated;
```

The `ALTER DEFAULT PRIVILEGES` lines matter as much as the revokes: without
them the next `pg_net` upgrade re-creates the objects and re-opens the hole.

### ⚠ What breaks if this is done wrong

- **`service_role`, `postgres` and `supabase_admin` must keep everything.**
  Twenty-four `SECURITY DEFINER` dispatchers owned by `postgres` call
  `net.http_post`, driven by roughly forty `pg_cron` jobs. They execute as
  their definer, so removing `anon`/`authenticated`/`PUBLIC` does not touch
  them — but a blanket `revoke all ... from public` **that also caught
  `postgres`** would stop every scheduled dispatch in the product.
- **Do not disable or drop the `pg_net` extension.** That is not an acceptable
  substitute; it would break all of the above.
- After the change we expect
  `has_function_privilege('anon','net.http_post(...)','EXECUTE')` to be
  `false` and
  `has_function_privilege('postgres','net.http_post(...)','EXECUTE')` to stay
  `true`.

### Exposure, stated honestly

This is **latent, not live**. Schema `net` is not in this project's PostgREST
exposed-schema list. Proven from outside with the publishable anon key: a table
read (`Accept-Profile: net`) and an RPC call (`Content-Profile: net`) both
return `HTTP 406 PGRST106 — "Only the following schemas are exposed: public,
graphql_public"`, against a control request that correctly 404s inside `public`.
There is also no in-database bridge: every `net` caller is `SECURITY DEFINER`
owned by `postgres`, and the four reachable by `authenticated` take **zero**
arguments and hard-code their URL. We are asking anyway, because the grant is
the thing that turns one config flip into a full compromise.

---

## Request 2 — `storage.objects` and `storage.buckets` grant `TRUNCATE` to `anon` and `authenticated`

**Internal id:** A-1 (remainder) · **Severity:** live · **Owner of the objects:**
`supabase_storage_admin`

### What is open

```sql
select relacl from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'storage' and c.relname in ('objects','buckets');
-- {supabase_storage_admin=a*r*w*d*D*x*t*m*/supabase_storage_admin,
--  service_role=arwdDxtm/supabase_storage_admin,
--  authenticated=arwdDxtm/supabase_storage_admin,
--  anon=arwdDxtm/supabase_storage_admin,
--  postgres=a*r*w*d*D*x*t*m*/supabase_storage_admin}

select has_table_privilege('anon','storage.objects','TRUNCATE');           -- true
select has_table_privilege('authenticated','storage.objects','TRUNCATE');  -- true
select has_table_privilege('anon','storage.buckets','TRUNCATE');           -- true
select has_table_privilege('authenticated','storage.buckets','TRUNCATE');  -- true
```

**`TRUNCATE` is not policed by row-level security.** RLS filters `SELECT`,
`INSERT`, `UPDATE` and `DELETE`; `TRUNCATE` is a table-level operation and the
policies on `storage.objects` cannot see it. So any holder of a publishable anon
key or any signed-up user is one statement from emptying the object index for
**every tenant on the project** — provided they can reach a SQL surface at all.
The same is true of `storage.buckets`, where they additionally hold
`INSERT`/`UPDATE`/`DELETE` on the bucket registry itself.

### Evidence we cannot fix it

Driven on production, 2026-08-21, inside a rolled-back transaction:

```sql
revoke truncate, delete, insert, update on storage.objects from anon, authenticated;  -- RETURNED SUCCESS
revoke truncate, delete, insert, update on storage.buckets from anon, authenticated;  -- RETURNED SUCCESS
-- afterwards:
--   has_table_privilege('anon','storage.objects','TRUNCATE')          -> STILL true
--   has_table_privilege('authenticated','storage.objects','TRUNCATE') -> STILL true
--   relacl                                                            -> BYTE-IDENTICAL

alter table storage.objects owner to postgres;   -- ERROR 42501: must be owner of table objects
set role supabase_storage_admin;                 -- ERROR 42501: permission denied to set role "supabase_storage_admin"
```

Note that `postgres` **does** hold every privilege here *with grant option*
(`a*r*w*d*D*x*t*m*`). That is not sufficient:
`select_best_grantor()` therefore picks `postgres` as the grantor of the
`REVOKE`, finds no ACL entry with grantee `anon` and grantor `postgres`, and
removes nothing. Holding grant option is not the same as being the grantor.

### What we are asking you to run — as `supabase_storage_admin` (or a superuser)

```sql
revoke truncate on storage.objects from anon, authenticated;
revoke truncate on storage.buckets from anon, authenticated;
revoke insert, update, delete on storage.buckets from anon, authenticated;
```

### ⚠⚠ What breaks if this is done wrong — please read this part

**Do not revoke `SELECT`, `INSERT`, `UPDATE` or `DELETE` on
`storage.objects` from `authenticated` or `anon`.** Those four are the upload
and download path: the storage service reaches `storage.objects` as the
caller's own role, and RLS is what scopes each row to the right tenant. Removing
them does not tighten anything — it deletes the product's ability to store or
serve a file. This project has two private buckets (`playbook-media`,
`specialist-media`) and every file upload in it goes through that table.

Concretely, after the change these must all still be **true**:

```sql
has_table_privilege('authenticated','storage.objects','SELECT')  -- true
has_table_privilege('authenticated','storage.objects','INSERT')  -- true
has_table_privilege('authenticated','storage.objects','UPDATE')  -- true
has_table_privilege('authenticated','storage.objects','DELETE')  -- true
has_table_privilege('anon','storage.objects','SELECT')           -- true
has_table_privilege('authenticated','storage.buckets','SELECT')  -- true
has_table_privilege('anon','storage.buckets','SELECT')           -- true
-- and unchanged, in full, for:
--   service_role, postgres, supabase_admin, supabase_storage_admin
```

and these must be **false**:

```sql
has_table_privilege('anon','storage.objects','TRUNCATE')           -- false
has_table_privilege('authenticated','storage.objects','TRUNCATE')  -- false
has_table_privilege('anon','storage.buckets','TRUNCATE')           -- false
has_table_privilege('authenticated','storage.buckets','TRUNCATE')  -- false
```

We have a certify arm (`storage-write-perimeter`) that asserts both lists on
every run, in both directions, so we will detect a change that goes too far as
quickly as one that does not go far enough.

### What we already fixed ourselves

The *default* privileges half of this finding was ours to fix and is done —
migration `839`. Schema `storage`'s three `pg_default_acl` rows all carry
grantor `postgres`, and a role may always alter its own default privileges, so
we revoked everything from `anon` and `authenticated` there. Nothing in that
change touches an existing object; we assert the `relacl` of
`storage.objects`/`storage.buckets` before and after inside the migration, and
we drove a real upload / download / list / signed-URL round-trip against the
private `playbook-media` bucket on either side of it.

---

## Request 3 — the `public` default-ACL row whose grantor is `supabase_admin`

**Internal id:** A-2 · **Severity:** latent · **Owner of the row:**
`supabase_admin`

### What is open

```sql
select d.defaclrole::regrole::text as grantor, d.defaclobjtype, d.defaclacl::text
  from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
 where n.nspname = 'public';

-- grantor postgres,       objtype r -> {postgres=arwdDxtm/postgres,
--                                       anon=rxtm/postgres,
--                                       authenticated=rxtm/postgres,
--                                       service_role=arwdDxtm/postgres}   ← we fixed this one
-- grantor supabase_admin, objtype r -> {postgres=arwdDxtm/supabase_admin,
--                                       anon=arwdDxtm/supabase_admin,
--                                       authenticated=arwdDxtm/supabase_admin,
--                                       service_role=arwdDxtm/supabase_admin}   ← this one is open
```

Any table created in `public` **by `supabase_admin`** is therefore born with
`INSERT`, `UPDATE`, `DELETE` and `TRUNCATE` for `anon` and `authenticated`.

### Evidence we cannot fix it

```sql
alter default privileges for role supabase_admin in schema public
  revoke truncate, insert, update, delete on tables from authenticated;
-- ERROR 42501: permission denied to change default privileges
```

Same result in migration `715` (2026-08-12) and re-driven 2026-08-21. Unlike
the two items above, this one at least **says so** rather than silently
succeeding.

### What we are asking you to run — as `supabase_admin`

```sql
alter default privileges for role supabase_admin in schema public
  revoke truncate, insert, update, delete on tables from anon, authenticated;
```

To match, exactly, what `postgres`'s own row in the same schema already reads
after our migration 715.

### ⚠ What breaks if this is done wrong

- `anon` and `authenticated` must **keep** `SELECT`, `REFERENCES`, `TRIGGER`
  and `MAINTAIN` (`rxtm`) in that row. Our browser reads `public` tables through
  PostgREST as `authenticated`; a table born without `SELECT` would be
  invisible to the app until someone noticed and wrote a grant.
- `postgres` and `service_role` must keep `arwdDxtm`.
- Nothing about this changes an existing table. All 299 relations in `public`
  are owned by `postgres`, so this row has, as far as we can measure, never
  actually fired. We are asking because it is a loaded default, not because it
  is currently doing damage.

---

## Summary

| # | Item | Must run as | Exposure today | Precedent |
|---|---|---|---|---|
| 1 | schema `net` reachable by `anon`/`authenticated`/`PUBLIC` (16 objects) | `supabase_admin` | latent — `net` not exposed over REST | `cron`, `vault` already scoped this way |
| 2 | `TRUNCATE` on `storage.objects`/`storage.buckets` for `anon`/`authenticated` | `supabase_storage_admin` | live — RLS cannot police `TRUNCATE` | — |
| 3 | `public` default-ACL row, grantor `supabase_admin` | `supabase_admin` | latent — no object has ever been created by that role | matches `postgres`'s own row |

We are happy to run any verification you would like before and after. Every
statement above has been rehearsed against this project in a transaction that
was rolled back, and the results are quoted verbatim.
