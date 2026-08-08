import { useAuth } from '../context/AuthContext';
import { canAccessPage } from './navAccess';
import type { Page } from '../types';

// ════════════════════════════════════════════════════════════════════════
// Role gates for the UI, matching the gates the DATABASE actually enforces.
//
// ⚠ WHY THIS EXISTS. navAccess decides which PAGES a role may open. It does
// not decide which CONTROLS on those pages will work — that lives in the
// SECURITY DEFINER functions, and the two had drifted apart. An audit of every
// tenant page found controls offered to roles the server refuses: nineteen on
// the Employee File, a password field on Browser Operator that a read_only
// account could type into but never save, and five more on sub-pages rendered
// inside ALL_TENANT parents.
//
// ⚠ THIS IS NOT A SECURITY BOUNDARY — same rule as navAccess. The database
// refuses regardless; these hooks stop the UI OFFERING what will be refused.
// Never let them be the only gate.
//
// ⚠ AND NOT EVERY GATED CONTROL SHOULD BE HIDDEN. Approving a task routes
// through decide_human_task, which answers with a specific reason ("you hold
// no approval authority for X"). A governed refusal that explains itself is
// working correctly — hiding it would remove the one control the `approver`
// role exists to use. Hide a control only when the refusal would teach the
// person nothing.
// ════════════════════════════════════════════════════════════════════════

/** Owner or admin — the gate on can_admin_tenant_internal and on the
 *  `role not in ('tenant_owner','tenant_admin')` checks. */
export function useIsTenantAdmin(): boolean {
  const { authedUser, isDTUser } = useAuth();
  return isDTUser || ['tenant_owner', 'tenant_admin'].includes(authedUser?.role ?? '');
}

/** Owner, admin or manager — the gate on
 *  auth_has_tenant_role(array['tenant_owner','tenant_admin','tenant_manager']). */
export function useIsTenantManager(): boolean {
  const { authedUser, isDTUser } = useAuth();
  return isDTUser || ['tenant_owner', 'tenant_admin', 'tenant_manager'].includes(authedUser?.role ?? '');
}

// ── the knowledge specialist ─────────────────────────────────────────────
//
// navAccess gives the KNOWLEDGE tier to owner, admin, manager and
// knowledge_manager because "curating knowledge is their job". The database
// then refused the specialist every action on those three pages: the role
// could open the doors and touch nothing. Migration 634 fixed the database;
// these two hooks are the UI half.
//
// ⚠ THEY DIFFER, AND THE DIFFERENCE IS NOT AN OVERSIGHT. 634 widened each gate
// from wherever it already stood rather than flattening all three to one tier,
// so deciding what the knowledge base SAYS is admin-or-specialist, while the
// cadence a source refreshes on also admits a manager — which is where that
// one already sat. Using one hook for both would silently hand a manager the
// conflict queue, or take the sync toggle away from them.

/** Owner, admin or the knowledge specialist. Deciding which of two documents
 *  is the source of truth, and the thresholds that turn a gap into work. */
export function useCanCurateKnowledge(): boolean {
  const { authedUser, isDTUser } = useAuth();
  return isDTUser || ['tenant_owner', 'tenant_admin', 'knowledge_manager'].includes(authedUser?.role ?? '');
}

/** The manage tier plus the specialist — whether a connected source re-syncs
 *  on its own. Connecting one, holding its credential and choosing which of
 *  its documents may be ingested all stay owner/admin: this toggles the
 *  cadence of a source somebody else already connected. */
export function useCanScheduleKnowledgeSync(): boolean {
  const { authedUser, isDTUser } = useAuth();
  return isDTUser || ['tenant_owner', 'tenant_admin', 'tenant_manager', 'knowledge_manager'].includes(authedUser?.role ?? '');
}

// ════════════════════════════════════════════════════════════════════════
// ⚠ CAN THIS PERSON OPEN THAT PAGE?
//
// Every hook above answers "may they do this THING". This one answers "may
// they go THERE", which is a different question with a different owner:
// PAGE_ACCESS, read through canAccessPage. It exists because a link is a
// control too, and handleSetPage refuses silently — so a "View the full
// audit trail →" offered to a role that cannot open the audit trail takes
// the click and does nothing, which reads as a broken product rather than
// as a boundary. audit-role-gates found eight of those across five files.
//
// ⚠⚠ IT MUST ASK THE SAME QUESTION handleSetPage ASKS, not a copy of the
// answer. Writing `useIsTenantManager()` at each of those eight call sites
// would work today and drift the first time a page changed tier — the link
// and the destination would disagree, and nothing would catch it. Calling
// canAccessPage with the same arguments makes disagreement impossible.
//
// ⚠ Naming matters here: audit-role-gates derives a file's gate names from
// its `const x = use(Is|Can)…()` bindings, so a hook called useCanOpenPage
// is recognised as a gate automatically. A name outside that shape would be
// invisible to the checker that found these in the first place.
// ════════════════════════════════════════════════════════════════════════
export function useCanOpenPage(page: Page): boolean {
  const { authedUser } = useAuth();
  return canAccessPage(
    (authedUser?.role ?? 'read_only') as Parameters<typeof canAccessPage>[0],
    page,
    authedUser?.layer,
    authedUser?.deRelations,
  );
}
