-- ═══════════════════════════════════════════════════════════════
-- 193 — Living Workforce D5 + D6: Practice Reviews on a cadence, and a
-- unified workforce P&L.
--
-- D5: every workforce citizen "goes back to school" on a schedule. A weekly
-- cron finds DEs that have been over-refusing (a real, cheap SQL signal from
-- de_messages) and, if there's no amendment already in review, asks the
-- entity-amend engine to draft ONE improvement (bounded — cost-controlled).
--
-- D6: get_workforce_economics rolls the whole workforce ledger into one
-- number set from REAL data — playbook P&L (mig 191) across all published
-- playbooks + DE headcount + the tenant's own FTE baseline.
--
-- GLOBAL: schema + functions + one cron; no tenant-specific rows.
-- ═══════════════════════════════════════════════════════════════

create or replace function public.invoke_workforce_practice_review()
returns text language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare v_secret text; v_de record; v_fired int := 0; v_req bigint;
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'playbook_dispatch_secret' limit 1;
  if v_secret is null then return 'no_secret'; end if;

  -- DEs with >=3 recent over-refusals and NO amendment already in review.
  for v_de in
    select c.de_id, c.tenant_id, count(*) as refusals
    from de_messages m
    join de_conversations c on c.id = m.conversation_id
    where m.role = 'assistant'
      and m.content ilike '%outside my guardrails%'
      and m.created_at > now() - interval '14 days'
    group by c.de_id, c.tenant_id
    having count(*) >= 3
       and not exists (
         select 1 from workforce_entity_amendments a
         where a.entity_kind = 'de' and a.entity_id = c.de_id and a.status = 'review_pending')
    order by count(*) desc
    limit 5   -- cost guard: at most 5 drafts per weekly run across all tenants
  loop
    select net.http_post(
      url := 'https://rfsvmhcqeiyrxivbmpel.supabase.co/functions/v1/entity-amend',
      body := jsonb_build_object('tenant_id', v_de.tenant_id, 'entity_kind', 'de', 'entity_id', v_de.de_id),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-dispatch-secret', v_secret),
      timeout_milliseconds := 120000
    ) into v_req;
    v_fired := v_fired + 1;
  end loop;
  return 'practice_review_fired:' || v_fired;
end; $function$;
revoke all on function public.invoke_workforce_practice_review() from public, anon, authenticated;
grant execute on function public.invoke_workforce_practice_review() to service_role;

-- Weekly, Monday 06:30 UTC. cron.schedule upserts by name — idempotent.
select cron.schedule('workforce-practice-review-weekly', '30 6 * * 1', 'select invoke_workforce_practice_review()');

-- ── D6: the whole workforce's P&L in one call ──
create or replace function public.get_workforce_economics(p_tenant_id uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare v_de_count int; v_pb_runs int; v_pb_done int; v_minutes numeric; v_ai numeric; v_value numeric; v_bl workforce_baselines;
begin
  if auth.uid() is not null and not exists (
    select 1 from profiles p where p.user_id = auth.uid()
      and (p.layer = 'platform' or p.tenant_id = p_tenant_id)) then
    raise exception 'not authorized';
  end if;

  select count(*) into v_de_count from digital_employees
    where tenant_id = p_tenant_id and lifecycle_status not in ('retired','archived');

  select count(*), count(*) filter (where r.status = 'completed')
    into v_pb_runs, v_pb_done
  from playbook_runs r join playbook_definitions d on d.id = r.definition_id
  where d.tenant_id = p_tenant_id;

  select coalesce(sum(a.cost_used_cents),0) into v_ai
  from agentic_step_runs a where a.tenant_id = p_tenant_id;

  select * into v_bl from workforce_baselines where tenant_id = p_tenant_id;
  v_minutes := v_pb_done * coalesce(v_bl.action_minutes, 15);
  v_value := case when v_bl.avg_fte_cost_monthly_usd is not null and v_bl.avg_fte_cost_monthly_usd > 0
    then round((v_minutes/60.0) * (v_bl.avg_fte_cost_monthly_usd/160.0), 2) else null end;

  return jsonb_build_object(
    'digital_employees', v_de_count,
    'playbook_runs', v_pb_runs, 'playbook_completed', v_pb_done,
    'ai_cost_usd', round(v_ai/100.0, 2),
    'human_minutes_saved', round(v_minutes, 0),
    'est_value_usd', v_value,
    'baseline_configured', v_bl.tenant_id is not null);
end; $function$;
revoke all on function public.get_workforce_economics(uuid) from public, anon;
grant execute on function public.get_workforce_economics(uuid) to authenticated, service_role;
