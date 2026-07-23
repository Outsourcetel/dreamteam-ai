-- ═══════════════════════════════════════════════════════════════
-- 267 — Tier-0 fixes from the DE structural audit (docs/21, docs/22)
--
-- T0.1 — Archetype binding at hire. instantiate_role_archetype set catalog_id
--   but NOT archetype_key, and resolve_de_archetype reads only archetype_key
--   (NULL until certification, never catalog_id). Net: a freshly hired role
--   DE was examined on UNIVERSAL questions only — the exact bug mig 265 fixed,
--   reintroduced at the hire boundary.
--
-- T0.2 — Vacuous compliance-pack promise. Every archetype seeded an empty
--   compliance_pack_keys, so the hire's auto-attach loop ran zero times and
--   the "mandatory compliance packs apply from the first answer" promise was
--   empty. attach_compliance_pack materializes pack rules into enforced,
--   un-toggleable guardrail_rules — so populating role-intrinsic packs makes
--   the promise real. Compliance is role/industry-intrinsic: financial
--   controls for finance roles, TCPA (do-not-call) for outreach roles. HIPAA
--   stays tenant-attachable (industry-specific, not role-universal).
-- ═══════════════════════════════════════════════════════════════

-- ── T0.1a: set archetype_key at hire (alongside catalog_id) ──
create or replace function public.instantiate_role_archetype(
  p_tenant_id uuid, p_archetype_key text, p_de_name text, p_persona_name text default null
) returns uuid
language plpgsql security definer set search_path to 'public' as $function$
declare a role_archetypes; v_de uuid; v_pack text;
begin
  if auth.uid() is not null and not exists (
      select 1 from profiles p where p.user_id = auth.uid()
      and (p.layer = 'platform' or (p.tenant_id = p_tenant_id and p.role in ('tenant_owner','tenant_admin','tenant_manager')))) then
    raise exception 'not authorized to hire a DE for this tenant';
  end if;
  select * into a from role_archetypes where key = p_archetype_key and status = 'active';
  if a.key is null then raise exception 'unknown archetype %', p_archetype_key; end if;

  insert into digital_employees (tenant_id, name, persona_name, description, category, department,
    lifecycle_status, trust_level, status, capabilities, responsibilities, model_provider, model_id,
    catalog_id, archetype_key)
  values (p_tenant_id, p_de_name, p_persona_name, a.description, 'Customer', a.domain,
    'designed', 'supervised', 'idle', a.required_capabilities, a.responsibilities, 'anthropic', a.recommended_model,
    a.key, a.key)
  returning id into v_de;

  -- Auto-attach the archetype's mandatory compliance packs (now populated).
  foreach v_pack in array a.compliance_pack_keys loop
    perform public.attach_compliance_pack(p_tenant_id, v_pack);
  end loop;

  return v_de;
end;
$function$;

-- ── T0.1b: catalog_id fallback in the canonical resolver (belt & suspenders
--   for DEs hired before this fix and never certified) ──
create or replace function resolve_de_archetype(p_de_id uuid)
returns text
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select archetype_key from digital_employees where id = p_de_id),
    (select catalog_id from digital_employees where id = p_de_id),
    (select archetype_key from role_certifications
      where de_id = p_de_id and archetype_key is not null
      order by created_at desc limit 1)
  );
$$;

-- ── T0.1c: backfill existing role DEs whose archetype_key never got set ──
update digital_employees d
   set archetype_key = catalog_id
 where archetype_key is null
   and catalog_id is not null
   and exists (select 1 from role_archetypes a where a.key = d.catalog_id);

-- ── T0.2: populate role-intrinsic compliance packs on the catalog ──
-- Finance roles → financial controls (SoD, approval thresholds, audit trail).
update role_archetypes
   set compliance_pack_keys = array['financial_controls']
 where key in ('accounting','fpa','billing_ar')
   and coalesce(array_length(compliance_pack_keys,1),0) = 0;

-- Outreach roles → TCPA / do-not-call (they contact prospects/customers).
update role_archetypes
   set compliance_pack_keys = array['tcpa_dnc']
 where key in ('bdr','sdr','marketing','google_ads')
   and coalesce(array_length(compliance_pack_keys,1),0) = 0;

-- (hipaa is industry-specific — a healthcare tenant attaches it directly;
--  not stamped on a generic role.)
