/**
 * de-memory — durable DE memory read/write with free edge embeddings.
 *
 * The reasoning layer (agentic loop / de-answer) calls this to REMEMBER
 * ("what happened on this case") and RECALL ("what do I know about this
 * account"). Embeddings are the free gte-small 384-dim vectors computed
 * here in the edge runtime (_shared/knowledgeEmbed.ts) and handed to the
 * de_memory_write / de_memory_search RPCs (migration 155). Null embedding
 * degrades to recency+salience recall — memory always works, semantics
 * just sharpen it.
 *
 * Auth: dispatch secret / service-role bearer (server-to-server), or a
 * signed-in tenant member's JWT resolved via resolveTenantWithRemoteAccess.
 * Deployed verify_jwt=false, so this function enforces auth ITSELF before
 * any service-role RPC — the RPC membership check is skipped under service
 * role, which previously left this endpoint effectively unauthenticated
 * (external review 2026-07-20, finding P0-3). The DE must belong to the
 * resolved tenant for both read and write.
 *
 * Actions (POST JSON):
 *   { action:'write', tenant_id, de_id, content, subject_kind?, subject_ref?,
 *     kind?, salience?, source?, expires_at? }            -> { id }
 *   { action:'search', tenant_id, de_id, query?, subject_kind?, subject_ref?,
 *     kinds?, match_count? }                               -> { matches:[...] }
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { embedText } from '../_shared/knowledgeEmbed.ts';
import { secureEqual } from '../_shared/secureCompare.ts';
import { resolveTenantWithRemoteAccess } from '../_shared/resolveTenant.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-dispatch-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const { action, tenant_id, de_id } = body;
    if (!tenant_id || !de_id) return json({ error: 'tenant_id and de_id required' }, 400);

    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey);

    // ── Auth gate (before any service-role RPC) ──
    const dispatchSecret = Deno.env.get('PLAYBOOK_DISPATCH_SECRET') ?? '';
    const headerSecret = req.headers.get('x-dispatch-secret') ?? '';
    const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const isDispatch = dispatchSecret !== '' && (await secureEqual(headerSecret, dispatchSecret));
    const isServiceRole = serviceKey !== '' && (await secureEqual(bearer, serviceKey));

    if (!isDispatch && !isServiceRole) {
      // Browser/user path: validate the JWT and resolve the tenant from the
      // authenticated profile (with audited remote access for platform ops).
      const { data: userData, error: userErr } = await admin.auth.getUser(bearer);
      if (userErr || !userData?.user) return json({ error: 'unauthorized' }, 401);
      const { data: prof } = await admin
        .from('profiles')
        .select('tenant_id, layer')
        .eq('user_id', userData.user.id)
        .maybeSingle();
      const resolved = await resolveTenantWithRemoteAccess(
        admin, userData.user.id, prof?.tenant_id, prof?.layer, tenant_id,
      );
      if (!resolved || resolved !== tenant_id) return json({ error: 'not_authorized_for_tenant' }, 403);
    }

    // The DE must belong to the asserted tenant for every path — a poisoned
    // memory write into another tenant's DE is the exact exploit this blocks.
    const { data: deRow } = await admin
      .from('digital_employees')
      .select('id')
      .eq('id', de_id)
      .eq('tenant_id', tenant_id)
      .maybeSingle();
    if (!deRow) return json({ error: 'de_not_in_tenant' }, 403);

    if (action === 'write') {
      const content = typeof body.content === 'string' ? body.content.trim() : '';
      if (!content) return json({ error: 'content required' }, 400);
      const embedding = await embedText(content.slice(0, 4000)); // null-safe
      const { data, error } = await admin.rpc('de_memory_write', {
        p_tenant_id: tenant_id, p_de_id: de_id, p_content: content,
        p_embedding: embedding, p_subject_kind: body.subject_kind ?? 'general',
        p_subject_ref: body.subject_ref ?? null, p_kind: body.kind ?? 'episodic',
        p_salience: typeof body.salience === 'number' ? body.salience : 0.5,
        p_source: body.source ?? 'de', p_expires_at: body.expires_at ?? null,
      });
      if (error) return json({ error: error.message }, 400);
      return json({ id: data, embedded: embedding != null });
    }

    if (action === 'search') {
      const query = typeof body.query === 'string' ? body.query.trim() : '';
      const embedding = query ? await embedText(query.slice(0, 2000)) : null;
      const { data, error } = await admin.rpc('de_memory_search', {
        p_tenant_id: tenant_id, p_de_id: de_id, p_query_embedding: embedding,
        p_subject_kind: body.subject_kind ?? null, p_subject_ref: body.subject_ref ?? null,
        p_kinds: Array.isArray(body.kinds) ? body.kinds : null,
        p_match_count: typeof body.match_count === 'number' ? body.match_count : 8,
      });
      if (error) return json({ error: error.message }, 400);
      return json({ matches: data ?? [], semantic: embedding != null });
    }

    return json({ error: 'unknown_action' }, 400);
  } catch (err) {
    console.error('de-memory error:', err);
    return json({ error: String(err) }, 500);
  }
});
