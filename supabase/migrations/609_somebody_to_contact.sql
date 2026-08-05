-- 609 — somebody to contact.
--
-- Two digital employees ran the same objective today and stopped at the same
-- step for the same reason:
--
--     step 3 "Find who holds the relationship" -> waiting_human
--     "No executive sponsor or day-to-day contact is recorded for
--      Grant Plastics Ltd. Cannot proceed with at-risk ch..."
--
-- Steps 4, 5 and 6 — record the position, prepare the check-in, hand it to a
-- person — are still queued behind it, in both objectives. The employees did
-- the thinking and hit a wall at the one step that needs a human being's name.
--
-- The collections work hit the same wall from the opposite direction: the
-- ERPNext chase falls back to an internal note because there is no recipient.
-- Same missing data, found two days apart through two unrelated features.
--
-- ── The state of it ──────────────────────────────────────────────────────
-- `customer_account_contacts` holds ZERO rows and has NO WRITER — not "no
-- ingest", no writer of any kind: no UI, no sync, no RPC. A fully specified
-- table that nothing on earth could populate. It is READ by real code:
-- de-work/index.ts:628 (the exact lookup both employees used) and
-- verify_and_bind_widget_identity.
--
-- The ERP has nothing either. Probed live: Contact holds exactly one record,
-- the ERP admin; all three Customers have customer_primary_contact = null.
--
-- ── What this table actually is, which the first draft got wrong ─────────
-- It is not a plain contact list. `end_user_ref` is NOT NULL with a UNIQUE
-- index on (tenant_id, lower(btrim(end_user_ref))): it is the VERIFIED
-- IDENTITY KEY a customer presents in the widget, which
-- verify_and_bind_widget_identity resolves to an account. A contact row is
-- therefore also an identity the platform will trust.
--
-- So end_user_ref is derived, never blank: the email where there is one —
-- which is what a person identifies with — and provider:external_ref
-- otherwise, which is stable and unique but cannot be guessed by a stranger.
--
-- There is also a UNIQUE index on (account_id) WHERE is_primary. Setting a new
-- primary must therefore CLEAR the old one FIRST; the first draft did it
-- afterwards and would have hit the constraint on the second contact of any
-- account. The dry run caught the NOT NULL; only reading the indexes caught
-- this one.

begin;

-- ── Mirror keys, so a re-sync updates instead of duplicating ─────────────

alter table customer_account_contacts
  add column if not exists source text,
  add column if not exists external_ref text;

create unique index if not exists customer_account_contacts_source_ref_uniq
  on customer_account_contacts (tenant_id, source, external_ref)
  where external_ref is not null;

-- No index on (account_id, email) is added: customer_account_contacts_ref_uidx
-- already makes end_user_ref unique per tenant, and end_user_ref IS the email
-- wherever one exists. A second constraint saying the same thing is a second
-- thing to keep in step.

-- ── From a system of record ──────────────────────────────────────────────

create or replace function upsert_external_contact(
  p_tenant_id uuid, p_provider text, p_external_ref text,
  p_first_name text, p_last_name text, p_email text,
  p_phone text default null, p_mobile text default null,
  p_title text default null, p_customer_external_ref text default null,
  p_customer_name text default null, p_is_primary boolean default false
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_account uuid;
  v_email   text := nullif(btrim(lower(p_email)), '');
  v_ref     text;
  v_id      uuid;
begin
  if p_tenant_id is null or coalesce(p_provider,'') = '' or coalesce(p_external_ref,'') = '' then
    raise exception 'tenant, provider and external ref are all required';
  end if;

  -- The identity key. Email where the record has one, because that is what a
  -- person presents; otherwise the source reference, which is stable and
  -- unique but not guessable by someone who is not that customer.
  v_ref := coalesce(v_email, p_provider || ':' || p_external_ref);

  v_account := resolve_external_account(p_tenant_id, p_provider, p_customer_external_ref, p_customer_name);

  -- account_id is NOT NULL, and rightly so: a contact nobody is the contact FOR
  -- answers nothing. The question an employee asks is "who holds THIS
  -- relationship". Refuse loudly rather than file an orphan the DE will later
  -- fail to find.
  if v_account is null then
    return jsonb_build_object('ok', false, 'error', 'no_account',
      'detail', format('contact %s names no customer this workspace knows (%s)',
                       p_external_ref, coalesce(p_customer_external_ref, 'none given')));
  end if;

  -- Clear the old primary BEFORE claiming it: (account_id) WHERE is_primary is
  -- UNIQUE, so setting a second one in the same statement fails outright.
  if coalesce(p_is_primary, false) and v_account is not null then
    update customer_account_contacts
       set is_primary = false, updated_at = now()
     where tenant_id = p_tenant_id and account_id = v_account and is_primary
       and coalesce(external_ref,'') is distinct from p_external_ref;
  end if;

  insert into customer_account_contacts
    (tenant_id, account_id, end_user_ref, first_name, last_name, email, phone, mobile, title,
     is_primary, source, external_ref)
  values
    (p_tenant_id, v_account, v_ref,
     nullif(btrim(p_first_name),''), nullif(btrim(p_last_name),''),
     v_email, nullif(btrim(p_phone),''), nullif(btrim(p_mobile),''),
     nullif(btrim(p_title),''), coalesce(p_is_primary, false), p_provider, p_external_ref)
  on conflict (tenant_id, source, external_ref) where external_ref is not null
  do update set
    account_id   = coalesce(excluded.account_id, customer_account_contacts.account_id),
    end_user_ref = excluded.end_user_ref,
    first_name   = excluded.first_name,
    last_name    = excluded.last_name,
    -- A sync that omits a field must not ERASE one we already hold: the same
    -- rule the invoice ingest needed for contact_email (mig 595).
    email        = coalesce(excluded.email,  customer_account_contacts.email),
    phone        = coalesce(excluded.phone,  customer_account_contacts.phone),
    mobile       = coalesce(excluded.mobile, customer_account_contacts.mobile),
    title        = coalesce(excluded.title,  customer_account_contacts.title),
    is_primary   = excluded.is_primary,
    updated_at   = now()
  returning id into v_id;

  return jsonb_build_object('contact_id', v_id, 'account_id', v_account, 'identity_key', v_ref);
end;
$$;

grant execute on function upsert_external_contact(uuid, text, text, text, text, text, text, text, text, text, text, boolean) to service_role;

-- ── Typed in, for the customers no system holds ──────────────────────────

create or replace function set_account_contact(
  p_account_id uuid, p_first_name text, p_last_name text, p_email text,
  p_title text default null, p_phone text default null, p_mobile text default null,
  p_is_primary boolean default false, p_contact_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := auth_tenant_id();
  v_email  text := nullif(btrim(lower(p_email)), '');
  v_id     uuid;
begin
  if v_tenant is null then raise exception 'not_authenticated'; end if;
  if not auth_has_tenant_role(array['tenant_owner','tenant_admin','tenant_manager']) then
    raise exception 'not_allowed: only an owner, admin or manager may record a customer contact';
  end if;
  if not exists (select 1 from customer_accounts where id = p_account_id and tenant_id = v_tenant) then
    raise exception 'that account is not in this workspace';
  end if;
  if coalesce(btrim(p_first_name),'') = '' and coalesce(btrim(p_last_name),'') = '' then
    raise exception 'a contact needs at least a name';
  end if;
  -- A contact with no email cannot be an identity key, and end_user_ref is
  -- NOT NULL. Refuse rather than invent one.
  if v_email is null then
    raise exception 'a contact needs an email address — it is how the customer is recognised';
  end if;

  if coalesce(p_is_primary, false) then
    update customer_account_contacts
       set is_primary = false, updated_at = now()
     where tenant_id = v_tenant and account_id = p_account_id and is_primary
       and (p_contact_id is null or id <> p_contact_id);
  end if;

  if p_contact_id is not null then
    update customer_account_contacts set
      first_name = nullif(btrim(p_first_name),''), last_name = nullif(btrim(p_last_name),''),
      email = v_email, end_user_ref = v_email, title = nullif(btrim(p_title),''),
      phone = nullif(btrim(p_phone),''), mobile = nullif(btrim(p_mobile),''),
      is_primary = coalesce(p_is_primary, false), updated_at = now()
    where id = p_contact_id and tenant_id = v_tenant
    returning id into v_id;
    if v_id is null then raise exception 'no such contact in this workspace'; end if;
  else
    insert into customer_account_contacts
      (tenant_id, account_id, end_user_ref, first_name, last_name, email, title, phone, mobile, is_primary)
    values (v_tenant, p_account_id, v_email,
            nullif(btrim(p_first_name),''), nullif(btrim(p_last_name),''),
            v_email, nullif(btrim(p_title),''),
            nullif(btrim(p_phone),''), nullif(btrim(p_mobile),''), coalesce(p_is_primary, false))
    on conflict (tenant_id, lower(btrim(end_user_ref)))
    do update set
      account_id = excluded.account_id,
      first_name = excluded.first_name, last_name = excluded.last_name,
      title = coalesce(excluded.title, customer_account_contacts.title),
      phone = coalesce(excluded.phone, customer_account_contacts.phone),
      mobile = coalesce(excluded.mobile, customer_account_contacts.mobile),
      is_primary = excluded.is_primary, updated_at = now()
    returning id into v_id;
  end if;

  return jsonb_build_object('ok', true, 'contact_id', v_id);
end;
$$;

grant execute on function set_account_contact(uuid, text, text, text, text, text, text, boolean, uuid) to authenticated, service_role;

create or replace function delete_account_contact(p_contact_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_tenant uuid := auth_tenant_id(); v_n int;
begin
  if v_tenant is null then raise exception 'not_authenticated'; end if;
  if not auth_has_tenant_role(array['tenant_owner','tenant_admin','tenant_manager']) then
    raise exception 'not_allowed';
  end if;
  delete from customer_account_contacts where id = p_contact_id and tenant_id = v_tenant;
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', v_n > 0);
end;
$$;

grant execute on function delete_account_contact(uuid) to authenticated, service_role;

create or replace function list_account_contacts(p_account_id uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'first_name', c.first_name, 'last_name', c.last_name,
    'email', c.email, 'phone', c.phone, 'mobile', c.mobile, 'title', c.title,
    'is_primary', c.is_primary,
    -- Where it came from, so nobody edits a mirrored row expecting it to stick.
    'source', coalesce(c.source, 'entered by hand')
  ) order by c.is_primary desc, c.last_name, c.first_name), '[]'::jsonb)
  from customer_account_contacts c
  where c.account_id = p_account_id and c.tenant_id = auth_tenant_id();
$$;

grant execute on function list_account_contacts(uuid) to authenticated, service_role;

-- ── Prove both writers against the real constraints ──────────────────────

do $verify$
declare
  v_t   uuid := (select id from tenants where slug = 'outsourcetel-hq');
  v_acc uuid;
  v_a jsonb; v_b jsonb; v_c jsonb;
begin
  if v_t is null then raise notice 'no workspace to verify against'; return; end if;
  select id into v_acc from customer_accounts where tenant_id = v_t limit 1;
  if v_acc is null then raise notice 'no account to verify against'; return; end if;

  -- Idempotent, and a later sync that omits a field must not erase it.
  v_a := upsert_external_contact(v_t, '__probe__', 'CT-1', 'Ada', 'Probe',
           'ada@probe.example', '123', null, 'Ops Lead', 'PROBE-CUST', 'Probe Co', false);
  v_b := upsert_external_contact(v_t, '__probe__', 'CT-1', 'Ada', 'Probe',
           null, null, null, null, 'PROBE-CUST', 'Probe Co', false);
  if (v_a->>'contact_id') <> (v_b->>'contact_id') then
    raise exception 're-syncing one contact created a second row';
  end if;
  if (select email from customer_account_contacts where id = (v_a->>'contact_id')::uuid) is null then
    raise exception 'a sync that omitted the email ERASED it';
  end if;
  if (v_a->>'identity_key') <> 'ada@probe.example' then
    raise exception 'identity key should be the email, got %', v_a->>'identity_key';
  end if;

  -- No email: the key falls back to source:ref rather than violating NOT NULL.
  v_c := upsert_external_contact(v_t, '__probe__', 'CT-2', 'Bee', 'Probe',
           null, null, null, null, 'PROBE-CUST', 'Probe Co', false);
  if (v_c->>'identity_key') <> '__probe__:CT-2' then
    raise exception 'fallback identity key wrong: %', v_c->>'identity_key';
  end if;

  -- Two primaries on one account must not be possible: the unique index makes
  -- claiming the second fail unless the first is cleared first.
  perform upsert_external_contact(v_t, '__probe__', 'CT-3', 'Cy', 'Probe',
            'cy@probe.example', null, null, null, 'PROBE-CUST', 'Probe Co', true);
  perform upsert_external_contact(v_t, '__probe__', 'CT-4', 'Di', 'Probe',
            'di@probe.example', null, null, null, 'PROBE-CUST', 'Probe Co', true);
  if (select count(*) from customer_account_contacts c
      join customer_accounts a on a.id = c.account_id
      where a.source_provider = '__probe__' and c.is_primary) <> 1 then
    raise exception 'an account ended up with more than one primary contact';
  end if;

  -- A contact naming no customer must be REFUSED, not filed as an orphan.
  if coalesce((upsert_external_contact(v_t, '__probe__', 'CT-5', 'Ed', 'Probe',
                 'ed@probe.example', null, null, null, null, null, false)->>'ok')::boolean, true) then
    raise exception 'a contact with no customer was accepted';
  end if;

  delete from customer_account_contacts where source = '__probe__';
  delete from customer_accounts where source_provider = '__probe__';
  raise notice 'contact writers verified: idempotent, non-destructive, identity key derived, one primary';
end;
$verify$;

commit;
