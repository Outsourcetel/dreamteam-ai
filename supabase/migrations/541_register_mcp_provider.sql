-- ============================================================
-- Migration 541: register 'mcp' as a connector provider (docs/40 P2, M1).
--
-- Makes an MCP server a FIRST-CLASS CONNECTOR rather than a specialist-source
-- side channel. The point is governance, not reach: once a server is a
-- connector, each of its tools is registered as an action_definition and every
-- call goes through decide_action_execution (destructive floor → guardrails →
-- trust), the same gate every other connector write already passes.
--
-- The array below is the LIVE constraint (pg_get_constraintdef), re-dumped and
-- regenerated mechanically immediately before apply per the fresh-dump rule,
-- with 'mcp' appended and nothing else changed. Reserved #541 vs ledger 540.
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
    'erpnext','mcp'
  ]::text[]));

do $assert$
declare v_def text;
begin
  select pg_get_constraintdef(oid) into v_def from pg_constraint
   where conrelid='public.connectors'::regclass and conname='connectors_provider_check';
  if v_def is null or v_def not like '%''mcp''%' then
    raise exception 'mig 541: mcp missing from the recreated constraint';
  end if;
  -- recreation must not have dropped anything that already existed
  if v_def not like '%''erpnext''%' or v_def not like '%''hubspot''%' or v_def not like '%''template''%' then
    raise exception 'mig 541: recreation dropped an existing provider';
  end if;
end
$assert$;
