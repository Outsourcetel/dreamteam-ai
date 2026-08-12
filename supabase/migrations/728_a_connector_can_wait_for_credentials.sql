-- 728 — a connector can wait for credentials
--
-- connectors.status knew three things: connected, error, disconnected. There
-- was no word for "we have prepared this for you and are waiting on you",
-- which is exactly the state the discovery interview leaves a system in: row
-- created, named, categorised, base URL set, employee access bound — and no
-- credentials, because those are the customer's to enter and nobody else's.
--
-- Widening only. No existing row changes meaning; the three original values
-- keep their exact semantics.

begin;

alter table public.connectors drop constraint if exists connectors_status_check;
alter table public.connectors add constraint connectors_status_check
  check (status in ('connected', 'error', 'disconnected', 'pending_credentials'));

do $$
declare v_bad int; v_tenant uuid;
begin
  -- Widening must not have stranded an existing row.
  select count(*) into v_bad from public.connectors
   where status not in ('connected','error','disconnected','pending_credentials');
  if v_bad > 0 then raise exception '728: % connector rows hold a status the new CHECK rejects', v_bad; end if;

  -- And it must not have become permissive. Prove the fence by trying to cross
  -- it — with a REAL tenant_id, so that the CHECK is what refuses us.
  --
  -- ⚠ An earlier draft used a zero UUID and caught foreign_key_violation as
  -- "also fine". That is a check that cannot fail: the FK refuses the row
  -- before the CHECK is ever the reason, so the probe reports success whether
  -- or not the CHECK exists. Use a tenant that exists; catch ONLY
  -- check_violation. The insert never commits — either the CHECK rejects it,
  -- or we raise and the whole migration rolls back.
  select id into v_tenant from public.tenants limit 1;
  if v_tenant is null then
    raise exception '728: no tenant to probe with — cannot prove the CHECK holds';
  end if;

  begin
    -- base_url is NOT NULL with no default. Omitting it (as an earlier draft
    -- of this probe did) raises not_null_violation before the status CHECK is
    -- ever reached — the same "check that cannot fail" trap as the zero-UUID
    -- one above, just tripping over a different constraint on the way in.
    -- '' satisfies the NOT NULL, and connectors_base_url_safe_check passes it
    -- trivially via its own COALESCE(base_url,'')='' branch, so this row
    -- reaches exactly one CHECK: the one under test.
    insert into public.connectors (tenant_id, provider, display_name, base_url, status, category)
    values (v_tenant, 'mcp', 'CHECK probe — never commits', '', 'not_a_real_status', 'other');
    raise exception '728: the status CHECK accepted a value it should refuse';
  exception
    when check_violation then null;   -- the only acceptable outcome
  end;
end $$;

commit;
