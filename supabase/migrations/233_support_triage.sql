-- 233_support_triage.sql
-- ============================================================================
-- Support hardening #2 — deterministic upfront classification / priority /
-- severity at intake.
--
-- Today a support conversation's priority is a manual/default field; there is
-- no content-driven triage taxonomy, and severity must NOT be decided by
-- customer emotion or the model's mood. This adds a DETERMINISTIC, config-driven
-- classifier that runs when the first customer message lands:
--
--   • support_triage_rules — a tenant-editable, precedence-ordered ruleset.
--     Highest-severity rules (safety/security/outage) evaluate first and win,
--     so a "data breach" is critical regardless of how calmly it is phrased,
--     and a furious "how do I export a CSV" stays low severity.
--   • classify_support_text() — a pure, deterministic function (literal keyword
--     match, no regex-injection risk, no LLM). "AI may assist interpretation,
--     but deterministic policy controls final severity."
--   • a trigger on the FIRST user message sets de_conversations.category,
--     severity and priority — resilient (never blocks a customer message) and
--     non-destructive (never overrides an already-set classification).
--
-- Industry-agnostic: the seeded rules are generic defaults; each tenant edits
-- its own categories/patterns. All SQL — no edge-function change, no new
-- runtime. Reuses the existing de_conversations lifecycle (mig 149). GLOBAL.
-- ============================================================================

-- 1. The classification target — additive columns on the conversation ---------
ALTER TABLE de_conversations
  ADD COLUMN IF NOT EXISTS category    text,   -- e.g. how_to | billing | outage | security …
  ADD COLUMN IF NOT EXISTS severity    text,   -- e.g. sev1 (critical) … sev4 (low)
  ADD COLUMN IF NOT EXISTS triaged_at  timestamptz;

-- 2. The ruleset — tenant-editable, precedence-ordered ------------------------
CREATE TABLE IF NOT EXISTS support_triage_rules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  rule_order    integer NOT NULL DEFAULT 100,   -- lower = evaluated first / wins
  name          text NOT NULL,
  match_pattern text,                            -- '|'-separated literal keywords; NULL = catch-all default
  set_category  text NOT NULL,
  set_priority  text NOT NULL DEFAULT 'normal'   -- must satisfy de_conversations priority check
                  CHECK (set_priority IN ('low','normal','high','urgent')),
  set_severity  text NOT NULL DEFAULT 'sev3',
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_triage_rules_tenant ON support_triage_rules(tenant_id, rule_order) WHERE active;
ALTER TABLE support_triage_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS support_triage_rules_tenant_read ON support_triage_rules;
CREATE POLICY support_triage_rules_tenant_read ON support_triage_rules
  FOR SELECT USING (tenant_id = public.auth_tenant_id());
DROP POLICY IF EXISTS support_triage_rules_admin_write ON support_triage_rules;
CREATE POLICY support_triage_rules_admin_write ON support_triage_rules
  FOR ALL USING (tenant_id = public.auth_tenant_id() AND public.auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin','tenant_manager']))
  WITH CHECK (tenant_id = public.auth_tenant_id() AND public.auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin','tenant_manager']));

-- 3. The classifier — deterministic, literal keyword match (no LLM, no regex) --
CREATE OR REPLACE FUNCTION public.classify_support_text(p_tenant_id uuid, p_text text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r support_triage_rules;
  v_low text := lower(coalesce(p_text, ''));
  frag text;
BEGIN
  FOR r IN
    SELECT * FROM support_triage_rules
    WHERE tenant_id = p_tenant_id AND active
    ORDER BY rule_order, created_at
  LOOP
    -- Catch-all rule (no pattern) applies immediately.
    IF r.match_pattern IS NULL OR btrim(r.match_pattern) = '' THEN
      RETURN jsonb_build_object('category', r.set_category, 'priority', r.set_priority, 'severity', r.set_severity, 'rule', r.name);
    END IF;
    -- First rule whose ANY literal keyword is present wins.
    FOREACH frag IN ARRAY string_to_array(r.match_pattern, '|') LOOP
      frag := lower(btrim(frag));
      IF frag <> '' AND position(frag IN v_low) > 0 THEN
        RETURN jsonb_build_object('category', r.set_category, 'priority', r.set_priority, 'severity', r.set_severity, 'rule', r.name);
      END IF;
    END LOOP;
  END LOOP;
  -- No rule matched and no catch-all configured — safe neutral default.
  RETURN jsonb_build_object('category','general','priority','normal','severity','sev3','rule','default');
END; $$;
REVOKE ALL ON FUNCTION public.classify_support_text(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.classify_support_text(uuid, text) TO authenticated, service_role;

-- 4. Apply at intake — trigger on the first user message ----------------------
-- Resilient (never blocks a customer message) and non-destructive (only sets a
-- classification that isn't already there).
CREATE OR REPLACE FUNCTION public.trg_triage_support_conversation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_conv de_conversations; v_first boolean; v_cls jsonb;
BEGIN
  IF coalesce(NEW.role,'') <> 'user' THEN RETURN NEW; END IF;
  BEGIN
    -- Only the FIRST user message triages the conversation.
    SELECT count(*) = 1 INTO v_first FROM de_messages
      WHERE conversation_id = NEW.conversation_id AND role = 'user';
    IF NOT v_first THEN RETURN NEW; END IF;

    SELECT * INTO v_conv FROM de_conversations WHERE id = NEW.conversation_id;
    IF v_conv.id IS NULL OR v_conv.category IS NOT NULL THEN RETURN NEW; END IF;  -- don't override

    v_cls := public.classify_support_text(v_conv.tenant_id, coalesce(v_conv.subject,'') || ' ' || coalesce(NEW.content,''));
    UPDATE de_conversations
       SET category   = v_cls->>'category',
           severity   = v_cls->>'severity',
           priority   = v_cls->>'priority',
           triaged_at = now()
     WHERE id = NEW.conversation_id AND category IS NULL;
  EXCEPTION WHEN OTHERS THEN
    -- Triage must never block a customer message landing.
    NULL;
  END;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_triage_support_conversation ON de_messages;
CREATE TRIGGER trg_triage_support_conversation
  AFTER INSERT ON de_messages
  FOR EACH ROW EXECUTE FUNCTION public.trg_triage_support_conversation();

-- 5. Seed generic, industry-agnostic default rules for every tenant -----------
-- Precedence: life-safety / security / legal / availability first (they win
-- over any emotional phrasing), then operational categories, then how-to, with
-- a neutral catch-all last. Tenants edit these freely.
INSERT INTO support_triage_rules (tenant_id, rule_order, name, match_pattern, set_category, set_priority, set_severity)
SELECT t.id, s.rule_order, s.name, s.match_pattern, s.set_category, s.set_priority, s.set_severity
FROM tenants t
CROSS JOIN (VALUES
  (10,  'Safety',          'injury|someone is hurt|unsafe|not safe|fire|smoke|gas leak|hazard|electric shock|danger', 'safety',          'urgent', 'sev1'),
  (20,  'Security',        'data breach|breach of|hacked|unauthorized access|security incident|leaked|phishing|malware|ransomware|compromised account', 'security', 'urgent', 'sev1'),
  (30,  'Legal/Regulatory','lawsuit|legal action|threaten to sue|gdpr|hipaa|regulator|compliance violation|subpoena|data protection', 'legal',    'high',   'sev2'),
  (40,  'Outage',          'outage|is down|system down|everything is broken|all users affected|cannot access at all|completely broken|nothing works|not working at all|major disruption', 'outage', 'high', 'sev2'),
  (50,  'Data loss',       'data loss|lost my data|deleted everything|missing records|records are gone|corrupted data', 'data', 'high', 'sev2'),
  (60,  'Billing',         'invoice|refund|overcharged|billing|payment failed|charged twice|double charged|credit note|wrong amount', 'billing', 'normal', 'sev3'),
  (70,  'Access',          'locked out|reset password|cannot log in|unable to log in|access denied|unlock my account|forgot password|mfa|two factor', 'access', 'normal', 'sev3'),
  (80,  'Complaint',       'complaint|unacceptable|terrible service|worst|extremely disappointed|want to escalate|speak to a manager|this is ridiculous', 'complaint', 'high', 'sev3'),
  (90,  'Feature request', 'feature request|would be great if|can you add|please add|it would be nice|suggestion for', 'feature_request', 'low', 'sev4'),
  (100, 'How-to',          'how do i|how to|how can i|where do i|where is|is it possible|walk me through|step by step|tutorial|guide', 'how_to', 'low', 'sev4'),
  (9999,'Default',         NULL, 'general', 'normal', 'sev3')
) AS s(rule_order, name, match_pattern, set_category, set_priority, set_severity)
WHERE NOT EXISTS (
  SELECT 1 FROM support_triage_rules e WHERE e.tenant_id = t.id AND e.name = s.name);
