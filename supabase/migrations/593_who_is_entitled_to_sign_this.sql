-- 593 — who is entitled to sign this?
--
-- Move B of docs/44, and the finding that made the permissions review worth
-- doing. `decide_human_task` is the one sanctioned path for approving anything
-- on this platform. Before this migration it checked four things: are you
-- signed in, is this task in your workspace, if the task names a digital
-- employee may you access it, and is it still pending.
--
-- It never asked what was being approved, or what it was worth. The same test
-- governed a PKR 45,000 credit hold, a five pound refund, a change to a
-- guardrail protecting the whole workspace, and a promotion of an employee to
-- higher autonomy.
--
-- And the employee check only bites when a task names one. 238 of 320 pending
-- approvals name none — 74% — so for three quarters of the queue the only
-- question actually asked was "are you in this workspace".
--
-- ── The safety property that matters most ──────────────────────────────────
-- An authority check changes who may approve. Done carelessly it blocks people
-- who could approve yesterday and freezes the queue we have just spent a week
-- unblocking. So:
--
--   A WORKSPACE WITH NO AUTHORITY ROWS BEHAVES EXACTLY AS IT DOES TODAY.
--
-- `has_approval_authority` returns allowed when a tenant has declared nothing.
-- The mechanism ships; the restriction is a decision each workspace makes
-- deliberately. That is the difference between handing someone a lock and
-- changing their locks for them.
--
-- ── Three design calls ──────────────────────────────────────────────────────
--
-- 1. REJECTIONS ARE NOT GATED. Declining is the conservative direction. A rule
--    that stops someone saying "no" is not an authority model, it is a way of
--    forcing things through. Only approvals are checked.
--
-- 2. GRANTS ADD UP, THEY DO NOT FIGHT. A person may hold authority by role, by
--    org unit and personally. The most permissive matching grant wins. The
--    alternative — most restrictive wins — means giving somebody an extra
--    responsibility could silently take one away.
--
-- 3. A UNIT GRANT REACHES THE UNITS BENEATH IT. Authority on Finance applies to
--    the Accounts Receivable team inside it. This is the OPPOSITE direction
--    from `can_access_de`, deliberately: access asks "is this employee within
--    my remit" (downward from me); authority asks "does my remit sit under a
--    grant" (upward from me). Same tree, different question.

begin;

-- ── Who may sign what ───────────────────────────────────────────────────────

create table if not exists approval_authority (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  -- WHO holds it. At least one must be set; setting more than one narrows it.
  org_unit_id   uuid references org_units(id) on delete cascade,
  role          text,
  user_id       uuid,
  -- WHAT they may sign. NULL category = any kind of work.
  category      text,
  -- NULL = no ceiling. 0 = may approve only work with no money attached.
  max_amount_cents bigint,
  -- Above this, one signature is not enough. NULL = never.
  second_approver_above_cents bigint,
  note          text,
  is_active     boolean not null default true,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint approval_authority_has_a_holder
    check (org_unit_id is not null or role is not null or user_id is not null)
);

create index if not exists idx_approval_authority_tenant
  on approval_authority(tenant_id) where is_active;

drop trigger if exists approval_authority_updated_at on approval_authority;
create trigger approval_authority_updated_at before update on approval_authority
  for each row execute function update_updated_at();

alter table approval_authority enable row level security;

drop policy if exists approval_authority_read on approval_authority;
create policy approval_authority_read on approval_authority for select
  using (tenant_id = auth_tenant_id());

-- Only owners and admins may change who can sign. A manager able to widen
-- their own limit does not have a limit.
drop policy if exists approval_authority_write on approval_authority;
create policy approval_authority_write on approval_authority for all
  using (tenant_id = auth_tenant_id()
         and auth_has_tenant_role(array['tenant_owner','tenant_admin']));

-- ── A second signature leaves a trace ──────────────────────────────────────

alter table human_tasks add column if not exists first_approver_id uuid;
alter table human_tasks add column if not exists first_approved_at timestamptz;

-- ── What kind of thing is this, and what is it worth ───────────────────────

create or replace function task_approval_facts(p_task_id uuid)
returns table (category text, amount_cents bigint)
language sql stable security definer set search_path = public as $fn$
  select
    -- An action approval is classified by the action's own category
    -- (erp_financials, helpdesk, ads…); everything else by its task type
    -- (escalation, review_gate, checklist…). The two vocabularies do not
    -- overlap, so one column holds both without ambiguity.
    coalesce(ad.category, h.type),
    -- ⚠ `amount_cents` is the param name the platform's money gates already
    -- read; `outstanding_cents` is what the dunning sweep carries. Reading
    -- only one would leave a whole class of money silently unpriced.
    coalesce(
      nullif(ae.params->>'amount_cents', '')::bigint,
      nullif(ae.params->>'outstanding_cents', '')::bigint
    )
  from human_tasks h
  left join action_executions ae
    on ae.id = h.related_id and h.related_table = 'action_executions'
  left join action_definitions ad on ad.id = ae.action_definition_id
  where h.id = p_task_id
  limit 1;
$fn$;

grant execute on function task_approval_facts(uuid) to authenticated, service_role;

-- ── The check ───────────────────────────────────────────────────────────────

create or replace function has_approval_authority(
  p_user_id uuid, p_tenant_id uuid, p_category text, p_amount_cents bigint
) returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_declared int;
  v_role     text;
  v_best     record;
begin
  if p_user_id is null then
    return jsonb_build_object('allowed', false, 'reason', 'not signed in');
  end if;

  -- ⚠ THE PERMISSIVE DEFAULT. A workspace that has declared no authority
  -- behaves exactly as it did before this migration existed. Removing this is
  -- how you freeze every queue on the platform at once.
  select count(*) into v_declared
    from approval_authority where tenant_id = p_tenant_id and is_active;
  if v_declared = 0 then
    return jsonb_build_object('allowed', true, 'needs_second', false,
                              'reason', 'no approval limits are declared in this workspace');
  end if;

  select role into v_role from profiles where user_id = p_user_id and tenant_id = p_tenant_id;

  with granted as (
    select a.max_amount_cents, a.second_approver_above_cents
    from approval_authority a
    where a.tenant_id = p_tenant_id
      and a.is_active
      and (a.category is null or a.category = p_category)
      and (
        (a.user_id is not null and a.user_id = p_user_id)
        or (a.role is not null and a.role = v_role)
        or (a.org_unit_id is not null and exists (
             with recursive below as (
               select a.org_unit_id as id
               union
               select u.id from org_units u join below b on u.parent_id = b.id where u.is_active
             )
             select 1 from org_unit_members m
              where m.user_id = p_user_id and m.is_active
                and m.org_unit_id in (select id from below)
           ))
      )
  )
  select
    -- Most permissive wins: an unlimited grant beats any ceiling, a higher
    -- ceiling beats a lower one. Grants add up rather than fight.
    bool_or(max_amount_cents is null) as unlimited,
    max(max_amount_cents)             as ceiling,
    min(second_approver_above_cents)  as second_above,
    count(*)                          as n
  into v_best
  from granted;

  if coalesce(v_best.n, 0) = 0 then
    return jsonb_build_object('allowed', false,
      'reason', format('you hold no approval authority for %s in this workspace',
                       coalesce(p_category, 'this kind of work')));
  end if;

  -- Nothing financial attached: holding any matching grant is enough.
  if p_amount_cents is null then
    return jsonb_build_object('allowed', true, 'needs_second', false,
                              'reason', 'within your authority');
  end if;

  if not coalesce(v_best.unlimited, false) and p_amount_cents > coalesce(v_best.ceiling, 0) then
    return jsonb_build_object('allowed', false, 'limit_cents', v_best.ceiling,
      'reason', format('this is %s and your limit for %s is %s',
                       money_text(p_amount_cents, null),
                       coalesce(p_category, 'this kind of work'),
                       money_text(coalesce(v_best.ceiling, 0), null)));
  end if;

  return jsonb_build_object(
    'allowed', true, 'reason', 'within your authority',
    'needs_second', (v_best.second_above is not null and p_amount_cents > v_best.second_above));
end;
$fn$;

grant execute on function has_approval_authority(uuid, uuid, text, bigint) to authenticated, service_role;

-- ── The gate itself ─────────────────────────────────────────────────────────
-- Spliced into the deployed body, not retyped: this function carries the
-- pending-only double-approval guard, the sanctioned-decision set_config and
-- the DE scoping clause, and losing any of them to a typo would be worse than
-- the gap being closed.

CREATE OR REPLACE FUNCTION public.decide_human_task(p_task_id uuid, p_decision text, p_reason_code text DEFAULT NULL::text, p_note text DEFAULT NULL::text, p_edit jsonb DEFAULT NULL::jsonb)
 RETURNS human_tasks
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid := auth_tenant_id();
  v_task   human_tasks;
  v_row    human_tasks;
  v_cat    text;
  v_amt    bigint;
  v_auth   jsonb;
BEGIN
  perform set_config('app.allow_task_decision', 'on', true);   -- mig 486: sanctioned decision path
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'decision must be approved or rejected';
  END IF;
  -- A rejection with no reason teaches nothing. This is the one place the
  -- friction is worth it; a clean approval needs no code.
  IF p_decision = 'rejected' AND coalesce(btrim(p_reason_code), '') = '' THEN
    RAISE EXCEPTION 'reason_required: a rejection must carry a reason code';
  END IF;

  SELECT * INTO v_task FROM human_tasks WHERE id = p_task_id AND tenant_id = v_tenant;
  IF v_task.id IS NULL THEN RAISE EXCEPTION 'task_not_found'; END IF;

  -- DE scoping (mig 385). Null-tolerant, matching the mig-386/452 policies:
  -- an unattributed task is decidable by the whole workspace, exactly as it is
  -- visible to them. A bare guard here would be stricter than the table.
  IF v_task.de_id IS NOT NULL AND NOT public.can_access_de(v_task.de_id) THEN
    RAISE EXCEPTION 'not_responsible_for_de: this employee is not in your reporting line';
  END IF;

  -- ── mig 593: AUTHORITY ──────────────────────────────────
  -- Everything above answers "may you SEE this?". Nothing has ever asked
  -- "are you entitled to SIGN it?" — a PKR 45,000 credit hold and a five
  -- pound refund passed the identical test, and 238 of 320 pending items
  -- name no employee at all, so the scoping clause never even bit.
  --
  -- REJECTIONS ARE DELIBERATELY NOT GATED. Declining is the conservative
  -- direction, and a rule that stops someone saying "no" is not an
  -- authority model, it is a way of forcing things through.
  IF p_decision = 'approved' THEN
    SELECT category, amount_cents INTO v_cat, v_amt FROM task_approval_facts(p_task_id);
    v_auth := has_approval_authority(auth.uid(), v_tenant, v_cat, v_amt);

    IF NOT coalesce((v_auth->>'allowed')::boolean, true) THEN
      RAISE EXCEPTION 'not_authorised_to_approve: %', v_auth->>'reason';
    END IF;

    -- A second pair of eyes. The first approval is RECORDED and the task
    -- stays pending; it completes when a DIFFERENT person approves.
    -- Recording rather than refusing is what stops the first approver
    -- having to remember they already looked at it.
    IF coalesce((v_auth->>'needs_second')::boolean, false)
       AND (v_task.first_approver_id IS NULL OR v_task.first_approver_id = auth.uid()) THEN
      UPDATE human_tasks
         SET first_approver_id = auth.uid(), first_approved_at = now(), updated_at = now()
       WHERE id = p_task_id AND status = 'pending';
      RETURN NULL;   -- contract: NULL means the caller MUST skip its hooks
    END IF;
  END IF;

  -- ⚠ The pending-only clause is the double-approval guard the caller depends
  -- on. No row back means "already decided" and the caller MUST skip its side
  -- effects (invoice send, gated-action execute, write-backs). Do not relax.
  UPDATE human_tasks
     SET status               = p_decision,
         decided_by           = auth.uid(),
         decided_at           = now(),
         updated_at           = now(),
         decision_reason_code = nullif(btrim(p_reason_code), ''),
         decision_note        = nullif(btrim(p_note), ''),
         decision_edit        = p_edit
   WHERE id = p_task_id AND tenant_id = v_tenant AND status = 'pending'
   RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN RETURN NULL; END IF;   -- already decided; caller skips hooks

  -- Governance record. 'approval' is constraint-legal (checked against
  -- audit_events_category_check); p_category is NOT normalised by
  -- append_audit_event, so an invented category would raise and abort the
  -- decision — the mig-429 lesson.
  PERFORM append_audit_event(
    v_tenant,
    coalesce((SELECT full_name FROM profiles WHERE user_id = auth.uid()), 'An approver'),
    'human',
    format('Task %s: %s%s', p_decision, v_row.title,
           CASE WHEN p_reason_code IS NOT NULL THEN ' (' || p_reason_code || ')' ELSE '' END),
    'approval',
    jsonb_build_object(
      'kind', 'human_task_decision', 'task_id', p_task_id, 'task_type', v_row.type,
      'decision', p_decision, 'reason_code', nullif(btrim(p_reason_code), ''),
      'de_id', v_row.de_id, 'edited', (p_edit IS NOT NULL),
      'related_table', v_row.related_table, 'related_id', v_row.related_id));

  RETURN v_row;
END $function$
;

do $assert$
declare v_src text; v_res jsonb; v_u uuid; v_t uuid;
begin
  select prosrc into v_src from pg_proc where proname = 'decide_human_task';
  if v_src !~ 'not_responsible_for_de'  then raise exception 'lost: DE scoping clause'; end if;
  if v_src !~ 'app.allow_task_decision' then raise exception 'lost: sanctioned-decision set_config'; end if;
  if v_src !~ 'reason_required'         then raise exception 'lost: rejection-reason rule'; end if;
  if v_src !~ 'append_audit_event'      then raise exception 'lost: audit event'; end if;
  if v_src !~ 'not_authorised_to_approve' then raise exception 'the authority gate was not applied'; end if;
  if (select count(*) from pg_proc where proname = 'decide_human_task') <> 1 then
    raise exception 'decide_human_task: overloads exist';
  end if;

  -- The permissive default, asserted rather than assumed: with nothing
  -- declared, a workspace must still allow what it allowed yesterday.
  select id into v_t from tenants where slug = 'outsourcetel-hq';
  select user_id into v_u from profiles where tenant_id = v_t limit 1;
  v_res := has_approval_authority(v_u, v_t, 'erp_financials', 4500000);
  if not coalesce((v_res->>'allowed')::boolean, false) then
    raise exception 'PERMISSIVE DEFAULT BROKEN — an undeclared workspace would be frozen: %', v_res;
  end if;
end;
$assert$;

commit;
