-- ═══════════════════════════════════════════════════════════════
-- 179 — Proactive outbound core, draft leg (Frontier-20 #17)
--
-- A DE working a long-horizon goal ("follow up with the customer",
-- "chase the renewal") can now PRODUCE the outbound message — as a
-- DRAFT that lands in the existing approvals inbox. Nothing is ever
-- sent by the platform:
--
--   • outbound_drafts — the draft + full provenance (which work item /
--     objective / conversation caused it) + a linked human_tasks row
--     ('approval_gate'), so drafts surface in the approvals UI that
--     already exists with zero new frontend.
--   • create_outbound_draft — the ONLY write path (service role; the
--     de-work executor's draft_outreach tool calls it).
--   • DELIVERY IS DORMANT BY CONSTRUCTION: status 'sent' exists in the
--     CHECK for the day a channel provider lands, but NO code path sets
--     it — approving a draft means a human copies it into their own
--     email/SMS tool. SKIPPED (founder-blocked): channel providers.
-- ═══════════════════════════════════════════════════════════════

create table if not exists outbound_drafts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  de_id         uuid not null references digital_employees(id) on delete cascade,
  recipient_ref text not null,          -- who it's for (name/email/account ref — freeform, human resolves)
  channel       text not null default 'email' check (channel in ('email', 'sms', 'chat', 'other')),
  subject       text not null default '',
  body          text not null,
  reason        text not null default '',   -- why the DE drafted this
  source_kind   text check (source_kind in ('work_item', 'objective', 'conversation', 'manual')),
  source_ref    uuid,
  status        text not null default 'pending_approval'
    check (status in ('pending_approval', 'approved', 'rejected', 'sent')),
  human_task_id uuid references human_tasks(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists outbound_drafts_tenant_idx on outbound_drafts (tenant_id, created_at desc);

alter table outbound_drafts enable row level security;
drop policy if exists outbound_drafts_read on outbound_drafts;
create policy outbound_drafts_read on outbound_drafts for select using (
  tenant_id in (select p.tenant_id from profiles p where p.user_id = auth.uid())
  or exists (select 1 from profiles p where p.user_id = auth.uid() and p.layer = 'platform'));

-- ── the ONLY write path ──
create or replace function public.create_outbound_draft(
  p_tenant_id uuid, p_de_id uuid, p_recipient text, p_channel text, p_subject text,
  p_body text, p_reason text default '', p_source_kind text default 'manual', p_source_ref uuid default null
) returns uuid
language plpgsql security definer set search_path to 'public' as $function$
declare v_draft uuid; v_task uuid; v_name text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'create_outbound_draft is service-role only';
  end if;
  if p_body is null or length(trim(p_body)) < 10 then
    raise exception 'draft body required (min 10 chars)';
  end if;
  if not exists (select 1 from digital_employees where id = p_de_id and tenant_id = p_tenant_id) then
    raise exception 'de not in tenant';
  end if;

  insert into outbound_drafts (tenant_id, de_id, recipient_ref, channel, subject, body, reason, source_kind, source_ref)
  values (p_tenant_id, p_de_id, left(coalesce(p_recipient, ''), 200),
          case when p_channel in ('email','sms','chat','other') then p_channel else 'email' end,
          left(coalesce(p_subject, ''), 200), p_body, left(coalesce(p_reason, ''), 500),
          case when p_source_kind in ('work_item','objective','conversation','manual') then p_source_kind else 'manual' end,
          p_source_ref)
  returning id into v_draft;

  select coalesce(persona_name, name, 'DE') into v_name from digital_employees where id = p_de_id;
  insert into human_tasks (tenant_id, type, source, title, detail, related_table, related_id)
  values (p_tenant_id, 'approval_gate', 'de',
    format('Outbound draft from %s — to %s', v_name, left(coalesce(p_recipient, 'recipient'), 60)),
    format(E'%s drafted an outbound %s message and needs your approval. NOTHING sends automatically — approving means you deliver it via your own channel.\n\nTo: %s\nSubject: %s\n\n%s\n\nWhy: %s',
           v_name, case when p_channel in ('email','sms','chat','other') then p_channel else 'email' end,
           coalesce(p_recipient, '—'), coalesce(nullif(p_subject, ''), '—'), p_body, coalesce(nullif(p_reason, ''), '—')),
    'outbound_drafts', v_draft)
  returning id into v_task;

  update outbound_drafts set human_task_id = v_task, updated_at = now() where id = v_draft;
  return v_draft;
end;
$function$;
revoke all on function public.create_outbound_draft(uuid, uuid, text, text, text, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.create_outbound_draft(uuid, uuid, text, text, text, text, text, text, uuid) to service_role;

-- ── keep draft status in lockstep with its review task ──
create or replace function public.sync_outbound_draft_status() returns trigger
language plpgsql as $function$
begin
  if NEW.related_table = 'outbound_drafts' and NEW.status in ('approved', 'rejected')
     and OLD.status is distinct from NEW.status then
    update outbound_drafts set status = NEW.status, updated_at = now()
     where id = NEW.related_id and status = 'pending_approval';
  end if;
  return NEW;
end;
$function$;
drop trigger if exists trg_sync_outbound_draft on human_tasks;
create trigger trg_sync_outbound_draft
  after update of status on human_tasks
  for each row execute function public.sync_outbound_draft_status();
