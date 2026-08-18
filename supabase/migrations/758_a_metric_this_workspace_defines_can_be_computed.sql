-- ============================================================================
-- 758 — a metric this workspace defines can be COMPUTED.
--
-- docs/54 item 12, the wall: "upsert_kpi_metric hardcodes source='manual' — a
-- tenant-defined metric can NEVER be computed by the platform." Measured: 0
-- tenant-defined metrics exist on any tenant, and every reading on record is
-- source='system' from the built-in catalog. A workspace could name a metric
-- and then had no way to ever get a number into it except typing one.
--
-- The table always allowed it — kpi_metric_catalog_source_check admits
-- ('computed','manual','action'). Only the RPC refused, by never offering the
-- column. Mig 756/757 put the action arm in ONE place first, precisely so this
-- change is written once.
--
-- ⛔ 'computed' IS DELIBERATELY NOT OFFERED. A 'computed' metric is resolved
-- from v_vals, whose keys are the seven built-in metric keys the platform
-- calculates. A tenant key can never appear there, so a tenant-defined
-- 'computed' metric would resolve to NULL forever — a metric that cannot ever
-- hold a value, which is worse than one that refuses to be created. manual and
-- action are the two that can actually produce a number.
--
-- ⚠ UNKNOWN CONFIG KEYS ARE REJECTED, and this is the important guard. The arm
-- reads `coalesce(source_config->>'category','') = '' or ad.category = ...`.
-- A typo — 'catagory' — is not an error there: it makes the filter empty,
-- which means NO FILTER, which means the metric silently counts EVERY action
-- the employee ever took. A metric that quietly measures the wrong thing is
-- the exact failure this codebase keeps recording. So only agg, category and
-- action_label are accepted, and anything else raises.
--
-- ⚠ SIGNATURE CHANGE — THE ALLOWLIST MUST BE RE-PINNED. Adding parameters to a
-- Postgres function creates an OVERLOAD, not a replacement, and a 5-argument
-- call would then be ambiguous between the two. So the old signature is
-- DROPPED and the new one created. That changes the identity string certify
-- pins, so supabase/baseline/execute-allowlist.json shows one VANISHED and one
-- NEW entry until re-pinned. This is the sanctioned case the allowlist note
-- describes — a DELIBERATE perimeter change — and not the forbidden one
-- (re-pinning to make a red run green). The grants are restored explicitly
-- below rather than left to Supabase's defaults, because a dropped function
-- takes its ACL with it and the default would hand EXECUTE to PUBLIC.
--
-- The browser caller (src/lib/roleConfigApi.ts:118 createKpiMetric) passes
-- five NAMED arguments and keeps working untouched; the two new parameters
-- default.
-- ============================================================================

drop function if exists public.upsert_kpi_metric(text, text, text, text, text);

create or replace function public.upsert_kpi_metric(
  p_metric_key    text,
  p_label         text,
  p_direction     text  default 'higher',
  p_unit          text  default null,
  p_description   text  default null,
  p_source        text  default 'manual',
  p_source_config jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant uuid := auth_tenant_id();
  v_id     uuid;
  v_source text := coalesce(nullif(btrim(p_source), ''), 'manual');
  v_cfg    jsonb;
  v_bad    text;
begin
  if v_tenant is null then raise exception 'not_authenticated'; end if;
  if not auth_has_tenant_role(array['tenant_owner','tenant_admin']) then raise exception 'insufficient_role'; end if;
  if p_metric_key !~ '^[a-z0-9_]{2,60}$' then
    raise exception 'metric_key must be lowercase letters, numbers and underscores';
  end if;
  -- A tenant may not shadow a built-in key; that would silently change
  -- which value the computed lookup returns.
  if exists (select 1 from kpi_metric_catalog where tenant_id is null and metric_key = p_metric_key) then
    raise exception 'metric_key_reserved: % is a built-in metric', p_metric_key;
  end if;

  if v_source not in ('manual', 'action') then
    raise exception 'source_not_supported: % — a workspace metric is manual (you record it) or action (the platform counts it)', v_source;
  end if;

  if v_source = 'manual' then
    if p_source_config is not null and p_source_config <> '{}'::jsonb then
      raise exception 'source_config_not_allowed: a manual metric takes no source_config';
    end if;
    -- NOT NULL with default {} — see the suite note above: setting this
    -- to NULL broke the EXISTING manual path, which is the path that already
    -- worked. Caught only because the suite tested the old behaviour too.
    v_cfg := '{}'::jsonb;
  else
    v_cfg := coalesce(p_source_config, '{}'::jsonb);
    if jsonb_typeof(v_cfg) <> 'object' then
      raise exception 'source_config_must_be_an_object';
    end if;
    -- An unrecognised key is NOT harmless: the arm treats a missing filter as
    -- "match everything", so a typo turns a narrow metric into a count of all
    -- actions. Refuse instead of measuring the wrong thing quietly.
    select string_agg(k, ', ') into v_bad
      from jsonb_object_keys(v_cfg) k
     where k not in ('agg', 'category', 'action_label');
    if v_bad is not null then
      raise exception 'source_config_unknown_key: % — only agg, category, action_label', v_bad;
    end if;
    if coalesce(v_cfg->>'agg', 'count') not in ('count', 'auto_rate') then
      raise exception 'source_config_agg_invalid: % — count or auto_rate', v_cfg->>'agg';
    end if;
    if coalesce(v_cfg->>'category', '') <> ''
       and not exists (select 1 from system_categories sc where sc.key = v_cfg->>'category') then
      raise exception 'source_config_category_unknown: %', v_cfg->>'category';
    end if;
  end if;

  insert into kpi_metric_catalog (tenant_id, metric_key, label, direction, unit, description, source, source_config)
  values (v_tenant, p_metric_key, p_label, coalesce(p_direction,'higher'), p_unit, p_description, v_source, v_cfg)
  on conflict (tenant_id, metric_key) where tenant_id is not null
  do update set label = excluded.label, direction = excluded.direction,
                unit = excluded.unit, description = excluded.description,
                -- Without these two, a metric could never be switched from
                -- manual to computed after it was first created — which is
                -- the whole point of this migration.
                source = excluded.source, source_config = excluded.source_config
  returning id into v_id;
  return v_id;
end$function$;

-- A dropped function takes its ACL with it, and the recreated one would
-- otherwise inherit the PUBLIC default plus Supabase's anon grant (migs
-- 610 + 630). Restored to exactly what it had: authenticated + service_role.
revoke all on function public.upsert_kpi_metric(text, text, text, text, text, text, jsonb) from public;
revoke all on function public.upsert_kpi_metric(text, text, text, text, text, text, jsonb) from anon;
grant execute on function public.upsert_kpi_metric(text, text, text, text, text, text, jsonb) to authenticated;
grant execute on function public.upsert_kpi_metric(text, text, text, text, text, text, jsonb) to service_role;
