-- 740_discovery_proposals_can_record_why_a_writer_refused.sql
-- ==========================================================================
-- WHY: a proposal that silently fails to become a thing is the worst outcome
-- this surface can produce, and today there is nowhere to write down that it
-- happened.
--
-- Plan 3b Task 3 Step 3 says, in as many words: "a writer that refuses must
-- leave the proposal `pending` with the reason VISIBLE." That step is
-- currently impossible to build. discovery_proposals has exactly twelve
-- columns — id, session_id, tenant_id, kind, payload, rationale,
-- source_dimension, state, decided_by, decided_at, created_object_id,
-- created_at — and not one of them can hold a reason. `authenticated` holds
-- SELECT/REFERENCES/TRIGGER and no UPDATE, so the browser cannot write one
-- either. A refusal today reverts the row to 'pending' and looks exactly like
-- a proposal nobody has got to yet.
--
-- That is the shape this repository has been bitten by before: the governed
-- refusal reported as success, the gate that had never fired. A customer who
-- clicks Accept and sees the card go back to "waiting for you" with no reason
-- has been told nothing, and the operator reading the table later cannot
-- distinguish "the writer refused" from "never decided".
--
-- Follows the `connectors.last_error` / `de_work_items.last_error` precedent —
-- seven tables already carry exactly this triple, so this is the house shape,
-- not a new one.
--
-- ==========================================================================
-- AND: nothing stops the same card being written twice.
--
-- The only unique index on this table is the primary key. discovery-interview
-- guards re-emission with a read ("does this session already have proposals?")
-- and its own comment names the hole honestly:
--
--     "guarded by a check for existing proposals on this session before doing
--      any work, not by a DB-level constraint (none exists ... and adding one
--      is a migration, out of scope for this task) ... not airtight against
--      two truly concurrent requests for the same session_id racing this
--      check — a real gap, left for Task 2/3 to close with a proper
--      constraint if it matters in practice."
--
-- This is Task 3. It matters in practice: the duplicate is not a cosmetic
-- repeat, it is the same employee, guardrail or trust cap offered twice, and
-- accepting both hires twice.
--
-- WHY `(session_id, kind, source_dimension)` IS THE WRONG KEY, PROVABLY.
-- Employee drafts come from `dim.serves_archetypes` — one dimension can name
-- many archetypes, and several do. Keying on source_dimension would refuse
-- the second, third and thirteenth genuinely-different employees a single
-- dimension proposes. So the identity of a proposal is per-kind:
--
--     employee   -> payload->>'archetype_key'   (deduped across the whole
--                                                emission by seenArchetypes)
--     connector  -> payload->>'provider_key'    (deduped by seenProviders)
--     everything else -> source_dimension       (DIMENSION_STRUCTURAL_KINDS
--                                                gives each dimension at most
--                                                one structural kind, so this
--                                                IS the natural key for
--                                                procedure/guardrail/
--                                                trust_rule/conversation_type)
--
-- Enumerated against the emitter, not assumed: proposalsFrom has exactly six
-- `kind:` emission sites, and the four structural kinds are produced by a
-- `for (const kind of DIMENSION_STRUCTURAL_KINDS[dim.key] ?? [])` loop over a
-- map whose every entry is a single-element array. Probe 2 below fires the
-- employee case specifically, because it is the one a plausible-looking index
-- would get wrong.
--
-- THE `coalesce(..., '')` IS LOAD-BEARING, NOT DEFENSIVE. source_dimension is
-- nullable, and NULLs never collide in a btree unique index — so without the
-- coalesce, two proposals that both carry a NULL identity would BOTH insert
-- and the constraint would be silently partial. Probe 5 fires that case.
--
-- ⚠ Migration 628's rule — a unique index is an INTERFACE — so every writer
-- of this table was enumerated before landing it. Today there is exactly one:
-- supabase/functions/discovery-interview/index.ts:459. src/lib/discoveryApi.ts
-- reads only. That writer changes from .insert() to .upsert(..., {onConflict:
-- 'session_id,kind,identity_key', ignoreDuplicates: true}) in the same commit.
-- ==========================================================================

alter table public.discovery_proposals
  add column if not exists last_error    text,
  add column if not exists last_error_at timestamptz,
  add column if not exists attempts      integer not null default 0;

comment on column public.discovery_proposals.last_error is
  'Why the writer refused the last accept attempt. Set when an accept rolls back and the row returns to pending; cleared on a successful accept. Without this a refusal is indistinguishable from an undecided proposal.';
comment on column public.discovery_proposals.attempts is
  'How many times an accept has been tried and failed. A card on its third attempt is a different conversation from one on its first.';

alter table public.discovery_proposals
  add column if not exists identity_key text
    generated always as (
      coalesce(
        case kind
          when 'employee'  then payload ->> 'archetype_key'
          when 'connector' then payload ->> 'provider_key'
          else source_dimension
        end, '')
    ) stored;

comment on column public.discovery_proposals.identity_key is
  'What makes this proposal THE SAME proposal, per kind. Not source_dimension alone — one dimension proposes many employees. See the migration header.';

create unique index if not exists discovery_proposals_identity_uq
  on public.discovery_proposals (session_id, kind, identity_key);

-- ==========================================================================
-- VERIFICATION — every pin inverted.
--
-- A duplicate-refused probe alone would pass against an index that refuses
-- EVERYTHING. Probe 2 is therefore not optional garnish: it is the probe that
-- makes probe 1 mean something, and it fires the exact case the obvious-but-
-- wrong key would have broken.
-- ==========================================================================
do $$
declare
  v_tenant       uuid;
  v_session      uuid;
  v_dim_a        text;
  v_dim_b        text;
  v_rows_before  bigint;
  v_rows_after   bigint;
  v_dup_refused  boolean := false;
  v_pair_ok      boolean := false;
  v_null_collide boolean := false;
  v_ident        text;
  v_attempts     integer;
  v_err_read     text;
  v_bad          text[] := '{}';
begin
  select count(*) into v_rows_before from public.discovery_proposals;

  select id into v_tenant from public.tenants order by created_at limit 1;
  if v_tenant is null then
    raise exception '740: no tenant exists to probe with — cannot prove any of this';
  end if;

  -- Two REAL dimension keys, because source_dimension carries an FK. Picking
  -- them dynamically keeps this migration honest if the seed changes.
  select key into v_dim_a from public.discovery_dimensions order by key limit 1;
  select key into v_dim_b from public.discovery_dimensions where key <> v_dim_a order by key limit 1;
  if v_dim_a is null or v_dim_b is null then
    raise exception '740 vacuity guard: fewer than two discovery_dimensions exist — probes 2 and 3 could not distinguish a per-kind key from a per-dimension one, so passing would prove nothing';
  end if;

  begin
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;

    -- ---- PROBE 1: the pin FIRES. Same session, same kind, same identity. ----
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, source_dimension, state)
      values (v_session, v_tenant, 'employee', jsonb_build_object('archetype_key','support_agent'), v_dim_a, 'pending');
    begin
      insert into public.discovery_proposals (session_id, tenant_id, kind, payload, source_dimension, state)
        values (v_session, v_tenant, 'employee', jsonb_build_object('archetype_key','support_agent'), v_dim_b, 'pending');
    exception when unique_violation then
      v_dup_refused := true;
    end;
    -- Note the DIFFERENT source_dimension on the second insert: this proves
    -- the index keys on the archetype, not on the dimension. The same employee
    -- reached from two dimensions is one proposal.

    -- ---- PROBE 2: THE INVERSION. The pin must ADMIT two real employees ----
    -- from ONE dimension. This is precisely what (session_id, kind,
    -- source_dimension) would have refused, and it is the common case.
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, source_dimension, state)
      values (v_session, v_tenant, 'employee', jsonb_build_object('archetype_key','renewal_manager'), v_dim_a, 'pending');
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, source_dimension, state)
      values (v_session, v_tenant, 'employee', jsonb_build_object('archetype_key','front_desk'), v_dim_a, 'pending');
    v_pair_ok := true;

    -- ---- PROBE 3: identity_key resolves per kind, not by one rule ----------
    select identity_key into v_ident from public.discovery_proposals
      where session_id = v_session and kind = 'employee' and payload ->> 'archetype_key' = 'front_desk';
    if v_ident is distinct from 'front_desk' then
      v_bad := v_bad || format('employee identity_key = %L, expected the archetype_key', coalesce(v_ident,'NULL'));
    end if;

    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, source_dimension, state)
      values (v_session, v_tenant, 'connector', jsonb_build_object('provider_key','zendesk'), v_dim_a, 'pending')
      returning identity_key into v_ident;
    if v_ident is distinct from 'zendesk' then
      v_bad := v_bad || format('connector identity_key = %L, expected the provider_key', coalesce(v_ident,'NULL'));
    end if;

    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, source_dimension, state)
      values (v_session, v_tenant, 'guardrail', jsonb_build_object('rule','never quote a price'), v_dim_a, 'pending')
      returning identity_key into v_ident;
    if v_ident is distinct from v_dim_a then
      v_bad := v_bad || format('guardrail identity_key = %L, expected the source_dimension %L', coalesce(v_ident,'NULL'), v_dim_a);
    end if;

    -- A connector and a guardrail on the SAME dimension must coexist — the
    -- index is (session, KIND, identity), and collapsing across kinds would
    -- make one dimension able to propose only one thing in total.
    if not exists (
      select 1 from public.discovery_proposals
       where session_id = v_session and source_dimension = v_dim_a and kind = 'connector'
    ) or not exists (
      select 1 from public.discovery_proposals
       where session_id = v_session and source_dimension = v_dim_a and kind = 'guardrail'
    ) then
      v_bad := v_bad || 'a connector and a guardrail from one dimension did not both survive — the index is collapsing across kinds';
    end if;

    -- ---- PROBE 4: the reason columns actually round-trip ------------------
    update public.discovery_proposals
       set last_error = 'writer_returned_no_object', last_error_at = now(), attempts = attempts + 1
     where session_id = v_session and kind = 'guardrail';
    select attempts, last_error into v_attempts, v_err_read
      from public.discovery_proposals where session_id = v_session and kind = 'guardrail';
    if coalesce(v_attempts, -1) <> 1 then
      v_bad := v_bad || format('attempts did not default to 0 and increment to 1 (got %s)', coalesce(v_attempts::text,'NULL'));
    end if;
    if v_err_read is distinct from 'writer_returned_no_object' then
      v_bad := v_bad || format('last_error did not round-trip (got %L)', coalesce(v_err_read,'NULL'));
    end if;

    -- ---- PROBE 5: the coalesce is load-bearing ---------------------------
    -- Two rows whose identity falls to a NULL source_dimension. Without
    -- coalesce(...,'') these are two NULLs, btree treats them as distinct, and
    -- the constraint is silently partial exactly where it is least expected.
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, source_dimension, state)
      values (v_session, v_tenant, 'procedure', jsonb_build_object('name','first'), null, 'pending');
    begin
      insert into public.discovery_proposals (session_id, tenant_id, kind, payload, source_dimension, state)
        values (v_session, v_tenant, 'procedure', jsonb_build_object('name','second'), null, 'pending');
    exception when unique_violation then
      v_null_collide := true;
    end;

    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception
    when others then
      if sqlerrm <> '__undo_probe__' then raise; end if;
  end;

  if not v_dup_refused then
    v_bad := v_bad || 'the SAME employee was proposed twice into one session and the unique index allowed it — the duplicate-card gap is still open';
  end if;
  if not v_pair_ok then
    v_bad := v_bad || 'two DIFFERENT employees from one dimension were refused — the index is keyed on the dimension, which would silently drop every employee a dimension proposes after the first';
  end if;
  if not v_null_collide then
    v_bad := v_bad || 'two proposals with a NULL source_dimension both inserted — the coalesce(...,'''') is not doing its job and the constraint is partial';
  end if;

  -- Rollback integrity: the counts must match, or every probe above is a
  -- statement about rows that are still there.
  select count(*) into v_rows_after from public.discovery_proposals;
  if v_rows_before <> v_rows_after then
    raise exception '740: discovery_proposals went from % row(s) to % — the probe rollback is broken and this migration has left test data in production',
      v_rows_before, v_rows_after;
  end if;

  -- Perimeter: adding columns must not have handed the browser a write path.
  -- The RPC is the only thing that may set state, and it is SECURITY DEFINER.
  if has_table_privilege('authenticated', 'public.discovery_proposals', 'UPDATE') then
    v_bad := v_bad || 'authenticated gained UPDATE on discovery_proposals — a client that can write its own state does not need the RPC and is not audited';
  end if;
  if has_table_privilege('anon', 'public.discovery_proposals', 'SELECT') then
    v_bad := v_bad || 'anon can read discovery_proposals';
  end if;

  if array_length(v_bad, 1) > 0 then
    raise exception '740: % check(s) failed: %', array_length(v_bad, 1), array_to_string(v_bad, ' | ');
  end if;

  raise notice '740: all checks passed — a refusal now has somewhere to be written; duplicate refused, two distinct employees from one dimension admitted, identity resolves per kind, NULL identities collide, % row(s) before and after',
    v_rows_after;
end $$;
