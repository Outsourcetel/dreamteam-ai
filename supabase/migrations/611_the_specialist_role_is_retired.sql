-- 611 — the specialist role is retired.
--
-- The founder's recollection was right: specialists stopped being a separate
-- citizen in migration 208 and specialist_profiles was dropped in 212. What
-- survived was a FLAG — is_specialist / specialist_key on digital_employees —
-- and a surface still hanging off it. This removes the rest.
--
-- The evidence, measured rather than assumed:
--   16 is_specialist rows, ALL status='disabled', ALL lifecycle_status='retired'
--   2 consultations ever, the last on 2026-07-18
--   0 specialist_sources, 0 scribe_requests, 0 media_assets
--   1 de_specialist_assignments row
--   46 de_consultation_grants — every single one pointing at a DISABLED specialist
--
-- ⚠⚠ THE ROWS ARE RETIRED, NOT DELETED, AND THAT IS DELIBERATE.
-- Six tables carry specialist_de_id with ON DELETE **CASCADE**, and
-- evidence_runs holds 190 rows that name one. Deleting the 16 employee rows
-- would silently take 190 runs of genuine work history with them — the feed
-- the Workforce activity tab and the employee file both read. Dropping the
-- FLAG kills the role; deleting the ROWS would destroy the audit trail. So the
-- 16 stay on as ordinary retired digital employees and their history still
-- resolves to a name.
--
-- The dependent tables ARE dropped: between them they hold 3 rows, all from a
-- feature that no longer exists, and nothing reads them once the code is gone.
-- Snapshotted into the migration output first.

begin;

-- ── What is about to be destroyed, on the record ─────────────────────────
do $snapshot$
declare v jsonb;
begin
  select jsonb_build_object(
    'specialist_des', (select count(*) from digital_employees where is_specialist),
    'consultations',  (select coalesce(jsonb_agg(jsonb_build_object(
                         'question', left(question, 80), 'status', status,
                         'confidence', confidence, 'at', created_at)), '[]'::jsonb)
                       from spec_consultations),
    'assignments',    (select count(*) from de_specialist_assignments),
    'sources',        (select count(*) from specialist_sources),
    'scribe',         (select count(*) from scribe_requests),
    'media',          (select count(*) from media_assets)
  ) into v;
  raise notice 'DROPPING WITH THIS CONTENT: %', v;
end;
$snapshot$;

-- ── 1. Rewrite the functions that merely READ the flag ───────────────────
-- Spliced from pg_get_functiondef rather than retyped: several of these are
-- long, and re-transcribing a working function to change one predicate is how
-- a typo gets in. Each anchor is asserted present before, and gone after.

do $splice$
declare
  r        record;
  v_def    text;
  v_new    text;
  v_edits  jsonb := jsonb_build_array(
    -- audit_tenant_feature_parity / audit_tenant_provisioning: every specialist
    -- row is lifecycle_status='retired', so the neighbouring retired filter
    -- already excludes them. Removing the predicate is behaviour-preserving.
    jsonb_build_object('fn','audit_tenant_feature_parity',
      'from',' and not d.is_specialist','to',''),
    jsonb_build_object('fn','audit_tenant_provisioning',
      'from',' and not d.is_specialist','to',''),
    -- ...except this one COUNTS active specialists. There are none, and there
    -- can never be again, so it is a literal 0 — same answer, no column.
    jsonb_build_object('fn','audit_tenant_provisioning',
      'from','(select count(*) from digital_employees d where d.tenant_id = t.id and d.is_specialist = true and d.status = ''active'')',
      'to','0'),
    -- apply_entity_amendment: the specialist branch of entity amendments.
    jsonb_build_object('fn','apply_entity_amendment',
      'from',' and is_specialist = true',      'to',''),
    -- get_de_role_context: stops selecting and emitting the flag.
    jsonb_build_object('fn','get_de_role_context',
      'from','select id, category, department, is_specialist, specialist_key',
      'to','select id, category, department'),
    jsonb_build_object('fn','get_de_role_context',
      'from','''is_specialist'', v_de.is_specialist,','to',''),
    -- get_identity_inventory: one kind of subject now.
    jsonb_build_object('fn','get_identity_inventory',
      'from','case when d.is_specialist then ''specialist'' else ''de'' end as subject_kind',
      'to','''de''::text as subject_kind'),
    jsonb_build_object('fn','get_identity_inventory',
      'from','case when d.is_specialist then coalesce(d.specialist_key, ''specialist'') else coalesce(nullif(d.department, ''''), d.category) end as subject_role',
      'to','coalesce(nullif(d.department, ''''), d.category) as subject_role'),
    -- request_de_task: the "cannot delegate to a specialist" guard. There is
    -- no specialist to refuse, and the caller-side filter already excludes
    -- retired employees.
    jsonb_build_object('fn','request_de_task',
      'from','SELECT 1 FROM digital_employees s WHERE s.id = p_to_de_id AND s.is_specialist = true) THEN',
      'to','SELECT 1 FROM digital_employees s WHERE s.id = p_to_de_id AND FALSE) THEN'),
    -- ⚠ record_inquiry_decision is LIVE — the 10-minute work poller calls it
    -- on every item. It read evidence_runs.specialist_de_id to decide whether
    -- the subject was a DE or a specialist. Only the DE arm can happen now.
    -- My first pass MISSED this one: the scan looked for is_specialist and
    -- specialist_key and never for specialist_de_id, and the migration's own
    -- assertion is what caught it.
    jsonb_build_object('fn','record_inquiry_decision',
      'from','  -- Experience door (migs 044/045) — logic unchanged; now selects
  -- specialist_de_id (the pre-212 column name no longer exists, and naming it
  -- here would trip the token assert below — the mig-428 lesson).
  select de_id, specialist_de_id, account_ref into v_run from evidence_runs where id = p_evidence_run_id;
  if v_run.de_id is not null then
    v_subject_kind := ''de''; v_subject_id := v_run.de_id;
  elsif v_run.specialist_de_id is not null then
    v_subject_kind := ''specialist''; v_subject_id := v_run.specialist_de_id;
  end if;',
      'to','  -- Experience door (migs 044/045). The specialist arm went with the role;
  -- a run is the work of a digital employee, full stop.
  select de_id, account_ref into v_run from evidence_runs where id = p_evidence_run_id;
  if v_run.de_id is not null then
    v_subject_kind := ''de''; v_subject_id := v_run.de_id;
  end if;'),
    -- Comment-only reference, but the assertion below matches text, not code —
    -- and a comment naming a dropped column is a lie waiting to be believed.
    jsonb_build_object('fn','submit_evidence_feedback',
      'from','-- specialist_de_id is intentionally NOT tested: the run is the work of',
      'to','-- The subject is intentionally NOT tested: the run is the work of')
  );
  e        jsonb;
  v_n      int;
begin
  for e in select * from jsonb_array_elements(v_edits) loop
    select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f' and p.proname = (e->>'fn')
    limit 1;

    if v_def is null then
      raise exception 'function % is missing — refusing to continue', e->>'fn';
    end if;

    v_n := (length(v_def) - length(replace(v_def, e->>'from', ''))) / greatest(length(e->>'from'), 1);
    if v_n < 1 then
      raise exception 'anchor not found in %: %', e->>'fn', left(e->>'from', 60);
    end if;

    v_new := replace(v_def, e->>'from', e->>'to');
    if v_new = v_def then
      raise exception 'splice was a silent no-op on %', e->>'fn';
    end if;
    execute v_new;
    raise notice 'rewrote % (% occurrence(s))', e->>'fn', v_n;
  end loop;
end;
$splice$;

-- ── 2. list_consultable_for_de — the one that must SURVIVE ───────────────
-- It fed the specialist consult AND colleague-to-colleague help. The DE-to-DE
-- half is the live mechanism (it is what runResolveInquiry consults inside the
-- evidence pipeline), so it is rewritten, not dropped. Specialist ranking goes.
create or replace function list_consultable_for_de(p_de_id uuid)
returns json
language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(row_to_json(x) order by x.name), '[]'::json)
  from (
    select d.id as target_de_id,
           coalesce(d.persona_name, d.name) as name,
           'grant'::text as grant_kind
    from de_consultation_grants g
    join digital_employees d on d.id = g.target_de_id
    where g.requester_de_id = p_de_id
      and g.active
      and d.status = 'active'
      and coalesce(d.lifecycle_status, '') not in ('retired', 'archived')
  ) x;
$$;

revoke execute on function list_consultable_for_de(uuid) from public;
grant execute on function list_consultable_for_de(uuid) to authenticated, service_role;

-- ── 3. Drop the specialist-only functions ────────────────────────────────
-- Verified to have no SQL callers and no callers anywhere in the repo (the
-- last one, resolve_de_specialist_internal, was reached from playbook-execute's
-- consult_specialist STEP, removed in the same change).
drop function if exists install_technical_specialist();
drop function if exists install_technical_specialist(uuid);
drop function if exists list_de_specialists(uuid);
drop function if exists resolve_de_specialist_internal(uuid, uuid);
drop function if exists resolve_specialist_de(uuid);
-- ⚠ smallint, not integer. `drop function if exists` with the wrong argument
-- type is a SILENT no-op — it matched nothing and said nothing. Only the
-- assertion at the bottom caught that the function was still there.
drop function if exists set_de_specialist(uuid, smallint, uuid);
-- Writes a Vault secret for a specialist_sources row. The table goes below, so
-- the function has nothing left to write to. (It was NOT the mig-580 plaintext
-- bug — it correctly used Vault — it is simply orphaned.)
drop function if exists set_specialist_source_secret(uuid, text);
drop function if exists set_specialist_source_secret(uuid, text, text);

-- The two auto-grant triggers and their functions. ⚠ These were the pair that
-- looked like duplicates in the audit and were not — mutually exclusive WHEN
-- clauses, opposite directions of one relationship. Both directions end here.
drop trigger if exists trg_de_auto_consult_grant_ins on digital_employees;
drop trigger if exists trg_de_auto_consult_grant_upd on digital_employees;
drop trigger if exists trg_spec_auto_consult_grant_ins on digital_employees;
drop trigger if exists trg_spec_auto_consult_grant_upd on digital_employees;
drop function if exists de_grant_specialist_consult();
drop function if exists de_specialist_grant_workforce();

-- ── 4. The grants that point nowhere ─────────────────────────────────────
-- All 46 target a disabled specialist. They are not "DE-to-DE grants" in any
-- useful sense — they are the residue of the old auto-grant backfill, and
-- leaving them would keep every employee showing a colleague it cannot reach.
delete from de_consultation_grants g
using digital_employees d
where d.id = g.target_de_id and d.is_specialist;

-- ── 5. Drop the specialist-only tables ───────────────────────────────────
drop table if exists scribe_requests cascade;
drop table if exists spec_consultations cascade;
drop table if exists specialist_sources cascade;
drop table if exists de_specialist_assignments cascade;
drop table if exists media_assets cascade;

-- ── 6. And finally the flag itself ───────────────────────────────────────
-- evidence_runs.specialist_de_id goes too: it is nullable, its FK target rows
-- survive as ordinary employees, and de_id already records who did the work.
alter table evidence_runs drop column if exists specialist_de_id;
alter table digital_employees drop column if exists specialist_key;
alter table digital_employees drop column if exists is_specialist;

-- ── Prove it ─────────────────────────────────────────────────────────────
do $verify$
declare
  v_cols int;
  v_fns  int;
  v_runs int;
  v_des  int;
begin
  select count(*) into v_cols from information_schema.columns
  where table_schema = 'public' and column_name in ('is_specialist', 'specialist_key', 'specialist_de_id');
  if v_cols > 0 then raise exception '% specialist column(s) survived', v_cols; end if;

  select count(*) into v_fns from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind = 'f'
    and pg_get_functiondef(p.oid) ~ 'is_specialist|specialist_key|specialist_de_id';
  if v_fns > 0 then raise exception '% function(s) still reference a dropped column', v_fns; end if;

  -- THE POINT OF RETIRING RATHER THAN DELETING: the history is still here.
  select count(*) into v_runs from evidence_runs;
  if v_runs < 190 then
    raise exception 'evidence_runs fell to % — history was destroyed', v_runs;
  end if;

  -- ...and so are the 16 employees, now ordinary retired ones.
  select count(*) into v_des from digital_employees where lifecycle_status = 'retired';
  if v_des < 16 then raise exception 'the retired employee rows went missing (% left)', v_des; end if;

  raise notice 'specialist role retired: 0 columns, 0 functions, % evidence runs and % retired employees intact',
    v_runs, v_des;
end;
$verify$;

commit;
