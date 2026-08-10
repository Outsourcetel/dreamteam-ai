-- 700_a_failover_nobody_saw.sql
-- ============================================================================
-- WHY (gap G-G, unparked by the founder 2026-08-11): the LLM failover spine
-- (llm.ts, 4 tiers, proven live 2026-07-22 when Bedrock rescued a dead
-- Anthropic org) records each failover via platform_config_set — and that
-- write has FAILED SILENTLY since the day it shipped. platform_config_set
-- gates on resolve_platform_capability(auth.uid(), 'billing.manage'); the
-- edge functions call it under the SERVICE ROLE, where auth.uid() is NULL,
-- so every call raises 'not authorized' and llm.ts's best-effort catch
-- swallows it. The spine's own memory flagged the missing marker as "FIX
-- LATER" — this is that fix. Until now a provider failover left no trace a
-- platform admin could query: the dependency the whole workforce runs on had
-- no black box.
--
-- Fix: admit auth.role() = 'service_role' through the gate. This widens
-- NOTHING — a service-role caller already bypasses RLS and can write the
-- platform_config table and vault directly (the Bedrock key setup did
-- exactly that, documented in the spine memory); the capability check only
-- ever guarded USER-JWT calls, and still does. SQL-only: the 18 deployed
-- functions' existing noteFailover call starts working with no redeploy.
-- ============================================================================

begin;

create or replace function public.platform_config_set(p_entries jsonb)
returns boolean
language plpgsql security definer set search_path to 'public'
as $function$
declare
  k text;
  v text;
  v_existing uuid;
begin
  -- Service-role callers (edge functions: failover marker, internal writers)
  -- pass; user-JWT callers still need the platform capability. NULL-safe:
  -- an absent role never equals 'service_role'.
  if not (coalesce(auth.role(), '') = 'service_role'
          or resolve_platform_capability(auth.uid(), 'billing.manage')) then
    raise exception 'not authorized';
  end if;

  for k, v in select * from jsonb_each_text(p_entries)
  loop
    select secret_id into v_existing from platform_config where key = k;

    if v_existing is not null then
      perform vault.update_secret(v_existing, v);
      update platform_config set updated_at = now() where key = k;
    else
      insert into platform_config (key, secret_id, updated_at)
      values (k, vault.create_secret(v, 'platform_config:' || k, 'Set via platform_config_set'), now());
    end if;
  end loop;

  return true;
end;
$function$;

-- Perimeter unchanged on purpose: the fn itself is the gate.
revoke all on function public.platform_config_set(jsonb) from public, anon;

-- ── Verify: behavioral probes, both directions, then clean up ──
do $$
declare
  v_ok boolean;
  v_blocked boolean := false;
  v_probe_secret uuid;
begin
  -- (1) A service-role claim may write (the GUC trick mig 472's probe uses:
  --     no auth.users row is forged, only the transaction-local claim).
  perform set_config('request.jwt.claim.role', 'service_role', true);
  select platform_config_set(jsonb_build_object('G_G_PROBE_KEY', 'probe')) into v_ok;
  if not v_ok then raise exception '700: service-role write did not succeed'; end if;
  if not exists (select 1 from platform_config where key = 'G_G_PROBE_KEY') then
    raise exception '700: service-role write claimed success but wrote nothing';
  end if;

  -- (2) An authenticated claim with no capability is still refused.
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  begin
    perform platform_config_set(jsonb_build_object('G_G_PROBE_KEY_2', 'nope'));
  exception when others then
    v_blocked := true;
  end;
  perform set_config('request.jwt.claim.role', '', true);
  if not v_blocked then
    raise exception '700: an authenticated caller without the capability was NOT refused';
  end if;
  if exists (select 1 from platform_config where key = 'G_G_PROBE_KEY_2') then
    raise exception '700: the refused write left a row behind';
  end if;

  -- (3) Clean the probe key out of config AND vault — a probe is not config.
  select secret_id into v_probe_secret from platform_config where key = 'G_G_PROBE_KEY';
  delete from platform_config where key = 'G_G_PROBE_KEY';
  if v_probe_secret is not null then
    delete from vault.secrets where id = v_probe_secret;
  end if;
  if exists (select 1 from platform_config where key = 'G_G_PROBE_KEY') then
    raise exception '700: probe cleanup failed';
  end if;

  raise notice '700: failover marker path OPEN for service-role writers, user gate intact — the next failover will finally leave a trace';
end $$;

commit;
