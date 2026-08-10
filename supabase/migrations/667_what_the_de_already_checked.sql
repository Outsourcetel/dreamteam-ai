-- 667: "What Sophie already checked" — retain the DE's pre-escalation
-- verification per conversation (handoff 06 §A).
--
-- WHY. When a DE escalates, the human re-does the checking before trusting
-- the draft — the handoff calls retention "the highest-value item on the
-- screen". The runtime HOLDS the evidence at escalation time (knowledge
-- sources, identity verification, which guardrail or escalation rule fired,
-- confidence) and then throws it away: widget-ask's escalation exit returns
-- sources: []. This table is where that evidence stops dying.
--
-- WHAT IT IS NOT. There are NO conversation-time connector calls in the
-- runtime today (verified: zero tool references in widget-ask/de-answer), so
-- no 'connector' rows will exist yet — the kind is admitted for the day they
-- arrive. A check row asserts a check that RAN; nothing here may be invented.
--
-- WRITERS: service role only (the DE runtime). Clients get SELECT via RLS and
-- nothing else — there is deliberately NO insert/update/delete policy, so
-- even a compromised authenticated session cannot backfill fake evidence.

do $$
begin
  if to_regclass('public.conversation_checks') is not null then
    raise exception 'conversation_checks already exists — this migration expects to create it';
  end if;
end $$;

create table public.conversation_checks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  conversation_id uuid not null references public.de_conversations(id) on delete cascade,
  de_id uuid null references public.digital_employees(id) on delete set null,
  kind text not null check (kind in ('knowledge','identity','guardrail','escalation_rule','connector')),
  ok boolean not null,
  label text not null,
  detail text null,
  created_at timestamptz not null default now()
);

create index conversation_checks_conv_idx on public.conversation_checks (conversation_id, created_at);
create index conversation_checks_tenant_idx on public.conversation_checks (tenant_id);

alter table public.conversation_checks enable row level security;

-- Tenant members may READ their tenant's checks. That is the whole client
-- surface: no write policies exist, so RLS denies client writes regardless
-- of table privileges.
create policy conversation_checks_tenant_read on public.conversation_checks
  for select using (tenant_id = public.auth_tenant_id());

-- Belt and braces on top of "no write policy": strip write PRIVILEGES from
-- the client roles too (mig 610/630 discipline — always all three).
revoke insert, update, delete on public.conversation_checks from public, anon, authenticated;

-- Assert AFTER: table exists, RLS on, exactly one policy, and it is SELECT.
do $$
declare
  v_policies int;
  v_rls boolean;
begin
  if to_regclass('public.conversation_checks') is null then
    raise exception 'conversation_checks was not created';
  end if;
  select relrowsecurity into v_rls from pg_class where oid = 'public.conversation_checks'::regclass;
  if not v_rls then
    raise exception 'RLS is not enabled on conversation_checks';
  end if;
  select count(*) into v_policies from pg_policies
    where schemaname = 'public' and tablename = 'conversation_checks';
  if v_policies <> 1 then
    raise exception 'expected exactly 1 policy on conversation_checks, found %', v_policies;
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'conversation_checks' and cmd = 'SELECT'
  ) then
    raise exception 'the single conversation_checks policy is not SELECT';
  end if;
end $$;
