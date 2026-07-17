/**
 * de-perceive — closes the execution half of two Wave-2 muscles now that
 * the key is live:
 *   action:'extract_fields' (#8) — LLM extracts named fields from OCR/
 *     document text per a template, stored UNVERIFIED (a DE must not act
 *     on the values until verify_extraction_result flips them — mig 159).
 *   action:'nl_query' (#9) — LLM maps a natural-language question to ONE
 *     vetted analytics key + params from the analytics_query_defs
 *     allowlist, then runs run_analytics_query. The model only PICKS from
 *     the catalog; it never authors SQL, so there is no injection surface.
 *
 * Auth: dispatch secret or a tenant member's JWT. verify_jwt=false.
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getAIKey } from '../_shared/aiKeys.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-dispatch-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

async function claude(apiKey: string, system: string, user: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 1024, system, messages: [{ role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`anthropic_${res.status}: ${(await res.text()).slice(0, 200)}`);
  const d = await res.json();
  return (d.content ?? []).find((b: { type?: string }) => b.type === 'text')?.text ?? '';
}
function parseJson(s: string): Record<string, unknown> | null {
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < 0) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const { action, tenant_id } = body;
    if (!tenant_id) return json({ error: 'tenant_id required' }, 400);

    const admin: SupabaseClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // Auth: dispatch secret or tenant-member JWT.
    const dispatch = Deno.env.get('PLAYBOOK_DISPATCH_SECRET') ?? '';
    const isDispatch = dispatch && req.headers.get('x-dispatch-secret') === dispatch;
    if (!isDispatch) {
      const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
      const { data: u } = await admin.auth.getUser(jwt);
      if (!u?.user) return json({ error: 'unauthorized' }, 401);
      const { data: prof } = await admin.from('profiles').select('tenant_id, layer').eq('user_id', u.user.id).maybeSingle();
      if (!(prof?.layer === 'platform' || prof?.tenant_id === tenant_id)) return json({ error: 'forbidden' }, 403);
    }

    const apiKey = await getAIKey(admin, 'ANTHROPIC_API_KEY');
    if (!apiKey) return json({ error: 'llm_not_configured' }, 503);

    // Cost governance: this is an LLM call site — it must sit inside the
    // same budget net as every other one (was previously ungated).
    const { data: budget } = await admin.rpc('check_tenant_ai_budget', { p_tenant_id: tenant_id });
    if (budget && budget.allowed === false) return json({ error: 'ai_budget_exceeded' }, 429);

    if (action === 'extract_fields') {
      let fields = Array.isArray(body.fields) ? body.fields : null;
      if (!fields && body.template_id) {
        const { data: t } = await admin.from('extraction_templates').select('fields').eq('id', body.template_id).eq('tenant_id', tenant_id).maybeSingle();
        fields = (t?.fields as unknown[]) ?? null;
      }
      const text = String(body.text ?? '');
      if (!fields || fields.length === 0 || !text) return json({ error: 'fields (or template_id) and text required' }, 400);
      const fieldList = fields.map((f: { key: string; label?: string; type?: string }) => `- ${f.key} (${f.type ?? 'string'}): ${f.label ?? f.key}`).join('\n');
      const system = 'You extract structured fields from a document. Return ONLY JSON: {"fields": {<key>: <value or null>}, "confidence": {<key>: 0-1}}. Use null when the document does not contain a field. Never invent values.';
      const out = parseJson(await claude(apiKey, system, `Fields to extract:\n${fieldList}\n\nDocument:\n${text.slice(0, 8000)}`));
      const extracted = (out?.fields as Record<string, unknown>) ?? {};
      const confidence = (out?.confidence as Record<string, unknown>) ?? {};
      const { data: row, error } = await admin.from('extraction_results')
        .insert({ tenant_id, template_id: body.template_id ?? null, source_kind: 'text', source_ref: body.source_ref ?? null, extracted, confidence, verified: false })
        .select('id').single();
      if (error) return json({ error: error.message }, 400);
      return json({ extraction_id: row.id, extracted, confidence, verified: false, note: 'stored UNVERIFIED — verify before acting on these values' });
    }

    if (action === 'nl_query') {
      const question = String(body.question ?? '');
      if (!question) return json({ error: 'question required' }, 400);
      const { data: defs } = await admin.from('analytics_query_defs')
        .select('key, name, description, param_schema')
        .or(`scope.eq.platform,tenant_id.eq.${tenant_id}`).eq('status', 'active');
      if (!defs || defs.length === 0) return json({ error: 'no analytics queries available' }, 404);
      const catalog = defs.map((d: { key: string; name: string; description: string; param_schema: unknown }) => `- key "${d.key}" (${d.name}): ${d.description}. params: ${JSON.stringify(d.param_schema)}`).join('\n');
      const system = 'You pick the ONE analytics query that answers the question. Return ONLY JSON: {"key": "<one of the listed keys, or null>", "params": {...}}. Never invent a key.';
      const pick = parseJson(await claude(apiKey, system, `Available queries:\n${catalog}\n\nQuestion: ${question}`));
      const key = pick?.key as string | null;
      if (!key || !defs.some((d: { key: string }) => d.key === key)) {
        return json({ key: null, result: null, note: 'no vetted query matched the question' });
      }
      const params = (pick?.params as Record<string, unknown>) ?? {};
      const { data: result, error } = await admin.rpc('run_analytics_query', { p_tenant_id: tenant_id, p_key: key, p_params: params });
      if (error) return json({ error: error.message }, 400);
      return json({ key, params, result });
    }

    return json({ error: 'unknown_action' }, 400);
  } catch (err) {
    console.error('de-perceive error:', err);
    return json({ error: String(err) }, 500);
  }
});
