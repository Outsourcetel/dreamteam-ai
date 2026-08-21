/**
 * platform-tenant-delete — delete a workspace that is too large for the
 * console's database budget, without lying about who deleted it.
 *
 * WHY THIS EXISTS
 * `authenticated` runs with statement_timeout = 8s (Supabase's default). A
 * workspace of any real size cannot be swept in eight seconds — acme-telecom,
 * 47,763 rows, takes 22-30s — so the console returns
 *
 *     canceling statement due to statement timeout
 *
 * and the workspace is simply undeletable from the UI. Twelve smaller ones
 * (78-804 rows) went through fine on 2026-08-20, which is why the ceiling
 * stayed invisible until the first workspace with volume met it.
 *
 * ⚠ THE IN-DATABASE FIX DOES NOT EXIST. Raising statement_timeout inside
 * delete_tenant cannot work: the budget is armed when the statement starts, so
 * a function cannot extend the statement already running it. That was written,
 * tested against an 8s budget armed by a prior statement, observed to time out
 * identically, and thrown away. The timeout has to be someone else's.
 *
 * `service_role` carries no statement_timeout override and inherits the
 * database default of 2min — four times what the largest sweep needs. This
 * function is that caller.
 *
 * ── The part that is actually hard ─────────────────────────────────────────
 * delete_tenant stamps tenant_deletion_receipts.deleted_by from auth.uid().
 * Running the sweep as service_role would leave that NULL, or — worse — invite
 * whoever wrote the caller to put a name in it. A receipt naming the wrong
 * person is worse than a slow delete: it is the one record that outlives the
 * data it describes.
 *
 * So the identity is CARRIED, not assumed:
 *
 *   1. the caller's JWT is verified cryptographically (admin.auth.getUser)
 *   2. the verified user id is passed to delete_tenant_as as p_actor
 *   3. the database re-checks that THAT user holds tenants.manage, so this
 *      function cannot manufacture authority — only pass along one that exists
 *
 * This function is therefore transport with a longer clock, not a privilege
 * escalation. Everything it can do, the named human could already do; it just
 * has time to finish.
 *
 * Auth: user JWT + tenants.manage. Platform operator tooling, never a tenant
 * surface. Migration 825 supplies delete_tenant_as and is its only caller.
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.112.3';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);

  try {
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // ── 1. who is asking, proven rather than claimed ────────────────────────
    const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!bearer) return json({ ok: false, error: 'unauthorized', detail: 'user JWT required' }, 401);
    const { data: u } = await admin.auth.getUser(bearer);
    if (!u?.user) return json({ ok: false, error: 'unauthorized', detail: 'user JWT required' }, 401);
    const actor = u.user.id;

    // ── 2. what they asked for ──────────────────────────────────────────────
    const body = await req.json().catch(() => ({}));
    const tenantId = String(body?.tenant_id ?? '').trim();
    const confirmSlug = String(body?.confirm_slug ?? '').trim();
    if (!tenantId || !confirmSlug) {
      return json({ ok: false, error: 'bad_request', detail: 'tenant_id and confirm_slug are both required' }, 400);
    }

    // ── 3. may they? asked AS THEM, not as service_role ─────────────────────
    // Defence in depth — delete_tenant_as re-checks this against p_actor
    // server-side and would refuse anyway. This is here so the caller gets a
    // 403 that says why, instead of a raised exception from inside a sweep.
    const asUser = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: `Bearer ${bearer}` } } },
    );
    const { data: permitted } = await asUser.rpc('resolve_platform_capability', {
      p_user_id: actor,
      p_capability: 'tenants.manage',
    });
    if (permitted !== true) {
      return json({ ok: false, error: 'not_permitted', detail: 'tenants.manage is required to delete a workspace' }, 403);
    }

    // ── 4. the sweep, on service_role's 2min budget ─────────────────────────
    // Every rail still applies inside: suspended-first, exact slug, not your
    // own tenant, no child tenants, and the receipt records `actor`.
    const startedAt = Date.now();
    const { data, error } = await admin.rpc('delete_tenant_as', {
      p_tenant_id: tenantId,
      p_confirm_slug: confirmSlug,
      p_actor: actor,
    });
    const elapsedMs = Date.now() - startedAt;

    if (error) {
      // ⚠ REPORT THE DATABASE'S OWN WORDS. The rails raise sentences written to
      // be read by a person ("suspend the tenant before deleting it"), and
      // flattening them into "delete failed" is how an operator ends up
      // debugging the wrong thing — which is exactly what the bare
      // statement-timeout message did.
      return json({ ok: false, error: 'delete_failed', detail: error.message, elapsed_ms: elapsedMs }, 400);
    }

    // The RPC returns delete_tenant's own receipt payload — rows_removed,
    // profiles_removed, residual_after, verified. Passed through unchanged:
    // the caller should see what the database recorded, not a summary of it.
    return json({ ok: true, elapsed_ms: elapsedMs, receipt: data });
  } catch (e) {
    return json({ ok: false, error: 'unhandled', detail: e instanceof Error ? e.message : String(e) }, 500);
  }
});
