// ============================================================
// Systems-of-Record connector layer v1 (R2) — client API.
// Tables from supabase/migrations/017_connectors.sql; live actions
// via the connector-zendesk edge function.
//
// Doctrine: connectors declare per-object mode — 'sync' (cached
// working copy) or 'read_through' (fetched at action time, never
// persisted). Actions write BACK into the SoR. Credentials live in
// connector_secrets (service-role-only; written via the
// set_connector_secret RPC and never readable from the client).
// ============================================================
import { supabase } from '../supabase';
import { getSessionTenantId, CustomerApiError, isMissingTableError } from './customerApi';

// ── Types ─────────────────────────────────────────────────────────

import type { SystemCategory, CanonicalItem, ConnectorHealth } from './categoryContracts';
import { computeHealth } from './categoryContracts';

export type ConnectorProvider =
  | 'zendesk' | 'salesforce' | 'confluence' | 'jira' | 'intercom'
  | 'generic_rest' | 'sharepoint' | 'gdrive' | 'hubspot' | 'slack'
  | 'notion' | 'teams' | 'box' | 'freshdesk' | 'freshservice'
  | 'servicenow' | 'dynamics' | 'github' | 'gitlab' | 'guru' | 'document360'
  | 'asana' | 'clickup' | 'monday' | 'linear'
  | 'stripe' | 'shopify' | 'woocommerce' | 'bigcommerce' | 'square'
  | 'bamboohr' | 'greenhouse' | 'lever' | 'buildium' | 'canvas'
  | 'quickbooks' | 'xero' | 'clio' | 'gusto' | 'procore' | 'jobber'
  | 'gorgias' | 'front' | 'coda' | 'pagerduty' | 'sentry'
  | 'pipedrive' | 'smartsheet' | 'wrike' | 'trello' | 'datadog'
  | 'close' | 'kustomer' | 'mailchimp' | 'gitbook'
  | 'netsuite' | 'powerschool' | 'ellucian' | 'toast' | 'athenahealth' | 'epic' | 'cerner'
  | 'dropbox' | 'twilio' | 'typeform' | 'calendly' | 'okta' | 'contentful' | 'template';
export type ConnectorStatus = 'connected' | 'error' | 'disconnected';
export type ConnectorAccessMode = 'ingest' | 'fetch_only';

export interface Connector {
  id: string;
  tenant_id: string;
  provider: ConnectorProvider;
  display_name: string;
  base_url: string;
  status: ConnectorStatus;
  /** Category contract (migration 027) — what KIND of system this is; the app speaks category ops. */
  category: SystemCategory;
  access_mode: ConnectorAccessMode;
  /** Declarative Adapter Framework (migration 028): the template this connector was created from. */
  template_id: string | null;
  config: Record<string, unknown>;
  /** {canonical_field: source_field} applied at normalization time. */
  field_map: Record<string, string>;
  // Call-driven health (migration 027)
  last_ok_at: string | null;
  last_error_at: string | null;
  consecutive_failures: number;
  last_sync_at: string | null;
  last_error: string | null;
  // WS8 scheduled sync (mig 287) — off by default; opt in per connector.
  scheduled_sync_enabled?: boolean;
  sync_interval_mins?: number;
  last_scheduled_sync_at?: string | null;
  created_at: string;
  updated_at: string;
}

export function connectorHealth(c: Connector): ConnectorHealth {
  return computeHealth(c);
}

export const ACCESS_MODE_EXPLAIN: Record<ConnectorAccessMode, string> = {
  ingest: 'Ingest: DreamTeam keeps a searchable working copy of knowledge content. Your system stays the source of truth.',
  fetch_only: 'Fetch-only: we look at your data to answer, we never store it. Only the citation trail (title, reference, short snippet) is kept.',
};

/** Per-provider setup metadata: credential fields + how to get them. */
export interface ProviderField { key: string; label: string; placeholder: string; secret: boolean; multiline?: boolean }
export interface ProviderMeta {
  label: string;
  tagline: string;
  defaultCategory: SystemCategory;
  baseUrlLabel: string;
  baseUrlPlaceholder: string;
  fields: ProviderField[];        // stored server-side via set_connector_secret; never readable back
  help: string;                    // plain-language "how to get credentials"
  knowledgeSync: boolean;          // provider can ingest articles/pages
  implemented: boolean;
  oauth?: boolean;                 // connect via "Sign in with…" redirect (no pasted token)
}

export const PROVIDERS: Record<ConnectorProvider, ProviderMeta> = {
  zendesk: {
    label: 'Zendesk', tagline: 'Support desk — tickets, past conversations, help center',
    defaultCategory: 'helpdesk',
    baseUrlLabel: 'Zendesk URL', baseUrlPlaceholder: 'https://acme.zendesk.com',
    fields: [
      { key: 'email', label: 'Admin email', placeholder: 'admin@acme.com', secret: false },
      { key: 'api_token', label: 'API token', placeholder: '••••••••', secret: true },
    ],
    help: 'In Zendesk: Admin Center → Apps and integrations → APIs → Zendesk API → enable Token access → Add API token. Use your admin email plus that token.',
    knowledgeSync: true, implemented: true,
  },
  notion: {
    label: 'Notion', tagline: 'Wiki & docs — pages, databases, processes',
    defaultCategory: 'knowledge_base',
    baseUrlLabel: 'Notion API (fixed — leave blank)', baseUrlPlaceholder: 'not needed for Notion',
    fields: [
      { key: 'token', label: 'Internal integration token', placeholder: 'ntn_••••••••', secret: true },
    ],
    help: 'In Notion: notion.so/my-integrations → New integration → copy the Internal Integration Token. Then SHARE the pages/databases you want the DE to read WITH the integration (open a page → ••• → Connections → add your integration). The integration only sees pages you share — that sharing is your security boundary.',
    knowledgeSync: true, implemented: true,
  },
  teams: {
    label: 'Microsoft Teams', tagline: 'Channel messages — search past discussions',
    defaultCategory: 'knowledge_base',
    baseUrlLabel: 'Microsoft Graph (fixed — leave blank)', baseUrlPlaceholder: 'not needed for Teams',
    fields: [
      { key: 'tenant_id', label: 'Directory (tenant) ID', placeholder: '00000000-0000-0000-0000-000000000000', secret: false },
      { key: 'client_id', label: 'Application (client) ID', placeholder: '11111111-1111-1111-1111-111111111111', secret: false },
      { key: 'client_secret', label: 'Client secret value', placeholder: '••••••••', secret: true },
    ],
    help: 'App-only access (same Azure app registration as SharePoint). Reading Teams channel messages needs the PROTECTED Microsoft Graph permission ChannelMessage.Read.All — add it under API permissions → Application permissions, click "Grant admin consent", and note Microsoft meters/approves this API. Copy the Directory (tenant) ID and Application (client) ID from the app Overview, and a client secret from Certificates & secrets.',
    knowledgeSync: false, implemented: true,
  },
  box: {
    label: 'Box', tagline: 'Enterprise files — documents & PDFs into knowledge',
    defaultCategory: 'knowledge_base',
    baseUrlLabel: 'Box API (fixed — leave blank)', baseUrlPlaceholder: 'not needed for Box',
    fields: [
      { key: 'client_id', label: 'Client ID', placeholder: 'from your Box app', secret: false },
      { key: 'client_secret', label: 'Client secret', placeholder: '••••••••', secret: true },
      { key: 'enterprise_id', label: 'Enterprise ID', placeholder: 'your Box enterprise id', secret: false },
    ],
    help: 'App-only access (no user sign-in). In the Box Developer Console → Create a Custom App → Server Authentication (Client Credentials Grant) → copy the Client ID & Secret; authorize the app in the Box Admin Console (Apps → Custom Apps Manager). Enterprise ID is in the Admin Console under Account & Billing. The app sees only the folders you grant it — that scoping is your security boundary.',
    knowledgeSync: true, implemented: true,
  },
  freshdesk: {
    label: 'Freshdesk', tagline: 'Support desk — tickets & conversations',
    defaultCategory: 'helpdesk',
    baseUrlLabel: 'Freshdesk URL', baseUrlPlaceholder: 'https://yourco.freshdesk.com',
    fields: [
      { key: 'api_key', label: 'API key', placeholder: '••••••••', secret: true },
    ],
    help: 'In Freshdesk: click your profile → Profile Settings → your API key is on the right. Paste it plus your Freshdesk URL (https://yourcompany.freshdesk.com).',
    knowledgeSync: false, implemented: true,
  },
  freshservice: {
    label: 'Freshservice', tagline: 'IT service desk — tickets, incidents, requests',
    defaultCategory: 'helpdesk',
    baseUrlLabel: 'Freshservice URL', baseUrlPlaceholder: 'https://yourco.freshservice.com',
    fields: [
      { key: 'api_key', label: 'API key', placeholder: '••••••••', secret: true },
    ],
    help: 'In Freshservice: profile picture → Profile Settings → your API key is on the right panel. Paste it plus your Freshservice URL (https://yourcompany.freshservice.com).',
    knowledgeSync: false, implemented: true,
  },
  slack: {
    label: 'Slack', tagline: 'Team chat — search past answers & decisions',
    defaultCategory: 'knowledge_base',
    baseUrlLabel: 'Slack API (fixed — leave blank)', baseUrlPlaceholder: 'not needed for Slack',
    fields: [
      { key: 'token', label: 'User OAuth Token', placeholder: 'xoxp-••••••••', secret: true },
    ],
    help: 'To let a DE search past Slack messages you need a User OAuth Token (xoxp-) with the search:read scope — bot tokens cannot search. In Slack: api.slack.com/apps → Create/select an app → OAuth & Permissions → add the "search:read" User Token Scope → Install to Workspace → copy the "User OAuth Token" (starts xoxp-). Paste it here. The DE reads past answers as knowledge; it never posts unless you add a posting action later.',
    knowledgeSync: false, implemented: true,
  },
  hubspot: {
    label: 'HubSpot', tagline: 'CRM + Service Hub — companies, deals, tickets in one',
    defaultCategory: 'crm',
    baseUrlLabel: 'HubSpot API (fixed — leave blank)', baseUrlPlaceholder: 'not needed for HubSpot',
    fields: [
      { key: 'access_token', label: 'Private-app token', placeholder: 'pat-na1-••••••••', secret: true },
    ],
    help: 'In HubSpot: Settings → Integrations → Private Apps → Create a private app → on the Scopes tab enable the read scopes you want (crm.objects.contacts.read, crm.objects.companies.read, crm.objects.deals.read, tickets) → Create → copy the access token. One token covers CRM (companies, contacts, deals) and Service Hub (tickets). Set this connector\'s category to "helpdesk" to use it as a support desk, or "CRM" for sales/account context.',
    knowledgeSync: false, implemented: true,
  },
  clio: {
    label: 'Clio', tagline: 'Legal — matters, clients, billing',
    defaultCategory: 'product_system',
    baseUrlLabel: '', baseUrlPlaceholder: '',
    fields: [],
    help: 'Connect by signing in to Clio — no keys to paste. (A platform admin registers the Clio app once.)',
    knowledgeSync: false, implemented: true, oauth: true,
  },
  gusto: {
    label: 'Gusto', tagline: 'Payroll & HR — employees, time off',
    defaultCategory: 'payroll_hcm',
    baseUrlLabel: '', baseUrlPlaceholder: '',
    fields: [],
    help: 'Connect by signing in to Gusto — no keys to paste. (A platform admin registers the Gusto app once.)',
    knowledgeSync: false, implemented: true, oauth: true,
  },
  procore: {
    label: 'Procore', tagline: 'Construction — projects, RFIs, documents',
    defaultCategory: 'product_system',
    baseUrlLabel: '', baseUrlPlaceholder: '',
    fields: [],
    help: 'Connect by signing in to Procore — no keys to paste. (A platform admin registers the Procore app once.)',
    knowledgeSync: false, implemented: true, oauth: true,
  },
  jobber: {
    label: 'Jobber', tagline: 'Field service — jobs, clients, quotes',
    defaultCategory: 'product_system',
    baseUrlLabel: '', baseUrlPlaceholder: '',
    fields: [],
    help: 'Connect by signing in to Jobber — no keys to paste. (A platform admin registers the Jobber app once.)',
    knowledgeSync: false, implemented: true, oauth: true,
  },
  quickbooks: {
    label: 'QuickBooks Online', tagline: 'Accounting — invoices, bills, customers',
    defaultCategory: 'erp_financials',
    baseUrlLabel: '', baseUrlPlaceholder: '',
    fields: [],
    help: 'Connect by signing in to QuickBooks — no keys to paste. (A platform admin registers the QuickBooks app once, then anyone can connect their company.)',
    knowledgeSync: false, implemented: true, oauth: true,
  },
  xero: {
    label: 'Xero', tagline: 'Accounting — invoices, contacts, bank transactions',
    defaultCategory: 'erp_financials',
    baseUrlLabel: '', baseUrlPlaceholder: '',
    fields: [],
    help: 'Connect by signing in to Xero — no keys to paste. (A platform admin registers the Xero app once, then anyone can connect their organisation.)',
    knowledgeSync: false, implemented: true, oauth: true,
  },
  stripe: {
    label: 'Stripe', tagline: 'Payments & billing — invoices, subscriptions',
    defaultCategory: 'billing',
    baseUrlLabel: 'Stripe API (fixed — leave blank)', baseUrlPlaceholder: 'not needed for Stripe',
    fields: [
      { key: 'api_key', label: 'Secret key', placeholder: 'sk_live_••••••••', secret: true },
    ],
    help: 'In Stripe: Developers → API keys → use a Restricted key with read access to Invoices, Subscriptions and Customers (safer than the full secret key). Paste it here.',
    knowledgeSync: false, implemented: true,
  },
  shopify: {
    label: 'Shopify', tagline: 'E-commerce — orders, products, customers',
    defaultCategory: 'pos',
    baseUrlLabel: 'Store URL', baseUrlPlaceholder: 'https://yourstore.myshopify.com',
    fields: [
      { key: 'access_token', label: 'Admin API access token', placeholder: 'shpat_••••••••', secret: true },
    ],
    help: 'In Shopify admin: Settings → Apps and sales channels → Develop apps → Create an app → Configuration → Admin API access scopes (add read_orders, read_products, read_customers) → Install → reveal the Admin API access token (shpat_…). Paste it plus your store URL.',
    knowledgeSync: false, implemented: true,
  },
  woocommerce: {
    label: 'WooCommerce', tagline: 'E-commerce — orders on WordPress',
    defaultCategory: 'pos',
    baseUrlLabel: 'Store URL', baseUrlPlaceholder: 'https://yourstore.com',
    fields: [
      { key: 'consumer_key', label: 'Consumer key', placeholder: 'ck_••••••••', secret: false },
      { key: 'consumer_secret', label: 'Consumer secret', placeholder: 'cs_••••••••', secret: true },
    ],
    help: 'In WordPress: WooCommerce → Settings → Advanced → REST API → Add key → set Read permissions → copy the Consumer key & secret. Paste them plus your store URL.',
    knowledgeSync: false, implemented: true,
  },
  bigcommerce: {
    label: 'BigCommerce', tagline: 'E-commerce — orders, catalog, customers',
    defaultCategory: 'pos',
    baseUrlLabel: 'BigCommerce API (fixed — leave blank)', baseUrlPlaceholder: 'not needed for BigCommerce',
    fields: [
      { key: 'store_hash', label: 'Store hash', placeholder: 'abc123', secret: false },
      { key: 'access_token', label: 'API account token', placeholder: '••••••••', secret: true },
    ],
    help: 'In BigCommerce: Settings → API → Store-level API accounts → Create → give it read scopes for Orders, Products, Customers → copy the Access Token. The store hash is in your control-panel URL (store-XXXX → the XXXX is the hash).',
    knowledgeSync: false, implemented: true,
  },
  square: {
    label: 'Square', tagline: 'POS — orders, payments, customers',
    defaultCategory: 'pos',
    baseUrlLabel: 'Square API (fixed — leave blank)', baseUrlPlaceholder: 'not needed for Square',
    fields: [
      { key: 'access_token', label: 'Access token', placeholder: 'EAAA••••••••', secret: true },
    ],
    help: 'In the Square Developer Dashboard: create an application → Production → copy the Access Token (or use OAuth for a merchant). Paste it here.',
    knowledgeSync: false, implemented: true,
  },
  bamboohr: {
    label: 'BambooHR', tagline: 'HR — employees, org, time off',
    defaultCategory: 'payroll_hcm',
    baseUrlLabel: 'BambooHR API (fixed — leave blank)', baseUrlPlaceholder: 'not needed for BambooHR',
    fields: [
      { key: 'subdomain', label: 'Company subdomain', placeholder: 'acme (from acme.bamboohr.com)', secret: false },
      { key: 'api_key', label: 'API key', placeholder: '••••••••', secret: true },
    ],
    help: 'In BambooHR: your avatar → API Keys → Add New Key. Paste the key plus your company subdomain (the acme in acme.bamboohr.com).',
    knowledgeSync: false, implemented: true,
  },
  greenhouse: {
    label: 'Greenhouse', tagline: 'Recruiting — candidates, jobs, applications',
    defaultCategory: 'product_system',
    baseUrlLabel: 'Greenhouse API (fixed — leave blank)', baseUrlPlaceholder: 'not needed for Greenhouse',
    fields: [
      { key: 'api_key', label: 'Harvest API key', placeholder: '••••••••', secret: true },
    ],
    help: 'In Greenhouse: Configure → Dev Center → API Credential Management → Create New API Key → type Harvest → grant read on Candidates/Jobs. Paste the key.',
    knowledgeSync: false, implemented: true,
  },
  lever: {
    label: 'Lever', tagline: 'Recruiting — opportunities & candidates',
    defaultCategory: 'product_system',
    baseUrlLabel: 'Lever API (fixed — leave blank)', baseUrlPlaceholder: 'not needed for Lever',
    fields: [
      { key: 'api_key', label: 'API key', placeholder: '••••••••', secret: true },
    ],
    help: 'In Lever: Settings → Integrations and API → API credentials → Generate a new key with read access. Paste it here.',
    knowledgeSync: false, implemented: true,
  },
  buildium: {
    label: 'Buildium', tagline: 'Property management — leases, work orders',
    defaultCategory: 'product_system',
    baseUrlLabel: 'Buildium API (fixed — leave blank)', baseUrlPlaceholder: 'not needed for Buildium',
    fields: [
      { key: 'client_id', label: 'Client ID', placeholder: 'from Buildium', secret: false },
      { key: 'client_secret', label: 'Client secret', placeholder: '••••••••', secret: true },
    ],
    help: 'In Buildium: Settings → API settings → enable the API and create an API key → copy the Client ID & Secret.',
    knowledgeSync: false, implemented: true,
  },
  canvas: {
    label: 'Canvas LMS', tagline: 'Education — courses, students, assignments',
    defaultCategory: 'product_system',
    baseUrlLabel: 'Canvas URL', baseUrlPlaceholder: 'https://yourschool.instructure.com',
    fields: [
      { key: 'token', label: 'Access token', placeholder: '••••••••', secret: true },
    ],
    help: 'In Canvas: Account → Settings → Approved Integrations → + New Access Token. Paste it plus your Canvas URL (https://yourschool.instructure.com).',
    knowledgeSync: false, implemented: true,
  },
  twilio: {
    label: 'Twilio', tagline: 'Messaging — SMS & call logs',
    defaultCategory: 'other',
    baseUrlLabel: 'Twilio API (fixed — leave blank)', baseUrlPlaceholder: 'not needed for Twilio',
    fields: [
      { key: 'account_sid', label: 'Account SID', placeholder: 'AC••••••••', secret: false },
      { key: 'auth_token', label: 'Auth token', placeholder: '••••••••', secret: true },
    ],
    help: 'In the Twilio Console dashboard: copy your Account SID and Auth Token. (An API Key SID/Secret also works in place of the auth token.)',
    knowledgeSync: false, implemented: true,
  },
  typeform: {
    label: 'Typeform', tagline: 'Forms & survey responses',
    defaultCategory: 'product_system',
    baseUrlLabel: 'Typeform API (fixed — leave blank)', baseUrlPlaceholder: 'not needed for Typeform',
    fields: [
      { key: 'token', label: 'Personal access token', placeholder: 'tfp_••••••••', secret: true },
    ],
    help: 'In Typeform: Settings → Personal tokens → Generate a new token. Paste it here.',
    knowledgeSync: false, implemented: true,
  },
  calendly: {
    label: 'Calendly', tagline: 'Scheduling — events & invitees',
    defaultCategory: 'product_system',
    baseUrlLabel: 'Calendly API (fixed — leave blank)', baseUrlPlaceholder: 'not needed for Calendly',
    fields: [
      { key: 'token', label: 'Personal access token', placeholder: 'eyJ••••••••', secret: true },
    ],
    help: 'In Calendly: Integrations → API & Webhooks → Personal Access Tokens → Generate. Paste it here.',
    knowledgeSync: false, implemented: true,
  },
  okta: {
    label: 'Okta', tagline: 'Identity — users & groups',
    defaultCategory: 'product_system',
    baseUrlLabel: 'Okta org URL', baseUrlPlaceholder: 'https://yourorg.okta.com',
    fields: [
      { key: 'token', label: 'API token', placeholder: '••••••••', secret: true },
    ],
    help: 'In Okta admin: Security → API → Tokens → Create Token (SSWS). Paste it plus your Okta org URL.',
    knowledgeSync: false, implemented: true,
  },
  contentful: {
    label: 'Contentful', tagline: 'Headless CMS — content entries',
    defaultCategory: 'knowledge_base',
    baseUrlLabel: 'Contentful API (fixed — leave blank)', baseUrlPlaceholder: 'not needed for Contentful',
    fields: [
      { key: 'space_id', label: 'Space ID', placeholder: '', secret: false },
      { key: 'access_token', label: 'Content Delivery API token', placeholder: '••••••••', secret: true },
    ],
    help: 'In Contentful: Settings → API keys → add an API key → copy the Space ID and the Content Delivery API access token.',
    knowledgeSync: false, implemented: true,
  },
  dropbox: {
    label: 'Dropbox', tagline: 'Files — documents & PDFs into knowledge',
    defaultCategory: 'knowledge_base',
    baseUrlLabel: '', baseUrlPlaceholder: '',
    fields: [],
    help: 'Connect by signing in to Dropbox — no keys to paste. (A platform admin registers the Dropbox app once.) Then use "What gets ingested" to choose folders, exclude patterns, and review files before they enter knowledge. SECURITY: the real boundary is sharing only the intended folder(s) with the app.',
    knowledgeSync: true, implemented: true, oauth: true,
  },
  netsuite: {
    label: 'NetSuite', tagline: 'ERP — invoices, orders, financials',
    defaultCategory: 'erp_financials',
    baseUrlLabel: 'SuiteTalk REST base URL', baseUrlPlaceholder: 'https://ACCT.suitetalk.api.netsuite.com/services/rest',
    fields: [
      { key: 'account_id', label: 'Account ID', placeholder: '1234567 or 1234567_SB1', secret: false },
      { key: 'consumer_key', label: 'Consumer key', placeholder: '', secret: false },
      { key: 'consumer_secret', label: 'Consumer secret', placeholder: '••••••••', secret: true },
      { key: 'token_id', label: 'Token ID', placeholder: '', secret: false },
      { key: 'token_secret', label: 'Token secret', placeholder: '••••••••', secret: true },
    ],
    help: 'Uses NetSuite Token-Based Auth (TBA). In NetSuite: enable the TBA feature, create an Integration record (get the Consumer key/secret), then create an Access Token for a role (get the Token ID/secret). Paste all four plus your Account ID and SuiteTalk REST base URL.',
    knowledgeSync: false, implemented: true,
  },
  powerschool: {
    label: 'PowerSchool', tagline: 'K-12 SIS — students, enrollment, grades',
    defaultCategory: 'product_system',
    baseUrlLabel: 'District PowerSchool URL', baseUrlPlaceholder: 'https://yourdistrict.powerschool.com',
    fields: [
      { key: 'client_id', label: 'Client ID', placeholder: '', secret: false },
      { key: 'client_secret', label: 'Client secret', placeholder: '••••••••', secret: true },
    ],
    help: 'GATED: a PowerSchool plugin must be installed and enabled by the DISTRICT, which then provides the Client ID/Secret. Paste those plus the district URL. Without the district installing the plugin, this cannot connect.',
    knowledgeSync: false, implemented: true,
  },
  ellucian: {
    label: 'Ellucian (Banner/Colleague)', tagline: 'Higher-ed SIS via Ethos',
    defaultCategory: 'product_system',
    baseUrlLabel: 'Ellucian API (fixed — leave blank)', baseUrlPlaceholder: 'not needed for Ellucian',
    fields: [
      { key: 'api_key', label: 'Ethos API key', placeholder: '••••••••', secret: true },
    ],
    help: 'GATED: requires an Ellucian Ethos entitlement enabled by the institution, which provides the Ethos API key. Paste it here.',
    knowledgeSync: false, implemented: true,
  },
  toast: {
    label: 'Toast', tagline: 'Restaurant POS — orders, menus, checks',
    defaultCategory: 'pos',
    baseUrlLabel: 'Toast API (fixed — leave blank)', baseUrlPlaceholder: 'not needed for Toast',
    fields: [
      { key: 'client_id', label: 'Client ID', placeholder: '', secret: false },
      { key: 'client_secret', label: 'Client secret', placeholder: '••••••••', secret: true },
      { key: 'restaurant_guid', label: 'Restaurant GUID', placeholder: '', secret: false },
    ],
    help: 'GATED: Toast requires an approved integration-partner account (application + security review + signed agreement) before production API access. Once approved you get a Client ID/Secret; the Restaurant GUID identifies the location.',
    knowledgeSync: false, implemented: true,
  },
  athenahealth: {
    label: 'athenahealth', tagline: 'EHR — patients, appointments, billing',
    defaultCategory: 'other',
    baseUrlLabel: 'athenahealth API (fixed — leave blank)', baseUrlPlaceholder: 'not needed for athenahealth',
    fields: [
      { key: 'client_id', label: 'Client ID', placeholder: '', secret: false },
      { key: 'client_secret', label: 'Client secret', placeholder: '••••••••', secret: true },
      { key: 'practiceid', label: 'Practice ID', placeholder: '', secret: false },
    ],
    help: '⚠️ PHI — a signed BAA is REQUIRED before connecting real patient data (see the BAA steps in chat). GATED: register the app in the athenahealth Marketplace/Developer program to get Client ID/Secret; the Practice ID identifies your practice. Do not connect without a BAA in place.',
    knowledgeSync: false, implemented: true,
  },
  epic: {
    label: 'Epic', tagline: 'EHR — FHIR R4 (SMART Backend Services)',
    defaultCategory: 'other',
    baseUrlLabel: 'FHIR base URL', baseUrlPlaceholder: 'https://fhir.epic.com/.../api/FHIR/R4',
    fields: [
      { key: 'client_id', label: 'Client ID (non-production/production)', placeholder: '', secret: false },
      { key: 'token_url', label: 'Token endpoint', placeholder: 'https://.../oauth2/token', secret: false },
      { key: 'private_key', label: 'Private key (PEM, PKCS8)', placeholder: '-----BEGIN PRIVATE KEY-----', secret: true, multiline: true },
    ],
    help: '⚠️ PHI — a signed BAA is REQUIRED (see the BAA steps in chat). Uses SMART on FHIR "Backend Services": register your app at fhir.epic.com, upload your PUBLIC key, and each health system must authorize your Client ID against their Epic. Paste the Client ID, that system\'s token endpoint, the org\'s FHIR base URL, and your matching PRIVATE key. Do not connect without a BAA.',
    knowledgeSync: false, implemented: true,
  },
  cerner: {
    label: 'Oracle Health (Cerner)', tagline: 'EHR — FHIR R4 (SMART Backend Services)',
    defaultCategory: 'other',
    baseUrlLabel: 'FHIR base URL', baseUrlPlaceholder: 'https://fhir-.../r4',
    fields: [
      { key: 'client_id', label: 'Client ID', placeholder: '', secret: false },
      { key: 'token_url', label: 'Token endpoint', placeholder: 'https://.../token', secret: false },
      { key: 'private_key', label: 'Private key (PEM, PKCS8)', placeholder: '-----BEGIN PRIVATE KEY-----', secret: true, multiline: true },
    ],
    help: '⚠️ PHI — a signed BAA is REQUIRED (see the BAA steps in chat). Same SMART Backend Services model as Epic: register at code.cerner.com (Oracle Health), the org authorizes your Client ID, then paste the Client ID, token endpoint, FHIR base URL, and your private key. Do not connect without a BAA.',
    knowledgeSync: false, implemented: true,
  },
  close: {
    label: 'Close', tagline: 'CRM — leads, opportunities, activities',
    defaultCategory: 'crm',
    baseUrlLabel: 'Close API (fixed — leave blank)', baseUrlPlaceholder: 'not needed for Close',
    fields: [
      { key: 'api_key', label: 'API key', placeholder: 'api_••••••••', secret: true },
    ],
    help: 'In Close: Settings → API Keys → New API Key. Paste it here.',
    knowledgeSync: false, implemented: true,
  },
  kustomer: {
    label: 'Kustomer', tagline: 'CX — conversations & customers',
    defaultCategory: 'helpdesk',
    baseUrlLabel: 'Kustomer API (fixed — leave blank)', baseUrlPlaceholder: 'not needed for Kustomer',
    fields: [
      { key: 'api_key', label: 'API key', placeholder: '••••••••', secret: true },
    ],
    help: 'In Kustomer: Settings → API Keys → Add API Key (read roles). Paste it here.',
    knowledgeSync: false, implemented: true,
  },
  mailchimp: {
    label: 'Mailchimp', tagline: 'Marketing — campaigns & audiences',
    defaultCategory: 'other',
    baseUrlLabel: 'Mailchimp API (fixed — leave blank)', baseUrlPlaceholder: 'not needed for Mailchimp',
    fields: [
      { key: 'api_key', label: 'API key', placeholder: '••••••••-us21', secret: true },
    ],
    help: 'In Mailchimp: Account → Extras → API keys → Create A Key. The datacenter (e.g. us21) is read from the key\'s suffix automatically.',
    knowledgeSync: false, implemented: true,
  },
  gitbook: {
    label: 'GitBook', tagline: 'Docs — spaces & pages',
    defaultCategory: 'knowledge_base',
    baseUrlLabel: 'GitBook API (fixed — leave blank)', baseUrlPlaceholder: 'not needed for GitBook',
    fields: [
      { key: 'token', label: 'API token', placeholder: 'gb_api_••••••••', secret: true },
    ],
    help: 'In GitBook: Settings → Developer → Personal Access Tokens → create one. Paste it here.',
    knowledgeSync: false, implemented: true,
  },
  pipedrive: {
    label: 'Pipedrive', tagline: 'CRM — deals, organizations, contacts',
    defaultCategory: 'crm',
    baseUrlLabel: 'Pipedrive API (fixed — leave blank)', baseUrlPlaceholder: 'not needed for Pipedrive',
    fields: [
      { key: 'api_token', label: 'API token', placeholder: '••••••••', secret: true },
    ],
    help: 'In Pipedrive: your avatar → Personal preferences → API → copy your personal API token. Paste it here.',
    knowledgeSync: false, implemented: true,
  },
  smartsheet: {
    label: 'Smartsheet', tagline: 'Work management — sheets & rows',
    defaultCategory: 'product_system',
    baseUrlLabel: 'Smartsheet API (fixed — leave blank)', baseUrlPlaceholder: 'not needed for Smartsheet',
    fields: [
      { key: 'token', label: 'API access token', placeholder: '••••••••', secret: true },
    ],
    help: 'In Smartsheet: Account → Personal Settings → API Access → Generate new access token. Paste it here.',
    knowledgeSync: false, implemented: true,
  },
  wrike: {
    label: 'Wrike', tagline: 'Work management — tasks & folders',
    defaultCategory: 'product_system',
    baseUrlLabel: 'Wrike API (fixed — leave blank)', baseUrlPlaceholder: 'not needed for Wrike',
    fields: [
      { key: 'token', label: 'Permanent access token', placeholder: 'eyJ••••••••', secret: true },
    ],
    help: 'In Wrike: Apps & Integrations → API → create a Permanent access token. Paste it here.',
    knowledgeSync: false, implemented: true,
  },
  trello: {
    label: 'Trello', tagline: 'Kanban — boards, lists, cards',
    defaultCategory: 'product_system',
    baseUrlLabel: 'Trello API (fixed — leave blank)', baseUrlPlaceholder: 'not needed for Trello',
    fields: [
      { key: 'api_key', label: 'API key', placeholder: 'from trello.com/app-key', secret: false },
      { key: 'token', label: 'Token', placeholder: '••••••••', secret: true },
    ],
    help: 'Get an API key at trello.com/app-key, then generate a Token from the link on that page. Paste both.',
    knowledgeSync: false, implemented: true,
  },
  datadog: {
    label: 'Datadog', tagline: 'Observability — monitors & alerts',
    defaultCategory: 'product_system',
    baseUrlLabel: 'Datadog API (fixed — leave blank)', baseUrlPlaceholder: 'not needed for Datadog',
    fields: [
      { key: 'api_key', label: 'API key', placeholder: '••••••••', secret: true },
      { key: 'app_key', label: 'Application key', placeholder: '••••••••', secret: true },
    ],
    help: 'In Datadog: Organization Settings → API Keys (create one) and Application Keys (create one). Paste both. (US1 site; tell us if you use EU/other.)',
    knowledgeSync: false, implemented: true,
  },
  gorgias: {
    label: 'Gorgias', tagline: 'E-commerce support — tickets & customers',
    defaultCategory: 'helpdesk',
    baseUrlLabel: 'Gorgias URL', baseUrlPlaceholder: 'https://yourstore.gorgias.com',
    fields: [
      { key: 'email', label: 'Account email', placeholder: 'you@store.com', secret: false },
      { key: 'api_key', label: 'API key', placeholder: '••••••••', secret: true },
    ],
    help: 'In Gorgias: Settings → REST API → generate an API key. Use your account email + that key, plus your Gorgias URL.',
    knowledgeSync: false, implemented: true,
  },
  front: {
    label: 'Front', tagline: 'Shared inbox — conversations & contacts',
    defaultCategory: 'helpdesk',
    baseUrlLabel: 'Front API (fixed — leave blank)', baseUrlPlaceholder: 'not needed for Front',
    fields: [
      { key: 'token', label: 'API token', placeholder: 'eyJ••••••••', secret: true },
    ],
    help: 'In Front: Settings → Developers → API tokens → create a token with read scope. Paste it here.',
    knowledgeSync: false, implemented: true,
  },
  coda: {
    label: 'Coda', tagline: 'Docs & tables — knowledge base',
    defaultCategory: 'knowledge_base',
    baseUrlLabel: 'Coda API (fixed — leave blank)', baseUrlPlaceholder: 'not needed for Coda',
    fields: [
      { key: 'api_token', label: 'API token', placeholder: '••••••••', secret: true },
    ],
    help: 'In Coda: Account Settings → API Settings → Generate API token. Paste it here.',
    knowledgeSync: false, implemented: true,
  },
  pagerduty: {
    label: 'PagerDuty', tagline: 'Incidents — on-call & response',
    defaultCategory: 'product_system',
    baseUrlLabel: 'PagerDuty API (fixed — leave blank)', baseUrlPlaceholder: 'not needed for PagerDuty',
    fields: [
      { key: 'api_key', label: 'REST API key', placeholder: '••••••••', secret: true },
    ],
    help: 'In PagerDuty: Integrations → API Access Keys → Create New API Key (read-only is fine). Paste it here.',
    knowledgeSync: false, implemented: true,
  },
  sentry: {
    label: 'Sentry', tagline: 'Engineering — errors & issues',
    defaultCategory: 'product_system',
    baseUrlLabel: 'Sentry API (fixed — leave blank)', baseUrlPlaceholder: 'not needed for Sentry',
    fields: [
      { key: 'token', label: 'Auth token', placeholder: 'sntrys_••••••••', secret: true },
    ],
    help: 'In Sentry: Settings → Account → API → Auth Tokens (or an Internal Integration) with project:read / event:read. Paste the token.',
    knowledgeSync: false, implemented: true,
  },
  servicenow: {
    label: 'ServiceNow', tagline: 'ITSM — incidents, requests & knowledge base',
    defaultCategory: 'helpdesk',
    baseUrlLabel: 'Instance URL', baseUrlPlaceholder: 'https://yourinstance.service-now.com',
    fields: [
      { key: 'username', label: 'Integration user', placeholder: 'svc_dreamteam', secret: false },
      { key: 'password', label: 'Password', placeholder: '••••••••', secret: true },
    ],
    help: 'Create a dedicated integration user in ServiceNow (User Administration → Users) with read access to the incident and kb_knowledge tables (and write to incident work_notes if you want the DE to add notes). Use its username + password. For least privilege, scope the user\'s roles to only the tables you need.',
    knowledgeSync: true, implemented: true,
  },
  dynamics: {
    label: 'Microsoft Dynamics 365', tagline: 'CRM — accounts, cases, opportunities',
    defaultCategory: 'crm',
    baseUrlLabel: 'Organization URL', baseUrlPlaceholder: 'https://yourorg.crm.dynamics.com',
    fields: [
      { key: 'tenant_id', label: 'Directory (tenant) ID', placeholder: '00000000-0000-0000-0000-000000000000', secret: false },
      { key: 'client_id', label: 'Application (client) ID', placeholder: '11111111-1111-1111-1111-111111111111', secret: false },
      { key: 'client_secret', label: 'Client secret value', placeholder: '••••••••', secret: true },
    ],
    help: 'App-only access via Entra (Azure AD). Register an app, add a client secret, then in Dynamics create an Application User (Power Platform admin → Environments → Settings → Users → Application users) bound to that app with a security role granting read on accounts/contacts/opportunities/incidents. Paste the Directory (tenant) ID, Application (client) ID, secret, and your org URL.',
    knowledgeSync: false, implemented: true,
  },
  github: {
    label: 'GitHub', tagline: 'Engineering — issues & pull requests',
    defaultCategory: 'product_system',
    baseUrlLabel: 'GitHub API (fixed — leave blank)', baseUrlPlaceholder: 'not needed for GitHub',
    fields: [
      { key: 'token', label: 'Personal access token', placeholder: 'github_pat_••••••••', secret: true },
    ],
    help: 'In GitHub: Settings → Developer settings → Personal access tokens → generate a token with repo (or read-only: issues) scope. Fine-grained tokens work too — grant the repositories and Issues (read, and read/write if the DE should comment).',
    knowledgeSync: false, implemented: true,
  },
  gitlab: {
    label: 'GitLab', tagline: 'Engineering — issues & merge requests',
    defaultCategory: 'product_system',
    baseUrlLabel: 'GitLab URL', baseUrlPlaceholder: 'https://gitlab.com',
    fields: [
      { key: 'token', label: 'Personal access token', placeholder: 'glpat-••••••••', secret: true },
    ],
    help: 'In GitLab: your avatar → Edit profile → Access tokens → create one with the read_api scope (or api if the DE should post notes). Paste it plus your GitLab URL (https://gitlab.com, or your self-managed URL).',
    knowledgeSync: false, implemented: true,
  },
  guru: {
    label: 'Guru', tagline: 'Knowledge — verified cards & answers',
    defaultCategory: 'knowledge_base',
    baseUrlLabel: 'Guru API (fixed — leave blank)', baseUrlPlaceholder: 'not needed for Guru',
    fields: [
      { key: 'username', label: 'User email', placeholder: 'you@acme.com', secret: false },
      { key: 'api_token', label: 'API token', placeholder: '••••••••', secret: true },
    ],
    help: 'In Guru: Settings → API Access → create a User or Collection API token. Use your Guru user email plus that token.',
    knowledgeSync: true, implemented: true,
  },
  document360: {
    label: 'Document360', tagline: 'Help center — knowledge base articles',
    defaultCategory: 'knowledge_base',
    baseUrlLabel: 'Document360 API (fixed — leave blank)', baseUrlPlaceholder: 'not needed for Document360',
    fields: [
      { key: 'api_token', label: 'API token', placeholder: '••••••••', secret: true },
    ],
    help: 'In Document360: Settings → API tokens → generate a token. Paste it here. (Article ingest traverses versions → categories → articles; if your plan returns article content separately, tell us and we\'ll fetch per-article.)',
    knowledgeSync: true, implemented: true,
  },
  asana: {
    label: 'Asana', tagline: 'Work management — tasks & projects',
    defaultCategory: 'product_system',
    baseUrlLabel: 'Asana API (fixed — leave blank)', baseUrlPlaceholder: 'not needed for Asana',
    fields: [
      { key: 'token', label: 'Personal access token', placeholder: '1/••••••••', secret: true },
    ],
    help: 'In Asana: Settings → Apps → Manage Developer Apps → Personal access tokens → Create new token. Paste it here.',
    knowledgeSync: false, implemented: true,
  },
  clickup: {
    label: 'ClickUp', tagline: 'Work management — tasks, lists, docs',
    defaultCategory: 'product_system',
    baseUrlLabel: 'ClickUp API (fixed — leave blank)', baseUrlPlaceholder: 'not needed for ClickUp',
    fields: [
      { key: 'token', label: 'Personal API token', placeholder: 'pk_••••••••', secret: true },
    ],
    help: 'In ClickUp: your avatar → Settings → Apps → API Token → Generate. Paste the personal token (starts pk_).',
    knowledgeSync: false, implemented: true,
  },
  monday: {
    label: 'monday.com', tagline: 'Work management — boards & items',
    defaultCategory: 'product_system',
    baseUrlLabel: 'monday API (fixed — leave blank)', baseUrlPlaceholder: 'not needed for monday',
    fields: [
      { key: 'token', label: 'API token', placeholder: 'eyJ••••••••', secret: true },
    ],
    help: 'In monday.com: your avatar → Developers → My access tokens → copy your personal API token (v2). Paste it here.',
    knowledgeSync: false, implemented: true,
  },
  linear: {
    label: 'Linear', tagline: 'Engineering — issues, projects, cycles',
    defaultCategory: 'product_system',
    baseUrlLabel: 'Linear API (fixed — leave blank)', baseUrlPlaceholder: 'not needed for Linear',
    fields: [
      { key: 'api_key', label: 'Personal API key', placeholder: 'lin_api_••••••••', secret: true },
    ],
    help: 'In Linear: Settings → Security & access → Personal API keys → New API key. Paste it here.',
    knowledgeSync: false, implemented: true,
  },
  salesforce: {
    label: 'Salesforce', tagline: 'CRM — accounts, cases, knowledge articles',
    defaultCategory: 'crm',
    baseUrlLabel: 'Instance URL', baseUrlPlaceholder: 'https://yourorg.my.salesforce.com',
    fields: [
      { key: 'client_id', label: 'Connected app Consumer Key', placeholder: '3MVG9…', secret: false },
      { key: 'client_secret', label: 'Consumer Secret', placeholder: '••••••••', secret: true },
    ],
    help: 'Free option: sign up for a Salesforce Developer Edition at developer.salesforce.com/signup. Then Setup → App Manager → New Connected App → enable OAuth, add the "Client Credentials Flow", assign a run-as user, and copy the Consumer Key & Secret.',
    knowledgeSync: true, implemented: true,
  },
  confluence: {
    label: 'Confluence', tagline: 'Knowledge base — pages & documentation',
    defaultCategory: 'knowledge_base',
    baseUrlLabel: 'Atlassian site URL', baseUrlPlaceholder: 'https://acme.atlassian.net',
    fields: [
      { key: 'email', label: 'Atlassian account email', placeholder: 'you@acme.com', secret: false },
      { key: 'api_token', label: 'API token', placeholder: '••••••••', secret: true },
    ],
    help: 'Create a free API token at id.atlassian.com → Security → Create API token. Use it with the email of the same Atlassian account.',
    knowledgeSync: true, implemented: true,
  },
  jira: {
    label: 'Jira', tagline: 'Issue tracker — bugs, past fixes, project history',
    defaultCategory: 'helpdesk',
    baseUrlLabel: 'Atlassian site URL', baseUrlPlaceholder: 'https://acme.atlassian.net',
    fields: [
      { key: 'email', label: 'Atlassian account email', placeholder: 'you@acme.com', secret: false },
      { key: 'api_token', label: 'API token', placeholder: '••••••••', secret: true },
    ],
    help: 'Same credentials as Confluence: a free API token from id.atlassian.com → Security → Create API token, plus your account email.',
    knowledgeSync: false, implemented: true,
  },
  intercom: {
    label: 'Intercom', tagline: 'Customer messaging — conversations & help articles',
    defaultCategory: 'helpdesk',
    baseUrlLabel: 'API base URL', baseUrlPlaceholder: 'https://api.intercom.io',
    fields: [
      { key: 'access_token', label: 'Access token', placeholder: '••••••••', secret: true },
    ],
    help: 'In Intercom: Settings → Integrations → Developer Hub → New app → the Access Token is on the Authentication page. A free developer workspace works for testing.',
    knowledgeSync: true, implemented: true,
  },
  generic_rest: {
    label: 'Your product API', tagline: 'Any REST API — connect your own product with zero code',
    defaultCategory: 'product_system',
    baseUrlLabel: 'API base URL', baseUrlPlaceholder: 'https://api.yourproduct.com',
    fields: [
      { key: 'header_name', label: 'Auth header name (optional)', placeholder: 'Authorization', secret: false },
      { key: 'header_value', label: 'Auth header value (optional)', placeholder: 'Bearer …', secret: true },
    ],
    help: 'Point DreamTeam at any JSON REST API: give it a search endpoint (path + query parameter) and optionally a record endpoint (path with {ref}). If the API needs a key, add the header it expects — stored server-side, never shown again.',
    knowledgeSync: false, implemented: true,
  },
  template: {
    label: 'Custom system (from template)', tagline: 'Any REST system as configuration — built with the template builder',
    defaultCategory: 'other',
    baseUrlLabel: 'Base URL', baseUrlPlaceholder: 'set by the template',
    fields: [],
    help: 'Template connectors are created from the template library or the template builder — not from this generic form.',
    knowledgeSync: false, implemented: true,
  },
  sharepoint: {
    label: 'SharePoint', tagline: 'Documents & pages — a whole document library into knowledge',
    defaultCategory: 'knowledge_base',
    baseUrlLabel: 'Site URL', baseUrlPlaceholder: 'https://acme.sharepoint.com/sites/kb',
    fields: [
      { key: 'tenant_id', label: 'Directory (tenant) ID', placeholder: '00000000-0000-0000-0000-000000000000', secret: false },
      { key: 'client_id', label: 'Application (client) ID', placeholder: '11111111-1111-1111-1111-111111111111', secret: false },
      { key: 'client_secret', label: 'Client secret value', placeholder: '••••••••', secret: true },
    ],
    help: 'App-only access (no per-person sign-in). SECURITY: prefer least privilege — put shareable docs in ONE dedicated site, grant the app Sites.Selected (starts with access to nothing, then grant read on just that site) rather than Sites.Read.All (which exposes every site in your tenant). Steps: Azure portal → App registrations → New registration; Certificates & secrets → New client secret (copy the Value); API permissions → Microsoft Graph → Application permissions → add Sites.Selected → "Grant admin consent"; then grant the app read on your knowledge site (Graph: POST /sites/{id}/permissions with role read + your app). Copy the Directory (tenant) ID and Application (client) ID from the app\'s Overview page.',
    knowledgeSync: true, implemented: true,
  },
  gdrive: {
    label: 'Google Drive', tagline: 'Docs, Slides, Sheets & PDFs from a shared folder into knowledge',
    defaultCategory: 'knowledge_base',
    baseUrlLabel: 'Folder or Shared Drive ID (optional)', baseUrlPlaceholder: 'leave blank for everything shared with the service account',
    fields: [
      { key: 'service_account_json', label: 'Service account key (JSON)', placeholder: '{ "type": "service_account", "client_email": "...", "private_key": "..." }', secret: true, multiline: true },
    ],
    help: 'App-only access via a service account (no per-person sign-in). In Google Cloud Console → APIs & Services: enable the Google Drive API; then IAM & Admin → Service Accounts → Create; then Keys → Add key → JSON and paste the downloaded file here. Finally, in Google Drive, share the folder(s) you want ingested with the service account\'s email (…@….iam.gserviceaccount.com) as a Viewer.',
    knowledgeSync: true, implemented: true,
  },
};

export type ConnectorObjectType = 'ticket' | 'user' | 'organization';
export type ConnectorObjectMode = 'sync' | 'read_through';

export interface ConnectorObject {
  id: string;
  connector_id: string;
  object_type: ConnectorObjectType;
  mode: ConnectorObjectMode;
  sync_interval_mins: number;
  last_synced_at: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export type ConnectorActionKey = 'add_internal_note' | 'update_status' | 'reply_to_ticket';

export interface ConnectorAction {
  id: string;
  connector_id: string;
  action_key: ConnectorActionKey;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface SyncResult {
  ok: boolean;
  pulled?: number;
  upserted?: number;
  pages?: number;
  errors?: string[];
  error?: string;
}

export interface ReadThroughResult {
  ok: boolean;
  ticket?: Record<string, unknown>;
  persisted?: boolean;
  error?: string;
}

// ── Errors / tenant plumbing (mirrors customerApi) ────────────────

import { raise, requireTenantId, listTenantRows } from './liveShared';


// ── Connector CRUD ────────────────────────────────────────────────

// WS8 (mig 287): owner/admin toggle a connector's scheduled auto-sync. Note the
// tenant-wide feature flag `knowledge_scheduled_sync` (Platform Console, default
// OFF) must ALSO be on for the cron to actually run — this is the per-connector half.
export async function setConnectorSchedule(connectorId: string, enabled: boolean, intervalMins = 1440): Promise<void> {
  const { data, error } = await supabase.rpc('set_connector_schedule', {
    p_connector_id: connectorId, p_enabled: enabled, p_interval_mins: intervalMins,
  });
  if (error) throw new Error(error.message);
  const r = data as { ok?: boolean; error?: string };
  if (!r?.ok) throw new Error(r?.error === 'not_permitted' ? 'Only owners and admins can change auto-sync.' : (r?.error ?? 'Could not update auto-sync.'));
}

export async function listConnectors(): Promise<Connector[]> {
  return listTenantRows<Connector>('connectors', 'created_at', true, 'listConnectors');
}

export async function listConnectorObjects(connectorId: string): Promise<ConnectorObject[]> {
  const { data, error } = await supabase
    .from('connector_objects')
    .select('*')
    .eq('connector_id', connectorId)
    .order('object_type', { ascending: true });
  if (error) raise('listConnectorObjects', error);
  return (data ?? []) as ConnectorObject[];
}

export async function listConnectorActions(connectorId: string): Promise<ConnectorAction[]> {
  const { data, error } = await supabase
    .from('connector_actions')
    .select('*')
    .eq('connector_id', connectorId)
    .order('action_key', { ascending: true });
  if (error) raise('listConnectorActions', error);
  return (data ?? []) as ConnectorAction[];
}

export async function updateConnectorObject(
  id: string,
  updates: Partial<Pick<ConnectorObject, 'mode' | 'sync_interval_mins' | 'enabled'>>,
): Promise<ConnectorObject> {
  const { data, error } = await supabase
    .from('connector_objects')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error) raise('updateConnectorObject', error);
  return data as ConnectorObject;
}

export async function updateConnectorAction(
  id: string,
  enabled: boolean,
): Promise<ConnectorAction> {
  const { data, error } = await supabase
    .from('connector_actions')
    .update({ enabled })
    .eq('id', id)
    .select()
    .single();
  if (error) raise('updateConnectorAction', error);
  return data as ConnectorAction;
}

// ── Connect flow ──────────────────────────────────────────────────
// insert connector → set_connector_secret RPC → seed default
// objects/actions → live 'test' call. On auth failure the connector
// stays in 'error' with the reason recorded.

export interface ConnectZendeskInput {
  displayName: string;
  baseUrl: string;   // e.g. https://acme.zendesk.com
  email: string;
  apiToken: string;
}

export async function connectZendesk(
  input: ConnectZendeskInput,
): Promise<{ connector: Connector; test: { ok: boolean; error?: string } }> {
  const tid = await requireTenantId();
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
  const { data, error } = await supabase
    .from('connectors')
    .insert({
      tenant_id: tid,
      provider: 'zendesk',
      display_name: input.displayName.trim() || 'Zendesk',
      base_url: baseUrl,
      status: 'disconnected',
    })
    .select()
    .single();
  if (error) raise('connectZendesk', error);
  const connector = data as Connector;

  // Credential goes into the service-role-only table via RPC —
  // never through a normal insert, never readable back.
  const { error: secretErr } = await supabase.rpc('set_connector_secret', {
    p_connector_id: connector.id,
    p_secret: JSON.stringify({ email: input.email.trim(), api_token: input.apiToken.trim() }),
  });
  if (secretErr) raise('set_connector_secret', secretErr);

  // Default object registry: tickets sync (the working cache),
  // users/orgs read-through (never persisted).
  const { error: objErr } = await supabase.from('connector_objects').insert([
    { connector_id: connector.id, object_type: 'ticket', mode: 'sync', sync_interval_mins: 60, enabled: true },
    { connector_id: connector.id, object_type: 'user', mode: 'read_through', enabled: true },
    { connector_id: connector.id, object_type: 'organization', mode: 'read_through', enabled: true },
  ]);
  if (objErr) raise('seed connector_objects', objErr);

  // Write-back registry
  const { error: actErr } = await supabase.from('connector_actions').insert([
    { connector_id: connector.id, action_key: 'add_internal_note', enabled: true },
    { connector_id: connector.id, action_key: 'update_status', enabled: true },
  ]);
  if (actErr) raise('seed connector_actions', actErr);

  const test = await invokeConnector<{ ok: boolean; error?: string }>({
    action: 'test',
    connector_id: connector.id,
  });

  const { data: fresh } = await supabase
    .from('connectors').select('*').eq('id', connector.id).single();
  return { connector: (fresh ?? connector) as Connector, test };
}

export async function testConnector(connectorId: string): Promise<{ ok: boolean; error?: string }> {
  return invokeConnector({ action: 'test', connector_id: connectorId });
}

export async function syncTickets(connectorId: string): Promise<SyncResult> {
  return invokeConnector({ action: 'sync_tickets', connector_id: connectorId });
}

export async function readThroughTicket(
  connectorId: string,
  externalRef: string,
): Promise<ReadThroughResult> {
  return invokeConnector({ action: 'read_ticket', connector_id: connectorId, external_ref: externalRef });
}

export async function writeBack(
  connectorId: string,
  externalRef: string,
  op: ConnectorActionKey,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  return invokeConnector({ action: 'write_back', connector_id: connectorId, external_ref: externalRef, op, payload });
}

/** Disconnect: purge the secret (RPC) and mark disconnected.
 *  The connector row + object/action config are kept so a reconnect
 *  restores the same shape; the credential is gone. */
export async function disconnectConnector(connector: Connector): Promise<void> {
  const { error: purgeErr } = await supabase.rpc('purge_connector_secret', {
    p_connector_id: connector.id,
  });
  if (purgeErr) raise('purge_connector_secret', purgeErr);
  const { error } = await supabase
    .from('connectors')
    .update({ status: 'disconnected', last_error: null })
    .eq('id', connector.id);
  if (error) raise('disconnectConnector', error);
  const { appendAuditEvent } = await import('./guardrailApi');
  await appendAuditEvent({
    actor: 'You', actor_type: 'human', category: 'config_change',
    action: `Connector disconnected — ${connector.display_name || connector.provider} (${connector.base_url}); credential purged`,
    detail: { connector_id: connector.id, provider: connector.provider },
  });
}

export async function deleteConnector(connectorId: string): Promise<void> {
  const { error } = await supabase.from('connectors').delete().eq('id', connectorId);
  if (error) raise('deleteConnector', error);
}

// ── Connector Hub: generic connect flow + read-through actions ────

export interface HubItem {
  ref: string;
  type: string;
  title: string;
  snippet: string;
  url: string | null;
  raw?: unknown; // returned live, never persisted
}

export interface ConnectProviderInput {
  provider: ConnectorProvider;
  displayName: string;
  baseUrl: string;
  category: SystemCategory;
  accessMode: ConnectorAccessMode;
  /** Credential fields (PROVIDERS[provider].fields) — sent to the
   *  server-side secret store via RPC; the client can never read them back. */
  secrets: Record<string, string>;
  /** generic_rest endpoint templates */
  config?: Record<string, unknown>;
}

export async function connectProvider(
  input: ConnectProviderInput,
): Promise<{ connector: Connector; test: { ok: boolean; error?: string; detail?: string } }> {
  const tid = await requireTenantId();
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
  const { data, error } = await supabase
    .from('connectors')
    .insert({
      tenant_id: tid,
      provider: input.provider,
      display_name: input.displayName.trim() || PROVIDERS[input.provider].label,
      base_url: baseUrl,
      category: input.category,
      access_mode: input.accessMode,
      config: input.config ?? {},
      status: 'disconnected',
    })
    .select()
    .single();
  if (error) raise('connectProvider', error);
  const connector = data as Connector;

  const secretEntries = Object.entries(input.secrets).filter(([, v]) => v.trim());
  if (secretEntries.length > 0) {
    const { error: secretErr } = await supabase.rpc('set_connector_secret', {
      p_connector_id: connector.id,
      p_secret: JSON.stringify(Object.fromEntries(secretEntries.map(([k, v]) => [k, v.trim()]))),
    });
    if (secretErr) raise('set_connector_secret', secretErr);
  }

  // Zendesk keeps its object/action registries (sync + write-back path).
  if (input.provider === 'zendesk') {
    await supabase.from('connector_objects').insert([
      { connector_id: connector.id, object_type: 'ticket', mode: input.accessMode === 'ingest' ? 'sync' : 'read_through', sync_interval_mins: 60, enabled: true },
      { connector_id: connector.id, object_type: 'user', mode: 'read_through', enabled: true },
      { connector_id: connector.id, object_type: 'organization', mode: 'read_through', enabled: true },
    ]);
    await supabase.from('connector_actions').insert([
      { connector_id: connector.id, action_key: 'add_internal_note', enabled: true },
      { connector_id: connector.id, action_key: 'update_status', enabled: true },
    ]);
  }

  const test = PROVIDERS[input.provider].implemented
    ? await invokeHub<{ ok: boolean; error?: string; detail?: string }>({ action: 'test', connector_id: connector.id })
    : { ok: false, error: 'not_implemented' };

  const { data: fresh } = await supabase
    .from('connectors').select('*').eq('id', connector.id).single();
  return { connector: (fresh ?? connector) as Connector, test };
}

export async function hubTest(connectorId: string): Promise<{ ok: boolean; error?: string; detail?: string }> {
  return invokeHub({ action: 'test', connector_id: connectorId });
}

/** Read-through search: fetched live, returned, nothing persisted but audit. */
export async function hubSearch(connectorId: string, query: string): Promise<{ ok: boolean; items: HubItem[]; error?: string; latency_ms?: number }> {
  return invokeHub({ action: 'search', connector_id: connectorId, query });
}

export async function hubFetchRecord(connectorId: string, recordType: string, externalRef: string): Promise<{ ok: boolean; items: HubItem[]; error?: string }> {
  return invokeHub({ action: 'fetch_record', connector_id: connectorId, record_type: recordType, external_ref: externalRef });
}

/** Knowledge ingest (server-side REFUSES this for fetch-only connectors). */
export async function hubSync(connectorId: string): Promise<{ ok: boolean; upserted?: number; chunked?: number; embedded?: number; error?: string; detail?: string }> {
  return invokeHub({ action: 'sync', connector_id: connectorId });
}

// ── Ingest control (migration 138): filters + review-before-ingest queue ──

export interface IngestFilters {
  exclude_patterns: string[];        // skip files/folders whose path contains one of these
  allow_types: string[] | null;      // if set, only these coarse types (pdf|doc|slide|sheet|text)
  folder: string | null;             // SharePoint sub-folder path / Drive folder id to scope to
  require_review: boolean;           // only approved files ingest
}
export const INGEST_TYPES: { key: string; label: string }[] = [
  { key: 'pdf', label: 'PDFs' }, { key: 'doc', label: 'Documents (Word/Docs)' },
  { key: 'slide', label: 'Slides' }, { key: 'sheet', label: 'Spreadsheets' },
  { key: 'text', label: 'Text / Markdown' },
];
export const DEFAULT_INGEST_FILTERS: IngestFilters = { exclude_patterns: [], allow_types: null, folder: null, require_review: true };

export function readIngestFilters(c: Connector): IngestFilters {
  const raw = ((c.config ?? {}) as { ingest?: Partial<IngestFilters> }).ingest ?? {};
  return {
    exclude_patterns: Array.isArray(raw.exclude_patterns) ? raw.exclude_patterns : [],
    allow_types: Array.isArray(raw.allow_types) ? raw.allow_types : null,
    folder: typeof raw.folder === 'string' && raw.folder.trim() ? raw.folder.trim() : null,
    require_review: raw.require_review !== false,   // default ON
  };
}

/** Owner/admin: persist the connector's ingest filters + review toggle. */
export async function setIngestConfig(connectorId: string, filters: IngestFilters): Promise<void> {
  const { error } = await supabase.rpc('set_connector_ingest_config', {
    p_connector_id: connectorId,
    p_config: {
      exclude_patterns: filters.exclude_patterns.map((s) => s.trim()).filter(Boolean),
      allow_types: filters.allow_types?.length ? filters.allow_types : null,
      folder: filters.folder?.trim() || null,
      require_review: !!filters.require_review,
    },
  });
  if (error) raise('setIngestConfig', error);
}

export interface IngestCandidate {
  id: string;
  external_ref: string;
  title: string;
  path: string;
  file_type: string;
  size_bytes: number | null;
  status: 'pending' | 'approved' | 'rejected' | 'ingested';
  discovered_at: string;
  ingested_at: string | null;
}

export async function listIngestCandidates(connectorId: string): Promise<IngestCandidate[]> {
  const { data, error } = await supabase
    .from('connector_ingest_candidates')
    .select('id, external_ref, title, path, file_type, size_bytes, status, discovered_at, ingested_at')
    .eq('connector_id', connectorId)
    .order('status', { ascending: true })
    .order('title', { ascending: true });
  if (error) raise('listIngestCandidates', error);
  return (data ?? []) as IngestCandidate[];
}

/** Owner/admin: approve / reject / reset candidates (null refs = all). */
export async function decideIngestCandidates(
  connectorId: string,
  refs: string[] | null,
  decision: 'approved' | 'rejected' | 'pending',
): Promise<number> {
  const { data, error } = await supabase.rpc('decide_ingest_candidates', {
    p_connector_id: connectorId, p_refs: refs, p_decision: decision,
  });
  if (error) raise('decideIngestCandidates', error);
  return (data as number) ?? 0;
}

/** Scan the source, applying filters, into the review queue (no ingest). */
export async function discoverConnector(connectorId: string): Promise<{ ok: boolean; found?: number; new?: number; pending?: number; approved?: number; rejected?: number; ingested?: number; error?: string; detail?: string }> {
  return invokeHub({ action: 'discover', connector_id: connectorId });
}

// ── Category contract (migration 027) ─────────────────────────────

/** THE CATEGORY CONTRACT: run a canonical category op ({query} or
 *  {external_ref}) — the hub validates legality against the connector's
 *  category and translates to the provider adapter. Read-through. */
export async function hubCategoryOp(
  connectorId: string,
  op: string,
  params: { query?: string; external_ref?: string },
): Promise<{ ok: boolean; items: CanonicalItem[]; category?: string; op?: string; object?: string; error?: string; detail?: string; health?: ConnectorHealth; latency_ms?: number; legal_ops?: string[] }> {
  const r = await invokeHub({ action: 'category_op', connector_id: connectorId, op, params });
  return r as unknown as { ok: boolean; items: CanonicalItem[]; error?: string };
}

/** Call-driven health check: runs test() and updates last_ok_at / failures. */
export async function hubHealthCheck(connectorId: string): Promise<{ ok: boolean; health?: ConnectorHealth; error?: string; detail?: string; checked_at?: string }> {
  return invokeHub({ action: 'health_check', connector_id: connectorId });
}

/** Save the customer's field mapping ({canonical_field: source_field}). */
export async function updateConnectorFieldMap(
  connectorId: string,
  fieldMap: Record<string, string>,
): Promise<Connector> {
  const clean = Object.fromEntries(Object.entries(fieldMap).filter(([, v]) => v.trim()));
  const { data, error } = await supabase
    .from('connectors')
    .update({ field_map: clean })
    .eq('id', connectorId)
    .select()
    .single();
  if (error) raise('updateConnectorFieldMap', error);
  const { appendAuditEvent } = await import('./guardrailApi');
  await appendAuditEvent({
    actor: 'You', actor_type: 'human', category: 'config_change',
    action: `Connector field mapping updated — ${Object.keys(clean).length} canonical field(s) mapped`,
    detail: { connector_id: connectorId, field_map: clean },
  });
  return data as Connector;
}

// ── THE GENERALIZED ACTION LAYER (migration 035) ──────────────────
// The write-side sibling of hubCategoryOp: any registered
// action_definition — not a narrow whitelisted enum — can be
// previewed or executed against a connector. Risk annotations (MCP
// tool-annotation vocabulary: destructive/idempotent) travel with the
// definition so the UI can show "always requires approval" /
// "currently auto-executes once trusted" honestly.

export interface ActionDefinition {
  id: string;
  scope: 'platform' | 'tenant';
  tenant_id: string | null;
  category: SystemCategory;
  action_key: string;
  label: string;
  description: string;
  provider: string;
  template_id: string | null;
  param_schema: Array<{ name: string; type: string; required?: boolean; help?: string }>;
  risk: { destructive: boolean; idempotent: boolean };
  execution: Record<string, unknown>;
  status: 'active' | 'disabled';
  created_at: string;
  updated_at: string;
}

/** All actions registered for a category (platform + this tenant's own). */
export async function listActionDefinitions(category?: SystemCategory): Promise<ActionDefinition[]> {
  const tid = await requireTenantId();
  let q = supabase.from('action_definitions').select('*')
    .eq('status', 'active')
    .or(`scope.eq.platform,tenant_id.eq.${tid}`);
  if (category) q = q.eq('category', category);
  const { data, error } = await q.order('label', { ascending: true });
  if (error) raise('listActionDefinitions', error);
  return (data ?? []) as ActionDefinition[];
}

export interface ActionPreviewResult {
  ok: boolean;
  action_key?: string;
  label?: string;
  preview?: { method?: string; url?: string; body?: unknown };
  receipt_preview?: string;
  risk?: { destructive: boolean; idempotent: boolean };
  error?: string;
  detail?: string;
}

/** action_executions row shape (migration 035), read-only — used to
 *  show the real receipt next to a "DE at Work" decision (migration
 *  036) instead of just the decision label. */
export interface ActionExecutionRow {
  id: string;
  tenant_id: string;
  action_definition_id: string;
  connector_id: string;
  mode: 'preview' | 'execute';
  decision: string;
  destructive: boolean;
  idempotent: boolean;
  request_summary: string;
  receipt: string | null;
  task_id: string | null;
  created_at: string;
}

export async function getActionExecution(id: string): Promise<ActionExecutionRow | null> {
  const { data, error } = await supabase.from('action_executions').select('*').eq('id', id).maybeSingle();
  if (error) raise('getActionExecution', error);
  return (data as ActionExecutionRow | null) ?? null;
}

/** Render the exact request WITHOUT calling the external system. */
export async function previewAction(
  connectorId: string, actionKey: string, params: Record<string, unknown>,
): Promise<ActionPreviewResult> {
  return invokeHub({ action: 'preview_action', connector_id: connectorId, action_key: actionKey, params }) as unknown as Promise<ActionPreviewResult>;
}

export interface ActionExecuteResult {
  ok: boolean;
  gated?: boolean;
  decision?: string;
  reasoning?: string;
  task_id?: string | null;
  execution_id?: string | null;
  receipt?: string | null;
  receipt_preview?: string;
  error?: string;
  detail?: string;
}

/** Execute a registered action. Enforces write_back access, then the
 *  destructive-always-gates / guardrail / trust composition; on
 *  auto-execute or (approvedExecutionId set) human-approved re-entry,
 *  actually calls the external system and returns a plain-language receipt. */
export async function executeAction(
  connectorId: string, actionKey: string, params: Record<string, unknown>,
  opts?: { subjectKind?: 'de' | 'specialist'; subjectId?: string; approvedExecutionId?: string },
): Promise<ActionExecuteResult> {
  return invokeHub({
    action: 'execute_action', connector_id: connectorId, action_key: actionKey, params,
    subject_kind: opts?.subjectKind, subject_id: opts?.subjectId,
    approved_execution_id: opts?.approvedExecutionId,
  }) as unknown as Promise<ActionExecuteResult>;
}

/** The gated execution a human task is holding for approval — used by
 *  the Human Tasks pane to show the FULL draft (e.g. the reply text a
 *  customer would see) before the human decides. Returns null when the
 *  task doesn't gate an action. */
export interface GatedExecutionPreview {
  execution_id: string;
  action_label: string;
  destructive: boolean;
  request_summary: string | null;
  /** Full param values — params.body/params.note carry the complete
   *  draft text for reply/note actions. */
  params: Record<string, string>;
}

export async function getGatedExecutionForTask(taskId: string): Promise<GatedExecutionPreview | null> {
  const { data, error } = await supabase
    .from('action_executions')
    .select('id, params, request_summary, decision, action_definitions(label, risk)')
    .eq('task_id', taskId)
    .like('decision', 'human_gated%')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const def = (data as { action_definitions?: { label?: string; risk?: { destructive?: boolean } } }).action_definitions;
  return {
    execution_id: (data as { id: string }).id,
    action_label: def?.label ?? 'Registered action',
    destructive: !!def?.risk?.destructive,
    request_summary: (data as { request_summary: string | null }).request_summary,
    params: ((data as { params?: Record<string, string> }).params ?? {}),
  };
}

/**
 * decideHumanTask hook target for 'action_approval' tasks: given the
 * task, find its pending action_executions row and re-execute with
 * approved_execution_id set (skips decide_action_execution — it
 * already ran once — and goes straight to calling the external
 * system). Rejection just leaves the row as-is (already recorded
 * human_gated_* — no further write needed); the task itself is marked
 * rejected by decideHumanTask before this hook runs.
 */
export async function resolveActionExecution(
  taskId: string, decision: 'approved' | 'rejected',
): Promise<void> {
  if (decision === 'rejected') return; // nothing further to execute
  const { data: exec, error } = await supabase.rpc('resolve_action_execution_for_task', { p_task_id: taskId });
  if (error || !exec) { console.warn('resolveActionExecution: no pending execution for task', taskId); return; }
  const row = exec as { id: string; action_definition_id: string; connector_id: string; params: Record<string, unknown> };
  const { data: def } = await supabase.from('action_definitions').select('action_key').eq('id', row.action_definition_id).maybeSingle();
  if (!def) { console.warn('resolveActionExecution: action_definition missing', row.action_definition_id); return; }
  await executeAction(row.connector_id, def.action_key as string, row.params, { approvedExecutionId: row.id });
}

async function invokeHub<T = Record<string, unknown>>(
  body: Record<string, unknown>,
): Promise<T & { ok: boolean; error?: string; items: HubItem[] }> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new CustomerApiError('Not signed in.', false);
  // tenant_id is only ever a fallback the edge function verifies
  // server-side against a real Remote Access session (migration 102)
  // — for an ordinary tenant user it's redundant with their own
  // profile and never gets used.
  const tid = await getSessionTenantId();
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/connector-hub`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
      'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(tid ? { ...body, tenant_id: tid } : body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !data?.error) throw new CustomerApiError(`HTTP ${res.status}`, false);
  return { items: [], ...data, ok: !!data.ok } as T & { ok: boolean; error?: string; items: HubItem[] };
}

// ── User-OAuth (authorization-code) connect flow ──────────────────

/** The public redirect URI a platform admin registers in each OAuth app. */
export const OAUTH_CALLBACK_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/oauth-callback`;

/** Which OAuth apps a platform admin has configured (client id set). */
export async function oauthAppStatus(): Promise<Set<string>> {
  const { data, error } = await supabase.rpc('oauth_app_status');
  if (error) return new Set();
  return new Set(((data ?? []) as { provider: string }[]).map((r) => r.provider));
}

/** Platform admin: register an OAuth app's client id + secret (Vault-encrypted). */
export async function setOAuthApp(provider: ConnectorProvider, clientId: string, clientSecret: string): Promise<void> {
  const { error } = await supabase.rpc('set_oauth_app', { p_provider: provider, p_client_id: clientId.trim(), p_client_secret: clientSecret.trim() });
  if (error) raise('setOAuthApp', error);
}

/** Begin an OAuth connection: returns the provider's authorize URL to redirect to. */
export async function oauthStart(provider: ConnectorProvider, displayName: string): Promise<{ ok: boolean; authorize_url?: string; error?: string; detail?: string }> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new CustomerApiError('Not signed in.', false);
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/oauth-start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}`, 'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY },
    body: JSON.stringify({ provider, display_name: displayName }),
  });
  return res.json().catch(() => ({ ok: false, error: 'network_error' }));
}

// ── Edge function invocation (legacy zendesk fn — sync/write-back) ─

async function invokeConnector<T = Record<string, unknown>>(
  body: Record<string, unknown>,
): Promise<T & { ok: boolean; error?: string }> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new CustomerApiError('Not signed in.', false);
  const tid = await getSessionTenantId();
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/connector-zendesk`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
      'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(tid ? { ...body, tenant_id: tid } : body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !data?.error) {
    throw new CustomerApiError(`HTTP ${res.status}`, false);
  }
  return { ok: !!data.ok, ...data } as T & { ok: boolean; error?: string };
}

// ── Display helpers ───────────────────────────────────────────────

export const CONNECTOR_ERROR_LABELS: Record<string, string> = {
  zendesk_auth_failed: 'Zendesk rejected the credentials — check the email and API token.',
  zendesk_unreachable: 'Could not reach the Zendesk instance — check the subdomain URL.',
  no_credentials: 'No credentials stored for this connector — reconnect to add them.',
  invalid_credentials_format: 'Stored credentials are malformed — reconnect to replace them.',
  object_disabled: 'This object type is disabled for the connector.',
  object_not_in_sync_mode: 'This object is set to read-through — switch it to sync mode first.',
  action_disabled: 'This write-back action is disabled in the registry.',
  connector_not_found: 'Connector not found for this workspace.',
};

export function connectorErrorLabel(err: string | undefined | null): string {
  if (!err) return 'Unknown error';
  return CONNECTOR_ERROR_LABELS[err] ?? (err.startsWith('zendesk_error_')
    ? `Zendesk returned HTTP ${err.replace('zendesk_error_', '')}`
    : err);
}

export function fmtSince(iso: string | null): string {
  if (!iso) return 'never';
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? '' : 's'} ago`;
  return `${Math.round(hrs / 24)} day${hrs < 48 ? '' : 's'} ago`;
}

// ── Declarative Adapter Framework (migration 028) ──────────────────
// Templates make connecting ANY REST system configuration, not code.

import type {
  AdapterDefinition, AdapterTemplate,
} from './adapterTemplates';
import { validateAdapterDefinition, AUTH_META } from './adapterTemplates';

/** Platform library + this tenant's own templates (RLS does the scoping). */
export async function listAdapterTemplates(): Promise<AdapterTemplate[]> {
  const { data, error } = await supabase
    .from('adapter_templates')
    .select('*')
    .order('scope', { ascending: false })  // platform first? tenant first: 'tenant' > 'platform'
    .order('created_at', { ascending: true });
  if (error) raise('listAdapterTemplates', error);
  return (data ?? []) as AdapterTemplate[];
}

/** Save (create or update) a tenant-scope template. Validates locally
 *  first (plain-language errors); the RPC re-validates structurally and
 *  the executor re-validates on every run. */
export async function saveAdapterTemplate(input: {
  id?: string;
  name: string;
  description: string;
  category: SystemCategory;
  definition: AdapterDefinition;
}): Promise<string> {
  const v = validateAdapterDefinition(input.definition, input.category);
  if (!v.ok) throw new CustomerApiError(v.errors.join(' '), false);
  const { data, error } = await supabase.rpc('save_adapter_template', {
    p_name: input.name,
    p_description: input.description,
    p_category: input.category,
    p_definition: input.definition,
    p_id: input.id ?? null,
  });
  if (error) raise('save_adapter_template', error);
  const { appendAuditEvent } = await import('./guardrailApi');
  await appendAuditEvent({
    actor: 'You', actor_type: 'human', category: 'config_change',
    action: `Adapter template ${input.id ? 'updated' : 'created'} — "${input.name}" (${input.category}), ${Object.keys(input.definition.ops).length} operation(s) bound`,
    detail: { template_id: data, category: input.category, ops: Object.keys(input.definition.ops) },
  });
  return data as string;
}

export async function publishAdapterTemplate(id: string, name: string): Promise<void> {
  const { error } = await supabase.rpc('publish_adapter_template', { p_id: id });
  if (error) raise('publish_adapter_template', error);
  const { appendAuditEvent } = await import('./guardrailApi');
  await appendAuditEvent({
    actor: 'You', actor_type: 'human', category: 'config_change',
    action: `Adapter template published — "${name}" is now available to connect from`,
    detail: { template_id: id },
  });
}

export interface TemplateDryRunResult {
  ok: boolean;
  items: CanonicalItemLike[];
  error?: string | null;
  detail?: string | null;
  errors?: string[];          // validation errors when error = invalid_template_definition
  url_called?: string | null;
  raw_response?: unknown;     // side-by-side debug view — never persisted
  latency_ms?: number;
}
interface CanonicalItemLike { ref: string; title: string; snippet: string; url: string | null }

/** The builder's "Test now": run one op live against creds entered in the
 *  builder — before anything is saved. Secrets travel in-flight only and
 *  are never stored. Returns the raw response next to the extracted items. */
export async function templateDryRun(input: {
  definition: AdapterDefinition;
  category: SystemCategory;
  op: string;
  variables: Record<string, string>;
  secrets: Record<string, string>;
  params: { query?: string; external_ref?: string };
}): Promise<TemplateDryRunResult> {
  return invokeHub({
    action: 'template_dry_run',
    definition: input.definition,
    category: input.category,
    op: input.op,
    variables: input.variables,
    secrets: input.secrets,
    params: input.params,
  }) as unknown as Promise<TemplateDryRunResult>;
}

/** Create a connector FROM a template: variables fill the base URL,
 *  secrets go to the service-role-only store, then a live test runs. */
export async function connectFromTemplate(input: {
  template: AdapterTemplate;
  displayName: string;
  variables: Record<string, string>;
  secrets: Record<string, string>;
  accessMode: ConnectorAccessMode;
}): Promise<{ connector: Connector; test: { ok: boolean; error?: string; detail?: string } }> {
  const tid = await requireTenantId();
  // Render the base URL for display/health purposes (executor re-renders live).
  let baseUrl = input.template.definition.base_url_template;
  for (const [k, v] of Object.entries(input.variables)) baseUrl = baseUrl.split(`{${k}}`).join(v.trim());
  const { data, error } = await supabase
    .from('connectors')
    .insert({
      tenant_id: tid,
      provider: 'template',
      template_id: input.template.id,
      display_name: input.displayName.trim() || input.template.name,
      base_url: baseUrl.replace(/\/+$/, ''),
      category: input.template.category,
      access_mode: input.accessMode,
      config: { template_vars: Object.fromEntries(Object.entries(input.variables).map(([k, v]) => [k, v.trim()])) },
      status: 'disconnected',
    })
    .select()
    .single();
  if (error) raise('connectFromTemplate', error);
  const connector = data as Connector;

  const secretEntries = Object.entries(input.secrets).filter(([, v]) => v.trim());
  if (secretEntries.length > 0) {
    const { error: secretErr } = await supabase.rpc('set_connector_secret', {
      p_connector_id: connector.id,
      p_secret: JSON.stringify(Object.fromEntries(secretEntries.map(([k, v]) => [k, v.trim()]))),
    });
    if (secretErr) raise('set_connector_secret', secretErr);
  }

  const test = await invokeHub<{ ok: boolean; error?: string; detail?: string }>({ action: 'test', connector_id: connector.id });
  const { data: fresh } = await supabase
    .from('connectors').select('*').eq('id', connector.id).single();
  return { connector: (fresh ?? connector) as Connector, test };
}

/** Secret fields a template's auth recipe requires (labels for the connect form). */
export function templateSecretFields(def: AdapterDefinition): { key: string; label: string }[] {
  return AUTH_META[def.auth.type]?.secretFields ?? [];
}

// ── §3 BREADTH: teach a tool from an OpenAPI spec ────────────────────
// Owner/admin only (enforced in tool-learn + the publish RPC). Generated
// actions land as DRAFTS — invisible to every digital employee until an
// admin publishes them — and even once published, execution needs the
// platform kill switch AND still passes the full action gate.

export interface LearnedAction {
  id: string; category: string; action_key: string; label: string; description: string;
  status: 'draft' | 'active' | 'disabled';
  risk: { destructive?: boolean; idempotent?: boolean } | null;
  execution: { method?: string; path_template?: string } | null;
  learned_from_spec_id: string | null; created_at: string;
}

/** Parse an OpenAPI v2/v3 document into draft actions for a connector's category. */
export async function learnToolFromSpec(
  name: string, spec: unknown, opts: { base_url?: string; category?: string; max_ops?: number } = {},
): Promise<{ spec_id: string; slug: string; operation_count: number; status: string; note?: string;
             actions: { action_key: string; label: string; method: string; path: string }[] }> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new CustomerApiError('Not signed in.', false);
  const tid = await getSessionTenantId();
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/tool-learn`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
      'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ tenant_id: tid, name, spec, ...opts }),
  });
  const data = await res.json().catch(() => ({}));
  if (data?.error) {
    throw new CustomerApiError(
      data.error === 'admin_required'
        ? 'Only a workspace owner or admin can teach a new tool from an API spec.'
        : (data.detail ?? data.error), false);
  }
  if (!res.ok) throw new CustomerApiError(`HTTP ${res.status}`, false);
  return data;
}

/** Every action learned from a spec, drafts included (for the review list). */
export async function listLearnedActions(): Promise<LearnedAction[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase.rpc('list_learned_actions', { p_tenant_id: tid });
  if (error) raise('listLearnedActions', error);
  return (data ?? []) as LearnedAction[];
}

/** Publish (or unpublish) a learned action. Owner/admin only, server-enforced. */
export async function setLearnedActionStatus(
  actionId: string, status: 'active' | 'draft' | 'disabled',
): Promise<void> {
  const tid = await requireTenantId();
  const { data, error } = await supabase.rpc('set_learned_action_status', {
    p_tenant_id: tid, p_action_id: actionId, p_status: status,
  });
  if (error) raise('setLearnedActionStatus', error);
  const r = data as { ok?: boolean; error?: string } | null;
  if (!r?.ok) {
    throw new CustomerApiError(
      r?.error === 'not_authorized'
        ? 'Only a workspace owner or admin can publish a learned action.'
        : (r?.error ?? 'Could not update that action.'), false);
  }
}
