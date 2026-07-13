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
  // How the token endpoint wants the client credentials:
  //  'basic' (default) = HTTP Basic auth header; 'body' = client_id/secret in the form body.
  tokenAuth?: 'basic' | 'body';
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
  clio: {
    label: 'Clio',
    authorizeUrl: 'https://app.clio.com/oauth/authorize',
    tokenUrl: 'https://app.clio.com/oauth/token',
    scopes: '',
    defaultCategory: 'product_system',
    tokenAuth: 'body',
  },
  gusto: {
    label: 'Gusto',
    authorizeUrl: 'https://api.gusto.com/oauth/authorize',
    tokenUrl: 'https://api.gusto.com/oauth/token',
    scopes: '',
    defaultCategory: 'payroll_hcm',
    tokenAuth: 'body',
  },
  procore: {
    label: 'Procore',
    authorizeUrl: 'https://login.procore.com/oauth/authorize',
    tokenUrl: 'https://login.procore.com/oauth/token',
    scopes: '',
    defaultCategory: 'product_system',
    tokenAuth: 'body',
  },
  jobber: {
    label: 'Jobber',
    authorizeUrl: 'https://api.getjobber.com/api/oauth/authorize',
    tokenUrl: 'https://api.getjobber.com/api/oauth/token',
    scopes: '',
    defaultCategory: 'product_system',
    tokenAuth: 'body',
  },
  dropbox: {
    label: 'Dropbox',
    authorizeUrl: 'https://www.dropbox.com/oauth2/authorize',
    tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
    scopes: 'files.metadata.read files.content.read',
    defaultCategory: 'knowledge_base',
    tokenAuth: 'body',
    extraAuthorize: { token_access_type: 'offline' },
  },
};

export const OAUTH_CALLBACK_PATH = '/functions/v1/oauth-callback';
