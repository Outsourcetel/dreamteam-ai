-- Exhaustive follow-up to the 2026-07-06/07 series of piecemeal null-bypass
-- fixes (038-041, 047). Per founder directive: "A systematic, complete sweep
-- for the specific auth-bypass shape across every function, so 'we think we
-- got them all' becomes 'we checked all of them.'"
--
-- Method: enumerated ALL 87 functions where pronamespace='public' AND
-- prosecdef=true (the full denominator; migration 047 fixed 3 functions'
-- grants + 2 functions' logic -- a partial pass). Every one of the 87 was
-- read via pg_get_functiondef and classified. This migration fixes every
-- function that landed in a vulnerable bucket.
--
-- CRITICAL LIVE FINDING: migration 047 was only PARTIALLY applied to the
-- live database. Its grant-hygiene REVOKE/GRANT statements for
-- match_doc_chunks/search_knowledge landed (confirmed via pg_proc.proacl),
-- but the CREATE OR REPLACE FUNCTION body fixes for those same functions
-- did NOT land -- the live function bodies still contain the exact
-- `auth.uid() IS NOT NULL AND ... NOT IN` / `auth.uid() IS NULL OR ... IN`
-- null-bypass shape today. This migration re-applies those body fixes AND
-- extends the same fix to every other function found with the same bug,
-- several of which migration 047 did not touch at all.
--
-- FINDING A (confirmed LIVE-EXPLOITABLE right now, proven via
-- `SET LOCAL ROLE anon` with no JWT claims at all against the live DB):
--   - visible_knowledge_docs: granted directly to anon AND to PUBLIC.
--     Live test returned 1 real knowledge-doc row for Acme Telecom
--     (tenant a1b2c3d4-0000-0000-0000-000000000001) with zero auth.
--   - match_cached_answer: granted directly to anon AND to PUBLIC.
--     Live test executed successfully against Acme Telecom's cache
--     (0 rows only because no cached answer currently exists there --
--     the bypass itself succeeded, proving the read path is open).
--   - resolve_action_execution_for_task: granted directly to anon AND to
--     PUBLIC. Live test returned a real action_executions row (including
--     receipt/result) for Acme Telecom by supplying only a task_id, with
--     zero auth. This function was NOT part of migration 047 and was
--     initially miscategorized as safe in this very audit on a first pass
--     -- caught only by re-verifying every "safe" classification a second
--     time against the raw guard shape, exactly per the "check every one
--     yourself" mandate. Its guard was
--       `IF auth.uid() IS NOT NULL AND v_task_tenant NOT IN (...) AND
--        NOT is_platform_admin() THEN RAISE EXCEPTION`
--     -- an extra `AND NOT is_platform_admin()` clause does not change the
--     fact that the whole condition is false (no exception) when
--     auth.uid() IS NULL.
--
-- FINDING B (same body-level bug, NOT currently anon/PUBLIC-granted, so
-- lower immediate severity, but still wrong and still fixed here for
-- defense-in-depth and correctness -- authenticated callers already pass
-- through fine today only because their auth.uid() is never null; the bug
-- would become live again the moment a grant is loosened, exactly as
-- happened with 047's partial application):
--   - search_knowledge(uuid, text, integer)
--   - search_knowledge(uuid, text, text, integer)
--   - match_doc_chunks
--   - hybrid_match_knowledge (NOT covered by migration 047 at all -- new)
--   - count_pending_knowledge_gaps (NOT covered by migration 047 -- new)
--
-- FINDING C (missing service-role check in the anonymous branch --
-- Finding-2-shaped bug, distinct function, NOT covered by migration 047):
--   - increment_metric_tenant: guard was
--       `IF auth.uid() IS NOT NULL THEN RAISE EXCEPTION 'service role only'`
--     with NOTHING in the implicit else branch -- an anonymous (no-JWT)
--     caller sails through and can write directly to usage_metrics for
--     ANY attacker-supplied p_tenant_id. Not currently anon/authenticated
--     granted (service_role/postgres only today), so not live-exploitable
--     over PostgREST right now, but the logic itself is broken and is
--     fixed here rather than left as a time bomb.
--
-- All fixes below preserve each function's existing legitimate business
-- logic exactly -- only the guard shape changes, using the same
-- `if v_user is not null then <checks> elsif coalesce(auth.role(),'') <>
-- 'service_role' then <reject> else <trusted path> end if` (or, for
-- read-only functions with no service-role branch, the simpler
-- `auth.uid() IS NULL OR <check>`-as-WHERE inverted into an explicit
-- `IF auth.uid() IS NOT NULL AND <bad> THEN RAISE` guarded by ALSO
-- rejecting outright when there is no way to prove membership) pattern
-- already proven correct elsewhere in this codebase (set_doc_scope,
-- submit_evidence_feedback, set_access_grant, revoke_access_grant).
--
-- Every other function among the 87 was confirmed safe: either it derives
-- tenant_id from the caller's own profile row (never trusts a parameter),
-- uses the `IS DISTINCT FROM ... AND NOT is_platform_admin()` shape (safe
-- because IS DISTINCT FROM does not silently pass on NULL the way `=`/`IN`
-- do), uses the correct `v_user is not null ... elsif auth.role() <>
-- 'service_role'` shape, is a trigger function with no direct caller, or
-- takes no tenant-scoped parameter at all.

-- ---------------------------------------------------------------
-- FINDING A/B: knowledge-retrieval read functions. Fix: replace the
-- null-bypassable guard with one that treats "no proven membership" as
-- deny, for every caller -- authenticated (must be a tenant member),
-- service_role (trusted, no profile needed), or anonymous (rejected).
-- ---------------------------------------------------------------

create or replace function public.visible_knowledge_docs(p_tenant_id uuid, p_subject_kind text default null::text, p_subject_id uuid default null::uuid)
 returns table(id uuid, title text, content text, tags text[], visibility text)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if auth.uid() is not null then
    if p_tenant_id not in (select tenant_id from profiles where user_id = auth.uid()) then
      raise exception 'tenant access denied';
    end if;
  elsif coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'tenant access denied';
  end if;
  return query
  select d.id, d.title, d.content, d.tags, d.visibility
  from knowledge_docs d
  where d.tenant_id = p_tenant_id
    and d.is_current
    and (
      d.visibility = 'tenant'
      or (p_subject_kind is not null and p_subject_id is not null and exists (
            select 1 from knowledge_doc_scopes s
            where s.doc_id = d.id
              and s.subject_kind = p_subject_kind
              and s.subject_id = p_subject_id))
    );
end;
$function$;

create or replace function public.match_cached_answer(p_tenant_id uuid, p_account_id uuid, p_query_embedding vector, p_max_distance double precision default 0.15)
 returns table(id uuid, answer text, confidence integer, sources jsonb, distance double precision)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if auth.uid() is not null then
    if p_tenant_id not in (select tenant_id from profiles where user_id = auth.uid()) then
      raise exception 'tenant access denied';
    end if;
  elsif coalesce(auth.role(), '') <> 'service_role' then
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
  order by
    (a.account_id is not null and a.account_id = p_account_id) desc,
    a.question_embedding <=> p_query_embedding
  limit 1;
end;
$function$;

create or replace function public.match_doc_chunks(p_tenant_id uuid, p_account_id uuid, p_query_embedding vector, p_match_count integer default 5, p_subject_kind text default null::text, p_subject_id uuid default null::uuid)
 returns table(id uuid, doc_id uuid, content text, account_id uuid, distance double precision, visibility text)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if auth.uid() is not null then
    if p_tenant_id not in (select tenant_id from profiles where user_id = auth.uid()) then
      raise exception 'tenant access denied';
    end if;
  elsif coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'tenant access denied';
  end if;
  return query
  select c.id, c.doc_id, c.content, c.account_id,
         (c.embedding <=> p_query_embedding)::float as distance,
         d.visibility
  from knowledge_doc_chunks c
  join knowledge_docs d on d.id = c.doc_id
  where c.tenant_id = p_tenant_id
    and c.embedding is not null
    and d.is_current
    and (c.account_id is null or (p_account_id is not null and c.account_id = p_account_id))
    and (
      d.visibility = 'tenant'
      or (p_subject_kind is not null and p_subject_id is not null and exists (
            select 1 from knowledge_doc_scopes s
            where s.doc_id = d.id
              and s.subject_kind = p_subject_kind
              and s.subject_id = p_subject_id))
    )
  order by
    (c.account_id is not null and c.account_id = p_account_id) desc, -- account overlay first
    c.embedding <=> p_query_embedding
  limit p_match_count;
end;
$function$;

create or replace function public.hybrid_match_knowledge(p_tenant_id uuid, p_query_text text, p_account_id uuid default null::uuid, p_query_embedding vector default null::vector, p_match_count integer default 5, p_subject_kind text default null::text, p_subject_id uuid default null::uuid, p_max_distance double precision default 0.25)
 returns table(id uuid, doc_id uuid, doc_title text, content text, account_id uuid, visibility text, lexical_rank integer, semantic_rank integer, distance double precision, score double precision)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if auth.uid() is not null then
    if p_tenant_id not in (select tenant_id from profiles where user_id = auth.uid()) then
      raise exception 'tenant access denied';
    end if;
  elsif coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'tenant access denied';
  end if;

  return query
  with visible_docs as (
    select d.id, d.title, d.visibility, d.search_tsv
    from knowledge_docs d
    where d.tenant_id = p_tenant_id
      and d.is_current
      and (
        d.visibility = 'tenant'
        or (p_subject_kind is not null and p_subject_id is not null and exists (
              select 1 from knowledge_doc_scopes s
              where s.doc_id = d.id
                and s.subject_kind = p_subject_kind
                and s.subject_id = p_subject_id))
      )
  ),
  lexical as (
    select
      vd.id as doc_id,
      (row_number() over (order by ts_rank(vd.search_tsv, websearch_to_tsquery('english', p_query_text)) desc))::int as lexical_rank
    from visible_docs vd
    where p_query_text is not null
      and length(trim(p_query_text)) > 0
      and vd.search_tsv @@ websearch_to_tsquery('english', p_query_text)
  ),
  semantic as (
    select
      c.id as chunk_id,
      c.doc_id,
      c.content,
      c.account_id,
      (c.embedding <=> p_query_embedding)::float as distance,
      (row_number() over (order by (c.embedding <=> p_query_embedding) asc))::int as semantic_rank
    from knowledge_doc_chunks c
    join visible_docs vd on vd.id = c.doc_id
    where c.tenant_id = p_tenant_id
      and c.embedding is not null
      and p_query_embedding is not null
      and (c.account_id is null or (p_account_id is not null and c.account_id = p_account_id))
      and (c.embedding <=> p_query_embedding) <= p_max_distance
  ),
  candidates as (
    select
      s.chunk_id as id, s.doc_id, s.content, s.account_id, s.distance, s.semantic_rank
    from semantic s
    union
    select
      gen_random_uuid() as id, vd.id as doc_id,
      (select d2.content from knowledge_docs d2 where d2.id = vd.id) as content,
      null::uuid as account_id, null::float as distance, null::int as semantic_rank
    from visible_docs vd
    join lexical l on l.doc_id = vd.id
    where not exists (select 1 from semantic s2 where s2.doc_id = vd.id)
  )
  select
    c.id, c.doc_id, vd.title as doc_title, c.content, c.account_id, vd.visibility,
    l.lexical_rank, c.semantic_rank, c.distance,
    (coalesce(1.0 / (60 + l.lexical_rank), 0.0) + coalesce(1.0 / (60 + c.semantic_rank), 0.0))::double precision as score
  from candidates c
  join visible_docs vd on vd.id = c.doc_id
  left join lexical l on l.doc_id = c.doc_id
  where l.lexical_rank is not null or c.semantic_rank is not null
  order by
    (c.account_id is not null and c.account_id = p_account_id) desc,
    score desc
  limit p_match_count;
end;
$function$;

create or replace function public.search_knowledge(p_tenant_id uuid, p_query text, p_audience text default null::text, p_limit integer default 5)
 returns table(id uuid, title text, summary text, body text, audience text, category text, tags text[], rank real)
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
begin
  if auth.uid() is not null then
    if p_tenant_id not in (select tenant_id from profiles where user_id = auth.uid()) then
      raise exception 'tenant access denied';
    end if;
  elsif coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'tenant access denied';
  end if;
  return query
  select ka.id, ka.title, ka.summary, ka.body, ka.audience, ka.category, ka.tags,
         ts_rank(ka.search_tsv, websearch_to_tsquery('english', p_query)) as rank
  from public.knowledge_articles ka
  where ka.tenant_id = p_tenant_id
    and ka.status = 'published'
    and (p_audience is null or ka.audience = p_audience or ka.audience = 'all')
    and ka.search_tsv @@ websearch_to_tsquery('english', p_query)
  order by rank desc
  limit greatest(p_limit, 1);
end;
$function$;

create or replace function public.search_knowledge(p_tenant_id uuid, p_query text, p_limit integer default 5)
 returns table(id uuid, title text, body text, similarity double precision)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if auth.uid() is not null then
    if p_tenant_id not in (select tenant_id from profiles where user_id = auth.uid()) then
      raise exception 'tenant access denied';
    end if;
  elsif coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'tenant access denied';
  end if;
  return query
  select ka.id, ka.title, ka.body,
    ts_rank(
      to_tsvector('english', coalesce(ka.title,'') || ' ' || coalesce(ka.body,'')),
      plainto_tsquery('english', p_query)
    )::float as similarity
  from knowledge_articles ka
  where ka.tenant_id = p_tenant_id
    and ka.status = 'published'
    and to_tsvector('english', coalesce(ka.title,'') || ' ' || coalesce(ka.body,''))
        @@ plainto_tsquery('english', p_query)
  order by similarity desc
  limit p_limit;
end;
$function$;

create or replace function public.count_pending_knowledge_gaps(p_tenant_id uuid)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_count int;
begin
  if auth.uid() is not null then
    if p_tenant_id not in (select tenant_id from profiles where user_id = auth.uid()) then
      raise exception 'tenant access denied';
    end if;
  elsif coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'tenant access denied';
  end if;

  select count(*) into v_count
  from knowledge_revision_requests
  where tenant_id = p_tenant_id
    and status = 'pending_approval';

  return coalesce(v_count, 0);
end;
$function$;

-- ---------------------------------------------------------------
-- FINDING A: resolve_action_execution_for_task -- the extra
-- `AND NOT is_platform_admin()` clause does not save this from the
-- null-bypass; auth.uid() IS NULL alone already makes the whole guard
-- false and skips the exception. New/deny-by-default shape below.
-- ---------------------------------------------------------------
create or replace function public.resolve_action_execution_for_task(p_task_id uuid)
 returns action_executions
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_task_tenant uuid;
  v_row action_executions;
begin
  select tenant_id into v_task_tenant from human_tasks where id = p_task_id;
  if v_task_tenant is null then
    return null;
  end if;
  if auth.uid() is not null then
    if v_task_tenant not in (select tenant_id from profiles where user_id = auth.uid()) and not is_platform_admin() then
      raise exception 'tenant access denied';
    end if;
  elsif coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'tenant access denied';
  end if;
  select ae.* into v_row from action_executions ae
    where ae.task_id = p_task_id and ae.tenant_id = v_task_tenant
    order by ae.created_at desc limit 1;
  return v_row;
end;
$function$;

-- ---------------------------------------------------------------
-- FINDING C: increment_metric_tenant -- "service role only" was intended
-- but the check only rejected AUTHENTICATED callers, never verified
-- auth.role() = 'service_role' for the anonymous branch, so a no-JWT
-- caller passed straight through to a write with an attacker-supplied
-- p_tenant_id. Not currently anon/authenticated granted, fixed anyway.
-- ---------------------------------------------------------------
create or replace function public.increment_metric_tenant(p_tenant_id uuid, p_metric text, p_delta bigint default 1)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role only';
  end if;
  insert into usage_metrics (tenant_id, day, metric, value)
    values (p_tenant_id, current_date, p_metric, p_delta)
    on conflict (tenant_id, day, metric)
    do update set value = usage_metrics.value + excluded.value;
end;
$function$;

-- ---------------------------------------------------------------
-- Grant hygiene: explicit revoke-from-all-three-then-regrant for every
-- function touched above, per the standing rule on this project that
-- `revoke ... from anon, authenticated` alone does NOT remove a grant
-- that also exists to the PUBLIC pseudo-role -- always name all three.
--
-- match_doc_chunks / search_knowledge(x2) / hybrid_match_knowledge /
-- count_pending_knowledge_gaps already have no anon/PUBLIC grant live
-- (confirmed via pg_proc.proacl before this migration) -- re-asserting
-- here anyway for defense-in-depth and to make the intended grant state
-- self-documenting in the migration history.
-- ---------------------------------------------------------------
revoke all on function visible_knowledge_docs(uuid, text, uuid) from public, anon, authenticated;
grant execute on function visible_knowledge_docs(uuid, text, uuid) to authenticated, service_role;

revoke all on function match_cached_answer(uuid, uuid, vector, double precision) from public, anon, authenticated;
grant execute on function match_cached_answer(uuid, uuid, vector, double precision) to authenticated, service_role;

revoke all on function match_doc_chunks(uuid, uuid, vector, integer, text, uuid) from public, anon, authenticated;
grant execute on function match_doc_chunks(uuid, uuid, vector, integer, text, uuid) to authenticated, service_role;

revoke all on function hybrid_match_knowledge(uuid, text, uuid, vector, integer, text, uuid, double precision) from public, anon, authenticated;
grant execute on function hybrid_match_knowledge(uuid, text, uuid, vector, integer, text, uuid, double precision) to authenticated, service_role;

revoke all on function search_knowledge(uuid, text, text, integer) from public, anon, authenticated;
grant execute on function search_knowledge(uuid, text, text, integer) to authenticated, service_role;

revoke all on function search_knowledge(uuid, text, integer) from public, anon, authenticated;
grant execute on function search_knowledge(uuid, text, integer) to authenticated, service_role;

revoke all on function count_pending_knowledge_gaps(uuid) from public, anon, authenticated;
grant execute on function count_pending_knowledge_gaps(uuid) to authenticated, service_role;

revoke all on function resolve_action_execution_for_task(uuid) from public, anon, authenticated;
grant execute on function resolve_action_execution_for_task(uuid) to authenticated, service_role;

revoke all on function increment_metric_tenant(uuid, text, bigint) from public, anon, authenticated;
grant execute on function increment_metric_tenant(uuid, text, bigint) to service_role;

-- ---------------------------------------------------------------
-- Minor grant-hygiene cleanup surfaced during this exhaustive pass
-- (not a vulnerability -- increment_metric derives tenant from the
-- caller's own profile row and cannot be tricked -- but it carries a
-- stray PUBLIC grant with no legitimate reason to, inconsistent with
-- every other function fixed in this migration).
-- ---------------------------------------------------------------
revoke all on function increment_metric(text, bigint) from public, anon, authenticated;
grant execute on function increment_metric(text, bigint) to authenticated, service_role;
