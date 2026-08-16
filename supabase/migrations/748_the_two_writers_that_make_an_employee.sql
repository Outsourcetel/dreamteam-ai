-- 748_the_two_writers_that_make_an_employee.sql
-- ==========================================================================
-- WHY: the two functions that CREATE a digital employee both failed open, and
-- neither of them left any record that an employee had been created at all.
--
-- Measured on 2026-08-16 against the LIVE bodies (pg_get_functiondef, WITH
-- LINE COMMENTS STRIPPED before matching — both prosrc and pg_get_functiondef
-- return the `--` comments, and a naive ilike matches the sentence describing
-- the bug; migration 747's own first apply failed on exactly that):
--
--   instantiate_role_archetype(uuid,text,text,text) -> uuid
--   install_role_kit(uuid,text)                     -> jsonb
--
-- both opened with
--
--     if auth.uid() is not null and not exists (...) then raise exception ...
--
-- That prefix makes the authority check SKIP rather than FAIL when auth.uid()
-- is null — i.e. under service_role, or under any `authenticated` caller
-- carrying no `sub` claim at all. This is the SIXTH and SEVENTH instance of
-- the pattern found in two days; attach_compliance_pack and
-- detach_compliance_pack were the fifth and sixth, fixed in migration 747,
-- which named these two by hand and deliberately left them.
--
-- instantiate_role_archetype is the worse of the two, because it takes
-- `p_tenant_id` AS A PARAMETER and writes into it. A tenant-id parameter that
-- nothing checks against the caller's own profile row IS authorisation — the
-- exact shape migrations 662-664 exist to prevent.
--
-- ⚠⚠ AND NEITHER FUNCTION AUDITED. Creating a digital employee is the most
-- consequential write in this product — it is the thing the customer is billed
-- for, the thing that gets a persona, a Book of Work, a published procedure and
-- guardrails — and it left NO row in audit_events anywhere. An employee hired
-- through any of the four live paths had no identity in the ledger: not who
-- hired it, not when, not from which role template, not whether a person or a
-- digital colleague did it. `apply_role_kit_to_employee` audits (it is a
-- wrapper AROUND install_role_kit); the writers themselves did not.
--
-- ==========================================================================
-- THE ENUMERATION, AND WHY THE TWO FIXES ARE DIFFERENT SHAPES
--
-- instantiate_role_archetype — FOUR callers, one of which has no user:
--   · src/lib/hireApi.ts:113                          browser, authenticated
--   · public.decide_discovery_proposal (mig 746)      SQL; SECURITY DEFINER,
--     but auth.uid() is a transaction GUC and survives SECDEF nesting, so this
--     is the real signed-in human, and its Zone 1 already refuses a null uid
--   · supabase/functions/connector-hub/index.ts:3346  ⚠ SERVICE ROLE. The DE
--     tool `dt_hire_from_archetype`, run by the Onboarding Architect through
--     c.admin against c.tenantId. NO auth.uid(), and LEGITIMATELY so — a
--     digital employee executing an approved action, whose authorisation
--     happened upstream in the action-execution path.
--   · public.verify_decide_discovery_proposal (migs 745/746) — impersonates a
--     real uid via set_config, so it is the signed-in human too.
--
-- install_role_kit — THREE callers, ALL with a real signed-in person:
--   · src/lib/hireApi.ts:123                          browser, authenticated
--   · public.decide_discovery_proposal                real auth.uid()
--   · public.apply_role_kit_to_employee               real auth.uid() (it
--     refuses a null one on its own line already)
--   NO service-role caller anywhere. Grepped supabase/functions/ — zero hits.
--   scripts/golden-path.mjs:157 calls it as a signed-up owner over PostgREST.
--
-- So: instantiate SPLITS (747's shape, for the one caller with no user) and
-- install_role_kit DOES NOT (there is nothing to split for).
--
-- ==========================================================================
-- ⚠⚠ THE NAMING DECISION, MADE OUT LOUD: connector-hub MOVES to the _internal
-- variant, and the OLD NAME stays on the WRAPPER.
--
-- Both halves of this cannot be true at once:
--   (a) a caller with no identity is refused by public.instantiate_role_archetype
--   (b) connector-hub keeps calling public.instantiate_role_archetype
--
-- Something has to move. The alternative arrangement — keep the old name on the
-- unchecked service path and give the browser a new one — was considered and
-- rejected: it leaves the ungated function sitting on the name that four call
-- sites, two docs and one permission matrix already point at, so the next
-- caller wired to the obvious name gets the unchecked one. The gate belongs on
-- the name people reach for.
--
-- So connector-hub/index.ts:3346 is repointed at
-- instantiate_role_archetype_internal and passes p_via = 'dt_hire_from_archetype'.
-- That is a ONE-LINE-ish edge-function change and it SHIPS WITH THIS MIGRATION.
-- ⚠ BETWEEN APPLYING THIS AND DEPLOYING connector-hub, dt_hire_from_archetype
-- IS BROKEN. It is broken either way — with the revoke below it fails as
-- `permission denied for function instantiate_role_archetype`, without it as
-- `not authenticated: ...` — so the revoke costs nothing and closes the hole.
-- A hire tool that silently stops working is worse than the hole, so this is
-- said here rather than discovered later: DEPLOY connector-hub WITH THIS.
--
-- ==========================================================================
-- ⚠⚠ THE PLATFORM DISJUNCT IS DROPPED FROM BOTH FUNCTIONS. THIS IS A CHANGE TO
-- WHO CAN HIRE AND IT IS NOT FILED UNDER "authority tidy-up".
--
-- Both live bodies admitted `p.layer = 'platform'` — a platform operator in god
-- mode, for ANY workspace, with the tenant id taken from the parameter. That
-- disjunct is precisely what made the tenant-id parameter into authorisation.
--
-- It cannot survive the audit. append_audit_event's live body raises 'not a
-- member of this tenant' for any non-service_role caller with no profiles row
-- for (auth.uid(), p_tenant_id). BOTH platform profiles carry tenant_id NULL
-- (measured 2 of 2, 2026-08-16) and `profiles` is UNIQUE (user_id)
-- (profiles_user_id_key, measured), so a platform operator can NEVER satisfy
-- that check. Keeping the disjunct while adding the audit would mean: pass the
-- authority check, insert the employee, attach the packs, materialise the
-- autonomy dials, and THEN abort inside append_audit_event — the half-way abort
-- migration 747 exists to replace, reintroduced by the very change that was
-- meant to add accountability. And hireApi.ts runs its three steps in THREE
-- transactions, so a god-mode hire would strand a half-made employee for real.
--
-- Refusing early, in words, is what 746's decide_discovery_proposal does
-- ("⚠ NO `p.layer = 'platform' or` DISJUNCT") and what 747's
-- detach_compliance_pack does ("No `p.layer = 'platform'` disjunct"). This is
-- the third function in three migrations to reach the same conclusion.
--
-- ⚠ WHAT IT COSTS, MEASURED RATHER THAN WAVED AT. Migration 747 deliberately
-- preserved god-mode hiring for the 8 active archetypes that carry no
-- compliance pack (its probe 13 asserted both halves). This migration takes
-- that away — a platform operator can no longer hire ANY archetype from inside
-- a customer's workspace. Before deciding that, the path was measured:
--
--     remote_access_write_log, table_name = 'digital_employees'
--       DELETE  15   (2026-07-19)
--       UPDATE   2   (2026-07-07)
--       INSERT   0   ← ever, across 219 logged god-mode writes in total
--
-- log_remote_access_write records INSERTs (TG_OP in ('INSERT','UPDATE') writes
-- new_data), so a god-mode hire would have appeared there. None ever has. This
-- removes a capability that has never once been exercised, and the refusal says
-- in words what to do instead: sign in as a member of the workspace.
--
-- ⚠ THE SERVICE PATH IS NOT AFFECTED BY THIS. Under service_role
-- append_audit_event skips the membership bar entirely, so the internal variant
-- audits fine with no user — which is exactly why the split exists.
--
-- ==========================================================================
-- WHAT IS NAMED AND LEFT (scope discipline — not fixed here, not hidden)
--
--   · NEITHER function checks `coalesce(p.is_active, true)` on the caller's
--     profile. decide_discovery_proposal and detach_compliance_pack both do. A
--     deactivated owner can hire today and can still hire after this migration;
--     append_audit_event does not check is_active either, so nothing else stops
--     them. Adding it is a change to who can hire, which is a separate decision
--     from closing a fail-open guard, and it is named here rather than slipped
--     in. The role predicate below is otherwise the live one, verbatim.
--   · `tenant_manager` remains admitted by both functions, exactly as today.
--     Migration 747 recorded that a manager cannot hire the 7 pack-carrying
--     archetypes (attach admits owner/admin only) and preserved that asymmetry;
--     it is preserved here too. ⚠ AND IT CANNOT BE FIRED: there are ZERO
--     tenant_manager profiles live (measured — 8 tenant_owner, 11 tenant_admin,
--     2 tenant_user, 0 tenant_manager), so no probe below exercises the manager
--     arm and this migration proves nothing about it either way.
--   · install_role_kit still swallows a per-watcher insert failure into a
--     `watchers_skipped` counter (mig 552). Untouched — it is deliberate, it is
--     reported honestly in the return value, and verify_decide_discovery_proposal
--     probe 13 drives it.
--   · install_role_systems is untouched.
--
-- ==========================================================================
-- ⚠⚠ WHAT THIS MUST NOT DO TO CERTIFY, AND WHY IT DOES NOT
--
-- Migration 745/746's public.verify_decide_discovery_proposal() runs on EVERY
-- certify and scripts/certify.mjs pins EXPECTED_PROBES = 14 and
-- ASSERTION_FLOOR = 138. Its probes 12, 13 and 14 drive decide_discovery_proposal
-- end to end, which calls BOTH functions changed here. Worked through, arm by
-- arm, against the live verifier body:
--
--   · ITS FIXTURE STILL PASSES THE NEW BARS. v_admin_uid is selected as a
--     tenant-layer tenant_owner/tenant_admin JOINED ON p.tenant_id = the probe
--     tenant, active, with no platform profile — so it satisfies the wrapper's
--     new predicate (member of THAT workspace, owner/admin) and
--     append_audit_event's membership bar. Its v_arch_key is chosen for
--     `compliance_pack_keys` EMPTY, so 747's pack refusal cannot fire either.
--   · ITS PLATFORM PROBE IS UNTOUCHED. Probe 11 fires a platform profile at
--     decide_discovery_proposal, which already refuses it in Zone 1 — it never
--     reaches instantiate_role_archetype.
--   · THE AUDIT COUNT DOES NOT MOVE. Probe 12 asserts EXACTLY ONE audit row via
--         detail->>'kind' = 'discovery_proposal_decision'
--         AND detail->>'proposal_id' = <the proposal>
--     and reads the decision's detail back with `detail->>'proposal_id' = ...`
--     alone. So the two new audit rows are invisible to it IF AND ONLY IF they
--     carry neither key. They carry `event` (never `kind`) and no
--     `proposal_id` — and a STATIC RATCHET at the bottom of this file fails if
--     either string ever appears in either body, because "we remembered not to"
--     is not a mechanism.
--   · ITS ROLLBACK BASELINE IS SCOPED THE SAME WAY
--     (`detail->>'kind' = 'discovery_proposal_decision'`), so the new rows
--     cannot make it report a broken rollback.
--   · PROBE 13(b) IS UNAFFECTED. Its `vddp_probe_kit_fail` archetype makes
--     install_role_kit raise 23514 inside the guardrail loop, which is BEFORE
--     the new audit call at the end of the function — so the failing kit still
--     fails, still takes the hire down, and still writes nothing.
--
-- EXPECTATION, STATED BEFORE THE FACT: 14 probes / 138 assertions, unchanged.
-- EXPECTED_PROBES and ASSERTION_FLOOR in scripts/certify.mjs DO NOT MOVE, and
-- this migration does not touch decide_discovery_proposal at all. Probe 8 below
-- drives a real discovery accept and asserts the one-audit-row count itself, so
-- this paragraph is a measurement rather than a hope.
-- ==========================================================================

begin;

-- ==========================================================================
-- 1. instantiate_role_archetype_internal — THE WORK, and the audit
--
--    No user check, because the ONE caller that reaches it without a user has
--    had its authorisation decided upstream: connector-hub's
--    dt_hire_from_archetype is a DE tool, run only after the action-execution
--    path approved it, scoped to its own connector's tenant.
--
--    It still refuses a null workspace and an unknown/inactive archetype, and
--    it carries migration 747's pre-insert compliance-pack refusal VERBATIM —
--    that refusal belongs next to the pack attach, which lives here.
-- ==========================================================================
create or replace function public.instantiate_role_archetype_internal(
  p_tenant_id     uuid,
  p_archetype_key text,
  p_de_name       text,
  p_persona_name  text default null,
  p_via           text default 'internal'
) returns uuid
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  a            role_archetypes;
  v_de         uuid;
  v_pack       text;
  v_dial       jsonb;
  v_dials      integer := 0;
  v_n          integer := 0;
  v_service    boolean;
  v_actor      text;
  v_actor_type text;
  v_name       text;
begin
  v_service := coalesce(auth.role(), '') = 'service_role';
  v_name    := nullif(btrim(coalesce(p_de_name, '')), '');

  -- ⚠ THE WORKSPACE IS NAMED FIRST, in words. Without this a NULL tenant would
  -- reach the digital_employees insert and come back as a raw 23502 about a
  -- column nobody outside this file has heard of. 747's attach variant refuses
  -- the same way and for the same reason.
  if p_tenant_id is null then
    raise exception 'cannot hire: no workspace was named — a digital employee belongs to exactly one workspace, and a call that does not say which cannot be authorised or recorded';
  end if;

  -- digital_employees.name is NOT NULL with no default (measured: tenant_id and
  -- name are the only two such columns), so an empty name would otherwise land
  -- on the caller as 23502.
  if v_name is null then
    raise exception 'cannot hire: a digital employee has to have a name';
  end if;

  select * into a from role_archetypes where key = p_archetype_key and status = 'active';
  if a.key is null then raise exception 'unknown archetype %', p_archetype_key; end if;

  -- ⚠⚠ MIGRATION 747, PRESERVED WHOLE AND MOVED TO WHERE THE PACK ATTACH IS.
  -- Refused HERE, BEFORE ANYTHING EXISTS, rather than half-way.
  --
  -- The pack attach below audits. append_audit_event raises 'not a member of
  -- this tenant' for any non-service_role caller with no profiles row for
  -- (auth.uid(), p_tenant_id). Without this line such a caller would insert the
  -- employee, materialise the pack's blocking rules, and only THEN die inside
  -- the audit call.
  --
  -- It is NOT "platform cannot hire" — that decision is made in the WRAPPER
  -- above this, and made for every archetype. This line is the guarantee that
  -- holds even for a future caller of the internal variant that is neither
  -- service_role nor a member: 8 of the 15 active archetypes carry no pack and
  -- are untouched by it; the 7 that do need a caller the audit chain can name.
  if coalesce(array_length(a.compliance_pack_keys, 1), 0) > 0
     and not v_service
     and not exists (select 1 from profiles p
                      where p.user_id = auth.uid()
                        and p.tenant_id = p_tenant_id) then
    raise exception 'this role comes with the % compliance pack, which switches on blocking rules for every employee in this workspace — and that is recorded against a member of it. Sign in as an owner or admin of this workspace to hire this role.',
      array_to_string(a.compliance_pack_keys, ', ');
  end if;

  -- The live body's column list, VERBATIM.
  insert into digital_employees (tenant_id, name, persona_name, description, category, department,
    lifecycle_status, trust_level, status, capabilities, responsibilities, model_provider, model_id,
    catalog_id, archetype_key)
  values (p_tenant_id, v_name, p_persona_name, a.description, 'Customer', a.domain,
    'designed', 'supervised', 'idle', a.required_capabilities, a.responsibilities, 'anthropic', a.recommended_model,
    a.key, a.key)
  returning id into v_de;

  -- Auto-attach the archetype's mandatory compliance packs.
  -- ⚠ migration 747: the INTERNAL attach variant. The public one demands a
  -- signed-in person, which the connector-hub Onboarding Architect is not.
  -- ⚠ coalesce: `foreach ... in array NULL` is not iteration, it is an error.
  -- Every live archetype carries '{}' today; this makes that a property of the
  -- code rather than of the data.
  foreach v_pack in array coalesce(a.compliance_pack_keys, '{}'::text[]) loop
    perform public.attach_compliance_pack_internal(p_tenant_id, v_pack, 'hire');
  end loop;

  -- mig 497 (D4): the role's own trust dials, materialised PER EMPLOYEE so a
  -- hire never widens the workspace. Counted with GET DIAGNOSTICS rather than by
  -- counting loop iterations, because `on conflict do nothing` means the two
  -- numbers are not the same number.
  for v_dial in select * from jsonb_array_elements(coalesce(a.autonomy_templates, '[]'::jsonb)) loop
    insert into de_autonomy (tenant_id, de_id, action_type, source_category, enabled)
    values (p_tenant_id, v_de, v_dial->>'action_type', v_dial->>'source_category',
            coalesce((v_dial->>'enabled')::boolean, false))
    on conflict do nothing;
    get diagnostics v_n = row_count;
    v_dials := v_dials + v_n;
  end loop;

  -- ⚠ NOT 'You'/'human' UNCONDITIONALLY. append_audit_event only overwrites the
  -- actor for a JWT caller; under service_role it writes whatever it is handed,
  -- so a hardcoded 'You' would file the Onboarding Architect's automated hire as
  -- a human decision. This is 747's lesson, one function along.
  if v_service then
    v_actor := 'System'; v_actor_type := 'system';
  else
    v_actor := 'You';    v_actor_type := 'human';
  end if;

  -- ⚠ NO `proposal_id` KEY — that one really would collide.
  -- verify_decide_discovery_proposal reads a decision's detail back with
  -- `detail->>'proposal_id' = ...` ON ITS OWN, unqualified by kind, so a hire
  -- carrying that key would be picked up as a second decision row.
  --
  -- ⚠⚠ BUT `kind` IS CORRECT AND AN EARLIER DRAFT OF THIS BLOCK WAS WRONG ABOUT IT.
  -- It used a bespoke `event` key and justified it by claiming `kind` here
  -- "would make a hire look like a decision and turn that 1 into a 2". It would
  -- not: probe 12 counts `detail->>'kind' = 'discovery_proposal_decision'`, a
  -- VALUE match, so a row keyed `digital_employee_hired` cannot satisfy it.
  --
  -- Measured before changing it: `detail ? 'event'` matches 0 of 66,999
  -- audit_events rows platform-wide, while `detail ? 'kind'` matches 3,063
  -- across 104 distinct values. Shipping `event` would have made the two most
  -- consequential writes in this product the only rows in the ledger speaking a
  -- private vocabulary — invisible to every dashboard, export and probe that
  -- filters on `kind`, permanently, and split even within one code path, since
  -- apply_role_kit_to_employee already writes `kind: 'role_kit_applied'`.
  -- A static ratchet at the bottom of this file still fails if `proposal_id`
  -- ever appears in this body.
  perform public.append_audit_event(
    p_tenant_id, v_actor, v_actor_type,
    format('Digital employee hired — %s, from the %s role template. Starts designed / supervised.',
           v_name, a.name),
    'config_change',
    jsonb_build_object(
      'kind',                  'digital_employee_hired',
      'de_id',                  v_de,
      'de_name',                v_name,
      'persona_name',           nullif(btrim(coalesce(p_persona_name, '')), ''),
      'archetype_key',          a.key,
      'archetype_name',         a.name,
      'lifecycle_status',       'designed',
      'trust_level',            'supervised',
      'compliance_packs',       to_jsonb(coalesce(a.compliance_pack_keys, '{}'::text[])),
      'autonomy_dials_created', v_dials,
      -- ⚠ THE WHOLE POINT OF THE SPLIT, RECORDED. "a digital employee hired
      -- this" and "a person hired this" are different facts about a workspace's
      -- headcount, and a ledger that cannot tell them apart is a ledger nobody
      -- can audit. actor_path is the mechanism; via names the tool.
      'actor_path',             case when v_service then 'service_role' else 'signed_in_user' end,
      'via',                    coalesce(nullif(btrim(coalesce(p_via, '')), ''), 'unknown'),
      'hired_by',               auth.uid()));

  return v_de;
end;
$fn$;

-- ⚠ SERVICE ROLE ONLY, and the shape is provision_starter_de_internal's
-- (measured live: {postgres, service_role}). service_role HAS to hold EXECUTE
-- here, unlike 747's attach_compliance_pack_internal, because connector-hub
-- reaches this over PostgREST rather than from inside another SECDEF function.
-- authenticated must NOT: this is the variant with no user check, and
-- `authenticated` is the internet with a session.
revoke all on function public.instantiate_role_archetype_internal(uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.instantiate_role_archetype_internal(uuid, text, text, text, text)
  to service_role;

-- ==========================================================================
-- 2. instantiate_role_archetype — THE PRODUCT ENTRY POINT
--
--    Same name, same signature, same return type, same grant to authenticated.
--    It refuses a null identity on its own line and FIRST — not folded into the
--    role predicate as `auth.uid() is not null and ...`, which is the bug this
--    migration exists for — then checks the caller's OWN profile row against the
--    tenant they named, then delegates.
-- ==========================================================================
create or replace function public.instantiate_role_archetype(
  p_tenant_id     uuid,
  p_archetype_key text,
  p_de_name       text,
  p_persona_name  text default null
) returns uuid
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  -- The identity bar, on its own line, in words about identity. The authority
  -- bar below would also refuse this caller; this line exists so the person
  -- reads a sentence about being signed in rather than one about permissions.
  if auth.uid() is null then
    raise exception 'not authenticated: hiring a digital employee puts a worker into this workspace, and the record has to say who hired it';
  end if;

  -- ⚠ THE TENANT ID IS A PARAMETER, SO IT IS NOT AUTHORISATION (migs 662-664).
  -- It is matched against the caller's OWN profile row. There is no
  -- `p.layer = 'platform' or` disjunct — see the header; that disjunct was the
  -- arm that made the parameter authorise itself, and it cannot coexist with the
  -- audit the internal variant now writes.
  if not exists (
    select 1 from profiles p
     where p.user_id = auth.uid()
       and p.tenant_id = p_tenant_id
       and p.role in ('tenant_owner', 'tenant_admin', 'tenant_manager')
  ) then
    raise exception 'not authorized to hire a digital employee for this workspace — a hire is recorded against a member of it, so sign in as an owner, admin or manager of this workspace';
  end if;

  return public.instantiate_role_archetype_internal(
           p_tenant_id, p_archetype_key, p_de_name, p_persona_name, 'signed_in_caller');
end;
$fn$;

-- ⚠ RESTATED, NOT ASSUMED. CREATE OR REPLACE preserves the ACL on THIS database,
-- but on a fresh one it CREATES the function and a newly created function
-- carries the default PUBLIC EXECUTE grant (migs 610/630). service_role is
-- revoked deliberately: after this migration the only service-role hire path is
-- the internal variant, and leaving the grant here would be the hole renamed
-- rather than closed.
revoke all on function public.instantiate_role_archetype(uuid, text, text, text)
  from public, anon, service_role;
grant execute on function public.instantiate_role_archetype(uuid, text, text, text)
  to authenticated;

-- ==========================================================================
-- 3. install_role_kit — NO SPLIT. It has no service-role caller anywhere
--    (grepped src/ and supabase/functions/ — zero hits), so a null auth.uid()
--    is REFUSED outright rather than waved through. Probe 1 fires it.
--
--    Everything below the authority block is the LIVE BODY VERBATIM, except
--    that the return value is built into a variable so the audit can carry the
--    same numbers the caller is handed — one object, two readers, so a card and
--    the ledger cannot disagree.
-- ==========================================================================
create or replace function public.install_role_kit(p_de_id uuid, p_archetype_key text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  a role_archetypes;
  v_tenant uuid;
  v_de_name text;
  v_watchers int := 0;
  v_skipped int := 0;
  v_guardrails int := 0;
  v_pb_key text;
  v_pb_id uuid;
  v_pb_version int;
  w jsonb;
  g jsonb;
  v_kind text;
  v_snapshot_errs text[] := array[]::text[];
  v_snapshot_written boolean := false;
  v_out jsonb;
  v_actor text;
  v_actor_type text;
begin
  select tenant_id, coalesce(nullif(persona_name, ''), name)
    into v_tenant, v_de_name
    from digital_employees where id = p_de_id;
  if v_tenant is null then raise exception 'unknown DE %', p_de_id; end if;

  -- ⚠ THE FIX. This was `if auth.uid() is not null and not exists (...)`, which
  -- SKIPS the authority check for a caller with no identity instead of failing
  -- it. Two lines now: identity, then authority — and no platform disjunct, for
  -- the reason in the header (the audit below cannot name a non-member).
  if auth.uid() is null then
    raise exception 'not authenticated: a role kit installs watchers, a published procedure and guardrails on an employee, and the record has to say who did it';
  end if;
  if not exists (
      select 1 from profiles p
       where p.user_id = auth.uid()
         and p.tenant_id = v_tenant
         and p.role in ('tenant_owner', 'tenant_admin', 'tenant_manager')) then
    raise exception 'not authorized to configure this employee — its role kit is installed into this workspace and recorded against a member of it';
  end if;

  select * into a from role_archetypes where key = p_archetype_key and status = 'active';
  if a.key is null then raise exception 'unknown archetype %', p_archetype_key; end if;

  -- Watchers: derive-your-own-work. validate_watcher_config enforces each
  -- kind's config shape. A template it refuses is SKIPPED and counted (mig
  -- 552) — it must not cost the employee its SOP and guardrails too.
  if a.watcher_templates is not null then
    for w in select * from jsonb_array_elements(a.watcher_templates) loop
      if not exists (
        select 1 from work_watchers
        where de_id = p_de_id and kind = w->>'kind' and label = w->>'label') then
        begin
          insert into work_watchers (tenant_id, de_id, kind, label, description, config, active)
          values (v_tenant, p_de_id, w->>'kind', w->>'label', w->>'description', w->'config', true);
          v_watchers := v_watchers + 1;
        exception when others then
          v_skipped := v_skipped + 1;
        end;
      end if;
    end loop;
  end if;

  -- SOP playbook: attach to THIS DE + publish. name/description are
  -- coalesced (mig 552): six archetypes shipped an sop_playbook with no
  -- description key, and description is NOT NULL, so the insert threw and
  -- took the whole kit with it.
  if a.sop_playbook is not null then
    v_kind := public.playbook_definition_kind(a.sop_playbook->'steps');
    v_pb_key := p_archetype_key || '_sop';
    insert into playbook_definitions
      (tenant_id, key, name, description, version, status, steps, trigger_type, de_id)
    values
      (v_tenant, v_pb_key,
       coalesce(a.sop_playbook->>'name', a.name || ' SOP'),
       coalesce(a.sop_playbook->>'description', a.sop_playbook->>'name', a.name || ' standard operating procedure'),
       1, 'published', a.sop_playbook->'steps', 'manual', p_de_id)
    on conflict (tenant_id, key) do update
      set name = excluded.name, description = excluded.description,
          steps = excluded.steps, status = 'published',
          version = playbook_definitions.version + 1, de_id = p_de_id,
          updated_at = now()
    returning id, version into v_pb_id, v_pb_version;
    -- kind is set by the trigger from the steps — never written here.

    -- Only a PROCEDURE gets a runnable snapshot, and only if it clears the
    -- floor (mig 713). An SOP is compiled by de-work, never handed to
    -- playbook-execute, so a snapshot for it would be an object no engine
    -- owns. Both refusals are reported, never silent.
    if v_kind = 'procedure' then
      v_snapshot_errs := public.playbook_snapshot_floor_errors(a.sop_playbook->'steps');
      if coalesce(array_length(v_snapshot_errs, 1), 0) = 0 then
        insert into playbook_versions (definition_id, version, steps, published_by)
        values (v_pb_id, v_pb_version, a.sop_playbook->'steps', null)
        on conflict do nothing;
        v_snapshot_written := true;
      end if;
    end if;
  end if;

  -- Role guardrails: employee-scoped. The permanent propose-only guarantee for
  -- money/terms is the destructive-action FLOOR in decide_action_execution;
  -- these state the rules to the DE and add amount/discount/phrase gates.
  if a.guardrail_templates is not null then
    for g in select * from jsonb_array_elements(a.guardrail_templates) loop
      if not exists (
        select 1 from guardrail_rules
        where tenant_id = v_tenant and scope = 'employee' and scope_ref = p_de_id::text
          and rule_type = g->>'rule_type' and rule = g->>'rule') then
        insert into guardrail_rules
          (tenant_id, rule, rule_type, pattern, threshold, severity, active, scope, scope_ref)
        values
          (v_tenant, g->>'rule', g->>'rule_type', g->>'pattern',
           nullif(g->>'threshold','')::bigint,
           coalesce(g->>'severity','blocking'), true, 'employee', p_de_id::text);
        v_guardrails := v_guardrails + 1;
      end if;
    end loop;
  end if;

  v_out := jsonb_build_object(
    'de_id', p_de_id, 'archetype', p_archetype_key,
    'watchers_created', v_watchers, 'watchers_skipped', v_skipped,
    'guardrails_created', v_guardrails,
    'sop_playbook_id', v_pb_id,
    'sop_playbook_kind', v_kind,
    'sop_snapshot_published', v_snapshot_written,
    'sop_snapshot_skipped_because', case
      when v_snapshot_written or v_pb_id is null then null
      when v_kind = 'sop' then
        'this archetype''s SOP is compiled into work items by the employee''s own '
        || 'work engine, not run by the playbook executor — there is no runnable '
        || 'snapshot to start, and the DE has its SOP'
      else 'this archetype''s procedure does not clear the snapshot floor ('
           || array_to_string(v_snapshot_errs, ', ')
           || ') — the DE has its definition; there is no runnable version to start'
    end);

  -- ⚠ THE SAME OBJECT the caller is handed goes into the audit detail, so the
  -- screen's numbers and the ledger's numbers are one set of numbers read twice.
  -- ⚠ AND UNCONDITIONALLY. The SOP arm re-publishes at version + 1 on every
  -- call, so there is no "nothing changed" case to suppress — and a suppression
  -- rule that is almost never true is a branch nobody tests.
  -- ⚠ NO `kind` KEY AND NO `proposal_id` KEY — see the internal variant above
  -- and the ratchet at the bottom.
  if coalesce(auth.role(), '') = 'service_role' then
    v_actor := 'System'; v_actor_type := 'system';
  else
    v_actor := 'You';    v_actor_type := 'human';
  end if;

  perform public.append_audit_event(
    v_tenant, v_actor, v_actor_type,
    format('Role kit installed on %s — %s (%s watcher(s)%s, %s guardrail(s)%s).',
           v_de_name, a.name, v_watchers,
           case when v_skipped > 0 then format(', %s skipped', v_skipped) else '' end,
           v_guardrails,
           case when v_pb_id is not null then ', published SOP' else '' end),
    'config_change',
    v_out || jsonb_build_object(
      'kind',          'role_kit_installed',
      'de_name',        v_de_name,
      'archetype_name', a.name,
      'actor_path',     case when coalesce(auth.role(), '') = 'service_role'
                             then 'service_role' else 'signed_in_user' end,
      'installed_by',   auth.uid()));

  return v_out;
end;
$fn$;

-- ⚠ service_role is REVOKED: enumerated across src/ and supabase/functions/,
-- install_role_kit has no service-role caller, and the two SQL callers
-- (decide_discovery_proposal, apply_role_kit_to_employee) are SECURITY DEFINER
-- functions owned by postgres, so they reach it regardless of client grants.
revoke all on function public.install_role_kit(uuid, text) from public, anon, service_role;
grant execute on function public.install_role_kit(uuid, text) to authenticated;

-- ==========================================================================
-- 4. VERIFICATION — every pin inverted, everything rolled back
-- ==========================================================================
do $verify$
declare
  v_caller        text;
  v_seen_role     text;
  v_bad           text[] := '{}';
  v_checks        integer := 0;
  v_probes        integer := 0;

  -- fixtures
  v_tenant        uuid;
  v_admin_uid     uuid;
  v_member_tenant uuid;
  v_user_uid      uuid;
  v_other_tenant  uuid;
  v_other_admin   uuid;
  v_platform_uid  uuid;
  v_arch          text;
  v_dim           text;

  -- baselines
  v_de_before     bigint;  v_de_after     bigint;
  v_ww_before     bigint;  v_ww_after     bigint;
  v_gr_before     bigint;  v_gr_after     bigint;
  v_pb_before     bigint;  v_pb_after     bigint;
  v_aud_before    bigint;  v_aud_after    bigint;
  v_prop_before   bigint;  v_prop_after   bigint;

  -- probe 1
  v_d1            boolean := false;
  v_p1_uid        uuid;
  v_p1_de         uuid;
  v_p1_inst_ref   boolean := false;  v_p1_inst_msg text;
  v_p1_kit_ref    boolean := false;  v_p1_kit_msg  text;
  v_p1_created    bigint;

  -- probe 2
  v_d2            boolean := false;
  v_p2_de         uuid;
  v_p2_ok         boolean := false;  v_p2_msg      text;
  v_p2_life       text;              v_p2_trust    text;
  v_p2_arch       text;              v_p2_assist   boolean;
  v_p2_detail     jsonb;
  v_p2_actor_type text;
  v_p2_authed_ok  boolean := false;  v_p2_authed_msg text;

  -- probe 3
  v_d3            boolean := false;
  v_p3_de         uuid;
  v_p3_ok         boolean := false;  v_p3_msg      text;
  v_p3_kit        jsonb;             v_p3_kit_msg  text;
  v_p3_kit_ok     boolean := false;
  v_p3_sys        integer;
  v_p3_hire_det   jsonb;
  v_p3_kit_det    jsonb;
  v_p3_ww         bigint;
  v_p3_gr         bigint;

  -- probe 4
  v_d4            boolean := false;
  v_p4_de         uuid;
  v_p4_inst_ref   boolean := false;  v_p4_inst_msg text;
  v_p4_kit_ref    boolean := false;  v_p4_kit_msg  text;

  -- probe 5
  v_d5            boolean := false;
  v_p5_de         uuid;
  v_p5_inst_ref   boolean := false;  v_p5_inst_msg text;
  v_p5_kit_ref    boolean := false;  v_p5_kit_msg  text;

  -- probe 6
  v_d6            boolean := false;
  v_p6_de         uuid;
  v_p6_inst_ref   boolean := false;  v_p6_inst_msg text;
  v_p6_kit_ref    boolean := false;  v_p6_kit_msg  text;
  v_p6_left       bigint;

  -- probe 7
  v_d7            boolean := false;
  v_p7_de         uuid;
  v_p7_res        jsonb;             v_p7_msg      text;
  v_p7_ok         boolean := false;
  v_p7_kit_aud    bigint;
  v_p7_apply_aud  bigint;

  -- probe 8
  v_d8            boolean := false;
  v_p8_sess       uuid;
  v_p8_prop       uuid;
  v_p8_res        jsonb;             v_p8_msg      text;
  v_p8_decision_n bigint;
  v_p8_tagged_n   bigint;
  v_p8_hire_n     bigint;
  v_p8_kit_n      bigint;
  v_p8_obj        uuid;

  -- static
  v_int_body      text;
  v_wrap_body     text;
  v_kit_body      text;
begin
  v_caller := current_user::text;

  ------------------------------------------------------------------------
  -- CAN THIS BLOCK IMPERSONATE AT ALL? Asked by DOING it. Every refusal below
  -- is a claim about what the RUNTIME role can do; without the switch they
  -- would run as this migration's own role, which holds EXECUTE on everything,
  -- and every "refused" would be a statement about postgres.
  ------------------------------------------------------------------------
  begin
    set local role authenticated;
    v_seen_role := current_user::text;
    execute format('set local role %I', v_caller);
  exception when others then
    raise exception '748: cannot switch to role authenticated and back to % (%: %) — the probes below would not be testing the runtime role they claim to test, so this migration refuses to apply rather than report a clean run it did not measure',
      v_caller, sqlstate, sqlerrm;
  end;
  if v_seen_role is distinct from 'authenticated' then
    raise exception '748: the role switch reported current_user=% rather than authenticated', coalesce(v_seen_role, 'NULL');
  end if;

  ------------------------------------------------------------------------
  -- FIXTURES — from live data, never hardcoded, every one guarded for
  -- vacuity. A missing fixture is a FAILURE here, not a quiet pass.
  ------------------------------------------------------------------------
  -- The workspace the acting probes hire into. Owner/admin, active, no platform
  -- profile (a platform profile would pass every bar and make probes 5 and 6
  -- meaningless).
  select p.tenant_id, p.user_id
    into v_tenant, v_admin_uid
    from public.profiles p
    join public.tenants t on t.id = p.tenant_id
   where p.layer = 'tenant'
     and p.role in ('tenant_owner', 'tenant_admin')
     and coalesce(p.is_active, true)
     and t.status in ('active', 'trial')
     and not exists (select 1 from public.profiles q
                      where q.user_id = p.user_id and q.layer = 'platform')
   order by p.created_at
   limit 1;

  -- ⚠ PROBE 4'S PAIR, AND IT MUST BE THEIR OWN WORKSPACE. A member who is
  -- NEITHER owner, admin NOR manager — the manager exclusion matters, because
  -- the predicate under test admits managers, so a manager here would make the
  -- probe assert a refusal that should not happen. Pointed at a workspace they
  -- are not in, this would collapse into probe 5 (cross-tenancy) and the role
  -- bar itself would never be tested.
  select u.tenant_id, u.user_id
    into v_member_tenant, v_user_uid
    from public.profiles u
    join public.tenants t on t.id = u.tenant_id
   where u.layer = 'tenant'
     and u.role not in ('tenant_owner', 'tenant_admin', 'tenant_manager')
     and coalesce(u.is_active, true)
     and t.status in ('active', 'trial')
     and not exists (select 1 from public.profiles q
                      where q.user_id = u.user_id and q.layer = 'platform')
   order by u.created_at
   limit 1;

  -- An owner/admin of a DIFFERENT workspace, with no profile in v_tenant.
  select p.tenant_id, p.user_id
    into v_other_tenant, v_other_admin
    from public.profiles p
    join public.tenants t on t.id = p.tenant_id
   where p.layer = 'tenant'
     and p.role in ('tenant_owner', 'tenant_admin')
     and coalesce(p.is_active, true)
     and t.status in ('active', 'trial')
     and p.tenant_id is distinct from v_tenant
     and not exists (select 1 from public.profiles q
                      where q.user_id = p.user_id and q.layer = 'platform')
     and not exists (select 1 from public.profiles q
                      where q.user_id = p.user_id and q.tenant_id = v_tenant)
   order by p.created_at
   limit 1;

  select p.user_id into v_platform_uid
    from public.profiles p
   where p.layer = 'platform'
     and coalesce(p.is_active, true)
   order by p.created_at
   limit 1;

  -- ⚠ THE ARCHETYPE, chosen for four properties each of which an assertion
  -- below depends on — the same conjuncts verify_decide_discovery_proposal
  -- picks its own fixture on, so probe 8 exercises the certify path rather than
  -- a lookalike:
  --   · status='active'                — both writers refuse anything else;
  --   · NO compliance_pack_keys        — so nothing here materialises a real
  --     workspace's blocking guardrails as a side effect of a health check;
  --   · watchers AND guardrails        — so probe 3's "the kit installed
  --     something" is a real inversion rather than a legitimate zero;
  --   · and all three kinds of template have DEMONSTRABLY INSTALLED somewhere
  --     on this platform already (a playbook_definitions row keyed
  --     `<archetype>_sop`, a work_watchers row matching a watcher template, a
  --     guardrail_rules row matching a guardrail template). install_role_kit
  --     SWALLOWS a watcher its validator refuses into `watchers_skipped` and
  --     RAISES on a guardrail rule_type the CHECK refuses, so an archetype
  --     whose templates have never actually installed would make probe 3 report
  --     "the kit installed nothing" for a reason that has nothing to do with the
  --     code under test. Grounding the choice in evidence is cheaper than
  --     diagnosing that later — and these conjuncts are NOT vacuous: measured
  --     2026-08-16, they exclude 2 of the 5 otherwise-eligible archetypes
  --     (front_desk and it_helpdesk have no installed watcher anywhere).
  select a.key into v_arch
    from public.role_archetypes a
   where a.status = 'active'
     and coalesce(array_length(a.compliance_pack_keys, 1), 0) = 0
     and a.watcher_templates is not null
     and jsonb_typeof(a.watcher_templates) = 'array'
     and jsonb_array_length(a.watcher_templates) > 0
     and a.guardrail_templates is not null
     and jsonb_typeof(a.guardrail_templates) = 'array'
     and jsonb_array_length(a.guardrail_templates) > 0
     and exists (select 1 from public.playbook_definitions pd
                  where pd.key = a.key || '_sop')
     and exists (select 1 from jsonb_array_elements(a.watcher_templates) t
                   join public.work_watchers w
                     on w.kind = t ->> 'kind' and w.label = t ->> 'label')
     and exists (select 1 from jsonb_array_elements(a.guardrail_templates) t
                   join public.guardrail_rules g
                     on g.scope = 'employee'
                    and g.rule_type = t ->> 'rule_type'
                    and g.rule = t ->> 'rule')
   order by a.key
   limit 1;

  select key into v_dim from public.discovery_dimensions where active order by key limit 1;

  if v_tenant is null or v_admin_uid is null or v_member_tenant is null
     or v_user_uid is null or v_other_admin is null or v_platform_uid is null
     or v_arch is null or v_dim is null then
    raise exception '748: VACUITY — fixtures could not be assembled (acting tenant=% owner=% member tenant=% non-admin member=% foreign owner=% platform profile=% archetype=% dimension=%). A missing fixture is not a pass: probe 4 could not tell "refused for the role" from "refused for no identity", probe 5 could not fire the cross-tenant refusal, probe 6 could not fire the platform refusal this migration deliberately introduces, and probe 8 could not drive the discovery accept that certify runs on every run.',
      coalesce(v_tenant::text, 'NULL'), coalesce(v_admin_uid::text, 'NULL'),
      coalesce(v_member_tenant::text, 'NULL'), coalesce(v_user_uid::text, 'NULL'),
      coalesce(v_other_admin::text, 'NULL'), coalesce(v_platform_uid::text, 'NULL'),
      coalesce(v_arch, 'NULL'), coalesce(v_dim, 'NULL');
  end if;

  -- Baselines SCOPED to the probe workspaces. A global count re-read at the end
  -- of the same READ COMMITTED transaction would go red because an unrelated
  -- workspace committed a row while this ran.
  -- ⚠ ALWAYS EXCLUDING is_workforce_assistant rows — the standing instruction
  -- puts them out of bounds, and it is also the correct denominator: a hire
  -- never makes one.
  select count(*) into v_de_before   from public.digital_employees
   where tenant_id in (v_tenant, v_other_tenant, v_member_tenant)
     and coalesce(is_workforce_assistant, false) = false;
  select count(*) into v_ww_before   from public.work_watchers
   where tenant_id in (v_tenant, v_other_tenant, v_member_tenant);
  select count(*) into v_gr_before   from public.guardrail_rules
   where tenant_id in (v_tenant, v_other_tenant, v_member_tenant);
  select count(*) into v_pb_before   from public.playbook_definitions
   where tenant_id in (v_tenant, v_other_tenant, v_member_tenant);
  select count(*) into v_aud_before  from public.audit_events
   where tenant_id in (v_tenant, v_other_tenant, v_member_tenant)
     and detail ->> 'kind' in ('digital_employee_hired', 'role_kit_installed');
  select count(*) into v_prop_before from public.discovery_proposals
   where tenant_id in (v_tenant, v_other_tenant, v_member_tenant);

  ------------------------------------------------------------------------
  -- PROBE 1 — NO IDENTITY AT ALL. THIS IS THE WHOLE FIX, FIRED.
  --
  -- ⚠ BOTH JWT GUCs cleared: auth.uid() falls back from request.jwt.claim.sub
  -- to request.jwt.claims->>'sub', so clearing one leaves a fallback. auth.uid()
  -- is then ASSERTED null, because a refusal for the wrong reason is no
  -- evidence.
  --
  -- ⚠ THE KIT TARGET IS INSERTED DIRECTLY, not hired through the function under
  -- test. install_role_kit reads the DE row and raises 'unknown DE' BEFORE its
  -- authority check, so passing a non-existent id would produce a refusal that
  -- has nothing to do with identity — the classic wrong-reason pass.
  --
  -- RED BEFORE THIS MIGRATION: with `auth.uid() is not null and` in front of
  -- both checks, BOTH calls SUCCEEDED here — an anonymous caller could hire into
  -- any workspace it could name and stamp a kit onto any employee.
  ------------------------------------------------------------------------
  begin
    insert into public.digital_employees (tenant_id, name, lifecycle_status, trust_level, status, category)
    values (v_tenant, '748 probe employee (kit target)', 'designed', 'supervised', 'idle', 'Customer')
    returning id into v_p1_de;

    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims',    '', true);
    select auth.uid() into v_p1_uid;

    set local role authenticated;
    begin
      perform public.instantiate_role_archetype(v_tenant, v_arch, '748 probe anonymous hire', null);
    exception when others then
      v_p1_inst_ref := true; v_p1_inst_msg := sqlerrm;
    end;
    begin
      perform public.install_role_kit(v_p1_de, v_arch);
    exception when others then
      v_p1_kit_ref := true; v_p1_kit_msg := sqlerrm;
    end;
    execute format('set local role %I', v_caller);

    select count(*) into v_p1_created from public.digital_employees
     where tenant_id = v_tenant and name = '748 probe anonymous hire';

    v_d1 := true;
    raise exception using errcode = 'P0001', message = '__undo__';
  exception when others then
    execute format('set local role %I', v_caller);
    if sqlerrm <> '__undo__' then
      v_bad := array_append(v_bad, format('PROBE 1 ABORTED (%s: %s) — the null-identity refusal, which is the entire reason this migration exists, was NOT compared this run', sqlstate, sqlerrm));
      v_d1 := false;
    end if;
  end;

  if v_d1 then
    v_probes := v_probes + 1;
    v_checks := v_checks + 1;
    if v_p1_uid is not null then
      v_bad := array_append(v_bad, format('the probe could not clear the identity (auth.uid()=%L) — every refusal below would be a claim about some other bar', v_p1_uid::text));
    end if;
    v_checks := v_checks + 1;
    if not v_p1_inst_ref then
      v_bad := array_append(v_bad, 'A CALLER WITH NO IDENTITY HIRED A DIGITAL EMPLOYEE — the `auth.uid() is not null and` prefix is back in instantiate_role_archetype and the authority check is skipped rather than failed');
    elsif coalesce(v_p1_inst_msg, '') not like 'not authenticated%' then
      v_bad := array_append(v_bad, format('instantiate_role_archetype refused the unidentified caller, but not by the identity bar: %L', coalesce(v_p1_inst_msg, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if not v_p1_kit_ref then
      v_bad := array_append(v_bad, 'A CALLER WITH NO IDENTITY INSTALLED A ROLE KIT — install_role_kit still skips its authority check when auth.uid() is null, so watchers, a published procedure and guardrails can be stamped onto any employee by nobody at all');
    elsif coalesce(v_p1_kit_msg, '') not like 'not authenticated%' then
      v_bad := array_append(v_bad, format('install_role_kit refused the unidentified caller, but not by the identity bar: %L', coalesce(v_p1_kit_msg, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p1_created, -1) <> 0 then
      v_bad := array_append(v_bad, format('the refused anonymous hire still left %s employee row(s) behind', coalesce(v_p1_created::text, 'NULL')));
    end if;
  end if;

  ------------------------------------------------------------------------
  -- PROBE 2 — THE INTERNAL VARIANT STILL WORKS WITH NO auth.uid().
  --
  -- Without this, "an identity-less caller is refused" would be
  -- indistinguishable from "the DE hire tool is dead", which is the worse of
  -- the two bugs. connector-hub's dt_hire_from_archetype runs exactly this
  -- shape: service-role client, tenant from its own connector context, no user.
  --
  -- ⚠ AND THE INVERSION IS IN THE SAME BLOCK: the SAME function called as
  -- `authenticated` must be refused by the grant, or "service_role works" would
  -- just mean "everyone works" and the split would be decoration.
  ------------------------------------------------------------------------
  begin
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
    set local role service_role;
    begin
      v_p2_de := public.instantiate_role_archetype_internal(
                   v_tenant, v_arch, '748 probe service hire', null, 'dt_hire_from_archetype');
      v_p2_ok := v_p2_de is not null;
    exception when others then
      v_p2_ok := false; v_p2_msg := sqlerrm;
    end;
    execute format('set local role %I', v_caller);

    if v_p2_de is not null then
      select d.lifecycle_status, d.trust_level, d.archetype_key,
             coalesce(d.is_workforce_assistant, false)
        into v_p2_life, v_p2_trust, v_p2_arch, v_p2_assist
        from public.digital_employees d where d.id = v_p2_de;
      select a.detail, a.actor_type into v_p2_detail, v_p2_actor_type
        from public.audit_events a
       where a.tenant_id = v_tenant
         and a.detail ->> 'kind' = 'digital_employee_hired'
         and a.detail ->> 'de_id' = v_p2_de::text
       order by a.created_at desc, a.id desc limit 1;
    end if;

    -- the inversion: the same function, as the runtime role the browser holds
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    begin
      perform public.instantiate_role_archetype_internal(
                v_tenant, v_arch, '748 probe authed internal hire', null, 'probe');
      v_p2_authed_ok := true;
    exception when others then
      v_p2_authed_ok := false; v_p2_authed_msg := sqlerrm;
    end;
    execute format('set local role %I', v_caller);

    v_d2 := true;
    raise exception using errcode = 'P0001', message = '__undo__';
  exception when others then
    execute format('set local role %I', v_caller);
    if sqlerrm <> '__undo__' then
      v_bad := array_append(v_bad, format('PROBE 2 ABORTED (%s: %s) — whether the DE hire tool still works after the split was NOT compared this run', sqlstate, sqlerrm));
      v_d2 := false;
    end if;
  end;

  if v_d2 then
    v_probes := v_probes + 1;
    v_checks := v_checks + 1;
    if not v_p2_ok then
      v_bad := array_append(v_bad, format('THE SERVICE-ROLE HIRE IS BROKEN: instantiate_role_archetype_internal(%L) refused under service_role — %L. connector-hub dt_hire_from_archetype (index.ts:3346) is repointed at exactly this call, and a hire tool that silently stops working is worse than the hole this migration closes.', v_arch, coalesce(v_p2_msg, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p2_life is distinct from 'designed' or v_p2_trust is distinct from 'supervised' then
      v_bad := array_append(v_bad, format('the service-role hire landed at lifecycle=%L trust=%L, expected designed/supervised — anything else puts a working employee straight into a customer workspace', coalesce(v_p2_life, 'NULL'), coalesce(v_p2_trust, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p2_arch is distinct from v_arch then
      v_bad := array_append(v_bad, format('the service-role hire carries archetype_key=%L, expected %L', coalesce(v_p2_arch, 'NULL'), v_arch));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p2_assist, true) then
      v_bad := array_append(v_bad, 'the internal hire produced a row carrying is_workforce_assistant = true — a hire must never mint the workspace''s own admin desk');
    end if;
    -- THE AUDIT, AND THE PART THAT MAKES IT WORTH WRITING
    v_checks := v_checks + 1;
    if v_p2_detail is null then
      v_bad := array_append(v_bad, 'the service-role hire left NO audit row — creating an employee is the most consequential write in this product and it would still have no identity anywhere, which is half of what this migration is for');
    else
      v_checks := v_checks + 1;
      if v_p2_detail ->> 'actor_path' is distinct from 'service_role' then
        v_bad := array_append(v_bad, format('the service-role hire recorded actor_path=%L — "a digital employee hired this" and "a person hired this" are different facts about a workspace''s headcount, and a ledger that cannot tell them apart is one nobody can audit', coalesce(v_p2_detail ->> 'actor_path', 'NULL')));
      end if;
      v_checks := v_checks + 1;
      if v_p2_detail ->> 'via' is distinct from 'dt_hire_from_archetype' then
        v_bad := array_append(v_bad, format('the service-role hire recorded via=%L, expected the tool name it was called with — without it, every automated hire looks the same', coalesce(v_p2_detail ->> 'via', 'NULL')));
      end if;
      v_checks := v_checks + 1;
      if v_p2_actor_type is distinct from 'system' then
        v_bad := array_append(v_bad, format('the service-role hire was filed with actor_type=%L, expected system. append_audit_event only overwrites the actor for a JWT caller; under service_role it writes what it is handed, so a hardcoded human actor would file an automated hire as a person''s decision.', coalesce(v_p2_actor_type, 'NULL')));
      end if;
      -- ⚠ `->> ... is not null` rather than the jsonb `?` operator, deliberately.
      -- `?` is a parameter placeholder to several client drivers and this file
      -- has to survive being replayed through whichever one a future rebuild
      -- uses; the two are equivalent here because nothing writes a null-valued
      -- `proposal_id`.
      v_checks := v_checks + 1;
      -- ⚠ ONLY proposal_id. An earlier draft banned `kind` too, on a claim that
      -- turned out to be false: probe 12 counts
      -- `detail->>'kind' = 'discovery_proposal_decision'`, a VALUE match, so a
      -- row keyed 'digital_employee_hired' cannot satisfy it. `kind` is the
      -- ledger's own vocabulary — 3,063 live rows across 104 values, against 0
      -- using anything else — and banning it here is what would have made a
      -- hire invisible to every reader that filters on it.
      if (v_p2_detail ->> 'proposal_id') is not null then
        v_bad := array_append(v_bad, 'the hire audit detail carries a `proposal_id` key — verify_decide_discovery_proposal reads a decision back with `detail->>''proposal_id''` UNQUALIFIED by kind, so a hire carrying it is picked up as a second decision row and the certify behaviour section goes red for every tenant');
      end if;
    end if;
    v_checks := v_checks + 1;
    if v_p2_authed_ok then
      v_bad := array_append(v_bad, 'ROLE `authenticated` EXECUTED instantiate_role_archetype_internal — the variant with NO user check is reachable from the browser, so the split moved the hole rather than closing it');
    end if;
  end if;

  ------------------------------------------------------------------------
  -- PROBE 3 — THE LIVE BROWSER SEQUENCE, hireApi.ts:113/123/133, driven end to
  -- end by a real owner. Without this, every refusal above would be consistent
  -- with "both functions now refuse everything".
  --
  -- ⚠ STEP 3 (install_role_systems) IS EXERCISED BUT NOT ASSERTED, deliberately
  -- and said out loud rather than left as a silent gap: it is untouched by this
  -- migration, its refusal is additive by design on every one of its callers,
  -- and asserting a count here would make this probe red for a reason outside
  -- the change. What running it proves is only that the three-step journey
  -- completes without an exception escaping — which is what hireApi does.
  ------------------------------------------------------------------------
  begin
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    begin
      v_p3_de := public.instantiate_role_archetype(v_tenant, v_arch, '748 probe owner hire', 'Probe');
      v_p3_ok := v_p3_de is not null;
    exception when others then
      v_p3_ok := false; v_p3_msg := sqlerrm;
    end;
    if v_p3_de is not null then
      begin
        v_p3_kit := public.install_role_kit(v_p3_de, v_arch);
        v_p3_kit_ok := true;
      exception when others then
        v_p3_kit_ok := false; v_p3_kit_msg := sqlerrm;
      end;
      begin
        v_p3_sys := coalesce(public.install_role_systems(v_p3_de, v_arch), 0);
      exception when others then
        v_p3_sys := 0;
      end;
    end if;
    execute format('set local role %I', v_caller);

    if v_p3_de is not null then
      select count(*) into v_p3_ww from public.work_watchers where de_id = v_p3_de;
      select count(*) into v_p3_gr from public.guardrail_rules
       where tenant_id = v_tenant and scope = 'employee' and scope_ref = v_p3_de::text;
      select a.detail into v_p3_hire_det from public.audit_events a
       where a.tenant_id = v_tenant and a.detail ->> 'kind' = 'digital_employee_hired'
         and a.detail ->> 'de_id' = v_p3_de::text
       order by a.created_at desc, a.id desc limit 1;
      select a.detail into v_p3_kit_det from public.audit_events a
       where a.tenant_id = v_tenant and a.detail ->> 'kind' = 'role_kit_installed'
         and a.detail ->> 'de_id' = v_p3_de::text
       order by a.created_at desc, a.id desc limit 1;
    end if;

    v_d3 := true;
    raise exception using errcode = 'P0001', message = '__undo__';
  exception when others then
    execute format('set local role %I', v_caller);
    if sqlerrm <> '__undo__' then
      v_bad := array_append(v_bad, format('PROBE 3 ABORTED (%s: %s) — THE INVERSION. Whether an owner can still hire at all was NOT compared this run, so every refusal above is consistent with a pair of functions that refuse everything', sqlstate, sqlerrm));
      v_d3 := false;
    end if;
  end;

  if v_d3 then
    v_probes := v_probes + 1;
    v_checks := v_checks + 1;
    if not v_p3_ok then
      v_bad := array_append(v_bad, format('THE INVERSION FAILED: the workspace''s OWN owner could not hire %L — %L. Hiring is what this whole surface exists to do; if it refuses then every "still refused" assertion above is a statement about a function that refuses everything.', v_arch, coalesce(v_p3_msg, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if not v_p3_kit_ok then
      v_bad := array_append(v_bad, format('the owner hired but could NOT install the role kit — %L. hireApi.ts runs these as steps 1 and 2 of one journey, in separate transactions, so a kit that refuses after a hire that succeeded strands a half-made employee in a customer workspace.', coalesce(v_p3_kit_msg, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p3_ww, 0) = 0 or coalesce(v_p3_gr, 0) = 0 then
      v_bad := array_append(v_bad, format('the kit installed %s watcher(s) and %s employee-scoped guardrail(s) for an archetype the fixture chose for having BOTH — a kit that returns success having installed nothing is the silent zero this repo keeps paying for', coalesce(v_p3_ww::text, 'NULL'), coalesce(v_p3_gr::text, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p3_hire_det is null then
      v_bad := array_append(v_bad, 'the owner''s hire left NO audit row — before this migration a hired employee had no identity anywhere, and that is the half of the defect a fail-open guard does not cover');
    else
      v_checks := v_checks + 1;
      if (v_p3_hire_det ->> 'hired_by') is distinct from v_admin_uid::text
         or (v_p3_hire_det ->> 'actor_path') is distinct from 'signed_in_user' then
        v_bad := array_append(v_bad, format('the owner''s hire recorded hired_by=%L actor_path=%L, expected %L / signed_in_user', coalesce(v_p3_hire_det ->> 'hired_by', 'NULL'), coalesce(v_p3_hire_det ->> 'actor_path', 'NULL'), v_admin_uid::text));
      end if;
      v_checks := v_checks + 1;
      if (v_p3_hire_det ->> 'archetype_key') is distinct from v_arch then
        v_bad := array_append(v_bad, format('the hire audit names archetype %L, the employee was hired from %L', coalesce(v_p3_hire_det ->> 'archetype_key', 'NULL'), v_arch));
      end if;
    end if;
    v_checks := v_checks + 1;
    if v_p3_kit_det is null then
      v_bad := array_append(v_bad, 'the role kit install left NO audit row — watchers, a published procedure and guardrails appeared in a workspace with nothing recording who put them there');
    else
      -- THE TWO ACCOUNTS ARE ONE ACCOUNT. The audit detail is built from the
      -- same jsonb the caller is handed, so this can only fail if a later edit
      -- rebuilds one of them separately.
      v_checks := v_checks + 1;
      if (v_p3_kit_det ->> 'watchers_created') is distinct from (v_p3_kit ->> 'watchers_created')
         or (v_p3_kit_det ->> 'guardrails_created') is distinct from (v_p3_kit ->> 'guardrails_created')
         or (v_p3_kit_det ->> 'watchers_skipped') is distinct from (v_p3_kit ->> 'watchers_skipped') then
        v_bad := array_append(v_bad, format('the caller was handed watchers=%L guardrails=%L skipped=%L and the ledger records watchers=%L guardrails=%L skipped=%L — a customer cannot check a card against a ledger that disagrees with it',
          coalesce(v_p3_kit ->> 'watchers_created', 'NULL'), coalesce(v_p3_kit ->> 'guardrails_created', 'NULL'), coalesce(v_p3_kit ->> 'watchers_skipped', 'NULL'),
          coalesce(v_p3_kit_det ->> 'watchers_created', 'NULL'), coalesce(v_p3_kit_det ->> 'guardrails_created', 'NULL'), coalesce(v_p3_kit_det ->> 'watchers_skipped', 'NULL')));
      end if;
      v_checks := v_checks + 1;
      if (v_p3_kit_det ->> 'proposal_id') is not null then
        v_bad := array_append(v_bad, 'the role-kit audit detail carries a `proposal_id` key — see probe 2: it would be read back as a second decision row by verify_decide_discovery_proposal');
      end if;
    end if;
  end if;

  ------------------------------------------------------------------------
  -- PROBE 4 — A MEMBER WHO IS NEITHER OWNER, ADMIN NOR MANAGER, IN THEIR OWN
  -- WORKSPACE. A real identity, so a refusal here is about AUTHORITY rather
  -- than identity — which is what makes probe 1 mean something.
  --
  -- ⚠ AND THE MESSAGE IS READ, not just the fact of an exception. Accepting any
  -- exception would let the identity bar, a 42501, or an unrelated 23502 stand
  -- in for the role refusal this probe exists to see.
  ------------------------------------------------------------------------
  begin
    insert into public.digital_employees (tenant_id, name, lifecycle_status, trust_level, status, category)
    values (v_member_tenant, '748 probe employee (member kit target)', 'designed', 'supervised', 'idle', 'Customer')
    returning id into v_p4_de;

    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', v_user_uid::text, true);
    set local role authenticated;
    begin
      perform public.instantiate_role_archetype(v_member_tenant, v_arch, '748 probe member hire', null);
    exception when others then
      v_p4_inst_ref := true; v_p4_inst_msg := sqlerrm;
    end;
    begin
      perform public.install_role_kit(v_p4_de, v_arch);
    exception when others then
      v_p4_kit_ref := true; v_p4_kit_msg := sqlerrm;
    end;
    execute format('set local role %I', v_caller);

    v_d4 := true;
    raise exception using errcode = 'P0001', message = '__undo__';
  exception when others then
    execute format('set local role %I', v_caller);
    if sqlerrm <> '__undo__' then
      v_bad := array_append(v_bad, format('PROBE 4 ABORTED (%s: %s) — the role bar was NOT compared this run', sqlstate, sqlerrm));
      v_d4 := false;
    end if;
  end;

  if v_d4 then
    v_probes := v_probes + 1;
    v_checks := v_checks + 1;
    if not v_p4_inst_ref then
      v_bad := array_append(v_bad, format('a member of workspace %s who is NEITHER owner, admin NOR manager HIRED AN EMPLOYEE into it — the role bar admits those three and nobody else', v_member_tenant));
    elsif coalesce(v_p4_inst_msg, '') not like 'not authorized to hire%' then
      v_bad := array_append(v_bad, format('the non-admin member''s hire was refused, but NOT by the role bar: %L', coalesce(v_p4_inst_msg, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if not v_p4_kit_ref then
      v_bad := array_append(v_bad, 'a non-admin member installed a role kit on an employee in their own workspace — guardrails and a published procedure can be stamped on by somebody with no authority to configure anything');
    elsif coalesce(v_p4_kit_msg, '') not like 'not authorized to configure%' then
      v_bad := array_append(v_bad, format('the non-admin member''s kit install was refused, but NOT by the role bar: %L', coalesce(v_p4_kit_msg, 'NULL')));
    end if;
  end if;

  ------------------------------------------------------------------------
  -- PROBE 5 — AN OWNER OF ANOTHER WORKSPACE. The tenant id is a PARAMETER on
  -- instantiate_role_archetype, so this is the 662-664 shape fired directly: a
  -- real, fully-privileged identity naming somebody else's workspace.
  ------------------------------------------------------------------------
  begin
    insert into public.digital_employees (tenant_id, name, lifecycle_status, trust_level, status, category)
    values (v_tenant, '748 probe employee (cross-tenant kit target)', 'designed', 'supervised', 'idle', 'Customer')
    returning id into v_p5_de;

    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', v_other_admin::text, true);
    set local role authenticated;
    begin
      perform public.instantiate_role_archetype(v_tenant, v_arch, '748 probe cross-tenant hire', null);
    exception when others then
      v_p5_inst_ref := true; v_p5_inst_msg := sqlerrm;
    end;
    begin
      perform public.install_role_kit(v_p5_de, v_arch);
    exception when others then
      v_p5_kit_ref := true; v_p5_kit_msg := sqlerrm;
    end;
    execute format('set local role %I', v_caller);

    v_d5 := true;
    raise exception using errcode = 'P0001', message = '__undo__';
  exception when others then
    execute format('set local role %I', v_caller);
    if sqlerrm <> '__undo__' then
      v_bad := array_append(v_bad, format('PROBE 5 ABORTED (%s: %s) — the cross-tenant refusal was NOT compared this run', sqlstate, sqlerrm));
      v_d5 := false;
    end if;
  end;

  if v_d5 then
    v_probes := v_probes + 1;
    v_checks := v_checks + 1;
    if not v_p5_inst_ref then
      v_bad := array_append(v_bad, format('an owner of workspace %s HIRED AN EMPLOYEE INTO WORKSPACE %s — the tenant id is a parameter and nothing checked it against the caller''s own profile row, which is exactly what migrations 662-664 exist to prevent', v_other_tenant, v_tenant));
    elsif coalesce(v_p5_inst_msg, '') not like 'not authorized to hire%' then
      v_bad := array_append(v_bad, format('the cross-tenant hire was refused, but NOT by the authority bar: %L', coalesce(v_p5_inst_msg, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if not v_p5_kit_ref then
      v_bad := array_append(v_bad, format('an owner of workspace %s installed a role kit onto an employee of workspace %s', v_other_tenant, v_tenant));
    elsif coalesce(v_p5_kit_msg, '') not like 'not authorized to configure%' then
      v_bad := array_append(v_bad, format('the cross-tenant kit install was refused, but NOT by the authority bar: %L', coalesce(v_p5_kit_msg, 'NULL')));
    end if;
  end if;

  ------------------------------------------------------------------------
  -- PROBE 6 — THE PLATFORM OPERATOR, AND THIS IS THE DELIBERATE BEHAVIOUR
  -- CHANGE, FIRED RATHER THAN ASSERTED IN A COMMENT.
  --
  -- Migration 747 refused a platform operator only for the 7 pack-carrying
  -- archetypes and preserved god-mode hiring for the other 8. Once BOTH writers
  -- audit, that is no longer available: append_audit_event refuses a caller with
  -- no profiles row for this workspace, both platform profiles carry tenant_id
  -- NULL, and profiles is UNIQUE (user_id) — so admitting them means inserting
  -- the employee and then aborting on the audit. This probe fires the refusal
  -- against a PACK-FREE archetype, which is precisely the case 747 kept working,
  -- so nobody can later read this migration and think the change was narrower
  -- than it is.
  ------------------------------------------------------------------------
  begin
    insert into public.digital_employees (tenant_id, name, lifecycle_status, trust_level, status, category)
    values (v_tenant, '748 probe employee (platform kit target)', 'designed', 'supervised', 'idle', 'Customer')
    returning id into v_p6_de;

    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', v_platform_uid::text, true);
    set local role authenticated;
    begin
      perform public.instantiate_role_archetype(v_tenant, v_arch, '748 probe platform hire', null);
    exception when others then
      v_p6_inst_ref := true; v_p6_inst_msg := sqlerrm;
    end;
    begin
      perform public.install_role_kit(v_p6_de, v_arch);
    exception when others then
      v_p6_kit_ref := true; v_p6_kit_msg := sqlerrm;
    end;
    execute format('set local role %I', v_caller);

    select count(*) into v_p6_left from public.digital_employees
     where tenant_id = v_tenant and name = '748 probe platform hire';

    v_d6 := true;
    raise exception using errcode = 'P0001', message = '__undo__';
  exception when others then
    execute format('set local role %I', v_caller);
    if sqlerrm <> '__undo__' then
      v_bad := array_append(v_bad, format('PROBE 6 ABORTED (%s: %s) — the platform refusal this migration deliberately introduces was NOT compared this run, so nobody can tell from this apply whether god-mode hiring stops at the door or half-way through', sqlstate, sqlerrm));
      v_d6 := false;
    end if;
  end;

  if v_d6 then
    v_probes := v_probes + 1;
    v_checks := v_checks + 1;
    if not v_p6_inst_ref then
      v_bad := array_append(v_bad, 'a PLATFORM-layer profile hired a PACK-FREE archetype and nothing objected — the `p.layer = ''platform'' or` disjunct is back, which means the tenant-id parameter authorises itself again AND the hire will abort inside append_audit_event after the employee row exists');
    elsif coalesce(v_p6_inst_msg, '') not like 'not authorized to hire%' then
      v_bad := array_append(v_bad, format('the platform hire failed, but NOT at the authority bar: %L. That is the half-way abort this migration exists to replace — the employee row is written before append_audit_event raises.', coalesce(v_p6_inst_msg, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p6_left, -1) <> 0 then
      v_bad := array_append(v_bad, format('the refused platform hire left %s employee row(s) behind — the refusal is not before the digital_employees insert', coalesce(v_p6_left::text, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if not v_p6_kit_ref then
      v_bad := array_append(v_bad, 'a PLATFORM-layer profile installed a role kit — install_role_kit''s audit would then abort after the watchers, the SOP and the guardrails were already written, in a function whose callers run it in its own transaction');
    elsif coalesce(v_p6_kit_msg, '') not like 'not authorized to configure%' then
      v_bad := array_append(v_bad, format('the platform kit install failed, but NOT at the authority bar: %L', coalesce(v_p6_kit_msg, 'NULL')));
    end if;
  end if;

  ------------------------------------------------------------------------
  -- PROBE 7 — apply_role_kit_to_employee, THE THIRD LIVE PATH.
  --
  -- It is UNTOUCHED by this migration, and that is exactly why it is driven: it
  -- calls install_role_kit, so a new bar inside install_role_kit could break it
  -- silently. src/lib/hireApi.ts:468 is its browser caller.
  ------------------------------------------------------------------------
  begin
    insert into public.digital_employees (tenant_id, name, lifecycle_status, trust_level, status, category)
    values (v_tenant, '748 probe employee (apply target)', 'designed', 'supervised', 'idle', 'Customer')
    returning id into v_p7_de;

    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    begin
      v_p7_res := public.apply_role_kit_to_employee(v_p7_de, v_arch, false);
      v_p7_ok := v_p7_res is not null;
    exception when others then
      v_p7_ok := false; v_p7_msg := sqlerrm;
    end;
    execute format('set local role %I', v_caller);

    select count(*) into v_p7_kit_aud from public.audit_events a
     where a.tenant_id = v_tenant and a.detail ->> 'kind' = 'role_kit_installed'
       and a.detail ->> 'de_id' = v_p7_de::text;
    select count(*) into v_p7_apply_aud from public.audit_events a
     where a.tenant_id = v_tenant and a.detail ->> 'kind' = 'role_kit_applied'
       and a.detail ->> 'de_id' = v_p7_de::text;

    v_d7 := true;
    raise exception using errcode = 'P0001', message = '__undo__';
  exception when others then
    execute format('set local role %I', v_caller);
    if sqlerrm <> '__undo__' then
      v_bad := array_append(v_bad, format('PROBE 7 ABORTED (%s: %s) — whether apply_role_kit_to_employee still works was NOT compared this run', sqlstate, sqlerrm));
      v_d7 := false;
    end if;
  end;

  if v_d7 then
    v_probes := v_probes + 1;
    v_checks := v_checks + 1;
    if not v_p7_ok then
      v_bad := array_append(v_bad, format('apply_role_kit_to_employee refused for the workspace''s own owner — %L. It is untouched by this migration, so a refusal here means install_role_kit''s new bars have broken a caller that was never in scope.', coalesce(v_p7_msg, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce((v_p7_res ->> 'employee'), '') = '' then
      v_bad := array_append(v_bad, format('apply_role_kit_to_employee returned no employee name: %L', coalesce(v_p7_res::text, 'NULL')));
    end if;
    -- ⚠ NAMED, NOT HIDDEN: this path now writes TWO audit rows — the kit's own
    -- record of what it installed, and apply's record of the role being applied.
    -- That is deliberate. install_role_kit's other two callers (hireApi.ts:123
    -- and decide_discovery_proposal) write no kit-level record at all, so the
    -- record has to belong to the writer rather than to one of its wrappers.
    v_checks := v_checks + 1;
    if coalesce(v_p7_kit_aud, 0) <> 1 or coalesce(v_p7_apply_aud, 0) <> 1 then
      v_bad := array_append(v_bad, format('the apply path wrote %s role_kit_installed row(s) and %s role_kit_applied row(s), expected exactly 1 of each', coalesce(v_p7_kit_aud::text, 'NULL'), coalesce(v_p7_apply_aud::text, 'NULL')));
    end if;
  end if;

  ------------------------------------------------------------------------
  -- PROBE 8 — THE DISCOVERY ACCEPT, AND THE CERTIFY-SAFETY ASSERTION.
  --
  -- ⚠⚠ THIS IS THE ONE THAT MATTERS MOST. verify_decide_discovery_proposal runs
  -- on every certify with 14 probes / 138 assertions, and its probe 12 asserts
  -- that an employee accept writes EXACTLY ONE audit row, counted with
  --     detail->>'kind' = 'discovery_proposal_decision'
  --     AND detail->>'proposal_id' = <the proposal>
  -- Two new audit rows now land in the same transaction. If either carried
  -- either key, that 1 becomes a 3 and the certify behaviour section goes red
  -- for every tenant. The header reasons it through; this probe MEASURES it, by
  -- driving the real RPC and counting the same way the verifier does.
  ------------------------------------------------------------------------
  begin
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_p8_sess;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_p8_sess, v_tenant, 'employee',
              jsonb_build_object('m748', '1', 'archetype_key', v_arch, 'name', '748 probe discovery hire'),
              'probe: the discovery accept still hires', v_dim, 'pending')
      returning id into v_p8_prop;

    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    begin
      v_p8_res := public.decide_discovery_proposal(v_p8_prop, 'accepted', 'hire them', null);
    exception when others then
      v_p8_msg := sqlerrm;
    end;
    execute format('set local role %I', v_caller);

    select created_object_id into v_p8_obj from public.discovery_proposals where id = v_p8_prop;

    -- COUNTED EXACTLY THE WAY verify_decide_discovery_proposal COUNTS IT.
    select count(*) into v_p8_decision_n from public.audit_events a
     where a.tenant_id = v_tenant
       and a.detail ->> 'kind' = 'discovery_proposal_decision'
       and a.detail ->> 'proposal_id' = v_p8_prop::text;
    -- ...and the way it reads the decision's detail back, on proposal_id alone.
    select count(*) into v_p8_tagged_n from public.audit_events a
     where a.tenant_id = v_tenant
       and a.detail ->> 'proposal_id' = v_p8_prop::text;
    select count(*) into v_p8_hire_n from public.audit_events a
     where a.tenant_id = v_tenant and a.detail ->> 'kind' = 'digital_employee_hired'
       and a.detail ->> 'de_id' = coalesce(v_p8_obj::text, '');
    select count(*) into v_p8_kit_n from public.audit_events a
     where a.tenant_id = v_tenant and a.detail ->> 'kind' = 'role_kit_installed'
       and a.detail ->> 'de_id' = coalesce(v_p8_obj::text, '');

    v_d8 := true;
    raise exception using errcode = 'P0001', message = '__undo__';
  exception when others then
    execute format('set local role %I', v_caller);
    if sqlerrm <> '__undo__' then
      v_bad := array_append(v_bad, format('PROBE 8 ABORTED (%s: %s) — the discovery accept, and with it the ONE assertion that says this migration does not turn the certify behaviour section red for every tenant, was NOT compared this run', sqlstate, sqlerrm));
      v_d8 := false;
    end if;
  end;

  if v_d8 then
    v_probes := v_probes + 1;
    v_checks := v_checks + 1;
    if coalesce((v_p8_res ->> 'ok')::boolean, false) is not true then
      v_bad := array_append(v_bad, format('the discovery accept of an employee proposal did not go through: res=%L err=%L. decide_discovery_proposal calls BOTH functions changed here, and verify_decide_discovery_proposal probes 12, 13 and 14 all depend on it succeeding.', coalesce(v_p8_res::text, 'NULL'), coalesce(v_p8_msg, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p8_obj is null then
      v_bad := array_append(v_bad, 'the discovery accept stamped a NULL created_object_id — the accept reached ACCEPTED and nothing records what it made');
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p8_decision_n, -1) <> 1 then
      v_bad := array_append(v_bad, format('THE CERTIFY ASSERTION: the accept produced %s audit row(s) matching verify_decide_discovery_proposal probe 12''s count (kind=discovery_proposal_decision AND proposal_id), expected exactly 1. The two audit rows this migration adds must carry NEITHER key, or `npm run certify` goes red in the behaviour section for every tenant on the next run.', coalesce(v_p8_decision_n::text, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p8_tagged_n, -1) <> 1 then
      v_bad := array_append(v_bad, format('%s audit row(s) carry this proposal''s proposal_id, expected exactly 1. Probe 12 reads the decision''s detail back with `detail->>''proposal_id'' = ... order by created_at desc limit 1` and NO kind filter, so a second row carrying that key would hand it the wrong detail and fail four more of its assertions.', coalesce(v_p8_tagged_n::text, 'NULL')));
    end if;
    -- The other direction: the new rows must actually BE there. "No collision"
    -- is trivially true if the audit never happened.
    v_checks := v_checks + 1;
    if coalesce(v_p8_hire_n, 0) <> 1 or coalesce(v_p8_kit_n, 0) <> 1 then
      v_bad := array_append(v_bad, format('the discovery hire wrote %s hire audit row(s) and %s kit audit row(s), expected exactly 1 of each — zero here would make the collision assertion above pass by having compared nothing', coalesce(v_p8_hire_n::text, 'NULL'), coalesce(v_p8_kit_n::text, 'NULL')));
    end if;
  end if;

  ------------------------------------------------------------------------
  -- THE PERIMETER — asserted in BOTH directions, with the FULL-SIGNATURE form
  -- of has_function_privilege so a future overload cannot make these ambiguous.
  --
  -- ⚠ NOT COUNTED AS A PROBE. v_probes counts DRIVEN comparisons — calls that
  -- actually ran against real rows. Grants and greps are cheap assertions and
  -- inflating the probe count with them is how "8 probes" comes to mean less
  -- than it says. They contribute to v_checks only.
  ------------------------------------------------------------------------
  v_checks := v_checks + 1;
  if has_function_privilege('authenticated', 'public.instantiate_role_archetype_internal(uuid, text, text, text, text)', 'EXECUTE') then
    v_bad := array_append(v_bad, 'authenticated can EXECUTE instantiate_role_archetype_internal — the variant with no user check must not be reachable from the browser, or the split has renamed the hole rather than closed it');
  end if;
  v_checks := v_checks + 1;
  if not has_function_privilege('service_role', 'public.instantiate_role_archetype_internal(uuid, text, text, text, text)', 'EXECUTE') then
    v_bad := array_append(v_bad, 'service_role CANNOT EXECUTE instantiate_role_archetype_internal — connector-hub dt_hire_from_archetype reaches it over PostgREST, so without this grant the DE hire tool is dead');
  end if;
  v_checks := v_checks + 1;
  if has_function_privilege('anon', 'public.instantiate_role_archetype_internal(uuid, text, text, text, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.instantiate_role_archetype(uuid, text, text, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.install_role_kit(uuid, text)', 'EXECUTE') then
    v_bad := array_append(v_bad, 'anon can EXECUTE one of the hire functions — a CREATE OR REPLACE on a fresh database creates the function with the default PUBLIC EXECUTE grant (migs 610/630)');
  end if;
  v_checks := v_checks + 1;
  if not has_function_privilege('authenticated', 'public.instantiate_role_archetype(uuid, text, text, text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.install_role_kit(uuid, text)', 'EXECUTE') then
    v_bad := array_append(v_bad, 'authenticated cannot EXECUTE the hire wrapper or install_role_kit — the hire wizard (src/lib/hireApi.ts:113/123) would be two buttons that always error');
  end if;
  v_checks := v_checks + 1;
  if has_function_privilege('service_role', 'public.instantiate_role_archetype(uuid, text, text, text)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.install_role_kit(uuid, text)', 'EXECUTE') then
    v_bad := array_append(v_bad, 'service_role still holds EXECUTE on the hire wrapper or on install_role_kit — under service_role auth.uid() is null, and leaving the grant on the functions that now REFUSE a null uid is a grant with no caller, which is how the next fail-open prefix gets justified');
  end if;

  ------------------------------------------------------------------------
  -- ROLLBACK INTEGRITY — the probes above wrote real rows into real
  -- workspaces. Every one of them must be gone.
  ------------------------------------------------------------------------
  select count(*) into v_de_after   from public.digital_employees
   where tenant_id in (v_tenant, v_other_tenant, v_member_tenant)
     and coalesce(is_workforce_assistant, false) = false;
  select count(*) into v_ww_after   from public.work_watchers
   where tenant_id in (v_tenant, v_other_tenant, v_member_tenant);
  select count(*) into v_gr_after   from public.guardrail_rules
   where tenant_id in (v_tenant, v_other_tenant, v_member_tenant);
  select count(*) into v_pb_after   from public.playbook_definitions
   where tenant_id in (v_tenant, v_other_tenant, v_member_tenant);
  select count(*) into v_aud_after  from public.audit_events
   where tenant_id in (v_tenant, v_other_tenant, v_member_tenant)
     and detail ->> 'kind' in ('digital_employee_hired', 'role_kit_installed');
  select count(*) into v_prop_after from public.discovery_proposals
   where tenant_id in (v_tenant, v_other_tenant, v_member_tenant);

  v_checks := v_checks + 1;
  if v_de_before <> v_de_after or v_ww_before <> v_ww_after or v_gr_before <> v_gr_after
     or v_pb_before <> v_pb_after or v_aud_before <> v_aud_after or v_prop_before <> v_prop_after then
    v_bad := array_append(v_bad, format('THE PROBES DID NOT ROLL BACK — employees %s→%s, watchers %s→%s, guardrails %s→%s, playbooks %s→%s, hire/kit audit rows %s→%s, discovery proposals %s→%s. This migration has left test data, and probe employees, in customer workspaces.',
      v_de_before, v_de_after, v_ww_before, v_ww_after, v_gr_before, v_gr_after,
      v_pb_before, v_pb_after, v_aud_before, v_aud_after, v_prop_before, v_prop_after));
  end if;
  -- The count is not enough on its own: install_role_kit UPSERTS the SOP on
  -- (tenant_id, key), so on a workspace that already holds it the playbook count
  -- would not move even though a row changed. Named survivors close that gap.
  -- ⚠ THE ASSISTANT EXCLUSION IS ON THE LEAK CHECK TOO. A hire never makes one,
  -- so the predicate cannot weaken the check, and the standing instruction puts
  -- those rows out of bounds for anything this migration touches.
  v_checks := v_checks + 1;
  if exists (select 1 from public.digital_employees
              where name like '748 probe%'
                and coalesce(is_workforce_assistant, false) = false) then
    v_bad := array_append(v_bad, 'a "748 probe" employee SURVIVED into a customer workspace — a probe rollback is broken and this migration has hired somebody real');
  end if;
  v_checks := v_checks + 1;
  if exists (select 1 from public.discovery_proposals where payload ->> 'm748' = '1') then
    v_bad := array_append(v_bad, 'a 748 probe discovery proposal SURVIVED — probe 8''s rollback is broken');
  end if;

  ------------------------------------------------------------------------
  -- STATIC RATCHETS — cheap, and they are what stops the fix being undone by
  -- the next person who copies the old shape.
  ------------------------------------------------------------------------
  select pg_get_functiondef(p.oid) into v_int_body from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'instantiate_role_archetype_internal';
  select pg_get_functiondef(p.oid) into v_wrap_body from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'instantiate_role_archetype';
  select pg_get_functiondef(p.oid) into v_kit_body from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'install_role_kit';

  -- ⚠⚠ STRIP LINE COMMENTS BEFORE MATCHING, AND THIS IS NOT TIDINESS.
  -- pg_get_functiondef returns the source INCLUDING `--` comments, so a ratchet
  -- grepping for a banned construct also matches any COMMENT that names it.
  -- Migration 747's first apply failed on exactly that: its check fired against
  -- its own comment explaining the bug it had just fixed. The code was correct
  -- and the sentence describing why was indistinguishable from the thing it
  -- described — and a ratchet a correct fix cannot pass gets weakened by the
  -- next person under time pressure. Every ratchet below runs on stripped text,
  -- and every one of these three bodies carries such a comment today, so this
  -- strip is load-bearing on the very first apply.
  v_int_body  := regexp_replace(coalesce(v_int_body,  ''), '--[^' || chr(10) || ']*', '', 'g');
  v_wrap_body := regexp_replace(coalesce(v_wrap_body, ''), '--[^' || chr(10) || ']*', '', 'g');
  v_kit_body  := regexp_replace(coalesce(v_kit_body,  ''), '--[^' || chr(10) || ']*', '', 'g');

  -- THE VACUITY GUARD ON THE STRIP ITSELF. An all-blank body would make every
  -- ratchet below pass over nothing, which looks exactly like a clean result.
  v_checks := v_checks + 1;
  if length(v_int_body) < 200 or length(v_wrap_body) < 200 or length(v_kit_body) < 200 then
    v_bad := array_append(v_bad, format('a stripped function body came back short (internal=%s wrapper=%s kit=%s characters) — the comment strip has eaten the code and every static ratchet below is comparing nothing',
      length(v_int_body), length(v_wrap_body), length(v_kit_body)));
  end if;

  v_checks := v_checks + 1;
  if v_wrap_body like '%auth.uid() is not null and%'
     or v_kit_body like '%auth.uid() is not null and%'
     or v_int_body like '%auth.uid() is not null and%' then
    v_bad := array_append(v_bad, 'one of the three hire functions contains `auth.uid() is not null and` — that prefix makes the authority check SKIP instead of FAIL, and it is the seventh instance of this pattern in two days');
  end if;
  v_checks := v_checks + 1;
  if v_wrap_body not like '%not authenticated%' then
    v_bad := array_append(v_bad, 'instantiate_role_archetype no longer refuses a null identity in words on its own line — folding it back into the role predicate is the bug this migration exists for');
  end if;
  v_checks := v_checks + 1;
  if v_kit_body not like '%not authenticated%' then
    v_bad := array_append(v_bad, 'install_role_kit no longer refuses a null identity — it has no service-role caller anywhere, so there is nothing a null uid could legitimately be');
  end if;
  v_checks := v_checks + 1;
  if v_wrap_body like '%layer = ''platform''%' or v_kit_body like '%layer = ''platform''%' then
    v_bad := array_append(v_bad, 'the `p.layer = ''platform''` disjunct is back in one of the two entry points — a platform profile carries tenant_id NULL and can never satisfy append_audit_event''s membership bar, so admitting it means writing the employee and THEN aborting on the audit');
  end if;
  v_checks := v_checks + 1;
  if v_wrap_body not like '%instantiate_role_archetype_internal%' then
    v_bad := array_append(v_bad, 'the wrapper no longer delegates to instantiate_role_archetype_internal — either the split has been undone or the wrapper has grown a second copy of the insert');
  end if;
  v_checks := v_checks + 1;
  if v_int_body not like '%append_audit_event%' or v_kit_body not like '%append_audit_event%' then
    v_bad := array_append(v_bad, 'one of the two writers no longer audits — an employee created that way has no identity anywhere, which is half of the defect this migration closes');
  end if;
  -- ⚠ THE CERTIFY RATCHET. Probe 8 measures the collision on real rows; this is
  -- what stops it coming back the day somebody adds a `kind` for tidiness and
  -- nobody re-runs the migration.
  v_checks := v_checks + 1;
  if v_int_body like '%discovery_proposal_decision%' or v_kit_body like '%discovery_proposal_decision%'
     or v_int_body like '%''proposal_id''%' or v_kit_body like '%''proposal_id''%' then
    v_bad := array_append(v_bad, 'a hire audit detail names discovery_proposal_decision or proposal_id — verify_decide_discovery_proposal probe 12 counts "exactly one audit row for this decision" on those two keys, so this takes the certify behaviour section red for every tenant');
  end if;
  -- 747's pre-insert refusal, preserved and relocated next to the pack attach.
  v_checks := v_checks + 1;
  if v_int_body not like '%comes with the%compliance pack%' then
    v_bad := array_append(v_bad, 'the internal variant no longer refuses a caller who cannot be audited against this workspace BEFORE the digital_employees insert for a pack-carrying archetype — migration 747 added that and this migration was told to preserve it');
  end if;
  v_checks := v_checks + 1;
  if v_int_body not like '%attach_compliance_pack_internal%' then
    v_bad := array_append(v_bad, 'the internal hire no longer calls attach_compliance_pack_internal — migration 747 routed the pack attach through the hardened internal variant precisely so the service-role hire keeps working while an identity-less one does not');
  end if;

  if array_length(v_bad, 1) > 0 then
    raise exception '748: % of % check(s) failed across % probe(s): %',
      array_length(v_bad, 1), v_checks, v_probes, array_to_string(v_bad, ' | ');
  end if;

  raise notice '748: % checks across % probes, all passed — a caller with NO identity is refused by instantiate_role_archetype AND by install_role_kit (this is the fix, fired); the internal variant still hires with no auth.uid() at all and records that a service-role tool did it, while `authenticated` cannot execute it; the workspace''s own owner still hires, still installs the kit, and both actions now leave an audit row naming who did it and agreeing with the numbers the caller was handed; a member who is neither owner, admin nor manager is refused BY THE ROLE BAR in their own workspace; an owner of another workspace is refused BY NAME; a PLATFORM profile is now refused a PACK-FREE hire too, before anything is created (this is the deliberate change to who can hire); apply_role_kit_to_employee and the discovery accept both still work; the discovery accept still produces EXACTLY ONE audit row under verify_decide_discovery_proposal probe 12''s own count, so certify''s 14 probes / 138 assertions are untouched; and every probe row rolled back',
    v_checks, v_probes;
end $verify$;

commit;
