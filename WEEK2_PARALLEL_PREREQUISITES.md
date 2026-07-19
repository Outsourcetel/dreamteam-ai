# Week 2: Parallel Prerequisites Execution Plan
**While waiting for founder decisions, execute these 5 work streams in parallel**

**Status**: STARTING NOW  
**Deadline**: EOW Week 2  
**Owner**: CTO  
**Benefit**: 4 of 6 prerequisites will be ready when founder decisions arrive

---

## Stream 1: Support Knowledge Audit & Structure Design

### Task 1.1: Locate Outsourcetel's Support KB
**Owner:** Knowledge team + Founder input needed  
**Time:** 2-4 hours  
**Output:** Document KB locations

**Steps:**
- [ ] Where is support documentation currently stored?
  - [ ] Confluence? (URL + space name)
  - [ ] Notion? (workspace + database)
  - [ ] Wiki? (site URL)
  - [ ] Scattered across emails/Slack?
  - [ ] Google Docs?
- [ ] Who owns each section? (contact for validation)
- [ ] How organized? (by product? by issue type? by audience?)

**Output Document**: Create `KB_AUDIT.md`
```markdown
# Outsourcetel Support KB Audit

## Knowledge Sources
1. Confluence
   - Space: [NAME]
   - URL: [URL]
   - Contents: [list pages/categories]
   - Owner: [NAME]
   - Last updated: [DATE]

2. Notion
   - Workspace: [NAME]
   - Database: [NAME]
   - URL: [URL]
   - Contents: [description]
   - Owner: [NAME]

3. Other sources
   - Google Docs: [links]
   - Zendesk Help Center articles: [count/link]
   - Email archives: [location]

## Organization Scheme
Current structure: [describe]
Recommended restructure: [suggest]

## Freshness
- Last audit: [DATE]
- Outdated articles (>6 months): [count/list]
- Missing topics: [list]
```

**Start:** Immediately (ask founder via email/Slack)

---

### Task 1.2: Design Knowledge Corpus Structure

**Time:** 4-6 hours  
**Output:** SQL migration for knowledge organization

**Steps:**
- [ ] Design ticket category taxonomy
  - Example categories: Product, Billing, Integration, Technical, Account
  - How granular? (5 top-level? 20 detailed?)
- [ ] Map KB articles to categories
- [ ] Design topic hierarchy (e.g., Product → Feature → Troubleshooting)
- [ ] Plan for cross-linking (one article can be in multiple categories)

**Design Document**: Create `KNOWLEDGE_SCHEMA.md`
```markdown
# Support Knowledge Schema Design

## Ticket Categories (Zendesk mappings)
- [ ] Category: PRODUCT
  - Subcategories: Feature Overview, Getting Started, Troubleshooting
  - Sample articles: [list]
  
- [ ] Category: BILLING
  - Subcategories: Pricing, Payment Methods, Refunds, Invoicing
  - Sample articles: [list]

- [ ] Category: INTEGRATION
  - Subcategories: Setup, Configuration, Troubleshooting, Errors
  - Sample articles: [list]

- [ ] Category: ACCOUNT
  - Subcategories: Login, Teams, Permissions, Security
  - Sample articles: [list]

- [ ] Category: TECHNICAL
  - Subcategories: API, Webhooks, Debugging, Performance
  - Sample articles: [list]

## Knowledge Article Template
Title: [clear, specific]
Category: [PRODUCT|BILLING|INTEGRATION|ACCOUNT|TECHNICAL]
Subcategory: [specific subtopic]
Last Reviewed: [DATE]
Reviewed By: [NAME]
Accuracy: [100%|95%|90%] (expert assessment)
Keywords: [comma-separated, for search]
Content: [plain text, <500 words ideal]
Related Articles: [list of cross-links]

## Searchability
Query types we need to handle:
- "customer can't login" → ACCOUNT/Login articles
- "invoice not received" → BILLING/Invoicing articles
- "API rate limit" → TECHNICAL/API articles
- "refund policy" → BILLING/Refunds articles

Search will use embeddings (mig 165) + keyword matching.
```

**Start:** Immediately (independent of founder decisions)

---

## Stream 2: Zendesk API Connection Testing

### Task 2.1: Zendesk Credentials Setup & Testing

**Owner:** Platform team + Founder  
**Time:** 2-3 hours  
**Output:** Working Zendesk API connection, credentials stored

**Prerequisites:**
- Founder provides Zendesk admin credentials (email + API token)
- Zendesk account must have "Outsourcetel" in the name (for verification)

**Steps:**
1. [ ] Founder generates Zendesk API token
   - In Zendesk: Admin Center → Apps and integrations → APIs → Zendesk API → enable Token access → Add API token
   - Copy token

2. [ ] Store credentials (encrypted)
   ```sql
   SELECT set_connector_secret(
     p_connector_id := (SELECT id FROM connectors WHERE provider='zendesk' LIMIT 1),
     p_secret_key := 'api_token',
     p_secret_value := '[TOKEN FROM STEP 1]'
   );
   ```

3. [ ] Test API connection
   ```bash
   curl -H "Authorization: Bearer [TOKEN]" \
     https://outsourcetel.zendesk.com/api/v2/tickets.json?per_page=1
   ```
   - Expected: 200 OK + JSON with ticket list
   - If fails: check token, email, permissions

4. [ ] Test read: can we fetch tickets?
   - Query: GET /api/v2/tickets.json?sort_by=created_at&order=desc
   - Verify: returns 100+ tickets (or whatever volume Outsourcetel has)
   - Extract: ticket IDs, subjects, customer names, status

5. [ ] Test write: can we send responses?
   - Query: POST /api/v2/tickets/{id}/comments
   - Body: {"comment": {"body": "Test response from DreamTeam"}}
   - Verify: response appears in Zendesk ticket

6. [ ] Error handling test
   - Provide wrong token → verify error caught
   - Rate limit test → verify retry logic would work

**Output**: `ZENDESK_CONNECTION_TEST.md`
```markdown
# Zendesk Connection Verification

✓ API token generated: [date]
✓ Token stored in connector_secrets: [confirmed]
✓ Read test (fetch tickets): [PASSED|FAILED] — [count] tickets returned
✓ Write test (send response): [PASSED|FAILED] — comment posted to ticket [ID]
✓ Error handling: [PASSED|FAILED] — wrong token correctly rejected

## Live Data Summary
- Total tickets in Outsourcetel account: [count]
- Date range: [oldest] to [newest]
- Ticket status breakdown:
  - New: [count]
  - Open: [count]
  - Pending: [count]
  - Solved: [count]
  - Closed: [count]

## Sample Tickets (for testing)
[List 5-10 representative ticket IDs for later playbook testing]

## Next Steps
- Ready to sync historical data? YES / NO
- Ready to route live tickets to DE? YES / NO
```

**Start:** Immediately (ask founder for API token)

---

### Task 2.2: Historical Ticket Backfill & Schema Validation

**Owner:** Platform team  
**Time:** 4-6 hours  
**Output:** 90+ days of tickets in `de_conversations` table

**Steps:**
1. [ ] Sync historical tickets (past 90 days)
   ```sql
   SELECT poll_support_inbox(
     p_connector_id := (SELECT id FROM connectors WHERE provider='zendesk'),
     p_date_from := NOW() - INTERVAL '90 days'
   );
   ```

2. [ ] Verify sync completed
   ```sql
   SELECT COUNT(*) as ticket_count, 
          MIN(created_at) as oldest_ticket,
          MAX(created_at) as newest_ticket
   FROM de_conversations 
   WHERE source='zendesk' 
     AND tenant_id = current_tenant_id();
   ```
   - Expected: 100+ tickets (depends on volume)

3. [ ] Verify schema matches Zendesk
   ```sql
   SELECT id, customer_name, subject, created_at, source_id, status 
   FROM de_conversations 
   WHERE source='zendesk' 
   ORDER BY created_at DESC 
   LIMIT 5;
   ```
   - Check: all fields present + data makes sense

4. [ ] Spot-check 5 random tickets
   - Go to Zendesk → find ticket by ID
   - Compare: subject, customer name, status match exactly
   - If mismatch: debug field mapping (mig 027)

5. [ ] Data quality check
   ```sql
   SELECT status, COUNT(*) as count FROM de_conversations 
   WHERE source='zendesk' AND tenant_id = current_tenant_id()
   GROUP BY status;
   ```
   - Expected distribution of statuses

**Output**: `ZENDESK_BACKFILL_SUMMARY.md`
```markdown
# Zendesk Historical Sync Summary

✓ Sync completed: [timestamp]
✓ Tickets synced: [count] tickets from past 90 days
✓ Date range: [oldest_date] to [newest_date]
✓ Schema validation: [PASSED|FAILED]
✓ Spot-check (5 tickets): [PASSED|FAILED]

## Status Breakdown
- New: [count]
- Open: [count]
- Pending: [count]
- Solved: [count]
- Closed: [count]

## Data Quality
- Missing subjects: [count]
- Missing customer names: [count]
- Duplicate IDs: [count]
- All critical fields present: YES / NO

## Ready for Testing?
- All prerequisites met: YES / NO
- Next: Can proceed to playbook design
```

**Start:** After 2.1 complete

---

## Stream 3: Metrics Infrastructure & SQL Setup

### Task 3.1: Design & Build Metrics SQL Functions

**Owner:** Analytics + CTO  
**Time:** 6-8 hours  
**Output:** SQL functions for FCR, CSAT, TTR, escalation %, quality score

**Steps:**

1. [ ] **FCR (First Contact Resolution)**
   ```sql
   -- Query: % of tickets resolved without escalation
   CREATE OR REPLACE FUNCTION support_fcr(
     p_tenant_id UUID,
     p_date_from TIMESTAMP,
     p_date_to TIMESTAMP
   ) RETURNS DECIMAL AS $$
   SELECT 
     ROUND(
       COUNT(CASE WHEN escalated = FALSE AND status = 'resolved' THEN 1 END)::DECIMAL 
       / NULLIF(COUNT(*), 0) * 100, 2
     )
   FROM de_conversations
   WHERE tenant_id = p_tenant_id
     AND created_at >= p_date_from
     AND created_at <= p_date_to
     AND source = 'zendesk'
   $$ LANGUAGE SQL;
   ```

2. [ ] **TTR (Time to Resolution) - Median**
   ```sql
   CREATE OR REPLACE FUNCTION support_ttr_median(
     p_tenant_id UUID,
     p_date_from TIMESTAMP,
     p_date_to TIMESTAMP
   ) RETURNS INTERVAL AS $$
   SELECT 
     PERCENTILE_CONT(0.5) WITHIN GROUP (
       ORDER BY EXTRACT(EPOCH FROM (resolved_at - created_at))
     )::INTERVAL
   FROM de_conversations
   WHERE tenant_id = p_tenant_id
     AND resolved_at IS NOT NULL
     AND created_at >= p_date_from
     AND created_at <= p_date_to
     AND source = 'zendesk'
   $$ LANGUAGE SQL;
   ```

3. [ ] **TTR P95 (95th percentile)**
   ```sql
   CREATE OR REPLACE FUNCTION support_ttr_p95(
     p_tenant_id UUID,
     p_date_from TIMESTAMP,
     p_date_to TIMESTAMP
   ) RETURNS INTERVAL AS $$
   SELECT 
     PERCENTILE_CONT(0.95) WITHIN GROUP (
       ORDER BY EXTRACT(EPOCH FROM (resolved_at - created_at))
     )::INTERVAL
   FROM de_conversations
   WHERE tenant_id = p_tenant_id
     AND resolved_at IS NOT NULL
     AND created_at >= p_date_from
     AND created_at <= p_date_to
     AND source = 'zendesk'
   $$ LANGUAGE SQL;
   ```

4. [ ] **Escalation Rate**
   ```sql
   CREATE OR REPLACE FUNCTION support_escalation_rate(
     p_tenant_id UUID,
     p_date_from TIMESTAMP,
     p_date_to TIMESTAMP
   ) RETURNS DECIMAL AS $$
   SELECT 
     ROUND(
       COUNT(CASE WHEN escalated = TRUE THEN 1 END)::DECIMAL 
       / NULLIF(COUNT(*), 0) * 100, 2
     )
   FROM de_conversations
   WHERE tenant_id = p_tenant_id
     AND created_at >= p_date_from
     AND created_at <= p_date_to
     AND source = 'zendesk'
   $$ LANGUAGE SQL;
   ```

5. [ ] **CSAT (from csat_scores table)**
   ```sql
   CREATE OR REPLACE FUNCTION support_csat_avg(
     p_tenant_id UUID,
     p_date_from TIMESTAMP,
     p_date_to TIMESTAMP
   ) RETURNS DECIMAL AS $$
   SELECT 
     ROUND(AVG(score), 2)
   FROM csat_scores
   WHERE tenant_id = p_tenant_id
     AND conversation_id IN (
       SELECT id FROM de_conversations 
       WHERE source = 'zendesk' 
         AND created_at >= p_date_from 
         AND created_at <= p_date_to
     )
   $$ LANGUAGE SQL;
   ```

6. [ ] **Quality Score (from human QA verdicts)**
   ```sql
   CREATE OR REPLACE FUNCTION support_quality_score(
     p_tenant_id UUID,
     p_date_from TIMESTAMP,
     p_date_to TIMESTAMP
   ) RETURNS DECIMAL AS $$
   SELECT 
     ROUND(
       COUNT(CASE WHEN verdict = 'accurate' THEN 1 END)::DECIMAL 
       / NULLIF(COUNT(*), 0) * 100, 2
     )
   FROM qa_verdicts
   WHERE tenant_id = p_tenant_id
     AND message_id IN (
       SELECT id FROM de_messages 
       WHERE conversation_id IN (
         SELECT id FROM de_conversations 
         WHERE source = 'zendesk' 
           AND created_at >= p_date_from 
           AND created_at <= p_date_to
       )
     )
   $$ LANGUAGE SQL;
   ```

**Output**: `METRICS_SQL_FUNCTIONS.sql` (ready to deploy)

**Start:** Immediately (independent)

---

### Task 3.2: Build Dashboard Query Layer

**Owner:** Frontend + Analytics  
**Time:** 3-4 hours  
**Output:** TypeScript API for fetching metrics

**Steps:**
1. [ ] Create `src/lib/supportMetricsApi.ts`
   ```typescript
   export async function getSupportAgentMetrics(
     tenant_id: string,
     dateFrom: Date,
     dateTo: Date
   ) {
     return supabase.rpc('get_support_agent_metrics', {
       p_tenant_id: tenant_id,
       p_date_from: dateFrom,
       p_date_to: dateTo
     });
   }
   
   export interface SupportMetrics {
     fcr: number; // %
     csat: number; // 0-5 scale
     ttr_median: string; // ISO interval
     ttr_p95: string; // ISO interval
     escalation_rate: number; // %
     quality_score: number; // %
     volume: number; // total tickets
     period: { from: string; to: string };
   }
   ```

2. [ ] Create dashboard component skeleton
   - File: `src/components/SupportAgentMetricsPanel.tsx`
   - Displays: all 6 metrics
   - Updates: hourly via polling
   - Loading state: skeleton loader

**Start:** After 3.1 complete

---

## Stream 4: Ticket Categorization & Testing Dataset

### Task 4.1: Design Ticket Categorization Schema

**Owner:** Operations  
**Time:** 2-3 hours  
**Output:** Zendesk custom field mapping + categorization rules

**Steps:**
1. [ ] Document Zendesk's current ticket categorization
   ```
   Q: How does Zendesk currently categorize tickets?
   - Zendesk "Type" field? (Problem, Task, Question, Incident)
   - Zendesk "Tags"? (list current tags used)
   - Outsourcetel custom fields? (list them)
   - Ticket subject keywords? (list common patterns)
   ```

2. [ ] Design Support Agent's categorization needs
   - Example: Product Troubleshooting, Billing Question, Account Access, Feature Request
   - Map to escalation rules (e.g., Billing → Billing Specialist)

3. [ ] Create extraction logic (for playbook Step 1)
   ```typescript
   // Example: classifier for ticket category
   function categorizeTicket(subject: string, description: string): string {
     if (subject.includes("refund") || description.includes("refund")) 
       return "BILLING";
     if (subject.includes("can't login") || description.includes("password"))
       return "ACCOUNT";
     if (subject.includes("integration") || subject.includes("API"))
       return "INTEGRATION";
     return "PRODUCT"; // default
   }
   ```

**Output**: `TICKET_CATEGORIZATION.md`

**Start:** Immediately (independent)

---

### Task 4.2: Prepare 100-Ticket Testing Dataset

**Owner:** QA + Operations  
**Time:** 4-6 hours  
**Output:** Curated set of 100 historical tickets for playbook testing

**Steps:**
1. [ ] Select 100 diverse historical tickets
   ```sql
   SELECT id, subject, description, customer_name, status, created_at
   FROM de_conversations
   WHERE source = 'zendesk'
     AND created_at >= NOW() - INTERVAL '90 days'
   ORDER BY RANDOM()
   LIMIT 100;
   ```

2. [ ] Categorize each ticket
   - Run categorization logic from 4.1
   - Document predicted category (for comparison after playbook build)

3. [ ] Manually label each ticket (human review)
   - Question: Did the customer get a good resolution?
   - Question: Was escalation necessary?
   - Question: Did human specialist agree with our categorization?
   - Create "ground truth" labels for later accuracy measurement

4. [ ] Build test file: `test_data/support_tickets_100.json`
   ```json
   {
     "tickets": [
       {
         "id": "12345",
         "subject": "Can't login to my account",
         "description": "...",
         "customer_name": "John Doe",
         "predicted_category": "ACCOUNT",
         "actual_category": "ACCOUNT",
         "was_escalated": false,
         "human_resolution": "Sent password reset link",
         "accuracy_rating": "MATCH"
       },
       ...
     ]
   }
   ```

5. [ ] Use this dataset for playbook testing in Week 4
   - Run playbook against each ticket
   - Measure: categorization accuracy, escalation % agreement

**Output**: `test_data/support_tickets_100.json` (ready for playbook testing)

**Start:** After 2.2 complete (need synced tickets)

---

## Stream 5: Playbook Flow Variant Design

### Task 5.1: Design Playbook Decision Branches

**Owner:** CTO + Operations  
**Time:** 3-4 hours  
**Output:** Detailed playbook flow diagram + decision tree

**Steps:**
1. [ ] Design the 6-step playbook with variants
   ```
   Step 1: RECEIVE TICKET
   ├─ Extract: ticket ID, customer name, subject, urgency, sentiment
   ├─ Retrieve: customer account context
   └─ Decision: Is this a known issue? (pattern matching)
   
   Step 2: CONSULT KNOWLEDGE BASE
   ├─ Query: customer's problem + category
   ├─ Retrieve: top 3 matching KB articles
   ├─ Score: by relevance + recency
   └─ Get: confidence score (0-100%)
   
   Step 3: CONFIDENCE GATE (>80%)
   ├─ Branch A: High Confidence (>80%)
   │  ├─ Draft response using KB
   │  ├─ Include: problem + solution + expected result
   │  ├─ Human review: Support Lead approves
   │  └─ Send to customer
   │
   ├─ Branch B: Low Confidence (<50%)
   │  ├─ Escalate to Support Lead with context
   │  ├─ Include: what we tried, why uncertain
   │  └─ Human specialists draft response
   │
   └─ Branch C: Medium Confidence (50-80%)
       ├─ Offer partial answer
       ├─ Include: workaround + escalation path
       └─ Send + mark for 48hr follow-up
   
   Step 4: HANDLE SPECIAL CASES
   ├─ Refund requests → Escalate to Finance
   ├─ Billing questions → Escalate to Finance
   ├─ Feature requests → Escalate to Product
   └─ Complaints → Escalate to Founder
   
   Step 5: TRACK OUTCOME
   ├─ Log: resolution_type (autonomous vs human-supported)
   ├─ Log: time_to_resolution
   ├─ Send: CSAT survey (48hr post-resolution)
   └─ Update: DE metrics dashboard
   
   Step 6: MEASURE SUCCESS
   ├─ FCR: Did customer reply again?
   ├─ TTR: How long to resolution?
   ├─ CSAT: Customer rating (1-5)?
   └─ Quality: Was response accurate?
   ```

2. [ ] Document decision thresholds
   ```markdown
   # Decision Thresholds (to be tuned)
   
   - Knowledge confidence threshold: 80% (adjust ±10%?)
   - Auto-send without approval? NO for now (weeks 6-7)
   - Escalation keywords: [list topics that trigger escalation]
   - Follow-up delay: 48 hours (if no customer reply)
   - QA sample rate: 10% (first week only)
   ```

3. [ ] Design guardrails (enforcement points)
   ```markdown
   # Guardrails
   
   ✓ Never promise delivery dates (escalate to PM)
   ✓ Never issue refunds (escalate to Finance)
   ✓ Never create customer records (read-only access)
   ✓ Never share company secrets
   ✓ Never make up information (use knowledge only)
   ```

**Output**: `PLAYBOOK_FLOW_DESIGN.md` (diagram + decision tree)

**Start:** Immediately (independent)

---

### Task 5.2: Playbook Testing Scenario Design

**Owner:** QA  
**Time:** 2-3 hours  
**Output:** Detailed test scenarios for playbook builder

**Steps:**
1. [ ] Design scenario: simple FAQ resolution
   ```markdown
   Scenario 1: Simple FAQ Resolution
   Input: "How do I reset my password?"
   Expected Flow:
     1. Categorize: ACCOUNT
     2. Query KB: get password reset articles
     3. Confidence: 95% (exact match)
     4. Draft response: "Click password reset link in your email"
     5. Human approval: APPROVE
     6. Send: to customer
   
   Success Criteria:
   - Confidence >80%? YES
   - Escalated? NO
   - Response sent? YES
   - CSAT expected: 4.5+/5.0
   ```

2. [ ] Design scenario: low-confidence troubleshooting
   ```markdown
   Scenario 2: Low Confidence Troubleshooting
   Input: "Integration with Salesforce failing randomly"
   Expected Flow:
     1. Categorize: INTEGRATION
     2. Query KB: get integration troubleshooting articles
     3. Confidence: 30% (vague, could be many issues)
     4. Escalate: to Technical Support DE (or human)
     5. Result: Human specialist investigates
   
   Success Criteria:
   - Confidence <50%? YES
   - Escalated? YES
   - Escalation reason logged? YES
   ```

3. [ ] Design scenario: refund request (escalation)
   ```markdown
   Scenario 3: Refund Request Escalation
   Input: "I'd like a refund for last month's bill"
   Expected Flow:
     1. Categorize: BILLING
     2. Detect: refund keyword → trigger escalation
     3. Route: to Finance Lead
     4. Escalation note: "Customer requests refund - amount unknown"
   
   Success Criteria:
   - Detected refund request? YES
   - Escalated to Finance? YES
   - Human response SLA: 4 hours
   ```

4. [ ] Add 7-10 more scenarios covering:
   - Account access issues
   - Billing questions (non-refund)
   - Angry/frustrated customer
   - Duplicate issue (seen before)
   - Feature request
   - Highly technical problem
   - Customer data inquiry

**Output**: `PLAYBOOK_TEST_SCENARIOS.md` (10+ scenarios, ready for Week 4 testing)

**Start:** After 4.1 complete

---

## Integration Points (When Decisions Arrive)

Once you provide the 7 founder decisions, these prerequisites enable:

1. **Knowledge Audit** (Stream 1) + **Identity Decision** → Knowledge ingestion can begin immediately Week 3
2. **Zendesk Testing** (Stream 2) + **Authority Decision** → Live sync can handle escalations correctly
3. **Metrics Functions** (Stream 3) + **FCR Target** → Dashboard shows progress toward goal
4. **Ticket Categorization** (Stream 4) + **Escalation Rules** → Playbook routing logic finalized
5. **Playbook Design** (Stream 5) + **Pre-Approval Decision** → Playbook builder can implement immediately

---

## Week 2 Timeline

### Monday-Tuesday (This week)
- **Stream 1.1**: Locate KB (ask founder)
- **Stream 2.1**: Test Zendesk API (ask founder for token)
- **Stream 3.1**: Build metrics SQL functions
- **Stream 4.1**: Design categorization schema
- **Stream 5.1**: Design playbook flow

### Wednesday-Thursday
- **Stream 1.2**: Design knowledge schema
- **Stream 2.2**: Backfill historical tickets
- **Stream 3.2**: Build metrics API layer
- **Stream 4.2**: Prepare 100-ticket dataset
- **Stream 5.2**: Design test scenarios

### Friday
- **Integration**: All prerequisites ready
- **Dependency Check**: What's blocking on founder decisions?
- **Handoff to Week 3**: Document what's ready to implement

---

## Success Criteria (EOW)

By EOD Friday (Week 2), these should be COMPLETE:

- ✅ **Stream 1**: Knowledge audit done, schema designed, KB locations documented
- ✅ **Stream 2**: Zendesk live + 90+ days historical tickets synced
- ✅ **Stream 3**: All 6 metric functions SQL-complete + API layer ready
- ✅ **Stream 4**: Ticket categorization schema defined, 100-ticket dataset prepared & labeled
- ✅ **Stream 5**: Playbook flow diagrammed, 10+ test scenarios documented

**Ready for Week 3**: The moment founder decisions arrive, execution begins immediately.

---

## Blocking Dependencies (Require Founder Input)

| Item | Needed For | Timeline |
|------|-----------|----------|
| Zendesk API token | Stream 2.1 | Monday EOD |
| KB storage location | Stream 1.1 | Monday EOD |
| Support Agent identity | Stream 5.1 refinement | Monday EOD |
| Refund authority | Stream 4.1 rules | Tuesday EOD |
| Escalation paths | Stream 5.1 branches | Tuesday EOD |
| Pre-approval gate | Stream 5 implementation | Wednesday EOD |
| FCR target | Stream 3.2 dashboard | Wednesday EOD |

**Action**: Email founder with these 7 items by EOD Monday

---

## Parallel Execution Priority

If time is limited, prioritize in this order:
1. **Stream 2** (Zendesk live) — blocks everything else
2. **Stream 3** (Metrics) — needed for dashboard by Week 5
3. **Stream 1** (Knowledge) — needed for content by Week 3
4. **Stream 4** (Testing data) — needed for playbook testing Week 4
5. **Stream 5** (Playbook design) — can be refined later

---

## Files to Create/Deliver EOW

1. ✅ `KB_AUDIT.md` — Knowledge source locations
2. ✅ `KNOWLEDGE_SCHEMA.md` — Ticket category taxonomy
3. ✅ `ZENDESK_CONNECTION_TEST.md` — API verification + sample tickets
4. ✅ `ZENDESK_BACKFILL_SUMMARY.md` — Historical sync results
5. ✅ `METRICS_SQL_FUNCTIONS.sql` — 6 functions (FCR, CSAT, TTR, etc.)
6. ✅ `TICKET_CATEGORIZATION.md` — Zendesk field mapping
7. ✅ `test_data/support_tickets_100.json` — Labeled test dataset
8. ✅ `PLAYBOOK_FLOW_DESIGN.md` — Complete flow diagram
9. ✅ `PLAYBOOK_TEST_SCENARIOS.md` — 10+ scenarios for testing

---

## Status Dashboard (Update Daily)

```
STREAM 1 (Knowledge): 0% → [tracking]
  ├─ 1.1 Audit KB: [ ] [ ] [ ]
  └─ 1.2 Schema Design: [ ] [ ] [ ]

STREAM 2 (Zendesk): 0% → [tracking]
  ├─ 2.1 API Testing: [ ] [ ] [ ]
  └─ 2.2 Backfill: [ ] [ ] [ ]

STREAM 3 (Metrics): 0% → [tracking]
  ├─ 3.1 SQL Functions: [ ] [ ] [ ]
  └─ 3.2 API Layer: [ ] [ ] [ ]

STREAM 4 (Testing): 0% → [tracking]
  ├─ 4.1 Categorization: [ ] [ ] [ ]
  └─ 4.2 Test Dataset: [ ] [ ] [ ]

STREAM 5 (Playbook): 0% → [tracking]
  ├─ 5.1 Flow Design: [ ] [ ] [ ]
  └─ 5.2 Scenarios: [ ] [ ] [ ]

Founder Decisions: 0/7
```

---

**Ready to Begin**: YES ✓  
**Starting**: NOW  
**Deadline**: EOW Week 2  
**Next Action**: Email founder with 7 decision items

