// platformDemandApi.ts — the platform's read of the cross-tenant capability
// demand signal (migrations 744 and 750).
//
// ⚠⚠ THIS FILE EXISTS TO NOT RETURN `[]` ON FAILURE, and that is the whole
// reason it is not three lines inside src/lib/api.ts alongside its neighbours.
//
// Every platform fetch helper in api.ts has this shape:
//
//     if (error) { console.error('fetchPlatformConnectorHealth:', error.message); return []; }
//
// — and the screen that consumes it then renders "No connectors configured by
// any tenant yet." A refusal, a dropped connection and a genuinely empty table
// are the same three characters by the time they reach the page. On System
// Health that is a latent lie; here it would be a guaranteed one, because
// `discovery_capability_demand_log` holds ZERO rows today, so an empty screen
// is the FIRST thing anybody will ever see and there is nothing to make them
// suspicious.
//
// So the read returns a discriminated result and the page cannot get to its
// empty state except through `status: 'ok'`: `failure` and `report` are on
// different arms of the union, so the compiler will not let a failure be read
// as a report.
//
// ⚠ BE PRECISE ABOUT WHAT THAT BUYS, because an overstated guarantee is worse
// than none — it stops the next reader looking. The union constrains THIS
// FUNCTION'S RESULT. It says nothing about what a consumer does after
// destructuring it: a page that copied `report` and `failure` into two
// independent state slots would satisfy every type here and could still paint
// a stale report under a fresh error, with exclusivity resting on one
// `setReport(null)`. The type is necessary and not sufficient.
//
// The consumer half is held in PlatformDemandPage, which stores this whole
// `DemandReadResult` in ONE state slot and renders its report body from a
// component that cannot be constructed without a `CapabilityDemandReport`.
// Between the two there is no assignment that produces both — which is the
// claim, stated where it is actually true.
//
// ⚠ `.rpc()` RESOLVES on a Postgres error — the promise does not reject. A
// missing `if (error)` here would swallow the capability guard's RAISE and
// hand the page `data === null`, which is exactly the state that must never be
// confused with "we ran and found nothing".
//
// ⚠ AND A SHAPE WE CANNOT READ IS A FAILURE, NOT AN EMPTY LIST. If `demand`
// comes back as anything but an array, `?? []` would manufacture "no customer
// has asked for anything" out of a broken response. It is reported as a
// failure instead.
import { supabase } from '../supabase';

/** One workspace's own recorded words, from discovery_capability_demand_log.
 *  `tenant_label` is the DENORMALISED snapshot taken when the customer spoke —
 *  it survives the deletion of the tenant, which is the point of migration
 *  744. Shown on the drill-down and deliberately NOT on the aggregate row; see
 *  migration 750's header for that argument. */
export interface DemandEvidence {
  tenant_label: string;
  surfaced_at: string;
  evidence: string;
}

/** One capability × dimension, aggregated across every workspace. */
export interface DemandRow {
  capability: string;
  dimension_key: string;
  dimension_title: string;
  /** THE priority signal. Distinct workspaces, not sessions. */
  tenants_surfaced: number;
  sessions_surfaced: number;
  first_surfaced_at: string;
  last_surfaced_at: string;
  /** How many log rows carried a sentence. NOT the same as sessions_surfaced:
   *  a dimension can be marked heard with nothing quotable, and pretending
   *  otherwise would have the screen imply four quotes where there is one. */
  evidence_total: number;
  /** How many of those the server actually sent (capped at 25 per capability),
   *  so a truncated list is visible rather than silent. */
  evidence_shown: number;
  evidence: DemandEvidence[];
}

/**
 * The whole answer, in one object.
 *
 * ⚠ THE ANCHORS TRAVEL WITH THE LIST, and that is the design. "No demand yet"
 * is meaningless on its own — it could mean nobody has been interviewed, or
 * that plenty have and none hit a gap, or that the catalogue names no
 * unstaffed capability at all so the list CANNOT fill. Those are three
 * different facts and the founder needs a different response to each. Because
 * they arrive in the same object as `demand`, the page is structurally unable
 * to render an empty list without them.
 */
export interface CapabilityDemandReport {
  generated_at: string;
  /** Discovery interviews on record across EVERY workspace. */
  sessions_on_record: number;
  latest_session_at: string | null;
  /** Rows in discovery_capability_demand_log. `log_rows > 0` with an empty
   *  `demand` is an impossible state and the page says so. */
  log_rows: number;
  /** Interview dimensions that currently name a capability we cannot staff.
   *  ZERO means this list can never fill and an empty screen proves nothing —
   *  the vacuity condition, surfaced rather than hidden. */
  gap_dimensions: number;
  capabilities_watched: string[];
  demand: DemandRow[];
}

export type DemandFailureKind =
  /** The capability guard refused this signed-in operator. */
  | 'not_authorised'
  /** The RPC is not in the schema cache — migration 750 is not applied here. */
  | 'not_installed'
  /** Anything else: transport, a Postgres fault, an unreadable shape. */
  | 'failed';

export interface DemandFailure {
  kind: DemandFailureKind;
  /** The server's own sentence, verbatim and untranslated. The page shows it. */
  message: string;
}

/**
 * ⚠ THE DISCRIMINANT IS A STRING, AND THAT IS NOT A STYLE CHOICE. The obvious
 * spelling — `{ ok: true; report } | { ok: false; failure }` — DOES NOT NARROW
 * under this repository's tsconfig, which sets `"strict": false` and therefore
 * `strictNullChecks: false`. Measured, not assumed: the boolean form compiled
 * to
 *
 *   error TS2339: Property 'failure' does not exist on type 'DemandReadResult'.
 *     Property 'failure' does not exist on type '{ ok: true; report: … }'.
 *
 * on tsc 5.9.3, while the identical union keyed on a string literal narrowed
 * cleanly in the same run. The consequence matters more than the syntax: the
 * whole claim this module makes — that the page CANNOT reach its empty state
 * from a failure — rests on the compiler separating these two arms. With a
 * boolean key it would not have, and the "guarantee" would have been a comment.
 */
export type DemandReadResult =
  | { status: 'ok'; report: CapabilityDemandReport }
  | { status: 'failed'; failure: DemandFailure };

/** Classify a PostgREST/Postgres message. ⚠ Branch on the SERVER's wording
 *  only where that wording is a stable contract: the guard's sentence is
 *  raised by migration 750 and is quoted here so the two can be grepped
 *  together. Everything unrecognised falls to 'failed' — never to a shrug. */
function classify(message: string): DemandFailure {
  const m = message || '';
  if (m.includes('only a platform team member')) return { kind: 'not_authorised', message: m };
  if (m.includes('permission denied for function')) return { kind: 'not_authorised', message: m };
  if (m.includes('Could not find the function') || m.includes('schema cache')) {
    return { kind: 'not_installed', message: m };
  }
  return { kind: 'failed', message: m || 'The workspace refused the read and did not say why.' };
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}
function asInt(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Read the cross-tenant capability demand.
 *
 * Runs as the SIGNED-IN platform operator — `platform_capability_demand()` is
 * granted to `authenticated` and to nobody else, and it asks
 * resolve_platform_capability(auth.uid(), 'tenants.manage') before it touches a
 * row. There is no tenant parameter, deliberately: a tenant id passed in by a
 * caller is not authorisation (migrations 662-664, 749).
 */
export async function fetchCapabilityDemand(): Promise<DemandReadResult> {
  const { data, error } = await supabase.rpc('platform_capability_demand');

  if (error) return { status: 'failed', failure: classify(error.message) };

  const raw = (data ?? null) as Record<string, unknown> | null;
  if (!raw || raw.ok !== true) {
    return {
      status: 'failed',
      failure: {
        kind: 'failed',
        message: 'The reader answered without confirming it had run. Nothing on this screen can be trusted until that is understood.',
      },
    };
  }
  // ⚠ Not `(raw.demand as DemandRow[]) ?? []`. A null or an object here would
  // become "no customer has asked for anything", which is the one sentence
  // this screen must never say without having checked.
  if (!Array.isArray(raw.demand)) {
    return {
      status: 'failed',
      failure: {
        kind: 'failed',
        message: `The reader returned demand as ${raw.demand === null ? 'null' : typeof raw.demand}, not a list. This is not an empty result — it is an unreadable one.`,
      },
    };
  }
  if (!Array.isArray(raw.capabilities_watched)) {
    return {
      status: 'failed',
      failure: {
        kind: 'failed',
        message: 'The reader did not report which unstaffed capabilities it is watching, so an empty result here could not be told apart from a list that can never fill.',
      },
    };
  }

  const demand: DemandRow[] = (raw.demand as Record<string, unknown>[]).map((d) => ({
    capability: asString(d.capability),
    dimension_key: asString(d.dimension_key),
    dimension_title: asString(d.dimension_title),
    tenants_surfaced: asInt(d.tenants_surfaced),
    sessions_surfaced: asInt(d.sessions_surfaced),
    first_surfaced_at: asString(d.first_surfaced_at),
    last_surfaced_at: asString(d.last_surfaced_at),
    evidence_total: asInt(d.evidence_total),
    evidence_shown: asInt(d.evidence_shown),
    evidence: Array.isArray(d.evidence)
      ? (d.evidence as Record<string, unknown>[]).map((e) => ({
          tenant_label: asString(e.tenant_label, 'a workspace we can no longer name'),
          surfaced_at: asString(e.surfaced_at),
          evidence: asString(e.evidence),
        }))
      : [],
  }));

  return {
    status: 'ok',
    report: {
      generated_at: asString(raw.generated_at),
      sessions_on_record: asInt(raw.sessions_on_record),
      latest_session_at: typeof raw.latest_session_at === 'string' ? raw.latest_session_at : null,
      log_rows: asInt(raw.log_rows),
      gap_dimensions: asInt(raw.gap_dimensions),
      capabilities_watched: (raw.capabilities_watched as unknown[]).map((c) => String(c)),
      demand,
    },
  };
}

/** `planned_hr` → `HR`. Cosmetic only — every place this is used also shows
 *  the raw key, because the raw key is what somebody greps for when they go to
 *  build the thing, and a prettified name that no file contains is a dead end. */
export function capabilityLabel(key: string): string {
  const base = key.replace(/^planned_/, '').replace(/_/g, ' ').trim();
  if (!base) return key;
  if (base.length <= 3) return base.toUpperCase();
  return base.charAt(0).toUpperCase() + base.slice(1);
}
