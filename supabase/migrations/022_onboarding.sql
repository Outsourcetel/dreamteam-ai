-- ============================================================
-- Migration 022: Customer Onboarding end-to-end
--
--   1. onboarding_templates          — tenant-editable checklist drafts
--      (ordered items jsonb: key/label/phase/owner_type/requires_signoff).
--   2. onboarding_template_versions  — IMMUTABLE publish snapshots
--      (same pattern as playbook_versions: projects bind to a snapshot,
--      never the live draft). Publish validates: 1-50 items, ≥1 golive
--      item, sign-off items must be owner_type human/either, unique keys.
--   3. onboarding_projects           — a template version run against a
--      customer account. items_state jsonb tracks per-item status /
--      assignee / note; progress_pct recomputed by trigger on every write.
--   4. Sign-off flow — marking a requires_signoff item done creates a
--      human_tasks row (type review_gate); resolve_onboarding_signoff
--      (called from decideHumanTask ALONGSIDE the playbook resume hook)
--      flips the item to signed_off (approve) or back to in_progress
--      (reject). Completion: every non-signoff item done AND every
--      sign-off item signed_off → project auto-completes.
--   5. install_starter_onboarding_template() — 10-item SaaS starter
--      across the 5 phases, published immediately.
--
-- Audit (hash chain via append_audit_event_internal, detail.kind
-- 'onboarding_*'): template publish, project create/complete/cancel,
-- every sign-off decision. Activity events: one per item transition.
-- ============================================================

-- ============================================================
-- 1. Templates (draft, editable)
-- ============================================================
create table if not exists onboarding_templates (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  name        text not null,
  description text not null default '',
  items       jsonb not null default '[]'::jsonb,
  version     integer not null default 0,
  status      text not null default 'draft' check (status in ('draft', 'published')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_onboarding_templates_tenant on onboarding_templates(tenant_id);

alter table onboarding_templates enable row level security;
drop policy if exists "onboarding_templates_tenant_isolation" on onboarding_templates;
create policy "onboarding_templates_tenant_isolation" on onboarding_templates
  for all
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()))
  with check (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));

drop trigger if exists onboarding_templates_updated_at on onboarding_templates;
create trigger onboarding_templates_updated_at
  before update on onboarding_templates
  for each row execute function update_updated_at();

-- ============================================================
-- 2. Immutable publish snapshots
-- ============================================================
create table if not exists onboarding_template_versions (
  id           uuid primary key default gen_random_uuid(),
  template_id  uuid not null references onboarding_templates(id) on delete cascade,
  tenant_id    uuid not null references tenants(id) on delete cascade,
  version      integer not null,
  name         text not null,
  description  text not null default '',
  items        jsonb not null,
  published_by uuid,
  published_at timestamptz not null default now(),
  unique (template_id, version)
);
create index if not exists idx_onboarding_tv_tenant on onboarding_template_versions(tenant_id);

alter table onboarding_template_versions enable row level security;
drop policy if exists "onboarding_tv_tenant_read" on onboarding_template_versions;
create policy "onboarding_tv_tenant_read" on onboarding_template_versions
  for select
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));
-- no insert/update/delete policies: snapshots are written only by the
-- SECURITY DEFINER publish RPC and are immutable thereafter.

-- ============================================================
-- 3. Projects
-- ============================================================
create table if not exists onboarding_projects (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  account_id          uuid not null references customer_accounts(id) on delete cascade,
  template_version_id uuid not null references onboarding_template_versions(id),
  name                text not null,
  status              text not null default 'active'
                      check (status in ('active', 'on_hold', 'completed', 'cancelled')),
  target_golive       date,
  items_state         jsonb not null default '[]'::jsonb,
  progress_pct        integer not null default 0,
  created_by          uuid,
  completed_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists idx_onboarding_projects_tenant on onboarding_projects(tenant_id);
create index if not exists idx_onboarding_projects_account on onboarding_projects(account_id);

alter table onboarding_projects enable row level security;
drop policy if exists "onboarding_projects_tenant_isolation" on onboarding_projects;
create policy "onboarding_projects_tenant_isolation" on onboarding_projects
  for all
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()))
  with check (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));

drop trigger if exists onboarding_projects_updated_at on onboarding_projects;
create trigger onboarding_projects_updated_at
  before update on onboarding_projects
  for each row execute function update_updated_at();

-- progress_pct recomputed on every items_state write (done + signed_off count)
create or replace function onboarding_progress_recalc()
returns trigger
language plpgsql
as $$
declare
  v_total integer;
  v_done  integer;
begin
  select count(*),
         count(*) filter (where i->>'status' in ('done', 'signed_off'))
    into v_total, v_done
  from jsonb_array_elements(coalesce(new.items_state, '[]'::jsonb)) i;
  new.progress_pct := case when v_total = 0 then 0 else round(100.0 * v_done / v_total)::int end;
  return new;
end;
$$;

drop trigger if exists onboarding_projects_progress on onboarding_projects;
create trigger onboarding_projects_progress
  before insert or update of items_state on onboarding_projects
  for each row execute function onboarding_progress_recalc();

-- ============================================================
-- Item validation helper (shared by publish + starter install)
-- Returns array of error strings; empty = valid.
-- ============================================================
create or replace function validate_onboarding_items(p_items jsonb)
returns text[]
language plpgsql
immutable
as $$
declare
  v_errors text[] := '{}';
  v_item   jsonb;
  v_keys   text[] := '{}';
  v_key    text;
  v_n      integer;
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
  end loop;

  if not exists (
    select 1 from jsonb_array_elements(p_items) i where i->>'phase' = 'golive'
  ) then
    v_errors := v_errors || 'template needs at least one go-live phase item';
  end if;

  return v_errors;
end;
$$;

-- ============================================================
-- Publish: validate → snapshot → bump version → audit.
-- ============================================================
create or replace function publish_onboarding_template(p_template_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_tpl     onboarding_templates;
  v_errors  text[];
  v_version integer;
  v_vid     uuid;
begin
  select * into v_tpl from onboarding_templates where id = p_template_id;
  if not found then
    return jsonb_build_object('error', 'template_not_found');
  end if;
  if not exists (
    select 1 from profiles where user_id = auth.uid() and tenant_id = v_tpl.tenant_id
  ) then
    raise exception 'not a member of this tenant';
  end if;

  v_errors := validate_onboarding_items(v_tpl.items);
  if array_length(v_errors, 1) is not null then
    return jsonb_build_object('errors', to_jsonb(v_errors));
  end if;

  v_version := v_tpl.version + 1;
  insert into onboarding_template_versions (template_id, tenant_id, version, name, description, items, published_by)
  values (v_tpl.id, v_tpl.tenant_id, v_version, v_tpl.name, v_tpl.description, v_tpl.items, auth.uid())
  returning id into v_vid;

  update onboarding_templates
    set version = v_version, status = 'published'
    where id = v_tpl.id;

  perform append_audit_event_internal(
    v_tpl.tenant_id, 'You', 'human',
    format('Onboarding template published — %s v%s (%s items)', v_tpl.name, v_version, jsonb_array_length(v_tpl.items)),
    'config_change',
    jsonb_build_object('kind', 'onboarding_template_publish', 'template_id', v_tpl.id,
                       'version_id', v_vid, 'version', v_version,
                       'item_count', jsonb_array_length(v_tpl.items)));

  return jsonb_build_object('version_id', v_vid, 'version', v_version);
end;
$$;
revoke all on function publish_onboarding_template(uuid) from public;
grant execute on function publish_onboarding_template(uuid) to authenticated;

-- ============================================================
-- Starter template: 10 SaaS items across the 5 phases, published.
-- Idempotent: returns the existing starter if already installed.
-- ============================================================
create or replace function install_starter_onboarding_template()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_tenant uuid;
  v_tpl_id uuid;
  v_pub    jsonb;
  v_items  jsonb := '[
    {"key":"kickoff_call","label":"Kickoff call held","phase":"kickoff","owner_type":"human","requires_signoff":false,"description":"Intro call: goals, timeline, points of contact."},
    {"key":"data_export_received","label":"Data export received from customer","phase":"data","owner_type":"either","requires_signoff":false,"description":"Customer sends their employee/location export (CSV or spreadsheet)."},
    {"key":"employees_imported","label":"Employees imported","phase":"data","owner_type":"de","requires_signoff":false,"description":"Employee records loaded and normalized in the platform."},
    {"key":"locations_configured","label":"Locations configured","phase":"config","owner_type":"de","requires_signoff":false,"description":"Sites, time zones, and operating hours set up."},
    {"key":"settings_review","label":"Account settings reviewed","phase":"config","owner_type":"human","requires_signoff":true,"description":"Human sign-off on core account configuration."},
    {"key":"leave_rules_configured","label":"Leave rules configured","phase":"config","owner_type":"either","requires_signoff":true,"description":"Accrual, carryover, and approval chains — needs human sign-off."},
    {"key":"test_scenario_run","label":"Test scenario run","phase":"validation","owner_type":"de","requires_signoff":false,"description":"End-to-end test with sample data."},
    {"key":"uat_approved","label":"UAT approved by customer","phase":"validation","owner_type":"human","requires_signoff":true,"description":"Customer confirms acceptance testing passed."},
    {"key":"training_session","label":"Training session delivered","phase":"golive","owner_type":"human","requires_signoff":false,"description":"Admin + end-user training completed."},
    {"key":"go_live","label":"Go-live","phase":"golive","owner_type":"human","requires_signoff":true,"description":"Production cutover — final human sign-off."}
  ]'::jsonb;
begin
  select tenant_id into v_tenant from profiles where user_id = auth.uid() limit 1;
  if v_tenant is null then
    raise exception 'no tenant for caller';
  end if;

  select id into v_tpl_id from onboarding_templates
    where tenant_id = v_tenant and name = 'SaaS onboarding — starter' limit 1;
  if v_tpl_id is not null then
    return jsonb_build_object('template_id', v_tpl_id, 'already_installed', true);
  end if;

  insert into onboarding_templates (tenant_id, name, description, items)
  values (v_tenant, 'SaaS onboarding — starter',
          '10-step implementation checklist: kickoff → data → config → validation → go-live. Sign-off gates on settings, leave rules, UAT, and go-live.',
          v_items)
  returning id into v_tpl_id;

  v_pub := publish_onboarding_template(v_tpl_id);
  return jsonb_build_object('template_id', v_tpl_id, 'already_installed', false) || v_pub;
end;
$$;
revoke all on function install_starter_onboarding_template() from public;
grant execute on function install_starter_onboarding_template() to authenticated;

-- ============================================================
-- Create a project from a published template version.
-- ============================================================
create or replace function create_onboarding_project(
  p_account_id uuid,
  p_version_id uuid,
  p_name       text default null,
  p_target     date default null
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_tenant  uuid;
  v_acct    customer_accounts;
  v_ver     onboarding_template_versions;
  v_state   jsonb;
  v_proj_id uuid;
  v_name    text;
begin
  select tenant_id into v_tenant from profiles where user_id = auth.uid() limit 1;
  if v_tenant is null then raise exception 'no tenant for caller'; end if;

  select * into v_acct from customer_accounts where id = p_account_id and tenant_id = v_tenant;
  if not found then return jsonb_build_object('error', 'account_not_found'); end if;

  select * into v_ver from onboarding_template_versions where id = p_version_id and tenant_id = v_tenant;
  if not found then return jsonb_build_object('error', 'template_version_not_found'); end if;

  select jsonb_agg(jsonb_build_object(
    'key', i->>'key', 'status', 'pending', 'assignee', null, 'note', ''))
    into v_state
  from jsonb_array_elements(v_ver.items) i;

  v_name := coalesce(nullif(trim(p_name), ''), format('%s — %s', v_acct.name, v_ver.name));

  insert into onboarding_projects (tenant_id, account_id, template_version_id, name, target_golive, items_state, created_by)
  values (v_tenant, p_account_id, p_version_id, v_name, p_target, coalesce(v_state, '[]'::jsonb), auth.uid())
  returning id into v_proj_id;

  perform append_audit_event_internal(
    v_tenant, 'You', 'human',
    format('Onboarding project created — %s (%s v%s, %s items)', v_name, v_ver.name, v_ver.version, jsonb_array_length(v_ver.items)),
    'config_change',
    jsonb_build_object('kind', 'onboarding_project_create', 'project_id', v_proj_id,
                       'account_id', p_account_id, 'version_id', p_version_id));

  insert into activity_events (tenant_id, account_id, actor, actor_type, event_type, text)
  values (v_tenant, p_account_id, 'You', 'human', 'config_change',
          format('Onboarding started — %s', v_acct.name));

  return jsonb_build_object('project_id', v_proj_id);
end;
$$;
revoke all on function create_onboarding_project(uuid, uuid, text, date) from public;
grant execute on function create_onboarding_project(uuid, uuid, text, date) to authenticated;

-- ============================================================
-- Internal: check completion (every sign-off item signed_off, every
-- other item done). Auto-completes the project + audit + activity.
-- ============================================================
create or replace function onboarding_check_complete(p_project_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_proj onboarding_projects;
  v_ver  onboarding_template_versions;
  v_acct_name text;
  v_incomplete integer;
begin
  select * into v_proj from onboarding_projects where id = p_project_id;
  if not found or v_proj.status <> 'active' then return false; end if;
  select * into v_ver from onboarding_template_versions where id = v_proj.template_version_id;

  select count(*) into v_incomplete
  from jsonb_array_elements(v_ver.items) def
  join lateral (
    select s from jsonb_array_elements(v_proj.items_state) s
    where s->>'key' = def->>'key' limit 1
  ) st on true
  where case when coalesce((def->>'requires_signoff')::boolean, false)
             then st.s->>'status' <> 'signed_off'
             else st.s->>'status' not in ('done', 'signed_off') end;

  if v_incomplete > 0 then return false; end if;

  update onboarding_projects
    set status = 'completed', completed_at = now()
    where id = p_project_id;

  select name into v_acct_name from customer_accounts where id = v_proj.account_id;

  perform append_audit_event_internal(
    v_proj.tenant_id, 'System', 'system',
    format('Onboarding project completed — %s', v_proj.name),
    'config_change',
    jsonb_build_object('kind', 'onboarding_project_complete', 'project_id', p_project_id,
                       'account_id', v_proj.account_id));

  insert into activity_events (tenant_id, account_id, actor, actor_type, event_type, text)
  values (v_proj.tenant_id, v_proj.account_id, 'System', 'system', 'resolved',
          format('Onboarding completed — %s', coalesce(v_acct_name, v_proj.name)));

  return true;
end;
$$;
revoke all on function onboarding_check_complete(uuid) from public, anon, authenticated;

-- ============================================================
-- Update one checklist item (status / assignee / note).
--   · one activity event per STATUS transition (not per note edit)
--   · done on a requires_signoff item → human_tasks review_gate row,
--     item keeps status 'done' with signoff_task_id until decided
--   · completion check after every status change
-- ============================================================
create or replace function update_onboarding_item(
  p_project_id uuid,
  p_key        text,
  p_status     text default null,
  p_assignee   text default null,
  p_note       text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
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
  if not exists (
    select 1 from profiles where user_id = auth.uid() and tenant_id = v_proj.tenant_id
  ) then
    raise exception 'not a member of this tenant';
  end if;
  if v_proj.status <> 'active' then
    return jsonb_build_object('error', 'project_not_active');
  end if;
  if p_status is not null and p_status not in ('pending', 'in_progress', 'done', 'blocked') then
    return jsonb_build_object('error', 'invalid_status');
  end if;

  select * into v_ver from onboarding_template_versions where id = v_proj.template_version_id;
  select d into v_def from jsonb_array_elements(v_ver.items) d where d->>'key' = p_key limit 1;
  if v_def is null then return jsonb_build_object('error', 'item_not_found'); end if;
  v_signoff := coalesce((v_def->>'requires_signoff')::boolean, false);

  for v_item in select * from jsonb_array_elements(v_proj.items_state) loop
    if v_item->>'key' = p_key then v_idx := v_i; exit; end if;
    v_i := v_i + 1;
  end loop;
  if v_idx < 0 then return jsonb_build_object('error', 'item_state_missing'); end if;
  v_old := v_item->>'status';

  if v_old = 'signed_off' then
    return jsonb_build_object('error', 'item_already_signed_off');
  end if;

  if p_assignee is not null then v_item := v_item || jsonb_build_object('assignee', nullif(trim(p_assignee), '')); end if;
  if p_note is not null then v_item := v_item || jsonb_build_object('note', p_note); end if;

  if p_status is not null and p_status <> v_old then
    v_item := v_item || jsonb_build_object('status', p_status);
    if p_status = 'done' then
      v_item := v_item || jsonb_build_object('done_at', now());
      if v_signoff then
        insert into human_tasks (tenant_id, type, title, detail, source, related_table, related_id)
        values (v_proj.tenant_id, 'review_gate',
                format('Onboarding sign-off — %s · %s', v_def->>'label', v_proj.name),
                format('Item "%s" is marked done and needs a human sign-off before the project can complete.', v_def->>'label'),
                'system', 'onboarding_projects', p_project_id)
        returning id into v_task_id;
        v_item := v_item || jsonb_build_object('signoff_task_id', v_task_id);
      end if;
    end if;

    select name into v_acct_name from customer_accounts where id = v_proj.account_id;
    insert into activity_events (tenant_id, account_id, actor, actor_type, event_type, text)
    values (v_proj.tenant_id, v_proj.account_id, 'You', 'human',
            case when p_status = 'blocked' then 'escalated' else 'config_change' end,
            format('Onboarding — %s: %s → %s%s (%s)', v_def->>'label', v_old, p_status,
                   case when v_task_id is not null then ' · awaiting sign-off' else '' end,
                   coalesce(v_acct_name, v_proj.name)));
  end if;

  update onboarding_projects
    set items_state = jsonb_set(items_state, array[v_idx::text], v_item)
    where id = p_project_id;

  -- non-signoff items can complete the project directly
  if p_status = 'done' and not v_signoff then
    v_completed := onboarding_check_complete(p_project_id);
  end if;

  select to_jsonb(p.*) into v_item from onboarding_projects p where p.id = p_project_id;
  return jsonb_build_object('project', v_item, 'signoff_task_id', v_task_id, 'completed', v_completed);
end;
$$;
revoke all on function update_onboarding_item(uuid, text, text, text, text) from public;
grant execute on function update_onboarding_item(uuid, text, text, text, text) to authenticated;

-- ============================================================
-- Sign-off resolution — called from decideHumanTask AFTER the task row
-- is decided (alongside, not replacing, resume_playbook_on_task).
-- Approve → signed_off; reject → back to in_progress with a note.
-- ============================================================
create or replace function resolve_onboarding_signoff(
  p_task_id  uuid,
  p_decision text
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_task      human_tasks;
  v_proj      onboarding_projects;
  v_ver       onboarding_template_versions;
  v_def       jsonb;
  v_item      jsonb;
  v_idx       integer := -1;
  v_i         integer := 0;
  v_key       text;
  v_completed boolean := false;
begin
  if p_decision not in ('approved', 'rejected') then
    return jsonb_build_object('error', 'invalid_decision');
  end if;

  select * into v_task from human_tasks where id = p_task_id;
  if not found or v_task.related_table <> 'onboarding_projects' or v_task.related_id is null then
    return jsonb_build_object('error', 'not_an_onboarding_task');
  end if;
  if not exists (
    select 1 from profiles where user_id = auth.uid() and tenant_id = v_task.tenant_id
  ) then
    raise exception 'not a member of this tenant';
  end if;

  select * into v_proj from onboarding_projects where id = v_task.related_id::uuid;
  if not found then return jsonb_build_object('error', 'project_not_found'); end if;

  for v_item in select * from jsonb_array_elements(v_proj.items_state) loop
    if v_item->>'signoff_task_id' = p_task_id::text then v_idx := v_i; exit; end if;
    v_i := v_i + 1;
  end loop;
  if v_idx < 0 then return jsonb_build_object('error', 'item_for_task_not_found'); end if;
  v_key := v_item->>'key';

  if v_item->>'status' = 'signed_off' then
    return jsonb_build_object('error', 'already_signed_off');
  end if;

  select * into v_ver from onboarding_template_versions where id = v_proj.template_version_id;
  select d into v_def from jsonb_array_elements(v_ver.items) d where d->>'key' = v_key limit 1;

  if p_decision = 'approved' then
    v_item := v_item || jsonb_build_object('status', 'signed_off', 'signed_off_by', auth.uid(), 'signed_off_at', now());
  else
    v_item := v_item || jsonb_build_object('status', 'in_progress',
      'note', trim(coalesce(v_item->>'note', '') || ' · Sign-off rejected — rework needed.', ' ·'),
      'signoff_task_id', null);
  end if;

  update onboarding_projects
    set items_state = jsonb_set(items_state, array[v_idx::text], v_item)
    where id = v_proj.id;

  perform append_audit_event_internal(
    v_task.tenant_id, 'You', 'human',
    format('Onboarding sign-off %s — %s (%s)', p_decision, coalesce(v_def->>'label', v_key), v_proj.name),
    'approval',
    jsonb_build_object('kind', 'onboarding_signoff', 'project_id', v_proj.id,
                       'item_key', v_key, 'task_id', p_task_id, 'decision', p_decision));

  if p_decision = 'approved' then
    v_completed := onboarding_check_complete(v_proj.id);
  end if;

  return jsonb_build_object('project_id', v_proj.id, 'item_key', v_key,
                            'decision', p_decision, 'completed', v_completed);
end;
$$;
revoke all on function resolve_onboarding_signoff(uuid, text) from public;
grant execute on function resolve_onboarding_signoff(uuid, text) to authenticated;

-- ============================================================
-- Cancel / hold / reactivate a project (status transitions with audit).
-- ============================================================
create or replace function set_onboarding_project_status(
  p_project_id uuid,
  p_status     text
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_proj onboarding_projects;
begin
  if p_status not in ('active', 'on_hold', 'cancelled') then
    return jsonb_build_object('error', 'invalid_status');
  end if;
  select * into v_proj from onboarding_projects where id = p_project_id;
  if not found then return jsonb_build_object('error', 'project_not_found'); end if;
  if not exists (
    select 1 from profiles where user_id = auth.uid() and tenant_id = v_proj.tenant_id
  ) then
    raise exception 'not a member of this tenant';
  end if;
  if v_proj.status = 'completed' then
    return jsonb_build_object('error', 'project_completed');
  end if;
  if v_proj.status = p_status then
    return jsonb_build_object('status', p_status);
  end if;

  update onboarding_projects set status = p_status where id = p_project_id;

  perform append_audit_event_internal(
    v_proj.tenant_id, 'You', 'human',
    format('Onboarding project %s — %s', case p_status when 'cancelled' then 'cancelled'
           when 'on_hold' then 'put on hold' else 'reactivated' end, v_proj.name),
    'config_change',
    jsonb_build_object('kind', 'onboarding_project_' || p_status, 'project_id', p_project_id,
                       'old_status', v_proj.status, 'new_status', p_status));

  return jsonb_build_object('status', p_status);
end;
$$;
revoke all on function set_onboarding_project_status(uuid, text) from public;
grant execute on function set_onboarding_project_status(uuid, text) to authenticated;
