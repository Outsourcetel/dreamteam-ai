-- 304_answer_cache_de_scope.sql
-- ============================================================================
-- Production-readiness audit: the answer_cache was keyed by tenant + account +
-- language but NOT by digital employee. In a multi-DE tenant, DE-A's cached
-- answer could be served for a question routed to DE-B — under DE-B's persona,
-- even when DE-B lacks access to the documents DE-A used (cross-DE leak + scope
-- dishonesty). Add de_id and DE-scope the match so a DE's cache serves ONLY that
-- DE (null-de = the headless/no-DE path still matches itself).
--
-- Existing rows have de_id NULL → they simply stop matching DE-scoped reads and
-- re-populate per-DE naturally; the miss is the SAFE direction (a fresh gated
-- answer rather than a wrong-DE cache hit). GLOBAL, additive.
-- ============================================================================

ALTER TABLE answer_cache ADD COLUMN IF NOT EXISTS de_id uuid;

-- Adding p_de_id changes the signature, so CREATE OR REPLACE would leave the old
-- 5-arg overload live (un-scoped + ambiguous). Drop it first.
DROP FUNCTION IF EXISTS public.match_cached_answer(uuid, uuid, vector, double precision, text);

CREATE OR REPLACE FUNCTION public.match_cached_answer(
  p_tenant_id uuid, p_account_id uuid, p_query_embedding vector,
  p_max_distance double precision DEFAULT 0.15, p_language text DEFAULT NULL::text,
  p_de_id uuid DEFAULT NULL::uuid)
RETURNS TABLE(id uuid, answer text, confidence integer, sources jsonb, distance double precision)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is not null and p_tenant_id not in
     (select tenant_id from profiles where user_id = auth.uid()) then
    raise exception 'tenant access denied';
  end if;
  return query
  select a.id, a.answer, a.confidence, a.sources,
         (a.question_embedding <=> p_query_embedding)::float as distance
  from answer_cache a
  where a.tenant_id = p_tenant_id
    and a.invalidated = false
    and a.question_embedding is not null
    and a.de_id is not distinct from p_de_id   -- DE-scoped: a DE's cache serves only that DE
    and (a.account_id is null or (p_account_id is not null and a.account_id = p_account_id))
    and (a.question_embedding <=> p_query_embedding) < p_max_distance
    and (
      (p_language is null and (a.language is null or a.language ilike 'english'))
      or (p_language is not null and a.language ilike p_language)
    )
  order by
    (a.account_id is not null and a.account_id = p_account_id) desc,
    a.question_embedding <=> p_query_embedding
  limit 1;
end;
$function$;

NOTIFY pgrst, 'reload schema';
