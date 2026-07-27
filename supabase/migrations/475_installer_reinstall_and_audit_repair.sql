-- 475_installer_reinstall_and_audit_repair.sql
-- ============================================================================
-- Fix-pass companion to the specialist auto-grant migration (decisions batch,
-- 2026-07-28). Two repairs, both born from the outsourcetel-hq duplicate-
-- specialist incident (retired twin b532000c-…, new active 39521a06-…):
--
--   1. INSTALLER REINSTALL TRAP — install_technical_specialist's
--      already-installed check counted ANY row with
--      is_specialist=true/specialist_key='technical', including retired and
--      disabled ones. Consequence live TODAY: a tenant whose specialist was
--      retired can NEVER reinstall — the dead row answers 'already_installed'
--      forever. Retired/disabled specialist rows are TERMINAL HISTORY (the
--      lookup fixes in specialist-consult, same fix-pass, embody the same
--      semantic): they must not block a fresh install. The check now counts
--      only status='active' rows. NOTE the deliberate edge: a tenant whose
--      only specialist is DISABLED gets a NEW row on reinstall rather than a
--      revival of the old one — creating exactly the multi-row-per-key state
--      the fix-pass's status-filtered lookups (edge) make safe. One-active-
--      per-key is NOT structurally guaranteed (no unique index — verified
--      live 2026-07-28), which is why every reader now filters + orders.
--
--   2. MISSING AUDIT EVENT — the server-direct install of hq's new active
--      specialist (2026-07-27 20:44 UTC, de_id 39521a06-…) wrote NO
--      audit_events row: the install statement put the audit call in an
--      unreferenced CTE, which Postgres is free to skip — and did (verified
--      live 2026-07-28: zero audit_events with detail->>'de_id' =
--      '39521a06-…'). A governance write with no trace violates the house
--      standard; the corrective event is appended below via
--      append_audit_event_internal (NEVER a raw INSERT — audit_events is a
--      per-tenant hash chain), explicitly marked retroactive.
--
-- House rules: live-reproduce (function body below is the LIVE
-- pg_get_functiondef of 2026-07-28 — which includes the mig-440 role gate —
-- with ONLY the already-installed check changed); three contexts unchanged
-- (the function already refuses service_role without a tenant and gates on
-- auth-derived roles — it is an interactive RPC, never cron); CREATE OR
-- REPLACE preserves the ACL, asserted below; category 'config_change' and
-- actor_type 'system' verified against the live audit_events check
-- constraints; every assert can actually fail (see each one's comment).
-- ============================================================================

-- ── 1. The installer, reinstall-safe ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.install_technical_specialist()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_tenant uuid; v_is_active boolean; v_id uuid;
begin
  select tenant_id, coalesce(is_active, true) into v_tenant, v_is_active from profiles where user_id = auth.uid();
  if v_tenant is null then
    if coalesce(auth.role(), '') = 'service_role' then raise exception 'service role must use direct inserts with an explicit tenant'; end if;
    return jsonb_build_object('error', 'no_tenant');
  end if;
  if not v_is_active then raise exception 'account is deactivated'; end if;

  -- Role gate (mig 440). Creating a digital employee is a management act.
  -- Manager+ rather than owner/admin: hiring is looser than the credential
  -- and unsupervised-reply gates in migs 433/434.
  if not (is_platform_admin() or auth_has_tenant_role(ARRAY['tenant_owner', 'tenant_admin', 'tenant_manager'])) then
    raise exception 'insufficient_permission: adding a digital employee requires a manager';
  end if;

  -- Already-installed = an ACTIVE specialist exists (fix-pass 2026-07-28).
  -- Retired/disabled specialist rows are terminal history and must NOT block
  -- a reinstall — the old check (no status filter) locked any tenant with a
  -- dead twin out of ever having a working specialist again. Newest-first
  -- for determinism if multiple actives ever exist (no unique index).
  select id into v_id from digital_employees
    where tenant_id = v_tenant and is_specialist = true and specialist_key = 'technical'
      and status = 'active'
    order by created_at desc limit 1;
  if v_id is not null then return jsonb_build_object('profile_id', v_id, 'already_installed', true); end if;

  insert into digital_employees (tenant_id, name, persona_name, category, is_specialist, specialist_key, description, charter, lifecycle_status, status)
  values (v_tenant, 'Technical Specialist', 'Technical Specialist', 'Internal', true, 'technical',
    'Consulted for API, integration, architecture, and debugging questions that exceed a primary Digital Employee''s depth.',
    jsonb_build_object('mission', 'You are the Technical Specialist — consulted for deep technical questions. Answer ONLY from configured sources; cite every source; escalate when the sources do not support an answer.'),
    'active', 'active')
  returning id into v_id;

  perform append_audit_event(v_tenant, 'You', 'human',
    'Technical Specialist installed (as a Digital Employee) — charter seeded, sources not yet configured',
    'config_change', jsonb_build_object('kind', 'specialist_de', 'de_id', v_id, 'specialist_key', 'technical'));
  return jsonb_build_object('profile_id', v_id, 'already_installed', false);
end; $function$;

-- ── 2. Asserts for the installer fix ────────────────────────────────────────
do $$
declare
  v_def text;
  v_old_matches int;
  v_new_pick uuid;
begin
  -- (a) WHERE-clause shape: the deployed already-installed check carries the
  -- status filter. The token is the full predicate as it appears ONLY in the
  -- check (the INSERT's values list says 'active','active' but never
  -- "and status = 'active'"), so a body with the old unfiltered check CANNOT
  -- pass this assert.
  select pg_get_functiondef(p.oid) into v_def from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'install_technical_specialist';
  if v_def not like '%specialist_key = ''technical''%and status = ''active''%order by created_at desc%' then
    raise exception '475: install_technical_specialist already-installed check lacks the active-only filter';
  end if;
  if position('limit 1' in v_def) = 0 then
    raise exception '475: install_technical_specialist check lost its limit';
  end if;

  -- (b) LIVE PROBE against outsourcetel-hq's duplicate state, reproducing the
  -- function's SELECT as a query. This is the behavioural half of the assert
  -- question: it FAILS if a retired row could still block (or win) install.
  --   * old shape (no status filter) must see BOTH rows — proving the trap
  --     was real against live data;
  --   * fixed shape must pick exactly the ACTIVE row (39521a06-…), never the
  --     retired twin (b532000c-…).
  -- If either half fires, hq's duplicate state changed between draft and
  -- apply (e.g. someone stripped is_specialist from the dead row) — re-verify
  -- the incident state, then update or drop this probe deliberately.
  select count(*) into v_old_matches from digital_employees
   where tenant_id = '5bb802e1-8e92-4eef-9a7a-ac348785d43f'
     and is_specialist = true and specialist_key = 'technical';
  if v_old_matches < 2 then
    raise exception '475: hq duplicate state changed (found % technical-specialist row(s), drafted against 2) — re-verify the probe', v_old_matches;
  end if;
  select id into v_new_pick from digital_employees
   where tenant_id = '5bb802e1-8e92-4eef-9a7a-ac348785d43f'
     and is_specialist = true and specialist_key = 'technical' and status = 'active'
   order by created_at desc limit 1;
  if v_new_pick is distinct from '39521a06-dac8-4f32-b44b-f0bd78099c93'::uuid then
    raise exception '475: fixed already-installed check picks % in hq, expected the active specialist 39521a06', v_new_pick;
  end if;
  if v_new_pick = 'b532000c-e30e-4f0b-8e34-887641aebb4e'::uuid then
    raise exception '475: the retired twin still wins the already-installed check';
  end if;

  -- (c) ACL preserved by CREATE OR REPLACE: the mig-440 posture (role gate is
  -- INSIDE the body; EXECUTE stays with authenticated + service_role, never
  -- anon). has_function_privilege is a behaviour check, not a grants-table
  -- string match.
  if has_function_privilege('anon', 'public.install_technical_specialist()', 'execute') then
    raise exception '475: install_technical_specialist executable by anon';
  end if;
  if not has_function_privilege('authenticated', 'public.install_technical_specialist()', 'execute') then
    raise exception '475: install_technical_specialist lost its authenticated EXECUTE grant';
  end if;
end $$;

-- ── 3. Retroactive audit event for the untraced server-direct install ──────
do $$
declare
  v_tenant uuid;
  v_de uuid := '39521a06-dac8-4f32-b44b-f0bd78099c93'::uuid;
begin
  select tenant_id into v_tenant from digital_employees where id = v_de;
  if v_tenant is null then
    raise exception '475: specialist DE 39521a06 no longer exists — the retroactive audit event has nothing to describe';
  end if;

  -- Idempotent: only if the trace is still missing (drafted against zero
  -- matching rows live 2026-07-28). The event goes through
  -- append_audit_event_internal so the tenant's hash chain stays intact.
  if not exists (
    select 1 from audit_events
    where tenant_id = v_tenant
      and detail->>'de_id' = v_de::text
      and detail->>'kind' = 'specialist_de') then
    perform append_audit_event_internal(
      v_tenant, 'DreamTeam', 'system',
      'Technical Specialist installed (as a Digital Employee) — recorded RETROACTIVELY: the install was performed server-direct at the founder''s direction on 2026-07-27 20:44 UTC, and its audit write was silently skipped (the install statement placed it in an unreferenced CTE, which Postgres may not execute). This entry restores the trace; the timestamp of THIS event is the repair time, not the install time.',
      'config_change',
      jsonb_build_object(
        'kind', 'specialist_de',
        'de_id', v_de,
        'specialist_key', 'technical',
        'installed_via', 'server_direct_founder_directed',
        'retroactive', true,
        'installed_at', '2026-07-27T20:44:42Z'));
  end if;

  -- Assert the trace now exists (fails if the insert above was skipped AND
  -- no prior row existed — i.e. the repair did not land).
  if not exists (
    select 1 from audit_events
    where tenant_id = v_tenant
      and detail->>'de_id' = v_de::text
      and detail->>'kind' = 'specialist_de') then
    raise exception '475: retroactive install audit event did not land';
  end if;
end $$;

-- ============================================================================
-- Post-apply verification (read-only, for the applying session):
--
--   -- the fixed check in the deployed body:
--   select pg_get_functiondef(p.oid) from pg_proc p
--    where p.pronamespace='public'::regnamespace
--      and p.proname='install_technical_specialist';
--
--   -- the retroactive trace:
--   select actor, actor_type, action, category, created_at, detail
--     from audit_events
--    where detail->>'de_id' = '39521a06-dac8-4f32-b44b-f0bd78099c93';
--
--   -- OPEN QUESTION for the main session (deliberately NOT decided here):
--   -- the retired twin b532000c-… still carries is_specialist=true/
--   -- specialist_key='technical'. Every reader now filters it out, so it is
--   -- inert history — stripping its specialist flags would ALSO work but
--   -- rewrites history; leaving it is the drafted position.
-- ============================================================================
