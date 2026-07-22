-- 250_briefing_multi_sop.sql
-- ============================================================================
-- Wave 2 (truth audit docs/15): ONE playbook model. The Operating Charter's
-- de_playbook_assignments FK-references the LEGACY `playbooks` table (empty),
-- so it can never bind real playbook_definitions — the panel was inert. The
-- direct attachment (playbook_definitions.de_id) becomes the single visible
-- truth, and get_de_briefing now injects ALL of a DE's published SOPs (was:
-- single most-recent — silently dropped the rest), each titled, capped at 4.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_de_briefing(p_de_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid;
  v_sop text;
  v_guard text;
begin
  select tenant_id into v_tenant from digital_employees where id = p_de_id;
  if v_tenant is null then return jsonb_build_object('sop','','guardrails',''); end if;

  -- ALL attached, published SOPs (titled; newest first; capped at 4).
  select string_agg(sop_text, E'\n\n' order by upd desc)
  into v_sop
  from (
    select pd.updated_at as upd,
           '## ' || pd.name || E'\n' || (
             select string_agg(
               s.ord || '. ' || coalesce(s.elem->>'label','step') ||
               case
                 when s.elem->>'key' = 'instruction' and s.elem->'params'->>'body_md' is not null
                   then ' — ' || (s.elem->'params'->>'body_md')
                 when s.elem->>'key' = 'checklist'
                   then ' — ' || coalesce((select string_agg(i.value #>> '{}', '; ')
                                            from jsonb_array_elements(s.elem->'params'->'items') i), '')
                 else ''
               end, E'\n' order by s.ord)
             from jsonb_array_elements(pd.steps) with ordinality as s(elem, ord)
           ) as sop_text
    from playbook_definitions pd
    where pd.de_id = p_de_id and pd.status = 'published'
    order by pd.updated_at desc
    limit 4
  ) sops;

  -- The DE's active guardrails, rendered as rules it must honour.
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

  return jsonb_build_object('sop', coalesce(v_sop,''), 'guardrails', coalesce(v_guard,''));
end;
$function$;

NOTIFY pgrst, 'reload schema';
