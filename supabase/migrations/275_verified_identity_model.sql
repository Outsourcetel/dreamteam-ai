-- 275_verified_identity_model.sql
-- ============================================================================
-- VERIFIED-IDENTITY MODEL (T2.3 prerequisite). The columns BOTH the widget-HMAC
-- and email-DMARC paths write via the bind RPC (mig 277), plus the de_memory
-- 'identity' subject_kind that cross-conversation memory keys on.
--
-- Designed + adversarially verified (wf_d0585fd8-8a5). Structural guarantees:
--   * verified_identity_key is a NEW column — NOT end_user_key (which mig 237
--     made GENERATED from the spoofable end_user_ref, so it can't be trusted).
--   * A CHECK makes the empty-string-collision bucket impossible: a verified
--     conversation ALWAYS has a non-blank key, so unverified/blank keys can
--     never collide into one shared identity bucket.
-- The verified flag is written ONLY by the service-role bind RPC after HMAC
-- (widget) or DMARC (email) proof. Per the adversary's CRITICAL finding, the
-- memory GATE consumes a PER-TURN verification signal (mig 276/277 + edge fns),
-- never merely this stored flag. GLOBAL, additive.
-- ============================================================================

ALTER TABLE de_conversations
  ADD COLUMN IF NOT EXISTS identity_verified   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS verified_identity_key text,
  ADD COLUMN IF NOT EXISTS identity_method     text;

-- identity_method vocabulary
ALTER TABLE de_conversations DROP CONSTRAINT IF EXISTS de_conversations_identity_method_ck;
ALTER TABLE de_conversations ADD CONSTRAINT de_conversations_identity_method_ck
  CHECK (identity_method IS NULL OR identity_method IN ('widget_hmac','email_dmarc'));

-- Anti-collision: a verified conversation must carry a non-blank key.
ALTER TABLE de_conversations DROP CONSTRAINT IF EXISTS de_conversations_verified_key_ck;
ALTER TABLE de_conversations ADD CONSTRAINT de_conversations_verified_key_ck
  CHECK (identity_verified = false
         OR (verified_identity_key IS NOT NULL AND btrim(verified_identity_key) <> ''));

CREATE INDEX IF NOT EXISTS idx_de_conversations_verified_identity
  ON de_conversations (tenant_id, verified_identity_key)
  WHERE identity_verified AND verified_identity_key IS NOT NULL;

-- Allow identity-scoped durable memory. Reproduced FROM LIVE (the current def is
-- subject_kind in general|entity|case|conversation) + 'identity'. New value is
-- default-DENY to unpatched readers (they simply never query subject_kind='identity').
ALTER TABLE de_memory DROP CONSTRAINT IF EXISTS de_memory_subject_kind_check;
ALTER TABLE de_memory ADD CONSTRAINT de_memory_subject_kind_check
  CHECK (subject_kind = ANY (ARRAY['general'::text, 'entity'::text, 'case'::text, 'conversation'::text, 'identity'::text]));

NOTIFY pgrst, 'reload schema';
