-- ============================================================
-- Migration 044: NON-HUMAN-IDENTITY / CREDENTIAL INVENTORY VIEW
--
-- Gap-analysis item 26 (memory/gap_analysis_roadmap.md, Tier 2):
-- "no single view shows which DE or specialist holds which live
-- credential and grant across every connected system — the first
-- document a serious enterprise security reviewer will ask for."
-- Direct follow-up to today's adversarial multi-tenant isolation
-- audit (migrations 038-041, memory/project_isolation_audit.md) —
-- this is the VISIBILITY layer on top of what that audit secured.
--
-- THIS IS READ-ONLY REPORTING. It assembles, per machine subject
-- (a Digital Employee or a Specialist), every connected system it
-- holds ANY grant on, and for each: the permission level, whether a
-- credential is stored (boolean existence check only — the actual
-- secret value is NEVER read or returned, matching connector_secrets'
-- established zero-client-access discipline from migration 017),
-- connector health (last_ok_at/last_error_at/consecutive_failures,
-- migration 027), the subject's earned trust level for that category
-- (trust_policies.current_level, migration 025/036), and which
-- registered actions (action_definitions, migration 035) it could
-- invoke there if a write is ever attempted.
--
-- SECURITY DISCIPLINE (the exact mistake that recurred 4x today —
-- migrations 040/041/042/043 — a bare tenant_id parameter trusted
-- verbatim, or REVOKE from anon/authenticated alone leaving a bare
-- PUBLIC grant exploitable):
--   get_identity_inventory(p_tenant_id) does NOT trust p_tenant_id.
--   It derives the caller's real tenant from auth.uid() -> profiles
--   and requires p_tenant_id to match it exactly (or the caller must
--   be service_role). No role restriction beyond "member of this
--   tenant" — this mirrors the existing data_access_grants SELECT
--   policy (transparency for any tenant member), since the founder's
--   brief allows either "explicit tenant-membership check" or
--   "admin/owner only" and every sibling read surface in Governance
--   (Data Access, Trust & Architecture) is member-readable, not
--   admin-gated, for consistency of security bar.
--   EXECUTE is revoked from PUBLIC explicitly (not just anon/
--   authenticated) and re-granted only to authenticated + service_role.
-- ============================================================

-- ============================================================
-- FUNCTION: get_identity_inventory
--   Returns one row per subject × connected-system-with-a-grant.
--   A subject with NO grants anywhere still appears once (system_id
--   null) so the UI can show "no access anywhere" rather than the
--   subject silently vanishing from the report — an auditor should
--   see every identity, including ones holding nothing.
-- ============================================================
create or replace function get_identity_inventory(p_tenant_id uuid)
returns table (
  subject_kind        text,
  subject_id          uuid,
  subject_name        text,
  subject_label       text,   -- persona_name if set, else name
  subject_role        text,   -- DE category/department, or specialist key
  subject_status      text,
  connector_id        uuid,
  connector_name       text,
  connector_provider   text,
  connector_category   text,
  connector_status     text,
  connector_last_ok_at         timestamptz,
  connector_last_error_at      timestamptz,
  connector_consecutive_failures integer,
  has_stored_credential boolean,
  permission           text,     -- search | read | ingest | write_back
  permission_via        text,    -- 'connector' | 'category'
  trust_current_level   integer, -- 0..3, action_execute category, null if no policy row
  trust_target_level    integer,
  autonomy_enabled      boolean, -- de_autonomy.enabled for this category (or tenant-wide fallback)
  possible_actions       jsonb    -- [{action_key,label,destructive}] registered for this category
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_caller_tenant uuid;
  v_is_service    boolean := coalesce(auth.role(), '') = 'service_role';
begin
  -- ── EXPLICIT TENANT-MEMBERSHIP CHECK (not a bare parameter trust) ──
  if not v_is_service then
    select tenant_id into v_caller_tenant from profiles where user_id = auth.uid();
    if v_caller_tenant is null then
      raise exception 'not authenticated or no tenant membership';
    end if;
    if v_caller_tenant is distinct from p_tenant_id then
      raise exception 'not a member of this tenant';
    end if;
  end if;
  -- service_role callers pass p_tenant_id straight through (internal/
  -- trusted context only — same posture as resolve_access).

  return query
  with subjects as (
    select 'de'::text as subject_kind, d.id as subject_id, d.name as subject_name,
           coalesce(d.persona_name, d.name) as subject_label,
           coalesce(nullif(d.department, ''), d.category) as subject_role,
           d.status as subject_status
    from digital_employees d
    where d.tenant_id = p_tenant_id
    union all
    select 'specialist'::text, s.id, s.name, s.name, s.key, s.status
    from specialist_profiles s
    where s.tenant_id = p_tenant_id
  ),
  -- Every grant this subject holds, resolved against real connectors
  -- (category grants fan out to every connected system of that
  -- category; connector-specific grants target exactly one).
  grants_resolved as (
    -- category-level grants -> every connector of that category
    select g.subject_kind, g.subject_id, c.id as connector_id, g.permission, 'category'::text as via,
           g.resource_category as eff_category
    from data_access_grants g
    join connectors c on c.tenant_id = g.tenant_id and c.category = g.resource_category
    where g.tenant_id = p_tenant_id and g.resource_kind = 'category'
    union all
    -- connector-specific grants -> that one connector (wins over
    -- category — de-duplicated below by preferring 'connector' rows)
    select g.subject_kind, g.subject_id, g.resource_id as connector_id, g.permission, 'connector'::text as via,
           c.category as eff_category
    from data_access_grants g
    join connectors c on c.id = g.resource_id and c.tenant_id = p_tenant_id
    where g.tenant_id = p_tenant_id and g.resource_kind = 'connector'
  ),
  -- Collapse to one row per subject×connector: connector-specific
  -- beats category (mirrors resolve_access's resolution order).
  grants_final as (
    select distinct on (gr.subject_kind, gr.subject_id, gr.connector_id)
      gr.subject_kind, gr.subject_id, gr.connector_id, gr.permission, gr.via, gr.eff_category
    from grants_resolved gr
    order by gr.subject_kind, gr.subject_id, gr.connector_id,
             (gr.via = 'connector') desc
  ),
  secrets as (
    select cs.connector_id as secret_connector_id, true as has_secret from connector_secrets cs
  ),
  trust as (
    select tp.de_id, tp.source_category, tp.current_level, tp.target_level
    from trust_policies tp
    where tp.tenant_id = p_tenant_id and tp.action_category = 'action_execute'
  ),
  autonomy as (
    select da.source_category, da.enabled
    from de_autonomy da
    where da.tenant_id = p_tenant_id and da.action_type = 'action_execute'
  ),
  actions_by_category as (
    select ad.category,
           jsonb_agg(jsonb_build_object(
             'action_key', ad.action_key, 'label', ad.label,
             'destructive', coalesce((ad.risk->>'destructive')::boolean, true)
           ) order by ad.label) as actions
    from action_definitions ad
    where ad.status = 'active' and (ad.scope = 'platform' or ad.tenant_id = p_tenant_id)
    group by ad.category
  )
  select
    s.subject_kind, s.subject_id, s.subject_name, s.subject_label, s.subject_role, s.subject_status,
    c.id, c.display_name, c.provider, c.category, c.status,
    c.last_ok_at, c.last_error_at, c.consecutive_failures,
    coalesce(sec.has_secret, false),
    gf.permission, gf.via,
    -- trust: prefer a per-DE row scoped to this exact category, else
    -- a per-DE tenant-wide (source_category null) row. Specialists
    -- have no per-subject trust_policies row today (action_execute
    -- trust is DE-scoped) — reported as null, not fabricated.
    coalesce(
      (select tr.current_level from trust tr where tr.de_id = s.subject_id and tr.source_category = c.category),
      (select tr.current_level from trust tr where tr.de_id = s.subject_id and tr.source_category is null and s.subject_kind = 'de')
    ),
    coalesce(
      (select tr.target_level from trust tr where tr.de_id = s.subject_id and tr.source_category = c.category),
      (select tr.target_level from trust tr where tr.de_id = s.subject_id and tr.source_category is null and s.subject_kind = 'de')
    ),
    coalesce(
      (select au.enabled from autonomy au where au.source_category = c.category),
      (select au.enabled from autonomy au where au.source_category is null)
    ),
    coalesce(abc.actions, '[]'::jsonb)
  from subjects s
  left join grants_final gf on gf.subject_kind = s.subject_kind and gf.subject_id = s.subject_id
  left join connectors c on c.id = gf.connector_id
  left join secrets sec on sec.secret_connector_id = c.id
  left join actions_by_category abc on abc.category = c.category
  order by s.subject_kind, s.subject_name, c.category, c.display_name;
end;
$$;

-- ── Grant discipline: explicit PUBLIC revoke (the recurring gotcha
--    today — REVOKE from anon/authenticated alone leaves a bare
--    PUBLIC grant exploitable), then name the roles that may call it.
revoke all on function get_identity_inventory(uuid) from public;
revoke all on function get_identity_inventory(uuid) from anon;
revoke all on function get_identity_inventory(uuid) from authenticated;
grant execute on function get_identity_inventory(uuid) to authenticated, service_role;
