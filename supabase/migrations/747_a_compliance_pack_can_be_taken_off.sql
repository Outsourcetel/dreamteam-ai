-- 747_a_compliance_pack_can_be_taken_off.sql
-- ==========================================================================
-- WHY: accepting a discovery employee proposal — or hiring through the wizard —
-- silently switches on WORKSPACE-WIDE BLOCKING guardrails that the customer was
-- never shown and could not remove.
--
--   instantiate_role_archetype → attach_compliance_pack inserts guardrail_rules
--   with applies_to='all', severity='blocking', compliance_pack_key=<pack>.
--
-- Measured live on 2026-08-16: 7 of 15 active archetypes carry a pack
-- (accounting/billing_ar/fpa → financial_controls; bdr/google_ads/marketing/sdr
-- → tcpa_dnc), 2 rules each, and only 4 of 18 tenants hold any pack today — so
-- this fires for real on most workspaces, and it fires on the hire path that
-- migration 746 has just made reachable from the discovery deck.
--
-- ⚠ THE REMOVAL DESIGN IS SOUND AND IS PRESERVED WHOLE. Trigger
-- `guard_compliance_guardrails` refuses a DELETE, or a deactivation, of any row
-- carrying a compliance_pack_key unless the transaction-local GUC
-- `app.allow_compliance_change` is 'on', and detach_compliance_pack is the one
-- function that sets it. That gate is good and this migration does not weaken
-- it — the last probe below fires a bare DELETE and a bare deactivation OUTSIDE
-- detach and requires both to still be refused. The defects were all AROUND it.
--
-- ==========================================================================
-- THE FOUR DEFECTS, each measured on the live body (pg_get_functiondef)
--
-- 1. ⚠⚠⚠ BOTH FUNCTIONS FAILED OPEN. Both opened with
--
--        if auth.uid() is not null and not exists (...) then raise
--
--    That prefix makes the authority check SKIP rather than FAIL when
--    auth.uid() is null — i.e. under service_role, or under any caller with no
--    identity at all. A caller with no identity could attach or detach
--    compliance packs on ANY tenant with no authority check whatsoever. This is
--    the exact pattern migrations 662-664 exist to prevent, the one
--    decide_discovery_proposal refuses by name in its own Zone 1 comment, and
--    the one still live in install_role_kit (named below, not fixed here).
--
-- 2. NEITHER FUNCTION AUDITED. Attaching or removing BLOCKING COMPLIANCE
--    controls left no trace anywhere — not in audit_events, not in a counter,
--    not on a card.
--
-- 3. detach HARD-DELETED: `delete from guardrail_rules where ... `. The standing
--    ruling on this repo is RETIRE, NOT DELETE — migration 726 added
--    `retired_at`/`retired_by` to guardrail_rules for exactly this, and
--    retire_guardrail_rule freezes the whole rule into the audit detail
--    "because the row can later be edited and there is no version history
--    anywhere else". A hard delete also destroys the only record of what the
--    rule said, and orphans every guardrail_block event that points at its id.
--
-- 4. detach_compliance_pack HAD NO CALLER IN THE PRODUCT. Enumerated across
--    src/ and supabase/functions/: exactly one call to attach
--    (src/lib/deWorkbenchApi.ts:273) and ZERO to detach. So the documented
--    escape hatch — retire_guardrail_rule's own refusal says "detach the pack
--    instead" — pointed at something unreachable. This migration gives detach a
--    caller on the Compliance page.
--
-- ==========================================================================
-- WHO IS ALLOWED TO DO THIS, AND WHY THE INTERNAL VARIANT EXISTS
--
-- Enumerated callers, before deciding anything:
--
--   attach_compliance_pack
--     · public.instantiate_role_archetype                    (SQL)
--     · src/lib/deWorkbenchApi.ts:273                        (browser, signed in)
--   instantiate_role_archetype
--     · src/lib/hireApi.ts:113                               (browser, signed in)
--     · public.decide_discovery_proposal                     (SQL; auth.uid() is
--       already refused-if-null in its Zone 1, so the hire path always carries a
--       real person — auth.uid() is a transaction GUC and survives SECDEF
--       nesting, which probe 10 proves rather than assumes)
--     · supabase/functions/connector-hub/index.ts:3346       (⚠ SERVICE ROLE)
--     · scripts/golden-path.mjs:143                          (a signed-up owner)
--   detach_compliance_pack
--     · nothing, anywhere
--
-- ⚠ connector-hub's `dt_hire_from_archetype` is a GENUINE provisioning path
-- with no user: the Onboarding Architect runs it through the service-role admin
-- client, scoped to its own connector's tenant. Making attach demand a signed-in
-- human would have broken that live feature — a refusal reported as a fix. So
-- the hole is closed by DESIGN rather than by deletion:
--
--   attach_compliance_pack_internal  — does the work. Authority =
--       can_admin_tenant_internal(), the same helper install_role_systems uses
--       on the same hire: service_role, or an owner/admin of THAT tenant.
--       It FAILS CLOSED for a caller with no identity that is not service_role.
--       EXECUTE is revoked from public, anon, authenticated AND service_role, so
--       it is reachable only from inside another SECURITY DEFINER function.
--   attach_compliance_pack           — the product entry point. authenticated
--       only, and it refuses a null auth.uid() in words before delegating.
--   detach_compliance_pack           — authenticated only, owner/admin of THAT
--       tenant read off their OWN profile row. No service_role arm at all,
--       because nothing needs one and removing protection is the dangerous
--       direction.
--
-- Net effect on who can do what:
--   · nobody-at-all           — was WAVED THROUGH, now REFUSED (the fix)
--   · service_role direct     — could attach/detach any tenant, now REFUSED
--   · service_role via hire   — worked, still works (probe 10)
--   · owner/admin             — worked, still works (probes 4, 5)
--   · tenant_manager          — attach was refused, still refused (see below)
--   · another tenant's owner  — was refused, still refused (probe 3)
--   · an owner/admin whose OWN profile carries tenant_id NULL — was WAVED
--     THROUGH BY A NULL, now REFUSED (probe 11; see the coalesce note below)
--   · platform profile        — WAS ADMITTED, IS NOW REFUSED, and the hire that
--     used to carry it is refused BEFORE it creates anything (probe 13; see the
--     platform-operator section below, which is a change to WHO CAN HIRE and is
--     called that rather than filed under authority).
--
-- ⚠ NAMED AND NOT FIXED (deliberate, in scope discipline):
--   · instantiate_role_archetype ITSELF still opens with `auth.uid() is not
--     null and`. Tightening it the same way would break connector-hub, and
--     narrowing it to can_admin_tenant_internal would lock out tenant_manager,
--     who can hire today. It is now harmless for PACKS — the pack write below
--     fails closed and takes the whole hire down with it — but an archetype
--     with no packs can still be hired by an identity-less `authenticated`
--     caller. Same sentence for install_role_kit, which is untouched here.
--   · A tenant_manager cannot hire any of the 7 pack-carrying archetypes:
--     instantiate admits managers, attach never has. That defect is PRESERVED
--     EXACTLY (can_admin_tenant_internal admits owner/admin only), because
--     changing it is a change to who can hire, which is not this migration.
--   · src/lib/hireApi.ts:113 is the SECOND pack-attaching path in the product
--     (the hire wizard). It discloses nothing about packs before or after this
--     migration. Left alone deliberately — the disclosure work here is the
--     discovery deck's, and the wizard is its own surface with its own
--     confirmation step. Named because a header that lists everything else it
--     left cannot quietly omit the one caller that still says nothing.
--
-- ==========================================================================
-- ⚠⚠ WHY `coalesce(can_admin_tenant_internal(...), false)` AND NOT THE BARE CALL
--
-- The first version of this migration wrote `if not
-- public.can_admin_tenant_internal(p_tenant_id) then`. THAT GUARD CANNOT FIRE
-- FOR A WHOLE CLASS OF CALLER, because the helper returns NULL, not FALSE:
--
--     coalesce(auth.role(),'') = 'service_role'                     -- FALSE
--  OR (p_tenant = auth_tenant_id() AND auth_has_tenant_role([...])) -- NULL AND TRUE
--
-- With auth_tenant_id() NULL, `p_tenant = NULL` is NULL, `NULL AND TRUE` is
-- NULL, `FALSE OR NULL` is NULL — and `if not NULL then` does not fire.
--
-- MEASURED against production on 2026-08-16, read-only, by impersonating the
-- live fixture (profiles.user_id = 6d07ff8d-5784-4a73-abd9-f3bcacd8062a, which
-- is layer='tenant', role='tenant_owner', is_active, and tenant_id IS NULL —
-- auth_has_tenant_role is NOT tenant-scoped, so it returns TRUE for them):
--
--     auth_tenant_id()                    -> NULL
--     auth_has_tenant_role([owner,admin]) -> true
--     can_admin_tenant_internal(<tenant>) -> NULL
--     not can_admin_tenant_internal(...)  -> NULL   (the `if` does not fire)
--     not coalesce(..., false)            -> TRUE   (it fires)
--
-- The same NULL arrives by a second door with no exotic fixture at all:
-- `attach_compliance_pack(NULL, ...)` from ANY owner or admin makes `p_tenant =
-- auth_tenant_id()` NULL on its own — measured, can_admin_tenant_internal(NULL)
-- -> NULL — so the guard waved it past and the call died on a raw 23502 from
-- the tenant_compliance_packs insert. Both doors are probe 11.
--
-- It was not exploitable the hour this was written, and that is not a defence:
-- the only thing stopping it was append_audit_event raising 'not a member of
-- this tenant' AFTERWARDS and rolling the transaction back — accidental
-- protection living in a different function, which anyone making the audit
-- conditional, reordering it, or adding a service_role arm would remove without
-- ever reading this file.
--
-- THE HOUSE PATTERN IS coalesce, and 11 live functions already use it:
-- install_role_systems (which this migration cited as its precedent and then
-- did not copy), decide_discovery_proposal, apply_playbook_amendment,
-- reject_playbook_amendment, three writeback resolvers and three scim
-- functions. A static ratchet at the bottom of this file fails if the bare call
-- ever comes back.
--
-- ==========================================================================
-- ⚠⚠ THE PLATFORM OPERATOR'S HIRE — DECIDED OUT LOUD, BECAUSE IT BREAKS ONE
--
-- God mode is a LIVE path, not a theoretical one: AuthContext.tsx:152 sets
-- godModeTenantIdOverride, customerApi.ts:285 short-circuits getSessionTenantId
-- to the remote-access tenant, App.tsx:491 renders the whole tenant app
-- including the hire wizard, and platform_access_events holds 57 'start' rows.
--
-- Once attach AUDITS — the whole point of defect 2 — a platform operator hiring
-- a pack-carrying archetype passes can_admin_tenant_internal (via
-- resolve_remote_access_tenant) and then dies inside append_audit_event, whose
-- live body raises 'not a member of this tenant' for any non-service_role
-- caller with no profiles row for (auth.uid(), p_tenant_id). Both platform
-- profiles carry tenant_id NULL (measured: 2 of 2). The employee row and the
-- pack rows are already written by then, so the hire aborts HALF-WAY and the
-- operator reads a sentence about the audit chain.
--
-- TWO OPTIONS, AND WHY THIS ONE. The alternative was to give the internal
-- variant a platform arm with an audit path append_audit_event accepts. There
-- is no such path that is not either (a) editing append_audit_event's
-- membership bar, which is the tenancy perimeter for the ENTIRE audit chain and
-- is not this migration's to move, or (b) skipping the audit for platform
-- callers — which is defect 2 coming back on exactly the caller who most needs
-- a record, since a platform operator acting inside a customer's workspace is
-- the least accountable actor in the system. So: REFUSE, in words, BEFORE the
-- digital_employees insert.
--
-- AND NARROWLY. The refusal is not "platform cannot hire" — that would break 8
-- of the 15 active archetypes that carry no pack, work today, and would keep
-- working after this migration untouched. It is exactly the predicate that
-- append_audit_event would have raised on, asked early:
--
--     the archetype carries at least one pack
--     AND the caller is not service_role
--     AND the caller has no profiles row for this tenant
--
-- so a platform operator can still hire cs_manager, front_desk, it_helpdesk,
-- onboarding, renewal_manager, seo, social_media and support_agent, and is told
-- plainly why accounting, billing_ar, fpa, bdr, google_ads, marketing and sdr
-- need a workspace member. Probe 13 fires both halves: the refusal, and the
-- pack-free hire by the SAME platform profile, because "platform is refused"
-- would otherwise just mean "platform is refused for everything".
--
-- ⚠ AND THE HIRES THAT STILL WORK ARE NOT UNRECORDED. digital_employees carries
-- trg_remote_access_audit → log_remote_access_write, which writes every
-- god-mode write into remote_access_write_log with the operator, the session key
-- and the whole row (verified body). That is a different surface from the
-- tenant's tamper-evident audit chain, and it is precisely why the chain's
-- membership bar must not be widened to admit a non-member: the platform
-- operator's accountability already lives somewhere that does not require
-- pretending they are a member of the workspace.
--
-- ==========================================================================
-- RETIRE, AND WHAT A LATER RE-ATTACH DOES
--
-- detach now sets retired_at = now(), retired_by = auth.uid(), active = false,
-- version = version + 1 — migration 726's exact shape, and the shape
-- retire_guardrail_rule uses. The trigger permits it because detach sets the
-- GUC, and the CHECK `guardrail_rules_retired_is_inactive` (retired_at is null
-- OR active = false) is satisfied because both are written in one statement.
--
-- ⚠ detach RESETS THE GUC BACK TO 'off' BEFORE IT RETURNS. set_config(..., true)
-- is TRANSACTION-local, not statement-local: left on, every later statement in
-- the same transaction could delete or deactivate a pack rule freely. In
-- production PostgREST gives each RPC its own transaction so this was latent,
-- but a future SQL caller inside a larger transaction would inherit an open
-- gate. Probe 9 asserts the gate is shut again by firing a bare DELETE and a
-- bare deactivation immediately after a successful detach, in the same
-- transaction, and requiring both to be refused.
--
-- The tenant_compliance_packs row is DELETED on detach and re-inserted on
-- re-attach: that table is the plain set of "which packs are on", it is what
-- the new UI lists from, and the history of who turned one on or off now lives
-- where history belongs — the audit chain — instead of in a membership row.
--
-- RE-ATTACH RE-ACTIVATES, IT DOES NOT INSERT A SECOND COPY. Decided, with the
-- reason: the old attach skipped any rule whose text already existed for that
-- tenant+pack, so after a retire-style detach it would have inserted NOTHING
-- and left every rule retired — the pack would read as attached with nothing in
-- force, which is the silent-zero defect this codebase keeps paying for.
-- Inserting a fresh duplicate instead would leave two rows with identical text,
-- one live and one retired, in a list the UI keys by text. Reviving the same
-- rows keeps the block history (audit_events.detail.rule_id) pointing at a rule
-- that is live again, so a rule blocked in March, detached in April and
-- re-attached in May is ONE rule with a gap rather than two rules with half a
-- story each. Probe 7 asserts the row COUNT does not move across a
-- detach/re-attach cycle and that the same ids come back live.
--
-- ⚠ AND IT COMES BACK ON, unlike restore_guardrail_rule, which deliberately
-- restores a rule switched OFF. That asymmetry is correct: a hand-written rule
-- is one person's decision and turning it back on is a second decision; a
-- compliance pack is mandatory by construction (compliance_packs.mandatory is
-- true for all three), and attaching a pack whose rules are all off would be an
-- attach that attaches nothing.
--
-- ==========================================================================
-- WHAT THE CUSTOMER IS TOLD
--
-- decide_discovery_proposal now measures the workspace's active pack rules
-- either side of the hire and reports THREE numbers, in the return payload AND
-- the audit detail, from one variable so they cannot disagree:
--   compliance_packs_attached  — the archetype's pack keys
--   compliance_rules_created   — how many blocking rules this accept newly put
--                                in force (0 when the pack was already on)
--   compliance_rules_in_force  — how many are in force afterwards, so a 0 in the
--                                line above is distinguishable from "there are
--                                none", which is the lesson of systems_installed
--
-- ==========================================================================
-- WHAT IS NOT CHANGED HERE, ON PURPOSE
--   · guard_compliance_guardrails — untouched. It is the good part.
--   · retire_guardrail_rule — untouched. Its refusal ("detach the pack
--     instead") is now true rather than aspirational.
--
-- ⚠ restore_guardrail_rule IS CHANGED, and it has to be, because THIS
--   migration is what exposes it. Its live body has no compliance_pack_key
--   refusal (unlike retire's, which has an explicit one) and it writes
--   `active = false`; guard_compliance_guardrails fires on exactly
--   `UPDATE ... OLD.compliance_pack_key is not null AND NEW.active = false` and
--   raises 'cannot be disabled or deleted — detach the pack instead'. Before
--   this migration detach DELETED the rows, so a pack rule could never reach
--   the Retired shelf and that button could never be pressed on one. Retiring
--   them — section 3 below — is what puts them on the shelf, next to a Restore
--   control the database refuses every time. Shipping the retire without the
--   refusal would be this migration handing the customer a button that always
--   errors, on the page its own confirm dialog sends them to. Section 5 adds
--   the pack branch in words; CompliancePage.tsx stops offering Restore for a
--   pack rule at all.
--   · delete_tenant — untouched. It sets app.allow_compliance_change itself and
--     relies on the FK cascade; it never called detach_compliance_pack.
--   · guardrail_rules_for_de — untouched. It already filters `active and
--     retired_at is null`, which is WHY retiring is enough; probe 6 drives it
--     rather than trusting the comment.
-- ==========================================================================

begin;

-- ==========================================================================
-- 1. attach_compliance_pack_internal — the work, and the audit
-- ==========================================================================
create or replace function public.attach_compliance_pack_internal(
  p_tenant_id uuid,
  p_pack_key  text,
  p_via       text default 'unknown'
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_inserted   integer := 0;
  v_revived    integer := 0;
  v_in_force   integer := 0;
  v_new_pack   boolean := false;
  v_pack_name  text;
  v_rules      jsonb;
  v_actor      text;
  v_actor_type text;
begin
  -- ⚠ THE WORKSPACE IS NAMED FIRST, in words. Without this line a NULL tenant
  -- reached the tenant_compliance_packs insert and came back as a raw 23502
  -- about a column nobody outside this file has heard of — and it got that far
  -- because `p_tenant = auth_tenant_id()` is NULL when p_tenant is NULL, so the
  -- authority check below evaluated to NULL and waved it through. It is now
  -- refused twice: here by name, and by the coalesce below if this line is ever
  -- deleted.
  if p_tenant_id is null then
    raise exception 'not authorized to attach a compliance pack: no workspace was named — a pack switches on blocking rules for one specific workspace, and a call that does not say which cannot be authorised or recorded';
  end if;

  -- ⚠ FAILS CLOSED, AND coalesce IS WHAT MAKES THAT TRUE. can_admin_tenant_internal is
  --     auth.role() = 'service_role'
  --  OR (p_tenant = auth_tenant_id() AND auth_has_tenant_role([owner, admin]))
  -- which returns NULL — not FALSE — whenever auth_tenant_id() is NULL, and
  -- `if not NULL then` DOES NOT FIRE. Measured live: a profile carrying
  -- role='tenant_owner' with tenant_id NULL walks straight past the bare call.
  -- See the header section on coalesce for the full measurement and for the 11
  -- live functions that already write it this way, install_role_systems — this
  -- migration's own cited precedent — among them.
  if not coalesce(public.can_admin_tenant_internal(p_tenant_id), false) then
    raise exception 'not authorized to attach a compliance pack to this workspace — attaching switches on blocking rules that apply to every employee in it';
  end if;

  select name into v_pack_name from compliance_packs where key = p_pack_key;
  if v_pack_name is null then
    raise exception 'unknown compliance pack %', p_pack_key;
  end if;

  insert into tenant_compliance_packs (tenant_id, pack_key, attached_by)
  values (p_tenant_id, p_pack_key, auth.uid())
  on conflict (tenant_id, pack_key) do nothing;
  get diagnostics v_inserted = row_count;
  v_new_pack := v_inserted > 0;

  -- (a) rules this workspace has never held. Column list byte-identical to the
  --     body this replaces: semantic_policy is deliberately NOT copied from the
  --     catalogue, because it never was, and quietly starting to would change
  --     what the meaning judge screens on.
  insert into guardrail_rules
    (tenant_id, rule, rule_type, pattern, applies_to, severity, active, compliance_pack_key)
  select p_tenant_id, r.rule, r.rule_type, r.pattern, 'all', r.severity, true, r.pack_key
  from compliance_pack_rules r
  where r.pack_key = p_pack_key
    and not exists (
      select 1 from guardrail_rules g
       where g.tenant_id = p_tenant_id
         and g.compliance_pack_key = r.pack_key
         and g.rule = r.rule);
  get diagnostics v_inserted = row_count;

  -- (b) rules a previous detach retired, or that are otherwise switched off.
  --     ⚠ The trigger does NOT block this: it refuses `NEW.active = false`, and
  --     this sets active TRUE. retired_at must be cleared in the SAME statement
  --     or guardrail_rules_retired_is_inactive rejects the row.
  update guardrail_rules g
     set retired_at = null,
         retired_by = null,
         active     = true,
         version    = g.version + 1
   where g.tenant_id          = p_tenant_id
     and g.compliance_pack_key = p_pack_key
     and (g.retired_at is not null or g.active = false);
  get diagnostics v_revived = row_count;

  select count(*) into v_in_force
    from guardrail_rules g
   where g.tenant_id = p_tenant_id
     and g.compliance_pack_key = p_pack_key
     and g.active and g.retired_at is null;

  -- The rules VERBATIM. Same reasoning retire_guardrail_rule states in its own
  -- comment: the row can be edited later and there is no version history
  -- anywhere else, so the audit detail is the only frozen copy of what the
  -- customer's workspace was actually made to enforce.
  -- ⚠ THE SAME COLUMN LIST AS retire_guardrail_rule's frozen copy, and the same
  -- one detach uses below. The first version of this file froze a shorter list
  -- in each of the two directions and a shorter one again than retire's:
  -- threshold, scope_ref and version were missing here or there. Harmless while
  -- every pack rule is blocked_topic/blocking with null threshold and null
  -- scope_ref — and silently wrong on the first pack rule that is not, which is
  -- exactly the day the frozen copy is the only record left.
  select coalesce(jsonb_agg(jsonb_build_object(
           'rule_id',  g.id,   'rule',      g.rule,
           'rule_type', g.rule_type, 'pattern', g.pattern,
           'threshold', g.threshold,
           'severity', g.severity, 'applies_to', g.applies_to,
           'scope',    g.scope, 'scope_ref', g.scope_ref,
           'version',  g.version) order by g.rule), '[]'::jsonb)
    into v_rules
    from guardrail_rules g
   where g.tenant_id = p_tenant_id
     and g.compliance_pack_key = p_pack_key
     and g.active and g.retired_at is null;

  -- ⚠ NOT 'You'/'human' unconditionally. append_audit_event only overwrites the
  -- actor for a JWT caller; under service_role it writes whatever it is handed,
  -- so a hardcoded 'You' would file the Onboarding Architect's automated hire
  -- as a human decision.
  if coalesce(auth.role(), '') = 'service_role' then
    v_actor := 'System'; v_actor_type := 'system';
  else
    v_actor := 'You';    v_actor_type := 'human';
  end if;

  -- Audited only when something actually CHANGED. Hiring three accountants
  -- attaches financial_controls once and no-ops twice; three identical
  -- config_change rows would be three claims that something happened.
  if v_new_pack or v_inserted > 0 or v_revived > 0 then
    perform public.append_audit_event(
      p_tenant_id, v_actor, v_actor_type,
      format('Compliance pack attached — %s. %s blocking rule(s) now apply to every employee in this workspace.',
             v_pack_name, v_in_force),
      'config_change',
      jsonb_build_object(
        'event',             'compliance_pack_attached',
        'pack_key',          p_pack_key,
        'pack_name',         v_pack_name,
        'via',               p_via,
        'rules_created',     v_inserted,
        'rules_reactivated', v_revived,
        'rules_in_force',    v_in_force,
        'rules',             v_rules,
        'attached_by',       auth.uid()));
  end if;

  return jsonb_build_object(
    'ok',                true,
    'pack_key',          p_pack_key,
    'pack_name',         v_pack_name,
    'newly_attached',    v_new_pack,
    'rules_created',     v_inserted,
    'rules_reactivated', v_revived,
    'rules_in_force',    v_in_force);
end;
$fn$;

-- ⚠ NO CLIENT ROLE HOLDS THIS. It is reachable only from inside another
-- SECURITY DEFINER function owned by postgres (where current_user is the
-- definer), which is what makes "service_role cannot attach a pack to an
-- arbitrary tenant" true rather than merely intended.
revoke all on function public.attach_compliance_pack_internal(uuid, text, text)
  from public, anon, authenticated, service_role;

-- ==========================================================================
-- 2. attach_compliance_pack — the product entry point
-- ==========================================================================
create or replace function public.attach_compliance_pack(p_tenant_id uuid, p_pack_key text)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare v_res jsonb;
begin
  -- Refused on its own line, FIRST, and in words — not folded into the role
  -- predicate as `auth.uid() is not null and ...`, which is the bug this
  -- migration exists for. The internal variant would refuse this caller too;
  -- this line exists so the person reads a sentence about identity rather than
  -- a sentence about authority.
  if auth.uid() is null then
    raise exception 'not authenticated: attaching a compliance pack switches on blocking rules for every employee in this workspace, and the record has to say who did it';
  end if;

  v_res := public.attach_compliance_pack_internal(p_tenant_id, p_pack_key, 'compliance_page');

  -- Same integer contract as before: how many guardrail rules this call put in
  -- force. A revived rule counts — it was not enforcing a second ago and is now.
  return coalesce((v_res ->> 'rules_created')::integer, 0)
       + coalesce((v_res ->> 'rules_reactivated')::integer, 0);
end;
$fn$;

revoke all on function public.attach_compliance_pack(uuid, text) from public, anon, service_role;
grant execute on function public.attach_compliance_pack(uuid, text) to authenticated;

-- ==========================================================================
-- 3. detach_compliance_pack — retires, audits, and answers
--    ⚠ DROP first: the return type changes from void to jsonb, which CREATE OR
--    REPLACE cannot do. Safe because it has no caller anywhere today — that is
--    defect 4, and the reason this drop is not a compatibility event.
-- ==========================================================================
drop function if exists public.detach_compliance_pack(uuid, text);

create function public.detach_compliance_pack(p_tenant_id uuid, p_pack_key text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_pack_name    text;
  v_rules        jsonb;
  v_retired      integer := 0;
  v_already      integer := 0;
  v_was_attached boolean := false;
begin
  if auth.uid() is null then
    raise exception 'not authenticated: taking a compliance pack off removes blocking rules from every employee in this workspace, and the record has to say who did it';
  end if;

  -- The tenant comes off the caller's OWN profile row matched against the
  -- parameter — a tenant id supplied by the caller is not authorisation
  -- (migrations 662-664). No `p.layer = 'platform'` disjunct, and no
  -- service_role arm: see the header for both.
  if not exists (
    select 1 from profiles p
     where p.user_id = auth.uid()
       and coalesce(p.is_active, true)
       and p.tenant_id = p_tenant_id
       and p.role in ('tenant_owner', 'tenant_admin')
  ) then
    raise exception 'only this workspace''s owners and admins can take a compliance pack off';
  end if;

  select name into v_pack_name from compliance_packs where key = p_pack_key;
  if v_pack_name is null then
    raise exception 'unknown compliance pack %', p_pack_key;
  end if;

  -- Frozen BEFORE anything changes. After the update these rows still exist but
  -- read as retired; the point of the copy is what they SAID while they applied.
  select coalesce(jsonb_agg(jsonb_build_object(
           'rule_id',  g.id,   'rule',      g.rule,
           'rule_type', g.rule_type, 'pattern', g.pattern,
           'threshold', g.threshold,
           'severity', g.severity, 'applies_to', g.applies_to,
           'scope',    g.scope, 'scope_ref', g.scope_ref,
           'version',  g.version) order by g.rule), '[]'::jsonb)
    into v_rules
    from guardrail_rules g
   where g.tenant_id = p_tenant_id
     and g.compliance_pack_key = p_pack_key
     and g.retired_at is null;

  select count(*) into v_already
    from guardrail_rules g
   where g.tenant_id = p_tenant_id
     and g.compliance_pack_key = p_pack_key
     and g.retired_at is not null;

  -- Transaction-local sanction for trg_guard_compliance_guardrails.
  perform set_config('app.allow_compliance_change', 'on', true);

  -- ⚠ RETIRE, NOT DELETE (migration 726). active = false is what stops
  -- enforcement — every reader filters on it, and guardrail_rules_for_de filters
  -- on retired_at too. retired_at is the filing decision, and it is what lets a
  -- guardrail_block recorded months ago still point at something.
  update guardrail_rules
     set retired_at = now(),
         retired_by = auth.uid(),
         active     = false,
         version    = version + 1
   where tenant_id = p_tenant_id
     and compliance_pack_key = p_pack_key
     and retired_at is null;
  get diagnostics v_retired = row_count;

  with d as (
    delete from tenant_compliance_packs
     where tenant_id = p_tenant_id and pack_key = p_pack_key
    returning 1)
  select count(*) > 0 into v_was_attached from d;

  -- ⚠ SHUT THE GATE. set_config(..., true) lasts the whole TRANSACTION, not the
  -- statement — leaving it open would let anything later in the same transaction
  -- delete or deactivate a pack rule with no gate at all. Probe 9 fires a bare
  -- DELETE right after this returns and requires it to be refused.
  perform set_config('app.allow_compliance_change', 'off', true);

  if v_retired > 0 or v_was_attached then
    perform public.append_audit_event(
      p_tenant_id, 'You', 'human',
      format('Compliance pack removed — %s. %s blocking rule(s) stopped applying to every employee in this workspace.',
             v_pack_name, v_retired),
      'config_change',
      jsonb_build_object(
        'event',                 'compliance_pack_detached',
        'pack_key',              p_pack_key,
        'pack_name',             v_pack_name,
        'rules_retired',         v_retired,
        'rules_already_retired', v_already,
        'was_attached',          v_was_attached,
        'rules',                 v_rules,
        'detached_by',           auth.uid()));
  end if;

  return jsonb_build_object(
    'ok',                    true,
    'pack_key',              p_pack_key,
    'pack_name',             v_pack_name,
    'rules_retired',         v_retired,
    'rules_already_retired', v_already,
    'was_attached',          v_was_attached);
end;
$fn$;

revoke all on function public.detach_compliance_pack(uuid, text) from public, anon, service_role;
grant execute on function public.detach_compliance_pack(uuid, text) to authenticated;

-- ==========================================================================
-- 4. instantiate_role_archetype — TWO CHANGES
--    (a) the pack attach goes through the internal variant, so the hire keeps
--        working for connector-hub's service-role Onboarding Architect while an
--        identity-less caller is refused;
--    (b) a caller who cannot be audited against this workspace is refused
--        BEFORE the digital_employees insert when — and only when — the
--        archetype carries a pack. See the platform-operator section in the
--        header for why this is a refusal rather than a platform arm, and why
--        it is scoped to pack-carrying archetypes rather than to platform.
--    Everything else is the live body verbatim.
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.instantiate_role_archetype(p_tenant_id uuid, p_archetype_key text, p_de_name text, p_persona_name text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a role_archetypes; v_de uuid; v_pack text; v_dial jsonb;
begin
  if auth.uid() is not null and not exists (
      select 1 from profiles p where p.user_id = auth.uid()
      and (p.layer = 'platform' or (p.tenant_id = p_tenant_id and p.role in ('tenant_owner','tenant_admin','tenant_manager')))) then
    raise exception 'not authorized to hire a DE for this tenant';
  end if;
  select * into a from role_archetypes where key = p_archetype_key and status = 'active';
  if a.key is null then raise exception 'unknown archetype %', p_archetype_key; end if;

  -- ⚠⚠ migration 747: REFUSED HERE, BEFORE ANYTHING EXISTS, rather than half-way.
  --
  -- The pack attach below now AUDITS. append_audit_event's live body raises
  -- 'not a member of this tenant' for any non-service_role caller with no
  -- profiles row for (auth.uid(), p_tenant_id). A PLATFORM OPERATOR IN GOD MODE
  -- IS EXACTLY THAT CALLER — both platform profiles carry tenant_id NULL
  -- (measured 2 of 2, 2026-08-16) — and so is an owner/admin whose own profile
  -- carries a NULL tenant_id (1 such row live). can_admin_tenant_internal lets
  -- the first through via resolve_remote_access_tenant, so without this line the
  -- hire inserts the employee, materialises the pack's blocking rules, and only
  -- THEN dies inside the audit call, aborting a hire the operator had every
  -- reason to think was underway.
  --
  -- The predicate is append_audit_event's own membership bar, asked early. It is
  -- NOT "platform cannot hire": 8 of the 15 active archetypes carry no pack,
  -- work for a platform operator today, and are untouched by this — only the 7
  -- that carry one need a caller the audit chain can name. Probe 13 fires both
  -- halves.
  if coalesce(array_length(a.compliance_pack_keys, 1), 0) > 0
     and coalesce(auth.role(), '') <> 'service_role'
     and not exists (select 1 from profiles p
                      where p.user_id = auth.uid()
                        and p.tenant_id = p_tenant_id) then
    raise exception 'this role comes with the % compliance pack, which switches on blocking rules for every employee in this workspace — and that is recorded against a member of it. Sign in as an owner or admin of this workspace to hire this role.',
      array_to_string(a.compliance_pack_keys, ', ');
  end if;

  insert into digital_employees (tenant_id, name, persona_name, description, category, department,
    lifecycle_status, trust_level, status, capabilities, responsibilities, model_provider, model_id,
    catalog_id, archetype_key)
  values (p_tenant_id, p_de_name, p_persona_name, a.description, 'Customer', a.domain,
    'designed', 'supervised', 'idle', a.required_capabilities, a.responsibilities, 'anthropic', a.recommended_model,
    a.key, a.key)
  returning id into v_de;

  -- Auto-attach the archetype's mandatory compliance packs (now populated).
  -- ⚠ migration 747: the INTERNAL variant. The public one demands a signed-in
  -- person, which the connector-hub Onboarding Architect is not.
  foreach v_pack in array a.compliance_pack_keys loop
    perform public.attach_compliance_pack_internal(p_tenant_id, v_pack, 'hire');
  end loop;

  -- mig 497 (D4): the role's own trust dials, materialised PER EMPLOYEE so a
  -- hire never widens the workspace. This is the only hook all three hire
  -- paths share.
  for v_dial in select * from jsonb_array_elements(coalesce(a.autonomy_templates, '[]'::jsonb)) loop
    insert into de_autonomy (tenant_id, de_id, action_type, source_category, enabled)
    values (p_tenant_id, v_de, v_dial->>'action_type', v_dial->>'source_category',
            coalesce((v_dial->>'enabled')::boolean, false))
    on conflict do nothing;
  end loop;

  return v_de;
end;
$function$;

-- ==========================================================================
-- 5. restore_guardrail_rule — the button on the Retired shelf that this
--    migration would otherwise have pointed at a certain error
--
--    ⚠ THIS FUNCTION IS ONLY BROKEN BECAUSE OF SECTION 3. Its live body has no
--    compliance_pack_key refusal — retire_guardrail_rule has an explicit one,
--    restore never did — and it writes `active = false`.
--    guard_compliance_guardrails fires on precisely
--        UPDATE ... OLD.compliance_pack_key is not null AND NEW.active = false
--    with the GUC off, and raises 'cannot be disabled or deleted — detach the
--    pack instead'. That combination was unreachable while detach DELETED the
--    rows: a pack rule could never reach the shelf, so Restore could never be
--    pressed on one. Retiring them puts them there, under a button that fails
--    every time — and the new detach confirm dialog tells people that is where
--    they went.
--
--    The refusal below is the same shape and the same voice as retire's, and it
--    names the way back, because for a pack there IS one: re-attach the pack and
--    every rule comes back live together (section 1's revive arm). The UI stops
--    offering Restore on a pack rule at all (CompliancePage.tsx); this is the
--    bar underneath it, because a control that is only hidden is not gated.
--
--    Everything else is the live body VERBATIM — same authority check (which
--    admits platform, unchanged: restoring writes an audit row against
--    v_rule.tenant_id and that is a pre-existing property of this function, not
--    something this migration is widening), same already-live short-circuit,
--    same active=false-on-purpose, same audit call.
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.restore_guardrail_rule(p_rule_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_rule guardrail_rules;
  v_next guardrail_rules;
begin
  select * into v_rule from guardrail_rules where id = p_rule_id;
  if v_rule.id is null then
    raise exception 'guardrail rule not found';
  end if;

  if not exists (
    select 1 from profiles p
     where p.user_id = auth.uid()
       and (p.layer = 'platform'
            or (p.tenant_id = v_rule.tenant_id and p.role in ('tenant_owner', 'tenant_admin')))
  ) then
    raise exception 'only workspace owners and admins can restore a guardrail';
  end if;

  -- ⚠ ADDED BY 747. A pack rule cannot come back one at a time, in either
  -- direction: retire refuses it going out, and the trigger refuses the
  -- `active = false` this function writes coming back in. Said in words here
  -- rather than surfaced as the trigger's raw text, and it names the door that
  -- is actually open — the pack, whole.
  if v_rule.compliance_pack_key is not null then
    raise exception 'compliance guardrail (%): it belongs to a pack, so it cannot be restored on its own — put the pack back instead, under Compliance & Guardrails or by hiring a role that needs it, and all of its rules come back together', v_rule.compliance_pack_key;
  end if;

  if v_rule.retired_at is null then
    return jsonb_build_object('ok', true, 'already_live', true,
      'rule_id', v_rule.id, 'active', v_rule.active, 'version', v_rule.version);
  end if;

  update guardrail_rules
     set retired_at = null,
         retired_by = null,
         -- ⚠ STAYS OFF. Un-retiring restores the row to the list; deciding to
         -- enforce it again is a separate, visible act on the Active toggle.
         active     = false,
         version    = version + 1
   where id = p_rule_id
  returning * into v_next;

  perform append_audit_event(
    v_rule.tenant_id, 'You', 'human',
    format('Guardrail restored — "%s" (%s). It is back in the list, still switched off.',
           v_rule.rule, v_rule.rule_type),
    'config_change',
    jsonb_build_object(
      'event', 'guardrail_restored',
      'rule_id', v_rule.id, 'rule', v_rule.rule, 'rule_type', v_rule.rule_type,
      'retired_at_was', v_rule.retired_at, 'version', v_next.version));

  return jsonb_build_object('ok', true, 'rule_id', v_next.id, 'active', false,
    'version', v_next.version);
end;
$function$;

-- ⚠ RESTATED, NOT ASSUMED. CREATE OR REPLACE preserves the existing ACL on THIS
-- database — but on a fresh one it CREATES the function, and a newly created
-- function carries the default PUBLIC EXECUTE grant. Migrations 610/630 exist
-- because that default has shipped a hole here before. The live grant today is
-- `authenticated` only (measured), and this says so out loud so a replay
-- reproduces it rather than widening it.
revoke all on function public.restore_guardrail_rule(uuid) from public, anon, service_role;
grant execute on function public.restore_guardrail_rule(uuid) to authenticated;

-- ==========================================================================
-- 6. decide_discovery_proposal — the hire says what it attached
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.decide_discovery_proposal(p_proposal_id uuid, p_decision text, p_note text DEFAULT NULL::text, p_created_object_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_p          public.discovery_proposals%rowtype;   -- the proposal, read once
  v_row        public.discovery_proposals%rowtype;   -- what the CAS claimed
  v_detail     jsonb;
  v_label      text;
  v_action     text;
  v_object_id  uuid;
  v_object_tbl text;
  v_writer     text;
  v_err        text;
  v_errstate   text;
  v_attempts   integer;

  -- ── added by 746, for the `employee` branch ──────────────────────────────
  v_arch       text;      -- the archetype key, off the payload
  v_name       text;      -- what the new employee is called, off the payload
  v_de_id      uuid;      -- what instantiate_role_archetype created
  v_kit        jsonb;     -- install_role_kit's own account of what it installed
  v_systems    integer;   -- install_role_systems' count, or 0 if it refused
  -- Everything the accept wants to be able to SAY afterwards, in one object
  -- that is merged into BOTH the return payload and the audit detail so the two
  -- can never disagree. Empty for every kind that does not fill it, so the
  -- connector branch's shape is byte-identical to what 741 returned.
  v_counters   jsonb := '{}'::jsonb;

  -- ── added by 747, for the `employee` branch ──────────────────────────────
  -- ⚠ A HIRE ATTACHES WORKSPACE-WIDE BLOCKING RULES AND SAID NOTHING. 7 of 15
  -- active archetypes carry a compliance pack; instantiate_role_archetype
  -- materialises its rules as guardrail_rules with applies_to='all',
  -- severity='blocking'. None of that reached a counter, an audit detail or a
  -- card, so a customer accepted controls they were never shown — the same
  -- §11b problem the guardrail card already solves for a single rule.
  --
  -- Measured as a BEFORE/AFTER DELTA rather than read off the archetype,
  -- because the two answer different questions: the archetype says which packs
  -- the role declares, the delta says how many rules THIS accept actually put
  -- in force. They differ whenever the workspace already had the pack, which is
  -- the common case for a second finance hire — and a card that claims two new
  -- blocking rules when it added none is the overclaim this file already
  -- refuses for guardrails and systems.
  v_pack_keys  text[];    -- what the role declares
  v_pack_before bigint;   -- active pack rules in the workspace before the hire
  v_pack_after  bigint;   -- ...and after
begin
  --------------------------------------------------------------------------
  -- ZONE 1 — refuse before touching anything. Every branch here RAISES, and
  -- nothing has been written when it does.
  --------------------------------------------------------------------------

  -- A null uid is refused on its own line and FIRST, for all three decisions.
  -- Folding this into the role predicate as `auth.uid() is not null and ...`
  -- is the exact bug in install_role_kit: it makes the authority check SKIP
  -- instead of FAIL. It applies to decline and park too, because a terminal
  -- state with a null decided_by is a decision nobody made.
  if auth.uid() is null then
    raise exception 'not authenticated: a discovery proposal is decided by a person, and the decision records which person';
  end if;

  select * into v_p from public.discovery_proposals where id = p_proposal_id;
  if v_p.id is null then
    raise exception 'unknown discovery proposal %', p_proposal_id;
  end if;

  if p_decision is null or p_decision not in ('accepted', 'declined', 'parked') then
    raise exception 'decide_discovery_proposal: % is not a decision — must be ''accepted'', ''declined'' or ''parked''',
      coalesce(p_decision, 'NULL');
  end if;

  -- The role bar. The tenant comes off the ROW (v_p.tenant_id), never from a
  -- parameter. Accept only: saying no is not gated.
  --
  -- ⚠ NO `p.layer = 'platform' or` DISJUNCT. A platform profile has
  -- tenant_id NULL and `profiles` is UNIQUE (user_id), so its holder can never
  -- satisfy append_audit_event's membership check. Admitting them here means
  -- passing the authority check and then aborting at the audit call OUTSIDE
  -- every sub-block — with the browser's connector already committed. Refuse
  -- in Zone 1, in words, before anything is claimed. See the header.
  if p_decision = 'accepted' then
    if not exists (
      select 1 from public.profiles p
       where p.user_id = auth.uid()
         and coalesce(p.is_active, true)
         and p.tenant_id = v_p.tenant_id
         and p.role in ('tenant_owner', 'tenant_admin')
    ) then
      raise exception 'only workspace owners and admins can accept a discovery proposal — declining and parking are open to anyone in the workspace';
    end if;
  end if;

  --------------------------------------------------------------------------
  -- ZONE 2 — THE CLAIM. This compare-and-swap is the double-click guard.
  -- It is OUTSIDE any sub-block on purpose: a writer's rollback in Zone 3
  -- must not be able to undo it.
  --
  -- 'parked' is in the admitted set because park is a pause. 'accepted' and
  -- 'declined' are not, so a second decision on either matches zero rows,
  -- leaves v_row NULL, and returns already_decided having written nothing.
  --
  -- ⚠ `and not (state = 'parked' and p_decision = 'parked')` is what makes PARK
  -- ITSELF IDEMPOTENT. Without it a double-clicked Park matches on 'parked',
  -- re-dates decided_at, writes a SECOND config_change audit row and returns
  -- ok=true twice — the same class of defect that logged one human's approval
  -- three times in 37 seconds. Parked → accepted and parked → declined are
  -- untouched by this clause; only parked → parked is refused.
  --------------------------------------------------------------------------
  update public.discovery_proposals
     set state      = p_decision,
         decided_by = auth.uid(),
         decided_at = now()
   where id        = p_proposal_id
     and tenant_id = v_p.tenant_id
     and state in ('pending', 'parked')
     and not (state = 'parked' and p_decision = 'parked')
  returning * into v_row;

  if v_row.id is null then
    return jsonb_build_object(
      'ok',          false,
      'error',       'already_decided',
      'proposal_id', p_proposal_id,
      'state',       (select state from public.discovery_proposals
                       where id = p_proposal_id and tenant_id = v_p.tenant_id));
  end if;

  --------------------------------------------------------------------------
  -- THE AUDIT DETAIL, BUILT ONCE, BEFORE THE BRANCH.
  --
  -- Built here rather than per-arm so that a decline cannot be dropped by
  -- someone editing a separate code path. The accept arm ADDS to it; no arm
  -- rebuilds it.
  --
  -- `payload` goes in WHOLE AND VERBATIM. It is the only copy of the literal
  -- the customer consented to, and the row it came from can be edited or
  -- deleted with no version history anywhere else — the same reasoning
  -- retire_guardrail_rule states in its own comment.
  --
  -- `decided_by` goes INSIDE detail. append_audit_event's hash covers
  -- prev_hash || tenant_id || action || detail::text || created_at. The
  -- `actor` COLUMN is not in the digest; `detail` is. The tamper-evident
  -- chain does not protect the identity column, so the identity is put where
  -- the chain reaches.
  --
  -- ⚠ append_audit_event, not _internal, and UNGUARDED: it raises on failure,
  -- so no audit row means no decision. Swallowing it is the deprecated
  -- resolve_account_writeback shape. Category MUST be 'config_change' — an
  -- invented category violates audit_events_category_check and aborts the
  -- decision, which is the mig-429 lesson.
  --------------------------------------------------------------------------
  v_label := coalesce(
    nullif(btrim(v_p.payload ->> 'name'), ''),
    nullif(btrim(v_p.payload ->> 'label'), ''),
    nullif(btrim(v_p.payload ->> 'rule'), ''),
    nullif(btrim(v_p.payload ->> 'archetype_key'), ''),
    nullif(btrim(v_p.payload ->> 'provider_key'), ''),
    'unnamed');

  v_detail := jsonb_build_object(
    'kind',             'discovery_proposal_decision',
    'decision',         p_decision,
    'proposal_id',      v_p.id,
    'session_id',       v_p.session_id,
    'proposal_kind',    v_p.kind,
    'source_dimension', v_p.source_dimension,
    'payload',          v_p.payload,
    'rationale',        v_p.rationale,
    'note',             nullif(btrim(p_note), ''),
    'decided_by',       auth.uid());

  v_action := format('Discovery proposal %s — %s (%s).', p_decision, v_label, v_p.kind);

  -- Decline and park end here. Both audited, for three reasons: there is no
  -- note column on the table, so an unaudited decline destroys the only
  -- sentence explaining why a customer refused; absence must be
  -- distinguishable from never-shown; and an unaudited park re-creates the
  -- invisible pile.
  if p_decision <> 'accepted' then
    perform public.append_audit_event(
      v_p.tenant_id, 'You', 'human', v_action, 'config_change', v_detail);

    return jsonb_build_object(
      'ok',                true,
      'state',             p_decision,
      'proposal_id',       v_p.id,
      'created_object_id', null);
  end if;

  --------------------------------------------------------------------------
  -- ZONE 3 — ACCEPT ONLY. Exactly ONE sub-block, for the whole accept.
  --
  -- ADDING A KIND IS ONE `when` BRANCH HERE AND NOTHING ELSE. A branch must
  -- set v_writer and v_object_tbl (they are what the audit line and the
  -- refusal record report) and end with v_object_id set to the thing that now
  -- exists, or raise with a sentence a person can read.
  --------------------------------------------------------------------------
  begin
    case v_p.kind

      -- ---- connector — Path B -------------------------------------------
      -- The browser already inserted the row as the signed-in human under
      -- RLS. This stamps it. It does NOT insert: an `insert into connectors`
      -- here runs as postgres, bypasses RLS entirely, and is the second
      -- creation engine the plan forbids.
      --
      -- ⚠ NO `data_access_grants` ROW IS WRITTEN, and that is load-bearing
      -- rather than an oversight. `poll_de_work_sources_targets` filters
      -- `c.status <> 'disconnected'`, which ADMITS 'pending_credentials', and
      -- joins to data_access_grants. The grant is what arms the poller.
      -- Withholding it is what makes the card's promise — "you still enter
      -- the credential yourself" — true on every traced path.
      when 'connector' then
        v_writer     := 'connectProvider -> connectors (client, under RLS), stamped here';
        v_object_tbl := 'connectors';

        if p_created_object_id is null then
          raise exception 'a connector proposal is accepted by creating the connector first: insert it as the signed-in person, then pass its id here (Path B)';
        end if;

        -- The id a caller hands us is NOT its own authorisation. It must be a
        -- connector already belonging to THIS proposal's tenant, or
        -- created_object_id would point at another workspace's row — or at
        -- nothing at all, which would satisfy the Task 5 certify assertion
        -- with garbage.
        if not exists (
          select 1 from public.connectors c
           where c.id = p_created_object_id
             and c.tenant_id = v_p.tenant_id
        ) then
          raise exception 'no connector % in this workspace — a created-object id is not its own authorisation', p_created_object_id;
        end if;

        v_object_id := p_created_object_id;

      -- ---- employee — Path A, ONE transaction ----------------------------
      -- THE FIRST KIND THIS FUNCTION CREATES ITSELF, and it can only because
      -- all three of its ordinary writers are SQL. `p_created_object_id` is
      -- IGNORED here: there is nothing for the browser to have made first, and
      -- `authenticated` holds only SELECT on digital_employees, which is
      -- exactly why this kind cannot be Path B.
      --
      -- The human hire is three RPCs in three transactions
      -- (src/lib/hireApi.ts:104-149) and has already stranded half-hired
      -- employees. This is one.
      when 'employee' then
        v_writer     := 'instantiate_role_archetype + install_role_kit + install_role_systems, inside decide_discovery_proposal';
        v_object_tbl := 'digital_employees';

        -- Both literals are read BEFORE anything is created, and refused in
        -- words. digital_employees.name is NOT NULL with no default (read live
        -- from pg_attribute), so a payload without one would otherwise reach
        -- the customer as `23502 null value in column "name"` — a sentence
        -- about a column nobody outside this file has heard of, written onto
        -- the card by migration 740's last_error and still there tomorrow.
        v_arch := nullif(btrim(v_p.payload ->> 'archetype_key'), '');
        v_name := nullif(btrim(v_p.payload ->> 'name'), '');
        if v_arch is null then
          raise exception 'this recommendation does not say which role to hire, so there is nothing to create — it carries no archetype_key';
        end if;
        if v_name is null then
          raise exception 'this recommendation does not say what to call the new employee, and an employee has to have a name';
        end if;

        -- 1. THE HIRE. Creates the digital_employees row at
        --    designed/supervised, attaches the archetype's mandatory compliance
        --    packs and materialises its PER-EMPLOYEE autonomy dials, so a hire
        --    never widens the workspace.
        --
        --    ⚠ It does NOT set is_workforce_assistant (live body, read via
        --    pg_get_functiondef), so the column takes its default of false: a
        --    discovery accept can never stamp the workspace's own admin desk,
        --    which is what scripts/discovery-proposal-check.mjs's `excluded`
        --    resolver arm refuses on every certify.
        --    ⚠ THE PACK COUNT IS TAKEN EITHER SIDE OF THIS CALL, because
        --    instantiate_role_archetype returns only a uuid and the pack attach
        --    happens inside it. Counting `active and retired_at is null` on
        --    both sides means a pack the workspace already held contributes 0,
        --    and a pack whose rules were previously RETIRED by a detach and are
        --    revived here contributes them — which is exactly what a person
        --    needs to be told, since revived rules start blocking again.
        select count(*) into v_pack_before
          from public.guardrail_rules g
         where g.tenant_id = v_p.tenant_id
           and g.compliance_pack_key is not null
           and g.active and g.retired_at is null;
        select coalesce(a.compliance_pack_keys, '{}'::text[]) into v_pack_keys
          from public.role_archetypes a where a.key = v_arch;

        v_de_id := public.instantiate_role_archetype(
                     v_p.tenant_id, v_arch, v_name, null);
        if v_de_id is null then
          raise exception 'the hire returned no employee';
        end if;

        select count(*) into v_pack_after
          from public.guardrail_rules g
         where g.tenant_id = v_p.tenant_id
           and g.compliance_pack_key is not null
           and g.active and g.retired_at is null;

        -- 2. THE KIT — its Book of Work watchers, its published SOP and its
        --    role guardrails. DELIBERATELY UNGUARDED. This is what makes the
        --    new employee an employee rather than a row, so a failure here must
        --    take the whole accept down: the sub-block below rolls the employee
        --    back and the card returns to the deck with the reason on it.
        --    Probe 13 forces exactly that and asserts no employee is left
        --    behind — the asymmetry with step 3 is a claim, so it is driven.
        v_kit := public.install_role_kit(v_de_id, v_arch);

        -- 3. THE SYSTEMS — additive, and therefore in their OWN nested block.
        --
        --    ⚠⚠ THIS NESTING IS LOAD-BEARING, and it is not a style choice.
        --    install_role_systems opens with
        --        IF NOT coalesce(can_admin_tenant_internal(<the DE's tenant>),
        --                        false) THEN RAISE EXCEPTION 'not permitted';
        --    and can_admin_tenant_internal admits service_role or
        --    tenant_owner/tenant_admin only. Un-nested, that refusal — and
        --    every other way this step can fail — would abort the hire and undo
        --    the kit as well, for a step the product has always treated as
        --    additive. apply_role_kit_to_employee wraps it exactly this way;
        --    hireApi.ts means to and cannot, because .rpc() resolves on a
        --    Postgres error and its catch is dead code.
        --
        --    ⚠ coalesce, because a SQL function returning NULL would otherwise
        --    put a null into a counter the screen prints as a number.
        begin
          v_systems := coalesce(public.install_role_systems(v_de_id, v_arch), 0);
        exception when others then
          v_systems := 0;
        end;

        -- WHAT THE SCREEN IS ALLOWED TO SAY. A SILENT ZERO IS THE DEFECT: the
        -- existing hire wizard prints "0 connected systems" identically for
        -- "this archetype has none" and "the systems step refused", and there
        -- is no way from the outside to tell which happened. These travel in
        -- the return payload AND the audit detail, from ONE object, so the two
        -- accounts cannot drift.
        --
        -- sop_snapshot_published is here because install_role_kit already
        -- reports it honestly (false for every SOP archetype — an SOP is
        -- compiled by de-work, never run by playbook-execute) while the card
        -- asserts comes_with_published_sop unconditionally. The accept should
        -- be able to contradict the card.
        v_counters := jsonb_build_object(
          'archetype_key',          v_arch,
          -- ⚠ THREE numbers, not one, for the reason systems_installed has a
          -- sentence of its own above: "0 new blocking rules" and "this
          -- workspace has no compliance rules at all" are opposite facts and
          -- read identically as a bare zero. in_force is what tells them apart,
          -- and packs_attached names WHICH controls, since a rule the customer
          -- cannot name is a rule they cannot consent to.
          'compliance_packs_attached', to_jsonb(coalesce(v_pack_keys, '{}'::text[])),
          'compliance_rules_created',  greatest(coalesce(v_pack_after, 0) - coalesce(v_pack_before, 0), 0),
          'compliance_rules_in_force', coalesce(v_pack_after, 0),
          'systems_installed',      v_systems,
          'watchers_created',       coalesce((v_kit ->> 'watchers_created')::integer, 0),
          'watchers_skipped',       coalesce((v_kit ->> 'watchers_skipped')::integer, 0),
          'guardrails_created',     coalesce((v_kit ->> 'guardrails_created')::integer, 0),
          'sop_playbook_id',        v_kit ->> 'sop_playbook_id',
          'sop_snapshot_published', coalesce((v_kit ->> 'sop_snapshot_published')::boolean, false));

        v_object_id := v_de_id;

      -- ---- every other kind ---------------------------------------------
      -- procedure, guardrail, trust_rule, conversation_type. All four are
      -- admitted by discovery_proposals_kind_check, so this refusal is the
      -- ROUTER's and nothing else's. Each ships in its own task, in risk order.
      -- A kind with no writer must say so. Probe 7 fires this for `guardrail`
      -- and probe 14 for `procedure` and `trust_rule`, so "the router did not
      -- swing open when employee was added" is a comparison, not a hope.
      else
        raise exception 'kind not yet routable: %', v_p.kind;

    end case;

    -- Belt and braces for a future branch that forgets: never leave Zone 3
    -- with the state claimed and nothing created.
    if v_object_id is null then
      raise exception 'writer_returned_no_object';
    end if;

  exception when others then
    -- ⚠ ONLY variable capture. Everything the failed writer wrote is already
    -- rolled back by the time this line runs, and anything written HERE would
    -- roll back too. The record of the failure is made below, outside.
    -- ⚠ `sqlstate`, NOT `returned_sqlstate`. RETURNED_SQLSTATE is a GET STACKED
    -- DIAGNOSTICS ITEM NAME, not an identifier: only SQLSTATE and SQLERRM exist
    -- in a handler's namespace. plpgsql defers expression parsing to first
    -- execution, so `returned_sqlstate` here compiled fine and then raised
    -- 42703 `column "returned_sqlstate" does not exist` INSIDE the handler on
    -- the first refusal — escaping this block and killing the entire
    -- revert-to-pending / last_error / attempts / refusal-audit arm below.
    -- The shipped precedent is migration 738's `v_null_sqlstate := sqlstate;`.
    v_err      := sqlerrm;
    v_errstate := sqlstate;
  end;

  --------------------------------------------------------------------------
  -- OUTSIDE the sub-block. These writes commit with the rest of the
  -- transaction — migration 525's pattern.
  --------------------------------------------------------------------------
  if v_err is not null then
    update public.discovery_proposals
       set state         = 'pending',
           decided_by    = null,
           decided_at    = null,
           last_error    = left(v_err, 500),
           last_error_at = now(),
           attempts      = attempts + 1
     where id = p_proposal_id and tenant_id = v_p.tenant_id
    returning attempts into v_attempts;

    v_detail := v_detail || jsonb_build_object(
      'outcome',                'refused',
      'error',                  left(v_err, 500),
      'sqlstate',               v_errstate,
      'attempts',               v_attempts,
      'writer',                 v_writer,
      'attempted_object_table', v_object_tbl);

    perform public.append_audit_event(
      v_p.tenant_id, 'You', 'human',
      format('Discovery proposal could not be accepted — %s (%s): %s', v_label, v_p.kind, left(v_err, 200)),
      'config_change', v_detail);

    return jsonb_build_object(
      'ok',          false,
      'state',       'pending',
      'proposal_id', v_p.id,
      'error',       v_err,
      'sqlstate',    v_errstate,
      'attempts',    v_attempts);
  end if;

  -- The accept succeeded. state='accepted' (Zone 2) and created_object_id
  -- (here) commit together; neither can be observed without the other.
  update public.discovery_proposals
     set created_object_id = v_object_id,
         last_error        = null,
         last_error_at     = null
   where id = p_proposal_id and tenant_id = v_p.tenant_id;

  -- ⚠ `|| v_counters` on BOTH, from the SAME variable. The audit line and the
  -- answer the screen prints are then the same sentence read twice — a card
  -- saying "0 connected systems" can be checked against the audit trail rather
  -- than believed. For every kind that does not fill it, v_counters is '{}' and
  -- both shapes are byte-identical to what migration 741 returned.
  v_detail := v_detail || jsonb_build_object(
    'outcome',              'created',
    'writer',               v_writer,
    'created_object_table', v_object_tbl,   -- a bare uuid with no table name
    'created_object_id',    v_object_id)    -- is not reconstructable later
    || v_counters;

  perform public.append_audit_event(
    v_p.tenant_id, 'You', 'human', v_action, 'config_change', v_detail);

  return jsonb_build_object(
    'ok',                   true,
    'state',                'accepted',
    'proposal_id',          v_p.id,
    'created_object_table', v_object_tbl,
    'created_object_id',    v_object_id)
    || v_counters;
end;
$function$;


-- ==========================================================================
-- 7. VERIFICATION — every pin inverted, everything rolled back
-- ==========================================================================
do $verify$
declare
  v_caller        text;
  v_seen_role     text;
  v_bad           text[] := '{}';
  v_checks        integer := 0;
  v_probes        integer := 0;

  v_tenant        uuid;
  v_admin_uid     uuid;
  -- ⚠ THE FIXTURE IS SPLIT, AND IT HAS TO BE. The first version of this block
  -- asked ONE workspace to be both pack-free AND to hold a non-owner/admin
  -- member. Measured on 2026-08-16, conjunct by conjunct: 15 owner workspaces →
  -- 11 pack-free → 0 that also hold a non-admin member. Those two conjuncts are
  -- MUTUALLY EXCLUSIVE on this data — the only 2 non-admin members in the whole
  -- database are in outsourcetel-hq, which holds all three packs. v_tenant came
  -- back NULL, the VACUITY guard raised, and this migration could not apply at
  -- all: zero DDL, zero probes, nothing compared.
  --
  -- ⚠ AND RELAXING THE PACK-FREE CONJUNCT IS NOT THE FIX. Probe 2 must run
  -- against the tenant_user's OWN workspace or it stops being probe 2: an
  -- outsider refused by a workspace they are not in is probe 3, refused for
  -- cross-tenancy rather than for role, and the two would prove the same single
  -- thing twice. So probe 2 gets its own pair — a workspace that HAS such a
  -- member, plus any pack key, since it asserts a refusal and writes nothing —
  -- and everything that actually attaches and detaches keeps the pack-free
  -- workspace it needs to start from a known floor.
  v_member_tenant uuid;
  v_member_pack   text;
  v_user_uid      uuid;
  v_other_tenant  uuid;
  v_other_admin   uuid;
  v_pack          text;
  v_pack_rules    integer;
  v_types         text[];
  v_arch          text;
  v_free_arch     text;   -- an active archetype carrying NO pack (probe 13)
  v_platform_uid  uuid;   -- a platform profile (probe 13)
  v_null_uid      uuid;   -- owner/admin whose OWN profile has tenant_id NULL (probe 11b)

  -- baselines
  v_gr_before     bigint;
  v_tcp_before    bigint;
  v_audit_before  bigint;
  v_de_before     bigint;
  v_gr_after      bigint;
  v_tcp_after     bigint;
  v_audit_after   bigint;
  v_de_after      bigint;

  -- probe 1 (no identity)
  v_d1            boolean := false;
  v_p1_uid        uuid;
  v_p1_att_ref    boolean := false;
  v_p1_att_msg    text;
  v_p1_det_ref    boolean := false;
  v_p1_det_msg    text;

  -- probe 2 (tenant_user) / 3 (foreign owner)
  v_d2            boolean := false;
  v_p2_att_ref    boolean := false;
  v_p2_att_msg    text;
  v_p2_det_ref    boolean := false;
  v_p2_det_msg    text;
  v_p3_att_ref    boolean := false;
  v_p3_att_msg    text;
  v_p3_det_ref    boolean := false;
  v_p3_det_msg    text;

  -- probes 4-9 (the owner's own lifecycle)
  v_d4            boolean := false;
  v_att           integer;
  v_att_live      bigint;
  v_att_blocking  bigint;
  v_att_allscope  bigint;
  v_tcp_row       bigint;
  v_ids_before    uuid[];
  v_resolver_pre  bigint;
  v_det           jsonb;
  v_rows_after    bigint;
  v_retired_n     bigint;
  v_live_after    bigint;
  v_tcp_after_det bigint;
  v_resolver_post bigint;
  v_ids_after     uuid[];
  v_guc           text;
  v_del_refused   boolean := false;
  v_del_msg       text;
  v_upd_refused   boolean := false;
  v_upd_msg       text;
  v_re            integer;
  v_rows_re       bigint;
  v_live_re       bigint;
  v_ids_re        uuid[];
  v_aud_att       jsonb;
  v_aud_det       jsonb;
  v_a_rule        text;
  v_first_rule    text;
  v_some_rule_id  uuid;
  v_live_rule_id  uuid;

  -- probe 10 (service-role hire)
  v_d10           boolean := false;
  v_p10_de        uuid;
  v_p10_ok        boolean := false;
  v_p10_msg       text;
  v_p10_packs     bigint;
  v_p10_anon_ok   boolean := false;
  v_p10_anon_msg  text;

  -- probe 11 (the guard that evaluated to NULL)
  v_d11           boolean := false;
  v_p11a_ref      boolean := false;   -- attach(NULL, pack) by a real owner
  v_p11a_msg      text;
  v_p11b_ran      boolean := false;   -- the null-tenant profile fixture existed
  v_p11b_ref      boolean := false;
  v_p11b_msg      text;
  v_p11b_uid      uuid;

  -- probe 12 (decide_discovery_proposal actually driven)
  v_d12           boolean := false;
  v_p12_sess      uuid;
  v_p12_prop      uuid;
  v_p12_res       jsonb;
  v_p12_before    bigint;
  v_p12_after     bigint;
  v_p12_de        bigint;
  v_p12_keys      text[];

  -- probe 13 (the platform operator's hire)
  v_d13           boolean := false;
  v_p13_ref       boolean := false;
  v_p13_msg       text;
  v_p13_de_n      bigint;
  v_p13_free_ok   boolean := false;
  v_p13_free_msg  text;

  -- static
  v_att_body      text;
  v_int_body      text;
  v_det_body      text;
  v_inst_body     text;
  v_ddp_body      text;
  v_res_body      text;
begin
  v_caller := current_user::text;

  ------------------------------------------------------------------------
  -- CAN THIS BLOCK IMPERSONATE AT ALL? Asked by DOING it. Every refusal below
  -- is a claim about what the runtime role `authenticated` can do; without the
  -- switch they would run as the migration's own role, which holds EXECUTE on
  -- everything, and every "refused" would be a statement about postgres.
  ------------------------------------------------------------------------
  begin
    set local role authenticated;
    v_seen_role := current_user::text;
    execute format('set local role %I', v_caller);
  exception when others then
    raise exception '747: cannot switch to role authenticated and back to % (%: %) — the probes below would not be testing the runtime role they claim to test, so this migration refuses to apply rather than report a clean run it did not measure',
      v_caller, sqlstate, sqlerrm;
  end;
  if v_seen_role is distinct from 'authenticated' then
    raise exception '747: the role switch reported current_user=% rather than authenticated', coalesce(v_seen_role, 'NULL');
  end if;

  ------------------------------------------------------------------------
  -- FIXTURES — chosen from live data, never hardcoded, and every one guarded
  -- for vacuity. A missing fixture is a FAILURE here, not a quiet pass: a
  -- migration that applies having compared nothing is the exact shape of the
  -- gate that had never fired.
  ------------------------------------------------------------------------
  -- ── FIXTURE A: the workspace the lifecycle probes ACT on. Pack-free, so
  --    probes 4-9 start from a known floor and their counts cannot be read as a
  --    statement about somebody's real compliance posture. No non-admin-member
  --    conjunct — see the declaration note; that conjunct is what made this
  --    query return zero rows and the whole migration unappliable.
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
     and not exists (select 1 from public.tenant_compliance_packs tc
                      where tc.tenant_id = p.tenant_id)
   order by p.created_at
   limit 1;

  -- ── FIXTURE B: probe 2's pair. A real member of a real workspace who is
  --    NEITHER owner NOR admin, tested against THEIR OWN workspace — anything
  --    else collapses probe 2 into probe 3. This workspace may well already hold
  --    packs; that is fine and is why the pack key here is chosen from the
  --    CATALOGUE rather than from what is unattached: probe 2 asserts a refusal
  --    and writes nothing, so the workspace's real posture is never touched.
  select u.tenant_id, u.user_id
    into v_member_tenant, v_user_uid
    from public.profiles u
    join public.tenants t on t.id = u.tenant_id
   where u.layer = 'tenant'
     and u.role not in ('tenant_owner', 'tenant_admin')
     and coalesce(u.is_active, true)
     and t.status in ('active', 'trial')
     and not exists (select 1 from public.profiles q
                      where q.user_id = u.user_id and q.layer = 'platform')
   order by u.created_at
   limit 1;

  select cp.key into v_member_pack
    from public.compliance_packs cp
   where exists (select 1 from public.compliance_pack_rules r where r.pack_key = cp.key)
   order by cp.key
   limit 1;

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

  -- A pack with real rules that this workspace has never materialised.
  select cp.key into v_pack
    from public.compliance_packs cp
   where exists (select 1 from public.compliance_pack_rules r where r.pack_key = cp.key)
     and not exists (select 1 from public.guardrail_rules g
                      where g.tenant_id = v_tenant and g.compliance_pack_key = cp.key)
   order by cp.key
   limit 1;

  -- An active archetype that ACTUALLY CARRIES a pack — probe 10 is meaningless
  -- against one that does not, and would pass on an empty loop.
  select a.key into v_arch
    from public.role_archetypes a
   where a.status = 'active'
     and coalesce(array_length(a.compliance_pack_keys, 1), 0) > 0
   order by a.key
   limit 1;

  -- ...and one that carries NONE. Probe 13's inversion: without it, "a platform
  -- operator is refused" would be indistinguishable from "a platform operator
  -- can no longer hire anything", which is not what section 4 does and would be
  -- a much bigger regression than the one being made deliberately.
  select a.key into v_free_arch
    from public.role_archetypes a
   where a.status = 'active'
     and coalesce(array_length(a.compliance_pack_keys, 1), 0) = 0
   order by a.key
   limit 1;

  -- A platform profile — the god-mode hire probe 13 drives. Measured 2 live,
  -- both with tenant_id NULL, which is exactly why append_audit_event refuses
  -- them and why section 4 refuses them earlier.
  select p.user_id into v_platform_uid
    from public.profiles p
   where p.layer = 'platform'
     and coalesce(p.is_active, true)
   order by p.user_id
   limit 1;

  -- ⚠ OPTIONAL BY DESIGN, and its ABSENCE IS ALSO CHECKED (probe 11b). This is
  -- the live shape that makes can_admin_tenant_internal return NULL rather than
  -- FALSE: an owner/admin profile whose own tenant_id is NULL, so
  -- auth_tenant_id() is NULL while auth_has_tenant_role — which is not
  -- tenant-scoped — is TRUE. One such row existed on 2026-08-16. It is NOT in
  -- the vacuity guard: if somebody later gives that profile a tenant_id, this
  -- migration must not become unappliable, and probe 11a covers the same NULL
  -- through a door that needs no fixture at all.
  select p.user_id into v_null_uid
    from public.profiles p
   where p.tenant_id is null
     and p.layer = 'tenant'
     and p.role in ('tenant_owner', 'tenant_admin')
     and coalesce(p.is_active, true)
   order by p.user_id
   limit 1;

  if v_tenant is null or v_user_uid is null or v_member_tenant is null
     or v_member_pack is null or v_other_admin is null
     or v_pack is null or v_arch is null or v_free_arch is null
     or v_platform_uid is null then
    raise exception '747: VACUITY — fixtures could not be assembled (act-on tenant=% owner=% member tenant=% non-admin member=% member pack=% foreign owner=% unattached pack=% pack-carrying archetype=% pack-free archetype=% platform profile=%). A missing fixture is not a pass: probe 2 could not tell "refused for the role" from "refused for no identity", probe 3 could not fire the cross-tenant refusal, probe 10 could not prove the service-role hire still works, and probe 13 could not prove the platform refusal is narrow rather than total.',
      coalesce(v_tenant::text,'NULL'), coalesce(v_admin_uid::text,'NULL'),
      coalesce(v_member_tenant::text,'NULL'), coalesce(v_user_uid::text,'NULL'),
      coalesce(v_member_pack,'NULL'), coalesce(v_other_admin::text,'NULL'),
      coalesce(v_pack,'NULL'), coalesce(v_arch,'NULL'),
      coalesce(v_free_arch,'NULL'), coalesce(v_platform_uid::text,'NULL');
  end if;

  select count(*) into v_pack_rules from public.compliance_pack_rules where pack_key = v_pack;
  select array_agg(distinct rule_type) into v_types from public.compliance_pack_rules where pack_key = v_pack;
  select r.rule into v_first_rule from public.compliance_pack_rules r where r.pack_key = v_pack order by r.rule limit 1;

  -- Baselines scoped to the probe tenants only. A global count re-read at the
  -- end of the same READ COMMITTED transaction would go red because some
  -- unrelated workspace committed a row while this ran.
  --
  -- ⚠ v_member_tenant IS IN THIS LIST even though probe 2 only asserts refusals.
  -- That workspace holds REAL attached packs — it is the only kind of workspace
  -- that can hold a non-admin member on this data — so "probe 2's detach was
  -- refused" and "probe 2's detach ran and rolled back" must be distinguishable
  -- afterwards, not just believed from the refusal flag.
  select count(*) into v_gr_before    from public.guardrail_rules where tenant_id in (v_tenant, v_other_tenant, v_member_tenant);
  select count(*) into v_tcp_before   from public.tenant_compliance_packs where tenant_id in (v_tenant, v_other_tenant, v_member_tenant);
  select count(*) into v_audit_before from public.audit_events where tenant_id in (v_tenant, v_other_tenant, v_member_tenant)
     and detail ->> 'event' in ('compliance_pack_attached', 'compliance_pack_detached');
  select count(*) into v_de_before    from public.digital_employees where tenant_id in (v_tenant, v_other_tenant, v_member_tenant)
     and coalesce(is_workforce_assistant, false) = false;

  ------------------------------------------------------------------------
  -- PROBE 1 — NO IDENTITY AT ALL. This is the fail-open fix, fired.
  --
  -- ⚠ BOTH GUCs cleared: auth.uid() falls back from request.jwt.claim.sub to
  -- request.jwt.claims->>'sub', so clearing one leaves a fallback. auth.uid() is
  -- asserted null below precisely so "refused" cannot be mistaken for "the probe
  -- failed to drop the identity" — a refusal for the wrong reason is no evidence.
  --
  -- RED BEFORE THIS MIGRATION: with `auth.uid() is not null and` in front of the
  -- check, both calls SUCCEEDED here.
  ------------------------------------------------------------------------
  begin
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims',    '', true);
    select auth.uid() into v_p1_uid;

    set local role authenticated;
    begin
      perform public.attach_compliance_pack(v_tenant, v_pack);
    exception when others then
      v_p1_att_ref := true; v_p1_att_msg := sqlerrm;
    end;
    begin
      perform public.detach_compliance_pack(v_tenant, v_pack);
    exception when others then
      v_p1_det_ref := true; v_p1_det_msg := sqlerrm;
    end;
    execute format('set local role %I', v_caller);

    v_d1 := true;
    raise exception using errcode = 'P0001', message = '__undo__';
  exception when others then
    execute format('set local role %I', v_caller);
    if sqlerrm <> '__undo__' then
      v_bad := array_append(v_bad, format('PROBE 1 ABORTED (%s: %s) — the null-identity refusal was NOT compared this run', sqlstate, sqlerrm));
      v_d1 := false;
    end if;
  end;

  if v_d1 then
    v_probes := v_probes + 1;
    v_checks := v_checks + 1;
    if v_p1_uid is not null then
      v_bad := array_append(v_bad, format('the probe could not clear the identity (auth.uid()=%L) — everything below would be a claim about some other refusal', v_p1_uid::text));
    end if;
    v_checks := v_checks + 1;
    if not v_p1_att_ref then
      v_bad := array_append(v_bad, 'A CALLER WITH NO IDENTITY ATTACHED A COMPLIANCE PACK — the `auth.uid() is not null and` prefix is back, and the authority check is skipped rather than failed');
    elsif coalesce(v_p1_att_msg, '') not like 'not authenticated%' then
      v_bad := array_append(v_bad, format('attach refused the unidentified caller, but not by the identity bar: %L', coalesce(v_p1_att_msg, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if not v_p1_det_ref then
      v_bad := array_append(v_bad, 'A CALLER WITH NO IDENTITY DETACHED A COMPLIANCE PACK — blocking compliance controls can be removed from any workspace by nobody at all');
    elsif coalesce(v_p1_det_msg, '') not like 'not authenticated%' then
      v_bad := array_append(v_bad, format('detach refused the unidentified caller, but not by the identity bar: %L', coalesce(v_p1_det_msg, 'NULL')));
    end if;
  end if;

  ------------------------------------------------------------------------
  -- PROBES 2 + 3 — a member who is not an admin, and an admin of ANOTHER
  -- workspace. Both are real identities, so a refusal here is about authority
  -- rather than about identity — which is what makes probe 1 mean something.
  --
  -- ⚠ PROBE 2 RUNS AGAINST THE MEMBER'S OWN WORKSPACE (v_member_tenant), NOT
  -- v_tenant. Pointed at a workspace they are not in, a tenant_user would be
  -- refused for cross-tenancy — which is probe 3 — and "refused for being a
  -- tenant_user" would never have been tested at all. This is the whole reason
  -- the fixture is split.
  --
  -- ⚠ AND BOTH PROBES NOW READ THE MESSAGE. Accepting any exception makes a
  -- wrong-reason refusal look like a right one: probe 2 must be stopped by the
  -- ROLE bar, not by the identity bar it would hit with no jwt set, and not by
  -- an unrelated 23502 or 42501.
  ------------------------------------------------------------------------
  begin
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', v_user_uid::text, true);
    set local role authenticated;
    begin
      perform public.attach_compliance_pack(v_member_tenant, v_member_pack);
    exception when others then
      v_p2_att_ref := true; v_p2_att_msg := sqlerrm;
    end;
    begin
      perform public.detach_compliance_pack(v_member_tenant, v_member_pack);
    exception when others then
      v_p2_det_ref := true; v_p2_det_msg := sqlerrm;
    end;
    execute format('set local role %I', v_caller);

    perform set_config('request.jwt.claim.sub', v_other_admin::text, true);
    set local role authenticated;
    begin
      perform public.attach_compliance_pack(v_tenant, v_pack);
    exception when others then
      v_p3_att_ref := true; v_p3_att_msg := sqlerrm;
    end;
    begin
      perform public.detach_compliance_pack(v_tenant, v_pack);
    exception when others then
      v_p3_det_ref := true; v_p3_det_msg := sqlerrm;
    end;
    execute format('set local role %I', v_caller);

    v_d2 := true;
    raise exception using errcode = 'P0001', message = '__undo__';
  exception when others then
    execute format('set local role %I', v_caller);
    if sqlerrm <> '__undo__' then
      v_bad := array_append(v_bad, format('PROBES 2/3 ABORTED (%s: %s) — the role and cross-tenant refusals were NOT compared this run', sqlstate, sqlerrm));
      v_d2 := false;
    end if;
  end;

  if v_d2 then
    v_probes := v_probes + 2;
    v_checks := v_checks + 1;
    if not v_p2_att_ref then
      v_bad := array_append(v_bad, format('a member who is NOT an owner or admin attached a compliance pack to their OWN workspace %s', v_member_tenant));
    elsif coalesce(v_p2_att_msg, '') not like 'not authorized to attach%' then
      v_bad := array_append(v_bad, format('the non-admin member''s attach was refused, but NOT by the role bar: %L. A refusal for the wrong reason is not evidence that role is checked — this probe exists to tell "you are not an admin" apart from "you are nobody".', coalesce(v_p2_att_msg, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if not v_p2_det_ref then
      v_bad := array_append(v_bad, format('a member who is NOT an owner or admin detached a compliance pack from their OWN workspace %s — real blocking rules came off a real workspace', v_member_tenant));
    elsif coalesce(v_p2_det_msg, '') not like '%owners and admins can take a compliance pack off%' then
      v_bad := array_append(v_bad, format('the non-admin member''s detach was refused, but NOT by the role bar: %L', coalesce(v_p2_det_msg, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if not v_p3_att_ref then
      v_bad := array_append(v_bad, format('an owner of ANOTHER workspace attached a pack to tenant %s — the tenant-id parameter is being taken as authorisation (migs 662-664)', v_tenant));
    elsif coalesce(v_p3_att_msg, '') not like 'not authorized to attach%' then
      v_bad := array_append(v_bad, format('the foreign owner''s attach was refused, but not by the authority bar: %L', coalesce(v_p3_att_msg, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if not v_p3_det_ref then
      v_bad := array_append(v_bad, format('an owner of ANOTHER workspace detached a pack from tenant %s', v_tenant));
    elsif coalesce(v_p3_det_msg, '') not like '%owners and admins can take a compliance pack off%' then
      v_bad := array_append(v_bad, format('the foreign owner''s detach was refused, but not by the authority bar: %L', coalesce(v_p3_det_msg, 'NULL')));
    end if;
  end if;

  ------------------------------------------------------------------------
  -- PROBES 4-9 — THE WHOLE LIFECYCLE, as the workspace's own owner. This arm is
  -- also THE INVERSION for probes 1-3: if attach and detach refused everybody,
  -- every refusal above would be worthless.
  --
  --   4  the owner succeeds and the rules are really materialised
  --   5  detach RETIRES: same rows, retired_at set, active false, nothing deleted
  --   6  the runtime resolver stops returning them
  --   7  re-attach revives the SAME rows and creates no duplicates
  --   8  both actions left an audit row carrying the pack key and the rule text
  --   9  the trigger still refuses a bare DELETE and a bare deactivation
  ------------------------------------------------------------------------
  begin
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);

    -- ── 4. attach ──────────────────────────────────────────────────────
    set local role authenticated;
    v_att := public.attach_compliance_pack(v_tenant, v_pack);
    execute format('set local role %I', v_caller);

    select count(*), count(*) filter (where severity = 'blocking'),
           count(*) filter (where applies_to = 'all'), array_agg(id order by rule)
      into v_att_live, v_att_blocking, v_att_allscope, v_ids_before
      from public.guardrail_rules
     where tenant_id = v_tenant and compliance_pack_key = v_pack
       and active and retired_at is null;
    select count(*) into v_tcp_row from public.tenant_compliance_packs
     where tenant_id = v_tenant and pack_key = v_pack;

    -- ── 6a. the resolver sees them BEFORE ──────────────────────────────
    select count(*) into v_resolver_pre
      from public.guardrail_rules_for_de(v_tenant, null::uuid, v_types) g
     where g.compliance_pack_key = v_pack;

    -- ── 5. detach ──────────────────────────────────────────────────────
    set local role authenticated;
    v_det := public.detach_compliance_pack(v_tenant, v_pack);
    execute format('set local role %I', v_caller);

    select count(*), count(*) filter (where retired_at is not null),
           count(*) filter (where active), array_agg(id order by rule)
      into v_rows_after, v_retired_n, v_live_after, v_ids_after
      from public.guardrail_rules
     where tenant_id = v_tenant and compliance_pack_key = v_pack;
    select count(*) into v_tcp_after_det from public.tenant_compliance_packs
     where tenant_id = v_tenant and pack_key = v_pack;

    -- ── 6b. the resolver no longer sees them ───────────────────────────
    select count(*) into v_resolver_post
      from public.guardrail_rules_for_de(v_tenant, null::uuid, v_types) g
     where g.compliance_pack_key = v_pack;

    -- ── 9. the gate must have SHUT again. Same transaction, right after a
    --      successful detach — this is where a transaction-local GUC left 'on'
    --      would show up.
    v_guc := coalesce(current_setting('app.allow_compliance_change', true), '');
    select id into v_some_rule_id from public.guardrail_rules
     where tenant_id = v_tenant and compliance_pack_key = v_pack limit 1;
    begin
      delete from public.guardrail_rules where id = v_some_rule_id;
    exception when others then
      v_del_refused := true; v_del_msg := sqlerrm;
    end;

    -- ── 7. re-attach ───────────────────────────────────────────────────
    set local role authenticated;
    v_re := public.attach_compliance_pack(v_tenant, v_pack);
    execute format('set local role %I', v_caller);

    select count(*), count(*) filter (where active and retired_at is null),
           array_agg(id order by rule)
      into v_rows_re, v_live_re, v_ids_re
      from public.guardrail_rules
     where tenant_id = v_tenant and compliance_pack_key = v_pack;

    -- ── 9b. deactivating a LIVE pack rule outside detach is still refused ──
    select id into v_live_rule_id from public.guardrail_rules
     where tenant_id = v_tenant and compliance_pack_key = v_pack and active limit 1;
    begin
      update public.guardrail_rules set active = false where id = v_live_rule_id;
    exception when others then
      v_upd_refused := true; v_upd_msg := sqlerrm;
    end;

    -- ── 8. the audit rows ──────────────────────────────────────────────
    select detail into v_aud_att from public.audit_events
     where tenant_id = v_tenant and detail ->> 'event' = 'compliance_pack_attached'
     order by created_at desc limit 1;
    select detail into v_aud_det from public.audit_events
     where tenant_id = v_tenant and detail ->> 'event' = 'compliance_pack_detached'
     order by created_at desc limit 1;

    v_d4 := true;
    raise exception using errcode = 'P0001', message = '__undo__';
  exception when others then
    execute format('set local role %I', v_caller);
    if sqlerrm <> '__undo__' then
      v_bad := array_append(v_bad, format('PROBES 4-9 ABORTED (%s: %s) — the attach/retire/resolver/re-attach/audit/trigger chain was NOT compared this run, so every refusal in probes 1-3 is unbacked', sqlstate, sqlerrm));
      v_d4 := false;
    end if;
  end;

  if v_d4 then
    v_probes := v_probes + 6;

    -- 4
    v_checks := v_checks + 1;
    if coalesce(v_att, -1) <> v_pack_rules then
      v_bad := array_append(v_bad, format('attach reported %L rules put in force, the pack catalogue holds %s', coalesce(v_att::text,'NULL'), v_pack_rules));
    end if;
    v_checks := v_checks + 1;
    if v_att_live <> v_pack_rules or v_att_blocking <> v_pack_rules or v_att_allscope <> v_pack_rules then
      v_bad := array_append(v_bad, format('after attach: %s live rules (%s blocking, %s applies_to=all) for %s catalogue rules — the pack did not materialise as workspace-wide blocking controls', v_att_live, v_att_blocking, v_att_allscope, v_pack_rules));
    end if;
    v_checks := v_checks + 1;
    if v_tcp_row <> 1 then
      v_bad := array_append(v_bad, format('tenant_compliance_packs holds %s row(s) for this pack after attach, expected 1', v_tcp_row));
    end if;

    -- 5
    v_checks := v_checks + 1;
    if v_rows_after <> v_att_live then
      v_bad := array_append(v_bad, format('DETACH DELETED ROWS: %s rule row(s) before, %s after. Migration 726 added retired_at to guardrail_rules so this exact removal keeps the record of what the rule said, and so a guardrail_block from months ago still has something to point at', v_att_live, v_rows_after));
    end if;
    v_checks := v_checks + 1;
    if v_retired_n <> v_rows_after or coalesce(v_live_after, -1) <> 0 then
      v_bad := array_append(v_bad, format('after detach: %s of %s rows carry retired_at and %s are still active — retiring is what stops enforcement, and both facts have to move together', v_retired_n, v_rows_after, v_live_after));
    end if;
    v_checks := v_checks + 1;
    if v_ids_after is distinct from v_ids_before then
      v_bad := array_append(v_bad, 'the rule ids changed across a detach — the rows were replaced rather than retired, so every audit event pointing at an old id is now orphaned');
    end if;
    v_checks := v_checks + 1;
    if coalesce((v_det ->> 'rules_retired')::integer, -1) <> v_pack_rules
       or coalesce((v_det ->> 'was_attached')::boolean, false) is not true then
      v_bad := array_append(v_bad, format('detach answered %L — it must report how many rules it retired and that the pack was attached', coalesce(v_det::text, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_tcp_after_det <> 0 then
      v_bad := array_append(v_bad, format('tenant_compliance_packs still holds %s row(s) after detach — the pack would keep reading as attached', v_tcp_after_det));
    end if;

    -- 6
    v_checks := v_checks + 1;
    if v_resolver_pre <> v_pack_rules then
      v_bad := array_append(v_bad, format('guardrail_rules_for_de returned %s of the %s attached pack rules BEFORE detach — the resolver test below would then prove nothing', v_resolver_pre, v_pack_rules));
    end if;
    v_checks := v_checks + 1;
    if v_resolver_post <> 0 then
      v_bad := array_append(v_bad, format('guardrail_rules_for_de STILL returns %s pack rule(s) after detach — retiring is not enough, and the answer path, the action gate and both triage decisions all read through this function', v_resolver_post));
    end if;

    -- 7
    v_checks := v_checks + 1;
    if v_rows_re <> v_rows_after then
      v_bad := array_append(v_bad, format('re-attach changed the row count from %s to %s — it inserted duplicates instead of reviving the rules that were already there', v_rows_after, v_rows_re));
    end if;
    v_checks := v_checks + 1;
    if v_live_re <> v_pack_rules then
      v_bad := array_append(v_bad, format('re-attach left %s of %s rules in force — a pack that reads as attached with nothing enforcing is the silent zero this codebase keeps paying for', v_live_re, v_pack_rules));
    end if;
    v_checks := v_checks + 1;
    if v_ids_re is distinct from v_ids_before then
      v_bad := array_append(v_bad, 'the rule ids changed across a re-attach — the revived rules are not the rules the block history points at');
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_re, -1) <> v_pack_rules then
      v_bad := array_append(v_bad, format('re-attach reported %L rules put back in force, expected %s', coalesce(v_re::text,'NULL'), v_pack_rules));
    end if;

    -- 8
    v_checks := v_checks + 1;
    if v_aud_att is null then
      v_bad := array_append(v_bad, 'attaching workspace-wide BLOCKING compliance controls left no audit row at all');
    else
      if v_aud_att ->> 'pack_key' is distinct from v_pack then
        v_bad := array_append(v_bad, format('the attach audit names pack %L, expected %L', coalesce(v_aud_att ->> 'pack_key','NULL'), v_pack));
      end if;
      select string_agg(e ->> 'rule', ' ') into v_a_rule
        from jsonb_array_elements(coalesce(v_aud_att -> 'rules', '[]'::jsonb)) e;
      if coalesce(v_a_rule, '') not like '%' || v_first_rule || '%' then
        v_bad := array_append(v_bad, 'the attach audit does not carry the rule text — the row can be edited later and there is no version history anywhere else');
      end if;
    end if;
    v_checks := v_checks + 1;
    if v_aud_det is null then
      v_bad := array_append(v_bad, 'removing workspace-wide BLOCKING compliance controls left no audit row at all');
    else
      if v_aud_det ->> 'pack_key' is distinct from v_pack then
        v_bad := array_append(v_bad, format('the detach audit names pack %L, expected %L', coalesce(v_aud_det ->> 'pack_key','NULL'), v_pack));
      end if;
      if coalesce((v_aud_det ->> 'rules_retired')::integer, -1) <> v_pack_rules then
        v_bad := array_append(v_bad, format('the detach audit says %L rules retired, expected %s', coalesce(v_aud_det ->> 'rules_retired','NULL'), v_pack_rules));
      end if;
      select string_agg(e ->> 'rule', ' ') into v_a_rule
        from jsonb_array_elements(coalesce(v_aud_det -> 'rules', '[]'::jsonb)) e;
      if coalesce(v_a_rule, '') not like '%' || v_first_rule || '%' then
        v_bad := array_append(v_bad, 'the detach audit does not carry the rule text VERBATIM — after a detach that text exists nowhere a person can read');
      end if;
    end if;

    -- 9
    v_checks := v_checks + 1;
    if v_guc = 'on' then
      v_bad := array_append(v_bad, 'app.allow_compliance_change is STILL "on" after detach returned — set_config(..., true) is transaction-local, so everything later in the same transaction could delete or deactivate a pack rule with no gate at all');
    end if;
    v_checks := v_checks + 1;
    if not v_del_refused then
      v_bad := array_append(v_bad, 'a bare DELETE of a compliance pack rule OUTSIDE detach_compliance_pack succeeded — trg_guard_compliance_guardrails is the good part of this design and it has stopped working');
    elsif coalesce(v_del_msg, '') not like '%compliance guardrail%' then
      v_bad := array_append(v_bad, format('the bare DELETE was refused, but not by the compliance trigger: %L', coalesce(v_del_msg, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if not v_upd_refused then
      v_bad := array_append(v_bad, 'a bare deactivation of a LIVE compliance pack rule OUTSIDE detach succeeded — a pack rule could be switched off one at a time again');
    elsif coalesce(v_upd_msg, '') not like '%compliance guardrail%' then
      v_bad := array_append(v_bad, format('the bare deactivation was refused, but not by the compliance trigger: %L', coalesce(v_upd_msg, 'NULL')));
    end if;
  end if;

  ------------------------------------------------------------------------
  -- PROBE 10 — THE SERVICE-ROLE HIRE STILL WORKS.
  --
  -- connector-hub's dt_hire_from_archetype runs instantiate_role_archetype
  -- through the service-role admin client, with no user. Tightening attach
  -- without this probe would have broken a live feature and called it a fix.
  -- The INVERSION is in the same block: the same call with role `authenticated`
  -- and no identity at all must FAIL, or "service_role works" would just mean
  -- "everything works".
  ------------------------------------------------------------------------
  begin
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
    set local role service_role;
    begin
      v_p10_de := public.instantiate_role_archetype(v_tenant, v_arch, '747 probe hire', null);
      v_p10_ok := v_p10_de is not null;
    exception when others then
      v_p10_ok := false; v_p10_msg := sqlerrm;
    end;
    execute format('set local role %I', v_caller);

    select count(*) into v_p10_packs
      from public.guardrail_rules g
      join public.role_archetypes a on a.key = v_arch
     where g.tenant_id = v_tenant
       and g.compliance_pack_key = any(a.compliance_pack_keys)
       and g.active and g.retired_at is null;

    -- the inversion: no identity, not service_role
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
    set local role authenticated;
    begin
      perform public.instantiate_role_archetype(v_tenant, v_arch, '747 probe anon hire', null);
      v_p10_anon_ok := true;
    exception when others then
      v_p10_anon_ok := false; v_p10_anon_msg := sqlerrm;
    end;
    execute format('set local role %I', v_caller);

    v_d10 := true;
    raise exception using errcode = 'P0001', message = '__undo__';
  exception when others then
    execute format('set local role %I', v_caller);
    if sqlerrm <> '__undo__' then
      v_bad := array_append(v_bad, format('PROBE 10 ABORTED (%s: %s) — whether the service-role provisioning hire still works was NOT compared this run', sqlstate, sqlerrm));
      v_d10 := false;
    end if;
  end;

  if v_d10 then
    v_probes := v_probes + 1;
    v_checks := v_checks + 1;
    if not v_p10_ok then
      v_bad := array_append(v_bad, format('THE SERVICE-ROLE HIRE IS BROKEN: instantiate_role_archetype(%L) refused under service_role — %L. connector-hub dt_hire_from_archetype (index.ts:3346) runs exactly this, and hardening attach must not take it down.', v_arch, coalesce(v_p10_msg,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p10_packs, 0) = 0 then
      v_bad := array_append(v_bad, format('the service-role hire of %L attached NO pack rules — the internal variant is not being reached from the hire path', v_arch));
    end if;
    v_checks := v_checks + 1;
    if v_p10_anon_ok then
      v_bad := array_append(v_bad, 'a caller with NO identity and no service_role claim completed a pack-carrying hire — the internal attach is fail-open after all, and "service_role works" above means nothing');
    elsif coalesce(v_p10_anon_msg, '') not like '%compliance pack%' then
      -- ⚠ THE MESSAGE, not just the fact. Accepting any exception here would let
      -- an unrelated 42501 or 23502 stand in for the refusal this probe exists
      -- to see. TWO bars can legitimately catch this caller now — section 4's
      -- pre-insert refusal ("this role comes with the % compliance pack") fires
      -- first, and attach's own ("not authorized to attach a compliance pack")
      -- is behind it — and both name a compliance pack, which is what this
      -- pattern discriminates on. The internal attach's OWN fail-closed
      -- behaviour, reached with a real identity rather than none, is pinned
      -- separately by probe 11a.
      v_bad := array_append(v_bad, format('the identity-less pack-carrying hire was refused, but not by either compliance bar: %L', coalesce(v_p10_anon_msg, 'NULL')));
    end if;
  end if;

  ------------------------------------------------------------------------
  -- PROBE 11 — THE GUARD THAT EVALUATED TO NULL AND SO NEVER FIRED.
  --
  -- can_admin_tenant_internal returns NULL — not FALSE — whenever
  -- auth_tenant_id() is NULL, because `p_tenant = NULL` is NULL and `NULL AND
  -- TRUE` is NULL. `if not NULL then` DOES NOT FIRE. Nothing above can catch
  -- this and that is not an accident of ordering:
  --   · probe 1 is stopped by the wrapper's null-uid bar before it ever
  --     reaches the authority check;
  --   · probe 10's inversion yields FALSE, not NULL, because a null uid makes
  --     auth_has_tenant_role FALSE and collapses the AND.
  -- So the NULL is built deliberately, twice, through two different doors.
  --
  -- 11a — NO FIXTURE NEEDED. A real owner of a real workspace calls attach with
  --       a NULL tenant. `p_tenant = auth_tenant_id()` is NULL for ANY caller
  --       when p_tenant is NULL, so this reproduces the NULL on every database
  --       forever. It must be refused IN WORDS by the guard, not by a raw 23502
  --       from the tenant_compliance_packs insert three statements later.
  --       ⚠ This is also the only probe that reaches the INTERNAL variant's own
  --       authority check carrying a real identity — probe 1 stops at the
  --       wrapper's identity bar, probe 10's inversion stops at section 4.
  -- 11b — THE LIVE SHAPE. An owner/admin profile whose OWN tenant_id is NULL:
  --       auth_tenant_id() NULL, auth_has_tenant_role TRUE (it is not
  --       tenant-scoped), guard NULL. Measured on 2026-08-16: one such profile.
  --       ⚠ IT MUST BE REFUSED BY THE AUTHORITY GUARD, and the message is the
  --       whole assertion. Without the coalesce this caller still ends in an
  --       exception — append_audit_event raises 'not a member of this tenant'
  --       AFTER the rows are written — so "an exception happened" is exactly
  --       what a fail-open guard looks like here. The pin is that the sentence
  --       is the authority refusal.
  --       ⚠ If the fixture is gone, its ABSENCE is asserted rather than
  --       skipped: a probe that quietly does not run is the gate that never
  --       fired.
  ------------------------------------------------------------------------
  begin
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    begin
      perform public.attach_compliance_pack(null::uuid, v_pack);
    exception when others then
      v_p11a_ref := true; v_p11a_msg := sqlerrm;
    end;
    execute format('set local role %I', v_caller);

    if v_null_uid is not null then
      v_p11b_ran := true;
      v_p11b_uid := v_null_uid;
      perform set_config('request.jwt.claim.sub', v_null_uid::text, true);
      set local role authenticated;
      begin
        perform public.attach_compliance_pack(v_tenant, v_pack);
      exception when others then
        v_p11b_ref := true; v_p11b_msg := sqlerrm;
      end;
      execute format('set local role %I', v_caller);
    end if;

    v_d11 := true;
    raise exception using errcode = 'P0001', message = '__undo__';
  exception when others then
    execute format('set local role %I', v_caller);
    if sqlerrm <> '__undo__' then
      v_bad := array_append(v_bad, format('PROBE 11 ABORTED (%s: %s) — the NULL-evaluating authority guard was NOT compared this run', sqlstate, sqlerrm));
      v_d11 := false;
    end if;
  end;

  if v_d11 then
    v_probes := v_probes + 1;
    v_checks := v_checks + 1;
    if not v_p11a_ref then
      v_bad := array_append(v_bad, 'attach_compliance_pack(NULL, ...) from a real owner was NOT refused — can_admin_tenant_internal returns NULL for a null tenant and `if not NULL` does not fire, so the authority check was skipped rather than failed');
    elsif coalesce(v_p11a_msg, '') not like 'not authorized to attach%' then
      v_bad := array_append(v_bad, format('attach_compliance_pack(NULL, ...) failed, but not at the guard: %L. A raw 23502 three statements later means the NULL walked past the authority check and was stopped by a NOT NULL constraint.', coalesce(v_p11a_msg, 'NULL')));
    end if;

    v_checks := v_checks + 1;
    if v_p11b_ran then
      if not v_p11b_ref then
        v_bad := array_append(v_bad, format('an owner/admin profile whose own tenant_id is NULL (%s) ATTACHED A PACK to workspace %s — the guard evaluated to NULL and was skipped', v_p11b_uid, v_tenant));
      elsif coalesce(v_p11b_msg, '') not like 'not authorized to attach%' then
        v_bad := array_append(v_bad, format('the NULL-tenant owner was stopped, but NOT by the authority guard: %L. That is what a fail-open guard looks like from the outside — the rows are written and append_audit_event raises afterwards, in a different function, and the transaction unwinds. The guard must refuse it in its own words.', coalesce(v_p11b_msg, 'NULL')));
      end if;
    else
      -- The fixture is absent. That is only acceptable if the shape genuinely
      -- does not exist — asserted, not assumed.
      if exists (select 1 from public.profiles p
                  where p.tenant_id is null and p.layer = 'tenant'
                    and p.role in ('tenant_owner', 'tenant_admin')
                    and coalesce(p.is_active, true)) then
        v_bad := array_append(v_bad, 'probe 11b did not run although a NULL-tenant owner/admin profile exists — the fixture query and the exposure disagree');
      end if;
    end if;
  end if;

  ------------------------------------------------------------------------
  -- PROBE 12 — decide_discovery_proposal IS DRIVEN, not grepped.
  --
  -- The three new counters were asserted by one `like '%compliance_rules_
  -- created%'` against the function body. That check passes if the numbers are
  -- transposed, if greatest(...,0) masks a negative, or if the packs silently
  -- fail to materialise — the string is present in all three cases. Migration
  -- 746 drove this function; 747 adds three numbers to its receipt and drove
  -- none of them. This is the one number the customer is shown.
  --
  -- Real session, real proposal, real accept, by the workspace's own owner —
  -- then the counter is compared against the rules that ACTUALLY appeared,
  -- counted here rather than taken from the RPC's own arithmetic.
  ------------------------------------------------------------------------
  begin
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);

    -- ⚠ 'proposed', not 'complete'. discovery_sessions_status_check admits
    -- running / proposed / accepted / parked / abandoned only (read live); an
    -- invented status aborts the probe with a 23514 and this whole comparison
    -- would be reported as "PROBE 12 ABORTED" rather than as a result.
    insert into public.discovery_sessions (tenant_id, status, created_by)
    values (v_tenant, 'proposed', v_admin_uid)
    returning id into v_p12_sess;

    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale)
    values (v_p12_sess, v_tenant, 'employee',
            jsonb_build_object('archetype_key', v_arch, 'name', '747 probe employee'),
            '747 verification probe')
    returning id into v_p12_prop;

    select count(*) into v_p12_before
      from public.guardrail_rules g
     where g.tenant_id = v_tenant and g.compliance_pack_key is not null
       and g.active and g.retired_at is null;

    set local role authenticated;
    v_p12_res := public.decide_discovery_proposal(v_p12_prop, 'accepted', null, null);
    execute format('set local role %I', v_caller);

    select count(*) into v_p12_after
      from public.guardrail_rules g
     where g.tenant_id = v_tenant and g.compliance_pack_key is not null
       and g.active and g.retired_at is null;

    select coalesce(a.compliance_pack_keys, '{}'::text[]) into v_p12_keys
      from public.role_archetypes a where a.key = v_arch;

    select count(*) into v_p12_de
      from public.digital_employees d
     where d.tenant_id = v_tenant and d.name = '747 probe employee';

    v_d12 := true;
    raise exception using errcode = 'P0001', message = '__undo__';
  exception when others then
    execute format('set local role %I', v_caller);
    if sqlerrm <> '__undo__' then
      v_bad := array_append(v_bad, format('PROBE 12 ABORTED (%s: %s) — the three compliance counters on the discovery receipt were NOT compared this run, and the only other thing checking them is a grep of the function body', sqlstate, sqlerrm));
      v_d12 := false;
    end if;
  end;

  if v_d12 then
    v_probes := v_probes + 1;
    v_checks := v_checks + 1;
    if coalesce((v_p12_res ->> 'ok')::boolean, false) is not true then
      v_bad := array_append(v_bad, format('the discovery accept of a pack-carrying employee did not go through: %L', coalesce(v_p12_res::text, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p12_de <> 1 then
      v_bad := array_append(v_bad, format('the discovery accept created %s employees named "747 probe employee", expected 1', v_p12_de));
    end if;
    v_checks := v_checks + 1;
    -- THE COUNTER AGAINST THE ROWS. v_pack_after - v_pack_before transposed, or
    -- masked by greatest(), lands here and nowhere else.
    if coalesce((v_p12_res ->> 'compliance_rules_created')::bigint, -1)
       is distinct from (v_p12_after - v_p12_before) then
      v_bad := array_append(v_bad, format('the accept reported compliance_rules_created=%L, but the workspace''s active pack rules moved %s → %s (a delta of %s). The number on the customer''s receipt is not the number of rules that started blocking.',
        coalesce(v_p12_res ->> 'compliance_rules_created', 'NULL'), v_p12_before, v_p12_after, v_p12_after - v_p12_before));
    end if;
    v_checks := v_checks + 1;
    if coalesce((v_p12_res ->> 'compliance_rules_created')::bigint, -1) <= 0 then
      v_bad := array_append(v_bad, format('the accept of a PACK-CARRYING archetype (%L) reported %L new blocking rules into a workspace that held none — either the pack did not materialise, or greatest(...,0) is masking a negative delta. A zero here is indistinguishable from "there are none", which is the exact defect the third counter exists to prevent.',
        v_arch, coalesce(v_p12_res ->> 'compliance_rules_created', 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce((v_p12_res ->> 'compliance_rules_in_force')::bigint, -1) is distinct from v_p12_after then
      v_bad := array_append(v_bad, format('the accept reported compliance_rules_in_force=%L, the workspace actually holds %s active pack rules',
        coalesce(v_p12_res ->> 'compliance_rules_in_force', 'NULL'), v_p12_after));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p12_res -> 'compliance_packs_attached', 'null'::jsonb)
       is distinct from to_jsonb(coalesce(v_p12_keys, '{}'::text[])) then
      v_bad := array_append(v_bad, format('the accept named packs %L, the archetype %L declares %L — a customer cannot consent to a control nobody names',
        coalesce((v_p12_res -> 'compliance_packs_attached')::text, 'NULL'), v_arch, coalesce(v_p12_keys::text, 'NULL')));
    end if;
  end if;

  ------------------------------------------------------------------------
  -- PROBE 13 — THE PLATFORM OPERATOR'S HIRE, BOTH HALVES.
  --
  -- God mode is live (AuthContext.tsx:152, customerApi.ts:285, App.tsx:491, 57
  -- platform_access_events 'start' rows). Once attach audits, a platform
  -- operator hiring a pack-carrying archetype would pass the authority check and
  -- then die inside append_audit_event — half-way, with the employee already
  -- inserted. Section 4 refuses it first, in words.
  --
  -- ⚠ AND THE SAME OPERATOR MUST STILL HIRE A PACK-FREE ARCHETYPE. Without that
  -- half, "platform is refused" is indistinguishable from "platform can no
  -- longer hire at all" — 8 of the 15 active archetypes carry no pack and are
  -- deliberately untouched.
  ------------------------------------------------------------------------
  begin
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', v_platform_uid::text, true);
    set local role authenticated;
    begin
      perform public.instantiate_role_archetype(v_tenant, v_arch, '747 probe platform hire', null);
    exception when others then
      v_p13_ref := true; v_p13_msg := sqlerrm;
    end;
    begin
      perform public.instantiate_role_archetype(v_tenant, v_free_arch, '747 probe platform free hire', null);
      v_p13_free_ok := true;
    exception when others then
      v_p13_free_ok := false; v_p13_free_msg := sqlerrm;
    end;
    execute format('set local role %I', v_caller);

    select count(*) into v_p13_de_n
      from public.digital_employees d
     where d.tenant_id = v_tenant and d.name = '747 probe platform hire';

    v_d13 := true;
    raise exception using errcode = 'P0001', message = '__undo__';
  exception when others then
    execute format('set local role %I', v_caller);
    if sqlerrm <> '__undo__' then
      v_bad := array_append(v_bad, format('PROBE 13 ABORTED (%s: %s) — whether a platform operator can still hire, and what happens when they hire a pack-carrying role, were NOT compared this run', sqlstate, sqlerrm));
      v_d13 := false;
    end if;
  end;

  if v_d13 then
    v_probes := v_probes + 1;
    v_checks := v_checks + 1;
    if not v_p13_ref then
      v_bad := array_append(v_bad, format('a platform profile hired the PACK-CARRYING archetype %L into workspace %s and nothing objected — either the pack attach no longer audits, or it audited a caller append_audit_event should have refused', v_arch, v_tenant));
    elsif coalesce(v_p13_msg, '') not like '%comes with the%compliance pack%' then
      v_bad := array_append(v_bad, format('the platform pack-carrying hire failed, but NOT at the pre-insert refusal: %L. That is the half-way abort this section exists to replace — the employee row and the pack rules are written before append_audit_event raises.', coalesce(v_p13_msg, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p13_de_n <> 0 then
      v_bad := array_append(v_bad, format('the refused platform hire still left %s employee row(s) behind — the refusal is not before the digital_employees insert', v_p13_de_n));
    end if;
    v_checks := v_checks + 1;
    if not v_p13_free_ok then
      v_bad := array_append(v_bad, format('a platform profile could NOT hire the pack-free archetype %L: %L. The refusal above was meant to be narrow — this migration is not allowed to take god-mode hiring away from the 8 archetypes that carry no compliance pack.', v_free_arch, coalesce(v_p13_free_msg, 'NULL')));
    end if;
  end if;

  ------------------------------------------------------------------------
  -- ROLLBACK INTEGRITY — the probes above wrote real rows into a real
  -- workspace. Every one of them must be gone.
  ------------------------------------------------------------------------
  select count(*) into v_gr_after    from public.guardrail_rules where tenant_id in (v_tenant, v_other_tenant, v_member_tenant);
  select count(*) into v_tcp_after   from public.tenant_compliance_packs where tenant_id in (v_tenant, v_other_tenant, v_member_tenant);
  select count(*) into v_audit_after from public.audit_events where tenant_id in (v_tenant, v_other_tenant, v_member_tenant)
     and detail ->> 'event' in ('compliance_pack_attached', 'compliance_pack_detached');
  select count(*) into v_de_after    from public.digital_employees where tenant_id in (v_tenant, v_other_tenant, v_member_tenant)
     and coalesce(is_workforce_assistant, false) = false;

  v_checks := v_checks + 1;
  if v_gr_before <> v_gr_after or v_tcp_before <> v_tcp_after
     or v_audit_before <> v_audit_after or v_de_before <> v_de_after then
    v_bad := array_append(v_bad, format('THE PROBES DID NOT ROLL BACK — guardrail_rules %s→%s, tenant_compliance_packs %s→%s, pack audit events %s→%s, employees %s→%s. This migration has left test data in a customer workspace.',
      v_gr_before, v_gr_after, v_tcp_before, v_tcp_after, v_audit_before, v_audit_after, v_de_before, v_de_after));
  end if;

  ------------------------------------------------------------------------
  -- STATIC RATCHETS — cheap, and they are what stops the fix being undone by
  -- the next person who copies the old shape.
  ------------------------------------------------------------------------
  select pg_get_functiondef(p.oid) into v_att_body from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'attach_compliance_pack';
  select pg_get_functiondef(p.oid) into v_int_body from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'attach_compliance_pack_internal';
  select pg_get_functiondef(p.oid) into v_det_body from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'detach_compliance_pack';
  select pg_get_functiondef(p.oid) into v_inst_body from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'instantiate_role_archetype';
  select pg_get_functiondef(p.oid) into v_ddp_body from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'decide_discovery_proposal';
  select pg_get_functiondef(p.oid) into v_res_body from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'restore_guardrail_rule';

  -- ⚠⚠ STRIP THE COMMENTS BEFORE MATCHING, AND THIS IS NOT TIDINESS.
  -- pg_get_functiondef returns the source INCLUDING `--` comments, so a
  -- ratchet that greps for a banned construct also matches any COMMENT that
  -- names it. The first run of this migration failed on exactly that: the
  -- check below fired against attach_compliance_pack's own comment explaining
  -- the `auth.uid() is not null and` bug it had just fixed. The code was
  -- correct; the sentence describing why was indistinguishable from the thing
  -- it described.
  --
  -- That is worse than a false alarm. A ratchet that a correct fix cannot pass
  -- gets weakened by the next person under time pressure — and the comment is
  -- exactly what a future reader most needs, so the check was punishing the
  -- documentation. scripts/migration-append-check.mjs strips line comments
  -- before matching for the same reason.
  v_att_body  := regexp_replace(coalesce(v_att_body,  ''), '--[^' || chr(10) || ']*', '', 'g');
  v_int_body  := regexp_replace(coalesce(v_int_body,  ''), '--[^' || chr(10) || ']*', '', 'g');
  v_det_body  := regexp_replace(coalesce(v_det_body,  ''), '--[^' || chr(10) || ']*', '', 'g');
  v_inst_body := regexp_replace(coalesce(v_inst_body, ''), '--[^' || chr(10) || ']*', '', 'g');
  v_ddp_body  := regexp_replace(coalesce(v_ddp_body,  ''), '--[^' || chr(10) || ']*', '', 'g');
  v_res_body  := regexp_replace(coalesce(v_res_body,  ''), '--[^' || chr(10) || ']*', '', 'g');

  -- The strip must not silently empty everything — an all-blank body would
  -- make every ratchet below pass over nothing.
  v_checks := v_checks + 1;
  if length(v_att_body) < 100 or length(v_det_body) < 100 or length(v_inst_body) < 100 then
    v_bad := array_append(v_bad, 'a stripped function body came back under 100 characters — the comment strip has eaten the code and every static ratchet below is now comparing nothing');
  end if;

  v_checks := v_checks + 1;
  if v_att_body like '%auth.uid() is not null and%' or v_det_body like '%auth.uid() is not null and%' then
    v_bad := array_append(v_bad, 'attach or detach still contains `auth.uid() is not null and` — that prefix makes the authority check SKIP instead of FAIL');
  end if;

  -- ⚠ THE RATCHET FOR THE NULL. Probe 11 fires only while a NULL-producing
  -- caller exists to fire it; this fails the instant the coalesce is deleted,
  -- for any reason, by anyone, forever. `if not <boolean-returning call>` on a
  -- helper that can return NULL is a check that cannot fail.
  v_checks := v_checks + 1;
  if v_int_body like '%not public.can_admin_tenant_internal%'
     and v_int_body not like '%coalesce(public.can_admin_tenant_internal%' then
    v_bad := array_append(v_bad, 'attach_compliance_pack_internal calls can_admin_tenant_internal WITHOUT coalesce — that helper returns NULL (not FALSE) whenever auth_tenant_id() is NULL, and `if not NULL then` does not fire, so the authority check is skipped rather than failed. 11 live functions, install_role_systems among them, write coalesce(..., false) for exactly this reason.');
  end if;

  -- The refusal that stops this migration handing the customer a Restore button
  -- the database always rejects. It only became reachable because detach now
  -- RETIRES rather than deletes.
  v_checks := v_checks + 1;
  if v_res_body not like '%compliance_pack_key is not null%' then
    v_bad := array_append(v_bad, 'restore_guardrail_rule has no compliance_pack_key refusal — retiring pack rules puts them on the Retired shelf, where its Restore button writes active=false into a row guard_compliance_guardrails refuses. The button would error every single time.');
  end if;

  -- The pre-insert refusal that turns a half-way abort into a sentence.
  v_checks := v_checks + 1;
  if v_inst_body not like '%comes with the%compliance pack%' then
    v_bad := array_append(v_bad, 'instantiate_role_archetype no longer refuses a caller who cannot be audited against this workspace BEFORE the digital_employees insert — a platform operator in god mode would insert the employee, materialise the pack rules, and then abort inside append_audit_event');
  end if;
  v_checks := v_checks + 1;
  if v_det_body like '%delete from guardrail_rules%' or v_det_body like '%delete from public.guardrail_rules%' then
    v_bad := array_append(v_bad, 'detach_compliance_pack still DELETES guardrail rules — the standing ruling is retire, not delete');
  end if;
  v_checks := v_checks + 1;
  if v_inst_body not like '%attach_compliance_pack_internal%' then
    v_bad := array_append(v_bad, 'instantiate_role_archetype does not call the internal attach — the service-role provisioning hire has no route through the hardened guard');
  end if;
  -- ⚠ A GREP, AND IT IS NOT THE EVIDENCE. This passes if the before/after are
  -- transposed, if greatest(...,0) masks a negative, or if the packs silently
  -- fail to materialise — the string is present in all three cases. PROBE 12 is
  -- what actually drives this function and compares the number on the receipt
  -- against the rules that appeared. This line is only the ratchet that stops
  -- the counters being deleted outright.
  v_checks := v_checks + 1;
  if v_ddp_body not like '%compliance_rules_created%' then
    v_bad := array_append(v_bad, 'decide_discovery_proposal does not report compliance_rules_created — a customer cannot consent to a blocking rule they were never shown');
  end if;

  v_checks := v_checks + 1;
  if has_function_privilege('service_role', 'public.detach_compliance_pack(uuid, text)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.attach_compliance_pack(uuid, text)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.attach_compliance_pack_internal(uuid, text, text)', 'EXECUTE') then
    v_bad := array_append(v_bad, 'service_role can still execute one of the compliance-pack functions directly — the hole is renamed, not closed');
  end if;
  v_checks := v_checks + 1;
  if has_function_privilege('anon', 'public.detach_compliance_pack(uuid, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.attach_compliance_pack(uuid, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.attach_compliance_pack_internal(uuid, text, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.restore_guardrail_rule(uuid)', 'EXECUTE') then
    v_bad := array_append(v_bad, 'anon can execute a compliance-pack function, or restore_guardrail_rule — a CREATE OR REPLACE on a fresh database creates the function with the default PUBLIC EXECUTE grant (migs 610/630)');
  end if;
  v_checks := v_checks + 1;
  if not has_function_privilege('authenticated', 'public.restore_guardrail_rule(uuid)', 'EXECUTE') then
    v_bad := array_append(v_bad, 'authenticated cannot execute restore_guardrail_rule — section 5 replaced the function and took the Retired shelf''s Restore button down with it');
  end if;
  v_checks := v_checks + 1;
  if has_function_privilege('authenticated', 'public.attach_compliance_pack_internal(uuid, text, text)', 'EXECUTE') then
    v_bad := array_append(v_bad, 'authenticated can execute attach_compliance_pack_internal — the unchecked variant must be reachable only from inside another SECURITY DEFINER function');
  end if;
  v_checks := v_checks + 1;
  if not has_function_privilege('authenticated', 'public.detach_compliance_pack(uuid, text)', 'EXECUTE') then
    v_bad := array_append(v_bad, 'authenticated cannot execute detach_compliance_pack — the Compliance page control would be a button that always errors');
  end if;

  v_checks := v_checks + 1;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.guardrail_rules'::regclass
                    and conname = 'guardrail_rules_retired_is_inactive') then
    v_bad := array_append(v_bad, 'the CHECK keeping retired_at and active=false agreeing is gone — a retired rule could be enforced again');
  end if;
  v_checks := v_checks + 1;
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.guardrail_rules'::regclass
                    and tgname = 'trg_guard_compliance_guardrails' and not tgisinternal) then
    v_bad := array_append(v_bad, 'trg_guard_compliance_guardrails is gone — the gate this migration was told to preserve');
  end if;

  if array_length(v_bad, 1) > 0 then
    raise exception '747: % of % check(s) failed across % probe(s): %',
      array_length(v_bad, 1), v_checks, v_probes, array_to_string(v_bad, ' | ');
  end if;

  raise notice '747: % checks across % probes, all passed — an unidentified caller is refused by both functions, a non-admin member of their OWN workspace and a foreign admin are refused BY NAME rather than by any exception, a caller whose authority check evaluates to NULL is refused (both doors), the owner attaches % blocking rule(s), detach RETIRES them (same ids, retired_at set, active false, nothing deleted), guardrail_rules_for_de stops returning them, re-attach revives the same rows with no duplicates, both actions leave an audit row carrying the pack key and the rule text, a bare DELETE and a bare deactivation outside detach are still refused, the service-role provisioning hire still works while an identity-less one does not, a real discovery accept reports a compliance_rules_created that equals the rules that actually appeared, a platform operator is refused a pack-carrying hire BEFORE anything is created and can still hire a pack-free role, and every probe row rolled back',
    v_checks, v_probes, v_pack_rules;
end $verify$;

commit;
