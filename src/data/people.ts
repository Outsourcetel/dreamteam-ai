// ── People — single source of truth for human workers ─────────────
// Humans and Digital Employees are the same kind of thing: workers with
// roles, workloads, and partnerships. This file gives humans the same
// first-class treatment DEs get in WorkforceDEsPage.

import type { CompanyId } from './companies'

export interface Person {
  id: string
  name: string
  title: string
  email: string
  team: string
  avatarInitials: string
  color: string // tailwind bg class for the avatar
  orgColumn: 'customer' | 'vendor' | 'workforce' | 'specialist'
  worksWith: string[] // DE ids
  approves: string[] // task types this person gates
  weeklyLoad: { approvals: number; escalations: number; reviews: number; avgResponseHrs: number }
  loadTrend: 'up' | 'down' | 'flat'
  loadInsight?: string // shown when trend is up — the trust-dial teaser
  expertiseTags: string[]
  consultedByDEs: number // times DEs consulted this person this month
  pendingItems: number // items currently waiting on them (mirrors Human Tasks seeds where applicable)
}

export const TCP_PEOPLE: Person[] = [
  {
    id: 'priya-sharma', name: 'Priya Sharma', title: 'VP Customer Operations', email: 'priya.sharma@tcpsoftware.com',
    team: 'Customer Operations', avatarInitials: 'PS', color: 'bg-rose-500/20 text-rose-300', orgColumn: 'customer',
    worksWith: ['casey', 'alex'],
    approves: ['Invoice approvals over $10K escalated from Finance', 'Billing adjustments >$500 (Alex approval gate)', 'Support overrides'],
    weeklyLoad: { approvals: 9, escalations: 2, reviews: 3, avgResponseHrs: 3.1 },
    loadTrend: 'up',
    loadInsight: "Priya's approval load is up 40% this month. Casey's calibration supports raising her invoice auto-approve limit — review in Proving Ground →",
    expertiseTags: ['Billing policy', 'Customer escalations', 'Renewal economics', 'Support operations'],
    consultedByDEs: 14, pendingItems: 2,
  },
  {
    id: 'taylor-smith', name: 'Taylor Smith', title: 'Senior CSM', email: 'taylor.smith@tcpsoftware.com',
    team: 'Customer Success', avatarInitials: 'TS', color: 'bg-sky-500/20 text-sky-300', orgColumn: 'customer',
    worksWith: ['casey'],
    approves: ['At-risk account reviews (Casey review gate)', 'Save-play sign-off'],
    weeklyLoad: { approvals: 2, escalations: 3, reviews: 6, avgResponseHrs: 4.5 },
    loadTrend: 'flat',
    expertiseTags: ['At-risk playbooks', 'Renewal conversations', 'Health scoring'],
    consultedByDEs: 9, pendingItems: 1,
  },
  {
    id: 'jordan-lee', name: 'Jordan Lee', title: 'Onboarding Specialist', email: 'jordan.lee@tcpsoftware.com',
    team: 'Customer Success', avatarInitials: 'JL', color: 'bg-emerald-500/20 text-emerald-300', orgColumn: 'customer',
    worksWith: ['alex'],
    approves: ['Customer configuration reviews', 'Onboarding milestone sign-off'],
    weeklyLoad: { approvals: 1, escalations: 1, reviews: 5, avgResponseHrs: 5.2 },
    loadTrend: 'down',
    expertiseTags: ['Implementation config', 'Data migration', 'Kick-off calls'],
    consultedByDEs: 6, pendingItems: 1,
  },
  {
    id: 'maya-osei', name: 'Maya Osei', title: 'Support Lead', email: 'm.osei@tcpsoftware.com',
    team: 'Support', avatarInitials: 'MO', color: 'bg-amber-500/20 text-amber-300', orgColumn: 'customer',
    worksWith: ['alex'],
    approves: ['L2 escalations from Alex', 'KB article reviews', 'Learned-behavior approvals'],
    weeklyLoad: { approvals: 3, escalations: 6, reviews: 4, avgResponseHrs: 2.4 },
    loadTrend: 'flat',
    expertiseTags: ['L2 troubleshooting', 'API auth issues', 'KB quality'],
    consultedByDEs: 18, pendingItems: 2,
  },
  {
    id: 'jai-patel', name: 'Jai Patel', title: 'Finance Manager', email: 'j.patel@tcpsoftware.com',
    team: 'Finance', avatarInitials: 'JP', color: 'bg-indigo-500/20 text-indigo-300', orgColumn: 'workforce',
    worksWith: ['casey'],
    approves: ['Credit notes & write-offs', 'Invoice approvals >$10K (Casey approval gate)'],
    weeklyLoad: { approvals: 7, escalations: 1, reviews: 2, avgResponseHrs: 3.8 },
    loadTrend: 'up',
    loadInsight: "Jai's invoice-approval queue has grown 3 weeks running. Casey's 94% approval-match rate supports a higher auto-approve threshold — review in Proving Ground →",
    expertiseTags: ['Revenue recognition', 'Zuora billing', 'Write-off policy'],
    consultedByDEs: 8, pendingItems: 2,
  },
  {
    id: 'dana-whitfield', name: 'Dana Whitfield', title: 'HRBP', email: 'dana.whitfield@tcpsoftware.com',
    team: 'People', avatarInitials: 'DW', color: 'bg-teal-500/20 text-teal-300', orgColumn: 'workforce',
    worksWith: ['riley'],
    approves: ['HR approvals (Riley approval gate)', "Riley's learned-behavior validation", 'Compensation data access'],
    weeklyLoad: { approvals: 4, escalations: 2, reviews: 3, avgResponseHrs: 6.0 },
    loadTrend: 'flat',
    expertiseTags: ['HR policy', 'Leave management', 'Onboarding compliance'],
    consultedByDEs: 11, pendingItems: 1,
  },
]

export const PWC_PEOPLE: Person[] = [
  {
    id: 'james-whitfield', name: 'James Whitfield', title: 'Managing Partner', email: 'j.whitfield@pwc.com',
    team: 'Partner Group', avatarInitials: 'JW', color: 'bg-rose-500/20 text-rose-300', orgColumn: 'specialist',
    worksWith: ['avery', 'morgan'],
    approves: ["Partner review of Avery's tax memos", 'Overrides above policy limits', 'Client commitments >$50K'],
    weeklyLoad: { approvals: 6, escalations: 1, reviews: 8, avgResponseHrs: 8.5 },
    loadTrend: 'up',
    loadInsight: "James's memo-review load is up this month. Avery's 91% confidence and clean citation record support widening the auto-release band for routine memos — review in Proving Ground →",
    expertiseTags: ['Tax strategy', 'Engagement risk', 'Client relationships'],
    consultedByDEs: 12, pendingItems: 2,
  },
  {
    id: 'rina-tanaka', name: 'Rina Tanaka', title: 'Engagement Manager', email: 'r.tanaka@pwc.com',
    team: 'Advisory', avatarInitials: 'RT', color: 'bg-sky-500/20 text-sky-300', orgColumn: 'customer',
    worksWith: ['morgan'],
    approves: ['Engagement approvals >$5K (Morgan approval gate)', 'Scope-change sign-off'],
    weeklyLoad: { approvals: 5, escalations: 2, reviews: 4, avgResponseHrs: 4.2 },
    loadTrend: 'flat',
    expertiseTags: ['Engagement scoping', 'Change orders', 'Client onboarding'],
    consultedByDEs: 10, pendingItems: 1,
  },
  {
    id: 'aisha-osei', name: 'Aisha Osei', title: 'Risk & Compliance Officer', email: 'a.osei@pwc.com',
    team: 'Risk & Compliance', avatarInitials: 'AO', color: 'bg-amber-500/20 text-amber-300', orgColumn: 'customer',
    worksWith: ['morgan'],
    approves: ['GDPR escalations', 'KYC / sanctions screening hits', 'Regulatory filings'],
    weeklyLoad: { approvals: 2, escalations: 4, reviews: 5, avgResponseHrs: 3.0 },
    loadTrend: 'up',
    loadInsight: "Aisha's GDPR escalation volume is climbing. Morgan's data-request handling passes every compliance eval — consider expanding Morgan's autonomous response scope — review in Proving Ground →",
    expertiseTags: ['GDPR', 'AML / KYC', 'Sanctions screening'],
    consultedByDEs: 15, pendingItems: 1,
  },
  {
    id: 'liam-brennan', name: 'Liam Brennan', title: 'Billing Manager', email: 'l.brennan@pwc.com',
    team: 'Finance', avatarInitials: 'LB', color: 'bg-indigo-500/20 text-indigo-300', orgColumn: 'workforce',
    worksWith: ['morgan'],
    approves: ['Credit notes & fee adjustments', 'WIP write-offs'],
    weeklyLoad: { approvals: 4, escalations: 1, reviews: 2, avgResponseHrs: 5.5 },
    loadTrend: 'flat',
    expertiseTags: ['Fee schedules', 'WIP management', 'Billing policy'],
    consultedByDEs: 5, pendingItems: 1,
  },
]

export const PEOPLE_BY_COMPANY: Record<CompanyId, Person[]> = { tcp: TCP_PEOPLE, pwc: PWC_PEOPLE }

export function getPeople(companyId: CompanyId): Person[] {
  return PEOPLE_BY_COMPANY[companyId] ?? []
}

// localStorage handoff key — other pages set this to preselect a person
// on the Workforce Roster (workforce_des) page.
export const ROSTER_SELECT_KEY = 'dt_roster_select'

/** Match a free-text name (e.g. "J. Patel (Finance)") to a person. */
export function findPersonByName(companyId: CompanyId, text: string): Person | undefined {
  const people = getPeople(companyId)
  const lower = text.toLowerCase()
  return people.find(p => {
    const [first, last] = p.name.split(' ')
    return lower.includes(p.name.toLowerCase())
      || lower.includes(`${first[0].toLowerCase()}. ${last.toLowerCase()}`)
      || lower.includes(last.toLowerCase())
  })
}
