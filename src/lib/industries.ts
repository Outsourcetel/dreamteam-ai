// ============================================================
// The ONE canonical industry list + provisioning templates
// (Wave 1.1). Before this, three screens carried three different
// hardcoded industry lists, and the Company Setup wizard's choices
// persisted nothing. This module is now the single source:
//   - LoginPage / OrgSetupScreen signup pickers  → INDUSTRY_NAMES
//   - SettingsPage industry field                → INDUSTRY_NAMES
//   - CompanySetupPage wizard                    → INDUSTRY_TEMPLATES
//
// HONESTY RULES for templates:
//   1. Every template guardrail carries a REAL, enforceable pattern —
//      the same '|'-separated fragments the live triage/guardrail
//      engine regex-matches. A rule without a pattern would be a
//      policy statement wearing a guardrail costume; none ship here.
//   2. Templates are SEEDS, not behavior: the wizard shows each rule
//      (with its pattern) before creating it, and everything lands as
//      ordinary editable guardrail_rules rows.
//   3. Recommended hires create real Digital Employees at lifecycle
//      'designed' — they then walk the same gated lifecycle as any
//      hand-hired DE. No shortcuts.
// ============================================================

export interface IndustryGuardrail {
  rule: string;                       // plain-language statement (shown to humans)
  rule_type: 'blocked_topic' | 'blocked_phrase' | 'require_approval_over_cents';
  pattern?: string;                   // '|'-separated fragments (the engine's format)
  threshold?: number;                 // cents, for require_approval_over_cents
}

export interface IndustryHire {
  name: string;
  department: string;
  category: 'Customer' | 'Internal';
  description: string;
  why: string;
}

export interface IndustryTemplate {
  name: string;                       // EXACTLY the string stored on tenants.industry
  icon: string;
  blurb: string;
  hires: IndustryHire[];
  guardrails: IndustryGuardrail[];
}

export const INDUSTRY_TEMPLATES: IndustryTemplate[] = [
  {
    name: 'Technology', icon: '⚡',
    blurb: 'Support-heavy: ticket resolution, renewals, developer-facing knowledge.',
    hires: [
      { name: 'Support DE', department: 'Customer Support', category: 'Customer', description: 'First-contact support: answers product questions from the knowledge base and drafts ticket replies for approval.', why: 'Highest-volume function — fastest time to value' },
      { name: 'Renewal DE', department: 'Customer Success', category: 'Customer', description: 'Watches renewal dates, prepares renewal invoices, and flags at-risk accounts.', why: 'Automates the renewal lifecycle end to end' },
    ],
    guardrails: [
      { rule: 'Never quote or compare competitor pricing', rule_type: 'blocked_topic', pattern: 'competitor pric|cheaper than .*|price match' },
      { rule: 'No uptime or SLA guarantees beyond the standard tier', rule_type: 'blocked_phrase', pattern: 'guarantee.{0,12}uptime|guaranteed sla|custom sla' },
      { rule: 'Billing adjustments above the threshold need approval', rule_type: 'require_approval_over_cents', threshold: 1000000 },
    ],
  },
  {
    name: 'Finance', icon: '$',
    blurb: 'Compliance-first: strict advice boundaries, review gates, escalation on regulated topics.',
    hires: [
      { name: 'Client Relations DE', department: 'Client Services', category: 'Customer', description: 'Client communications and intake: answers service questions and routes account requests.', why: 'Client communications with mandatory review gates' },
      { name: 'Operations DE', department: 'Operations', category: 'Internal', description: 'Internal process support: reconciliations follow-ups, report preparation, and staff questions.', why: 'Back-office volume without compliance exposure' },
    ],
    guardrails: [
      { rule: 'Never give investment advice or predict returns', rule_type: 'blocked_topic', pattern: 'investment advice|should i invest|guaranteed return|buy .{0,20}(stock|shares|crypto)' },
      { rule: 'Sanctions/KYC topics always go to a human', rule_type: 'blocked_topic', pattern: 'sanction|ofac|money launder|kyc exception' },
      { rule: 'Never commit to making a regulatory filing', rule_type: 'blocked_phrase', pattern: 'file on your behalf|submit the filing|handle the regulator' },
      { rule: 'Transactions above the threshold need approval', rule_type: 'require_approval_over_cents', threshold: 2500000 },
    ],
  },
  {
    name: 'Healthcare', icon: '＋',
    blurb: 'Clinician-in-the-loop: hard limits on clinical content, identifiers stay out of replies.',
    hires: [
      { name: 'Patient Services DE', department: 'Patient Services', category: 'Customer', description: 'Scheduling, billing questions, and intake paperwork — never clinical content.', why: 'High-volume administrative work, clearly fenced from care' },
      { name: 'HR & People DE', department: 'Human Resources', category: 'Internal', description: 'Credentialing reminders, staff onboarding, and internal policy questions.', why: 'Staff support without patient-data exposure' },
    ],
    guardrails: [
      { rule: 'No clinical advice — ever. Diagnosis, medication, and treatment always go to a clinician', rule_type: 'blocked_topic', pattern: 'diagnos|prescri|dosage|medication advice|treatment (plan|recommend)|is it (cancer|serious)' },
      { rule: 'Patient identifiers never appear in outbound replies', rule_type: 'blocked_phrase', pattern: 'social security number|ssn|medical record number|date of birth' },
      { rule: 'Billing adjustments above the threshold need approval', rule_type: 'require_approval_over_cents', threshold: 500000 },
    ],
  },
  {
    name: 'Retail', icon: '◧',
    blurb: 'Volume-optimized: order status, returns, refund gates, fraud escalation.',
    hires: [
      { name: 'Support DE', department: 'Customer Support', category: 'Customer', description: 'Order status, returns, and product questions — the bulk of inbound volume.', why: 'Order status + returns are 70%+ of inbound' },
      { name: 'Vendor DE', department: 'Procurement', category: 'Internal', description: 'Supplier communications, PO follow-ups, and delivery-date chasing.', why: 'Supplier coordination without adding headcount' },
    ],
    guardrails: [
      { rule: 'No price-match or discount commitments without policy check', rule_type: 'blocked_phrase', pattern: 'price match|match (their|that) price|special discount just for you' },
      { rule: 'Fraud-pattern language always goes to a human', rule_type: 'blocked_topic', pattern: 'chargeback|stolen card|card was used without' },
      { rule: 'Refunds above the threshold need approval', rule_type: 'require_approval_over_cents', threshold: 250000 },
    ],
  },
  {
    name: 'Professional Services', icon: '◈',
    blurb: 'Engagement-centric: scope boundaries, deliverable review gates, conflict escalation.',
    hires: [
      { name: 'Client Relations DE', department: 'Client Services', category: 'Customer', description: 'Engagement intake, status updates, and scheduling — inside engaged scope only.', why: 'Keeps clients informed without partner time' },
      { name: 'Finance DE', department: 'Finance', category: 'Internal', description: 'WIP tracking, billing preparation, and collections follow-ups.', why: 'Billing hygiene runs itself' },
    ],
    guardrails: [
      { rule: 'No advice outside the engaged scope', rule_type: 'blocked_phrase', pattern: 'off the record|informal advice|outside (the|our) engagement' },
      { rule: 'Conflict-of-interest signals always go to a human', rule_type: 'blocked_topic', pattern: 'conflict of interest|also represent|other side' },
      { rule: 'Client commitments above the threshold need partner sign-off', rule_type: 'require_approval_over_cents', threshold: 2500000 },
    ],
  },
  {
    name: 'Manufacturing', icon: '⚙',
    blurb: 'Order-and-supply focused: delivery-date discipline, safety-claim limits.',
    hires: [
      { name: 'Customer Service DE', department: 'Customer Service', category: 'Customer', description: 'Order status, lead-time questions, and documentation requests.', why: 'Order-status volume without touching promises' },
      { name: 'Supplier DE', department: 'Procurement', category: 'Internal', description: 'Supplier follow-ups, PO confirmations, and delivery tracking.', why: 'Supply-chain chasing on autopilot' },
    ],
    guardrails: [
      { rule: 'No delivery-date guarantees — quotes only, confirmed by a human', rule_type: 'blocked_phrase', pattern: 'guarantee[d]? (delivery|ship)|will definitely (arrive|ship)' },
      { rule: 'No safety or compliance certifications by chat', rule_type: 'blocked_topic', pattern: 'osha|safety certif|complian(ce|t) certif' },
      { rule: 'Orders above the threshold need approval', rule_type: 'require_approval_over_cents', threshold: 2500000 },
    ],
  },
  {
    name: 'Education', icon: '◎',
    blurb: 'Student-and-family facing: admission/grade boundaries, records protection.',
    hires: [
      { name: 'Admissions DE', department: 'Admissions', category: 'Customer', description: 'Program questions, application status, and deadline reminders.', why: 'Admissions season volume, handled consistently' },
      { name: 'Student Services DE', department: 'Student Services', category: 'Customer', description: 'Enrollment logistics, billing questions, and campus information.', why: 'Frees staff for the conversations that need people' },
    ],
    guardrails: [
      { rule: 'Never promise admission outcomes or grade changes', rule_type: 'blocked_phrase', pattern: 'guarantee[d]? admission|change (your|the) grade|promise .{0,12}accept' },
      { rule: 'Student records stay out of replies', rule_type: 'blocked_phrase', pattern: 'student id number|transcript attached' },
      { rule: 'Fee adjustments above the threshold need approval', rule_type: 'require_approval_over_cents', threshold: 250000 },
    ],
  },
  {
    name: 'Real Estate', icon: '⌂',
    blurb: 'Listing-and-client focused: fair-housing discipline, no value guarantees.',
    hires: [
      { name: 'Client Services DE', department: 'Client Services', category: 'Customer', description: 'Listing questions, viewing scheduling, and document chasing.', why: 'Inquiry volume answered while agents show homes' },
      { name: 'Transactions DE', department: 'Operations', category: 'Internal', description: 'Transaction checklists, deadline tracking, and document follow-ups.', why: 'Nothing falls through mid-transaction' },
    ],
    guardrails: [
      { rule: 'Fair-housing: never steer by protected characteristics', rule_type: 'blocked_topic', pattern: 'no (kids|children)|adults only|familial status|good (ethnic|religious) fit' },
      { rule: 'No property-value or appreciation guarantees', rule_type: 'blocked_phrase', pattern: 'guaranteed (value|appreciation)|will definitely (sell|appreciate)' },
      { rule: 'Commitments above the threshold need approval', rule_type: 'require_approval_over_cents', threshold: 1000000 },
    ],
  },
  {
    name: 'Legal', icon: '§',
    blurb: 'Matter-centric: engagement boundaries, privilege protection.',
    hires: [
      { name: 'Client Intake DE', department: 'Client Services', category: 'Customer', description: 'New-matter intake, scheduling, and status questions — never legal advice.', why: 'Intake runs around the clock, cleanly fenced' },
      { name: 'Matter Support DE', department: 'Operations', category: 'Internal', description: 'Deadline tracking, document requests, and filing-date reminders for staff.', why: 'Calendar discipline without paralegal hours' },
    ],
    guardrails: [
      { rule: 'No legal advice outside an engagement — new matters go to a human', rule_type: 'blocked_topic', pattern: 'am i liable|should i sue|is this legal|what are my rights' },
      { rule: 'Privilege signals always escalate', rule_type: 'blocked_topic', pattern: 'privileged|attorney.client|work product' },
      { rule: 'Engagement commitments above the threshold need partner sign-off', rule_type: 'require_approval_over_cents', threshold: 2500000 },
    ],
  },
  {
    name: 'Other', icon: '◇',
    blurb: 'General template: sensible defaults every business needs on day one.',
    hires: [
      { name: 'Support DE', department: 'Customer Support', category: 'Customer', description: 'First-contact question answering from the knowledge base, with human escalation.', why: 'Every business answers questions' },
      { name: 'Operations DE', department: 'Operations', category: 'Internal', description: 'Internal follow-ups, reminders, and staff questions.', why: 'The everything-else desk' },
    ],
    guardrails: [
      { rule: 'No commitments on behalf of leadership', rule_type: 'blocked_phrase', pattern: 'the (ceo|owner|director) (promised|agreed)|we guarantee' },
      { rule: 'Amounts above the threshold need approval', rule_type: 'require_approval_over_cents', threshold: 1000000 },
    ],
  },
];

/** The canonical picker list — derived, never duplicated. */
export const INDUSTRY_NAMES = INDUSTRY_TEMPLATES.map(t => t.name);

export function industryTemplate(name: string | null | undefined): IndustryTemplate {
  return INDUSTRY_TEMPLATES.find(t => t.name === name) ?? INDUSTRY_TEMPLATES[INDUSTRY_TEMPLATES.length - 1];
}

// ============================================================
// Wave 4 — per-industry work-object configuration seeds: what the
// served party is CALLED, what the value metric is CALLED, the
// pipeline stages the industry actually moves work through, and the
// extra fields worth tracking on each served-party record. These are
// SEEDS (same honesty rule as guardrails above): Company Setup writes
// them as ordinary tenant config — vocabulary on tenants.vocabulary,
// stages into tenant_pipeline_stages, fields into tenant_entity_fields
// — all editable afterwards. Omitted keys fall back to SaaS defaults.
// ============================================================

export interface IndustryWorkConfig {
  vocabulary: {
    party_singular: string; party_plural: string;
    value_metric: string; value_metric_hint: string;
    renewal_label: string; section_label: string;
  };
  stages: Array<{ key: string; label: string }>;
  entity_fields: Array<{ key: string; label: string; type: 'text' | 'number' | 'date' }>;
}

const SAAS_STAGES = [
  { key: 'prospect', label: 'Prospect' },
  { key: 'qualified', label: 'Qualified' },
  { key: 'proposal', label: 'Proposal' },
  { key: 'negotiation', label: 'Negotiation' },
];

export const INDUSTRY_WORK_CONFIG: Record<string, IndustryWorkConfig> = {
  Technology: {
    vocabulary: { party_singular: 'Customer', party_plural: 'Customers', value_metric: 'ARR', value_metric_hint: '$/year', renewal_label: 'Renewal', section_label: 'Customers' },
    stages: SAAS_STAGES,
    entity_fields: [
      { key: 'plan_tier', label: 'Plan tier', type: 'text' },
      { key: 'seats', label: 'Seats', type: 'number' },
    ],
  },
  Finance: {
    vocabulary: { party_singular: 'Client', party_plural: 'Clients', value_metric: 'AUM / fees', value_metric_hint: '$/year', renewal_label: 'Review', section_label: 'Clients' },
    stages: [
      { key: 'prospect', label: 'Prospect' },
      { key: 'kyc_review', label: 'KYC review' },
      { key: 'proposal', label: 'Proposal' },
      { key: 'documentation', label: 'Documentation' },
    ],
    entity_fields: [
      { key: 'risk_profile', label: 'Risk profile', type: 'text' },
      { key: 'next_review_date', label: 'Next review', type: 'date' },
    ],
  },
  Healthcare: {
    vocabulary: { party_singular: 'Patient', party_plural: 'Patients', value_metric: 'Annual care value', value_metric_hint: '$/year', renewal_label: 'Re-enrollment', section_label: 'Patients' },
    stages: [
      { key: 'referral', label: 'Referral' },
      { key: 'intake', label: 'Intake' },
      { key: 'insurance_check', label: 'Insurance check' },
      { key: 'scheduled', label: 'Scheduled' },
    ],
    entity_fields: [
      { key: 'insurer', label: 'Insurer', type: 'text' },
      { key: 'next_appointment', label: 'Next appointment', type: 'date' },
    ],
  },
  Retail: {
    vocabulary: { party_singular: 'Customer', party_plural: 'Customers', value_metric: 'Annual spend', value_metric_hint: '$/year', renewal_label: 'Reorder', section_label: 'Customers' },
    stages: [
      { key: 'lead', label: 'Lead' },
      { key: 'quote', label: 'Quote' },
      { key: 'order_placed', label: 'Order placed' },
      { key: 'fulfillment', label: 'Fulfillment' },
    ],
    entity_fields: [
      { key: 'loyalty_tier', label: 'Loyalty tier', type: 'text' },
      { key: 'last_order_date', label: 'Last order', type: 'date' },
    ],
  },
  'Professional Services': {
    vocabulary: { party_singular: 'Client', party_plural: 'Clients', value_metric: 'Engagement value', value_metric_hint: '$/year', renewal_label: 'Re-engagement', section_label: 'Clients' },
    stages: [
      { key: 'lead', label: 'Lead' },
      { key: 'scoping', label: 'Scoping' },
      { key: 'proposal', label: 'Proposal' },
      { key: 'contracting', label: 'Contracting' },
    ],
    entity_fields: [
      { key: 'engagement_partner', label: 'Engagement partner', type: 'text' },
      { key: 'engagement_end', label: 'Engagement end', type: 'date' },
    ],
  },
  Manufacturing: {
    vocabulary: { party_singular: 'Account', party_plural: 'Accounts', value_metric: 'Annual order volume', value_metric_hint: '$/year', renewal_label: 'Contract renewal', section_label: 'Accounts' },
    stages: [
      { key: 'inquiry', label: 'Inquiry' },
      { key: 'rfq', label: 'RFQ' },
      { key: 'quote', label: 'Quote' },
      { key: 'po_received', label: 'PO received' },
    ],
    entity_fields: [
      { key: 'plant', label: 'Plant / site', type: 'text' },
      { key: 'payment_terms', label: 'Payment terms', type: 'text' },
    ],
  },
  Education: {
    vocabulary: { party_singular: 'Student', party_plural: 'Students', value_metric: 'Annual tuition', value_metric_hint: '$/year', renewal_label: 'Re-enrollment', section_label: 'Students' },
    stages: [
      { key: 'inquiry', label: 'Inquiry' },
      { key: 'applied', label: 'Applied' },
      { key: 'interview', label: 'Interview' },
      { key: 'offer', label: 'Offer' },
    ],
    entity_fields: [
      { key: 'program', label: 'Program', type: 'text' },
      { key: 'start_term', label: 'Start term', type: 'text' },
    ],
  },
  'Real Estate': {
    vocabulary: { party_singular: 'Client', party_plural: 'Clients', value_metric: 'Transaction value', value_metric_hint: '$', renewal_label: 'Repeat business', section_label: 'Clients' },
    stages: [
      { key: 'lead', label: 'Lead' },
      { key: 'viewing', label: 'Viewing' },
      { key: 'offer_made', label: 'Offer made' },
      { key: 'under_contract', label: 'Under contract' },
    ],
    entity_fields: [
      { key: 'property_interest', label: 'Property interest', type: 'text' },
      { key: 'budget', label: 'Budget', type: 'number' },
    ],
  },
  Legal: {
    vocabulary: { party_singular: 'Client', party_plural: 'Clients', value_metric: 'Matter value', value_metric_hint: '$/year', renewal_label: 'Retainer renewal', section_label: 'Clients' },
    stages: [
      { key: 'intake', label: 'Intake' },
      { key: 'conflict_check', label: 'Conflict check' },
      { key: 'engagement_letter', label: 'Engagement letter' },
      { key: 'active_matter', label: 'Active matter' },
    ],
    entity_fields: [
      { key: 'matter_type', label: 'Matter type', type: 'text' },
      { key: 'responsible_partner', label: 'Responsible partner', type: 'text' },
    ],
  },
  Other: {
    vocabulary: { party_singular: 'Customer', party_plural: 'Customers', value_metric: 'Annual value', value_metric_hint: '$/year', renewal_label: 'Renewal', section_label: 'Customers' },
    stages: SAAS_STAGES,
    entity_fields: [],
  },
};

export function industryWorkConfig(name: string | null | undefined): IndustryWorkConfig {
  return INDUSTRY_WORK_CONFIG[name ?? ''] ?? INDUSTRY_WORK_CONFIG.Other;
}
