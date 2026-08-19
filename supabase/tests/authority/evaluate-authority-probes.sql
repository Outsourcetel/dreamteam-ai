-- evaluate-authority-probes.sql
-- ==========================================================================
-- Behavioural coverage for public.evaluate_authority (migs 768/770/772),
-- promoted from a session scratchpad because nothing else in the repo
-- re-runs it — see README.md in this directory for what it covers and the
-- exact command to run it. NOT wired into `npm run certify`: these three
-- migrations are still unapplied, and certify must not depend on schema that
-- does not exist in production yet. That wiring is step 2's business.
--
-- Items 1-10 + iextra are the original widened suite, proven against the
-- fix-round-1 evaluator (commits 9cafbbac..9b90b45c). Items 11-17 were added
-- by the final-review fix wave that closed the actor fail-open (F1) and the
-- unfireable-threshold hole (F4); see 772's "FINAL REVIEW FIX WAVE" comment
-- and 770's threshold_cannot_fire raises. THE ASSERTIONS BELOW ARE PRESERVED
-- EXACTLY AS PROVEN — if a future change breaks one, fix the evaluator, not
-- the expectation.
--
-- ⚠ i3/i4 are the differential this file exists to protect: a rule on a unit
-- ABOVE the actor still binds when the INTERMEDIATE unit is inactive. 772's
-- own comment warns a future editor against "restoring" an is_active filter
-- on that walk to make it look like mig 593's GRANT walk again — doing so
-- would fail this file at i4, not silently.
-- ==========================================================================

-- Re-seed the same 3 original rules (verbatim from the brief's probe) so the
-- widened run's item 6/7/8 reasoning about the pre-existing GLOBAL rule
-- (amount_cents > 900000) stays accurate — that rule is always in scope
-- regardless of category, exactly like it is in the original probe run.
do $seed$
declare v_t uuid; begin
  select id into v_t from tenants limit 1;
  insert into authority_rules (tenant_id, actor_kind, category, dimension, comparator, threshold, outcome)
  values (v_t,'all','erp_financials','amount_cents','>',50000,'require_human'),
         (v_t,'all','erp_financials','confidence','<',60,'deny'),
         (v_t,'all',null,'amount_cents','>',900000,'require_second_approver');
end $seed$;

create temp table widen_probe_results (
  name    text primary key,
  outcome text,
  reasons jsonb
);

-- Extra, beyond the required 10: the "unknown comparator" minor fix has no
-- coverage otherwise, because the composite FK to authority_dimension_
-- comparators makes it structurally unreachable through a normal rule
-- insert (only the 5 seeded comparators can ever satisfy the FK). Add a
-- synthetic comparator pairing to the registry itself — platform vocabulary,
-- not tenant data, so this is a plain extra row, not a trigger bypass — so
-- a rule naming it can legally exist and the escalate-don't-raise branch is
-- actually exercised once before this whole transaction rolls back.
insert into authority_dimension_comparators (dimension, comparator)
values ('amount_cents', 'not_a_real_comparator');

do $widen$
declare
  v_t2         uuid;
  v_role       text;
  v_user_match uuid;
  v_user_other uuid;
  v_de_a       uuid;
  v_de_b       uuid;
  v_top_a      uuid;
  v_mid_a      uuid;
  v_leaf_a     uuid;
  v_top_b      uuid;
  v_mid_b      uuid;
  v_leaf_b     uuid;
begin
  -- A REAL tenant with >=2 active profiles carrying >=2 distinct roles, so
  -- the role arm (item 2) has both a genuine match and a genuine non-match
  -- to test against real profiles rows — never a fabricated auth identity.
  select tenant_id into v_t2
    from profiles
   where tenant_id is not null and coalesce(is_active, true)
   group by tenant_id
  having count(distinct role) >= 2 and count(*) >= 2
   order by tenant_id
   limit 1;

  if v_t2 is null then
    raise exception 'widen probe precondition failed: no tenant with >=2 active profiles in >=2 roles was found';
  end if;

  select user_id, role into v_user_match, v_role
    from profiles
   where tenant_id = v_t2 and coalesce(is_active, true)
   order by user_id
   limit 1;

  select user_id into v_user_other
    from profiles
   where tenant_id = v_t2 and coalesce(is_active, true) and role <> v_role
   order by user_id
   limit 1;

  -- ⚠ F1(b) ADDITION: both DE ids must be REAL digital_employees rows the
  -- actor-resolution check can find. A bare gen_random_uuid() (the original
  -- fixture, before the evaluator required resolution) would now be an
  -- "unidentified actor" before the rule loop ever runs — a different
  -- assertion than item 1 claims to make. v_de_b resolves fine but is not
  -- named by any rule, so it still proves "a real actor the rules don't
  -- mention is allow", not "an actor that doesn't exist is allow" (item 12b
  -- covers that case explicitly).
  insert into digital_employees (tenant_id, name) values (v_t2, 'Widen Probe DE A — targeted')
    returning id into v_de_a;
  insert into digital_employees (tenant_id, name) values (v_t2, 'Widen Probe DE B — not targeted')
    returning id into v_de_b;

  -- === item 1: exact (actor_kind, actor_id) match binds ======================
  insert into authority_rules (tenant_id, actor_kind, actor_id, category, dimension, comparator, threshold, outcome)
  values (v_t2, 'de', v_de_a, 'probe_exact_match', 'amount_cents', '>', 1000, 'require_human');

  -- === item 2: a role rule binds a user whose profile role matches ===========
  insert into authority_rules (tenant_id, actor_kind, actor_role, category, dimension, comparator, threshold, outcome)
  values (v_t2, 'role', v_role, 'probe_role_arm', 'confidence', '<', 50, 'require_human');

  -- === items 3 & 4: org_unit arm — below the rule's unit, active vs inactive
  -- ===              intermediate unit (I3's regression case) ================
  insert into org_units (tenant_id, kind, name, is_active)
    values (v_t2, 'department', 'Widen Probe Top A', true) returning id into v_top_a;
  insert into org_units (tenant_id, parent_id, kind, name, is_active)
    values (v_t2, v_top_a, 'team', 'Widen Probe Mid A', true) returning id into v_mid_a;
  insert into org_units (tenant_id, parent_id, kind, name, is_active)
    values (v_t2, v_mid_a, 'team', 'Widen Probe Leaf A', true) returning id into v_leaf_a;
  insert into org_unit_members (tenant_id, org_unit_id, user_id, is_active)
    values (v_t2, v_leaf_a, v_user_match, true);
  insert into authority_rules (tenant_id, actor_kind, actor_id, category, dimension, comparator, threshold, outcome)
  values (v_t2, 'org_unit', v_top_a, 'probe_org_unit_active', 'amount_cents', '>', 500, 'require_human');

  insert into org_units (tenant_id, kind, name, is_active)
    values (v_t2, 'department', 'Widen Probe Top B', true) returning id into v_top_b;
  -- ⚠ the regression case for I3: the INTERMEDIATE unit is inactive. The
  -- fixed walk must still reach the leaf below it.
  insert into org_units (tenant_id, parent_id, kind, name, is_active)
    values (v_t2, v_top_b, 'team', 'Widen Probe Mid B (inactive)', false) returning id into v_mid_b;
  insert into org_units (tenant_id, parent_id, kind, name, is_active)
    values (v_t2, v_mid_b, 'team', 'Widen Probe Leaf B', true) returning id into v_leaf_b;
  insert into org_unit_members (tenant_id, org_unit_id, user_id, is_active)
    values (v_t2, v_leaf_b, v_user_other, true);
  insert into authority_rules (tenant_id, actor_kind, actor_id, category, dimension, comparator, threshold, outcome)
  values (v_t2, 'org_unit', v_top_b, 'probe_org_unit_inactive_mid', 'amount_cents', '>', 500, 'require_human');

  -- === item 5: require_second_approver is reachable (rank 2) =================
  insert into authority_rules (tenant_id, actor_kind, category, dimension, comparator, threshold, outcome)
  values (v_t2, 'all', 'probe_second_approver', 'amount_cents', '>', 500000, 'require_second_approver');

  -- === item 6: {"amount_cents": null} must escalate, not read as absent-safe =
  insert into authority_rules (tenant_id, actor_kind, category, dimension, comparator, threshold, outcome)
  values (v_t2, 'all', 'probe_null_measure', 'amount_cents', '>', 100, 'require_human');

  -- === item 7: an unparseable measure must fail closed, not raise ============
  insert into authority_rules (tenant_id, actor_kind, category, dimension, comparator, threshold, outcome)
  values (v_t2, 'all', 'probe_bad_measure', 'amount_cents', '>', 100, 'require_human');

  -- === item 8: p_category NULL must still hit a category-scoped rule ========
  insert into authority_rules (tenant_id, actor_kind, category, dimension, comparator, threshold, outcome)
  values (v_t2, 'all', 'probe_category_null_test', 'amount_cents', '>', 111, 'require_human');

  -- === item 10: an is_active=false rule must not fire ========================
  insert into authority_rules (tenant_id, actor_kind, category, dimension, comparator, threshold, outcome, is_active)
  values (v_t2, 'all', 'probe_inactive_rule', 'amount_cents', '>', 1, 'deny', false);

  -- === extra: an unknown comparator escalates rather than silently no-firing
  insert into authority_rules (tenant_id, actor_kind, category, dimension, comparator, threshold, outcome)
  values (v_t2, 'all', 'probe_unknown_comparator', 'amount_cents', 'not_a_real_comparator', 50, 'deny');

  -- ── run every scenario, store outcome + reasons for the final report ──────
  insert into widen_probe_results(name, outcome, reasons) select 'i1_exact_match_binds',
    r->>'outcome', r->'reasons' from (select public.evaluate_authority(v_t2,'de',v_de_a,'probe_exact_match','{"amount_cents":2000}'::jsonb) r) x;
  insert into widen_probe_results(name, outcome, reasons) select 'i1_exact_match_wrong_id_is_allow',
    r->>'outcome', r->'reasons' from (select public.evaluate_authority(v_t2,'de',v_de_b,'probe_exact_match','{"amount_cents":2000}'::jsonb) r) x;

  insert into widen_probe_results(name, outcome, reasons) select 'i2_role_arm_binds',
    r->>'outcome', r->'reasons' from (select public.evaluate_authority(v_t2,'user',v_user_match,'probe_role_arm','{"amount_cents":0,"confidence":10}'::jsonb) r) x;
  insert into widen_probe_results(name, outcome, reasons) select 'i2_role_arm_wrong_role_is_allow',
    r->>'outcome', r->'reasons' from (select public.evaluate_authority(v_t2,'user',v_user_other,'probe_role_arm','{"amount_cents":0,"confidence":10}'::jsonb) r) x;

  insert into widen_probe_results(name, outcome, reasons) select 'i3_org_unit_below_binds_when_mid_active',
    r->>'outcome', r->'reasons' from (select public.evaluate_authority(v_t2,'user',v_user_match,'probe_org_unit_active','{"amount_cents":600}'::jsonb) r) x;

  insert into widen_probe_results(name, outcome, reasons) select 'i4_org_unit_below_still_binds_when_mid_inactive',
    r->>'outcome', r->'reasons' from (select public.evaluate_authority(v_t2,'user',v_user_other,'probe_org_unit_inactive_mid','{"amount_cents":600}'::jsonb) r) x;

  insert into widen_probe_results(name, outcome, reasons) select 'i5_second_approver_reachable',
    r->>'outcome', r->'reasons' from (select public.evaluate_authority(v_t2,'all',null,'probe_second_approver','{"amount_cents":600000}'::jsonb) r) x;
  insert into widen_probe_results(name, outcome, reasons) select 'i5_second_approver_under_threshold_is_allow',
    r->>'outcome', r->'reasons' from (select public.evaluate_authority(v_t2,'all',null,'probe_second_approver','{"amount_cents":100}'::jsonb) r) x;

  insert into widen_probe_results(name, outcome, reasons) select 'i6_json_null_measure_is_unmeasured',
    r->>'outcome', r->'reasons' from (select public.evaluate_authority(v_t2,'all',null,'probe_null_measure','{"amount_cents":null}'::jsonb) r) x;

  insert into widen_probe_results(name, outcome, reasons) select 'i7_unparseable_measure_is_unreadable_not_raise',
    r->>'outcome', r->'reasons' from (select public.evaluate_authority(v_t2,'all',null,'probe_bad_measure','{"amount_cents":"n/a"}'::jsonb) r) x;

  insert into widen_probe_results(name, outcome, reasons) select 'i8_null_category_still_hits_category_scoped_rule',
    r->>'outcome', r->'reasons' from (select public.evaluate_authority(v_t2,'all',null,null,'{"amount_cents":200}'::jsonb) r) x;

  insert into widen_probe_results(name, outcome, reasons) select 'i9_unknown_actor_kind_is_require_human',
    r->>'outcome', r->'reasons' from (select public.evaluate_authority(v_t2,'digital_employee',gen_random_uuid(),'probe_anything','{}'::jsonb) r) x;
  insert into widen_probe_results(name, outcome, reasons) select 'i9b_missing_actor_id_is_require_human',
    r->>'outcome', r->'reasons' from (select public.evaluate_authority(v_t2,'user',null,'probe_anything','{}'::jsonb) r) x;

  insert into widen_probe_results(name, outcome, reasons) select 'i10_inactive_rule_does_not_fire',
    r->>'outcome', r->'reasons' from (select public.evaluate_authority(v_t2,'all',null,'probe_inactive_rule','{"amount_cents":5}'::jsonb) r) x;

  insert into widen_probe_results(name, outcome, reasons) select 'iextra_unknown_comparator_escalates',
    r->>'outcome', r->'reasons' from (select public.evaluate_authority(v_t2,'all',null,'probe_unknown_comparator','{"amount_cents":999}'::jsonb) r) x;

  -- ── F1 final-review fix wave: the actor-kind whitelist and actor
  -- ── resolution, added by this fix wave ─────────────────────────────────
  -- === item 11: 'role' is RULE-scoping vocabulary, not an actor kind =========
  insert into widen_probe_results(name, outcome, reasons) select 'i11_role_actor_kind_is_require_human',
    r->>'outcome', r->'reasons' from (select public.evaluate_authority(v_t2,'role',gen_random_uuid(),'probe_anything','{}'::jsonb) r) x;

  -- === item 12: a 'user' actor_id with no profile in this tenant must not
  -- ===          silently lose its role-/unit-derived rules ==================
  insert into widen_probe_results(name, outcome, reasons) select 'i12_unresolvable_user_is_require_human',
    r->>'outcome', r->'reasons' from (select public.evaluate_authority(v_t2,'user',gen_random_uuid(),'probe_anything','{}'::jsonb) r) x;

  -- === item 12b: same, for 'de' — v_de_a/v_de_b above are deliberately REAL
  -- ===           rows, so this is the only case left that proves a
  -- ===           non-existent DE id escalates rather than falling through =
  insert into widen_probe_results(name, outcome, reasons) select 'i12b_unresolvable_de_is_require_human',
    r->>'outcome', r->'reasons' from (select public.evaluate_authority(v_t2,'de',gen_random_uuid(),'probe_anything','{}'::jsonb) r) x;

  -- === item 13: a DEACTIVATED profile must ESCALATE, not resolve ==========
  -- The guard used to ask only whether a profile EXISTED. An offboarded user
  -- therefore resolved here, matched no role-scoped rule below (the role arm
  -- filters on coalesce(is_active, true)), and received the most permissive
  -- answer available — the likelier real case of the two, since people are
  -- offboarded far more often than user ids are fabricated.
  -- ⚠ THIS MUST STAY LAST IN THIS BLOCK. It deactivates v_user_match, whom
  -- the role-arm assertions above depend on; moving it earlier would break
  -- them silently rather than loudly.
  update profiles set is_active = false
   where user_id = v_user_match and tenant_id = v_t2;
  insert into widen_probe_results(name, outcome, reasons) select 'i13_deactivated_user_is_require_human',
    r->>'outcome', r->'reasons' from (select public.evaluate_authority(v_t2,'user',v_user_match,'probe_anything','{}'::jsonb) r) x;
end
$widen$;

-- ── F4 final-review fix wave: threshold vs value_type, added by this fix
-- ── wave — an unfireable rule must be REJECTED AT INSERT ───────────────────
-- Both cases are caught in a nested exception block so a genuine regression
-- here (the insert should raise but silently lands instead) is REPORTED as a
-- failed assertion below, rather than aborting this whole probe transaction.
--
-- ⚠ 'reversible' — the only boolean dimension the real seed data declares —
-- has reader_fn = null (768's seed: nothing reads it yet), so any rule
-- naming it is already rejected by the EARLIER dimension_has_no_reader
-- check, before threshold_cannot_fire ever runs. Proven the hard way: the
-- first version of this test named 'reversible' directly and passed for the
-- wrong reason (caught by re-running and reading the actual error text, not
-- assumed). A synthetic boolean dimension WITH a reader — same fix as the
-- synthetic comparator above, same reason: the real registry cannot reach
-- this branch, so a platform-vocabulary row is added to reach it on purpose.
do $threshold$
declare
  v_t3      uuid;
  v_caught  boolean;
  v_msg     text;
begin
  select id into v_t3 from tenants limit 1;

  insert into authority_dimensions (dimension, value_type, reader_fn) values
    ('probe_bad_boolean', 'boolean', 'public.decide_action_execution(uuid,text,text,boolean,uuid,bigint,text,text)')
  on conflict (dimension) do nothing;
  insert into authority_dimension_comparators (dimension, comparator) values
    ('probe_bad_boolean', 'is')
  on conflict do nothing;

  -- === item 13: a boolean dimension stores 1/0; a threshold of 7 can never
  -- ===          equal either =================================================
  v_caught := false; v_msg := null;
  begin
    insert into authority_rules (tenant_id, actor_kind, category, dimension, comparator, threshold, outcome)
    values (v_t3, 'all', 'probe_bad_boolean_threshold', 'probe_bad_boolean', 'is', 7, 'deny');
  exception when others then
    v_caught := true;
    v_msg := sqlerrm;
  end;
  insert into widen_probe_results(name, outcome, reasons) values (
    'i13_boolean_threshold_7_is_rejected_at_insert',
    case when v_caught then 'require_human' else 'allow' end,
    jsonb_build_array(jsonb_build_object('why', coalesce(v_msg, '<insert was not rejected>')))
  );

  -- === item 14: confidence is read 0..100; a threshold of -1 can never
  -- ===          be tripped by any comparator ================================
  v_caught := false; v_msg := null;
  begin
    insert into authority_rules (tenant_id, actor_kind, category, dimension, comparator, threshold, outcome)
    values (v_t3, 'all', 'probe_bad_confidence_threshold', 'confidence', '<', -1, 'deny');
  exception when others then
    v_caught := true;
    v_msg := sqlerrm;
  end;
  insert into widen_probe_results(name, outcome, reasons) values (
    'i14_confidence_threshold_negative_is_rejected_at_insert',
    case when v_caught then 'require_human' else 'allow' end,
    jsonb_build_array(jsonb_build_object('why', coalesce(v_msg, '<insert was not rejected>')))
  );
end
$threshold$;

-- ── F2 final-review fix wave: the certify probe's new absence arm, added by
-- ── this fix wave — proven against the EXACT sql text of that arm
-- ── (scripts/certify.mjs, 'authority-has-one-evaluator-and-no-decorative-
-- ── dimension'), not a reimplementation that merely resembles it. The drop
-- ── lives inside a SAVEPOINT so it never survives past this block: the rest
-- ── of this file, and anything run after it in the same session before the
-- ── final rollback, must find evaluate_authority intact.
--
-- ⚠ ROLLBACK TO SAVEPOINT undoes EVERYTHING since the savepoint — including
-- a widen_probe_results row inserted while the drop is in effect. Proven the
-- hard way: the first version of this test recorded i16 INSIDE the savepoint
-- window, the rollback silently erased that row along with the drop, and the
-- row vanished from the final report with no error — a checker that cannot
-- fail is theatre, and this was it, caught only by counting the output rows
-- against the 23 expected rather than trusting a clean exit code. A session
-- GUC (set_config with is_local=false) was tried as the smuggling channel
-- and empirically does NOT survive ROLLBACK TO SAVEPOINT either — tested in
-- isolation before trusting it here. nextval() on a sequence DOES: sequence
-- advancement is documented as non-transactional, confirmed empirically
-- against this project too. So the fact "did the arm fire" is smuggled out
-- as a sequence bump, not as a row or a session variable.
do $absence_before$
declare v_violation text;
begin
  -- select ... into against a zero-row source leaves the target NULL rather
  -- than raising (plain, non-STRICT select into) — the same semantics the
  -- trigger in mig 770 already relies on for its own registry lookup.
  select violation into v_violation from (
    select 'the authority evaluator is MISSING' as violation
     where to_regprocedure('public.evaluate_authority(uuid,text,uuid,text,jsonb)') is null
  ) arm;

  insert into widen_probe_results(name, outcome, reasons) values (
    'i15_certify_absence_arm_is_silent_while_evaluator_exists',
    case when v_violation is null then 'allow' else 'require_human' end,
    '[]'::jsonb
  );
end
$absence_before$;

create temp sequence absence_arm_fired_seq;
select nextval('absence_arm_fired_seq');  -- call #1: unconditional baseline,
                                           -- taken BEFORE the savepoint so
                                           -- currval() is always defined
                                           -- afterward, whichever branch runs

savepoint before_evaluator_drop;
drop function public.evaluate_authority(uuid, text, uuid, text, jsonb);

do $absence_after$
begin
  if to_regprocedure('public.evaluate_authority(uuid,text,uuid,text,jsonb)') is null then
    perform nextval('absence_arm_fired_seq');  -- call #2, only if the arm's
                                                -- own condition is true
  end if;
end
$absence_after$;

rollback to savepoint before_evaluator_drop;  -- undoes the drop; does NOT
                                               -- undo either nextval() call

insert into widen_probe_results(name, outcome, reasons) values (
  'i16_certify_absence_arm_fires_when_evaluator_missing',
  case when currval('absence_arm_fired_seq') >= 2 then 'require_human' else 'allow' end,
  jsonb_build_array(jsonb_build_object('why',
    case when currval('absence_arm_fired_seq') >= 2
         then 'the authority evaluator is MISSING' else '<arm did not fire>' end))
);

-- === item 17: the restore genuinely worked — not just that the CATALOG
-- ===          entry reappeared (i16 already proved that), but that the
-- ===          function runs. A tenant-independent call (no fixture rows
-- ===          needed) so this holds even if it runs standalone. ===========
insert into widen_probe_results(name, outcome, reasons) select 'i17_evaluator_restored_and_callable_after_drop_test',
  r->>'outcome', r->'reasons' from (select public.evaluate_authority(null,'all',null,null,'{}'::jsonb) r) x;

select
  w.name,
  w.outcome,
  (select x->>'why' from jsonb_array_elements(w.reasons) x limit 1) as first_reason,
  case
    when e.expect_outcome is not null and w.outcome is distinct from e.expect_outcome
      then 'FAIL outcome, got ' || coalesce(w.outcome,'<null>')
    when e.expect_reason_prefix is not null and not exists (
           select 1 from jsonb_array_elements(w.reasons) x
            where x->>'why' like e.expect_reason_prefix || '%')
      then 'FAIL reason prefix'
    when e.expect_reason_exact is not null and not exists (
           select 1 from jsonb_array_elements(w.reasons) x
            where x->>'why' = e.expect_reason_exact)
      then 'FAIL reason exact'
    else 'pass'
  end as verdict
from widen_probe_results w
join (values
  ('i1_exact_match_binds',                           'require_human'::text, null::text,             null::text),
  ('i1_exact_match_wrong_id_is_allow',                'allow',               null,                    null),
  ('i2_role_arm_binds',                               'require_human',       null,                    null),
  ('i2_role_arm_wrong_role_is_allow',                 'allow',               null,                    null),
  ('i3_org_unit_below_binds_when_mid_active',         'require_human',       null,                    null),
  ('i4_org_unit_below_still_binds_when_mid_inactive', 'require_human',       null,                    null),
  ('i5_second_approver_reachable',                    'require_second_approver', null,                null),
  ('i5_second_approver_under_threshold_is_allow',     'allow',               null,                    null),
  ('i6_json_null_measure_is_unmeasured',              'require_human',       'unmeasured:',           null),
  ('i7_unparseable_measure_is_unreadable_not_raise',  'require_human',       'unreadable measure:',   null),
  ('i8_null_category_still_hits_category_scoped_rule', null,                 null,                    'amount_cents > 111'),
  ('i9_unknown_actor_kind_is_require_human',          'require_human',       'unknown actor kind:',   null),
  ('i9b_missing_actor_id_is_require_human',           'require_human',       'unidentified actor:',   null),
  ('i10_inactive_rule_does_not_fire',                 'allow',               null,                    null),
  ('iextra_unknown_comparator_escalates',              'require_human',       'unknown comparator:',   null),
  ('i11_role_actor_kind_is_require_human',            'require_human',       'unknown actor kind:',   null),
  ('i12_unresolvable_user_is_require_human',          'require_human',       'unidentified actor:',   null),
  ('i12b_unresolvable_de_is_require_human',           'require_human',       'unidentified actor:',   null),
  ('i13_deactivated_user_is_require_human',           'require_human',       'unidentified actor:',   null),
  ('i13_boolean_threshold_7_is_rejected_at_insert',   'require_human',       'threshold_cannot_fire:', null),
  ('i14_confidence_threshold_negative_is_rejected_at_insert', 'require_human', 'threshold_cannot_fire:', null),
  ('i15_certify_absence_arm_is_silent_while_evaluator_exists', 'allow',      null,                    null),
  ('i16_certify_absence_arm_fires_when_evaluator_missing',     'require_human', null, 'the authority evaluator is MISSING'),
  ('i17_evaluator_restored_and_callable_after_drop_test',      'require_human', null, 'no workspace in context')
) as e(name, expect_outcome, expect_reason_prefix, expect_reason_exact)
  on e.name = w.name
order by w.name;

rollback;
