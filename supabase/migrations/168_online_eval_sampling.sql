-- ═══════════════════════════════════════════════════════════════
-- 168 — Continuous online evals: sampling substrate (Frontier-20 #2)
--
-- Score a sampled % of REAL production answers with the LLM judge
-- (mig 167), continuously, so quality drift is caught in hours not
-- quarters (Decagon Watchtower / the 2026 "always-on QA" bar). This
-- migration adds only the dedupe link + the sampler RPC; the de-eval-
-- online edge function does the judging (LLM) and a cron drives it.
--
-- Deliberate design: online eval FLAGS drift (writes an activity_event
-- the Insights/trust surfaces read) — it does NOT auto-demote a DE's
-- trust. Trust promotion/demotion stays evidence-based and human-owned
-- (trust_policies), consistent with the platform's trust doctrine; an
-- automated judge silently lowering autonomy would be the wrong kind of
-- un-reviewable action.
-- ═══════════════════════════════════════════════════════════════

alter table eval_judgments add column if not exists message_id uuid;
create unique index if not exists eval_judgments_message_uniq
  on eval_judgments (message_id) where message_id is not null;

-- Claim up to N un-judged, delivered assistant messages from the recent
-- window, pairing each with the customer question that preceded it in the
-- same conversation. Service-role only (the sampler cron/worker).
create or replace function public.sample_messages_for_online_eval(
  p_limit integer default 5, p_window_minutes integer default 90, p_tenant_id uuid default null
) returns table (
  message_id uuid, tenant_id uuid, de_id uuid, conversation_id uuid, question text, answer text
)
language sql stable security definer set search_path to 'public' as $function$
  select m.id, m.tenant_id, c.de_id, m.conversation_id,
         -- the most recent customer turn before this answer
         (select um.content from de_messages um
           where um.conversation_id = m.conversation_id and um.role = 'user' and um.created_at <= m.created_at
           order by um.created_at desc limit 1) as question,
         m.content as answer
  from de_messages m
  join de_conversations c on c.id = m.conversation_id
  where m.role = 'assistant'
    and m.delivery = 'sent'                     -- only answers a customer actually received
    and not m.escalated
    and m.created_at >= now() - make_interval(mins => greatest(5, p_window_minutes))
    and (p_tenant_id is null or m.tenant_id = p_tenant_id)
    and not exists (select 1 from eval_judgments j where j.message_id = m.id)
    and exists (select 1 from de_messages um where um.conversation_id = m.conversation_id and um.role = 'user' and um.created_at <= m.created_at)
  order by m.created_at desc
  limit greatest(1, least(50, p_limit));
$function$;

revoke all on function public.sample_messages_for_online_eval(integer, integer, uuid) from public, anon, authenticated;
grant execute on function public.sample_messages_for_online_eval(integer, integer, uuid) to service_role;
