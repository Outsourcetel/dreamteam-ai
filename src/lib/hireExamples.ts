// ── Hire Wizard Examples ───────────────────────────────────────────────
// Data-driven examples pool (enables rotation, industry-specific, future admin customization).

export const HIRE_EXAMPLES_BY_INDUSTRY = {
  billing: [
    'I need someone to answer billing questions — invoices, refunds within our 30-day policy, and payment problems. Anything about contract changes goes to a human.',
    'Handle invoice disputes and refund requests. Check if the request is within our refund window, verify the order, and escalate anything unusual.',
    'Answer questions about pricing tiers, discounts, and subscription upgrades. Anything about custom contracts should be escalated.',
  ],
  support: [
    'A support employee for our telecom customers: troubleshooting connection issues step by step, checking known outages, and escalating anything that needs a truck roll.',
    'Handle order status questions for our online store — where is my order, returns, exchanges — always polite, never promises delivery dates we cannot keep.',
    'Troubleshoot account login problems for our SaaS product. Try password reset, 2FA troubleshooting, then escalate. Do not reset MFA without human verification.',
  ],
  ecommerce: [
    'Someone to handle order status questions for our online store — where is my order, returns, exchanges — always polite, never promises delivery dates we cannot keep.',
    'Answer product compatibility questions. Check our KB for spec sheets and common pairings. Escalate any issues that require a human recommendation.',
    'Handle returns and exchanges. Check our return window, verify the issue, issue RMAs. Escalate anything that requires a refund beyond our standard policy.',
  ],
  finance: [
    'Handle expense report questions: status, approval timeline, policy exceptions. Escalate anything that needs VP sign-off.',
    'Answer 401k and benefits enrollment questions. Provide plan summaries, deadlines, contact HR for exceptions.',
    'Handle invoice and payment inquiries. Check payment status, confirm receipt, escalate disputes.',
  ],
  hr: [
    'Field payroll questions: check stubs, direct deposit, tax withholding. Escalate policy exceptions to HR.',
    'Answer benefits and leave questions. PTO balances, health insurance options, parental leave policy. Escalate exceptions.',
    'Handle onboarding questions for new employees. Document checklist, IT setup status, first week schedule. Escalate blockers.',
  ],
  technical: [
    'API integration support: answer questions about endpoints, auth, rate limits, error codes. Escalate feature requests and bugs.',
    'Troubleshoot deployment issues: help debug build errors, environment configuration. Escalate infrastructure problems.',
    'Handle SDK questions: installation, examples, best practices. Escalate framework-specific bugs to engineering.',
  ],
};

export type IndustryKey = keyof typeof HIRE_EXAMPLES_BY_INDUSTRY;

/**
 * Get a set of hire examples for the wizard.
 * If industry is provided, use industry-specific examples.
 * Otherwise use a default mix.
 */
export function getHireExamples(industry?: IndustryKey): string[] {
  if (industry && HIRE_EXAMPLES_BY_INDUSTRY[industry]) {
    return HIRE_EXAMPLES_BY_INDUSTRY[industry];
  }

  // Default mix: one from each industry (rotating selection)
  return [
    HIRE_EXAMPLES_BY_INDUSTRY.billing[0],
    HIRE_EXAMPLES_BY_INDUSTRY.support[1],
    HIRE_EXAMPLES_BY_INDUSTRY.ecommerce[0],
  ];
}

/**
 * Get a random example from a set to rotate in the UI.
 */
export function getRandomExample(examples: string[]): string {
  return examples[Math.floor(Math.random() * examples.length)];
}

/**
 * All industries available.
 */
export const INDUSTRIES = Object.keys(HIRE_EXAMPLES_BY_INDUSTRY) as IndustryKey[];
