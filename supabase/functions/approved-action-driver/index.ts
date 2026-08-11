// approved-action-driver — carry out actions a human has already approved.
//
// WHY THIS EXISTS. An approved action only ran when someone clicked in the web
// app; resolveActionExecution in src/lib/connectorApi.ts was the only caller.
// A decision made on a phone, by email, or overnight sat there until a browser
// tab opened. Six July approvals were still waiting a month later.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not execute anything. It has no
// connector logic, no gate, no claim. It finds due work and POSTs to
// connector-hub's existing `execute_action` with approved_execution_id — the
// SAME entry point the browser uses, which already accepts x-dispatch-secret
// plus an explicit tenant_id for headless flows. The action/connector binding
// check, the forged-approval refusal, and claim_gated_action_execution's
// exactly-once claim all stay exactly where they are. This decides WHEN;
// connector-hub decides WHETHER. There is no second execution path.
//
// EVERY GUARD LIVES IN SQL, not here. due_approved_actions() applies the
// enabled_at watermark, the tenant allowlist, the suspended-tenant exclusion
// and the already-claimed exclusion. A driver whose safety lives in its own
// TypeScript is one refactor from unsafe; this one returns nothing to do when
// the dials are off, no matter what this file says.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const DISPATCH_SECRET = Deno.env.get('PLAYBOOK_DISPATCH_SECRET') ?? '';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

interface DueAction {
  tenant_id: string;
  tenant_slug: string;
  task_id: string;
  execution_id: string;
  connector_id: string;
  /** WHICH executor was approved. `action_key` alone is not an executor:
   *  on production today `send_payment_reminder` and `send_final_notice` each
   *  resolve to TWO live ERPNext definitions — an internal invoice comment and
   *  an email to the customer. connector-hub refuses to guess between them
   *  (`action_ambiguous`, index.ts:2186), so a driver that forwards only the
   *  key can carry out nothing on exactly the rungs it exists to run. The id
   *  was always on the row being acted on; mig 703 stopped throwing it away.
   *  NOT NULL at the table, and mig 703 asserts that premise. */
  action_definition_id: string;
  action_key: string;
  action_label: string;
  params: Record<string, unknown>;
  decided_at: string;
}

Deno.serve(async (req) => {
  // Cron-only. There is no user-facing form of this endpoint: everything it can
  // do, a signed-in person can already do by clicking Approve.
  const headerSecret = req.headers.get('x-dispatch-secret') ?? '';
  if (DISPATCH_SECRET === '' || headerSecret !== DISPATCH_SECRET) {
    return json({ ok: false, error: 'forbidden' }, 403);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  });

  const body = await req.json().catch(() => ({}));
  const limit = Number((body as { limit?: number })?.limit ?? 25);

  // .rpc() RESOLVES on a Postgres error — it does not throw. An unchecked error
  // here would look identical to "nothing to do", which is exactly how a driver
  // goes quietly dead for a month.
  const { data, error } = await admin.rpc('due_approved_actions', { p_limit: limit });
  if (error) {
    console.error(`[approved-action-driver] due_approved_actions failed: ${error.message}`);
    return json({ ok: false, error: 'due_query_failed', detail: error.message }, 503);
  }

  const due = (data ?? []) as DueAction[];
  if (due.length === 0) {
    return json({ ok: true, due: 0, executed: 0, failed: 0, results: [] });
  }

  const results: Array<Record<string, unknown>> = [];
  let executed = 0;
  let failed = 0;

  for (const item of due) {
    // Sequential, not parallel, and deliberately so. These are real writes into
    // customer systems; a burst of them is not a throughput win worth having,
    // and the 5-minute tick gives ample headroom at this volume.
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/connector-hub`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ANON_KEY}`,
          apikey: ANON_KEY,
          'x-dispatch-secret': DISPATCH_SECRET,
        },
        body: JSON.stringify({
          action: 'execute_action',
          tenant_id: item.tenant_id,
          connector_id: item.connector_id,
          // NAME THE EXECUTOR. Without this connector-hub re-derives the
          // definition from (connector, action_key) and refuses when that is
          // ambiguous — and even a lucky resolution to the wrong sibling would
          // then be caught by the approval binding at index.ts:7365
          // (`approval_mismatch`), because the approval was granted for ONE
          // definition. Same fix shape as mig 701 gave the browser path
          // (`resolveActionExecution` forwards `row.action_definition_id`), so
          // the two paths agree on how an approval names what it authorises.
          action_definition_id: item.action_definition_id,
          action_key: item.action_key,
          params: item.params ?? {},
          approved_execution_id: item.execution_id,
        }),
      });
      const out = await res.json().catch(() => ({}));

      // connector-hub reports refusal INSIDE an HTTP 200 ({ok:false,error}).
      // Reading only res.ok would count a refused execution as a success — the
      // silent-refusal class this codebase has a standing audit for.
      const okay = res.ok && (out as { ok?: boolean })?.ok === true;
      if (okay) executed++; else failed++;

      results.push({
        tenant: item.tenant_slug,
        action: item.action_label,
        task_id: item.task_id,
        ok: okay,
        already_executed: (out as { already_executed?: boolean })?.already_executed ?? false,
        error: okay ? null : ((out as { error?: string })?.error ?? `http_${res.status}`),
      });

      if (!okay) {
        console.error(`[approved-action-driver] ${item.tenant_slug} ${item.action_key} refused: ${(out as { error?: string })?.error ?? res.status}`);
      }
    } catch (e) {
      // NO RETRY, here or on the next tick by accident. A failed attempt leaves
      // no resolves_task_id row, so the item stays due and will be retried on
      // the next tick — but only because the CLAIM is exactly-once. Retrying
      // inside this loop would risk a second external call on a timeout whose
      // write actually landed.
      failed++;
      results.push({
        tenant: item.tenant_slug, action: item.action_label, task_id: item.task_id,
        ok: false, error: `exception: ${(e as Error).message}`,
      });
      console.error(`[approved-action-driver] ${item.tenant_slug} ${item.action_key} threw: ${(e as Error).message}`);
    }
  }

  // Loud when it matters. A driver that fails silently is worse than no driver:
  // the approval still looks handled.
  if (failed > 0) {
    await admin.rpc('raise_ops_alert', {
      p_kind: 'approved_action_driver_failures',
      p_message: `${failed} approved action(s) could not be carried out on this tick.`,
      p_context: { failed, executed, results: results.filter((r) => !r.ok) },
    });
  }

  return json({ ok: true, due: due.length, executed, failed, results });
});
