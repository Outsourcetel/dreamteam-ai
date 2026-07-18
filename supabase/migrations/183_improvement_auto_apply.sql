-- ═══════════════════════════════════════════════════════════════
-- 183 — Approving a knowledge fix actually publishes it (+ cron dedupe)
--
-- The knowledge_revision review card promises "Approving publishes the
-- article" — but unlike outbound drafts (mig 179) and computer-use
-- tasks (mig 182), de_improvements had NO sync trigger: a UI approval
-- updated the task and nothing else. This wires the promise:
--   • approved  → apply_improvement (the Postgres-gated publish path,
--                 migs 172/181 — the trigger adds no new authority, it
--                 just invokes the same gate the approval satisfies)
--   • rejected  → reject_improvement
-- Errors are swallowed with a WARNING so a failed apply can never roll
-- back the human's decision; the improvement then stays review_pending
-- and visibly needs attention instead of silently un-deciding the task.
--
-- Also: de-work was driven by TWO crons calling the same idle-cheap
-- dispatcher (de-work-run-5min AND de-work-tick from mig 173). Pure
-- duplication — the 5-minute job stays, the tick goes.
-- ═══════════════════════════════════════════════════════════════

create or replace function public.sync_improvement_decision() returns trigger
language plpgsql security definer set search_path to 'public' as $function$
begin
  if NEW.related_table = 'de_improvements' and NEW.status in ('approved', 'rejected')
     and OLD.status is distinct from NEW.status then
    begin
      if NEW.status = 'approved' then
        perform public.apply_improvement(NEW.related_id);
      else
        perform public.reject_improvement(NEW.related_id);
      end if;
    exception when others then
      -- Never roll back the human's decision; leave the improvement in
      -- review_pending where it is visibly stuck rather than silently lost.
      raise warning 'sync_improvement_decision: % for improvement %: %', NEW.status, NEW.related_id, SQLERRM;
    end;
  end if;
  return NEW;
end;
$function$;
drop trigger if exists trg_sync_improvement on human_tasks;
create trigger trg_sync_improvement
  after update of status on human_tasks
  for each row execute function public.sync_improvement_decision();

do $$
begin
  if exists (select 1 from cron.job where jobname = 'de-work-tick') then
    perform cron.unschedule('de-work-tick');
  end if;
end $$;
