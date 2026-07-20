// ============================================================
// oauth-start — begins a user-OAuth (authorization-code) connection.
// Authenticated. Creates a disconnected connector + a single-use CSRF state,
// then returns the provider's authorize URL for the browser to redirect to.
// The provider later redirects to oauth-callback with code + state.
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { resolveTenantWithRemoteAccess } from '../_shared/resolveTenant.ts';
import { OAUTH_PROVIDERS, OAUTH_CALLBACK_PATH } from '../_shared/oauthProviders.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const payload = await req.json().catch(() => ({}));
    const provider = String(payload.provider ?? '');
    const meta = OAUTH_PROVIDERS[provider];
    if (!meta) return json({ error: 'unknown_oauth_provider' }, 400);

    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const admin = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: 'unauthorized' }, 401);
    const { data: profile } = await admin.from('profiles').select('tenant_id, layer').eq('user_id', userData.user.id).single();
    const tenantId = await resolveTenantWithRemoteAccess(admin, userData.user.id, profile?.tenant_id, profile?.layer, payload.tenant_id);
    if (!tenantId) return json({ error: 'no_tenant' }, 403);

    // The platform must have registered an OAuth app (our client id/secret).
    const { data: clientId } = await admin.rpc('platform_config_get', { p_key: `oauth:${provider}:client_id` });
    if (!clientId || String(clientId).trim() === '') {
      return json({ ok: false, error: 'oauth_app_not_configured', detail: `No OAuth app is configured for ${meta.label}. A platform admin must set its client id and secret first.` }, 200);
    }

    // Create the connector shell (tokens land on it in the callback).
    const { data: conn, error: connErr } = await admin.from('connectors').insert({
      tenant_id: tenantId, provider, display_name: String(payload.display_name ?? meta.label).trim() || meta.label,
      base_url: '', category: meta.defaultCategory, access_mode: 'fetch_only', config: {}, status: 'disconnected',
    }).select('id').single();
    if (connErr || !conn) return json({ error: 'connector_create_failed', detail: connErr?.message }, 500);

    const state = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
    const redirectUri = `${SUPABASE_URL}${OAUTH_CALLBACK_PATH}`;

    // PKCE (S256): verifier stored with the single-use state, challenge sent
    // to the provider. Providers that don't support PKCE ignore the extra
    // authorize params; ones that do then require the verifier at exchange —
    // oauth-callback submits it. Opt out per provider with meta.pkce === false.
    const usePkce = (meta as { pkce?: boolean }).pkce !== false;
    let codeVerifier: string | null = null;
    let codeChallenge: string | null = null;
    if (usePkce) {
      const raw = crypto.getRandomValues(new Uint8Array(48));
      codeVerifier = btoa(String.fromCharCode(...raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier)));
      codeChallenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    const { error: stErr } = await admin.from('oauth_connect_states').insert({
      state, tenant_id: tenantId, connector_id: conn.id, provider, redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    });
    if (stErr) return json({ error: 'state_create_failed', detail: stErr.message }, 500);

    const u = new URL(meta.authorizeUrl);
    u.searchParams.set('client_id', String(clientId));
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('redirect_uri', redirectUri);
    if (meta.scopes) u.searchParams.set('scope', meta.scopes);
    u.searchParams.set('state', state);
    if (codeChallenge) {
      u.searchParams.set('code_challenge', codeChallenge);
      u.searchParams.set('code_challenge_method', 'S256');
    }
    for (const [k, v] of Object.entries(meta.extraAuthorize ?? {})) u.searchParams.set(k, v);

    return json({ ok: true, authorize_url: u.toString(), connector_id: conn.id });
  } catch (e) {
    return json({ error: `oauth_start_failed: ${String((e as Error)?.message ?? e).slice(0, 160)}` }, 500);
  }
});
