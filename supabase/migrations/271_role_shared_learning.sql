-- ═══════════════════════════════════════════════════════════════
-- 271 — T2.2: role/workforce shared learning (docs/22, adversary-approved)
--
-- Today every DE is a learning island: a verified self-improvement publishes
-- as a 'scoped' knowledge doc visible only to that de_id. This lets a human,
-- at the SAME approval gate, publish it at 'role' scope so every same-archetype
-- DE in the tenant benefits — human-gated, tenant-isolated, and privacy-safe
-- by construction (the doc is a generalized, replay-verified article, never raw
-- customer/conversation memory).
--
-- Safety property (verified): a NEW visibility value 'role' is default-DENY to
-- every reader we don't explicitly patch (no reader treats non-'tenant' as
-- public). Tenant isolation holds — the role branch is ANDed inside each
-- reader's existing d.tenant_id scope. Publication stays only via the
-- human-approval-gated apply_improvement.
--
-- The 3 retrieval functions + apply_improvement are reproduced from their LIVE
-- definitions (pg_get_functiondef) + one added branch each — NOT from migration
-- files — so no older-base regression (the 048-vs-059 class) is possible.
-- ═══════════════════════════════════════════════════════════════

-- ── §1 Schema (default-neutral: existing rows/behavior unchanged) ──
alter table knowledge_docs add column if not exists share_archetype_key text;
alter table knowledge_docs drop constraint if exists knowledge_docs_visibility_check;
alter table knowledge_docs add constraint knowledge_docs_visibility_check
  check (visibility in ('tenant','scoped','role'));
comment on column knowledge_docs.share_archetype_key is
  'When visibility=role, the resolve_de_archetype key whose DEs may retrieve this doc. NULL otherwise.';
alter table de_improvements add column if not exists publish_scope text not null default 'de'
  check (publish_scope in ('de','role'));

-- ── §2 Pre-apply scope toggle (human sets it before approval; locked after) ──
create or replace function public.set_improvement_publish_scope(p_improvement_id uuid, p_scope text)
returns void language plpgsql security definer set search_path to 'public' as $function$
declare imp de_improvements;
begin
  if p_scope not in ('de','role') then raise exception 'invalid scope %', p_scope; end if;
  select * into imp from de_improvements where id = p_improvement_id for update;
  if imp.id is null then raise exception 'improvement not found'; end if;
  if auth.uid() is not null and not exists (
      select 1 from profiles p where p.user_id = auth.uid()
      and (p.layer = 'platform' or p.tenant_id = imp.tenant_id)) then
    raise exception 'not authorized';
  end if;
  if imp.status = 'applied' then raise exception 'improvement already published — scope is locked'; end if;
  if imp.status = 'rejected' then raise exception 'improvement was rejected'; end if;
  update de_improvements set publish_scope = p_scope, updated_at = now() where id = p_improvement_id;
end;
$function$;

-- ── §3 apply_improvement (reproduced from live) — role/scoped publish branch ──
CREATE OR REPLACE FUNCTION public.apply_improvement(p_improvement_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare imp de_improvements; v_task_status text; v_doc uuid; v_arch text;
begin
  select * into imp from de_improvements where id = p_improvement_id for update;
  if imp.id is null then raise exception 'improvement not found'; end if;
  if auth.uid() is not null and not exists (
      select 1 from profiles p where p.user_id = auth.uid()
      and (p.layer = 'platform' or p.tenant_id = imp.tenant_id)) then
    raise exception 'not authorized';
  end if;
  if imp.status = 'applied' then return imp.applied_doc_id; end if;
  if imp.status = 'rejected' then raise exception 'improvement was rejected'; end if;

  if imp.human_task_id is null then
    raise exception 'improvement has no review task — call create_improvement_review first';
  end if;
  select status into v_task_status from human_tasks where id = imp.human_task_id;
  if v_task_status is distinct from 'approved' then
    raise exception 'improvement is not human-approved (review task status: %) — a proposed fix can only be published after explicit approval', coalesce(v_task_status, 'missing');
  end if;

  -- T2.2: publish at role scope when the human chose it AND the DE's archetype
  -- resolves; otherwise the unchanged de-scoped path (today's behavior).
  v_arch := case when imp.publish_scope = 'role' then resolve_de_archetype(imp.de_id) end;
  if imp.publish_scope = 'role' and v_arch is not null then
    insert into knowledge_docs (tenant_id, title, content, source, visibility, is_current, tags, share_archetype_key)
    values (imp.tenant_id, imp.proposed_title, imp.proposed_content, 'self_improvement', 'role', true,
            array['self-improvement','team-learning'], v_arch)
    returning id into v_doc;
  else
    insert into knowledge_docs (tenant_id, title, content, source, visibility, is_current, tags)
    values (imp.tenant_id, imp.proposed_title, imp.proposed_content, 'self_improvement', 'scoped', true,
            array['self-improvement'])
    returning id into v_doc;
    insert into knowledge_doc_scopes (tenant_id, doc_id, subject_kind, subject_id)
    values (imp.tenant_id, v_doc, 'de', imp.de_id);
  end if;

  update de_improvements set status = 'applied', applied_doc_id = v_doc, updated_at = now()
   where id = p_improvement_id;

  insert into activity_events (tenant_id, actor, actor_type, event_type, text, confidence)
  select imp.tenant_id, coalesce(d.persona_name, d.name, 'DE'), 'system', 'config_change',
    format('Approved self-improvement published: "%s" (%s). Proposed from a failed answer, verified by replay, human-approved.',
           imp.proposed_title, case when imp.publish_scope = 'role' and v_arch is not null then 'shared with all '||v_arch||' employees' else 'scoped to '||coalesce(d.persona_name, d.name, 'this employee') end),
    coalesce((imp.replay->'after'->>'score')::numeric, 0)
  from digital_employees d where d.id = imp.de_id;

  return v_doc;
end;
$function$;

-- ── §4 Retrieval — reproduce each LIVE def + one role branch + resolver ──

-- §4a visible_knowledge_docs (reproduced from live)
CREATE OR REPLACE FUNCTION public.visible_knowledge_docs(p_tenant_id uuid, p_subject_kind text DEFAULT NULL::text, p_subject_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, title text, content text, tags text[], visibility text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_archetype text;
begin
  if auth.uid() is not null then
    if p_tenant_id not in (select tenant_id from profiles where user_id = auth.uid() and coalesce(is_active, true) = true) then
      raise exception 'tenant access denied';
    end if;
  elsif coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'tenant access denied';
  end if;
  v_archetype := case when p_subject_kind = 'de' and p_subject_id is not null then resolve_de_archetype(p_subject_id) end;
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
      or (d.visibility = 'role' and v_archetype is not null and d.share_archetype_key = v_archetype)
    );
end;
$function$;

-- §4b match_doc_chunks (reproduced from live — keeps is_active + is_current)
CREATE OR REPLACE FUNCTION public.match_doc_chunks(p_tenant_id uuid, p_account_id uuid, p_query_embedding vector, p_match_count integer DEFAULT 5, p_subject_kind text DEFAULT NULL::text, p_subject_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, doc_id uuid, content text, account_id uuid, distance double precision, visibility text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_archetype text;
begin
  if auth.uid() is not null and p_tenant_id not in
     (select tenant_id from profiles where user_id = auth.uid() and coalesce(is_active, true) = true) then
    raise exception 'tenant access denied';
  end if;
  v_archetype := case when p_subject_kind = 'de' and p_subject_id is not null then resolve_de_archetype(p_subject_id) end;
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
      or (d.visibility = 'role' and v_archetype is not null and d.share_archetype_key = v_archetype)
    )
  order by
    (c.account_id is not null and c.account_id = p_account_id) desc,
    c.embedding <=> p_query_embedding
  limit p_match_count;
end;
$function$;

-- §4c hybrid_match_knowledge (reproduced from live — the primary answer path)
CREATE OR REPLACE FUNCTION public.hybrid_match_knowledge(p_tenant_id uuid, p_query_text text, p_account_id uuid DEFAULT NULL::uuid, p_query_embedding vector DEFAULT NULL::vector, p_match_count integer DEFAULT 5, p_subject_kind text DEFAULT NULL::text, p_subject_id uuid DEFAULT NULL::uuid, p_max_distance double precision DEFAULT 0.25)
 RETURNS TABLE(id uuid, doc_id uuid, doc_title text, content text, account_id uuid, visibility text, lexical_rank integer, semantic_rank integer, distance double precision, score double precision)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_archetype text;
begin
  if auth.uid() is not null and p_tenant_id not in
     (select tenant_id from profiles where user_id = auth.uid()) then
    raise exception 'tenant access denied';
  end if;
  v_archetype := case when p_subject_kind = 'de' and p_subject_id is not null then resolve_de_archetype(p_subject_id) end;

  return query
  with visible_docs as (
    select d.id, d.title, d.visibility, d.search_tsv, coalesce(d.authority, 0) as authority
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
      + (coalesce(vd.authority, 0) * 0.002))::double precision as score
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
