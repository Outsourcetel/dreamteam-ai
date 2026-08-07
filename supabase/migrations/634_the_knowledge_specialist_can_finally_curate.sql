-- 634 — the knowledge specialist can finally curate
--
-- navAccess defines the KNOWLEDGE tier as "Manage tier plus the knowledge
-- specialist — curating knowledge is their job", and gives that role three
-- pages. The database then refused it every action on them. The role could
-- open the doors and touch nothing.
--
-- The refused surface is exactly three things, enumerated rather than guessed
-- (everything else knowledge-related is gated by the per-person knowledge ACL,
-- `knowledge_effective_level`, which the specialist already passes):
--
--   resolve_knowledge_conflict   owner/admin           deciding which of two
--                                                      documents is the source
--                                                      of truth — the single
--                                                      most curatorial act we
--                                                      have
--   knowledge_gap_policies       owner/admin           the thresholds that turn
--                                                      a knowledge gap into
--                                                      work
--   set_connector_schedule       owner/admin/manager   whether a source
--                                                      re-syncs daily
--
-- ⚠ WHAT DELIBERATELY DOES NOT MOVE. The specialist still cannot connect a
-- system, hold or purge a credential, delete a connector, or decide which
-- documents a connector may ingest. set_connector_schedule only toggles the
-- refresh cadence of a source somebody else connected — that is curation, not
-- plumbing, and the line between the two is the point of this migration.
--
-- ⚠ SPLICED, NOT RETYPED. These function bodies are long and one of them
-- returns structured jsonb; retyping them by hand to change four words is how
-- a body gets silently truncated. Each definition is read back with
-- pg_get_functiondef, the role array is widened by pattern, and the result is
-- asserted BEFORE and AFTER execution. `create or replace` also preserves the
-- existing EXECUTE grants, which matters here: migration 630 had to clean up
-- after ten functions that were re-created and re-opened to anon.

begin;

do $mig$
declare
  v_name    text;
  v_def     text;
  v_new     text;
  v_before  text;
  v_after   text;
begin
  foreach v_name in array array['resolve_knowledge_conflict', 'set_connector_schedule'] loop
    select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_name;

    if v_def is null then
      raise exception '634: % not found — nothing spliced, and a silent no-op here would look identical to success', v_name;
    end if;

    -- ⚠ Exactly one gate per function, or the pattern below would widen a
    -- check I have not read. Fail rather than guess.
    if (select count(*) from regexp_matches(v_def, 'auth_has_tenant_role', 'g')) <> 1 then
      raise exception '634: % has % auth_has_tenant_role calls, expected 1 — read it by hand', v_name,
        (select count(*) from regexp_matches(v_def, 'auth_has_tenant_role', 'g'));
    end if;

    if v_def like '%knowledge_manager%' then
      raise exception '634: % already names knowledge_manager — has this run before?', v_name;
    end if;

    -- Case and spacing differ between the two (ARRAY[...] vs array[ ... ]),
    -- so match the shape rather than a literal string.
    v_new := regexp_replace(
      v_def,
      '(auth_has_tenant_role\s*\(\s*(?:ARRAY|array)\s*\[)([^\]]*)(\])',
      '\1\2, ''knowledge_manager''\3'
    );

    if v_new = v_def then
      raise exception '634: the splice matched nothing in % — the role array is not the shape this expects', v_name;
    end if;

    -- Grants survive a replace; capture them so the claim is proven, not assumed.
    select coalesce(array_to_string(p.proacl, ','), '(default)') into v_before
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_name;

    execute v_new;

    select coalesce(array_to_string(p.proacl, ','), '(default)') into v_after
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_name;

    if v_before is distinct from v_after then
      raise exception '634: EXECUTE grants on % changed during replace: % -> %', v_name, v_before, v_after;
    end if;

    -- Post-condition. A migration that ran without doing the thing is worse
    -- than one that failed.
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_name and p.prosrc like '%knowledge_manager%'
    ) then
      raise exception '634: % still does not name knowledge_manager after the replace', v_name;
    end if;

    raise notice '634: % widened, grants unchanged (%)', v_name, v_after;
  end loop;
end $mig$;

-- knowledge_gap_policies — an RLS policy rather than a function, so it is
-- rewritten outright. Both USING and WITH CHECK, because an UPDATE is tested
-- by both and widening only one produces a row you can select but not save.
drop policy if exists knowledge_gap_policies_tenant_write on public.knowledge_gap_policies;
create policy knowledge_gap_policies_tenant_write on public.knowledge_gap_policies
  for all
  using (
    tenant_id = auth_tenant_id()
    and auth_has_tenant_role(array['tenant_owner', 'tenant_admin', 'knowledge_manager'])
  )
  with check (
    tenant_id = auth_tenant_id()
    and auth_has_tenant_role(array['tenant_owner', 'tenant_admin', 'knowledge_manager'])
  );

-- ── prove it, before anyone trusts it ────────────────────────────────────
--
-- ⚠ A service-role check proves nothing: service_role bypasses RLS and
-- auth_tenant_id() returns null for it. Assert on the DEFINITIONS instead —
-- what the database will actually test when a knowledge_manager arrives.
do $verify$
declare
  v_missing text[] := '{}';
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'resolve_knowledge_conflict'
                   and p.prosrc like '%knowledge_manager%') then
    v_missing := v_missing || 'resolve_knowledge_conflict';
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'set_connector_schedule'
                   and p.prosrc like '%knowledge_manager%') then
    v_missing := v_missing || 'set_connector_schedule';
  end if;
  if not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'knowledge_gap_policies'
                   and policyname = 'knowledge_gap_policies_tenant_write'
                   and qual like '%knowledge_manager%' and with_check like '%knowledge_manager%') then
    v_missing := v_missing || 'knowledge_gap_policies (USING and WITH CHECK)';
  end if;

  if array_length(v_missing, 1) is not null then
    raise exception '634 VERIFY FAILED — still refusing knowledge_manager: %', array_to_string(v_missing, ', ');
  end if;

  -- ⚠ And the other half of the claim: the plumbing did NOT move. If one of
  -- these ever starts naming knowledge_manager, someone has widened the line
  -- this migration exists to draw.
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public'
               and p.proname in ('set_connector_secret', 'purge_connector_secret',
                                 'decide_ingest_candidates', 'set_connector_ingest_config')
               and p.prosrc like '%knowledge_manager%') then
    raise exception '634 VERIFY FAILED — a credential or ingest-control function now admits knowledge_manager';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'connectors'
               and cmd <> 'SELECT' and coalesce(qual, with_check) like '%knowledge_manager%') then
    raise exception '634 VERIFY FAILED — the connectors table now admits knowledge_manager';
  end if;

  raise notice '634 verified: three curation gates widened, credentials and connectors untouched';
end $verify$;

commit;
