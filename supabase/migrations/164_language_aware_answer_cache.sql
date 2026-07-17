-- ═══════════════════════════════════════════════════════════════
-- 164 — Language-aware answer cache (bug fix, found live 2026-07-17)
--
-- THE BUG: the semantic answer cache stored no language. A Spanish
-- answer cached during cross-language testing was served to ENGLISH
-- askers — gte-small embeddings are multilingual enough that the
-- English phrasing of the same question lands inside the match
-- threshold. Observed live on the hosted portal: English "What employee
-- data does the Workday integration sync?" → cached:true, "Según la
-- documentación…".
--
-- THE FIX:
--   • answer_cache.language — the language of the cached ANSWER
--     (null = legacy/unknown, treated as English after the purge below).
--   • match_cached_answer gains p_language: null → match only rows
--     whose language is null/English (the English fast path); a named
--     language → match only that language.
--   • Callers additionally SKIP the cache read for non-English
--     questions (we can detect "not English" cheaply, but not WHICH
--     language without a model call — and serving Spanish cache to a
--     French asker is the same bug). Non-English askers are rare; they
--     just pay the normal LLM path.
--   • Purge the polluted demo-tenant cache so legacy null-language
--     Spanish rows can't match again.
-- ═══════════════════════════════════════════════════════════════

alter table answer_cache add column if not exists language text;

-- Recreate with the extra defaulted param. Existing named-param callers
-- (de-answer, widget-ask) keep working; drop first because adding a
-- parameter changes the signature (CREATE OR REPLACE would overload).
drop function if exists match_cached_answer(uuid, uuid, vector, float);

create or replace function match_cached_answer(
  p_tenant_id       uuid,
  p_account_id      uuid,
  p_query_embedding vector(384),
  p_max_distance    float default 0.15,
  p_language        text default null
)
returns table (id uuid, answer text, confidence integer, sources jsonb, distance float)
language plpgsql security definer set search_path = public as $$
begin
  -- Body is migration 013's verbatim (tenant guard, account-null
  -- semantics, account-preference ordering, strict < threshold) plus
  -- ONLY the language gate.
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
    and (a.account_id is null or (p_account_id is not null and a.account_id = p_account_id))
    and (a.question_embedding <=> p_query_embedding) < p_max_distance
    -- Language gate: default (null) = the English path — only rows whose
    -- answer is English (or legacy-null, safe post-purge). A named
    -- language matches only itself.
    and (
      (p_language is null and (a.language is null or a.language ilike 'english'))
      or (p_language is not null and a.language ilike p_language)
    )
  order by
    (a.account_id is not null and a.account_id = p_account_id) desc,
    a.question_embedding <=> p_query_embedding
  limit 1;
end;
$$;

revoke all on function match_cached_answer(uuid, uuid, vector, float, text) from public, anon;
grant execute on function match_cached_answer(uuid, uuid, vector, float, text) to service_role;

-- Purge the demo tenant's polluted cache (contains untagged Spanish rows).
delete from answer_cache where tenant_id = 'a1b2c3d4-0000-0000-0000-000000000001';
