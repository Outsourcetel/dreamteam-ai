-- Wave 5 (cont.): Renewal, Billing & Invoicing, Accounting, Finance, BD,
-- and Onboarding DEs for Outsourcetel. Same proven pattern as the Growth
-- DE: a real digital employee + genuine best-practice grounding knowledge
-- (NOT fabricated business data), advisor-first, structured to scale to
-- execution. Finance/Accounting charters state plainly they give process
-- guidance, not licensed financial, tax or investment advice.
--
-- Idempotent: DEs and docs already present (by name/title) are skipped.

DO $$
DECLARE
  v_tenant uuid := (SELECT id FROM tenants WHERE slug = 'outsourcetel-hq');
  v_owner  uuid := (SELECT user_id FROM profiles WHERE tenant_id = v_tenant AND role = 'tenant_owner' AND coalesce(is_active,true) ORDER BY created_at LIMIT 1);
  r record;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'tenant not found'; END IF;

  -- ── The six DEs ─────────────────────────────────────────────
  FOR r IN
    SELECT * FROM (VALUES
      ('Renewal DE','Remy','Customer','Customer Success',
       'Advises on subscription and contract renewals — cadence, at-risk detection, and expansion.',
       'Renewal & Expansion Advisor',
       'Protect and grow recurring revenue by renewing more contracts on time and spotting risk early.',
       ARRAY['Plan the renewal cadence and outreach timing','Spot at-risk accounts from usage and engagement signals','Recommend expansion and upsell opportunities','Handle non-payment and lapse recovery politely']),
      ('Billing & Invoicing DE','Bailey','Customer','Finance Operations',
       'Advises on invoicing, payment terms, proration, dunning and billing disputes.',
       'Billing & Invoicing Advisor',
       'Get invoices out accurately and on time and collect payment with fewer disputes.',
       ARRAY['Generate and check invoices for accuracy','Set and explain payment terms and proration','Run a polite, effective dunning sequence','Resolve billing disputes fairly']),
      ('Accounting DE','Aria','Internal','Accounting',
       'Advises on bookkeeping, reconciliation, journal entries and the monthly close. Process guidance, not licensed accounting or tax advice.',
       'Accounting Process Advisor',
       'Keep the books accurate and the monthly close on schedule.',
       ARRAY['Guide bank and account reconciliation','Explain correct journal entries and coding','Run the month-end close checklist','Flag anomalies for a qualified accountant']),
      ('Finance DE','Fin','Internal','Finance',
       'Advises on budgeting, forecasting, cash flow and unit economics. Process and analysis guidance only — NOT licensed financial, tax or investment advice.',
       'FP&A Advisor',
       'Help the team plan, forecast and understand the numbers behind the business.',
       ARRAY['Build and review budgets and forecasts','Explain cash flow and runway','Analyse unit economics (LTV, CAC, payback, margins)','Interpret key financial ratios']),
      ('Business Development DE','Blair','Customer','Business Development',
       'Advises on partnerships and new-business development — pipeline, outreach, qualification and deal structure.',
       'Business Development Advisor',
       'Build a healthy partnership and new-business pipeline that converts.',
       ARRAY['Research and prioritise prospects and partners','Draft outreach that earns replies','Qualify opportunities (fit, need, timing, budget)','Advise on deal and partnership structure']),
      ('Onboarding DE','Onni','Customer','Customer Success',
       'Advises on customer onboarding — kickoff, time-to-value, adoption milestones and early health.',
       'Onboarding Advisor',
       'Get new customers to value fast so they stick and grow.',
       ARRAY['Design the kickoff and onboarding plan','Set time-to-value and adoption milestones','Spot early churn-risk signals','Advise handoffs from sales to success'])
    ) AS d(name, persona, category, dept, description, title, purpose, resp)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM digital_employees WHERE tenant_id=v_tenant AND name=r.name) THEN
      INSERT INTO digital_employees (
        tenant_id, name, persona_name, description, category, department,
        display_title, purpose_statement, responsibilities,
        lifecycle_status, status, trust_level, external_reply_mode, charter, created_by
      ) VALUES (
        v_tenant, r.name, r.persona, r.description, r.category, r.dept,
        r.title, r.purpose, r.resp,
        'active', 'active', 'supervised', 'draft',
        jsonb_build_object(
          'mission', 'Be a trustworthy advisor. Recommend, explain the why, and ground answers in real knowledge — never invent numbers about this business; ask for the data. You advise; you do not yet execute changes in external systems.',
          'scales_to_execution', 'When the relevant system (billing, accounting, CRM) is connected, the same advice can become a drafted action through the normal approval + guardrail path. Advisory only until then.'
        ),
        v_owner
      );
      RAISE NOTICE 'created %', r.name;
    END IF;
  END LOOP;

  -- ── Grounding knowledge (tenant-visible; retrieved by de-answer) ──
  INSERT INTO knowledge_docs (tenant_id, title, content, source, tags, visibility, is_current)
  SELECT v_tenant, d.title, d.content, 'upload', d.tags, 'tenant', true
  FROM (VALUES
    ('Renewals — cadence, risk and expansion',
     E'Renewals protect recurring revenue. The goal is to renew on time, catch risk early, and expand where there is value.\n\nCADENCE: Start the renewal conversation well before the term ends — 90 days out for annual contracts, more for large or multi-year deals. Confirm the renewal owner, review the account''s value delivered, and surface any open issues before they become reasons to churn. Send a clear renewal notice with terms; do not let auto-renew be the first the customer hears of it.\n\nAT-RISK SIGNALS: Declining usage or logins, an unresolved support escalation, a champion who left, missed business reviews, or repeated invoice disputes all predict churn. Score accounts on these signals and route at-risk ones to a human owner early, not at the deadline.\n\nEXPANSION: The best time to expand is when the customer is getting clear value. Look for teams or usage growing past their plan, adjacent needs your product covers, and multi-year commitments that trade a discount for retention. Lead with the outcome, not the SKU.\n\nRECOVERY: If a renewal lapses or a payment fails, respond quickly and politely — a friendly reminder, then a clear consequence and a path back. Most lapses are administrative, not decisions to leave.',
     ARRAY['renewal','retention','churn','expansion','recurring-revenue']),
    ('At-risk accounts and dunning',
     E'DUNNING (payment recovery): When a payment fails or an invoice goes unpaid, a structured, courteous sequence recovers most of it. Day 0: a friendly "your payment didn''t go through" note with a one-click fix. Day 3-5: a reminder. Day 7-14: a firmer notice naming the consequence (service pause) and a clear way to resolve. Keep tone helpful — most failures are expired cards, not refusals. Always make paying trivially easy.\n\nGRACE & PAUSE: Give a short grace period before restricting service, and warn before you do. An abrupt cut-off over an expired card destroys goodwill you spent years building.\n\nESCALATION: Route genuine disputes and large balances to a human. Never threaten, never mislead about consequences, and keep a record of every notice sent.',
     ARRAY['renewal','dunning','collections','payment','at-risk']),
    ('Invoicing basics — accuracy, terms and proration',
     E'An invoice is a request for payment that must be correct, clear, and easy to pay.\n\nACCURACY: Every invoice needs the right customer and billing contact, a unique invoice number, issue and due dates, an itemised list of what is billed with quantities and rates, tax handled correctly for the jurisdiction, the total, and how to pay. Errors cause disputes and delay payment — check before sending.\n\nPAYMENT TERMS: State terms plainly (e.g. Net 30 = due 30 days from the invoice date). Shorter terms and easy payment methods speed cash in. Offer the payment methods your customers actually use.\n\nPRORATION: When a customer starts, upgrades, or downgrades mid-cycle, bill only for the portion of the period they used at each level. Explain proration on the invoice so it does not look like an error — unexplained prorated lines are a top cause of disputes.\n\nDISPUTES: Acknowledge fast, investigate against the contract and usage record, and correct genuine errors with a credit note rather than an argument. A fair, quick resolution protects the relationship and future payment.',
     ARRAY['billing','invoicing','payment-terms','proration','disputes']),
    ('Bookkeeping and reconciliation',
     E'Bookkeeping records every transaction accurately so the business knows where it stands. This is process guidance; a qualified accountant owns sign-off.\n\nDOUBLE ENTRY: Every transaction affects at least two accounts and the books must balance (debits = credits). Record income when earned and expenses when incurred (accrual) or when cash moves (cash basis) — consistently, per your chosen method.\n\nCODING: Post each transaction to the correct account in the chart of accounts. Consistent coding is what makes reports meaningful; guessing categories produces useless statements.\n\nRECONCILIATION: Regularly match your recorded transactions against the bank and card statements. Every line should agree. Investigate differences — timing, missing entries, duplicates, or errors — and resolve them. Unreconciled books hide mistakes and fraud.\n\nMONTH-END CLOSE: Run a repeatable checklist — reconcile all accounts, record accruals and prepayments, review unusual balances, and lock the period. A disciplined close means the numbers can be trusted. Flag anomalies for a human accountant rather than adjusting silently.',
     ARRAY['accounting','bookkeeping','reconciliation','close','journal-entries']),
    ('Financial planning — forecasting, cash flow and unit economics',
     E'Financial planning turns goals into numbers and numbers into decisions. This is analysis and process guidance, not licensed financial or investment advice.\n\nBUDGET vs FORECAST: A budget is the plan set at the start of the period; a forecast is the updated expectation as reality unfolds. Compare actuals to both. Large variances are questions to investigate, not just numbers to report.\n\nCASH FLOW & RUNWAY: Profit is not cash. Track cash in and out and the timing between them. Runway = current cash / net monthly burn — it tells you how many months you have at the current rate. Watch it closely; most businesses fail from running out of cash, not from being unprofitable on paper.\n\nUNIT ECONOMICS: Understand the economics of one customer. LTV (lifetime value) should comfortably exceed CAC (cost to acquire). CAC payback = months to earn back acquisition cost. Gross margin shows how much of each dollar is left after delivering the product. Healthy unit economics are what let growth create value instead of destroying it.\n\nRATIOS: Use a few ratios in context — gross and net margin, current ratio (liquidity), and growth rate — to spot trends. A ratio is a prompt to ask why, not a verdict on its own.',
     ARRAY['finance','fpa','forecasting','cash-flow','unit-economics']),
    ('Business development — pipeline, outreach and qualification',
     E'Business development builds new revenue through prospects and partnerships. A healthy pipeline is built deliberately, not hoped for.\n\nTARGETING: Define who is a good fit before you reach out — the profile of customers and partners who get the most value and are realistic to win. A focused list beats a big list. Prioritise by fit, potential value, and how reachable they are.\n\nOUTREACH: Messages that earn replies are short, specific to the recipient, lead with a relevant reason to talk (not a pitch), and ask for one small next step. Personalise on something real. Follow up a few times with added value, then stop — persistence, not pestering.\n\nQUALIFICATION: Before investing time, check fit (do they match your ideal profile), need (is there a real problem you solve), timing (is now the moment), and authority/budget (can this person actually buy or partner). Disqualify fast so you spend time on real opportunities.\n\nDEAL & PARTNERSHIP STRUCTURE: Structure so both sides win and incentives align. Be clear on what each party gives and gets, how success is measured, and how either side exits. Vague partnerships quietly die; specific ones with owners and milestones deliver.',
     ARRAY['business-development','bd','pipeline','outreach','partnerships']),
    ('Customer onboarding — kickoff, time-to-value and adoption',
     E'Onboarding is where a new customer either reaches value and stays, or stalls and churns. The early weeks set the whole relationship.\n\nKICKOFF: Start with a clear plan — confirm the customer''s goal (the outcome they bought), the success criteria, the people involved on both sides, and the timeline. A good kickoff aligns expectations and creates momentum.\n\nTIME-TO-VALUE: The single most important onboarding metric is how quickly the customer reaches their first real outcome ("first value"). Design the onboarding to hit that milestone as fast as possible, then build on it. Every week of delay raises churn risk.\n\nADOPTION MILESTONES: Break the journey into concrete milestones (setup done, first key action, first result, team rolled out). Track each customer against them so you can see who is progressing and who is stuck.\n\nEARLY RISK: Silence, missed milestones, a single user instead of the team, or unmet setup steps are early churn signals. Reach out proactively — do not wait for a renewal to discover a customer never got started. Hand off cleanly from sales, carrying the context so the customer never has to repeat themselves.',
     ARRAY['onboarding','time-to-value','adoption','customer-success','activation'])
  ) AS d(title, content, tags)
  WHERE NOT EXISTS (
    SELECT 1 FROM knowledge_docs k WHERE k.tenant_id=v_tenant AND k.title=d.title AND k.is_current
  );

  RAISE NOTICE 'wave5 DEs + knowledge ensured';
END $$;

SELECT d.name, d.department FROM digital_employees d
 WHERE d.tenant_id=(SELECT id FROM tenants WHERE slug='outsourcetel-hq')
   AND d.name IN ('Renewal DE','Billing & Invoicing DE','Accounting DE','Finance DE','Business Development DE','Onboarding DE')
 ORDER BY d.name;
