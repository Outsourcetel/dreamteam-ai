// ============================================================
// Wave 2b — emit-event: the external webhook that fires a tenant-defined
// trigger event. A tenant's connected system POSTs here to start any
// playbook wired to that event.
//
// Auth: the existing tenant API-key system (migration 090). The caller
// passes an API key (header `x-api-key` or body `api_key`); we verify it
// with verify_tenant_api_key (service-role, sha256) and confirm it belongs
// to the tenant_id in the body. No new secret mechanism.
//
// On success we call emit_tenant_event, which inserts the same
// playbook_trigger_fires rows the poller does — so the emitted event
// becomes a run on the next dispatch cycle, exactly like a polled event.
// ============================================================
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-api-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const tenantId = String(body.tenant_id ?? '').trim();
  const eventKey = String(body.event_key ?? '').trim();
  const apiKey = String(req.headers.get('x-api-key') ?? body.api_key ?? '').trim();
  const targetRef = body.target_ref != null ? String(body.target_ref) : null;
  const targetAccountId = body.target_account_id != null ? String(body.target_account_id) : null;
  const payload = (body.payload && typeof body.payload === 'object') ? body.payload : {};

  if (!tenantId || !eventKey) return json({ error: 'tenant_id and event_key are required' }, 400);
  if (!apiKey) return json({ error: 'missing_api_key' }, 401);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  // Verify the API key and that it belongs to the claimed tenant.
  const { data: verify, error: vErr } = await admin.rpc('verify_tenant_api_key', { p_raw_key: apiKey });
  if (vErr) {
    console.error('verify_tenant_api_key:', vErr.message);
    return json({ error: 'verification_failed' }, 500);
  }
  const v = verify as { valid?: boolean; tenant_id?: string } | null;
  if (!v?.valid || v.tenant_id !== tenantId) {
    return json({ error: 'invalid_api_key' }, 401);
  }

  // Fire the event. emit_tenant_event does the event-exists check, the
  // owner/admin gate is bypassed for service_role, and cooldown/dedup runs
  // inside it — mirroring the poller.
  const { data: result, error: eErr } = await admin.rpc('emit_tenant_event', {
    p_tenant_id: tenantId,
    p_event_key: eventKey,
    p_target_ref: targetRef,
    p_target_account_id: targetAccountId,
    p_payload: { ...payload, source: 'webhook' },
  });
  if (eErr) {
    console.error('emit_tenant_event:', eErr.message);
    return json({ error: 'emit_failed', detail: eErr.message }, 500);
  }
  const r = result as { ok?: boolean; error?: string; fires_created?: number; skipped?: number };
  if (!r?.ok) {
    return json({ error: r?.error ?? 'emit_failed', event_key: eventKey }, 400);
  }
  return json({ ok: true, event_key: eventKey, fires_created: r.fires_created ?? 0, skipped: r.skipped ?? 0 });
});
