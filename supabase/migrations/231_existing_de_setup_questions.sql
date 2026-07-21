-- 231_existing_de_setup_questions.sql
-- ============================================================================
-- Platform pass — make Create-with-AI's tailoring interview work for EVERY role.
--
-- Mig 229 gave renewal_manager its setup_questions; mig 230 gave the four new
-- roles theirs. This fills in the remaining five that already shipped
-- (cs_manager, sdr, billing_ar, accounting, fpa) so the AI-led hire interview
-- is consistent across all nine Digital Employees — no code change needed (the
-- wizard reads role_archetypes.setup_questions generically). GLOBAL.
-- ============================================================================

-- Customer Success
UPDATE role_archetypes SET setup_questions = jsonb_build_array(
  jsonb_build_object('key','systems_of_record','kind','text','question','Where do your customer, health and usage records live?','help','e.g. Salesforce, Gainsight, a product-analytics tool'),
  jsonb_build_object('key','segments','kind','text','question','Which accounts should this employee own?','help','e.g. all mid-market; or named strategic accounts by tier'),
  jsonb_build_object('key','health_signals','kind','text','question','What tells you an account is healthy or at risk?','help','e.g. usage trend, support tickets, exec engagement, NPS'),
  jsonb_build_object('key','outreach','kind','choice','question','Should customer outreach always be drafted for approval?','options', jsonb_build_array('Yes — always','Only for at-risk or executive contacts','No — routine check-ins can auto-send')),
  jsonb_build_object('key','escalation','kind','text','question','Who owns executive engagement and relationship recovery?','help','e.g. the account owner / CS lead'),
  jsonb_build_object('key','success_metrics','kind','text','question','What customer outcomes matter most?','help','e.g. adoption, retention, expansion signals')
) WHERE key = 'cs_manager';

-- SDR
UPDATE role_archetypes SET setup_questions = jsonb_build_array(
  jsonb_build_object('key','systems_of_record','kind','text','question','Where do your leads and opportunities live?','help','e.g. Salesforce, HubSpot'),
  jsonb_build_object('key','icp','kind','text','question','What is your ideal customer profile and qualification criteria?','help','e.g. company size, industry, title, intent signals'),
  jsonb_build_object('key','channels','kind','text','question','Which outreach channels should it draft for?','help','e.g. email, LinkedIn — always as drafts for approval'),
  jsonb_build_object('key','boundary','kind','text','question','Where is the line between SDR and BDR (if you have both)?','help','e.g. SDR works inbound + demo requests; BDR owns named outbound'),
  jsonb_build_object('key','approval_threshold','kind','text','question','Above what value must a human approve any commitment?','help','e.g. $25,000'),
  jsonb_build_object('key','qualification','kind','text','question','What makes a lead qualified and ready to hand off?','help','e.g. budget, authority, need, timing confirmed')
) WHERE key = 'sdr';

-- Billing & AR
UPDATE role_archetypes SET setup_questions = jsonb_build_array(
  jsonb_build_object('key','billing_system','kind','text','question','Where are invoices and billing handled?','help','e.g. Zuora, Stripe, NetSuite, QuickBooks'),
  jsonb_build_object('key','cadence','kind','text','question','What is your dunning / follow-up cadence for overdue invoices?','help','e.g. reminder at day 0, 7, 14, then escalate'),
  jsonb_build_object('key','credit_authority','kind','text','question','What credits or adjustments can be made without approval, and who approves above that?','help','e.g. up to $200 goodwill; more needs Finance'),
  jsonb_build_object('key','approval_threshold','kind','text','question','Above what amount must a human approve a billing action?','help','e.g. $10,000'),
  jsonb_build_object('key','disputes','kind','text','question','How should billing disputes be handled and escalated?','help','e.g. log, pause dunning, route to the account owner'),
  jsonb_build_object('key','contract_source','kind','text','question','Where do contract terms live for contract-to-bill checks?','help','e.g. the CRM, a CLM, or the agreement record')
) WHERE key = 'billing_ar';

-- Accounting
UPDATE role_archetypes SET setup_questions = jsonb_build_array(
  jsonb_build_object('key','ledger_system','kind','text','question','Where is your general ledger / accounting system?','help','e.g. NetSuite, QuickBooks, Xero, Sage'),
  jsonb_build_object('key','close_cadence','kind','text','question','What is your close schedule and its key deadlines?','help','e.g. 5-day monthly close; hard cutoff on business day 5'),
  jsonb_build_object('key','sod','kind','text','question','Who prepares, who approves, and who posts entries? (separation of duties)','help','e.g. this employee prepares; a human approves and posts high-value entries'),
  jsonb_build_object('key','approval_threshold','kind','text','question','Above what value must an entry get additional approval?','help','e.g. journals over $10,000'),
  jsonb_build_object('key','reconciliations','kind','text','question','Which accounts get reconciled, and how often?','help','e.g. bank, AR, AP — monthly'),
  jsonb_build_object('key','controls','kind','text','question','Which controls must never be bypassed?','help','e.g. period-close cutoff, supported journals only, no self-approval')
) WHERE key = 'accounting';

-- FP&A
UPDATE role_archetypes SET setup_questions = jsonb_build_array(
  jsonb_build_object('key','data_sources','kind','text','question','Where do your actuals, budget and forecast data live?','help','e.g. the GL, a planning tool, spreadsheets'),
  jsonb_build_object('key','planning_cadence','kind','text','question','What is your budget and forecast cycle?','help','e.g. annual budget; monthly rolling forecast'),
  jsonb_build_object('key','scenarios','kind','text','question','Which scenarios matter to you?','help','e.g. base / upside / downside; hiring plans'),
  jsonb_build_object('key','reporting','kind','text','question','Who receives management reporting, and how often?','help','e.g. monthly board pack; weekly cash flash'),
  jsonb_build_object('key','assumptions','kind','text','question','What are the key drivers and assumptions?','help','e.g. growth rate, churn, headcount, CAC'),
  jsonb_build_object('key','boundaries','kind','choice','question','Should FP&A be able to change accounting or billing records?','options', jsonb_build_array('No — read-only / analysis only (recommended)','Only through a controlled, approved workflow'))
) WHERE key = 'fpa';
