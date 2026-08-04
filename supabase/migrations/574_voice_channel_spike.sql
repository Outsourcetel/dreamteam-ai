-- 574: the voice-channel spike (docs/42 P0) — the database side.
--
-- Founder approved the spike 2026-08-04. This adds the minimum schema for a
-- phone call to be governed and recorded like every other unit of work:
--   * evidence_runs learns kind='call', so calls feed the SAME performance/
--     trust/certification organs as chat answers — no parallel system.
--   * voice_messages / voice_appointments — where the two spike tools land.
--     take_message writes directly (internal note-taking, like chat answers,
--     is not an external action). book_appointment goes through the GATE:
--     registered below as a destructive dreamteam-provider action, so it is
--     always human-approved and lands in action_executions with a receipt.
--   * Readers are the spike report + approval UI today; Employee File call
--     surfaces are P1. Recorded honestly rather than oversold.
begin;

alter table public.evidence_runs drop constraint if exists evidence_runs_kind_check;
alter table public.evidence_runs add constraint evidence_runs_kind_check
  check (kind = any (array['answer'::text, 'work'::text, 'call'::text]));

create table if not exists public.voice_messages (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  de_id        uuid references public.digital_employees(id) on delete set null,
  call_id      text,
  caller_name  text,
  caller_phone text,
  message      text not null,
  created_at   timestamptz not null default now()
);
alter table public.voice_messages enable row level security;
drop policy if exists voice_messages_tenant_select on public.voice_messages;
create policy voice_messages_tenant_select on public.voice_messages
  for select using (exists (select 1 from profiles p
    where p.user_id = auth.uid() and p.tenant_id = voice_messages.tenant_id));
revoke insert, update, delete on public.voice_messages from anon, authenticated;

create table if not exists public.voice_appointments (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  de_id          uuid references public.digital_employees(id) on delete set null,
  call_id        text,
  caller_name    text not null,
  caller_phone   text not null,
  service        text not null,
  preferred_time text not null,
  status         text not null default 'requested'
                 check (status in ('requested','confirmed','declined','cancelled')),
  created_at     timestamptz not null default now()
);
alter table public.voice_appointments enable row level security;
drop policy if exists voice_appointments_tenant_select on public.voice_appointments;
create policy voice_appointments_tenant_select on public.voice_appointments
  for select using (exists (select 1 from profiles p
    where p.user_id = auth.uid() and p.tenant_id = voice_appointments.tenant_id));
revoke insert, update, delete on public.voice_appointments from anon, authenticated;

-- The gated action. provider='dreamteam' + category='platform_admin' so it
-- resolves against the existing self connector (Ada's proven action target) —
-- no new connector machinery for a spike. destructive:true means the floor in
-- decide_action_execution human-gates it unconditionally: the caller hears
-- "a colleague will confirm", which IS the product behaving correctly.
insert into public.action_definitions
  (scope, tenant_id, category, provider, action_key, label, description,
   reversible, risk, execution, param_schema, status)
select 'platform', null, 'platform_admin', 'dreamteam', 'book_appointment',
  'Book appointment',
  'Requested by a caller on the phone. Approving confirms the appointment request and a human follows up to finalize; declining discards it.',
  true,
  '{"destructive": true, "idempotent": false}'::jsonb,
  '{"execution_key": "voice_book_appointment"}'::jsonb,
  '[{"name":"caller_name","type":"string","required":true,"help":"Who asked"},
    {"name":"caller_phone","type":"string","required":true,"help":"Callback number"},
    {"name":"service","type":"string","required":true,"help":"What they want"},
    {"name":"preferred_time","type":"string","required":true,"help":"When they asked for"}]'::jsonb,
  'active'
where not exists (select 1 from public.action_definitions
  where scope = 'platform' and tenant_id is null
    and category = 'platform_admin' and action_key = 'book_appointment');

do $do$
declare v_t uuid; v_ok boolean := false;
begin
  if not exists (select 1 from action_definitions
                  where scope='platform' and action_key='book_appointment'
                    and execution->>'execution_key' = 'voice_book_appointment') then
    raise exception '574: book_appointment action was not registered';
  end if;

  -- kind='call' must actually be insertable (probe rolled back via sub-block).
  select id into v_t from tenants where name = 'Outsourcetel';
  begin
    insert into evidence_runs (tenant_id, inquiry, status, kind)
    values (v_t, '574 probe', 'complete', 'call');
    v_ok := true;
    raise exception using errcode = '22000', message = '__probe_rollback__';
  exception when sqlstate '22000' then
    if sqlerrm <> '__probe_rollback__' then raise; end if;
  end;
  if not v_ok then raise exception '574: kind=call still rejected'; end if;

  if to_regclass('public.voice_messages') is null
     or to_regclass('public.voice_appointments') is null then
    raise exception '574: voice tables missing';
  end if;
  raise notice '574: voice spike schema in place';
end $do$;

commit;
