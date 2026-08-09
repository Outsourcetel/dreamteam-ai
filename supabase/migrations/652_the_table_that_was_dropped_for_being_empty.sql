-- 652_the_table_that_was_dropped_for_being_empty.sql
-- ============================================================================
-- `media_assets` does not exist in production. Three live code paths write to
-- it and read from it. A Playbook Builder document upload therefore succeeds at
-- storing the file and then throws PGRST205, leaving an orphan in a bucket that
-- still exists.
--
-- HOW IT HAPPENED, because the mechanism matters more than the fix. The table
-- served TWO purposes. Migration 024 created it for specialist media. Migration
-- 031 then repurposed it — `alter table media_assets add column definition_id
-- references playbook_definitions` — plus the private `playbook-media` bucket
-- that is still there today. Migration 611 retired the specialist role and
-- dropped it as a "specialist-only table", justified in its own header by
-- MEASURED EVIDENCE: `0 specialist_sources, 0 scribe_requests, 0 media_assets`.
--
-- The row count was real. The conclusion was wrong. Zero rows meant the
-- playbook-media feature was UNUSED, not that the table was DEAD — and 611
-- validated the drop on ROWS instead of on CALLERS. Every previous audit here
-- has checked schema → code; nobody ran code → schema until now. Doing so found
-- exactly two tables referenced by live code and missing from production.
--
-- WHAT THIS RECREATES: only the playbook half, shaped to what the surviving
-- callers actually use, not a resurrection of the specialist table.
--   src/lib/playbookBuilderApi.ts:976  INSERT tenant_id, definition_id, kind,
--                                      title, storage_path, mime, size_bytes, created_by
--   src/lib/playbookBuilderApi.ts:996  SELECT storage_path
--   supabase/functions/playbook-execute/index.ts:2132
--                                      SELECT id, storage_path, mime, kind
-- The `profile_id` column 611's header referred to is NOT recreated: nothing
-- reads it, and specialists are retired.
-- ============================================================================

begin;

-- The bucket half of the feature. Production still has it (created by 031 on
-- 2026-07-05) — only the table was dropped. Dev never had it, and a migration
-- that restores half a feature and then asserts the other half exists is not
-- replayable anywhere. Idempotent insert, byte-for-byte the one 031 used.
insert into storage.buckets (id, name, public)
values ('playbook-media', 'playbook-media', false)
on conflict (id) do nothing;

create table if not exists public.media_assets (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  -- on delete SET NULL, exactly as 031 had it: deleting a playbook must not
  -- silently destroy an uploaded document that a person may still need.
  definition_id uuid references public.playbook_definitions(id) on delete set null,
  kind          text not null check (kind in ('document', 'image', 'video')),
  title         text not null default '',
  storage_path  text not null,
  mime          text not null default '',
  size_bytes    bigint not null default 0,
  created_by    uuid,
  created_at    timestamptz not null default now()
);

create index if not exists media_assets_tenant_idx on public.media_assets(tenant_id);
create index if not exists media_assets_definition_idx on public.media_assets(definition_id)
  where definition_id is not null;

-- A new table is readable by default until RLS is on. This repo has shipped
-- exactly that mistake before, so it is enabled before anything can reach it.
alter table public.media_assets enable row level security;

drop policy if exists media_assets_tenant_read on public.media_assets;
create policy media_assets_tenant_read on public.media_assets
  for select to authenticated
  using (tenant_id in (select p.tenant_id from public.profiles p
                        where p.user_id = auth.uid() and coalesce(p.is_active, true)));

drop policy if exists media_assets_tenant_write on public.media_assets;
create policy media_assets_tenant_write on public.media_assets
  for insert to authenticated
  with check (tenant_id in (select p.tenant_id from public.profiles p
                             where p.user_id = auth.uid() and coalesce(p.is_active, true)));

drop policy if exists media_assets_tenant_delete on public.media_assets;
create policy media_assets_tenant_delete on public.media_assets
  for delete to authenticated
  using (tenant_id in (select p.tenant_id from public.profiles p
                        where p.user_id = auth.uid() and coalesce(p.is_active, true)));

-- ── Prove it against what the code actually needs. ────────────────────────
do $$
declare
  v_missing text;
  v_rls     boolean;
  v_pol     int;
begin
  -- Every column the three call sites name must exist, or the upload path is
  -- still broken and this migration only looks like a fix.
  select string_agg(c, ', ') into v_missing
    from unnest(array['id','tenant_id','definition_id','kind','title',
                      'storage_path','mime','size_bytes','created_by','created_at']) c
   where not exists (select 1 from information_schema.columns
                      where table_schema='public' and table_name='media_assets'
                        and column_name = c);
  if v_missing is not null then
    raise exception '652: media_assets is missing column(s) the live callers use: %', v_missing;
  end if;

  select relrowsecurity into v_rls from pg_class
   where oid = 'public.media_assets'::regclass;
  if not v_rls then raise exception '652: media_assets shipped without RLS'; end if;

  select count(*) into v_pol from pg_policies
   where schemaname='public' and tablename='media_assets';
  if v_pol < 3 then raise exception '652: expected read/insert/delete policies, found %', v_pol; end if;

  -- The bucket the callers upload to must still be there, or restoring the
  -- table fixes the second half of a two-part failure and not the first.
  if not exists (select 1 from storage.buckets where id = 'playbook-media') then
    raise exception '652: the playbook-media bucket is gone — the upload path is still broken';
  end if;

  raise notice '652: media_assets restored for playbook media; all 10 caller columns present, RLS on, % policies, bucket present', v_pol;
end $$;

commit;
