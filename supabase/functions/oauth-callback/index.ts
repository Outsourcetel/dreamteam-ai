// ============================================================
// oauth-callback — PUBLIC redirect target for user-OAuth. The provider sends
// the browser here with ?code&state (verify_jwt=false — there is no JWT on a
// browser redirect). We validate the single-use state (CSRF + tenant/connector
// link), exchange the code for tokens using the platform app's client id/secret,
// store the tokens on the connector (Vault), and mark it connected.
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { OAUTH_PROVIDERS, OAUTH_CALLBACK_PATH } from '../_shared/oauthProviders.ts';

// Title/body may contain provider-supplied error text — escape it so a
// malicious ?error= value can never inject HTML into this public page.
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function page(rawTitle: string, rawBody: string, ok: boolean): Response {
  const title = esc(rawTitle);
  const body = esc(rawBody);
  const color = ok ? '#0d7d74' : '#c0453b';
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#0d1016;color:#e8ecf1;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{max-width:26rem;padding:2rem;border:1px solid #232a35;border-radius:16px;background:#141922;text-align:center}
.badge{width:3rem;height:3rem;border-radius:50%;background:${color};color:#fff;display:flex;align-items:center;justify-content:center;font-size:1.5rem;margin:0 auto 1rem}
h1{font-size:1.2rem;margin:.3rem 0}p{color:#a3adba;font-size:.92rem;line-height:1.5}</style></head>
<body><div class="card"><div class="badge">${ok ? '✓' : '!'}</div><h1>${title}</h1><p>${body}</p></div></body></html>`;
  return new Response(html, { status: ok ? 200 : 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

Deno.serve(async (req) => {
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const admin = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get('code') ?? '';
    const state = url.searchParams.get('state') ?? '';
    const err = url.searchParams.get('error');
    if (err) return page('Connection cancelled', `The provider reported: ${err}. You can close this tab and try again.`, false);
    if (!code || !state) return page('Missing details', 'This callback was opened without an authorization code. Please start the connection again from DreamTeam.', false);

    // Validate + consume the single-use state.
    const { data: st } = await admin.from('oauth_connect_states').select('*').eq('state', state).maybeSingle();
    if (!st) return page('Link expired', 'This sign-in link is invalid or already used. Please start the connection again from DreamTeam.', false);
    await admin.from('oauth_connect_states').delete().eq('state', state);
    if (Date.now() - new Date(st.created_at).getTime() > 15 * 60 * 1000) {
      return page('Link expired', 'This sign-in link took too long. Please start the connection again from DreamTeam.', false);
    }
    const provider = String(st.provider);
    const meta = OAUTH_PROVIDERS[provider];
    if (!meta) return page('Unknown provider', 'This provider is not configured. Please contact your administrator.', false);

    const { data: clientId } = await admin.rpc('platform_config_get', { p_key: `oauth:${provider}:client_id` });
    const { data: clientSecret } = await admin.rpc('platform_config_get', { p_key: `oauth:${provider}:client_secret` });
    if (!clientId || !clientSecret) return page('App not configured', `${meta.label} is not fully set up. A platform admin must set its client id and secret.`, false);

    // Exchange the code for tokens. Client creds go in the Basic header
    // (QuickBooks/Xero) or the form body (Clio/Gusto/Procore) per provider.
    const redirectUri = `${SUPABASE_URL}${OAUTH_CALLBACK_PATH}`;
    const useBasic = (meta.tokenAuth ?? 'basic') === 'basic';
    const bodyParams: Record<string, string> = { grant_type: 'authorization_code', code, redirect_uri: redirectUri };
    // PKCE: the verifier stored by oauth-start must accompany the exchange.
    if (typeof st.code_verifier === 'string' && st.code_verifier) bodyParams.code_verifier = st.code_verifier;
    const tokHeaders: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    if (useBasic) tokHeaders.Authorization = 'Basic ' + btoa(`${clientId}:${clientSecret}`);
    else { bodyParams.client_id = String(clientId); bodyParams.client_secret = String(clientSecret); }
    const tokRes = await fetch(meta.tokenUrl, { method: 'POST', headers: tokHeaders, body: new URLSearchParams(bodyParams).toString() });
    const tok = await tokRes.json().catch(() => null) as { access_token?: string; refresh_token?: string; expires_in?: number; token_type?: string; error_description?: string } | null;
    if (!tokRes.ok || !tok?.access_token) {
      return page('Sign-in failed', `Could not complete the token exchange (${tok?.error_description ?? tokRes.status}). Please try again.`, false);
    }

    const secret: Record<string, unknown> = {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token ?? '',
      token_type: tok.token_type ?? 'Bearer',
      expires_at: Date.now() + (Number(tok.expires_in ?? 3600) - 60) * 1000, // refresh 60s early
    };

    // Provider-specific post-exchange bits the API calls need.
    if (meta.postExchange === 'realm') {
      const realm = url.searchParams.get('realmId');
      if (!realm) return page('Missing company', 'QuickBooks did not return a company id (realmId). Please try again.', false);
      secret.realm_id = realm;
    } else if (meta.postExchange === 'xero') {
      const connRes = await fetch('https://api.xero.com/connections', { headers: { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/json' } });
      const conns = await connRes.json().catch(() => []) as Array<{ tenantId?: string; tenantName?: string }>;
      if (!Array.isArray(conns) || !conns[0]?.tenantId) return page('No organisation', 'Xero returned no connected organisation. Please try again.', false);
      secret.xero_tenant_id = conns[0].tenantId;
    }

    await admin.rpc('set_connector_secret_sysadmin', { p_connector_id: st.connector_id, p_secret: JSON.stringify(secret) });
    await admin.from('connectors').update({ status: 'connected', last_ok_at: new Date().toISOString(), consecutive_failures: 0 }).eq('id', st.connector_id);

    return page(`${meta.label} connected`, `Your ${meta.label} account is now connected to DreamTeam. You can close this tab and return to the app.`, true);
  } catch (e) {
    return page('Something went wrong', `An unexpected error occurred: ${String((e as Error)?.message ?? e).slice(0, 160)}. Please try again.`, false);
  }
});
