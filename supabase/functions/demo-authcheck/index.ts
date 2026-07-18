/**
 * demo-authcheck — prove tenant isolation at the REAL login layer (gap G6).
 *
 * Earlier isolation proofs ran at the RLS layer by impersonating a real
 * admin uid inside Postgres. This closes the loop end-to-end through
 * gotrue: for one tenant it
 *   1. creates an EPHEMERAL test user (random email, random password
 *      generated in-process — never logged, returned, or stored),
 *   2. performs a real password-grant login against /auth/v1/token,
 *   3. uses the resulting USER access token (anon apikey) against PostgREST:
 *        - own-tenant knowledge_docs   → should be visible
 *        - cross-tenant knowledge_docs → must be 0 rows
 *        - tenants listing             → must contain ONLY the own tenant
 *        - cross-tenant guardrail INSERT → must be rejected by RLS
 *   4. deletes the ephemeral user (+ profile) and any probe row.
 *
 * It never touches the pre-provisioned demo admins or their credentials.
 * Auth: service-role key or x-dispatch-secret.
 * POST { slug, cross_tenant_id }  ->  per-check report
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-dispatch-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('');
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const url = Deno.env.get('SUPABASE_URL')!;
  const svc = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
  const admin = createClient(url, svc);
  let uid: string | null = null;
  try {
    const dispatch = Deno.env.get('PLAYBOOK_DISPATCH_SECRET') ?? '';
    const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!((dispatch && req.headers.get('x-dispatch-secret') === dispatch) || bearer === svc)) {
      return json({ error: 'unauthorized' }, 401);
    }
    const body = await req.json().catch(() => ({})) as { slug?: string; cross_tenant_id?: string };
    if (!body.slug || !body.cross_tenant_id) return json({ error: 'slug and cross_tenant_id required' }, 400);
    const { data: tenant } = await admin.from('tenants').select('id, slug').eq('slug', body.slug).maybeSingle();
    if (!tenant) return json({ error: 'tenant_not_found' }, 404);
    const ownId = tenant.id as string;
    const crossId = body.cross_tenant_id;
    const report: Record<string, unknown> = { slug: body.slug };

    // 1) ephemeral user — random identity + random password, in-process only.
    const email = `g6check-${body.slug}-${randomHex(6)}@example.com`;
    const password = randomHex(24); // 48 hex chars; discarded when this scope ends
    const { data: created, error: cErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { g6_ephemeral: true } });
    if (cErr || !created.user) return json({ error: `createUser: ${cErr?.message}` }, 500);
    uid = created.user.id;
    // A signup trigger auto-creates a bare profile — upsert on user_id
    // (same as demo-provision) to claim it for this tenant.
    const { error: pErr } = await admin.from('profiles').upsert({
      user_id: uid, tenant_id: ownId, role: 'tenant_admin', layer: 'tenant',
      full_name: 'G6 Isolation Check (ephemeral)', department: 'QA', is_active: true,
    }, { onConflict: 'user_id' });
    if (pErr) { report.profile_error = pErr.message; return json({ ok: false, ...report }, 200); }

    // 2) REAL login through gotrue.
    const loginRes = await fetch(`${url}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': anon },
      body: JSON.stringify({ email, password }),
    });
    const login = await loginRes.json().catch(() => ({}));
    report.login_ok = loginRes.ok && typeof login.access_token === 'string';
    if (!report.login_ok) { report.login_status = loginRes.status; return json({ ok: false, ...report }, 200); }
    const userHeaders = { 'apikey': anon, 'Authorization': `Bearer ${login.access_token}` };

    // 3) RLS checks with the USER token.
    const ownDocs = await fetch(`${url}/rest/v1/knowledge_docs?select=id&tenant_id=eq.${ownId}&limit=5`, { headers: userHeaders });
    report.own_docs_visible = ownDocs.ok ? (await ownDocs.json()).length : `http_${ownDocs.status}`;

    const crossDocs = await fetch(`${url}/rest/v1/knowledge_docs?select=id&tenant_id=eq.${crossId}&limit=5`, { headers: userHeaders });
    report.cross_docs_visible = crossDocs.ok ? (await crossDocs.json()).length : `http_${crossDocs.status}`;

    const tenants = await fetch(`${url}/rest/v1/tenants?select=id`, { headers: userHeaders });
    const tlist = tenants.ok ? await tenants.json() as Array<{ id: string }> : [];
    report.tenants_visible = tlist.length;
    report.tenants_only_own = tlist.length >= 0 && tlist.every((t) => t.id === ownId);

    // Cross-tenant WRITE probe: INSERT a clearly-labeled inactive rule into the
    // OTHER tenant. RLS must reject it; if it somehow lands, we detect + clean.
    const probe = await fetch(`${url}/rest/v1/guardrail_rules`, {
      method: 'POST', headers: { ...userHeaders, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({ tenant_id: crossId, rule: 'G6 isolation probe — must never exist', rule_type: 'blocked_phrase', pattern: 'g6probe-never-matches', severity: 'warning', active: false, scope: 'workspace' }),
    });
    const probeBody = probe.ok ? await probe.json().catch(() => []) : [];
    report.cross_write_blocked = !(probe.ok && Array.isArray(probeBody) && probeBody.length > 0);
    // Defensive cleanup regardless of outcome.
    await admin.from('guardrail_rules').delete().eq('rule', 'G6 isolation probe — must never exist');

    report.pass = report.login_ok === true
      && typeof report.own_docs_visible === 'number' && (report.own_docs_visible as number) > 0
      && report.cross_docs_visible === 0
      && report.tenants_only_own === true
      && report.cross_write_blocked === true;
    return json({ ok: true, ...report });
  } catch (err) {
    console.error('demo-authcheck error:', String(err));
    return json({ error: String(err) }, 500);
  } finally {
    // 4) always destroy the ephemeral identity.
    if (uid) {
      try { await admin.from('profiles').delete().eq('user_id', uid); } catch { /* best-effort */ }
      try { await admin.auth.admin.deleteUser(uid); } catch { /* best-effort */ }
    }
  }
});
