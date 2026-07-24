-- 314_metering_deferred_settlement.sql
-- ============================================================================
-- METERING INTEGRITY — stop billing for answers that weren't actually good.
--
-- THE PROBLEM (top commercial-integrity risk): record_billable_outcome (mig 181)
-- bills a 'resolution' the MOMENT an answer is delivered. A wrong / thumbs-down /
-- later-reopened answer that never escalates STILL bills as a paid resolution —
-- an invoice a governance-first buyer's diligence would tear apart.
--
-- THE FIX (deferred settlement): a resolution is recorded PENDING at answer time
-- and only CONFIRMED billable after a settlement window (default 72h) IF no
-- negative signal appeared — no escalation, no thumbs-down (csat_score = -1), no
-- conversation hand-off to a human, and no customer writing back after the answer
-- (a reopen). Any negative signal settles it 'unbilled' → it never bills.
--
-- SAFETY: the entire behavior change is behind an OFF kill-switch
-- ('metering_deferred_settlement_enabled'). Flag OFF ⇒ byte-behavior of mig 181
-- (born confirmed/billable) ⇒ NO published metering number moves on apply. Legacy
-- rows are frozen (settled_at = occurred_at, existing billable intact). Flipping
-- the flag is a founder billing-policy decision. GLOBAL.
--
-- Reproduces record_billable_outcome VERBATIM from mig 181:347-382; changes ONLY
-- the status/deferral branches + the insert column list. get_benchmark_report and
-- get_outcome_metering are UNCHANGED (they already filter on `billable`, which is
-- only ever true post-settlement, so pending rows are correctly excluded).
-- ============================================================================

-- Part A — schema (idempotent; existing rows preserved) -----------------------
ALTER TABLE billable_outcomes
  ADD COLUMN IF NOT EXISTS status       text NOT NULL DEFAULT 'confirmed',
  ADD COLUMN IF NOT EXISTS settle_after timestamptz,
  ADD COLUMN IF NOT EXISTS settled_at   timestamptz;
ALTER TABLE billable_outcomes DROP CONSTRAINT IF EXISTS billable_outcomes_status_check;
ALTER TABLE billable_outcomes ADD CONSTRAINT billable_outcomes_status_check
  CHECK (status IN ('pending','confirmed','unbilled','free'));
-- Re-derive status for legacy rows from the billable flags (source of truth):
UPDATE billable_outcomes SET status = CASE
    WHEN kind = 'escalation'              THEN 'free'
    WHEN kind = 'resolution' AND billable THEN 'confirmed'
    ELSE                                       'unbilled'
  END
  WHERE settled_at IS NULL;
UPDATE billable_outcomes SET settled_at = coalesce(settled_at, occurred_at)
  WHERE settled_at IS NULL;   -- legacy rows are already settled — freeze them
CREATE INDEX IF NOT EXISTS billable_outcomes_pending_idx
  ON billable_outcomes (settle_after) WHERE kind = 'resolution' AND status = 'pending';

-- Part B — record_billable_outcome (mig 181 verbatim + deferral branches) ------
CREATE OR REPLACE FUNCTION public.record_billable_outcome(
  p_tenant_id uuid, p_de_id uuid, p_conversation_id uuid, p_kind text, p_source text default 'chat'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
declare
  v_price integer := 0; v_billable boolean := false; v_id uuid;
  v_status text := 'free'; v_settle_after timestamptz := null;
  v_deferred boolean := (select value = 'true' from platform_config where key = 'metering_deferred_settlement_enabled');
  v_window numeric := coalesce((select value from platform_config where key = 'metering_settle_window_hours')::numeric, 72);
begin
  if p_kind not in ('resolution', 'escalation') then raise exception 'kind must be resolution|escalation'; end if;
  if p_conversation_id is null then return jsonb_build_object('recorded', false, 'reason', 'no_conversation'); end if;
  v_deferred := coalesce(v_deferred, false);

  if p_kind = 'resolution' then
    select coalesce((select price_per_resolution_cents from tenant_outcome_pricing where tenant_id = p_tenant_id), 99)
      into v_price;
    if exists (select 1 from billable_outcomes where conversation_id = p_conversation_id and kind = 'escalation') then
      v_billable := false; v_price := 0; v_status := 'unbilled';           -- escalated first: never bills
    elsif v_deferred then
      v_billable := false; v_status := 'pending'; v_settle_after := now() + make_interval(hours => v_window);
    else
      v_billable := true;  v_status := 'confirmed';                        -- LEGACY bill-on-answer (flag OFF)
    end if;
  else
    -- Escalation after a resolution: reverse it. MUST catch PENDING too, so the
    -- settle cron can never later confirm a conversation the human took over.
    update billable_outcomes set billable = false, unit_price_cents = 0, status = 'unbilled', settled_at = now()
     where conversation_id = p_conversation_id and kind = 'resolution' and status in ('pending','confirmed');
    v_billable := false; v_status := 'free';
  end if;

  insert into billable_outcomes (tenant_id, de_id, conversation_id, kind, source, billable, unit_price_cents, status, settle_after, settled_at)
  values (p_tenant_id, p_de_id, p_conversation_id, p_kind,
          case when p_source in ('chat','widget','a2a','orchestrate') then p_source else 'chat' end,
          v_billable, v_price, v_status, v_settle_after,
          case when v_status in ('confirmed','free','unbilled') then now() else null end)
  on conflict do nothing
  returning id into v_id;

  return jsonb_build_object('recorded', v_id is not null, 'billable', v_billable, 'unit_price_cents', v_price, 'status', v_status);
end;
$function$;
revoke all on function public.record_billable_outcome(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.record_billable_outcome(uuid, uuid, uuid, text, text) to service_role;

-- Part C — settle function (pure SQL; idempotent; tenant-agnostic) -------------
-- Confirms a pending resolution as billable only if NO negative signal appeared
-- by settle_after. Negative = an escalation on the conversation, a thumbs-down
-- (csat_score = -1), the conversation handed to a human (status='human_owned'),
-- or the customer writing back after the answer (a role='user' message after the
-- resolution). status values verified live: ai_handling / human_owned / resolved.
CREATE OR REPLACE FUNCTION public.settle_billable_outcomes() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
declare v_n integer;
begin
  with due as (
    select r.id,
      (exists (select 1 from billable_outcomes e where e.conversation_id = r.conversation_id and e.kind='escalation')
       or exists (select 1 from de_conversations c where c.id = r.conversation_id
                    and (c.csat_score = -1 or c.status = 'human_owned'))
       or exists (select 1 from de_messages m where m.conversation_id = r.conversation_id
                    and m.role = 'user' and m.created_at > r.occurred_at)   -- customer wrote back = not resolved
      ) as reversed
    from billable_outcomes r
    where r.kind = 'resolution' and r.status = 'pending' and r.settle_after <= now()
  )
  update billable_outcomes b set
    status           = case when d.reversed then 'unbilled' else 'confirmed' end,
    billable         = not d.reversed,
    unit_price_cents = case when d.reversed then 0 else b.unit_price_cents end,
    settled_at       = now()
  from due d where b.id = d.id;
  get diagnostics v_n = row_count;
  return v_n;
end $function$;
revoke all on function public.settle_billable_outcomes() from public, anon, authenticated;
grant execute on function public.settle_billable_outcomes() to service_role;

-- Part D — cron (plain SQL call; only ever acts on 'pending' rows) -------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'settle-billable-outcomes') THEN
    PERFORM cron.unschedule('settle-billable-outcomes');
  END IF;
  PERFORM cron.schedule('settle-billable-outcomes', '*/15 * * * *', 'select public.settle_billable_outcomes()');
END $$;

-- Part E — kill-switch, defaulted OFF (flag flip is a founder billing decision) -
INSERT INTO platform_config (key, value) VALUES ('metering_deferred_settlement_enabled','false')
  ON CONFLICT (key) DO NOTHING;
INSERT INTO platform_config (key, value) VALUES ('metering_settle_window_hours','72')
  ON CONFLICT (key) DO NOTHING;

NOTIFY pgrst, 'reload schema';
