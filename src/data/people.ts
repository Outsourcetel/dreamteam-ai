// ── People — type contract for human workers ──────────────────────
// Humans and Digital Employees are the same kind of thing: workers with
// roles, workloads, and partnerships. The live roster is loaded from the
// database; this file only defines the shared shape.

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
  pendingItems: number // items currently waiting on them
}
