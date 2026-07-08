-- ============================================================
-- Migration 098: fixes a bug in 097's own cleanup. 097 soft-disabled
-- each duplicate DE but left its `catalog_id` (e.g. 'starter_finance_de')
-- in place — so provision_starter_de_internal's FIRST lookup (by
-- catalog_id) still found the disabled duplicate rather than the
-- canonical DE, and reactivated it. Confirmed live: a same-session
-- idempotency test call for Acme Telecom's finance_de flag reactivated
-- e6ceba70-... (status back to 'active') moments after 097 disabled it.
--
-- Fix: swap catalog_id onto the canonical DE and clear it from the
-- disabled duplicate, then re-disable the duplicate. This makes the
-- catalog_id lookup find the canonical DE on any future provisioning
-- call, which is what the whole point of catalog_id is for.
-- ============================================================
do $$
declare
  v_pair record;
begin
  for v_pair in
    select
      canonical.id as canonical_id, dup.id as dup_id, dup.catalog_id as dup_catalog_id
    from digital_employees dup
    join digital_employees canonical
      on canonical.tenant_id = dup.tenant_id
     and canonical.name = dup.name
     and canonical.id <> dup.id
    where dup.catalog_id in ('starter_account_de', 'starter_finance_de')
      and 'duplicate_merged' = any(dup.tags)
      and canonical.catalog_id is null
  loop
    update digital_employees set catalog_id = v_pair.dup_catalog_id where id = v_pair.canonical_id;
    update digital_employees
    set catalog_id = null, status = 'disabled', lifecycle_status = 'paused'
    where id = v_pair.dup_id;
  end loop;
end $$;
