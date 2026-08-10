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
    'COUNTER — the hours-saved model reads de_token_usage on its COST side; exam spend makes economics look worse, never better. Whether to exclude it is a product call, not a leak (mig 131)',
};

export const PRODUCTION_EVIDENCE_PIN_NAMES = Object.keys(PRODUCTION_EVIDENCE_PINS);

const list = (names) => names.map((n) => `'${n}'`).join(', ');
const values = (names) => names.map((n) => `('${n}')`).join(', ');

// Violations-only. `pins` is a parameter so the mutation test can run the REAL
// query with one name removed instead of a paraphrase of it.
export function productionEvidenceSql(pins = PRODUCTION_EVIDENCE_PIN_NAMES) {
  const L = list(pins.length ? pins : [' none ']);
  const V = values(pins.length ? pins : [' none ']);
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
  select 'billable_outcomes ' || b.id || ' is exam-linked but marked production' as violation
    from billable_outcomes b join de_conversations c on c.id = b.conversation_id
   where c.channel = 'exam' and b.origin = 'production'
   limit 5
  union all
  -- Arm 5 (data): an exercise outcome that bills is money invented by a test.
  select 'billable_outcomes ' || id || ' is origin=exercise AND billable' as violation
    from billable_outcomes where origin = 'exercise' and billable
   limit 5
  union all
  -- Arm 6 (data): exam-linked evidence runs feeding the activity feeds.
  select 'evidence_runs ' || er.id || ' is exam-linked but marked production' as violation
    from evidence_runs er join de_conversations c
      on er.account_ref = 'conversation:' || c.id::text
   where c.channel = 'exam' and er.origin = 'production'
   limit 5`;
}
