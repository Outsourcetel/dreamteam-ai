-- ============================================================
-- Migration 543: register the P4 providers — Chargebee, Clover, Zoho CRM,
-- Zoho Desk (docs/40 P4). These are the top-5 systems that had NO adapter at
-- all; their read adapters + category translators ship with this in
-- connector-hub.
--
-- All four authenticate with credentials the CUSTOMER holds — Chargebee (site
-- + api key), Clover (api token + merchant id), Zoho (self-client id/secret/
-- refresh token) — so none needs a platform-level OAuth app, which is what
-- keeps "connect by pasting your own API credentials" true.
--
-- ⚠ SAGE IS DELIBERATELY NOT HERE. Sage Business Cloud needs a registered
-- developer app plus a redirect-based OAuth grant, so it cannot be connected
-- by pasting credentials — it requires us to register an app first, which is a
-- founder/commercial decision rather than an engineering one. erp_financials
-- already carries QuickBooks, Xero, ERPNext and NetSuite.
--
-- The array is the LIVE constraint (pg_get_constraintdef), re-dumped and
-- regenerated immediately before apply per the fresh-dump rule, with only the
-- four new values appended. Reserved #543 against ledger max 542.
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
    'erpnext','mcp','chargebee','clover','zohocrm','zohodesk'
  ]::text[]));

do $assert$
declare v_def text; v_missing text := '';
begin
  select pg_get_constraintdef(oid) into v_def from pg_constraint
   where conrelid='public.connectors'::regclass and conname='connectors_provider_check';
  if v_def is null then raise exception 'mig 543: connectors_provider_check missing after recreate'; end if;
  -- the four new ones must be accepted
  if v_def not like '%''chargebee''%' then v_missing := v_missing || ' chargebee'; end if;
  if v_def not like '%''clover''%'    then v_missing := v_missing || ' clover';    end if;
  if v_def not like '%''zohocrm''%'   then v_missing := v_missing || ' zohocrm';   end if;
  if v_def not like '%''zohodesk''%'  then v_missing := v_missing || ' zohodesk';  end if;
  if v_missing <> '' then raise exception 'mig 543: new provider(s) missing:%', v_missing; end if;
  -- and the recreation must not have dropped anything that already existed
  if v_def not like '%''erpnext''%' or v_def not like '%''mcp''%' or v_def not like '%''hubspot''%'
     or v_def not like '%''template''%' or v_def not like '%''zendesk''%' then
    raise exception 'mig 543: recreation dropped an existing provider';
  end if;
end
$assert$;
