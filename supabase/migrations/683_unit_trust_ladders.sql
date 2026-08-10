-- 683 — a ladder exists for every unit that earned the right to climb (G-F).
--
-- Founder ratified three decisions on 2026-08-10:
--
--   D1  POLICY OF RECORD: a human approving a Digital Employee's action counts
--       as trust evidence, scoped to the category the policy governs (shipped
--       in mig 586; ratified now — this header is the record).
--   D2  Per-unit target levels. Six employees had NO trust policy at all —
--       "supervised forever" was structural, not earned. Seeded here by
--       archetype across active tenants (always-live rule):
--         renewal_manager  → action_execute,        target level 2 (rank-#1 unit;
--                            level 2 still requires a human click per rung)
--         billing_ar       → action:erp_financials, target level 1 (money verbs
--                            are destructive-floored FOREVER regardless of level)
--         onboarding       → action_execute,        target level 1
--       DELIBERATELY ABSENT — absence encodes the founder's HOLD: bdr and
--       marketing archetypes (units on hold in the portfolio) and the
--       Workspace Assistant (platform property; always supervised) get NO
--       ladder. Do not "fix" this by adding one.
--   D3  Action-shaped policies get action-shaped evidence. ~14 per-tool
--       policies (mcp_stripe_*, log_invoice_note, action:erp_financials …)
--       carried the exam criteria of the answer desk — min_eval_samples 25 on
--       employees that never sit an answering exam. That is mig 586's
--       "excused from the exam yet failed it" defect, re-seeded at scale.
--       Aligned here: min_eval_samples → 0, min_human_samples → at least 3.
--       answer_dock / answer_widget KEEP their exams — those employees sit them.
--
-- Criteria shape = the Finance DE's proven ladder (the only policy that has
-- ever reached eligible): window 30d, no exam requirement, 3 human approvals
-- at ≥90%, zero production guardrail blocks (mig 682's origin filter keeps
-- marked exercises out of that count).

-- ── D2: seed the missing unit ladders ──────────────────────────────────────
-- target_level is a GENERATED column (LEAST(current_level+1, 3)) — the ladder
-- names its own next rung. The founder's per-unit ceiling lives in max_level,
-- which apply_trust_promotion enforces at the climb (mig 458:
-- least(current+1, max_level)). Bailey's "level 1 forever" is that cap.
insert into trust_policies (tenant_id, de_id, action_category, max_level, display_name, criteria)
select d.tenant_id, d.id, x.category, x.cap,
       'Unit ladder — ' || coalesce(d.persona_name, d.name),
       '{"window_days": 30, "min_eval_samples": 0, "min_human_samples": 3,
         "min_eval_pass_rate": 0.9, "max_guardrail_blocks": 0,
         "min_human_approval_rate": 0.9}'::jsonb
  from digital_employees d
  join tenants t on t.id = d.tenant_id and t.status = 'active'
  join lateral (values
        ('renewal_manager', 'action_execute',        2),
        ('billing_ar',      'action:erp_financials', 1),
        ('onboarding',      'action_execute',        1)
       ) as x(archetype, category, cap)
    on x.archetype = d.archetype_key
 where coalesce(d.lifecycle_status, 'active') not in ('paused', 'retired', 'archived')
   and not exists (
         select 1 from trust_policies p
          where p.tenant_id = d.tenant_id
            and p.action_category = x.category
            and coalesce(p.source_category, '') = ''
            and coalesce(p.de_id::text, '') = d.id::text);

-- ── D3: align action-shaped criteria (answer desks keep their exams) ───────
update trust_policies
   set criteria = criteria || jsonb_build_object(
         'min_eval_samples', 0,
         'min_human_samples', greatest(coalesce((criteria->>'min_human_samples')::int, 0), 3)),
       updated_at = now()
 where status = 'active'
   and action_category not in ('answer_dock', 'answer_widget')
   and coalesce((criteria->>'min_eval_samples')::int, 25) > 0;

-- ── Prove it, in this transaction ──────────────────────────────────────────
do $$
declare
  v_n bigint;
  v_pol trust_policies;
begin
  -- The three archetypes now hold their ladders on the proof tenant.
  select count(*) into v_n
    from trust_policies p
    join digital_employees d on d.id = p.de_id
    join tenants t on t.id = p.tenant_id
   where t.slug = 'outsourcetel-hq' and p.status = 'active'
     and ((d.archetype_key = 'renewal_manager' and p.action_category = 'action_execute'        and p.max_level = 2)
       or (d.archetype_key = 'billing_ar'      and p.action_category = 'action:erp_financials' and p.max_level = 1)
       or (d.archetype_key = 'onboarding'      and p.action_category = 'action_execute'        and p.max_level = 1));
  if v_n < 3 then raise exception '683: expected 3 unit ladders on outsourcetel-hq, found %', v_n; end if;

  -- The HOLD is real: bdr, marketing and the Workspace Assistant gained nothing.
  select count(*) into v_n
    from trust_policies p
    join digital_employees d on d.id = p.de_id
    join tenants t on t.id = p.tenant_id
   where t.slug = 'outsourcetel-hq' and p.status = 'active'
     and (d.archetype_key in ('bdr', 'marketing') or d.archetype_key is null);
  if v_n > 0 then raise exception '683: % ladder(s) appeared on HELD units — absence was the decision', v_n; end if;

  -- No active action-shaped policy still demands an exam it cannot sit.
  select count(*) into v_n
    from trust_policies
   where status = 'active'
     and action_category not in ('answer_dock', 'answer_widget')
     and coalesce((criteria->>'min_eval_samples')::int, 0) > 0;
  if v_n > 0 then raise exception '683: % action-shaped policies still carry an exam requirement', v_n; end if;

  -- Precision, both directions (a fix that passes everything is worthless):
  -- Morgan's earned eligibility SURVIVES the alignment…
  select p.* into v_pol
    from trust_policies p
    join digital_employees d on d.id = p.de_id
    join tenants t on t.id = p.tenant_id
   where t.slug = 'outsourcetel-hq' and d.archetype_key = 'fpa'
     and p.action_category = 'action_execute' and p.status = 'active'
   limit 1;
  if v_pol.id is null or (trust_evidence_for(v_pol)->>'eligible') <> 'true' then
    raise exception '683: Morgan''s earned eligibility did not survive the alignment';
  end if;

  -- …and the NEW ladders start ineligible: a seeded policy is a gate, not a gift.
  select count(*) into v_n
    from trust_policies p
    join digital_employees d on d.id = p.de_id
    join tenants t on t.id = p.tenant_id
   where t.slug = 'outsourcetel-hq' and p.status = 'active'
     and d.archetype_key in ('renewal_manager', 'billing_ar', 'onboarding')
     and (trust_evidence_for(p)->>'eligible') = 'true';
  if v_n > 0 then raise exception '683: % newly seeded ladder(s) born eligible — evidence must be earned, never granted', v_n; end if;
end $$;
