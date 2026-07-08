/**
 * check-ip-allowlist — Security & Access page's real IP allowlist,
 * client-side enforcement (migration 092).
 *
 * True request-time enforcement (Vercel Edge Middleware) turned out to
 * require reading the session from a cookie on the incoming request;
 * this app stores its Supabase session in localStorage only (the
 * supabase-js default), which middleware cannot see at all. Making
 * middleware work would mean migrating the whole app's session storage
 * to cookies first — a separate, much larger auth-architecture change.
 * Founder-approved: ship the honest, real, client-side version instead.
 *
 * This function is the one place that CAN see a caller's real IP (via
 * the x-forwarded-for header Supabase's edge network sets) — the
 * client-side JS that calls it cannot reliably know its own public IP.
 * AuthContext calls this once per session (and periodically) for a real
 * tenant user; a `false` result forces a sign-out.
 *
 * FAIL-OPEN at every layer: any error here (bad JWT, no profile, no
 * tenant, malformed IP) must never actively lock a real user out. See
 * check_ip_against_tenant_allowlist's own fail-open exception handler.
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

function callerIp(req: Request): string | null {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return req.headers.get('x-real-ip');
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const authHeader = req.headers.get('Authorization') ?? '';
    const jwt = authHeader.replace(/^Bearer\s+/i, '');
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) {
      // Fail-open -- an auth hiccup here should never look like a lockout.
      return json({ allowed: true, reason: 'unauthenticated' });
    }

    const { data: profile } = await admin
      .from('profiles').select('tenant_id').eq('user_id', userData.user.id).maybeSingle();
    const tenantId = profile?.tenant_id ?? null;
    if (!tenantId) return json({ allowed: true, reason: 'no_tenant' });

    const ip = callerIp(req);
    if (!ip) return json({ allowed: true, reason: 'no_ip_detected' });

    const { data, error } = await admin.rpc('check_ip_against_tenant_allowlist', {
      p_tenant_id: tenantId, p_ip: ip,
    });
    if (error) {
      console.error('check_ip_against_tenant_allowlist:', error.message);
      return json({ allowed: true, reason: 'rpc_error_fail_open' });
    }
    return json(data);
  } catch (e) {
    console.error('check-ip-allowlist:', e);
    return json({ allowed: true, reason: 'exception_fail_open' });
  }
});
