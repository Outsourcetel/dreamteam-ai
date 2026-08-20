-- 812_dunning_will_not_route_through_a_dead_connector.sql
-- ==========================================================================
-- Second reader of the marker that lies, and this one has money on it.
--
-- dunning_connector_for picks the connector that will carry out a collections
-- action -- "Send a payment reminder", "Send a final notice", "Flag for
-- collections", "Book a payment against an invoice". It selects on
-- `status = 'connected'`, the stored marker mig 774 identified as stale and
-- which still reads connected for Outsourcetel's ERPNext after 8,750
-- consecutive http_402 failures.
--
-- MEASURED before writing this: for that workspace the function resolves a
-- connector for TWELVE erp_financials action definitions, every one of them
-- the dead integration. dunning-sweep-daily (07:10) is active and still
-- creating rows -- the most recent ERP action was raised TODAY and sits at
-- human_gated_trust, waiting for a person to approve a payment reminder that
-- cannot be delivered.
--
-- The last four that actually executed were 2026-08-04/05 -- BEFORE the
-- connector died on the 11th -- and all returned {"ok": true, "status": 200}.
-- So this has not burned anyone yet. It is loaded, not fired.
--
-- ── WHY RETURNING NULL IS THE RIGHT FIX, AND SAFE ─────────────────────────
-- run_dunning_sweep ALREADY handles a null connector, and its own comment
-- says why in as many words:
--
--   "KNOWING WHICH VERB IS NOT KNOWING WHICH SYSTEM. Without this, the row is
--    raised with a null connector and the approved re-entry path returns
--    `connector_id_required` -- silently, after the human has been told the
--    work is done."
--
-- It counts the skip as `no_connector` and reports it in the sweep detail. So
-- a dead connector now produces a visible "skipped: no_connector" rather than
-- a queued reminder nobody can send. The landing zone was already built; the
-- selector just never asked whether the connector was alive.
--
-- ⚠ THE FAILURE MODE THIS PREVENTS is not a crash. It is a person approving
-- "Send a final notice" to a customer, being told it went, and it not having
-- gone. On a workspace whose employee is currently reporting $431k
-- outstanding, that is the expensive kind of quiet.
--
-- Same one-line shape as mig 810 gave the third dispatcher. Deliberately not
-- a new predicate: one breaker, asked by everyone who needs it.
-- ==========================================================================

begin;

create or replace function public.dunning_connector_for(p_tenant_id uuid, p_action_definition_id uuid)
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $function$
  -- The connector that carries out THIS definition for THIS tenant: same
  -- category, same provider, connected. Exactly one, or nothing — a second
  -- candidate collapses the whole thing to null rather than choosing a
  -- company's ERP by row order. (`array_agg(…)[1]` rather than `min()`:
  -- there is no `min(uuid)` in Postgres, and under `count(*) = 1` the array
  -- holds exactly one element, so the subscript is not a choice.)
  select case when count(*) = 1 then (array_agg(c.id))[1] end
  from connectors c
  join action_definitions ad on ad.id = p_action_definition_id
  where c.tenant_id = p_tenant_id
    and c.status    = 'connected'
    -- ⛔ AND ALIVE. `status` is a stored marker that is not written on
    -- failure; mig 774 built this breaker precisely because it keeps reading
    -- 'connected' through thousands of failures. A collections action routed
    -- to a dead connector is not a delayed send, it is a send the human is
    -- told happened. run_dunning_sweep already skips a null connector and
    -- reports `no_connector`, which is the honest outcome.
    and not public.connector_circuit_open(c.consecutive_failures, c.last_error_at)
    and c.category  = ad.category
    and c.provider  = ad.provider;
$function$;

revoke all on function public.dunning_connector_for(uuid, uuid) from public;
revoke all on function public.dunning_connector_for(uuid, uuid) from anon;

-- ── proof ─────────────────────────────────────────────────────────────────
do $verify$
declare
  v_dead_conn uuid; v_tenant uuid; v_ad uuid; v_resolved uuid;
  v_alive_before int; v_alive_after int;
begin
  -- The dead one: 8,750 failures, still marked connected.
  select c.id, c.tenant_id into v_dead_conn, v_tenant
    from connectors c
   where c.provider = 'erpnext' and c.status = 'connected'
     and public.connector_circuit_open(c.consecutive_failures, c.last_error_at)
   order by c.consecutive_failures desc
   limit 1;

  if v_dead_conn is null then
    raise exception 'VERIFY FAILED: no open-circuit connector exists, so the assertion below would prove nothing';
  end if;

  select ad.id into v_ad
    from action_definitions ad
   where ad.provider = 'erpnext' and ad.category = 'erp_financials'
   limit 1;
  if v_ad is null then
    raise exception 'VERIFY FAILED: no erpnext action definition to resolve against';
  end if;

  -- (a) ⛔ THE POINT. A dead connector must no longer be resolvable.
  v_resolved := public.dunning_connector_for(v_tenant, v_ad);
  if v_resolved is not null then
    raise exception 'VERIFY FAILED: dunning still resolved a connector whose circuit is OPEN (%)', v_resolved;
  end if;

  -- (b) ...and this must not have simply broken dunning everywhere. A
  --     selector that returns null for EVERYTHING would pass (a) and silently
  --     stop collections for every workspace — which is the failure that
  --     looks most like a fix.
  select count(*) into v_alive_before
    from connectors c
   where c.status = 'connected'
     and not public.connector_circuit_open(c.consecutive_failures, c.last_error_at);
  if v_alive_before = 0 then
    raise notice 'VERIFY: no healthy connector exists anywhere, so (b) cannot discriminate today';
  else
    select count(*) into v_alive_after
      from connectors c
      join action_definitions ad2 on ad2.category = c.category and ad2.provider = c.provider
     where c.status = 'connected'
       and not public.connector_circuit_open(c.consecutive_failures, c.last_error_at)
       and public.dunning_connector_for(c.tenant_id, ad2.id) is not null;
    if v_alive_after = 0 then
      raise exception 'VERIFY FAILED: % healthy connector(s) exist but dunning resolves none — the selector now refuses everything', v_alive_before;
    end if;
  end if;
end
$verify$;

commit;
