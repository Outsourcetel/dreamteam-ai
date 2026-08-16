-- 750_the_demand_signal_gets_a_reader.sql
-- ==========================================================================
-- WHY: migration 744 gave the demand signal a LIFETIME. It did not give it a
-- READER. `discovery_capability_demand_log` and its aggregate view
-- `discovery_capability_demand` are granted to postgres + service_role only,
-- and nothing in this product selects from either. The founder's requirement,
-- verbatim (2026-08-15): *"the same flag to us at platform level so we know
-- what customer asked for that need our attention to build or evaluate."*
--
-- A history nobody can read is a history nobody has. This migration is the
-- read path; the platform page that calls it is in the same change.
--
-- ==========================================================================
-- WHY `authenticated` STILL CANNOT SELECT THE TABLE, AND MUST NOT
--
-- 744's perimeter is correct and is not touched here. This is a CROSS-TENANT
-- tally of what customers asked for and could not get: one workspace seeing
-- another's unmet needs is a disclosure, not a feature. So the table stays
-- closed and the ONLY door is this SECURITY DEFINER function, which asks the
-- capability question before it reads anything.
--
-- ==========================================================================
-- THE GUARD, AND THE SHAPE THAT IS BANNED
--
--     if not resolve_platform_capability(auth.uid(), 'tenants.manage') then
--       raise exception '...';
--     end if;
--
-- copied from `audit_tenant_provisioning` (migration 723:138), which is the
-- repo's existing precedent for a cross-tenant roll-up read reached from the
-- Platform Console by a signed-in operator.
--
-- ⚠⚠ THERE IS NO `auth.uid() is not null and` PREFIX AND THERE NEVER MAY BE.
-- Migration 749 removed that shape from 29 functions and shipped
-- scripts/secdef-authority-prefix.mjs, which goes red on a new one. The prefix
-- makes the check SKIP rather than FAIL when auth.uid() is null — which is
-- every service_role call and every JWT with no `sub`.
--
-- MEASURED HERE RATHER THAN ASSUMED, on this database, 2026-08-17:
--     select resolve_platform_capability(null,'tenants.manage')  ->  false
--     select resolve_platform_capability(null,'support.cross_tenant') -> false
-- `false`, not `null` — 077's body returns early with a literal `false` when
-- the profile lookup finds nothing. So `if not <false>` is `if true`, the
-- exception fires, and the guard FAILS CLOSED for an unidentified caller.
-- Probe 1 below fires it rather than trusting the arithmetic.
--
-- ==========================================================================
-- WHY `tenants.manage` AND NOT ONE OF THE OTHER FOUR LIVE KEYS
--
-- Live keys in use: tenants.manage, team.manage, billing.manage,
-- remote_access.use, support.cross_tenant. No new key is invented here.
--
--   · `support.cross_tenant` is the closest-SOUNDING and is wrong. It exists
--     so a support operator can see ONE workspace's work while helping that
--     workspace (078:574 uses it exactly that way). This screen is not about
--     one workspace; it is the platform's own roadmap input. Gating a
--     roadmap surface on a support key would also hand it to every
--     `platform_support` account by role default (077:112-113).
--   · `remote_access.use` is the authority to go INTO a customer's workspace.
--     Wrong axis entirely.
--   · `team.manage` is about who works here; `billing.manage` about money.
--
--   · `tenants.manage` is the one already used for the cross-tenant roll-up
--     read this most resembles. By ROLE DEFAULT (077:110-117) it resolves true
--     only for `platform_super_admin` — `platform_support` and
--     `platform_billing` both get `tenants.view` and NOT this — so the
--     narrowest live audience gets it first. Widening later is one row in
--     `platform_capability_grants` with effect='grant', no migration.
--     Measured on this database: 2 active platform profiles, both
--     platform_super_admin, 0 platform_support, 0 platform_billing.
--
-- ⚠ AND THE GATE READS THE CAPABILITY, NOT THE LAYER. Probe 3 inserts an
-- effect='deny' override for a real platform super-admin and asserts the
-- reader then REFUSES them. Without that probe, `resolve_platform_capability`
-- and a bare `layer = 'platform'` test are indistinguishable from the outside.
--
-- ==========================================================================
-- WHY IT RETURNS ONE JSONB ENVELOPE AND NOT `returns table`
--
-- Because of what has to be true when it comes back EMPTY. The log holds ZERO
-- rows today and will hold zero for a while, so the first thing anyone ever
-- sees on the new screen is an empty one — and an empty table captioned "no
-- demand yet" when the query actually failed or refused is the
-- measurement-organ-lies defect this repo keeps finding. (The neighbouring
-- Platform › System Health page has exactly that shape today: its fetch helper
-- swallows the error and returns [], so a refusal renders as "No connectors
-- configured by any tenant yet." Named, not fixed — out of scope here.)
--
-- Two things make the empty state honest, and only one of them is the
-- transport:
--   1. `.rpc()` RESOLVES on a Postgres error, so the client MUST read `error`
--      — that separates "refused/broken" from "ran and found nothing". The
--      product half does this and returns a discriminated result.
--   2. "found nothing" still has to be ANCHORED to something, or it is a
--      shrug. The anchor is: how many discovery interviews exist at all, when
--      the most recent one was, and how many dimensions in the catalogue can
--      even PRODUCE a demand row. If that last number is 0, the log is empty
--      by construction and "nothing yet" proves nothing about the product.
--
-- A `returns table` shape would put the anchor in a SECOND call that can fail
-- on its own, leaving the page holding an empty list and no anchor — the exact
-- state it must never be able to render. One call, one object: you cannot
-- obtain `demand: []` without also obtaining the numbers that explain it.
--
-- ⚠ `coalesce(jsonb_agg(...), '[]'::jsonb)`. jsonb_agg over no rows is NULL,
-- and a client doing `?? []` would turn a NULL into an empty list without ever
-- knowing which it had. Probe 2 asserts the array-ness on an empty log.
--
-- ==========================================================================
-- WHAT IT RETURNS, AND THE TENANT-NAMING JUDGEMENT
--
-- The aggregate is what to PRIORITISE. The evidence is what tells you WHAT TO
-- BUILD — `discovery_capability_demand_log.evidence` is the customer's own
-- recorded words, captured by 744's trigger from the interview's coverage. A
-- count says "four workspaces want HR"; the evidence says whether they mean
-- onboarding paperwork or firing people. So: aggregate AND drill-down.
--
-- ⚠ ORDER: `tenants_surfaced desc` first, then sessions, then recency. Ten
-- sessions from one workspace is ONE customer asking ten times; two workspaces
-- is two customers. Probe 6 constructs a case where the two orderings
-- DISAGREE (1 tenant × 5 sessions vs 3 tenants × 3 sessions) and asserts the
-- broad one ranks first — so re-sorting on sessions_surfaced goes red instead
-- of quietly changing what we build next.
--
-- ⚠ TENANT NAMING, THE GENUINE JUDGEMENT CALL. `tenant_label` is a
-- denormalised snapshot precisely so a row survives the tenant's deletion.
-- Two defensible answers:
--   (a) name the workspace — "we can go talk to them";
--   (b) never name it — "this is an aggregate, not a customer list".
-- CHOSEN: (a), but ONLY on the evidence drill-down, never on the aggregate
-- row. Reasons, in order of weight:
--   · The founder's sentence asks for it by name: "so we know what CUSTOMER
--     asked for". Answering with an anonymised tally answers a different
--     question than the one asked.
--   · The boundary that matters is that no CUSTOMER ever sees this, and that
--     is enforced by grant + RLS-with-no-policy, not by hiding names from
--     platform staff who already hold `tenants.manage` — an authority that
--     includes suspending and deleting the workspace outright.
--   · Keeping names off the aggregate row is not privacy theatre, it is
--     framing: the default view is a prioritisation table, and the named
--     customer arrives attached to the specific sentence they said, which is
--     the only form in which a name is actually actionable. "Acme: 4" invites
--     an account conversation; «"nobody chases our unpaid invoices" — Acme»
--     invites a product decision.
-- If that trade is ever revisited, the change is to stop selecting
-- `tenant_label` in the `quotes` object below, and nothing else.
--
-- ==========================================================================
-- WHY authenticated ONLY, AND service_role EXPLICITLY NOT
--
-- The Platform Console runs as a SIGNED-IN USER — every platform read it does
-- goes through supabase.rpc() on the browser client (fetchPlatformTenantOverview,
-- fetchPlatformConnectorHealth, src/lib/api.ts), so `authenticated` is the role
-- that has to hold EXECUTE.
--
-- `service_role` is revoked, deliberately, and this is not just tidiness:
-- auth.uid() is NULL under service_role, so this function can only ever REFUSE
-- a service-role caller. Granting EXECUTE would ship a control that is
-- guaranteed to fail — an invitation for someone to "fix" the guard. A backend
-- job that genuinely needs this data already holds SELECT on the log and the
-- view directly (744:198). Probe 7 asserts both directions with the
-- full-signature form of has_function_privilege.
-- ==========================================================================

begin;

create or replace function public.platform_capability_demand()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_demand           jsonb;
  v_sessions_total   integer;
  v_sessions_latest  timestamptz;
  v_log_rows         integer;
  v_gap_dimensions   integer;
  v_watched          jsonb;
begin
  -- THE GUARD. One line, no identity test in front of it. See the header.
  if not resolve_platform_capability(auth.uid(), 'tenants.manage') then
    raise exception 'only a platform team member with tenant management access may read cross-tenant capability demand';
  end if;

  -- ── the anchors ───────────────────────────────────────────────────────
  -- These exist so "nothing yet" is a statement about something. Read even
  -- when the demand list is non-empty, because the screen shows them either
  -- way and a number that only appears on the empty path is a number nobody
  -- ever checks.
  select count(*)::integer, max(created_at)
    into v_sessions_total, v_sessions_latest
    from discovery_sessions;

  select count(*)::integer into v_log_rows
    from discovery_capability_demand_log;

  -- How many dimensions in the CATALOGUE currently name a capability this
  -- product cannot staff, and which capabilities those are. If this is 0 the
  -- log can never gain a row, and an empty screen proves nothing at all — the
  -- vacuity condition, reported rather than hidden.
  select count(*)::integer into v_gap_dimensions
    from discovery_capability_gaps;

  select coalesce(jsonb_agg(distinct cap.a), '[]'::jsonb) into v_watched
    from discovery_capability_gaps g
    cross join lateral unnest(g.planned_archetypes) cap(a);

  -- ── the demand itself ─────────────────────────────────────────────────
  -- ⚠⚠ THE EVIDENCE JOIN MUST CARRY dimension_title, AND THAT IS NOT
  -- COSMETIC. 744's view groups on (capability, dimension_key,
  -- dimension_title) — three columns, because `dimension_title` is a
  -- DENORMALISED SNAPSHOT taken at capture time (744's trigger reads
  -- `g.title` into the row) precisely so a demand row survives the dimension
  -- being retitled. That is 744's whole point, and it means ONE capability
  -- can legitimately hold TWO aggregate rows: the sentences said before the
  -- rename and the ones said after.
  --
  -- Joining the quotes on two of those three columns is therefore a
  -- grain mismatch, and a left join across a grain mismatch FANS OUT. Measured
  -- on a 3-row stub before this line was changed — one capability, one
  -- dimension_key, two titles:
  --     "The workforce itself"   tenants=2 sessions=2 evidence_total=3 → Corvus,Borden,Acme
  --     "Your people (renamed)"  tenants=1 sessions=1 evidence_total=3 → Corvus,Borden,Acme
  -- Three real sentences rendered SIX times, and the one-workspace row
  -- captioned "What they said (3)" carrying two sentences that workspace
  -- never said. Attributing a customer's words to a customer who did not say
  -- them is the worst failure this screen has available: the whole reason the
  -- evidence exists is that the aggregate says how loud and the quote says
  -- WHAT — and a misattributed quote corrupts the half we act on.
  --
  -- Same stub with the three columns carried through: 2 quotes on the
  -- original title, 1 on the renamed one, each sentence on exactly one row.
  -- Probe 5b pins it against a REAL retitle rather than against arithmetic.
  with ranked as (
    select l.capability, l.dimension_key, l.dimension_title,
           l.tenant_label, l.surfaced_at, l.evidence,
           row_number() over (partition by l.capability, l.dimension_key, l.dimension_title
                              order by l.surfaced_at desc, l.id) as rn
      from discovery_capability_demand_log l
     where nullif(btrim(coalesce(l.evidence, '')), '') is not null
  ),
  quoted as (
    select r.capability, r.dimension_key, r.dimension_title,
           count(*)::integer as evidence_total,
           count(*) filter (where r.rn <= 25)::integer as evidence_shown,
           jsonb_agg(jsonb_build_object(
                       'tenant_label', r.tenant_label,
                       'surfaced_at',  r.surfaced_at,
                       'evidence',     r.evidence)
                     order by r.surfaced_at desc, r.rn)
             filter (where r.rn <= 25) as quotes
      from ranked r
     group by r.capability, r.dimension_key, r.dimension_title
  )
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'capability',        d.capability,
               'dimension_key',     d.dimension_key,
               'dimension_title',   d.dimension_title,
               'tenants_surfaced',  d.tenants_surfaced,
               'sessions_surfaced', d.sessions_surfaced,
               'first_surfaced_at', d.first_surfaced_at,
               'last_surfaced_at',  d.last_surfaced_at,
               -- ⚠ evidence_total counts rows that CARRIED a sentence, which
               -- is not the same as sessions_surfaced: a dimension can be
               -- marked heard with no quotable evidence. Reporting both stops
               -- the screen implying we have four quotes when we have one.
               'evidence_total',    coalesce(q.evidence_total, 0),
               'evidence_shown',    coalesce(q.evidence_shown, 0),
               'evidence',          coalesce(q.quotes, '[]'::jsonb))
             -- THE ORDER. tenants first — see the header.
             order by d.tenants_surfaced desc,
                      d.sessions_surfaced desc,
                      d.last_surfaced_at desc,
                      d.capability),
           '[]'::jsonb)
    into v_demand
    from discovery_capability_demand d
    left join quoted q
      on q.capability = d.capability
     and q.dimension_key = d.dimension_key
     -- The third column. Without it this join is coarser than the view's own
     -- grain and every quote lands on every retitling of the dimension.
     and q.dimension_title = d.dimension_title;

  return jsonb_build_object(
    'ok',                 true,
    'generated_at',       now(),
    -- The anchors travel WITH the list, in the same object, so an empty list
    -- cannot be rendered without them.
    'sessions_on_record', v_sessions_total,
    'latest_session_at',  v_sessions_latest,
    'log_rows',           v_log_rows,
    'gap_dimensions',     v_gap_dimensions,
    'capabilities_watched', v_watched,
    'demand',             v_demand);
end;
$fn$;

comment on function public.platform_capability_demand() is
  'Platform-only reader for the cross-tenant capability demand signal (migration 744). Returns one jsonb envelope: the aggregate from discovery_capability_demand, the customers own recorded words from discovery_capability_demand_log, and the anchors that make an empty result honest (how many interviews exist, when the last one ran, how many catalogue dimensions can produce demand at all). Gated on resolve_platform_capability(auth.uid(), tenants.manage). See migration 750.';

-- ── perimeter ────────────────────────────────────────────────────────────
-- `authenticated` only. service_role is revoked on purpose — see the header:
-- auth.uid() is null there, so it could only ever be refused, and a control
-- that cannot work invites somebody to remove the guard that stops it.
revoke all on function public.platform_capability_demand() from public, anon, authenticated, service_role;
grant execute on function public.platform_capability_demand() to authenticated;

-- ==========================================================================
-- VERIFICATION
--
-- ⚠ THE POSITIVE CONTROL IS THE LOAD-BEARING PROBE, because the table is
-- EMPTY. A reader that returns nothing over an empty table is
-- indistinguishable from a reader that returns nothing over anything. So the
-- probes INSERT demand, in a rolled-back block, and assert the reader hands it
-- back — with the right counts, the right order and the customer's actual
-- sentence.
--
-- ⚠ The inserted rows use SYNTHETIC tenant ids that match no `tenants` row.
-- That is not laziness: it is 744's design exercised. The log carries no
-- foreign keys precisely so a demand row outlives its tenant, and a probe that
-- only ever used live tenants would never test the case the table exists for.
-- ==========================================================================
do $$
declare
  v_platform_uid uuid;
  v_owner_uid    uuid;
  v_dim_a  text;  v_cap_a  text;  v_title_a text;
  v_dim_b  text;  v_cap_b  text;  v_title_b text;
  -- ⚠ THE RETITLE. Derived from v_title_b at probe time rather than declared
  -- as a constant, so it is guaranteed to DIFFER from whatever the live
  -- catalogue currently calls that dimension — a hardcoded string would
  -- silently become equal to the real title the day somebody renames the
  -- dimension to it, and this probe would then pass by comparing a row to
  -- itself.
  v_title_b_ren text;
  v_pairs  integer;
  v_t1 uuid := gen_random_uuid();
  v_t2 uuid := gen_random_uuid();
  v_t3 uuid := gen_random_uuid();
  v_before  bigint;
  v_after   bigint;
  v_res     jsonb;
  v_row     jsonb;
  v_uid_now uuid;
  v_msg     text;
  v_ref     boolean;
  v_pos_a   integer;
  v_pos_b   integer;
  -- ⚠ THE TRUTH, READ AS `postgres`, BEFORE ANY `set local role`.
  -- The first draft of probe 4 compared the envelope against sub-selects
  -- written inline — which would have executed AS `authenticated`, where
  -- discovery_sessions is RLS-scoped to a tenant the platform operator does
  -- not belong to and discovery_capability_demand_log carries no SELECT grant
  -- at all. So the log comparison would have RAISED "permission denied", and
  -- the sessions comparison would have quietly compared the definer's true
  -- count against an RLS-filtered 0 — passing today only because both are 0,
  -- and going red for the wrong reason the day an interview exists.
  v_sessions_true integer;
  v_gaps_true     integer;
  v_caps_true     integer;
  v_checks  integer := 0;
  v_bad     text[] := '{}';
  v_quote   text := '750 probe: nobody here chases an unpaid invoice and it is costing us every month';
  -- Said about the SAME capability and the SAME dimension_key, but recorded
  -- after the dimension was retitled. Probe 5b.
  v_quote_ren text := '750 probe: said after the rename, and it belongs to the renamed row alone';
  v_row_ren jsonb;
  v_hits    integer;
begin
  select count(*) into v_before from public.discovery_capability_demand_log;

  -- The anchor values the envelope must reproduce, read here as `postgres`.
  -- See the declaration note — reading them later, under an assumed role,
  -- compares the reader against a censored view of the same tables.
  select count(*)::integer into v_sessions_true from public.discovery_sessions;
  select count(*)::integer into v_gaps_true from public.discovery_capability_gaps;
  select count(distinct cap.a)::integer into v_caps_true
    from public.discovery_capability_gaps g
    cross join lateral unnest(g.planned_archetypes) cap(a);

  -- ── subjects, from live data ────────────────────────────────────────────
  select p.user_id into v_platform_uid
    from profiles p
   where p.layer = 'platform' and coalesce(p.is_active, true)
     and resolve_platform_capability(p.user_id, 'tenants.manage')
   order by p.user_id limit 1;

  select p.user_id into v_owner_uid
    from profiles p
   where p.layer = 'tenant' and coalesce(p.is_active, true) and p.role = 'tenant_owner'
     and not resolve_platform_capability(p.user_id, 'tenants.manage')
   order by p.user_id limit 1;

  -- Two DIFFERENT (dimension, capability) pairs from the live catalogue.
  select g.dimension_key, cap.a, g.title into v_dim_a, v_cap_a, v_title_a
    from discovery_capability_gaps g cross join lateral unnest(g.planned_archetypes) cap(a)
   order by g.dimension_key, cap.a limit 1;
  select g.dimension_key, cap.a, g.title into v_dim_b, v_cap_b, v_title_b
    from discovery_capability_gaps g cross join lateral unnest(g.planned_archetypes) cap(a)
   order by g.dimension_key, cap.a offset 1 limit 1;
  select count(*) into v_pairs
    from discovery_capability_gaps g cross join lateral unnest(g.planned_archetypes) cap(a);

  -- The retitled snapshot for pair B. See the declaration note.
  v_title_b_ren := coalesce(v_title_b, '(untitled)') || ' [750 probe, renamed after the fact]';

  -- ── vacuity guards. Each one is a probe that could not otherwise fail. ──
  if v_platform_uid is null then
    raise exception '750 vacuity guard: no active platform profile resolves tenants.manage, so the SUCCESS probe would have nobody to succeed as and every refusal below would be trivially true';
  end if;
  if v_owner_uid is null then
    raise exception '750 vacuity guard: no active tenant_owner exists who is NOT platform, so probe 2 could not tell "refuses a non-platform caller" from "refuses everybody"';
  end if;
  if v_pairs < 2 then
    raise exception '750 vacuity guard: the catalogue offers % (dimension, capability) pair(s); the ordering probe needs 2 that can disagree', v_pairs;
  end if;
  -- ⚠ Probe 5b's ENTIRE content is that two dimension_titles differ. If they
  -- are equal the retitle collapses into the original row, every assertion
  -- below it passes for free, and the grain fix ships unpinned — the
  -- gate-that-cannot-fail trap, in the probe written to prevent it.
  if v_title_b_ren is not distinct from v_title_b then
    raise exception '750 vacuity guard: the retitled dimension_title is identical to the original (%L) — probe 5b would compare a row against itself and could not detect a coarse evidence join', v_title_b;
  end if;
  -- ⚠ The count assertions below are absolute (3 tenants, 5 sessions), so a
  -- PRE-EXISTING log row on either probe pair would make them fail with a
  -- confusing arithmetic complaint about the reader. Zero on this database
  -- today; anywhere it is not, say so plainly instead.
  if exists (select 1 from public.discovery_capability_demand_log l
              where (l.capability = v_cap_a and l.dimension_key = v_dim_a)
                 or (l.capability = v_cap_b and l.dimension_key = v_dim_b)) then
    raise exception '750: the demand log already holds real rows for (%, %) or (%, %). The positive-control probe asserts exact counts and would report a false defect in the reader. Point the probe at two unused pairs before re-running.',
      v_cap_a, v_dim_a, v_cap_b, v_dim_b;
  end if;

  -- The claim this migration's header makes about the guard, checked rather
  -- than quoted. `false`, not null — `if not null` would be NEITHER branch.
  v_checks := v_checks + 1;
  if resolve_platform_capability(null, 'tenants.manage') is distinct from false then
    v_bad := array_append(v_bad, format('resolve_platform_capability(null, tenants.manage) returned %L, not false — `if not <that>` does not necessarily raise, and this whole gate may fail OPEN for a caller with no identity',
                                        coalesce(resolve_platform_capability(null, 'tenants.manage')::text, 'NULL')));
  end if;

  begin
    ------------------------------------------------------------------------
    -- PROBE 1 — A CALLER WITH NO auth.uid() IS REFUSED.
    -- ⚠ BOTH JWT GUCs cleared: auth.uid() falls back from
    -- request.jwt.claim.sub to request.jwt.claims->>'sub', so clearing one
    -- leaves a fallback. The null-ness is then ASSERTED — a refusal for the
    -- wrong reason is not evidence.
    -- Called AS `authenticated`, which HOLDS execute, so the refusal is the
    -- BODY's and not the grant's.
    ------------------------------------------------------------------------
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims',    '', true);
    select auth.uid() into v_uid_now;
    set local role authenticated;

    v_checks := v_checks + 1;
    if v_uid_now is not null then
      v_bad := array_append(v_bad, format('probe 1 could not clear the identity (auth.uid() = %L) — its refusal would say nothing about an unidentified caller', v_uid_now::text));
    end if;

    v_ref := false; v_msg := null;
    begin
      v_res := public.platform_capability_demand();
    exception when others then v_ref := true; v_msg := sqlerrm; end;
    v_checks := v_checks + 1;
    if not v_ref then
      v_bad := array_append(v_bad, 'A CALLER WITH NO IDENTITY READ THE CROSS-TENANT DEMAND SIGNAL — the guard is fail-open, which is what the banned `auth.uid() is not null and` prefix does');
    elsif coalesce(v_msg, '') not like 'only a platform team member%' then
      v_bad := array_append(v_bad, format('the unidentified caller was refused, but NOT by the capability guard: %L', coalesce(v_msg, 'NULL')));
    end if;

    reset role;

    ------------------------------------------------------------------------
    -- PROBE 2 — A TENANT OWNER IS REFUSED.
    -- The most privileged CUSTOMER role there is. If this passes, one
    -- workspace can read every other workspace's unmet needs.
    ------------------------------------------------------------------------
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', v_owner_uid::text, true);
    select auth.uid() into v_uid_now;
    set local role authenticated;

    v_checks := v_checks + 1;
    if v_uid_now is distinct from v_owner_uid then
      v_bad := array_append(v_bad, format('probe 2 could not adopt the tenant owner identity (auth.uid() = %L, wanted %L)', coalesce(v_uid_now::text, 'NULL'), v_owner_uid::text));
    end if;

    v_ref := false; v_msg := null;
    begin
      v_res := public.platform_capability_demand();
    exception when others then v_ref := true; v_msg := sqlerrm; end;
    v_checks := v_checks + 1;
    if not v_ref then
      v_bad := array_append(v_bad, 'A TENANT OWNER READ THE CROSS-TENANT DEMAND SIGNAL — every workspace can now see what every other workspace asked for and could not get');
    elsif coalesce(v_msg, '') not like 'only a platform team member%' then
      v_bad := array_append(v_bad, format('the tenant owner was refused, but NOT by the capability guard: %L', coalesce(v_msg, 'NULL')));
    end if;

    reset role;

    ------------------------------------------------------------------------
    -- PROBE 3 — THE GATE READS THE CAPABILITY, NOT THE LAYER.
    -- A real platform super-admin, with an explicit effect='deny' override on
    -- tenants.manage, must be REFUSED. Without this, a guard spelled
    -- `layer = 'platform'` would pass every other probe in this file.
    ------------------------------------------------------------------------
    insert into platform_capability_grants (user_id, capability, effect, note)
    values (v_platform_uid, 'tenants.manage', 'deny', '750 probe, rolled back')
    on conflict (user_id, capability)
      do update set effect = 'deny', note = '750 probe, rolled back';

    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', v_platform_uid::text, true);
    set local role authenticated;

    v_ref := false; v_msg := null;
    begin
      v_res := public.platform_capability_demand();
    exception when others then v_ref := true; v_msg := sqlerrm; end;
    v_checks := v_checks + 1;
    if not v_ref then
      v_bad := array_append(v_bad, 'a platform operator whose tenants.manage is explicitly DENIED still read the demand signal — the guard is testing the platform LAYER, not the capability, and every per-person deny on this platform is decorative');
    elsif coalesce(v_msg, '') not like 'only a platform team member%' then
      v_bad := array_append(v_bad, format('the denied operator was refused, but NOT by the capability guard: %L', coalesce(v_msg, 'NULL')));
    end if;

    reset role;
    delete from platform_capability_grants
     where user_id = v_platform_uid and capability = 'tenants.manage' and note = '750 probe, rolled back';

    ------------------------------------------------------------------------
    -- PROBE 4 — THE AUTHORISED CALLER SUCCEEDS, AND THE EMPTY ANSWER IS AN
    -- ARRAY. Run BEFORE anything is inserted, because today's log is empty
    -- and that is the state the screen will actually meet first.
    -- ⚠ `jsonb_typeof = 'array'`, never `is not null`: jsonb_agg over no rows
    -- is NULL, and a null here would reach the client as `demand: null`,
    -- where a `?? []` turns it into an empty list nobody knows was missing.
    ------------------------------------------------------------------------
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', v_platform_uid::text, true);
    set local role authenticated;

    v_res := null;
    v_msg := null;
    begin
      v_res := public.platform_capability_demand();
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks + 1;
    if v_msg is not null then
      v_bad := array_append(v_bad, format('a platform operator holding tenants.manage was REFUSED (%s) — the platform cannot read its own signal', v_msg));
    end if;

    v_checks := v_checks + 1;
    if coalesce(v_res ->> 'ok', '') <> 'true' then
      v_bad := array_append(v_bad, format('the authorised read did not answer ok=true: %L', coalesce(v_res::text, 'NULL')));
    end if;

    v_checks := v_checks + 1;
    if jsonb_typeof(v_res -> 'demand') is distinct from 'array' then
      v_bad := array_append(v_bad, format('demand came back as %L rather than an array — an empty aggregate must be [] so the screen can tell "ran and found nothing" from "field absent"',
                                          coalesce(jsonb_typeof(v_res -> 'demand'), 'NULL')));
    end if;

    -- The anchors must be REAL numbers, not decoration. Compared against the
    -- tables themselves: hardcode either and this goes red.
    v_checks := v_checks + 1;
    if (v_res ->> 'sessions_on_record')::integer is distinct from v_sessions_true then
      v_bad := array_append(v_bad, format('sessions_on_record says %L but discovery_sessions holds %s — the anchor the empty state leans on is wrong, so "nothing yet" would be unanchored',
                                          coalesce(v_res ->> 'sessions_on_record', 'NULL'), v_sessions_true));
    end if;
    v_checks := v_checks + 1;
    if (v_res ->> 'log_rows')::integer is distinct from v_before::integer then
      v_bad := array_append(v_bad, format('log_rows says %L but the log holds %s', coalesce(v_res ->> 'log_rows', 'NULL'), v_before));
    end if;
    v_checks := v_checks + 1;
    if (v_res ->> 'gap_dimensions')::integer is distinct from v_gaps_true then
      v_bad := array_append(v_bad, format('gap_dimensions says %L but the catalogue holds %s gap dimension(s) — the vacuity number the screen uses to say "this list CAN fill" is wrong, and a wrong one turns an unfalsifiable empty state into a reassuring one',
                                          coalesce(v_res ->> 'gap_dimensions', 'NULL'), v_gaps_true));
    end if;
    v_checks := v_checks + 1;
    if jsonb_array_length(coalesce(v_res -> 'capabilities_watched', '[]'::jsonb)) is distinct from v_caps_true then
      v_bad := array_append(v_bad, format('capabilities_watched holds %s entries but the catalogue names %s distinct unstaffed capabilities',
                                          jsonb_array_length(coalesce(v_res -> 'capabilities_watched', '[]'::jsonb)), v_caps_true));
    end if;

    reset role;

    ------------------------------------------------------------------------
    -- PROBE 5 — THE POSITIVE CONTROL. Insert demand and read it back.
    --
    --   pair A ("the loud one")  : 1 tenant  × 5 sessions
    --   pair B ("the broad one") : 3 tenants × 3 sessions
    --
    -- The two orderings DISAGREE on this data, on purpose. See probe 6.
    ------------------------------------------------------------------------
    insert into discovery_capability_demand_log
      (tenant_id, session_id, dimension_key, tenant_label, dimension_title, capability, evidence, surfaced_at)
    select v_t1, gen_random_uuid(), v_dim_a, '[750 probe] Loud Single Workspace', v_title_a, v_cap_a,
           format('750 probe: we keep asking for this, time %s', i), now() - (i || ' hours')::interval
      from generate_series(1, 5) i;

    insert into discovery_capability_demand_log
      (tenant_id, session_id, dimension_key, tenant_label, dimension_title, capability, evidence, surfaced_at)
    values
      (v_t1, gen_random_uuid(), v_dim_b, '[750 probe] Loud Single Workspace', v_title_b, v_cap_b, '750 probe: first workspace said so', now() - interval '3 hours'),
      (v_t2, gen_random_uuid(), v_dim_b, '[750 probe] Second Workspace',      v_title_b, v_cap_b, v_quote,                              now() - interval '2 hours'),
      -- ⚠ evidence NULL on purpose: a dimension can be marked heard with
      -- nothing quotable. It must still count toward tenants_surfaced and
      -- must NOT appear as an empty quote.
      (v_t3, gen_random_uuid(), v_dim_b, '[750 probe] Third Workspace',       v_title_b, v_cap_b, null,                                 now() - interval '1 hour'),
      -- ⚠⚠ THE RETITLE ROW. Same capability, same dimension_key, DIFFERENT
      -- dimension_title — the state 744 built the denormalised snapshot to
      -- survive. It makes the aggregate hold TWO rows for pair B, which is
      -- the only condition under which a two-column evidence join can be told
      -- apart from a three-column one. Deliberately the SAME workspace that
      -- already spoke under the old title, so a fan-out shows up in both
      -- directions: the old row gaining a sentence said after the rename, and
      -- the new row gaining two it was never present for.
      (v_t1, gen_random_uuid(), v_dim_b, '[750 probe] Loud Single Workspace', v_title_b_ren, v_cap_b, v_quote_ren,                     now() - interval '30 minutes');

    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', v_platform_uid::text, true);
    set local role authenticated;

    v_res := null; v_msg := null;
    begin
      v_res := public.platform_capability_demand();
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks + 1;
    if v_msg is not null then
      v_bad := array_append(v_bad, format('the authorised read failed once the log held rows (%s) — the reader only works over an empty table, which is the one case that proves nothing', v_msg));
    end if;

    -- ---- pair B: the aggregate must match what was inserted --------------
    -- ⚠ QUALIFIED BY dimension_title, and it has to be. Pair B now spans TWO
    -- aggregate rows (the retitle, above), and a bare `select … into` over two
    -- matching rows takes the FIRST and raises nothing — so an unqualified
    -- lookup here would assert against whichever row the ordering happened to
    -- put first. That is the same coarse-match mistake the join itself made.
    select e into v_row
      from jsonb_array_elements(coalesce(v_res -> 'demand', '[]'::jsonb)) t(e)
     where e ->> 'capability' = v_cap_b and e ->> 'dimension_key' = v_dim_b
       and e ->> 'dimension_title' = v_title_b;

    v_checks := v_checks + 1;
    if v_row is null then
      v_bad := array_append(v_bad, format('3 workspaces surfaced %L on %L and the reader returned NO row for it — this is the whole point of the function', v_cap_b, v_dim_b));
    else
      v_checks := v_checks + 1;
      if (v_row ->> 'tenants_surfaced')::integer <> 3 then
        v_bad := array_append(v_bad, format('tenants_surfaced for %L is %L, expected 3 — the number the whole priority order is built on does not count what was inserted', v_cap_b, v_row ->> 'tenants_surfaced'));
      end if;
      v_checks := v_checks + 1;
      if (v_row ->> 'sessions_surfaced')::integer <> 3 then
        v_bad := array_append(v_bad, format('sessions_surfaced for %L is %L, expected 3', v_cap_b, v_row ->> 'sessions_surfaced'));
      end if;
      -- Two of the three rows carried a sentence; the third was silent.
      v_checks := v_checks + 1;
      if (v_row ->> 'evidence_total')::integer <> 2 then
        v_bad := array_append(v_bad, format('evidence_total for %L is %L, expected 2 — the silent row is being counted as a quote, or a real quote is being dropped', v_cap_b, v_row ->> 'evidence_total'));
      end if;
      v_checks := v_checks + 1;
      if jsonb_array_length(coalesce(v_row -> 'evidence', '[]'::jsonb)) <> 2 then
        v_bad := array_append(v_bad, format('the evidence array for %L holds %s quote(s), expected 2', v_cap_b, jsonb_array_length(coalesce(v_row -> 'evidence', '[]'::jsonb))));
      end if;

      ----------------------------------------------------------------------
      -- The customer's ACTUAL WORDS have to arrive. A reader that returns
      -- counts and loses the evidence tells you how loud the demand is and
      -- nothing about what to build.
      ----------------------------------------------------------------------
      v_checks := v_checks + 1;
      if not exists (select 1 from jsonb_array_elements(coalesce(v_row -> 'evidence', '[]'::jsonb)) q(e)
                      where e ->> 'evidence' = v_quote) then
        v_bad := array_append(v_bad, 'the exact sentence a workspace recorded did not come back in the evidence — the drill-down is the half that says WHAT to build, and it is empty');
      end if;
      -- ...and attached to the workspace that said it. This is the tenant-
      -- naming decision argued in the header, pinned so it cannot be dropped
      -- by accident rather than by decision.
      v_checks := v_checks + 1;
      if not exists (select 1 from jsonb_array_elements(coalesce(v_row -> 'evidence', '[]'::jsonb)) q(e)
                      where e ->> 'evidence' = v_quote and e ->> 'tenant_label' = '[750 probe] Second Workspace') then
        v_bad := array_append(v_bad, 'the evidence came back without the workspace that said it — naming the customer on the drill-down is a decision this migration argues for, so losing it must be a decision too');
      end if;
      -- ⚠ AND THE SENTENCE SAID AFTER THE RENAME MUST NOT BE HERE. This is the
      -- half of probe 5b that fires on the ORIGINAL row: a two-column evidence
      -- join fans every quote onto every retitling of the dimension, so this
      -- row would carry a sentence recorded against a title it never held.
      v_checks := v_checks + 1;
      if exists (select 1 from jsonb_array_elements(coalesce(v_row -> 'evidence', '[]'::jsonb)) q(e)
                  where e ->> 'evidence' = v_quote_ren) then
        v_bad := array_append(v_bad, 'the row for the ORIGINAL dimension title is carrying a sentence that was recorded after the dimension was RETITLED — the evidence join is coarser than the aggregate it decorates, and quotes are fanning across every title the dimension has ever had');
      end if;
    end if;

    ------------------------------------------------------------------------
    -- PROBE 5b — A RETITLED DIMENSION SPLITS THE AGGREGATE, AND EACH QUOTE
    -- LANDS ON EXACTLY ONE OF THE TWO ROWS.
    --
    -- 744 stores dimension_title as a DENORMALISED SNAPSHOT so a demand row
    -- outlives a rename, and its view groups on it. One capability can
    -- therefore hold two aggregate rows. The evidence side has to agree, or
    -- the left join fans every sentence onto every title.
    --
    -- ⚠ THE COUNT IS THE ASSERTION, NOT THE PRESENCE. "the quote came back"
    -- is true in the broken case too — it came back TWICE. So both sentences
    -- are counted across the WHOLE demand array, and either one appearing
    -- more than once is the defect.
    ------------------------------------------------------------------------
    select e into v_row_ren
      from jsonb_array_elements(coalesce(v_res -> 'demand', '[]'::jsonb)) t(e)
     where e ->> 'capability' = v_cap_b and e ->> 'dimension_key' = v_dim_b
       and e ->> 'dimension_title' = v_title_b_ren;

    v_checks := v_checks + 1;
    if v_row_ren is null then
      v_bad := array_append(v_bad, format('a demand row recorded under a RETITLED dimension (%L) came back with no aggregate row of its own — 744 snapshots dimension_title precisely so the sentence survives the rename, and this reader has lost it', v_title_b_ren));
    else
      -- One workspace, one session, under the new title.
      v_checks := v_checks + 1;
      if (v_row_ren ->> 'tenants_surfaced')::integer <> 1 or (v_row_ren ->> 'sessions_surfaced')::integer <> 1 then
        v_bad := array_append(v_bad, format('the retitled row reports %L workspace(s) / %L session(s), expected 1 / 1', v_row_ren ->> 'tenants_surfaced', v_row_ren ->> 'sessions_surfaced'));
      end if;
      -- ...carrying its OWN single sentence and nobody else's. In the broken
      -- shape this row reads evidence_total = 3 and is captioned "What they
      -- said (3)" while holding two sentences this workspace never said.
      v_checks := v_checks + 1;
      if (v_row_ren ->> 'evidence_total')::integer <> 1 then
        v_bad := array_append(v_bad, format('the retitled row reports evidence_total %L, expected 1 — one workspace said one sentence under that title, so anything higher is another row''s evidence being attributed to a customer who did not say it',
                                            v_row_ren ->> 'evidence_total'));
      end if;
      v_checks := v_checks + 1;
      if jsonb_array_length(coalesce(v_row_ren -> 'evidence', '[]'::jsonb)) <> 1
         or not exists (select 1 from jsonb_array_elements(coalesce(v_row_ren -> 'evidence', '[]'::jsonb)) q(e)
                         where e ->> 'evidence' = v_quote_ren) then
        v_bad := array_append(v_bad, format('the retitled row''s evidence array holds %s quote(s) and does not consist solely of the sentence recorded under that title',
                                            jsonb_array_length(coalesce(v_row_ren -> 'evidence', '[]'::jsonb))));
      end if;
    end if;

    -- Each sentence, counted across every row of the answer. Exactly one.
    select count(*)::integer into v_hits
      from jsonb_array_elements(coalesce(v_res -> 'demand', '[]'::jsonb)) t(e)
      cross join lateral jsonb_array_elements(coalesce(t.e -> 'evidence', '[]'::jsonb)) q(ev)
     where q.ev ->> 'evidence' = v_quote_ren;
    v_checks := v_checks + 1;
    if v_hits <> 1 then
      v_bad := array_append(v_bad, format('the sentence recorded after the retitle appears on %s row(s) of the answer, expected exactly 1 — the evidence join is fanning one customer''s words across every title the dimension has ever carried', v_hits));
    end if;

    select count(*)::integer into v_hits
      from jsonb_array_elements(coalesce(v_res -> 'demand', '[]'::jsonb)) t(e)
      cross join lateral jsonb_array_elements(coalesce(t.e -> 'evidence', '[]'::jsonb)) q(ev)
     where q.ev ->> 'evidence' = v_quote;
    v_checks := v_checks + 1;
    if v_hits <> 1 then
      v_bad := array_append(v_bad, format('the sentence recorded BEFORE the retitle appears on %s row(s) of the answer, expected exactly 1 — a workspace that spoke once is being quoted twice, and the second row belongs to a title it never spoke under', v_hits));
    end if;

    -- ---- pair A: 5 sessions, ONE tenant ---------------------------------
    select e into v_row
      from jsonb_array_elements(coalesce(v_res -> 'demand', '[]'::jsonb)) t(e)
     where e ->> 'capability' = v_cap_a and e ->> 'dimension_key' = v_dim_a
       and e ->> 'dimension_title' = v_title_a;
    v_checks := v_checks + 1;
    if v_row is null then
      v_bad := array_append(v_bad, format('no row returned for %L on %L', v_cap_a, v_dim_a));
    else
      v_checks := v_checks + 1;
      if (v_row ->> 'tenants_surfaced')::integer <> 1 or (v_row ->> 'sessions_surfaced')::integer <> 5 then
        v_bad := array_append(v_bad, format('one workspace over five sessions reported as %L tenant(s) / %L session(s), expected 1 / 5 — repeat asking is being counted as repeat demand',
                                            v_row ->> 'tenants_surfaced', v_row ->> 'sessions_surfaced'));
      end if;
      -- 25 is the per-capability quote cap; 5 is under it, so shown = total.
      v_checks := v_checks + 1;
      if (v_row ->> 'evidence_shown')::integer <> 5 or (v_row ->> 'evidence_total')::integer <> 5 then
        v_bad := array_append(v_bad, format('evidence_shown/total for %L is %L/%L, expected 5/5', v_cap_a, v_row ->> 'evidence_shown', v_row ->> 'evidence_total'));
      end if;
    end if;

    ------------------------------------------------------------------------
    -- PROBE 6 — THE ORDER IS THE ONE THIS MIGRATION ARGUES FOR.
    -- pair B (3 tenants, 3 sessions) must outrank pair A (1 tenant, 5
    -- sessions). Sorting on sessions_surfaced instead would invert this and
    -- go red — which is the point. Ten sessions from one workspace is one
    -- customer asking ten times.
    ------------------------------------------------------------------------
    -- ⚠ Both lookups name the dimension_title as well. Pair B spans two rows
    -- since probe 5b, and `min(ord)` over both would silently compare pair A
    -- against whichever of them happened to sort higher — an ordering probe
    -- that does not know which row it is pointing at proves nothing.
    select min(ord)::integer into v_pos_b
      from jsonb_array_elements(coalesce(v_res -> 'demand', '[]'::jsonb)) with ordinality t(e, ord)
     where e ->> 'capability' = v_cap_b and e ->> 'dimension_key' = v_dim_b
       and e ->> 'dimension_title' = v_title_b;
    select min(ord)::integer into v_pos_a
      from jsonb_array_elements(coalesce(v_res -> 'demand', '[]'::jsonb)) with ordinality t(e, ord)
     where e ->> 'capability' = v_cap_a and e ->> 'dimension_key' = v_dim_a
       and e ->> 'dimension_title' = v_title_a;
    v_checks := v_checks + 1;
    if v_pos_a is null or v_pos_b is null then
      v_bad := array_append(v_bad, format('the ordering probe could not locate both pairs (a=%L, b=%L)', coalesce(v_pos_a::text, 'NULL'), coalesce(v_pos_b::text, 'NULL')));
    elsif v_pos_b >= v_pos_a then
      v_bad := array_append(v_bad, format('the capability 3 workspaces asked for ranked BELOW the one 1 workspace asked for five times (positions %s vs %s) — the list is sorted on how loudly one customer repeated themselves, not on how many customers want it',
                                          v_pos_b, v_pos_a));
    end if;

    -- log_rows must have moved with the inserts, or it is a decorative number.
    v_checks := v_checks + 1;
    if (v_res ->> 'log_rows')::integer <> (v_before + 9)::integer then
      v_bad := array_append(v_bad, format('log_rows reports %L after 9 inserts over a base of %s — the anchor is not reading the table', v_res ->> 'log_rows', v_before));
    end if;

    reset role;

    ------------------------------------------------------------------------
    -- PROBE 7 — THE PERIMETER, BOTH DIRECTIONS, FULL SIGNATURE.
    -- has_function_privilege with the bare name would resolve by search_path
    -- and silently pass on a different overload.
    ------------------------------------------------------------------------
    v_checks := v_checks + 1;
    if not has_function_privilege('authenticated', 'public.platform_capability_demand()', 'execute') then
      v_bad := array_append(v_bad, 'authenticated CANNOT execute platform_capability_demand — the Platform Console runs as a signed-in user, so the screen would be dead on arrival');
    end if;
    v_checks := v_checks + 1;
    if has_function_privilege('anon', 'public.platform_capability_demand()', 'execute') then
      v_bad := array_append(v_bad, 'anon can execute platform_capability_demand — the guard would still refuse, but a cross-tenant reader reachable without signing in is not a perimeter');
    end if;
    v_checks := v_checks + 1;
    if has_function_privilege('service_role', 'public.platform_capability_demand()', 'execute') then
      v_bad := array_append(v_bad, 'service_role can execute platform_capability_demand — auth.uid() is null there so it can only ever be refused, and shipping a control that cannot work invites somebody to delete the guard that stops it');
    end if;

    -- ...and the TABLE is still shut, so this function is the only door.
    v_checks := v_checks + 1;
    if has_table_privilege('authenticated', 'public.discovery_capability_demand_log', 'SELECT')
       or has_table_privilege('authenticated', 'public.discovery_capability_demand', 'SELECT') then
      v_bad := array_append(v_bad, 'authenticated can read the demand log or its view directly — 744''s perimeter has been widened and the guard in this function is now optional');
    end if;

    -- Actually CALL it as anon, rather than only asking the catalogue. A
    -- privilege bit nobody has exercised is a claim, not a proof.
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
    set local role anon;
    v_ref := false; v_msg := null;
    begin
      v_res := public.platform_capability_demand();
    exception when others then v_ref := true; v_msg := sqlerrm; end;
    v_checks := v_checks + 1;
    if not v_ref then
      v_bad := array_append(v_bad, 'anon executed platform_capability_demand without error');
    elsif coalesce(v_msg, '') not ilike '%permission denied%' then
      v_bad := array_append(v_bad, format('anon was stopped, but not by the EXECUTE grant: %L', coalesce(v_msg, 'NULL')));
    end if;
    reset role;

    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception when others then
    if sqlerrm <> '__undo_probe__' then raise; end if;
  end;

  -- ---- rollback integrity ------------------------------------------------
  select count(*) into v_after from public.discovery_capability_demand_log;
  v_checks := v_checks + 1;
  if v_before <> v_after then
    v_bad := array_append(v_bad, format('the demand log went from %s to %s row(s) — the probe did not roll back and this migration has left fabricated customer demand in the one table the roadmap is meant to read', v_before, v_after));
  end if;
  v_checks := v_checks + 1;
  if exists (select 1 from platform_capability_grants where note = '750 probe, rolled back') then
    v_bad := array_append(v_bad, 'a probe capability override survived — a real platform operator has been left DENIED tenants.manage by this migration');
  end if;

  if array_length(v_bad, 1) > 0 then
    raise exception '750: % of % check(s) failed: %', array_length(v_bad, 1), v_checks, array_to_string(v_bad, ' | ');
  end if;

  raise notice '750: % checks passed — an unidentified caller, a tenant owner and a platform operator with tenants.manage explicitly DENIED were each refused by the capability guard; the authorised operator read an empty log as [] with live anchors, then read back 9 inserted demand rows with the right tenant/session counts, the customer''s exact sentence and the workspace that said it; a RETITLED dimension split into its own aggregate row and each sentence landed on exactly one row; 3-tenants outranked 5-sessions-one-tenant; authenticated holds EXECUTE while anon and service_role do not and anon''s call was refused by the grant; % row(s) in the log before and after',
    v_checks, v_after;
end $$;

commit;
