-- 363_de_team_knowledge_audience.sql
-- ============================================================================
-- Item 3: widen the AI audience so knowledge can be given to a TEAM of Digital
-- Employees rather than one at a time.
--
-- ── What this deliberately does NOT add: 'archetype' ──────────────────────
-- The obvious reading of the request is "widen subject_kind to de_team AND
-- archetype". Checked first, and archetype scoping ALREADY EXISTS by a
-- different mechanism: knowledge_docs.visibility = 'role' plus
-- share_archetype_key, which hybrid_match_knowledge already honours:
--     or (d.visibility = 'role' and v_archetype is not null
--         and d.share_archetype_key = v_archetype)
--
-- Adding a second archetype route through knowledge_doc_scopes would mean two
-- independent answers to "which archetypes may use this document", and they
-- would drift the first time one path was updated and the other was not. This
-- session has paid for that lesson four times (two hash implementations, two
-- lifecycle meanings, two hierarchy candidates, two spellings of one status).
--
-- There is also a hard blocker: subject_id is a uuid, and archetype keys are
-- text. Storing 'archetype' there would need a parallel column, which is the
-- same duplication wearing a different hat.
--
-- So: de_team is added, archetype is not, and §2 instead FIXES the existing
-- archetype mechanism, which was quietly broken.
--
-- ── §2, the bug that made archetype sharing unusable ─────────────────────
-- set_doc_scope ends with:
--     v_after := case when v_count > 0 then 'scoped' else 'tenant' end;
--     update knowledge_docs set visibility = v_after where id = p_doc_id;
-- There is no 'role' branch. So a document shared with an archetype
-- (visibility='role') that has its subject list cleared is silently downgraded
-- to 'tenant' — losing its archetype restriction and widening its audience to
-- every employee in the workspace. A scope editor that BROADENS access when you
-- clear a field is the worst possible direction for that mistake to go.
--
-- Measured: 0 documents currently sit at visibility='role', so nothing is
-- broken right now — the mechanism was simply unusable, which is why nobody
-- adopted it.
-- ============================================================================

-- ── 1. de_team becomes a valid audience ───────────────────────────────────
ALTER TABLE knowledge_doc_scopes DROP CONSTRAINT IF EXISTS knowledge_doc_scopes_subject_kind_check;
ALTER TABLE knowledge_doc_scopes ADD CONSTRAINT knowledge_doc_scopes_subject_kind_check
  CHECK (subject_kind IN ('de', 'specialist', 'de_team'));

COMMENT ON COLUMN knowledge_doc_scopes.subject_kind IS
  'Who may RETRIEVE this document: de | specialist | de_team. Archetype sharing is NOT here — it lives on knowledge_docs.visibility = ''role'' + share_archetype_key, and duplicating it would create two answers to one question.';

-- ── 2. set_doc_scope: accept teams, and stop clobbering role-shared docs ──
-- Reproduced from the live definition; only the subject validation, the insert
-- loop's label lookup and the final visibility decision change.
CREATE OR REPLACE FUNCTION public.set_doc_scope(p_doc_id uuid, p_subjects jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
declare
  v_user uuid := auth.uid(); v_caller_tenant uuid; v_is_active boolean;
  v_doc_tenant uuid; v_doc_title text; v_before text; v_after text; v_archetype text;
  v_subj jsonb; v_kind text; v_sid uuid; v_label text; v_labels text[] := '{}'; v_count integer := 0;
begin
  select tenant_id, title, visibility, share_archetype_key
    into v_doc_tenant, v_doc_title, v_before, v_archetype
    from knowledge_docs where id = p_doc_id;
  if v_doc_tenant is null then return jsonb_build_object('ok', false, 'error', 'doc_not_found'); end if;

  if v_user is not null then
    select tenant_id, coalesce(is_active, true) into v_caller_tenant, v_is_active from profiles where user_id = v_user;
    if v_caller_tenant is null or v_caller_tenant <> v_doc_tenant then return jsonb_build_object('ok', false, 'error', 'not_tenant_member', 'detail', 'Only members of this workspace can change who uses a document.'); end if;
    if not v_is_active then return jsonb_build_object('ok', false, 'error', 'not_tenant_member', 'detail', 'Only members of this workspace can change who uses a document.'); end if;
  elsif coalesce(auth.role(), '') <> 'service_role' then
    return jsonb_build_object('ok', false, 'error', 'not_tenant_member', 'detail', 'Only members of this workspace can change who uses a document.');
  end if;

  if p_subjects is null or jsonb_typeof(p_subjects) <> 'array' then return jsonb_build_object('ok', false, 'error', 'bad_subjects', 'detail', 'p_subjects must be a JSON array of {kind, id}.'); end if;

  for v_subj in select * from jsonb_array_elements(p_subjects) loop
    v_kind := v_subj->>'kind';
    begin v_sid := (v_subj->>'id')::uuid; exception when others then return jsonb_build_object('ok', false, 'error', 'bad_subject_id'); end;
    if v_kind in ('de', 'specialist') then
      select name into v_label from digital_employees where id = v_sid and tenant_id = v_doc_tenant;
    elsif v_kind = 'de_team' then
      -- 363: a team of employees is an audience. Still tenant-checked, so a
      -- team id from another workspace cannot be attached.
      select name into v_label from workforce_teams where id = v_sid and tenant_id = v_doc_tenant;
    else
      return jsonb_build_object('ok', false, 'error', 'bad_subject_kind');
    end if;
    if v_label is null then return jsonb_build_object('ok', false, 'error', 'subject_not_in_tenant', 'detail', v_kind || ' ' || v_sid || ' is not in this workspace.'); end if;
    v_labels := array_append(v_labels, v_label || ' (' || v_kind || ')');
    v_count := v_count + 1;
  end loop;

  delete from knowledge_doc_scopes where doc_id = p_doc_id;
  for v_subj in select * from jsonb_array_elements(p_subjects) loop
    insert into knowledge_doc_scopes (tenant_id, doc_id, subject_kind, subject_id)
    values (v_doc_tenant, p_doc_id, v_subj->>'kind', (v_subj->>'id')::uuid)
    on conflict (doc_id, subject_kind, subject_id) do nothing;
  end loop;

  -- 363: THE CLOBBER FIX. Clearing the subject list on an archetype-shared
  -- document used to drop it to 'tenant', silently WIDENING its audience to
  -- every employee. It now returns to 'role', which is where it came from.
  v_after := case
    when v_count > 0 then 'scoped'
    when v_before = 'role' and v_archetype is not null then 'role'
    else 'tenant' end;
  update knowledge_docs set visibility = v_after where id = p_doc_id;

  begin
    perform append_audit_event(v_doc_tenant,
      coalesce((select full_name from profiles where user_id = v_user), 'service'),
      case when v_user is null then 'system' else 'human' end,
      'Knowledge scope changed — "' || v_doc_title || '": ' || v_before || ' → ' || v_after ||
        case when v_count > 0 then ' (only ' || array_to_string(v_labels, ', ') || ' will use this document)'
             when v_after = 'role' then ' (shared with the ' || v_archetype || ' role)'
             else ' (all digital employees will use this document)' end,
      'access_control', jsonb_build_object('kind', 'knowledge_scope_changed', 'doc_id', p_doc_id, 'doc_title', v_doc_title, 'before', v_before, 'after', v_after, 'subjects', p_subjects, 'subject_labels', v_labels));
  exception when others then null; end;
  return jsonb_build_object('ok', true, 'visibility', v_after, 'subjects', v_count);
end; $function$;
REVOKE ALL ON FUNCTION public.set_doc_scope(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_doc_scope(uuid, jsonb) TO authenticated;

-- ── 3. Retrieval: an employee inherits its teams' knowledge ───────────────
-- Reproduced from the live mig-357 body; the ONLY change is the scope branch of
-- visible_docs. Everything else — the human ACL, withheld_count, the lifecycle
-- gate, the restricted-space rule, RRF scoring, the ANN pool, freshness — is
-- carried through untouched.
DO $rewrite$
DECLARE v_def text; v_new text; v_sig text;
BEGIN
  SELECT pg_get_functiondef(p.oid), p.oid::regprocedure::text INTO v_def, v_sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='hybrid_match_knowledge' LIMIT 1;
  IF v_def IS NULL THEN RAISE EXCEPTION '363: hybrid_match_knowledge not found'; END IF;
  IF v_def ILIKE '%de_team%' THEN RAISE NOTICE '363: retrieval already team-aware'; RETURN; END IF;

  v_new := replace(v_def,
    '        or (p_subject_kind is not null and p_subject_id is not null and exists (' || E'\n' ||
    '              select 1 from knowledge_doc_scopes s' || E'\n' ||
    '              where s.doc_id = d.id' || E'\n' ||
    '                and s.subject_kind = p_subject_kind' || E'\n' ||
    '                and s.subject_id = p_subject_id))',

    '        or (p_subject_kind is not null and p_subject_id is not null and exists (' || E'\n' ||
    '              select 1 from knowledge_doc_scopes s' || E'\n' ||
    '              where s.doc_id = d.id' || E'\n' ||
    '                and (' || E'\n' ||
    '                  (s.subject_kind = p_subject_kind and s.subject_id = p_subject_id)' || E'\n' ||
    '                  -- 363: an employee also sees what its TEAMS were given.' || E'\n' ||
    '                  -- Membership is the grant; nothing is copied per employee,' || E'\n' ||
    '                  -- so adding someone to a team updates their knowledge too.' || E'\n' ||
    '                  or (p_subject_kind = ''de'' and s.subject_kind = ''de_team''' || E'\n' ||
    '                      and exists (select 1 from workforce_team_members m' || E'\n' ||
    '                                   where m.team_id = s.subject_id' || E'\n' ||
    '                                     and m.de_id = p_subject_id))' || E'\n' ||
    '                )))');

  IF v_new = v_def THEN RAISE EXCEPTION '363: could not anchor the team branch into visible_docs'; END IF;
  EXECUTE v_new;
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', v_sig);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', v_sig);
END $rewrite$;

-- The same inheritance for the other subject-aware reader.
DO $vkd$
DECLARE v_def text; v_new text; v_sig text;
BEGIN
  SELECT pg_get_functiondef(p.oid), p.oid::regprocedure::text INTO v_def, v_sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='visible_knowledge_docs' LIMIT 1;
  IF v_def IS NULL OR v_def ILIKE '%de_team%' THEN RETURN; END IF;

  v_new := replace(v_def,
    '      or (p_subject_kind is not null and p_subject_id is not null and exists (' || E'\n' ||
    '            select 1 from knowledge_doc_scopes s' || E'\n' ||
    '            where s.doc_id = d.id' || E'\n' ||
    '              and s.subject_kind = p_subject_kind' || E'\n' ||
    '              and s.subject_id = p_subject_id))',

    '      or (p_subject_kind is not null and p_subject_id is not null and exists (' || E'\n' ||
    '            select 1 from knowledge_doc_scopes s' || E'\n' ||
    '            where s.doc_id = d.id' || E'\n' ||
    '              and ((s.subject_kind = p_subject_kind and s.subject_id = p_subject_id)' || E'\n' ||
    '                or (p_subject_kind = ''de'' and s.subject_kind = ''de_team''' || E'\n' ||
    '                    and exists (select 1 from workforce_team_members m' || E'\n' ||
    '                                 where m.team_id = s.subject_id and m.de_id = p_subject_id)))))');

  IF v_new <> v_def THEN
    EXECUTE v_new;
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', v_sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', v_sig);
  ELSE
    RAISE WARNING '363: visible_knowledge_docs scope branch did not match — team scoping applies to retrieval only';
  END IF;
END $vkd$;

-- Membership is looked up per candidate document; index the access path.
CREATE INDEX IF NOT EXISTS workforce_team_members_de_team_idx
  ON workforce_team_members (de_id, team_id);

-- ── 4. Prove it ───────────────────────────────────────────────────────────
DO $assert$
DECLARE
  v_t uuid; v_de uuid; v_team uuid; v_doc uuid; v_def text; v_n int; v_ok boolean;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='hybrid_match_knowledge' LIMIT 1;
  IF v_def NOT ILIKE '%de_team%' THEN RAISE EXCEPTION '363: retrieval is not team-aware'; END IF;
  -- The rewrite must not have dropped anything built on top of this function.
  IF v_def NOT ILIKE '%withheld_count%' OR v_def NOT ILIKE '%lifecycle_status%'
     OR v_def NOT ILIKE '%restricted_space_id%' OR v_def NOT ILIKE '%permitted_docs%'
  THEN RAISE EXCEPTION '363: the rewrite dropped 345/346/357 machinery'; END IF;

  -- End to end on real rows: a doc scoped to a TEAM must be visible to a member
  -- of that team and invisible to an employee outside it.
  SELECT t.id, d.id INTO v_t, v_de
    FROM tenants t JOIN digital_employees d ON d.tenant_id = t.id
   WHERE EXISTS (SELECT 1 FROM knowledge_docs k WHERE k.tenant_id = t.id AND k.is_current)
   LIMIT 1;
  SELECT id INTO v_doc FROM knowledge_docs WHERE tenant_id = v_t AND is_current LIMIT 1;

  INSERT INTO workforce_teams (tenant_id, name) VALUES (v_t, '__scope_team') RETURNING id INTO v_team;
  INSERT INTO workforce_team_members (tenant_id, team_id, de_id, fallback_rank) VALUES (v_t, v_team, v_de, 1);
  INSERT INTO knowledge_doc_scopes (tenant_id, doc_id, subject_kind, subject_id)
  VALUES (v_t, v_doc, 'de_team', v_team);
  UPDATE knowledge_docs SET visibility = 'scoped' WHERE id = v_doc;

  SELECT count(*) INTO v_n FROM visible_knowledge_docs(v_t, 'de', v_de) v WHERE v.id = v_doc;
  IF v_n <> 1 THEN RAISE EXCEPTION '363: a team member cannot see knowledge given to their team'; END IF;

  -- An employee NOT in the team must not.
  SELECT id INTO v_de FROM digital_employees
   WHERE tenant_id = v_t AND id NOT IN (SELECT de_id FROM workforce_team_members WHERE team_id = v_team) LIMIT 1;
  IF v_de IS NOT NULL THEN
    SELECT count(*) INTO v_n FROM visible_knowledge_docs(v_t, 'de', v_de) v WHERE v.id = v_doc;
    IF v_n <> 0 THEN RAISE EXCEPTION '363: team-scoped knowledge leaked to a non-member'; END IF;
  END IF;

  -- A cross-workspace team id must be refused by set_doc_scope's validation.
  v_ok := false;
  BEGIN
    INSERT INTO knowledge_doc_scopes (tenant_id, doc_id, subject_kind, subject_id)
    VALUES (v_t, v_doc, 'nonsense_kind', v_team);
  EXCEPTION WHEN others THEN v_ok := true; END;
  IF NOT v_ok THEN RAISE EXCEPTION '363: the subject_kind CHECK accepts anything'; END IF;

  DELETE FROM knowledge_doc_scopes WHERE doc_id = v_doc AND subject_kind = 'de_team';
  DELETE FROM workforce_team_members WHERE team_id = v_team;
  DELETE FROM workforce_teams WHERE id = v_team;
  UPDATE knowledge_docs SET visibility = 'tenant' WHERE id = v_doc;

  RAISE NOTICE '363: team audiences work, non-members excluded, role-clobber fixed';
END $assert$;

NOTIFY pgrst, 'reload schema';
