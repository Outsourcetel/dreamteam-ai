// ============================================================
// playbook-gap-probes.mjs — the typed-gaps build's Ring-0 probes (mig 712,
// spec docs/superpowers/specs/2026-08-12-builder-typed-gaps-design.md §5),
// in ONE file imported by BOTH certify.mjs and certify-mutation-test.mjs —
// the mutation test exercises the real queries, not paraphrases of them.
//
// Style rules inherited from the siblings in this directory:
//   · violations-only — a row with `violation` fails certify; a row with
//     `note` prints the DENOMINATOR (zero findings from zero comparisons
//     looks exactly like a clean result, so every probe says how much it
//     examined, on a PASS as well as a fail);
//   · every builder takes an optional fixture so the mutation test drives
//     the SAME SQL over synthesised rows;
//   · DRIVING OBJECTS over prosrc token pins wherever the invariant lives
//     in the catalog (the audit trigger is pinned as a pg_trigger row, not
//     as a source-text grep).
//
// PIN DATE. The feature shipped 2026-08-12. Rows older than that predate
// the machinery and are named debt, not findings: 14 playbook_versions
// snapshots (2026-07-21 → 2026-08-10) end in an `instruction` step, not
// `complete` — published through a path that bypassed validateSteps
// (found during this build; flagged, not fixed). The strictness pin
// therefore ratchets from the pin date and REPORTS the excluded legacy
// count so the debt stays visible.
//
// mig 713 (2026-08-12, same day) closed the DOOR the 14 came through: a
// BEFORE INSERT OR UPDATE trigger on playbook_versions runs a SQL floor of
// validateSteps' key-and-order rules, so no path — SQL function, migration,
// edge function or raw SQL — can add a 15th. The pin date does NOT move:
// the 14 are still there, still named, and moving the date would erase
// them from the denominator without correcting one of them. What moves is
// the ratchet: LEGACY_MAX below is a HIGH-WATER MARK. If the pre-pin
// failing count ever exceeds it, something inserted a backdated invalid
// snapshot and the gate leaked; it may only ever shrink, one corrected
// playbook at a time, and each shrink is a deliberate edit here.
//
// WHY THE 14 ARE STILL NAMED AND NOT CORRECTED (measured 2026-08-12, all
// 14 driven through the DEPLOYED validator): appending the missing
// `complete` does NOT make them valid — every one ALSO fails bad_params
// (their instruction steps carry the title in `label`, not `params.title`),
// and their source of truth, role_archetypes.sop_playbook, is prose in
// 15/15 archetypes. Correcting them would turn 11 published starter
// playbooks in one tenant from "cannot run at all" (invalid_definition/422,
// zero runs ever) into "runs" — a behaviour change, not a maintenance fix.
// ============================================================

const PIN_DATE = '2026-08-12';
// High-water mark for pre-pin snapshots failing the floor. Measured
// 2026-08-12: exactly 14, all tenant Outsourcetel, across 11 definitions.
const LEGACY_MAX = 14;
const sq = (s) => `'${String(s).replace(/'/g, "''")}'`;
const jfx = (rows) => rows
  .map((r) => `(${sq(JSON.stringify(r))}::jsonb)`)
  .join(', ');

// The snapshot vocabulary — playbook-execute's PRIMITIVES, plus the one
// retired key that was validation-legal when its snapshots published
// (consult_specialist; the executor skips it honestly). Adding a primitive
// to the engine without adding it here turns certify red on the first
// publish that uses it — a deliberate re-pin, which is the point.
const SNAPSHOT_KEYS = [
  'check_account', 'generate_invoice', 'human_approval', 'guardrail_check',
  'connector_action', 'update_record', 'log_activity',
  'instruction', 'decision', 'checklist', 'wait', 'sub_playbook', 'agentic_step',
  'custom_step', 'start_onboarding', 'emit_event', 'check_knowledge',
  'read_reference', 'complete', 'gap_gate',
  'consult_specialist', // retired; historical snapshots only
];

/**
 * gap-gate-can-only-pause — the runtime conduct pin.
 *
 * A gap_gate step exists so a blocked behaviour CANNOT run: the executor may
 * leave it pending, park it waiting, record it skipped (the human's
 * skip-for-this-run waiver) or cancelled — NEVER done. A gap_gate that ends
 * 'done' means some code path executed through it, which is the exact
 * "execute anyway" this build forbids.
 *
 * @param {Array<{id: string, steps: Array<{key: string, status?: string}>}>|null} runsFixture
 */
export function gapGateConductSql(runsFixture = null) {
  const source = runsFixture
    ? `select (v.j->>'id') as id, (v.j->'steps') as steps
         from (values ${jfx(runsFixture)}) as v(j)`
    : `select id::text as id, steps from playbook_runs`;
  return String.raw`
with runs as (
${source}
),
gate_steps as (
  select r.id as run_id, s->>'key' as key, s->>'status' as status
    from runs r, lateral jsonb_array_elements(r.steps) s
   where s->>'key' = 'gap_gate'
)
select 'run ' || run_id || ': a gap_gate step ended ''done'' — a gap gate may only pause '
       || '(pending/waiting), be skipped for one run by a human, or be cancelled. '
       || '''done'' means something EXECUTED through it, which is the forbidden "execute anyway".'
       as violation, null as note
  from gate_steps
 where status = 'done'
union all
select null,
       'gap-gate-can-only-pause: examined ' || count(*) || ' gap_gate step(s) across '
       || count(distinct run_id) || ' run(s)'
       || case when count(*) = 0 then ' — none exist yet (partial publish is opt-in and off by default); the snapshot-shape and strictness arms below are the standing teeth' else '' end
  from gate_steps`;
}

/**
 * playbook-steps-writes-are-audited — the mig 712 governance closure.
 *
 * PROVEN HOLE (spec §1.4): on 2026-08-11 22:31 a draft's 7 compiled steps
 * were overwritten with 8 prose sections ("Rabeel") through a write path
 * that audited nothing. mig 712's playbook_steps_guard trigger validates
 * shape AND appends the audit event IN THE SAME STATEMENT — so an
 * un-audited steps update is impossible while the trigger stands. Two arms:
 *
 *   1. DRIVING OBJECT: the trigger row itself — present, enabled ('O'),
 *      BEFORE INSERT+UPDATE, wired to playbook_steps_guard(). A dropped or
 *      disabled trigger is a violation even with zero data to show for it.
 *   2. DATA: every steps UPDATE after the pin date (steps_updated_at
 *      meaningfully later than created_at — inserts stamp both together)
 *      must have its audit event within ±5 minutes.
 *
 * @param {object|null} fx  { triggerName?: string,
 *   defs?: [{id,tenant_id,name,key,created_at,steps_updated_at}],
 *   events?: [{tenant_id,definition_id,kind,created_at}] }
 */
export function auditedStepsWritesSql(fx = null) {
  const triggerName = fx?.triggerName ?? 'playbook_steps_guard';
  const defsSource = fx?.defs
    ? `select (v.j->>'id') as id, (v.j->>'tenant_id') as tenant_id,
              (v.j->>'name') as name, (v.j->>'key') as key,
              (v.j->>'created_at')::timestamptz as created_at,
              (v.j->>'steps_updated_at')::timestamptz as steps_updated_at
         from (values ${jfx(fx.defs)}) as v(j)`
    : `select id::text as id, tenant_id::text as tenant_id, name, key, created_at, steps_updated_at
         from playbook_definitions`;
  const eventsSource = fx?.events
    ? `select (v.j->>'tenant_id') as tenant_id, (v.j->>'definition_id') as definition_id,
              (v.j->>'kind') as kind, (v.j->>'created_at')::timestamptz as created_at
         from (values ${jfx(fx.events)}) as v(j)`
    : `select tenant_id::text as tenant_id, detail->>'definition_id' as definition_id,
              detail->>'kind' as kind, created_at
         from audit_events
        where created_at > timestamptz '${PIN_DATE}' - interval '10 minutes'
          and detail->>'kind' = 'playbook_steps_updated'`;
  return String.raw`
with defs as (
${defsSource}
),
evts as (
${eventsSource}
),
trigger_check as (
  select count(*) as n
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_proc p on p.oid = t.tgfoid
   where c.relname = 'playbook_definitions'
     and t.tgname = ${sq(triggerName)}
     and t.tgenabled = 'O'
     and p.proname = 'playbook_steps_guard'
),
steps_updates as (
  select * from defs
   where steps_updated_at is not null
     and steps_updated_at > timestamptz '${PIN_DATE}'
     and steps_updated_at > created_at + interval '5 seconds'
)
select 'the playbook_steps_guard trigger is MISSING or DISABLED on playbook_definitions — '
       || 'every write path (PostgREST, ai_apply_change, service role) can now change steps '
       || 'un-audited and un-shape-checked, which is the exact hole the 22:31 "Rabeel" overwrite proved (mig 712)'
       as violation, null as note
  from trigger_check where n = 0
union all
select 'playbook "' || d.name || '" (' || d.key || '): steps updated at ' || d.steps_updated_at
       || ' with NO playbook_steps_updated audit event within 5 minutes — an un-audited steps write happened'
       as violation, null
  from steps_updates d
 where not exists (
   select 1 from evts e
    where e.definition_id = d.id
      and e.tenant_id = d.tenant_id
      and e.created_at between d.steps_updated_at - interval '5 minutes'
                           and d.steps_updated_at + interval '5 minutes')
union all
select null,
       'playbook-steps-writes-are-audited: trigger ' || case when (select n from trigger_check) > 0 then 'ENABLED' else 'MISSING' end
       || '; examined ' || (select count(*) from steps_updates) || ' steps-update(s) since ${PIN_DATE}'`;
}

/**
 * published-snapshots-respect-the-gate — the full-publish strictness pin,
 * inverted: instead of trusting that validateSteps ran, assert that what it
 * GUARDS holds on every snapshot the executor can be handed. If anyone
 * relaxes the gate, the first loosened publish lands here as a named row.
 * (The behavioural refusal-code pin lives in tests/playbook-gate.test.ts,
 * which drives the deployed dev validator with refusal fixtures.)
 *
 * mig 713 adds two arms that make this probe fail on a REGRESSION as well
 * as on a bad row:
 *   · DRIVING OBJECT — the playbook_versions_gate trigger must exist,
 *     be enabled ('O'), be BEFORE INSERT+UPDATE and be wired to
 *     playbook_versions_gate(). Dropped or disabled, every insert path is
 *     ungated again even with zero bad rows to show for it. Pinned as a
 *     pg_trigger row, not a prosrc grep.
 *   · LEGACY RATCHET — the pre-pin failing count may not exceed
 *     LEGACY_MAX. A backdated invalid snapshot is the one way the gate
 *     could be bypassed without tripping the post-pin arms.
 *
 * @param {Array<{id: string, published_at: string, steps: Array<object>}>|null} versionsFixture
 * @param {{triggerName?: string, legacyMax?: number}|null} opts
 */
export function snapshotGateSql(versionsFixture = null, opts = null) {
  const source = versionsFixture
    ? `select (v.j->>'id') as id, (v.j->>'published_at')::timestamptz as published_at, (v.j->'steps') as steps
         from (values ${jfx(versionsFixture)}) as v(j)`
    : `select id::text as id, published_at, steps from playbook_versions`;
  const keysList = SNAPSHOT_KEYS.map(sq).join(', ');
  const triggerName = opts?.triggerName ?? 'playbook_versions_gate';
  const legacyMax = opts?.legacyMax ?? LEGACY_MAX;
  return String.raw`
with vers as (
${source}
),
scoped as (
  select * from vers where published_at > timestamptz '${PIN_DATE}'
),
legacy as (
  select count(*) as n from vers where published_at <= timestamptz '${PIN_DATE}'
),
legacy_bad as (
  select count(*) as n from vers
   where published_at <= timestamptz '${PIN_DATE}'
     and (jsonb_array_length(steps) = 0
          or (steps->(jsonb_array_length(steps)-1))->>'key' is distinct from 'complete')
),
gate_trigger as (
  select count(*) as n
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_proc p on p.oid = t.tgfoid
   where c.relname = 'playbook_versions'
     and t.tgname = ${sq(triggerName)}
     and t.tgenabled = 'O'
     and p.proname = 'playbook_versions_gate'
)
select 'the playbook_versions_gate trigger is MISSING or DISABLED — mig 713 put the floor ON THE TABLE '
       || 'precisely because NINE insert paths exist and gating them one at a time leaves the next one '
       || 'ungated by construction. Without it, install_role_kit, provision_starter_de_internal, any '
       || 'migration DO block and any service-role write can publish a snapshot the runtime will refuse.'
       as violation, null as note
  from gate_trigger where n = 0
union all
select 'pre-pin snapshots failing the floor rose to ' || n || ' (high-water mark ' || ${legacyMax}
       || ') — the 14 named legacy rows can only SHRINK. A rise means a snapshot was inserted with a '
       || 'backdated published_at, which is the one route past the post-pin arms.', null
  from legacy_bad where n > ${legacyMax}
union all
select 'snapshot ' || v.id || ': step ' || (i.ord)::text || ' uses key "' || (i.s->>'key')
       || '", which is outside the pinned snapshot vocabulary — either the gate was relaxed '
       || 'or a new primitive shipped without a deliberate re-pin here'
       as violation, null as note
  from scoped v, lateral jsonb_array_elements(v.steps) with ordinality i(s, ord)
 where coalesce(i.s->>'key', '') not in (${keysList})
union all
select 'snapshot ' || v.id || ': last step is "' || coalesce(v.steps->(jsonb_array_length(v.steps)-1)->>'key', '(none)')
       || '", not complete — the last_step rule did not hold at publish', null
  from scoped v
 where jsonb_array_length(v.steps) = 0
    or (v.steps->(jsonb_array_length(v.steps)-1))->>'key' is distinct from 'complete'
union all
select 'snapshot ' || v.id || ': ' || cnt || ' human_approval steps (max 1) — the gate was relaxed', null
  from (select v.id, (select count(*) from jsonb_array_elements(v.steps) s where s->>'key' = 'human_approval') as cnt
          from scoped v) v
 where cnt > 1
union all
select 'snapshot ' || v.id || ': ' || cnt || ' generate_invoice steps (max 1) — the gate was relaxed', null
  from (select v.id, (select count(*) from jsonb_array_elements(v.steps) s where s->>'key' = 'generate_invoice') as cnt
          from scoped v) v
 where cnt > 1
union all
select 'snapshot ' || v.id || ': a gap_gate step carries no gap_id — a gate that cannot name '
       || 'the gap that blocks it is unanswerable', null
  from scoped v, lateral jsonb_array_elements(v.steps) s
 where s->>'key' = 'gap_gate'
   and coalesce(s->'params'->>'gap_id', '') = ''
union all
select null,
       'published-snapshots-respect-the-gate: table gate '
       || case when (select n from gate_trigger) > 0 then 'ENABLED (mig 713)' else 'MISSING' end
       || '; examined ' || (select count(*) from scoped)
       || ' snapshot(s) published after ${PIN_DATE}; ' || (select n from legacy)
       || ' legacy snapshot(s) excluded as named debt, of which ' || (select n from legacy_bad)
       || ' fail the floor (high-water mark ${legacyMax}) — all tenant Outsourcetel, 11 definitions, ZERO runs ever; '
       || 'they end in instruction AND fail bad_params, so appending complete would not make them runnable'`;
}

/**
 * playbook-gaps-hold-their-evidence — answered ≠ resolved, structurally.
 *
 * Arms: (1) a resolved gap must carry resolved_at, and a resolved
 * missing_knowledge gap must carry the doc evidence its resolution rule
 * demands (answer.doc_id — the recompile verified retrieval) or a
 * patch_applied marker is a lie on this kind; (2) answered gaps must carry
 * an answer + answered_at; dismissed must carry dismissed_at; (3) coverage:
 * a study that raised gaps/validator errors after the pin date must have
 * gap rows — objections that exist only as prose are the dead end this
 * build replaces.
 *
 * @param {object|null} fx  { gaps?: [...], studies?: [{definition_id, updated_at,
 *   n_gaps, n_validation_errors}], gapCounts?: [{definition_id, n, n_validator}] }
 */
export function gapEvidenceSql(fx = null) {
  const gapsSource = fx?.gaps
    ? `select (v.j->>'id') as id, (v.j->>'definition_id') as definition_id,
              (v.j->>'kind') as kind, (v.j->>'status') as status,
              (v.j->>'gap_key') as gap_key,
              nullif(v.j->>'answer', '')::jsonb as answer,
              nullif(v.j->>'answered_at', '')::timestamptz as answered_at,
              nullif(v.j->>'resolved_at', '')::timestamptz as resolved_at,
              nullif(v.j->>'dismissed_at', '')::timestamptz as dismissed_at,
              (v.j->>'source') as source
         from (values ${jfx(fx.gaps)}) as v(j)`
    : `select id::text as id, definition_id::text as definition_id, kind, status, gap_key,
              answer, answered_at, resolved_at, dismissed_at, source
         from playbook_gaps`;
  const studiesSource = fx?.studies
    ? `select (v.j->>'definition_id') as definition_id,
              (v.j->>'updated_at')::timestamptz as updated_at,
              (v.j->>'n_gaps')::int as n_gaps,
              (v.j->>'n_validation_errors')::int as n_validation_errors
         from (values ${jfx(fx.studies)}) as v(j)`
    : `select definition_id::text as definition_id, updated_at,
              coalesce(jsonb_array_length(report->'gaps'), 0) as n_gaps,
              coalesce(jsonb_array_length(report->'validation_errors'), 0) as n_validation_errors
         from playbook_studies`;
  return String.raw`
with gaps as (
${gapsSource}
),
studies as (
${studiesSource}
),
scoped_studies as (
  select * from studies where updated_at > timestamptz '${PIN_DATE}'
)
select 'gap ' || gap_key || ' (' || id || '): status=resolved but resolved_at is NULL — a closure with no timestamp is a stored marker, not evidence'
       as violation, null as note
  from gaps where status = 'resolved' and resolved_at is null
union all
select 'gap ' || gap_key || ' (' || id || '): a RESOLVED missing_knowledge gap with no doc evidence in its answer — '
       || 'resolution for this kind means the recompile RETRIEVED the answered document (answer.doc_id); '
       || 'without it the gap was resolved on somebody''s say-so', null
  from gaps
 where status = 'resolved' and kind = 'missing_knowledge'
   and coalesce(answer->>'doc_id', '') = ''
union all
select 'gap ' || gap_key || ' (' || id || '): status=answered but answer or answered_at is missing', null
  from gaps where status = 'answered' and (answer is null or answered_at is null)
union all
select 'gap ' || gap_key || ' (' || id || '): status=dismissed but dismissed_at is NULL', null
  from gaps where status = 'dismissed' and dismissed_at is null
union all
select 'study for definition ' || s.definition_id || ': the study raised ' || s.n_gaps
       || ' typed gap(s) but ZERO playbook_gaps rows exist — the objections exist only as prose again', null
  from scoped_studies s
 where s.n_gaps > 0
   and not exists (select 1 from gaps g where g.definition_id = s.definition_id)
union all
select 'study for definition ' || s.definition_id || ': ' || s.n_validation_errors
       || ' draft-time validator error(s) recorded but ZERO validator-sourced gaps exist — errors are being dropped again (spec §1.2b)', null
  from scoped_studies s
 where s.n_validation_errors > 0
   and not exists (select 1 from gaps g where g.definition_id = s.definition_id and g.source = 'validator')
union all
select null,
       'playbook-gaps-hold-their-evidence: examined ' || (select count(*) from gaps) || ' gap row(s) and '
       || (select count(*) from scoped_studies) || ' study(ies) since ${PIN_DATE}'`;
}
