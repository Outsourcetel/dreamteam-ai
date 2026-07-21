-- 232_support_role_kit.sql
-- ============================================================================
-- Bring the FLAGSHIP support_agent onto the role-kit machinery it predates.
--
-- support_agent (mig 162) is the original hardcoded archetype — it shipped
-- before the generic Role Kit (mig 218: sop_playbook/watcher_templates/
-- guardrail_templates), the Connected Systems desk (mig 221: system_templates),
-- and the Create-with-AI tailoring interview (mig 229/231: setup_questions).
-- Every role added AFTER it got those; Support did not. So the one role the
-- Support "Create with AI" prompt centers on is the ONLY major role that could
-- not be hired through the generic flow with a real kit.
--
-- This fills that in — same pattern as 218/221/231, targeting support_agent.
-- No new machinery, no frontend: the hire wizard reads role_archetypes +
-- setup_questions generically, so Support becomes Create-with-AI-hireable with
-- a real SOP, guardrails, system binding and tailoring interview on apply.
--
-- Preserves the base archetype (persona, capabilities, connector categories,
-- eval_category='support', golden path) — only the kit columns are set. The
-- live grounded answer path (de-answer / widget-ask / escalation / reply-mode)
-- is UNCHANGED. GLOBAL.
-- ============================================================================

UPDATE role_archetypes SET
  sop_playbook = jsonb_build_object(
    'name','Support Resolution SOP',
    'description','Standard operating procedure for a digital support specialist — from intake through grounded resolution or a clean human handoff.',
    'steps', jsonb_build_array(
      jsonb_build_object('key','instruction','label','Understand the request and who is asking','params',jsonb_build_object('body_md','Read what the customer actually wants and how urgent it is. Identify who is contacting you and which account they belong to. Do NOT reveal account-sensitive information before the required identity check is complete. If several unrelated issues are combined, separate them while keeping the conversation context.')),
      jsonb_build_object('key','instruction','label','Gather only the context you need','params',jsonb_build_object('body_md','Pull the relevant account, product, entitlement and prior-case context from permitted systems — only what this case needs, not everything. Check for a known incident or a prior resolution before diagnosing from scratch.')),
      jsonb_build_object('key','checklist','label','Find a grounded answer','params',jsonb_build_object('items', jsonb_build_array('Answer only from approved, current knowledge — never invent a resolution or a timeline','Cite the source; do not present an outdated fix for an incompatible product version','Treat unverified past case comments as leads, not authoritative knowledge','If confidence is low or the knowledge is missing, do not guess — escalate'))),
      jsonb_build_object('key','instruction','label','Resolve, guide, or act within your authority','params',jsonb_build_object('body_md','Explain the resolution or guide the customer through it. You may create and update cases, request information, set status, and prepare replies — but any action that changes customer data, money, access, or makes a commitment goes through approval. Never promise a refund, credit, deadline or fix you are not authorised to commit.')),
      jsonb_build_object('key','instruction','label','Escalate with a complete handoff','params',jsonb_build_object('body_md','Escalate on low confidence, repeated failure, frustration, a customer request for a human, a security/safety/legal/regulatory signal, a major account, or SLA risk. Hand off the FULL context — identity, account, issue, impact, what you checked, what you did, likely cause, remaining uncertainty and the recommended next step — so the human never has to make the customer repeat themselves.')),
      jsonb_build_object('key','instruction','label','Close the loop honestly','params',jsonb_build_object('body_md','Confirm the outcome with the customer, keep the record current, and if a question had no approved answer, flag it as a knowledge gap. Never falsely close a case to protect a metric — a correct escalation is a better outcome than a wrong autonomous answer.'))
    )),
  watcher_templates = jsonb_build_array(
    jsonb_build_object('kind','inbox','label','New support conversation','description','Support work arrives by itself — a new conversation/ticket lands via a connected channel (widget, email, portal, helpdesk). Registered here so the book of work is complete in one place; intake is served by the proactive poller.','config',jsonb_build_object('source','de_conversations'))),
  guardrail_templates = jsonb_build_array(
    jsonb_build_object('rule','No financial or contractual commitments in writing','rule_type','blocked_phrase','pattern','refund you|issue a credit|waive the|compensation|we guarantee|we promise|will be fixed by|resolved by tomorrow|deadline of|discount of','severity','blocking'),
    jsonb_build_object('rule','Customer-impacting financial actions over $500 require human approval','rule_type','require_approval_over_cents','threshold','50000','severity','blocking'),
    jsonb_build_object('rule','Do not handle legal, security, safety or regulatory matters — escalate','rule_type','blocked_topic','pattern','legal threat|lawsuit|sue |security incident|data breach|privacy breach|safety risk|regulatory|compliance violation','severity','blocking'),
    jsonb_build_object('rule','Escalate on strong frustration or churn language','rule_type','frustration_signal','pattern','unacceptable|cancel my account|speak to a manager|this is ridiculous|furious|worst service|escalate this','severity','warning')),
  system_templates = jsonb_build_array(
    jsonb_build_object('system_key','helpdesk','label','Help desk / ticketing','binding_kind','connector','can_read',true,'can_write',false,'can_verify',true)),
  setup_questions = jsonb_build_array(
    jsonb_build_object('key','support_scope','kind','text','question','What do you support — which products, services or systems?','help','e.g. our workforce-management software; or our commercial HVAC equipment'),
    jsonb_build_object('key','audience','kind','choice','question','Is this customer-facing support or an internal help desk?','options', jsonb_build_array('Customer-facing','Internal (employees)','Both')),
    jsonb_build_object('key','channels','kind','text','question','Which channels do customers use to reach support?','help','e.g. email, chat widget, phone, portal'),
    jsonb_build_object('key','systems','kind','text','question','Which systems should it read and work in?','help','e.g. Zendesk/Freshdesk help desk, Salesforce CRM, your knowledge base'),
    jsonb_build_object('key','identity','kind','text','question','What identity or entitlement check is required before sharing account details or acting?','help','e.g. verify email on file + account match; check active support plan'),
    jsonb_build_object('key','actions','kind','text','question','What actions may it take on its own, and what must a human approve?','help','e.g. answer, create/update cases, request info autonomously; any data change, refund, or access reset needs approval'),
    jsonb_build_object('key','escalation','kind','text','question','When should it hand off to a human, and to whom?','help','e.g. anything security/safety/legal, angry customers, or high-value accounts → the support lead'),
    jsonb_build_object('key','tone','kind','text','question','What tone and languages should it use?','help','e.g. warm and concise; English + Spanish; never over-apologise or overpromise'))
WHERE key = 'support_agent';
