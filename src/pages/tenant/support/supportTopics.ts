// The seeded triage taxonomy (mig 233), in plain words. Anything a workspace
// adds of its own falls through to the raw value with underscores stripped —
// the list must never become a gate on what a tenant may call a topic.
// One definition, two consumers: the inbox filter bar and the History report.
export const TOPIC_LABEL: Record<string, string> = {
  billing: 'Billing', access: 'Access', security: 'Security', how_to: 'How do I…',
  complaint: 'Complaint', general: 'General', data: 'Data', legal: 'Legal',
  outage: 'Outage', safety: 'Safety', feature_request: 'Feature request',
};
