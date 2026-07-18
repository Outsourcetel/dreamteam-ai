/**
 * otel-export — ships stored GenAI spans to an OTLP/HTTP collector
 * (Frontier-20 #13, mig 177).
 *
 * DORMANT BY DESIGN: does nothing until the platform admin sets the
 * platform_config key 'otel_collector_endpoint' (an OTLP/HTTP base URL,
 * e.g. https://otel.example.com — POSTs to <base>/v1/traces). Optional
 * 'otel_collector_auth_header' ("Header-Name: value") for collectors that
 * need auth. Until then every call reports { dormant: true } honestly.
 *
 * Batches unexported spans (oldest first, capped), converts rows to OTLP
 * JSON with gen_ai.* attributes preserved, marks them exported on 2xx.
 * Auth: dispatch secret or service-role bearer (cron/manual trigger).
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
const BATCH = 200;

const toNano = (iso: string) => String(BigInt(new Date(iso).getTime()) * 1000000n);
const attrVal = (v: unknown) =>
  typeof v === 'number' ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v })
  : typeof v === 'boolean' ? { boolValue: v }
  : { stringValue: String(v ?? '') };

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const dispatch = Deno.env.get('PLAYBOOK_DISPATCH_SECRET') ?? '';
    const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!((dispatch && req.headers.get('x-dispatch-secret') === dispatch) || bearer === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'))) {
      return json({ error: 'unauthorized' }, 401);
    }

    const { data: cfg } = await admin.from('platform_config').select('key, value')
      .in('key', ['otel_collector_endpoint', 'otel_collector_auth_header']);
    const endpoint = (cfg ?? []).find((r: { key: string }) => r.key === 'otel_collector_endpoint')?.value ?? '';
    if (!endpoint) return json({ dormant: true, detail: 'Set platform_config key otel_collector_endpoint to enable export.' });
    if (!isSafeExternalUrl(endpoint)) return json({ error: 'unsafe_collector_endpoint' }, 400);
    const authHeader = (cfg ?? []).find((r: { key: string }) => r.key === 'otel_collector_auth_header')?.value ?? '';

    const { data: rows } = await admin.from('otel_spans')
      .select('id, tenant_id, trace_id, span_id, parent_span_id, name, kind, started_at, ended_at, attributes')
      .eq('exported', false).order('created_at', { ascending: true }).limit(BATCH);
    if (!rows || rows.length === 0) return json({ exported: 0, detail: 'nothing pending' });

    const spans = rows.map((r: { trace_id: string; span_id: string; parent_span_id: string | null; name: string; started_at: string; ended_at: string; tenant_id: string; attributes: Record<string, unknown> }) => ({
      traceId: r.trace_id, spanId: r.span_id,
      ...(r.parent_span_id ? { parentSpanId: r.parent_span_id } : {}),
      name: r.name, kind: 1, // SPAN_KIND_INTERNAL
      startTimeUnixNano: toNano(r.started_at), endTimeUnixNano: toNano(r.ended_at),
      attributes: [
        { key: 'dreamteam.tenant_id', value: { stringValue: r.tenant_id } },
        ...Object.entries(r.attributes ?? {}).map(([k, v]) => ({ key: k, value: attrVal(v) })),
      ],
    }));

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const ci = authHeader.indexOf(':');
    if (ci > 0) headers[authHeader.slice(0, ci).trim()] = authHeader.slice(ci + 1).trim();
    const res = await fetch(`${endpoint.replace(/\/$/, '')}/v1/traces`, {
      method: 'POST', headers,
      body: JSON.stringify({
        resourceSpans: [{
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'dreamteam-ai' } }] },
          scopeSpans: [{ scope: { name: 'dreamteam' }, spans }],
        }],
      }),
    });
    if (!res.ok) return json({ error: 'collector_rejected', status: res.status, detail: (await res.text()).slice(0, 300) }, 502);

    await admin.from('otel_spans').update({ exported: true }).in('id', rows.map((r: { id: string }) => r.id));
    return json({ exported: rows.length });
  } catch (err) {
    console.error('otel-export error:', err);
    return json({ error: String(err) }, 500);
  }
});
