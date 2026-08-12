-- 727 — a catalog of the systems we know
--
-- The ~75 systems we claim to support have lived in a TypeScript constant
-- (PROVIDERS, src/lib/connectorApi.ts) hand-synced against a CHECK constraint
-- on connectors.provider. Two lists, one truth, nobody watching — and the
-- consequence is visible: TOP_PROVIDERS has no entry at all for ads, social or
-- web analytics, so 4 of 15 role archetypes demand a system category the
-- product cannot suggest anything for.
--
-- The discovery interview needs to ask the DATABASE "what do we know about
-- Xero", so the list has to exist server-side. This is a port, not a rewrite:
-- label, category, credential help and OAuth-ness all come straight from the
-- constant. The one genuinely new field is `aliases`, which is what lets free
-- text resolve to a provider.
--
-- The React UI deliberately keeps rendering from PROVIDERS. A test asserts the
-- two agree in both directions, which closes the drift risk without a risky
-- rewrite of the connector screens.

begin;

create table if not exists public.connector_providers (
  provider_key              text primary key,
  label                     text not null,
  category                  text not null,
  aliases                   text[] not null default '{}',
  auth_kind                 text not null check (auth_kind in ('oauth','api_key','basic')),
  credential_hint           text,
  default_base_url          text,
  implemented               boolean not null default false,
  active                    boolean not null default true,
  created_at                timestamptz not null default now()
);

alter table public.connector_providers enable row level security;

-- Readable by any signed-in user (it is a product catalog, not tenant data);
-- writable by nobody through PostgREST — it changes by migration only.
drop policy if exists connector_providers_read on public.connector_providers;
create policy connector_providers_read on public.connector_providers
  for select to authenticated using (true);

revoke all on public.connector_providers from public, anon;
revoke insert, update, delete on public.connector_providers from authenticated;
grant select on public.connector_providers to authenticated, service_role;
grant insert, update, delete on public.connector_providers to service_role;

insert into public.connector_providers
  (provider_key, label, category, aliases, auth_kind, credential_hint, default_base_url, implemented)
values
  ('zendesk', 'Zendesk', 'helpdesk', array['zendesk'], 'api_key', 'In Zendesk: Admin Center → Apps and integrations → APIs → Zendesk API → enable Token access → Add API token. Use your admin email plus that token.', 'https://acme.zendesk.com', true),
  ('chargebee', 'Chargebee', 'billing', array['chargebee'], 'api_key', 'In Chargebee: Settings → Configure Chargebee → API Keys → Create a Key (read-only is enough for reading invoices and subscriptions). Your site name is the part before ".chargebee.com" in your dashboard URL.', 'not needed for Chargebee', true),
  ('clover', 'Clover', 'pos', array['clover'], 'api_key', 'In Clover: Account & Setup → API Tokens → Create a new token, granting read access to Orders and Payments. The merchant ID appears in your Clover dashboard URL (…/m/{MERCHANT_ID}/…).', 'not needed for Clover', true),
  ('zohocrm', 'Zoho CRM', 'crm', array['zohocrm','zoho crm'], 'api_key', 'In Zoho: api-console.zoho.com → Add Client → Self Client → copy the Client ID and Secret, then generate a code for the scope ZohoCRM.modules.READ and exchange it for a refresh token. DreamTeam refreshes the access token itself from then on. If your Zoho account is not on .com (EU, India, Australia), set the two domain fields to match — otherwise leave them blank.', 'not needed for Zoho', true),
  ('zohodesk', 'Zoho Desk', 'helpdesk', array['zohodesk','zoho desk'], 'api_key', 'In Zoho: api-console.zoho.com → Add Client → Self Client → copy the Client ID and Secret, then generate a code for the scope Desk.tickets.READ and exchange it for a refresh token. The organisation ID is in Desk → Setup → Developer Space → API. If your Zoho account is not on .com, set the domain fields to match.', 'not needed for Zoho Desk', true),
  ('mcp', 'MCP server', 'other', array['mcp','mcp server','mcpserver'], 'api_key', 'Paste the server’s Streamable-HTTP endpoint. After connecting, use "Register tools" — DreamTeam reads the server’s tool list and registers each tool as an approval-gated action. Risk comes from the tool’s own MCP annotations, and anything not explicitly marked read-only requires human approval, so a tool can never quietly act on its own. Only public https addresses are allowed, and an admin can restrict which servers are permitted.', 'https://example.com/mcp', true),
  ('erpnext', 'ERPNext', 'erp_financials', array['erpnext'], 'api_key', 'In ERPNext: open your user (avatar → My Settings) → Settings tab → API Access → Generate Keys. Copy the API Key and the API Secret (the secret shows only once). The connector reads with that user’s permissions, so pick a user who can see Sales Invoices and Customers.', 'https://yourcompany.frappe.cloud', true),
  ('notion', 'Notion', 'knowledge_base', array['notion'], 'api_key', 'In Notion: notion.so/my-integrations → New integration → copy the Internal Integration Token. Then SHARE the pages/databases you want the DE to read WITH the integration (open a page → ••• → Connections → add your integration). The integration only sees pages you share — that sharing is your security boundary.', 'not needed for Notion', true),
  ('teams', 'Microsoft Teams', 'knowledge_base', array['teams','microsoft teams','microsoftteams'], 'api_key', 'App-only access (same Azure app registration as SharePoint). Reading Teams channel messages needs the PROTECTED Microsoft Graph permission ChannelMessage.Read.All — add it under API permissions → Application permissions, click "Grant admin consent", and note Microsoft meters/approves this API. Copy the Directory (tenant) ID and Application (client) ID from the app Overview, and a client secret from Certificates & secrets.', 'not needed for Teams', true),
  ('box', 'Box', 'knowledge_base', array['box'], 'api_key', 'App-only access (no user sign-in). In the Box Developer Console → Create a Custom App → Server Authentication (Client Credentials Grant) → copy the Client ID & Secret; authorize the app in the Box Admin Console (Apps → Custom Apps Manager). Enterprise ID is in the Admin Console under Account & Billing. The app sees only the folders you grant it — that scoping is your security boundary.', 'not needed for Box', true),
  ('freshdesk', 'Freshdesk', 'helpdesk', array['freshdesk'], 'api_key', 'In Freshdesk: click your profile → Profile Settings → your API key is on the right. Paste it plus your Freshdesk URL (https://yourcompany.freshdesk.com).', 'https://yourco.freshdesk.com', true),
  ('freshservice', 'Freshservice', 'helpdesk', array['freshservice'], 'api_key', 'In Freshservice: profile picture → Profile Settings → your API key is on the right panel. Paste it plus your Freshservice URL (https://yourcompany.freshservice.com).', 'https://yourco.freshservice.com', true),
  ('slack', 'Slack', 'knowledge_base', array['slack'], 'api_key', 'To let a DE search past Slack messages you need a User OAuth Token (xoxp-) with the search:read scope — bot tokens cannot search. In Slack: api.slack.com/apps → Create/select an app → OAuth & Permissions → add the "search:read" User Token Scope → Install to Workspace → copy the "User OAuth Token" (starts xoxp-). Paste it here. The DE reads past answers as knowledge; it never posts unless you add a posting action later.', 'not needed for Slack', true),
  ('hubspot', 'HubSpot', 'crm', array['hubspot'], 'api_key', 'In HubSpot: Settings → Integrations → Private Apps → Create a private app → on the Scopes tab enable the read scopes you want (crm.objects.contacts.read, crm.objects.companies.read, crm.objects.deals.read, tickets) → Create → copy the access token. One token covers CRM (companies, contacts, deals) and Service Hub (tickets). Set this connector''s category to "helpdesk" to use it as a support desk, or "CRM" for sales/account context.', 'not needed for HubSpot', true),
  ('clio', 'Clio', 'product_system', array['clio'], 'oauth', 'Connect by signing in to Clio — no keys to paste. (A platform admin registers the Clio app once.)', '', true),
  ('gusto', 'Gusto', 'payroll_hcm', array['gusto'], 'oauth', 'Connect by signing in to Gusto — no keys to paste. (A platform admin registers the Gusto app once.)', '', true),
  ('procore', 'Procore', 'product_system', array['procore'], 'oauth', 'Connect by signing in to Procore — no keys to paste. (A platform admin registers the Procore app once.)', '', true),
  ('jobber', 'Jobber', 'product_system', array['jobber'], 'oauth', 'Connect by signing in to Jobber — no keys to paste. (A platform admin registers the Jobber app once.)', '', true),
  ('quickbooks', 'QuickBooks Online', 'erp_financials', array['quickbooks','quickbooks online','quickbooksonline'], 'oauth', 'Connect by signing in to QuickBooks — no keys to paste. (A platform admin registers the QuickBooks app once, then anyone can connect their company.)', '', true),
  ('xero', 'Xero', 'erp_financials', array['xero'], 'oauth', 'Connect by signing in to Xero — no keys to paste. (A platform admin registers the Xero app once, then anyone can connect their organisation.)', '', true),
  ('stripe', 'Stripe', 'billing', array['stripe'], 'api_key', 'In Stripe: Developers → API keys → use a Restricted key with read access to Invoices, Subscriptions and Customers (safer than the full secret key). Paste it here.', 'not needed for Stripe', true),
  ('shopify', 'Shopify', 'pos', array['shopify'], 'api_key', 'In Shopify admin: Settings → Apps and sales channels → Develop apps → Create an app → Configuration → Admin API access scopes (add read_orders, read_products, read_customers) → Install → reveal the Admin API access token (shpat_…). Paste it plus your store URL.', 'https://yourstore.myshopify.com', true),
  ('woocommerce', 'WooCommerce', 'pos', array['woocommerce'], 'api_key', 'In WordPress: WooCommerce → Settings → Advanced → REST API → Add key → set Read permissions → copy the Consumer key & secret. Paste them plus your store URL.', 'https://yourstore.com', true),
  ('bigcommerce', 'BigCommerce', 'pos', array['bigcommerce'], 'api_key', 'In BigCommerce: Settings → API → Store-level API accounts → Create → give it read scopes for Orders, Products, Customers → copy the Access Token. The store hash is in your control-panel URL (store-XXXX → the XXXX is the hash).', 'not needed for BigCommerce', true),
  ('square', 'Square', 'pos', array['square'], 'api_key', 'In the Square Developer Dashboard: create an application → Production → copy the Access Token (or use OAuth for a merchant). Paste it here.', 'not needed for Square', true),
  ('bamboohr', 'BambooHR', 'payroll_hcm', array['bamboohr'], 'api_key', 'In BambooHR: your avatar → API Keys → Add New Key. Paste the key plus your company subdomain (the acme in acme.bamboohr.com).', 'not needed for BambooHR', true),
  ('greenhouse', 'Greenhouse', 'product_system', array['greenhouse'], 'api_key', 'In Greenhouse: Configure → Dev Center → API Credential Management → Create New API Key → type Harvest → grant read on Candidates/Jobs. Paste the key.', 'not needed for Greenhouse', true),
  ('lever', 'Lever', 'product_system', array['lever'], 'api_key', 'In Lever: Settings → Integrations and API → API credentials → Generate a new key with read access. Paste it here.', 'not needed for Lever', true),
  ('buildium', 'Buildium', 'product_system', array['buildium'], 'api_key', 'In Buildium: Settings → API settings → enable the API and create an API key → copy the Client ID & Secret.', 'not needed for Buildium', true),
  ('canvas', 'Canvas LMS', 'product_system', array['canvas','canvas lms','canvaslms'], 'api_key', 'In Canvas: Account → Settings → Approved Integrations → + New Access Token. Paste it plus your Canvas URL (https://yourschool.instructure.com).', 'https://yourschool.instructure.com', true),
  ('twilio', 'Twilio', 'other', array['twilio'], 'api_key', 'In the Twilio Console dashboard: copy your Account SID and Auth Token. (An API Key SID/Secret also works in place of the auth token.)', 'not needed for Twilio', true),
  ('typeform', 'Typeform', 'product_system', array['typeform'], 'api_key', 'In Typeform: Settings → Personal tokens → Generate a new token. Paste it here.', 'not needed for Typeform', true),
  ('calendly', 'Calendly', 'product_system', array['calendly'], 'api_key', 'In Calendly: Integrations → API & Webhooks → Personal Access Tokens → Generate. Paste it here.', 'not needed for Calendly', true),
  ('okta', 'Okta', 'product_system', array['okta'], 'api_key', 'In Okta admin: Security → API → Tokens → Create Token (SSWS). Paste it plus your Okta org URL.', 'https://yourorg.okta.com', true),
  ('contentful', 'Contentful', 'knowledge_base', array['contentful'], 'api_key', 'In Contentful: Settings → API keys → add an API key → copy the Space ID and the Content Delivery API access token.', 'not needed for Contentful', true),
  ('dropbox', 'Dropbox', 'knowledge_base', array['dropbox'], 'oauth', 'Connect by signing in to Dropbox — no keys to paste. (A platform admin registers the Dropbox app once.) Then use "What gets ingested" to choose folders, exclude patterns, and review files before they enter knowledge. SECURITY: the real boundary is sharing only the intended folder(s) with the app.', '', true),
  ('netsuite', 'NetSuite', 'erp_financials', array['netsuite'], 'api_key', 'Uses NetSuite Token-Based Auth (TBA). In NetSuite: enable the TBA feature, create an Integration record (get the Consumer key/secret), then create an Access Token for a role (get the Token ID/secret). Paste all four plus your Account ID and SuiteTalk REST base URL.', 'https://ACCT.suitetalk.api.netsuite.com/services/rest', true),
  ('powerschool', 'PowerSchool', 'product_system', array['powerschool'], 'api_key', 'GATED: a PowerSchool plugin must be installed and enabled by the DISTRICT, which then provides the Client ID/Secret. Paste those plus the district URL. Without the district installing the plugin, this cannot connect.', 'https://yourdistrict.powerschool.com', true),
  ('ellucian', 'Ellucian (Banner/Colleague)', 'product_system', array['ellucian','ellucian (banner/colleague)','ellucianbannercolleague'], 'api_key', 'GATED: requires an Ellucian Ethos entitlement enabled by the institution, which provides the Ethos API key. Paste it here.', 'not needed for Ellucian', true),
  ('toast', 'Toast', 'pos', array['toast'], 'api_key', 'GATED: Toast requires an approved integration-partner account (application + security review + signed agreement) before production API access. Once approved you get a Client ID/Secret; the Restaurant GUID identifies the location.', 'not needed for Toast', true),
  ('athenahealth', 'athenahealth', 'other', array['athenahealth'], 'api_key', '⚠️ PHI — a signed BAA is REQUIRED before connecting real patient data (see the BAA steps in chat). GATED: register the app in the athenahealth Marketplace/Developer program to get Client ID/Secret; the Practice ID identifies your practice. Do not connect without a BAA in place.', 'not needed for athenahealth', true),
  ('epic', 'Epic', 'other', array['epic'], 'api_key', '⚠️ PHI — a signed BAA is REQUIRED (see the BAA steps in chat). Uses SMART on FHIR "Backend Services": register your app at fhir.epic.com, upload your PUBLIC key, and each health system must authorize your Client ID against their Epic. Paste the Client ID, that system''s token endpoint, the org''s FHIR base URL, and your matching PRIVATE key. Do not connect without a BAA.', 'https://fhir.epic.com/.../api/FHIR/R4', true),
  ('cerner', 'Oracle Health (Cerner)', 'other', array['cerner','oracle health (cerner)','oraclehealthcerner'], 'api_key', '⚠️ PHI — a signed BAA is REQUIRED (see the BAA steps in chat). Same SMART Backend Services model as Epic: register at code.cerner.com (Oracle Health), the org authorizes your Client ID, then paste the Client ID, token endpoint, FHIR base URL, and your private key. Do not connect without a BAA.', 'https://fhir-.../r4', true),
  ('close', 'Close', 'crm', array['close'], 'api_key', 'In Close: Settings → API Keys → New API Key. Paste it here.', 'not needed for Close', true),
  ('kustomer', 'Kustomer', 'helpdesk', array['kustomer'], 'api_key', 'In Kustomer: Settings → API Keys → Add API Key (read roles). Paste it here.', 'not needed for Kustomer', true),
  ('mailchimp', 'Mailchimp', 'other', array['mailchimp'], 'api_key', 'In Mailchimp: Account → Extras → API keys → Create A Key. The datacenter (e.g. us21) is read from the key''s suffix automatically.', 'not needed for Mailchimp', true),
  ('gitbook', 'GitBook', 'knowledge_base', array['gitbook'], 'api_key', 'In GitBook: Settings → Developer → Personal Access Tokens → create one. Paste it here.', 'not needed for GitBook', true),
  ('pipedrive', 'Pipedrive', 'crm', array['pipedrive'], 'api_key', 'In Pipedrive: your avatar → Personal preferences → API → copy your personal API token. Paste it here.', 'not needed for Pipedrive', true),
  ('smartsheet', 'Smartsheet', 'product_system', array['smartsheet'], 'api_key', 'In Smartsheet: Account → Personal Settings → API Access → Generate new access token. Paste it here.', 'not needed for Smartsheet', true),
  ('wrike', 'Wrike', 'product_system', array['wrike'], 'api_key', 'In Wrike: Apps & Integrations → API → create a Permanent access token. Paste it here.', 'not needed for Wrike', true),
  ('trello', 'Trello', 'product_system', array['trello'], 'api_key', 'Get an API key at trello.com/app-key, then generate a Token from the link on that page. Paste both.', 'not needed for Trello', true),
  ('datadog', 'Datadog', 'product_system', array['datadog'], 'api_key', 'In Datadog: Organization Settings → API Keys (create one) and Application Keys (create one). Paste both. (US1 site; tell us if you use EU/other.)', 'not needed for Datadog', true),
  ('gorgias', 'Gorgias', 'helpdesk', array['gorgias'], 'api_key', 'In Gorgias: Settings → REST API → generate an API key. Use your account email + that key, plus your Gorgias URL.', 'https://yourstore.gorgias.com', true),
  ('front', 'Front', 'helpdesk', array['front'], 'api_key', 'In Front: Settings → Developers → API tokens → create a token with read scope. Paste it here.', 'not needed for Front', true),
  ('coda', 'Coda', 'knowledge_base', array['coda'], 'api_key', 'In Coda: Account Settings → API Settings → Generate API token. Paste it here.', 'not needed for Coda', true),
  ('pagerduty', 'PagerDuty', 'product_system', array['pagerduty'], 'api_key', 'In PagerDuty: Integrations → API Access Keys → Create New API Key (read-only is fine). Paste it here.', 'not needed for PagerDuty', true),
  ('sentry', 'Sentry', 'product_system', array['sentry'], 'api_key', 'In Sentry: Settings → Account → API → Auth Tokens (or an Internal Integration) with project:read / event:read. Paste the token.', 'not needed for Sentry', true),
  ('servicenow', 'ServiceNow', 'helpdesk', array['servicenow'], 'api_key', 'Create a dedicated integration user in ServiceNow (User Administration → Users) with read access to the incident and kb_knowledge tables (and write to incident work_notes if you want the DE to add notes). Use its username + password. For least privilege, scope the user''s roles to only the tables you need.', 'https://yourinstance.service-now.com', true),
  ('dynamics', 'Microsoft Dynamics 365', 'crm', array['dynamics','microsoft dynamics 365','microsoftdynamics365'], 'api_key', 'App-only access via Entra (Azure AD). Register an app, add a client secret, then in Dynamics create an Application User (Power Platform admin → Environments → Settings → Users → Application users) bound to that app with a security role granting read on accounts/contacts/opportunities/incidents. Paste the Directory (tenant) ID, Application (client) ID, secret, and your org URL.', 'https://yourorg.crm.dynamics.com', true),
  ('github', 'GitHub', 'product_system', array['github'], 'api_key', 'In GitHub: Settings → Developer settings → Personal access tokens → generate a token with repo (or read-only: issues) scope. Fine-grained tokens work too — grant the repositories and Issues (read, and read/write if the DE should comment).', 'not needed for GitHub', true),
  ('gitlab', 'GitLab', 'product_system', array['gitlab'], 'api_key', 'In GitLab: your avatar → Edit profile → Access tokens → create one with the read_api scope (or api if the DE should post notes). Paste it plus your GitLab URL (https://gitlab.com, or your self-managed URL).', 'https://gitlab.com', true),
  ('guru', 'Guru', 'knowledge_base', array['guru'], 'api_key', 'In Guru: Settings → API Access → create a User or Collection API token. Use your Guru user email plus that token.', 'not needed for Guru', true),
  ('document360', 'Document360', 'knowledge_base', array['document360'], 'api_key', 'In Document360: Settings → API tokens → generate a token. Paste it here. (Article ingest traverses versions → categories → articles; if your plan returns article content separately, tell us and we''ll fetch per-article.)', 'not needed for Document360', true),
  ('asana', 'Asana', 'product_system', array['asana'], 'api_key', 'In Asana: Settings → Apps → Manage Developer Apps → Personal access tokens → Create new token. Paste it here.', 'not needed for Asana', true),
  ('clickup', 'ClickUp', 'product_system', array['clickup'], 'api_key', 'In ClickUp: your avatar → Settings → Apps → API Token → Generate. Paste the personal token (starts pk_).', 'not needed for ClickUp', true),
  ('monday', 'monday.com', 'product_system', array['monday','monday.com','mondaycom'], 'api_key', 'In monday.com: your avatar → Developers → My access tokens → copy your personal API token (v2). Paste it here.', 'not needed for monday', true),
  ('linear', 'Linear', 'product_system', array['linear'], 'api_key', 'In Linear: Settings → Security & access → Personal API keys → New API key. Paste it here.', 'not needed for Linear', true),
  ('salesforce', 'Salesforce', 'crm', array['salesforce'], 'api_key', 'Free option: sign up for a Salesforce Developer Edition at developer.salesforce.com/signup. Then Setup → App Manager → New Connected App → enable OAuth, add the "Client Credentials Flow", assign a run-as user, and copy the Consumer Key & Secret.', 'https://yourorg.my.salesforce.com', true),
  ('confluence', 'Confluence', 'knowledge_base', array['confluence'], 'api_key', 'Create a free API token at id.atlassian.com → Security → Create API token. Use it with the email of the same Atlassian account.', 'https://acme.atlassian.net', true),
  ('jira', 'Jira', 'helpdesk', array['jira'], 'api_key', 'Same credentials as Confluence: a free API token from id.atlassian.com → Security → Create API token, plus your account email.', 'https://acme.atlassian.net', true),
  ('intercom', 'Intercom', 'helpdesk', array['intercom'], 'api_key', 'In Intercom: Settings → Integrations → Developer Hub → New app → the Access Token is on the Authentication page. A free developer workspace works for testing.', 'https://api.intercom.io', true),
  ('generic_rest', 'Your product API', 'product_system', array['generic_rest','your product api','yourproductapi'], 'api_key', 'Point DreamTeam at any JSON REST API: give it a search endpoint (path + query parameter) and optionally a record endpoint (path with {ref}). If the API needs a key, add the header it expects — stored server-side, never shown again.', 'https://api.yourproduct.com', true),
  ('template', 'Custom system (from template)', 'other', array['template','custom system (from template)','customsystemfromtemplate'], 'basic', 'Template connectors are created from the template library or the template builder — not from this generic form.', 'set by the template', true),
  ('sharepoint', 'SharePoint', 'knowledge_base', array['sharepoint'], 'api_key', 'App-only access (no per-person sign-in). SECURITY: prefer least privilege — put shareable docs in ONE dedicated site, grant the app Sites.Selected (starts with access to nothing, then grant read on just that site) rather than Sites.Read.All (which exposes every site in your tenant). Steps: Azure portal → App registrations → New registration; Certificates & secrets → New client secret (copy the Value); API permissions → Microsoft Graph → Application permissions → add Sites.Selected → "Grant admin consent"; then grant the app read on your knowledge site (Graph: POST /sites/{id}/permissions with role read + your app). Copy the Directory (tenant) ID and Application (client) ID from the app''s Overview page.', 'https://acme.sharepoint.com/sites/kb', true),
  ('gdrive', 'Google Drive', 'knowledge_base', array['gdrive','google drive','googledrive'], 'api_key', 'App-only access via a service account (no per-person sign-in). In Google Cloud Console → APIs & Services: enable the Google Drive API; then IAM & Admin → Service Accounts → Create; then Keys → Add key → JSON and paste the downloaded file here. Finally, in Google Drive, share the folder(s) you want ingested with the service account''s email (…@….iam.gserviceaccount.com) as a Viewer.', 'leave blank for everything shared with the service account', true)
on conflict (provider_key) do update set
  label = excluded.label,
  category = excluded.category,
  aliases = excluded.aliases,
  auth_kind = excluded.auth_kind,
  credential_hint = excluded.credential_hint,
  default_base_url = excluded.default_base_url,
  implemented = excluded.implemented;

-- Curated synonyms the generator cannot infer. These are what make free text
-- resolve: a customer says "we do our books in zero", not "xero".
update public.connector_providers set aliases = aliases || array['zero','books','accounting software']
  where provider_key = 'xero';
update public.connector_providers set aliases = aliases || array['qb','qbo']
  where provider_key = 'quickbooks';
-- ('quickbooks online' deliberately absent here — the generator already
-- derives it from the label, and listing it twice on one row is what tripped
-- the duplicate-alias check below on the first run of this migration.)
update public.connector_providers set aliases = aliases || array['sfdc','sales force']
  where provider_key = 'salesforce';
update public.connector_providers set aliases = aliases || array['hub spot']
  where provider_key = 'hubspot';
update public.connector_providers set aliases = aliases || array['zen desk']
  where provider_key = 'zendesk';

do $$
declare v_n int; v_dupe int;
begin
  select count(*) into v_n from public.connector_providers where active;
  if v_n < 50 then
    raise exception '727: expected the full provider catalog, only % rows landed', v_n;
  end if;

  -- An alias that matches two providers makes the matcher ambiguous and is a
  -- seeding bug, not a runtime one. Catch it here.
  select count(*) into v_dupe from (
    select unnest(aliases) as a from public.connector_providers where active
  ) x group by a having count(*) > 1 limit 1;
  if coalesce(v_dupe, 0) > 0 then
    raise exception '727: an alias resolves to more than one provider';
  end if;

  if has_table_privilege('authenticated', 'public.connector_providers', 'delete') then
    raise exception '727: authenticated must not be able to delete from the catalog';
  end if;
  if not has_table_privilege('authenticated', 'public.connector_providers', 'select') then
    raise exception '727: authenticated must be able to read the catalog';
  end if;
end $$;

commit;
