-- 793_the_role_gate_leans_on_an_index_say_so.sql
-- ============================================================================
-- Register A-10 said auth_has_tenant_role() is a latent cross-tenant privilege
-- escalation. It is not, and this migration records WHY it is not — because
-- the reason lives in a different table from the risk, and nothing said so.
--
-- ── The claim ───────────────────────────────────────────────────────────────
-- auth_has_tenant_role(required_roles) asks:
--
--     select 1 from profiles
--      where user_id = auth.uid() and coalesce(is_active,true)
--        and role = any(required_roles)
--
-- No tenant predicate. Read alone, that answers "does this user hold this role
-- ANYWHERE", not "in THIS workspace" — so a caller like set_tenant_llm_key,
-- which separately proves membership of the target tenant and then asks this
-- for the ROLE, would take membership from workspace B and authority from
-- workspace A. Given that setting an LLM key adds a subprocessor that receives
-- customer conversations (A-8), that would be a real escalation.
--
-- ── Why it is nonetheless safe ──────────────────────────────────────────────
-- The escalation needs one user to hold two profiles. They cannot:
--
--     CREATE UNIQUE INDEX profiles_user_id_key ON public.profiles (user_id)
--
-- UNIQUE on user_id ALONE — not (user_id, tenant_id), and not partial on
-- is_active. One user, at most one profile, full stop. So "the role I hold
-- somewhere" and "the role I hold here" are necessarily the same role, and
-- auth_tenant_id()'s unordered `limit 1` is deterministic rather than
-- arbitrary, because it selects from at most one row.
--
-- Measured before writing this, not assumed: 24 profiles, 0 users with more
-- than one profile in any state, 0 platform admins also holding a tenant
-- profile, and 40 of 40 RLS policies that call the role gate carry their own
-- tenant_id predicate.
--
-- ── What is actually wrong, and what this fixes ─────────────────────────────
-- The safety of an authorisation function is being held up by a unique index
-- on another table, and NEITHER OBJECT MENTIONS THE OTHER. Someone widening
-- profiles to support one person across two workspaces — an ordinary,
-- desirable feature — would drop or relax this index. Nothing in front of them
-- would say that doing so silently converts 89 functions from "checks your
-- role here" to "checks your role anywhere".
--
-- That person would be reviewing a workspace-membership change. They would not
-- be reviewing an authorisation model. This migration puts the warning where
-- they will be standing.
--
-- No behaviour changes here. Two comments and an assertion.
-- ============================================================================

comment on index public.profiles_user_id_key is
  'LOAD-BEARING FOR AUTHORISATION, not just a uniqueness nicety. '
  'auth_has_tenant_role() filters profiles by user and role but NOT by tenant. '
  'That is only correct because this index makes one-user-two-profiles '
  'impossible, so "the role I hold somewhere" and "the role I hold in this '
  'workspace" cannot differ. Relaxing this index to allow a user in multiple '
  'workspaces (e.g. UNIQUE (user_id, tenant_id)) MUST be done together with '
  'tenant-scoping auth_has_tenant_role and giving auth_tenant_id() a real '
  'current-workspace selector — its `limit 1` has no ORDER BY and would '
  'otherwise pick an arbitrary workspace. See register A-10 and migration 793.';

comment on function public.auth_has_tenant_role(text[]) is
  'Does the caller hold one of these roles? Deliberately NOT tenant-scoped, '
  'and safe only because public.profiles_user_id_key is UNIQUE on user_id '
  'alone, so a user has at most one profile and therefore at most one role. '
  'If that index is ever relaxed to allow multi-workspace users, this function '
  'becomes a cross-tenant privilege escalation for all 89 of its callers — '
  'callers prove MEMBERSHIP of the target tenant locally but take the ROLE '
  'from here. See register A-10 and migration 793.';

-- ── The ratchet ─────────────────────────────────────────────────────────────
-- A comment is documentation and documentation does not fail a build. This
-- block does. It runs at apply time, and the same predicate is pinned in the
-- register so certify re-checks it against production on every run.
do $$
declare
  v_def text;
  v_dupes int;
begin
  -- A. The index still exists AND is still unique on user_id ALONE. Checking
  --    only that an index named profiles_user_id_key exists would pass after
  --    someone redefined it as (user_id, tenant_id) — which is precisely the
  --    change that breaks the role gate. So the SHAPE is what is asserted.
  select indexdef into v_def
    from pg_indexes
   where schemaname = 'public' and tablename = 'profiles'
     and indexname = 'profiles_user_id_key';

  if v_def is null then
    raise exception '793: profiles_user_id_key is GONE. auth_has_tenant_role() is not tenant-scoped and was relying on it — every role check across 89 functions is now answerable from any workspace the user belongs to.';
  end if;

  if v_def !~ 'btree \(user_id\)' then
    raise exception '793: profiles_user_id_key is no longer UNIQUE on user_id alone (now: %). If this became (user_id, tenant_id), a user can hold two profiles and auth_has_tenant_role() must be tenant-scoped in the same change.', v_def;
  end if;

  -- B. Belt and braces: the DATA agrees with the constraint. An index can be
  --    marked invalid and stop enforcing while still appearing in pg_indexes.
  select count(*) into v_dupes from (
    select user_id from public.profiles group by user_id having count(*) > 1
  ) s;
  if v_dupes <> 0 then
    raise exception '793: % user(s) already hold more than one profile — the index is not actually enforcing, and the role gate is live-exploitable right now', v_dupes;
  end if;
end $$;
