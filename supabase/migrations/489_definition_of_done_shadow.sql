-- 489_definition_of_done_shadow.sql
-- ============================================================================
-- WAVE 1, ITEM 3 (second half): the definition-of-done gate is switched on in
-- SHADOW, everywhere.
--
-- Founder decision N3: a text-only reply becomes a routed question rather than
-- a "done" (shipped in de-work), AND the definition-of-done checker turns on in
-- shadow mode — it logs what it WOULD block — until it is calibrated. Flipping
-- to enforce is a separate, deliberate act, because enforcement reclassifies
-- existing "done" work as incomplete on live screens.
--
-- The gate was built and has NEVER evaluated anything: platform_config held
-- zero definition_of_done keys, so defOfDoneGate() returned {enabled:false} on
-- every call and definition_of_done_log stayed empty. A kill-switch nobody
-- ever armed is not a control.
--
-- Ships GLOBAL by baseline (the standing rule): feature_registry.default_enabled
-- flips to true, so every tenant — present and future — gets it without a
-- per-tenant row. Any tenant that later wants out gets an explicit override;
-- there are zero overrides today.
-- ============================================================================

insert into platform_config (key, value)
values ('definition_of_done.enabled', 'true')
on conflict (key) do update set value = excluded.value, updated_at = now();

insert into platform_config (key, value)
values ('definition_of_done.mode', 'shadow')
on conflict (key) do update set value = excluded.value, updated_at = now();

update feature_registry set default_enabled = true where key = 'definition_of_done';

do $a$
declare
  v_master text;
  v_mode text;
  v_default boolean;
  v_hq uuid;
  v_on boolean;
  n int;
begin
  select value into v_master from platform_config where key = 'definition_of_done.enabled';
  if coalesce(v_master, '') <> 'true' then
    raise exception '489: master switch did not land (%)', coalesce(v_master, 'NULL');
  end if;

  -- Shadow, not enforce. Getting this backwards would reclassify live work.
  select value into v_mode from platform_config where key = 'definition_of_done.mode';
  if coalesce(v_mode, '') <> 'shadow' then
    raise exception '489: mode is "%" — N3 requires shadow first', coalesce(v_mode, 'NULL');
  end if;

  select default_enabled into v_default from feature_registry where key = 'definition_of_done';
  if v_default is not true then
    raise exception '489: the feature is not on by default — it would reach no tenant';
  end if;

  -- Behavioural: the gate resolver must now report enabled for a real tenant.
  -- Checking config rows alone would pass even if the resolver still said no.
  select id into v_hq from tenants where slug = 'outsourcetel-hq';
  if v_hq is not null then
    select is_feature_enabled_internal(v_hq, 'definition_of_done') into v_on;
    if v_on is not true then
      raise exception '489: the gate still resolves OFF for outsourcetel-hq';
    end if;
  end if;

  -- And it must be on for every tenant, not just hq — the ships-global rule.
  select count(*) into n
    from tenants t
   where is_feature_enabled_internal(t.id, 'definition_of_done') is not true;
  if n > 0 then
    raise exception '489: % tenants would still not evaluate the gate', n;
  end if;

  raise notice '489: definition-of-done armed in SHADOW for all tenants — it now logs what it would withhold';
end $a$;
