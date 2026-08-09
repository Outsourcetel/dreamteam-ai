-- 650_the_live_employee_gets_the_new_job.sql
-- ============================================================================
-- Mig 649 rewrote the archetype, which governs every FUTURE onboarding hire.
-- The employee already working does not re-read its archetype: it runs the
-- procedure published against it, which still says assess-chase-report.
--
-- ⚠ EXTEND THE EXISTING DEFINITION. DO NOT PUBLISH A SECOND ONE. The runtime
-- picks among an employee's published procedures with NO ORDERING and takes
-- whichever the database returns first — and 14 employees already carry more
-- than one (up to five). Adding a second here would make which job this
-- employee does a coin flip on every wake. So this bumps the one that exists.
--
-- The steps come FROM the archetype rather than being retyped, so the live
-- procedure and the one every future hire receives cannot drift apart. There is
-- exactly one authored copy of this job description, in mig 649.
-- ============================================================================

begin;

do $$
declare
  v_steps   jsonb;
  v_updated int;
  v_dupes   int;
begin
  select sop_playbook->'steps' into v_steps from role_archetypes where key = 'onboarding';
  if v_steps is null or jsonb_array_length(v_steps) = 0 then
    raise exception '650: the onboarding archetype has no procedure to publish';
  end if;

  -- Version history first, so the old procedure remains readable. An audit
  -- trail you overwrite is not an audit trail.
  insert into playbook_versions (definition_id, version, steps, published_at)
  select d.id, d.version, d.steps, now()
    from playbook_definitions d
    join digital_employees de on de.id = d.de_id
   where de.archetype_key = 'onboarding'
     and d.status = 'published'
     and not exists (select 1 from playbook_versions v
                      where v.definition_id = d.id and v.version = d.version);

  update playbook_definitions d
     set steps       = v_steps,
         name        = 'Customer Setup SOP',
         description  = 'How this employee takes a signed-up customer to a configured, verified system.',
         version     = d.version + 1,
         updated_at  = now()
    from digital_employees de
   where de.id = d.de_id
     and de.archetype_key = 'onboarding'
     and d.status = 'published';

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise notice '650: no published onboarding procedure here — nothing to update (expected on dev/replay)';
    return;
  end if;

  -- The trap this migration exists to avoid: more than one published procedure
  -- for the same employee makes its job non-deterministic.
  select count(*) into v_dupes from (
    select d.de_id from playbook_definitions d
      join digital_employees de on de.id = d.de_id
     where de.archetype_key = 'onboarding' and d.status = 'published'
     group by d.de_id having count(*) > 1) x;
  if v_dupes > 0 then
    raise exception '650: % onboarding employee(s) now have MORE THAN ONE published procedure — which job they do is a coin flip', v_dupes;
  end if;

  -- And it must be the new job, not the old one wearing a new version number.
  if exists (
    select 1 from playbook_definitions d
      join digital_employees de on de.id = d.de_id
      , jsonb_array_elements(d.steps) s
     where de.archetype_key = 'onboarding' and d.status = 'published'
       and (s->>'title' ilike '%who to chase%' or s->>'title' ilike '%status update%')) then
    raise exception '650: the live procedure still chases and reports';
  end if;
  if not exists (
    select 1 from playbook_definitions d
      join digital_employees de on de.id = d.de_id
      , jsonb_array_elements(d.steps) s
     where de.archetype_key = 'onboarding' and d.status = 'published'
       and s->>'tool' = 'verify_in_system') then
    raise exception '650: the live procedure never verifies a change landed';
  end if;

  raise notice '650: % live onboarding procedure(s) now do the implementation job', v_updated;
end $$;

commit;
