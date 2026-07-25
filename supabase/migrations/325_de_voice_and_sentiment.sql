-- 325_de_voice_and_sentiment.sql
-- ============================================================================
-- THE JUDGMENT LAYER — let a digital employee read the room and sound like a
-- person, without loosening a single fact.
--
-- Founder, after using the live chat: "pleasantries like 'I am frustrated' or
-- 'thanks this helped' are handled poorly with no sensible conversation."
--
-- Diagnosis (verified in code, not assumed):
--   1. The model receives ONE line — `messages: [{role:'user', content: question}]`.
--      No conversation history on any answer path. Every turn is a cold open, so
--      it cannot track an emotional arc, a repeated question, or a callback joke.
--   2. escalation rulesets load a `frustration_threshold`, but NOTHING on the
--      answer path ever computes a sentiment value to compare against it. The
--      dial is wired to nothing.
--   3. The persona injects identity (name/role/purpose/responsibilities) but no
--      VOICE — no guidance on warmth, brevity, or register.
--
-- Deliberately NOT a sentiment classifier. Detection bolted beside generation is
-- what makes bots sound like bots ("I detect that you are frustrated. I am sorry
-- you are frustrated."). Modern models read tone natively; they need context,
-- permission, and a voice. This migration supplies the storage for 2 and 3; the
-- edge functions supply the conversation and the prompt frame.
--
-- Facts remain grounded: the answer prompt still requires documents for factual
-- claims. Only the MANNER is freed. GLOBAL.
-- ============================================================================

-- 1) Per-employee VOICE. Nullable: an employee without one behaves exactly as
--    before, so this changes nothing until a human writes one.
ALTER TABLE digital_employees ADD COLUMN IF NOT EXISTS voice text;
COMMENT ON COLUMN digital_employees.voice IS
  'How this employee should SOUND — tone, register, warmth, brevity. Injected into the answer prompt after identity. Facts are still grounded in documents; this governs manner only. NULL = house default.';

-- 2) How many prior turns the employee sees. Conversation memory is the single
--    biggest driver of natural conversation; it is also the main cost lever, so
--    it is configurable per employee rather than hardcoded.
ALTER TABLE digital_employees ADD COLUMN IF NOT EXISTS context_turns int NOT NULL DEFAULT 8;
COMMENT ON COLUMN digital_employees.context_turns IS
  'How many prior messages of the conversation the employee sees (default 8). 0 disables history and restores the previous single-turn behaviour.';

-- 3) The numeric 'sentiment' signal ALREADY exists in the catalog (mig 262:43,
--    number 0-100, "Detected frustration / negative sentiment") — it was designed
--    and registered, and simply never supplied by any caller. The edge functions
--    now feed it from the employee's own read, so existing rules built on it
--    start working with no rule changes.
--    Add only the missing companion: the categorical label, so a rule can say
--    "confused" (offer to rephrase) vs "angry" (get a human) rather than reducing
--    every feeling to one number.
INSERT INTO public.escalation_signals (tenant_id, key, label, value_type, applies_to, help, sort_order)
VALUES (null, 'sentiment_label', 'Customer mood', 'text', '{answer}',
        'How the person seems, read from the whole conversation: happy, neutral, confused, frustrated, angry. Pair with the numeric sentiment signal for intensity.', 31)
ON CONFLICT (tenant_id, key) DO NOTHING;

NOTIFY pgrst, 'reload schema';
