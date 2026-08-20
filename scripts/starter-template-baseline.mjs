// ============================================================================
// starter-template-baseline.mjs — Ring-0: a workspace quietly running a starter
// onboarding list several items behind the canonical one, with nothing anywhere
// saying so.
//
// WHY THIS EXISTS (mig 817). install_starter_onboarding_template() returned
// `already_installed: true` for ANY tenant holding a row named
// 'SaaS onboarding — starter' — which is exactly every tenant that would need
// the newer list — handed back the OLD template id, and reported success. Four
// tenants sat six items behind the canonical sixteen for over a month
// (acme-telecom, first-community-cu, gusto, kinetic; measured 2026-08-20), and
// no gate, toast, screen or log said a word. The class is the one this repo has
// spent days removing: A CALL THAT SUCCEEDS WHILE NOTHING HAPPENS.
//
// ── THE ARMS ───────────────────────────────────────────────────────────────
//
//  1. `behind-unacknowledged` (VIOLATION) — a template classified `outdated`:
//     provably unedited, and N canonical items absent from it, with no live
//     acknowledgement. This is the defect in row form.
//
//     ⚠ IT IS RED ON PRODUCTION TODAY, FOR FOUR TENANTS, AND THAT IS CORRECT.
//     Whether a workspace moves to the newer list is the founder's decision;
//     what this refuses to allow is the decision going unmade and unnoticed.
//     There are exactly two ways to clear it and both are a person deciding:
//     upgrade_starter_onboarding_template(), or
//     acknowledge_starter_template_baseline() to stay put on the record.
//
//  2. `mechanism-missing` (VIOLATION) — ⚠ THE ARM THAT STOPS THIS BEING
//     THEATRE. On a day when every workspace happens to be current, arm 1
//     finds nothing whether mig 817 is installed or has been deleted, and
//     those two states must not look alike. The classifier, the pure verdict,
//     the honest installer, the upgrade path and the acknowledgement must all
//     EXIST.
//
//  3. `installer-reports-blindly` (VIOLATION) — the fix itself, pinned. The
//     installer must consult the classifier. Without this arm the honest
//     branch can be reverted to `already_installed: true` and every other arm
//     here still passes.
//
//  4. `upgrade-lost-its-refusal` (VIOLATION) — the two properties that make
//     the upgrade safe rather than merely present: it must still refuse an
//     EDITED template by default, and it must still carry the merge guard that
//     raises if an existing item would change. An upgrade path that overwrites
//     somebody's edits is worse than the bug it was built to fix.
//
//  5. `perimeter-loosened` (VIOLATION) — anon/public must hold EXECUTE on none
//     of them; `authenticated` must KEEP it on the three client RPCs (a revoke
//     that breaks a live button is as much a defect as a grant that opens a
//     hole); and starter_template_state_internal — which takes a tenant id —
//     must NOT be reachable by `authenticated`, because a SECDEF-adjacent
//     function taking a tenant id is the migs 662-664 confused-deputy shape.
//
//  6. `classifier-disagrees` (VIOLATION) — this probe derives `touched` itself
//     so that it can be handed synthetic rows for mutation testing. That is a
//     SECOND COPY of a rule, and a second copy rots. For every real tenant the
//     probe's verdict must equal starter_template_state_internal's, so the
//     copy cannot drift silently.
//
//  7. `no-comparisons` (VIOLATION) — zero templates examined, or a canonical
//     list with zero items, is a REFUSAL, never a pass. Zero findings from zero
//     comparisons looks exactly like a clean result.
//
//  8. `note` — the denominators, always: templates compared, canon size and
//     md5, the per-status split, and every non-current workspace named with
//     how far behind it is and whether a decision has been recorded.
// ============================================================================

// The canonical item list, from the single source mig 685 established.
const CANON_DEFAULT = `select public.starter_onboarding_template()->'items' as items`;

// Every real starter template, joined to its tenant. `touched` is the
// history half of the edit test — see arm 6 for why a second copy is safe here.
const TEMPLATES_DEFAULT = `
  select t.slug::text                        as slug,
         tpl.tenant_id                       as tenant_id,
         tpl.id::text                        as template_id,
         tpl.items                           as items,
         md5(tpl.items::text)                as items_md5,
         (    tpl.updated_at > tpl.created_at
           or tpl.version > 1
           or (select count(distinct md5(v.items::text))
                 from public.onboarding_template_versions v
                where v.template_id = tpl.id) > 1 ) as touched
    from public.onboarding_templates tpl
    join public.tenants t on t.id = tpl.tenant_id
   where tpl.name = public.starter_onboarding_template_name()`;

// A decision to stay put, recorded by acknowledge_starter_template_baseline().
// It carries BOTH md5s and the probe honours it only while both still match —
// so editing the template, or moving the canonical list again, lapses it. An
// acknowledgement that outlives the comparison it was about is a stored marker,
// and this repo has been caught by those before.
const ACKS_DEFAULT = `
  select a.tenant_id                as tenant_id,
         a.detail->>'items_md5'     as items_md5,
         a.detail->>'canon_md5'     as canon_md5
    from public.audit_events a
   where a.detail->>'kind' = 'onboarding_starter_baseline_acknowledged'`;

// The five functions mig 817 installs, with the identity args needed to name
// them to has_function_privilege.
const REQUIRED_FUNCTIONS = [
  { name: 'starter_template_verdict',              args: 'jsonb, jsonb, boolean', authenticated: false },
  { name: 'starter_template_state_internal',       args: 'uuid',                  authenticated: false },
  { name: 'starter_onboarding_template_status',    args: '',                      authenticated: true },
  { name: 'install_starter_onboarding_template',   args: '',                      authenticated: true },
  { name: 'upgrade_starter_onboarding_template',   args: 'boolean',               authenticated: true },
  { name: 'acknowledge_starter_template_baseline', args: 'text',                  authenticated: true },
];

const FUNCTIONS_DEFAULT = REQUIRED_FUNCTIONS.map(
  (f) => `select ${lit(f.name)}::text as fname, ${lit(f.args)}::text as fargs, ${f.authenticated} as want_auth`,
).join('\n    union all\n    ');

function lit(s) { return `'${String(s).replace(/'/g, "''")}'`; }

/**
 * @param {object} [o]
 * @param {string} [o.templatesSql]  replaces the population (mutation testing)
 * @param {string} [o.canonSql]      replaces the canonical item list
 * @param {string} [o.acksSql]       replaces the acknowledgement source
 * @param {string} [o.catalogSql]    replaces the live pg_proc catalog view
 * @param {string} [o.privSql]       replaces the live EXECUTE-privilege view
 */
export function starterTemplateBaselineSql(o = {}) {
  const TEMPLATES = o.templatesSql ?? TEMPLATES_DEFAULT;
  const CANON = o.canonSql ?? CANON_DEFAULT;
  const ACKS = o.acksSql ?? ACKS_DEFAULT;

  // The live catalog: which of the required functions exist, and their bodies.
  //
  // ⚠ oidvectortypes, NOT pg_get_function_identity_arguments. The latter
  // includes PARAMETER NAMES — it returns 'p_note text', not 'text' — so
  // comparing it to a signature written as 'text' never matches and
  // `mechanism-missing` fires for every function whether it exists or not: a
  // gate red for a reason that has nothing to do with what it guards. Caught
  // by running the privilege query by hand before trusting this, which is also
  // why the same expression is what builds the signature handed to
  // has_function_privilege below — one derivation, so the two cannot disagree.
  const CATALOG = o.catalogSql ?? `
    select p.proname::text as fname,
           pg_catalog.oidvectortypes(p.proargtypes)::text as fargs,
           p.prosrc as body
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'`;

  // EXECUTE privileges, resolved per role. Built from the required list so a
  // function that does not exist shows as "no privilege" rather than erroring.
  const PRIV = o.privSql ?? `
    select r.fname, r.fargs,
           coalesce(has_function_privilege('anon',          'public.' || r.fname || '(' || r.fargs || ')', 'EXECUTE'), false) as anon_x,
           coalesce(has_function_privilege('authenticated', 'public.' || r.fname || '(' || r.fargs || ')', 'EXECUTE'), false) as auth_x,
           coalesce(has_function_privilege('service_role',  'public.' || r.fname || '(' || r.fargs || ')', 'EXECUTE'), false) as svc_x
      from required r
     where exists (select 1 from cat c where c.fname = r.fname)`;

  return `
with canon as (${CANON}),
pop as (${TEMPLATES}),
acks as (${ACKS}),
required as (
    ${FUNCTIONS_DEFAULT}
),
cat as (${CATALOG}),
-- THE decision, from mig 817's pure function. Not a paraphrase of it: a probe
-- whose rule disagrees with the runtime's manufactures findings and misses real
-- ones in the same pass.
verdicts as (
  select p.slug, p.tenant_id, p.template_id, p.items_md5, p.touched,
         public.starter_template_verdict((select items from canon), p.items, p.touched) as v
    from pop p
),
scored as (
  select s.*, s.v->>'status' as status, (s.v->>'behind_by')::int as behind_by,
         (select md5(items::text) from canon) as canon_md5,
         exists (select 1 from acks a
                  where a.tenant_id = s.tenant_id
                    and a.items_md5 = s.items_md5
                    and a.canon_md5 = (select md5(items::text) from canon)) as acknowledged
    from verdicts s
),

-- ── ARM 1 ────────────────────────────────────────────────────────────────
arm_behind as (
  select format(
    'behind-unacknowledged: workspace "%s" runs a starter onboarding list %s item(s) short of the canonical %s and no decision is on record. Missing: %s. Either upgrade_starter_onboarding_template() or acknowledge_starter_template_baseline() — both are a person deciding, which is the point.',
    slug, behind_by, (v->>'canon_items'),
    array_to_string(array(select jsonb_array_elements_text(v->'missing_keys')), ', ')) as violation
  from scored where status = 'outdated' and not acknowledged
),

-- ── ARM 2 ────────────────────────────────────────────────────────────────
arm_mechanism as (
  select format(
    'mechanism-missing: public.%s(%s) does not exist. Arm 1 finds nothing on a day every workspace is current whether mig 817 is installed or deleted; those two states must not look alike.',
    r.fname, r.fargs) as violation
  from required r
  where not exists (select 1 from cat c where c.fname = r.fname and c.fargs = r.fargs)
),

-- ── ARM 3 ────────────────────────────────────────────────────────────────
arm_installer as (
  select 'installer-reports-blindly: install_starter_onboarding_template no longer consults starter_template_state_internal. It is back to answering "already_installed: true" for a workspace six items behind — success reported for doing nothing, which is the entire defect mig 817 exists to remove.' as violation
  from cat c
  where c.fname = 'install_starter_onboarding_template'
    and c.body not like '%starter_template_state_internal%'
),

-- ── ARM 4 ────────────────────────────────────────────────────────────────
arm_upgrade as (
  select v.violation from cat c
  cross join lateral (values
    (case when c.body not like '%template_has_local_edits%'
          then 'upgrade-lost-its-refusal: upgrade_starter_onboarding_template no longer refuses an EDITED template by default. Silently replacing a workspace''s own edits is worse than the bug this was built to fix.' end),
    (case when c.body not like '%would have changed or dropped an item%'
          then 'upgrade-lost-its-refusal: upgrade_starter_onboarding_template has lost the merge guard — the assertion that every pre-existing item is still present byte-identical before anything is written. "It is a merge" is a promise about code; that assertion was the guarantee.' end)
  ) as v(violation)
  where c.fname = 'upgrade_starter_onboarding_template' and v.violation is not null
),

-- ── ARM 5 ────────────────────────────────────────────────────────────────
priv as (${PRIV}),
arm_perimeter as (
  select v.violation from priv p
  join required r on r.fname = p.fname and r.fargs = p.fargs
  cross join lateral (values
    (case when p.anon_x then format('perimeter-loosened: anon holds EXECUTE on public.%s(%s) — that is the internet reaching the starter-template machinery.', p.fname, p.fargs) end),
    (case when r.want_auth and not p.auth_x then format('perimeter-loosened: authenticated LOST EXECUTE on public.%s(%s) — that is a live button now returning 42501. An over-revoke is a defect too.', p.fname, p.fargs) end),
    (case when not r.want_auth and p.auth_x then format('perimeter-loosened: authenticated GAINED EXECUTE on public.%s(%s), which takes a tenant id as a parameter — the migs 662-664 shape where the parameter becomes the authorisation.', p.fname, p.fargs) end),
    (case when not p.svc_x then format('perimeter-loosened: service_role cannot execute public.%s(%s) — certify''s own read and every script path is broken.', p.fname, p.fargs) end)
  ) as v(violation)
  where v.violation is not null
),

-- ── ARM 6 ────────────────────────────────────────────────────────────────
arm_drift as (
  select format(
    'classifier-disagrees: for workspace "%s" this probe derives status "%s" but starter_template_state_internal says "%s". The probe re-derives the touched flag itself so it can be mutation-tested on synthetic rows; that second copy has now drifted from the one the RPCs use, and the gate and the product no longer mean the same thing by "outdated".',
    s.slug, s.status, public.starter_template_state_internal(s.tenant_id)->>'status') as violation
  from scored s
  -- Only rows that are a REAL workspace. starter_template_state_internal reads
  -- the table, so it can only be compared against a tenant that exists; a
  -- synthetic mutation-test row would always "disagree" and turn this arm into
  -- noise. Gating on public.tenants is not a weakening — every production row
  -- reaching this probe joins tenants to get here in the first place.
  where exists (select 1 from public.tenants t where t.id = s.tenant_id)
    and public.starter_template_state_internal(s.tenant_id)->>'status' is distinct from s.status
),

-- ── ARM 7 ────────────────────────────────────────────────────────────────
arm_vacuous as (
  select 'no-comparisons: zero starter onboarding templates were examined. Zero findings from zero comparisons looks exactly like a clean result, so this is a REFUSAL, not a pass.' as violation
  where (select count(*) from pop) = 0
  union all
  select 'no-comparisons: the canonical starter template has zero items, so every workspace would trivially classify as current and this gate would pass by comparing against nothing.' as violation
  where (select coalesce(jsonb_array_length(items), 0) from canon) = 0
),

-- ── ARM 8: denominators, always ──────────────────────────────────────────
arm_note as (
  select format(
    'starter-template-baseline: %s template(s) compared against a canonical list of %s item(s) (md5 %s) — %s current, %s outdated, %s divergent(by-choice); %s acknowledged. %s',
    (select count(*) from scored),
    (select jsonb_array_length(items) from canon),
    left((select md5(items::text) from canon), 8),
    (select count(*) from scored where status = 'current'),
    (select count(*) from scored where status = 'outdated'),
    (select count(*) from scored where status = 'divergent'),
    (select count(*) from scored where acknowledged),
    coalesce((select string_agg(format('%s=%s(-%s%s)', slug, status, behind_by,
                                        case when acknowledged then ',ack' else '' end), ' ')
                from scored where status <> 'current'), 'every workspace is current')
  ) as note
)
select violation, null::text as note from arm_behind
union all select violation, null from arm_mechanism
union all select violation, null from arm_installer
union all select violation, null from arm_upgrade
union all select violation, null from arm_perimeter
union all select violation, null from arm_drift
union all select violation, null from arm_vacuous
union all select null, note from arm_note
`;
}

export { TEMPLATES_DEFAULT, CANON_DEFAULT, ACKS_DEFAULT, REQUIRED_FUNCTIONS };
