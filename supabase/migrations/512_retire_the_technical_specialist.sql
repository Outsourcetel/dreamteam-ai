-- 512_retire_the_technical_specialist.sql
-- ============================================================================
-- Retiring a feature nobody understands and nobody uses.
--
-- ── THE EVIDENCE ───────────────────────────────────────────────────────────
-- 16 specialist employees exist platform-wide. Every one is called "Technical
-- Specialist" with specialist_key='technical' — the same template provisioned
-- into every tenant by provision_tenant_baseline_internal. Across all of them,
-- in the platform's entire history: 2 consultations, both against one row.
-- Zero widget bindings. Zero conversations. The founder has twice said they do
-- not know what a specialist is or how one would be made — which is itself a
-- finding: a capability that cannot be explained is not a capability.
--
-- What a specialist offered was a narrow desk another employee could ask a
-- single question. Delegation between employees already does more (a colleague
-- picks the work up as their own, under their own governance), and that path
-- IS used. So this is a thin idea sitting next to a strong one.
--
-- ── RETIRED, NOT DELETED ───────────────────────────────────────────────────
-- lifecycle_status='retired' + status='disabled' is this platform's existing,
-- REVERSIBLE instrument. Nothing is dropped: the two historical consultations
-- keep their rows, the employees keep their records, and a single UPDATE
-- restores them if this judgment turns out wrong. What stops is new use:
--   * inbound consultation grants are deactivated, so no employee is offered
--     the consult tool for them
--   * install_technical_specialist becomes a no-op, so newly provisioned
--     tenants stop inheriting one
-- de-work needs no change: it builds the consult tool from ACTIVE grants, so
-- revoking the grants removes the tool by itself.
--
-- NOT TOUCHED: the consultation machinery itself (specialist-consult,
-- spec_consultations, the grant model). If a genuine specialist is ever
-- defined, the rails are intact. This retires the empty template, not the idea.
-- ============================================================================

-- Deactivate the grants first: while they are active an employee can still be
-- offered a consult tool pointing at a retired desk.
update public.de_consultation_grants
   set active = false
 where target_de_id in (select id from digital_employees where is_specialist);

update public.digital_employees
   set lifecycle_status = 'retired',
       status = 'disabled',
       updated_at = now()
 where is_specialist
   and coalesce(lifecycle_status, '') <> 'retired';

-- Stop provisioning new ones. Reproduced from the LIVE definition (mig 377):
-- the body becomes an explicit, documented no-op rather than being dropped, so
-- every existing caller keeps working and the reason survives in the schema.
create or replace function public.install_technical_specialist(p_tenant_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- mig 512: retired. Sixteen of these were provisioned across the platform and
  -- two consultations ever resulted. Delegation between employees covers the
  -- same need and is actually used. Deliberately a no-op rather than a dropped
  -- function so existing callers (provisioning, baseline repair) keep working
  -- and this note stays attached to the reason.
  return null;
end;
$function$;

notify pgrst, 'reload schema';

-- ── PROOF ────────────────────────────────────────────────────────────────────
do $a$
declare n_active int; n_grants int; n_hist int; v_new uuid;
begin
  select count(*) into n_active from digital_employees
   where is_specialist and coalesce(lifecycle_status, '') <> 'retired';
  if n_active > 0 then
    raise exception '512: % specialist(s) are still active', n_active;
  end if;

  select count(*) into n_grants from de_consultation_grants g
    join digital_employees d on d.id = g.target_de_id
   where d.is_specialist and g.active;
  if n_grants > 0 then
    raise exception '512: % consultation grant(s) still point at a retired desk', n_grants;
  end if;

  -- History must SURVIVE. Retiring is not erasing: the two consultations that
  -- did happen are evidence of what was tried.
  select count(*) into n_hist from spec_consultations;
  if n_hist < 2 then
    raise exception '512: consultation history was destroyed (% rows left)', n_hist;
  end if;

  -- And no new one may be minted.
  v_new := install_technical_specialist((select id from tenants limit 1));
  if v_new is not null then
    raise exception '512: provisioning still creates a specialist';
  end if;

  raise notice '512: specialists retired (reversible), grants revoked, % consultation(s) of history preserved', n_hist;
end $a$;
