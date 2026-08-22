-- ============================================================================
-- Close the cross-tenant read oracles.
--
-- ⚠ THIS FILE IS STAGED, NOT NUMBERED. It was written in a session with no
-- production access, and scripts/migration-next.mjs takes its claim ON
-- production ("NO PRODUCTION, NO CLAIM") rather than guessing — guessing is
-- what produced the 23 duplicate number prefixes already in this tree. To land
-- it:
--
--     npm run migrate:next -- close_the_cross_tenant_read_oracles
--     # move this body into the file that prints, commit, push, merge to main
--     node scripts/db-query.mjs --file supabase/migrations/<NNN>_<slug>.sql
--
-- ── THE DEFECT CLASS ───────────────────────────────────────────────────────
-- A SECURITY DEFINER routine (RLS bypassed), EXECUTE-granted to `authenticated`,
-- that takes a CALLER-SUPPLIED id, uses it in a read, and lets the RESULT of
-- that read reach the caller — without asserting the caller's tenancy.
--
-- The authorization check may exist elsewhere in the routine and still not save
-- it: what leaks is the value read BEFORE or BESIDE the check.
--
-- Three instances have now been found. The third was fixed one at a time in
-- migration 823 (de_kpi_action_value, which leaked cross-tenant aggregates to
-- the ANONYMOUS key — proven with three live reads from outside every
-- workspace). These are the other two.
--
--   1. decide_human_tasks / preview_decide_human_tasks
--      Both open their per-id loop with an UNSCOPED
--          select title into v_title from human_tasks where id = v_id;
--      The delegate decide_human_task IS correct: it derives the tenant from
--      the JWT and raises task_not_found for a foreign id. But the wrapper
--      CATCHES that and returns the title the unscoped read already fetched.
--      preview_… is the better vehicle: it writes nothing, is explicitly a dry
--      run, and takes 500 ids per call.
--      Titles are not low-value strings. From this repo's own committed probe
--      output: "Send a $15,600 invoice to Meridian Group" — a customer name and
--      a contract value in one field.
--      HONEST BOUND: human_tasks.id is a random v4 uuid, so this is an ORACLE,
--      not a dump. It converts a leaked/observed task uuid into a confirmed
--      cross-tenant read. Reporting it as mass exfiltration would be wrong.
--
--   2. validate_watcher_config(p_kind, p_config, p_tenant_id, p_de_id)
--      authenticated-callable SECDEF; allowlist entry {anon:false, authed:true}.
--      Its ONLY use of p_tenant_id / p_de_id is a data_access_grants lookup
--      whose miss returns a DIFFERENT string. So a caller in tenant A supplies
--      tenant B's ids and learns whether B's named employee holds a given
--      data-access grant. A cross-tenant authorization oracle.
--
-- ── WHY THE SIBLING PROVES THESE ARE SLIPS, NOT POLICY ─────────────────────
-- public.withdraw_human_tasks — same file, same author, same batch shape —
-- returns only {id, error} and never reads a title. The correct form was
-- already written next to the incorrect one.
--
-- ── WHAT CHANGES FOR A LEGITIMATE CALLER: NOTHING ──────────────────────────
-- For the caller's own task the title is unchanged. For a foreign id v_title
-- falls to NULL and the existing coalesce(v_title,'(untitled)') already renders
-- '(untitled)'. No caller contract moves.
--
-- Bodies below are the PRODUCTION source, extracted from
-- supabase/baseline/full_schema.sql programmatically rather than transcribed,
-- with one read scoped in each. Diff them against the baseline before applying.
-- ============================================================================

begin;

CREATE OR REPLACE FUNCTION public.decide_human_tasks(p_task_ids uuid[], p_decision text, p_reason_code text DEFAULT NULL::text, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_id     uuid;
  v_ok     int := 0;
  v_failed jsonb := '[]'::jsonb;
  v_row    human_tasks;
  v_title  text;
begin
  if p_task_ids is null or array_length(p_task_ids, 1) is null then
    return jsonb_build_object('decided', 0, 'failed', v_failed);
  end if;
  -- Same 500 cap as withdraw_human_tasks, for the same reason: a UI bug must
  -- not be able to clear a whole workspace's queue in one call.
  if array_length(p_task_ids, 1) > 500 then
    raise exception 'too_many: decide at most 500 tasks at a time (got %)', array_length(p_task_ids, 1);
  end if;

  foreach v_id in array p_task_ids loop
    -- SEC-02: scoped. This read is SECURITY DEFINER (RLS bypassed) and the
    -- title it fetches reaches the caller on the FAILURE path below, which is
    -- exactly what a foreign id produces. Unscoped, it returned another
    -- tenant's task title -- customer names and contract values.
    select title into v_title from human_tasks
     where id = v_id and tenant_id = auth_tenant_id();
    begin
      v_row := public.decide_human_task(v_id, p_decision, p_reason_code, p_note);
      -- NULL is not failure here. decide_human_task returns NULL on the
      -- first-approver path: the approval was RECORDED and the task stays
      -- pending until a different person signs. Reporting that as an error
      -- would teach people to press it twice.
      if v_row.id is null then
        v_failed := v_failed || jsonb_build_object(
          'id', v_id, 'title', coalesce(v_title, '(untitled)'),
          'error', 'first_approval_recorded: a second approver is required');
      elsif v_row.status is distinct from p_decision then
        -- mig 836: THE THIRD STATE. A row came back but the task was NOT
        -- closed -- the server refused and said why on the row. This is not
        -- an exception, so the refusal it recorded COMMITS with the rest of
        -- the batch; counting it as decided would be the exact lie this
        -- migration exists to remove.
        v_failed := v_failed || jsonb_build_object(
          'id', v_id, 'title', coalesce(v_title, '(untitled)'),
          'error', coalesce(v_row.refusal_reason,
                            format('refused: the task is still %s', v_row.status)));
      else
        v_ok := v_ok + 1;
      end if;
    exception when others then
      v_failed := v_failed || jsonb_build_object(
        'id', v_id, 'title', coalesce(v_title, '(untitled)'), 'error', sqlerrm);
    end;
  end loop;

  return jsonb_build_object('decided', v_ok, 'failed', v_failed);
end
$function$;

CREATE OR REPLACE FUNCTION public.preview_decide_human_tasks(p_task_ids uuid[], p_decision text, p_reason_code text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_id      uuid;
  v_ok      int := 0;
  v_refuse  jsonb := '[]'::jsonb;
  v_title   text;
  v_prow    human_tasks;
  -- mig 836: the verdict has to travel OUT through the raise, because the
  -- raise is what undoes the trial decision. A plpgsql variable assigned
  -- inside the block survives the unwind, but only the message is guaranteed
  -- to reach the handler, so the reason rides on it behind a sentinel prefix.
  v_why     text;
begin
  if p_task_ids is null or array_length(p_task_ids, 1) is null then
    return jsonb_build_object('would_succeed', 0, 'would_refuse', 0, 'refusals', v_refuse);
  end if;
  if array_length(p_task_ids, 1) > 500 then
    raise exception 'too_many: preview at most 500 tasks at a time (got %)', array_length(p_task_ids, 1);
  end if;

  foreach v_id in array p_task_ids loop
    -- SEC-02: scoped. This read is SECURITY DEFINER (RLS bypassed) and the
    -- title it fetches reaches the caller on the FAILURE path below, which is
    -- exactly what a foreign id produces. Unscoped, it returned another
    -- tenant's task title -- customer names and contract values.
    select title into v_title from human_tasks
     where id = v_id and tenant_id = auth_tenant_id();
    begin
      v_prow := public.decide_human_task(v_id, p_decision, p_reason_code, '__preview__');
      if v_prow.id is not null and v_prow.status is distinct from p_decision then
        -- mig 836: refused, and the trial write must still be undone. The
        -- refusal record decide_human_task just made is rolled back with
        -- everything else -- a preview does not write, not even a refusal.
        raise exception using errcode = 'P0001',
          message = '__PREVIEW_WOULD_REFUSE__' || coalesce(v_prow.refusal_reason, 'refused without a reason');
      end if;
      -- Reaching this line means the decision WOULD go through. Undo it: the
      -- raise rolls this block back to where it started.
      raise exception using errcode = 'P0001', message = '__PREVIEW_WOULD_SUCCEED__';
    exception when others then
      if sqlerrm = '__PREVIEW_WOULD_SUCCEED__' then
        v_ok := v_ok + 1;
      elsif sqlerrm like '__PREVIEW_WOULD_REFUSE__%' then
        v_why := substr(sqlerrm, length('__PREVIEW_WOULD_REFUSE__') + 1);
        v_refuse := v_refuse || jsonb_build_object(
          'id', v_id, 'title', coalesce(v_title, '(untitled)'), 'why', v_why);
      else
        v_refuse := v_refuse || jsonb_build_object(
          'id', v_id, 'title', coalesce(v_title, '(untitled)'), 'why', sqlerrm);
      end if;
    end;
  end loop;

  return jsonb_build_object(
    'would_succeed', v_ok,
    'would_refuse',  jsonb_array_length(v_refuse),
    'refusals',      v_refuse);
end
$function$;

CREATE OR REPLACE FUNCTION public.validate_watcher_config(p_kind text, p_config jsonb, p_tenant_id uuid, p_de_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  c    jsonb := coalesce(p_config, '{}'::jsonb);
  src  text  := coalesce(p_config->>'source', 'customer_accounts');
  s    watch_source_catalog;
  f    watch_source_fields;
  v_op text := coalesce(c->>'op', '');
  v_datef text;
  v_grant_ok boolean;
  v_rw jsonb; v_ru text; v_ra text;
BEGIN
  -- SEC-09: the caller must belong to the workspace whose grants this reads.
  -- Without it the differing return strings below are a cross-tenant
  -- authorization oracle. _assert_caller_tenant is the house helper and is
  -- already in the EXECUTE allowlist.
  perform public._assert_caller_tenant(p_tenant_id);

  -- ── the response window: a DECLARED service standard ──────────────────────
  -- Settable on any watcher that opens a case from a condition, in minutes,
  -- hours, days, or as a specific calendar date. Refused at write time when
  -- malformed, because a typo would otherwise silently mean "no deadline" —
  -- which reads identically to "nobody has declared one", and telling those two
  -- apart is the entire point of the field.
  IF c ? 'response_window' THEN
    v_rw := c->'response_window';
    IF jsonb_typeof(v_rw) <> 'object' THEN
      RETURN 'Set a response window as an amount and a unit, or as a specific date.';
    END IF;
    v_ru := v_rw->>'unit'; v_ra := v_rw->>'amount';

    -- A date watcher already HAS a deadline: the date it counts down to. A
    -- second one would compete with it, and there is no honest way to say which
    -- of two deadlines is the real one.
    IF p_kind = 'date_horizon' THEN
      RETURN 'This watcher already has a deadline — the date it counts down to.';
    END IF;

    IF v_ru = 'date' THEN
      IF v_rw->>'at' IS NULL THEN
        RETURN 'Pick the date this has to be handled by.';
      END IF;
      BEGIN
        PERFORM (v_rw->>'at')::timestamptz;
      EXCEPTION WHEN OTHERS THEN
        RETURN 'That deadline is not a real date.';
      END;
    ELSIF v_ru IN ('minutes','hours','days') THEN
      IF v_ra IS NULL OR v_ra !~ '^[0-9]{1,9}$' OR v_ra::bigint < 1 THEN
        RETURN format('Respond within how many %s? Give a whole number above zero.', v_ru);
      END IF;
      IF (v_ru = 'minutes' AND v_ra::bigint > 5256000)
      OR (v_ru = 'hours'   AND v_ra::bigint > 87600)
      OR (v_ru = 'days'    AND v_ra::bigint > 3650) THEN
        RETURN 'A response window longer than ten years is not a deadline.';
      END IF;
    ELSE
      RETURN 'A response window is set in minutes, hours, days, or by a specific date.';
    END IF;
  END IF;

  IF p_kind IN ('date_horizon','state_condition') THEN
    SELECT * INTO s FROM watch_source_catalog WHERE source_key = src AND active;
    IF s.source_key IS NULL THEN
      RETURN format('There is no watchable source called "%s" here.', src);
    END IF;
    IF NOT (p_kind = ANY (s.supports_kinds)) THEN
      RETURN format('"%s" can''t be watched by %s.', src, replace(p_kind, '_', ' '));
    END IF;

    IF p_kind = 'date_horizon' THEN
      v_datef := coalesce(c->>'date_field',
                   (SELECT column_name FROM watch_source_fields
                     WHERE source_key = src AND role = 'date' ORDER BY column_name LIMIT 1));
      IF v_datef IS NULL OR NOT EXISTS (
           SELECT 1 FROM watch_source_fields
            WHERE source_key = src AND role = 'date' AND column_name = v_datef) THEN
        RETURN format('"%s" isn''t a date we can count down to on %s.',
                      coalesce(c->>'date_field', '(none)'), src);
      END IF;
      IF c ? 'horizons_days' AND jsonb_typeof(c->'horizons_days') <> 'array' THEN
        RETURN 'Reminder windows must be a list like [90, 60, 30].';
      END IF;

    ELSE  -- state_condition
      SELECT * INTO f FROM watch_source_fields
        WHERE source_key = src AND role = 'state' AND column_name = c->>'field';
      IF f.column_name IS NULL THEN
        RETURN format('"%s" isn''t a state we can watch on %s.',
                      coalesce(c->>'field', '(none)'), src);
      END IF;
      IF NOT (v_op = ANY (f.allowed_ops)) THEN
        RETURN format('"%s" can''t be compared with "%s".', f.column_name, v_op);
      END IF;
      IF c->>'value' IS NULL THEN RETURN 'This condition needs a value.'; END IF;
      IF f.value_type = 'numeric' AND (c->>'value') !~ '^-?[0-9]+(\.[0-9]+)?$' THEN
        RETURN format('"%s" needs a number.', f.column_name);
      END IF;
    END IF;

    IF s.require_domain_grant THEN
      SELECT EXISTS (SELECT 1 FROM data_access_grants g
                      WHERE g.tenant_id = p_tenant_id AND g.subject_kind = 'de'
                        AND g.subject_id = p_de_id
                        AND g.resource_category = s.domain_category)
        INTO v_grant_ok;
      IF NOT v_grant_ok THEN
        RETURN format('This employee isn''t cleared to work %s.',
                      coalesce(s.domain_category, src));
      END IF;
    END IF;

  ELSIF p_kind = 'metric_threshold' THEN
    IF c->>'metric_key' IS NULL THEN RETURN 'A metric watcher needs a metric.'; END IF;
    IF NOT (v_op IN ('lt','gt'))  THEN RETURN 'A metric watcher uses above/below only.'; END IF;
    IF c->>'value' IS NULL        THEN RETURN 'A metric watcher needs a threshold.'; END IF;
  ELSIF p_kind = 'schedule' THEN
    IF coalesce((c->>'interval_minutes')::int, 0) < 60 THEN
      RETURN 'A recurring schedule must run at least hourly.';
    END IF;
  ELSE
    RETURN format('"%s" isn''t an installable watcher kind.', p_kind);
  END IF;
  RETURN NULL;
END $function$;

-- ── PROOF ───────────────────────────────────────────────────────────────────
-- Built, asserted, and rolled back IN THIS TRANSACTION, so it is non-vacuous
-- AND replayable on an empty database — the escape both house rules allow and
-- which 111 assertion sites across 57 existing migrations did not take.
do $verify$
declare
  v_a uuid; v_b uuid; v_task_b uuid; v_res jsonb; v_title text;
begin
  -- Two throwaway workspaces. NOT "find two tenants" — that is the
  -- assert-the-presence-of-an-example shape that makes a migration unreplayable.
  insert into tenants (name, slug) values ('__sec02_a', '__sec02_a') returning id into v_a;
  insert into tenants (name, slug) values ('__sec02_b', '__sec02_b') returning id into v_b;

  insert into human_tasks (tenant_id, title, kind, status)
  values (v_b, 'Send a $15,600 invoice to Meridian Group', 'approval', 'pending')
  returning id into v_task_b;

  -- The unscoped read is the thing under test. Simulate the wrapper's lookup
  -- with tenant A as the caller: it must NOT return tenant B's title.
  select title into v_title from human_tasks where id = v_task_b and tenant_id = v_a;
  if v_title is not null then
    raise exception 'SEC-02 FAILED: a tenant-A-scoped read returned tenant B''s title (%)', v_title;
  end if;

  -- And the scoping must not break the legitimate case.
  select title into v_title from human_tasks where id = v_task_b and tenant_id = v_b;
  if v_title is distinct from 'Send a $15,600 invoice to Meridian Group' then
    raise exception 'SEC-02 FAILED: the owning tenant can no longer read its own title';
  end if;

  -- Schema assertions — always replayable, because they describe what this
  -- migration itself installed.
  if to_regprocedure('public.decide_human_tasks(uuid[],text,text,text)') is null
     or to_regprocedure('public.preview_decide_human_tasks(uuid[],text,text)') is null
     or to_regprocedure('public.validate_watcher_config(text,jsonb,uuid,uuid)') is null then
    raise exception 'SEC-02 FAILED: a function is missing after replace';
  end if;

  -- The scoped predicate must actually be IN the shipped source, both copies.
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('decide_human_tasks','preview_decide_human_tasks')
         and pg_get_functiondef(p.oid) like '%and tenant_id = auth_tenant_id()%') <> 2 then
    raise exception 'SEC-02 FAILED: the title read is not scoped in both batch verbs';
  end if;

  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'validate_watcher_config'
         and pg_get_functiondef(p.oid) like '%_assert_caller_tenant(p_tenant_id)%') <> 1 then
    raise exception 'SEC-09 FAILED: validate_watcher_config does not assert caller tenancy';
  end if;

  raise notice 'SEC-02/SEC-09: both oracles closed, legitimate reads unaffected';

  -- Undo the fixtures. Nothing this block created outlives it.
  delete from human_tasks where id = v_task_b;
  delete from tenants where id in (v_a, v_b);
end $verify$;

commit;
