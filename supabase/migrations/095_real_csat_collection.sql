-- Migration 095: Performance & Insights page rebuild, part 3 — real
-- CSAT collection. CSAT has never actually been collected: migration
-- 010 added csat_score/csat_submitted_at to a `conversations` table
-- that has never existed in this schema (the real table is
-- de_conversations) -- api.ts's submitCSAT has been silently failing on
-- every call since it was written, and EndUserChatPage.tsx already has a
-- real, live thumbs-up/down UI wired to that broken function. This
-- fixes the actual bug (the columns/table mismatch) rather than
-- inventing a new survey feature from scratch.
--
-- de_conversations also gets a new de_id column (nullable), because
-- CSAT needs to be attributable to a specific DE for this page's
-- per-DE breakdown, and no attribution existed at all before this.
-- de-answer/widget-ask now set it at conversation-creation time (they
-- already resolve subjectDeId for knowledge-scope filtering — this
-- reuses that same resolution, no new lookup).
-- =====================================================================

alter table de_conversations
  add column if not exists de_id uuid references digital_employees(id) on delete set null,
  add column if not exists csat_score smallint,
  add column if not exists csat_submitted_at timestamptz;

alter table de_conversations
  drop constraint if exists de_conversations_csat_score_check;
alter table de_conversations
  add constraint de_conversations_csat_score_check check (csat_score is null or csat_score in (1, -1));

create index if not exists de_conversations_de_id_idx on de_conversations(de_id);

-- ── submit_csat ──
-- Replaces the direct client .update() against a nonexistent table.
-- Low-sensitivity (thumbs up/down only) -- any authenticated caller can
-- submit for a conversation that genuinely belongs to the stated
-- tenant, matching the leniency the original (broken) code intended.
create or replace function public.submit_csat(p_conversation_id uuid, p_tenant_id uuid, p_score integer)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if p_score not in (1, -1) then
    raise exception 'score must be 1 or -1';
  end if;

  update de_conversations
    set csat_score = p_score, csat_submitted_at = now()
    where id = p_conversation_id and tenant_id = p_tenant_id;

  if not found then
    raise exception 'conversation not found for this tenant';
  end if;

  return jsonb_build_object('ok', true);
end;
$function$;

revoke all on function public.submit_csat(uuid, uuid, integer) from public, anon;
grant execute on function public.submit_csat(uuid, uuid, integer) to authenticated;

-- ── get_de_csat_metrics ──
-- Same read gate as get_de_performance_metrics/get_de_cost_metrics.
create or replace function public.get_de_csat_metrics(p_tenant_id uuid)
returns table(de_id uuid, total_ratings bigint, positive_ratings bigint, csat_pct numeric)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not (
    is_platform_admin()
    or exists (select 1 from profiles p where p.user_id = auth.uid() and p.tenant_id = p_tenant_id)
  ) then
    raise exception 'not authorized to view this workspace''s CSAT data';
  end if;

  return query
    select
      c.de_id,
      count(*) as total_ratings,
      count(*) filter (where c.csat_score = 1) as positive_ratings,
      round(100.0 * count(*) filter (where c.csat_score = 1) / nullif(count(*), 0), 1) as csat_pct
    from de_conversations c
    where c.tenant_id = p_tenant_id and c.csat_submitted_at is not null and c.de_id is not null
    group by c.de_id;
end;
$function$;

revoke all on function public.get_de_csat_metrics(uuid) from public, anon;
grant execute on function public.get_de_csat_metrics(uuid) to authenticated;
