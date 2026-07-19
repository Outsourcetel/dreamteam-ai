# Week 1 Deliverables Audit: Foundation Infrastructure
**What's Built? What Needs UI? What's Missing?**

**Date:** 2026-07-19  
**Scope:** Assess 6 Week 1 foundational systems against "hidden machinery vs. discoverable UI" standard  
**Target:** All 6 components visible, measurable, and manageable from the platform UI by Friday EOD

---

## Executive Summary

Most Week 1 machinery is **BUILT but HIDDEN**. The work is 40% UI/UX integration to make hidden systems visible, 30% connector hardening (live proof), 20% knowledge ingestion, 10% plumbing.

| Deliverable | Built | UI Visible | Actionable | Status |
|------------|-------|-----------|-----------|--------|
| 1. Data Integration Layer | ✅ YES (migrations 017+) | ⚠️ PARTIAL | ❌ NO | **Fix visibility** |
| 2. Real Performance Dashboard | ✅ YES (mig 147) | ⚠️ PARTIAL | ✅ YES | **Verify metrics** |
| 3. Real Playbook Templates | ✅ YES (mig 031) | ✅ YES | ✅ YES | **Create Support + Billing drafts** |
| 4. Escalation + Approval Workflows | ✅ YES (mig 024+) | ✅ YES | ✅ YES | **Wire into Outsourcetel ops** |
| 5. Knowledge Corpus | ✅ YES (mig 032) | ⚠️ PARTIAL | ❌ NO | **Organize by domain + UI** |
| 6. Connector Hardening | ⚠️ PARTIAL | ✅ YES | ❌ NO | **Live proof required** |

---

## 1. Data Integration Layer

### What's Built
- ✅ **Connectors framework** (mig 017): connector table, connector_objects (sync vs read-through), connector_secrets (SECURITY DEFINER, encrypted)
- ✅ **Zendesk connector** live-proof (sync_tickets, read-through, write-back add_internal_note + update_status)
- ✅ **Connectors page** UI (connect flow, object-mode table, sync intervals, write-back toggles, test + save, disconnect)
- ✅ **Specialist-consult** edge function (data read-through for technical assistance)
- ✅ **Category contracts** (mig 027): 9 categories (crm, helpdesk, knowledge_base, erp_financials, billing, payroll_hcm, pos, product_system, other) with canonical objects + operations
- ✅ **Connector health** (mig 027): last_ok_at/last_error_at/consecutive_failures tracked per connector call

### What's Hidden (Needs UI)
- ❌ **No data sync status dashboard** — Operations team can't see:
  - Which data sources are connected
  - How fresh is the data (last sync timestamp per connector)
  - Did the last sync succeed or fail?
  - How many items synced / skipped / errored?
  - Which connectors need credential refresh?

- ❌ **No data inventory** — Can't see:
  - How many Zendesk tickets synced (total, past 24h, past 7d)
  - How many Salesforce accounts available
  - How many QuickBooks GL entries
  - Coverage: "Which systems is this DE connected to?" not visible anywhere

### What Needs to Be Built (By Friday)

**1.1 Connector Status Dashboard** (New page under Operations or Data Access)
- [ ] Card per connected system (Zendesk, Salesforce, Stripe, QuickBooks)
- [ ] For each: connection status (healthy/degraded/down/never_connected), last sync time, last error (if any), item counts (total, past 24h)
- [ ] "Sync now" button (triggers immediate sync_tickets/read-through)
- [ ] Data freshness badge: "✅ Fresh (synced 5 min ago)" or "⚠️ Stale (2+ hours)"

**1.2 Data Coverage View** (Per-DE or per-Domain tab)
- [ ] "Support Agent can see: Zendesk tickets, Salesforce customers, internal KB"
- [ ] "Billing Specialist can see: Stripe transactions, QuickBooks GL, customer contracts"
- [ ] List connector status, access level (read-only vs write-back), data count

**1.3 Data Sync Errors Panel**
- [ ] List last 10 sync failures across all connectors (connector, error type, timestamp, retry count)
- [ ] "Retry now" action
- [ ] Alert if any connector hasn't synced in 24h

**Acceptance Criteria (By Friday EOD):**
- [ ] Dashboard loads without errors
- [ ] Shows real data (Zendesk mock tickets if real account not available)
- [ ] Last sync timestamp accurate (within 5 minutes of actual)
- [ ] Data counts match connector tables (spot-check)

---

## 2. Real Performance Dashboard

### What's Built
- ✅ **Performance & Insights page** (mig 147) — shows per-DE metrics:
  - Resolution rate (%)
  - Confidence (avg)
  - Escalation rate (%)
  - Error rate (%)
  - Cost (token usage + estimated AI spend)
  - CSAT (from survey collection, mig 147)
- ✅ **Insights page** — anomaly detection, config drift, eval failure signals
- ✅ **Performance data sources**:
  - `evidence_run_decisions` (from 034): would_auto_send / needs_review / blocked_guardrail / skipped
  - `de_work_items` / `human_tasks`: escalation tracking
  - `evidence_runs`: accuracy via feedback loop (mig 032)
  - `de_economics` (mig 131): FTE equivalent, ROI, cost per transaction

### What's Missing (Needs Verification + UI)

**The 9 Delivery Excellence Metrics** — which ones are actually on the dashboard?

| Metric | Category | Status | UI Component |
|--------|----------|--------|---------------|
| **CSAT** | Client Experience | ✅ Live (mig 147) | Survey widget on Support Agent page |
| **FCR (First Contact Resolution)** | Client Experience | ⚠️ PARTIAL | Computed? Visible? |
| **TTR (Time to Resolution)** | Client Experience | ⚠️ PARTIAL | Computed? Visible? |
| **NPS** | Client Experience | ❌ MISSING | No collection mechanism |
| **DE-Handled Rate** | Operational Quality | ✅ Live | Shows as % autonomous (inverse of escalation) |
| **Escalation Rate** | Operational Quality | ✅ Live | Real metric on perf page |
| **SLA Achievement Rate** | Operational Quality | ❌ MISSING | No SLA target tracking |
| **Quality Score** | Operational Quality | ⚠️ PARTIAL | From QA sampling? Not visible on dashboard |
| **Policy Compliance Rate** | Operational Quality | ⚠️ PARTIAL | Guardrail blocks tracked, not as a dashboard % |

### What Needs to Be Built (By Friday)

**2.1 Fix Existing Metrics Display**
- [ ] FCR: Compute as `1 - (escalations / total_work_items)`, show % trend over 7/30/90 days
- [ ] TTR: Compute as average `completed_at - created_at`, show median + p95
- [ ] Quality Score: Pull from QA sampling data if available; if not, use accuracy from evidence feedback
- [ ] Policy Compliance Rate: Pull from guardrail audit events, show as `(no_violations / total_decisions) * 100`

**2.2 Add Missing Metrics**
- [ ] NPS: Add comment collection on ticket resolution ("How would you rate your experience?"), compute quarterly
- [ ] SLA Achievement Rate: Add SLA target field to DE (default per domain), compute `(on_time / total) * 100`

**2.3 Make Dashboard Actionable**
- [ ] Show red/yellow/green thresholds (e.g., FCR target 65%+, CSAT 4.2+)
- [ ] Weekly snapshot (every Monday) — "Last week's metrics" card with trend arrows
- [ ] Metric drill-down: click metric → see underlying work items (e.g., click "65% FCR" → list of tickets with FCR flag)
- [ ] Filter by time range (week, month, quarter)

**Acceptance Criteria (By Friday EOD):**
- [ ] All 9 metrics visible on dashboard (even if some say "computing..." initially)
- [ ] At least 3 metrics have 7+ days of historical data
- [ ] Metrics update hourly (or on-demand button)
- [ ] Thresholds color-coded (red = below target)
- [ ] No hard-coded demo data (all real queries or honest empty states)

---

## 3. Real Playbook Templates

### What's Built
- ✅ **Playbook builder** (mig 031): 5 step types (instruction, decision, checklist, wait, sub_playbook)
- ✅ **Playbook executor** (mig 031+): runs playbooks server-side, supports schedules + event triggers
- ✅ **Playbook templates** for enterprise customers (Acme Telecom renewal, onboarding, etc.)
- ✅ **Live Playbooks page** — view, edit, publish, run, view history
- ✅ **Playbook drafting UI** — step picker, plain-language editor

### What's Missing (Needs Creation)

**No Support or Billing templates exist for Outsourcetel yet.**

### What Needs to Be Built (By Friday)

**3.1 Support Playbook Template** (Draft)
```
Name: "Resolve Support Ticket"
Steps:
1. Instruction: "Read ticket carefully"
2. Check_knowledge: "Search KB for solution (confidence >80%)"
3. Decision: "If confidence > 80% and no guardrails block?"
   - Yes → Step 4
   - No → Step 5
4. Instruction: "Draft response"
5. Specialist_consult: "Route to Finance Specialist (if billing question)"
6. Checklist: "Have I addressed all parts of the ticket?"
7. Wait: "Await customer response (48h timeout)"
8. Complete: "Ticket resolved"
```

- [ ] Create in PlaybooksPage under "Templates"
- [ ] Status: "Draft" (not published yet)
- [ ] Mark as "Outsourcetel Support — do not modify"
- [ ] Add description: "Baseline template for Support Agent. Handles triage, escalation, and resolution tracking."

**3.2 Billing Playbook Template** (Draft)
```
Name: "Process Invoice & Follow Up"
Steps:
1. Instruction: "Identify overdue invoice (>30 days)"
2. Check_account: "Get customer info, check payment history"
3. Connector_action: "Read latest payment method from Stripe"
4. Decision: "Did payment fail?"
   - Yes → Step 5 (retry notification)
   - No → Step 6 (investigation)
5. Instruction: "Send payment retry notification (template)"
6. Wait: "Await payment (7 days)"
7. Decision: "Payment received?"
   - Yes → Step 8
   - No → Step 9
8. Complete: "Invoice paid"
9. Escalate: "Route to Finance Lead (unresolved after 7d)"
```

- [ ] Create in PlaybooksPage under "Templates"
- [ ] Status: "Draft"
- [ ] Mark as "Outsourcetel Billing — do not modify"

**3.3 Template Visibility**
- [ ] Add "Library" tab on Playbooks page
- [ ] Show domain-specific templates: Support, Billing, Sales, CSM, Finance
- [ ] "Clone template" button (creates a draft copy for the tenant)
- [ ] Mark as "Outsourcetel Template" (read-only, for reference)

**Acceptance Criteria (By Friday EOD):**
- [ ] Both Support + Billing templates created as drafts
- [ ] Templates exist in the templates library
- [ ] Can be viewed (not edited)
- [ ] "Clone" creates a working copy
- [ ] No syntax errors (tsc passes)

---

## 4. Escalation + Approval Workflows

### What's Built
- ✅ **Human tasks framework** (mig 024): inquiry_review, action_approval, checklist, review_gate, approval_gate, knowledge_revision
- ✅ **Human Tasks page** — see pending tasks, approve/reject, add notes
- ✅ **Escalation rules** per-DE (mig 110, structured escalation rules: frustration threshold, always-escalate topics)
- ✅ **Approval gates** in playbooks (human_approval, guardrail_check gate steps)
- ✅ **Decision hooks** (5 hooks wired to trigger approvals/escalations)
- ✅ **Staleness watchdog** (mig 042) — escalates stalled work items

### What's Missing (Needs Wiring to Outsourcetel Operations)

- ⚠️ **No escalation playbook** — how does Support Agent escalate to human specialist?
- ⚠️ **No escalation assignment** — who should receive escalations? Support Lead? Founder?
- ⚠️ **No SLA on approvals** — how fast should human review an approval task?

### What Needs to Be Built (By Friday)

**4.1 Escalation Routing Configuration**
- [ ] On each DE profile (Settings or Governance tab), add "Escalation Routes"
  - Support Agent: escalates to → Support Lead (by topic), or Founder (billing)
  - Billing Specialist: escalates to → Finance Lead (policy) or Founder (>$X)
  - Sales Ops: escalates to → Sales Manager or Founder
- [ ] Implement `resolve_escalation_target(DE_id, reason)` SQL function
- [ ] Wire into playbook execute: when escalate step fires, target resolves correctly

**4.2 Approval SLA Configuration**
- [ ] Per DE or per domain, set approval SLA (default: 4h urgent, 24h standard)
- [ ] Staleness watchdog (mig 042) already fires at breach — just needs UI to configure it
- [ ] Show "Pending 3h / SLA in 1h" badge on Human Tasks page

**4.3 Escalation Visibility**
- [ ] On Human Tasks page, add "Escalation Reason" column (why did this escalate?)
- [ ] Filter: "Show escalations only" toggle
- [ ] Quick-assign: "Assign to..." dropdown

**Acceptance Criteria (By Friday EOD):**
- [ ] Support DE has routing configured (escalates to human)
- [ ] Approval SLA shows on tasks (e.g., "SLA in 2h")
- [ ] Staleness watchdog is configured for Support tickets (breach after 4h)
- [ ] Human Tasks page shows escalation reason + SLA
- [ ] No hardcoded Founder escalations (all configurable)

---

## 5. Knowledge Corpus

### What's Built
- ✅ **Knowledge ingestion** (mig 032): upload KB articles, chunk + embed, make searchable
- ✅ **Knowledge feedback loop** (mig 032): evidence → verdict → revision request → approve/reject
- ✅ **Per-DE knowledge scopes** (mig 030): which DE can see which docs
- ✅ **Knowledge Library page**: upload, manage docs, set scopes
- ✅ **Specialist consult** (mig 024): retrieve knowledge during evidence-gathering

### What's Missing (Needs Organization + UI)

- ❌ **No domain-scoped knowledge** — can't see "Support docs", "Billing docs", "Finance docs" separately
- ❌ **No knowledge coverage metrics** — how complete is Support KB? Billing KB?
- ❌ **No knowledge versioning UI** — hard to track what changed
- ❌ **No knowledge health** — which docs are outdated? Which need review?

### What Needs to Be Built (By Friday)

**5.1 Domain-Scoped Knowledge Organization**
- [ ] On Knowledge Library page, add "Domain" column (Support, Billing, Sales, Finance, etc.)
- [ ] Default domain scoping when uploading ("This is a Billing doc")
- [ ] Filter by domain: "Show Billing KB only"
- [ ] Breadcrumb: "Support > Billing > ...articles"

**5.2 Knowledge Coverage Dashboard**
- [ ] Add "Knowledge Health" page or widget
- [ ] Per domain:
  - Total articles
  - Articles reviewed (confidence = high)
  - Articles needing review (confidence < threshold)
  - Last update date
- [ ] Example:
  ```
  Support: 45 articles, 38 reviewed (84%), updated 2d ago ✅
  Billing: 12 articles, 8 reviewed (67%), updated 5d ago ⚠️
  Finance: 0 articles ❌
  ```

**5.3 Knowledge Ingestion for Week 1**
- [ ] **Support KB**: Fetch from Confluence/Notion (if available) or manually seed 20-30 articles
  - FAQs, troubleshooting guides, product overview, common errors
- [ ] **Billing KB**: Seed 10-15 articles
  - Billing policies, refund policy, payment methods, tax rules, customer contracts (if available)
- [ ] Validation: spot-check 5 articles for accuracy

**5.4 Knowledge Revision Tracking UI**
- [ ] On each Knowledge doc, show "Version history" tab
- [ ] List: v1 (original upload), v2 (revised based on feedback), etc.
- [ ] "View diff" button: shows what changed between versions
- [ ] Link to the feedback that triggered the revision

**Acceptance Criteria (By Friday EOD):**
- [ ] Support KB has 20+ articles ingested, organized by domain
- [ ] Billing KB has 10+ articles ingested
- [ ] Knowledge Health page shows coverage per domain (all should show >0)
- [ ] Knowledge scopes per DE are visible (Support Agent → Support KB only)
- [ ] No knowledge marked as "outdated" (all <7 days since review)

---

## 6. Connector Hardening (Live Proof)

### What's Built
- ✅ **Zendesk connector** (mig 017): sync_tickets, read_ticket, add_internal_note, update_status
- ⚠️ **Stripe connector** (category template): blueprint exists, NOT proven live
- ⚠️ **QuickBooks connector** (category template): blueprint exists, NOT proven live
- ⚠️ **Salesforce connector** (category contract): blueprint exists, NOT proven live
- ✅ **Category contract framework** (mig 027): generic ops (search_records, get_record, create_record, etc.)
- ✅ **Connector template executor** (mig 028): renders API calls, handles auth

### What's Missing (Needs Live Proof by Friday)

**CRITICAL PATH:** If Zendesk doesn't sync real Outsourcetel tickets by Friday, Support Agent can't launch Week 8.

| Connector | Live? | Status | Blocker? |
|-----------|-------|--------|----------|
| **Zendesk** | ✅ YES | Syncs real Acme Telecom tickets (proven in ROADMAP.md) | NO |
| **Stripe** | ❌ NO | Exists as template, not connected to real account | **BLOCKER for Billing** |
| **QuickBooks** | ❌ NO | Exists as template, not connected | **BLOCKER for Billing** |
| **Salesforce** | ❌ NO | Exists as contract, not connected | **BLOCKER for Sales Ops** |
| **Slack** | ⚠️ PARTIAL | Webhook exists (notifications), not fully integrated | Not critical Week 1 |

### What Needs to Be Done (By Friday)

**6.1 Zendesk Live Proof (Support Agent Foundation)**
- [ ] Connect to Outsourcetel's Zendesk account (if available) OR a free trial
- [ ] Run `sync_tickets` cron job — verify:
  - [ ] Real tickets appear in `support_tickets` table
  - [ ] Data freshness: last sync timestamp accurate
  - [ ] Error handling: any failed calls logged, not silent
  - [ ] Rate limiting: no 429 errors
  - [ ] Security: no credentials logged, audit trail complete
- [ ] Test `read_ticket` (read-through mode): pull one ticket, verify data matches Zendesk
- [ ] Test write-back: `add_internal_note` + `update_status` on a test ticket
- [ ] Regression test: run on past 100 tickets, verify accuracy

**6.2 Stripe Live Proof (Billing Specialist Foundation)**
- [ ] Create a Stripe test account (free tier) OR use Outsourcetel's sandbox
- [ ] Run template executor against Stripe API:
  - [ ] `list_records` (all transactions) — verify response parsing
  - [ ] `get_record` (one invoice) — verify dot-path extraction
  - [ ] Test error handling: fake API key, wrong endpoint, rate limit
- [ ] Store test transaction IDs: will use for golden-set testing Week 9-12

**6.3 QuickBooks Live Proof (Billing Specialist Foundation)**
- [ ] Create a QuickBooks sandbox account (free tier) OR use Outsourcetel's test company
- [ ] Test OAuth2 flow: authenticate, get access token, confirm it persists
- [ ] Test category ops:
  - [ ] `list_records` (GL entries) — verify structure
  - [ ] `get_record` (one GL entry) — verify amount/date parsing
  - [ ] Test error handling: expired token, wrong company ID, invalid account
- [ ] Store test GL entry IDs: will use for golden-set testing

**6.4 Salesforce Live Proof (Sales Ops Foundation)**
- [ ] Create a Salesforce Developer Edition (free, Outsourcetel's own instance if available)
- [ ] Test OAuth2 flow: authenticate, get session token
- [ ] Test category ops:
  - [ ] `search_records` (accounts) — verify search, pagination
  - [ ] `get_record` (one opportunity) — verify fields (amount, stage, close date)
  - [ ] Test error handling: invalid SOQL, rate limit, permission denied
- [ ] Store test record IDs: will use for golden-set testing

**6.5 Connector Status Reporting**
- [ ] For each connector (Zendesk, Stripe, QuickBooks, Salesforce):
  - [ ] Auth working: ✅ or ❌
  - [ ] Data readable: ✅ or ❌ (show sample record)
  - [ ] Rate limiting respected: ✅ or ❌
  - [ ] Error handling working: ✅ (tested with fake creds)
  - [ ] Audit trail complete: ✅ or ❌
- [ ] Document in a "Connector Status Report" (table or Slack message to founder)

**Acceptance Criteria (By Friday EOD):**
- [ ] Zendesk: Live real-data sync, no errors, audit trail intact
- [ ] Stripe: Authenticated, test transaction retrieved, rate limiting working
- [ ] QuickBooks: Authenticated, test GL entry retrieved, error handling proven
- [ ] Salesforce: Authenticated, test opportunity retrieved, error handling proven
- [ ] All 4 connectors documented in status report (pass/fail + notes)
- [ ] No credentials logged, all secrets encrypted
- [ ] Zero regression on existing tenants (mig 017/027/028 unchanged)

---

## Week 1 Critical Path (Friday EOD Checklist)

### Backend (Must be done)
- [ ] All 5 data sources readable without errors (Zendesk, Stripe, QuickBooks, Salesforce, Slack)
- [ ] Data freshness <5 min (sync runs on schedule, not manual)
- [ ] Connector health tracking live (last_ok_at, consecutive_failures, etc.)
- [ ] No silent failures (all errors logged, audit trail complete)

### UI/UX (Must be visible)
- [ ] **Data Integration Dashboard**: Shows sync status per connector
- [ ] **Performance Dashboard**: All 9 metrics visible (even if "computing...")
- [ ] **Playbook Templates**: Support + Billing drafts exist, visible in library
- [ ] **Escalation Configuration**: Support Agent has routing rules + SLA set
- [ ] **Knowledge Library**: Support + Billing domains visible, >20 articles ingested
- [ ] **Connector Status Page**: Shows which connectors are healthy, which have errors

### Measurement (Must be tracked)
- [ ] FCR, CSAT, TTR, Escalation Rate, Autonomy Rate visible on dashboard
- [ ] Data sync counts visible (X articles ingested, Y Zendesk tickets synced)
- [ ] Approval SLA tracking live (tasks show "SLA in 2h" badge)

### Handoff to Support Agent Build (Week 2)
- [ ] Support DE can read Zendesk tickets (live proof)
- [ ] Support DE can consult internal KB (20+ articles)
- [ ] Support DE can escalate to human with routing (determined by DE config)
- [ ] Support DE autonomy + escalation rules configured (default: level 2, <4h escalation SLA)
- [ ] Performance dashboard ready to show Support Agent metrics (FCR, CSAT, TTR)

---

## If Anything Is Missing by Friday...

Support Agent **cannot launch Week 8** without:
- ✅ **CRITICAL**: Zendesk connector live (real data readable)
- ✅ **CRITICAL**: Support knowledge >20 articles
- ✅ **CRITICAL**: Performance dashboard showing FCR/CSAT/TTR
- ✅ **CRITICAL**: Escalation routing configured

Billing Specialist **cannot launch Week 12** without:
- ✅ **CRITICAL**: Stripe + QuickBooks connectors live (real data readable)
- ✅ **CRITICAL**: Billing knowledge >10 articles
- ✅ **CRITICAL**: Approval SLA tracking (4h urgent, 24h standard)

---

## Summary: "Hidden Machinery" → "Visible Operations"

**Current state:** All the machinery exists under the hood. Operations teams can't see it.

**After Week 1:** Every system has a dashboard, a status page, or a control panel. Operations teams can see:
- How fresh is the data?
- Is the DE working correctly?
- What's it doing right now?
- What do I need to fix?

**By Friday EOD, someone should be able to walk up to the Performance Dashboard and say:** "Support Agent is 65% autonomous, escalating 25% of tickets to human (3h SLA), with 4.2/5 CSAT. It knows 45 articles about our products. It's connected to Zendesk and reading real tickets. All syncs are working."

That's when Week 1 is done.
