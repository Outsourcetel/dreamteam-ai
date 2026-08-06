-- 615 — drop the retrieval path nobody calls.
--
-- Found while checking whether archived knowledge can still be retrieved.
-- Four functions can return knowledge documents:
--
--   hybrid_match_knowledge   filters lifecycle_status   <- the DE retrieval path
--   search_knowledge_docs    filters lifecycle_status   <- the app's search
--   search_knowledge         does NOT filter            <- called only by
--                                                          search_knowledge_docs,
--                                                          which filters around it
--   match_knowledge_chunks   does NOT filter            <- NO CALLER AT ALL
--
-- match_knowledge_chunks has no SQL caller, no edge-function caller and no
-- frontend caller. The only references left are the generated types file and
-- the baseline schema dump, neither of which invokes anything.
--
-- So it is dead code that also happens to be the one retrieval path with no
-- lifecycle filter — a way to surface an archived document that nothing uses
-- but anything could start using. Dropping it removes both at once.
--
-- ⚠ NOT dropping search_knowledge: it is reached through search_knowledge_docs,
-- which applies the lifecycle filter itself. Its own lack of a filter is safe
-- only because of that wrapper — worth knowing, not worth churning.

begin;

do $verify$
declare v_callers int;
begin
  -- Prove it is unreferenced by any OTHER function before removing it. A
  -- "nobody calls this" claim that is wrong deletes a live path.
  select count(*) into v_callers
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind = 'f'
    and p.proname <> 'match_knowledge_chunks'
    and pg_get_functiondef(p.oid) ~ 'match_knowledge_chunks';
  if v_callers > 0 then
    raise exception '% function(s) still call match_knowledge_chunks — refusing to drop', v_callers;
  end if;
end;
$verify$;

drop function if exists match_knowledge_chunks(vector, uuid, double precision, integer);

do $verify$
declare
  v_left int;
  v_keep int;
begin
  select count(*) into v_left from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'match_knowledge_chunks';
  if v_left > 0 then
    raise exception 'match_knowledge_chunks survived — the signature did not match (a drop with the wrong arg types is a SILENT no-op)';
  end if;

  -- The retrieval paths that ARE used must still be here.
  select count(*) into v_keep from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in
    ('hybrid_match_knowledge', 'search_knowledge_docs', 'search_knowledge');
  if v_keep < 3 then
    raise exception 'a live retrieval function went missing (% of 3 left)', v_keep;
  end if;

  raise notice 'dead unfiltered retrieval path removed; the 3 live ones intact';
end;
$verify$;

commit;
