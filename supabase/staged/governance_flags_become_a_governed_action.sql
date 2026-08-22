-- ============================================================================
-- The governance controls become governed.
--
-- ⚠ STAGED, NOT NUMBERED. See supabase/staged/README.md.
--     npm run migrate:next -- governance_flags_become_a_governed_action
--
-- ── THE FINDING ────────────────────────────────────────────────────────────
-- Four of this platform's governance organs are HARD OFF, and turning one on is
-- a hand-written service-role INSERT against production with no audit event, no
-- review, and no way to see the result. For a company whose entire pitch is
-- governance, the governance controls are the one ungoverned surface.
--
-- The gate is two-tier and the tiers are not equivalent. Edge functions check a
-- PLATFORM-LEVEL master row in platform_config FIRST and treat an absent row as
-- OFF. Three migrations say so in their own headers, deliberately:
--
--   315_gi8_semantic_guardrail.sql:12   "we seed NO row"
--   317_grounded_confidence_calibration.sql:13   "seed NO row"
--   329_gi10_guardrail_adjudication.sql:40   "NO ROW SEEDED = OFF"
--
-- So migration 551 ("every feature ON by default") moved the SECOND tier —
-- feature_registry.default_enabled — for organs whose FIRST tier does not
-- exist. Reading the registry alone therefore produces a confident wrong
-- answer, which is exactly what 726:72 warned about and exactly the mistake
-- this migration's author made first.
--
-- Measured 2026-08-22 across all 859 migrations:
--
--   semantic_guardrail.enabled       no migration seeds it   HARD OFF
--   guardrail_adjudication.enabled   no migration seeds it   HARD OFF
--   grounded_confidence.enabled      no migration seeds it   HARD OFF
--   learned_http.enabled             no migration seeds it   HARD OFF
--   definition_of_done.enabled       489:23 true, mode=shadow ON, records only
--   amendment_fitness.enabled        313 + 551                ON
--   metering_deferred_settlement     314:138 false            OFF by value
--
-- docs/24 says "Founder activation: flip semantic_guardrail.enabled → 'true'"
-- as though a switch exists. Nothing in the repository performs that write:
-- platform_config is REVOKE ALL FROM anon, authenticated (full_schema.sql:
-- 57874-57875), only service_role holds grants (:58496), and even
-- platform_config_get(text) is revoked from authenticated (:57631).
--
-- ── THE SHARPER HALF ───────────────────────────────────────────────────────
-- 726:70-74, measuring PRODUCTION, reports adjudication as "on but
-- mode='shadow'". No migration seeds guardrail_adjudication.enabled. That row
-- was therefore INSERTED BY HAND and exists in no migration — so a rebuilt
-- environment enforces a different guardrail posture than production, and
-- nothing reports the difference. That is the replayability defect landing on
-- the governance surface specifically, which makes it the most consequential
-- instance of it rather than a footnote.
--
-- ── WHAT THIS DOES ─────────────────────────────────────────────────────────
-- 1. Seeds every governance master row EXPLICITLY, at its current effective
--    value, so the intended posture lives in migration history and a rebuilt
--    environment is IDENTICAL rather than accidentally equal.
-- 2. Gives activation a governed path: platform-admin only, restricted to a
--    hard-coded allowlist of governance keys, writing an audit event every time.
--
-- ⚠ THE ALLOWLIST IS THE POINT, AND IT IS NOT A CONVENIENCE. platform_config
-- also holds vault `secret_id` references (087_encrypt_platform_config.sql,
-- 700_a_failover_nobody_saw.sql). A generic set_platform_config(key, value)
-- would be a credential-rotation primitive wearing a governance label. This
-- function can only ever write these keys, and adding one is a migration a
-- reviewer sees.
--
-- ⚠ THIS CHANGES NO ENFORCEMENT BEHAVIOUR. Every value seeded below is the value
-- already in effect. Flipping one is a separate, deliberate act — which is now
-- possible to perform, see, and audit.
-- ============================================================================

begin;

-- ── 1. The posture becomes explicit ────────────────────────────────────────
-- `on conflict do nothing`: production's current value always wins. This
-- records the DEFAULT for an environment that has none, and must never
-- overwrite a deliberate live setting — including the hand-inserted
-- adjudication row described above, which this preserves rather than clobbers.
insert into public.platform_config (key, value)
values
  ('semantic_guardrail.enabled',      'false'),
  ('semantic_guardrail.mode',         'shadow'),
  ('guardrail_adjudication.enabled',  'false'),
  ('guardrail_adjudication.mode',     'shadow'),
  ('guardrail_adjudication.kill',     'false'),
  ('grounded_confidence.enabled',     'false'),
  ('grounded_confidence.mode',        'shadow'),
  ('learned_http.enabled',            'false')
on conflict (key) do nothing;

-- ── 2. Activation becomes a governed action ────────────────────────────────
create or replace function public.set_platform_governance_flag(
  p_key   text,
  p_value text,
  p_note  text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_allowed constant text[] := array[
    'semantic_guardrail.enabled',     'semantic_guardrail.mode',
    'guardrail_adjudication.enabled', 'guardrail_adjudication.mode', 'guardrail_adjudication.kill',
    'grounded_confidence.enabled',    'grounded_confidence.mode',
    'definition_of_done.enabled',     'definition_of_done.mode',
    'learned_http.enabled',
    'amendment_fitness.enabled',
    'metering_deferred_settlement_enabled'
  ];
  v_old text;
  v_actor text;
  r record;
begin
  if not public.is_platform_admin() then
    raise exception 'only a platform administrator can change a governance flag';
  end if;

  if not (p_key = any(v_allowed)) then
    -- Named refusal, not a silent no-op: platform_config holds vault secret_ids
    -- and this must never become a general-purpose writer.
    raise exception 'refused: "%" is not a governance flag. This function can only write the % keys it declares; anything else is a migration.', p_key, array_length(v_allowed, 1);
  end if;

  -- Every one of these is a boolean word or a mode word. A value outside that
  -- set is a typo that would silently read as OFF at the gate, which is the
  -- worst possible outcome for a control someone believes they just enabled.
  if p_key like '%.mode' then
    if p_value not in ('shadow', 'enforce', 'blended', 'self_reported') then
      raise exception 'refused: mode must be shadow / enforce / blended / self_reported, got "%"', p_value;
    end if;
  elsif p_value not in ('true', 'false') then
    raise exception 'refused: "%" takes true or false, got "%"', p_key, p_value;
  end if;

  select value into v_old from public.platform_config where key = p_key;

  insert into public.platform_config (key, value, updated_at)
  values (p_key, p_value, now())
  on conflict (key) do update set value = excluded.value, updated_at = now();

  select coalesce(full_name, email, 'platform operator') into v_actor
    from public.profiles where user_id = auth.uid();

  -- Recorded in EVERY workspace's chain, because a platform-level governance
  -- change alters what every workspace is subject to. A tenant that later asks
  -- "when did the semantic guardrail start blocking us?" can answer it from
  -- their own audit trail rather than ours.
  for r in select id from public.tenants loop
    perform public.append_audit_event_internal(
      r.id, coalesce(v_actor, 'platform'), 'human',
      format('Platform governance flag %s changed', p_key), 'security',
      jsonb_build_object('key', p_key, 'from', v_old, 'to', p_value, 'note', p_note));
  end loop;

  return jsonb_build_object('ok', true, 'key', p_key, 'from', v_old, 'to', p_value);
end $fn$;

revoke all on function public.set_platform_governance_flag(text, text, text) from public, anon;
grant execute on function public.set_platform_governance_flag(text, text, text) to authenticated;

-- ── 3. And a reader, so the console can show what is actually enforced ─────
-- Returns ONLY the governance keys, never an arbitrary lookup — the same reason
-- 726's status RPC deliberately takes no key parameter: a config reader with a
-- key argument is a config oracle.
create or replace function public.list_platform_governance_flags()
returns table(key text, value text, updated_at timestamptz)
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
begin
  if not public.is_platform_admin() then
    raise exception 'only a platform administrator can read the governance flags';
  end if;
  return query
    select c.key, c.value, c.updated_at
      from public.platform_config c
     where c.key in (
       'semantic_guardrail.enabled','semantic_guardrail.mode',
       'guardrail_adjudication.enabled','guardrail_adjudication.mode','guardrail_adjudication.kill',
       'grounded_confidence.enabled','grounded_confidence.mode',
       'definition_of_done.enabled','definition_of_done.mode',
       'learned_http.enabled','amendment_fitness.enabled',
       'metering_deferred_settlement_enabled')
     order by c.key;
end $fn$;

revoke all on function public.list_platform_governance_flags() from public, anon;
grant execute on function public.list_platform_governance_flags() to authenticated;

-- ── PROOF ───────────────────────────────────────────────────────────────────
-- Schema and config assertions only — both describe what THIS migration
-- installed, so they hold on an empty database and need no fixture.
do $verify$
declare v_n int;
begin
  if to_regprocedure('public.set_platform_governance_flag(text,text,text)') is null
     or to_regprocedure('public.list_platform_governance_flags()') is null then
    raise exception 'GOV FAILED: a function is missing'; end if;

  -- Every master row the edge functions read now EXISTS, so a rebuilt
  -- environment resolves the same posture as production instead of falling
  -- through "absent = off" by accident.
  select count(*) into v_n from (values
      ('semantic_guardrail.enabled'),('guardrail_adjudication.enabled'),
      ('grounded_confidence.enabled'),('learned_http.enabled')) t(k)
   where not exists (select 1 from public.platform_config c where c.key = t.k);
  if v_n <> 0 then
    raise exception 'GOV FAILED: % governance master row(s) still absent', v_n; end if;

  -- The writer is not a general-purpose config setter. Asserted on the SOURCE,
  -- because that is the property a future edit would quietly remove.
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'set_platform_governance_flag'
         and pg_get_functiondef(p.oid) like '%is not a governance flag%') <> 1 then
    raise exception 'GOV FAILED: the key allowlist is gone — this would be a vault-secret writer';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'set_platform_governance_flag'
         and pg_get_functiondef(p.oid) like '%is_platform_admin()%') <> 1 then
    raise exception 'GOV FAILED: the platform-admin gate is gone';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'set_platform_governance_flag'
         and pg_get_functiondef(p.oid) like '%append_audit_event_internal%') <> 1 then
    raise exception 'GOV FAILED: the change would not be audited';
  end if;

  -- Neither function may be reachable by anon. Absence-of-violation form.
  select count(*) into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('set_platform_governance_flag','list_platform_governance_flags')
     and has_function_privilege('anon', p.oid, 'EXECUTE');
  if v_n <> 0 then raise exception 'GOV FAILED: % governance function(s) reachable by anon', v_n; end if;

  raise notice 'governance flags: 4 absent master rows seeded, activation is now audited and allowlisted';
end $verify$;

commit;
