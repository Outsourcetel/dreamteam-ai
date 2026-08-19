begin;
-- ⚠ THIS `begin;` IS LOAD-BEARING. This file APPROVES REAL TASKS to prove the
-- refusal is real. Without the transaction, running it the obvious way would
-- autocommit those approvals against production. See the README.
--
-- WHY THIS FILE EXISTS
-- ====================
-- compose-decide-human-task.sql calls `evaluate_authority` DIRECTLY for c1-c4
-- and only greps decide_human_task's source for c5. A decide_human_task that
-- computed the risk and then ignored it would pass every assertion in that
-- file. It did not catch the hole mig 786 closes, and it structurally could
-- not have.
--
-- This suite runs decide_human_task END TO END and looks at what happens to a
-- real pending task. That means approving one, which is exactly why the
-- earlier file avoided it — but inside an always-aborting transaction the
-- approval is undone, and the alternative is a probe that cannot fail.
--
-- RUN IT BOTH WAYS. e2 must FAIL against production as it stands, and PASS
-- with 786 concatenated ahead of it. A run where e2 passes both ways is
-- measuring nothing:
--
--   node scripts/db-query.mjs supabase/tests/authority/compose-decide-human-task-endtoend.sql
--   { sed 's/^commit;$//' supabase/migrations/786_*.sql; \
--     tail -n +2 supabase/tests/authority/compose-decide-human-task-endtoend.sql; } > /tmp/after.sql
--   node scripts/db-query.mjs /tmp/after.sql

create temp table e_results(name text, outcome text, detail text) on commit drop;

do $e$
declare
  v_tenant uuid; v_user uuid; v_cat text;
  v_task_a uuid; v_task_b uuid;
  v_row human_tasks; v_raised boolean; v_msg text; v_n int;
begin
  -- A workspace where an admin can genuinely sign a task that carries no
  -- price. Both halves matter: unpriced (so the measure is absent) and
  -- entitled (so any refusal we see comes from the risk rule, not the grant).
  select t.tenant_id, p.user_id, f.category
    into v_tenant, v_user, v_cat
    from human_tasks t
    cross join lateral task_approval_facts(t.id) f
    join profiles p on p.tenant_id = t.tenant_id and coalesce(p.is_active, true)
                   and p.role in ('tenant_owner','tenant_admin')
    join approval_authority a on a.tenant_id = t.tenant_id and a.is_active
                             and a.category = f.category
   where t.status = 'pending' and f.amount_cents is null and f.category is not null
   limit 1;

  select count(*) into v_n
    from human_tasks t cross join lateral task_approval_facts(t.id) f
   where t.tenant_id = v_tenant and t.status = 'pending'
     and f.amount_cents is null and f.category = v_cat;

  -- ⚠ Two distinct tasks are needed: e1 consumes one by approving it.
  insert into e_results values ('e0_fixture_found',
    case when v_tenant is not null and v_n >= 2 then 'pass' else 'FAIL' end,
    format('tenant %s, category %s, %s unpriced pending task(s) available',
           coalesce(v_tenant::text,'(none)'), coalesce(v_cat,'(none)'), v_n));
  if v_tenant is null or v_n < 2 then return; end if;

  select t.id into v_task_a
    from human_tasks t cross join lateral task_approval_facts(t.id) f
   where t.tenant_id = v_tenant and t.status = 'pending'
     and f.amount_cents is null and f.category = v_cat
   order by t.id limit 1;
  select t.id into v_task_b
    from human_tasks t cross join lateral task_approval_facts(t.id) f
   where t.tenant_id = v_tenant and t.status = 'pending'
     and f.amount_cents is null and f.category = v_cat and t.id <> v_task_a
   order by t.id limit 1;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_user, 'role', 'authenticated')::text, true);

  -- ── e1: WITH NO RULE THE APPROVAL SUCCEEDS ────────────────────────────────
  -- Without this, e2 proves nothing. A refusal that was already happening for
  -- an unrelated reason looks identical to a refusal the rule caused.
  delete from authority_rules where tenant_id = v_tenant;
  v_raised := false; v_msg := null;
  begin
    v_row := decide_human_task(v_task_a, 'approved', null, 'authority probe: baseline');
  exception when others then v_raised := true; v_msg := sqlerrm;
  end;
  insert into e_results values ('e1_baseline_approval_succeeds',
    case when not v_raised then 'pass' else 'FAIL' end,
    case when v_raised then 'raised: ' || v_msg
         else 'approved with no rule present' end);

  -- ── e2: THE HOLE 786 CLOSES ───────────────────────────────────────────────
  -- A `deny` rule on a measure this task does not report. evaluate_authority
  -- cannot check it, so it downgrades to `require_human` — which this path
  -- treats as already satisfied, because a human IS approving. Before 786 the
  -- declared `deny` was erased on the way through and the approval went ahead.
  perform set_authority_rule('all','amount_cents','>',1,'deny',v_cat);
  v_raised := false; v_msg := null;
  begin
    v_row := decide_human_task(v_task_b, 'approved', null, 'authority probe: deny rule present');
  exception when others then v_raised := true; v_msg := sqlerrm;
  end;
  insert into e_results values ('e2_unverifiable_deny_refuses',
    case when v_raised and v_msg like 'not_authorised_to_approve%' then 'pass' else 'FAIL' end,
    case when v_raised then 'raised: ' || v_msg
         else 'APPROVED — the workspace''s deny rule enforced nothing' end);

  -- ── e3: and a deny it CAN check still refuses, unchanged ──────────────────
  -- Guards the other direction: 786 must not have broken the case that always
  -- worked.
  insert into e_results values ('e3_checkable_deny_still_denies',
    case when (evaluate_authority(v_tenant,'user',v_user,v_cat,
                 jsonb_build_object('amount_cents', 50000))->>'outcome') = 'deny'
         then 'pass' else 'FAIL' end,
    'measured amount, deny rule present');

  delete from authority_rules where tenant_id = v_tenant;
end
$e$;

select jsonb_agg(jsonb_build_object('name',name,'outcome',outcome,'detail',detail) order by name)
    as endtoend_suite from e_results;
rollback;
