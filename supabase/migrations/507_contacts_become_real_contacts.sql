-- 507_contacts_become_real_contacts.sql
-- ============================================================================
-- customer_account_contacts was a stub: id, tenant_id, account_id and a bare
-- end_user_ref text. No name, no title, no email, no phone — and NO WRITER
-- anywhere in the codebase. Nothing has ever put a row in it.
--
-- That absence has a cost already on the record. docs/38 traced the renewal
-- outreach failure to exactly this: the employee could draft a notice but had
-- nobody to send it to, and said so — "Who on the Meridian Group team should
-- receive this outreach?" A contact store that cannot hold a person's name is
-- the reason that question had no answer.
--
-- Mapped to the standard Salesforce Contact shape, so what goes in here lines
-- up with what a CRM would hand over later rather than needing translation:
--   Salutation / First / Last name, Title, Department, Reports To,
--   Email, Phone, Mobile, Mailing city+country, Lead Source, Description
-- plus two fields a workforce needs that Salesforce puts on the junction:
--   role      — what this person is FOR (decision maker, billing, technical…)
--   is_primary — who to contact first, enforced as at most one per account
--
-- end_user_ref is kept and stays NOT NULL: it is the existing join key to
-- conversation history, and dropping it would break that link. New rows use the
-- email as the reference, which is what a support conversation keys on anyway.
-- ============================================================================

alter table public.customer_account_contacts add column if not exists salutation text;
alter table public.customer_account_contacts add column if not exists first_name text;
alter table public.customer_account_contacts add column if not exists last_name text;
alter table public.customer_account_contacts add column if not exists title text;
alter table public.customer_account_contacts add column if not exists department text;
alter table public.customer_account_contacts add column if not exists email text;
alter table public.customer_account_contacts add column if not exists phone text;
alter table public.customer_account_contacts add column if not exists mobile text;
alter table public.customer_account_contacts add column if not exists mailing_city text;
alter table public.customer_account_contacts add column if not exists mailing_country text;
alter table public.customer_account_contacts add column if not exists lead_source text;
alter table public.customer_account_contacts add column if not exists role text;
alter table public.customer_account_contacts add column if not exists is_primary boolean not null default false;
alter table public.customer_account_contacts add column if not exists reports_to uuid;
alter table public.customer_account_contacts add column if not exists notes text;
alter table public.customer_account_contacts add column if not exists attributes jsonb not null default '{}'::jsonb;
alter table public.customer_account_contacts add column if not exists updated_at timestamptz not null default now();

do $c$
begin
  if not exists (select 1 from pg_constraint where conname = 'customer_account_contacts_role_check') then
    alter table public.customer_account_contacts add constraint customer_account_contacts_role_check
      check (role is null or role = any (array[
        'decision_maker', 'economic_buyer', 'billing', 'technical', 'exec_sponsor',
        'day_to_day', 'procurement', 'legal', 'other']));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'customer_account_contacts_reports_to_fkey') then
    alter table public.customer_account_contacts add constraint customer_account_contacts_reports_to_fkey
      foreign key (reports_to) references public.customer_account_contacts(id) on delete set null;
  end if;
end $c$;

-- "Who do I contact first" must have exactly one answer, or an employee
-- choosing a recipient is choosing arbitrarily.
create unique index if not exists customer_account_contacts_primary_uniq
  on public.customer_account_contacts (account_id)
  where is_primary;

create index if not exists customer_account_contacts_account_idx
  on public.customer_account_contacts (account_id);
create index if not exists customer_account_contacts_email_idx
  on public.customer_account_contacts (tenant_id, lower(email))
  where email is not null;

comment on column public.customer_account_contacts.role is
  'What this person is FOR on this account. An employee drafting outreach picks the recipient by role, not by guessing from a job title.';
comment on column public.customer_account_contacts.is_primary is
  'At most one per account, enforced by a partial unique index. Who to contact when nothing more specific applies.';

notify pgrst, 'reload schema';

do $a$
declare n int;
begin
  select count(*) into n from information_schema.columns
   where table_schema='public' and table_name='customer_account_contacts'
     and column_name in ('first_name','last_name','title','email','phone','role','is_primary');
  if n <> 7 then
    raise exception '507: only % of the 7 core contact fields landed', n;
  end if;
  -- end_user_ref must SURVIVE — it is the join to conversation history.
  if not exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='customer_account_contacts'
                    and column_name='end_user_ref' and is_nullable='NO') then
    raise exception '507: end_user_ref was dropped or loosened — the conversation link would break';
  end if;
  if not exists (select 1 from pg_indexes
                  where schemaname='public' and indexname='customer_account_contacts_primary_uniq') then
    raise exception '507: two contacts could both be primary on one account';
  end if;
  raise notice '507: contacts can hold a person';
end $a$;
