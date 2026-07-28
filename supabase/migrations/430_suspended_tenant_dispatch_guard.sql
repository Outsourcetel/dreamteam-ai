-- ============================================================
-- Migration 430: suspended tenants go DORMANT at the dispatcher level.
--
-- Found live 2026-07-27: the suspended tenant acme-telecom kept producing
-- ~3 action_executions + de_experience rows per day. Root cause: tenant
-- suspension (migration 081) only sets tenants.status — of the ~27 functions
-- behind the 30 pg_cron jobs, only expire_trials and
-- run_reply_mode_gate_internal ever looked at it. dispatch_due_triggers kept
-- evaluating acme's playbook event rules (invoice_overdue -> 2 dunning
-- actions/day at ~06:25, account_at_risk -> 1 check-in/day at ~02:45), and
-- invoke_playbook_dispatch's health loop kept recomputing the account back
-- to at_risk, re-arming the trigger after each 24h cooldown.
--
-- SEMANTICS (decided here): suspended = fully dormant, resumable.
--   * No trigger evaluation, no playbook runs, no DE work claim/wake, no
--     watchers, no case continuations, no evals, no improve/gap loops, no
--     knowledge sync, no inbox polling, no governance/skills/KPI writes.
--   * Nothing is cancelled or deleted: queued de_work_items, open
--     objectives, schedules and event rules all stay put; on reactivation
--     the next tick picks them up exactly where they stopped.
--   * DELIBERATELY still running for suspended tenants:
--       settle_billable_outcomes  (billing truth for already-delivered work)
--       check_dispatch_failures   (platform ops monitoring)
--       embed/reembed/ingest/conflict-probe/eval-batch drains
--                                 (drain already-enqueued jobs; creators
--                                  above are guarded so queues self-empty)
--       retention jobs            (prune/reap/redact are platform hygiene)
--       expire_trials             (already status-aware by design)
--
-- Every function below is the LIVE production definition
-- (pg_get_functiondef, 2026-07-27) with only the status predicate added —
-- generated + asserted mechanically, no hand-retyping.
-- ============================================================

-- The one predicate everything else uses. SECURITY DEFINER so RLS on
-- tenants can never hide a row from a dispatcher; null-tolerant per the
-- docs/29 guard convention: platform-scoped work (no tenant) is not
-- suspendable, an orphaned tenant_id (no tenants row) must NOT run.
create or replace function public.tenant_is_operational(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select case
    when p_tenant_id is null then true
    else exists (select 1 from tenants t
                  where t.id = p_tenant_id and t.status in ('active', 'trial'))
  end;
$$;

revoke all on function public.tenant_is_operational(uuid) from public, anon, authenticated;


-- ── dispatch_due_triggers ──
CREATE OR REPLACE FUNCTION public.dispatch_due_triggers(p_tenant_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
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
      and tenant_is_operational(s.tenant_id)
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
      and tenant_is_operational(r.tenant_id)
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

-- ── invoke_playbook_dispatch ──
CREATE OR REPLACE FUNCTION public.invoke_playbook_dispatch()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_secret  text;
  v_anon    text := platform_anon_key();
  v_req_id  bigint; v_req_id2 bigint; v_req_id3 bigint; v_req_id4 bigint;
  v_t       record;
  v_health  integer := 0;
  v_stale   jsonb;
BEGIN
  FOR v_t IN
    SELECT DISTINCT ca.tenant_id
    FROM customer_accounts ca
    LEFT JOIN health_score_config c ON c.tenant_id = ca.tenant_id
    WHERE (c.last_computed_at IS NULL OR c.last_computed_at < now() - interval '24 hours')
      AND tenant_is_operational(ca.tenant_id)
  LOOP
    PERFORM compute_tenant_health_service(v_t.tenant_id);
    v_health := v_health + 1;
  END LOOP;

  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'playbook_dispatch_secret' LIMIT 1;
  IF v_secret IS NULL THEN
    PERFORM raise_ops_alert('dispatch_secret_missing',
      'playbook_dispatch_secret is missing from Vault — the 5-minute dispatch cron (playbooks, polling, gap/learn detection) is doing NOTHING.',
      jsonb_build_object('cron', 'invoke_playbook_dispatch'));
    RETURN format('health:%s no_secret', v_health);
  END IF;

  SELECT net.http_post(
    url := platform_fn_url('/functions/v1/playbook-execute'),
    body := '{"action":"dispatch"}'::jsonb,
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_anon,'apikey',v_anon,'x-dispatch-secret',v_secret),
    timeout_milliseconds := 30000
  ) INTO v_req_id;

  SELECT net.http_post(
    url := platform_fn_url('/functions/v1/specialist-consult'),
    body := '{"action":"poll_de_work_sources"}'::jsonb,
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_anon,'apikey',v_anon,'x-dispatch-secret',v_secret),
    timeout_milliseconds := 30000
  ) INTO v_req_id2;

  BEGIN
    v_stale := check_staleness();
  EXCEPTION WHEN OTHERS THEN
    v_stale := jsonb_build_object('error', sqlerrm);
  END;

  BEGIN
    SELECT net.http_post(
      url := platform_fn_url('/functions/v1/knowledge-gap-detect'),
      body := '{}'::jsonb,
      headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_anon,'apikey',v_anon,'x-dispatch-secret',v_secret),
      timeout_milliseconds := 30000
    ) INTO v_req_id3;
  EXCEPTION WHEN OTHERS THEN v_req_id3 := NULL; END;

  BEGIN
    SELECT net.http_post(
      url := platform_fn_url('/functions/v1/learned-behavior-detect'),
      body := '{}'::jsonb,
      headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_anon,'apikey',v_anon,'x-dispatch-secret',v_secret),
      timeout_milliseconds := 30000
    ) INTO v_req_id4;
  EXCEPTION WHEN OTHERS THEN v_req_id4 := NULL; END;

  RETURN format('health:%s dispatch:%s poll:%s gap:%s learn:%s stale:%s',
    v_health, v_req_id, v_req_id2, coalesce(v_req_id3::text, 'err'), coalesce(v_req_id4::text, 'err'),
    coalesce(v_stale->>'checked', '0'));
END;
$function$;

-- ── run_work_watchers ──
CREATE OR REPLACE FUNCTION public.run_work_watchers(p_tenant_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  w work_watchers; v_new integer; v_total integer := 0; v_watchers integer := 0;
  v_obj_id uuid; v_inserted boolean; r record; v_h integer; v_occ text;
  v_title text; v_de_name text; v_src text; v_date_field text; v_motion text;
  v_cat watch_source_catalog; v_row jsonb; v_id text; v_where text; v_sql text;
  v_field text; v_op text; v_vt text; v_cast text; v_datef text; v_label text; v_subject jsonb; v_cap int;
BEGIN
  FOR w IN SELECT * FROM work_watchers WHERE active AND kind <> 'inbox'
      AND (p_tenant_id IS NULL OR tenant_id = p_tenant_id)
      AND tenant_is_operational(tenant_id) ORDER BY created_at
  LOOP
    v_new := 0; v_watchers := v_watchers + 1;
    v_src := coalesce(w.config->>'source','customer_accounts');
    SELECT coalesce(persona_name, name) INTO v_de_name FROM digital_employees WHERE id = w.de_id;

    BEGIN
    -- ── date_horizon ──
    IF w.kind = 'date_horizon' AND v_src = 'customer_accounts' THEN
      FOR r IN
        SELECT ca.id, ca.name, ca.renewal_date, ca.arr_cents, ca.health_score,
               (ca.renewal_date - current_date) AS days_left
        FROM customer_accounts ca
        WHERE ca.tenant_id = w.tenant_id AND ca.renewal_date IS NOT NULL AND ca.renewal_date >= current_date
          AND (w.config->'status_filter' IS NULL OR ca.status IN (SELECT jsonb_array_elements_text(w.config->'status_filter')))
      LOOP
        SELECT min(h) INTO v_h FROM (SELECT (jsonb_array_elements_text(coalesce(w.config->'horizons_days','[90,60,30]'::jsonb)))::int AS h) hs WHERE h >= r.days_left;
        IF v_h IS NULL THEN CONTINUE; END IF;
        v_occ := r.id::text || '|' || r.renewal_date::text || '|' || v_h::text;
        INSERT INTO work_watcher_matches (tenant_id, watcher_id, subject_ref, occurrence_key)
        VALUES (w.tenant_id, w.id, r.id::text, v_occ) ON CONFLICT (watcher_id, occurrence_key) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT; IF NOT v_inserted THEN CONTINUE; END IF;
        v_title := w.label || ' — ' || r.name || ' (' || v_h || '-day checkpoint, renews ' || to_char(r.renewal_date, 'Mon DD') || ')';
        INSERT INTO de_objectives (tenant_id, de_id, title, description, entity_kind, entity_ref, status, priority, due_at, plan)
        VALUES (w.tenant_id, w.de_id, left(v_title, 200),
          'Opened by the Book of Work: ' || r.name || ' renews on ' || r.renewal_date::text || ' (' || r.days_left || ' days out). Work the ' || v_h || '-day motion per the playbook.',
          'customer_account', r.id::text, 'open', v_h, r.renewal_date::timestamptz,
          jsonb_build_object('source','book_of_work','watcher_id',w.id,'kind',w.kind,'horizon_days',v_h,
            'subject', jsonb_build_object('name', r.name, 'renewal_date', r.renewal_date, 'arr_cents', r.arr_cents, 'health_score', r.health_score))
        ) RETURNING id INTO v_obj_id;
        UPDATE work_watcher_matches SET objective_id = v_obj_id WHERE watcher_id = w.id AND occurrence_key = v_occ;
        v_new := v_new + 1;
      END LOOP;

    ELSIF w.kind = 'date_horizon' AND v_src = 'opportunities' THEN
      FOR r IN
        SELECT o.id, coalesce(o.name, o.company_name, 'opportunity') AS name, o.close_date, o.amount_cents, o.stage,
               (o.close_date - current_date) AS days_left
        FROM opportunities o
        WHERE o.tenant_id = w.tenant_id AND o.close_date IS NOT NULL AND o.close_date >= current_date AND o.closed_at IS NULL
          AND (w.config->'stage_filter' IS NULL OR o.stage IN (SELECT jsonb_array_elements_text(w.config->'stage_filter')))
      LOOP
        SELECT min(h) INTO v_h FROM (SELECT (jsonb_array_elements_text(coalesce(w.config->'horizons_days','[30,14,7]'::jsonb)))::int AS h) hs WHERE h >= r.days_left;
        IF v_h IS NULL THEN CONTINUE; END IF;
        v_occ := r.id::text || '|' || r.close_date::text || '|' || v_h::text;
        INSERT INTO work_watcher_matches (tenant_id, watcher_id, subject_ref, occurrence_key)
        VALUES (w.tenant_id, w.id, r.id::text, v_occ) ON CONFLICT (watcher_id, occurrence_key) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT; IF NOT v_inserted THEN CONTINUE; END IF;
        v_title := w.label || ' — ' || r.name || ' (' || v_h || '-day, closes ' || to_char(r.close_date, 'Mon DD') || ')';
        INSERT INTO de_objectives (tenant_id, de_id, title, description, entity_kind, entity_ref, status, priority, due_at, plan)
        VALUES (w.tenant_id, w.de_id, left(v_title, 200),
          'Opened by the Book of Work: opportunity ' || r.name || ' is in stage "' || coalesce(r.stage,'?') || '" and closes on ' || r.close_date::text || ' (' || r.days_left || ' days out). Advance it per the playbook.',
          'opportunity', r.id::text, 'open', v_h, r.close_date::timestamptz,
          jsonb_build_object('source','book_of_work','watcher_id',w.id,'kind',w.kind,'horizon_days',v_h,
            'subject', jsonb_build_object('name', r.name, 'close_date', r.close_date, 'amount_cents', r.amount_cents, 'stage', r.stage))
        ) RETURNING id INTO v_obj_id;
        UPDATE work_watcher_matches SET objective_id = v_obj_id WHERE watcher_id = w.id AND occurrence_key = v_occ;
        v_new := v_new + 1;
      END LOOP;

    -- ── NEW: date_horizon on commercial_agreements (configurable date_field) ──
    -- Opens a de_objectives case AND its typed continuity_cases facet, stamped
    -- with the motion (explicit config override, else derived from the date_field).
    ELSIF w.kind = 'date_horizon' AND v_src = 'commercial_agreements' THEN
      v_date_field := coalesce(w.config->>'date_field','renewal_date');
      FOR r IN
        SELECT sub.* FROM (
          SELECT a.id, coalesce(a.counterparty_name, a.title) AS name, a.account_id, a.party_side,
                 a.baseline_value_cents, a.status, a.agreement_type,
                 (CASE v_date_field
                    WHEN 'renewal_date'            THEN a.renewal_date
                    WHEN 'notice_deadline'         THEN a.notice_deadline
                    WHEN 'warranty_expiry'         THEN a.warranty_expiry
                    WHEN 'next_reorder_date'       THEN a.next_reorder_date
                    WHEN 'cancellation_deadline'   THEN a.cancellation_deadline
                    WHEN 'pricing_notice_deadline' THEN a.pricing_notice_deadline
                    WHEN 'replacement_date'        THEN a.replacement_date
                    ELSE a.renewal_date END) AS target_date
          FROM commercial_agreements a
          WHERE a.tenant_id = w.tenant_id
            AND (w.config->'status_filter' IS NULL OR a.status IN (SELECT jsonb_array_elements_text(w.config->'status_filter')))
        ) sub
        WHERE sub.target_date IS NOT NULL AND sub.target_date >= current_date
      LOOP
        SELECT min(h) INTO v_h FROM (SELECT (jsonb_array_elements_text(coalesce(w.config->'horizons_days','[90,60,30]'::jsonb)))::int AS h) hs WHERE h >= (r.target_date - current_date);
        IF v_h IS NULL THEN CONTINUE; END IF;
        v_occ := r.id::text || '|' || v_date_field || '|' || r.target_date::text || '|' || v_h::text;
        INSERT INTO work_watcher_matches (tenant_id, watcher_id, subject_ref, occurrence_key)
        VALUES (w.tenant_id, w.id, r.id::text, v_occ) ON CONFLICT (watcher_id, occurrence_key) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT; IF NOT v_inserted THEN CONTINUE; END IF;

        v_motion := coalesce(nullif(w.config->>'motion',''),
          CASE v_date_field
            WHEN 'renewal_date'            THEN 'renew'
            WHEN 'notice_deadline'         THEN 'renew'
            WHEN 'warranty_expiry'         THEN 'replace'
            WHEN 'next_reorder_date'       THEN 'reorder'
            WHEN 'replacement_date'        THEN 'replace'
            WHEN 'cancellation_deadline'   THEN 'renew'
            WHEN 'pricing_notice_deadline' THEN 'renegotiate'
            ELSE 'renew' END);

        v_title := w.label || ' — ' || r.name || ' (' || v_h || '-day, ' || v_date_field || ' ' || to_char(r.target_date, 'Mon DD') || ')';
        INSERT INTO de_objectives (tenant_id, de_id, title, description, entity_kind, entity_ref, status, priority, due_at, plan)
        VALUES (w.tenant_id, w.de_id, left(v_title, 200),
          'Opened by the Book of Work: ' || r.name || ' — ' || v_motion || ' motion. The ' || replace(v_date_field,'_',' ')
            || ' is ' || r.target_date::text || ' (' || (r.target_date - current_date) || ' days out). Work the ' || v_h || '-day motion per the playbook.',
          'commercial_agreement', r.id::text, 'open', v_h, r.target_date::timestamptz,
          jsonb_build_object('source','book_of_work','watcher_id',w.id,'kind',w.kind,'horizon_days',v_h,'motion',v_motion,'date_field',v_date_field,
            'subject', jsonb_build_object('name', r.name, 'agreement_type', r.agreement_type, 'party_side', r.party_side,
              'target_date', r.target_date, 'baseline_value_cents', r.baseline_value_cents))
        ) RETURNING id INTO v_obj_id;
        UPDATE work_watcher_matches SET objective_id = v_obj_id WHERE watcher_id = w.id AND occurrence_key = v_occ;

        -- The typed facet: exactly one per case, driven off the SAME objective.
        INSERT INTO continuity_cases (objective_id, tenant_id, de_id, agreement_id, account_id, motion, stage_key, party_side, baseline_cents)
        VALUES (v_obj_id, w.tenant_id, w.de_id, r.id, r.account_id, v_motion, 'discovered', coalesce(r.party_side,'sell'), r.baseline_value_cents)
        ON CONFLICT (objective_id) DO NOTHING;
        INSERT INTO continuity_case_events (tenant_id, objective_id, to_stage, motion, actor_kind, summary, detail)
        VALUES (w.tenant_id, v_obj_id, 'discovered', v_motion, 'system',
          'Case opened by Book of Work — ' || v_motion || ' on ' || r.name || ' (' || replace(v_date_field,'_',' ') || ')',
          jsonb_build_object('watcher_id', w.id, 'date_field', v_date_field, 'horizon_days', v_h));
        v_new := v_new + 1;
      END LOOP;


    -- GENERIC date_horizon (catalog-driven; any non-legacy source)
    ELSIF w.kind = 'date_horizon' THEN
      SELECT * INTO v_cat FROM watch_source_catalog WHERE source_key = v_src AND active AND NOT legacy_bespoke;
      IF v_cat.source_key IS NULL THEN CONTINUE; END IF;
      v_datef := coalesce(w.config->>'date_field',
                   (SELECT column_name FROM watch_source_fields WHERE source_key = v_src AND role='date' ORDER BY column_name LIMIT 1));
      IF v_datef IS NULL OR NOT EXISTS (SELECT 1 FROM watch_source_fields WHERE source_key=v_src AND role='date' AND column_name=v_datef) THEN CONTINUE; END IF;
      v_cap := least(coalesce((w.config->>'max_per_run')::int, 1000), 1000);
      v_where := format('%I = $1 AND %I IS NOT NULL AND %I >= current_date', v_cat.tenant_column, v_datef, v_datef)
                 || build_base_predicates(v_cat.base_predicates)
                 || format(' AND ($2::text[] IS NULL OR %I = ANY($2))', v_cat.status_column);
      v_sql := format('SELECT %I::text AS _id, to_jsonb(t.*) AS _row FROM %I t WHERE %s ORDER BY %I LIMIT %s',
                      v_cat.id_column, v_cat.table_name, v_where, v_datef, v_cap);
      FOR r IN EXECUTE v_sql USING w.tenant_id,
                 CASE WHEN w.config ? 'status_filter' THEN ARRAY(SELECT jsonb_array_elements_text(w.config->'status_filter')) ELSE NULL::text[] END
      LOOP
        v_row := r._row; v_id := r._id;
        SELECT min(h) INTO v_h FROM (SELECT (jsonb_array_elements_text(coalesce(w.config->'horizons_days', v_cat.default_horizons)))::int AS h) hs WHERE h >= ((v_row->>v_datef)::date - current_date);
        IF v_h IS NULL THEN CONTINUE; END IF;
        v_occ := v_id || '|' || v_datef || '|' || (v_row->>v_datef) || '|' || v_h::text;
        INSERT INTO work_watcher_matches (tenant_id, watcher_id, subject_ref, occurrence_key)
        VALUES (w.tenant_id, w.id, v_id, v_occ) ON CONFLICT (watcher_id, occurrence_key) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT; IF NOT v_inserted THEN CONTINUE; END IF;
        v_label := watcher_label(v_cat.label_columns, v_row, v_cat.entity_kind, v_id);
        v_subject := jsonb_object_agg_subset(v_row, v_cat.subject_columns);
        v_title := w.label || ' — ' || v_label || ' (' || v_h || '-day, ' || replace(v_datef,'_',' ') || ' ' || to_char((v_row->>v_datef)::date,'Mon DD') || ')';
        INSERT INTO de_objectives (tenant_id, de_id, title, description, entity_kind, entity_ref, status, priority, due_at, plan)
        VALUES (w.tenant_id, w.de_id, left(v_title,200),
          'Opened by the Book of Work: ' || v_label || ' — ' || replace(v_datef,'_',' ') || ' is ' || (v_row->>v_datef) || ' (' || (((v_row->>v_datef)::date - current_date)) || ' days out). Work the ' || v_h || '-day motion per the playbook.',
          v_cat.entity_kind, v_id, 'open', v_h, (v_row->>v_datef)::timestamptz,
          jsonb_build_object('source','book_of_work','watcher_id',w.id,'kind',w.kind,'watch_source',v_src,'date_field',v_datef,'horizon_days',v_h,'subject', v_subject))
        RETURNING id INTO v_obj_id;
        UPDATE work_watcher_matches SET objective_id=v_obj_id WHERE watcher_id=w.id AND occurrence_key=v_occ;
        v_new := v_new + 1;
      END LOOP;

    -- ── state_condition ──
    ELSIF w.kind = 'state_condition' AND v_src = 'customer_accounts' THEN
      FOR r IN
        SELECT ca.id, ca.name, ca.health_score, ca.status, ca.arr_cents, ca.tier
        FROM customer_accounts ca WHERE ca.tenant_id = w.tenant_id
          AND CASE w.config->>'field'
                WHEN 'health_score' THEN CASE w.config->>'op'
                    WHEN 'lt' THEN ca.health_score < (w.config->>'value')::numeric WHEN 'lte' THEN ca.health_score <= (w.config->>'value')::numeric
                    WHEN 'gt' THEN ca.health_score > (w.config->>'value')::numeric WHEN 'gte' THEN ca.health_score >= (w.config->>'value')::numeric
                    WHEN 'eq' THEN ca.health_score = (w.config->>'value')::numeric ELSE ca.health_score <> (w.config->>'value')::numeric END
                WHEN 'arr_cents' THEN CASE w.config->>'op'
                    WHEN 'lt' THEN ca.arr_cents < (w.config->>'value')::numeric WHEN 'lte' THEN ca.arr_cents <= (w.config->>'value')::numeric
                    WHEN 'gt' THEN ca.arr_cents > (w.config->>'value')::numeric WHEN 'gte' THEN ca.arr_cents >= (w.config->>'value')::numeric
                    WHEN 'eq' THEN ca.arr_cents = (w.config->>'value')::numeric ELSE ca.arr_cents <> (w.config->>'value')::numeric END
                WHEN 'status' THEN CASE w.config->>'op' WHEN 'eq' THEN ca.status = w.config->>'value' ELSE ca.status <> w.config->>'value' END
                WHEN 'tier' THEN CASE w.config->>'op' WHEN 'eq' THEN ca.tier = w.config->>'value' ELSE ca.tier <> w.config->>'value' END
                ELSE false END
      LOOP
        v_occ := r.id::text || '|' || (w.config->>'field') || (w.config->>'op') || (w.config->>'value');
        INSERT INTO work_watcher_matches (tenant_id, watcher_id, subject_ref, occurrence_key)
        VALUES (w.tenant_id, w.id, r.id::text, v_occ) ON CONFLICT (watcher_id, occurrence_key) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT; IF NOT v_inserted THEN CONTINUE; END IF;
        v_title := w.label || ' — ' || r.name;
        INSERT INTO de_objectives (tenant_id, de_id, title, description, entity_kind, entity_ref, status, priority, plan)
        VALUES (w.tenant_id, w.de_id, left(v_title, 200),
          'Opened by the Book of Work: ' || r.name || ' matched "' || (w.config->>'field') || ' ' || (w.config->>'op') || ' ' || (w.config->>'value') || '". Assess and work per the playbook.',
          'customer_account', r.id::text, 'open', 2,
          jsonb_build_object('source','book_of_work','watcher_id',w.id,'kind',w.kind,'condition', w.config,
            'subject', jsonb_build_object('name', r.name, 'health_score', r.health_score, 'status', r.status))
        ) RETURNING id INTO v_obj_id;
        UPDATE work_watcher_matches SET objective_id = v_obj_id WHERE watcher_id = w.id AND occurrence_key = v_occ;
        v_new := v_new + 1;
      END LOOP;

    ELSIF w.kind = 'state_condition' AND v_src = 'opportunities' THEN
      FOR r IN
        SELECT o.id, coalesce(o.name, o.company_name, 'opportunity') AS name, o.stage, o.amount_cents, o.close_date
        FROM opportunities o WHERE o.tenant_id = w.tenant_id AND o.closed_at IS NULL
          AND CASE w.config->>'field'
                WHEN 'amount_cents' THEN CASE w.config->>'op'
                    WHEN 'lt' THEN o.amount_cents < (w.config->>'value')::numeric WHEN 'lte' THEN o.amount_cents <= (w.config->>'value')::numeric
                    WHEN 'gt' THEN o.amount_cents > (w.config->>'value')::numeric WHEN 'gte' THEN o.amount_cents >= (w.config->>'value')::numeric
                    WHEN 'eq' THEN o.amount_cents = (w.config->>'value')::numeric ELSE o.amount_cents <> (w.config->>'value')::numeric END
                WHEN 'stage' THEN CASE w.config->>'op' WHEN 'eq' THEN o.stage = w.config->>'value' ELSE o.stage <> w.config->>'value' END
                ELSE false END
      LOOP
        v_occ := r.id::text || '|' || (w.config->>'field') || (w.config->>'op') || (w.config->>'value');
        INSERT INTO work_watcher_matches (tenant_id, watcher_id, subject_ref, occurrence_key)
        VALUES (w.tenant_id, w.id, r.id::text, v_occ) ON CONFLICT (watcher_id, occurrence_key) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT; IF NOT v_inserted THEN CONTINUE; END IF;
        v_title := w.label || ' — ' || r.name;
        INSERT INTO de_objectives (tenant_id, de_id, title, description, entity_kind, entity_ref, status, priority, plan)
        VALUES (w.tenant_id, w.de_id, left(v_title, 200),
          'Opened by the Book of Work: opportunity ' || r.name || ' matched "' || (w.config->>'field') || ' ' || (w.config->>'op') || ' ' || (w.config->>'value') || '". Advance it per the playbook.',
          'opportunity', r.id::text, 'open', 2,
          jsonb_build_object('source','book_of_work','watcher_id',w.id,'kind',w.kind,'condition', w.config,
            'subject', jsonb_build_object('name', r.name, 'stage', r.stage, 'amount_cents', r.amount_cents, 'close_date', r.close_date))
        ) RETURNING id INTO v_obj_id;
        UPDATE work_watcher_matches SET objective_id = v_obj_id WHERE watcher_id = w.id AND occurrence_key = v_occ;
        v_new := v_new + 1;
      END LOOP;


    -- GENERIC state_condition (catalog-driven; any non-legacy source)
    ELSIF w.kind = 'state_condition' THEN
      SELECT * INTO v_cat FROM watch_source_catalog WHERE source_key = v_src AND active AND NOT legacy_bespoke;
      IF v_cat.source_key IS NULL THEN CONTINUE; END IF;
      v_field := w.config->>'field'; v_op := w.config->>'op';
      SELECT value_type INTO v_vt FROM watch_source_fields WHERE source_key=v_src AND role='state' AND column_name=v_field AND v_op = ANY (allowed_ops);
      IF v_vt IS NULL THEN CONTINUE; END IF;
      v_cast := CASE WHEN v_vt = 'numeric' THEN '::numeric' ELSE '' END;
      v_where := format('%I = $1', v_cat.tenant_column) || build_base_predicates(v_cat.base_predicates)
                 || format(' AND %I %s $2%s', v_field, sql_op(v_op), v_cast)
                 || format(' AND NOT EXISTS (SELECT 1 FROM work_watcher_matches m WHERE m.watcher_id = $3 AND m.subject_ref = t.%I::text)', v_cat.id_column);
      v_sql := format('SELECT %I::text AS _id, to_jsonb(t.*) AS _row FROM %I t WHERE %s', v_cat.id_column, v_cat.table_name, v_where);
      FOR r IN EXECUTE v_sql USING w.tenant_id, (w.config->>'value'), w.id
      LOOP
        v_row := r._row; v_id := r._id;
        v_occ := v_id || '|' || v_field || v_op || (w.config->>'value');
        INSERT INTO work_watcher_matches (tenant_id, watcher_id, subject_ref, occurrence_key)
        VALUES (w.tenant_id, w.id, v_id, v_occ) ON CONFLICT (watcher_id, occurrence_key) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT; IF NOT v_inserted THEN CONTINUE; END IF;
        v_label := watcher_label(v_cat.label_columns, v_row, v_cat.entity_kind, v_id);
        v_subject := jsonb_object_agg_subset(v_row, v_cat.subject_columns);
        INSERT INTO de_objectives (tenant_id, de_id, title, description, entity_kind, entity_ref, status, priority, plan)
        VALUES (w.tenant_id, w.de_id, left(w.label || ' — ' || v_label,200),
          'Opened by the Book of Work: ' || v_label || ' matched "' || v_field || ' ' || v_op || ' ' || (w.config->>'value') || '". Assess and work per the playbook.',
          v_cat.entity_kind, v_id, 'open', 2,
          jsonb_build_object('source','book_of_work','watcher_id',w.id,'kind',w.kind,'watch_source',v_src,'condition',w.config,'subject', v_subject))
        RETURNING id INTO v_obj_id;
        UPDATE work_watcher_matches SET objective_id=v_obj_id WHERE watcher_id=w.id AND occurrence_key=v_occ;
        v_new := v_new + 1;
      END LOOP;

    -- ── metric_threshold (unchanged from mig 220) ──
    ELSIF w.kind = 'metric_threshold' THEN
      SELECT k.metric_key AS mkey, k.value, k.as_of INTO r
      FROM de_kpi_readings k WHERE k.tenant_id = w.tenant_id AND k.de_id = w.de_id AND k.metric_key = w.config->>'metric_key'
      ORDER BY k.as_of DESC, k.created_at DESC LIMIT 1;
      IF r.mkey IS NOT NULL AND ((w.config->>'op' = 'lt' AND r.value < (w.config->>'value')::numeric) OR (w.config->>'op' = 'gt' AND r.value > (w.config->>'value')::numeric)) THEN
        v_occ := r.mkey || '|' || r.as_of::text || '|' || (w.config->>'op') || (w.config->>'value');
        INSERT INTO work_watcher_matches (tenant_id, watcher_id, subject_ref, occurrence_key)
        VALUES (w.tenant_id, w.id, r.mkey, v_occ) ON CONFLICT (watcher_id, occurrence_key) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        IF v_inserted THEN
          INSERT INTO de_objectives (tenant_id, de_id, title, description, entity_kind, entity_ref, status, priority, plan)
          VALUES (w.tenant_id, w.de_id, left(w.label || ' — ' || r.mkey || ' at ' || r.value, 200),
            'Opened by the Book of Work: metric "' || r.mkey || '" read ' || r.value || ' on ' || r.as_of || ', crossing the ' || (w.config->>'op') || ' ' || (w.config->>'value') || ' line. Investigate per the playbook.',
            'metric', r.mkey, 'open', 2,
            jsonb_build_object('source','book_of_work','watcher_id',w.id,'kind',w.kind,'reading', jsonb_build_object('metric_key', r.mkey, 'value', r.value, 'as_of', r.as_of))
          ) RETURNING id INTO v_obj_id;
          UPDATE work_watcher_matches SET objective_id = v_obj_id WHERE watcher_id = w.id AND occurrence_key = v_occ;
          v_new := v_new + 1;
        END IF;
      END IF;

    -- ── schedule (unchanged from mig 220) ──
    ELSIF w.kind = 'schedule' THEN
      IF w.next_fire_at IS NULL THEN
        UPDATE work_watchers SET next_fire_at = now() + make_interval(mins => (w.config->>'interval_minutes')::int) WHERE id = w.id;
      ELSIF now() >= w.next_fire_at THEN
        v_occ := to_char(w.next_fire_at, 'YYYY-MM-DD"T"HH24:MI');
        INSERT INTO work_watcher_matches (tenant_id, watcher_id, subject_ref, occurrence_key)
        VALUES (w.tenant_id, w.id, 'schedule', v_occ) ON CONFLICT (watcher_id, occurrence_key) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        IF v_inserted THEN
          INSERT INTO de_objectives (tenant_id, de_id, title, description, entity_kind, entity_ref, status, priority, plan)
          VALUES (w.tenant_id, w.de_id, left(w.label, 200),
            'Opened by the Book of Work on schedule (' || coalesce(w.description, w.label) || '). Run the recurring motion per the playbook.',
            'schedule', v_occ, 'open', 3, jsonb_build_object('source','book_of_work','watcher_id',w.id,'kind',w.kind,'fired_at', now())
          ) RETURNING id INTO v_obj_id;
          UPDATE work_watcher_matches SET objective_id = v_obj_id WHERE watcher_id = w.id AND occurrence_key = v_occ;
          v_new := v_new + 1;
        END IF;
        UPDATE work_watchers SET next_fire_at = now() + make_interval(mins => (w.config->>'interval_minutes')::int) WHERE id = w.id;
      END IF;
    END IF;
    EXCEPTION WHEN OTHERS THEN
      BEGIN PERFORM append_audit_event_internal(w.tenant_id, 'system', 'system',
        'Book of Work watcher "' || w.label || '" errored and was skipped this tick', 'playbook_step',
        jsonb_build_object('kind','book_of_work_error','watcher_id', w.id, 'error', SQLERRM));
      EXCEPTION WHEN OTHERS THEN NULL; END;
      CONTINUE;
    END;

    UPDATE work_watchers SET last_run_at = now(), last_match_count = v_new WHERE id = w.id;
    v_total := v_total + v_new;
    IF v_new > 0 THEN
      BEGIN PERFORM append_audit_event_internal(w.tenant_id, coalesce(v_de_name, 'DE'), 'de',
          coalesce(v_de_name, 'DE') || ' found ' || v_new || ' new work item(s) via Book of Work watcher "' || w.label || '"',
          'playbook_step', jsonb_build_object('kind','book_of_work','watcher_id', w.id, 'watcher_kind', w.kind, 'new_cases', v_new));
      EXCEPTION WHEN OTHERS THEN NULL; END;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'watchers_run', v_watchers, 'cases_opened', v_total);
END; $function$;

-- ── run_case_timeline ──
CREATE OR REPLACE FUNCTION public.run_case_timeline(p_tenant_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE e de_case_events; v_fired integer := 0;
BEGIN
  FOR e IN
    SELECT * FROM de_case_events
    WHERE status = 'pending' AND fire_at <= now()
      AND (p_tenant_id IS NULL OR tenant_id = p_tenant_id)
      AND tenant_is_operational(tenant_id)
    ORDER BY fire_at LIMIT 500
  LOOP
    UPDATE de_case_events SET status = 'fired', decided_at = now() WHERE id = e.id;

    -- Re-open the case with the continuation instruction attached, so de-work
    -- resumes the motion where it paused.
    UPDATE de_objectives
       SET status = CASE WHEN status IN ('achieved','abandoned') THEN status ELSE 'open' END,
           next_wake_at = now(),
           description = coalesce(description,'') || E'\n\n[Follow-up ' || to_char(now(),'Mon DD') || ']: '
             || coalesce(nullif(e.instruction,''),
                  CASE WHEN e.awaiting_ref IS NOT NULL THEN 'No reply received by the deadline — continue the motion.' ELSE 'Scheduled continuation — continue the motion.' END),
           updated_at = now()
     WHERE id = e.objective_id;

    BEGIN
      PERFORM append_audit_event_internal(e.tenant_id,
        (SELECT coalesce(persona_name, name) FROM digital_employees WHERE id = e.de_id), 'de',
        'Case resumed — ' || e.kind || (CASE WHEN e.awaiting_ref IS NOT NULL THEN ' (no reply by deadline)' ELSE '' END)
          || ': ' || left(coalesce(e.instruction,'continue the motion'), 120),
        'playbook_step',
        jsonb_build_object('kind','case_continuation_fired','event_id',e.id,'objective_id',e.objective_id,'continuation_kind',e.kind));
    EXCEPTION WHEN OTHERS THEN NULL; END;

    v_fired := v_fired + 1;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'fired', v_fired);
END; $function$;

-- ── wake_due_objectives ──
CREATE OR REPLACE FUNCTION public.wake_due_objectives(p_limit integer DEFAULT 5)
 RETURNS SETOF de_objectives
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select * from de_objectives
   where status in ('open', 'in_progress')
     and next_wake_at is not null
     and next_wake_at <= now()
     and tenant_is_operational(tenant_id)
   order by next_wake_at asc
   limit greatest(1, least(20, p_limit));
$function$;

-- ── claim_de_work_items ──
CREATE OR REPLACE FUNCTION public.claim_de_work_items(p_limit integer DEFAULT 10, p_worker text DEFAULT 'worker'::text, p_tenant_id uuid DEFAULT NULL::uuid)
 RETURNS SETOF de_work_items
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  return query
  with due as (
    select w.id
    from de_work_items w
    join digital_employees de on de.id = w.de_id
    where w.status = 'queued'
      and w.scheduled_for <= now()
      and (p_tenant_id is null or w.tenant_id = p_tenant_id)
      and tenant_is_operational(w.tenant_id)
      -- WAVE-1 FIX (mig 249): an unavailable employee's items stay queued.
      and de.status = 'active'
      and de.lifecycle_status not in ('paused', 'retired', 'archived')
      -- T2.4: a paused/cancelled mission's fanned work stops claiming at once,
      -- for single AND team missions. NULL-safe: non-mission items (objective_id
      -- null, or objective without a mission) are unaffected.
      and not exists (
        select 1 from de_objectives o
        join de_missions m on m.id = o.mission_id
        where o.id = w.objective_id and m.status in ('paused', 'cancelled'))
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

-- ── dispatch_de_work_internal ──
CREATE OR REPLACE FUNCTION public.dispatch_de_work_internal()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_secret text;
  v_anon   text := platform_anon_key();
  v_req_id bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM de_work_items WHERE status = 'queued' AND scheduled_for <= now() AND tenant_is_operational(tenant_id))
     AND NOT EXISTS (SELECT 1 FROM de_objectives WHERE status IN ('open','in_progress') AND tenant_is_operational(tenant_id)
                       AND ( (next_wake_at IS NOT NULL AND next_wake_at <= now())
                             OR NOT EXISTS (SELECT 1 FROM de_work_items w WHERE w.objective_id = de_objectives.id) ))
  THEN
    RETURN 'idle — nothing due';
  END IF;

  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'playbook_dispatch_secret';
  IF v_secret IS NULL THEN
    PERFORM raise_ops_alert('dispatch_secret_missing',
      'playbook_dispatch_secret is missing from Vault — de-work items are queued but the work engine cron cannot run them.',
      jsonb_build_object('cron', 'dispatch_de_work_internal'));
    RETURN 'no dispatch secret';
  END IF;
  SELECT net.http_post(
    url := platform_fn_url('/functions/v1/de-work'),
    body := '{"action":"run","max_items":3}'::jsonb,
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_anon,'x-dispatch-secret',v_secret)
  , timeout_milliseconds := 60000) INTO v_req_id;
  RETURN 'de-work dispatched, req ' || v_req_id;
END;
$function$;

-- ── dispatch_eval_driver_internal ──
CREATE OR REPLACE FUNCTION public.dispatch_eval_driver_internal()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_secret text;
  v_anon   text := coalesce((select value from platform_runtime_config where key = 'supabase_anon_key'), 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmc3ZtaGNxZWl5cnhpdmJtcGVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxMzIwMDgsImV4cCI6MjA5NzcwODAwOH0.RKCWute2ypkx9X-ByumIQWw8MS5uQPco-i-asNa-ESg');
  v_run    record;
  v_count  int := 0;
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'playbook_dispatch_secret';
  if v_secret is null then return 'no dispatch secret'; end if;

  for v_run in
    select id, tenant_id, de_id, archetype_key
      from eval_runs
     where status = 'running'
       and de_id is not null
       and finished_at is null
       and coalesce(jsonb_array_length(results), 0) < total
       and tenant_is_operational(tenant_id)
  loop
    perform net.http_post(
      url     := public.platform_fn_url('/functions/v1/eval-run'),
      body    := jsonb_build_object(
                   'run_id',        v_run.id,
                   'tenant_id',     v_run.tenant_id,
                   'de_id',         v_run.de_id,
                   'archetype_key', v_run.archetype_key
                 ),
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'Authorization', 'Bearer ' || v_anon,
                   'x-dispatch-secret', v_secret
                 )
    , timeout_milliseconds := 60000);
    v_count := v_count + 1;
  end loop;

  return 'eval-driver dispatched ' || v_count || ' run(s)';
end;
$function$;

-- ── dispatch_de_improve_internal ──
CREATE OR REPLACE FUNCTION public.dispatch_de_improve_internal()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_secret text;
  v_anon   text := coalesce((select value from platform_runtime_config where key = 'supabase_anon_key'), 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmc3ZtaGNxZWl5cnhpdmJtcGVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxMzIwMDgsImV4cCI6MjA5NzcwODAwOH0.RKCWute2ypkx9X-ByumIQWw8MS5uQPco-i-asNa-ESg');
  v_row    record;
  v_count  int := 0;
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'playbook_dispatch_secret';
  if v_secret is null then return 'no dispatch secret'; end if;

  -- Retryability: an infra-caused mid-replay failure (fail_closed) must not
  -- permanently burn a judgment. Clear such proposals older than 3 days so the
  -- candidate query re-picks their judgment for another pass. A genuine
  -- "answer could not be improved" that did NOT fail closed stays deduped.
  delete from de_improvements
   where status = 'failed_replay'
     and (replay->'golden'->>'failed_closed') = 'true'
     and updated_at < now() - interval '3 days';

  -- One oldest-unhandled below-standard judgment per tenant (FIFO fairness +
  -- sidesteps the edge fn's recency-window picker), skipping tenants that
  -- already have >= 3 open reviews (backpressure on the human queue), and only
  -- for active employees. Passing judgment_id makes each tick idempotent.
  for v_row in
    with pending as (
      select tenant_id, count(*) n from de_improvements
       where status = 'review_pending' group by tenant_id
    )
    select distinct on (j.tenant_id) j.tenant_id, j.id as judgment_id
      from eval_judgments j
      join digital_employees de on de.id = j.de_id
       and de.status = 'active'
       and de.lifecycle_status not in ('retired','archived')
      left join pending p on p.tenant_id = j.tenant_id
     where j.verdict in ('fail','partial')
       and j.score < 70
       and j.de_id is not null
       and coalesce(p.n, 0) < 3
       and tenant_is_operational(j.tenant_id)
       and not exists (select 1 from de_improvements di
                        where di.tenant_id = j.tenant_id and di.judgment_id = j.id)
     order by j.tenant_id, j.created_at asc
     limit 25
  loop
    -- per-iteration isolation: a bad row can never abort the global tick.
    begin
      perform net.http_post(
        url     := public.platform_fn_url('/functions/v1/de-improve'),
        body    := jsonb_build_object('tenant_id', v_row.tenant_id, 'judgment_id', v_row.judgment_id),
        headers := jsonb_build_object(
                     'Content-Type', 'application/json',
                     'Authorization', 'Bearer ' || v_anon,
                     'x-dispatch-secret', v_secret
                   )
      , timeout_milliseconds := 60000);
      v_count := v_count + 1;
    exception when others then
      raise warning 'de-improve dispatch failed for tenant % judgment %: %', v_row.tenant_id, v_row.judgment_id, sqlerrm;
    end;
  end loop;

  -- Honest: the posts are async; this counts dispatches, not improvements.
  return 'de-improve dispatched ' || v_count || ' http_post(s) (async)';
end;
$function$;

-- ── dispatch_gap_improve_internal ──
CREATE OR REPLACE FUNCTION public.dispatch_gap_improve_internal()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_secret text;
  v_anon   text := coalesce((select value from platform_runtime_config where key = 'supabase_anon_key'), 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmc3ZtaGNxZWl5cnhpdmJtcGVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxMzIwMDgsImV4cCI6MjA5NzcwODAwOH0.RKCWute2ypkx9X-ByumIQWw8MS5uQPco-i-asNa-ESg');
  v_row    record;
  v_count  int := 0;
BEGIN
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'playbook_dispatch_secret';
  IF v_secret IS NULL THEN RETURN 'no dispatch secret'; END IF;

  FOR v_row IN
    WITH pending AS (
      SELECT tenant_id, count(*) n FROM de_improvements
       WHERE status = 'review_pending' GROUP BY tenant_id
    )
    SELECT DISTINCT ON (g.tenant_id) g.tenant_id, g.id AS cluster_id
      FROM knowledge_gap_clusters g
      LEFT JOIN pending p ON p.tenant_id = g.tenant_id
     WHERE g.status = 'open'
       AND g.de_improvement_id IS NULL
       AND g.representative_run_id IS NOT NULL
       AND coalesce(p.n, 0) < 3
       AND tenant_is_operational(g.tenant_id)
       AND NOT EXISTS (SELECT 1 FROM de_improvements di WHERE di.gap_cluster_id = g.id)
       -- draftable only: de-improve needs a DE + question from the rep run;
       -- a rep run with no de_id would 422 forever, so never dispatch it.
       AND EXISTS (SELECT 1 FROM evidence_runs r
                    WHERE r.id = g.representative_run_id
                      AND r.de_id IS NOT NULL AND r.inquiry IS NOT NULL)
     ORDER BY g.tenant_id, g.severity_score DESC NULLS LAST, g.member_count DESC
     LIMIT 25
  LOOP
    BEGIN
      PERFORM net.http_post(
        url     := public.platform_fn_url('/functions/v1/de-improve'),
        body    := jsonb_build_object('tenant_id', v_row.tenant_id, 'gap_cluster_id', v_row.cluster_id),
        headers := jsonb_build_object(
                     'Content-Type', 'application/json',
                     'Authorization', 'Bearer ' || v_anon,
                     'x-dispatch-secret', v_secret)
      , timeout_milliseconds := 60000);
      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'gap-improve dispatch failed for tenant % cluster %: %', v_row.tenant_id, v_row.cluster_id, sqlerrm;
    END;
  END LOOP;

  RETURN 'gap-improve dispatched ' || v_count || ' http_post(s) (async)';
END;
$function$;

-- ── dispatch_knowledge_sync_internal ──
CREATE OR REPLACE FUNCTION public.dispatch_knowledge_sync_internal()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_secret text;
  v_anon   text := coalesce((select value from platform_runtime_config where key = 'supabase_anon_key'), 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmc3ZtaGNxZWl5cnhpdmJtcGVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxMzIwMDgsImV4cCI6MjA5NzcwODAwOH0.RKCWute2ypkx9X-ByumIQWw8MS5uQPco-i-asNa-ESg');
  v_row    record;
  v_count  int := 0;
BEGIN
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'playbook_dispatch_secret';
  IF v_secret IS NULL THEN RETURN 'no dispatch secret'; END IF;

  FOR v_row IN
    SELECT c.id AS connector_id, c.tenant_id
      FROM connectors c
     WHERE c.scheduled_sync_enabled = true
       AND coalesce(c.access_mode, '') <> 'fetch_only'
       -- default-OFF flag => no tenant is touched until it explicitly opts in
       AND public.is_feature_enabled_internal(c.tenant_id, 'knowledge_scheduled_sync') = true
       AND tenant_is_operational(c.tenant_id)
       AND (c.last_scheduled_sync_at IS NULL
            OR c.last_scheduled_sync_at < now() - make_interval(mins => greatest(60, c.sync_interval_mins)))
     ORDER BY c.last_scheduled_sync_at ASC NULLS FIRST
     LIMIT 25
  LOOP
    BEGIN
      -- Claim first (advance the clock) so a slow/duplicate tick can't double-fire.
      UPDATE connectors SET last_scheduled_sync_at = now() WHERE id = v_row.connector_id;
      PERFORM net.http_post(
        url     := public.platform_fn_url('/functions/v1/connector-hub'),
        body    := jsonb_build_object('action', 'sync', 'connector_id', v_row.connector_id,
                                      'tenant_id', v_row.tenant_id, 'scheduled', true),
        headers := jsonb_build_object(
                     'Content-Type', 'application/json',
                     'Authorization', 'Bearer ' || v_anon,
                     'x-dispatch-secret', v_secret)
      , timeout_milliseconds := 60000);
      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'knowledge-sync dispatch failed for connector %: %', v_row.connector_id, sqlerrm;
    END;
  END LOOP;

  RETURN 'knowledge-sync dispatched ' || v_count || ' connector(s) (async)';
END;
$function$;

-- ── invoke_workforce_practice_review ──
CREATE OR REPLACE FUNCTION public.invoke_workforce_practice_review()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_secret text; v_de record; v_fired int := 0; v_req bigint;
BEGIN
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'playbook_dispatch_secret' LIMIT 1;
  IF v_secret IS NULL THEN
    PERFORM raise_ops_alert('dispatch_secret_missing',
      'playbook_dispatch_secret is missing from Vault — weekly workforce practice review is doing nothing.',
      jsonb_build_object('cron', 'invoke_workforce_practice_review'));
    RETURN 'no_secret';
  END IF;

  FOR v_de IN
    SELECT c.de_id, c.tenant_id, count(*) AS refusals
    FROM de_messages m
    JOIN de_conversations c ON c.id = m.conversation_id
    WHERE m.role = 'assistant'
      AND m.content ILIKE '%outside my guardrails%'
      AND m.created_at > now() - interval '14 days'
      AND tenant_is_operational(c.tenant_id)
    GROUP BY c.de_id, c.tenant_id
    HAVING count(*) >= 3
       AND NOT EXISTS (
         SELECT 1 FROM workforce_entity_amendments a
         WHERE a.entity_kind = 'de' AND a.entity_id = c.de_id AND a.status = 'review_pending')
    ORDER BY count(*) DESC
    LIMIT 5
  LOOP
    SELECT net.http_post(
      url := platform_fn_url('/functions/v1/entity-amend'),
      body := jsonb_build_object('tenant_id', v_de.tenant_id, 'entity_kind', 'de', 'entity_id', v_de.de_id),
      headers := jsonb_build_object('Content-Type','application/json','x-dispatch-secret',v_secret),
      timeout_milliseconds := 120000
    ) INTO v_req;
    v_fired := v_fired + 1;
  END LOOP;
  RETURN 'practice_review_fired:' || v_fired;
END;
$function$;

-- ── poll_de_work_sources_targets ──
CREATE OR REPLACE FUNCTION public.poll_de_work_sources_targets(p_tenant_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(tenant_id uuid, connector_id uuid, connector_provider text, connector_display_name text, category text, subject_kind text, subject_id uuid, subject_name text, last_seen_external_ref text, last_seen_timestamp timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select c.tenant_id, c.id, c.provider, c.display_name, c.category, g.subject_kind, g.subject_id,
    coalesce(sub.name, 'DE'), w.last_seen_external_ref, w.last_seen_timestamp
  from connectors c
  join data_access_grants g on g.tenant_id = c.tenant_id
   and ((g.resource_kind = 'connector' and g.resource_id = c.id) or (g.resource_kind = 'category' and g.resource_category = c.category))
   and access_permission_level(g.permission) >= access_permission_level('search')
  left join digital_employees sub on sub.id = g.subject_id
  left join digital_employees de on de.id = g.subject_id and g.subject_kind = 'de'
  left join inbox_watch_state w on w.tenant_id = c.tenant_id and w.connector_id = c.id
  where c.status <> 'disconnected'
    and (p_tenant_id is null or c.tenant_id = p_tenant_id)
    and tenant_is_operational(c.tenant_id)
    and (g.subject_kind <> 'de'
         or (de.lifecycle_status in ('assigned', 'active', 'improving') and de.status = 'active' and de_is_available(de.availability)))
    and not (
      g.subject_kind = 'de'
      and exists (
        select 1 from workforce_team_members me
        join workforce_teams t on t.id = me.team_id and t.status = 'active'
        join workforce_team_members peer on peer.team_id = me.team_id and peer.fallback_rank < me.fallback_rank
        join digital_employees pde on pde.id = peer.de_id
        where me.de_id = g.subject_id and t.tenant_id = c.tenant_id
          and pde.lifecycle_status in ('assigned', 'active', 'improving') and pde.status = 'active' and de_is_available(pde.availability)
          and exists (select 1 from data_access_grants pg where pg.tenant_id = c.tenant_id and pg.subject_kind = 'de' and pg.subject_id = pde.id
              and ((pg.resource_kind = 'connector' and pg.resource_id = c.id) or (pg.resource_kind = 'category' and pg.resource_category = c.category))
              and access_permission_level(pg.permission) >= access_permission_level('search'))
      )
    )
    and not (
      g.subject_kind = 'specialist'
      and exists (
        select 1 from data_access_grants g2 join digital_employees de2 on de2.id = g2.subject_id
        where g2.tenant_id = c.tenant_id and g2.subject_kind = 'de'
          and de2.lifecycle_status in ('assigned', 'active', 'improving') and de2.status = 'active' and de_is_available(de2.availability)
          and ((g2.resource_kind = 'connector' and g2.resource_id = c.id) or (g2.resource_kind = 'category' and g2.resource_category = c.category))
          and access_permission_level(g2.permission) >= access_permission_level('search')
      )
    );
$function$;

-- ── assess_de_skills_internal ──
CREATE OR REPLACE FUNCTION public.assess_de_skills_internal(p_tenant_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_de record;
  v_updated integer := 0;
  -- signal scratch
  v_dec_total integer; v_dec_escalated integer; v_dec_conf numeric;
  v_run_total integer; v_run_blocked integer; v_run_answered integer;
  v_csat_total integer; v_csat_pos integer;
  v_act_total integer; v_act_ok integer;
  -- per-skill result
  v_prof integer; v_prev integer; v_sample integer; v_value numeric; v_detail text;
  v_weak text[];
  v_weak_names text;
begin
  for v_de in
    select id, tenant_id, name from digital_employees
    where lifecycle_status not in ('retired', 'archived')
      and (p_tenant_id is null or tenant_id = p_tenant_id)
      and tenant_is_operational(tenant_id)
  loop
    v_weak := '{}';

    -- ── raw signals, all windowed to the last 30 days ──
    select count(*), count(*) filter (where d.decision = 'needs_review'),
           round(avg(d.confidence) filter (where d.confidence is not null), 1)
      into v_dec_total, v_dec_escalated, v_dec_conf
    from evidence_run_decisions d
    join evidence_runs er on er.id = d.evidence_run_id
    where er.tenant_id = v_de.tenant_id and er.de_id = v_de.id
      and d.created_at > now() - interval '30 days';

    -- Domain grounding measures GENUINE answer attempts only: a run
    -- that never reached the model (llm_not_configured — no key/budget,
    -- an infrastructure state, not a knowledge signal) or was withheld
    -- by a guardrail (blocked — a policy signal, not knowledge) does not
    -- count for or against the DE's domain knowledge. Denominator =
    -- answered + error (the DE tried); numerator = answered.
    select count(*) filter (where answer_status in ('answered', 'error')),
           count(*) filter (where answer_status = 'blocked'),
           count(*) filter (where answer_status = 'answered')
      into v_run_total, v_run_blocked, v_run_answered
    from evidence_runs
    where tenant_id = v_de.tenant_id and de_id = v_de.id
      and created_at > now() - interval '30 days';

    select count(*) filter (where csat_submitted_at is not null),
           count(*) filter (where csat_score = 1)
      into v_csat_total, v_csat_pos
    from de_conversations
    where tenant_id = v_de.tenant_id and de_id = v_de.id
      and csat_submitted_at > now() - interval '30 days';

    select count(*) filter (where decision in ('auto_executed', 'executed_after_approval', 'failed')),
           count(*) filter (where decision in ('auto_executed', 'executed_after_approval'))
      into v_act_total, v_act_ok
    from action_executions
    where tenant_id = v_de.tenant_id and subject_kind = 'de' and subject_id = v_de.id
      and mode = 'execute' and created_at > now() - interval '30 days';

    -- ── skill 1: Case Resolution (escalation rate, lower better) ──
    v_sample := coalesce(v_dec_total, 0);
    if v_sample >= 10 then
      v_value := round(100.0 * v_dec_escalated / v_sample, 1);
      v_prof := case when v_value <= 10 then 4 when v_value <= 25 then 3 when v_value <= 50 then 2 else 1 end;
      v_detail := format('Escalated %s%% of %s decisions (last 30 days). Lower is better; level 5 is human-awarded.', v_value, v_sample);
    else
      v_prof := null; v_value := null;
      v_detail := format('Not yet assessed — %s of the 10 real decisions needed.', v_sample);
    end if;
    call upsert_de_skill(v_de.tenant_id, v_de.id, 'case_resolution', v_prof, v_sample, v_value, v_detail, v_prev);
    if v_prof is not null and v_prof <= 2 then v_weak := array_append(v_weak, 'Case Resolution'); end if;
    if v_prof is distinct from v_prev then v_updated := v_updated + 1; end if;

    -- ── skill 2: Judgment Calibration (avg confidence, higher better) ──
    v_sample := coalesce(v_dec_total, 0);
    if v_sample >= 10 and v_dec_conf is not null then
      v_value := v_dec_conf;
      v_prof := case when v_value >= 80 then 4 when v_value >= 65 then 3 when v_value >= 50 then 2 else 1 end;
      v_detail := format('Average confidence %s%% across %s decisions (last 30 days). Level 5 is human-awarded.', v_value, v_sample);
    else
      v_prof := null; v_value := null;
      v_detail := format('Not yet assessed — %s of the 10 real decisions needed.', v_sample);
    end if;
    call upsert_de_skill(v_de.tenant_id, v_de.id, 'judgment_calibration', v_prof, v_sample, v_value, v_detail, v_prev);
    if v_prof is not null and v_prof <= 2 then v_weak := array_append(v_weak, 'Judgment Calibration'); end if;
    if v_prof is distinct from v_prev then v_updated := v_updated + 1; end if;

    -- ── skill 3: Domain Grounding (answered share of non-blocked) ──
    v_sample := coalesce(v_run_total, 0);
    if v_sample >= 10 then
      v_value := round(100.0 * v_run_answered / v_sample, 1);
      v_prof := case when v_value >= 90 then 4 when v_value >= 75 then 3 when v_value >= 50 then 2 else 1 end;
      v_detail := format('Produced a real answer on %s%% of %s genuine answer attempts (last 30 days). Level 5 is human-awarded.', v_value, v_sample);
    else
      v_prof := null; v_value := null;
      v_detail := format('Not yet assessed — %s of the 10 genuine answer attempts needed.', v_sample);
    end if;
    call upsert_de_skill(v_de.tenant_id, v_de.id, 'domain_grounding', v_prof, v_sample, v_value, v_detail, v_prev);
    if v_prof is not null and v_prof <= 2 then v_weak := array_append(v_weak, 'Domain Knowledge Grounding'); end if;
    if v_prof is distinct from v_prev then v_updated := v_updated + 1; end if;

    -- ── skill 4: Communication Quality (positive CSAT) ──
    v_sample := coalesce(v_csat_total, 0);
    if v_sample >= 5 then
      v_value := round(100.0 * v_csat_pos / v_sample, 1);
      v_prof := case when v_value >= 90 then 4 when v_value >= 75 then 3 when v_value >= 50 then 2 else 1 end;
      v_detail := format('%s%% positive across %s ratings (last 30 days). Level 5 is human-awarded.', v_value, v_sample);
    else
      v_prof := null; v_value := null;
      v_detail := format('Not yet assessed — %s of the 5 customer ratings needed.', v_sample);
    end if;
    call upsert_de_skill(v_de.tenant_id, v_de.id, 'communication_quality', v_prof, v_sample, v_value, v_detail, v_prev);
    if v_prof is not null and v_prof <= 2 then v_weak := array_append(v_weak, 'Communication Quality'); end if;
    if v_prof is distinct from v_prev then v_updated := v_updated + 1; end if;

    -- ── skill 5: System Integration (action success rate) ──
    v_sample := coalesce(v_act_total, 0);
    if v_sample >= 5 then
      v_value := round(100.0 * v_act_ok / v_sample, 1);
      v_prof := case when v_value >= 95 then 4 when v_value >= 85 then 3 when v_value >= 60 then 2 else 1 end;
      v_detail := format('%s%% of %s executed actions succeeded (last 30 days). Level 5 is human-awarded.', v_value, v_sample);
    else
      v_prof := null; v_value := null;
      v_detail := format('Not yet assessed — %s of the 5 executed actions needed.', v_sample);
    end if;
    call upsert_de_skill(v_de.tenant_id, v_de.id, 'system_integration', v_prof, v_sample, v_value, v_detail, v_prev);
    if v_prof is not null and v_prof <= 2 then v_weak := array_append(v_weak, 'System Integration'); end if;
    if v_prof is distinct from v_prev then v_updated := v_updated + 1; end if;

    -- ── §4.5: skill gaps drive Development. One consolidated item per
    --    DE, refreshed; removed when no skills are weak. ──
    if array_length(v_weak, 1) is not null then
      v_weak_names := array_to_string(v_weak, ', ');
      insert into de_development_items (tenant_id, de_id, item_type, source, priority, description, target_metric, target_value, baseline_value, status)
      values (v_de.tenant_id, v_de.id, 'skill_gap', 'detected', 'medium',
        format('%s is below Proficient (level 3) on: %s. These are assessed from real 30-day evidence — target level 3+.', v_de.name, v_weak_names),
        'skill_proficiency', 3, 2, 'proposed')
      on conflict (tenant_id, de_id, item_type) where source = 'detected' and status in ('proposed', 'in_progress')
      do update set description = excluded.description, updated_at = now();
    else
      -- No weak skills → retire any still-open detected skill_gap item.
      update de_development_items set status = 'completed', updated_at = now()
      where tenant_id = v_de.tenant_id and de_id = v_de.id and item_type = 'skill_gap'
        and source = 'detected' and status in ('proposed', 'in_progress');
    end if;
  end loop;

  return jsonb_build_object('skills_changed', v_updated);
end;
$function$;

-- ── detect_de_development_needs_internal ──
CREATE OR REPLACE FUNCTION public.detect_de_development_needs_internal(p_tenant_id uuid DEFAULT NULL::uuid)
 RETURNS SETOF de_development_items
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  t record;
  m record;
  v_candidate record;
  v_row de_development_items;
begin
  for t in
    select id from tenants
    where (p_tenant_id is null or id = p_tenant_id)
      and status in ('active', 'trial')
  loop
    for m in select * from get_de_performance_metrics(t.id, 8) where total_decisions >= 10
    loop
      for v_candidate in
        select * from (values
          ('escalation_spike', m.escalation_rate > 50, 'escalation_rate'::text, 30::numeric, m.escalation_rate,
            format('%s escalated %s%% of %s decisions over the last 8 weeks — more than half. Target: bring escalation rate under 30%%.', m.de_name, round(m.escalation_rate), m.total_decisions)),
          ('confidence_gap', m.avg_confidence < 50, 'avg_confidence', 65::numeric, m.avg_confidence,
            format('%s''s average confidence across %s decisions is %s%% — evidence or knowledge coverage may be thin. Target: 65%%+.', m.de_name, m.total_decisions, round(m.avg_confidence))),
          ('error_rate', m.error_rate > 15, 'error_rate', 5::numeric, m.error_rate,
            format('%s had a %s%% run error rate over the last 8 weeks (%s runs). Target: under 5%%.', m.de_name, round(m.error_rate), m.total_runs)),
          ('guardrail_pattern', m.total_runs > 0 and m.blocked_guardrail_count::numeric / m.total_runs > 0.1, 'blocked_guardrail_count', 0::numeric, m.blocked_guardrail_count::numeric,
            format('%s was blocked by a guardrail on %s of %s runs (%s%%) — review whether this is a knowledge gap or a genuinely out-of-scope request pattern.', m.de_name, m.blocked_guardrail_count, m.total_runs, round(m.blocked_guardrail_count::numeric / m.total_runs * 100)))
        ) as c(item_type, triggered, target_metric, target_value, baseline_value, description)
        where c.triggered
      loop
        insert into de_development_items (tenant_id, de_id, item_type, source, priority, description, target_metric, target_value, baseline_value, status)
        values (t.id, m.de_id, v_candidate.item_type, 'detected', 'medium', v_candidate.description, v_candidate.target_metric, v_candidate.target_value, v_candidate.baseline_value, 'proposed')
        on conflict (tenant_id, de_id, item_type) where source = 'detected' and status in ('proposed', 'in_progress')
        do update set description = excluded.description, baseline_value = excluded.baseline_value, updated_at = now()
        returning * into v_row;
        perform sync_de_lifecycle_from_development(m.de_id);
        return next v_row;
      end loop;
      -- Recovery pass (docs/31 Q10, mig 453): each opening bar above, inverted,
      -- releases the entry it opened once the measure is back inside the line;
      -- the employee lifecycle is then re-derived so the flip back to active
      -- fires when the last open entry goes. The two filters keep this
      -- statement away from human-created entries and from the kinds the
      -- other two sweeps own — each of those closes its own.
      update de_development_items i
         set status = 'completed', completed_at = now(), updated_at = now()
       where i.tenant_id = t.id and i.de_id = m.de_id
         and i.source = 'detected'
         and i.status in ('proposed', 'in_progress')
         and ((i.item_type = 'escalation_spike'  and m.escalation_rate <= 50)
           or (i.item_type = 'confidence_gap'    and m.avg_confidence >= 50)
           or (i.item_type = 'error_rate'        and m.error_rate <= 15)
           or (i.item_type = 'guardrail_pattern' and m.blocked_guardrail_count::numeric <= 0.1 * m.total_runs));
      if found then
        perform sync_de_lifecycle_from_development(m.de_id);
      end if;
    end loop;
  end loop;
  return;
end;
$function$;

-- ── detect_de_incidents_internal ──
CREATE OR REPLACE FUNCTION public.detect_de_incidents_internal(p_tenant_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_inserted integer := 0;
  v_count integer;
begin
  -- 1. Guardrail blocks from the triage pipeline (best attribution:
  --    evidence_runs.de_id).
  insert into de_incidents (tenant_id, de_id, kind, severity, title, detail, source_table, source_id, occurred_at)
  select d.tenant_id, er.de_id, 'guardrail_block', 'warning',
    'Guardrail blocked an automatic action',
    jsonb_build_object('reasoning', left(d.reasoning, 400), 'guardrail_rule_id', d.guardrail_rule_id,
                       'external_ref', d.external_ref, 'source_category', d.source_category,
                       'evidence_run_id', d.evidence_run_id),
    'evidence_run_decisions', d.id, d.created_at
  from evidence_run_decisions d
  join evidence_runs er on er.id = d.evidence_run_id
  where d.decision = 'blocked_guardrail'
    and d.created_at > now() - interval '30 days'
    and (p_tenant_id is null or d.tenant_id = p_tenant_id)
    and tenant_is_operational(d.tenant_id)
  on conflict (tenant_id, source_table, source_id) do nothing;
  get diagnostics v_count = row_count; v_inserted := v_inserted + v_count;

  -- 2. Guardrail blocks recorded straight to the audit trail (widget/
  --    chat answers withheld). Attribution by actor name — the same
  --    semantics the old profile tab used, now persisted once.
  insert into de_incidents (tenant_id, de_id, kind, severity, title, detail, source_table, source_id, occurred_at)
  select a.tenant_id,
    (select de.id from digital_employees de
     where de.tenant_id = a.tenant_id and (de.name = a.actor or de.persona_name = a.actor)
     limit 1),
    'guardrail_block', 'warning',
    'Guardrail withheld an answer',
    jsonb_build_object('action', left(a.action, 400), 'rule', a.detail->>'rule', 'channel', a.detail->>'channel'),
    'audit_events', a.id, a.created_at
  from audit_events a
  where a.category = 'guardrail_block'
    and a.created_at > now() - interval '30 days'
    and (p_tenant_id is null or a.tenant_id = p_tenant_id)
    and tenant_is_operational(a.tenant_id)
  on conflict (tenant_id, source_table, source_id) do nothing;
  get diagnostics v_count = row_count; v_inserted := v_inserted + v_count;

  -- 3. Automatic trust demotions (migration 025's "demote fast" path).
  insert into de_incidents (tenant_id, de_id, kind, severity, title, detail, source_table, source_id, occurred_at)
  select a.tenant_id,
    nullif(a.detail->>'de_id', '')::uuid,
    'trust_demotion', 'critical',
    'Trust level automatically demoted',
    jsonb_build_object('action', left(a.action, 400), 'action_category', a.detail->>'action_category',
                       'policy_id', a.detail->>'policy_id'),
    'audit_events', a.id, a.created_at
  from audit_events a
  where a.detail->>'kind' = 'trust_demoted'
    and a.created_at > now() - interval '30 days'
    and (p_tenant_id is null or a.tenant_id = p_tenant_id)
    and tenant_is_operational(a.tenant_id)
  on conflict (tenant_id, source_table, source_id) do nothing;
  get diagnostics v_count = row_count; v_inserted := v_inserted + v_count;

  -- 4. Failed eval runs (tenant-level: no single attributable DE).
  insert into de_incidents (tenant_id, de_id, kind, severity, title, detail, source_table, source_id, occurred_at)
  select r.tenant_id, null,
    'eval_regression', 'warning',
    format('Golden QA run failed — %s of %s passed', r.passed, r.total),
    jsonb_build_object('run_id', r.id, 'passed', r.passed, 'failed', r.failed, 'trigger', r.trigger),
    'eval_runs', r.id, coalesce(r.finished_at, r.started_at)
  from eval_runs r
  where r.status = 'failed'
    and coalesce(r.finished_at, r.started_at) > now() - interval '30 days'
    and (p_tenant_id is null or r.tenant_id = p_tenant_id)
    and tenant_is_operational(r.tenant_id)
  on conflict (tenant_id, source_table, source_id) do nothing;
  get diagnostics v_count = row_count; v_inserted := v_inserted + v_count;

  -- 5. Humans rejecting a proposed action (a draft the DE got wrong).
  insert into de_incidents (tenant_id, de_id, kind, severity, title, detail, source_table, source_id, occurred_at)
  select t.tenant_id,
    case when ae.subject_kind = 'de' then ae.subject_id else null end,
    'action_rejected', 'info',
    format('Proposed action rejected by a human — %s', left(t.title, 120)),
    jsonb_build_object('task_id', t.id, 'request_summary', left(ae.request_summary, 300), 'decided_at', t.decided_at),
    'human_tasks', t.id, coalesce(t.decided_at, t.created_at)
  from human_tasks t
  join action_executions ae on ae.task_id = t.id
  where t.type = 'action_approval' and t.status = 'rejected'
    and coalesce(t.decided_at, t.created_at) > now() - interval '30 days'
    and (p_tenant_id is null or t.tenant_id = p_tenant_id)
    and tenant_is_operational(t.tenant_id)
  on conflict (tenant_id, source_table, source_id) do nothing;
  get diagnostics v_count = row_count; v_inserted := v_inserted + v_count;

  return jsonb_build_object('inserted', v_inserted);
end;
$function$;

-- ── de_governance_sweep_internal ──
CREATE OR REPLACE FUNCTION public.de_governance_sweep_internal()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_cert record;
  v_pip record;
  v_inc record;
  m record;
  v_warned integer := 0;
  v_expired integer := 0;
  v_pip_completed integer := 0;
  v_pip_failed integer := 0;
  v_sla integer := 0;
  v_de_name text;
  v_passing boolean;
begin
  -- (a) Expiring within 14 days → one warning audit event per cert.
  for v_cert in
    select c.*, de.name as de_name from de_certifications c
    join digital_employees de on de.id = c.de_id
    where c.status = 'active' and c.warned_at is null
      and c.expires_at <= now() + interval '14 days' and c.expires_at > now()
      and tenant_is_operational(c.tenant_id)
  loop
    update de_certifications set warned_at = now() where id = v_cert.id;
    perform append_audit_event_internal(
      v_cert.tenant_id, 'Governance sweep', 'system',
      format('%s''s %s certification expires %s — recertify to keep it current', v_cert.de_name, v_cert.cert_type, to_char(v_cert.expires_at, 'YYYY-MM-DD')),
      'config_change',
      jsonb_build_object('kind', 'certification_expiring', 'cert_id', v_cert.id, 'de_id', v_cert.de_id)
    );
    v_warned := v_warned + 1;
  end loop;

  -- (b) Expired → status flip + incident (dedup via unique source key).
  for v_cert in
    select c.*, de.name as de_name from de_certifications c
    join digital_employees de on de.id = c.de_id
    where c.status = 'active' and c.expires_at <= now()
      and tenant_is_operational(c.tenant_id)
  loop
    update de_certifications set status = 'expired' where id = v_cert.id;
    insert into de_incidents (tenant_id, de_id, kind, severity, title, detail, source_table, source_id, occurred_at)
    values (v_cert.tenant_id, v_cert.de_id, 'certification_expired', 'warning',
      format('%s certification expired — %s', initcap(v_cert.cert_type), v_cert.de_name),
      jsonb_build_object('cert_id', v_cert.id, 'cert_type', v_cert.cert_type, 'scope', v_cert.scope,
                         'issued_by', v_cert.issued_by_name, 'expired_at', v_cert.expires_at),
      'de_certifications', v_cert.id, v_cert.expires_at)
    on conflict (tenant_id, source_table, source_id) do nothing;
    v_expired := v_expired + 1;
  end loop;

  -- (c) Overdue open PIPs → RE-MEASURE on a fresh 4-week window: now
  --     passing → completed (closed loop); still failing → 'failed' +
  --     CRITICAL incident for human trust review.
  for v_pip in
    select i.* from de_development_items i
    where i.item_type = 'pip' and i.source = 'detected'
      and i.status in ('proposed', 'in_progress') and i.due_date < current_date
      and tenant_is_operational(i.tenant_id)
  loop
    select name into v_de_name from digital_employees where id = v_pip.de_id;
    v_passing := false;
    for m in select * from get_de_performance_metrics(v_pip.tenant_id, 4) where de_id = v_pip.de_id loop
      v_passing := m.total_decisions >= 10
        and m.escalation_rate <= 50 and m.avg_confidence >= 50 and m.error_rate <= 15;
    end loop;

    if v_passing then
      update de_development_items set status = 'completed', completed_at = now(), updated_at = now() where id = v_pip.id;
      perform append_audit_event_internal(
        v_pip.tenant_id, 'Governance sweep', 'system',
        format('%s met its Performance Improvement Plan targets — PIP closed', coalesce(v_de_name, 'Employee')),
        'config_change',
        jsonb_build_object('kind', 'pip_completed', 'item_id', v_pip.id, 'de_id', v_pip.de_id)
      );
      v_pip_completed := v_pip_completed + 1;
    else
      update de_development_items set status = 'failed', updated_at = now() where id = v_pip.id;
      insert into de_incidents (tenant_id, de_id, kind, severity, title, detail, source_table, source_id, occurred_at)
      values (v_pip.tenant_id, v_pip.de_id, 'pip_failed', 'critical',
        format('Performance Improvement Plan failed — %s', coalesce(v_de_name, 'employee')),
        jsonb_build_object('item_id', v_pip.id, 'due_date', v_pip.due_date,
          'consequence', v_pip.consequence,
          'next_step', 'A human decides here: trust reduction, added approval gates, or pause (Pause is on the employee profile).'),
        'de_development_items', v_pip.id, now())
      on conflict (tenant_id, source_table, source_id) do nothing;
      v_pip_failed := v_pip_failed + 1;
    end if;
  end loop;

  -- (d) §10.3: critical incidents should be reviewed within 48 hours —
  --     one nudge each (detail flag dedup).
  for v_inc in
    select * from de_incidents
    where status = 'open' and severity = 'critical'
      and created_at < now() - interval '48 hours'
      and coalesce(detail->>'sla_nudged', '') = ''
      and tenant_is_operational(tenant_id)
  loop
    update de_incidents set detail = detail || '{"sla_nudged": true}'::jsonb where id = v_inc.id;
    perform append_audit_event_internal(
      v_inc.tenant_id, 'Governance sweep', 'system',
      format('Critical incident open past the 48-hour review window: %s', left(v_inc.title, 160)),
      'config_change',
      jsonb_build_object('kind', 'incident_sla_nudge', 'incident_id', v_inc.id, 'de_id', v_inc.de_id)
    );
    v_sla := v_sla + 1;
  end loop;

  return jsonb_build_object('cert_warnings', v_warned, 'certs_expired', v_expired,
    'pips_completed', v_pip_completed, 'pips_failed', v_pip_failed, 'sla_nudges', v_sla);
end;
$function$;

-- ── run_de_performance_review_internal ──
CREATE OR REPLACE FUNCTION public.run_de_performance_review_internal(p_tenant_id uuid DEFAULT NULL::uuid, p_de_id uuid DEFAULT NULL::uuid)
 RETURNS SETOF de_performance_reviews
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_t record;
  m record;
  v_skills jsonb;
  v_verdict text;
  v_summary text;
  v_row de_performance_reviews;
  v_period_start date := (date_trunc('quarter', now()))::date;
  v_period_end date := current_date;
begin
  for v_t in
    select distinct de.tenant_id as tid from digital_employees de
    where de.lifecycle_status not in ('retired', 'archived')
      and (p_tenant_id is null or de.tenant_id = p_tenant_id)
      and tenant_is_operational(de.tenant_id)
  loop
    for m in
      select * from get_de_performance_metrics(v_t.tid, 13)
      where (p_de_id is null or de_id = p_de_id)
    loop
      -- Skip DEs outside the operational world (pre-launch/paused have
      -- nothing meaningful to review).
      if not exists (select 1 from digital_employees d where d.id = m.de_id
                     and d.lifecycle_status in ('assigned', 'active', 'improving', 'paused')) then
        continue;
      end if;

      select coalesce(jsonb_agg(jsonb_build_object('skill', s.skill_key, 'proficiency', s.proficiency, 'value', s.signal_value)), '[]'::jsonb)
        into v_skills from de_skills s where s.de_id = m.de_id;

      if m.total_decisions < 10 then
        v_verdict := 'insufficient_data';
        v_summary := format('%s handled %s decisions this period — below the 10 needed for a meaningful verdict. No judgment recorded on thin evidence.', m.de_name, m.total_decisions);
      elsif m.escalation_rate > 50 or m.avg_confidence < 50 or m.error_rate > 15 then
        v_verdict := 'below';
        v_summary := format('%s is below threshold this period: %s%% escalation (target <50), %s%% avg confidence (target 65+), %s%% error rate (target <15), across %s decisions. A Performance Improvement Plan has been opened.',
          m.de_name, round(m.escalation_rate), round(m.avg_confidence), round(m.error_rate), m.total_decisions);
      else
        v_verdict := 'meets';
        v_summary := format('%s meets expectations this period: %s%% resolution, %s%% avg confidence, %s%% error rate across %s decisions.',
          m.de_name, round(m.resolution_rate), round(m.avg_confidence), round(m.error_rate), m.total_decisions);
      end if;

      insert into de_performance_reviews (tenant_id, de_id, period_start, period_end, verdict, summary, metrics_snapshot)
      values (v_t.tid, m.de_id, v_period_start, v_period_end, v_verdict, v_summary,
        jsonb_build_object(
          'total_decisions', m.total_decisions, 'resolution_rate', m.resolution_rate,
          'avg_confidence', m.avg_confidence, 'escalation_rate', m.escalation_rate,
          'error_rate', m.error_rate, 'blocked_guardrail_count', m.blocked_guardrail_count,
          'avg_frustration_score', m.avg_frustration_score, 'skills', v_skills))
      on conflict (tenant_id, de_id, period_start)
      do update set period_end = excluded.period_end, verdict = excluded.verdict,
                    summary = excluded.summary, metrics_snapshot = excluded.metrics_snapshot
      returning * into v_row;

      if v_verdict = 'below' then
        -- §10.4: the PIP — a Development item with a formal deadline
        -- and a written consequence. One open PIP per DE (the partial
        -- unique index on detected items).
        insert into de_development_items (tenant_id, de_id, item_type, source, priority, description,
          target_metric, target_value, baseline_value, status, due_date, consequence)
        values (v_t.tid, m.de_id, 'pip', 'detected', 'high',
          format('Performance Improvement Plan for %s (quarterly review %s): bring escalation under 50%%, average confidence to 50+, and error rate under 15%% within 30 days. Current: %s%% / %s%% / %s%%.',
            m.de_name, v_period_start, round(m.escalation_rate), round(m.avg_confidence), round(m.error_rate)),
          'quarterly_review_thresholds', 1, 0, 'proposed', current_date + 30,
          'If targets are not met by the due date, a CRITICAL incident is raised for trust review — possible outcomes decided by a human there: trust reduction, added approval gates, or pause.')
        on conflict (tenant_id, de_id, item_type) where source = 'detected' and status in ('proposed', 'in_progress')
        do update set description = excluded.description, due_date = excluded.due_date, updated_at = now();
      elsif v_verdict = 'meets' then
        update de_development_items set status = 'completed', completed_at = now(), updated_at = now()
        where tenant_id = v_t.tid and de_id = m.de_id and item_type = 'pip'
          and source = 'detected' and status in ('proposed', 'in_progress');
      end if;

      return next v_row;
    end loop;
  end loop;
  return;
end;
$function$;

-- ── snapshot_all_de_kpi_readings ──
CREATE OR REPLACE FUNCTION public.snapshot_all_de_kpi_readings()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare d record; v_total int := 0; v_des int := 0;
begin
  for d in
    select id from digital_employees
     where coalesce(lifecycle_status, 'active') not in ('retired', 'archived')
       and tenant_is_operational(tenant_id)
  loop
    begin
      v_total := v_total + public.snapshot_de_kpi_readings(d.id);   -- per-DE isolation
      v_des := v_des + 1;
    exception when others then
      raise warning 'snapshot_de_kpi_readings(%) failed: %', d.id, sqlerrm;
    end;
  end loop;
  -- Retention: system snapshots are cheap to recompute; keep 180 days.
  delete from de_kpi_readings where source = 'system' and as_of < current_date - 180;
  return jsonb_build_object('des', v_des, 'written', v_total);
end $function$;

-- ── sync_de_lifecycle_auto_internal ──
CREATE OR REPLACE FUNCTION public.sync_de_lifecycle_auto_internal()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row record;
  v_count integer := 0;
begin
  for v_row in
    select de.id, de.tenant_id, de.name from digital_employees de
    where de.lifecycle_status = 'assigned'
      and tenant_is_operational(de.tenant_id)
      and exists (select 1 from evidence_runs er where er.tenant_id = de.tenant_id and er.de_id = de.id)
  loop
    update digital_employees set lifecycle_status = 'active', updated_at = now() where id = v_row.id;
    insert into de_lifecycle_events (tenant_id, de_id, from_stage, to_stage, actor_label, note)
    values (v_row.tenant_id, v_row.id, 'assigned', 'active', 'system', 'First live execution observed — activated automatically.');
    v_count := v_count + 1;
  end loop;
  return jsonb_build_object('activated', v_count);
end;
$function$;

-- ── Assertions: every dispatcher above actually carries the guard ──────────
do $assert$
declare
  v_fn text;
  v_missing text := '';
begin
  -- helper semantics: null tenant → operational, unknown tenant → dormant
  if not tenant_is_operational(null) then
    raise exception 'mig 430: tenant_is_operational(null) must be true';
  end if;
  if tenant_is_operational(gen_random_uuid()) then
    raise exception 'mig 430: tenant_is_operational(<missing row>) must be false';
  end if;

  foreach v_fn in array array['dispatch_due_triggers', 'invoke_playbook_dispatch', 'run_work_watchers', 'run_case_timeline', 'wake_due_objectives', 'claim_de_work_items', 'dispatch_de_work_internal', 'dispatch_eval_driver_internal', 'dispatch_de_improve_internal', 'dispatch_gap_improve_internal', 'dispatch_knowledge_sync_internal', 'invoke_workforce_practice_review', 'poll_de_work_sources_targets', 'assess_de_skills_internal', 'detect_de_development_needs_internal', 'detect_de_incidents_internal', 'de_governance_sweep_internal', 'run_de_performance_review_internal', 'snapshot_all_de_kpi_readings', 'sync_de_lifecycle_auto_internal']
  loop
    if not exists (
      select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_fn
        and (p.prosrc like '%tenant_is_operational%'
             or p.prosrc like '%status in (''active'', ''trial'')%')
    ) then
      v_missing := v_missing || ' ' || v_fn;
    end if;
  end loop;

  if v_missing <> '' then
    raise exception 'mig 430 assertion failed — still unguarded:%', v_missing;
  end if;
end
$assert$;
