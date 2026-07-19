# Week 1: Pick Up Here — Exact Tasks to Build

**Status:** Ready to execute  
**Timeline:** Monday-Friday (5 days)  
**Team:** Platform (Backend), Frontend, Operations (Outsourcetel), Knowledge  
**Success:** All 6 foundational systems discoverable + measurable from UI by Friday EOD

---

## Monday-Tuesday: Assessment + Planning

### 1. Verify Existing Machinery (Backend team, 2 hours)
- [ ] Run existing queries to assess:
  - Zendesk data in `support_tickets` table (how many rows? when last synced?)
  - Salesforce data in `crm_accounts` / `crm_opportunities` (any data?)
  - Knowledge in `knowledge_docs` / `knowledge_chunks` (any articles? which domains?)
  - Performance metrics in `evidence_run_decisions` (decision distribution: auto_send vs needs_review vs blocked?)
  - Human tasks in `human_tasks` (any pending? escalation tracking?)

### 2. Identify Gaps (Team sync, 1 hour)
- [ ] For each of 6 Week 1 systems, document:
  - What backend exists (SQL queries, edge functions, RPCs)
  - What UI exists (which pages, which components)
  - What's missing (dashboard? status page? configuration UI?)
  - **Example:** 
    ```
    Data Integration Layer:
    - Backend: ✅ Zendesk sync_tickets (migration 017), Stripe template (mig 028), QB template (mig 028)
    - UI: ✅ Connectors page (connect/disconnect), ⚠️ No sync status dashboard
    - Missing: Dashboard showing last sync time, item counts, error log
    ```

### 3. Prioritize (Friday blocker-first)
- [ ] **CRITICAL PATH** (blocks Support Agent Week 8):
  1. Zendesk live proof (real tickets sync)
  2. Support knowledge ingestion (20+ articles)
  3. Performance dashboard (FCR, CSAT, TTR, escalation visible)
  4. Escalation configuration (who escalates to? SLA?)

- [ ] **HIGH** (blocks Billing Week 12):
  1. Stripe live proof (real transactions readable)
  2. QuickBooks live proof (real GL readable)
  3. Billing knowledge ingestion (10+ articles)

- [ ] **MEDIUM** (enables other roles, less urgent):
  1. Salesforce live proof
  2. Slack integration
  3. Knowledge organization by domain

---

## Wednesday: Frontend UI Builds

### Task Set 1: Connector Status Dashboard (Frontend team, 6 hours)
**Location:** New page or widget under Operations or Data Access  
**What to build:**
```
Card layout:
┌─────────────────────────────┐
│ Zendesk                     │
│ Status: ✅ Healthy          │
│ Last sync: 5 min ago        │
│ Items: 342 tickets          │
│ Last 24h: 18 new tickets    │
│ Action: [Sync Now]          │
└─────────────────────────────┘

┌─────────────────────────────┐
│ Stripe                      │
│ Status: ⚠️ Not Connected    │
│ Action: [Connect]           │
└─────────────────────────────┘
```

**Components to build:**
- [ ] ConnectorStatusCard component (health indicator, sync time, item count, sync button)
- [ ] ConnectorStatusDashboard page (list all connectors, group by status)
- [ ] Query: `select connector_id, category, last_ok_at, last_error_at, consecutive_failures from connectors`
- [ ] Sync counts: Join connector → connector_objects → real tables (support_tickets, etc.)

**Props & State:**
- [ ] connectorId, category, status, lastSyncTime, itemCount, lastError
- [ ] onSyncNow() handler → trigger `invoke_playbook_dispatch()` or manual sync function

**Acceptance Criteria:**
- [ ] Shows all 4 connectors (Zendesk, Stripe, QB, Salesforce)
- [ ] Refreshes on button click
- [ ] Shows real data (not mocks)
- [ ] No errors in browser console

---

### Task Set 2: Performance Dashboard Fixes (Frontend team, 4 hours)
**Location:** Existing Performance & Insights page  
**Current state:** Shows resolution, confidence, escalation, error, cost, CSAT  
**What's missing:** FCR, TTR, Quality Score, Policy Compliance, SLA Achievement, NPS

**For Friday, add at minimum:**
- [ ] **FCR (First Contact Resolution)**
  - Compute: `1 - (escalations / total_tickets) * 100`
  - Display: `65% FCR` with trend (↑ if week-over-week improvement)
  - Query: Count escalations vs total from `support_tickets` + `human_tasks`

- [ ] **TTR (Time to Resolution)**
  - Compute: Average `(completed_at - created_at)` for resolved tickets
  - Display: `2.3h median, 4.1h p95`
  - Query: Average from `support_tickets` where status = 'resolved'

- [ ] **Policy Compliance Rate**
  - Compute: `(decisions_without_violation / total_decisions) * 100`
  - Display: `100% compliance` (or list blocked decisions)
  - Query: Count guardrail_blocks from `audit_events`

- [ ] **Quality Score**
  - Compute: Pull from QA sampling or evidence feedback accuracy
  - Display: `91% quality` (or `—` if not yet available)
  - Query: Count accurate verdicts from `evidence_feedback` where verdict = 'accurate'

**Acceptance Criteria:**
- [ ] All 4 metrics show on dashboard (even if some say "Computing...")
- [ ] No hardcoded demo data
- [ ] Metrics update hourly or on manual refresh
- [ ] Thresholds color-coded (green >80%, yellow 60-80%, red <60%)

---

### Task Set 3: Playbook Template Library (Frontend team, 4 hours)
**Location:** Existing Playbooks page (add "Templates" tab or section)  
**What to build:**
```
Templates Tab:
┌─────────────────────────────────────────┐
│ Support Templates                       │
│ ┌─────────────────────────────────────┐ │
│ │ Resolve Support Ticket              │ │
│ │ Status: Draft                       │ │
│ │ "Baseline for handling support..."  │ │
│ │ [View] [Clone Template]             │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ Billing Templates                       │
│ ┌─────────────────────────────────────┐ │
│ │ Process Invoice & Follow Up         │ │
│ │ Status: Draft                       │ │
│ │ "Handle overdue invoicing..."       │ │
│ │ [View] [Clone Template]             │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

**To build:**
- [ ] TemplateCard component (title, status, description, view/clone buttons)
- [ ] TemplateLibrary page (list templates by domain)
- [ ] Clone function: Copy template → create draft → enable edit
- [ ] Filter by domain (Support, Billing, Sales, Finance, etc.)

**Data structure** (already exists in playbook_definitions):
- [ ] Query templates where `published=false` and `scope='template'`
- [ ] Display with domain tag

**Acceptance Criteria:**
- [ ] Support + Billing templates exist in DB (created manually if needed)
- [ ] Library page shows both templates
- [ ] "Clone" creates an editable copy
- [ ] Templates are read-only (can't edit original)

---

### Task Set 4: Escalation Configuration UI (Frontend team, 3 hours)
**Location:** DE profile > Settings or Governance tab  
**What to build:**
```
Escalation Configuration:
┌──────────────────────────────────────┐
│ Escalation Routes                    │
│                                      │
│ What triggers escalation?            │
│ ☐ Support Lead (Topic-based)         │
│ ☐ Founder (Billing questions)        │
│ ☐ Founder (Policy decisions)         │
│                                      │
│ Approval SLA                         │
│ ○ 4 hours (urgent)                  │
│ ○ 24 hours (standard)               │
│                                      │
│ [Save Configuration]                 │
└──────────────────────────────────────┘
```

**To build:**
- [ ] EscalationConfigPanel component (on DE profile)
- [ ] Checkboxes for escalation routes (read from DE config)
- [ ] Radio for SLA (4h, 24h, custom)
- [ ] Save → update `de_escalation_rules` (or new column)

**Data structure:**
- [ ] `digital_employees.escalation_routes` (JSONB): `{topics: [], always_escalate_to: 'founder', sla_hours: 24}`
- [ ] Query + update via existing `update_digital_employee()` RPC

**Acceptance Criteria:**
- [ ] Support Agent has routes configured (escalate to Support Lead by topic, or Founder)
- [ ] SLA shows on Human Tasks (e.g., "SLA in 2h 15m")
- [ ] Configuration persists (survives page reload)

---

## Thursday-Friday: Backend Integration + Testing

### Task Set 5: Connector Live Proof (Backend + Ops, 8 hours)

**Zendesk** (CRITICAL — Support Agent can't build without this)
- [ ] Connect Outsourcetel's Zendesk account OR create free trial
- [ ] Run `sync_tickets` → verify real tickets in DB
- [ ] Test: Pick 5 recent tickets, verify all fields (id, title, description, status, created_at match Zendesk)
- [ ] Run again 10 min later → verify new tickets synced, old ones unchanged (idempotency)
- [ ] Test error: Fake API key → verify error logged, didn't crash
- [ ] Document: Sync status, error log (if any), sample ticket IDs for testing

**Stripe** (CRITICAL — Billing Specialist can't build without this)
- [ ] Create Stripe test account OR use Outsourcetel's sandbox
- [ ] Authenticate OAuth2 → store token in `connector_secrets`
- [ ] Test `list_records` (transactions) → verify response parsing, count items
- [ ] Test `get_record` (one invoice) → verify amount, date, customer fields correct
- [ ] Test error: Expired token → verify error handled gracefully
- [ ] Document: Transaction IDs for golden-set testing Week 12

**QuickBooks** (CRITICAL — Billing Specialist can't build without this)
- [ ] Create QB sandbox OR use Outsourcetel's test company
- [ ] Authenticate OAuth2 → store token
- [ ] Test `list_records` (GL entries) → count items, verify account numbers
- [ ] Test `get_record` (one entry) → verify amount, date, account code
- [ ] Test error: Wrong company ID → verify error message clear
- [ ] Document: GL entry IDs for testing

**Salesforce** (HIGH — Sales Ops can't build without this)
- [ ] Create SF Dev Edition OR use Outsourcetel's org
- [ ] Authenticate OAuth2
- [ ] Test `search_records` (accounts) → verify pagination, search params work
- [ ] Test `get_record` (one opportunity) → verify amount, stage, close date
- [ ] Test error: Invalid SOQL → verify error handling
- [ ] Document: Opp IDs for testing

**Acceptance Criteria:**
- [ ] All 4 connectors: Auth works, data readable, errors handled, audit trail clean
- [ ] No credentials logged, all secrets encrypted
- [ ] Zero regression (existing tenants untouched)

---

### Task Set 6: Knowledge Ingestion (Knowledge team, 6 hours)

**Support Knowledge** (CRITICAL — Support Agent can't launch without this)
- [ ] Identify or create 20-30 Support KB articles:
  - Product overview (3-5 articles)
  - Common troubleshooting (5-8 articles)
  - FAQ (5-10 articles)
  - Policy/billing questions (3-5 articles)
  - Known issues (2-3 articles)
- [ ] Ingest into `knowledge_docs` (via UI Knowledge Library page or bulk upload)
- [ ] Mark domain: "Support"
- [ ] Spot-check: Random 5 articles, verify accuracy
- [ ] Measure: "Support KB: 25 articles, 100% reviewed" ✅

**Billing Knowledge** (HIGH — Billing Specialist can't launch without this)
- [ ] Create 10-15 Billing KB articles:
  - Billing policies (2-3 articles)
  - Refund policy (1 article)
  - Payment methods (1 article)
  - Tax rules (1 article)
  - Customer contracts (if available, 2-3 articles)
  - Collections procedures (2-3 articles)
  - Common questions (2-3 articles)
- [ ] Ingest into `knowledge_docs`
- [ ] Mark domain: "Billing"
- [ ] Spot-check: Random 3 articles, verify accuracy
- [ ] Measure: "Billing KB: 12 articles, 100% reviewed" ✅

**Acceptance Criteria:**
- [ ] Support: 20+ articles ingested, domain scoped, all <7 days since review
- [ ] Billing: 10+ articles ingested, domain scoped, all <7 days since review
- [ ] Can filter by domain (Support KB only, Billing KB only)
- [ ] Knowledge accessible via specialist-consult (tested: consult returns KB results)

---

## Friday EOD: Integration + Launch Readiness

### Checklist Before Support Agent Can Build (Week 2)

**Backend & Data:**
- [ ] Zendesk sync live (real tickets)
- [ ] Support knowledge 20+ articles
- [ ] Escalation configuration stored
- [ ] Performance metrics populating (even if trends are shallow yet)

**UI/UX (All discoverable):**
- [ ] Connector Status Dashboard shows healthy/degraded status
- [ ] Performance Dashboard shows ≥4 of 9 metrics (FCR, CSAT, TTR, Escalation)
- [ ] Playbook Templates visible (Support + Billing drafts exist)
- [ ] Escalation Configuration visible on DE profile (SLA configured)
- [ ] Knowledge Library shows Support domain (20+ articles)

**Measurement & Ops Readiness:**
- [ ] Outsourcetel operations team can see: "Support Agent will handle X%, escalate Y%, need Z KB articles"
- [ ] Someone can walk up to the dashboard and understand status in 30 seconds
- [ ] All metrics update automatically (no manual refreshes required)

### Deploy Checklist (Friday EOD)
- [ ] Connectors page updated (if needed)
- [ ] Performance page updated with new metrics
- [ ] Playbook library updated with templates
- [ ] DE profile UI updated with escalation config
- [ ] Knowledge Library updated with domain filtering
- [ ] No console errors on any of these pages
- [ ] TypeScript check passes (`tsc --noEmit`)
- [ ] Build succeeds (`vite build`)

### Commit & Push
- [ ] Commit: "feat: Week 1 foundation infrastructure — dashboards, templates, configuration"
- [ ] Push to main
- [ ] Tag: `week1-foundation` for reference

---

## If Anything Slips...

**BLOCKER for Week 2 (Support Agent build):**
- Zendesk live data sync
- Support knowledge (20+ articles)
- Performance dashboard (FCR, CSAT, Escalation visible)
- Escalation configuration UI

If any of these slip, Support Agent can't start building. Everything else can ship late.

**BLOCKER for Week 12 (Billing Specialist build):**
- Stripe + QuickBooks live proof
- Billing knowledge (10+ articles)

---

## Handoff Summary (Friday → Week 2)

When Support Agent build starts Monday Week 2, the platform should be:
- ✅ Connectors connected (Zendesk, Stripe, QB, Salesforce live)
- ✅ Dashboards live (operations visibility into metrics + sync status)
- ✅ Templates exist (Support + Billing drafts ready to evolve)
- ✅ Escalation paths defined (who escalates to whom? SLA?)
- ✅ Knowledge ready (20+ Support articles, 10+ Billing articles)

Everything is visible, measurable, configurable. No hidden machinery.

**Ready to build Support Agent.**
