# Week 2: Support Agent Build Plan
**Weeks 3-8 in original roadmap, compressed into actual Week 2 execution**

**Status**: Ready to Begin  
**Timeline**: This week → 6 weeks to live deployment  
**Goal**: First Digital Employee autonomous on Outsourcetel's real support tickets  
**Owner**: CTO + Founder  
**Success Metric**: Support Agent achieving 65%+ FCR by Week 8 go-live

---

## Overview

Support Agent is the first proof point that the machinery works. It demonstrates:
- ✅ Knowledge-grounded decision making
- ✅ Confidence-based escalation
- ✅ Playbook execution at scale
- ✅ Audit trail completeness
- ✅ Measurable outcomes (FCR, CSAT, TTR)

**Critical Success Factor:** Real Outsourcetel tickets, real customers, real measurements. No demo data.

---

## Part 1: Foundational Decisions (This Week)

### 1.1 Support Agent Identity
**Decision Owner**: Founder  
**Timeline**: By EOD Monday

Define the following explicitly:

**Name & Persona:**
- [ ] Official name (e.g., "Support Specialist", "Sophie", "Support Agent")
- [ ] Role description (1-2 sentences visible to customers)
- [ ] Profile picture/avatar

**Scope of Responsibility:**
- [ ] Which ticket types can this DE handle? (all or specific categories?)
- [ ] Languages supported? (English only initially?)
- [ ] Hours of operation? (24/7 or business hours?)
- [ ] Geographic scope? (all customers or specific regions?)

**Authority & Limitations:**
- [ ] Can issue refunds? (if yes, up to what amount without approval?)
- [ ] Can commit to delivery dates? (answer: no, or "only with PM approval")
- [ ] Can create new customer records? (answer: no, read-only)
- [ ] Can schedule customer calls? (answer: no, escalate to human)

**Example Charter (fill in your values):**
```
Name: "Support Specialist"
Domain: Support
Persona: Empathetic, thorough, precise. Resolves customer issues via product knowledge. Escalates when uncertain or policy-sensitive.
Scope: All support ticket categories, all languages (English only for now), 24/7 operation
Authority: 
  - Can send responses (draft + human approval required)
  - Cannot issue refunds (escalate to Finance Lead)
  - Cannot commit delivery dates (escalate to PM)
  - Cannot create records (read-only access)
Escalation Routes:
  - Billing questions → Billing Specialist (once deployed)
  - Technical bugs → Technical Support DE (future)
  - Refund requests → Finance Lead (manager approval)
  - Policy questions → Support Lead (human specialist)
Model Routing: Haiku for FAQs, Sonnet for complex troubleshooting
Trust Level: Start at 2/5 (moderate autonomy), earn trust on accuracy
```

**Next Step:** Document this in `digital_employees.charter` field (existing schema, mig 098+)

---

### 1.2 Knowledge Corpus Scope
**Decision Owner**: Operations + Knowledge team  
**Timeline**: By EOD Monday

What knowledge will this DE have access to? Be specific:

**Knowledge Sources:**
- [ ] Internal Outsourcetel product documentation (Confluence/Notion URL?)
- [ ] FAQ pages (where are they? how are they organized?)
- [ ] Troubleshooting guides (by product? by issue type?)
- [ ] Customer communication templates (refund denial, escalation explanation, etc.)
- [ ] Known issues + workarounds (current version of this?)
- [ ] Customer-specific info (account details, billing status, SLA terms?)

**Knowledge Organization:**
- [ ] By product area? (e.g., "Billing", "Infrastructure", "Integration")
- [ ] By issue type? (e.g., "Performance", "Configuration", "Error")
- [ ] By urgency? (e.g., "Critical", "Standard", "FAQ")
- [ ] All of the above with cross-indexing?

**Knowledge Freshness & Accuracy:**
- [ ] When was each KB article last reviewed?
- [ ] Who authored it? (trust signal)
- [ ] Is it sourced from one system (Confluence) or multiple? (impacts sync)

**Example Knowledge Structure (fill in your values):**
```
Support Knowledge Corpus:
├── Product Overview (3 articles)
│   ├── What is Outsourcetel?
│   ├── Supported integrations
│   └── Pricing & plans
├── Getting Started (5 articles)
│   ├── Account setup
│   ├── First integration
│   └── Team management
├── Troubleshooting (8 articles)
│   ├── Sync failures
│   ├── Authentication errors
│   ├── Performance issues
│   └── ...
├── Billing & Support (3 articles)
│   ├── Refund policy
│   ├── Payment methods
│   └── SLA terms
└── Known Issues (2 articles)
    ├── Current bugs + workarounds
    └── Maintenance windows

Total: 20-30 articles, all reviewed in past 30 days
```

**Next Step:** Ingest all KB articles into `knowledge_docs` table with domain="Support" by end of Week 2

---

### 1.3 Escalation Routing
**Decision Owner**: Founder + Support Lead  
**Timeline**: By EOD Tuesday

Define exactly when Support Agent escalates to a human. Examples:

**Escalation Triggers (Topic-Based):**
- [ ] Billing questions → Finance Lead (can't handle money)
- [ ] Refund requests → Finance Lead (approval required)
- [ ] Feature requests → Product Manager (outside scope)
- [ ] Complaints about company/policy → Founder (sensitivity required)

**Escalation Triggers (Confidence-Based):**
- [ ] Confidence <50% → Human specialist (not sure)
- [ ] Multiple consecutive wrong answers → Support Lead (model error)
- [ ] Customer anger detected (NLP) → Human specialist (empathy required)

**Escalation Triggers (Authority-Based):**
- [ ] Customer requests callback → Support Lead (schedule human call)
- [ ] Unusual requests (data export, account closure) → Support Lead
- [ ] Disputes or complaints → Support Lead (needs judgment)

**SLA for Escalation Response:**
- [ ] Urgent escalations: respond within 4 hours
- [ ] Standard escalations: respond within 24 hours
- [ ] Notifications: send to Slack + email

**Example Escalation Rules (fill in your values):**
```
Support Agent Escalation Rules:
1. Topic-based:
   - If billing_question → escalate to Finance Lead
   - If refund_request → escalate to Finance Lead
   - If feature_request → escalate to PM
   - If complaint about company → escalate to Founder

2. Confidence-based:
   - If confidence < 50% → escalate to Support Lead
   - If error_count_24h > 3 → pause and escalate to Support Lead

3. Authority-based:
   - If customer_requests_callback → escalate to Support Lead
   - If data_export_request → escalate to Support Lead

4. SLA:
   - Urgent: 4 hours
   - Standard: 24 hours
   - Channel: Slack notification + email assignment
```

**Next Step:** Implement in `de_escalation_rules` table (mig 108), wire into playbook via decision gates

---

### 1.4 Playbook Structure
**Decision Owner**: CTO  
**Timeline**: By EOD Wednesday

Define the exact flow Support Agent follows to resolve a ticket.

**Example 6-Step Playbook (reference):**
```
Step 1: Receive Ticket
  - Extract ticket ID, customer name, category, urgency, sentiment
  - Retrieve customer account context (name, company, plan, history)
  - Decision: Is this a known issue? (pattern matching)

Step 2: Consult Knowledge Base
  - Query: "customer's problem + category" 
  - Retrieve top 3 matching KB articles with confidence scores
  - Rank by relevance + recency
  - Decision: Confidence >80%?

Step 3: High Confidence Branch (>80%)
  - Draft response using KB article context
  - Include: Problem statement + solution + expected result
  - Human review gate: Support Lead approves draft
  - Send response to customer

Step 4: Low Confidence Branch (<50%)
  - Escalate to Support Lead with context
  - Include: What we tried, why we're uncertain, KB articles we consulted
  - Support Lead drafts response + sends

Step 5: Medium Confidence Branch (50-80%)
  - Offer partial answer with escalation path
  - "This looks like X. Here's a workaround. If that doesn't work, we'll connect you with a specialist."
  - Send response + mark for 48hr follow-up (human-driven)

Step 6: Track Outcome Metrics
  - Log: resolution_type (autonomous vs human-supported)
  - Log: time_to_resolution
  - Send CSAT survey (post-resolution, 48hr)
  - Update customer satisfaction score
  - Update DE metrics dashboard
```

**Key Decisions:**
- [ ] How many knowledge articles to consult? (top 3? top 5?)
- [ ] What confidence threshold for autonomous response? (80%? 75%? 85%?)
- [ ] Does human approval happen before or after sending to customer? (BEFORE recommended)
- [ ] What's the follow-up cadence? (48hr check-in if no reply?)
- [ ] Track CSAT? (yes, via survey)

**Next Step:** Build playbook in Playbook Builder, test on historical tickets

---

## Part 2: Critical Path (Weeks 3-6)

### 2.1 Knowledge Ingestion

**Owner:** Knowledge + Operations team  
**Timeline**: Week 3  
**Blocker for:** Everything (DE can't answer without knowledge)

**Tasks:**
1. [ ] Collect all Outsourcetel support KB articles
   - From: Confluence, Notion, wiki, email archives, sales docs, etc.
   - Organize by category (Product, Billing, Integration, Technical)
   - Export: PDF, Markdown, or plain text (whatever source allows)

2. [ ] Clean and standardize
   - Remove outdated articles (>6 months old without review)
   - Add metadata: author, last_reviewed_date, accuracy_level, category
   - Verify technical accuracy (run through dev team if needed)

3. [ ] Ingest into knowledge_docs
   - Use Knowledge Ingestion page UI (built Week 1)
   - Or bulk RPC: `ingest_knowledge_batch(documents, domain='Support')`
   - Verify: every article appears in search results

4. [ ] Embedding & Indexing
   - Trigger embedding computation (mig 165: knowledge embedding RPC)
   - Verify: similarity search works (search "can't login" → finds login troubleshooting)
   - Spot-check: random 5 articles, verify embeddings make semantic sense

5. [ ] Spot-check Accuracy
   - Pick 5 random KB articles
   - Have support team verify: is this information correct and current?
   - Update: any outdated info before DE goes live

**Success Criteria:**
- [ ] 20-30 articles ingested (Support domain)
- [ ] All articles have metadata (author, last_reviewed, category)
- [ ] All articles embedded (similarity search works)
- [ ] 100% accuracy spot-check (5 articles verified)
- [ ] Searchable: DE can query "customer can't login" and get relevant results

---

### 2.2 Zendesk Connector Live Proof

**Owner:** Platform + Ops team  
**Timeline**: Week 3 (parallel with knowledge ingestion)  
**Blocker for:** Playbook testing

**Tasks:**
1. [ ] Connect Outsourcetel's real Zendesk account
   - Generate API key (Zendesk admin required)
   - Store in `connector_secrets` (encrypted, mig 087)
   - Test connection: list tickets API call succeeds

2. [ ] Sync historical tickets
   - Backfill past 90 days (enough for metrics + testing)
   - Query: `SELECT COUNT(*) FROM support_tickets` — should see 100s or 1000s
   - Verify: ticket fields match Zendesk schema (id, subject, description, customer_name, status, created_at, updated_at)

3. [ ] Test real ticket sync
   - Create test ticket in Zendesk
   - Wait 5 minutes
   - Verify: ticket appears in `support_tickets` table
   - Verify: no PII leakage (customer email not exposed in logs)

4. [ ] Test write path (optional for Week 3, required for go-live)
   - Can DE send response back to Zendesk?
   - Test: insert response into `support_ticket_responses` → verify appears in Zendesk ticket
   - Verify: customer sees response in Zendesk portal

5. [ ] Error handling
   - Test: Fake API key → verify graceful error (logged, no crash)
   - Test: Rate limit (force 429 response) → verify retry logic
   - Test: Network timeout → verify graceful degradation

**Success Criteria:**
- [ ] Real Zendesk account connected (no demo/test account)
- [ ] 90+ days of historical tickets synced
- [ ] New tickets sync within 5 minutes
- [ ] Responses write correctly (customer sees them)
- [ ] Errors logged + handled gracefully

---

### 2.3 Playbook Build & Testing

**Owner:** CTO + Operations team  
**Timeline**: Weeks 4-5  
**Blocker for:** Go-live testing

**Tasks:**
1. [ ] Implement Support Agent playbook
   - Use Playbook Builder (PB2.0, mig 165)
   - Create: 6-step flow (reference from 1.4 above)
   - Include: knowledge consultation, confidence gates, escalation branches

2. [ ] Wire knowledge consultation
   - Step 2: Call `consult_specialist` edge function with ticket context
   - Retrieve top N KB articles (N=3 recommended)
   - Score by relevance + recency

3. [ ] Implement confidence-based gates
   - Step 3: If KB relevance score >80% → autonomous response branch
   - Step 4: If score <50% → escalation branch
   - Step 5: If 50-80% → hybrid (answer + escalation option)

4. [ ] Test on historical tickets
   - Pick 100 historical support tickets (mix of resolved + escalated)
   - Run playbook against each ticket (simulation)
   - Measure: Does playbook routing match human specialist's routing?
   - Target: 85%+ agreement on routing decisions

5. [ ] Refine based on test results
   - If playbook over-escalates: lower confidence threshold
   - If playbook misses: add more knowledge articles or adjust keywords
   - Re-run simulation: measure improvement

**Success Criteria:**
- [ ] Playbook exists in Playbook Builder (published, not draft)
- [ ] All 6 steps implemented + tested
- [ ] 100% historical ticket coverage (can handle all ticket types)
- [ ] 85%+ agreement on routing decisions (vs human specialist)
- [ ] Confidence thresholds tuned (no false positives)

---

### 2.4 DE Charter & Configuration

**Owner:** CTO  
**Timeline**: Week 4 (parallel with playbook)  
**Blocker for:** Deployment

**Tasks:**
1. [ ] Create digital_employees record
   - Name: "Support Specialist" (or your chosen name)
   - Domain: "support"
   - Persona: (from 1.1 above)
   - Model routing: Haiku/Sonnet selection rules (mig 163)
   - Trust level: Start at 2/5

2. [ ] Configure escalation rules
   - Topic-based escalations (billing → Finance)
   - Confidence-based escalations (score <50% → human)
   - Authority-based escalations (refunds → manager)
   - Implement in `de_escalation_rules` table (mig 108)

3. [ ] Link playbook to DE
   - Wire Support Agent playbook to this DE
   - Set playbook as default for all support tickets
   - Verify: UI shows playbook correctly linked

4. [ ] Configure knowledge scope
   - Grant access to Support domain knowledge (all 20-30 articles)
   - Verify: DE can query knowledge base
   - Test: DE retrieves correct articles for sample queries

5. [ ] Wire guardrails
   - Never promise delivery dates (guardrail_rules)
   - Never issue refunds (guardrail_rules, mig 166)
   - Respect existing customer communication (don't repeat)
   - Implement: `check_guardrails_for_de()` SQL function (mig 166)

**Success Criteria:**
- [ ] DE record exists in digital_employees table
- [ ] Escalation rules configured (all 3 types)
- [ ] Playbook linked (UI confirms association)
- [ ] Knowledge scope granted (can query all 20-30 articles)
- [ ] Guardrails enforced (test: attempt to violate → blocked)

---

### 2.5 Measurement Infrastructure

**Owner:** Product + Analytics  
**Timeline**: Week 5 (parallel with playbook refinement)  
**Blocker for:** Go-live reporting

**Tasks:**
1. [ ] Set up real-time metrics tracking
   - FCR (First Contact Resolution): % of tickets not escalated
   - TTR (Time to Resolution): median hours from ticket creation to closure
   - Escalation Rate: % of tickets escalated to human
   - Quality Score: % of responses rated accurate by human QA
   - CSAT: Customer satisfaction from post-resolution survey (1-5 scale)

2. [ ] Wire metrics dashboard
   - Update Performance & Insights page (mig 147)
   - Add Support Agent specific metrics
   - Display: hourly/daily/weekly trends
   - Threshold alerts: FCR <60%? → flag for review

3. [ ] Implement CSAT collection
   - After ticket resolution: send survey ("How satisfied with response? 1-5")
   - Store in `csat_scores` table (mig 166)
   - Aggregate: weighted average, exclude non-responders

4. [ ] Audit trail completeness
   - Every ticket: decision_trace records every DE decision
   - Include: which KB articles consulted, confidence scores, why escalated
   - Verify: human support specialist can explain every DE decision

5. [ ] Baseline metrics
   - Historical data: last 6 months of human specialist performance
   - Baseline FCR: current human specialist FCR rate
   - Baseline CSAT: current customer satisfaction
   - Target: DE matches or exceeds baseline by Week 8

**Success Criteria:**
- [ ] All 5 Delivery Excellence Metrics tracked
- [ ] Dashboard updates hourly
- [ ] CSAT survey works (sent post-resolution)
- [ ] Audit trail complete (every decision logged)
- [ ] Baselines established (know what we're measuring against)

---

## Part 3: Go-Live Preparation (Weeks 6-8)

### 3.1 Pilot Deployment (Week 6)

**Owner:** Ops + CTO  
**Deployment Strategy**: Gradual ramp (10% → 50% → 100%)

**Week 6: 10% Volume**
- [ ] Route 10% of incoming support tickets to Support Agent
- [ ] 90% still routed to human specialists
- [ ] Humans review every DE response (pre-send approval)
- [ ] No customer knows this is an AI (internal testing phase)
- [ ] Measure: any errors? false escalations? odd behaviors?

**Tasks:**
- [ ] Set up ticket routing logic (conditional dispatch)
- [ ] Configure human approval gate (all responses require human thumbs-up)
- [ ] Monitor: error logs, metrics dashboard, escalation rate
- [ ] Daily standup: review 10-20 sample responses, adjust if needed

**Success Criteria:**
- [ ] 0 policy violations (guardrails held 100%)
- [ ] <20% false escalations (doesn't escalate when unnecessary)
- [ ] >80% responses approved by human without changes
- [ ] 0 security issues (no credentials logged, no PII leaked)

---

### 3.2 Gradual Ramp (Weeks 7-8)

**Week 7: 50% Volume**
- [ ] Remove pre-send approval gate (DE can send directly)
- [ ] Keep post-send monitoring (humans can edit responses)
- [ ] Route 50% of tickets to DE, 50% to human specialist
- [ ] Measure: FCR, CSAT, quality score, escalation rate vs baseline

**Week 8: 100% Volume (Go-Live)**
- [ ] Route all support tickets to DE
- [ ] Humans monitor for exceptions + escalations
- [ ] Human support specialist available for escalations
- [ ] Go/No-Go checkpoint: metrics meet targets?

**Tasks (Both Weeks):**
- [ ] Daily monitoring: metrics dashboard, error logs, customer feedback
- [ ] Weekly metrics review: share with Founder + Support Lead
- [ ] Incident response: if FCR drops below 60%, pause expansion
- [ ] Knowledge refinement: add articles for common knowledge gaps

---

### 3.3 Success Criteria (Go-Live Checkpoint)

**By Week 8 EOD, Support Agent must achieve:**

| Metric | Target | How Measured |
|--------|--------|--------------|
| FCR (First Contact Resolution) | 65%+ | % tickets not escalated |
| CSAT (Customer Satisfaction) | 4.2+/5.0 | Post-resolution survey |
| TTR (Time to Resolution) | <4h median | support_tickets.resolved_at |
| Escalation Rate | <25% | % escalations |
| Quality Score | 90%+ | Human QA sampling |
| Policy Compliance | 100% | Zero guardrail violations |
| Audit Trail | 100% | Every decision traced |
| Uptime | 99.9%+ | Service availability |

**If ANY metric misses target:**
- [ ] Root cause analysis (what went wrong?)
- [ ] Refinement plan (how to fix it?)
- [ ] Revised timeline (push go-live? or fix + retry?)
- [ ] Founder decision: proceed to Billing Specialist, or iterate on Support?

---

## Part 4: Integration Checklist

### Backend Requirements (must exist before go-live)

| Component | Status | Owner | Deadline |
|-----------|--------|-------|----------|
| `list_connector_health` RPC | ✅ Built Week 1 | Platform | Week 1 ✓ |
| `get/set_de_escalation_config` RPC | ⏳ Pending | Platform | This week |
| `clone_playbook_template` RPC | ⏳ Pending | Platform | This week |
| Zendesk connector live | ⏳ Pending | Platform | Week 3 |
| Support knowledge ingestion | ⏳ Pending | Knowledge | Week 3 |
| Performance metrics computation | ⏳ Pending | Analytics | Week 5 |
| CSAT survey collection | ⏳ Pending | Product | Week 5 |
| Audit trail (decision_trace) | ✅ Exists | Core | ✓ |
| Guardrail enforcement | ✅ Exists (mig 166) | Core | ✓ |

### Frontend Components (built in Week 1, need integration)

| Component | Status | Where Used | Deadline |
|-----------|--------|-----------|----------|
| ConnectorStatusDashboard | ✅ Built | LiveConnectorsPage | This week |
| EscalationConfiguration | ✅ Built | WorkforceDEsPage | This week |
| PlaybookTemplateLibrary | ✅ Built | PlaybooksPage | This week |
| Performance metrics display | ⏳ Pending | PerformancePage | Week 5 |
| Audit trail viewer | ✅ Exists | WorkforceDEsPage | ✓ |

---

## Weekly Breakdown

### Week 2 (This Week): Foundational Decisions + Setup

**Monday:**
- [ ] Define Support Agent identity + charter (Founder + CTO)
- [ ] Document knowledge scope (Operations)
- [ ] Document escalation rules (Founder + Support Lead)

**Tuesday-Wednesday:**
- [ ] Define playbook structure (CTO)
- [ ] Begin knowledge collection (Knowledge team)
- [ ] Begin Zendesk connection setup (Platform)

**Thursday-Friday:**
- [ ] Finalize all decisions (documented + reviewed)
- [ ] Start knowledge ingestion (Knowledge team)
- [ ] Start Zendesk sync testing (Platform)

**Done By EOW:**
- ✅ Support Agent charter documented + approved
- ✅ Playbook structure defined
- ✅ Escalation rules finalized
- ✅ Knowledge collection started
- ✅ Zendesk live proof begun

---

### Week 3-4: Build Phase

- Knowledge ingestion complete (20-30 articles)
- Zendesk connector live (real tickets syncing)
- Playbook fully implemented (6 steps, all branches)
- DE charter configured (identity, escalation, guardrails)

---

### Week 5: Testing & Refinement

- Playbook tested on 100 historical tickets (85%+ routing accuracy)
- Metrics infrastructure wired (dashboard ready)
- CSAT survey configured
- Guardrails tested (attempt to violate → blocked)

---

### Week 6: Pilot (10% Volume)

- 10% of support tickets routed to Support Agent
- All responses pre-approved by human specialist
- Metrics tracked (0 violations, <20% false escalations expected)
- Daily monitoring + refinement

---

### Week 7: Ramp (50% Volume)

- 50% of support tickets autonomous (no pre-approval)
- 50% still human-routed (parallel comparison)
- Metrics measured: FCR, CSAT, TTR vs baseline
- Daily + weekly reporting

---

### Week 8: Go-Live (100% Volume) + Checkpoint

- 100% of support tickets routed to DE
- Metrics dashboard published
- Go/No-Go decision: proceed to Billing Specialist?

---

## Success Criteria Summary

**For Week 2 to be considered complete:**
- ✅ Support Agent identity defined + approved
- ✅ Knowledge scope documented (20-30 articles identified)
- ✅ Escalation rules finalized
- ✅ Playbook structure designed
- ✅ Zendesk connector live (real tickets syncing)
- ✅ Knowledge ingestion begun
- ✅ Charter documented + ready for DE configuration

**For Week 8 go-live checkpoint:**
- ✅ FCR 65%+ (autonomous resolution rate)
- ✅ CSAT 4.2+/5.0 (customer satisfaction)
- ✅ TTR <4h median
- ✅ Escalation rate <25%
- ✅ Quality score 90%+
- ✅ 100% policy compliance (zero guardrail violations)
- ✅ 100% audit trail completeness
- ✅ Founder decision: Go or No-Go to Billing Specialist

---

## Decision: What Needs Founder Input This Week?

| Decision | Options | Recommendation | Timeline |
|----------|---------|-----------------|----------|
| **Support Agent Name** | "Support Specialist", "Sophie", "Support Agent", other | TBD | EOD Monday |
| **Can issue refunds?** | Yes (up to $X), No | No (escalate to Finance) | EOD Monday |
| **Can commit delivery dates?** | Yes (if sourced from PM), No | No (escalate to PM) | EOD Monday |
| **Knowledge source** | Confluence? Notion? Wiki? Email? | TBD (check where Outsourcetel's KB lives) | EOD Tuesday |
| **Primary escalation path** | To Support Lead? To Founder? Hybrid? | Support Lead for most, Founder for refunds | EOD Tuesday |
| **Playbook pre-approval gate** | Yes (all responses human-approved first), No (direct send) | Yes for Weeks 6-7, No from Week 8 | EOD Wednesday |
| **FCR target by Week 8** | 60%? 65%? 70%? | 65% (industry standard for support) | EOD Wednesday |

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Knowledge quality too low | DE gives wrong answers | Spot-check 5 articles, verify accuracy, update before go-live |
| Zendesk connector unreliable | Missed tickets, sync gaps | Test with real data, implement retry logic, monitor errors |
| Playbook over-escalates | No FCR gain, humans overwhelmed | Lower confidence threshold, add more KB articles, re-test |
| Playbook under-escalates | Angry customers, brand damage | Conservative thresholds initially, escalate >80% uncertainty |
| Metric infrastructure broken | Can't measure success | Build dashboards in parallel, dry-run with historical data |
| Customer backlash (finds out AI) | Trust erosion | Be transparent: "Your response was reviewed by our AI-assisted support team" |
| Guardrails fail silently | Policy violation, regulatory issue | Test: intentionally try to violate, verify block |

---

## Handoff to Week 3

When Week 3 begins (Monday), the project should have:
- ✅ Support Agent fully defined (name, scope, authority, guardrails)
- ✅ Playbook designed + ready to implement
- ✅ Knowledge scope identified (20-30 articles for ingestion)
- ✅ Escalation rules finalized
- ✅ Zendesk connector setup begun (credentials stored, first sync attempted)
- ✅ All decisions documented + approved

With these in place, Week 3 can immediately begin implementation without blocking decisions.

---

## Next Decision Point

**Founder Checkpoint (EOD Week 2):**
- [ ] All foundational decisions made?
- [ ] Zendesk connector live + syncing real data?
- [ ] Knowledge collection underway?
- [ ] Ready to build playbook in Week 3?

**Approval:** Founder confirms readiness to proceed to Week 3 implementation.

---

**Week 2 Status:** Ready to Begin ✓  
**Next Action:** Founder decisions (Support Agent identity, escalation paths, guardrails)  
**Timeline to Go-Live:** 6 weeks (Weeks 3-8)
