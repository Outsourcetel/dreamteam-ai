# Week 2: Codebase Audit + Amendment Strategy
**What exists → What to amend → What to build new**

**Principle**: No duplicate work. Audit first, extend existing patterns.

---

## Part 1: Connector Configuration (What Exists)

### ✅ Existing: LiveConnectorsPage.tsx
**Location**: `src/pages/tenant/systems/LiveConnectorsPage.tsx`

**What it does:**
- ConnectWizard modal (provider selection → category → credentials → test)
- Category selection (helpdesk, crm, knowledge_base, etc.)
- Provider picker (30+ systems: Zendesk, Salesforce, Confluence, etc.)
- Credential input form (dynamically generated per provider from PROVIDERS config)
- Live test (`connectProvider()` RPC tests connection)
- Health status display (connected/degraded/down)

**Credential Input Pattern** (lines 245-300+):
```typescript
// Provider has 'fields' array defining what credentials to collect
// Example: Zendesk needs [email, api_token]
// Form renders input per field
// On submit: calls connectProvider() which invokes set_connector_secret RPC
```

**Key Functions**:
- `connectProvider()` — calls backend, stores secrets in connector_secrets table
- `updateConnectorFieldMap()` — map source fields to canonical fields
- `disconnectConnector()` — remove connection

**Status**: Production-ready, extensible

---

### ✅ Existing: ConnectorStatusDashboard.tsx (NEW THIS WEEK)
**Location**: `src/components/ConnectorStatusDashboard.tsx`

**What it does:**
- Displays all connectors by category (helpdesk, crm, knowledge_base)
- Status indicators (connected/degraded/down/never_connected)
- Last sync time (fmtSince)
- Item counts
- Error messages
- "Sync now" button

**Issue**: Built this week but only shows status. Doesn't integrate with LiveConnectorsPage yet.

**Amendment Needed**: Wire into LiveConnectorsPage (show dashboard below connector list)

---

### ✅ Existing: connectorApi.ts
**Location**: `src/lib/connectorApi.ts`

**Key exports**:
- `PROVIDERS`: Config for 30+ systems (label, fields, help, knowledgeSync, implemented)
- `connectProvider()`: RPC call to create connector + test + store secrets
- `listConnectors()`: Fetch all connectors for tenant
- `disconnectConnector()`: Remove connector
- `set_connector_secret()`: Store credential (called from connectProvider)
- `connectorHealth()`: Compute health status

**Pattern**: All secrets stored server-side via RPC. Never readable client-side. ✓ Secure.

---

## Part 2: Knowledge Ingestion (What Exists)

### ✅ Existing: KnowledgeIngestionPage.tsx
**Location**: `src/pages/tenant/knowledge/KnowledgeIngestionPage.tsx`

**What it does:**
- Connector discovery (list available connectors)
- Ingest filters (what to import: articles, FAQs, docs)
- Candidate selection (choose what to ingest)
- Ingestion workflow

**Status**: Likely needs review for multi-source ingestion (Salesforce, SharePoint, Google Docs, Notion, etc.)

---

### ✅ Existing: connectorApi.ts functions
- `listIngestCandidates()`: Browse what's available in a source
- `setIngestConfig()`: Configure what to ingest per connector
- `decideIngestCandidates()`: Choose which items to import

**Pattern**: Connector + ingest workflow already exists. ✓

---

## Part 3: Metrics Infrastructure (What Exists)

### ✅ Existing: Performance pages
**Location**: `src/pages/tenant/performance/` (multiple pages)

**What exists**:
- PerformancePage.tsx (metrics dashboard)
- InsightsPage.tsx (trend analysis)
- Real metric queries (mig 147: get_de_action_metrics)

**Status**: Likely needs enhancement for Support Agent metrics (FCR, CSAT, TTR, escalation %)

---

## Part 4: Escalation Configuration (What Exists)

### ✅ Existing: EscalationConfiguration.tsx (NEW THIS WEEK)
**Location**: `src/components/EscalationConfiguration.tsx`

**What it does**:
- Escalation route selection (checkboxes)
- SLA selection (dropdown)
- Save via RPC: `set_de_escalation_config()`

**Status**: Built this week but only basic version. Needs enhancement for:
- Multiple escalation rules (not just single route)
- Confidence-based escalation
- Sentiment-based escalation
- Topic-based escalation

**Amendment Needed**: Extend to support Sophie's 10-rule escalation system

---

## Part 5: DE Configuration (What Exists)

### ✅ Existing: WorkforceDEsPage.tsx
**Location**: `src/pages/tenant/WorkforceDEsPage.tsx`

**What it has**:
- DE profile tabs (multiple sections)
- Profile tab (identity, persona)
- Settings tab (existing but minimal)
- Performance tab
- Audit tab

**Amendment Needed**:
- Add "Authority" tab (refund limits, commitment rules)
- Extend "Settings" tab (knowledge sources, pre-approval rules)
- Add "Configuration" section (summary view)

---

## Part 6: Playbook System (What Exists)

### ✅ Existing: PlaybookBuilder/PlaybooksPage.tsx
**Location**: `src/pages/tenant/systems/PlaybooksPage.tsx`

**What it has**:
- Playbook creation/editing UI
- Step definition (conditionals, branching)
- Playbook templates (from PB2.0)

**Status**: Production-ready for playbook implementation (Week 4)

---

## Summary: What to Build vs Amend

| Component | Status | Action |
|-----------|--------|--------|
| **Connector Config** | ✅ Exists (LiveConnectorsPage) | **Amend**: Add Zendesk credential form + tenant-level setup wizard |
| **Connector Status** | ✅ Built (ConnectorStatusDashboard) | **Integrate**: Wire into LiveConnectorsPage |
| **Knowledge Ingestion** | ✅ Exists (KnowledgeIngestionPage) | **Test**: Verify multi-source ingestion (8 sources) |
| **Metrics Infrastructure** | ✅ Exists (PerformancePage) | **Enhance**: Add FCR, CSAT, TTR, escalation % metrics |
| **Escalation Config** | ✅ Built (EscalationConfiguration) | **Extend**: Support 10 rules (confidence, sentiment, topic-based) |
| **DE Configuration** | ⏳ Partial (WorkforceDEsPage) | **Expand**: Add Authority, Knowledge, Pre-Approval tabs |
| **Playbook System** | ✅ Exists | **Use**: Ready for Sophie playbook Week 4 |

---

## Amendment #1: Tenant-Level Connector Configuration UI

### What to Build
A **ConnectorConfigurationPanel** component that:
1. Shows all available connectors (30+ systems)
2. Lets tenant enable/disable per connector
3. Opens credential form for Zendesk (+ others)
4. Shows status + last sync time
5. Has "Configure Now" vs "Configure Later" option

### Where to Build
File: `src/components/TenantConnectorConfig.tsx` (new)

### Integration
- Add as a tab in WorkforceDEsPage or standalone page
- Let user configure when ready (no forced credentials)
- Save state per tenant

### Code Pattern (Reuse)
```typescript
// Reuse existing patterns from LiveConnectorsPage:
- PROVIDERS config
- connectProvider() RPC
- set_connector_secret() pattern
- ConnectWizard modal (or adapt it)

// New: Tenant-level UI (vs. system-wide UI)
- Checkbox: "Enable Zendesk for this tenant"
- When checked: show credential form (reuse from LiveConnectorsPage)
- Show status: "Not configured" → "Connected" → "Syncing"
```

---

## Amendment #2: Enhanced Escalation Configuration

### Current State
`EscalationConfiguration.tsx` (built this week):
- Single escalation route
- Single SLA

### Needed: Multi-Rule System
- Rule 1: Topic-based (billing → Finance)
- Rule 2: Confidence-based (< 50% → Support Lead)
- Rule 3: Sentiment-based (angry → Manager)
- Rule 4-10: Custom rules

### How to Amend
File: `src/components/SophieEscalationRules.tsx` (new, replaces simple version)

```typescript
// Extend data model:
interface EscalationRule {
  id: string;
  rule_type: 'topic' | 'confidence' | 'sentiment' | 'custom';
  condition: string; // "topic='billing'" or "confidence<50"
  action: string; // "escalate_to=finance_lead"
  sla_hours?: number;
}

// Extend UI:
- List of rules (add/edit/delete)
- Rule type selector
- Condition builder (domain-specific per type)
- Action picker (Finance Lead, Manager, Support, Founder, etc.)
- SLA input
```

---

## Amendment #3: DE Authority Configuration Tab

### What to Build
File: `src/components/DEAuthorityPanel.tsx` (new)

### Where to Integrate
WorkforceDEsPage.tsx → Add new tab: "Authority"

### Content
```
┌────────────────────────┐
│ Refund Authority       │
│ Up to: [$____] ← input │
│ Above: Escalate to [__]│
│                        │
│ Commitment Rules       │
│ [+ Add Rule]           │
│ Rule 1: [if/then]      │
│ Rule 2: [if/then]      │
└────────────────────────┘
```

### Pattern (Reuse)
Use same form pattern as EscalationConfiguration (checkboxes, dropdowns, save)

---

## Amendment #4: DE Knowledge Scope Tab

### What to Build
File: `src/components/DEKnowledgeScopePanel.tsx` (new)

### Where to Integrate
WorkforceDEsPage.tsx → Add new tab: "Knowledge"

### Content
```
┌────────────────────────────────────────┐
│ Knowledge Sources                      │
│ ☑ Salesforce (connected)               │
│   Last sync: 2026-07-19 10:15 AM      │
│   [Re-sync Now]                       │
│                                        │
│ ☑ SharePoint (connected)               │
│   [Re-sync Now]                       │
│                                        │
│ ○ Zendesk (not connected)              │
│   [Connect Now]                       │
│                                        │
│ ○ Notion (disabled)                    │
│   [Enable]                            │
│                                        │
│ [Save Configuration]                   │
└────────────────────────────────────────┘
```

### Reuse
- Use connectorApi.ts to list available connectors
- Show connectivity status from `list_connectors()`
- Use "Configure Now" / "Configure Later" pattern

---

## Amendment #5: DE Pre-Approval Rules Tab

### What to Build
File: `src/components/DEPreApprovalRulesPanel.tsx` (new)

### Where to Integrate
WorkforceDEsPage.tsx → Add new tab: "Approval Rules"

### Content
```
┌────────────────────────────────────────┐
│ Pre-Approval Strategy                  │
│ ○ Review ALL (safest)                  │
│ ● Rule-based (see below)               │
│ ○ Never review (fastest)               │
│                                        │
│ Active Rules:                          │
│ [☑] Confidence < 80% → require review  │
│ [☑] Response type = refund → review    │
│ [☑] Customer tier = enterprise → review│
│ [☐] Response length > 500 words        │
│                                        │
│ Timeout: [30] minutes                  │
│ On timeout: ● Escalate / ○ Send       │
│                                        │
│ [Save Configuration]                   │
└────────────────────────────────────────┘
```

### Pattern (Reuse)
Same form pattern (checkboxes, inputs, save)

---

## Amendment #6: Sophie Configuration Summary Page

### What to Build
File: `src/components/SophieConfigurationSummary.tsx` (new)

### Where to Integrate
WorkforceDEsPage.tsx → New tab: "Configuration"

### Shows
- Identity (name, avatar)
- Authority (refund limit, commitment rules)
- Knowledge (sources synced)
- Escalation (routing rules)
- Pre-Approval (approval rules)
- Audit log (who changed what, when)

---

## Implementation Sequence (No Duplication)

### Week 3: Amend Existing
1. ✅ Wire ConnectorStatusDashboard into LiveConnectorsPage
2. ✅ Extend EscalationConfiguration → SophieEscalationRules (multi-rule)
3. ✅ Add new tabs to WorkforceDEsPage:
   - Authority (refund, commitment)
   - Knowledge (sources)
   - Approval (pre-approval rules)
   - Configuration (summary)
4. ✅ Build TenantConnectorConfig UI (tenant-level configuration)

### Week 4: Build Playbook
1. Use existing PlaybookBuilder
2. Implement Sophie's 6-step playbook

### Week 5: Build Metrics
1. Extend existing PerformancePage metrics
2. Add FCR, CSAT, TTR, escalation %

---

## No Duplicate Work Principle

**Before building anything**:
- [ ] Grep codebase for similar component
- [ ] Check if pattern exists (form, modal, RPC)
- [ ] Reuse existing imports/types
- [ ] Extend, don't rebuild

**Example**: EscalationConfiguration existed as simple version. Instead of rebuilding from scratch, we extend it to multi-rule system.

---

## Files: Existing to Reuse

| File | What to Reuse |
|------|--------------|
| connectorApi.ts | PROVIDERS, connectProvider(), set_connector_secret pattern |
| LiveConnectorsPage.tsx | ConnectWizard modal, credential form rendering |
| connectorApi.ts | listConnectors(), updateConnectorFieldMap() |
| EscalationConfiguration.tsx | Form pattern (checkboxes, save) |
| WorkforceDEsPage.tsx | Tab structure, nested components |
| PerformancePage.tsx | Metric display pattern |
| PlaybookBuilder | Playbook creation infrastructure |

---

## Files: New to Create (No Duplicates)

| File | Purpose |
|------|---------|
| TenantConnectorConfig.tsx | Tenant-level connector selection + credential entry |
| SophieEscalationRules.tsx | Multi-rule escalation (extends EscalationConfiguration pattern) |
| DEAuthorityPanel.tsx | Refund limits + commitment rules |
| DEKnowledgeScopePanel.tsx | Knowledge source selection |
| DEPreApprovalRulesPanel.tsx | Approval rules (which responses need review) |
| SophieConfigurationSummary.tsx | At-a-glance config view + audit trail |
| supportMetricsApi.ts | (Already designed, needs implementation) |
| METRICS_SQL_FUNCTIONS.sql | (Already designed, needs implementation) |

---

## Red Flags: Duplicate Work to Avoid

❌ **DON'T**: Rebuild connector UI
✅ **DO**: Extend LiveConnectorsPage / use ConnectWizard

❌ **DON'T**: Create new escalation rules system
✅ **DO**: Extend EscalationConfiguration pattern to multi-rule

❌ **DON'T**: New metrics dashboard
✅ **DO**: Extend PerformancePage with new queries

❌ **DON'T**: New knowledge ingestion page
✅ **DO**: Extend KnowledgeIngestionPage for multi-source

---

## Status: Ready for Week 3

All amendments are **extensions** of existing patterns. No duplicate work.

- Existing infrastructure is solid
- Clear amendment points identified
- Reusable patterns documented
- Ready to build without duplication

✓ No credential asks (UI-driven configuration)
✓ No duplicate work (amend + extend)
