-- ============================================================
-- Migration 514: register 'erpnext' as a connector provider.
--
-- ERPNext is the first NATIVE provider for the erp_financials category —
-- before this, only the jsonplaceholder verification template served it.
-- The read adapter (test/search/fetchRecord/listRecent) and the
-- search_invoices / get_invoice category translators live in the
-- connector-hub edge function; this migration only widens the provider
-- allow-list so a connector row may carry provider='erpnext'.
--
-- Postgres has no "add a value to a CHECK constraint" primitive, so we drop
-- and re-add the whole constraint. The array below is the LIVE constraint
-- (pg_get_constraintdef), re-diffed against production immediately before
-- apply per the fresh-dump rule, with 'erpnext' appended and nothing else
-- changed. Reserved #514 against ledger max 513 (parallel streams hold
-- 481-513).
-- ============================================================
alter table public.connectors drop constraint if exists connectors_provider_check;
alter table public.connectors add constraint connectors_provider_check
  check (provider = any (array[
    'generic_rest','template','dreamteam','zendesk','freshdesk','freshservice','intercom','front','gorgias','kustomer',
    'servicenow','salesforce','hubspot','pipedrive','close','dynamics','confluence','sharepoint','gdrive','notion',
    'box','dropbox','guru','document360','gitbook','coda','contentful','jira','github','gitlab',
    'linear','pagerduty','datadog','sentry','asana','monday','clickup','trello','smartsheet','wrike',
    'slack','teams','quickbooks','xero','netsuite','stripe','shopify','woocommerce','bigcommerce','square',
    'gusto','bamboohr','greenhouse','lever','jobber','procore','clio','canvas','powerschool','ellucian',
    'athenahealth','epic','cerner','toast','buildium','twilio','typeform','calendly','okta','mailchimp',
    'erpnext'
  ]::text[]));

-- Assertions: the new value is accepted AND the recreation did not silently
-- drop an existing provider (guard against a stale hand-typed array).
do $assert$
declare
  v_def text;
begin
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint
   where conrelid = 'public.connectors'::regclass and conname = 'connectors_provider_check';
  if v_def is null then
    raise exception 'mig 514: connectors_provider_check missing after recreate';
  end if;
  if v_def not like '%''erpnext''%' then
    raise exception 'mig 514: erpnext not present in the recreated constraint';
  end if;
  -- representative existing providers must survive the recreate
  if v_def not like '%''zendesk''%' or v_def not like '%''netsuite''%' or v_def not like '%''template''%' then
    raise exception 'mig 514: recreation dropped an existing provider';
  end if;
end
$assert$;
