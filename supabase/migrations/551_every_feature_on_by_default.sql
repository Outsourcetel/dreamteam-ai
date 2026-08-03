-- 551: every feature ON by default, in every workspace — founder decision.
--
-- Three features shipped default-off and stayed that way for everyone,
-- including the workspace they were validated on. This turns them on, for
-- existing workspaces and for every workspace created from now on.
--
-- ── require_certification needs MORE than the default flag ──────────────────
-- This one cannot be switched on by flipping feature_registry alone.
-- de_records_gate reads `tenant_feature_overrides` DIRECTLY and requires an
-- explicit true — deliberately, because is_feature_enabled_internal fails OPEN
-- and a governance control must never switch itself on by accident. So a real
-- override row per workspace is written here.
--
-- WHAT THAT ACTUALLY CHANGES, precisely:
--   * The override's updated_at is the GRANDFATHER CUTOFF. de_records_gate
--     only requires certification of employees whose created_at is LATER than
--     it. Writing these rows now therefore grandfathers every employee that
--     exists today — no current employee changes behaviour.
--   * From now on, an employee hired into a role that HAS an active exam must
--     pass it before acting autonomously; until it does it is supervised, not
--     stopped. Every workspace has active exam rows (5–24 each), and an exam
--     with a null archetype counts for any role, so this will genuinely bite
--     for new hires. That is the point of turning it on.
--   * The separate publish gate (gate_de_certification, a trigger on
--     lifecycle_status) already enforced unconditionally regardless of this
--     flag. Turning the flag on makes the flag and the trigger agree, which
--     they previously did not — the audit found the flag claiming "off" while
--     the trigger enforced on everyone.
--
-- Descriptions are rewritten in the same breath. Leaving them saying "Default
-- OFF" would recreate the exact defect migration 550 just fixed, and the
-- parity detector added there would (correctly) fire on it.
begin;

-- ── every feature defaults on ───────────────────────────────────────────────
update feature_registry set default_enabled = true where default_enabled = false;

update feature_registry set description =
  'A digital employee hired into a role that has an active certification exam must pass it before it can act or answer autonomously; until it does, its work is supervised rather than stopped. On by default. Employees already hired when this was switched on are grandfathered, and a role with no published exam is never blocked.'
 where key = 'require_certification';

update feature_registry set description =
  'An AI second pass that catches paraphrased violations of blocking guardrail and compliance-pack rules after the keyword first pass. On by default and fail-closed: if the judge cannot reach a verdict, the block stands.'
 where key = 'semantic_guardrail';

update feature_registry set description =
  'Automatically re-sync knowledge connectors on their configured interval, so answers are drawn from current material without anyone remembering to press refresh. On by default.'
 where key = 'knowledge_scheduled_sync';

-- ── the explicit opt-in de_records_gate actually reads ──────────────────────
-- updated_at is left to default on INSERT and deliberately NOT touched on
-- conflict: moving it would shift the grandfather cutoff forward and newly
-- gate employees hired since an earlier opt-in.
insert into tenant_feature_overrides (tenant_id, feature_key, enabled, note)
select t.id, 'require_certification', true,
       'Migration 551 — certification required in every workspace. Employees existing at this timestamp are grandfathered.'
  from tenants t
on conflict (tenant_id, feature_key) do update set enabled = true;

-- ── the remaining platform-level feature switch ─────────────────────────────
-- amendment_fitness measures whether an approved playbook amendment actually
-- improved anything (de-fitness-measure). It was off platform-wide.
update platform_config set value = 'true' where key = 'amendment_fitness.enabled';
insert into platform_config (key, value)
select 'amendment_fitness.enabled', 'true'
 where not exists (select 1 from platform_config where key = 'amendment_fitness.enabled');

-- NOT TOUCHED, and deliberately so:
--   * metering_deferred_settlement_enabled — a BILLING settlement mode, not a
--     product feature. Flipping how money is settled is not something to do as
--     a side effect of "turn the features on".
--   * definition_of_done.mode / guardrail_adjudication.mode = 'shadow' and
--     grounded_confidence.mode = 'blended'. Those features ARE on; mode is a
--     separate dial that decides whether they merely record or actually
--     withhold and block. Moving them to enforcing would start blocking real
--     work platform-wide and is its own decision.

do $do$
declare v_n int; v_de uuid; v_tenant uuid; v_gated boolean; v_reasons text[];
begin
  select count(*) into v_n from feature_registry where default_enabled = false;
  if v_n <> 0 then raise exception '551: % feature(s) still default-off', v_n; end if;

  select count(*) into v_n from feature_registry
   where default_enabled = true and description ilike '%default off%';
  if v_n <> 0 then raise exception '551: % description(s) still claim default OFF', v_n; end if;

  select count(*) into v_n from tenants t
   where not exists (select 1 from tenant_feature_overrides o
                      where o.tenant_id = t.id and o.feature_key = 'require_certification' and o.enabled);
  if v_n <> 0 then raise exception '551: % workspace(s) lack the certification opt-in', v_n; end if;

  select count(*) into v_n from tenants t
   where not public.is_feature_enabled_internal(t.id, 'require_certification')
      or not public.is_feature_enabled_internal(t.id, 'semantic_guardrail')
      or not public.is_feature_enabled_internal(t.id, 'knowledge_scheduled_sync');
  if v_n <> 0 then raise exception '551: % workspace(s) still resolve a feature as off', v_n; end if;

  if (select value from platform_config where key = 'amendment_fitness.enabled') <> 'true' then
    raise exception '551: amendment_fitness did not turn on'; end if;

  -- THE SAFETY PROOF: an employee that already existed must NOT be newly
  -- gated. If grandfathering did not work, this is where it shows.
  select d.id, d.tenant_id into v_de, v_tenant
    from digital_employees d
    join tenants t on t.id = d.tenant_id
   where d.lifecycle_status <> 'retired' and not d.is_specialist
     and d.created_at < now() - interval '1 hour'
   order by d.created_at limit 1;
  if v_de is null then raise exception '551: no pre-existing employee found to test grandfathering'; end if;

  select gated, reasons into v_gated, v_reasons from public.de_records_gate(v_tenant, v_de);
  if 'never_certified' = any(coalesce(v_reasons, '{}')) then
    raise exception '551: grandfathering FAILED — existing employee % is now gated as never_certified', v_de;
  end if;

  -- and the parity detector must still be quiet
  if (public.run_tenant_feature_parity_audit()->>'findings')::int <> 0 then
    raise exception '551: parity audit is no longer quiet';
  end if;

  raise notice '551: all features on in every workspace; existing employees grandfathered (sample % not gated)', v_de;
end $do$;

commit;
