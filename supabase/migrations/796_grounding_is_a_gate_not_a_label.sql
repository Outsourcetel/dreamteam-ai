-- 796_grounding_is_a_gate_not_a_label.sql
-- ==========================================================================
-- WHY: required_connector_categories was DECORATIVE (single reader: the
-- Record tab display). Nothing stopped hiring an SEO employee with nothing
-- to read — it would run ungrounded and produce plausible generic content.
-- With BPO clients connecting THEIR OWN systems (program decision
-- 2026-08-11), an ungrounded hire is a customer-facing lie, not hygiene.
--
-- The gate lands at ASSIGNED — the stage where work begins: every category
-- the archetype requires must have a CONNECTED connector in this tenant.
-- No archetype / no requirements ⇒ trivially grounded (genericity rule: a
-- bespoke employee is not penalised for having no template). The hire
-- wizard already renders readiness criteria as plain-language to-dos, so
-- this appears there with zero UI changes.
--
-- Both function bodies below were GENERATED from pg_get_functiondef of the
-- live definitions and edited surgically — never retyped (the mig-377
-- lesson: retyping from memory silently dropped keyset pagination).
-- ==========================================================================

begin;

CREATE OR REPLACE FUNCTION public.compute_de_lifecycle_readiness(p_de_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_de digital_employees;
  v_tenant uuid;
  v_identity boolean;
  v_grants boolean;
  v_knowledge boolean;
  v_policies boolean;
  v_embedded boolean;
  v_qa_passed boolean;
  v_certified boolean;
  v_channel boolean;
  v_grounding jsonb;
  v_executed boolean;
begin
  select * into v_de from digital_employees where id = p_de_id;
  if v_de.id is null then return jsonb_build_object('error', 'not_found'); end if;
  v_tenant := v_de.tenant_id;

  -- Humans must belong to the workspace; trusted server contexts pass.
  if auth.role() is not null and auth.role() <> 'service_role' then
    if auth_tenant_id() is distinct from v_tenant then
      raise exception 'not a member of this workspace';
    end if;
    if not public.can_access_de(p_de_id) then
      return jsonb_build_object('error', 'not_found');
    end if;
  end if;

  v_identity := coalesce(v_de.name, '') <> '' and coalesce(v_de.description, '') <> ''
    and (coalesce(v_de.department, '') <> '' or coalesce(v_de.workspace, '') <> '')
    and coalesce(array_length(v_de.responsibilities, 1), 0) >= 1;

  v_grants := exists (select 1 from data_access_grants
    where tenant_id = v_tenant and subject_kind = 'de' and subject_id = p_de_id);

  v_knowledge := exists (select 1 from knowledge_docs d
    where d.tenant_id = v_tenant
      and (d.visibility = 'tenant'
           or exists (select 1 from knowledge_doc_scopes s
                      where s.doc_id = d.id and s.subject_kind = 'de' and s.subject_id = p_de_id)));

  v_policies := exists (select 1 from guardrail_rules where tenant_id = v_tenant and active);

  v_embedded := exists (select 1 from knowledge_doc_chunks c
    join knowledge_docs d on d.id = c.doc_id
    where d.tenant_id = v_tenant and c.embedding is not null
      and (d.visibility = 'tenant'
           or exists (select 1 from knowledge_doc_scopes s
                      where s.doc_id = d.id and s.subject_kind = 'de' and s.subject_id = p_de_id)));

  v_qa_passed := coalesce((select r.status = 'passed' from eval_runs r
    where r.tenant_id = v_tenant
    order by coalesce(r.finished_at, r.started_at) desc limit 1), false);

  v_certified := exists (select 1 from de_lifecycle_events
    where tenant_id = v_tenant and de_id = p_de_id and to_stage = 'certified' and actor_id is not null);

  v_channel := exists (select 1 from data_access_grants g
      where g.tenant_id = v_tenant and g.subject_kind = 'de' and g.subject_id = p_de_id
        and access_permission_level(g.permission) >= access_permission_level('search'))
    or exists (select 1 from widget_keys where tenant_id = v_tenant and active);

  v_executed := exists (select 1 from evidence_runs where tenant_id = v_tenant and de_id = p_de_id);
  -- Mig 796: grounding. required_connector_categories was DECORATIVE — its one
  -- reader displayed it on the Record tab and nothing gated hiring or work, so
  -- an SEO employee could be hired with nothing to read and would run anyway,
  -- producing plausible generic content (measured 2026-07-28, still true
  -- 2026-08-11). A required category counts as met only when this tenant has a
  -- CONNECTED connector in it. No archetype, or no requirements ⇒ trivially
  -- grounded — a bespoke employee is not penalised for having no template.
  select coalesce(jsonb_object_agg(req.cat,
           exists (select 1 from connectors k
                    where k.tenant_id = v_tenant and k.category = req.cat
                      and k.status = 'connected')), '{}'::jsonb)
    into v_grounding
    from (select unnest(ra.required_connector_categories) as cat
            from digital_employees d
            join role_archetypes ra on ra.key = d.archetype_key
           where d.id = p_de_id) req;

  return jsonb_build_object(
    'stage', v_de.lifecycle_status,
    'status', v_de.status,
    'criteria', jsonb_build_object(
      'configured', jsonb_build_object(
        'identity_complete', v_identity,
        'detail', 'Name, description, a department or workspace, and at least one responsibility.'),
      'trained', jsonb_build_object(
        'control_fabric_grant', v_grants,
        'knowledge_in_scope', v_knowledge,
        'active_guardrails', v_policies,
        'detail', 'At least one system-access grant, knowledge this employee can see, and active workspace guardrails.'),
      'tested', jsonb_build_object(
        'knowledge_embedded', v_embedded,
        'detail', 'The knowledge in scope is actually searchable (embedded), so answers can cite it.'),
      'certified', jsonb_build_object(
        'golden_qa_passed', v_qa_passed,
        'scope', 'workspace',
        'detail', 'The latest golden Q&A run passed. (Suite is workspace-level today — per-employee suites arrive with Skills, DE-C1.)'),
      'published', jsonb_build_object(
        'certified_by_human', v_certified,
        'detail', 'A named workspace owner/admin recorded certification.'),
      'assigned', jsonb_build_object(
        'has_work_channel', v_channel,
        'grounding_connected', (select coalesce(bool_and(v::boolean), true) from jsonb_each_text(v_grounding) as e(k, v)),
        'grounding_by_category', v_grounding,
        'detail', 'A searchable system grant (inbox) or an active site widget key.'),
      'active', jsonb_build_object(
        'first_live_execution', v_executed,
        'detail', 'At least one real evidence run attributed to this employee.')
    )
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.advance_de_lifecycle(p_de_id uuid, p_to_stage text, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid;
  v_de digital_employees;
  v_readiness jsonb;
  v_ok boolean;
  v_actor_name text;
  v_expected_from text;
begin
  v_tenant := auth_tenant_id();
  if v_tenant is null then raise exception 'not a member of any tenant'; end if;
  if not auth_has_tenant_role(array['tenant_owner', 'tenant_admin']) then
    raise exception 'only workspace owners/admins can advance an employee''s lifecycle';
  end if;

  select * into v_de from digital_employees where id = p_de_id and tenant_id = v_tenant;
  if v_de.id is null then raise exception 'employee not found in this workspace'; end if;
  if v_de.lifecycle_status in ('retired', 'archived') then
    raise exception 'this employee is retired — its lifecycle is closed';
  end if;
  if v_de.lifecycle_status = 'paused' then
    raise exception 'this employee is paused — use resume first';
  end if;

  v_expected_from := case p_to_stage
    when 'configured' then 'designed'
    when 'trained'    then 'configured'
    when 'tested'     then 'trained'
    when 'certified'  then 'tested'
    when 'published'  then 'certified'
    when 'assigned'   then 'published'
    when 'active'     then 'assigned'
    else null
  end;
  if v_expected_from is null then
    raise exception 'stage "%" is not reachable through advance (pause/resume/retire have their own controls)', p_to_stage;
  end if;
  if v_de.lifecycle_status <> v_expected_from then
    raise exception 'cannot advance to "%" from "%" — the chain is designed → configured → trained → tested → certified → published → assigned → active', p_to_stage, v_de.lifecycle_status;
  end if;

  v_readiness := compute_de_lifecycle_readiness(p_de_id);
  v_ok := case p_to_stage
    when 'configured' then (v_readiness->'criteria'->'configured'->>'identity_complete')::boolean
    when 'trained'    then (v_readiness->'criteria'->'trained'->>'control_fabric_grant')::boolean
                       and (v_readiness->'criteria'->'trained'->>'knowledge_in_scope')::boolean
                       and (v_readiness->'criteria'->'trained'->>'active_guardrails')::boolean
    when 'tested'     then (v_readiness->'criteria'->'tested'->>'knowledge_embedded')::boolean
    when 'certified'  then (v_readiness->'criteria'->'certified'->>'golden_qa_passed')::boolean
    when 'published'  then (v_readiness->'criteria'->'published'->>'certified_by_human')::boolean
    when 'assigned'   then (v_readiness->'criteria'->'assigned'->>'has_work_channel')::boolean
                           and coalesce((v_readiness->'criteria'->'assigned'->>'grounding_connected')::boolean, true)
    when 'active'     then (v_readiness->'criteria'->'active'->>'first_live_execution')::boolean
  end;
  if not coalesce(v_ok, false) then
    return jsonb_build_object('ok', false, 'blocked', true, 'readiness', v_readiness,
      'reason', format('Entry criteria for "%s" are not met yet — see readiness.', p_to_stage));
  end if;

  if p_to_stage = 'certified' and (p_note is null or trim(p_note) = '') then
    raise exception 'certification requires a note stating what was reviewed';
  end if;

  select full_name into v_actor_name from profiles where user_id = auth.uid();

  update digital_employees set
    lifecycle_status = p_to_stage,
    status = case when p_to_stage in ('assigned', 'active') then 'active' else status end,
    updated_at = now()
  where id = p_de_id;

  insert into de_lifecycle_events (tenant_id, de_id, from_stage, to_stage, actor_id, actor_label, note, criteria_snapshot)
  values (v_tenant, p_de_id, v_de.lifecycle_status, p_to_stage, auth.uid(), coalesce(v_actor_name, 'A workspace admin'), p_note, v_readiness);

  -- §9.5 (migration 129): the lifecycle checkpoint also issues the
  -- durable, expiring workspace certification.
  if p_to_stage = 'certified' then
    insert into de_certifications (tenant_id, de_id, cert_type, scope, note, issued_by, issued_by_name, expires_at)
    values (v_tenant, p_de_id, 'workspace', 'Pre-launch lifecycle certification', trim(p_note), auth.uid(),
            coalesce(v_actor_name, 'A workspace admin'), now() + interval '180 days');
  end if;

  perform append_audit_event_internal(
    v_tenant, coalesce(v_actor_name, 'A workspace admin'), 'human',
    format('%s advanced to %s%s', v_de.name, p_to_stage,
      case when p_note is not null and p_note <> '' then format(' — "%s"', left(p_note, 160)) else '' end),
    'config_change',
    jsonb_build_object('kind', 'lifecycle_advance', 'de_id', p_de_id, 'from', v_de.lifecycle_status, 'to', p_to_stage)
  );

  return jsonb_build_object('ok', true, 'stage', p_to_stage);
end;
$function$
;

do $$
declare v jsonb;
begin
  -- The criterion must EXIST in the payload for a real employee.
  select compute_de_lifecycle_readiness(id) into v from digital_employees limit 1;
  if v is null then raise notice 'no employees to probe — shape assert skipped'; 
  elsif v->'criteria'->'assigned'->>'grounding_connected' is null then
    raise exception 'grounding_connected missing from readiness payload';
  end if;
end $$;

commit;
