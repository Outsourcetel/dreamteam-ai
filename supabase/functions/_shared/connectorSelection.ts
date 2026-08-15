// connectorSelection.ts — ONE definition of "a connector we can actually call",
// and one deterministic answer to "which one" when a workspace has more than
// one in the same category.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// Until 2026-08-15 every "pick a usable connector" selector in this repo was
// spelled `status <> 'disconnected'`, in four places, each written when
// `disconnected` was the ONLY status that meant "you cannot call this". They
// were negations of a single bad value, not statements of what is required.
//
// Migration 728 added a fifth value, `pending_credentials`: a connector a
// person agreed to on a discovery card, staged with NO secret, never
// credentialled. `<> 'disconnected'` ADMITS it. Nobody updated the four
// readers, because nothing wrote the value yet — `select status, count(*) from
// connectors group by 1` was `connected 24, disconnected 2` on 2026-08-15, and
// zero rows have ever held it. The first writer is the discovery accept path
// (src/lib/discoveryApi.ts), which is shipping now.
//
// The measured consequence, had it shipped unchanged: a workspace with no CRM
// accepts "Connect HubSpot" from a card. The next `category_op` step used to
// record `skipped: no connected crm system for this workspace` — an honest
// skip. It would instead select the staged row, get `{error:'no_credentials'}`
// (400) back from connector-hub, and record a FAILURE. A step that correctly
// reported "there is nothing here to call" starts reporting "the call failed".
//
// Worse, and non-deterministic: with a live credentialled Zendesk in
// `helpdesk` and an accepted-but-uncredentialled Freshdesk card in the same
// category, `.limit(1)` with no ORDER BY lets Postgres return EITHER row. A
// working automation starts failing on some runs and not others, with nothing
// in the workspace having changed.
//
// ── WHAT THE PREDICATE ACTUALLY MEANS ───────────────────────────────────────
// The question these selectors are asking is "does this connector have a
// credential we can call with", and the five live values answer it directly
// (connectors_status_check, read from pg_constraint 2026-08-15):
//
//   connected           — has one; the last call was fine            → CALLABLE
//   error               — has one; the last call failed              → CALLABLE
//                         (retryable; the old `<> 'disconnected'` selectors
//                         admitted it deliberately and this keeps that)
//   disconnected        — the credential was purged                  → not callable
//   pending_credentials — there has never been one                   → not callable
//
// It is an ALLOW-LIST on purpose. `<> 'disconnected'` was a deny-list, and a
// deny-list is what let a new status walk in unannounced. A sixth status added
// tomorrow is not callable until someone names it here, so the failure mode of
// forgetting this file is an honest skip, never a false failure.
//
// ⚠ Not the same predicate as `get_agentic_tools_for_de`, which requires
// `status = 'connected'` (verified live). That one is stricter on purpose —
// it decides what a DE is allowed to reach, not what a step may attempt.

/** The live `connectors.status` domain. Mirrors src/lib/connectorApi.ts's
 *  ConnectorStatus; edge functions cannot import from src/. */
export type ConnectorStatusValue =
  | 'connected'
  | 'error'
  | 'disconnected'
  | 'pending_credentials';

/** The statuses that mean a credential exists, so a call is worth attempting.
 *  Pass this straight to PostgREST `.in('status', [...])`. */
export const CALLABLE_CONNECTOR_STATUSES: readonly ConnectorStatusValue[] = [
  'connected',
  'error',
];

/** True when this row is one a call may be attempted against. */
export function isCallableConnector(status: string | null | undefined): boolean {
  return (CALLABLE_CONNECTOR_STATUSES as readonly string[]).includes(String(status ?? ''));
}

/** Rank for the deterministic pick — LOWER wins. `connected` beats `error`
 *  because a connector whose last call succeeded is the better bet than one
 *  that is currently failing; anything not callable is excluded before it
 *  gets here and ranks last if it ever arrives. */
function statusRank(status: string | null | undefined): number {
  if (status === 'connected') return 0;
  if (status === 'error') return 1;
  return 2;
}

export interface SelectableConnector {
  id?: string | null;
  status?: string | null;
  created_at?: string | null;
}

/**
 * The callable connectors, in a total order.
 *
 * ⚠ THIS IS THE ORDER BY the four call sites did not have. `.limit(1)` with no
 * ordering is not a tie-break, it is a coin toss the planner makes — and it can
 * land differently on two consecutive runs against unchanged data.
 *
 * Total order, so there is never a tie left for the database to break:
 *   1. callable only (uncredentialled rows are not candidates at all);
 *   2. `connected` before `error`;
 *   3. oldest `created_at` first — the connector the workspace has been
 *      running on, not the one somebody added this morning;
 *   4. `id` ascending — created_at can tie to the millisecond on a seeded
 *      workspace, and a total order has to actually be total.
 */
export function orderedCallableConnectors<T extends SelectableConnector>(
  rows: readonly T[] | null | undefined,
): T[] {
  return (rows ?? [])
    .filter((r) => isCallableConnector(r?.status))
    .slice()
    .sort((a, b) => {
      const byStatus = statusRank(a.status) - statusRank(b.status);
      if (byStatus !== 0) return byStatus;
      const at = String(a.created_at ?? '');
      const bt = String(b.created_at ?? '');
      if (at !== bt) return at < bt ? -1 : 1;
      return String(a.id ?? '') < String(b.id ?? '') ? -1 : 1;
    });
}

/** Choose ONE connector out of the candidates, deterministically — the head of
 *  `orderedCallableConnectors`. Returns null when nothing is callable, which
 *  is what lets the caller record an honest skip instead of a false failure. */
export function pickCallableConnector<T extends SelectableConnector>(
  rows: readonly T[] | null | undefined,
): T | null {
  return orderedCallableConnectors(rows)[0] ?? null;
}
