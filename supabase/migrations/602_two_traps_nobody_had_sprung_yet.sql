-- 602 — two traps nobody had sprung yet.
--
-- From the platform-wide duplicate audit. Both of these are dead code today;
-- both are the kind of dead code that becomes a live defect the first time
-- somebody touches it.
--
-- ── 1. `search_knowledge` — an ambiguous overload AND an audience bypass ───
--
-- Two functions share the name:
--
--   search_knowledge(p_tenant_id, p_query, p_limit)                3 args, 1 default
--   search_knowledge(p_tenant_id, p_query, p_audience, p_limit)    4 args, 2 defaults
--
-- A call passing (tenant, query, limit) matches BOTH, so PostgREST answers
-- "Could not choose the best candidate function" — the same shape that turned
-- an export into a silent rows_exported: 0 in mig 377.
--
-- But they are not two spellings of one function, and that is the real problem.
-- The 4-arg version filters on audience:
--
--     and (p_audience is null or ka.audience = p_audience or ka.audience = 'all')
--
-- The 3-arg version has NO audience clause at all. It returns every published
-- article to any caller, and it is granted to `authenticated`. In this
-- workspace `knowledge_articles` holds three rows — two `customer`, one
-- `internal`, and NONE marked `all` — so the legacy overload is the difference
-- between "internal knowledge stays internal" and "anyone signed in can read
-- it". It has no callers today: the app calls search_knowledge_docs, and the
-- digital employees' `search_knowledge` TOOL actually invokes
-- hybrid_match_knowledge. Nothing has ever gone through this door. It is still
-- an unlocked one.
--
-- Dropping the legacy arity closes the bypass and the ambiguity in one move,
-- and leaves the audience-aware function as the only answer to that name.
--
-- ── 2. Vestigial plaintext credential columns ─────────────────────────────
--
-- `connector_secrets.secret` and `specialist_source_secrets.secret` are text
-- columns sitting beside the `secret_id` that points into the Vault. They are
-- the residue of the bug mig 580 fixed, where set_connector_secret wrote every
-- customer credential in PLAINTEXT into a column nothing could read back.
--
-- Verified before removing: 0 of 2 connector rows and 0 of 0 specialist rows
-- have any value; no function writes them; the only function mentioning either
-- table in a SELECT is export_tenant_surface, which excludes every `%_secrets`
-- table wholesale; and both `*_decrypted` views read `vault.decrypted_secrets`
-- joined on secret_id, never the column being dropped.
--
-- Leaving an empty plaintext-credential column next to the encrypted one is an
-- invitation to a future writer who picks the obvious name. Removing it makes
-- the mistake impossible rather than merely unlikely.
--
-- ⚠ NOT FIXED HERE, and deliberately: the audit also flagged action_definitions
-- with no `execution_key`. That was a FALSE POSITIVE of my own detection.
-- execution_key is not the only execution path — `generate_invoice` and
-- `start_onboarding` are provider='internal' engine primitives with their own
-- playbook step types (and the Action Library already filters them out), and
-- acme-telecom's rows execute through `template_id`, with 7, 50, 23, 28 and 27
-- real executions between them. They all work. Nothing to fix.

begin;

-- ── 1. The audience-blind overload ────────────────────────────────────────

do $pre$
begin
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'search_knowledge') <> 2 then
    raise exception 'expected exactly 2 search_knowledge overloads, found % — stop and look',
      (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'search_knowledge');
  end if;
end;
$pre$;

drop function if exists public.search_knowledge(uuid, text, integer);

do $post$
declare v_src text;
begin
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'search_knowledge') <> 1 then
    raise exception 'search_knowledge is still ambiguous';
  end if;

  -- The survivor must be the one that filters by audience. Dropping the wrong
  -- arity would have removed the ambiguity and KEPT the bypass, which reviews
  -- exactly as well as the correct fix.
  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'search_knowledge';
  if v_src !~ 'p_audience' then
    raise exception 'the surviving search_knowledge does not filter on audience — the bypass is still open';
  end if;
end;
$post$;

-- ── 2. The plaintext columns ──────────────────────────────────────────────

do $safety$
declare v_c int; v_s int;
begin
  select count(*) into v_c from connector_secrets where coalesce(secret, '') <> '';
  select count(*) into v_s from specialist_source_secrets where coalesce(secret, '') <> '';
  if v_c > 0 or v_s > 0 then
    -- Dropping a populated credential column would destroy the only copy of
    -- something a customer's system depends on. Refuse and let a human look.
    raise exception 'plaintext credentials present (% connector, % specialist) — migrate them into the Vault before dropping the column', v_c, v_s;
  end if;
end;
$safety$;

alter table connector_secrets          drop column if exists secret;
alter table specialist_source_secrets  drop column if exists secret;

-- The views must still resolve: they read vault.decrypted_secrets joined on
-- secret_id and alias it AS secret, which is easy to mistake for the column
-- just removed. Selecting from them proves the difference.
do $views$
declare v_n int;
begin
  execute 'select count(*) from connector_secrets_decrypted' into v_n;
  execute 'select count(*) from specialist_source_secrets_decrypted' into v_n;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name in ('connector_secrets', 'specialist_source_secrets')
      and column_name = 'secret'
  ) then
    raise exception 'a plaintext secret column survived the drop';
  end if;

  raise notice 'plaintext credential columns removed; decrypted views still resolve through the Vault';
end;
$views$;

commit;
