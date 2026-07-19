# Sophie Configuration Framework
**Customer-Configurable Support Agent Identity & Authority**

**Status**: Design (ready to implement Week 3)  
**Impact**: Turns "Sophie" from hardcoded DE into tenant-customizable platform feature  
**Architecture**: DE charter + playbook + escalation rules (existing schema, mig 098+)

---

## Overview

Sophie isn't one fixed Support Agent. Each Outsourcetel customer (tenant) gets to configure:
1. ✅ Sophie's name (rename to "Support Assistant", "Help Desk Bot", etc.)
2. ✅ Refund authority (up to $X without approval)
3. ✅ Commitment authority (promise delivery dates: yes/no/rule-based)
4. ✅ Knowledge sources (which systems to consult: Salesforce? SharePoint? All?)
5. ✅ Escalation routing (escalate to Support, Lead, Manager, or custom)
6. ✅ Pre-approval rules (which response types require human review before sending)

This makes Sophie **a product, not a demo**. Outsourcetel can customize Sophie for each customer's needs.

---

## Part 1: Sophie's Identity Configuration

### UI Component: `SophieIdentityPanel.tsx`

**Location in App**: Tenant Settings → Digital Employees → Sophie → Edit Identity

**Form Fields:**

```
┌─────────────────────────────────────────┐
│  Sophie Identity Configuration          │
├─────────────────────────────────────────┤
│                                         │
│  Display Name                           │
│  [Support Specialist        ________]   │
│  (customers can rename Sophie)          │
│                                         │
│  Avatar/Icon (optional)                 │
│  [Upload image or emoji]                │
│                                         │
│  Public Role Description                │
│  [Sophie helps resolve issues...]       │
│  (shown to customers in widget)         │
│                                         │
│  Internal Notes                         │
│  [For your team's reference]            │
│                                         │
│  [Save Configuration]                   │
│                                         │
└─────────────────────────────────────────┘
```

**Backend Storage**:
```sql
UPDATE digital_employees 
SET 
  display_name = 'Support Specialist',  -- customer's chosen name
  avatar_url = 'https://...',           -- customer's avatar
  description = 'Helps resolve...',     -- customer's description
  metadata = {
    'internal_notes': 'Always escalate billing...',
    'tenant_customized': true
  }
WHERE id = sophie_de_id 
  AND tenant_id = current_tenant_id;
```

---

## Part 2: Sophie's Authority Configuration

### UI Component: `SophieAuthorityPanel.tsx`

**Location**: Tenant Settings → Digital Employees → Sophie → Authority

**Form Sections:**

#### Section A: Refund Authority
```
┌─────────────────────────────────────────┐
│  Refund Policy                          │
├─────────────────────────────────────────┤
│                                         │
│  Maximum refund without approval:       │
│  [$1000.00        ________]             │
│                                         │
│  Above this amount:                     │
│  ○ Always escalate to manager           │
│  ○ Escalate based on customer tier      │
│                                         │
│  [Save] [Test Policy] [View Audit]      │
│                                         │
└─────────────────────────────────────────┘
```

**Backend Storage**:
```sql
INSERT INTO de_escalation_rules (
  de_id, rule_type, condition, action, threshold
) VALUES (
  sophie_de_id,
  'refund_authority',
  'amount > 1000',
  'escalate_to_manager',
  NULL
);
```

#### Section B: Commitment Authority (Delivery Dates)
```
┌─────────────────────────────────────────┐
│  Delivery Date Commitments              │
├─────────────────────────────────────────┤
│                                         │
│  Can Sophie promise delivery dates?     │
│  ○ Never (always escalate to PM)        │
│  ● Rule-based (see rules below)         │
│  ○ Yes (Sophie can commit)              │
│                                         │
│  If "Rule-based", define conditions:    │
│  ┌─────────────────────────────────┐   │
│  │ Rule 1: Bug fixes               │   │
│  │ If: issue_type = "bug_fix"      │   │
│  │ Then: Can promise <24 hour fix  │   │
│  │                                 │   │
│  │ Rule 2: Feature requests        │   │
│  │ If: issue_type = "feature_req"  │   │
│  │ Then: Always escalate to PM     │   │
│  │                                 │   │
│  │ [+ Add Rule]                    │   │
│  └─────────────────────────────────┘   │
│                                         │
│  [Save] [Test Rules]                    │
│                                         │
└─────────────────────────────────────────┘
```

**Backend Storage**:
```sql
INSERT INTO de_escalation_rules (
  de_id, rule_type, condition, action
) VALUES 
  (sophie_de_id, 'commitment', 'issue_type="bug_fix"', 'can_commit'),
  (sophie_de_id, 'commitment', 'issue_type="feature_request"', 'escalate_to_pm');
```

---

## Part 3: Sophie's Knowledge Scope Configuration

### UI Component: `SophieKnowledgeSourcesPanel.tsx`

**Location**: Tenant Settings → Digital Employees → Sophie → Knowledge Sources

**Form Sections:**

```
┌─────────────────────────────────────────┐
│  Knowledge Sources                      │
│  (Choose which systems Sophie consults) │
├─────────────────────────────────────────┤
│                                         │
│  ☑ Salesforce (Accounts & Contacts)    │
│    Last sync: 2026-07-19 10:15 AM      │
│    Items: 4,523 accounts, 8,291 contacts
│    [Re-sync Now]                       │
│                                         │
│  ☑ SharePoint                           │
│    Last sync: 2026-07-18 03:00 AM      │
│    Items: 127 documents                │
│    [Re-sync Now]                       │
│                                         │
│  ☑ Google Workspace                     │
│    Last sync: 2026-07-19 08:30 AM      │
│    Items: 89 Drive files                │
│    [Re-sync Now]                       │
│                                         │
│  ☑ Notion                               │
│    Last sync: 2026-07-19 09:00 AM      │
│    Items: 256 pages                    │
│    [Re-sync Now]                       │
│                                         │
│  ☑ Confluence                           │
│    Last sync: Never                    │
│    [Connect Now]                       │
│                                         │
│  ☑ Wiki                                 │
│    Last sync: Never                    │
│    [Connect Now]                       │
│                                         │
│  ☑ Microsoft Office Docs                │
│    Last sync: Never                    │
│    [Connect Now]                       │
│                                         │
│  ☑ Images & Screenshots                │
│    Last sync: Never                    │
│    [Connect Now]                       │
│                                         │
│  [Save Configuration]                   │
│                                         │
└─────────────────────────────────────────┘
```

**Backend Storage**:
```sql
UPDATE digital_employees 
SET 
  knowledge_scope = {
    'sources': [
      {'provider': 'salesforce', 'enabled': true, 'last_sync': '2026-07-19T10:15:00Z'},
      {'provider': 'sharepoint', 'enabled': true, 'last_sync': '2026-07-18T03:00:00Z'},
      {'provider': 'google_drive', 'enabled': true, 'last_sync': '2026-07-19T08:30:00Z'},
      {'provider': 'notion', 'enabled': true, 'last_sync': '2026-07-19T09:00:00Z'},
      {'provider': 'confluence', 'enabled': false, 'last_sync': null},
      {'provider': 'wiki', 'enabled': false, 'last_sync': null},
      {'provider': 'microsoft_office', 'enabled': false, 'last_sync': null},
      {'provider': 'images', 'enabled': false, 'last_sync': null}
    ]
  }
WHERE id = sophie_de_id AND tenant_id = current_tenant_id;
```

**Important**: Knowledge ingestion is triggered separately (Week 3 work). This just tells Sophie which sources to consult.

---

## Part 4: Sophie's Escalation Routing Configuration

### UI Component: `SophieEscalationRoutingPanel.tsx`

**Location**: Tenant Settings → Digital Employees → Sophie → Escalation Routes

**Form Sections:**

```
┌──────────────────────────────────────────┐
│  Escalation Routing Rules                │
│  (Where does Sophie send tricky issues?) │
├──────────────────────────────────────────┤
│                                          │
│  Default escalation target:              │
│  ○ Support Lead                          │
│  ○ Customer's Support Manager            │
│  ● Custom (define below)                 │
│                                          │
│  Rule 1: Topic-Based Escalation          │
│  If topic = "Billing" → escalate to      │
│    [Finance Lead          ________]      │
│                                          │
│  Rule 2: Topic-Based Escalation          │
│  If topic = "Refund" → escalate to       │
│    [Finance Manager       ________]      │
│                                          │
│  Rule 3: Confidence-Based Escalation     │
│  If confidence < 50% → escalate to       │
│    [Support Specialist    ________]      │
│                                          │
│  Rule 4: Complaint Detection             │
│  If customer_sentiment = "angry" →       │
│  escalate to [Support Manager ________]  │
│                                          │
│  Rule 5: Custom Rule                     │
│  If [issue_type = "data_export"   ]      │
│  Then escalate to [Security Team _]      │
│                                          │
│  [+ Add Rule] [- Remove] [Reorder]       │
│                                          │
│  Escalation SLA (hours to respond):      │
│  Urgent: [4        ]                     │
│  Standard: [24      ]                    │
│                                          │
│  [Save Configuration]                    │
│                                          │
└──────────────────────────────────────────┘
```

**Backend Storage**:
```sql
INSERT INTO de_escalation_rules (
  de_id, tenant_id, rule_type, condition, action, sla_hours
) VALUES 
  (sophie_de_id, tenant_id, 'topic', 'topic="billing"', 'escalate_to=finance_lead', NULL),
  (sophie_de_id, tenant_id, 'topic', 'topic="refund"', 'escalate_to=finance_manager', NULL),
  (sophie_de_id, tenant_id, 'confidence', 'confidence<50', 'escalate_to=support_specialist', NULL),
  (sophie_de_id, tenant_id, 'sentiment', 'sentiment="angry"', 'escalate_to=support_manager', 4),
  (sophie_de_id, tenant_id, 'custom', 'issue_type="data_export"', 'escalate_to=security_team', 24);
```

---

## Part 5: Sophie's Pre-Approval Rules Configuration

### UI Component: `SophiePreApprovalRulesPanel.tsx`

**Location**: Tenant Settings → Digital Employees → Sophie → Response Approval Rules

**Form Sections:**

```
┌──────────────────────────────────────────┐
│  Pre-Approval Rules                      │
│  (When must humans review before send?)  │
├──────────────────────────────────────────┤
│                                          │
│  Pre-Approval Strategy:                  │
│  ○ Review ALL responses (safest)         │
│  ● Rule-based (see below)                │
│  ○ Never review (fastest)                │
│                                          │
│  If "Rule-based", define when to review: │
│                                          │
│  Rule 1: Confidence Threshold            │
│  If confidence < [80%      ] → review    │
│                                          │
│  Rule 2: Response Type                   │
│  ☑ Always review: refund offers         │
│  ☑ Always review: escalations           │
│  ☑ Always review: apologies/complaints  │
│  ☐ Always review: data access requests  │
│                                          │
│  Rule 3: Customer Tier                   │
│  If customer_tier = "Enterprise" →       │
│  ☑ Review all responses                 │
│                                          │
│  Rule 4: Sentiment                       │
│  If detected_sentiment = "angry" →       │
│  ☑ Review response before send           │
│                                          │
│  [+ Add Rule]                            │
│                                          │
│  Max response time for review:           │
│  [30        ] minutes                    │
│                                          │
│  If review timeout, what to do?          │
│  ○ Send anyway (risky)                  │
│  ● Escalate instead (safe)               │
│                                          │
│  [Save Configuration]                    │
│                                          │
└──────────────────────────────────────────┘
```

**Backend Storage**:
```sql
INSERT INTO de_approval_rules (
  de_id, tenant_id, rule_type, condition, requires_approval
) VALUES 
  (sophie_de_id, tenant_id, 'confidence', 'confidence<80', true),
  (sophie_de_id, tenant_id, 'response_type', 'type="refund_offer"', true),
  (sophie_de_id, tenant_id, 'response_type', 'type="escalation"', true),
  (sophie_de_id, tenant_id, 'customer_tier', 'tier="enterprise"', true),
  (sophie_de_id, tenant_id, 'sentiment', 'sentiment="angry"', true);
```

---

## Part 6: Configuration Summary & Testing

### UI Component: `SophieConfigurationSummary.tsx`

**Shows current configuration at a glance:**

```
┌──────────────────────────────────────────┐
│  Sophie Configuration Summary            │
├──────────────────────────────────────────┤
│                                          │
│  Identity:                               │
│  Name: Sophie (customer can rename)      │
│  Avatar: [shows current]                 │
│                                          │
│  Authority:                              │
│  Refunds: Up to $1000 without approval   │
│  Delivery dates: Rule-based (3 rules)    │
│                                          │
│  Knowledge:                              │
│  Sources: Salesforce, SharePoint, Notion│
│  Last sync: 2026-07-19 10:15 AM          │
│  Items indexed: 13,265                   │
│                                          │
│  Escalation:                             │
│  Routing rules: 5 active                 │
│  Default escalation: Support Lead        │
│  Urgent SLA: 4 hours                     │
│                                          │
│  Pre-Approval:                           │
│  Strategy: Rule-based                    │
│  Active rules: 5                         │
│  Review timeout: 30 minutes               │
│                                          │
│  [Edit All Settings] [View Audit Log]    │
│  [Run Configuration Test] [Export]       │
│                                          │
└──────────────────────────────────────────┘
```

---

## Implementation Roadmap

### Week 3: Customer Configuration UIs
- ✅ Build `SophieIdentityPanel.tsx`
- ✅ Build `SophieAuthorityPanel.tsx`
- ✅ Build `SophieKnowledgeSourcesPanel.tsx`
- ✅ Build `SophieEscalationRoutingPanel.tsx`
- ✅ Build `SophiePreApprovalRulesPanel.tsx`
- ✅ Build `SophieConfigurationSummary.tsx`

### Week 3: Backend Integration
- ✅ Wire UI forms to `digital_employees.charter` + related tables
- ✅ Implement RPC: `update_de_configuration()`
- ✅ Implement RPC: `test_de_configuration()` (dry-run escalations)
- ✅ Add audit logging (track config changes)

### Week 4: Playbook Integration
- ✅ Wire playbook to respect `de_escalation_rules`
- ✅ Wire playbook to respect `de_approval_rules`
- ✅ Test: scenario → apply rules → verify correct routing

### Week 5: Testing
- ✅ Test all configuration scenarios
- ✅ Test edge cases (conflicting rules? timeout handling?)
- ✅ Customer training docs

---

## Default Configuration (Outsourcetel Reference)

For Outsourcetel's internal use (customer-configurable, but here's what we suggest):

```yaml
Sophie_Configuration_Outsourcetel:
  identity:
    display_name: "Sophie"
    avatar: "support-agent-emoji.png"
    description: "I'm Sophie, your support assistant. I resolve issues using our knowledge base and escalate when needed."
  
  authority:
    refund_limit: 1000  # up to $1000
    commitment_rules:
      - if: issue_type == "bug_fix"
        then: can_promise_24hr_fix
      - if: issue_type == "feature_request"
        then: escalate_to_pm
  
  knowledge_sources:
    - salesforce (enabled)
    - sharepoint (enabled)
    - google_drive (enabled)
    - notion (enabled)
    - confluence (disabled, can enable)
    - wiki (disabled, can enable)
  
  escalation_routing:
    default: support_lead
    rules:
      - if: topic == "billing" then: finance_lead
      - if: topic == "refund" then: finance_manager
      - if: confidence < 50% then: support_specialist
      - if: sentiment == "angry" then: support_manager
  
  pre_approval:
    strategy: "rule_based"
    rules:
      - if: confidence < 80% then: require_review
      - if: response_type == "refund_offer" then: require_review
      - if: response_type == "escalation" then: require_review
      - if: customer_tier == "enterprise" then: require_review
    timeout_minutes: 30
    on_timeout: escalate_instead
```

---

## Key Design Decisions

1. **Tenant-Customizable, Not Hardcoded**
   - Sophie's identity, authority, rules are per-tenant
   - Outsourcetel can modify, test, and publish configs
   - Becomes competitive advantage (customer sees their own rules enforced)

2. **Configuration UI Before Go-Live**
   - Week 3: Build configuration panels
   - Week 4-5: Test all scenarios
   - Week 8: Customers can customize before live deployment

3. **Audit Trail**
   - Every config change logged
   - Can see who changed what when
   - Can roll back if needed

4. **Testing & Dry-Run**
   - `test_de_configuration()` RPC: run escalation logic without actually escalating
   - Customers can validate rules work before go-live

5. **Extensibility**
   - New rule types can be added (new conditions, new actions)
   - Playbook can check rules at decision points
   - Guardrails enforced server-side (no sneaking around)

---

## Success Criteria (Week 8 Go-Live)

- ✅ Outsourcetel team can configure Sophie's identity
- ✅ Outsourcetel team can configure refund authority
- ✅ Outsourcetel team can configure commitment rules
- ✅ Outsourcetel team can configure knowledge sources
- ✅ Outsourcetel team can configure escalation routes
- ✅ Outsourcetel team can configure pre-approval rules
- ✅ All rules tested and working
- ✅ Configuration audit trail complete

When customers license playbooks from Outsourcetel, they get:
- **Proven Sophie configuration** (templates from Outsourcetel's settings)
- **Customization UI** (they can modify for their own needs)
- **Documentation** (how to configure Sophie for their use case)

This turns Sophie into a **product, not a demo**.

---

**Status**: Design ready for Week 3 implementation ✓  
**Dependencies**: None (independent of Stream 2 Zendesk work)  
**Blocking**: Nothing (UI can be built in parallel with playbook/metrics)
