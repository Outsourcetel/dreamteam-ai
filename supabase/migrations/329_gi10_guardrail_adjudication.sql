-- 329_gi10_guardrail_adjudication.sql
-- ============================================================================
-- GI-10 — ADJUDICATED REGEX HIT. Schema + flags. Additive and INERT on apply.
--
-- WHY THIS EXISTS. Migration 328 fixed a real matcher bug and freed 8 of 17
-- historical false positives. It does NOT fix the remaining class, and that was
-- verified rather than assumed: the certification-exam answer said a write-back
-- grant "doesn't skip approvals", and the phrase "skip approval" is inside it.
-- Word boundaries were tested and rejected (they would silently disable the live
-- clinical rule: \bdiagnos\b stops matching "diagnoses", "diagnosis" AND
-- "diagnose"). No pattern can separate DOING from DESCRIBING. Only meaning can.
--
-- WHAT IT ADDS. When the deterministic filter blocks a draft answer, a small
-- model is asked ONE narrow question: does this answer ENACT the prohibited act,
-- or DESCRIBE/DENY the control against it? Only an unambiguous "describes", at
-- high confidence, on a rule a human explicitly opted in, can release it — and
-- the release is permanently recorded before it happens.
--
-- THIS IS THE FIRST THING IN THE PLATFORM THAT CAN UN-BLOCK CONTENT. That is a
-- real and permanent change to the safety story and it is not argued away here.
-- What IS done: keep it small (internal chat only), opt-in one rule at a time,
-- record every release in the hash chain, and make every failure keep the block.
--
-- CUT after adversarial review — each one could have released something genuinely unsafe:
--   * MONEY ACTIONS. decide_action_execution RETURNS at the guardrail loop before
--     the amount threshold, spend caps and trust resolution run, returning
--     trust_level null. Clearing in the app layer would auto-execute a payment
--     with three gates never evaluated. Not fixable in TypeScript. OUT.
--   * THE PUBLIC WIDGET. Anonymous callers can shape a draft to fit the clear
--     criterion, which is published in this file. Internal chat only. OUT.
--   * COMPLIANCE-PACK RULES BY DEFAULT. HIPAA/TCPA/financial rules stay
--     non-clearable; making one clearable needs an owner, a 40-char written
--     justification, and the same escape hatch detach_compliance_pack uses.
--   * CLEARING KEYED TO A WHOLE RULE. A reviewer built a case releasing a real
--     PHI disclosure because the same answer also quoted the policy correctly.
--     The code masks the cleared phrase and re-screens the WHOLE answer against
--     ALL rules; anything still matching keeps the block.
--
-- INERTNESS (four tiers, all fail closed):
--   platform_config['guardrail_adjudication.enabled']  — NO ROW SEEDED = OFF
--   feature_registry['guardrail_adjudication']         — seeded FALSE
--   platform_config['guardrail_adjudication.mode']     — absent = 'shadow'
--   platform_config['guardrail_adjudication.kill']     — 'true' = hard off
--   guardrail_rule_adjudicable                         — EMPTY = no rule clearable
-- Five independent things must be true before a single block can be cleared.
-- This migration changes NO behaviour on apply. GLOBAL.
-- ============================================================================

-- ── A. Widen the audit category. MANDATORY, and it must land BEFORE any code. ──
-- audit_events.category is a CHECK constraint last set in mig 111 with exactly
-- 17 values. Without this, append_audit_event RAISES on every clear — and since
-- the release is gated on that write succeeding, the feature would simply never
-- clear anything. Reproduced from the LIVE constraint definition, adding one.
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_category_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_category_check CHECK (category = ANY (ARRAY[
  'resolved','escalated','approval','guardrail_check','guardrail_block','config_change',
  'playbook_step','invoice','connector_sync','connector_action','evidence_step',
  'access_control','knowledge_revision','inquiry_triage','action_execution','de_memory',
  'de_consultation',
  'guardrail_adjudication'   -- NEW (GI-10)
]));

DO $assert$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.audit_events'::regclass
       AND conname = 'audit_events_category_check'
       AND pg_get_constraintdef(oid) LIKE '%guardrail_adjudication%')
  THEN RAISE EXCEPTION '329: audit category widening did not apply'; END IF;
END $assert$;

-- ── B. Per-tenant staging flag, seeded FALSE ──
-- MUST exist and be false: is_feature_enabled_internal FAILS OPEN on an unknown
-- key (068:82-84). The adjudicator additionally reads the tables directly rather
-- than through that RPC, so a deleted row cannot enable it platform-wide.
INSERT INTO feature_registry (key, label, description, default_enabled, category)
VALUES ('guardrail_adjudication',
        'AI may clear a guardrail false match',
        'When the keyword filter blocks a draft answer, a small model decides whether the answer ENACTS the prohibited act or merely DESCRIBES the control against it. Only an explicit per-rule opt-in makes a rule clearable. Every release is permanently audited. Internal chat only; never money actions, never the public widget. Default OFF; fail-closed.',
        false, 'governance')
ON CONFLICT (key) DO NOTHING;

DO $assert$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM feature_registry WHERE key = 'guardrail_adjudication')
  THEN RAISE EXCEPTION '329: guardrail_adjudication feature_registry row missing after seed'; END IF;
END $assert$;

-- ── C. Per-rule opt-in. Deliberately its OWN table, not a column. ────────────
-- guardrail_rules is client-writable by tenant members (015/105), so ANY column
-- on it can be flipped by a raw PostgREST PATCH with no audit and no
-- justification — including nulling compliance_pack_key first to dodge the
-- compliance check. Permission therefore cannot live on that table.
CREATE TABLE IF NOT EXISTS guardrail_rule_adjudicable (
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  rule_id       uuid NOT NULL REFERENCES guardrail_rules(id) ON DELETE CASCADE,
  granted_by    uuid,
  granted_at    timestamptz NOT NULL DEFAULT now(),
  justification text NOT NULL CHECK (length(btrim(justification)) >= 40),
  PRIMARY KEY (tenant_id, rule_id)
);
ALTER TABLE guardrail_rule_adjudicable ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gra_tenant_read ON guardrail_rule_adjudicable;
CREATE POLICY gra_tenant_read ON guardrail_rule_adjudicable
  FOR SELECT USING (tenant_id = public.auth_tenant_id());
-- No INSERT/UPDATE/DELETE policy: set_rule_adjudicable is the ONLY write path,
-- enforced by RLS rather than by convention.
REVOKE INSERT, UPDATE, DELETE ON guardrail_rule_adjudicable FROM authenticated, anon;

-- ── D. The decision log. Every adjudication, both modes, before any clear. ───
CREATE TABLE IF NOT EXISTS guardrail_adjudications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  de_id           uuid,
  conversation_id uuid,
  surface         text NOT NULL,
  rule_id         uuid,
  rule_text       text,
  matched_text    text,
  pattern         text,
  assessment      text CHECK (assessment IN ('describes','enacts','unclear','error')),
  confidence      smallint,
  rationale       text,
  model           text,        -- the model that ACTUALLY served, never the constant
  provider        text,
  prompt_version  text,
  mode            text CHECK (mode IN ('shadow','enforce')),
  would_clear     boolean NOT NULL DEFAULT false,
  applied         boolean NOT NULL DEFAULT false,
  reason          text,
  truncated       boolean,
  cache_hit       boolean,
  duration_ms     int,
  input_tokens    int,
  output_tokens   int,
  metering_failed boolean,
  content_sha256  text,
  content_preview text,
  question_preview text,
  audit_event_id  uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE guardrail_adjudications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ga_tenant_read ON guardrail_adjudications;
CREATE POLICY ga_tenant_read ON guardrail_adjudications
  FOR SELECT USING (tenant_id = public.auth_tenant_id());
CREATE INDEX IF NOT EXISTS guardrail_adjudications_tenant_idx
  ON guardrail_adjudications (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS guardrail_adjudications_rule_idx
  ON guardrail_adjudications (tenant_id, rule_id, created_at DESC);

-- Immutability. Retention is REDACT, never DELETE: a blanket purge against an
-- immutability trigger would fail on every run forever. The decision skeleton
-- survives permanently; only the free-text previews age out.
CREATE OR REPLACE FUNCTION guardrail_adjudications_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'guardrail_adjudications is append-only: a machine overturning a compliance block is a permanent record';
  END IF;
  IF coalesce(current_setting('app.allow_adjudication_redact', true), '') <> 'on' THEN
    RAISE EXCEPTION 'guardrail_adjudications rows cannot be edited';
  END IF;
  -- Redaction may only null the four free-text columns; every decision field
  -- must be byte-identical.
  IF (NEW.id, NEW.tenant_id, NEW.de_id, NEW.conversation_id, NEW.surface, NEW.rule_id,
      NEW.assessment, NEW.confidence, NEW.model, NEW.provider, NEW.prompt_version,
      NEW.mode, NEW.would_clear, NEW.applied, NEW.reason, NEW.content_sha256,
      NEW.audit_event_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.de_id, OLD.conversation_id, OLD.surface, OLD.rule_id,
      OLD.assessment, OLD.confidence, OLD.model, OLD.provider, OLD.prompt_version,
      OLD.mode, OLD.would_clear, OLD.applied, OLD.reason, OLD.content_sha256,
      OLD.audit_event_id, OLD.created_at)
  THEN RAISE EXCEPTION 'guardrail_adjudications: only the text previews may be redacted'; END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS guardrail_adjudications_immutable_trg ON guardrail_adjudications;
CREATE TRIGGER guardrail_adjudications_immutable_trg
  BEFORE UPDATE OR DELETE ON guardrail_adjudications
  FOR EACH ROW EXECUTE FUNCTION guardrail_adjudications_immutable();

-- ── E. Verdict cache. surface/prompt_version/model are in the key NOW so a ───
-- later surface or a prompt edit can never inherit answer-surface verdicts.
CREATE TABLE IF NOT EXISTS guardrail_adjudication_cache (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  de_id            uuid NOT NULL,
  surface          text NOT NULL,
  rule_id          uuid NOT NULL,
  rule_updated_at  timestamptz NOT NULL,
  content_sha256   text NOT NULL,
  question_sha256  text NOT NULL,
  prompt_version   text NOT NULL,
  model            text NOT NULL,
  assessment       text NOT NULL CHECK (assessment IN ('describes','enacts')),
  confidence       smallint NOT NULL,
  rationale        text NOT NULL,
  provider         text,
  judged_at        timestamptz NOT NULL DEFAULT now(),
  source_log_id    uuid,
  expires_at       timestamptz NOT NULL,
  UNIQUE (tenant_id, de_id, surface, rule_id, rule_updated_at, content_sha256, question_sha256, prompt_version, model)
);
ALTER TABLE guardrail_adjudication_cache ENABLE ROW LEVEL SECURITY;
-- RLS on, no policies = service-role only (the adjudicator runs service-side).

-- ── F. The only write path for the opt-in. ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_rule_adjudicable(
  p_rule_id uuid, p_on boolean, p_justification text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_rule  guardrail_rules;
  v_actor text;
BEGIN
  SELECT * INTO v_rule FROM guardrail_rules WHERE id = p_rule_id;
  IF v_rule.id IS NULL THEN RAISE EXCEPTION 'guardrail rule not found'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles p
     WHERE p.user_id = auth.uid()
       AND (p.layer = 'platform'
            OR (p.tenant_id = v_rule.tenant_id AND p.role IN ('tenant_owner','tenant_admin'))))
  THEN RAISE EXCEPTION 'only workspace owners/admins can change what a machine may overrule'; END IF;

  IF v_rule.severity <> 'blocking' OR v_rule.rule_type NOT IN ('blocked_phrase','blocked_topic') THEN
    RAISE EXCEPTION 'only blocking phrase/topic rules can be adjudicated';
  END IF;

  IF p_on THEN
    IF p_justification IS NULL OR length(btrim(p_justification)) < 40 THEN
      RAISE EXCEPTION 'a written justification of at least 40 characters is required to let a machine overrule this rule';
    END IF;
    -- Compliance-pack rules are described by this product as un-toggleable.
    -- That promise now also covers "un-clearable": the same owner-only escape
    -- hatch detach_compliance_pack requires (160:108) applies here.
    IF v_rule.compliance_pack_key IS NOT NULL
       AND coalesce(current_setting('app.allow_compliance_change', true), '') <> 'on' THEN
      RAISE EXCEPTION 'rule "%" comes from the % compliance pack — making it machine-clearable is an explicit compliance decision and requires the owner override', v_rule.rule, v_rule.compliance_pack_key;
    END IF;

    INSERT INTO guardrail_rule_adjudicable (tenant_id, rule_id, granted_by, justification)
    VALUES (v_rule.tenant_id, p_rule_id, auth.uid(), btrim(p_justification))
    ON CONFLICT (tenant_id, rule_id) DO UPDATE
      SET justification = excluded.justification, granted_by = excluded.granted_by, granted_at = now();
  ELSE
    DELETE FROM guardrail_rule_adjudicable WHERE tenant_id = v_rule.tenant_id AND rule_id = p_rule_id;
  END IF;

  SELECT full_name INTO v_actor FROM profiles WHERE user_id = auth.uid();
  -- Same transaction as the row write: the grant and its record commit together.
  PERFORM append_audit_event_internal(
    v_rule.tenant_id, coalesce(v_actor, 'A workspace admin'), 'human',
    format('%s: guardrail rule "%s" %s machine-clearable',
           CASE WHEN p_on THEN 'GRANTED' ELSE 'REVOKED' END, v_rule.rule,
           CASE WHEN p_on THEN 'is now' ELSE 'is no longer' END),
    'guardrail_adjudication',
    jsonb_build_object('kind', CASE WHEN p_on THEN 'adjudicable_granted' ELSE 'adjudicable_revoked' END,
                       'rule_id', p_rule_id, 'rule', v_rule.rule, 'pattern', v_rule.pattern,
                       'compliance_pack_key', v_rule.compliance_pack_key,
                       'justification', btrim(coalesce(p_justification, '')))
  );
  RETURN jsonb_build_object('rule_id', p_rule_id, 'adjudicable', p_on);
END $fn$;

REVOKE ALL ON FUNCTION public.set_rule_adjudicable(uuid, boolean, text) FROM public;
GRANT EXECUTE ON FUNCTION public.set_rule_adjudicable(uuid, boolean, text) TO authenticated;

-- ── G. Retention: redact previews at 90 days, keep the decision forever. ────
CREATE OR REPLACE FUNCTION redact_old_adjudications()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $fn$
DECLARE v_n int;
BEGIN
  PERFORM set_config('app.allow_adjudication_redact', 'on', true);
  WITH upd AS (
    UPDATE guardrail_adjudications
       SET content_preview = NULL, question_preview = NULL, matched_text = NULL, rationale = NULL
     WHERE created_at < now() - interval '90 days'
       AND (content_preview IS NOT NULL OR question_preview IS NOT NULL
            OR matched_text IS NOT NULL OR rationale IS NOT NULL)
    RETURNING 1)
  SELECT count(*) INTO v_n FROM upd;
  DELETE FROM guardrail_adjudication_cache WHERE expires_at < now();
  RETURN v_n;
END $fn$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'adjudication-retention') THEN
    PERFORM cron.unschedule('adjudication-retention');
  END IF;
  PERFORM cron.schedule('adjudication-retention', '17 4 * * *', 'select redact_old_adjudications()');
END $$;

NOTIFY pgrst, 'reload schema';
