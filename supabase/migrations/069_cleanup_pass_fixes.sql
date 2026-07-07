-- ============================================================
-- Migration 069: two real regressions found during a full dead-code/
-- unused-build cleanup audit (2026-07-07), independently verified
-- against live function bodies (not just the audit's report) before
-- writing this fix. Neither is a new business rule — both restore
-- behavior an earlier migration deliberately established and a later
-- one accidentally dropped via CREATE OR REPLACE, the same class of
-- regression migrations 021/031/037/042/043 documented and fixed
-- repeatedly earlier in this project's history.
--
-- 1) NULL-JWT deny-by-default lost on 4 knowledge-read functions.
--    Migration 048 (exhaustive SECDEF null-bypass sweep) gave these
--    functions an explicit two-branch guard: a real user session gets
--    the tenant-membership check; a caller with auth.uid() IS NULL is
--    allowed through ONLY if it is genuinely service_role, otherwise
--    denied. Migration 059's mechanical is_active sweep touched these
--    same functions to add the is_active gate, but in doing so
--    collapsed the guard down to a single `if auth.uid() is not null
--    and ... then raise` with no else/elsif — so a null-auth.uid()
--    caller now silently skips the check entirely instead of being
--    rejected unless it's truly service_role. Verified live via
--    pg_get_functiondef before writing this fix. Not currently
--    exploitable by anon (EXECUTE is granted to authenticated/
--    service_role only, confirmed live) — but the deliberate defense-
--    in-depth 048 encoded is gone, and any future grant change or a
--    malformed/self-crafted JWT with role=authenticated but no sub
--    would silently bypass tenant isolation rather than erroring.
--    Restoring 048's exact guard shape, keeping 059's is_active gate.
--
-- 2) dispatch_due_triggers permanently missing its opportunity_won
--    branch. Migration 023 (pipeline) added a real 'opportunity_won'
--    event key, the close_opportunity_won() handoff, and a dispatcher
--    branch for it — those first two shipped live (confirmed:
--    close_opportunity_won/close_opportunity_lost/
--    opportunities_stage_guard and the widened event_key check
--    constraint all exist in the live database today), but 023's own
--    CREATE OR REPLACE of dispatch_due_triggers was authored against
--    an older base (021) that predates the charter_priority ordering
--    031/037 added — applying it verbatim would have REGRESSED
--    charter_priority, so it was correctly never applied as-is. That
--    left opportunity_won permanently unwired: the event key and the
--    close-out handoff exist, but nothing ever dispatches a playbook
--    off it. This migration adds 023's opportunity_won branch onto
--    the CURRENT live function (which already has charter_priority +
--    the restored account_at_risk branch from 037) — merging the two
--    evolutionary lines correctly instead of reverting either one.
-- ============================================================

-- ── 1a. visible_knowledge_docs ──
create or replace function public.visible_knowledge_docs(p_tenant_id uuid, p_subject_kind text default null::text, p_subject_id uuid default null::uuid)
returns table(id uuid, title text, content text, tags text[], visibility text)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if auth.uid() is not null then
    if p_tenant_id not in (select tenant_id from profiles where user_id = auth.uid() and coalesce(is_active, true) = true) then
      raise exception 'tenant access denied';
    end if;
  elsif coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'tenant access denied';
  end if;
  return query
  select d.id, d.title, d.content, d.tags, d.visibility
  from knowledge_docs d
  where d.tenant_id = p_tenant_id
    and d.is_current
    and (
      d.visibility = 'tenant'
      or (p_subject_kind is not null and p_subject_id is not null and exists (
            select 1 from knowledge_doc_scopes s
            where s.doc_id = d.id
              and s.subject_kind = p_subject_kind
              and s.subject_id = p_subject_id))
    );
end;
$function$;

-- ── 1b. count_pending_knowledge_gaps ──
create or replace function public.count_pending_knowledge_gaps(p_tenant_id uuid)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_count int;
begin
  if auth.uid() is not null then
    if p_tenant_id not in (select tenant_id from profiles where user_id = auth.uid() and coalesce(is_active, true) = true) then
      raise exception 'tenant access denied';
    end if;
  elsif coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'tenant access denied';
  end if;

  select count(*) into v_count
  from knowledge_revision_requests
  where tenant_id = p_tenant_id
    and status = 'pending_approval';

  return coalesce(v_count, 0);
end;
$function$;

-- ── 1c. search_knowledge (2-arg, ts_rank/plainto_tsquery form) ──
create or replace function public.search_knowledge(p_tenant_id uuid, p_query text, p_limit integer default 5)
returns table(id uuid, title text, body text, similarity double precision)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if auth.uid() is not null then
    if p_tenant_id not in (select tenant_id from profiles where user_id = auth.uid() and coalesce(is_active, true) = true) then
      raise exception 'tenant access denied';
    end if;
  elsif coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'tenant access denied';
  end if;
  return query
  select ka.id, ka.title, ka.body,
    ts_rank(
      to_tsvector('english', coalesce(ka.title,'') || ' ' || coalesce(ka.body,'')),
      plainto_tsquery('english', p_query)
    )::float as similarity
  from knowledge_articles ka
  where ka.tenant_id = p_tenant_id
    and ka.status = 'published'
    and to_tsvector('english', coalesce(ka.title,'') || ' ' || coalesce(ka.body,''))
        @@ plainto_tsquery('english', p_query)
  order by similarity desc
  limit p_limit;
end;
$function$;

-- ── 1d. search_knowledge (4-arg, audience-scoped, websearch_to_tsquery
-- form). This overload is `language sql` (can't RAISE), so the guard
-- has to be an inline boolean predicate rather than an early exit —
-- restoring the exact same "real member OR genuinely service_role"
-- rule, just expressed as a WHERE clause instead of an exception.
-- Previously the whole clause was `(auth.uid() IS NULL OR tenant
-- check)` -- an auth.uid() IS NULL caller got EVERY tenant's articles
-- unconditionally, worse than the plpgsql functions' bypass since
-- there wasn't even a partial guard.
-- ============================================================
create or replace function public.search_knowledge(p_tenant_id uuid, p_query text, p_audience text default null::text, p_limit integer default 5)
returns table(id uuid, title text, summary text, body text, audience text, category text, tags text[], rank real)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select ka.id, ka.title, ka.summary, ka.body, ka.audience, ka.category, ka.tags,
         ts_rank(ka.search_tsv, websearch_to_tsquery('english', p_query)) as rank
  from public.knowledge_articles ka
  where ka.tenant_id = p_tenant_id
    and (
      (auth.uid() is not null and p_tenant_id in (select tenant_id from public.profiles where user_id = auth.uid() and coalesce(is_active, true) = true))
      or (auth.uid() is null and coalesce(auth.role(), '') = 'service_role')
    )
    and ka.status = 'published'
    and (p_audience is null or ka.audience = p_audience or ka.audience = 'all')
    and ka.search_tsv @@ websearch_to_tsquery('english', p_query)
  order by rank desc
  limit greatest(p_limit, 1);
$function$;

-- ── 2. dispatch_due_triggers — add the opportunity_won branch (023)
-- onto the CURRENT live function (charter_priority ordering + the
-- restored account_at_risk branch from 037), instead of reverting to
-- 023's older pre-charter_priority base. Everything above the new
-- elsif block is byte-identical to the live definition.
-- ============================================================
create or replace function public.dispatch_due_triggers(p_tenant_id uuid default null::uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_sched      record;
  v_rule       record;
  v_acct       record;
  v_inv        record;
  v_ticket     record;
  v_opp        record;
  v_pending    integer := 0;
  v_skipped    integer := 0;
  v_days       integer;
  v_priority   text;
  v_within     integer;
  v_recent     record;
  v_min_arr    bigint;
  v_min_amount bigint;
begin
  -- ── (a) due schedules — lowest DE-assigned priority first ──
  for v_sched in
    select s.*, d.status as def_status,
      coalesce((select min(a.priority) from de_playbook_charter a
                where a.playbook_id = s.definition_id and a.active), 1000) as charter_priority
    from playbook_schedules s
    join playbook_definitions d on d.id = s.definition_id
    where s.active
      and s.next_fire_at is not null
      and s.next_fire_at <= now()
      and (p_tenant_id is null or s.tenant_id = p_tenant_id)
    order by charter_priority asc, s.next_fire_at asc
    for update of s skip locked
  loop
    if v_sched.def_status <> 'published' then
      insert into playbook_trigger_fires (tenant_id, source, schedule_id, definition_id, status, detail)
      values (v_sched.tenant_id, 'schedule', v_sched.id, v_sched.definition_id, 'error',
              'definition is not published — schedule fired into the void');
      v_skipped := v_skipped + 1;
    elsif v_sched.account_selector->>'mode' = 'single' then
      insert into playbook_trigger_fires (tenant_id, source, schedule_id, definition_id, target_account_id, status, detail)
      values (v_sched.tenant_id, 'schedule', v_sched.id, v_sched.definition_id,
              (v_sched.account_selector->>'account_id')::uuid, 'pending_start',
              format('schedule due at %s (single account, charter priority %s)', v_sched.next_fire_at, v_sched.charter_priority));
      v_pending := v_pending + 1;
    else
      v_within := coalesce((v_sched.account_selector->>'renewal_within_days')::int, 60);
      for v_acct in
        select id from customer_accounts
        where tenant_id = v_sched.tenant_id
          and renewal_date is not null
          and renewal_date <= (current_date + v_within)
      loop
        insert into playbook_trigger_fires (tenant_id, source, schedule_id, definition_id, target_account_id, status, detail)
        values (v_sched.tenant_id, 'schedule', v_sched.id, v_sched.definition_id, v_acct.id, 'pending_start',
                format('schedule due at %s (renewal within %s days, charter priority %s)', v_sched.next_fire_at, v_within, v_sched.charter_priority));
        v_pending := v_pending + 1;
      end loop;
    end if;

    update playbook_schedules set last_fired_at = now() where id = v_sched.id;
  end loop;

  -- ── (b) event rules — lowest DE-assigned priority first ────
  for v_rule in
    select r.*, d.status as def_status,
      coalesce((select min(a.priority) from de_playbook_charter a
                where a.playbook_id = r.definition_id and a.active), 1000) as charter_priority
    from playbook_event_rules r
    join playbook_definitions d on d.id = r.definition_id
    where r.active
      and d.status = 'published'
      and (p_tenant_id is null or r.tenant_id = p_tenant_id)
    order by charter_priority asc
  loop
    if v_rule.event_key = 'invoice_overdue' then
      v_days := coalesce((v_rule.params->>'overdue_days')::int, 7);
      for v_inv in
        select id, account_id from renewal_invoices
        where tenant_id = v_rule.tenant_id
          and status = 'sent'
          and due_date is not null
          and due_date < (current_date - v_days)
      loop
        select * into v_recent from playbook_trigger_fires
          where event_rule_id = v_rule.id and target_ref = v_inv.id::text
            and status in ('pending_start', 'started')
            and fired_at > now() - make_interval(hours => v_rule.cooldown_hours)
          order by fired_at desc limit 1;
        if found then
          if not exists (
            select 1 from playbook_trigger_fires
            where event_rule_id = v_rule.id and target_ref = v_inv.id::text
              and status = 'skipped_dedup' and fired_at > v_recent.fired_at
          ) then
            insert into playbook_trigger_fires (tenant_id, source, event_rule_id, definition_id, target_account_id, target_ref, status, detail)
            values (v_rule.tenant_id, 'event', v_rule.id, v_rule.definition_id, v_inv.account_id, v_inv.id::text, 'skipped_dedup',
                    format('invoice already fired within the %sh cooldown', v_rule.cooldown_hours));
            v_skipped := v_skipped + 1;
          end if;
        else
          insert into playbook_trigger_fires (tenant_id, source, event_rule_id, definition_id, target_account_id, target_ref, status, detail)
          values (v_rule.tenant_id, 'event', v_rule.id, v_rule.definition_id, v_inv.account_id, v_inv.id::text, 'pending_start',
                  format('invoice overdue > %s days (charter priority %s)', v_days, v_rule.charter_priority));
          update playbook_event_rules set last_fired_at = now() where id = v_rule.id;
          v_pending := v_pending + 1;
        end if;
      end loop;

    elsif v_rule.event_key = 'ticket_synced_high_priority' then
      v_priority := coalesce(v_rule.params->>'priority', 'p1');
      for v_ticket in
        select id, account_id from support_tickets
        where tenant_id = v_rule.tenant_id
          and source = 'zendesk'
          and priority = v_priority
          and created_at > now() - interval '7 days'
      loop
        select * into v_recent from playbook_trigger_fires
          where event_rule_id = v_rule.id and target_ref = v_ticket.id::text
            and status in ('pending_start', 'started')
            and fired_at > now() - make_interval(hours => v_rule.cooldown_hours)
          order by fired_at desc limit 1;
        if found then
          if not exists (
            select 1 from playbook_trigger_fires
            where event_rule_id = v_rule.id and target_ref = v_ticket.id::text
              and status = 'skipped_dedup' and fired_at > v_recent.fired_at
          ) then
            insert into playbook_trigger_fires (tenant_id, source, event_rule_id, definition_id, target_account_id, target_ref, status, detail)
            values (v_rule.tenant_id, 'event', v_rule.id, v_rule.definition_id, v_ticket.account_id, v_ticket.id::text, 'skipped_dedup',
                    format('ticket already fired within the %sh cooldown', v_rule.cooldown_hours));
            v_skipped := v_skipped + 1;
          end if;
        else
          insert into playbook_trigger_fires (tenant_id, source, event_rule_id, definition_id, target_account_id, target_ref, status, detail)
          values (v_rule.tenant_id, 'event', v_rule.id, v_rule.definition_id, v_ticket.account_id, v_ticket.id::text, 'pending_start',
                  format('%s ticket synced from Zendesk (charter priority %s)', v_priority, v_rule.charter_priority));
          update playbook_event_rules set last_fired_at = now() where id = v_rule.id;
          v_pending := v_pending + 1;
        end if;
      end loop;

    elsif v_rule.event_key = 'account_at_risk' then
      v_min_arr := coalesce((v_rule.params->>'min_arr_cents')::bigint, 0);
      for v_acct in
        select id, arr_cents from customer_accounts
        where tenant_id = v_rule.tenant_id
          and status = 'at_risk'
          and arr_cents >= v_min_arr
      loop
        select * into v_recent from playbook_trigger_fires
          where event_rule_id = v_rule.id and target_ref = v_acct.id::text
            and status in ('pending_start', 'started')
            and fired_at > now() - make_interval(hours => v_rule.cooldown_hours)
          order by fired_at desc limit 1;
        if found then
          if not exists (
            select 1 from playbook_trigger_fires
            where event_rule_id = v_rule.id and target_ref = v_acct.id::text
              and status = 'skipped_dedup' and fired_at > v_recent.fired_at
          ) then
            insert into playbook_trigger_fires (tenant_id, source, event_rule_id, definition_id, target_account_id, target_ref, status, detail)
            values (v_rule.tenant_id, 'event', v_rule.id, v_rule.definition_id, v_acct.id, v_acct.id::text, 'skipped_dedup',
                    format('account already fired within the %sh cooldown', v_rule.cooldown_hours));
            v_skipped := v_skipped + 1;
          end if;
        else
          insert into playbook_trigger_fires (tenant_id, source, event_rule_id, definition_id, target_account_id, target_ref, status, detail)
          values (v_rule.tenant_id, 'event', v_rule.id, v_rule.definition_id, v_acct.id, v_acct.id::text, 'pending_start',
                  format('account at risk (computed health below threshold, charter priority %s)', v_rule.charter_priority));
          update playbook_event_rules set last_fired_at = now() where id = v_rule.id;
          v_pending := v_pending + 1;
        end if;
      end loop;

    elsif v_rule.event_key = 'opportunity_won' then
      -- RESTORED (originally 023, never actually applied live because
      -- 023's own version predated charter_priority — see this
      -- migration's header). Byte-faithful to 023's query/dedup/
      -- cooldown logic, with charter_priority ordering applied on top
      -- exactly like the other three branches already get.
      v_min_amount := coalesce((v_rule.params->>'min_amount_cents')::bigint, 0);
      for v_opp in
        select id, account_id, amount_cents from opportunities
        where tenant_id = v_rule.tenant_id
          and stage = 'won'
          and account_id is not null
          and closed_at > now() - interval '7 days'
          and coalesce(amount_cents, 0) >= v_min_amount
      loop
        select * into v_recent from playbook_trigger_fires
          where event_rule_id = v_rule.id and target_ref = v_opp.id::text
            and status in ('pending_start', 'started')
            and fired_at > now() - make_interval(hours => v_rule.cooldown_hours)
          order by fired_at desc limit 1;
        if found then
          if not exists (
            select 1 from playbook_trigger_fires
            where event_rule_id = v_rule.id and target_ref = v_opp.id::text
              and status = 'skipped_dedup' and fired_at > v_recent.fired_at
          ) then
            insert into playbook_trigger_fires (tenant_id, source, event_rule_id, definition_id, target_account_id, target_ref, status, detail)
            values (v_rule.tenant_id, 'event', v_rule.id, v_rule.definition_id, v_opp.account_id, v_opp.id::text, 'skipped_dedup',
                    format('opportunity already fired within the %sh cooldown', v_rule.cooldown_hours));
            v_skipped := v_skipped + 1;
          end if;
        else
          insert into playbook_trigger_fires (tenant_id, source, event_rule_id, definition_id, target_account_id, target_ref, status, detail)
          values (v_rule.tenant_id, 'event', v_rule.id, v_rule.definition_id, v_opp.account_id, v_opp.id::text, 'pending_start',
                  format('opportunity won — welcome/kickoff play (charter priority %s)', v_rule.charter_priority));
          update playbook_event_rules set last_fired_at = now() where id = v_rule.id;
          v_pending := v_pending + 1;
        end if;
      end loop;
    end if;
  end loop;

  return jsonb_build_object('pending', v_pending, 'skipped_dedup', v_skipped);
end;
$function$;

revoke all on function public.dispatch_due_triggers(uuid) from public;
grant execute on function public.dispatch_due_triggers(uuid) to service_role;
