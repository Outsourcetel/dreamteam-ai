-- 481_server_side_chunking_for_improvement_publishes.sql
-- ============================================================================
-- A doc published without chunks is PERMANENTLY keyword-only, silently.
--
-- Retrieval reads knowledge_doc_chunks. Chunking happens in the ingest-chunks
-- edge function, which is called from exactly three CLIENT files — none of
-- them the self-improvement path. apply_improvement inserts knowledge_docs
-- (+ scopes) and never chunks; it fires from trigger sync_improvement_decision,
-- entirely server-side, with no client to compensate. And nothing in the
-- platform hunts for docs with zero chunks: embed-backfill sweeps only chunks
-- that EXIST (embedding IS NULL), knowledge-ingest-drain works from an
-- explicit queue. So the failure is invisible — the publish SUCCEEDS, the
-- article exists, and semantic retrieval just never sees it.
--
-- Why never seen: zero improvements ever reached 'applied' — the eval gate
-- blocked the first-ever approval until it went green on 2026-07-28. Without
-- this fix, the very next approved improvement publishes a silently-dead
-- article.
--
-- apply_knowledge_revision has the same shape; its one live caller is the
-- browser (knowledgeApi.resolveKnowledgeRevision), which compensates by
-- calling ingest-chunks afterwards — but a service-role caller has no client.
-- Fixed in the same pass. The browser's follow-up call is UNAFFECTED: with
-- the content hash stamped and rows present, ingest-chunks' unchanged check
-- makes it a no-op that goes straight to embedding (and if the SQL hash ever
-- disagrees on some unicode edge, it merely re-chunks once — same end state).
--
-- What this migration does:
--   1. Ports the house splitter (ingest-chunks chunkText: 1500 chars, 200
--      overlap, paragraph-then-sentence-then-space cuts) and the house
--      content hash (contentHash.ts normalization) to SQL, as internal
--      functions nobody can call from a client.
--   2. Adds one chunking call to apply_improvement and one to
--      apply_knowledge_revision — patched against the LIVE definitions with
--      exact-count anchors, refusing to guess if the bodies drifted.
--   3. Backfills every CURRENT zero-chunk doc (one exists today: mynd's
--      "Rent Ready Standards", source=connector — proof this class is not
--      hypothetical). Archived non-current docs are left untouched.
--   4. Proves the fix behaviourally: a fixture improvement is approved and
--      published through the REAL apply_improvement under the service-role
--      claim (the unattended worker context), the published doc is asserted
--      to have >= 1 chunk with NULL embeddings — then the whole fixture is
--      rolled back via a deliberate subtransaction abort, leaving nothing.
--
-- Embeddings are deliberately NOT computed here: chunks land with NULL
-- embeddings and the embed-backfill cron (every 2 min, no source filter)
-- drains them. That is the proven division of labour.
--
-- ⚠ The assert that catches this class is "the published doc has >= 1 chunk",
-- never "the insert returned an id" — the publish succeeding is exactly what
-- makes the defect invisible.
-- ============================================================================


-- ── 1a. lastIndexOf, 0-indexed, -1 when absent (JS parity) ──────────────────
create or replace function public.last_index_of_internal(p_hay text, p_needle text)
returns integer
language sql immutable
as $fn$
  select case
    when p_hay is null or p_needle is null or p_needle = '' then -1
    when position(reverse(p_needle) in reverse(p_hay)) = 0 then -1
    else length(p_hay) - length(p_needle)
         - (position(reverse(p_needle) in reverse(p_hay)) - 1)
  end
$fn$;
revoke all on function public.last_index_of_internal(text, text) from public, anon, authenticated;

-- ── 1b. The house splitter, ported line-for-line from ingest-chunks ─────────
-- chunkText: ~1500-char chunks with ~200 overlap; each cut prefers a paragraph
-- break, then a sentence end, then a space — searched from the back of the
-- window, accepted only past 40% (600 chars). 0-indexed positions throughout
-- to mirror the JS. (Known, accepted drift: JS measures UTF-16 code units,
-- SQL measures characters — astral-plane text lands cuts a few chars apart.)
create or replace function public.chunk_doc_text_internal(p_text text)
returns text[]
language plpgsql immutable
as $fn$
declare
  v_clean text := regexp_replace(coalesce(p_text, ''), '^\s+|\s+$', '', 'g');
  v_len   int;
  v_out   text[] := '{}';
  v_start int := 0;
  v_end   int;
  v_window text;
  v_para  int; v_sent int; v_space int; v_cut int;
  v_piece text;
begin
  if v_clean = '' then return v_out; end if;
  v_len := length(v_clean);
  if v_len <= 1500 then return array[v_clean]; end if;

  while v_start < v_len loop
    v_end := least(v_start + 1500, v_len);
    if v_end < v_len then
      v_window := substr(v_clean, v_start + 1, 1500);
      v_para := public.last_index_of_internal(v_window, chr(10) || chr(10));
      v_sent := greatest(
        public.last_index_of_internal(v_window, '. '),
        public.last_index_of_internal(v_window, '.' || chr(10)),
        public.last_index_of_internal(v_window, '! '),
        public.last_index_of_internal(v_window, '? '));
      v_space := public.last_index_of_internal(v_window, ' ');
      v_cut := case
        when v_para  > 600 then v_para
        when v_sent  > 600 then v_sent + 1
        when v_space > 600 then v_space
        else length(v_window)
      end;
      v_end := v_start + v_cut;
    end if;
    v_piece := regexp_replace(substr(v_clean, v_start + 1, v_end - v_start), '^\s+|\s+$', '', 'g');
    if v_piece <> '' then v_out := v_out || v_piece; end if;
    exit when v_end >= v_len;
    v_start := greatest(v_end - 200, v_start + 1);
  end loop;
  return v_out;
end $fn$;
revoke all on function public.chunk_doc_text_internal(text) from public, anon, authenticated;

-- ── 1c. The house content hash (contentHash.ts parity) ──────────────────────
-- sha256 hex over normalized text: NFC, CRLF→LF, collapse horizontal
-- whitespace runs, trim spaces around newlines, collapse 3+ newlines, trim.
-- Stamping this lets a later client re-ingest of unchanged content no-op.
create or replace function public.normalized_content_hash_internal(p_text text)
returns text
language sql immutable
as $fn$
  select encode(extensions.digest(
    regexp_replace(
    regexp_replace(
    regexp_replace(
    regexp_replace(
    regexp_replace(normalize(coalesce(p_text, ''), NFC),
      '\r\n?',     chr(10),            'g'),
      '[ \t]+',    ' ',                'g'),
      ' *\n *',    chr(10),            'g'),
      '\n{3,}',    chr(10) || chr(10), 'g'),
      '^\s+|\s+$', '',                 'g'),
    'sha256'), 'hex')
$fn$;
revoke all on function public.normalized_content_hash_internal(text) from public, anon, authenticated;

-- ── 1d. Chunk one knowledge doc, exactly the way ingest-chunks would ────────
-- Chunks title + blank line + content (the ingest-chunks call shape), inserts
-- with NULL embeddings for embed-backfill to drain, stamps the doc's
-- content_hash. NEVER duplicates: a doc that already has chunks keeps them
-- (the backfill-needs-a-not-exists-guard rule). Not SECURITY DEFINER — it
-- inherits the calling function's context and is not client-executable.
create or replace function public.chunk_knowledge_doc_internal(p_doc_id uuid)
returns integer
language plpgsql
as $fn$
declare
  d record;
  v_text  text;
  v_parts text[];
  v_n     int;
begin
  select id, tenant_id, account_id, title, content into d
    from knowledge_docs where id = p_doc_id;
  if d.id is null then
    raise warning 'chunk_knowledge_doc_internal: doc % not found', p_doc_id;
    return 0;
  end if;

  select count(*) into v_n from knowledge_doc_chunks where doc_id = d.id;
  if v_n > 0 then return v_n; end if;

  v_text  := coalesce(d.title, '') || chr(10) || chr(10) || coalesce(d.content, '');
  v_parts := public.chunk_doc_text_internal(v_text);
  if coalesce(array_length(v_parts, 1), 0) = 0 then return 0; end if;

  insert into knowledge_doc_chunks (tenant_id, account_id, doc_id, chunk_index, content, embedding)
  select d.tenant_id, d.account_id, d.id, i - 1, v_parts[i], null
    from generate_subscripts(v_parts, 1) as i;

  update knowledge_docs
     set content_hash = public.normalized_content_hash_internal(v_text)
   where id = d.id;

  return array_length(v_parts, 1);
end $fn$;
revoke all on function public.chunk_knowledge_doc_internal(uuid) from public, anon, authenticated;


-- ── 2a. Patch apply_improvement against its LIVE definition ─────────────────
do $patch_imp$
declare
  v_src text; v_new text; v_eol text; v_hits int;
  a_anchor text := $a$update de_improvements set status = 'applied', applied_doc_id = v_doc, updated_at = now()$a$;
  v_add text;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'apply_improvement';
  if v_src is null then raise exception '481: apply_improvement not found'; end if;

  if v_src ilike '%chunk_knowledge_doc_internal%' then
    raise notice '481: apply_improvement already chunks, nothing to do';
    return;
  end if;

  v_eol := case when position(chr(13) || chr(10) in v_src) > 0
                then chr(13) || chr(10) else chr(10) end;

  -- Placed after BOTH insert branches (v_doc is set either way) and before the
  -- applied-status stamp, all inside the same transaction.
  v_add := array_to_string(ARRAY[
    '-- Chunk the published doc NOW, server-side (mig 481): this path fires from',
    '  -- a trigger with no client to compensate, and nothing in the platform hunts',
    '  -- for docs with zero chunks — unchunked here means keyword-only retrieval',
    '  -- forever. Embeddings stay NULL; embed-backfill drains them within minutes.',
    '  perform public.chunk_knowledge_doc_internal(v_doc);',
    '',
    '  '], v_eol);

  v_hits := (length(v_src) - length(replace(v_src, a_anchor, ''))) / length(a_anchor);
  if v_hits <> 1 then
    raise exception '481: expected exactly 1 applied-status anchor in apply_improvement, found % — the body changed, refusing to guess', v_hits;
  end if;

  v_new := replace(v_src, a_anchor, v_add || a_anchor);
  if v_new = v_src then
    raise exception '481: apply_improvement replacement produced an identical body — the edit did not land';
  end if;
  execute v_new;
end $patch_imp$;

-- ── 2b. Patch apply_knowledge_revision against its LIVE definition ──────────
do $patch_rev$
declare
  v_src text; v_new text; v_eol text; v_hits int;
  a_anchor text := 'returning id into v_new_doc_id;';
  v_add text;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'apply_knowledge_revision';
  if v_src is null then raise exception '481: apply_knowledge_revision not found'; end if;

  if v_src ilike '%chunk_knowledge_doc_internal%' then
    raise notice '481: apply_knowledge_revision already chunks, nothing to do';
    return;
  end if;

  v_eol := case when position(chr(13) || chr(10) in v_src) > 0
                then chr(13) || chr(10) else chr(10) end;

  v_add := array_to_string(ARRAY[
    '',
    '',
    '  -- Chunk server-side (mig 481): a service-role caller has no compensating',
    '  -- client; the browser caller''s follow-up ingest sees matching hash plus',
    '  -- existing rows and no-ops straight into embedding.',
    '  perform public.chunk_knowledge_doc_internal(v_new_doc_id);'], v_eol);

  v_hits := (length(v_src) - length(replace(v_src, a_anchor, ''))) / length(a_anchor);
  if v_hits <> 1 then
    raise exception '481: expected exactly 1 returning-anchor in apply_knowledge_revision, found % — the body changed, refusing to guess', v_hits;
  end if;

  v_new := replace(v_src, a_anchor, a_anchor || v_add);
  if v_new = v_src then
    raise exception '481: apply_knowledge_revision replacement produced an identical body — the edit did not land';
  end if;
  execute v_new;
end $patch_rev$;


-- ── 3. Backfill: every CURRENT doc with zero chunks, with a delta assert ────
-- Today that is one doc (mynd "Rent Ready Standards", source=connector) —
-- live proof the zero-chunk class exists outside the improvement path too.
-- Archived non-current docs (one, in suspended acme-telecom) stay untouched:
-- retrieval does not serve them, and chunking history is not a repair.
do $backfill$
declare
  v_before int; v_after int; v_added int := 0; r record;
begin
  select count(*) into v_before
    from knowledge_docs d
   where d.is_current
     and regexp_replace(coalesce(d.title,'') || chr(10) || chr(10) || coalesce(d.content,''), '^\s+|\s+$', '', 'g') <> ''
     and not exists (select 1 from knowledge_doc_chunks c where c.doc_id = d.id);

  for r in
    select d.id
      from knowledge_docs d
     where d.is_current
       and regexp_replace(coalesce(d.title,'') || chr(10) || chr(10) || coalesce(d.content,''), '^\s+|\s+$', '', 'g') <> ''
       and not exists (select 1 from knowledge_doc_chunks c where c.doc_id = d.id)
  loop
    v_added := v_added + public.chunk_knowledge_doc_internal(r.id);
  end loop;

  select count(*) into v_after
    from knowledge_docs d
   where d.is_current
     and regexp_replace(coalesce(d.title,'') || chr(10) || chr(10) || coalesce(d.content,''), '^\s+|\s+$', '', 'g') <> ''
     and not exists (select 1 from knowledge_doc_chunks c where c.doc_id = d.id);

  -- Would this pass if the backfill were broken? No — after must hit zero.
  if v_after <> 0 then
    raise exception '481: backfill left % current docs with zero chunks', v_after;
  end if;
  -- Would this pass on a no-op? No, when there was work to do — the delta
  -- demands at least one chunk row per doc that needed them. (On a re-run
  -- v_before is 0 and there is legitimately nothing to add.)
  if v_before > 0 and v_added < v_before then
    raise exception '481: delta assert — % docs needed chunks but only % chunk rows were added', v_before, v_added;
  end if;
  raise notice '481: backfill — % current zero-chunk docs found, % chunk rows added (NULL embeddings; embed-backfill drains them)', v_before, v_added;
end $backfill$;


-- ── 4a. Splitter + hash proofs (pure functions, deterministic, no fixtures) ─
do $split_proof$
declare
  v text := ''; c text[]; i int; v_trimmed text;
begin
  if coalesce(array_length(public.chunk_doc_text_internal(null), 1), 0) <> 0
     or coalesce(array_length(public.chunk_doc_text_internal('   '), 1), 0) <> 0 then
    raise exception '481: empty/whitespace text must yield no chunks';
  end if;

  c := public.chunk_doc_text_internal('  short doc  ');
  if array_length(c, 1) <> 1 or c[1] <> 'short doc' then
    raise exception '481: short text must yield exactly itself, trimmed';
  end if;

  for i in 1..40 loop
    v := v || 'Sentence number ' || i || ' of the splitter proof, padded with regular words to sit near ninety characters. ';
  end loop;
  c := public.chunk_doc_text_internal(v);
  if coalesce(array_length(c, 1), 0) < 2 then
    raise exception '481: ~3800-char text produced % chunks — the splitter did not split', coalesce(array_length(c, 1), 0);
  end if;
  for i in 1..array_length(c, 1) loop
    if length(c[i]) > 1500 then raise exception '481: chunk % exceeds 1500 chars (%)', i, length(c[i]); end if;
  end loop;
  v_trimmed := regexp_replace(v, '^\s+|\s+$', '', 'g');
  if position(left(v_trimmed, 60) in c[1]) <> 1 then
    raise exception '481: first chunk does not open the text';
  end if;
  if position(right(v_trimmed, 60) in c[array_length(c, 1)]) = 0 then
    raise exception '481: last chunk does not carry the text''s end — coverage is broken';
  end if;
  if position(left(c[2], 40) in c[1]) = 0 then
    raise exception '481: chunk 2''s head is absent from chunk 1 — the 200-char overlap is broken';
  end if;

  if public.normalized_content_hash_internal('a  b' || chr(13) || chr(10) || 'c')
     <> public.normalized_content_hash_internal('a b' || chr(10) || 'c') then
    raise exception '481: hash must collapse whitespace-only differences (contentHash.ts parity)';
  end if;
  if public.normalized_content_hash_internal('a b') = public.normalized_content_hash_internal('a c') then
    raise exception '481: different content must hash differently';
  end if;
end $split_proof$;

-- ── 4b. Behavioural proof through the REAL path, then roll it all back ──────
-- A fixture improvement is human-task-approved and published via the actual
-- apply_improvement under the service-role claim — the unattended worker
-- context (auth.uid() NULL, so profile/tenant checks skip; can_access_de and
-- the publish gate both pass by role name, exactly as in production). The
-- deliberate exception aborts the subtransaction: doc, chunks, scope row,
-- activity event, fixture rows — all gone. plpgsql variables survive the
-- abort, so the measurements escape while the data does not.
do $proof$
declare
  v_tenant uuid; v_de uuid; v_task uuid; v_imp uuid; v_doc uuid;
  v_chunks int := -1;
  v_null_embeddings boolean := true;
  v_hash text;
  v_scoped boolean := false;
begin
  begin
    perform set_config('request.jwt.claim.role', 'service_role', true);
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

    select d.tenant_id, d.id into v_tenant, v_de
      from digital_employees d join tenants t on t.id = d.tenant_id
     where d.status = 'active' and t.slug = 'outsourcetel-hq'
     order by d.created_at limit 1;
    if v_de is null then
      select d.tenant_id, d.id into v_tenant, v_de
        from digital_employees d where d.status = 'active'
       order by d.created_at limit 1;
    end if;
    if v_de is null then
      raise exception '481: no active digital employee anywhere — cannot run the behavioural proof';
    end if;

    insert into human_tasks (tenant_id, title, status)
    values (v_tenant, 'mig-481 behavioural proof (rolls back)', 'approved')
    returning id into v_task;

    insert into de_improvements
      (tenant_id, de_id, failure_question, proposed_title, proposed_content, human_task_id, status)
    values
      (v_tenant, v_de,
       'mig-481 proof: does an improvement publish get retrieval coverage?',
       'Mig-481 proof article (rolls back)',
       repeat('The refund window for annual plans is thirty days from the invoice date. ', 30),
       v_task, 'review_pending')
    returning id into v_imp;

    v_doc := public.apply_improvement(v_imp);

    select count(*), coalesce(bool_and(embedding is null), true)
      into v_chunks, v_null_embeddings
      from knowledge_doc_chunks where doc_id = v_doc;
    select content_hash into v_hash from knowledge_docs where id = v_doc;
    v_scoped := exists (select 1 from knowledge_doc_scopes where doc_id = v_doc);

    raise exception 'FIXTURE_ROLLBACK_481';
  exception when others then
    if sqlerrm <> 'FIXTURE_ROLLBACK_481' then raise; end if;
  end;

  -- The catching assert: the published doc has chunks — not merely an id.
  if v_chunks < 1 then
    raise exception '481: improvement publish produced % retrieval chunks — the defect is NOT fixed', v_chunks;
  end if;
  if not v_null_embeddings then
    raise exception '481: fixture chunks arrived with embeddings — expected NULL for embed-backfill to drain';
  end if;
  if v_hash is null then
    raise exception '481: published doc was not hash-stamped — a later client re-ingest would re-chunk needlessly';
  end if;
  if not v_scoped then
    raise exception '481: the de-scoped publish path lost its scope row — a prior contract broke';
  end if;
  if exists (select 1 from de_improvements where id = v_imp)
     or exists (select 1 from human_tasks where id = v_task) then
    raise exception '481: fixture rows survived — the rollback did not happen';
  end if;
  raise notice '481: behavioural proof — approved improvement published with % chunks (NULL embeddings), hash-stamped, scope row intact; fixture fully rolled back', v_chunks;
end $proof$;


-- ── 5. Definition + privilege asserts ───────────────────────────────────────
do $assert$
declare v_def text; n int;
begin
  -- The create-across-arities trap: both patched functions stay single-arity.
  select count(*) into n from pg_proc
   where pronamespace = 'public'::regnamespace and proname = 'apply_improvement';
  if n <> 1 then raise exception '481: apply_improvement has % arities', n; end if;
  select count(*) into n from pg_proc
   where pronamespace = 'public'::regnamespace and proname = 'apply_knowledge_revision';
  if n <> 1 then raise exception '481: apply_knowledge_revision has % arities', n; end if;

  select pg_get_functiondef(oid) into v_def from pg_proc
   where pronamespace = 'public'::regnamespace and proname = 'apply_improvement';
  n := (length(v_def) - length(replace(v_def, 'chunk_knowledge_doc_internal(', ''))) / length('chunk_knowledge_doc_internal(');
  if n <> 1 then raise exception '481: apply_improvement expected exactly 1 chunking call, found %', n; end if;
  if position('chunk_knowledge_doc_internal' in v_def) < position('knowledge_doc_scopes' in v_def)
     or position('chunk_knowledge_doc_internal' in v_def) > position('update de_improvements' in v_def) then
    raise exception '481: chunking call is not between the doc inserts and the applied-status update';
  end if;
  if v_def not like '%is not human-approved%' or v_def not like '%can_access_de%' then
    raise exception '481: apply_improvement lost prior guarantees — a stale body was applied';
  end if;

  select pg_get_functiondef(oid) into v_def from pg_proc
   where pronamespace = 'public'::regnamespace and proname = 'apply_knowledge_revision';
  n := (length(v_def) - length(replace(v_def, 'chunk_knowledge_doc_internal(', ''))) / length('chunk_knowledge_doc_internal(');
  if n <> 1 then raise exception '481: apply_knowledge_revision expected exactly 1 chunking call, found %', n; end if;
  if position('chunk_knowledge_doc_internal' in v_def) < position('insert into knowledge_docs' in v_def)
     or position('chunk_knowledge_doc_internal' in v_def) > position('update knowledge_revision_requests' in v_def) then
    raise exception '481: revision chunking call is not between the doc insert and the request update';
  end if;
  if v_def not like '%pending_approval%' then
    raise exception '481: apply_knowledge_revision lost prior guarantees — a stale body was applied';
  end if;

  -- None of the new internals may be client-executable (REVOKE-from-PUBLIC
  -- rule — Postgres grants EXECUTE to PUBLIC on every new function).
  if has_function_privilege('anon', 'public.chunk_knowledge_doc_internal(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.chunk_knowledge_doc_internal(uuid)', 'execute')
     or has_function_privilege('anon', 'public.chunk_doc_text_internal(text)', 'execute')
     or has_function_privilege('authenticated', 'public.chunk_doc_text_internal(text)', 'execute')
     or has_function_privilege('anon', 'public.normalized_content_hash_internal(text)', 'execute')
     or has_function_privilege('authenticated', 'public.normalized_content_hash_internal(text)', 'execute')
     or has_function_privilege('anon', 'public.last_index_of_internal(text, text)', 'execute')
     or has_function_privilege('authenticated', 'public.last_index_of_internal(text, text)', 'execute') then
    raise exception '481: an internal chunking function is client-executable — a REVOKE did not land';
  end if;

  raise notice '481: server-side chunking live on both publish paths; improvement-published articles now reach retrieval.';
end $assert$;

notify pgrst, 'reload schema';
