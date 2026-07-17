-- ═══════════════════════════════════════════════════════════════
-- 166 — Reclaim stale DE work items (quality-review HIGH fix)
--
-- claim_de_work_items only ever selected status='queued', so an edge
-- worker dying mid-item (timeout during its serial LLM turns) abandoned
-- the row in 'running' forever — shown eternally in-flight in the
-- Workbench, never retried, never failed. The claim now first reclaims
-- anything locked >15 minutes (far beyond a worker's real lifetime):
-- back to 'queued' when attempts remain, else 'failed' with an honest
-- error. Runs inside the same claim call — no new cron needed.
-- ═══════════════════════════════════════════════════════════════

create or replace function public.claim_de_work_items(
  p_limit  integer default 10,
  p_worker text default 'worker',
  p_tenant_id uuid default null
) returns setof de_work_items
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- Reclaim abandoned items before claiming new ones.
  update de_work_items w
     set status = case when w.attempts >= w.max_attempts then 'failed' else 'queued' end,
         last_error = case when w.attempts >= w.max_attempts
                           then coalesce(w.last_error, '') || ' [worker died mid-run; max attempts reached]'
                           else coalesce(w.last_error, '') || ' [worker died mid-run; requeued]' end,
         locked_at = null, locked_by = null, updated_at = now()
   where w.status = 'running'
     and w.locked_at is not null
     and w.locked_at < now() - interval '15 minutes';

  return query
  with due as (
    select w.id
    from de_work_items w
    where w.status = 'queued'
      and w.scheduled_for <= now()
      and (p_tenant_id is null or w.tenant_id = p_tenant_id)
      and (w.depends_on is null
           or exists (select 1 from de_work_items d where d.id = w.depends_on and d.status = 'done'))
    order by w.scheduled_for asc
    limit greatest(1, least(100, p_limit))
    for update skip locked
  )
  update de_work_items w
     set status = 'running', locked_at = now(), locked_by = p_worker,
         attempts = w.attempts + 1, updated_at = now()
    from due
   where w.id = due.id
  returning w.*;
end;
$function$;

revoke all on function public.claim_de_work_items(integer, text, uuid) from public, anon, authenticated;
grant execute on function public.claim_de_work_items(integer, text, uuid) to service_role;
