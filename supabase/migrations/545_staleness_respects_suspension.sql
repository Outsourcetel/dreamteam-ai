-- ============================================================
-- Migration 545: the staleness watchdog respects tenant suspension.
--
-- Completes migration 430. That sweep guarded the twenty dispatchers that
-- CREATE work, and the action pipeline has been correctly silent for both
-- suspended tenants ever since (zero action_executions). But the staleness
-- watchdog was not in that list, so it carried on minting "Review overdue"
-- escalations for suspended acme-telecom on 28, 29 and 30 July — chasing the
-- backlog the original leak had already produced. Twenty tasks, all after the
-- fix that was supposed to make the tenant dormant.
--
-- Two edits, both regenerated mechanically from the live bodies:
--   1. check_staleness  — the outer policy loop, which every escalation kind
--      (onboarding_project / pending_review_task / overdue_invoice_unattended)
--      flows through, so one predicate covers all three.
--   2. stale_upsert_escalation — the writer itself, so a future caller cannot
--      reintroduce the hole. Fix at the primitive, not just at today's caller.
--
-- Resolution of ALREADY-OPEN escalations is deliberately left unguarded: a
-- suspended tenant should still be able to have stale items closed out, it
-- just must not gain new ones.
-- ============================================================

-- ── check_staleness ──
CREATE OR REPLACE FUNCTION public.check_staleness(p_tenant_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_policy   record;
  v_proj     record;
  v_task     record;
  v_inv      record;
  v_open     record;
  v_warned   integer := 0;
  v_breached integer := 0;
  v_resolved integer := 0;
  v_acct     text;
begin
  for v_policy in
    select * from staleness_policies sp
    where sp.enabled
      and (p_tenant_id is null or sp.tenant_id = p_tenant_id)
      and is_feature_enabled_internal(sp.tenant_id, 'staleness_watchdog')
      -- Mig 545: a suspended workspace is dormant. Without this the watchdog
      -- kept minting "Review overdue" escalations for suspended tenants
      -- (observed on acme-telecom for three days after mig 430) because the
      -- backlog it nags about does not disappear when the tenant is suspended.
      and tenant_is_operational(sp.tenant_id)
  loop

    if v_policy.target_kind = 'onboarding_project' then
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

    elsif v_policy.target_kind = 'overdue_invoice_unattended' then
      for v_inv in
        select ri.id, ri.account_id, ri.amount_cents, ri.due_date, ca.name as account_name
        from renewal_invoices ri
        join customer_accounts ca on ca.id = ri.account_id and ca.tenant_id = v_policy.tenant_id
        where ri.tenant_id = v_policy.tenant_id
          and ri.status in ('sent', 'awaiting_approval')
          and ri.due_date is not null
      loop
        if (current_date - v_inv.due_date) * interval '1 day' >= v_policy.breach_after then
          if stale_upsert_escalation(
            v_policy.tenant_id, 'overdue_invoice_unattended', v_inv.id, 'breach',
            format('Invoice seriously overdue — %s', v_inv.account_name),
            format('Invoice for %s (%s cents) has been overdue since %s — %s past due (breach threshold: %s).',
                   v_inv.account_name, v_inv.amount_cents, v_inv.due_date,
                   stale_humanize_interval((current_date - v_inv.due_date) * interval '1 day'),
                   stale_humanize_interval(v_policy.breach_after)),
            'renewal_invoices', v_inv.id
          ) is not null then v_breached := v_breached + 1; end if;
        elsif (current_date - v_inv.due_date) * interval '1 day' >= v_policy.warning_after then
          if stale_upsert_escalation(
            v_policy.tenant_id, 'overdue_invoice_unattended', v_inv.id, 'warning',
            format('Invoice overdue — %s', v_inv.account_name),
            format('Invoice for %s (%s cents) has been overdue since %s — %s past due (warning threshold: %s).',
                   v_inv.account_name, v_inv.amount_cents, v_inv.due_date,
                   stale_humanize_interval((current_date - v_inv.due_date) * interval '1 day'),
                   stale_humanize_interval(v_policy.warning_after)),
            'renewal_invoices', v_inv.id
          ) is not null then v_warned := v_warned + 1; end if;
        end if;
      end loop;

      for v_open in
        select se.id, se.target_id
        from staleness_escalations se
        where se.tenant_id = v_policy.tenant_id
          and se.target_kind = 'overdue_invoice_unattended'
          and se.resolved_at is null
      loop
        if not exists (
          select 1 from renewal_invoices ri
          where ri.id = v_open.target_id and ri.tenant_id = v_policy.tenant_id
            and ri.status in ('sent', 'awaiting_approval')
        ) then
          update staleness_escalations set resolved_at = now() where id = v_open.id;
          v_resolved := v_resolved + 1;
        end if;
      end loop;

    end if;
  end loop;

  return jsonb_build_object('warned', v_warned, 'breached', v_breached, 'resolved', v_resolved);
end;
$function$;

-- ── stale_upsert_escalation ──
CREATE OR REPLACE FUNCTION public.stale_upsert_escalation(p_tenant_id uuid, p_target_kind text, p_target_id uuid, p_tier text, p_task_title text, p_task_detail text, p_related_table text, p_related_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_task_id uuid;
  v_esc_id  uuid;
begin
  -- Mig 545: fix at the primitive, not only at the caller. A suspended
  -- workspace never gains new escalations regardless of who asks.
  if not tenant_is_operational(p_tenant_id) then
    return null;
  end if;
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
$function$;

do $assert$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'check_staleness'
                    and p.prosrc like '%tenant_is_operational%') then
    raise exception 'mig 545: check_staleness is still unguarded';
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'stale_upsert_escalation'
                    and p.prosrc like '%tenant_is_operational%') then
    raise exception 'mig 545: stale_upsert_escalation is still unguarded';
  end if;
end
$assert$;
