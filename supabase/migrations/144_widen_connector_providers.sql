-- ============================================================
-- 144 — Widen connectors_provider_check to the full connector catalog.
--
-- Gap (found in the 2026-07-13 multi-tenancy audit): the UI PROVIDERS
-- registry / ConnectorProvider union exposes ~68 connectors and the picker
-- renders all of them to every tenant, but the connectors table CHECK
-- constraint only allowed 9 providers. So a real customer picking any of the
-- other ~59 — including ones with working connector-hub adapters (slack,
-- github, gitlab, asana, servicenow) and every open-token leader (hubspot,
-- notion, stripe, shopify, quickbooks, xero, freshdesk, …) — hit a Postgres
-- constraint violation on Connect. "Shipped in the UI, not wired at the DB."
-- This affects ALL tenants equally (not a demo/isolation issue).
--
-- Fix: allow every provider in the ConnectorProvider union (kept in sync
-- with src/lib/connectorApi.ts) plus the internal 'template'/'dreamteam'.
-- ============================================================
alter table connectors drop constraint if exists connectors_provider_check;
alter table connectors add constraint connectors_provider_check
  check (provider = any (array[
    -- generic + internal
    'generic_rest','template','dreamteam',
    -- helpdesk / support
    'zendesk','freshdesk','freshservice','intercom','front','gorgias','kustomer','servicenow',
    -- CRM / sales
    'salesforce','hubspot','pipedrive','close','dynamics',
    -- knowledge / docs / collab
    'confluence','sharepoint','gdrive','notion','box','dropbox','guru','document360','gitbook','coda','contentful',
    -- eng / itsm / observability
    'jira','github','gitlab','linear','pagerduty','datadog','sentry',
    -- work management
    'asana','monday','clickup','trello','smartsheet','wrike','slack','teams',
    -- finance / erp / commerce
    'quickbooks','xero','netsuite','stripe','shopify','woocommerce','bigcommerce','square',
    -- hr / payroll / ats
    'gusto','bamboohr','greenhouse','lever',
    -- vertical (field service, legal, edu, healthcare, hospitality, property)
    'jobber','procore','clio','canvas','powerschool','ellucian','athenahealth','epic','cerner','toast','buildium',
    -- comms / forms / scheduling / identity
    'twilio','typeform','calendly','okta','mailchimp'
  ]));
