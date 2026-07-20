-- 202: AI budget — usable default + early-warning alerts
--
-- WHY
-- monthly_token_budget defaulted to 100,000 for every tenant, existing and new.
-- A grounded support answer costs ~3-6k tokens (persona + retrieved context +
-- output), so a tenant went dark after roughly 25 conversations — and the
-- failure is silent: widget-ask returns ai_budget_exceeded and the customer
-- sees "I'm briefly at capacity". Outsourcetel hit this at 101,740/100,000,
-- which is why the live Support DE stopped answering.
--
-- The ceiling is a runaway-loop backstop, not a billing plan. 5,000,000 keeps
-- that backstop meaningful while staying clear of normal use. This is the same
-- number Acme Telecom had already been raised to by hand.
--
-- Applies to all 16 edge functions that gate on check_tenant_ai_budget, not
-- just chat.

-- ── 1. New default for every future tenant ──────────────────────────────
ALTER TABLE public.tenants
  ALTER COLUMN monthly_token_budget SET DEFAULT 5000000;

-- ── 2. Backfill tenants still sitting on the old default ────────────────
-- Scoped to = 100000 on purpose: never clobber a deliberately-set ceiling
-- (Sonic is on 80,000,000; Acme already on 5,000,000).
UPDATE public.tenants
   SET monthly_token_budget = 5000000
 WHERE monthly_token_budget = 100000;

-- ── 3. Early warning at 80% ─────────────────────────────────────────────
-- Previously STABLE. Writing an alert makes it VOLATILE; verified no SQL
-- function calls it (only edge functions, via rpc), so nothing inlines it
-- into a STABLE/IMMUTABLE context.
--
-- Hot path: the threshold block only runs once a tenant is already past 80%,
-- so the common case adds no work. Dedupe is per tenant per billing month,
-- so a busy tenant raises one 'approaching' alert and one 'exhausted' alert
-- per month, not one per request.
CREATE OR REPLACE FUNCTION public.check_tenant_ai_budget(p_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_budget  integer;
  v_used    bigint;
  v_allowed boolean;
  v_period  text := to_char(date_trunc('month', now()), 'YYYY-MM');
  v_kind    text;
  v_name    text;
begin
  select monthly_token_budget, name into v_budget, v_name
    from tenants where id = p_tenant_id;

  -- null / <= 0 means "no ceiling" — unchanged behaviour.
  if v_budget is null or v_budget <= 0 then
    return jsonb_build_object('allowed', true, 'used', 0, 'budget', v_budget);
  end if;

  v_used   := get_tenant_token_usage_this_month(p_tenant_id);
  v_allowed := v_used < v_budget;

  if v_used >= (v_budget::numeric * 0.8) then
    v_kind := case when v_allowed then 'ai_budget_approaching' else 'ai_budget_exhausted' end;

    insert into ops_alerts (kind, message, detail)
    select
      v_kind,
      case when v_allowed
        then format('%s has used %s%% of its monthly AI budget (%s of %s tokens).',
                    coalesce(v_name, 'A tenant'),
                    round((v_used::numeric / v_budget) * 100),
                    v_used, v_budget)
        else format('%s has EXHAUSTED its monthly AI budget (%s of %s tokens). Its digital employees have stopped answering.',
                    coalesce(v_name, 'A tenant'), v_used, v_budget)
      end,
      jsonb_build_object(
        'tenant_id', p_tenant_id,
        'tenant_name', v_name,
        'period', v_period,
        'used', v_used,
        'budget', v_budget
      )
    where not exists (
      select 1 from ops_alerts a
       where a.kind = v_kind
         and a.detail->>'tenant_id' = p_tenant_id::text
         and a.detail->>'period' = v_period
    );
  end if;

  return jsonb_build_object('allowed', v_allowed, 'used', v_used, 'budget', v_budget);
end;
$function$;

-- Supports the dedupe NOT EXISTS above.
CREATE INDEX IF NOT EXISTS ops_alerts_kind_tenant_period_idx
  ON public.ops_alerts (kind, (detail->>'tenant_id'), (detail->>'period'));
