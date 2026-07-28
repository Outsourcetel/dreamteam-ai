-- 508_seed_test_account_book.sql
-- ============================================================================
-- TEST DATA, created at the founder's explicit request. Ten accounts with the
-- standard Salesforce Account mapping, four contacts each.
--
-- EVERY ROW IS MARKED. attributes->>'seed' = 'test_book_v1' on accounts and
-- contacts alike, and every account's description opens with [TEST]. This
-- matters more than it sounds: this platform already has an employee chasing a
-- renewal against a deleted test account, and docs/38 recorded seeded rows
-- being mistaken for a real book. Marked rows can be found and removed in one
-- statement — see the teardown note at the foot of this file.
--
-- ── SALESFORCE ACCOUNT MAPPING ─────────────────────────────────────────────
--   Account Name      -> name                  Annual Revenue -> arr_cents
--   Account Owner     -> csm                   Rating         -> health_score
--   Type              -> tier                  Account Number -> external_ref
--   Description       -> notes                 Renewal Date   -> renewal_date
--   Industry, Employees, Website, Phone, Billing Address, Ownership,
--   Parent Account, SIC, Segment  ->  attributes (jsonb)
--
-- ── SALESFORCE CONTACT MAPPING ─────────────────────────────────────────────
--   Salutation / First / Last, Title, Department, Email, Phone, Mobile,
--   Mailing City + Country, Lead Source, Reports To, Description
--   plus role and is_primary (mig 507)
--
-- ── TWO THINGS THIS DELIBERATELY EXERCISES ─────────────────────────────────
-- 1. THREE accounts are named to match the existing agreements — Lakeshore
--    Analytics, Meridian Group, Harbor Tech. Migration 506's trigger should
--    link each contract to its customer with nobody calling anything. If it
--    does not, 506 is inert and this migration will say so.
-- 2. A REALISTIC SPREAD of health, not all-green. Four watchers have never
--    fired in this platform's life — Account Success on at-risk and on health
--    below 60, Onboarding and Renewal on health below 50. Three accounts sit
--    under those lines on purpose, so the chain gets exercised rather than
--    admired. EXPECT AUTONOMOUS WORK: within a few minutes the watcher tick
--    will open cases against these accounts and employees will start working
--    them. That is the point, and it is also why the spread is three and not
--    ten.
-- ============================================================================

do $seed$
declare
  v_tenant uuid;
  v_acct uuid;
  v_boss uuid;
  r record;
  c record;
  n_acct int := 0;
  n_contact int := 0;
begin
  select t.id into v_tenant from tenants t where t.slug = 'outsourcetel-hq';
  if v_tenant is null then
    raise exception '508: outsourcetel-hq not found';
  end if;

  -- Idempotent: re-running must not double the book.
  if exists (select 1 from customer_accounts
              where tenant_id = v_tenant and attributes->>'seed' = 'test_book_v1') then
    raise notice '508: the test book already exists — nothing to do';
    return;
  end if;

  for r in
    select * from (values
      -- name, tier, industry, employees, arr_$, health, status, csm, renewal, city, country, website, phone, sic, ownership
      ('Lakeshore Analytics', 'Enterprise', 'Analytics Software', 240, 120000, 78, 'active',   'Priya Raman',  '2026-09-14', 'Chicago',   'United States', 'lakeshoreanalytics.com', '+1 312 555 0142', '7372', 'Private'),
      ('Meridian Group',      'Enterprise', 'Managed IT Services', 610, 84000,  46, 'at_risk',  'Priya Raman',  '2026-10-09', 'Manchester','United Kingdom','meridiangroup.co.uk',    '+44 161 555 0187', '7379', 'Private'),
      ('Harbor Tech',         'Mid-Market', 'Industrial Equipment', 95, 45000,  71, 'active',   'Daniel Osei',  '2026-09-04', 'Rotterdam', 'Netherlands',   'harbortech.nl',          '+31 10 555 0119',  '3559', 'Private'),
      ('Northwind Traders',   'Enterprise', 'Wholesale Distribution', 1450, 210000, 88, 'active','Daniel Osei', '2027-01-31', 'Seattle',   'United States', 'northwindtraders.com',   '+1 206 555 0164',  '5122', 'Public'),
      ('Cobalt Health',       'Enterprise', 'Healthcare Technology', 820, 156000, 41, 'at_risk', 'Priya Raman', '2026-11-20', 'Boston',    'United States', 'cobalthealth.io',        '+1 617 555 0173',  '8099', 'Private'),
      ('Fenwick Legal',       'Mid-Market', 'Legal Services', 140, 62000,  83, 'active',   'Amara Diallo', '2027-02-28', 'Toronto',   'Canada',        'fenwicklegal.ca',        '+1 416 555 0155',  '8111', 'Partnership'),
      ('Brightpath Learning', 'SMB',        'Education Technology', 48, 24000, 52, 'active',   'Amara Diallo', '2026-12-15', 'Dublin',    'Ireland',       'brightpathlearning.ie',  '+353 1 555 0128',  '8200', 'Private'),
      ('Sable Manufacturing', 'Enterprise', 'Industrial Manufacturing', 2300, 315000, 91, 'active','Daniel Osei','2027-04-30','Stuttgart', 'Germany',       'sable-mfg.de',           '+49 711 555 0193', '3499', 'Public'),
      ('Kestrel Logistics',   'Mid-Market', 'Transportation & Logistics', 380, 74000, 38, 'at_risk','Amara Diallo','2026-10-31','Singapore','Singapore',    'kestrel-logistics.sg',   '+65 6555 0146',    '4213', 'Private'),
      ('Ridgeway Capital',    'Enterprise', 'Financial Services', 520, 198000, 76, 'active',  'Priya Raman',  '2027-03-15', 'London',    'United Kingdom','ridgewaycapital.com',    '+44 20 5550 0171', '6282', 'Private')
    ) as v(name, tier, industry, employees, arr_usd, health, status, csm, renewal, city, country, website, phone, sic, ownership)
  loop
    insert into customer_accounts (
      tenant_id, name, tier, arr_cents, health_score, status, csm, renewal_date,
      external_ref, notes, attributes
    ) values (
      v_tenant, r.name, r.tier, (r.arr_usd::bigint * 100), r.health, r.status, r.csm, r.renewal::date,
      'ACC-' || lpad((n_acct + 1)::text, 5, '0'),
      format('[TEST] %s — %s. Seeded test account, not a real customer.', r.name, r.industry),
      jsonb_build_object(
        'seed', 'test_book_v1',
        'industry', r.industry,
        'employees', r.employees,
        'website', r.website,
        'phone', r.phone,
        'billing_city', r.city,
        'billing_country', r.country,
        'ownership', r.ownership,
        'sic_code', r.sic,
        'account_source', 'Seed — test book v1',
        'parent_account', null)
    ) returning id into v_acct;
    n_acct := n_acct + 1;

    -- Four contacts: an executive sponsor everyone reports to, then the three
    -- people an employee actually needs — who signs, who pays, who runs it.
    v_boss := null;
    for c in
      select * from (values
        (1, 'Ms',  'Elena',  'Vasquez', 'Chief Operating Officer',   'Executive',  'exec_sponsor',   true),
        (2, 'Mr',  'Tom',    'Bradley', 'VP Operations',             'Operations', 'decision_maker', false),
        (3, 'Ms',  'Priya',  'Nair',    'Financial Controller',      'Finance',    'billing',        false),
        (4, 'Mr',  'Sam',    'Okafor',  'Head of Platform',          'Technology', 'technical',      false)
      ) as v(seq, salutation, first_name, last_name, title, department, role, is_primary)
      order by seq
    loop
      insert into customer_account_contacts (
        tenant_id, account_id, end_user_ref, salutation, first_name, last_name,
        title, department, email, phone, mobile, mailing_city, mailing_country,
        lead_source, role, is_primary, reports_to, notes, attributes
      ) values (
        v_tenant, v_acct,
        lower(c.first_name || '.' || c.last_name || '@' || (r.website)),
        c.salutation, c.first_name, c.last_name, c.title, c.department,
        lower(c.first_name || '.' || c.last_name || '@' || (r.website)),
        r.phone,
        '+' || (10 + c.seq)::text || ' 7' || lpad((c.seq * 1379 % 9999)::text, 4, '0') || ' 555' || lpad(c.seq::text, 3, '0'),
        r.city, r.country,
        'Seed — test book v1', c.role, c.is_primary,
        case when c.seq = 1 then null else v_boss end,
        format('[TEST] Seeded contact for %s.', r.name),
        jsonb_build_object('seed', 'test_book_v1')
      );
      if c.seq = 1 then
        select id into v_boss from customer_account_contacts
         where account_id = v_acct and is_primary limit 1;
      end if;
      n_contact := n_contact + 1;
    end loop;
  end loop;

  raise notice '508: seeded % test accounts and % contacts', n_acct, n_contact;
end $seed$;

-- ── PROOF ────────────────────────────────────────────────────────────────────
do $a$
declare
  v_tenant uuid; n int; n_linked int; n_primary_bad int;
begin
  select t.id into v_tenant from tenants t where t.slug = 'outsourcetel-hq';

  select count(*) into n from customer_accounts
   where tenant_id = v_tenant and attributes->>'seed' = 'test_book_v1';
  if n <> 10 then raise exception '508: expected 10 test accounts, found %', n; end if;

  select count(*) into n from customer_account_contacts
   where tenant_id = v_tenant and attributes->>'seed' = 'test_book_v1';
  if n <> 40 then raise exception '508: expected 40 test contacts, found %', n; end if;

  -- Every account has exactly one primary contact, or an employee choosing a
  -- recipient would be choosing arbitrarily.
  select count(*) into n_primary_bad from (
    select account_id, count(*) filter (where is_primary) as p
      from customer_account_contacts
     where tenant_id = v_tenant and attributes->>'seed' = 'test_book_v1'
     group by account_id having count(*) filter (where is_primary) <> 1
  ) x;
  if n_primary_bad > 0 then
    raise exception '508: % accounts do not have exactly one primary contact', n_primary_bad;
  end if;

  -- MIGRATION 506 UNDER TEST: three accounts share a name with an existing
  -- agreement, and the trigger should have linked them with nobody calling it.
  select count(*) into n_linked from commercial_agreements
   where tenant_id = v_tenant and account_id is not null;
  if n_linked < 3 then
    raise exception '508: only % of 3 agreements found their customer — mig 506 is inert', n_linked;
  end if;

  -- ...and the continuity cases must agree about who the customer is.
  select count(*) into n from continuity_cases
   where tenant_id = v_tenant and account_id is not null;
  if n = 0 then
    raise exception '508: agreements linked but no continuity case learned its customer';
  end if;

  -- The spread must actually cross the watcher thresholds, or nothing is
  -- exercised and this book is decoration.
  select count(*) into n from customer_accounts
   where tenant_id = v_tenant and attributes->>'seed' = 'test_book_v1'
     and (status = 'at_risk' or health_score < 60);
  if n = 0 then
    raise exception '508: no account crosses a watcher threshold — the chain would never fire';
  end if;

  raise notice '508: 10 accounts, 40 contacts, % agreements linked automatically, % accounts below a watcher line',
    n_linked, n;
end $a$;

-- TEARDOWN, when this book has served its purpose:
--   delete from customer_accounts
--    where tenant_id = (select id from tenants where slug = 'outsourcetel-hq')
--      and attributes->>'seed' = 'test_book_v1';
--   (contacts cascade; agreements keep their account_id, so NULL those first if
--    you want the contracts unlinked as well.)
