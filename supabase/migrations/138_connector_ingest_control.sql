-- ============================================================
-- 138 — connector ingest control: filters + review-before-ingest queue
--
-- Founder asked: "can we control what folders/files get ingested and
-- what should not." Two layers, matching the honest doctrine:
--   1. Source-side sharing / Sites.Selected is the real security boundary
--      (a connector can read anything it's permitted; that is not changed
--      here).
--   2. In-product ingest CONTROL — this migration — is hygiene: which of
--      the readable files actually land in the knowledge corpus.
--
-- Filters live in connectors.config->'ingest' (no schema change: jsonb):
--   { exclude_patterns: text[], allow_types: text[]|null,
--     folder: text|null, require_review: bool }
-- The review queue is a real staging table: `discover` lists candidate
-- files (filters applied) here; only status='approved' rows are ingested
-- when require_review is on. Decisions persist across re-scans.
-- ============================================================

create table if not exists connector_ingest_candidates (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  connector_id  uuid not null references connectors(id) on delete cascade,
  external_ref  text not null,                         -- sharepoint:{id} | gdrive:{id}
  title         text not null default '',
  path          text not null default '',              -- folder path within the source
  file_type     text not null default '',              -- pdf | doc | sheet | slide | text | other
  size_bytes    bigint,
  status        text not null default 'pending'
                  check (status in ('pending','approved','rejected','ingested')),
  decided_by    uuid references auth.users(id),
  decided_at    timestamptz,
  discovered_at timestamptz not null default now(),
  ingested_at   timestamptz,
  unique (connector_id, external_ref)
);
create index if not exists cic_connector_status_idx
  on connector_ingest_candidates(connector_id, status);

alter table connector_ingest_candidates enable row level security;

-- Read: any active member of the owning tenant. Writes go ONLY through the
-- role-gated RPCs below (decisions) or service_role (the discover/sync edge
-- function upserts candidates) — no direct authenticated write policy.
drop policy if exists cic_read on connector_ingest_candidates;
create policy cic_read on connector_ingest_candidates
  for select to authenticated
  using (tenant_id = auth_tenant_id());

-- ── set_connector_ingest_config: owner/admin only (credentials-adjacent,
--    matches the connectors write gate). Merges into config->'ingest'. ──
create or replace function public.set_connector_ingest_config(
  p_connector_id uuid,
  p_config jsonb
) returns void
language plpgsql security definer set search_path = public as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from connectors where id = p_connector_id;
  if v_tenant is null or v_tenant <> auth_tenant_id()
     or not auth_has_tenant_role(array['tenant_owner','tenant_admin']) then
    raise exception 'only workspace owners/admins can change a connector''s ingest settings';
  end if;
  update connectors
     set config = coalesce(config, '{}'::jsonb) || jsonb_build_object('ingest', coalesce(p_config, '{}'::jsonb))
   where id = p_connector_id;
end $$;

-- ── decide_ingest_candidates: approve/reject/reset the review queue.
--    p_refs null = act on every non-ingested candidate for the connector. ──
create or replace function public.decide_ingest_candidates(
  p_connector_id uuid,
  p_refs text[],
  p_decision text
) returns integer
language plpgsql security definer set search_path = public as $$
declare v_tenant uuid; v_count int;
begin
  if p_decision not in ('approved','rejected','pending') then
    raise exception 'decision must be approved, rejected, or pending';
  end if;
  select tenant_id into v_tenant from connectors where id = p_connector_id;
  if v_tenant is null or v_tenant <> auth_tenant_id()
     or not auth_has_tenant_role(array['tenant_owner','tenant_admin']) then
    raise exception 'only workspace owners/admins can review connector documents';
  end if;
  update connector_ingest_candidates
     set status = p_decision, decided_by = auth.uid(), decided_at = now()
   where connector_id = p_connector_id
     and status <> 'ingested'
     and (p_refs is null or external_ref = any (p_refs));
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function public.set_connector_ingest_config(uuid, jsonb) from public, anon;
grant execute on function public.set_connector_ingest_config(uuid, jsonb) to authenticated, service_role;
revoke all on function public.decide_ingest_candidates(uuid, text[], text) from public, anon;
grant execute on function public.decide_ingest_candidates(uuid, text[], text) to authenticated, service_role;
