-- 703_the_driver_must_name_the_executor.sql
-- ==========================================================================
-- WHY. Migration 701 fixed the browser's approval path. It did not fix the
-- DRIVER's. `approved-action-driver` carries out approvals a human already
-- granted, on a five-minute tick, with nobody watching — and it asks
-- connector-hub to run an `action_key` without saying WHICH executor.
--
-- `due_approved_actions` (live body, read today) selects
--
--     select t.id, t.slug, ht.id, ae.id, ae.connector_id, ad.action_key, ad.label,
--            ae.params, ht.decided_at
--
-- It JOINS `action_definitions ad on ad.id = ae.action_definition_id` — it has
-- the exact executor in hand on every row — and then returns the LABEL and the
-- KEY and drops the ID. The driver forwards what it was given
-- (`approved-action-driver/index.ts:95-101`), so connector-hub is left to
-- re-derive the definition from (connector, action_key), and
-- `resolveActionDefinition` (index.ts:2186) refuses rather than guess:
--
--     "AMBIGUOUS AND UNSPECIFIED: refuse rather than guess. This used to fall
--      through to list.find(), i.e. the FIRST ROW OF AN UNORDERED QUERY … It
--      happened to land on the comment executor 12 times running; the day it
--      stopped, an employee meaning to leave an internal note would have
--      emailed a customer instead."
--
-- That refusal is RIGHT. The defect is that the driver makes it necessary when
-- it never had to: it is the one caller that already knows the answer, because
-- the answer is recorded on the very row it is acting on.
--
-- ── MEASURED, not assumed: where ambiguity is live ──────────────────────
-- The candidate set of `resolveActionDefinition` was reproduced in SQL against
-- production for every (connector, action_key) pair reachable today —
-- category match, active, `scope='tenant' and tenant_id=…` or
-- `scope='platform' and provider=…`. **94 pairs. Exactly 2 are ambiguous**,
-- both in `outsourcetel-hq`, both on the CONNECTED ERPNext connector:
--
--     send_payment_reminder   erpnext_invoice_comment | erpnext_send_invoice_email
--     send_final_notice       erpnext_invoice_comment | erpnext_send_invoice_email
--
-- Those are the dunning verbs. They are exactly what this driver would be
-- carrying out, and the difference between the two executors is an internal
-- note nobody outside the company sees and an EMAIL TO THE CUSTOMER. So the
-- driver is not theoretically exposed; it is exposed on the only rungs it has
-- ever been asked to run, including the two approvals pending right now and
-- the stage-3 rung above them.
--
-- ⚠ The second executor (`erpnext_send_invoice_email`, def 303895fd…) was
-- registered 2026-08-05T15:59Z. Before that instant the pair was
-- unambiguous and the driver's shape was harmless. The defect was not
-- introduced by a change to the driver — it was introduced by adding a
-- perfectly reasonable second executor somewhere else. That is the argument
-- for recording the identity rather than re-deriving it: a caller that names
-- what it means cannot be broken by someone else registering a sibling.
--
-- ── THE EXACT-MATCH BRANCH IS ALREADY PROVEN IN PRODUCTION ─────────────
-- Not inferred. On 2026-08-06T01:00Z — i.e. AFTER the pair became ambiguous —
-- connector-hub created two `action_executions` rows bound to `00003ef9…`
-- (`erpnext_invoice_comment`). Their `dedupe_key` carries the hub's own
-- fallback shape `<def.id>:<params json>`, so the hub wrote them; and the
-- ambiguity branch cannot produce a row at all, it returns. The only branch
-- that can bind one definition out of two candidates is the exact-match branch
-- at index.ts:2176. Therefore a caller passed `action_definition_id`, and that
-- branch works, on this exact ambiguous pair, in production. `de-work` is the
-- only caller in the repository that passes it (mig 614, index.ts:720).
--
-- This migration makes the driver the second such caller. Same fix shape as
-- mig 701 used for the browser (`resolveActionExecution` now forwards
-- `row.action_definition_id`), so the two paths agree rather than each having
-- their own idea of how an approval names its executor.
--
-- ── NO `is not null` FILTER ON THE NEW COLUMN, DELIBERATELY ─────────────
-- The obvious symmetry with `ae.connector_id is not null` two lines above is
-- WRONG here: `action_executions.action_definition_id` is declared NOT NULL at
-- the table. A filter on it could never exclude a row, and a pin on that
-- filter could never fail — a checker that cannot fail is theatre, and this
-- repository has paid for that before. The premise is ASSERTED instead, once,
-- below: if someone ever drops that NOT NULL, this migration's assumption is
-- void and the assertion says so in the one place a reader would look.
--
-- ── WHAT THIS DOES NOT TOUCH ────────────────────────────────────────────
-- Every guard in `due_approved_actions` is preserved BYTE FOR BYTE: the
-- `enabled_at` watermark, the empty-means-disabled reads, the tenant
-- allowlist, `t.status = 'active'`, `ht.status = 'approved'` (which excludes
-- mig 642's `expired`), `ae.decision like 'human_gated%'`, the
-- `ae.connector_id is not null` routing filter, the not-already-claimed
-- `resolves_task_id` clause, and the limit clamp. One column is added to the
-- result. Nothing is loosened. All of it is pinned below.
--
-- ⚠ THE DRIVER STAYS DISABLED. `approved_action_driver.enabled_at` is the
-- empty string on production and cron job 84 is `active = false`. This
-- migration does not read, write or touch either. Making the driver correct
-- and switching it on are different decisions, and the second one belongs to
-- the founder — it is real money moving with no person watching.
--
-- ── DROP AND RECREATE, and what that costs ──────────────────────────────
-- Adding a column to a `RETURNS TABLE` changes the return type, which
-- `create or replace` cannot do. So this DROPs first — and a DROP takes the
-- GRANTS with it. Unlike mig 701, "create or replace preserves grants" does
-- NOT apply here and the re-grant below is load-bearing rather than
-- belt-and-braces. Current ACL, read from `pg_proc.proacl` before writing
-- this: `postgres=X/postgres | service_role=X/postgres`. That is what is
-- restored, and it is asserted, not assumed. Sole caller:
-- `approved-action-driver/index.ts:66`.
-- ==========================================================================

begin;

drop function if exists public.due_approved_actions(integer);

create function public.due_approved_actions(p_limit integer default 25)
returns table(
  tenant_id            uuid,
  tenant_slug          text,
  task_id              uuid,
  execution_id         uuid,
  connector_id         uuid,
  -- WHICH executor. Recorded on the row when the approval was raised; the
  -- driver forwards it so connector-hub takes the exact-match branch instead
  -- of re-deriving an action_key that may have grown a sibling since.
  action_definition_id uuid,
  action_key           text,
  action_label         text,
  params               jsonb,
  decided_at           timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_enabled_at timestamptz;
  v_allow      text[];
begin
  -- Empty or unparseable ⇒ disabled. Never "assume on".
  select nullif(btrim(value), '')::timestamptz into v_enabled_at
    from platform_config where key = 'approved_action_driver.enabled_at';
  if v_enabled_at is null then
    return;                                     -- disabled: zero rows
  end if;

  select coalesce(
           array(select btrim(s) from unnest(string_to_array(coalesce(value, ''), ',')) s
                  where btrim(s) <> ''), '{}')
    into v_allow
    from platform_config where key = 'approved_action_driver.tenant_allowlist';
  if coalesce(array_length(v_allow, 1), 0) = 0 then
    return;                                     -- nobody opted in: zero rows
  end if;

  return query
  select t.id, t.slug, ht.id, ae.id, ae.connector_id, ae.action_definition_id,
         ad.action_key, ad.label, ae.params, ht.decided_at
    from human_tasks ht
    join tenants t             on t.id = ht.tenant_id
    join action_executions ae  on ae.task_id = ht.id
    join action_definitions ad on ad.id = ae.action_definition_id
   where ht.type = 'action_approval'
     and ht.status = 'approved'                 -- 'expired' (mig 642) excluded
     and t.status = 'active'                    -- never act in a suspended workspace
     and t.slug = any(v_allow)
     and ht.decided_at >= v_enabled_at          -- THE WATERMARK
     and ae.decision like 'human_gated%'
     and ae.connector_id is not null
     -- Not already carried out. From mig 642 onward the linkage is reliable:
     -- claim_gated_action_execution sets resolves_task_id on every claim.
     and not exists (
       select 1 from action_executions x
        where x.resolves_task_id = ht.id
          and x.decision <> 'failed')
   order by ht.decided_at
   limit greatest(1, least(coalesce(p_limit, 25), 100));
end;
$function$;

comment on function public.due_approved_actions(integer) is
  'Approved actions the driver may carry out. Returns action_definition_id so '
  'the driver NAMES the executor rather than leaving connector-hub to '
  're-derive it from an action_key that may have more than one — on production '
  'today, send_payment_reminder and send_final_notice each have two live '
  'ERPNext executors, one an internal note and one an email to the customer. '
  'See mig 703. Every guard is mig 644''s, unchanged.';

-- ⚠ A DROP TAKES THE GRANTS WITH IT. This is a restore, not a formality.
-- anon and authenticated are NAMED roles in Supabase, so revoking PUBLIC alone
-- would leave them holding EXECUTE on a function that lists approved money
-- actions across every allowlisted tenant.
revoke execute on function public.due_approved_actions(integer)
  from public, anon, authenticated;
grant execute on function public.due_approved_actions(integer) to service_role;

-- ── ASSERTIONS ────────────────────────────────────────────────────────────
do $assert$
declare
  v_src  text;
  v_cols text;
  v_n    int;
begin
  -- A. THE PREMISE behind having no `action_definition_id is not null` filter.
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'action_executions'
       and column_name = 'action_definition_id' and is_nullable = 'YES')
  then
    raise exception '703: action_executions.action_definition_id is NULLABLE — this migration assumed it was NOT NULL and therefore added no filter, so the driver could now be handed a null executor and fall straight back into the ambiguity it exists to avoid';
  end if;

  -- B. The contract actually changed: the column is in the RETURN TYPE.
  select string_agg(a.attname, ',' order by a.attnum) into v_cols
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join unnest(p.proallargtypes, p.proargmodes, p.proargnames)
         with ordinality as a(atttypid, attmode, attname, attnum) on true
   where n.nspname = 'public' and p.proname = 'due_approved_actions'
     and a.attmode = 't';
  if v_cols is null or v_cols !~ 'action_definition_id' then
    raise exception '703: due_approved_actions does not return action_definition_id — the driver still cannot name the executor. Columns: %', coalesce(v_cols, '(none)');
  end if;
  -- The routing PAIR, together. connector_id without the definition, or the
  -- reverse, cannot carry out an approval.
  if v_cols !~ 'connector_id' then
    raise exception '703: due_approved_actions lost connector_id — mig 701''s other half';
  end if;

  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'due_approved_actions';
  -- ⚠ COMMENTS STRIPPED FIRST. prosrc carries the prose, and in mig 701 two
  -- pins passed against a deliberately broken function because the words they
  -- searched for were sitting in a comment above the code. Code only.
  v_src := regexp_replace(v_src, '--[^\n]*', '', 'g');

  -- C. The new column is genuinely SELECTED, not merely declared. A
  --    RETURNS TABLE column that nothing populates yields NULL on every row —
  --    which reads exactly like success and lands the driver back on the
  --    ambiguity path.
  -- ⚠ ANCHORED TO THE SELECT LIST, not to the token. A bare
  -- `~ 'ae\.action_definition_id'` passes on a function that selects
  -- `null::uuid` into the column, because the JOIN condition
  -- `ad.id = ae.action_definition_id` further down satisfies it. That mutant
  -- SURVIVED the first draft of this block. The pattern below is the
  -- adjacency in the select list itself, where the two routing columns are
  -- emitted side by side.
  if v_src !~ 'ae\.connector_id,\s*ae\.action_definition_id' then
    raise exception '703: the return type declares action_definition_id but the SELECT LIST does not populate it from the row — every result would carry NULL and connector-hub would be back to guessing';
  end if;

  -- D. EVERY mig-644 GUARD, still there. Not one of these is decoration:
  --    each is the only thing standing between "a human approved something"
  --    and "a machine did it in a workspace/at a time/with a row it must not".
  if v_src !~ 'approved_action_driver\.enabled_at' or v_src !~ 'ht\.decided_at\s*>=\s*v_enabled_at' then
    raise exception '703: the enabled_at WATERMARK is gone — switching the driver on would replay every approval ever made';
  end if;
  -- ⚠ The RETURN, not just the branch. `if v_enabled_at is null then` matches
  -- a body that substitutes '-infinity' and carries on — which is the exact
  -- opposite of the guard, and it SURVIVED the first draft of this block.
  if v_src !~ 'if\s+v_enabled_at\s+is\s+null\s+then\s+return;' then
    raise exception '703: an unset/unparseable enabled_at no longer RETURNS — the driver must never assume on';
  end if;
  if v_src !~ 'approved_action_driver\.tenant_allowlist' or v_src !~ 't\.slug\s*=\s*any\(v_allow\)' then
    raise exception '703: the tenant allowlist is gone — the driver would act in workspaces nobody opted in';
  end if;
  if v_src !~ 'array_length\(v_allow, 1\), 0\)\s*=\s*0' then
    raise exception '703: an empty allowlist no longer means nobody — it must never default to everyone';
  end if;
  if v_src !~ 'ht\.status\s*=\s*''approved''' then
    raise exception '703: the driver would act on a task that is not approved (mig 642 expired tombstones say, verbatim, "Approved but never executed")';
  end if;
  if v_src !~ 't\.status\s*=\s*''active''' then
    raise exception '703: the driver would act inside a SUSPENDED workspace';
  end if;
  if v_src !~ 'ae\.decision\s+like\s+''human_gated%''' then
    raise exception '703: the driver would pick up rows that were never a human gate';
  end if;
  if v_src !~ 'ae\.connector_id\s+is\s+not\s+null' then
    raise exception '703: the routing filter is gone — the driver would attempt a row it cannot route (mig 701)';
  end if;
  if v_src !~ 'x\.resolves_task_id\s*=\s*ht\.id' or v_src !~ 'x\.decision\s*<>\s*''failed''' then
    raise exception '703: the already-carried-out check is gone — THE DRIVER WOULD SEND THE SAME CHASE EVERY FIVE MINUTES';
  end if;
  if v_src !~ 'least\(coalesce\(p_limit, 25\), 100\)' then
    raise exception '703: the limit clamp is gone — one tick could take an unbounded number of real actions';
  end if;

  -- E. THE PERIMETER. A DROP took the grants; this is the restore, checked.
  if has_function_privilege('anon', 'public.due_approved_actions(integer)', 'EXECUTE') then
    raise exception '703: anon can execute due_approved_actions — that lists approved money actions across every allowlisted tenant, and anon is the internet';
  end if;
  if has_function_privilege('authenticated', 'public.due_approved_actions(integer)', 'EXECUTE') then
    raise exception '703: authenticated can execute due_approved_actions';
  end if;
  if has_function_privilege('public', 'public.due_approved_actions(integer)', 'EXECUTE') then
    raise exception '703: PUBLIC still holds EXECUTE on due_approved_actions — revoking the named roles alone is theatre (mig 610)';
  end if;
  if not has_function_privilege('service_role', 'public.due_approved_actions(integer)', 'EXECUTE') then
    raise exception '703: service_role LOST EXECUTE on due_approved_actions — the DROP took the grant and it was not restored, so the driver would fail on every tick';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'due_approved_actions'
       and p.prosecdef and p.provolatile = 's'
       and array_to_string(p.proconfig, ',') like '%search_path=public%')
  then
    raise exception '703: due_approved_actions lost SECURITY DEFINER, STABLE, or its pinned search_path';
  end if;

  -- F. THE DRIVER IS STILL OFF. This migration must not switch anything on.
  select count(*) into v_n from platform_config
   where key = 'approved_action_driver.enabled_at' and nullif(btrim(value), '') is not null;
  if v_n > 0 then
    raise exception '703: approved_action_driver.enabled_at is SET — enabling the driver is a founder decision about money moving unattended, and this migration must never be the thing that made it';
  end if;
end $assert$;

commit;
