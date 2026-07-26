-- 345_knowledge_acl_retrieval.sql
-- ============================================================================
-- PHASE 2, INCREMENT 4 — permissions reach retrieval, WITHOUT making the
-- Digital Employees dumber. This is §7a of docs/27, the pushback you agreed to.
--
-- ── Why this is not optional ────────────────────────────────────────────────
-- Mig 344 put permissions on knowledge_docs. But hybrid_match_knowledge is
-- SECURITY DEFINER and every caller is an edge function holding the service
-- role — and service_role BYPASSES RLS. So as of 344 the Library respects
-- permissions and the employees do not. A person locked out of a Space could
-- simply ask a Digital Employee to read it to them. Permissions that any user
-- can walk around by asking nicely are decoration.
--
-- ── And why filtering alone would have been a bad trade ─────────────────────
-- Filter-before-rank is right for security and quietly corrosive for
-- intelligence: an employee retrieving from a narrowed corpus DOES NOT KNOW
-- what it was not shown. It answers confidently from partial knowledge — the
-- exact failure the grounded-confidence work exists to prevent. Security would
-- have eaten the product.
--
-- So retrieval now returns `withheld_count`: how many documents would have been
-- retrieved for this question but were withheld by permission. The employee can
-- then say "there may be material here I'm not permitted to see" instead of
-- inventing, or answering thinly and sounding certain. One integer, and it is
-- the difference between a secure product and a secure AND honest one.
--
-- ── Spoofing ────────────────────────────────────────────────────────────────
-- p_acting_user decides whose permissions apply, so it must not be caller-
-- supplied by anyone who could lie about it. If auth.uid() is non-null — a real
-- logged-in human calling through PostgREST — the argument is IGNORED and
-- replaced with their own id. Only a null-auth caller (service role, pg_cron)
-- may name the acting user, because only an edge function knows which human it
-- is answering on behalf of. Without this, "act as" is a query parameter.
--
-- ── Identical when off ──────────────────────────────────────────────────────
-- Flag `knowledge_acl_retrieval`, default OFF, seeded BEFORE the function is
-- replaced (is_feature_enabled_internal fails OPEN on an unknown key — mig 068).
-- With the flag off, or with no acting user, `permitted_docs` is `visible_docs`
-- unchanged and withheld_count is 0. One code path, one variable, so
-- "off ⇒ byte-identical" is provable rather than claimed. Same discipline as
-- migs 292 and 301.
--
-- Body reproduced VERBATIM from the live mig-301 definition. The changes are:
--   · two columns added to visible_docs (needed by the permission predicate)
--   · a new permitted_docs CTE
--   · a new withheld CTE
--   · lexical / semantic / candidates / final join read permitted_docs
--   · one new argument, one new return column
-- Nothing else — freshness weighting, RRF scoring, the ANN pool and the
-- account-pinning sort order are untouched.
-- ============================================================================

INSERT INTO feature_registry (key, label, description, default_enabled, category)
VALUES ('knowledge_acl_retrieval', 'Permission-aware retrieval',
        'Digital Employees answer a person only from documents that person is permitted to see, and say so when material was withheld. Default OFF; identical results until enabled.',
        false, 'retrieval')
ON CONFLICT (key) DO NOTHING;

DO $assert$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM feature_registry WHERE key = 'knowledge_acl_retrieval') THEN
    RAISE EXCEPTION '345: flag row missing — refusing to replace hybrid_match_knowledge';
  END IF;
END $assert$;

-- Return type changes, so this is a DROP not a REPLACE. Resolved from the
-- catalogue so a signature drift cannot silently leave the old one in place.
DO $drop$
DECLARE v_sig text;
BEGIN
  SELECT p.oid::regprocedure::text INTO v_sig FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'hybrid_match_knowledge' LIMIT 1;
  IF v_sig IS NOT NULL THEN EXECUTE 'DROP FUNCTION ' || v_sig; END IF;
END $drop$;

CREATE OR REPLACE FUNCTION public.hybrid_match_knowledge(
  p_tenant_id uuid, p_query_text text, p_account_id uuid DEFAULT NULL::uuid,
  p_query_embedding vector DEFAULT NULL::vector, p_match_count integer DEFAULT 5,
  p_subject_kind text DEFAULT NULL::text, p_subject_id uuid DEFAULT NULL::uuid,
  p_max_distance double precision DEFAULT 0.25,
  p_acting_user uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, doc_id uuid, doc_title text, content text, account_id uuid,
               visibility text, lexical_rank integer, semantic_rank integer,
               distance double precision, score double precision, withheld_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_archetype text;
  v_fresh_on boolean := false;
  v_fresh_weight double precision := 0.0;
  v_fresh_halflife double precision := 180.0;
  v_expired_penalty double precision := 0.0;
  v_cfg text;
  v_ann_on boolean := false;
  v_ann_pool bigint := 2000000000;
  -- 345: whose permissions apply, and whether they apply at all.
  v_actor uuid;
  v_acl_on boolean := false;
begin
  perform public._assert_caller_tenant(p_tenant_id);
  v_archetype := case when p_subject_kind = 'de' and p_subject_id is not null then resolve_de_archetype(p_subject_id) end;

  -- A logged-in caller may only ever act as themselves. Only a null-auth caller
  -- (edge function on service role, pg_cron) may name the human being served.
  v_actor := case when auth.uid() is not null then auth.uid() else p_acting_user end;
  if v_actor is not null and is_feature_enabled_internal(p_tenant_id, 'knowledge_acl_retrieval') then
    v_acl_on := true;
  end if;

  if is_feature_enabled_internal(p_tenant_id, 'knowledge_freshness_weighting') then
    select value into v_cfg from platform_config where key = 'knowledge.freshness_weighting_paused';
    if coalesce(v_cfg, '') not in ('true', '1', 't') then
      v_fresh_on := true;
      select coalesce((select case when value ~ '^[0-9]+(\.[0-9]+)?$' then value::double precision end
                         from platform_config where key = 'knowledge.freshness_weight'), 0.0007) into v_fresh_weight;
      select coalesce((select case when value ~ '^[0-9]+(\.[0-9]+)?$' then value::double precision end
                         from platform_config where key = 'knowledge.freshness_halflife_days'), 180.0) into v_fresh_halflife;
      select coalesce((select case when value ~ '^[0-9]+(\.[0-9]+)?$' then value::double precision end
                         from platform_config where key = 'knowledge.freshness_expired_penalty'), 0.006) into v_expired_penalty;
    end if;
  end if;

  if is_feature_enabled_internal(p_tenant_id, 'knowledge_ann_retrieval') then
    v_ann_on := true;
    v_ann_pool := 200;
    set local hnsw.iterative_scan = 'relaxed_order';
  end if;

  return query
  with visible_docs as (
    select d.id, d.title, d.visibility, d.search_tsv, coalesce(d.authority, 0) as authority,
           d.last_verified_at, d.updated_at, d.expires_at,
           -- 345: needed by the permission predicate below. Denormalised in 344
           -- precisely so this stays a column read.
           d.restricted_space_id, d.inherits_access
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
        or (d.visibility = 'role' and v_archetype is not null and d.share_archetype_key = v_archetype)
      )
  ),
  -- 345: the human ACL. When v_acl_on is false this is visible_docs verbatim,
  -- which is what makes flag-off byte-identical.
  permitted_docs as (
    select vd.* from visible_docs vd
    where (not v_acl_on)
       or exists (
         select 1 from knowledge_access_grants g
          where g.tenant_id = p_tenant_id
            and knowledge_permission_rank(g.permission) >= 1
            and knowledge_grant_matches_user(g, v_actor)
            and ((g.resource_type = 'workspace' and vd.restricted_space_id is null and vd.inherits_access)
              or (g.resource_type = 'document' and g.resource_id = vd.id)
              or (g.resource_type = 'collection' and vd.inherits_access
                  and exists (select 1 from knowledge_doc_access_paths p
                               where p.doc_id = vd.id and p.collection_id = g.resource_id))))
  ),
  lexical as (
    select
      vd.id as doc_id,
      (row_number() over (order by ts_rank(vd.search_tsv, websearch_to_tsquery('english', p_query_text)) desc))::int as lexical_rank
    from permitted_docs vd
    where p_query_text is not null
      and length(trim(p_query_text)) > 0
      and vd.search_tsv @@ websearch_to_tsquery('english', p_query_text)
  ),
  ann as (
    select c.id as chunk_id, c.doc_id, c.content, c.account_id,
           (c.embedding <=> p_query_embedding) as distance
    from knowledge_doc_chunks c
    where c.tenant_id = p_tenant_id
      and c.embedding is not null
      and p_query_embedding is not null
      and (c.account_id is null or (p_account_id is not null and c.account_id = p_account_id))
    order by c.embedding <=> p_query_embedding
    limit v_ann_pool
  ),
  semantic as (
    select
      a.chunk_id,
      a.doc_id,
      a.content,
      a.account_id,
      a.distance::float as distance,
      (row_number() over (order by a.distance asc))::int as semantic_rank
    from ann a
    join permitted_docs vd on vd.id = a.doc_id
    where a.distance <= p_max_distance
  ),
  -- 345: what did permission cost this answer? Only documents that WOULD have
  -- been retrieved — matched lexically, or close enough semantically — count.
  -- Anything else would inflate the number into noise the employee learns to
  -- ignore. Empty by construction when the ACL is off.
  withheld as (
    select count(*)::int as n
      from visible_docs vd
     where v_acl_on
       and not exists (select 1 from permitted_docs pd where pd.id = vd.id)
       and (
         (p_query_text is not null and length(trim(p_query_text)) > 0
            and vd.search_tsv @@ websearch_to_tsquery('english', p_query_text))
         or exists (select 1 from ann a where a.doc_id = vd.id and a.distance <= p_max_distance)
       )
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
    from permitted_docs vd
    join lexical l on l.doc_id = vd.id
    where not exists (select 1 from semantic s2 where s2.doc_id = vd.id)
  )
  select
    c.id, c.doc_id, vd.title as doc_title, c.content, c.account_id, vd.visibility,
    l.lexical_rank, c.semantic_rank, c.distance,
    (coalesce(1.0 / (60 + l.lexical_rank), 0.0)
      + coalesce(1.0 / (60 + c.semantic_rank), 0.0)
      + (coalesce(vd.authority, 0) * 0.002)
      + case when v_fresh_on then
          coalesce(
            v_fresh_weight * exp(- ln(2.0)
              * greatest(0.0, extract(epoch from (now() - coalesce(vd.last_verified_at, vd.updated_at))) / 86400.0)
              / greatest(1.0, v_fresh_halflife)),
            0.0)
          - (case when vd.expires_at is not null and vd.expires_at < now() then v_expired_penalty else 0.0 end)
        else 0.0 end
    )::double precision as score,
    w.n as withheld_count
  from candidates c
  join permitted_docs vd on vd.id = c.doc_id
  left join lexical l on l.doc_id = c.doc_id
  cross join withheld w
  where l.lexical_rank is not null or c.semantic_rank is not null
  order by
    (c.account_id is not null and c.account_id = p_account_id) desc,
    score desc
  limit p_match_count;
end;
$function$;

REVOKE ALL ON FUNCTION public.hybrid_match_knowledge(uuid, text, uuid, vector, integer, text, uuid, double precision, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.hybrid_match_knowledge(uuid, text, uuid, vector, integer, text, uuid, double precision, uuid) TO authenticated, service_role;

-- ── Prove it ────────────────────────────────────────────────────────────────
DO $assert$
DECLARE
  v_t uuid; v_rows int; v_withheld int; v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='hybrid_match_knowledge' LIMIT 1;

  -- The spoofing guard must be present, or p_acting_user is a privilege escalation.
  IF v_def !~ 'case when auth\.uid\(\) is not null then auth\.uid\(\)' THEN
    RAISE EXCEPTION '345: the acting-user spoofing guard is missing';
  END IF;
  -- The ranked paths must read permitted_docs, not visible_docs, or the filter
  -- is cosmetic.
  IF v_def ~ 'from visible_docs vd\s*\n\s*where p_query_text' THEN
    RAISE EXCEPTION '345: lexical still reads visible_docs — permission not applied to ranking';
  END IF;
  IF v_def !~ 'join permitted_docs vd on vd\.id = a\.doc_id' THEN
    RAISE EXCEPTION '345: semantic still reads visible_docs';
  END IF;

  -- And it must still actually answer. Flag is OFF, so this is today's behaviour.
  SELECT id INTO v_t FROM tenants t
   WHERE EXISTS (SELECT 1 FROM knowledge_docs d WHERE d.tenant_id=t.id AND d.is_current) LIMIT 1;
  SELECT count(*), coalesce(max(r.withheld_count),0) INTO v_rows, v_withheld
    FROM hybrid_match_knowledge(v_t, 'how do I get started', NULL, NULL, 5, NULL, NULL, 0.25, NULL) r;

  IF v_withheld <> 0 THEN
    RAISE EXCEPTION '345: withheld_count is % with the flag OFF — should be 0', v_withheld;
  END IF;
  RAISE NOTICE '345: retrieval returns % rows, withheld_count 0 with the flag off', v_rows;
END $assert$;

NOTIFY pgrst, 'reload schema';
