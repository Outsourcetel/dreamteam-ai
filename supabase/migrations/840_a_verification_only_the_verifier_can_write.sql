-- 840_a_verification_only_the_verifier_can_write.sql
-- ==========================================================================
-- WHY: migs 832 and 835 made verify_de_system refuse to record a check that
--      compared nothing. Both guards live INSIDE THE RPC, and the RPC is not
--      the only door. `service_role` holds INSERT/UPDATE/DELETE/TRUNCATE on
--      public.de_system_verifications directly, so any edge function that ever
--      writes the table without going through the RPC bypasses both guards and
--      can bank `matched = true` having read no system of record at all.
--
--      This migration removes that door. After it, the only way a row can
--      arrive is verify_de_system, which means "this row exists" and "the
--      guards ran" become the same statement.
-- ==========================================================================
--
-- ── WHAT WAS ACTUALLY MEASURED, AND WHAT IT MEANS ─────────────────────────
-- Measured on production 2026-08-21, before writing this:
--
--   * relacl                 {postgres=arwdDxtm/postgres, anon=rxtm/postgres,
--                             authenticated=rxtm/postgres,
--                             service_role=arwdDxtm/postgres}
--   * 305 of 306 public base tables carry the same service_role write set.
--   * NOTHING writes this table directly today. `de_system_verifications`
--     appears in ZERO .ts/.tsx/.js/.mjs files in the repository. The sole
--     writer is verify_de_system; its sole caller is de-work's
--     verify_in_system tool (index.ts:2018 offer, :975 dispatch).
--   * 2 rows, both matched = true, both with populated expectations.
--
-- So this closes a door nobody is walking through — deliberately, while it is
-- still cheap. The gap is future-tense: the day somebody adds a direct writer,
-- nothing today would object. After this, that writer gets 42501 on its first
-- call instead of silently minting evidence.
--
-- ── WHY 305/306 IS NOT AN ARGUMENT AGAINST DOING THIS ─────────────────────
-- It looks like a deliberate repo-wide posture. It is not: it is ONE DEFAULT
-- firing 305 times. pg_default_acl for (objtype r, grantor postgres, schema
-- public) reads
--
--   {postgres=arwdDxtm, anon=rxtm, authenticated=rxtm, service_role=arwdDxtm}
--
-- so every new table in `public` is BORN with it and nobody chose it for this
-- table. That row is also editable and has already been edited once — mig 715
-- ratcheted the `authenticated` letters down to rxtm, which is why anon and
-- authenticated no longer read arwdDxtm above.
--
-- ⚠ THE COROLLARY, STATED SO NOBODY MISREADS THIS MIGRATION'S SCOPE: because
-- the default still hands out arwdDxtm, table 307 will be born with the same
-- open door. This migration closes one door; it does not stop the factory.
-- That is a deliberate limit, argued at the bottom.
--
-- ── WHY MIG 716 IS NOT AN OBSTACLE (it reads like one, and is not) ─────────
-- 716:334 raises 'TIER B OVER-REVOKED' if service_role''s grant count moves,
-- which reads as a standing, actively-asserted invariant. It is not. That
-- comparison is `n_svc_before` against `n_svc_after` INSIDE 716''s own DO
-- block — a blast-radius check on 716 itself, proving that revoking from
-- `authenticated` did not also move `service_role`. It does not re-run.
--
-- Verified 2026-08-21: there is NO standing gate on service_role TABLE grants
-- anywhere in this repo. certify.mjs names service_role exactly once, for a
-- FUNCTION-execute privilege (:1166), and scripts/write-perimeter.mjs is
-- `authenticated`-only — zero occurrences of service_role in the file.
--
-- That cuts BOTH ways, and the second half is why this migration ships with a
-- companion: a revoke that nothing watches can regrow silently, and a control
-- nobody is measuring is the "gate that had never fired" this repo has already
-- paid for. The certify arm `evidence-tables-are-sealed` in
-- scripts/write-perimeter.mjs lands in the same change and is the load-bearing
-- half. Do not port this REVOKE anywhere without porting that arm too.
--
-- ── WHY A GRANT AND NOT A TRIGGER (both precedents exist here) ─────────────
-- This repo already contains both answers, and mig 744 wrote down both:
--
--   GRANT-BASED   744:197 — discovery_capability_demand_log. `revoke all from
--                 service_role; grant select`, reasoning "a history somebody
--                 can edit is not a history". It is currently the ONLY public
--                 base table without service_role INSERT.
--   TRIGGER-BASED 744:193 names the contrast — audit_events keeps full
--                 arwdDxtm and enforces immutability with
--                 audit_events_immutable (BEFORE UPDATE OR DELETE) and
--                 audit_events_no_truncate (BEFORE TRUNCATE) instead.
--
-- They are not interchangeable, and choosing between them requires splitting
-- the threat first:
--
--   FORGERY   — a NEW row asserting a check that never ran. Only a GRANT can
--               stop this. A trigger cannot know whether the caller actually
--               read the system of record, so it cannot tell a real
--               verification from an invented one.
--   TAMPERING — editing or erasing rows that already exist. A TRIGGER is
--               strictly stronger here, because it also stops `postgres`,
--               SECURITY DEFINER functions and migrations; a grant does not
--               constrain the table owner at all.
--
-- The threat that opened this file is FORGERY, so the control is a grant. The
-- revoke covers UPDATE/DELETE/TRUNCATE as well because they come off in the
-- same statement and cost nothing — but that half is the weaker of the two
-- controls and this migration does not pretend otherwise. If the day comes
-- that these two rows need protecting from `postgres` itself, add the
-- audit_events triggers; this migration does not.
--
-- ── WHY THE RPC STILL WORKS (proven, not reasoned) ────────────────────────
-- verify_de_system is SECURITY DEFINER owned by postgres, and the table does
-- not FORCE row security (relforcerowsecurity = false), so its INSERT runs
-- with the OWNER''s privileges and is untouched by anything revoked from
-- service_role. That is the mechanism. It was also executed, on production,
-- inside a transaction that always aborted:
--
--   acl after            {..., service_role=r/postgres}
--   CONTROL direct INSERT as service_role, BEFORE revoke   ALLOWED
--   ARM1    direct INSERT as service_role, AFTER  revoke   REFUSED 42501
--   ARM2    direct UPDATE as service_role, AFTER  revoke   REFUSED 42501
--   ARM3    direct SELECT as service_role, AFTER  revoke   ok, 3 rows
--   ARM4    SECDEF fn called BY service_role, AFTER revoke INSERTED 1 row
--
-- The CONTROL is the load-bearing line. Without it, "REFUSED 42501" is equally
-- consistent with an INSERT that could never have worked for some unrelated
-- reason, and four green arms would prove nothing. Residue checked afterwards:
-- 2 rows (unchanged), 0 probe rows, 0 probe functions, grant still in place.
--
-- ⚠ A first attempt at ARM4 used gen_random_uuid() for tenant_id and came back
-- 23503 — a CONSTRAINT failure, not a privilege one. It very nearly read as
-- "the revoke broke the RPC". Postgres checks table privileges BEFORE it
-- evaluates constraints, so 23503 actually means permission PASSED. That
-- ordering is load-bearing below: it is what lets this migration prove its own
-- guard in both directions with no fixture at all.
--
-- ── WHAT THIS DOES NOT DO, STATED PLAINLY ─────────────────────────────────
-- 1. NO CLASS SWEEP. The obvious next move is "define an append-only audit
--    class and revoke across all of it". That class was enumerated before this
--    migration was written rather than guessed at: of the 51
--    de_*/audit_*/governance_*/trust_*/approval_*/action_* tables with SECDEF
--    writers, FIFTEEN have zero references in shipped code (src/ +
--    supabase/functions/) — approval_briefs, audit_chain_state, audit_evidence,
--    de_config, de_config_audit_log, de_config_schemas, de_connected_systems,
--    de_delegation_tokens, de_experience, de_kpi_readings, de_kpis,
--    de_learning_edits, de_spend_ledger, de_system_verifications,
--    de_token_usage. Narrowing those fifteen to "read as evidence" is a
--    judgment call at each one, and that is precisely how a sweep ends up
--    partial while looking complete. Not done here, and named so the next
--    person inherits the census rather than re-running it.
--
-- 2. NO CHANGE TO THE DEFAULT ACL. See the corollary above: new tables keep
--    being born with arwdDxtm. Changing pg_default_acl for service_role would
--    affect all 306 tables at once and most of them legitimately need those
--    grants (de_conversations alone is written directly from 10 places in
--    shipped code). That is a separate decision with a much larger blast
--    radius.
--
-- 3. NOTHING ABOUT anon OR authenticated. Both read `rxtm` on this table —
--    SELECT included, protected by mig 221''s tenant_read policy and by RLS
--    being enabled. That is the default every table gets and nobody chose it
--    here either, but it is a READ question and this migration is about
--    writes. Asserting anything about it below would be the mig 837 defect:
--    an assertion describing a perimeter this migration does not install,
--    which passes on production and fails anywhere it was never hardened.
--
-- 4. NO BACKFILL, and nothing to back-fill: both existing rows were written by
--    the RPC, which is the only writer that has ever existed.
-- ==========================================================================

-- ── THE CHANGE ────────────────────────────────────────────────────────────
-- `revoke all` then `grant select`, exactly the shape 744:197-198 used, rather
-- than naming the four write privileges. It also takes off TRIGGER — which
-- would let service_role attach machinery to an audit table — and REFERENCES
-- and MAINTAIN, none of which any caller uses. SELECT is kept because the
-- table is read as evidence and revoking reads is not what this is about.
revoke all on table public.de_system_verifications from service_role;
grant select on table public.de_system_verifications to service_role;

comment on table public.de_system_verifications is
  'Audit trail of a digital employee re-reading the system of record to confirm its own write landed. WRITE-SEALED (migration 840): service_role holds SELECT only, so the sole path that can create a row is verify_de_system (SECURITY DEFINER, owner postgres), and with it the vacuous-expectation guard from migration 835. A row here therefore means the guard ran. Kept sealed by the certify arm evidence-tables-are-sealed in scripts/write-perimeter.mjs; a direct writer added later fails 42501 rather than silently minting evidence.';

do $$
declare
  held        text;
  direct_ins  text := 'NOT ATTEMPTED';
  owner_ins   text := 'NOT ATTEMPTED';
  direct_sel  text := 'NOT ATTEMPTED';
  n_compared  int  := 0;
begin
  -- ── ASSERT THE ABSENCE OF A VIOLATION ───────────────────────────────────
  -- A SCHEMA assertion about what THIS migration installs, which is the only
  -- kind that is true wherever it is replayed. It asks the privilege system
  -- directly (has_table_privilege), never information_schema — see the note on
  -- the certify arm for why that distinction is not pedantry.
  select string_agg(p, ', ' order by p) into held
    from unnest(array['INSERT','UPDATE','DELETE','TRUNCATE','TRIGGER','REFERENCES']) p
   where has_table_privilege('service_role', 'public.de_system_verifications', p);
  if held is not null then
    raise exception 'SEAL FAILED: service_role still holds % on de_system_verifications', held;
  end if;

  -- The other half. A revoke that removed more than intended is the same
  -- defect wearing the opposite mask (mig 643 nearly left 11 of 12 workspaces
  -- administrable by nobody), and the table is read as evidence.
  if not has_table_privilege('service_role', 'public.de_system_verifications', 'SELECT') then
    raise exception 'SEAL OVER-REVOKED: service_role lost SELECT on de_system_verifications — the evidence is unreadable';
  end if;

  -- ── PROVE THE SEAL FIRES, AND PROVE IT CAN BE SILENT ────────────────────
  -- Both arms below run on an EMPTY database. They insert deliberately
  -- dangling uuids, so the only two outcomes possible are 42501 (refused at
  -- the privilege check) and 23503 (privilege passed, refused later by the FK)
  -- — and Postgres checks privileges strictly before constraints. That
  -- ordering is what turns one bad row into a two-directional proof needing no
  -- fixture, no tenant and no digital employee.
  begin
    set local role service_role;
    insert into public.de_system_verifications
      (tenant_id, de_id, system_key, entity_ref, expectation, actual, matched)
    values (gen_random_uuid(), gen_random_uuid(), 'seal_probe', 'seal_probe_ref',
            '{}'::jsonb, '{}'::jsonb, true);
    direct_ins := 'ALLOWED';
  exception
    when insufficient_privilege then direct_ins := 'REFUSED_42501';
    when foreign_key_violation  then direct_ins := 'REACHED_FK_23503';
    when others                 then direct_ins := 'OTHER_' || sqlstate;
  end;
  reset role;
  n_compared := n_compared + 1;

  -- THE CONTROL. The identical statement as the OWNER must get PAST the
  -- privilege check and die on the foreign key instead. Without this arm,
  -- 'REFUSED_42501' above is equally consistent with a statement that could
  -- never have run at all, and a probe that always says REFUSED is theatre.
  begin
    insert into public.de_system_verifications
      (tenant_id, de_id, system_key, entity_ref, expectation, actual, matched)
    values (gen_random_uuid(), gen_random_uuid(), 'seal_probe', 'seal_probe_ref',
            '{}'::jsonb, '{}'::jsonb, true);
    owner_ins := 'ALLOWED';
  exception
    when insufficient_privilege then owner_ins := 'REFUSED_42501';
    when foreign_key_violation  then owner_ins := 'REACHED_FK_23503';
    when others                 then owner_ins := 'OTHER_' || sqlstate;
  end;
  n_compared := n_compared + 1;

  -- And the read that is deliberately still open. count(*) is 0 on an empty
  -- database and that is a pass: this asserts the PRIVILEGE, not the rows.
  begin
    set local role service_role;
    perform count(*) from public.de_system_verifications;
    direct_sel := 'ALLOWED';
  exception when others then direct_sel := 'BLOCKED_' || sqlstate;
  end;
  reset role;
  n_compared := n_compared + 1;

  if direct_ins <> 'REFUSED_42501' then
    raise exception 'SEAL PROVES NOTHING: a direct INSERT as service_role returned % (expected REFUSED_42501)', direct_ins;
  end if;
  if owner_ins <> 'REACHED_FK_23503' then
    raise exception 'SEAL PROBE IS VACUOUS: the same INSERT as the owner returned % (expected REACHED_FK_23503). The refusal above cannot be attributed to the revoke if the statement fails for everyone.', owner_ins;
  end if;
  if direct_sel <> 'ALLOWED' then
    raise exception 'SEAL OVER-REVOKED: service_role SELECT returned %', direct_sel;
  end if;
  if n_compared <> 3 then
    raise exception 'SEAL PROBE ran % comparison(s), expected 3 — zero findings from zero comparisons looks exactly like a clean result', n_compared;
  end if;

  raise notice 'SEAL: de_system_verifications is write-sealed. service_role holds SELECT only. % comparisons: direct INSERT %, owner INSERT % (control — privilege passed, FK refused), direct SELECT %.',
    n_compared, direct_ins, owner_ins, direct_sel;
end $$;
