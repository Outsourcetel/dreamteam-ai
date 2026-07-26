/**
 * tenant-export — a customer takes their own data out, without asking us.
 *
 * WHY
 * The 13-agent audit scored enterprise readiness 27/100 and "the customer cannot
 * export their data" was one of the two structural holes behind it. Data
 * portability is the question procurement asks right after SSO, and until now the
 * only honest answer was "email us and we'll run a script". It doubles as backup
 * insurance the customer controls: the Supabase org is on the FREE plan with no
 * automated backups (scripts/backup-data.mjs:9-12).
 *
 * WHAT IT IS NOT
 * A system backup. The manifest that opens every stream says so in those words
 * and enumerates the omissions — auth accounts, storage objects, vault secrets,
 * function source, cron schedules, embeddings. An export a customer MISTAKES for
 * a full backup is worse than no export, because they find out in the one moment
 * they cannot afford to.
 *
 * AUTHORIZATION
 * Every database call is made with the CALLER'S JWT, never the service role.
 * That is deliberate: export_tenant_manifest / export_tenant_table_page are
 * guarded by can_admin_tenant_internal (migration 372), and that guard returns
 * true unconditionally for service_role. Calling as the service role would move
 * the real gate into this file, where a single early-return bug becomes a
 * cross-tenant data leak. Calling as the user leaves the gate in the database,
 * where it is one expression that every path goes through.
 *
 * SHAPE — newline-delimited JSON, streamed
 *   {"type":"manifest",...}                        exactly one, first
 *   {"type":"table_start","table":..,"rows":N}
 *   {"type":"row","table":..,"data":{...}}         N of these
 *   {"type":"table_end","table":..,"exported":N,"complete":true}
 *   {"type":"summary",...}                         exactly one, last
 * NDJSON rather than a zip: it streams, so neither this function nor the
 * customer's machine ever holds the whole archive, and `jq` alone is enough to
 * work with it. Each row line repeats its table name so a consumer needs no
 * state — ~20 bytes a row, paid deliberately.
 *
 * BOUNDS (largest tenant table today is audit_events at 36,073 rows)
 *   · Rows are pulled one 500-row page at a time and released to the stream
 *     immediately; peak memory is one page, not one archive.
 *   · The stream is `pull`-driven, so a slow consumer applies real backpressure
 *     instead of letting pages pile up in the queue.
 *   · Tables the manifest counts at zero are skipped entirely. For a typical
 *     tenant that is most of the 226, and it is the difference between ~30
 *     round trips and ~250.
 *   · A wall-clock deadline stops the run before the platform kills it, and the
 *     summary then carries a resume cursor. A truncated export that SAYS it is
 *     truncated is recoverable; one that just stops is a silent data-loss bug.
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { reportEdgeError } from '../_shared/errorReport.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

const DEFAULT_PAGE = 500;          // same page size as scripts/backup-data.mjs:38
const MAX_PAGE = 2000;             // the RPC clamps here too; kept in sync on purpose
const DEFAULT_DEADLINE_MS = 240_000;
const MAX_DEADLINE_MS = 300_000;   // stay inside the platform's own wall clock

interface ManifestTable {
  table: string;
  rows: number | null;
  columns_omitted: string[];
  columns_redacted: string[];
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!bearer) return json({ error: 'unauthorized' }, 401);

    const body = await req.json().catch(() => ({})) as Record<string, unknown>;

    // The caller's own credentials, not ours. See AUTHORIZATION above.
    const asUser = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: `Bearer ${bearer}` } } },
    );

    const { data: userData, error: userErr } = await asUser.auth.getUser(bearer);
    if (userErr || !userData?.user) return json({ error: 'unauthorized' }, 401);

    // Tenant may be asserted (a platform operator in a remote-access session has
    // no tenant_id on their own profile). It is only a HINT: the RPC re-derives
    // authorization from auth_tenant_id() and rejects a tenant the caller does
    // not administer, so nothing here has to be trusted.
    let tenantId = typeof body.tenant_id === 'string' ? body.tenant_id : null;
    if (!tenantId) {
      const { data: profile } = await asUser
        .from('profiles').select('tenant_id').eq('user_id', userData.user.id).maybeSingle();
      tenantId = profile?.tenant_id ?? null;
    }
    if (!tenantId) return json({ error: 'no_tenant', message: 'Pass tenant_id.' }, 400);

    const pageSize = Math.min(Math.max(Number(body.page_size) || DEFAULT_PAGE, 1), MAX_PAGE);
    const deadlineMs = Math.min(
      Math.max(Number(body.deadline_ms) || DEFAULT_DEADLINE_MS, 5_000), MAX_DEADLINE_MS);
    const only = Array.isArray(body.tables)
      ? new Set((body.tables as unknown[]).filter((t): t is string => typeof t === 'string'))
      : null;
    const resume = (body.resume_from ?? null) as { table?: string; cursor?: unknown } | null;

    // ── Manifest first, always ──────────────────────────────────────────────
    // This is also where authorization actually happens: a caller who is not a
    // tenant_owner/tenant_admin of this tenant gets 42501 here and never reaches
    // a single row. Doing it before the response status is committed is what lets
    // us return a real 403 instead of an error buried in a 200 stream.
    const { data: manifest, error: manErr } = await asUser
      .rpc('export_tenant_manifest', { p_tenant: tenantId, p_include_counts: true });
    if (manErr) {
      const denied = manErr.code === '42501' || /not authorized/i.test(manErr.message ?? '');
      return json(
        { error: denied ? 'forbidden' : 'manifest_failed', message: manErr.message },
        denied ? 403 : 400,
      );
    }

    const allTables = ((manifest?.tables ?? []) as ManifestTable[]);
    if (body.manifest_only === true) return json(manifest);

    // The manifest is ordered by table name (export_tenant_surface orders by
    // relname), so the sequence is deterministic — which is the only reason a
    // resume cursor can mean anything across two separate requests.
    let queue = allTables.filter((t) => (t.rows ?? 0) > 0);
    if (only) {
      // A misspelt table name must not silently produce a smaller archive that
      // looks complete. Empty tables are a different matter — they are absent
      // from `queue` because they genuinely hold nothing, and the manifest
      // already says so with rows: 0.
      const known = new Set(allTables.map((t) => t.table));
      const unknown = [...only].filter((t) => !known.has(t));
      if (unknown.length) {
        return json({ error: 'unknown_tables', tables: unknown }, 400);
      }
      queue = queue.filter((t) => only.has(t.table));
    }
    if (resume?.table) {
      const at = queue.findIndex((t) => t.table === resume.table);
      if (at === -1) {
        return json({ error: 'bad_resume', message: `${resume.table} has no rows to resume` }, 400);
      }
      queue = queue.slice(at);
    }

    // Stripped rather than interpolated raw: this lands in a Content-Disposition
    // header, and a quote in a value that reaches a response header is how header
    // injection starts. Slugs are [a-z0-9-] today; that is not a reason to trust
    // the column forever.
    const slug = String(manifest?.tenant?.slug ?? 'tenant').replace(/[^a-zA-Z0-9-]/g, '') || 'tenant';
    const filename = `dreamteam-export-${slug}-${new Date().toISOString().slice(0, 10)}.ndjson`;
    const startedAt = Date.now();
    let cancelled = false;

    // ── The stream ──────────────────────────────────────────────────────────
    async function* lines(): AsyncGenerator<string> {
      const line = (o: unknown) => JSON.stringify(o) + '\n';
      const exported: Record<string, number> = {};
      const failed: Array<{ table: string; message: string }> = [];
      let rowsOut = 0;
      let truncated: { table: string; cursor: unknown } | null = null;
      let aborted: string | null = null;

      yield line({ type: 'manifest', ...manifest });

      for (let i = 0; i < queue.length; i++) {
        const t = queue[i];
        if (cancelled) break;
        if (Date.now() - startedAt > deadlineMs) {
          // Nothing of this table has been sent, so the resume point is its start.
          truncated = { table: t.table, cursor: null };
          break;
        }

        yield line({
          type: 'table_start',
          table: t.table,
          rows: t.rows,
          columns_omitted: t.columns_omitted,
          columns_redacted: t.columns_redacted,
        });

        let cursor: unknown = i === 0 ? (resume?.cursor ?? null) : null;
        let got = 0;
        let complete = false;

        for (;;) {
          if (cancelled) break;
          if (Date.now() - startedAt > deadlineMs) {
            truncated = { table: t.table, cursor };
            break;
          }
          const { data: page, error: pageErr } = await asUser.rpc('export_tenant_table_page', {
            p_tenant: tenantId,
            p_table: t.table,
            p_cursor: cursor,
            p_limit: pageSize,
          });
          if (pageErr) {
            // One bad table must not cost the customer the other 225. It is
            // recorded by name in the stream AND in the summary — never dropped,
            // which would leave a gap that looks exactly like "you had no rows".
            failed.push({ table: t.table, message: pageErr.message ?? 'unknown error' });
            yield line({ type: 'table_error', table: t.table, message: pageErr.message });
            // An auth failure is not a per-table problem. A JWT that expires
            // mid-export (these can run for minutes) would otherwise mark every
            // remaining table as individually broken and bury the one real cause
            // under 200 identical lines. Stop, and hand back a resume point.
            if (pageErr.code === '42501' || pageErr.code === 'PGRST301'
                || /jwt|token/i.test(pageErr.message ?? '')) {
              aborted = 'authorization was lost part-way through — sign in again and resume';
              truncated = { table: t.table, cursor };
            }
            break;
          }

          const rows = (page?.rows ?? []) as unknown[];
          // Serialized a page at a time and handed straight to the consumer, so
          // peak memory is one page regardless of how big the table is.
          if (rows.length) {
            yield rows.map((r) => line({ type: 'row', table: t.table, data: r })).join('');
          }
          got += rows.length;
          rowsOut += rows.length;
          cursor = page?.next_cursor ?? null;

          if (page?.complete === true || rows.length === 0 || cursor === null) {
            complete = true;
            break;
          }
        }

        exported[t.table] = got;
        yield line({
          type: 'table_end',
          table: t.table,
          exported: got,
          expected: t.rows,
          complete,
          // Counts are taken before the run and rows are read during it, so a
          // live workspace legitimately drifts. Saying so beats implying the
          // export lost something, or that it captured a frozen instant.
          note: complete && got !== t.rows
            ? 'row count changed while exporting — the workspace was in use'
            : undefined,
        });

        if (truncated || aborted) break;
      }

      yield line({
        type: 'summary',
        finished_at: new Date().toISOString(),
        elapsed_ms: Date.now() - startedAt,
        tables_exported: Object.keys(exported).length,
        tables_expected: queue.length,
        rows_exported: rowsOut,
        // The single most important field in the file.
        complete: !truncated && !aborted && !cancelled && failed.length === 0,
        cancelled,
        aborted,
        failed_tables: failed,
        truncated: truncated
          ? {
            reason: aborted ?? `stopped after ${deadlineMs} ms to finish cleanly`,
            resume_from: truncated,
            how: 'POST again with resume_from set to the object above to continue '
              + 'where this stream stopped.',
          }
          : null,
        reminder: 'This is a data extract, not a system backup — see not_included '
          + 'in the manifest line at the top of this file.',
      });
    }

    const it = lines();
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      // pull, not a push loop in start(): the generator only advances when the
      // consumer is ready for more, so a slow client throttles the export instead
      // of filling the queue with pages nobody is reading yet.
      async pull(controller) {
        try {
          const { value, done } = await it.next();
          if (done) { controller.close(); return; }
          controller.enqueue(enc.encode(value));
        } catch (streamErr) {
          // The 200 and its headers are long gone by now, so there is no status
          // code left to fail with. Put the failure IN the file, as the last
          // line, and let the reader see that it is not whole.
          console.error('tenant-export stream error:', String(streamErr));
          await reportEdgeError('tenant-export', streamErr, { phase: 'stream' }, tenantId);
          controller.enqueue(enc.encode(JSON.stringify({
            type: 'summary',
            complete: false,
            error: 'the export failed part-way through and this file is incomplete',
          }) + '\n'));
          controller.close();
        }
      },
      cancel() { cancelled = true; },
    });

    return new Response(stream, {
      headers: {
        ...CORS,
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    console.error('tenant-export error:', String(err));
    await reportEdgeError('tenant-export', err, {});
    return json({ error: 'internal' }, 500);
  }
});
