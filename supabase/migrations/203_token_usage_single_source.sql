-- 203: make the AI budget counter authoritative over ALL metered spend
--
-- WHY
-- There are two metering lanes:
--   record_de_token_usage()        -> de_token_usage      (per-DE work)
--   increment_tenant_token_usage() -> tenant_ai_usage     (tenant-level work)
-- but get_tenant_token_usage_this_month() only ever summed the first one.
-- Anything metered through the second lane was invisible to
-- check_tenant_ai_budget() — spend that no ceiling could ever stop.
--
-- Today tenant_ai_usage is empty and nothing calls the second lane, so
-- nothing has leaked. It surfaced while building ai-session, which is the
-- first genuinely tenant-level (not per-DE) AI surface and would have been
-- the first spend the budget could not see. Closing it before that lands
-- rather than after.
--
-- Union rather than migrating one lane into the other: per-DE rows carry a
-- de_id that the Performance pages group by, and tenant-level work has no
-- DE to attribute to. Both are legitimate; the counter just has to read both.

CREATE OR REPLACE FUNCTION public.get_tenant_token_usage_this_month(p_tenant_id uuid)
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT
    (SELECT coalesce(sum(input_tokens + output_tokens), 0)
       FROM de_token_usage
      WHERE tenant_id = p_tenant_id
        AND created_at >= date_trunc('month', now()))
  + (SELECT coalesce(sum(tokens_used), 0)
       FROM tenant_ai_usage
      WHERE tenant_id = p_tenant_id
        AND year_month = to_char(now(), 'YYYY-MM'));
$function$;
