-- 292_knowledge_freshness_retrieval.sql
-- ============================================================================
-- KNOWLEDGE PHASE 5 — freshness-weighted retrieval, default-OFF, base-preserving.
--
-- Adds ONE additive freshness term to hybrid_match_knowledge's fused score so
-- fresher / non-expired docs edge out stale ones on ties, WITHOUT regressing the
-- proven base ranking. The base body is reproduced VERBATIM from the live mig-271
-- definition; exactly two things change:
--   (1) visible_docs carries last_verified_at / updated_at / expires_at, and
--   (2) the final score gains  + v_fresh_weight*exp(-ln2*age/halflife) - expired_penalty.
-- ALL new sub-terms are multiplied by locals (v_fresh_weight / v_expired_penalty)
-- that stay 0.0 unless the tenant has the default-OFF flag on, and the whole
-- freshness clause is wrapped in `case when v_fresh_on then … else 0.0 end`, so
-- with the flag off the score is `base + 0.0` = BYTE-IDENTICAL to today. That is
-- the 046→236→271 base-regression discipline: never regress the base.
--
-- STEP A seeds the feature flag BEFORE the CREATE OR REPLACE, because
-- is_feature_enabled_internal fails OPEN on an unknown key — without the row,
-- replacing the fn would switch freshness ON for every tenant. Seeding first
-- makes the key known and default-false.
--
-- The three tuning knobs live in platform_config and are read with a regex-guarded
-- cast that FALLS BACK to the default on any non-numeric value — so a single bad
-- global config write can never raise mid-query and break the live answer path for
-- every flag-on tenant at once. set_knowledge_freshness_config is the validated
-- writer (numeric param + platform-admin gate). GLOBAL, additive.
-- ============================================================================

-- ── STEP A: default-OFF flag, seeded BEFORE the fn replace (fail-open trap) ──
INSERT INTO feature_registry (key, label, description, default_enabled, category)
VALUES ('knowledge_freshness_weighting', 'Freshness-weighted retrieval',
        'Nudge fresher / non-expired knowledge slightly higher in retrieval. Default OFF — enable per workspace and A/B against citation outcomes.',
        false, 'retrieval')
ON CONFLICT (key) DO NOTHING;

DO $assert$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM feature_registry WHERE key = 'knowledge_freshness_weighting') THEN
    RAISE EXCEPTION 'freshness flag row missing — refusing to replace hybrid_match_knowledge (fail-open risk)';
  END IF;
END $assert$;

-- ── Validated writer for the three numeric knobs (platform-admin only) ──
CREATE OR REPLACE FUNCTION public.set_knowledge_freshness_config(p_key text, p_value numeric)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_platform_admin() THEN RETURN jsonb_build_object('ok', false, 'error', 'forbidden'); END IF;
  IF p_key NOT IN ('knowledge.freshness_weight', 'knowledge.freshness_halflife_days', 'knowledge.freshness_expired_penalty') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_key');
  END IF;
  IF p_value IS NULL OR p_value < 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'bad_value'); END IF;
  -- platform_config.value is a plain text column; store the number as text.
  INSERT INTO platform_config (key, value) VALUES (p_key, p_value::text)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
  RETURN jsonb_build_object('ok', true, 'key', p_key, 'value', p_value);
END $$;
REVOKE ALL ON FUNCTION public.set_knowledge_freshness_config(text, numeric) FROM anon;
GRANT EXECUTE ON FUNCTION public.set_knowledge_freshness_config(text, numeric) TO authenticated, service_role;

-- ── STEP B: reproduce mig-271 body VERBATIM + the two freshness deltas ──
-- (CREATE OR REPLACE with an identical signature preserves the existing ACL, so
--  no grant change is needed — hence no REVOKE/GRANT that could differ from live.)
CREATE OR REPLACE FUNCTION public.hybrid_match_knowledge(
  p_tenant_id uuid, p_query_text text, p_account_id uuid DEFAULT NULL::uuid,
  p_query_embedding vector DEFAULT NULL::vector, p_match_count integer DEFAULT 5,
  p_subject_kind text DEFAULT NULL::text, p_subject_id uuid DEFAULT NULL::uuid,
  p_max_distance double precision DEFAULT 0.25)
 RETURNS TABLE(id uuid, doc_id uuid, doc_title text, content text, account_id uuid,
               visibility text, lexical_rank integer, semantic_rank integer,
               distance double precision, score double precision)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_archetype text;
  -- Freshness weighting locals. All 0.0 => the score below is byte-identical to
  -- the mig-271 base. Only populated when the tenant's default-OFF flag is on and
  -- the kill-switch is not set.
  v_fresh_on boolean := false;
  v_fresh_weight double precision := 0.0;
  v_fresh_halflife double precision := 180.0;
  v_expired_penalty double precision := 0.0;
  v_cfg text;
begin
  if auth.uid() is not null and p_tenant_id not in
     (select tenant_id from profiles where user_id = auth.uid()) then
    raise exception 'tenant access denied';
  end if;
  v_archetype := case when p_subject_kind = 'de' and p_subject_id is not null then resolve_de_archetype(p_subject_id) end;

  -- Resolve freshness weighting (default-OFF flag + kill-switch). Regex-guarded
  -- casts fall back to defaults on any non-numeric config → never raises here.
  -- platform_config.value is a plain text column — read it directly (not #>>).
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

  return query
  with visible_docs as (
    select d.id, d.title, d.visibility, d.search_tsv, coalesce(d.authority, 0) as authority,
           d.last_verified_at, d.updated_at, d.expires_at
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
    (coalesce(1.0 / (60 + l.lexical_rank), 0.0)
      + coalesce(1.0 / (60 + c.semantic_rank), 0.0)
      + (coalesce(vd.authority, 0) * 0.002)
      -- Freshness delta: 0.0 when the flag is off (byte-identical base). When on,
      -- an exponential recency bonus (half-life days) minus a penalty if expired.
      -- Whole clause coalesced so a null verify/updated anchor can never null the score.
      + case when v_fresh_on then
          coalesce(
            v_fresh_weight * exp(- ln(2.0)
              * greatest(0.0, extract(epoch from (now() - coalesce(vd.last_verified_at, vd.updated_at))) / 86400.0)
              / greatest(1.0, v_fresh_halflife)),
            0.0)
          - (case when vd.expires_at is not null and vd.expires_at < now() then v_expired_penalty else 0.0 end)
        else 0.0 end
    )::double precision as score
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

NOTIFY pgrst, 'reload schema';
