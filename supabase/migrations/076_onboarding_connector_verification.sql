-- ============================================================
-- Migration 076: connector-verified onboarding provisioning
-- (gap-analysis item 10).
--
-- Today every onboarding item, including ones explicitly marked
-- owner_type='de', completes the exact same way: a human picks "Done"
-- from a dropdown (update_onboarding_item). There is no distinction
-- between "a human says this happened" and "the platform confirmed
-- this happened in the real system." This migration adds that
-- distinction for items that opt into it, reusing machinery that
-- already exists rather than inventing new plumbing:
--
--   - The read side reuses connector-hub's `category_op` — the SAME
--     deterministic, no-LLM read-through every category_op consumer
--     already uses (helpdesk.search_tickets, crm.get_account, etc).
--     No new adapter code, no new provider integration.
--   - Access is enforced the SAME way every machine-attributed
--     connector call already is: resolve_access, subject_kind='de'.
--     A verification check is not a bypass of data access rules.
--   - The write side is a NEW function (apply_onboarding_verification)
--     rather than reusing update_onboarding_item, on purpose: a
--     system-verified completion needs to be honestly distinguishable
--     from a human's self-report in the audit trail and the UI — that
--     distinction IS the point of this gap. It is SECURITY DEFINER,
--     service-role-only (never callable by an authenticated user
--     directly) — only the onboarding-verify edge function calls it,
--     after it has actually confirmed something.
--
-- SCOPE, stated honestly: verification answers "does a search/get op
-- against a connected system return a matching result" (exists /
-- contains-text). It does not do arbitrary field-level comparison —
-- category_op's canonical shape (title/snippet/url per item) doesn't
-- expose raw fields, and inventing a raw-field-access path would be a
-- much larger, provider-specific change. This is the right-sized tool
-- for "has this record shown up / does it look right," not a general
-- assertion engine.
-- ============================================================

-- ============================================================
-- 1. validate_onboarding_items — accept an OPTIONAL `verify` object
-- per item. Only enforced when present (existing templates, including
-- the 10-item starter, have none and remain valid unchanged).
-- ============================================================
create or replace function public.validate_onboarding_items(p_items jsonb)
returns text[]
language plpgsql
immutable
as $function$
declare
  v_errors text[] := '{}';
  v_item   jsonb;
  v_verify jsonb;
  v_keys   text[] := '{}';
  v_key    text;
  v_n      integer;
  v_match  text;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    return array['items must be a JSON array'];
  end if;
  v_n := jsonb_array_length(p_items);
  if v_n < 1 then v_errors := v_errors || 'template needs at least 1 item'; end if;
  if v_n > 50 then v_errors := v_errors || 'template cannot exceed 50 items'; end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_key := coalesce(v_item->>'key', '');
    if v_key = '' then
      v_errors := v_errors || 'every item needs a non-empty key';
    elsif v_key = any(v_keys) then
      v_errors := v_errors || format('duplicate item key "%s"', v_key);
    end if;
    v_keys := v_keys || v_key;
    if coalesce(v_item->>'label', '') = '' then
      v_errors := v_errors || format('item "%s" needs a label', v_key);
    end if;
    if coalesce(v_item->>'phase', '') not in ('kickoff', 'data', 'config', 'validation', 'golive') then
      v_errors := v_errors || format('item "%s" has an invalid phase', v_key);
    end if;
    if coalesce(v_item->>'owner_type', '') not in ('human', 'de', 'either') then
      v_errors := v_errors || format('item "%s" has an invalid owner_type', v_key);
    end if;
    if coalesce((v_item->>'requires_signoff')::boolean, false)
       and coalesce(v_item->>'owner_type', '') = 'de' then
      v_errors := v_errors || format('sign-off item "%s" must be owned by human or either — a DE cannot sign off its own work', v_key);
    end if;

    v_verify := v_item->'verify';
    if v_verify is not null and jsonb_typeof(v_verify) = 'object' then
      if coalesce(v_item->>'owner_type', '') = 'human' then
        v_errors := v_errors || format('item "%s" is human-owned — automated verification only applies to de/either items', v_key);
      end if;
      if coalesce(v_verify->>'category', '') not in
        ('crm', 'helpdesk', 'knowledge_base', 'erp_financials', 'billing', 'payroll_hcm', 'pos', 'product_system', 'other') then
        v_errors := v_errors || format('item "%s" has an invalid verify.category', v_key);
      end if;
      if coalesce(v_verify->>'op', '') = '' then
        v_errors := v_errors || format('item "%s" needs a verify.op', v_key);
      end if;
      v_match := coalesce(v_verify->>'match', '');
      if v_match not in ('exists', 'contains') then
        v_errors := v_errors || format('item "%s" has an invalid verify.match (must be exists or contains)', v_key);
      end if;
      if v_match = 'contains' and coalesce(v_verify->>'contains_text', '') = '' then
        v_errors := v_errors || format('item "%s" verify.match=contains needs contains_text', v_key);
      end if;
      if coalesce(v_verify->>'query_template', '') = '' and coalesce(v_verify->>'ref_template', '') = '' then
        v_errors := v_errors || format('item "%s" needs a verify.query_template or verify.ref_template', v_key);
      end if;
    end if;
  end loop;

  if not exists (
    select 1 from jsonb_array_elements(p_items) i where i->>'phase' = 'golive'
  ) then
    v_errors := v_errors || 'template needs at least one go-live phase item';
  end if;

  return v_errors;
end;
$function$;

-- ============================================================
-- 2. apply_onboarding_verification — the ONLY way a check result
-- reaches items_state. Service-role only (the onboarding-verify edge
-- function is the sole caller, after it has actually called out to a
-- connector) — never callable by an authenticated user, so a human
-- cannot fake a system verification the way they could always fake a
-- manual "Done" click.
--
-- verified=true  → status flips to 'done' (or, if requires_signoff,
--                   the SAME human_tasks review_gate update_onboarding_item
--                   already creates — a DE-verified item can still need
--                   a human's sign-off; verification narrows WHAT a
--                   human is confirming, it doesn't remove the gate).
-- verified=false → status is left alone; last_check_at/result/detail
--                   record the honest "checked, not yet true" so the
--                   UI can show real information instead of silence.
-- ============================================================
create or replace function public.apply_onboarding_verification(
  p_project_id uuid,
  p_key        text,
  p_verified   boolean,
  p_detail     text
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $function$
declare
  v_proj      onboarding_projects;
  v_ver       onboarding_template_versions;
  v_def       jsonb;
  v_item      jsonb;
  v_idx       integer := -1;
  v_i         integer := 0;
  v_old       text;
  v_task_id   uuid;
  v_acct_name text;
  v_completed boolean := false;
  v_signoff   boolean;
begin
  select * into v_proj from onboarding_projects where id = p_project_id;
  if not found then return jsonb_build_object('error', 'project_not_found'); end if;
  if v_proj.status <> 'active' then return jsonb_build_object('error', 'project_not_active'); end if;

  select * into v_ver from onboarding_template_versions where id = v_proj.template_version_id;
  select d into v_def from jsonb_array_elements(v_ver.items) d where d->>'key' = p_key limit 1;
  if v_def is null or v_def->'verify' is null then
    return jsonb_build_object('error', 'item_not_verifiable');
  end if;
  v_signoff := coalesce((v_def->>'requires_signoff')::boolean, false);

  for v_item in select * from jsonb_array_elements(v_proj.items_state) loop
    if v_item->>'key' = p_key then v_idx := v_i; exit; end if;
    v_i := v_i + 1;
  end loop;
  if v_idx < 0 then return jsonb_build_object('error', 'item_state_missing'); end if;
  v_old := v_item->>'status';

  if v_old in ('done', 'signed_off') then
    -- Already complete (by whatever means) — record the check for the
    -- audit trail but don't re-run completion side effects.
    v_item := v_item || jsonb_build_object(
      'last_check_at', now(), 'last_check_result', case when p_verified then 'verified' else 'not_yet' end,
      'verify_detail', left(coalesce(p_detail, ''), 300));
    update onboarding_projects set items_state = jsonb_set(items_state, array[v_idx::text], v_item) where id = p_project_id;
    return jsonb_build_object('project_id', p_project_id, 'item_key', p_key, 'changed', false, 'already_complete', true);
  end if;

  if not p_verified then
    v_item := v_item || jsonb_build_object(
      'last_check_at', now(), 'last_check_result', 'not_yet',
      'verify_detail', left(coalesce(p_detail, ''), 300));
    update onboarding_projects set items_state = jsonb_set(items_state, array[v_idx::text], v_item) where id = p_project_id;
    return jsonb_build_object('project_id', p_project_id, 'item_key', p_key, 'changed', false, 'verified', false);
  end if;

  -- Verified true: same completion shape as update_onboarding_item's
  -- done path, attributed to System rather than a human.
  v_item := v_item || jsonb_build_object(
    'status', 'done', 'done_at', now(),
    'verified_by', 'system', 'verified_at', now(),
    'last_check_at', now(), 'last_check_result', 'verified',
    'verify_detail', left(coalesce(p_detail, ''), 300));

  if v_signoff then
    insert into human_tasks (tenant_id, type, title, detail, source, related_table, related_id)
    values (v_proj.tenant_id, 'review_gate',
            format('Onboarding sign-off — %s · %s', v_def->>'label', v_proj.name),
            format('Item "%s" was CONNECTOR-VERIFIED (%s) and needs a human sign-off before the project can complete.', v_def->>'label', left(coalesce(p_detail, ''), 200)),
            'system', 'onboarding_projects', p_project_id)
    returning id into v_task_id;
    v_item := v_item || jsonb_build_object('signoff_task_id', v_task_id);
  end if;

  select name into v_acct_name from customer_accounts where id = v_proj.account_id;
  insert into activity_events (tenant_id, account_id, actor, actor_type, event_type, text)
  values (v_proj.tenant_id, v_proj.account_id, 'System', 'system', 'resolved',
          format('Onboarding — %s: connector-verified done%s (%s) — %s', v_def->>'label',
                 case when v_task_id is not null then ' · awaiting sign-off' else '' end,
                 coalesce(v_acct_name, v_proj.name), left(coalesce(p_detail, ''), 160)));

  perform append_audit_event_internal(
    v_proj.tenant_id, 'System', 'system',
    format('Onboarding item connector-verified — %s (%s): %s', v_def->>'label', v_proj.name, left(coalesce(p_detail, ''), 200)),
    'config_change',
    jsonb_build_object('kind', 'onboarding_verify', 'project_id', p_project_id, 'item_key', p_key,
                       'detail', p_detail, 'signoff_task_id', v_task_id));

  update onboarding_projects
    set items_state = jsonb_set(items_state, array[v_idx::text], v_item)
    where id = p_project_id;

  if not v_signoff then
    v_completed := onboarding_check_complete(p_project_id);
  end if;

  return jsonb_build_object('project_id', p_project_id, 'item_key', p_key, 'changed', true,
                            'verified', true, 'signoff_task_id', v_task_id, 'completed', v_completed);
end;
$function$;

revoke all on function public.apply_onboarding_verification(uuid, text, boolean, text) from public, anon, authenticated;
grant execute on function public.apply_onboarding_verification(uuid, text, boolean, text) to service_role;

-- ============================================================
-- 3. Piggyback #4 on the existing 5-minute dispatch cron: automatic
-- re-checks for verify-configured items on active projects, so
-- provisioning that completes in the connected system gets noticed
-- without anyone clicking "check now." Independent request, same
-- try/catch isolation as the knowledge-gap-detect piggyback (070) —
-- a failure here never blocks or is blocked by the others.
-- ============================================================
create or replace function public.invoke_playbook_dispatch()
returns text
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_secret  text;
  v_req_id  bigint;
  v_req_id2 bigint;
  v_req_id3 bigint;
  v_req_id4 bigint;
  v_t       record;
  v_health  integer := 0;
  v_stale   jsonb;
begin
  for v_t in
    select distinct ca.tenant_id
    from customer_accounts ca
    left join health_score_config c on c.tenant_id = ca.tenant_id
    where c.last_computed_at is null or c.last_computed_at < now() - interval '24 hours'
  loop
    perform compute_tenant_health_service(v_t.tenant_id);
    v_health := v_health + 1;
  end loop;

  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'playbook_dispatch_secret'
  limit 1;
  if v_secret is null then
    return format('health:%s no_secret', v_health);
  end if;

  select net.http_post(
    url     := 'https://rfsvmhcqeiyrxivbmpel.supabase.co/functions/v1/playbook-execute',
    body    := '{"action":"dispatch"}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-dispatch-secret', v_secret
    ),
    timeout_milliseconds := 30000
  ) into v_req_id;

  select net.http_post(
    url     := 'https://rfsvmhcqeiyrxivbmpel.supabase.co/functions/v1/specialist-consult',
    body    := '{"action":"poll_de_work_sources"}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-dispatch-secret', v_secret
    ),
    timeout_milliseconds := 30000
  ) into v_req_id2;

  begin
    v_stale := check_staleness();
  exception when others then
    v_stale := jsonb_build_object('error', sqlerrm);
  end;

  -- Piggyback #3: automatic knowledge-gap detection (070).
  begin
    select net.http_post(
      url     := 'https://rfsvmhcqeiyrxivbmpel.supabase.co/functions/v1/knowledge-gap-detect',
      body    := '{}'::jsonb,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-dispatch-secret', v_secret
      ),
      timeout_milliseconds := 30000
    ) into v_req_id3;
  exception when others then
    v_req_id3 := null;
  end;

  -- Piggyback #4 (076): connector-verified onboarding provisioning.
  begin
    select net.http_post(
      url     := 'https://rfsvmhcqeiyrxivbmpel.supabase.co/functions/v1/onboarding-verify',
      body    := '{"action":"check_due"}'::jsonb,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-dispatch-secret', v_secret
      ),
      timeout_milliseconds := 30000
    ) into v_req_id4;
  exception when others then
    v_req_id4 := null;
  end;

  return format('health:%s queued:%s,%s,%s,%s staleness:%s', v_health, v_req_id, v_req_id2, v_req_id3, v_req_id4, v_stale::text);
end;
$function$;
