-- ═══════════════════════════════════════════════════════════════
-- 189 — Playbook 3.0 Wave 3: retire the procedure from the DE's brain
-- when its playbook is archived.
--
-- Publishing a playbook mirrors it into a PLATFORM_PLAYBOOK knowledge
-- document (external_ref = 'playbook:{definition_id}') so the DE can follow
-- and cite the procedure in chat (done in the publish edge action). When a
-- definition is archived, the procedure should stop informing the DE — this
-- trigger flips the mirrored doc to not-current (retrieval already filters
-- is_current), so no stale procedure lingers. Re-publishing revives it.
-- ═══════════════════════════════════════════════════════════════

create or replace function public.retire_playbook_knowledge()
returns trigger
language plpgsql
security definer set search_path to 'public' as $function$
begin
  if new.status = 'archived' and coalesce(old.status, '') <> 'archived' then
    update knowledge_docs
      set is_current = false
      where tenant_id = new.tenant_id
        and external_ref = 'playbook:' || new.id::text;
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_retire_playbook_knowledge on playbook_definitions;
create trigger trg_retire_playbook_knowledge
  after update of status on playbook_definitions
  for each row execute function retire_playbook_knowledge();
