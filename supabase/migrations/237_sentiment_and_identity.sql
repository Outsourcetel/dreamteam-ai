-- 237_sentiment_and_identity.sql
-- ============================================================================
-- Support hardening — richer SENTIMENT + cross-channel IDENTITY stitch.
--
-- Today the platform has a single frustration SCORE, and continuity is per
-- conversation. The prompt asks for operational sentiment (confusion, anger,
-- anxiety, churn language…) and for one coherent context per PERSON across
-- email/chat. The parts that need an LLM (nuanced emotion) are credit-blocked;
-- this ships the parts that are DETERMINISTIC and testable without credits:
--
--   1. SENTIMENT — a keyword classifier (same literal-match discipline as the
--      triage classifier, mig 233) sets de_conversations.sentiment on every
--      customer message, re-evaluated each turn so the latest mood wins.
--      Precedence puts the operationally-urgent signals first (churn > anger >
--      frustration > anxiety > confusion > satisfaction > neutral).
--   2. IDENTITY — end_user_key, a normalized generated column from end_user_ref
--      (usually the email), + an index. It lets a person's widget, email and
--      portal conversations be grouped as ONE identity (a plain RLS-scoped query
--      by end_user_key), so a human/DE sees the whole history — no per-channel
--      silos. (Sessions with no stable identifier don't stitch — honest limit.)
--
-- Both are additive + deterministic + resilient (the sentiment trigger never
-- blocks a customer message). Surfacing sentiment/person-view in the UI is a
-- follow-up. SQL only, verifiable by review. GLOBAL.
-- ============================================================================

-- 1. Columns ------------------------------------------------------------------
ALTER TABLE de_conversations
  ADD COLUMN IF NOT EXISTS sentiment    text,
  ADD COLUMN IF NOT EXISTS end_user_key text
    GENERATED ALWAYS AS (nullif(lower(btrim(coalesce(end_user_ref, ''))), '')) STORED;
CREATE INDEX IF NOT EXISTS idx_de_conversations_end_user
  ON de_conversations(tenant_id, end_user_key) WHERE end_user_key IS NOT NULL;

-- 2. Deterministic sentiment classifier (no LLM) ------------------------------
CREATE OR REPLACE FUNCTION public.classify_sentiment_text(p_text text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE v text := lower(coalesce(p_text, ''));
BEGIN
  IF v ~ 'cancel my|switch to|competitor|leaving you|close my account|no longer want|take my business' THEN RETURN 'churn_risk'; END IF;
  IF v ~ 'unacceptable|furious|ridiculous|worst|terrible|outrageous|disgusted|so angry|fed up' THEN RETURN 'angry'; END IF;
  IF v ~ 'still not|yet again|third time|keep failing|frustrat|annoyed|why is this|not working again' THEN RETURN 'frustrated'; END IF;
  IF v ~ 'urgent|asap|deadline|worried|concerned|losing money|at risk|time-sensitive' THEN RETURN 'anxious'; END IF;
  IF v ~ 'confus|do not understand|don''t understand|not sure how|unclear|how do i|where do i' THEN RETURN 'confused'; END IF;
  IF v ~ 'thank you|thanks|great|awesome|perfect|works now|resolved|appreciate|much better' THEN RETURN 'satisfied'; END IF;
  RETURN 'neutral';
END; $$;
REVOKE ALL ON FUNCTION public.classify_sentiment_text(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.classify_sentiment_text(text) TO authenticated, service_role;

-- 3. Apply sentiment on each customer message (resilient — never blocks) -------
CREATE OR REPLACE FUNCTION public.trg_support_sentiment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF coalesce(NEW.role, '') <> 'user' THEN RETURN NEW; END IF;
  BEGIN
    UPDATE de_conversations
       SET sentiment = public.classify_sentiment_text(NEW.content)
     WHERE id = NEW.conversation_id;
  EXCEPTION WHEN OTHERS THEN
    NULL;  -- sentiment must never block a customer message landing
  END;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_support_sentiment ON de_messages;
CREATE TRIGGER trg_support_sentiment
  AFTER INSERT ON de_messages
  FOR EACH ROW EXECUTE FUNCTION public.trg_support_sentiment();
