-- ═══════════════════════════════════════════════════════════════
-- 268 — T1.4 Stage 1: situational, structure-aware SOP briefing (docs/22)
--
-- get_de_briefing (mig 250) injects ALL of a DE's published SOPs at once, and
-- flattens each to only its instruction/checklist TEXT — the decisions, gates,
-- and actions that make a procedure a procedure are dropped, and there is no
-- situational selection. So the autonomous de-work loop sees four prose dumps,
-- not the ONE relevant procedure with its real control flow.
--
-- This adds get_de_briefing_for_objective(de, objective): pick the SINGLE
-- best-matching published SOP (full-text rank vs the objective, fallback to
-- most-recent) and render its full STRUCTURE — decision points, approval gates,
-- consults, gated actions — so the DE follows the shape of the procedure, not a
-- bullet list. get_de_briefing (mig 250) is left UNTOUCHED for its UI callers.
-- Guardrail block is byte-identical to mig 250. Stage 2 (routing an objective
-- through the real playbook-execute engine) is a separate follow-on.
-- ═══════════════════════════════════════════════════════════════

-- Render a playbook's step array as a structured, human-readable outline that
-- preserves control flow. Pure/immutable; keys match the playbook step schema.
CREATE OR REPLACE FUNCTION public.render_playbook_structure(p_steps jsonb)
RETURNS text LANGUAGE sql IMMUTABLE AS $function$
  select string_agg(
    s.ord || '. ' || coalesce(s.elem->>'label', s.elem->>'key', 'step') ||
    case s.elem->>'key'
      when 'instruction'     then coalesce(' — ' || (s.elem->'params'->>'body_md'), '')
      when 'checklist'       then ' — checklist: ' || coalesce((select string_agg(i.value #>> '{}', '; ')
                                                                from jsonb_array_elements(s.elem->'params'->'items') i), '')
      when 'decision'        then ' — DECISION: if ' || coalesce(s.elem->'params'->>'on','(prior step)') || ' '
                                    || coalesce(s.elem->'params'->>'operator','') || ' ' || coalesce(s.elem->'params'->>'value','')
                                    || ' then ' || coalesce(jsonb_array_length(s.elem->'then_steps')::text,'0') || ' step(s), else '
                                    || coalesce(jsonb_array_length(s.elem->'else_steps')::text,'0')
      when 'human_approval'  then ' — GATE: pause here for human approval before continuing'
      when 'guardrail_check' then ' — GUARDRAIL CHECK: ' || coalesce(s.elem->'params'->>'check','')
      when 'consult_specialist' then ' — CONSULT a specialist: ' || coalesce(s.elem->'params'->>'question_template','')
      when 'check_knowledge' then ' — CHECK KNOWLEDGE for: ' || coalesce(s.elem->'params'->>'query_template','')
      when 'agentic_step'    then ' — JUDGMENT STEP (use tools to): ' || coalesce(s.elem->'params'->>'instructions', s.elem->'params'->>'goal_template','')
      when 'custom_step'     then ' — JUDGMENT STEP (use tools to): ' || coalesce(s.elem->'params'->>'instructions', s.elem->'params'->>'goal_template','')
      when 'connector_action' then ' — ACTION: ' || coalesce(
                                      s.elem->'params'->>'action_key',
                                      nullif((s.elem->'params'->>'provider') || '.' || (s.elem->'params'->>'op'), '.'),
                                      nullif((s.elem->'params'->>'category') || '.' || (s.elem->'params'->>'op'), '.'),
                                      'connector action') || ' (routed through the approval/guardrail gates)'
      when 'generate_invoice' then ' — ACTION: generate an invoice (gated for approval)'
      when 'update_record'   then ' — ACTION: update a record (gated)'
      when 'wait'            then ' — WAIT ' || coalesce(s.elem->'params'->>'duration_minutes','?') || ' minutes, then resume'
      when 'complete'        then ' — (procedure ends here)'
      else ''
    end, E'\n' order by s.ord)
  from jsonb_array_elements(p_steps) with ordinality as s(elem, ord);
$function$;

CREATE OR REPLACE FUNCTION public.get_de_briefing_for_objective(p_de_id uuid, p_objective text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
declare
  v_tenant uuid; v_sop text; v_guard text; v_pid uuid; v_name text; v_by_rel boolean := false;
begin
  select tenant_id into v_tenant from digital_employees where id = p_de_id;
  if v_tenant is null then
    return jsonb_build_object('sop','','guardrails','','matched_playbook_id',null,'matched_by_relevance',false);
  end if;

  -- Best-matching published SOP by full-text rank vs the objective; fallback to
  -- most-recent (empty/nonsense objective → all ranks 0 → most-recent wins).
  select pd.id, pd.name, render_playbook_structure(pd.steps),
         (ts_rank(to_tsvector('english', coalesce(pd.name,'') || ' ' || coalesce(pd.description,'')),
                  plainto_tsquery('english', coalesce(p_objective,''))) > 0)
    into v_pid, v_name, v_sop, v_by_rel
  from playbook_definitions pd
  where pd.de_id = p_de_id and pd.status = 'published'
  order by ts_rank(to_tsvector('english', coalesce(pd.name,'') || ' ' || coalesce(pd.description,'')),
                   plainto_tsquery('english', coalesce(p_objective,''))) desc nulls last,
           pd.updated_at desc
  limit 1;

  -- Guardrail block — byte-identical to get_de_briefing (mig 250:48-62).
  select string_agg('- ' ||
    case r.rule_type
      when 'blocked_phrase' then 'Never commit to / say: ' || coalesce(r.pattern,'')
      when 'blocked_topic'  then 'Do not act on topic: ' || coalesce(r.pattern,'')
      when 'max_discount_pct' then 'Any discount above ' || coalesce(r.threshold::text,'0') || '% must be proposed for human approval'
      when 'require_approval_over_cents' then 'Any amount over $' || to_char(coalesce(r.threshold,0)/100.0,'FM999,999,990.00') || ' must be proposed for human approval'
      when 'frustration_signal' then 'Escalate to a human on: ' || coalesce(r.pattern,'')
      else coalesce(r.rule,'')
    end, E'\n')
  into v_guard
  from guardrail_rules_for_de(v_tenant, p_de_id,
       ARRAY['blocked_phrase','blocked_topic','max_discount_pct','require_approval_over_cents','frustration_signal'],
       null) r
  where r.active;

  return jsonb_build_object(
    'sop', case when v_sop is not null and v_name is not null then '## ' || v_name || E'\n' || v_sop else '' end,
    'guardrails', coalesce(v_guard,''),
    'matched_playbook_id', v_pid,
    'matched_by_relevance', coalesce(v_by_rel,false)
  );
end;
$function$;

NOTIFY pgrst, 'reload schema';
