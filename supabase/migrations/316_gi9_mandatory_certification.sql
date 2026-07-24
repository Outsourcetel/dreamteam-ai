-- 316_gi9_mandatory_certification.sql
-- ============================================================================
-- GI-9 (part 2) — certification MANDATORY-before-autonomy, opt-in + grandfathered.
--
-- Today (mig 258, deliberate) an employee with NO certification history is NOT
-- gated — "gating every uncertified DE would flip whole tenants to supervised
-- overnight." That leaves a DE running fully autonomous having never passed an
-- exam. This makes certification REQUIRED for autonomy, but only under three
-- layers of grandfathering so NOTHING flips without a deliberate human act:
--   1. Global: require_certification seeded default_enabled=false; branch (e)
--      requires an EXPLICIT per-tenant `true` override. On apply, no tenant changes.
--   2. Per-tenant: only DEs hired AFTER the opt-in (created_at > override.updated_at)
--      can be gated — every existing DE is grandfathered (reuses the override's
--      updated_at; no per-DE backfill).
--   3. Honest-exam guard: a role with no applicable active golden_qa is never gated.
--
-- FAIL DIRECTION (adversarial fixes):
--   R2: the opt-in is a DIRECT tenant_feature_overrides read (explicit-true) —
--       NEVER is_feature_enabled_internal, which FAILS OPEN on a missing key and
--       would mass-gate every tenant. Absent override / missing row = NOT gated.
--   R3: the cert/exam lookups are wrapped so any error on an OPTED-IN tenant goes
--       supervised (fails closed) and the branch never throws (so resolve_de_autonomy,
--       which callers wrap fail-OPEN, never errors from this branch).
--   R4: "certified" is archetype-scoped — an OLD role's passing cert does not count
--       after a re-scope; the DE must pass its CURRENT role's exam.
--
-- Reproduces public.de_records_gate VERBATIM from mig 307:31-105 (confirmed latest;
-- only 258/307 define it) and adds ONLY branch (e) + its declared vars. Branches
-- (a)-(d), the resolver, the covering index, and grants are untouched. GLOBAL.
-- ============================================================================

-- Seed the opt-in flag FIRST (tenant_feature_overrides.feature_key FKs to
-- feature_registry(key), so a tenant can't opt in until this row exists).
-- default_enabled=false; branch (e) does NOT consult it — it exists for the FK
-- and for the governance-settings toggle to render.
INSERT INTO feature_registry (key, label, description, default_enabled, category)
VALUES ('require_certification',
        'Require certification before autonomy',
        'When ON for a workspace, a digital employee hired after you turn this on must pass its role''s certification exam before it can act or answer autonomously. Existing employees are grandfathered; roles with no published exam are never blocked.',
        false, 'governance')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.de_records_gate(p_tenant_id uuid, p_de_id uuid)
RETURNS table(gated boolean, reasons text[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'extensions' AS $function$
declare
  v_reasons text[] := '{}';
  v_cert record;
  v_fp text;
  v_n bigint;       -- GI-4: this DE's 56d evidence-run volume
  v_failed bigint;  -- GI-4: this DE's 56d failed-run count
  v_req boolean;        -- GI-9: tenant opted into mandatory cert?
  v_req_since timestamptz;
  v_de_created timestamptz;
  v_arch text;
  v_has_exam boolean;
  v_has_pass boolean;
begin
  -- (a) Exam certifications (role_certifications): latest row decides.
  select rc.status, rc.config_fingerprint into v_cert
    from role_certifications rc
   where rc.tenant_id = p_tenant_id and rc.de_id = p_de_id
   order by rc.evaluated_at desc nulls last, rc.created_at desc limit 1;
  if found then
    if v_cert.status = 'failed' then
      v_reasons := array_append(v_reasons, 'failed_certification');
    elsif v_cert.status = 'passed' and v_cert.config_fingerprint is not null then
      v_fp := public.de_config_fingerprint(p_de_id);
      if v_fp is not null and v_fp <> v_cert.config_fingerprint then
        v_reasons := array_append(v_reasons, 'stale_certification');
      end if;
    end if;
  end if;

  -- (b) Governance certifications (de_certifications): an expired cert not
  --     superseded by a newer active one of the same type gates.
  if exists (
    select 1 from de_certifications c
     where c.tenant_id = p_tenant_id and c.de_id = p_de_id and c.status = 'expired'
       and not exists (
         select 1 from de_certifications c2
          where c2.tenant_id = p_tenant_id and c2.de_id = p_de_id
            and c2.cert_type = c.cert_type and c2.status = 'active'
            and c2.created_at > c.created_at)
  ) then
    v_reasons := array_append(v_reasons, 'expired_certification');
  end if;

  -- (c) GI-4: an OPEN CRITICAL incident on THIS employee gates. de_id is
  --     required so a tenant-level (null-de_id) incident never over-gates one
  --     employee. Self-clears the moment the incident moves off 'open'.
  if exists (
    select 1 from de_incidents i
     where i.tenant_id = p_tenant_id and i.de_id = p_de_id
       and i.status = 'open' and i.severity = 'critical'
  ) then
    v_reasons := array_append(v_reasons, 'open_critical_incident');
  end if;

  -- (d) GI-4: degraded performance gates on ERROR RATE ONLY (never escalation —
  --     escalation self-manufactures under gating; see header). Scoped to this
  --     employee, 56-day recoverable window, >=10-run sample floor so a DE with
  --     little/no run volume is never gated. Div-by-zero guarded. The inner
  --     block fails CLOSED with a distinct diagnosable reason so a throwing
  --     metric query can never bubble up and silently un-gate a fail-open path.
  begin
    select count(*)::bigint,
           count(*) filter (where er.status = 'failed')::bigint
      into v_n, v_failed
      from evidence_runs er
     where er.tenant_id = p_tenant_id and er.de_id = p_de_id
       and er.created_at > now() - interval '56 days';
    if coalesce(v_n, 0) >= 10
       and (100.0 * coalesce(v_failed, 0) / nullif(v_n, 0)) > 15 then
      v_reasons := array_append(v_reasons, 'degraded_metrics');
    end if;
  exception when others then
    v_reasons := array_append(v_reasons, 'metrics_check_unavailable');
  end;

  -- (e) GI-9: MANDATORY CERTIFICATION — opt-in per tenant (default off),
  --     grandfathered by hire date, honest per CURRENT role. A DE that has never
  --     passed its current role's exam is supervised, but ONLY when (i) the tenant
  --     explicitly opted in, (ii) the DE was hired AFTER opt-in, (iii) an exam
  --     actually exists for its role. Opt-in is an EXPLICIT-true DIRECT read (never
  --     is_feature_enabled_internal, which fails OPEN). The cert/exam lookups fail
  --     CLOSED inside their own block so a throw on an opted-in tenant goes supervised.
  if p_de_id is not null then
    select tfo.enabled, tfo.updated_at
      into v_req, v_req_since
      from tenant_feature_overrides tfo
     where tfo.tenant_id = p_tenant_id
       and tfo.feature_key = 'require_certification';
    if coalesce(v_req, false) then
      begin
        select d.created_at into v_de_created
          from digital_employees d
         where d.id = p_de_id and d.tenant_id = p_tenant_id;
        -- Grandfather: only DEs hired after opt-in must certify.
        if v_de_created is not null and v_de_created > v_req_since then
          v_arch := public.resolve_de_archetype(p_de_id);
          select exists (
            select 1 from golden_qa gq
             where gq.tenant_id = p_tenant_id and gq.active = true
               and (gq.archetype_key is null or gq.archetype_key = v_arch)
          ) into v_has_exam;
          select exists (
            select 1 from role_certifications rc
             where rc.tenant_id = p_tenant_id and rc.de_id = p_de_id
               and rc.status = 'passed'
               and rc.archetype_key is not distinct from v_arch
          ) into v_has_pass;
          if coalesce(v_has_exam, false) and not coalesce(v_has_pass, false) then
            v_reasons := array_append(v_reasons, 'never_certified');
          end if;
        end if;
      exception when others then
        v_reasons := array_append(v_reasons, 'certification_check_unavailable');
      end;
    end if;
  end if;

  return query select coalesce(array_length(v_reasons, 1), 0) > 0, v_reasons;
end;
$function$;
REVOKE ALL ON FUNCTION public.de_records_gate(uuid, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.de_records_gate(uuid, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
