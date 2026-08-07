import { useAuth } from '../context/AuthContext';

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
