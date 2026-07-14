-- ============================================================
-- 149 — Support chat Phase 1 foundation: the unified conversation =
-- ticket model (Fin-style), plus the per-DE external-reply send mode.
--
-- INFRASTRUCTURE ONLY. No intelligence/guardrail logic lives here — this
-- just extends the existing de_conversations/de_messages so one thread
-- can flow AI handling -> needs human -> human owned -> resolved, and so
-- the DE's own config decides whether an external reply auto-sends or
-- drafts for approval. The brain stays in de-answer/widget-ask + the
-- Control Fabric; these columns only carry state the channel presents.
-- ============================================================

-- 1) Widen the conversation channel (was CHECK-locked to 'dock' only —
--    so the public widget was mislabeling every conversation 'dock').
alter table de_conversations drop constraint if exists de_conversations_channel_check;
alter table de_conversations add constraint de_conversations_channel_check
  check (channel in ('dock', 'widget', 'hosted', 'portal', 'email'));

-- 2) Conversation lifecycle + the fields a human inbox (Phase 2) needs,
--    stored from day one so the inbox slots in with no backfill.
alter table de_conversations
  add column if not exists status text not null default 'ai_handling',
  add column if not exists priority text not null default 'normal',
  add column if not exists owner_user_id uuid,          -- human who took the thread (Phase 2); no hard FK for flexibility
  add column if not exists subject text,                -- short auto-title for the inbox
  add column if not exists detected_language text,      -- language mirrored back to the customer
  add column if not exists handoff_summary text,        -- 2-line summary written on escalation
  add column if not exists account_external_ref text,
  add column if not exists end_user_ref text,
  add column if not exists end_user_name text,
  add column if not exists last_message_at timestamptz;

alter table de_conversations drop constraint if exists de_conversations_status_check;
alter table de_conversations add constraint de_conversations_status_check
  check (status in ('ai_handling', 'needs_human', 'human_owned', 'resolved'));
alter table de_conversations drop constraint if exists de_conversations_priority_check;
alter table de_conversations add constraint de_conversations_priority_check
  check (priority in ('low', 'normal', 'high', 'urgent'));

create index if not exists de_conversations_status_idx
  on de_conversations(tenant_id, status, last_message_at desc nulls last);

-- 3) Message-level: language, optional voice audio, and delivery state
--    (a draft-mode reply is stored but NOT delivered until a human approves).
alter table de_messages
  add column if not exists lang text,
  add column if not exists audio_url text,
  add column if not exists delivery text not null default 'sent';
alter table de_messages drop constraint if exists de_messages_delivery_check;
alter table de_messages add constraint de_messages_delivery_check
  check (delivery in ('sent', 'draft_pending', 'blocked'));

-- 4) Per-DE external-reply send mode (founder decision: per-DE, you decide
--    each). Default 'draft' — start safe (human approves before a customer
--    sees it); flip to 'auto' per DE once it's earned trust. This is DE
--    config the channel reads; it is NOT chat logic.
alter table digital_employees
  add column if not exists external_reply_mode text not null default 'draft';
alter table digital_employees drop constraint if exists digital_employees_external_reply_mode_check;
alter table digital_employees add constraint digital_employees_external_reply_mode_check
  check (external_reply_mode in ('draft', 'auto'));
