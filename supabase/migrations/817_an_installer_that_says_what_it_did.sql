-- 817_an_installer_that_says_what_it_did.sql
-- ==========================================================================
-- WHY: install_starter_onboarding_template() reported SUCCESS for doing
-- nothing, and handed back the OLD thing while doing it.
--
--     select id into v_tpl_id from onboarding_templates
--       where tenant_id = v_tenant and name = 'SaaS onboarding — starter';
--     if v_tpl_id is not null then
--       return jsonb_build_object('template_id', v_tpl_id,
--                                 'already_installed', true);
--     end if;
--
-- `already_installed` is true for ANY tenant already holding a row with that
-- name — which is precisely every tenant that would NEED the newer list. The
-- caller gets a template id, no error, and a boolean whose only honest reading
-- is "there is a row here". src/lib/onboardingApi.ts turns that into a toast
-- reading "Starter template already installed." and the workspace stays on a
-- list that is six items short, forever, with no path off it.
--
-- Prior notes described moving to the newer list as "a UI opt-in". THAT IS
-- WRONG AND IT IS CORRECTED HERE: the opt-in does not exist. Every call site
-- was enumerated before writing this — src/lib/onboardingApi.ts:211
-- (installStarterTemplate) and its two callers, CustomerOnboardingLive.tsx:620
-- and PipelineLive.tsx:259 — and not one of them can reach the newer items.
-- PipelineLive does not even read the result. There is no other writer of
-- onboarding_templates.items in the product except the template EDITOR, which
-- is a person retyping sixteen items by hand.
--
-- ── MEASURED IN PRODUCTION BEFORE ANY CHANGE (2026-08-20 10:09Z) ──────────
-- 7 tenants, 6 holding a 'SaaS onboarding — starter'. Not sampled — the whole
-- population, joined to tenants:
--
--   acme-telecom        published v1  10 items  md5 329f3c95…  updated=created
--   first-community-cu  published v1  10 items  md5 329f3c95…  updated=created
--   gusto               published v1  10 items  md5 329f3c95…  updated=created
--   kinetic             published v1  10 items  md5 329f3c95…  updated=created
--   hudson-family       published v1  16 items  md5 70671c3b…  updated=created
--   outsourcetel-hq     DRAFT     v5  15 items  md5 3e230cc8…  EDITED
--
-- THE SUPERSET RELATION, RE-VERIFIED RATHER THAN INHERITED, because it is the
-- entire basis for calling an upgrade safe. Comparing each stored item to its
-- canonical counterpart as jsonb (not as text — jsonb normalises key order, so
-- this is a semantic comparison):
--
--   the four 10-item tenants:  0 keys outside canon, 10/10 items BYTE-
--                              IDENTICAL to canon, 6 canonical keys absent.
--                              6 additions, 0 removals, 0 modifications.
--   hudson-family:             16/16 identical, 0 missing. Already current.
--   outsourcetel-hq:           11/15 identical, 4 SAME KEY DIFFERENT BODY
--                              (requires_signoff flipped on kickoff_call,
--                              data_export_received and training_session; a
--                              hire_from_archetype binding added to
--                              locations_configured), and leave_rules_configured
--                              DELETED. Its version history says the rest:
--                              v1 was md5 329f3c95… — the same 10-item seed —
--                              then v2..v5 are four distinct further edits.
--
-- So the four are provably UNTOUCHED and purely behind, and outsourcetel-hq is
-- provably EDITED. Those are different situations and this migration refuses to
-- treat them alike.
--
-- ── WHAT THIS MIGRATION DOES NOT DO ──────────────────────────────────────
-- IT MIGRATES NOBODY. Which starter list a workspace runs is the founder's
-- decision, not a migration's. Nothing below writes to any tenant's template.
-- The mechanism is built; the choice is left.
--
-- ── VOCABULARY: BORROWED, NOT INVENTED ───────────────────────────────────
-- mig 712 already had to name this exact shape — a state that LOOKS finished
-- and is not. Its gap ledger distinguishes `answered` (a person supplied
-- something) from `resolved` (the platform VERIFIED it), and its RPCs return
-- {'ok', …, 'status': '<one word>'}. The same key and the same discipline are
-- used here, because the defect is the same defect:
--
--     712:  answered  ≠  resolved
--     817:  installed ≠  current
--
--   installed  — a row was created by this call.
--   current    — a row is there and its items ARE the canonical list.
--   outdated   — a row is there, provably unedited, and N canonical items are
--                absent from it. `behind_by` says how many; `missing_keys`
--                says which. This is the state that used to report as plain
--                success, and it is the whole reason for the change.
--   divergent  — a row is there and it carries LOCAL EDITS. Not a failure and
--                not a version number: somebody made this template theirs.
--
-- ── EDITS ARE DETECTED FROM CONTENT FIRST, HISTORY ONLY AS A TIE-BREAK ────
-- Two of the three edit signals are derived from the items themselves — an
-- item whose body differs from canon under the same key, or a key canon does
-- not name. Neither can be faked by a stale marker, which is the trap this
-- repo has been burned by (debt map: "stored-marker-as-truth").
--
-- The third signal exists because content ALONE cannot separate "never had
-- this item" from "deliberately deleted this item" — outsourcetel-hq's missing
-- leave_rules_configured is exactly that ambiguity. So when the only
-- difference from canon is ABSENCE, history decides: a template whose
-- updated_at has moved off created_at, or whose version is past 1, or which
-- has published more than one distinct item set, has been WRITTEN TO by a
-- person and its absences are treated as choices — divergent, not outdated.
-- The four 10-item tenants clear all three (v1, updated=created, one version
-- each), so calling them outdated is a conclusion, not an assumption.
--
-- ⚠ Note the asymmetry is deliberate and points the safe way: a template that
-- is wrongly called divergent merely REFUSES an upgrade. One wrongly called
-- outdated would be written to. The signals are OR-ed for that reason.
--
-- ── THE DECISION IS A PURE FUNCTION, SO IT CAN BE PINNED ANYWHERE ────────
-- starter_template_verdict(canon, items, touched) takes three values and
-- returns the verdict. It reads no table. That is what lets the assertions at
-- the bottom of this file exercise all four states on LITERALS — true on an
-- empty database, true on a restored backup, true on production. A migration
-- whose assertions need production's rows in order to pass cannot be replayed,
-- and three migrations in this repo already have that disease (778, 789, 790).
-- This one does not join to a single tenant row.
--
-- ── THE UPGRADE CANNOT OVERWRITE, STRUCTURALLY ───────────────────────────
-- upgrade_starter_onboarding_template() is a KEY-WISE MERGE in canonical
-- order: where a key already exists in the tenant's template THE TENANT'S OWN
-- ITEM WINS, verbatim; only genuinely absent canonical keys are inserted; and
-- any key canon does not name is carried through. That is the same merge mig
-- 685 used on outsourcetel-hq's draft, for the same reason.
--
-- Being a merge is not enough, because "it is a merge" is a promise about
-- code. So immediately before the UPDATE the function asserts that every item
-- present in the OLD array is still present, byte-identical, in the new one,
-- and raises if not. A future edit that turns the merge into a replacement
-- fails there instead of destroying somebody's work.
--
-- On top of that, a template in the `divergent` state is REFUSED outright
-- unless the caller passes p_preserve_edits => true, which selects the merge
-- explicitly and names every key it would add in the return value. Default
-- false: the button does not silently take that branch.
--
-- ── AND IT DOES NOT PUBLISH ANYTHING THAT WAS NOT ALREADY PUBLISHED ──────
-- publish_onboarding_template() is called only when the template was ALREADY
-- `published`. outsourcetel-hq's is a DRAFT at v5 and would stay a draft:
-- publishing somebody's unfinished draft is its own version of overwriting it.
-- Existing projects are unaffected either way — onboarding_projects pins to
-- template_version_id, and every historical onboarding_template_versions row
-- is left byte-identical, so a project mid-flight keeps the exact list it
-- started on.
--
-- ── THE ACKNOWLEDGEMENT, AND WHY IT EXPIRES ──────────────────────────────
-- certify's new ratchet fails on `outdated`. A red nobody can clear is a red
-- people learn to ignore (the lesson written into stranded-draft.mjs), and
-- "stay on the ten-item list" is a legitimate answer — so
-- acknowledge_starter_template_baseline() records that decision as an audit
-- event, exactly as mig 712 records a `dismissed` gap.
--
-- It stores the tenant's items md5 AND the canonical items md5 at the moment
-- of the decision, and the probe honours it only while BOTH still match. Edit
-- the template, or move the canonical list again, and the acknowledgement
-- lapses and the tenant goes red again — which is the point. An
-- acknowledgement that outlives the thing it was about is the stored marker
-- this repo keeps getting caught by.
-- ==========================================================================

begin;

-- ── 0. The name, once ─────────────────────────────────────────────────────
-- Four functions below have to agree on which row IS the starter template. A
-- literal repeated four times is the two-paths-one-counted shape: if one copy
-- drifts, the classifier reports `absent` while the installer reports
-- `already_installed`, and the two halves of this fix disagree in the safest-
-- looking way possible. It is one function so drift cannot be expressed.
create or replace function public.starter_onboarding_template_name()
returns text
language sql
immutable
as $function$ select 'SaaS onboarding — starter'::text $function$;

comment on function public.starter_onboarding_template_name() is
  'The name of the seeded starter onboarding template. Single-sourced so the '
  'installer, the classifier and the upgrade path cannot disagree about which '
  'row they are talking about.';

-- ── 1. The verdict — a PURE function, no tables ──────────────────────────
-- Everything that decides is here, and it decides from three values. Because
-- it touches no row it can be asserted exhaustively on literals in any
-- database, which is what the pins at the bottom of this file do.
create or replace function public.starter_template_verdict(
  p_canon jsonb, p_items jsonb, p_touched boolean)
returns jsonb
language plpgsql
immutable
as $function$
declare
  v_missing  text[] := '{}';
  v_modified text[] := '{}';
  v_extra    text[] := '{}';
  v_signals  text[] := '{}';
  v_status   text;
begin
  if p_canon is null or jsonb_typeof(p_canon) <> 'array' then
    raise exception 'starter_template_verdict: canon must be a jsonb array';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'starter_template_verdict: items must be a jsonb array';
  end if;

  -- canonical keys with no counterpart in the tenant's list
  select coalesce(array_agg(c.value->>'key' order by c.value->>'key'), '{}')
    into v_missing
    from jsonb_array_elements(p_canon) c
   where not exists (select 1 from jsonb_array_elements(p_items) t
                      where t.value->>'key' = c.value->>'key');

  -- same key, different body. jsonb <> jsonb is a SEMANTIC comparison: key
  -- order and whitespace are normalised, so this cannot fire on formatting.
  select coalesce(array_agg(c.value->>'key' order by c.value->>'key'), '{}')
    into v_modified
    from jsonb_array_elements(p_canon) c
   where exists (select 1 from jsonb_array_elements(p_items) t
                  where t.value->>'key' = c.value->>'key' and t.value <> c.value);

  -- keys the canonical list does not name at all
  select coalesce(array_agg(distinct t.value->>'key'), '{}')
    into v_extra
    from jsonb_array_elements(p_items) t
   where not exists (select 1 from jsonb_array_elements(p_canon) c
                      where c.value->>'key' = t.value->>'key');

  if array_length(v_modified, 1) is not null then
    v_signals := v_signals || format('%s item(s) edited in place: %s',
                   array_length(v_modified, 1), array_to_string(v_modified, ', '));
  end if;
  if array_length(v_extra, 1) is not null then
    v_signals := v_signals || format('%s item(s) this workspace added: %s',
                   array_length(v_extra, 1), array_to_string(v_extra, ', '));
  end if;

  if array_length(v_modified, 1) is not null or array_length(v_extra, 1) is not null then
    -- Content alone proves an edit. History is not consulted.
    v_status := 'divergent';
  elsif array_length(v_missing, 1) is not null then
    -- The ONLY difference is absence, which content cannot explain. A template
    -- a person has written to owns its absences; an untouched one is behind.
    if coalesce(p_touched, false) then
      v_status := 'divergent';
      v_signals := v_signals || format(
        'this template has been written to since it was seeded, so its %s absent item(s) are read as a choice, not as being behind: %s',
        array_length(v_missing, 1), array_to_string(v_missing, ', '));
    else
      v_status := 'outdated';
    end if;
  else
    -- Items ARE the canonical list. History is irrelevant: a template someone
    -- hand-edited INTO the canonical shape is current, and calling it divergent
    -- would be noise.
    v_status := 'current';
  end if;

  return jsonb_build_object(
    'status',        v_status,
    'canon_items',   jsonb_array_length(p_canon),
    'tenant_items',  jsonb_array_length(p_items),
    'behind_by',     coalesce(array_length(v_missing, 1), 0),
    'missing_keys',  to_jsonb(v_missing),
    'modified_keys', to_jsonb(v_modified),
    'extra_keys',    to_jsonb(v_extra),
    'edited',        v_status = 'divergent',
    'edit_signals',  to_jsonb(v_signals),
    'upgrade_available', v_status in ('outdated', 'divergent')
  );
end;
$function$;

comment on function public.starter_template_verdict(jsonb, jsonb, boolean) is
  'THE decision: installed/current/outdated/divergent, from three values and no '
  'table. Pure so it can be asserted on literals in any database — see mig 817.';

-- ── 2. The classifier — row lookup + the verdict above ───────────────────
-- SECURITY INVOKER on purpose. It takes a tenant id, and a SECURITY DEFINER
-- function that takes a tenant id is the migs 662-664 shape where the
-- PARAMETER becomes the authorisation. As an invoker function it has no
-- authority of its own: it can only read what its caller could already read.
-- The client-facing wrapper below is the one that resolves the tenant from the
-- session, and it never accepts one.
create or replace function public.starter_template_state_internal(p_tenant_id uuid)
returns jsonb
language plpgsql
stable
as $function$
declare
  v_canon    jsonb := public.starter_onboarding_template()->'items';
  v_tpl      public.onboarding_templates;
  v_touched  boolean;
  v_versions integer;
begin
  if p_tenant_id is null then
    raise exception 'starter_template_state_internal: p_tenant_id is required — a classifier that cannot tell which workspace it is describing must refuse, not guess';
  end if;

  select * into v_tpl
    from public.onboarding_templates
   where tenant_id = p_tenant_id
     and name = public.starter_onboarding_template_name()
   order by created_at
   limit 1;

  if not found then
    return jsonb_build_object(
      'tenant_id', p_tenant_id, 'template_id', null,
      'template_status', null, 'template_version', null,
      'status', 'absent',
      'canon_items', jsonb_array_length(v_canon),
      'tenant_items', 0,
      'behind_by', jsonb_array_length(v_canon),
      'missing_keys', (select coalesce(jsonb_agg(c.value->>'key' order by c.value->>'key'), '[]'::jsonb)
                         from jsonb_array_elements(v_canon) c),
      'modified_keys', '[]'::jsonb, 'extra_keys', '[]'::jsonb,
      'edited', false, 'edit_signals', '[]'::jsonb,
      'upgrade_available', false);
  end if;

  select count(distinct md5(items::text)) into v_versions
    from public.onboarding_template_versions where template_id = v_tpl.id;

  -- Three independent ways of saying "a person has written to this row".
  v_touched := (v_tpl.updated_at > v_tpl.created_at)
            or (v_tpl.version > 1)
            or (coalesce(v_versions, 0) > 1);

  return public.starter_template_verdict(v_canon, v_tpl.items, v_touched)
      || jsonb_build_object(
           'tenant_id', p_tenant_id,
           'template_id', v_tpl.id,
           'template_status', v_tpl.status,
           'template_version', v_tpl.version,
           'items_md5', md5(v_tpl.items::text),
           'canon_md5', md5(v_canon::text));
end;
$function$;

comment on function public.starter_template_state_internal(uuid) is
  'Classifies one workspace''s starter onboarding template as absent/current/'
  'outdated/divergent. SECURITY INVOKER deliberately — it takes a tenant id, and '
  'a SECDEF function that takes a tenant id is the migs 662-664 confused-deputy '
  'shape. Read by the installer, the upgrade path and certify''s ratchet, so all '
  'three cannot disagree.';

-- ── 3. The client-facing read — no parameters, no upgrade, no writes ─────
-- This is what lets a caller ACT: the UI can say "6 items behind" and offer the
-- upgrade without first attempting one and reading a boolean to find out.
create or replace function public.starter_onboarding_template_status()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'extensions'
as $function$
declare v_tenant uuid := public.auth_tenant_id();
begin
  if v_tenant is null then
    raise exception 'no tenant for caller';
  end if;
  return public.starter_template_state_internal(v_tenant) || jsonb_build_object('ok', true);
end;
$function$;

-- ── 4. The installer, made honest ────────────────────────────────────────
-- The insert half is unchanged. What changes is that the "there is already a
-- row here" branch now says WHICH row, in what state, and how far behind —
-- instead of `already_installed: true` and nothing else.
create or replace function public.install_starter_onboarding_template()
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_tenant    uuid;
  v_is_active boolean;
  v_tpl_id    uuid;
  v_pub       jsonb;
  v_spec      jsonb := public.starter_onboarding_template();
  v_state     jsonb;
begin
  select coalesce(is_active, true) into v_is_active from profiles where user_id = auth.uid() limit 1;
  if v_is_active is false then
    raise exception 'account is deactivated';
  end if;
  v_tenant := auth_tenant_id();
  if v_tenant is null then
    raise exception 'no tenant for caller';
  end if;

  v_state := public.starter_template_state_internal(v_tenant);

  if (v_state->>'status') <> 'absent' then
    -- ⚠ THE BRANCH THIS MIGRATION EXISTS FOR. It used to return
    -- {'template_id': …, 'already_installed': true} for a tenant six items
    -- behind, and the caller had no way to tell that from a tenant that was
    -- fully current. `already_installed` is kept because two call sites read
    -- it, but it is no longer the only thing said.
    return v_state || jsonb_build_object(
      'ok', true,
      'installed', false,
      'already_installed', true);
  end if;

  insert into onboarding_templates (tenant_id, name, description, items)
  values (v_tenant, public.starter_onboarding_template_name(),
          v_spec->>'description',
          v_spec->'items')
  returning id into v_tpl_id;

  v_pub := publish_onboarding_template(v_tpl_id);

  -- Re-read rather than describe what we believe we just wrote.
  return public.starter_template_state_internal(v_tenant)
      || jsonb_build_object('ok', true, 'status', 'installed',
                            'installed', true, 'already_installed', false)
      || v_pub;
end;
$function$;

-- ── 5. The upgrade path that actually upgrades ───────────────────────────
create or replace function public.upgrade_starter_onboarding_template(
  p_preserve_edits boolean default false)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_tenant    uuid;
  v_is_active boolean;
  v_state     jsonb;
  v_status    text;
  v_tpl_id    uuid;
  v_tpl_stat  text;
  v_canon     jsonb := public.starter_onboarding_template()->'items';
  v_canon_desc text := public.starter_onboarding_template()->>'description';
  v_old       jsonb;
  v_new       jsonb;
  v_added     text[];
  v_errors    text[];
  v_pub       jsonb := '{}'::jsonb;
  v_after     jsonb;
  v_before_n  integer;
  v_after_n   integer;
  v_desc_set  boolean := false;
begin
  select coalesce(is_active, true) into v_is_active from profiles where user_id = auth.uid() limit 1;
  if v_is_active is false then
    raise exception 'account is deactivated';
  end if;
  v_tenant := auth_tenant_id();
  if v_tenant is null then
    raise exception 'no tenant for caller';
  end if;
  -- Same bar publish_onboarding_template already holds. Stated here too
  -- because this function writes items, and a guard that lives only in the
  -- function you happen to call last is the shape mig 685 spent a paragraph on.
  if not auth_has_tenant_role(array['tenant_owner', 'tenant_admin']) then
    raise exception 'only workspace owners/admins can upgrade the starter onboarding template';
  end if;

  v_state  := public.starter_template_state_internal(v_tenant);
  v_status := v_state->>'status';

  if v_status = 'absent' then
    return v_state || jsonb_build_object(
      'ok', false, 'changed', false, 'refused', true,
      'reason', 'not_installed',
      'message', format('This workspace has no "%s" to upgrade. Install it first.',
                        public.starter_onboarding_template_name()));
  end if;

  v_tpl_id := (v_state->>'template_id')::uuid;

  if v_status = 'current' then
    return v_state || jsonb_build_object(
      'ok', true, 'changed', false, 'refused', false,
      'reason', 'already_current',
      'message', format('Already current — %s of %s items, nothing to add.',
                        v_state->>'tenant_items', v_state->>'canon_items'));
  end if;

  if v_status = 'divergent' and not coalesce(p_preserve_edits, false) then
    -- ⛔ THE REFUSAL. Somebody made this template theirs. Replacing it is worse
    -- than the bug this migration fixes, so the default answer is no, with the
    -- edits named so the person can see what the refusal is protecting.
    return v_state || jsonb_build_object(
      'ok', false, 'changed', false, 'refused', true,
      'reason', 'template_has_local_edits',
      'message', format(
        'Refused: this workspace has edited its starter template, so upgrading would overwrite that work. %s Re-run with preserve-edits to ADD only the %s missing item(s) and leave every existing item exactly as it is.',
        array_to_string(array(select jsonb_array_elements_text(v_state->'edit_signals')), ' '),
        v_state->>'behind_by'));
  end if;

  select items into v_old
    from onboarding_templates where id = v_tpl_id for update;
  v_before_n := jsonb_array_length(v_old);
  v_tpl_stat := (v_state->>'template_status');

  -- The merge: canonical ORDER, but where a key already exists THE TENANT'S
  -- OWN ITEM WINS, verbatim. Only absent canonical keys take canon's body.
  -- Anything canon does not name is carried through at the end.
  with merged as (
    select c.ord as ord,
           coalesce(
             (select t.value
                from jsonb_array_elements(v_old) with ordinality t(value, tord)
               where t.value->>'key' = c.value->>'key'
               order by t.tord limit 1),
             c.value) as item
      from jsonb_array_elements(v_canon) with ordinality c(value, ord)
    union all
    select 1000000 + t.tord, t.value
      from jsonb_array_elements(v_old) with ordinality t(value, tord)
     where not exists (select 1 from jsonb_array_elements(v_canon) c2
                        where c2.value->>'key' = t.value->>'key')
  )
  select coalesce(jsonb_agg(item order by ord), '[]'::jsonb) into v_new from merged;

  select coalesce(array_agg(c.value->>'key' order by c.value->>'key'), '{}') into v_added
    from jsonb_array_elements(v_canon) c
   where not exists (select 1 from jsonb_array_elements(v_old) t
                      where t.value->>'key' = c.value->>'key');

  -- ⛔ "It is a merge" is a promise about code. THIS is the guarantee: every
  -- item that was in the old array must still be in the new one, byte-
  -- identical. A future edit that turns this into a replacement dies here
  -- rather than in somebody's workspace. Absence-of-violation, so it is
  -- vacuously true on an empty template and still catches every real case.
  if exists (
    select 1 from jsonb_array_elements(v_old) o
     where not exists (select 1 from jsonb_array_elements(v_new) n where n.value = o.value)
  ) then
    raise exception 'upgrade_starter_onboarding_template: the merge would have changed or dropped an item that already existed. Refusing to write. This is a bug in the merge, not a problem with the workspace';
  end if;

  -- The publish gate polices shape and role-reachability, and it is not
  -- weakened or bypassed here — it is asked FIRST, so an upgrade that could
  -- not be published is refused before anything is written.
  v_errors := validate_onboarding_items(v_new, v_tenant);
  if array_length(v_errors, 1) is not null then
    return v_state || jsonb_build_object(
      'ok', false, 'changed', false, 'refused', true,
      'reason', 'would_not_validate',
      'errors', to_jsonb(v_errors),
      'message', 'Refused: the upgraded item list does not pass the publish validator, so nothing was written.');
  end if;

  -- The description is rewritten ONLY for a provably-untouched template, where
  -- it is provably still the old seed's text. An edited template keeps its own.
  v_desc_set := (v_status = 'outdated');

  update onboarding_templates
     set items = v_new,
         description = case when v_desc_set then v_canon_desc else description end
   where id = v_tpl_id;

  -- Only re-publish something that was ALREADY published. Publishing a draft
  -- somebody is still working on is its own kind of overwriting.
  if v_tpl_stat = 'published' then
    v_pub := publish_onboarding_template(v_tpl_id);
    if v_pub ? 'errors' then
      raise exception 'upgrade_starter_onboarding_template: publish refused after a validated merge — %', v_pub->>'errors';
    end if;
  end if;

  -- Re-read and RE-DERIVE. A function that reports what it intended rather
  -- than what the row now says is the defect at the top of this file.
  v_after   := public.starter_template_state_internal(v_tenant);
  v_after_n := (v_after->>'tenant_items')::integer;

  perform append_audit_event_internal(
    v_tenant, 'You', 'human',
    format('Starter onboarding template upgraded — %s to %s items (%s added)',
           v_before_n, v_after_n, coalesce(array_length(v_added, 1), 0)),
    'config_change',
    jsonb_build_object('kind', 'onboarding_starter_template_upgrade',
                       'template_id', v_tpl_id,
                       'items_before', v_before_n, 'items_after', v_after_n,
                       'added_keys', to_jsonb(v_added),
                       'preserved_edits', coalesce(p_preserve_edits, false),
                       'was_status', v_status,
                       'now_status', v_after->>'status',
                       'republished', v_tpl_stat = 'published'));

  return v_after || jsonb_build_object(
    'ok', true, 'changed', true, 'refused', false,
    'was_status', v_status,
    'items_before', v_before_n,
    'items_after', v_after_n,
    'added_keys', to_jsonb(v_added),
    'description_updated', v_desc_set,
    'republished', v_tpl_stat = 'published',
    'message', format('Upgraded from %s to %s items; %s added, 0 changed, 0 removed.',
                      v_before_n, v_after_n, coalesce(array_length(v_added, 1), 0)))
      || v_pub;
end;
$function$;

-- ── 6. Staying behind, on purpose and on the record ──────────────────────
create or replace function public.acknowledge_starter_template_baseline(p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_tenant uuid;
  v_state  jsonb;
  v_actor  text;
begin
  v_tenant := auth_tenant_id();
  if v_tenant is null then
    raise exception 'no tenant for caller';
  end if;
  if not auth_has_tenant_role(array['tenant_owner', 'tenant_admin']) then
    raise exception 'only workspace owners/admins can decide which starter onboarding list this workspace runs';
  end if;

  v_state := public.starter_template_state_internal(v_tenant);
  if (v_state->>'status') = 'absent' then
    return v_state || jsonb_build_object('ok', false, 'refused', true,
      'reason', 'not_installed',
      'message', 'There is no starter template here to make a decision about.');
  end if;

  select coalesce(nullif(full_name, ''), 'A workspace member') into v_actor
    from profiles where user_id = auth.uid() limit 1;

  -- The two md5s are what make this expire. certify honours the
  -- acknowledgement only while BOTH still match; edit the template or move the
  -- canonical list and the decision lapses, because it was a decision about a
  -- specific comparison and that comparison no longer exists.
  perform append_audit_event_internal(
    v_tenant, coalesce(v_actor, 'A workspace member'), 'human',
    format('Starter onboarding list kept as-is — %s of %s items, %s behind',
           v_state->>'tenant_items', v_state->>'canon_items', v_state->>'behind_by'),
    'config_change',
    jsonb_build_object('kind', 'onboarding_starter_baseline_acknowledged',
                       'template_id', v_state->>'template_id',
                       'items_md5', v_state->>'items_md5',
                       'canon_md5', v_state->>'canon_md5',
                       'status_at_ack', v_state->>'status',
                       'behind_by', v_state->>'behind_by',
                       'note', coalesce(p_note, '')));

  return v_state || jsonb_build_object('ok', true, 'acknowledged', true,
    'message', format('Recorded: this workspace stays on its current %s-item starter list.',
                      v_state->>'tenant_items'));
end;
$function$;

-- ── 7. Grants — migs 610+630. Strip both default mechanisms, then hand back
-- only what is needed. `create or replace` PRESERVES existing grants, so an
-- inherited hole would survive untouched unless it is revoked explicitly.
revoke all on function public.starter_onboarding_template_name() from public, anon, authenticated;
grant execute on function public.starter_onboarding_template_name() to authenticated, service_role;

revoke all on function public.starter_template_verdict(jsonb, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.starter_template_verdict(jsonb, jsonb, boolean) to service_role;

-- Not authenticated: it takes a tenant id, and handing the browser a
-- tenant-id-shaped read is the migs 662-664 shape even for a STABLE function.
revoke all on function public.starter_template_state_internal(uuid) from public, anon, authenticated;
grant execute on function public.starter_template_state_internal(uuid) to service_role;

revoke all on function public.starter_onboarding_template_status() from public, anon;
grant execute on function public.starter_onboarding_template_status() to authenticated, service_role;

revoke all on function public.install_starter_onboarding_template() from public, anon;
grant execute on function public.install_starter_onboarding_template() to authenticated, service_role;

revoke all on function public.upgrade_starter_onboarding_template(boolean) from public, anon;
grant execute on function public.upgrade_starter_onboarding_template(boolean) to authenticated, service_role;

revoke all on function public.acknowledge_starter_template_baseline(text) from public, anon;
grant execute on function public.acknowledge_starter_template_baseline(text) to authenticated, service_role;

-- ── 8. Assertions ────────────────────────────────────────────────────────
-- Every one of these is about SCHEMA or about a PURE FUNCTION over literals.
-- None joins to a tenant row, so this migration replays on an empty database,
-- on a restored backup, and on a fresh environment.

-- 8a. The verdict, driven through all four states on literals.
do $$
declare
  c jsonb := '[{"key":"a","label":"A"},{"key":"b","label":"B"},{"key":"c","label":"C"}]'::jsonb;
  v jsonb;
begin
  -- CURRENT: identical content.
  v := public.starter_template_verdict(c, c, false);
  if v->>'status' <> 'current' or (v->>'behind_by')::int <> 0 or (v->>'edited')::boolean then
    raise exception '817: identical items must be current, got %', v;
  end if;
  -- CURRENT even when touched — items ARE canon, history is irrelevant.
  v := public.starter_template_verdict(c, c, true);
  if v->>'status' <> 'current' then
    raise exception '817: identical items must stay current when touched, got %', v;
  end if;
  -- OUTDATED: a strict, unedited subset.
  v := public.starter_template_verdict(c, '[{"key":"a","label":"A"}]'::jsonb, false);
  if v->>'status' <> 'outdated' or (v->>'behind_by')::int <> 2
     or (v->>'edited')::boolean or v->'missing_keys' <> '["b","c"]'::jsonb then
    raise exception '817: an untouched strict subset must be outdated and name what is missing, got %', v;
  end if;
  -- DIVERGENT by HISTORY: the same subset, on a row a person has written to.
  -- ⚠ This pin is the asymmetry that keeps the upgrade safe. If it ever flips
  -- to outdated, a deliberately deleted item becomes something we silently
  -- put back.
  v := public.starter_template_verdict(c, '[{"key":"a","label":"A"}]'::jsonb, true);
  if v->>'status' <> 'divergent' or not (v->>'edited')::boolean then
    raise exception '817: a TOUCHED subset must be divergent, not outdated, got %', v;
  end if;
  -- DIVERGENT by MODIFICATION, with history clean — content alone must decide.
  v := public.starter_template_verdict(c,
        '[{"key":"a","label":"EDITED"},{"key":"b","label":"B"},{"key":"c","label":"C"}]'::jsonb, false);
  if v->>'status' <> 'divergent' or v->'modified_keys' <> '["a"]'::jsonb then
    raise exception '817: an in-place edit must be divergent on content alone, got %', v;
  end if;
  -- DIVERGENT by ADDITION, history clean.
  v := public.starter_template_verdict(c,
        (c || '[{"key":"zz","label":"Mine"}]'::jsonb), false);
  if v->>'status' <> 'divergent' or v->'extra_keys' <> '["zz"]'::jsonb then
    raise exception '817: an added key must be divergent on content alone, got %', v;
  end if;
  -- Key ORDER and whitespace must not read as an edit.
  v := public.starter_template_verdict(
        '[{"key":"a","label":"A"}]'::jsonb, '[{"label":"A","key":"a"}]'::jsonb, false);
  if v->>'status' <> 'current' then
    raise exception '817: jsonb key order must not read as an edit, got %', v;
  end if;
  -- A verdict that cannot decide must refuse, not guess.
  begin
    v := public.starter_template_verdict(c, '"not an array"'::jsonb, false);
    raise exception '817: verdict accepted a non-array items value';
  exception when others then
    if sqlerrm not like '%items must be a jsonb array%' then raise; end if;
  end;
end $$;

-- 8b. The classifier refuses a null tenant rather than describing nobody.
do $$
begin
  begin
    perform public.starter_template_state_internal(null);
    raise exception '817: starter_template_state_internal accepted a null tenant';
  exception when others then
    if sqlerrm not like '%p_tenant_id is required%' then raise; end if;
  end;
end $$;

-- 8c. An unknown workspace is `absent`, and says so with the canonical
-- denominator. True on any database including an empty one.
do $$
declare v jsonb := public.starter_template_state_internal('00000000-0000-0000-0000-00000000dead'::uuid);
begin
  if v->>'status' <> 'absent' or (v->>'canon_items')::int <> 16 then
    raise exception '817: an unknown workspace must classify as absent against a 16-item canon, got %', v;
  end if;
end $$;

-- 8d. The installer must READ the classifier. Without this the honest branch
-- can be quietly reverted to `already_installed: true` and every other
-- assertion here would still pass.
do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'install_starter_onboarding_template'
       and p.prosrc like '%starter_template_state_internal%'
  ) then
    raise exception '817: install_starter_onboarding_template does not consult the classifier — it is back to reporting success for doing nothing';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'upgrade_starter_onboarding_template'
       and p.prosrc like '%template_has_local_edits%'
  ) then
    raise exception '817: upgrade_starter_onboarding_template has lost its edited-template refusal';
  end if;
end $$;

-- 8e. The perimeter, asserted in BOTH directions. A revoke that broke a live
-- button is as much a defect as a grant that opened one.
do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('public.starter_onboarding_template_name()',        true,  false),
      ('public.starter_template_verdict(jsonb,jsonb,boolean)', false, false),
      ('public.starter_template_state_internal(uuid)',     false, false),
      ('public.starter_onboarding_template_status()',      true,  false),
      ('public.install_starter_onboarding_template()',     true,  false),
      ('public.upgrade_starter_onboarding_template(boolean)', true, false),
      ('public.acknowledge_starter_template_baseline(text)',  true, false)
    ) as t(sig, want_authenticated, want_anon)
  loop
    if has_function_privilege('anon', r.sig, 'EXECUTE') <> r.want_anon then
      raise exception '817: anon EXECUTE on % is % — expected %', r.sig,
        has_function_privilege('anon', r.sig, 'EXECUTE'), r.want_anon;
    end if;
    if has_function_privilege('authenticated', r.sig, 'EXECUTE') <> r.want_authenticated then
      raise exception '817: authenticated EXECUTE on % is % — expected %', r.sig,
        has_function_privilege('authenticated', r.sig, 'EXECUTE'), r.want_authenticated;
    end if;
    if not has_function_privilege('service_role', r.sig, 'EXECUTE') then
      raise exception '817: service_role cannot execute %', r.sig;
    end if;
  end loop;
end $$;

-- 8f. The name is single-sourced and all three readers use the function, not a
-- copy of the literal.
do $$
begin
  if public.starter_onboarding_template_name() <> 'SaaS onboarding — starter' then
    raise exception '817: the starter template name changed — every existing tenant row would become invisible to the classifier';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('install_starter_onboarding_template',
                         'starter_template_state_internal')
       and p.prosrc not like '%starter_onboarding_template_name()%'
  ) then
    raise exception '817: a reader of the starter template inlines the name literal instead of calling starter_onboarding_template_name() — that is how the classifier and the installer come to disagree about which row they mean';
  end if;
end $$;

commit;
