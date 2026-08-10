-- 698 — the founder tunes the review minutes (G-D follow-up: the model is yours).
--
-- mig 691 modeled human-review cost with standard minutes per decision type —
-- founder-editable in principle, service-role-only in practice. This gives the
-- editing path its front door: two gated RPCs the Settings card calls. Tenant
-- is NEVER a parameter (the mig-636 rule); owner/admin only; refusals arrive
-- in the payload (the import_books_rows shape, so the card can classify
-- refusal vs transport and never dress either up as success).
--
-- Both RPCs return the EFFECTIVE minutes after the change (via
-- resolve_review_minutes), so the card renders what the server now believes,
-- never what the browser hoped.

create or replace function public.set_review_minutes(p_task_type text, p_minutes numeric)
returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare v_tenant uuid; v_updated int;
begin
  v_tenant := public.auth_tenant_id();
  if v_tenant is null or not public.auth_has_tenant_role(array['tenant_owner','tenant_admin']) then
    return jsonb_build_object('ok', false, 'error', 'not_permitted');
  end if;
  if p_task_type not in ('approval_gate','review_gate','escalation','override','training_feedback',
                         'trust_promotion','trust_demotion_notice','checklist','knowledge_revision',
                         'inquiry_review','action_approval') then
    return jsonb_build_object('ok', false, 'error', 'unknown_task_type', 'task_type', p_task_type);
  end if;
  if p_minutes is null or p_minutes <= 0 or p_minutes > 60 then
    return jsonb_build_object('ok', false, 'error', 'minutes_out_of_range',
                              'detail', 'minutes must be greater than 0 and at most 60');
  end if;

  update review_time_standards
     set minutes = p_minutes, source = 'founder', updated_at = now()
   where tenant_id = v_tenant and task_type = p_task_type;
  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    insert into review_time_standards (tenant_id, task_type, minutes, source)
    values (v_tenant, p_task_type, p_minutes, 'founder');
  end if;

  return jsonb_build_object('ok', true, 'task_type', p_task_type,
                            'effective_minutes', public.resolve_review_minutes(v_tenant, p_task_type),
                            'overridden', true);
end $$;
revoke all on function public.set_review_minutes(text, numeric) from public, anon;
grant execute on function public.set_review_minutes(text, numeric) to authenticated, service_role;

create or replace function public.clear_review_minutes(p_task_type text)
returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare v_tenant uuid; v_deleted int;
begin
  v_tenant := public.auth_tenant_id();
  if v_tenant is null or not public.auth_has_tenant_role(array['tenant_owner','tenant_admin']) then
    return jsonb_build_object('ok', false, 'error', 'not_permitted');
  end if;

  delete from review_time_standards where tenant_id = v_tenant and task_type = p_task_type;
  get diagnostics v_deleted = row_count;

  return jsonb_build_object('ok', true, 'task_type', p_task_type,
                            'effective_minutes', public.resolve_review_minutes(v_tenant, p_task_type),
                            'was_overridden', v_deleted > 0);
end $$;
revoke all on function public.clear_review_minutes(text) from public, anon;
grant execute on function public.clear_review_minutes(text) to authenticated, service_role;

-- ── Prove what this context can prove (the happy path is proven by the
--    behavioral test tests/review-minutes.test.ts through the real public
--    signup flow — it runs inside certify's suite forever) ──────────────────
do $$
declare v jsonb;
begin
  -- The runner has no auth context: the gate must refuse in the payload,
  -- exactly the shape the Settings card classifies.
  v := public.set_review_minutes('action_approval', 7);
  if (v->>'ok') is distinct from 'false' or (v->>'error') is distinct from 'not_permitted' then
    raise exception '698: unauthenticated set was not refused: %', v;
  end if;
  v := public.clear_review_minutes('action_approval');
  if (v->>'ok') is distinct from 'false' or (v->>'error') is distinct from 'not_permitted' then
    raise exception '698: unauthenticated clear was not refused: %', v;
  end if;
end $$;
