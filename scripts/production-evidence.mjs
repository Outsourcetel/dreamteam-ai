// ============================================================
// production-evidence.mjs — the Ring-0 ratchet behind mig 682, in ONE place.
//
// Exam activity leaked into production evidence three separate times before
// this existed: a DE with 158 exam conversations and zero real work looked
// busy; guardrail blocks provoked by tests counted against the employee's
// trust evidence; an exam answer could record a BILLABLE resolution. mig 571
// fixed one reader; mig 671 fixed one taxonomy; mig 682 closed the class with
// ONE stamp at the write boundary (`origin` on billable_outcomes /
// de_token_usage / evidence_runs / human_tasks, plus detail->>'origin' on new
// audit rows) and ONE predicate — `public.evidence_is_production(text)` — that
// every metric reader must call.
//
// A shared predicate nobody is forced to use is a convention, not a fix. This
// file is the forcing: certify.mjs runs the probe, certify-mutation-test.mjs
// runs the SAME query with a pin removed and proves it goes red. Neither has
// its own copy. (Pattern and reasoning: scripts/landed-predicate.mjs.)
// ============================================================

// THE RULE: if a function body reads billable_outcomes or de_token_usage, it
// must either call the shared predicate or be pinned here WITH ITS REASON.
// Every name below was read against its defining migration on 2026-08-10. To
// add a name you must be able to finish the sentence "exam rows belong in this
// read because…". "It made the bar green" is not that sentence.
export const PRODUCTION_EVIDENCE_PINS = {
  // ══ WRITERS — they PRODUCE the stamp; there is no read to filter. ══════
  record_billable_outcome:
    'WRITER — carries p_origin and forces an exercise outcome to be born unbilled/unsettleable (mig 682)',
  record_de_token_usage:
    'WRITER — carries p_origin onto every usage row (mig 682)',

  // ══ SETTLEMENT — pending-only by construction. ═════════════════════════
  settle_billable_outcomes:
    "SETTLER — touches status='pending' rows only; an exercise outcome is born 'unbilled' and can never reach it (mig 682 forces this in the writer)",

  // ══ BUDGET — exam spend is REAL spend. The cap must see every token or a
  //    tenant could exam itself past its own ceiling. ═════════════════════
  get_tenant_token_usage_this_month:
    'BUDGET — the monthly cap counts all spend; an exam token costs the same dollars as a production token',
  check_de_budget:
    "BUDGET — per-employee ceiling; same reasoning as the tenant cap (mig 163)",

  // ══ COUNTERS — cost-side reads where exam rows only make the number MORE
  //    conservative, never better. ═══════════════════════════════════════
  get_de_economics:
    'COST-SIDE COUNTER — reads de_token_usage unfiltered ON PURPOSE (exam tokens are real dollars; counting them keeps the economics conservative) while its BENEFIT side calls evidence_is_production since mig 709. The predicate in its body would clear Arm 1 anyway; the pin stays so this asymmetry is a written decision, not an accident',
  get_de_performance_summary:
    "COST-SIDE COUNTER — mig 708 rebuilt it on real columns and its only stamped-table read is AI spend this month (de_token_usage × pricing). Exam tokens are real dollars; excluding them would flatter the panel. Every benefit-shaped field is a raw row count or an honest NULL — roi_hours_saved is null by doctrine §12.3. (Arm 1 caught this within minutes of the rebuild — the pin records the decision it forced)",
};

export const PRODUCTION_EVIDENCE_PIN_NAMES = Object.keys(PRODUCTION_EVIDENCE_PINS);

// ══ COUNT-READ PINS (arms 7-9, added with migs 707/709) ════════════════════
// The table sieve above covers billable_outcomes / de_token_usage — and that
// blind spot is exactly how the 571 defect shipped a SECOND time
// (assess_de_skills_internal counting exam decisions into skill levels, docs/51
// offender #2) and a THIRD and FOURTH instance sat unnoticed
// (get_de_economics' benefit side; get_de_inquiry_metrics — the docs/51 census
// itself missed that one; the widened sieve found it). Arms 7-8 close the
// class: a function that AGGREGATES evidence_run_decisions or de_conversations
// must carry the exam axis — public.evidence_is_production(origin) or the
// quoted 'exam' channel literal (571's `channel is distinct from 'exam'`
// shape) — or be pinned HERE with a reason that finishes the sentence
// "exam rows are safe in this count because…".
//
// ⚠ prosrc includes comments, so a comment containing the QUOTED literal
// 'exam' would satisfy the sieve. Keep migration comments to the unquoted
// word; the mutation suite pins the discrimination either way.
export const COUNT_READ_PINS = {
  cluster_gap_candidates:
    "GAP MINER — counts cluster members to rank severity for the improvement queue; an exam question the employee could not answer reveals a REAL knowledge gap, and the output is a replay-verified, human-approved draft — never a production metric (migs 471+)",
  get_knowledge_doc_citation_stats:
    'DOC USAGE LEDGER — counts citations of a knowledge doc wherever they occurred; an exam citing a doc is a genuine retrieval of that doc. Feeds doc hygiene, not employee performance',
  trg_triage_support_conversation:
    "TRIAGE TRIGGER — mig 671's channel guard allowlists support channels ('widget','hosted','portal','email','dock') BEFORE classifying, which excludes exams without naming them; its only count(*) is a first-user-message check on de_messages",
  snapshot_de_kpi_readings:
    'CSAT-ONLY READ — its de_conversations count requires csat_submitted_at, and an exam thread has no customer to rate it: 0 exam-channel CSAT rows have ever existed (verified live 2026-08-12). If CSAT semantics ever change, add the axis instead of widening this pin',
  de_kpi_status_internal:
    'CSAT-ONLY READ — mig 764 moved the body of get_de_kpi_status in here, so the pin moved with it; get_de_kpi_status is now a thin wrapper that aggregates nothing. Same population as snapshot_de_kpi_readings (csat_submitted_at required; 0 exam CSAT rows have ever existed), and its decision-shaped KPIs come from exam-filtered get_de_performance_metrics (571)',
  check_de_retirement_readiness:
    'DEPENDENCY CHECK — counts OPEN human_tasks/assignments before retirement; the de_conversations subselect only resolves which tasks belong to this employee. Exam-linked open work SHOULD block retirement — losing it silently would be the lie',
  get_de_work_product:
    "ACTIVITY LEDGER, CHANNEL-LABELED — reports conversation totals WITH a by_channel breakdown in the same payload, so exam threads are visible AS exam threads rather than blended into a production rate. It answers 'what did this employee do', not 'how well is it performing'",
};

export const COUNT_READ_PIN_NAMES = Object.keys(COUNT_READ_PINS);

const list = (names) => names.map((n) => `'${n}'`).join(', ');
const values = (names) => names.map((n) => `('${n}')`).join(', ');

// Violations-only. `pins` (and `countPins` for arms 7-9) are parameters so the
// mutation test can run the REAL query with one name removed instead of a
// paraphrase of it.
export function productionEvidenceSql(pins = PRODUCTION_EVIDENCE_PIN_NAMES, countPins = COUNT_READ_PIN_NAMES) {
  const L = list(pins.length ? pins : [' none ']);
  const V = values(pins.length ? pins : [' none ']);
  const CL = list(countPins.length ? countPins : [' none ']);
  const CV = values(countPins.length ? countPins : [' none ']);
  return `
  -- Arm 1: any function reading the stamped evidence tables must call the
  -- predicate or be pinned with a reason.
  select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
         || ' reads billable_outcomes/de_token_usage but never calls '
         || 'public.evidence_is_production(). If it is a metric or evidence read, '
         || 'call the shared predicate (mig 682). If it is a writer, budget check, '
         || 'settler or cost-side counter, pin it in scripts/production-evidence.mjs '
         || 'with the reason.' as violation
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind in ('f','p')
     and (p.prosrc ilike '%billable_outcomes%' or p.prosrc ilike '%de_token_usage%')
     and p.prosrc not ilike '%evidence_is_production%'
     and p.proname not in (${L})
  union all
  -- Arm 2: trust_evidence_for reads audit_events + human_tasks (outside Arm
  -- 1's table sieve) and decides AUTONOMY — it must carry the predicate by
  -- name, forever.
  select 'trust_evidence_for lost its exercise filter — the autonomy evidence '
         || 'would count exam-provoked blocks and exam escalations again (mig 682).' as violation
   where exists (
           select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'trust_evidence_for'
              and p.prosrc not ilike '%evidence_is_production%')
  union all
  -- Arm 3: a pin whose body no longer reads either table (or no longer
  -- exists) guards nothing. Delete it.
  select v.nm || ' is PINNED in scripts/production-evidence.mjs but no longer reads '
         || 'billable_outcomes or de_token_usage (or no longer exists). Delete the pin.' as violation
    from (values ${V}) v(nm)
   where not exists (
           select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = v.nm
              and (p.prosrc ilike '%billable_outcomes%' or p.prosrc ilike '%de_token_usage%'))
  union all
  -- Arm 4 (data): an exam-linked outcome marked production is the original
  -- defect, live. Zero rows or the backfill/writers have regressed.
  -- (Each data arm is parenthesized: LIMIT inside a UNION chain is a syntax
  -- error otherwise — a defect the mutation suite caught before first run.)
  (select 'billable_outcomes ' || b.id || ' is exam-linked but marked production' as violation
     from billable_outcomes b join de_conversations c on c.id = b.conversation_id
    where c.channel = 'exam' and b.origin = 'production'
    limit 5)
  union all
  -- Arm 5 (data): an exercise outcome that bills is money invented by a test.
  (select 'billable_outcomes ' || id || ' is origin=exercise AND billable' as violation
     from billable_outcomes where origin = 'exercise' and billable
    limit 5)
  union all
  -- Arm 6 (data): exam-linked evidence runs feeding the activity feeds.
  (select 'evidence_runs ' || er.id || ' is exam-linked but marked production' as violation
     from evidence_runs er join de_conversations c
       on er.account_ref = 'conversation:' || c.id::text
    where c.channel = 'exam' and er.origin = 'production'
    limit 5)
  union all
  -- Arm 7 (migs 571/707/709): a function that AGGREGATES evidence_run_decisions
  -- is a metric organ until proven otherwise, and a metric organ without the
  -- exam axis is the defect that shipped FOUR times (571's perf metrics, 707's
  -- skills organ, 709's economics benefit side + inquiry metrics). It must
  -- carry public.evidence_is_production() or the quoted 'exam' channel filter,
  -- or be pinned in COUNT_READ_PINS with the reason exam rows are safe there.
  select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
         || ' aggregates evidence_run_decisions without the exam axis — the '
         || 'mig-571 defect shipped four times this way. Filter with '
         || 'public.evidence_is_production(evidence_runs.origin) (or the '
         || '''exam'' channel exclusion), or pin it in scripts/'
         || 'production-evidence.mjs COUNT_READ_PINS with its reason.' as violation
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind in ('f','p')
     and p.prosrc ilike '%evidence_run_decisions%'
     and p.prosrc ilike '%count(%'
     and p.prosrc not ilike '%evidence_is_production%'
     and p.prosrc not ilike '%''exam''%'
     and p.proname not in (${CL})
  union all
  -- Arm 8: the same rule for de_conversations counts (the volume half of the
  -- class — 158 exam threads once read as "conversations" on three surfaces).
  select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
         || ' counts de_conversations without the exam axis. Add channel IS '
         || 'DISTINCT FROM ''exam'' (mig 671 split the corpus on channel), or '
         || 'pin it in scripts/production-evidence.mjs COUNT_READ_PINS with '
         || 'its reason.' as violation
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind in ('f','p')
     and p.prosrc ilike '%from de_conversations%'
     and p.prosrc ilike '%count(%'
     and p.prosrc not ilike '%evidence_is_production%'
     and p.prosrc not ilike '%''exam''%'
     and p.proname not in (${CL})
  union all
  -- Arm 9: a COUNT_READ_PIN whose body no longer count-reads either table (or
  -- no longer exists) guards nothing. Delete it — a pin roster that only grows
  -- is how an allowlist becomes a blindfold.
  select v.nm || ' is PINNED in COUNT_READ_PINS but no longer aggregates '
         || 'evidence_run_decisions or de_conversations (or no longer exists). '
         || 'Delete the pin.' as violation
    from (values ${CV}) v(nm)
   where not exists (
           select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and ((p.prosrc ilike '%evidence_run_decisions%' and p.prosrc ilike '%count(%')
                or (p.prosrc ilike '%from de_conversations%' and p.prosrc ilike '%count(%'))
              and p.proname = v.nm)`;
}
