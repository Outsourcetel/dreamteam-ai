// ============================================================================
// Data rights — client API for "give me my data" and "delete my data".
//
// WHY THIS FILE EXISTS
// An independent readiness audit scored ENTERPRISE READINESS 27/100, and two of
// the concrete holes behind that number were that a customer could not export
// their data and could not get it deleted. Before this file, the only two
// things in the database that were even adjacent were:
//   · export_tenant_config(uuid) — 591 chars, returns (metrics, schemas,
//     configs). It contains no customer rows, and `grep -rn export_tenant_config
//     src/` returns nothing, so it was never reachable from the product either.
//   · delete_tenant(uuid,text)   — platform-admin only, and deliberately so.
// So this is a new surface, not a re-skin of an existing one.
//
// DESIGN RULE FOR THIS FILE: never swallow a failure and never invent a
// success. Two agents are building the backend in parallel with this UI, so at
// the moment you read this the export function or the deletion RPC may simply
// not be deployed. A screen that shows "Export complete" because a call
// silently returned null would be a worse product than a screen that says
// "the exporter is not deployed here yet" — the whole point of the feature is
// that the customer can trust what we tell them about their own data.
// Every call therefore ends in either a typed DataRightsError or a value whose
// shape has been checked, with any contract deviation carried forward as a
// human-readable warning rather than quietly normalised away.
// ============================================================================
import { supabase } from '../supabase';
import { invokeEdge, EdgeFunctionError } from './invokeEdge';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './env';
import { requireTenantId } from './liveShared';

/* ── The two backend entry points, named in exactly one place each ────────── */

/** Edge function that builds the export. Contract agreed with the export agent:
 *  invoke('tenant-export', { body: { format?, tables? } })
 *    -> { ok, manifest: { tables: [{table, rows}], not_included: string[] }, download? } */
export const EXPORT_FUNCTION = 'tenant-export';

/**
 * RPC that records a deletion request.
 *
 * ⚠ NOT YET DEPLOYED. Checked against the deletion work as it landed:
 * migration 371_complete_tenant_deletion.sql hardens delete_tenant and adds
 * tenant_deletion_receipts, tenant_rows_remaining(uuid) and
 * list_tenant_deletion_receipts(int) — all platform-side. Nothing in it takes
 * a request FROM a customer, so this name is the placeholder the orchestrator
 * points at whatever gets built.
 *
 * This constant plus deletionRequestArgs() below are the ONLY two places that
 * encode the name and the argument names, so rewiring is a two-line edit and
 * nothing else in the app changes. Until then PostgREST answers PGRST202 and
 * the panel says the service is unavailable — out loud — rather than
 * pretending the request was filed.
 */
export const DELETION_REQUEST_RPC = 'request_tenant_deletion';

/** Single rewire point for the deletion RPC's argument names. */
function deletionRequestArgs(input: DeletionRequestInput): Record<string, unknown> {
  return {
    p_tenant_id: input.tenantId,
    p_confirm_slug: input.confirmSlug,
    p_reason: input.reason?.trim() ? input.reason.trim() : null,
  };
}

/* ── Errors ───────────────────────────────────────────────────────────────── */

export type DataRightsFailureKind =
  /** The backend piece is not deployed here, or its signature differs from
   *  what this file sends. Both are deployment facts, not customer errors. */
  | 'not_deployed'
  /** The server ran and refused on permissions. */
  | 'denied'
  /** The server ran and refused on the request itself (wrong confirmation
   *  text, workspace not suspended, …). The server's own sentence is kept. */
  | 'rejected'
  /** Never reached the server (offline, DNS, CORS). Nothing happened. */
  | 'unavailable'
  /** 2xx, but the payload is not the agreed contract — we cannot report a
   *  result we could not read. */
  | 'malformed'
  | 'server';

export class DataRightsError extends Error {
  readonly kind: DataRightsFailureKind;
  /** Raw server detail, kept verbatim for support. May be empty. */
  readonly detail: string;
  readonly status: number | null;
  readonly code: string | null;
  constructor(kind: DataRightsFailureKind, message: string, opts: { detail?: string; status?: number | null; code?: string | null } = {}) {
    super(message);
    this.name = 'DataRightsError';
    this.kind = kind;
    this.detail = opts.detail ?? '';
    this.status = opts.status ?? null;
    this.code = opts.code ?? null;
  }
}

/**
 * supabase-js v2 turns every non-2xx from an Edge Function into a
 * FunctionsHttpError whose `.message` is the useless string "Edge Function
 * returned a non-2xx status code" and whose `.context` is the raw Response
 * (@supabase/functions-js FunctionsClient: `if (!response.ok) throw new
 * FunctionsHttpError(response)`). Reading the body is the only way to tell
 * "you are not allowed" apart from "this function does not exist yet", and
 * those two need very different sentences in front of a customer.
 */
async function invokeFailure(fnName: string, err: EdgeFunctionError): Promise<DataRightsError> {
  if (typeof err.status !== 'number') {
    // No Response at all — FunctionsFetchError / FunctionsRelayError. The
    // request did not complete, so nothing was produced server-side.
    return new DataRightsError('unavailable',
      `Could not reach the ${fnName} service, so no export was produced.`,
      { detail: err.message ?? '' });
  }

  const parsed = (err.body ?? {}) as { error?: string; message?: string; detail?: string };
  const serverMessage = (parsed?.error || parsed?.detail || parsed?.message || err.bodyText || '').trim();

  if (err.status === 404) {
    return new DataRightsError('not_deployed',
      `The export service is not deployed to this environment yet — the platform returned 404 for “${fnName}”. No export was created.`,
      { detail: serverMessage, status: 404 });
  }
  if (err.status === 401 || err.status === 403) {
    return new DataRightsError('denied',
      serverMessage || 'Your account is not permitted to export this workspace.',
      { detail: serverMessage, status: err.status });
  }
  if (err.status >= 400 && err.status < 500) {
    return new DataRightsError('rejected',
      serverMessage || `The export service refused the request (status ${err.status}). Nothing was exported.`,
      { detail: serverMessage, status: err.status });
  }
  return new DataRightsError('server',
    serverMessage || `The export service failed (status ${err.status}).`,
    { detail: serverMessage, status: err.status });
}

/**
 * PostgREST error → typed failure.
 * PGRST202 ("Could not find the function … in the schema cache") and SQLSTATE
 * 42883 both mean the same thing to a user: the piece is not there. It also
 * fires when the function EXISTS but takes different argument names than
 * deletionRequestArgs() sends, which is why the message names this file.
 * 42501 is insufficient_privilege; P0001 is a plpgsql `raise exception`, i.e.
 * one of the deliberate refusals we want quoted verbatim.
 */
function rpcFailure(rpcName: string, err: { code?: string; message?: string; details?: string; hint?: string }): DataRightsError {
  const code = err?.code ?? null;
  const message = (err?.message ?? '').trim();
  if (code === 'PGRST202' || code === '42883') {
    return new DataRightsError('not_deployed',
      `The deletion-request service is not available in this environment yet (no function “${rpcName}” with the expected arguments). Nothing was submitted.`,
      { detail: message, code });
  }
  if (code === '42501' || /permission denied|not authenticated|only a platform/i.test(message)) {
    return new DataRightsError('denied', message || 'Your account is not permitted to do this.', { detail: message, code });
  }
  if (code === 'P0001' || code === 'P0002') {
    return new DataRightsError('rejected', message || 'The request was refused.', { detail: message, code });
  }
  return new DataRightsError('server', message || 'The request failed.', { detail: err?.details ?? '', code });
}

/* ── Who am I looking at ──────────────────────────────────────────────────── */

export interface WorkspaceIdentity {
  id: string;
  name: string;
  /** The exact string a customer must retype to confirm deletion. delete_tenant
   *  compares `p_confirm_slug` to tenants.slug, so the UI must use the slug and
   *  not the display name. */
  slug: string;
  status: 'active' | 'suspended' | 'trial' | string;
  plan: string | null;
  created_at: string | null;
}

/** The caller's own workspace. Readable under the tenants SELECT policy
 *  `tn_sel`: (id = auth_tenant_id()) OR resolve_platform_capability(uid,
 *  'tenants.view') — so a normal tenant admin sees exactly their own row. */
export async function getWorkspaceIdentity(): Promise<WorkspaceIdentity> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('tenants')
    .select('id, name, slug, status, plan, created_at')
    .eq('id', tid)
    .single();
  if (error) throw rpcFailure('tenants', error);
  if (!data) throw new DataRightsError('malformed', 'Your workspace record could not be read.');
  const t = data as { id: string; name: string; slug: string; status: string; plan: string | null; created_at: string | null };
  return { id: t.id, name: t.name, slug: t.slug, status: t.status, plan: t.plan ?? null, created_at: t.created_at ?? null };
}

/* ── Export ───────────────────────────────────────────────────────────────── */

export type ExportFormat = 'json' | 'csv';

export interface ExportTableCount {
  table: string;
  /** null when the exporter was asked for shape without counts
   *  (export_tenant_manifest's p_include_counts=false leaves 'rows' null), so
   *  the panel can print "not counted" instead of a fake 0. */
  rows: number | null;
  /** Plain-English scope sentence, e.g. "rows where tenant_id = your tenant". */
  scope: string | null;
  /** Columns dropped or masked for this table. Part of the gap story: a table
   *  can be "included" and still be missing a column. */
  columns_omitted: string[];
  columns_redacted: string[];
}

/** A prose caveat from the manifest ("files": "Uploaded files … not included"). */
export interface ExportExclusionNote { label: string; text: string }
/** A named list of excluded things ("views_excluded": [...]). */
export interface ExportExclusionList { label: string; items: string[] }
/** A table the exporter COULD NOT export, with the reason. */
export interface ExportBlockedTable { table: string; reason: string }

/**
 * Everything the export does NOT contain, normalised from either shape:
 *   · the simple contract  — not_included: string[]
 *   · what shipped         — not_included: { summary, files, credentials,
 *                            tables_excluded_by_name: [...], coverage, … }
 * plus `not_exportable`, the tables the exporter had to skip.
 * This is the part of the response the panel treats as the headline.
 */
export interface ExportExclusions {
  notes: ExportExclusionNote[];
  lists: ExportExclusionList[];
  blocked: ExportBlockedTable[];
  /** true only when the server actually sent a gaps section. false means "we
   *  cannot confirm anything about completeness" — NOT "nothing was omitted". */
  reported: boolean;
}

export interface ExportManifest {
  /** One entry per table actually written into the export. */
  tables: ExportTableCount[];
  exclusions: ExportExclusions;
  generated_at: string | null;
  format: string | null;
  /** Server-reported total when present, otherwise summed from `tables`.
   *  null when counts were not produced at all. */
  total_rows: number | null;
  /** Server's own coverage sentence, if it sent one. */
  coverage: string | null;
}

export interface ExportDownload {
  url: string;
  filename: string | null;
  expires_at: string | null;
  size_bytes: number | null;
}

export interface ExportResult {
  manifest: ExportManifest;
  /** null when the server produced no retrievable file. The panel must say so
   *  rather than showing a dead button. */
  download: ExportDownload | null;
  /** Contract deviations found while reading the response. Rendered to the
   *  user, because "we could not tell what was left out" is itself something
   *  they need to know before they rely on this export. */
  warnings: string[];
  /** Untouched payload, so the user can download the raw truth if the shape
   *  changed under us. */
  raw: unknown;
}

function normaliseDownload(raw: unknown, warnings: string[]): ExportDownload | null {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    return raw.trim() ? { url: raw, filename: null, expires_at: null, size_bytes: null } : null;
  }
  if (typeof raw === 'object') {
    const d = raw as { url?: unknown; href?: unknown; signed_url?: unknown; filename?: unknown; name?: unknown; expires_at?: unknown; size_bytes?: unknown };
    const url = [d.url, d.href, d.signed_url].find(v => typeof v === 'string' && v) as string | undefined;
    if (!url) {
      warnings.push('The server returned a download object with no URL in it, so there is nothing to retrieve.');
      return null;
    }
    return {
      url,
      filename: typeof d.filename === 'string' ? d.filename : typeof d.name === 'string' ? d.name : null,
      expires_at: typeof d.expires_at === 'string' ? d.expires_at : null,
      size_bytes: typeof d.size_bytes === 'number' ? d.size_bytes : null,
    };
  }
  warnings.push('The server returned a download field this screen could not read.');
  return null;
}

/** snake_case json key -> a heading a customer can read. */
function humaniseKey(k: string): string {
  const s = k.replace(/_/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function asStringList(v: unknown[]): string[] {
  return v.map(item => {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object') {
      const o = item as { table?: unknown; name?: unknown; reason?: unknown };
      const name = typeof o.table === 'string' ? o.table : typeof o.name === 'string' ? o.name : null;
      if (name) return typeof o.reason === 'string' ? `${name} — ${o.reason}` : name;
    }
    return String(item);
  });
}

/**
 * Read the gaps section, whichever shape it arrives in.
 *
 * The contract handed to this file was `not_included: string[]`. What the
 * export migration actually builds is an OBJECT whose values are a mix of
 * prose ("Uploaded files in object storage are not included…"), string arrays
 * (views_excluded), and {table, reason} arrays (tables_excluded_by_name), plus
 * a computed `coverage` sentence. Both are handled rather than one being
 * declared wrong, because the customer-facing cost of getting this branch
 * wrong is an export that looks complete and is not.
 */
function normaliseExclusions(rawNotIncluded: unknown, rawNotExportable: unknown, warnings: string[]): { exclusions: ExportExclusions; coverage: string | null } {
  const notes: ExportExclusionNote[] = [];
  const lists: ExportExclusionList[] = [];
  const blocked: ExportBlockedTable[] = [];
  let coverage: string | null = null;
  let reported = false;

  if (Array.isArray(rawNotIncluded)) {
    reported = true;
    const items = asStringList(rawNotIncluded);
    if (items.length) lists.push({ label: 'Not included', items });
  } else if (rawNotIncluded && typeof rawNotIncluded === 'object') {
    reported = true;
    for (const [key, value] of Object.entries(rawNotIncluded as Record<string, unknown>)) {
      if (key === 'coverage' && typeof value === 'string') { coverage = value; continue; }
      if (typeof value === 'string') {
        if (value.trim()) notes.push({ label: humaniseKey(key), text: value });
      } else if (Array.isArray(value)) {
        const items = asStringList(value);
        if (items.length) lists.push({ label: humaniseKey(key), items });
      } else if (value != null) {
        // Nested structure we did not anticipate. Surfaced rather than dropped
        // — a silently ignored branch of the gaps section is the one bug this
        // whole function exists to avoid.
        warnings.push(`The manifest’s “${humaniseKey(key)}” section is in a format this screen could not read; use “Save manifest” to see it in full.`);
      }
    }
  } else {
    // Deliberately loud. An absent gaps section is indistinguishable from
    // "nothing was excluded" if we default it to empty, and those are very
    // different facts for someone about to delete their workspace.
    warnings.push('The manifest did not report what was left out, so this screen CANNOT confirm that everything was exported.');
  }

  if (Array.isArray(rawNotExportable)) {
    for (const item of rawNotExportable) {
      const o = item as { table?: unknown; reason?: unknown };
      const table = typeof o?.table === 'string' ? o.table : typeof item === 'string' ? item : null;
      if (table) blocked.push({ table, reason: typeof o?.reason === 'string' ? o.reason : 'no reason given' });
    }
  }

  return { exclusions: { notes, lists, blocked, reported }, coverage };
}

/**
 * Ask the exporter for everything this workspace owns.
 *
 * `tables` is part of the agreed contract but intentionally NOT surfaced as a
 * picker: the default any customer means when they say "export my data" is all
 * of it, and a half-built picker is how you end up shipping an export that
 * quietly excludes things. It stays in the signature so a caller with a real
 * reason (a re-export of one table from the manifest) can pass it.
 */
export async function requestTenantExport(opts: { tables?: string[] } = {}): Promise<ExportResult> {
  const body: Record<string, unknown> = {};
  if (opts.tables?.length) body.tables = opts.tables;

  // ⚠ TWO CALLS, AND THE SPLIT IS NOT COSMETIC.
  //
  // The archive is streamed as `application/x-ndjson`. supabase-js does NOT
  // special-case that content type — FunctionsClient.js special-cases only
  // application/json, application/octet-stream, application/pdf,
  // text/event-stream and multipart/form-data, and everything else falls to
  // `data = await response.text()`. So invoking the archive endpoint returned a
  // STRING, failed this function's own object check, and reported "no file was
  // produced" — after the server had already streamed every row and written an
  // audit entry recording a successful export. It also buffered the entire
  // archive into a JS string and then discarded it, defeating the pull-based
  // backpressure the edge function was built around.
  //
  // So: the MANIFEST comes back as application/json, which supabase-js parses
  // correctly and which carries the auth/permission failures worth surfacing.
  // The ARCHIVE is fetched directly so the response body stays a stream.
  const { data, error } = await invokeEdge(EXPORT_FUNCTION, {
    body: { ...body, manifest_only: true },
  });
  if (error) throw await invokeFailure(EXPORT_FUNCTION, error);

  const warnings: string[] = [];
  const payload = data as { ok?: unknown; error?: unknown; manifest?: unknown; download?: unknown } | null;

  if (!payload || typeof payload !== 'object') {
    throw new DataRightsError('malformed', 'The export service answered, but the response was empty. Treat this export as not produced.');
  }
  // A 200 carrying { ok: false } is still a refusal — supabase-js does not
  // raise for it, so it must be checked explicitly or it renders as success.
  if (payload.ok === false) {
    const msg = typeof payload.error === 'string' ? payload.error : 'The export service reported a failure.';
    throw new DataRightsError('rejected', msg, { detail: msg });
  }

  // The agreed envelope is { ok, manifest, download }. export_tenant_manifest
  // returns the manifest object itself, so a thin edge wrapper that forwards
  // the RPC result unchanged is also accepted — recognised by format_version /
  // a top-level tables array. Guessing wrong here would show "no manifest" for
  // a perfectly good export.
  const rawManifest = payload.manifest
    ?? (('format_version' in payload || Array.isArray((payload as { tables?: unknown }).tables)) ? payload : null);
  if (!rawManifest || typeof rawManifest !== 'object') {
    throw new DataRightsError('malformed',
      'The export service answered without a manifest, so this screen cannot tell you what the export contains or what it left out.');
  }
  const m = rawManifest as {
    tables?: unknown; not_included?: unknown; not_exportable?: unknown;
    generated_at?: unknown; format?: unknown; counts?: unknown;
  };

  let tables: ExportTableCount[] = [];
  let uncounted = 0;
  if (Array.isArray(m.tables)) {
    tables = m.tables.map(entry => {
      const e = entry as {
        table?: unknown; name?: unknown; rows?: unknown; row_count?: unknown;
        scope?: unknown; columns_omitted?: unknown; columns_redacted?: unknown;
      };
      const name = typeof e?.table === 'string' ? e.table : typeof e?.name === 'string' ? e.name : '(unnamed table)';
      const rowsRaw = typeof e?.rows === 'number' ? e.rows : typeof e?.row_count === 'number' ? e.row_count : null;
      if (rowsRaw == null) uncounted += 1;
      const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
      return {
        table: name,
        rows: rowsRaw,
        scope: typeof e?.scope === 'string' ? e.scope : null,
        columns_omitted: strs(e?.columns_omitted),
        columns_redacted: strs(e?.columns_redacted),
      };
    });
  } else {
    warnings.push('The manifest listed no tables, so this screen cannot confirm what was included.');
  }
  // One aggregate line, not one per table: p_include_counts=false leaves EVERY
  // row count null, and 226 identical warnings would bury the ones that matter.
  if (uncounted > 0) {
    warnings.push(uncounted === tables.length
      ? 'No row counts were reported, so this screen cannot tell you how much data the export contains.'
      : `${uncounted} of ${tables.length} tables came back without a row count.`);
  }

  const { exclusions, coverage } = normaliseExclusions(m.not_included, m.not_exportable, warnings);

  const counts = (m.counts && typeof m.counts === 'object' ? m.counts : {}) as { total_rows?: unknown };
  const summed = tables.reduce<number | null>((sum, t) => (sum == null || t.rows == null ? null : sum + t.rows), 0);
  const manifest: ExportManifest = {
    tables,
    exclusions,
    generated_at: typeof m.generated_at === 'string' ? m.generated_at : null,
    // The exporter emits NDJSON and takes no format argument — the old
    // `opts.format` fallback here is what let the result header print "CSV"
    // over an NDJSON file. Report only what the server actually said.
    format: typeof m.format === 'string' ? m.format : 'ndjson',
    total_rows: typeof counts.total_rows === 'number' ? counts.total_rows : summed,
    coverage,
  };

  // ── The archive itself ────────────────────────────────────────────────────
  // Fetched directly rather than through functions.invoke, for the content-type
  // reason documented at the top of this function. Failure here is NOT fatal:
  // the manifest is already a real, useful answer about what the workspace
  // holds, and reporting "no file" alongside a valid manifest is honest.
  // Silently returning a manifest with no download and no warning would not be.
  let download: ExportDownload | null = null;
  try {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) {
      warnings.push('Your session expired before the file could be downloaded. The manifest below is still accurate; run the export again to get the file.');
    } else {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/${EXPORT_FUNCTION}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        warnings.push(`The manifest was produced but the file could not be downloaded (HTTP ${res.status}). Nothing was deleted or changed.`);
      } else {
        // Blob, not text: the archive can be tens of MB and the browser should
        // stream it to disk rather than hold it as a JS string.
        const blob = await res.blob();
        download = {
          url: URL.createObjectURL(blob),
          filename: `dreamteam-export-${new Date().toISOString().slice(0, 10)}.ndjson`,
          size_bytes: blob.size,
          expires_at: null,
          // A stream that ends without the trailing summary line was cut short
          // — a deadline, or a platform-side kill. The exporter emits that line
          // last precisely so truncation is detectable.
        };
        // A stream that ends without the trailing summary line was cut short —
        // a deadline, or a platform-side kill. The exporter emits that line last
        // precisely so truncation is detectable from the client.
        const tail = await blob.slice(Math.max(0, blob.size - 4096)).text();
        const truncated = !tail.includes('"summary"');
        if (truncated) {
          warnings.push('The download ended without the exporter’s completion marker, so it is INCOMPLETE. Do not treat it as a full copy — run the export again.');
        }
      }
    }
  } catch (err) {
    console.error('requestTenantExport: archive fetch failed', err);
    warnings.push('The manifest was produced but the file could not be downloaded. Nothing was deleted or changed.');
  }

  return { manifest, download, warnings, raw: data };
}

/* ── Deletion ─────────────────────────────────────────────────────────────── */

export interface DeletionRequestInput {
  tenantId: string;
  /** Must equal tenants.slug — the same comparison delete_tenant already
   *  enforces server-side (`if coalesce(p_confirm_slug,'') <> v_t.slug`). */
  confirmSlug: string;
  reason?: string;
}

export interface DeletionRequestResult {
  requestId: string | null;
  status: string | null;
  /** Anything the server says it will KEEP rather than destroy. Optional in
   *  the response; when present it is rendered verbatim, because a deletion
   *  that quietly retains records is the exact failure mode this feature is
   *  supposed to close. */
  retained: string[];
  message: string | null;
  raw: unknown;
}

/**
 * File a deletion request for the caller's workspace.
 *
 * This is a REQUEST, not the deletion. Measured against production today,
 * delete_tenant(uuid,text) requires all of the following, none of which a
 * customer can satisfy from inside their own workspace:
 *   · resolve_platform_capability(auth.uid(), 'tenants.manage')  — platform staff only
 *   · tenants.status = 'suspended' before the call
 *   · p_confirm_slug = tenants.slug
 *   · zero sub-tenants, and it explicitly refuses the caller's OWN tenant
 *     ("you cannot delete the tenant you belong to") and the demo tenant.
 * So there is no self-serve path, and the UI must not imply one.
 */
export async function requestWorkspaceDeletion(input: DeletionRequestInput): Promise<DeletionRequestResult> {
  const { data, error } = await supabase.rpc(DELETION_REQUEST_RPC, deletionRequestArgs(input));
  if (error) throw rpcFailure(DELETION_REQUEST_RPC, error);

  const d = (data ?? null) as { ok?: unknown; request_id?: unknown; id?: unknown; status?: unknown; retained?: unknown; not_deleted?: unknown; message?: unknown } | null;
  if (d && typeof d === 'object' && d.ok === false) {
    const msg = typeof d.message === 'string' ? d.message : 'The deletion request was refused.';
    throw new DataRightsError('rejected', msg, { detail: msg });
  }
  const retainedRaw = Array.isArray(d?.retained) ? d?.retained : Array.isArray(d?.not_deleted) ? d?.not_deleted : [];
  return {
    requestId: typeof d?.request_id === 'string' ? d.request_id : typeof d?.id === 'string' ? d.id : null,
    status: typeof d?.status === 'string' ? d.status : null,
    retained: (retainedRaw as unknown[]).filter((v): v is string => typeof v === 'string'),
    message: typeof d?.message === 'string' ? d.message : null,
    raw: data ?? null,
  };
}

/* ── Small shared helpers the panels both need ────────────────────────────── */

/** Turn any thrown value into a sentence safe to show a customer. */
export function describeDataRightsError(err: unknown): { message: string; kind: DataRightsFailureKind; detail: string } {
  if (err instanceof DataRightsError) return { message: err.message, kind: err.kind, detail: err.detail };
  const m = err instanceof Error ? err.message : String(err);
  return { message: m || 'Something went wrong.', kind: 'server', detail: '' };
}

/** Trigger a browser download of text the CLIENT already holds. Used only for
 *  the manifest — never for the export payload itself, which comes from the
 *  server's own signed link. Revokes the object URL so a long-lived page does
 *  not leak one per click. */
export function downloadTextFile(filename: string, text: string, mime = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
