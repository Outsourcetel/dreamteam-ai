-- ============================================================
-- Migration 042: THE GENERALIZED "NOTHING HAPPENED, ESCALATE" WATCHDOG
--
-- Gap closed (gap-analysis Tier 2 item 27, and the leverage insight
-- that folds items 6/12/16 into one build): "items 6 (Support SLA),
-- 12 (Onboarding stalled projects), and 16 (Account at-risk
-- auto-execution) are the same missing primitive wearing three
-- names — 'nothing happened in N days, tell a human.'" Item 16 is
-- already handled by the Account DE build (migration 037's
-- account_at_risk event rule). This migration's job is items 6 and
-- 12 — generalized as ONE domain-agnostic primitive, not two bespoke
-- timers, per the standing genericity test (memory/
-- feedback_de_genericity_test.md): "does this generalize across ANY
-- domain via configuration, or does it hardcode one department's
-- logic into a bespoke code path?"
--
-- RESEARCH GROUNDING (per the brief):
--   - Mature SLA/escalation systems (PagerDuty, Zendesk SLA policies,
--     ServiceNow OLAs) use TIERED severity — a "breaching soon" /
--     "at risk" warning BEFORE the hard breach, not a single alarm at
--     one threshold. This migration implements exactly two tiers,
--     'warning' and 'breach', each independently configurable per
--     (tenant, target_kind).
--   - Escalation-loop prevention: naive re-evaluation on every
--     dispatcher tick re-fires the same alert forever. This migration
--     uses a unique constraint on (tenant, target_kind, target_id,
--     tier) plus an unresolved-row check, so a stale item escalates
--     ONCE per tier and then goes quiet until either the tier changes
--     (warning -> breach, a NEW row) or the underlying item is
--     resolved (existing row gets resolved_at, re-opens the door for
--     a future occurrence to escalate again from scratch).
--
-- THE GENERICITY DESIGN (the actual point of this migration):
--   target_kind is a free-text configuration key, NOT a widened
--   enum — the same "no enum widening for new domains" lesson
--   migration 036 already applied to source_category. Adding a third
--   staleness domain later (e.g. 'unclaimed_lead') needs ONE new
--   staleness_policies row, never a code change or a new CHECK
--   constraint value. check_staleness() itself has NO
--   `if target_kind = 'onboarding_project' then ... elsif ... then`
--   branch tree of BUSINESS logic for what "stale" means per domain —
--   it has exactly two small, structurally-identical lookups (one for
--   onboarding_projects, one for human_tasks) because those are the
--   only two tables in this codebase today whose "still open, no
--   recent activity" shape needs watching. A third domain that
--   reuses either shape (another jsonb/status/timestamp table) needs
--   zero new code, only a new policy row; a genuinely new SHAPE would
--   need one new lookup branch, same cost as any new table anywhere
--   in this system. The policy, tier thresholds, and cooldown/dedup
--   mechanics are 100% shared and domain-agnostic.
--
-- TENANT-SAFETY DISCIPLINE (mirrors the isolation-audit fix pattern,
-- migrations 038-041, applied here from the start rather than
-- retrofitted): every query below carries an explicit tenant_id
-- filter — this function runs via the cron dispatcher, SECURITY
-- DEFINER, outside RLS, exactly like dispatch_due_triggers and
-- poll_de_work_sources_targets. It is granted to service_role ONLY;
-- REVOKE is issued against PUBLIC explicitly (not just anon/
-- authenticated by name), per the migration-040 lesson that a
-- function created with a default PUBLIC grant is NOT locked down by
-- revoking anon/authenticated alone.
--
-- Objects added:
--   staleness_policies    — tenant-overridable warning/breach
--                            thresholds per target_kind. Seeded with
--                            platform defaults for the two known
--                            kinds; a tenant can override or add its
--                            own target_kind row without a migration.
--   staleness_escalations — the tiered, deduplicated escalation
--                            ledger. One row per (tenant, target_kind,
--                            target_id, tier); resolved_at nullable.
--   check_staleness(uuid) — SECURITY DEFINER, service_role only. Finds
--                            stale targets per enabled policy, creates
--                            a plain-language human_task + escalation
--                            row per newly-crossed tier, resolves rows
--                            whose underlying item is no longer stale.
--
-- WHAT THIS DOES NOT DO (honest limits):
--   - No outbound notification (email/Slack) — the escalation
--     surfaces as a human_task in-app, same as every other DE-raised
--     task in this system. Real outbound notification is gated on the
--     same open gap as item 2 (outbound channel), not reinvented here.
--   - Only two target_kind shapes are wired today (onboarding_project,
--     human_tasks-backed review/approval gates). Extending to a new
--     TABLE shape (not just a new policy row against an existing
--     shape) is a small additive lookup, not zero-code, and that's
--     stated honestly rather than oversold as infinitely automatic.
--   - This does not replace or duplicate migration 037's
--     account_at_risk event rule (item 16) — that is a health-score
--     STATE CHANGE trigger (a signal fires), fundamentally different
--     from this migration's "nothing happened for N days" ABSENCE-OF-
--     ACTIVITY trigger. Both are legitimate, distinct primitives that
--     happen to both terminate in a human_task.
-- ============================================================

-- ============================================================
-- 1. TABLE: staleness_policies — tenant-overridable per target_kind.
-- target_kind is deliberately a free-text key (not an enum) so a new
-- domain is a data row, never a schema change.
-- ============================================================
create table if not exists staleness_policies (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  target_kind    text not null,
  warning_after  interval not null,
  breach_after   interval not null,
  enabled        boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (tenant_id, target_kind),
  constraint staleness_policies_tier_order check (breach_after > warning_after)
);

create index if not exists staleness_policies_tenant_idx on staleness_policies(tenant_id);

alter table staleness_policies enable row level security;
drop policy if exists "staleness_policies_tenant_isolation" on staleness_policies;
create policy "staleness_policies_tenant_isolation" on staleness_policies
  for all
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()))
  with check (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));

drop trigger if exists staleness_policies_updated_at on staleness_policies;
create trigger staleness_policies_updated_at
  before update on staleness_policies
  for each row execute function update_updated_at();

-- ============================================================
-- 2. TABLE: staleness_escalations — the tiered, deduplicated ledger.
-- The unique constraint on (tenant, target_kind, target_id, tier) IS
-- the cooldown/dedup mechanism: check_staleness only inserts a row
-- when no row for that exact (target, tier) exists yet — see the
-- `not exists (...)` guard in the function below. A tier change
-- (warning -> breach) is a DIFFERENT tier value, so it is a new row,
-- not blocked by the warning row's existence. Once resolved_at is
-- set, a FUTURE recurrence of staleness at the same tier can create a
-- fresh row again (no unique-violation, since a partial index only
-- guards UNRESOLVED rows) — this matters for a project that goes
-- stale, gets touched, then goes stale again later.
-- ============================================================
create table if not exists staleness_escalations (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  target_kind        text not null,
  target_id          uuid not null,
  tier               text not null check (tier in ('warning', 'breach')),
  first_detected_at  timestamptz not null default now(),
  last_escalated_at  timestamptz not null default now(),
  resolved_at        timestamptz,
  human_task_id      uuid references human_tasks(id) on delete set null,
  created_at         timestamptz not null default now()
);

-- Cooldown/dedup: only one UNRESOLVED escalation per (tenant,
-- target_kind, target_id, tier) at a time. Partial index (resolved_at
-- is null) so a resolved-then-restale item can escalate again fresh.
create unique index if not exists staleness_escalations_open_uq
  on staleness_escalations (tenant_id, target_kind, target_id, tier)
  where resolved_at is null;

create index if not exists staleness_escalations_tenant_idx on staleness_escalations(tenant_id, created_at desc);
create index if not exists staleness_escalations_target_idx on staleness_escalations(target_kind, target_id);

alter table staleness_escalations enable row level security;
drop policy if exists "staleness_escalations_tenant_select" on staleness_escalations;
create policy "staleness_escalations_tenant_select" on staleness_escalations
  for select
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));
-- writes: SECURITY DEFINER function / service-role only

-- ============================================================
-- Seed sensible platform defaults for the two known target_kinds.
-- Per-tenant, so every existing tenant gets a usable starting policy
-- immediately (tenant-overridable afterward via ordinary UPDATE/UPSERT
-- through the tenant-scoped RLS policy above — no new RPC needed,
-- these are plain tenant-owned rows).
--   onboarding_project:  warning 14 days no update, breach 30 days.
--   pending_review_task: warning 24h, breach 72h — covers BOTH
--     Support's inquiry_review tasks and the Account DE's
--     action_approval tasks (and any future approval/review-shaped
--     human_task type) via one shared target_kind, since all of them
--     share the identical "pending, created_at" staleness shape.
-- ============================================================
insert into staleness_policies (tenant_id, target_kind, warning_after, breach_after, enabled)
select t.id, k.target_kind, k.warning_after, k.breach_after, true
from tenants t
cross join (values
  ('onboarding_project',  interval '14 days', interval '30 days'),
  ('pending_review_task', interval '24 hours', interval '72 hours')
) as k(target_kind, warning_after, breach_after)
on conflict (tenant_id, target_kind) do nothing;

-- ============================================================
-- 3. check_staleness(p_tenant_id uuid default null) — THE PRIMITIVE.
--
-- For each (tenant, enabled policy, target_kind), finds target rows
-- past warning_after / breach_after with no open escalation at that
-- tier yet, creates the escalation + a plain-language human_task; and
-- resolves open escalations whose underlying item is no longer stale.
--
-- Deliberately data-driven, not branch-per-domain: the OUTER loop
-- (which policies to evaluate, which tenant, which tier) is 100%
-- generic. Only the INNER "how do I find target_kind X's rows and
-- their last-activity timestamp" step differs per target_kind, and
-- that's an honest, minimal `if target_kind = ... then` dispatch to a
-- lookup — not a duplicated copy of the tier/cooldown/task-creation
-- logic, which is written exactly once and shared by both kinds
-- (see the shared `perform stale_upsert_escalation(...)` calls).
-- ============================================================

-- Internal helper: human-readable duration for the plain-language
-- task text. Picks the largest sensible unit (days / hours / minutes)
-- rather than always saying "days" — a naive `extract(day from ...)`
-- would print "0 days" for any sub-24h interval, which is both wrong
-- and unhelpful for tenants who configure (or a demo that uses) a
-- fast-testing threshold, not just the 14/30-day platform default.
create or replace function stale_humanize_interval(p_span interval)
returns text
language sql
immutable
as $$
  select case
    when extract(epoch from p_span) >= 86400 then
      round(extract(epoch from p_span) / 86400.0, 1)::text || ' day' || case when round(extract(epoch from p_span) / 86400.0, 1) = 1 then '' else 's' end
    when extract(epoch from p_span) >= 3600 then
      round(extract(epoch from p_span) / 3600.0, 1)::text || ' hour' || case when round(extract(epoch from p_span) / 3600.0, 1) = 1 then '' else 's' end
    else
      greatest(1, round(extract(epoch from p_span) / 60.0))::text || ' minute' ||
        case when greatest(1, round(extract(epoch from p_span) / 60.0)) = 1 then '' else 's' end
  end;
$$;
revoke all on function stale_humanize_interval(interval) from public, anon, authenticated;
grant execute on function stale_humanize_interval(interval) to service_role;

-- Internal helper: shared tier-escalation logic for ONE stale target.
-- Not itself the "generalize across domains" trick (that's the caller
-- loop) — this just avoids writing the insert-if-not-exists dedup
-- logic twice (once per tier) inside every target_kind branch.
create or replace function stale_upsert_escalation(
  p_tenant_id    uuid,
  p_target_kind  text,
  p_target_id    uuid,
  p_tier         text,
  p_task_title   text,
  p_task_detail  text,
  p_related_table text,
  p_related_id    uuid
) returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_task_id uuid;
  v_esc_id  uuid;
begin
  -- Cooldown/dedup: if an OPEN escalation already exists for this
  -- exact (tenant, target_kind, target_id, tier), do nothing — this
  -- is what stops the same stale item re-firing every 5-minute tick.
  if exists (
    select 1 from staleness_escalations
    where tenant_id = p_tenant_id and target_kind = p_target_kind
      and target_id = p_target_id and tier = p_tier and resolved_at is null
  ) then
    return null;
  end if;

  insert into human_tasks (tenant_id, type, title, detail, source, related_table, related_id, status)
  values (p_tenant_id, 'escalation', p_task_title, p_task_detail, 'system', p_related_table, p_related_id, 'pending')
  returning id into v_task_id;

  insert into staleness_escalations (tenant_id, target_kind, target_id, tier, human_task_id)
  values (p_tenant_id, p_target_kind, p_target_id, p_tier, v_task_id)
  returning id into v_esc_id;

  perform append_audit_event_internal(
    p_tenant_id, 'System', 'system',
    format('Staleness watchdog: %s escalation — %s', p_tier, p_task_title),
    'escalated',
    jsonb_build_object('kind', 'staleness_escalation', 'target_kind', p_target_kind,
                       'target_id', p_target_id, 'tier', p_tier, 'human_task_id', v_task_id)
  );

  return v_esc_id;
end;
$$;
-- NOTE (learned live during this migration's own application — the
-- exact migration-040 gotcha, reproduced firsthand): `revoke all ...
-- from public` does NOT strip an explicit per-role grant already made
-- to anon/authenticated by name; PUBLIC and named-role grants are
-- independent ACL entries in Postgres. Revoke ALL THREE explicitly.
revoke all on function stale_upsert_escalation(uuid, text, uuid, text, text, text, text, uuid) from public, anon, authenticated;
grant execute on function stale_upsert_escalation(uuid, text, uuid, text, text, text, text, uuid) to service_role;

-- The primitive itself.
create or replace function check_staleness(p_tenant_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_policy   record;
  v_proj     record;
  v_task     record;
  v_open     record;
  v_warned   integer := 0;
  v_breached integer := 0;
  v_resolved integer := 0;
  v_acct     text;
begin
  -- ── Evaluate every enabled policy, explicit tenant filter always ──
  for v_policy in
    select * from staleness_policies sp
    where sp.enabled
      and (p_tenant_id is null or sp.tenant_id = p_tenant_id)
  loop

    if v_policy.target_kind = 'onboarding_project' then
      -- ── onboarding_projects: still active, updated_at is the
      -- "last activity" clock. Explicit tenant_id filter (no reliance
      -- on RLS — this function runs SECURITY DEFINER via cron).
      for v_proj in
        select op.id, op.name, op.updated_at, op.account_id
        from onboarding_projects op
        where op.tenant_id = v_policy.tenant_id
          and op.status = 'active'
      loop
        select name into v_acct from customer_accounts
          where id = v_proj.account_id and tenant_id = v_policy.tenant_id;

        if now() - v_proj.updated_at >= v_policy.breach_after then
          if stale_upsert_escalation(
            v_policy.tenant_id, 'onboarding_project', v_proj.id, 'breach',
            format('Onboarding stalled — %s', v_proj.name),
            format('This onboarding project for %s hasn''t been touched in %s (breach threshold: %s).',
                   coalesce(v_acct, v_proj.name), stale_humanize_interval(now() - v_proj.updated_at),
                   stale_humanize_interval(v_policy.breach_after)),
            'onboarding_projects', v_proj.id
          ) is not null then v_breached := v_breached + 1; end if;
        elsif now() - v_proj.updated_at >= v_policy.warning_after then
          if stale_upsert_escalation(
            v_policy.tenant_id, 'onboarding_project', v_proj.id, 'warning',
            format('Onboarding going quiet — %s', v_proj.name),
            format('This onboarding project for %s hasn''t been touched in %s (warning threshold: %s).',
                   coalesce(v_acct, v_proj.name), stale_humanize_interval(now() - v_proj.updated_at),
                   stale_humanize_interval(v_policy.warning_after)),
            'onboarding_projects', v_proj.id
          ) is not null then v_warned := v_warned + 1; end if;
        end if;
      end loop;

      -- Resolve: any open escalation whose project is no longer
      -- active (completed/cancelled/on_hold) or has been touched
      -- recently enough to fall back under the warning threshold.
      for v_open in
        select se.id, se.target_id
        from staleness_escalations se
        where se.tenant_id = v_policy.tenant_id
          and se.target_kind = 'onboarding_project'
          and se.resolved_at is null
      loop
        if not exists (
          select 1 from onboarding_projects op
          where op.id = v_open.target_id and op.tenant_id = v_policy.tenant_id
            and op.status = 'active'
            and now() - op.updated_at >= v_policy.warning_after
        ) then
          update staleness_escalations set resolved_at = now() where id = v_open.id;
          v_resolved := v_resolved + 1;
        end if;
      end loop;

    elsif v_policy.target_kind = 'pending_review_task' then
      -- ── human_tasks: review/approval-gate shaped tasks, still
      -- pending, created_at is the "last activity" clock (a task has
      -- no separate touch timestamp — its own existence-while-pending
      -- IS the staleness signal). Explicit tenant_id filter. Types
      -- covered: inquiry_review (Support), action_approval (Account/
      -- any DE's gated action), checklist, review_gate (onboarding
      -- sign-off gates) — any human_tasks row that is still
      -- 'pending' qualifies; we deliberately do NOT special-case by
      -- type here, since "pending too long" means the same thing
      -- regardless of which DE or department raised it.
      for v_task in
        select ht.id, ht.title, ht.created_at, ht.type
        from human_tasks ht
        where ht.tenant_id = v_policy.tenant_id
          and ht.status = 'pending'
          and ht.type in ('inquiry_review', 'action_approval', 'checklist', 'review_gate', 'approval_gate')
      loop
        if now() - v_task.created_at >= v_policy.breach_after then
          if stale_upsert_escalation(
            v_policy.tenant_id, 'pending_review_task', v_task.id, 'breach',
            format('Review overdue — %s', v_task.title),
            format('This %s has been waiting %s for a human decision (breach threshold: %s).',
                   replace(v_task.type, '_', ' '), stale_humanize_interval(now() - v_task.created_at),
                   stale_humanize_interval(v_policy.breach_after)),
            'human_tasks', v_task.id
          ) is not null then v_breached := v_breached + 1; end if;
        elsif now() - v_task.created_at >= v_policy.warning_after then
          if stale_upsert_escalation(
            v_policy.tenant_id, 'pending_review_task', v_task.id, 'warning',
            format('Review waiting — %s', v_task.title),
            format('This %s has been waiting %s for a human decision (warning threshold: %s).',
                   replace(v_task.type, '_', ' '), stale_humanize_interval(now() - v_task.created_at),
                   stale_humanize_interval(v_policy.warning_after)),
            'human_tasks', v_task.id
          ) is not null then v_warned := v_warned + 1; end if;
        end if;
      end loop;

      -- Resolve: any open escalation whose underlying task is no
      -- longer pending (approved/rejected — a human acted on it).
      for v_open in
        select se.id, se.target_id
        from staleness_escalations se
        where se.tenant_id = v_policy.tenant_id
          and se.target_kind = 'pending_review_task'
          and se.resolved_at is null
      loop
        if not exists (
          select 1 from human_tasks ht
          where ht.id = v_open.target_id and ht.tenant_id = v_policy.tenant_id
            and ht.status = 'pending'
        ) then
          update staleness_escalations set resolved_at = now() where id = v_open.id;
          v_resolved := v_resolved + 1;
        end if;
      end loop;

    end if;
    -- A new target_kind reusing either shape above needs ONLY a new
    -- staleness_policies row — it is picked up automatically by
    -- whichever branch matches its target_kind string. A target_kind
    -- with neither shape (a genuinely new table) falls through this
    -- if/elsif with no match and is silently skipped — honest no-op,
    -- not a crash, exactly like poll_de_work_sources_targets' "no
    -- grant = no rows" behavior for an unconfigured category.
  end loop;

  return jsonb_build_object('warned', v_warned, 'breached', v_breached, 'resolved', v_resolved);
end;
$$;

-- Tenant-safe, service-role-only — matches the now-corrected pattern
-- from migrations 038-041 exactly: revoke from PUBLIC AND from
-- anon/authenticated by name (they are independent ACL entries — a
-- bare `from public` does not strip a named anon/authenticated grant,
-- and vice versa, per migration 040's own root-cause finding, which
-- this migration's own live application reproduced firsthand on
-- stale_upsert_escalation before being caught and fixed), then grant
-- execute back to service_role by name.
revoke all on function check_staleness(uuid) from public, anon, authenticated;
grant execute on function check_staleness(uuid) to service_role;

-- ============================================================
-- audit_events: 'escalated' category already exists (see migration
-- 022's onboarding "blocked" transition and the original
-- audit_events_category_check) — no new category needed.
-- ============================================================

-- ============================================================
-- CRON PIGGYBACK — no new pg_cron job. invoke_playbook_dispatch()
-- (migration 020, extended by 034/036) already runs every 5 minutes;
-- check_staleness is PURE SQL/PLPGSQL (no outbound HTTP needed, unlike
-- the poll_* functions), so it is called DIRECTLY from inside
-- invoke_playbook_dispatch() via `perform check_staleness()` rather
-- than through a third net.http_post — there is no edge function to
-- reach, so no HTTP round-trip is warranted. A failure inside
-- check_staleness (wrapped in its own exception handler here) can
-- never block or be blocked by the two existing dispatch calls.
-- ============================================================
create or replace function invoke_playbook_dispatch()
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_secret text;
  v_req_id bigint;
  v_req_id2 bigint;
  v_stale  jsonb;
begin
  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'playbook_dispatch_secret'
  limit 1;
  if v_secret is null then
    return 'no_secret';
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

  -- Piggyback: the GENERALIZED proactive trigger, any category, on
  -- the SAME 5-minute tick. Independent request; a failure here never
  -- blocks or is blocked by the playbook dispatch above.
  select net.http_post(
    url     := 'https://rfsvmhcqeiyrxivbmpel.supabase.co/functions/v1/specialist-consult',
    body    := '{"action":"poll_de_work_sources"}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-dispatch-secret', v_secret
    ),
    timeout_milliseconds := 30000
  ) into v_req_id2;

  -- Piggyback #2: the generalized staleness watchdog. Pure SQL, no
  -- HTTP hop needed — called directly, wrapped so a bug here can
  -- never take down the two dispatch calls above (both of which have
  -- already been queued via pg_net by this point regardless).
  begin
    v_stale := check_staleness();
  exception when others then
    v_stale := jsonb_build_object('error', sqlerrm);
  end;

  return 'queued:' || v_req_id::text || ',' || v_req_id2::text || ' staleness:' || v_stale::text;
end;
$$;

revoke all on function invoke_playbook_dispatch() from public;

select cron.schedule(
  'playbook-dispatch-5min',
  '*/5 * * * *',
  $$select invoke_playbook_dispatch()$$
);
