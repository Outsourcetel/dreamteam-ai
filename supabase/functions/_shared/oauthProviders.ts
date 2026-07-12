// ============================================================
// OAuth 2.0 (authorization-code) provider registry — the metadata every
// user-OAuth connector shares. Adding a provider = one entry here + its
// read adapter in connector-hub. Client id/secret live per-provider in
// Vault-encrypted platform_config (oauth:{provider}:client_id / :client_secret).
// ============================================================
export interface OAuthProviderMeta {
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string;               // space-separated
  defaultCategory: string;      // connector category the DE speaks
  // Provider-specific callback post-processing the token exchange needs:
  //  - 'realm'  : the provider returns a realmId query param (QuickBooks) to store
  //  - 'xero'   : call /connections after token to resolve the org tenant id
  postExchange?: 'realm' | 'xero';
  // Some providers want extra params on the authorize request.
  extraAuthorize?: Record<string, string>;
}

export const OAUTH_PROVIDERS: Record<string, OAuthProviderMeta> = {
  quickbooks: {
    label: 'QuickBooks Online',
    authorizeUrl: 'https://appcenter.intuit.com/connect/oauth2',
    tokenUrl: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
    scopes: 'com.intuit.quickbooks.accounting',
    defaultCategory: 'erp_financials',
    postExchange: 'realm',
  },
  xero: {
    label: 'Xero',
    authorizeUrl: 'https://login.xero.com/identity/connect/authorize',
    tokenUrl: 'https://identity.xero.com/connect/token',
    scopes: 'offline_access accounting.transactions.read accounting.contacts.read',
    defaultCategory: 'erp_financials',
    postExchange: 'xero',
  },
  // Metadata-ready follow-ons (add a read adapter in connector-hub to enable):
  clio: {
    label: 'Clio',
    authorizeUrl: 'https://app.clio.com/oauth/authorize',
    tokenUrl: 'https://app.clio.com/oauth/token',
    scopes: '',
    defaultCategory: 'product_system',
  },
  gusto: {
    label: 'Gusto',
    authorizeUrl: 'https://api.gusto.com/oauth/authorize',
    tokenUrl: 'https://api.gusto.com/oauth/token',
    scopes: '',
    defaultCategory: 'payroll_hcm',
  },
  procore: {
    label: 'Procore',
    authorizeUrl: 'https://login.procore.com/oauth/authorize',
    tokenUrl: 'https://login.procore.com/oauth/token',
    scopes: '',
    defaultCategory: 'product_system',
  },
};

export const OAUTH_CALLBACK_PATH = '/functions/v1/oauth-callback';
