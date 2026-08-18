-- ============================================================================
-- 754 — a trust level cannot hide a live grant.
--
-- THE DEFECT, measured on production 2026-08-18. The Renewal DE renders as
-- `supervised` with every trust policy at current_level 0 — the level at which
-- the ladder is off and grants nothing — and at the same moment enforcement
-- resolves `action_execute`/`crm` to ENABLED for it. Both are correct. The
-- employee file simply shows the first and never mentions the second, so the
-- one screen a customer reads to answer "what may this employee do on its own"
-- answers a narrower question than the one they asked.
--
-- WHY THE LADDER IS NOT THE ANSWER. `de_autonomy` has SEVEN writers and only
-- `trust_apply_level` is downstream of a trust level; an archetype carrying
-- `autonomy_templates` has its row written AT HIRE by
-- `instantiate_role_archetype_internal`, before any trust card is rendered.
-- Reading the ladder therefore tells you about one writer out of seven.
--
-- WHAT THIS ADDS, AND WHAT IT DELIBERATELY DOES NOT. One read-only reader.
-- No writer is touched, no grant on any table changes, no existing routine is
-- redefined. It does NOT report WHERE a grant came from: `de_autonomy` has no
-- provenance column and `updated_by` is NULL on all 25 live rows, so any
-- "source" this returned today would be inferred rather than recorded — the
-- stored-marker-as-truth trap. Provenance is a separate, deliberate change
-- that has to stamp all seven writers; it is not smuggled in here.
--
-- ⛔ IT MUST ASK ENFORCEMENT, NOT RE-DERIVE IT. The tempting version composes
-- `derive_de_autonomy_dials` (raw rows, NO records gate) with
-- `get_de_gate_status` in TypeScript. That is a JS re-implementation of a
-- Postgres predicate, which this repo has already paid for once: such a test
-- proves only that the transcription agrees with itself. So this calls
-- `resolve_de_autonomy_chain` with the SAME key array `decide_action_execution`
-- passes — `['action:<category>', <action key>, 'action_execute']`, SPECIFIC
-- FIRST per mig 618 — and reports what it returns. If enforcement changes, this
-- screen changes with it, because it is the same call.
--
-- Guards mirror `get_de_gate_status` exactly: tenant derived from
-- `auth_tenant_id()` and NEVER taken as a parameter (a tenant-id parameter on a
-- SECURITY DEFINER routine IS the authorisation), membership checked, then
-- `can_access_de`. A null tenant returns not_permitted rather than falling
-- through — service_role has no tenant claim and must not be handed every row.
-- ============================================================================

create or replace function public.get_de_effective_permissions(p_de_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_tenant uuid;
  v_gate   record;
  v_dial   record;
  v_eff    record;
  v_perms  jsonb := '[]'::jsonb;
begin
  v_tenant := public.auth_tenant_id();
  if v_tenant is null then
    return jsonb_build_object('ok', false, 'error', 'not_permitted');
  end if;

  if not exists (
    select 1 from public.digital_employees d
     where d.id = p_de_id and d.tenant_id = v_tenant
  ) then
    return jsonb_build_object('ok', false, 'error', 'de_not_found');
  end if;

  if not public.can_access_de(p_de_id) then
    return jsonb_build_object('ok', false, 'error', 'de_not_found');
  end if;

  select g.gated, g.reasons into v_gate
    from public.de_records_gate(v_tenant, p_de_id) g;

  for v_dial in select * from public.derive_de_autonomy_dials(p_de_id) loop
    -- The same chain, in the same order, that decide_action_execution uses.
    select c.enabled, c.max_amount_cents, c.min_confidence into v_eff
      from public.resolve_de_autonomy_chain(
             v_tenant,
             array['action:' || v_dial.source_category, null, 'action_execute'],
             p_de_id,
             v_dial.source_category,
             null) c;

    v_perms := v_perms || jsonb_build_object(
      'source_category',    v_dial.source_category,
      'label',              v_dial.label,
      -- what the dials panel shows …
      'configured',         v_dial.configured,
      'configured_enabled', v_dial.enabled,
      -- … and what enforcement will actually decide. Both, on purpose: when
      -- they disagree the screen has to be able to say so.
      'effective_enabled',  coalesce(v_eff.enabled, false),
      'max_amount_cents',   v_eff.max_amount_cents,
      'min_confidence',     v_eff.min_confidence
    );
  end loop;

  return jsonb_build_object(
    'ok',           true,
    'gated',        coalesce(v_gate.gated, false),
    'gate_reasons', to_jsonb(coalesce(v_gate.reasons, array[]::text[])),
    'permissions',  v_perms
  );
end
$fn$;

-- Default EXECUTE goes to PUBLIC and Supabase adds anon/authenticated; the hole
-- this repo re-shipped twice (migs 610 + 630). Closed explicitly, every time.
revoke all on function public.get_de_effective_permissions(uuid) from public;
revoke all on function public.get_de_effective_permissions(uuid) from anon;
grant execute on function public.get_de_effective_permissions(uuid) to authenticated;
