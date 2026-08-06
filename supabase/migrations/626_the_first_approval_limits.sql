-- 626 — the first approval limits.
--
-- `approval_authority` has been empty in all sixteen workspaces since it was
-- built, and `has_approval_authority` answers *allowed* to any amount when it
-- is empty. A $5,000,000 approval and a $5 refund are checked identically.
-- That default is deliberate and correct — the alternative is freezing every
-- queue on the platform — but it means the control has never once bitten.
--
-- The founder asked for the limits to be set. These are they.
--
-- ⚠⚠ THE ONE THING THAT CAN GO WRONG HERE IS A LOCK-OUT, and it is not
-- hypothetical. The moment the FIRST active row exists for a workspace, the
-- permissive default switches off for EVERYONE in it, and anyone holding no
-- matching grant is refused. Two facts make that dangerous:
--
--   1. `task_approval_facts` classifies a task as `coalesce(ad.category,
--      h.type)`. The 341 tasks pending today resolve to TEN categories —
--      escalation (131), inquiry_review (58), erp_financials (49),
--      checklist (48), crm (32), trust_demotion_notice (9), platform_admin (6),
--      knowledge_revision (4), review_gate (2), helpdesk (2).
--   2. The category dropdown in the UI offers ten values, and FOUR of those
--      ten live categories are not among them (inquiry_review, checklist,
--      trust_demotion_notice, knowledge_revision — 119 pending tasks), plus
--      six more action categories exist that it cannot express at all
--      (other, product_system, pos, web_analytics, payroll_hcm, knowledge_base).
--
-- So a set of purely category-scoped limits would have silently refused the
-- owner on a third of the queue. THE FIX IS THE FIRST TWO ROWS: an
-- any-category, no-ceiling grant for the owner, held twice — once by role so
-- it survives the person leaving, once by user id so it survives the role
-- being changed. Every other row narrows from there, and because
-- `has_approval_authority` takes the MOST PERMISSIVE matching grant, no
-- narrower row can ever take the owner's escape hatch away.
--
-- ⚠ WHAT THESE LIMITS DO AND DO NOT DO TODAY. Nothing populates the money
-- field yet: of 180 action_executions platform-wide, ZERO carry `amount_cents`
-- and two carry `outstanding_cents`. `has_approval_authority` returns early
-- with needs_second=false when the amount is null, so today these rows decide
-- WHO MAY APPROVE AT ALL, and the ceilings and second-signature thresholds sit
-- dormant until executors start pricing their work. They are written now so
-- the policy is already in place when that happens, not invented under
-- pressure afterwards.
--
-- ⚠ SCOPED TO outsourcetel-hq ONLY. The other fifteen workspaces are demo
-- tenants with a single owner apiece (and `outsourcetel` has no people at
-- all); switching the default off for them would buy nothing and could freeze
-- a demo. They keep the permissive default until someone declares otherwise.
--
-- Ceilings are grounded in this workspace's real invoices — eight of them,
-- $15,000 smallest, $59,750 average, $229,000 largest — not in round numbers
-- chosen for looking sensible.

begin;

do $seed$
declare
  v_tenant uuid;
  v_owner  uuid;
  v_n      int;
begin
  select id into v_tenant from tenants where slug = 'outsourcetel-hq';
  if v_tenant is null then
    raise notice 'outsourcetel-hq not present — nothing to seed';
    return;
  end if;

  -- Idempotent: if this workspace has already declared authority, leave it
  -- alone. Re-running must never duplicate a grant or resurrect one somebody
  -- deliberately deactivated.
  select count(*) into v_n from approval_authority where tenant_id = v_tenant;
  if v_n > 0 then
    raise notice 'outsourcetel-hq already has % approval rule(s) — leaving them untouched', v_n;
    return;
  end if;

  select user_id into v_owner
    from profiles where tenant_id = v_tenant and role = 'tenant_owner' and is_active
    order by created_at limit 1;

  -- ── 1+2. The escape hatch, held two ways ────────────────────────────────
  -- No category, no ceiling. This is what makes every other row safe to add:
  -- whatever a task turns out to be classified as — including the six
  -- categories the UI cannot even express — the owner can still approve it.
  insert into approval_authority
    (tenant_id, role, category, max_amount_cents, second_approver_above_cents, note)
  values
    (v_tenant, 'tenant_owner', null, null, null,
     'Owner — final authority, any work, any amount. This row is what stops a '
     'category nobody wrote a rule for from freezing the queue. Do not delete it.');

  if v_owner is not null then
    insert into approval_authority
      (tenant_id, user_id, category, max_amount_cents, second_approver_above_cents, note)
    values
      (v_tenant, v_owner, null, null, null,
       'The founder personally — the same authority pinned to the person rather '
       'than the role, so changing a role cannot lock the workspace out.');
  end if;

  -- ── 3. Admins — run the business day to day ─────────────────────────────
  -- $250,000 clears the largest invoice this workspace has ever raised
  -- ($229,000). $100,000 for a second signature sits well above the $59,750
  -- average, so routine work stays single-signature and only genuine outliers
  -- need two people. The owner is always available as that second person.
  insert into approval_authority
    (tenant_id, role, category, max_amount_cents, second_approver_above_cents, note)
  values
    (v_tenant, 'tenant_admin', null, 25000000, 10000000,
     'Admin — any kind of work up to $250,000 (above the largest invoice ever '
     'raised here). Over $100,000 a second person must also approve.');

  -- ── 4. Managers — routine amounts only ──────────────────────────────────
  -- $25,000 sits above the smallest real invoice ($15,000) and below the
  -- average, so a manager clears ordinary items and anything substantial
  -- rises to an admin or the owner.
  insert into approval_authority
    (tenant_id, role, category, max_amount_cents, second_approver_above_cents, note)
  values
    (v_tenant, 'tenant_manager', null, 2500000, null,
     'Manager — any kind of work up to $25,000. Above the smallest invoice '
     'raised here and below the average, so routine items only.');

  -- ── 5-9. Everyone else — the support queue, and no money ────────────────
  -- These five categories are 243 of the 341 tasks pending today. A ceiling of
  -- zero is not a formality: with an amount attached the check refuses, so the
  -- moment any of this work starts carrying money it rises to a manager
  -- instead of being waved through by whoever happens to be looking.
  insert into approval_authority
    (tenant_id, role, category, max_amount_cents, second_approver_above_cents, note)
  select v_tenant, 'tenant_user', c, 0, null,
         'Support staff — may clear ' || c || ', but nothing carrying money; '
         'anything with an amount goes to a manager.'
  from unnest(array['helpdesk','escalation','inquiry_review','checklist','knowledge_revision']) as c;

  raise notice 'seeded % approval rule(s) for outsourcetel-hq',
    (select count(*) from approval_authority where tenant_id = v_tenant);
end;
$seed$;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFY — the only assertion that matters is that nobody got locked out.
-- ════════════════════════════════════════════════════════════════════════
do $verify$
declare
  v_tenant   uuid;
  v_owner    uuid;
  v_ali      uuid;
  v_cat      text;
  v_res      jsonb;
  v_blocked  text[] := '{}';
  v_selftest boolean := false;
begin
  select id into v_tenant from tenants where slug = 'outsourcetel-hq';
  if v_tenant is null then raise notice 'no workspace to verify'; return; end if;

  select user_id into v_owner
    from profiles where tenant_id = v_tenant and role = 'tenant_owner' and is_active
    order by created_at limit 1;
  if v_owner is null then raise exception 'no active owner — refusing to leave limits on with nobody unlimited'; end if;

  -- ⚠ SELF-TEST FIRST. A verify block that silently does not run is worse than
  -- no verify block, and this one loops over a query that could return nothing.
  -- Prove the loop body executes by asserting a case that MUST be true.
  v_res := has_approval_authority(v_owner, v_tenant, 'a-category-nobody-declared', 999999999999);
  if not coalesce((v_res->>'allowed')::boolean, false) then
    raise exception 'SELF-TEST FAILED: the owner was refused an unknown category — the escape hatch is not working: %',
      v_res->>'reason';
  end if;
  v_selftest := true;

  -- THE REAL CHECK: every category a pending task actually resolves to must be
  -- approvable by the owner. This is the query I should have run before
  -- writing a single row, and it is the one that would have caught a
  -- category-only rule set.
  for v_cat in
    select distinct coalesce(ad.category, h.type)
    from human_tasks h
    left join action_executions ae
      on ae.id = h.related_id and h.related_table = 'action_executions'
    left join action_definitions ad on ad.id = ae.action_definition_id
    where h.tenant_id = v_tenant and h.status = 'pending'
  loop
    v_res := has_approval_authority(v_owner, v_tenant, v_cat, null);
    if not coalesce((v_res->>'allowed')::boolean, false) then
      v_blocked := v_blocked || v_cat;
    end if;
  end loop;

  if array_length(v_blocked, 1) > 0 then
    raise exception 'the owner is now locked out of % pending categor(y/ies): % — rolling back',
      array_length(v_blocked, 1), array_to_string(v_blocked, ', ');
  end if;

  if not v_selftest then raise exception 'verify block did not execute'; end if;

  -- And the flip must have actually happened: the permissive default is gone.
  v_res := has_approval_authority(v_owner, v_tenant, 'erp_financials', 100);
  if v_res->>'reason' = 'no approval limits are declared in this workspace' then
    raise exception 'limits were not actually declared — still running on the permissive default';
  end if;

  -- A person with no grant at all must now be refused something outside their
  -- categories. If this passes, the control is real rather than decorative.
  select user_id into v_ali
    from profiles where tenant_id = v_tenant and role = 'tenant_user' and is_active
    order by created_at limit 1;
  if v_ali is not null then
    v_res := has_approval_authority(v_ali, v_tenant, 'erp_financials', null);
    if coalesce((v_res->>'allowed')::boolean, false) then
      raise exception 'support staff can still approve finance work — the limits are not binding';
    end if;
    raise notice 'support staff correctly refused finance work: %', v_res->>'reason';
  end if;

  raise notice 'owner clears all % pending categor(ies); limits are live and binding',
    (select count(distinct coalesce(ad.category, h.type))
       from human_tasks h
       left join action_executions ae on ae.id = h.related_id and h.related_table = 'action_executions'
       left join action_definitions ad on ad.id = ae.action_definition_id
      where h.tenant_id = v_tenant and h.status = 'pending');
end;
$verify$;

commit;
