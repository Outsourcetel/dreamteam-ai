-- 229_archetype_setup_questions.sql
-- ============================================================================
-- Renewals hire, Phase 1.2 — the AI-led tailoring discovery, defined on the ROLE.
--
-- When a tenant hires a role archetype, the employee should interview them to
-- tailor the setup to how THEIR business runs. Rather than hardcode a renewals
-- questionnaire in the UI, the questions live on the archetype — generic (every
-- role can carry its own), deterministic (works without live LLM credits), and
-- editable. The employee presents them; the answers become the input the AI
-- drafts tailored connectors / watchers / SOP / guardrails from (Phase 1.3).
--
-- Additive column + a seed for renewal_manager. GLOBAL.
-- ============================================================================

ALTER TABLE role_archetypes ADD COLUMN IF NOT EXISTS setup_questions jsonb;

-- Renewals tailoring interview — the few things that actually shape the job.
UPDATE role_archetypes SET setup_questions = jsonb_build_array(
  jsonb_build_object('key','systems_of_record','kind','text',
    'question','Where do your contracts, renewals and customer records live today?',
    'help','e.g. Salesforce, HubSpot, a CLM like DocuSign/Ironclad, or a spreadsheet'),
  jsonb_build_object('key','billing_system','kind','text',
    'question','Where is billing / invoicing handled?',
    'help','e.g. Zuora, Stripe, NetSuite, QuickBooks, or manual'),
  jsonb_build_object('key','party_scope','kind','choice',
    'question','Should this employee work customer renewals, vendor/supplier renewals, or both?',
    'options', jsonb_build_array('Customer (sell-side)','Vendor (buy-side)','Both')),
  jsonb_build_object('key','cadence','kind','text',
    'question','How far ahead should it start working a renewal, and what notice window applies?',
    'help','e.g. start at 90 days out; 60-day notice required before auto-renew'),
  jsonb_build_object('key','discount_authority','kind','text',
    'question','What discount (if any) can be offered without human approval, and who approves above that?',
    'help','e.g. up to 5% automatically; anything more needs Finance'),
  jsonb_build_object('key','approval_threshold','kind','text',
    'question','Above what deal value must a human approve any change?',
    'help','e.g. $25,000'),
  jsonb_build_object('key','at_risk_signals','kind','text',
    'question','What signals tell you a renewal is at risk?',
    'help','e.g. usage dropping, open support tickets, no reply to outreach')
) WHERE key = 'renewal_manager';
