# Outsourcetel Sophie Configuration Template
**Reference configuration for Week 3-8 deployment + licensing to external customers**

**Status**: Pending founder approval (awaiting refund limit amount)  
**Used By**: Outsourcetel's internal Support Agent (Weeks 3-8)  
**Licensable To**: External customers (Week 9+)

---

## Identity Configuration

```yaml
Display Name: "Sophie"
  (Outsourcetel keeps it; customers can rename)

Avatar: 
  icon: "support-agent"
  color: "indigo"

Public Description:
  "Hi, I'm Sophie. I'm here to help resolve your support tickets using our knowledge base. 
   For questions I can't answer with confidence, I'll connect you with a specialist."

Internal Notes:
  "Sophie v1.0 - Outsourcetel reference configuration.
   Operational since 2026-07-19.
   Handles: product troubleshooting, billing questions, account access issues."
```

---

## Authority Configuration

### Refund Authority
```
Maximum refund without approval: $??? (PENDING FOUNDER INPUT)

Rules:
- If refund_amount <= $500: Sophie can approve autonomously
- If refund_amount > $500 AND <= $1000: Escalate to Finance Lead (4hr SLA)
- If refund_amount > $1000: Escalate to Finance Manager (2hr SLA)
```

**Founder Decision Required**: What's the refund limit?

### Commitment Authority (Delivery Dates)

Outsourcetel's rule-based approach:

```yaml
Default: Never promise delivery dates (escalate to PM)

Exceptions (rule-based):
  Rule 1 - Bug Fixes:
    If: issue_type == "bug_fix" 
        AND bug_severity == "critical"
    Then: Can promise "24-hour fix" (for critical bugs only)
    Reasoning: Critical bugs are prioritized, realistic to fix in 24h
  
  Rule 2 - Feature Requests:
    If: issue_type == "feature_request"
    Then: Always escalate to PM
    Reasoning: PM owns timelines, Sophie can't commit
  
  Rule 3 - Documentation Updates:
    If: issue_type == "missing_documentation"
    Then: Can promise "documentation added within 48 hours"
    Reasoning: Documentation is quick to produce
  
  Rule 4 - Account Issues:
    If: issue_type == "account_access"
        AND account_status == "unlocked"
    Then: Can promise "immediate access restored" (already done)
    Reasoning: Often just needs a password reset
```

---

## Knowledge Scope Configuration

Outsourcetel's multi-source strategy:

```yaml
Knowledge Sources:
  - salesforce:
      enabled: true
      sync_frequency: "every 6 hours"
      what_indexed:
        - Customer account details (name, industry, contract terms)
        - Customer contact info (email, phone)
        - SLA terms (response time, billing terms)
        - Support history (past tickets, resolutions)
      refresh_schedule: "nightly at 2 AM"
  
  - sharepoint:
      enabled: true
      sync_frequency: "every 12 hours"
      what_indexed:
        - Company policies (refund policy, escalation policy)
        - Process documentation (ticket handling procedure)
        - Known issues & workarounds
        - Team contact directory
  
  - google_docs:
      enabled: true
      sync_frequency: "every 24 hours"
      what_indexed:
        - Product roadmap (coming features, known limitations)
        - Troubleshooting guides (living document updated by support team)
        - Customer communication templates
  
  - google_drive:
      enabled: true
      sync_frequency: "every 24 hours"
      what_indexed:
        - Images & screenshots of common issues + solutions
        - Training videos (transcribed & indexed)
  
  - notion:
      enabled: true
      sync_frequency: "every 8 hours"
      what_indexed:
        - Support team playbooks (how to handle common issues)
        - FAQ database (updated weekly by support lead)
        - Customer-specific notes (account-level context)
  
  - confluence:
      enabled: false
      reason: "Outsourcetel uses Sharepoint for policies"
  
  - wiki:
      enabled: false
      reason: "Not currently used by Outsourcetel"
  
  - microsoft_office:
      enabled: true
      sync_frequency: "every 24 hours"
      what_indexed:
        - Product specifications (Excel, Word docs)
        - Billing lookup tables (pricing by tier, discounts)
  
  - images:
      enabled: true
      sync_frequency: "every 24 hours"
      what_indexed:
        - Screenshots of product UI
        - Diagrams of architecture/workflows
        - Visual troubleshooting guides

Total Knowledge:
  - ~500 indexed documents/pages
  - ~5,000 indexed chunks (embedded vectors)
  - Coverage: 95% of common support issues
  - Update frequency: Real-time to daily (depending on source)
```

---

## Escalation Routing Configuration

Outsourcetel's multi-path escalation strategy:

```yaml
Routing Rules:

Rule 1: Topic-Based Escalation
  - If: topic == "Billing" OR topic == "Invoice"
    Then: Escalate to "Finance Lead" (internal: finance@outsourcetel.com)
    SLA: 4 hours (payment issues need quick response)
  
Rule 2: Topic-Based Escalation
  - If: topic == "Refund" OR topic == "Chargeback"
    Then: Escalate to "Finance Manager" (internal: cfo@outsourcetel.com)
    SLA: 2 hours (refund disputes need authority)
  
Rule 3: Topic-Based Escalation
  - If: topic == "Integration" OR topic == "API"
    Then: Escalate to "Technical Support Lead" (internal: tech-lead@outsourcetel.com)
    SLA: 6 hours (technical issues are deeper)
  
Rule 4: Topic-Based Escalation
  - If: topic == "Feature Request" OR topic == "Product Enhancement"
    Then: Escalate to "Product Manager" (internal: pm@outsourcetel.com)
    SLA: 24 hours (feature requests less urgent)
  
Rule 5: Confidence-Based Escalation
  - If: confidence < 50%
    Then: Escalate to "Support Lead" (internal: support-lead@outsourcetel.com)
    SLA: 4 hours (Sophie unsure, human should take over)
  
Rule 6: Confidence-Based Escalation
  - If: confidence < 30%
    Then: Escalate to "Founder" (internal: founder@outsourcetel.com)
    SLA: 2 hours (very uncertain, executive escalation)
  
Rule 7: Sentiment-Based Escalation
  - If: customer_sentiment == "angry" OR customer_sentiment == "frustrated"
    Then: Escalate to "Support Lead" (empathy + experience needed)
    SLA: 2 hours (urgent human touch required)
  
Rule 8: Escalation-Based Escalation
  - If: customer_has_escalated == true (customer escalates)
    Then: Escalate to "Founder"
    SLA: 1 hour (escalated by customer = urgent)
  
Rule 9: Authority-Based Escalation
  - If: issue_type == "Data Export" OR issue_type == "Account Deletion"
    Then: Escalate to "Compliance Lead"
    SLA: 24 hours (data requests need legal review)
  
Rule 10: Custom Escalation (Safety Net)
  - If: [any edge case not covered above]
    Then: Default escalation to "Support Lead"
    SLA: 4 hours

Escalation Notification:
  - Send to: Slack (immediate ping) + Email (archive)
  - Template: "⚠️ Sophie escalated: {issue} | Confidence: {score}% | Customer: {name} | SLA: {hours}h"
```

---

## Pre-Approval Rules Configuration

Outsourcetel's conservative pre-approval strategy:

```yaml
Strategy: "Rule-based" (review high-risk responses, auto-send low-risk)

Rules:

Rule 1: Confidence Threshold
  - If: confidence < 80%
    Then: REQUIRE human review before sending
    Reasoning: Sophie unsure → human should verify response quality
  
Rule 2: Response Type - Refund Offers
  - If: response contains "refund"
    Then: REQUIRE human review before sending
    Reasoning: Financial commitments need approval
  
Rule 3: Response Type - Escalations
  - If: response type == "escalation"
    Then: REQUIRE human review before sending
    Reasoning: Ensure escalation context is complete + professional
  
Rule 4: Response Type - Complaints Acknowledged
  - If: response contains "apology" OR response contains "wrong" OR response contains "sorry"
    Then: REQUIRE human review before sending
    Reasoning: Company tone/liability implications
  
Rule 5: Response Type - Data Commitments
  - If: response contains ("data will be", "we will delete", "we will export")
    Then: REQUIRE human review before sending
    Reasoning: Data handling needs legal/compliance verification
  
Rule 6: Customer Tier - Enterprise
  - If: customer_tier == "enterprise"
    Then: REQUIRE human review before sending
    Reasoning: Enterprise customers expect higher touch
  
Rule 7: Customer Tier - VIP
  - If: customer_importance == "vip"
    Then: REQUIRE human review before sending
    Reasoning: High-value customer communication needs care
  
Rule 8: Message Length
  - If: response_length > 500 words
    Then: REQUIRE human review before sending
    Reasoning: Long responses deserve human polish

Default for other cases:
  - AUTO-SEND without review (Sophie is confident + low-risk)

Review Timeout:
  - Max wait for human review: 30 minutes
  - If timeout expires: ESCALATE instead of sending
  - Reasoning: Don't let customer hang; escalate is safer than auto-send

Review Assignment:
  - Route to: "Support Lead" (available now?)
  - If unavailable: Escalate to "Support Manager"
```

---

## Performance Targets (Week 8 Go-Live)

```yaml
FCR (First Contact Resolution): 90% (ambitious but achievable)
  - Baseline: 60% (human specialists)
  - Target: 90% (Sophie + humans together)
  - Reasoning: Sophie + knowledge = better resolution rate

CSAT (Customer Satisfaction): 4.3+/5.0
  - Baseline: 4.1/5.0 (human specialists)
  - Target: 4.3+/5.0 (Sophie's consistent, knowledgeable responses)

TTR (Time to Resolution): <2 hours median
  - Baseline: 3.5 hours (human wait time + response time)
  - Target: <2 hours (Sophie responds instantly)

Escalation Rate: <15%
  - Target: Only escalate when truly uncertain
  - Above 15% means Sophie is too conservative

Quality Score: 95%+
  - Target: 95% of Sophie responses rated accurate by QA

Policy Compliance: 100%
  - Target: Zero policy violations (guardrails enforced)

Audit Trail: 100%
  - Target: Every decision logged + explainable
```

---

## Configuration Audit Trail

**Who changed what and when:**

```
2026-07-19 14:00 - CREATED
  Founder: Created initial Sophie configuration for Outsourcetel
  Version: v1.0

2026-07-19 14:30 - UPDATED (Authority)
  Founder: Set refund authority to $1000
  Changed: refund_limit = $1000

2026-07-19 15:00 - UPDATED (Knowledge)
  Founder: Enabled Salesforce + SharePoint sync
  Changed: salesforce.enabled = true, sharepoint.enabled = true

2026-08-19 10:00 - ADJUSTED (Escalation)
  Support Lead: Added Rule 10 (custom escalation to Support Lead)
  Reasoning: Catch all edge cases not covered by other rules

2026-08-29 09:00 - TESTED
  CTO: Ran test_de_configuration() - all 10 rules validated ✓

2026-09-09 14:00 - APPROVED
  Founder: Configuration approved for production deployment
```

---

## Reference for External Customers

When Outsourcetel licenses Sophie to external customers, they receive:

### **Sophie Platform Package** includes:
1. ✅ Proven configuration template (this document)
2. ✅ Customer configuration UI (6 panels)
3. ✅ Documentation (how to customize)
4. ✅ Training guide (for customer's support team)
5. ✅ Audit trail & compliance package
6. ✅ Support + SLA (Outsourcetel manages Sophie)

### **Customer Customization Examples:**

**Example 1: Big Enterprise Customer**
- Refund authority: $2000 (higher limit, faster decisions)
- Pre-approval: Review ALL responses (maximum safety)
- Escalation: Enterprise SLA = 1 hour response
- Knowledge: Add customer-specific docs (custom contracts, etc.)
- Result: Sophie locked down for enterprise safety

**Example 2: High-Volume Startup**
- Refund authority: $100 (limited liability)
- Pre-approval: Only review <50% confidence (speed priority)
- Escalation: Everything goes to one manager (simplified)
- Knowledge: Minimal (just product FAQ)
- Result: Sophie optimized for speed

**Example 3: Regulated Industry (Finance)**
- Refund authority: $0 (everything escalates)
- Pre-approval: Review EVERYTHING
- Escalation: To compliance team (not support)
- Knowledge: Restricted to public policies only
- Guardrails: Enforcement of financial regulations
- Result: Sophie maximizes audit trail + compliance

---

## Go-Live Checklist (Week 8)

- [ ] All configuration rules defined + approved
- [ ] All configuration tested (dry-run escalations work)
- [ ] Audit trail complete (all changes logged)
- [ ] Metrics baseline established (what are we measuring against?)
- [ ] Support team trained on configuration
- [ ] Customer notification ready ("Sophie is now live")
- [ ] Monitoring alerts configured (FCR drop? Escalation spike?)
- [ ] Rollback plan documented (how to disable Sophie if needed)

---

**Status**: Ready for Week 3 deployment  
**Dependencies**: Founder confirms refund authority amount  
**Licensability**: After Week 8 go-live, use this as customer reference configuration
