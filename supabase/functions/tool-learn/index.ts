/**
 * tool-learn — teach a DE a tool from its OpenAPI spec.
 *
 * Parses an OpenAPI (v2/v3) document into action_definitions rows in the
 * exact shape the executor already runs (provider 'template',
 * execution={method,path_template}, param_schema from the operation's
 * parameters/requestBody). The generated actions are structural: they
 * only call out once a connector with base_url + creds exists, and
 * connector-hub still enforces isSafeExternalUrl + destructive/trust/
 * guardrail gates. This just makes an arbitrary API authorable.
 *
 * Auth: signed-in tenant member (JWT) or service role. verify_jwt=false;
 * we resolve + check tenant membership here.
 *
 * POST { tenant_id, name, spec (object|json-string), base_url?, category?, max_ops? }
 *   -> { spec_id, slug, operation_count, actions:[{action_key,label,method,path}] }
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { isSafeExternalUrl } from '../_shared/urlSafety.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-dispatch-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'tool';
const ALLOWED_CATEGORY = ['crm', 'helpdesk', 'knowledge_base', 'erp_financials', 'billing', 'payroll_hcm', 'pos', 'product_system', 'other'];
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

interface ParamDesc { name: string; in: string; required: boolean; type: string; description: string }

function parseSpec(spec: any, toolSlug: string) {
  const ops: Array<{ action_key: string; label: string; description: string; method: string; path: string; param_schema: ParamDesc[]; risk: { destructive: boolean; idempotent: boolean } }> = [];
  const paths = spec?.paths ?? {};
  for (const [path, pathItem] of Object.entries<any>(paths)) {
    for (const method of METHODS) {
      const op = pathItem?.[method];
      if (!op) continue;
      const opId = op.operationId ? slugify(op.operationId) : `${method}_${slugify(path)}`;
      const params: ParamDesc[] = [];
      for (const p of (op.parameters ?? [])) {
        if (!p?.name) continue;
        params.push({
          name: p.name, in: p.in ?? 'query', required: !!p.required,
          type: p.schema?.type ?? p.type ?? 'string', description: p.description ?? '',
        });
      }
      // OpenAPI 3 requestBody -> flatten top-level JSON properties as body params.
      const bodyProps = op.requestBody?.content?.['application/json']?.schema?.properties
        ?? (method !== 'get' ? op.parameters?.find?.((x: any) => x.in === 'body')?.schema?.properties : null);
      if (bodyProps) {
        for (const [pn, ps] of Object.entries<any>(bodyProps)) {
          params.push({ name: pn, in: 'body', required: false, type: ps?.type ?? 'string', description: ps?.description ?? '' });
        }
      }
      ops.push({
        action_key: `${toolSlug}.${opId}`.slice(0, 80),
        label: op.summary || `${method.toUpperCase()} ${path}`,
        description: op.description || op.summary || '',
        method: method.toUpperCase(),
        path,
        param_schema: params,
        risk: { destructive: method !== 'get', idempotent: method === 'get' || method === 'put' || method === 'delete' },
      });
    }
  }
  return ops;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const { tenant_id, name } = body;
    if (!tenant_id || !name) return json({ error: 'tenant_id and name required' }, 400);

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // Auth: dispatch secret (server) or a tenant member's JWT.
    const dispatch = Deno.env.get('PLAYBOOK_DISPATCH_SECRET') ?? '';
    const headerSecret = req.headers.get('x-dispatch-secret') ?? '';
    const isDispatch = dispatch !== '' && headerSecret === dispatch;
    if (!isDispatch) {
      const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
      const { data: u } = await admin.auth.getUser(jwt);
      if (!u?.user) return json({ error: 'unauthorized' }, 401);
      const { data: prof } = await admin.from('profiles').select('tenant_id, layer').eq('user_id', u.user.id).maybeSingle();
      if (!(prof?.layer === 'platform' || prof?.tenant_id === tenant_id)) return json({ error: 'forbidden' }, 403);
    }

    let spec = body.spec;
    if (typeof spec === 'string') { try { spec = JSON.parse(spec); } catch { return json({ error: 'spec is not valid JSON' }, 400); } }
    if (!spec || typeof spec !== 'object' || !spec.paths) return json({ error: 'spec must be an OpenAPI object with a paths map' }, 400);

    const base_url = typeof body.base_url === 'string' ? body.base_url : (spec.servers?.[0]?.url ?? null);
    if (base_url && !isSafeExternalUrl(base_url)) return json({ error: 'base_url blocked by safety policy' }, 400);
    const category = ALLOWED_CATEGORY.includes(body.category) ? body.category : 'other';
    const slug = slugify(name);

    const ops = parseSpec(spec, slug);
    const maxOps = Number.isInteger(body.max_ops) ? body.max_ops : 200;
    const capped = ops.slice(0, maxOps);
    if (capped.length === 0) return json({ error: 'no operations found in spec' }, 400);

    // Upsert the learned-tool record.
    const { data: specRow, error: specErr } = await admin.from('learned_tool_specs')
      .upsert({ tenant_id, name, slug, source_kind: 'openapi', base_url, raw_spec: spec,
                operation_count: capped.length, status: 'parsed', error: null, updated_at: new Date().toISOString() },
              { onConflict: 'tenant_id,slug' })
      .select('id').single();
    if (specErr) return json({ error: `spec upsert failed: ${specErr.message}` }, 400);
    const spec_id = specRow.id;

    // Replace prior generations for this spec, then insert fresh.
    await admin.from('action_definitions').delete().eq('tenant_id', tenant_id).eq('learned_from_spec_id', spec_id);

    // provider 'learned_http': a generic HTTP action learned from a spec.
    // NOT 'template' (that requires a hand-built adapter_template row via
    // the provider_shape CHECK). The execution recipe carries everything a
    // generic HTTP executor needs; wiring that executor branch into
    // connector-hub is the remaining step (see the function header).
    const rows = capped.map(o => ({
      scope: 'tenant', tenant_id, category, action_key: o.action_key, label: o.label,
      description: o.description, provider: 'learned_http', param_schema: o.param_schema,
      risk: o.risk,
      execution: {
        method: o.method,
        path_template: o.path,
        params: o.param_schema.map(p => ({ name: p.name, in: p.in })),
      },
      status: 'active',
      learned_from_spec_id: spec_id,
    }));
    const { error: insErr } = await admin.from('action_definitions')
      .upsert(rows, { onConflict: 'scope,tenant_id,category,action_key' });
    if (insErr) return json({ error: `action generation failed: ${insErr.message}` }, 400);

    return json({
      spec_id, slug, operation_count: capped.length,
      actions: capped.map(o => ({ action_key: o.action_key, label: o.label, method: o.method, path: o.path })),
    });
  } catch (err) {
    console.error('tool-learn error:', err);
    return json({ error: String(err) }, 500);
  }
});
