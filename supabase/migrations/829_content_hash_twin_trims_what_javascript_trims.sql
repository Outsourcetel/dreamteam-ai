-- 829_content_hash_twin_trims_what_javascript_trims.sql
-- ==========================================================================
-- THE SQL HASH TWIN CLAIMED TO BE BYTE-IDENTICAL TO THE TYPESCRIPT ONE AND
-- WAS NOT, SO DEDUPE STOPPED FINDING DUPLICATES.
--
-- knowledge_normalize_content ended with btrim(x). btrim with ONE argument
-- strips SPACES ONLY. JavaScript's .trim() strips 25 different codepoints,
-- newline and tab among them. Every other step of the two normalizers matches
-- exactly, so the divergence stays invisible until a document's text happens
-- to begin or end with a newline. Then, for the same document:
--
--     TypeScript   sha256(normalize(title || LF LF || 'body'))
--     SQL          sha256(normalize(title || LF LF || 'body' || LF))
--
-- ── WHY THIS IS NOT MERELY AN UNTIDY TEST ────────────────────────────────
-- content_hash is WRITTEN by the TypeScript path (ingest-chunks,
-- connector-hub) and READ BACK by the SQL twin:
--
--     find_duplicate_knowledge_doc(tenant, title, content)
--       SELECT d.id FROM knowledge_docs d
--        WHERE d.content_hash = public.knowledge_content_hash(p_title, p_content)
--
-- When the two disagree that lookup matches nothing, the caller concludes the
-- document is new, and knowledge-ingest-drain and site-import CREATE A SECOND
-- COPY of a document they already had. Silent, and on the ingest path, which
-- is where duplicates are most expensive.
--
-- Measured on production before writing this: 4 of 88 documents with content
-- normalize to text ending in whitespace that btrim does not strip.
--
-- ── WHICH IMPLEMENTATION IS RIGHT ────────────────────────────────────────
-- TypeScript. Not by preference, by custody: it wrote every stored
-- content_hash, so those bytes already carry JavaScript's trim semantics.
-- Moving SQL to match makes the two agree on rows that already exist. Moving
-- TypeScript to match SQL would invalidate every hash in the table.
--
-- The 25 codepoints below were not recalled from the ECMAScript spec. They
-- were enumerated by asking JavaScript which characters .trim() removes —
-- String.fromCharCode(cp).trim() === '' for cp 0..0xFFFF — so the set is
-- derived from the implementation it has to match rather than transcribed from
-- a description of it. This file is generated for the same reason: 24 of the
-- 25 are invisible in an editor and one is a carriage return that a
-- line-ending conversion would silently eat, so every one of them appears as
-- escape text and never as itself.
--
-- ⚠ Nothing structural depends on either function. pg_index, pg_attrdef and
-- pg_constraint were all checked before writing this, because an IMMUTABLE
-- function used in an expression index or a generated column cannot be
-- redefined without corrupting bytes already stored under the old definition.
-- The only dependant is find_duplicate_knowledge_doc, which this repairs.
--
-- content_hash values are deliberately NOT rewritten. content_hash is a
-- watermark of what was last EMBEDDED, not a derived property of the current
-- row: a document edited since its last embed SHOULD carry a hash that no
-- longer matches its text, because that mismatch is what triggers re-embedding.
-- ==========================================================================

begin;

create or replace function public.knowledge_normalize_content(p_text text)
returns text
language sql
immutable
as $fn$
  SELECT btrim(
           regexp_replace(                                    -- \n{3,}  -> \n\n
             regexp_replace(                                  -- ' *\n *' -> \n
               regexp_replace(                                -- [ \t]+  -> ' '
                 regexp_replace(                              -- \r\n?   -> \n
                   normalize(coalesce(p_text, ''), NFC),
                   E'\r\n?', E'\n', 'g'),
                 E'[ \t]+', ' ', 'g'),
               E' *\n *', E'\n', 'g'),
             E'\n{3,}', E'\n\n', 'g'),
           -- ⛔ THE SECOND ARGUMENT IS THE ENTIRE FIX. Without it btrim strips
           -- spaces only, and the twin diverges from JavaScript's .trim().
           E'\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF');
$fn$;

-- Unchanged in shape, restated where the definition changed so the perimeter is
-- visible at the point of edit rather than only back in migration 352.
revoke all on function public.knowledge_normalize_content(text) from public;
revoke all on function public.knowledge_normalize_content(text) from anon;
grant execute on function public.knowledge_normalize_content(text) to authenticated;
grant execute on function public.knowledge_normalize_content(text) to service_role;

-- ── proof ─────────────────────────────────────────────────────────────────
-- GOLDEN VECTORS, not production rows. Every expected value below was produced
-- by running the REAL TypeScript implementation
-- (supabase/functions/_shared/contentHash.ts) over the same input, so this
-- asserts agreement with the thing that has to agree — and it asserts it about
-- literals, so it holds on an empty database and replays in any environment.
do $verify$
declare
  -- contentHash('T' || LF LF || 'body')                  — all five trimming cases collapse here
  v_plain constant text := 'c9ca2053d78dcad5c2d402046f90f8cbc9d1a564c2348bd192e289aff55facca';
  -- contentHash('T' || LF LF || NBSP || 'body')          — NBSP trimmed at the end, kept at the front
  v_nbsp  constant text := '64c2010c5d368a1f34f71ec3a4debacb3a0270929a98bffba2890cafa95298b6';
  -- contentHash('T' || LF LF || BOM || 'body')           — ideographic space trimmed, interior BOM survives
  v_bom   constant text := '289e577d544f808fb6be91bcc22f4a11ba7368314af9299537e0ca15b12fb226';
  -- contentHash('T' || LF LF || 'a' || LF || 'b')        — interior newline survives
  v_inner constant text := '009d91d80a62535319a9f37b376131deb9f163bbdd8faa6572d182e181b465aa';
  v_got   text;
begin
  -- (a) the case that was actually broken in production
  v_got := public.knowledge_content_hash('T', E'body\u000A');
  if v_got <> v_plain then
    raise exception 'VERIFY FAILED: trailing newline still diverges from TypeScript — got %, want %', v_got, v_plain;
  end if;

  -- (b) the other end, and the other ASCII members of the set
  if public.knowledge_content_hash('T', E'\u000Abody') <> v_plain then
    raise exception 'VERIFY FAILED: leading newline diverges from TypeScript';
  end if;
  if public.knowledge_content_hash('T', E'body\u0009') <> v_plain then
    raise exception 'VERIFY FAILED: trailing tab diverges from TypeScript';
  end if;
  if public.knowledge_content_hash('T', E'body\u000C') <> v_plain then
    raise exception 'VERIFY FAILED: trailing form feed diverges from TypeScript';
  end if;
  if public.knowledge_content_hash('T', E'body') <> v_plain then
    raise exception 'VERIFY FAILED: text needing no trimming diverges from TypeScript';
  end if;

  -- (c) the unicode end of the set, which a hand-written ' \t\n\r' would miss.
  --     Both vectors also pin that trimming touches ONLY the ends: the NBSP and
  --     the BOM sitting just after the title separator have to survive.
  if public.knowledge_content_hash('T', E'\u00A0body\u00A0') <> v_nbsp then
    raise exception 'VERIFY FAILED: non-breaking space is not trimmed the way JavaScript trims it';
  end if;
  if public.knowledge_content_hash('T', E'\uFEFFbody\u3000') <> v_bom then
    raise exception 'VERIFY FAILED: ideographic space is not trimmed, or the interior BOM did not survive';
  end if;

  -- (d) ⛔ THE INVERSION. Five of the assertions above compare against ONE
  --     constant, so a function returning that constant for every input would
  --     satisfy all of them. These prove the comparisons are live.
  if public.knowledge_content_hash('T', 'body') = public.knowledge_content_hash('T', 'other') then
    raise exception 'VERIFY FAILED: different content hashes the same — every check above proves nothing';
  end if;
  if public.knowledge_content_hash('T', E'a\u000Ab') <> v_inner then
    raise exception 'VERIFY FAILED: an interior newline was altered — trimming has become deletion';
  end if;
  if public.knowledge_normalize_content(E'\u000Aa\u00A0b\u000A') <> E'a\u00A0b' then
    raise exception 'VERIFY FAILED: the interior NBSP did not survive a trim of both ends';
  end if;

  -- (e) the OLD behaviour, stated as the thing that must no longer be true.
  --     One-argument btrim leaves a trailing newline, so if this passes the
  --     replacement did not take and everything above ran on the old body.
  if public.knowledge_normalize_content(E'a\u000A') <> 'a' then
    raise exception 'VERIFY FAILED: a trailing newline survived normalization — one-argument btrim is still in place';
  end if;
end
$verify$;

commit;
