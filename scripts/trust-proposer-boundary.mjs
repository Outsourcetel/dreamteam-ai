// ============================================================================
// trust-proposer-boundary.mjs — Ring-0: the trust pattern proposer cannot
// decide, and every open proposal it raised is evidence the LEDGER confirms.
//
// Mig 710 built the Gap-2 seam: repeated identical landed human approvals
// become ONE trust_promotion proposal on the existing queue. The entire value
// of that seam rests on two sentences, and this probe holds both:
//
//   PRIVILEGE — the proposer files proposals and NOTHING ELSE. The writer
//   runs as the NOLOGIN role `trust_pattern_proposer`, which holds no EXECUTE
//   on decide_human_task / apply_trust_promotion / trust_apply_level /
//   trust_demote / set_de_autonomy, no UPDATE/DELETE on human_tasks (status
//   IS the decision), no write of any kind on de_autonomy (the dial) or
//   approval_authority (the limits), and UPDATE on trust_policies ONLY for
//   the four request-bookkeeping columns. Only a human decision, through
//   decide_human_task, moves a dial — and only via apply_trust_promotion,
//   which re-verifies evidence and is undone by trust_demote.
//
//   EVIDENCE — every OPEN system-raised proposal (trust_policies.requested_by
//   IS NULL is the marker; the human path always stamps auth.uid()) cites
//   >= 3 decisions that the ledger, RE-READ at probe time, confirms as
//   approved + production-origin + landed (mig 679's shared predicate). A
//   stored citation is a stored marker, never truth (mig 642) — so the arms
//   join back to human_tasks and action_executions rather than trusting
//   pending_evidence.
//
// ⚠ has_function_privilege / has_table_privilege answer INCLUDING
// inheritance through PUBLIC — a REVOKE is not a description of the
// resulting privileges, so the arms ask the privilege question directly.
// ⚠ The role is resolved through a pg_roles OID join, never a name literal:
// has_function_privilege('name', …) RAISES 42704 when the role is gone,
// which would turn the exact violation this probe most needs to report
// (role-gone) into a probe ERROR. Lesson inherited from advisory-boundary.
// ⚠ AND THE COUNT: the denominator rides on every run — proposals scanned,
// citations re-verified, groups the detector currently reports. Zero open
// proposals is a LEGAL state (nothing qualifies yet — the machinery is for
// the accumulating future), so unlike the brief probe there is no
// no-comparisons violation on an empty proposal scan; the denominator line
// says out loud that zero were compared.
// ============================================================================

/**
 * @param {object} [opts]
 * @param {string} [opts.proposalExtra]  Extra rows for the evidence arms'
 *   proposal scan, as a SELECT with the shape (task_id uuid, tenant_id uuid,
 *   slug text, pending_evidence jsonb). Whether a fixture FIRES still depends
 *   on the real ledger — a fixture citing three genuinely approved, landed,
 *   production decisions stays silent, which is what makes the mutation
 *   cases discriminating.
 * @param {string} [opts.orphanExtra]  Extra rows for the orphan arm's scan,
 *   shape (task_id uuid, slug text, title text). Whether a row is flagged
 *   depends on the real trust_policies.pending_task_id linkage.
 */
export function trustProposerBoundarySql(opts = {}) {
  const { proposalExtra = null, orphanExtra = null } = opts;
  return `
with proposer_role as (
  select oid from pg_roles where rolname = 'trust_pattern_proposer'
),
role_present as (
  select exists (select 1 from pg_roles where rolname = 'trust_pattern_proposer') as ok
),
live_fns as (
  select p.oid,
         p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig,
         r.rolname as owner,
         p.prosecdef,
         p.provolatile,
         p.prorettype,
         p.prokind,
         regexp_replace(p.prosrc, '--[^\\n]*', '', 'g') as src
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_roles r on r.oid = p.proowner
   where n.nspname = 'public'
),
open_proposals as (
  -- THE EVIDENCE POPULATION: every OPEN system-raised proposal. requested_by
  -- IS NULL is the system marker — request_trust_promotion always stamps the
  -- human requester.
  select ht.id as task_id, ht.tenant_id,
         coalesce(t.slug, '(tenant ' || ht.tenant_id || ' missing)') as slug,
         tp.pending_evidence
    from human_tasks ht
    join trust_policies tp on tp.pending_task_id = ht.id
    left join tenants t on t.id = ht.tenant_id
   where ht.type = 'trust_promotion'
     and ht.status = 'pending'
     and tp.requested_by is null${proposalExtra ? `
  union all
${proposalExtra}` : ''}
),
cited as (
  -- Each cited decision, RE-VERIFIED against the ledger: approved,
  -- production-origin, and landed through THE shared predicate. Never the
  -- stored citation alone.
  select op.task_id, op.slug, d->>'task_id' as cited_task,
         exists (
           select 1 from human_tasks h
            where h.id = nullif(d->>'task_id', '')::uuid
              and h.tenant_id = op.tenant_id
              and h.type = 'action_approval'
              and h.status = 'approved'
              and public.evidence_is_production(h.origin)
              and exists (select 1 from action_executions ex
                           where (ex.task_id = h.id or ex.resolves_task_id = h.id)
                             and public.action_execution_landed(ex))
         ) as ledger_ok
    from open_proposals op,
         jsonb_array_elements(coalesce(op.pending_evidence->'pattern'->'decisions', '[]'::jsonb)) d
),
orphan_scan as (
  -- Every pending trust_promotion task, system- OR human-raised: one with no
  -- policy pointing back at it cannot be applied (apply_trust_promotion
  -- resolves through pending_task_id and would no-op) — a row asking a human
  -- for a decision that would change NOTHING, the mig-590/701 class.
  select ht.id as task_id,
         coalesce(t.slug, '(tenant ' || ht.tenant_id || ' missing)') as slug,
         ht.title
    from human_tasks ht
    left join tenants t on t.id = ht.tenant_id
   where ht.type = 'trust_promotion'
     and ht.status = 'pending'${orphanExtra ? `
  union all
${orphanExtra}` : ''}
),
counted as (
  select (select count(*) from open_proposals) as proposals_scanned,
         (select count(*) from cited) as citations_checked,
         (select count(*) from orphan_scan) as orphan_scanned
)

-- ── 1. ROLE GONE — a boundary with no subject. ──────────────────────────────
select 'role-gone — the trust_pattern_proposer role does not exist. The '
       || 'proposer writer would now run as whatever owns it, and every '
       || 'privilege claim below is vacuous.' as violation,
       null::text as note
  from role_present where not ok

union all

-- ── 2. CAN DECIDE OR MOVE A DIAL — the things the proposer must never do. ──
select 'can-decide — trust_pattern_proposer holds EXECUTE on public.' || f.sig
       || '. A proposer that can reach ' ||
       case when f.sig like 'decide_human_task(%' then 'the decision RPC'
            when f.sig like 'apply_trust_promotion(%' then 'the apply hook (it could approve its own proposal)'
            else 'a dial writer' end
       || ' is an approver nobody hired.' as violation,
       null::text as note
  from live_fns f, proposer_role pr
 where (f.sig like 'decide_human_task(%'
     or f.sig like 'apply_trust_promotion(%'
     or f.sig like 'trust_apply_level(%'
     or f.sig like 'trust_demote(%'
     or f.sig like 'set_de_autonomy(%')
   and has_function_privilege(pr.oid, f.oid, 'EXECUTE')

union all

-- ── 3. CAN WRITE WHAT IT MUST ONLY READ — the queue's status, the dial, the
--      limits, the policy's level. Column-level: a table-level check misses
--      a quiet GRANT UPDATE (current_level). ───────────────────────────────
select 'can-write — trust_pattern_proposer holds ' || v.what || '. ' || v.why as violation,
       null::text as note
  from proposer_role pr
 cross join lateral (
   select 'UPDATE on human_tasks' as what,
          'human_tasks.status IS the human''s decision; a proposer that can write it can approve without any RPC.' as why
    where has_table_privilege(pr.oid, 'public.human_tasks'::regclass, 'UPDATE')
       or has_any_column_privilege(pr.oid, 'public.human_tasks'::regclass, 'UPDATE')
   union all
   select 'DELETE on human_tasks',
          'deleting a task erases a pending decision.'
    where has_table_privilege(pr.oid, 'public.human_tasks'::regclass, 'DELETE')
   union all
   select 'a write privilege on de_autonomy',
          'de_autonomy IS the dial. Only trust_apply_level, behind a human decision, may write it.'
    where has_table_privilege(pr.oid, 'public.de_autonomy'::regclass, 'INSERT')
       or has_table_privilege(pr.oid, 'public.de_autonomy'::regclass, 'UPDATE')
       or has_table_privilege(pr.oid, 'public.de_autonomy'::regclass, 'DELETE')
       or has_any_column_privilege(pr.oid, 'public.de_autonomy'::regclass, 'UPDATE')
   union all
   select 'a write privilege on approval_authority',
          'approval_authority is the limits surface (migs 626/627); the proposer proposes, it never widens limits.'
    where has_table_privilege(pr.oid, 'public.approval_authority'::regclass, 'INSERT')
       or has_table_privilege(pr.oid, 'public.approval_authority'::regclass, 'UPDATE')
       or has_table_privilege(pr.oid, 'public.approval_authority'::regclass, 'DELETE')
       or has_any_column_privilege(pr.oid, 'public.approval_authority'::regclass, 'UPDATE')
   union all
   select 'UPDATE on trust_policies.' || col.c,
          'outside the four request-bookkeeping columns — ' || col.c || ' changes what the policy IS, not what is pending on it.'
     from (values ('current_level'), ('max_level'), ('status'), ('criteria'),
                  ('ladder'), ('action_category'), ('de_id')) col(c)
    where has_column_privilege(pr.oid, 'public.trust_policies'::regclass, col.c, 'UPDATE')
 ) v(what, why)

union all

-- ── 4. CANNOT FILE — the liveness half. A proposer that lost its INSERT or
--      its bookkeeping UPDATE fails SILENTLY: the sweep reports raised:0
--      forever and nobody learns anything, the built-but-unfed breaker
--      (mig 625) with a privilege cause. ───────────────────────────────────
select 'cannot-file — trust_pattern_proposer lost ' || v.what
       || '. Proposals silently stop; repeated approvals teach nothing again.' as violation,
       null::text as note
  from proposer_role pr
 cross join lateral (
   select 'INSERT on human_tasks' as what
    where not has_table_privilege(pr.oid, 'public.human_tasks'::regclass, 'INSERT')
   union all
   select 'UPDATE on trust_policies.' || col.c
     from (values ('pending_task_id'), ('pending_evidence'),
                  ('requested_by'), ('requested_at')) col(c)
    where not has_column_privilege(pr.oid, 'public.trust_policies'::regclass, col.c, 'UPDATE')
 ) v(what)

union all

-- ── 5. IDENTITY DRIFT — the writer must RUN AS the role; the detector must
--      be unable to write and must keep its load-bearing conjuncts. ────────
select 'identity-drift — ' || exp.sig || ': '
       || case when f.oid is null then 'function is GONE — the seam lost a limb and every claim below it is vacuous'
               when f.owner is distinct from exp.owner
                 then 'owned by ' || f.owner || ', expected ' || exp.owner
                      || case when exp.kind = 'writer'
                              then ' — a writer owned by anything but the boundary role runs with that owner''s privileges and the boundary is theatre'
                              else ' — the detector bypasses RLS deliberately and must stay under postgres' end
               when exp.kind = 'writer' and not f.prosecdef
                 then 'no longer SECURITY DEFINER — it now runs as the CALLER'
               when exp.kind = 'reader' and f.provolatile = 'v'
                 then 'VOLATILE — a reader that may write is a writer in waiting'
               when exp.kind = 'reader' and f.src not ilike '%evidence_is_production%'
                 then 'lost the exam axis — an exam decision could count toward widening trust (the mig-571/682/707 class, a fourth time)'
               when exp.kind = 'reader' and f.src not ilike '%tenant_is_operational%'
                 then 'lost the suspension filter — a suspended workspace could grow proposals'
               when exp.kind = 'reader' and f.src not ilike '%action_execution_landed%'
                 then 'no longer requires landed executions — approvals nobody carried out would count (mig 679)'
               when exp.kind = 'reader' and f.src not ilike '%n_ok >= 3%'
                 then 'the pattern floor (N=3, mig 683''s founder-ratified human-evidence floor) is gone or was changed silently'
          end as violation,
       null::text as note
  from (values
    ('raise_trust_widening_proposals(p_tenant_id uuid)', 'trust_pattern_proposer', 'writer'),
    ('detect_trust_widening_patterns(p_tenant_id uuid)', 'postgres',               'reader')
  ) exp(sig, owner, kind)
  left join live_fns f on f.sig = exp.sig
 where f.oid is null
    or f.owner is distinct from exp.owner
    or (exp.kind = 'writer' and not f.prosecdef)
    or (exp.kind = 'reader' and (f.provolatile = 'v'
        or f.src not ilike '%evidence_is_production%'
        or f.src not ilike '%tenant_is_operational%'
        or f.src not ilike '%action_execution_landed%'
        or f.src not ilike '%n_ok >= 3%'))

union all

-- ── 6. REACHABLE DECIDER — the two-paths trap. The role must not be able to
--      reach ANY function that decides, writes the queue, or moves the dial;
--      the front door is not the only pen. Trigger-returning functions are
--      excluded because Postgres refuses to call them directly. ────────────
select 'reachable-decider — trust_pattern_proposer can EXECUTE public.' || f.sig
       || ', whose body ' ||
       case when f.src ~* '\\mdecide_human_task\\s*\\(' then 'calls decide_human_task'
            when f.src ~* '\\mapply_trust_promotion\\s*\\(' then 'calls apply_trust_promotion'
            when f.src ~* '\\mtrust_apply_level\\s*\\(' then 'calls trust_apply_level'
            when f.src ~* '\\mset_de_autonomy\\s*\\(' then 'calls set_de_autonomy'
            when f.src ~* '\\mtrust_demote\\s*\\(' then 'calls trust_demote'
            when f.src ~* 'insert\\s+into\\s+(public\\.)?de_autonomy'
              or f.src ~* 'update\\s+(public\\.)?de_autonomy' then 'writes de_autonomy'
            else 'writes human_tasks' end
       || '. The boundary holds only if NOTHING the role can reach can decide or move a dial.' as violation,
       null::text as note
  from live_fns f
 cross join proposer_role pr
 where f.prorettype <> 'trigger'::regtype
   and f.prokind in ('f','p')
   and has_function_privilege(pr.oid, f.oid, 'EXECUTE')
   and (f.src ~* 'update\\s+(public\\.)?human_tasks'
     or f.src ~* '\\mdecide_human_task\\s*\\('
     or f.src ~* '\\mapply_trust_promotion\\s*\\('
     or f.src ~* '\\mtrust_apply_level\\s*\\('
     or f.src ~* '\\mset_de_autonomy\\s*\\('
     or f.src ~* '\\mtrust_demote\\s*\\('
     or f.src ~* 'insert\\s+into\\s+(public\\.)?de_autonomy'
     or f.src ~* 'update\\s+(public\\.)?de_autonomy')

union all

-- ── 7. PERIMETER — the seam's functions reach no browser. ───────────────────
select 'seam-reachable — ' || f.sig || ' is executable by ' || who.r
       || '. The detector''s output spans tenants and the writer files '
       || 'proposals; the only lawful callers are the proposer role, the '
       || 'service role, and the daily sweep.' as violation,
       null::text as note
  from live_fns f
 cross join (values ('anon'), ('authenticated'), ('public')) who(r)
 where f.sig in ('detect_trust_widening_patterns(p_tenant_id uuid)',
                 'raise_trust_widening_proposals(p_tenant_id uuid)',
                 'compute_trust_proposal_brief(p_task_id uuid)')
   and has_function_privilege(who.r, f.oid, 'EXECUTE')

union all

-- ── 8. SWEEP UNFED — built-but-unfed is the mig-625 breaker defect. The
--      daily governance sweep is the seam's only heartbeat; if its body
--      stops calling the proposer, patterns accumulate and nothing fires,
--      which looks exactly like "no group qualifies yet". ──────────────────
select 'sweep-unfed — de_governance_sweep_internal no longer calls '
       || 'raise_trust_widening_proposals. The seam is built and starved: '
       || 'repeated approvals teach nothing again, silently.' as violation,
       null::text as note
 where not exists (
         select 1 from live_fns f
          where f.sig = 'de_governance_sweep_internal()'
            and f.src ilike '%raise_trust_widening_proposals%')

union all

-- ── 9. CITATION BELOW FLOOR — an open system proposal must cite >= 3
--      decisions. One that does not should not exist (the writer only files
--      what the detector qualified at N=3). ────────────────────────────────
select 'citation-below-floor — ' || op.slug || ' [task ' || op.task_id || ']: '
       || 'open system-raised proposal cites '
       || coalesce(jsonb_array_length(op.pending_evidence->'pattern'->'decisions'), 0)
       || ' decision(s) — the pattern floor is 3. Either the evidence was '
       || 'edited after filing or a writer bypassed the detector.' as violation,
       null::text as note
  from open_proposals op
 where coalesce(jsonb_array_length(op.pending_evidence->'pattern'->'decisions'), 0) < 3

union all

-- ── 10. CITATION NOT IN LEDGER — a cited decision the ledger does not
--       confirm as approved + production + landed. The stored citation is a
--       stored marker; this arm re-reads the thing it points at (mig 642). ─
select 'citation-not-in-ledger — ' || c.slug || ' [task ' || c.task_id || ']: '
       || 'cites decision ' || coalesce(c.cited_task, '(null)')
       || ', which the ledger does NOT confirm as an approved, '
       || 'production-origin action_approval with a landed execution. '
       || 'Evidence that cannot be re-derived is not evidence.' as violation,
       null::text as note
  from cited c
 where not c.ledger_ok

union all

-- ── 11. DORMANT WORKSPACE — a suspended tenant must produce nothing. ────────
select 'proposal-in-dormant-workspace — ' || op.slug || ' [task ' || op.task_id
       || ']: open system-raised proposal in a workspace that is not '
       || 'operational. The detector filters on tenant_is_operational; this '
       || 'row means something bypassed it, or the workspace was suspended '
       || 'after filing and the proposal should be withdrawn.' as violation,
       null::text as note
  from open_proposals op
 where not public.tenant_is_operational(op.tenant_id)

union all

-- ── 12. ORPHAN PROPOSAL — a pending trust_promotion task no policy points
--       at. Approving it would no-op in apply_trust_promotion: a decision
--       that changes nothing, asked of a human (the mig-590/701 class). ────
select 'orphan-proposal — ' || o.slug || ' / ' || coalesce(o.title, '(untitled)')
       || ' [task ' || o.task_id || ']: pending trust_promotion task with NO '
       || 'trust_policies.pending_task_id pointing at it. Deciding it changes '
       || 'nothing; withdraw or re-link it.' as violation,
       null::text as note
  from orphan_scan o
 where not exists (select 1 from trust_policies tp where tp.pending_task_id = o.task_id)

union all

-- ── The denominator, surfaced on every run (violation NULL: printed, never
--    failed on). Zero open proposals is a legal state — the line says so. ───
select null::text as violation,
       'trust-proposer-boundary: ' || c.proposals_scanned
       || ' open system proposal(s) scanned; ' || c.citations_checked
       || ' citation(s) re-verified against the ledger; ' || c.orphan_scanned
       || ' pending trust_promotion task(s) in the orphan scan; detector '
       || 'currently reports '
       || (select count(*) from public.detect_trust_widening_patterns(null))
       || ' qualifying group(s) awaiting a proposal' as note
  from counted c
`;
}
