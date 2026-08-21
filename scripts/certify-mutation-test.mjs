// Mutation-test the Ring-0 probes: for each, prove that INJECTING the exact
// violation it hunts makes the probe RETURN ROWS. A probe that stays empty when
// the thing it forbids is present is theater — and this codebase has shipped
// exactly that (a vacuous invariants query, a test that asserted a bug).
//
// Read-only against PRODUCTION. Every mutation is a SELECT that SYNTHESISES a
// violating row in-query (no writes) and confirms the probe's own predicate
// fires on it. Where a probe reads live catalog state that a SELECT cannot
// fake, the mutation is described and marked MANUAL.
import { readFileSync } from 'node:fs';
// The REAL probe, not a copy of it. mig 661 shipped a pin that could not fail
// because the check and the thing it checked had drifted apart; the cases below
// run certify's own query with a pin removed rather than a paraphrase of it.
import { landedPredicateSql, LANDED_PINS } from './landed-predicate.mjs';
import { productionEvidenceSql, PRODUCTION_EVIDENCE_PIN_NAMES, COUNT_READ_PIN_NAMES } from './production-evidence.mjs';
import { bareContainerLiteralSql } from './bare-container-literal.mjs';
import { unexecutableApprovalSql } from './unexecutable-approval.mjs';
import { advisoryBoundarySql } from './advisory-boundary.mjs';
import { trustProposerBoundarySql } from './trust-proposer-boundary.mjs';
import { gapGateConductSql, auditedStepsWritesSql, snapshotGateSql, gapEvidenceSql } from './playbook-gap-probes.mjs';
import { writePerimeterSql, silentNoopWriteSql, sealedEvidenceSql } from './write-perimeter.mjs';
import { triggerExecutePerimeterSql, TRIGGER_FN_SOURCE } from './trigger-execute-perimeter.mjs';
// mig 817's ratchet — the REAL probe SQL, imported so these cases exercise the
// query certify runs rather than a paraphrase of it.
import { starterTemplateBaselineSql } from './starter-template-baseline.mjs';
// certify's ACTUAL provider-catalog comparison, imported rather than restated.
// Its assertions are all silent against a clean production, so the only thing
// that can prove they fire is running the real function over a mutated copy of
// real state — see the cases at the end of CASES.
import { providerCatalogFailures, providerCheckValues, readConnectorConstants } from './provider-catalog-check.mjs';
// certify's ACTUAL discovery-spine comparison. Same reason as
// provider-catalog above: production is clean (14 well-formed dimensions, 0
// sessions today — the interview engine has not been used yet), so every
// assertion below is silent against real state, and the only way to prove
// any of them can fire is to hand the REAL function a mutated COPY of that
// state, never a write.
import { discoverySpineFailures } from './discovery-spine-check.mjs';
// certify's ACTUAL subprocessor-disclosure comparison (register A-8). Same
// reason as the two above and then some: EVERY arm of it is silent against
// today's state — the manifest matches the chain, both configured credentials
// are disclosed, the page derives — and one of its stores
// (tenant_llm_credentials) holds zero rows, so its comparison count is
// legitimately 0. Nothing but a fired mutation distinguishes any of that from
// a gate that cannot fail.
import {
  subprocessorDisclosureFailures, readManifest, readLlmChain,
  readResolvedKeyNames, readKeyTokens, egressSources, PAGE_SRC,
} from './subprocessor-disclosure-check.mjs';
// certify's ACTUAL discovery-proposal-DECISION comparison — the same function,
// imported, never a paraphrase. This one is the most important import in the
// file: public.discovery_proposals holds ZERO rows (measured, along with 0
// discovery_sessions and 0 discovery_proposal_decision audit events), so its
// four ROW assertions are silent against real state for the reason that most
// resembles being correct. Nothing but a fired mutation is evidence that any
// of them can fail at all. KIND_ROUTES comes with it so the cases below can
// perform the exact edit that would buy silence and watch it be refused.
import {
  discoveryProposalFailures, KIND_ROUTES, EXPECTED_KIND_TABLES, NIL_UUID,
  proposalsSql, resolverControlSql, routeTablesSql, deciderSql, kindCheckValues,
  constraintDefsSql, privSql, mapPriv,
  EXPECTED_KIND_EXCLUSIONS, EXCLUSION_ANCHORS, exclusionAnchorSql,
  // The two resolver expressions, imported so the WIRING cases can perform the
  // exact swaps that used to be invisible — putting the tenant-SCOPED resolver
  // in the tenant-BLIND slot, and widening the tenant-blind one in place —
  // instead of describing them in a comment.
  objectResolvesSql, objectExistsAnyTenantSql,
} from './discovery-proposal-check.mjs';
// certify's ACTUAL ledger-vs-COMMITTED comparison. This one is here because
// its predecessor was the exact thing this file exists to distrust: a probe
// named migration-files-match-ledger-checksums that asserted only "no ledger
// row has a NULL checksum", over a ledger with 763 rows and zero nulls. It
// returned zero rows the way a clean scan does and could not have failed. The
// cases at the end of CASES synthesise every state it now decides.
import {
  readCommittedMigrations, committedLedgerFailures, migrationChecksum, MIGRATION_DIR,
} from './migration-committed-check.mjs';
import { readdirSync } from 'node:fs';

// ── Fixtures for no-untyped-literal-appended-to-a-container ────────────────
// The production catalog is CLEAN of this shape, so the probe returns zero rows
// and passes trivially. These fixtures are the only thing proving it can fire.
// They are fed through bareContainerLiteralSql() — the REAL query the probe
// runs — so a regex that matches nothing fails these cases instead of hiding
// behind a clean database. That is not hypothetical: the jsonb branch was first
// written with `\b` (a BACKSPACE in Postgres regex, not a word boundary), had
// zero coverage, and returned zero rows exactly like a clean scan.
const fx = (prosrc, fullargs = '') => [{ proname: 'fixture_fn', prosrc, fullargs }];

const BODY_BARE = fx(`declare v_errors text[] := '{}';
begin
  if v_n < 1 then v_errors := v_errors || 'template needs at least 1 item'; end if;
  return v_errors;
end;`);
const BODY_CAST = fx(`declare v_errors text[] := '{}';
begin
  if v_n < 1 then v_errors := v_errors || 'template needs at least 1 item'::text; end if;
  return v_errors;
end;`);
const BODY_FORMAT = fx(`declare v_errors text[] := '{}';
begin
  v_errors := v_errors || format('item "%s" needs a label', v_key);
  return v_errors;
end;`);
const BODY_ARRAY_APPEND = fx(`declare v_reasons text[] := '{}';
begin
  v_reasons := array_append(v_reasons, 'failed_certification');
  return v_reasons;
end;`);
const BODY_LITERAL_LEFT = fx(`declare v_errors text[] := '{}';
begin
  v_errors := 'template needs at least 1 item' || v_errors;
  return v_errors;
end;`);
const BODY_LITERAL_LEFT_CAST = fx(`declare v_errors text[] := '{}';
begin
  v_errors := 'template needs at least 1 item'::text || v_errors;
  return v_errors;
end;`);
// No '[' anywhere in these two, so the ARRAY branch of the regex cannot match
// them. Detection therefore depends entirely on the json branch and its \y.
const BODY_JSONB_BARE = fx(`declare v_doc jsonb := jsonb_build_array();
begin
  v_doc := v_doc || 'not valid json';
  return v_doc;
end;`);
const BODY_JSONB_CAST = fx(`declare v_doc jsonb := jsonb_build_array();
begin
  v_doc := v_doc || '{"ok": true}'::jsonb;
  return v_doc;
end;`);
const BODY_MULTILINE = fx(`declare v_errors text[] := '{}';
begin
  v_errors := v_errors
              ||
              'append spanning three lines';
  return v_errors;
end;`);
const BODY_MULTILINE_CAST = fx(`declare v_errors text[] := '{}';
begin
  v_errors := v_errors
              ||
              'append spanning three lines'::text;
  return v_errors;
end;`);
const BODY_ARRAY_CAT = fx(`declare v_errors text[] := '{}';
begin
  v_errors := array_cat(v_errors, 'malformed');
  return v_errors;
end;`);
const BODY_ARRAY_CAT_OK = fx(`declare v_errors text[] := '{}';
begin
  v_errors := array_cat(v_errors, array['fine']);
  return v_errors;
end;`);
const BODY_SCALAR = fx(`declare v_summary text := '';
begin
  v_summary := v_summary || 'Log activity on ' || v_acct_name;
  return v_summary;
end;`);
const BODY_COMMENTED = fx(`declare v_errors text[] := '{}';
begin
  -- v_errors := v_errors || 'this line is PROSE, exactly as mig 685 quotes it';
  v_errors := v_errors || format('item "%s" needs a label', v_key);
  return v_errors;
end;`);
const BODY_ARG_ARRAY = fx(`begin
  p_notes := p_notes || 'appended to an array argument';
  return p_notes;
end;`, 'p_notes text[]');
const BODY_ARG_ARRAY_CAST = fx(`begin
  p_notes := p_notes || 'appended to an array argument'::text;
  return p_notes;
end;`, 'p_notes text[]');
const REF = 'rfsvmhcqeiyrxivbmpel';
function token() {
  const env = readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
  const line = env.split(/\r?\n/).find((l) => l.startsWith('SUPABASE_ACCESS_TOKEN='));
  return line.slice('SUPABASE_ACCESS_TOKEN='.length).replace(/^["']|["']$/g, '').trim();
}
const TOKEN = token();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Retry policy copied from certify.mjs, and for the same reason: a single
// transient 502 from the Management API used to throw out of q() and abort the
// WHOLE suite part-way, leaving a run that had proven some cases and not others
// while exiting nonzero — indistinguishable at a glance from a real mutation
// failure. TRANSPORT ONLY. A 4xx is where a genuine SQL error lands, and
// retrying one would be retrying a broken case into a timeout.
async function q(sql, attempt = 0) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
  const t = await res.text();
  if (!res.ok) {
    if ((res.status === 429 || res.status >= 500 || res.status === 0) && attempt < 3) {
      await sleep(1500 * (attempt + 1));
      return q(sql, attempt + 1);
    }
    throw new Error(`${res.status}: ${t.slice(0,200)}`);
  }
  return JSON.parse(t);
}

// ── workspace-admin-has-an-owner: the REAL probe, read as text ─────────────
// This probe is INLINE in certify.mjs (like its neighbour
// bound-onboarding-items-complete-from-evidence), so unlike advisory-boundary
// or landed-predicate there is no module to import. It is therefore READ AS
// TEXT rather than paraphrased — a paraphrase is the thing this file exists to
// distrust, and this probe's whole premise is that a checker which cannot fail
// is theatre. Every step below THROWS instead of degrading into a case that
// silently tests nothing.
const DEMO_EXEMPTION = "t.id <> 'a0000000-0000-0000-0000-000000000001'";
const WORKSPACE_ADMIN_SQL = (() => {
  const src = readFileSync('scripts/certify.mjs', 'utf8');
  const at = src.indexOf("name: 'workspace-admin-has-an-owner'");
  if (at < 0) throw new Error('workspace-admin-has-an-owner: probe not found in scripts/certify.mjs');
  const open = src.indexOf('sql: `', at);
  if (open < 0) throw new Error('workspace-admin-has-an-owner: no sql template literal follows the probe name');
  const close = src.indexOf('`', open + 6);
  if (close < 0) throw new Error('workspace-admin-has-an-owner: unterminated sql template literal');
  const sql = src.slice(open + 6, close);
  // Landmarks, so a formatting change that moves the extraction window fails
  // here rather than producing cases that pass over the wrong text.
  for (const landmark of ['is_workforce_assistant', 'get_agentic_tools_for_de', DEMO_EXEMPTION]) {
    if (!sql.includes(landmark)) {
      throw new Error(`workspace-admin-has-an-owner: extracted SQL is missing "${landmark}" — the extractor grabbed the wrong text`);
    }
  }
  return sql;
})();
// The probe now emits a denominator row (violation NULL, note set) on every
// run, which certify prints and never fails on. The harness counts ROWS, so
// the note would make every `silent` half return 1 and every case fail — these
// count violations, exactly as certify does.
const violationsOnly = (sql) => `select * from (${sql}) z where z.violation is not null`;
const mutate = (find, replaceWith) => {
  const out = WORKSPACE_ADMIN_SQL.replace(find, replaceWith);
  if (out === WORKSPACE_ADMIN_SQL) {
    throw new Error(`workspace-admin-has-an-owner: mutation "${find}" changed nothing — the case would have tested the unmutated probe`);
  }
  return out;
};
// A tenant-status filter anywhere in the predicate is the regression F2 named:
// every tenant is born 'trial', so an active-only probe is blind for exactly
// the window in which a newly-provisioned workspace is newly broken.
const STATUS_FILTER = /\bstatus\s*(=|<>|!=|in)\s*[('"]/i;
const statusFilterFindings = (sql) => {
  const m = sql.match(STATUS_FILTER);
  return m ? [{ finding: `the probe filters tenants by status: ${m[0]}` }] : [];
};

// Each case: a predicate lifted from the real probe, applied to a synthesised
// violating row. It MUST return >=1 row (probe fires) and the clean row MUST
// return 0 (probe silent). Both halves matter: a probe that fires on everything
// is as useless as one that fires on nothing.
const CASES = [
  // ── mig 679's ratchet: landed-reads-use-the-shared-predicate ────────────
  // The first two run certify's ACTUAL probe against the LIVE production
  // catalog with one pin removed / one bogus pin added. That is a stronger
  // proof than any synthesised row: it shows the real query, over real bodies,
  // names the real function the moment its exemption goes away.
  {
    name: 'landed-reads-use-the-shared-predicate (drop a real pin -> the real probe names that function)',
    fires: landedPredicateSql(LANDED_PINS.filter((n) => n !== 'get_de_action_metrics')),
    silent: landedPredicateSql(),
  },
  {
    name: 'landed-reads-use-the-shared-predicate (a pin guarding nothing is itself a violation)',
    fires: landedPredicateSql([...LANDED_PINS, 'zz_pin_for_a_body_that_does_not_exist']),
    silent: landedPredicateSql(),
  },
  // ── mig 682's ratchet: exam-evidence-stays-out-of-production-metrics ────
  // Same construction as 679's: the REAL probe over the LIVE catalog, one pin
  // removed / one bogus pin added. record_billable_outcome definitely reads
  // billable_outcomes and (post-682) never calls the predicate — dropping its
  // pin must make the real query name it.
  {
    name: 'exam-evidence-stays-out-of-production-metrics (drop a real pin -> the real probe names that function)',
    fires: productionEvidenceSql(PRODUCTION_EVIDENCE_PIN_NAMES.filter((n) => n !== 'record_billable_outcome')),
    silent: productionEvidenceSql(),
  },
  {
    name: 'exam-evidence-stays-out-of-production-metrics (a pin guarding nothing is itself a violation)',
    fires: productionEvidenceSql([...PRODUCTION_EVIDENCE_PIN_NAMES, 'zz_pin_for_a_body_that_does_not_exist']),
    silent: productionEvidenceSql(),
  },
  // ── Arms 7-9 (migs 707/709): count-reads carry the exam axis ─────────────
  // Same construction: the REAL probe over the LIVE catalog, one count-pin
  // removed / one bogus count-pin added. cluster_gap_candidates definitely
  // aggregates evidence_run_decisions with no exam axis — dropping its pin
  // must make the real query name it.
  {
    name: 'exam-evidence count-read arm (drop a real COUNT_READ pin -> the real probe names that function)',
    fires: productionEvidenceSql(PRODUCTION_EVIDENCE_PIN_NAMES, COUNT_READ_PIN_NAMES.filter((n) => n !== 'cluster_gap_candidates')),
    silent: productionEvidenceSql(),
  },
  {
    name: 'exam-evidence count-read arm (a COUNT_READ pin guarding nothing is itself a violation)',
    fires: productionEvidenceSql(PRODUCTION_EVIDENCE_PIN_NAMES, [...COUNT_READ_PIN_NAMES, 'zz_count_pin_for_nothing']),
    silent: productionEvidenceSql(),
  },
  {
    // THE ORGAN THAT SHIPPED THE DEFECT TWICE, pinned by its own history: the
    // `fires` body is the EXACT decision-read that was live in
    // assess_de_skills_internal until mig 707 (mig 430's text, verbatim); the
    // `silent` body is 707's replacement. If anyone re-creates the organ
    // without the filter — the third recreation the founder brief forbids —
    // this is the shape the live Arm 7 catches, proven here on the real
    // predicate rather than assumed.
    name: 'exam-evidence count-read arm (the exact pre-707 assess_de_skills_internal read is caught; the 707 read is clean)',
    fires: `select 1 where exists (select 1 from (values ('assess_de_skills_internal_v430',
              'select count(*), count(*) filter (where d.decision = ''needs_review'') from evidence_run_decisions d join evidence_runs er on er.id = d.evidence_run_id where er.tenant_id = v_de.tenant_id and er.de_id = v_de.id and d.created_at > now() - interval ''30 days''')) v(nm, src)
             where src ilike '%evidence_run_decisions%' and src ilike '%count(%'
               and src not ilike '%evidence_is_production%' and src not ilike '%''exam''%'
               and nm not in (${COUNT_READ_PIN_NAMES.map((n) => `'${n}'`).join(', ')}))`,
    silent: `select 1 where exists (select 1 from (values ('assess_de_skills_internal_v707',
              'select count(*), count(*) filter (where d.decision = ''needs_review'') from evidence_run_decisions d join evidence_runs er on er.id = d.evidence_run_id where er.tenant_id = v_de.tenant_id and er.de_id = v_de.id and public.evidence_is_production(er.origin) and d.created_at > now() - interval ''30 days''')) v(nm, src)
             where src ilike '%evidence_run_decisions%' and src ilike '%count(%'
               and src not ilike '%evidence_is_production%' and src not ilike '%''exam''%'
               and nm not in (${COUNT_READ_PIN_NAMES.map((n) => `'${n}'`).join(', ')}))`,
  },
  {
    // The conversations half (arm 8), and the 571-shape channel literal as the
    // OTHER way to clear a body: a bare volume count fires; the same count
    // with `channel is distinct from 'exam'` is clean.
    name: 'exam-evidence count-read arm (a bare de_conversations volume count is caught; the channel literal clears it)',
    fires: `select 1 where exists (select 1 from (values ('a_new_digest',
              'select count(*) from de_conversations where tenant_id = v_t and last_message_at >= v_since')) v(nm, src)
             where src ilike '%from de_conversations%' and src ilike '%count(%'
               and src not ilike '%evidence_is_production%' and src not ilike '%''exam''%'
               and nm not in (${COUNT_READ_PIN_NAMES.map((n) => `'${n}'`).join(', ')}))`,
    silent: `select 1 where exists (select 1 from (values ('a_new_digest',
              'select count(*) from de_conversations where tenant_id = v_t and channel is distinct from ''exam'' and last_message_at >= v_since')) v(nm, src)
             where src ilike '%from de_conversations%' and src ilike '%count(%'
               and src not ilike '%evidence_is_production%' and src not ilike '%''exam''%'
               and nm not in (${COUNT_READ_PIN_NAMES.map((n) => `'${n}'`).join(', ')}))`,
  },
  {
    // ⚠ prosrc includes comments (the house rule). The UNQUOTED word "exam" in
    // a comment must NOT silence the sieve — only the quoted literal (an
    // actual channel filter) or the predicate call does. The known residual —
    // a comment containing the QUOTED literal would silence it — is documented
    // at COUNT_READ_PINS; this case pins the discrimination that exists.
    name: 'exam-evidence count-read arm (the unquoted word exam in a comment does NOT clear a body)',
    fires: `select 1 where exists (select 1 from (values ('a_commented_organ',
              '-- exams are not production work, someday we should filter them
               select count(*) from de_conversations where tenant_id = v_t')) v(nm, src)
             where src ilike '%from de_conversations%' and src ilike '%count(%'
               and src not ilike '%evidence_is_production%' and src not ilike '%''exam''%'
               and nm not in (${COUNT_READ_PIN_NAMES.map((n) => `'${n}'`).join(', ')}))`,
    silent: `select 1 where exists (select 1 from (values ('a_commented_organ',
              'select count(*) from de_conversations where tenant_id = v_t and channel is distinct from ''exam''')) v(nm, src)
             where src ilike '%from de_conversations%' and src ilike '%count(%'
               and src not ilike '%evidence_is_production%' and src not ilike '%''exam''%'
               and nm not in (${COUNT_READ_PIN_NAMES.map((n) => `'${n}'`).join(', ')}))`,
  },
  {
    // Isolates the `not ilike '%action_execution_landed%'` clause. Without it
    // the probe would flag all three fixed readers forever and be switched off;
    // with it inverted it would flag nobody. Same body, one call added.
    name: 'landed-reads-use-the-shared-predicate (calling the shared predicate is what clears a body)',
    fires: `select 1 where exists (select 1 from (values
              ('a_new_reader','count(*) filter (where decision = auto_executed)')) v(nm, src)
             where (src ilike '%executed_after_approval%' or src ilike '%auto_executed%')
               and src not ilike '%action_execution_landed%'
               and nm not in ('get_de_action_metrics','check_action_idempotency'))`,
    silent: `select 1 where exists (select 1 from (values
              ('a_new_reader','count(*) filter (where public.action_execution_landed(ae)) -- was decision = auto_executed')) v(nm, src)
             where (src ilike '%executed_after_approval%' or src ilike '%auto_executed%')
               and src not ilike '%action_execution_landed%'
               and nm not in ('get_de_action_metrics','check_action_idempotency'))`,
  },
  {
    // The OR's SECOND half on its own. A sieve that only looked for
    // `auto_executed` would miss every gated reader — which is exactly the
    // half migs 676/677/678 were about.
    name: 'landed-reads-use-the-shared-predicate (executed_after_approval alone is enough to be caught)',
    fires: `select 1 where exists (select 1 from (values
              ('a_new_reader','where decision = executed_after_approval')) v(nm, src)
             where (src ilike '%executed_after_approval%' or src ilike '%auto_executed%')
               and src not ilike '%action_execution_landed%'
               and nm not in ('get_de_action_metrics'))`,
    silent: `select 1 where exists (select 1 from (values
              ('a_new_reader','where decision = human_gated_trust')) v(nm, src)
             where (src ilike '%executed_after_approval%' or src ilike '%auto_executed%')
               and src not ilike '%action_execution_landed%'
               and nm not in ('get_de_action_metrics'))`,
  },
  {
    // The VIEW arm. There are zero such views today, so live data cannot
    // exercise it — which is precisely why it needs a synthesised mutant
    // rather than a shrug.
    name: 'landed-reads-use-the-shared-predicate (a VIEW is caught by the same rule)',
    fires: `select 1 where exists (select 1 from (values
              ('v_actions_done','select id from action_executions where decision in (auto_executed)')) v(nm, def)
             where (def ilike '%executed_after_approval%' or def ilike '%auto_executed%')
               and def not ilike '%action_execution_landed%'
               and nm not in ('get_de_action_metrics'))`,
    silent: `select 1 where exists (select 1 from (values
              ('v_actions_done','select id from action_executions ae where public.action_execution_landed(ae)')) v(nm, def)
             where (def ilike '%executed_after_approval%' or def ilike '%auto_executed%')
               and def not ilike '%action_execution_landed%'
               and nm not in ('get_de_action_metrics'))`,
  },
  {
    // The stale-pin arm's mechanics, isolated from live catalog contents: a
    // pinned name still fires when NO body of that name names either literal,
    // and stays silent when one does.
    name: 'landed-reads-use-the-shared-predicate (stale-pin arm: fires only when the pinned body is gone)',
    fires: `select 1 from (values ('pinned_name')) v(nm)
             where not exists (select 1 from (values ('some_other_fn','names auto_executed')) p(nm, src)
                                where p.nm = v.nm
                                  and (p.src ilike '%auto_executed%' or p.src ilike '%executed_after_approval%'))`,
    silent: `select 1 from (values ('pinned_name')) v(nm)
             where not exists (select 1 from (values ('pinned_name','names auto_executed')) p(nm, src)
                                where p.nm = v.nm
                                  and (p.src ilike '%auto_executed%' or p.src ilike '%executed_after_approval%'))`,
  },
  {
    name: 'no-unattended-public-speech',
    fires: `select 1 where exists (select 1 from (values ('publish_post','{"destructive":false}'::jsonb)) v(k,risk)
              where k in ('publish_post','publish_video') and (risk->>'destructive')::boolean is not true)`,
    silent: `select 1 where exists (select 1 from (values ('publish_post','{"destructive":true}'::jsonb)) v(k,risk)
              where k in ('publish_post','publish_video') and (risk->>'destructive')::boolean is not true)`,
  },
  {
    name: 'money-param-is-amount_cents',
    fires: `select 1 where exists (select 1 from (values ('budget_cents','integer')) v(name,typ)
              where typ in ('integer','number') and name ~* '(budget|amount|cents|price|spend)' and name <> 'amount_cents')`,
    silent: `select 1 where exists (select 1 from (values ('amount_cents','integer')) v(name,typ)
              where typ in ('integer','number') and name ~* '(budget|amount|cents|price|spend)' and name <> 'amount_cents')`,
  },
  {
    name: 'template-op-contract-classes (search without {query})',
    fires: `select 1 where 'search_x' like 'search\\_%' and '{"path_template":"/x"}' not like '%{query}%'`,
    silent: `select 1 where 'search_x' like 'search\\_%' and '{"query_params":{"q":"{query}"}}' not like '%{query}%'`,
  },
  {
    name: 'template-op-contract-classes (list pretending to search)',
    fires: `select 1 where 'list_x' like 'list\\_%' and '{"q":"{query}"}' like '%{query}%'`,
    silent: `select 1 where 'list_x' like 'list\\_%' and '{"limit":25}' like '%{query}%'`,
  },
  {
    name: 'template-op-contract-classes (frozen literal date)',
    fires: `select 1 where '{"startDate":"2026-01-01"}' ~ '"(startDate|endDate)":\\s*"\\d{4}-'`,
    silent: `select 1 where '{"startDate":"{days_ago_28}"}' ~ '"(startDate|endDate)":\\s*"\\d{4}-'`,
  },
  {
    name: 'rls-on-every-public-table',
    fires: `select 1 where exists (select 1 from (values ('faketable', false)) v(t, rls) where not rls)`,
    silent: `select 1 where exists (select 1 from (values ('faketable', true)) v(t, rls) where not rls)`,
  },
  {
    name: 'audit-chain-verifies-hq',
    fires: `select 1 where coalesce(('{"intact":false}'::jsonb->>'intact')::boolean,false) is not true`,
    silent: `select 1 where coalesce(('{"intact":true}'::jsonb->>'intact')::boolean,false) is not true`,
  },
  {
    // Half 1 of the R0.8 ratchet: does the sieve notice a MISSING caller check?
    // The real proof of this probe is stronger than any synthesised row — the
    // violation existed in production. It returned exactly 28 rows before
    // mig 662 and 0 after, on the live database. Recorded here so the predicate
    // itself stays honest if someone edits it.
    name: 'secdef-caller-tenant-ratchet (unguarded body fires)',
    fires: `select 1 where exists (select 1 from (values
              ('leak_me', true, true, 'p_tenant_id uuid', 'select * from renewal_invoices where tenant_id = p_tenant_id')
            ) v(nm, secdef, authed, args, src)
             where secdef and authed and args like '%uuid%'
               and src not ilike '%auth_tenant_id%' and src not ilike '%auth.uid%'
               and src not ilike '%can_access_de%' and src not ilike '%is_platform_admin%'
               and nm not in ('list_org_tree','match_doc_chunks','tenant_ancestors'))`,
    silent: `select 1 where exists (select 1 from (values
              ('leak_me', true, true, 'p_tenant_id uuid', 'select * from renewal_invoices where tenant_id = public.auth_tenant_id()')
            ) v(nm, secdef, authed, args, src)
             where secdef and authed and args like '%uuid%'
               and src not ilike '%auth_tenant_id%' and src not ilike '%auth.uid%'
               and src not ilike '%can_access_de%' and src not ilike '%is_platform_admin%'
               and nm not in ('list_org_tree','match_doc_chunks','tenant_ancestors'))`,
  },
  {
    // Half 2: the allowlist must actually exempt, and ONLY the names in it.
    // A ratchet whose allowlist matched everything would be silent forever.
    name: 'secdef-caller-tenant-ratchet (allowlist exempts, and only its names)',
    fires: `select 1 where exists (select 1 from (values ('brand_new_leak')) v(nm)
             where nm not in ('list_org_tree','match_doc_chunks','tenant_ancestors'))`,
    silent: `select 1 where exists (select 1 from (values ('list_org_tree')) v(nm)
             where nm not in ('list_org_tree','match_doc_chunks','tenant_ancestors'))`,
  },
  // ── onboarding-bindings-are-runnable (rewritten for mig 681) ────────────
  // The probe used to check three conditions — action_key match, status
  // active, and tenant VISIBILITY — and the four cases here modelled exactly
  // those three. All four passed, and the probe was still wrong: platform
  // actions carry tenant_id IS NULL, so "visible" was true for every tenant
  // in the system. The cases could not have caught that, because they
  // faithfully modelled a predicate that was itself too weak. A mutation case
  // proves a probe fires on the violation it models; it cannot tell you the
  // model is missing a condition.
  //
  // mig 681 tightened the probe to what get_agentic_tools_for_de means by
  // runnable: a CONNECTED connector of that tenant, matching category AND
  // provider, with provider='internal' excluded. The cases below exercise
  // every clause of that predicate one at a time.
  {
    // FIRST, and most valuable: the LIVE tables, and the exact row that
    // separates the old probe from the new one. Workspace 5bb802e1 has one
    // connected connector, erpnext/erp_financials.
    //   · log_invoice_note is active and platform-scope, so it was VISIBLE and
    //     the old predicate stayed silent on it — but in erp_financials it
    //     exists only under provider 'xero'. Nothing that workspace owns can
    //     run it. The new predicate fires.
    //   · configure_customer_setup is the erpnext one. It must stay silent, or
    //     the tightening has simply broken binding for everyone.
    // Synthetic cases can only prove the predicate does what it says; this one
    // proves it says the right thing about real production data.
    name: 'onboarding-bindings-are-runnable (LIVE: a visible-but-unrunnable verb fires, the runnable one stays silent)',
    fires: `select 1 where exists (
              select 1 from (values ('5bb802e1-8e92-4eef-9a7a-ac348785d43f'::uuid,'log_invoice_note')) item(tenant_id, action_key)
               where not exists (
                 select 1 from action_definitions ad
                 join connectors c
                   on c.tenant_id = item.tenant_id and c.status = 'connected'
                  and c.category = ad.category
                  and (ad.provider is null or ad.provider = c.provider or ad.provider = 'template')
                where ad.action_key = item.action_key and ad.status = 'active'
                  and ad.provider <> 'internal'
                  and (ad.scope = 'platform' or (ad.scope = 'tenant' and ad.tenant_id = item.tenant_id))))`,
    silent: `select 1 where exists (
              select 1 from (values ('5bb802e1-8e92-4eef-9a7a-ac348785d43f'::uuid,'configure_customer_setup')) item(tenant_id, action_key)
               where not exists (
                 select 1 from action_definitions ad
                 join connectors c
                   on c.tenant_id = item.tenant_id and c.status = 'connected'
                  and c.category = ad.category
                  and (ad.provider is null or ad.provider = c.provider or ad.provider = 'template')
                where ad.action_key = item.action_key and ad.status = 'active'
                  and ad.provider <> 'internal'
                  and (ad.scope = 'platform' or (ad.scope = 'tenant' and ad.tenant_id = item.tenant_id))))`,
  },
  // The remaining cases lift the probe's real predicate over synthesised
  // item / action_definition / connector rows — no live table read, so they
  // hold whatever those tables come to contain. The predicate is written ONCE,
  // as a builder, rather than pasted per case: eight hand-copied predicates
  // are eight chances for a case to drift from the thing it claims to test,
  // which is exactly how mig 661 shipped a pin that could not fail.
  ...(() => {
    const lit = (v) => (v === null ? 'null::text' : `'${v}'`);
    const runnable = (o = {}) => {
      const d = {
        itemTenant: 'tenant-a', itemKey: 'k',
        adKey: 'k', adStatus: 'active', adScope: 'platform', adTenant: null,
        adCategory: 'crm', adProvider: 'hubspot',
        connTenant: 'tenant-a', connStatus: 'connected',
        connCategory: 'crm', connProvider: 'hubspot', ...o,
      };
      return `select 1 where exists (
        select 1 from (values ('${d.itemTenant}','${d.itemKey}')) item(tenant_id, action_key)
         where not exists (
           select 1
             from (values (${lit(d.adKey)},${lit(d.adStatus)},${lit(d.adScope)},${lit(d.adTenant)},${lit(d.adCategory)},${lit(d.adProvider)}))
                    ad(action_key, status, scope, tenant_id, category, provider)
             join (values (${lit(d.connTenant)},${lit(d.connStatus)},${lit(d.connCategory)},${lit(d.connProvider)}))
                    c(tenant_id, status, category, provider)
               on c.tenant_id = item.tenant_id
              and c.status = 'connected'
              and c.category = ad.category
              and (ad.provider is null or ad.provider = c.provider or ad.provider = 'template')
            where ad.action_key = item.action_key
              and ad.status = 'active'
              and ad.provider <> 'internal'
              and (ad.scope = 'platform' or (ad.scope = 'tenant' and ad.tenant_id = item.tenant_id))))`;
    };
    // Every case's `silent` is the all-clean row, so each `fires` differs from
    // it in exactly ONE field. That is what makes each case a test of one
    // clause rather than of the predicate in general.
    const clean = runnable();
    const case_ = (name, mutation) => ({ name: `onboarding-bindings-are-runnable (${name})`, fires: runnable(mutation), silent: clean });
    return [
      // ── the action_definitions side ──
      case_('named verb does not exist at all', { adKey: 'something-else' }),
      case_('named verb exists but is not active', { adStatus: 'draft' }),
      case_('verb is tenant-scoped to a DIFFERENT tenant', { adScope: 'tenant', adTenant: 'tenant-b' }),
      // ...and its clean twin: tenant-scoped to the template's OWN tenant is
      // fine. Without this, flipping the scope clause to a constant true would
      // pass every case above.
      { name: 'onboarding-bindings-are-runnable (verb tenant-scoped to the SAME tenant is runnable)',
        fires: runnable({ adScope: 'tenant', adTenant: 'tenant-b' }),
        silent: runnable({ adScope: 'tenant', adTenant: 'tenant-a' }) },
      // provider='internal' isolated: the connector's provider is 'internal'
      // too, so the provider-MATCH clause passes and the ONLY thing excluding
      // this row is `ad.provider <> 'internal'`. Engine primitives
      // (generate_invoice, start_onboarding) have their own step types and are
      // never reachable through a connector.
      case_('verb is an internal engine primitive, not a connector action',
            { adProvider: 'internal', connProvider: 'internal' }),
      // A NULL action provider is excluded too, because `null <> 'internal'`
      // is NULL, not true. That is a quirk of get_agentic_tools_for_de's own
      // SQL, copied deliberately so the validator, the probe and VerbBinding
      // agree; 0 of 75 definitions have a null provider, so it changes nothing
      // today. If someone ever fixes the quirk, they must fix all three, and
      // this case going red is how they find out.
      case_('verb with a NULL provider is excluded, as get_agentic_tools_for_de excludes it',
            { adProvider: null }),
      // ── the connectors side: the four clauses mig 681 added ──
      case_('the matching connector belongs to a DIFFERENT tenant', { connTenant: 'tenant-b' }),
      case_('the matching connector is DISCONNECTED', { connStatus: 'disconnected' }),
      case_('the workspace has a connector, but in another CATEGORY', { connCategory: 'helpdesk' }),
      case_('the workspace has a connector in the right category but a DIFFERENT provider',
            { connProvider: 'salesforce' }),
      // ...and the two ways a provider legitimately matches without being
      // equal, which a "provider must be equal" over-tightening would break.
      { name: 'onboarding-bindings-are-runnable (a template-provider verb runs against any connector in its category)',
        fires: runnable({ adProvider: 'stripe', connProvider: 'salesforce' }),
        silent: runnable({ adProvider: 'template', connProvider: 'salesforce' }) },
    ];
  })(),
  {
    // Verbatim from the brief's spec: a two-field synthetic model
    // (status, has a qualifying execution). Kept as-is — it's still a
    // legitimate coarse check — but on its own it never exercises the
    // probe's other two real conditions (`d ? 'action_key'`, and that the
    // `not exists` checks *decision membership*, not just row existence).
    // The three cases below lift the real predicate's remaining conditions
    // one at a time, same pattern Task 2's fix used on the neighbouring
    // onboarding-bindings-are-runnable probe after a shallow mutation case
    // passed while blind to a live, populated condition.
    name: 'bound-onboarding-items-complete-from-evidence (done + no qualifying execution -> violation)',
    fires: `select 1 where exists (select 1 from (values ('done', false)) v(st, has_exec)
              where v.st = 'done' and not v.has_exec)`,
    silent: `select 1 where exists (select 1 from (values ('done', true)) v(st, has_exec)
              where v.st = 'done' and not v.has_exec)`,
  },
  {
    // Condition: the not-exists checks DECISION MEMBERSHIP, not mere
    // row existence. A row exists ('rejected') but doesn't qualify -> the
    // item must still be flagged, exactly as if no execution existed at all.
    name: 'bound-onboarding-items-complete-from-evidence (an execution row exists but its decision does not qualify -> still a violation)',
    fires: `select 1 where exists (
              select 1 from (values ('done', true)) i(status, has_action_key)
               where i.status = 'done' and i.has_action_key
                 and not exists (select 1 from (values ('rejected')) ae(decision)
                                  where ae.decision in ('auto_executed','executed_after_approval')))`,
    silent: `select 1 where exists (
              select 1 from (values ('done', true)) i(status, has_action_key)
               where i.status = 'done' and i.has_action_key
                 and not exists (select 1 from (values ('executed_after_approval')) ae(decision)
                                  where ae.decision in ('auto_executed','executed_after_approval')))`,
  },
  {
    // Condition: `d ? 'action_key'`. An item marked done with no verb bound
    // to it at all (the common case today — 0 bound items in production) is
    // exempt by design, not merely unmatched by accident.
    name: 'bound-onboarding-items-complete-from-evidence (item has no action_key binding -> exempt, never a violation)',
    fires: `select 1 where exists (
              select 1 from (values ('done', true)) i(status, has_action_key)
               where i.status = 'done' and i.has_action_key
                 and not exists (select 1 from (select null::text as decision where false) ae
                                  where ae.decision in ('auto_executed','executed_after_approval')))`,
    silent: `select 1 where exists (
              select 1 from (values ('done', false)) i(status, has_action_key)
               where i.status = 'done' and i.has_action_key
                 and not exists (select 1 from (select null::text as decision where false) ae
                                  where ae.decision in ('auto_executed','executed_after_approval')))`,
  },
  {
    // Condition: `i->>'status' = 'done'`. A bound item still in_progress
    // (or pending/blocked) with no execution is not a violation — only a
    // stored 'done' with nothing behind it is the trap this probe guards.
    name: 'bound-onboarding-items-complete-from-evidence (bound item not yet done -> exempt, never a violation)',
    fires: `select 1 where exists (
              select 1 from (values ('done', true)) i(status, has_action_key)
               where i.status = 'done' and i.has_action_key
                 and not exists (select 1 from (select null::text as decision where false) ae
                                  where ae.decision in ('auto_executed','executed_after_approval')))`,
    silent: `select 1 where exists (
              select 1 from (values ('in_progress', true)) i(status, has_action_key)
               where i.status = 'done' and i.has_action_key
                 and not exists (select 1 from (select null::text as decision where false) ae
                                  where ae.decision in ('auto_executed','executed_after_approval')))`,
  },
  // ── workspace-admin-has-an-owner ────────────────────────────────────────
  // Until now this probe's only "it can fire" evidence was a one-time manual
  // git-stash run recorded in a ledger. The day the Onboarding Architect is
  // retired it becomes the SOLE automated guard that a workspace still has a
  // platform_admin connector, so it needs a fixture that is re-runnable.
  //
  // The first case is the strongest available and needs no synthesis at all:
  // the Demo Workspace is a LIVE instance of the exact violating condition
  // (holds a Workspace Assistant, 0 admin connectors, 0 reachable
  // workforce_assistant verbs — against 1 and 4 for all 17 others). It is
  // exempt by id because provisioning refuses it by id. Lift that one line and
  // certify's ACTUAL query, over production, names it.
  {
    name: 'workspace-admin-has-an-owner (THE REAL PROBE over PRODUCTION — lift the one-id demo exemption and it names the workspace nobody can administer)',
    fires: violationsOnly(mutate(DEMO_EXEMPTION, 'true')),
    silent: violationsOnly(WORKSPACE_ADMIN_SQL),
  },
  {
    // F2's regression, guarded on the SHIPPED TEXT rather than a model of it,
    // because no live tenant can distinguish the two shapes: today every
    // trial and suspended workspace is clean, so a status filter would cost
    // nothing visible and silence everything later. `fires` injects the exact
    // filter that was there until 2026-08-13; `silent` is the shipped probe.
    name: 'workspace-admin-has-an-owner (a re-introduced tenant-status filter is caught — every tenant is born `trial`)',
    firesJs: () => statusFilterFindings(mutate(DEMO_EXEMPTION, `t.status = 'active' and ${DEMO_EXEMPTION}`)),
    silentJs: () => statusFilterFindings(WORKSPACE_ADMIN_SQL),
  },
  {
    // The core arm, synthesised because the live estate holds no second
    // instance: an assistant that reaches ZERO requires_role='workforce_assistant'
    // actions is the violation, whatever the reason — a missing connector, a
    // revoked grant, a de_may_use_action regression. `silent` is the same
    // workspace with one such verb reachable, so this proves discrimination
    // rather than mere firing.
    name: 'workspace-admin-has-an-owner (assistant present, ZERO reachable workforce_assistant verbs -> violation)',
    fires: `select 1 where exists (
              select 1 from (values (true, 0)) t(has_assistant, wa_verbs)
               where t.has_assistant and t.wa_verbs = 0)`,
    silent: `select 1 where exists (
              select 1 from (values (true, 4)) t(has_assistant, wa_verbs)
               where t.has_assistant and t.wa_verbs = 0)`,
  },
  {
    // The gate that is legitimate: a workspace with no Workspace Assistant is
    // not examined, because there is no assistant for the admin verbs to be
    // unreachable BY. Without this case, replacing the assistant gate with a
    // constant true would pass every case above.
    name: 'workspace-admin-has-an-owner (no Workspace Assistant -> exempt by design, never a violation)',
    fires: `select 1 where exists (
              select 1 from (values (true, 0)) t(has_assistant, wa_verbs)
               where t.has_assistant and t.wa_verbs = 0)`,
    silent: `select 1 where exists (
              select 1 from (values (false, 0)) t(has_assistant, wa_verbs)
               where t.has_assistant and t.wa_verbs = 0)`,
  },
  {
    // F4's arm. Both remaining gates (the demo id, "has an assistant") are
    // things a row change can empty, and zero examined renders identically to
    // zero violations. The probe now raises rather than printing a quiet pass.
    name: 'workspace-admin-has-an-owner (zero workspaces examined is a VIOLATION, not a clean run)',
    fires: `select 'no-comparisons' where exists (select 1 from (values (0)) c(n) where c.n = 0)`,
    silent: `select 'no-comparisons' where exists (select 1 from (values (17)) c(n) where c.n = 0)`,
  },
  // ── mig 685's ratchet: no-untyped-literal-appended-to-a-container ───────
  // Every case runs bareContainerLiteralSql() — certify's ACTUAL query — over
  // a synthesised body. `silent` is never an empty fixture; it is always the
  // CORRECT way to write the same line, so these prove the probe discriminates
  // rather than merely fires.
  {
    name: 'untyped-literal-append (the exact mig 685 shape -> caught; ::text -> clean)',
    fires: bareContainerLiteralSql(BODY_BARE),
    silent: bareContainerLiteralSql(BODY_CAST),
  },
  {
    name: 'untyped-literal-append (format(...) returns typed text and is NEVER a violation)',
    fires: bareContainerLiteralSql(BODY_BARE),
    silent: bareContainerLiteralSql(BODY_FORMAT),
  },
  {
    // array_append is (anyarray, anyelement) — CORRECT code, and 19 real call
    // sites in public depend on it (assess_de_skills_internal, de_records_gate,
    // get_de_economics, set_doc_scope, set_pipeline_stages,
    // work_de_development_program_internal). A careless pattern flags all 19,
    // the probe gets switched off, and the class comes back.
    name: 'untyped-literal-append (array_append(arr, \'lit\') is CORRECT — 19 real call sites must stay clean)',
    fires: bareContainerLiteralSql(BODY_BARE),
    silent: bareContainerLiteralSql(BODY_ARRAY_APPEND),
  },
  {
    name: 'untyped-literal-append (literal on the LEFT of || is the same defect)',
    fires: bareContainerLiteralSql(BODY_LITERAL_LEFT),
    silent: bareContainerLiteralSql(BODY_LITERAL_LEFT_CAST),
  },
  {
    // ⚠ THIS CASE GUARDS THE \y ESCAPE. Neither fixture contains a '[', so the
    // ARRAY branch of the regex cannot match them and detection depends
    // entirely on the json branch's word boundary. Rewrite `jsonb?\y` as
    // `jsonb?\b` in bare-container-literal.mjs and this case goes RED —
    // which is exactly what did NOT happen the first time, because there was
    // no such case and zero coverage looks identical to a clean database.
    name: 'untyped-literal-append (jsonb carries the same trap — GUARDS THE \\y WORD-BOUNDARY ESCAPE)',
    fires: bareContainerLiteralSql(BODY_JSONB_BARE),
    silent: bareContainerLiteralSql(BODY_JSONB_CAST),
  },
  {
    // The probe splits on ';' rather than newline. A line-based sieve returns
    // zero here, which is why the first draft of the sweep missed this shape.
    name: 'untyped-literal-append (an append split across THREE LINES is still caught)',
    fires: bareContainerLiteralSql(BODY_MULTILINE),
    silent: bareContainerLiteralSql(BODY_MULTILINE_CAST),
  },
  {
    // array_cat IS (anyarray, anyarray) — proven on production: it raised
    // 22P02 "malformed array literal" on a bare literal. Matching only when
    // the SECOND argument starts with a quote is what keeps array_cat(v,
    // array['fine']) out of the results.
    name: 'untyped-literal-append (array_cat with a literal is caught; array_cat(v, array[..]) is not)',
    fires: bareContainerLiteralSql(BODY_ARRAY_CAT),
    silent: bareContainerLiteralSql(BODY_ARRAY_CAT_OK),
  },
  {
    // 37 real statements in public concatenate a literal onto a SCALAR text
    // variable. That is ordinary string concatenation and always correct.
    name: 'untyped-literal-append (a SCALAR text variable is ordinary concatenation, never a violation)',
    fires: bareContainerLiteralSql(BODY_BARE),
    silent: bareContainerLiteralSql(BODY_SCALAR),
  },
  {
    // mig 685's own header quotes the bugged line as prose. A probe that read
    // comments would manufacture a finding out of the documentation of the fix.
    name: 'untyped-literal-append (a COMMENTED-OUT example is prose, not a finding)',
    fires: bareContainerLiteralSql(BODY_BARE),
    silent: bareContainerLiteralSql(BODY_COMMENTED),
  },
  {
    name: 'untyped-literal-append (an array ARGUMENT is covered, not just a local)',
    fires: bareContainerLiteralSql(BODY_ARG_ARRAY),
    silent: bareContainerLiteralSql(BODY_ARG_ARRAY_CAST),
  },
  // ── no-pending-approval-the-platform-cannot-carry-out ──────────────────
  // Every case runs certify's ACTUAL query — real connectors, real
  // action_definitions, real pg_proc — with ONE synthesised row UNIONed into
  // the population, and counts only the rows naming that fixture. No writes.
  // `silent` is never an empty population; it is always the SAME row made
  // executable, so these prove the probe discriminates rather than merely
  // fires. (The live, rolled-back-transaction version of these three — real
  // INSERTs into human_tasks/action_executions inside a transaction that
  // aborts — was run once against production when the probe shipped; all
  // three fired and named the right kind, action_executions stayed at 186.
  // These are the standing form of that proof.)
  ...(() => {
    const HQ = '5bb802e1-8e92-4eef-9a7a-ac348785d43f';        // outsourcetel-hq
    const DEF = '00003ef9-96d6-416e-9b21-3ea7301e83e6';       // send_payment_reminder, erp_financials, active
    const ERP = '7f595bec-2f73-44d2-8f89-20961ad11e0e';       // erpnext / erp_financials
    const OTHER = '73ab12eb-ddf1-4d64-8cc3-e4c917c5b604';     // mcp / other — right tenant, WRONG category
    // A synthesised population row. Defaults are the CLEAN one: the connector
    // that carries this verb, the definition that was gated, matching category.
    const row = (o = {}) => {
      const d = { conn: `'${ERP}'::uuid`, def: `'${DEF}'::uuid`, key: 'send_payment_reminder', ...o };
      return `  select '00000000-0000-4000-8000-00000000dead'::uuid, '${HQ}'::uuid, ${d.conn}, ${d.def},
                      '${d.key}'::text, 'outsourcetel-hq'::text, 'MUTATION FIXTURE'::text`;
    };
    // Only rows naming the fixture count — production carries one real
    // violation of this class (kinetic / create_specialist, whose definition
    // was disabled by mig 611), and a case that counted it would pass without
    // the mutation.
    const only = (kind, extra) => `select 1 from (${unexecutableApprovalSql({ extra })}) x
       where x.violation like '${kind} — %' and x.violation like '%MUTATION FIXTURE%'`;
    const case_ = (kind, name, mutation) => ({
      name: `unexecutable-approval (${name})`,
      fires: only(kind, row(mutation)),
      silent: only(kind, row()),
    });
    return [
      // mig 701's defect, exactly: the sweep wrote a null routing column.
      case_('unroutable', 'connector_id NULL -> connector-hub refuses at the door', { conn: 'null::uuid' }),
      // The other way a row is unroutable: the connector is not this
      // workspace's (deleted, or another tenant's) -> connector_not_found.
      case_('unroutable', 'the named connector is not a connector of this workspace',
            { conn: `'00000000-0000-4000-8000-00000000c0de'::uuid` }),
      // The named executor is real and active but unreachable THROUGH THIS
      // CONNECTOR, because the resolver keys on the CONNECTOR's category.
      case_('mismatched-pair', 'the named executor is not in the connector\'s category',
            { conn: `'${OTHER}'::uuid` }),
      // The half of `ambiguous` that a row can carry. It cannot arise from an
      // INSERT today (action_executions.action_definition_id is NOT NULL) and
      // that is stated in the probe rather than pretended otherwise — this
      // case is what keeps the arm honest if the constraint ever goes.
      case_('ambiguous', 'two live executors and the row names neither', { def: 'null::uuid' }),
      // ...and the discrimination that matters most: an UNAMBIGUOUS pair with
      // no disambiguator is NOT a violation. Without this, an arm that fired
      // on every null would look identical to the correct one.
      { name: 'unexecutable-approval (a single-executor pair needs no disambiguator and is never flagged)',
        fires: only('ambiguous', row({ def: 'null::uuid' })),
        silent: only('ambiguous', row({ def: 'null::uuid', key: 'flag_for_collections' })) },
    ];
  })(),
  // ── The FOURTH kind: `no-executor` (mig 704's sibling) ─────────────────
  // Same construction as the three above, but through the OTHER population
  // hook: `orphanExtra` feeds the task scan, which deliberately does not join
  // action_executions. Whether a fixture is FLAGGED is still decided by the
  // real action_executions table, so `silent` uses a REAL pending approval's
  // task id — one that genuinely has an execution row — wearing the same
  // fixture title. Firing on one and not the other is therefore the probe
  // discriminating, not the harness choosing.
  ...(() => {
    const HQ = '5bb802e1-8e92-4eef-9a7a-ac348785d43f';         // outsourcetel-hq
    // A real pending action_approval linked to a real action_executions row
    // via task_id (execution 7371abf7…). Deciding it later would not break
    // this case: a decision does not delete the execution row, and the fixture
    // supplies its own task row regardless of the real one's status.
    const LINKED = '87146a8e-9e2a-4ba1-ab93-93791efb2adb';
    const ORPHAN = '00000000-0000-4000-8000-00000000face';     // referenced by nothing
    const row = (taskId) => `  select '${taskId}'::uuid, '${HQ}'::uuid, 'outsourcetel-hq'::text,
                      'MUTATION FIXTURE'::text, '2026-08-11T00:00:00Z'::timestamptz`;
    // Production carries one REAL row of this kind (the founder's "test ping",
    // deliberately not allowlisted), so a case that counted every no-executor
    // row would pass without the mutation. Only the fixture counts.
    const only = (extra) => `select 1 from (${unexecutableApprovalSql({ orphanExtra: extra })}) x
       where x.violation like 'no-executor — %' and x.violation like '%MUTATION FIXTURE%'`;
    return [
      {
        name: 'unexecutable-approval (no-executor: a pending approval with NOTHING behind it is flagged)',
        fires: only(row(ORPHAN)),
        silent: only(row(LINKED)),
      },
    ];
  })(),
  {
    name: 'unexecutable-approval (no-executor: BOTH linkage columns clear a task, not just task_id)',
    manual: 'Driven against DEV inside a transaction that ABORTS, over the REAL probe query and REAL rows '
      + '(a values fixture cannot express this — the NOT EXISTS reads the live action_executions table). '
      + 'A pending action_approval with no execution row: arm named it (1 row). An execution row added '
      + 'linking ONLY by resolves_task_id (mig 642 linkage, task_id left null): arm went SILENT (0 rows). '
      + 'That link deleted again: arm named it once more (1 row). So an arm written with task_id alone '
      + 'would manufacture a finding on a healthy row. Rolled back. Directly observed 2026-08-11.',
  },
  {
    // THE DENOMINATOR ARM. mig 701 back-filled the two known-bad rows hours
    // before this probe was written, so its three arms find nothing today —
    // and zero findings from zero comparisons is indistinguishable from a
    // clean result. This is the case proving the probe refuses to call an
    // empty population a pass.
    name: 'unexecutable-approval (an empty population is a VIOLATION, not a pass)',
    fires: `select 1 from (${unexecutableApprovalSql({ empty: true })}) x
             where x.violation like 'no-comparisons — %'`,
    silent: `select 1 from (${unexecutableApprovalSql()}) x
             where x.violation like 'no-comparisons — %'`,
  },
  {
    // ...and the SECOND denominator, separately. The two populations are
    // different queries — one joins through action_executions, one refuses to
    // — so one going to zero must not be masked by the other being healthy.
    // Without this case, the task scan could silently read nothing and the
    // no-executor arm would look clean from having examined no rows.
    name: 'unexecutable-approval (an empty TASK SCAN is its own violation, not masked by a healthy population)',
    fires: `select 1 from (${unexecutableApprovalSql({ emptyTasks: true })}) x
             where x.violation like 'no-comparisons — %'`,
    silent: `select 1 from (${unexecutableApprovalSql()}) x
             where x.violation like 'no-comparisons — %'`,
  },
  {
    // The `ambiguous` arm's OTHER half — mig 703's defect — reads the driver's
    // selector out of pg_proc, which a SELECT cannot fake. What CAN be tested
    // as a SELECT is the pattern itself, and it is worth testing: mig 703
    // recorded that a bare `ae\.action_definition_id` match SURVIVED the
    // null::uuid mutant, because the JOIN condition further down the body
    // satisfies it. The anchor to the select list is the fix, and this is what
    // stops someone "simplifying" it back.
    name: 'unexecutable-approval (the selector pattern is anchored to the SELECT LIST, not the bare token)',
    fires: `select 1 where not (
              'select t.id, t.slug, ht.id, ae.id, ae.connector_id, null::uuid, ad.action_key
                 from action_executions ae join action_definitions ad on ad.id = ae.action_definition_id'
              ~ 'ae\\.connector_id,\\s*ae\\.action_definition_id')`,
    silent: `select 1 where not (
              'select t.id, t.slug, ht.id, ae.id, ae.connector_id, ae.action_definition_id, ad.action_key
                 from action_executions ae join action_definitions ad on ad.id = ae.action_definition_id'
              ~ 'ae\\.connector_id,\\s*ae\\.action_definition_id')`,
  },
  {
    name: 'unexecutable-approval (the bare-token pattern mig 703 rejected would NOT have caught the mutant)',
    // Same two bodies, the LOOSE pattern. It must stay silent on BOTH — which
    // is what makes the anchored one load-bearing rather than decorative.
    fires: `select 1 where not (
              'select ae.connector_id, null::uuid from action_executions ae'
              ~ 'ae\\.action_definition_id')`,
    silent: `select 1 where not (
              'select ae.connector_id, null::uuid from action_executions ae
                 join action_definitions ad on ad.id = ae.action_definition_id'
              ~ 'ae\\.action_definition_id')`,
  },
  {
    name: 'unexecutable-approval (LIVE DDL mutant: due_approved_actions stops forwarding the executor)',
    manual: 'mig 703 recreated inside a transaction that ABORTS, with null::uuid in the select list and the '
      + 'return type unchanged: the probe named 4 real production rows as `ambiguous` (outsourcetel-hq '
      + 'send_payment_reminder, two live ERPNext executors — an internal note and an email to the customer). '
      + 'Rolled back; the live selector was re-read afterwards and is intact. Directly observed 2026-08-11.',
  },
  {
    name: 'mig 704 retirement guard (19 live DDL mutants against its own assert block)',
    manual: 'The guard that alerts when an action_definition leaves status=active while a PENDING approval '
      + 'still names it. Its assert block was extracted from the shipped migration file (not paraphrased) and '
      + 'run against DEV after each mutation, in transactions that ABORT. Baseline green first, or every '
      + 'catch below would be meaningless. 19 mutants, 19 CAUGHT, 0 survived, 0 inconclusive — each scored '
      + 'only because the error NAMED the injected defect. Structural: WHEN clause removed (fires on every '
      + 'definition update), BEFORE instead of AFTER (can veto a retirement), writes to human_tasks, calls '
      + 'decide_human_task, never inserts an alert, tenant dropped from the dedup kind, definition dropped '
      + 'from it, only task_id checked (misses mig 642 resolves_task_id links), pending filter widened, '
      + 'anon/authenticated/PUBLIC granted EXECUTE, SECURITY DEFINER removed. ⚠ The PUBLIC case needed its '
      + 'own construction: a grant to PUBLIC also gives anon EXECUTE, so the anon pin fired first and the '
      + 'run did not name PUBLIC — INCONCLUSIVE under the strict rule, not a catch. Re-run with the anon and '
      + 'authenticated pins removed so only the PUBLIC pin could speak (plus a control proving that removal '
      + 'alone keeps the block green). BEHAVIOURAL, all passing the source pins and caught only because the '
      + 'assert block DRIVES the trigger: alerts on every retirement (F1), never alerts on a real stranding '
      + '(F3), alert stops naming the task (F3), and a decision made through dynamic SQL the prosrc pin '
      + 'cannot see (F4). One further mutant — the same dynamic decision WITHOUT the sanction GUC — is '
      + 'stopped by guard_human_task_decision rather than by mig 704, and is recorded as that rather than '
      + 'claimed as this migration\'s catch. Directly observed 2026-08-11.',
  },
  // ── mig 705's boundary: advisory-layer-cannot-decide ────────────────────
  // The coverage arms run certify's ACTUAL query with a fixture row UNIONed
  // into the task scan (no writes). Whether a fixture is FLAGGED is decided by
  // the real approval_briefs table: an orphan uuid has no brief and fires; a
  // REAL pending approval's task id (briefed by the mig-705 backfill, and its
  // brief row survives the task being decided — only task DELETION cascades)
  // stays silent. Firing on one and not the other is the probe discriminating.
  ...(() => {
    const HQ = '5bb802e1-8e92-4eef-9a7a-ac348785d43f';        // outsourcetel-hq
    // A real action_approval on prod, briefed by the 705 backfill: the
    // outsourcetel-hq "Grant Plastics" follow-up of 2026-08-05. Deciding it
    // later cannot break this case — the brief row survives a decision (only
    // task DELETION cascades), and the fixture supplies its own task row.
    const BRIEFED = '87146a8e-9e2a-4ba1-ab93-93791efb2adb';
    const ORPHAN = '00000000-0000-4000-8000-0000000005b1';    // referenced by nothing
    const row = (taskId) => `  select '${taskId}'::uuid, '${HQ}'::uuid,
                      'outsourcetel-hq'::text, 'MUTATION FIXTURE'::text`;
    const only = (extra) => `select 1 from (${advisoryBoundarySql({ orphanExtra: extra })}) x
       where x.violation like 'missing-brief — %' and x.violation like '%MUTATION FIXTURE%'`;
    return [
      {
        name: 'advisory-boundary (missing-brief: a pending approval with no brief row is flagged)',
        fires: only(row(ORPHAN)),
        silent: only(row(BRIEFED)),
      },
      {
        name: 'advisory-boundary (an empty task scan is a VIOLATION, not a pass)',
        fires: `select 1 from (${advisoryBoundarySql({ emptyTasks: true })}) x
                 where x.violation like 'no-comparisons — %'`,
        silent: `select 1 from (${advisoryBoundarySql()}) x
                 where x.violation like 'no-comparisons — %'`,
      },
      {
        // The identity-drift arm's LEFT JOIN mechanics, isolated: an expected
        // signature with no live counterpart must fire, a matched one must not.
        name: 'advisory-boundary (identity-drift: a vanished writer function is itself a violation)',
        fires: `select 1 from (values ('list_approval_briefs()')) exp(sig)
                 left join (select null::text as sig where false) live on live.sig = exp.sig
                where live.sig is null`,
        silent: `select 1 from (values ('list_approval_briefs()')) exp(sig)
                 left join (values ('list_approval_briefs()')) live(sig) on live.sig = exp.sig
                where live.sig is null`,
      },
    ];
  })(),
  {
    name: 'advisory-boundary (9 live mutants against the REAL probe on dev)',
    manual: 'Driven against DEV (mig 705 applied) on 2026-08-12, each mutant inside a DO block ending in '
      + 'RAISE EXCEPTION so the injected break rolls back; the exception message carried the probe rows, '
      + 'so every catch is scored on the probe NAMING the break. 9 mutants, 9 CAUGHT, 0 survived, '
      + '0 inconclusive: GRANT EXECUTE on decide_human_task to the role (can-decide); GRANT UPDATE on '
      + 'human_tasks (can-write-queue); list_approval_briefs owner flipped to postgres (identity-drift); '
      + 'compute_approval_brief made VOLATILE (identity-drift); refresh writer stripped of SECURITY DEFINER '
      + '(identity-drift); list_approval_briefs rewritten to serve stored rows without recomputing '
      + '(identity-drift, the stored-marker trap); role granted EXECUTE on decide_de_escalation '
      + '(reachable-decider — the two-paths trap); a pending approval whose brief row was deleted '
      + '(missing-brief, with its in-transaction control: arm silent while the trigger-written brief '
      + 'existed); the role dropped outright with DROP OWNED (role-gone). The last one first came back '
      + 'INCONCLUSIVE twice and forced two real fixes: DROP OWNED needed the trigger dropped first, and '
      + 'has_function_privilege(\'name\',…) RAISES 42704 on a missing role — the probe now resolves the '
      + 'role through a pg_roles OID join so role-gone reports instead of erroring. Dev verified fully '
      + 'rolled back afterwards (role/trigger/volatility/privileges intact, 0 leftover fixtures).',
  },
  // ── mig 710's boundary: trust-proposer-cannot-decide ─────────────────────
  // The evidence arms run certify's ACTUAL query with a fixture proposal
  // UNIONed into the scan (no writes). Whether a fixture FIRES is decided by
  // the real LEDGER: a citation naming three genuinely approved, landed,
  // production decisions stays silent; a citation the ledger cannot confirm
  // fires. Firing on one and not the other is the probe discriminating.
  {
    name: 'trust-proposer (16 live DDL mutants against the REAL probe on dev)',
    manual: 'Driven against DEV (mig 710 applied) on 2026-08-12, each mutant inside a DO block ending in '
      + 'RAISE EXCEPTION so the injected break rolls back; the exception message carried the probe rows, so '
      + 'every catch is scored on the probe NAMING the break. 16 mutants, 16 CAUGHT, 0 survived, 0 '
      + 'inconclusive, plus a no-mutation CONTROL proving zero violations on clean dev: GRANT EXECUTE on '
      + 'decide_human_task / apply_trust_promotion / set_de_autonomy to the role (can-decide ×3); GRANT '
      + 'UPDATE on human_tasks, GRANT UPDATE (current_level) on trust_policies, GRANT INSERT on de_autonomy, '
      + 'GRANT UPDATE on approval_authority (can-write ×4); REVOKE INSERT on human_tasks and REVOKE UPDATE '
      + '(pending_task_id) (cannot-file ×2, the built-but-unfed liveness half); writer owner flipped to '
      + 'postgres, detector made VOLATILE, detector body stubbed losing its conjunct predicates '
      + '(identity-drift ×3); role granted EXECUTE on set_trust_ladder, whose body reaches the dial '
      + '(reachable-decider — the two-paths trap); writer granted to authenticated (seam-reachable); '
      + 'de_governance_sweep_internal stubbed without the proposer call (sweep-unfed); DROP OWNED + DROP '
      + 'ROLE (role-gone). Dev verified fully rolled back afterwards (owner/volatility/conjuncts/grants '
      + 'intact, 0 leftover fixtures).',
  },
  {
    name: 'trust-proposer (13-group behavioral fixture matrix drives the REAL detector + writer on dev)',
    manual: 'Driven against DEV on 2026-08-12 inside one rolled-back transaction: thirteen fixture groups, '
      + 'each isolating ONE conjunct of the mig-710/711 pattern test — baseline (3 clean landed production '
      + 'approvals) FIRES; exam-origin decision does not count (682/707 axis); un-landed approval does not '
      + 'count (679 predicate); a rollback voids the pattern; destructive actions are excluded (the dial '
      + 'opens nothing above the destructive gate); a rejection voids the pattern; a DECLINED prior proposal '
      + 'blocks re-raise until the pattern re-accumulates; N=2 stays below the floor of 3; an open proposal '
      + 'blocks a second; a policy-ineligible group (trust_evidence_for says no) is refused; an identical '
      + 'qualifying group in a SUSPENDED workspace produces nothing; the mig-711 bimap shape (specific ladder '
      + 'approval-blind, generic action_execute+source ladder eligible) FIRES and maps to the generic — the '
      + 'ladder the evidence actually climbs; the same shape with an open proposal on the blind rung is '
      + 'blocked chain-wide. Detector returned EXACTLY the two firing groups and nothing else. Then the REAL '
      + 'writer ran under the role: raised=2, pending_task_id linkage set on both, citation carries exactly '
      + '3 decisions, mig-705 brief row present at birth, second run raised 0, suspended workspace raised 0. '
      + 'SCORECARD passes=19, failures NONE. The 710 run of this suite is what caught the '
      + 'silent zero-row UPDATE (RLS applies SELECT policies to the WHERE read of an UPDATE) that would have '
      + 'let every sweep re-raise the same proposal forever.',
  },
  {
    // mig 828 arm 9b (eligibility-not-re-derivable). Cannot join the automated
    // fires/silent block below: 9b's join (open_proposals op join trust_policies
    // tp on tp.pending_task_id = op.task_id) requires a REAL trust_policies row
    // already carrying the fixture's task_id in pending_task_id, and a bare
    // proposalExtra SELECT cannot fabricate a trust_policies row — only inject
    // an open_proposals one. Production holds exactly one such real linkage
    // (measured 2026-08-21) and it is eligible, so a live "fires" case has no
    // anchor to attach to without a write. See the comment at arm 9b itself for
    // the standing, always-live compensating control (arm 9c, the denominator
    // sum) that would catch a structural break here even between manual runs.
    name: 'trust-proposer (arm 9b, eligibility-not-re-derivable: fires+silent proven on dev)',
    manual: 'Driven against DEV (nmuntxrcdksyhsdywpan) on 2026-08-21 inside one rolled-back transaction, '
      + 'via scripts/dev-query.mjs — chosen over production per this probe\'s own precedent for anything '
      + 'requiring a write, even one that rolls back. Two synthetic trust_policies rows inserted for a real '
      + 'dev tenant (distinct action_category values, to clear the tenant/category/source/de unique index): '
      + 'one with criteria = {min_eval_samples:0, min_human_samples:0, max_guardrail_blocks:0} — every '
      + 'threshold zero, so trust_evidence_for reports eligible:true on zero data by construction (mirrors '
      + '828\'s own founder ruling: "an eligible policy raises a request even with NO approved-action '
      + 'history"); one left on the TABLE\'S OWN DEFAULT criteria (min_human_samples:5, min_eval_samples:25, '
      + '...) on the same zero data — genuinely eligible:false, no fabricated history needed. Both linked via '
      + 'pending_task_id to a fresh open_proposals fixture (proposalExtra, criteria-shaped, no pattern key) '
      + 'run through the REAL trustProposerBoundarySql(). Result: the eligible policy\'s proposal produced NO '
      + 'eligibility-not-re-derivable violation (silent, correctly); the not-eligible policy\'s proposal fired '
      + 'exactly that violation, naming its own task id. Denominator over the two-fixture population read '
      + '"2 open system proposal(s) scanned (0 pattern-filed ...; 2 criteria-filed ...)" — both counted, both '
      + 'summed, arm 9c silent. (The same run also surfaced several UNRELATED can-decide/cannot-file/identity-'
      + 'drift/reachable-decider findings — these are dev\'s own pre-existing privilege/ownership drift from '
      + 'production, not this arm, and are expected on dev.) Rollback confirmed: a separate read-only call '
      + 'afterward showed trust_policies back to 0 rows on dev, its state before this test.',
  },
  {
    // ⚠ MANUAL, and for the same reason arm 9b is: sweep-unfed reads
    // pg_proc.prosrc for de_governance_sweep_internal, which no opts.* hook
    // can inject into — the only way to drive it is to REPLACE a live
    // function, which is a DDL write. Named here with its compensating
    // control stated rather than left uncovered: migration 834's own PROBE 1
    // asserts the same two calls, unconditionally, on every replay.
    name: 'trust-proposer (arm 8, sweep-unfed: per-writer, five states proven against production)',
    manual: 'Driven against PRODUCTION on 2026-08-21 in five separate self-aborting transactions (each ends '
      + 'in RAISE EXCEPTION carrying the arm\'s rows, so nothing commits; no fixture rows, only CREATE OR '
      + 'REPLACE of functions inside the aborted transaction). The arm was extended this day because it '
      + 'watched ONE writer while migration 828 shipped a SECOND — request_eligible_promotions — with no '
      + 'caller anywhere in the repo, and stayed green throughout: the built-and-starved defect committed by '
      + 'the control named after it. Five states, each asked only for rows matching sweep-unfed: '
      + '(P0) production as it stands, 828 NOT applied -> SILENT, correctly — the new writer does not exist, '
      + 'so its row is gated off and no environment behind 828 is red for a defect it does not have. '
      + '(P1) 828 applied, 834 NOT -> RED, naming request_eligible_promotions. This is the exact state the '
      + 'un-extended arm reported as clean, and the reason this entry exists. '
      + '(P2) 828 + 834 both applied -> SILENT. '
      + '(P3) both applied cleanly, then the INSTALLED sweep replaced with the old writer\'s call stubbed out '
      + '-> RED, naming raise_trust_widening_proposals. '
      + '(P4) same, new writer\'s call stubbed -> RED, naming request_eligible_promotions. '
      + 'P3/P4 mutate the sweep AFTER 834 rather than inside it, because 834\'s own PROBE 1 asserts the same '
      + 'two calls and would abort the transaction before arm 8 was ever asked — which is itself the '
      + 'compensating control this entry relies on between manual runs. live_fns strips line comments before '
      + 'matching, so a row cannot be satisfied by prose naming the writer it looks for — P4 is the direct '
      + 'proof: 834\'s step (f) comment names request_eligible_promotions (counted: one occurrence in the '
      + 'installed body\'s comments), its call was the only thing stubbed, and the arm still went red. '
      + '(P3 is not a comment-stripping proof: nothing in the '
      + 'installed body\'s comments names raise_trust_widening_proposals.)',
  },
  ...(() => {
    const HQ = '5bb802e1-8e92-4eef-9a7a-ac348785d43f';       // outsourcetel-hq (active)
    const ACME = 'a1b2c3d4-0000-0000-0000-000000000001';     // acme-telecom (suspended)
    // Morgan's four real approved-and-landed send_payment_reminder decisions
    // (2026-08-04/05) — production origin, each with a landed execution.
    // Deciding or even voiding their TASKS later cannot break these cases:
    // the ledger arms re-check status='approved' + landed, both of which are
    // terminal states, and the fixture supplies its own proposal row.
    const REAL = ['c0701141-5d0c-4e7c-b2c6-1942f1462fb9',
                  '9d3f51b5-8956-41f8-b139-140b0c33843e',
                  'dfe869eb-27f2-41c6-b6ba-19000a10d858'];
    const BOGUS = '00000000-0000-4000-8000-000000000710';    // referenced by nothing
    const evidence = (ids) => `jsonb_build_object('pattern', jsonb_build_object('n_approved', ${ids.length}, 'decisions',
                      jsonb_build_array(${ids.map((id) => `jsonb_build_object('task_id', '${id}')`).join(', ')})))`;
    const prop = (tenant, ids) => `  select '00000000-0000-4000-8000-000000000711'::uuid, '${tenant}'::uuid,
                      'MUTATION FIXTURE'::text, ${evidence(ids)}`;
    const only = (arm, extra) => `select 1 from (${trustProposerBoundarySql({ proposalExtra: extra })}) x
       where x.violation like '${arm} — %' and x.violation like '%MUTATION FIXTURE%'`;
    return [
      {
        name: 'trust-proposer (citation-not-in-ledger: a cited decision the ledger cannot confirm is flagged; three real landed decisions are not)',
        fires: only('citation-not-in-ledger', prop(HQ, [REAL[0], REAL[1], BOGUS])),
        silent: only('citation-not-in-ledger', prop(HQ, REAL)),
      },
      {
        name: 'trust-proposer (citation-below-floor: fewer than 3 cited decisions is flagged)',
        fires: only('citation-below-floor', prop(HQ, [REAL[0], REAL[1]])),
        silent: only('citation-below-floor', prop(HQ, REAL)),
      },
      {
        name: 'trust-proposer (a suspended workspace holding an open system proposal is flagged; an active one is not)',
        fires: only('proposal-in-dormant-workspace', prop(ACME, REAL)),
        silent: only('proposal-in-dormant-workspace', prop(HQ, REAL)),
      },
      {
        // The orphan arm's mechanics: a pending proposal NO policy points at
        // fires; one with a live pending_task_id back-pointer does not. The
        // silent half rides on acme's stale-but-present linkage
        // (trust_policies.pending_task_id = 406f7bda…, the July answer_dock
        // request whose rejection never cleared the pointer) — stable unless
        // someone re-requests that policy, and the comment in the case name
        // will say so if it ever flips.
        name: 'trust-proposer (orphan-proposal: a pending proposal no policy points at is flagged)',
        fires: `select 1 from (${trustProposerBoundarySql({ orphanExtra:
          `  select '${BOGUS}'::uuid, 'MUTATION FIXTURE'::text, 'orphan fixture'::text` })}) x
           where x.violation like 'orphan-proposal — %' and x.violation like '%MUTATION FIXTURE%'`,
        silent: `select 1 from (${trustProposerBoundarySql({ orphanExtra:
          `  select '406f7bda-00c9-42b8-9c4c-23be8a10035b'::uuid, 'MUTATION FIXTURE'::text, 'linked fixture'::text` })}) x
           where x.violation like 'orphan-proposal — %' and x.violation like '%MUTATION FIXTURE%'`,
      },
    ];
  })(),
  {
    name: 'execute-perimeter (revoked fn removed from allowlist detects re-grant)',
    // Real perimeter check compares live grants to the pinned allowlist. Fire =
    // a live grant not in the pinned set. Proven by construction: we just
    // revoked 6 and re-pinned; certify was RED before the re-pin (the run above
    // showed the mismatch) and GREEN after. Marked MANUAL-VERIFIED.
    manual: 'certify was red with the 6 stale grants, green after --pin-allowlist. Directly observed this session.',
  },
  // ── mig 712 typed gaps: the four new probes, each driven through the REAL
  // SQL builders over synthesised rows. `fires` filters on the violation TEXT
  // naming the injected break (strict scoring); `silent` runs the same query
  // over the clean twin and must return zero VIOLATION rows (note/denominator
  // rows are excluded by the violation-is-not-null filter).
  ...(() => {
    const viol = (sql, like) => `select 1 from (${sql}) x
       where x.violation is not null${like ? ` and x.violation like '%${like}%'` : ''}`;
    const FXD = '00000000-0000-4000-8000-000000000712';   // fixture definition id
    const FXT = '00000000-0000-4000-8000-000000000042';   // fixture tenant id
    // a def row that never qualifies for the data arm (insert-stamped) — used
    // where a case needs the OTHER arm isolated, because an empty VALUES list
    // is a syntax error, not an empty fixture.
    const benignDef = { id: FXD, tenant_id: FXT, name: 'fx', key: 'fx', created_at: '2026-08-13T10:00:00Z', steps_updated_at: '2026-08-13T10:00:00Z' };
    const gapBase = { id: FXD, definition_id: FXD, kind: 'missing_knowledge', gap_key: 'knowledge:fx', source: 'study' };
    return [
      {
        name: 'gap-gate-can-only-pause (a gap_gate recorded done IS the forbidden execute-anyway; waiting/skipped stay silent)',
        fires: viol(gapGateConductSql([{ id: 'fx-run', steps: [{ key: 'gap_gate', status: 'done' }, { key: 'complete', status: 'pending' }] }]),
          `gap_gate step ended ''done''`),
        silent: viol(gapGateConductSql([{ id: 'fx-run', steps: [{ key: 'gap_gate', status: 'waiting' }, { key: 'gap_gate', status: 'skipped' }, { key: 'gap_gate', status: 'cancelled' }, { key: 'complete', status: 'pending' }] }])),
      },
      {
        name: 'playbook-steps-writes-are-audited (DRIVING ARM: the probe pointed at a trigger name that does not exist reports the guard missing)',
        fires: viol(auditedStepsWritesSql({ triggerName: 'zz_no_such_trigger_712', defs: [benignDef], events: [].concat([{ tenant_id: FXT, definition_id: FXD, kind: 'playbook_steps_updated', created_at: '2026-08-13T10:00:00Z' }]) }),
          'MISSING or DISABLED'),
        silent: viol(auditedStepsWritesSql({ defs: [benignDef], events: [{ tenant_id: FXT, definition_id: FXD, kind: 'playbook_steps_updated', created_at: '2026-08-13T10:00:00Z' }] })),
      },
      {
        name: 'playbook-steps-writes-are-audited (DATA ARM: a steps update with no audit event within 5 minutes fires; the same update with its event is silent)',
        fires: viol(auditedStepsWritesSql({
          defs: [{ id: FXD, tenant_id: FXT, name: 'fx', key: 'fx', created_at: '2026-08-13T10:00:00Z', steps_updated_at: '2026-08-13T11:00:00Z' }],
          events: [{ tenant_id: FXT, definition_id: FXD, kind: 'playbook_steps_updated', created_at: '2026-08-13T18:00:00Z' }],
        }), 'NO playbook_steps_updated audit event'),
        silent: viol(auditedStepsWritesSql({
          defs: [{ id: FXD, tenant_id: FXT, name: 'fx', key: 'fx', created_at: '2026-08-13T10:00:00Z', steps_updated_at: '2026-08-13T11:00:00Z' }],
          events: [{ tenant_id: FXT, definition_id: FXD, kind: 'playbook_steps_updated', created_at: '2026-08-13T11:00:30Z' }],
        })),
      },
      {
        name: 'published-snapshots-respect-the-gate (a snapshot smuggling an unpinned primitive is named; the pinned vocabulary is silent)',
        fires: viol(snapshotGateSql([{ id: 'fx-v', published_at: '2026-08-13T00:00:00Z', steps: [{ key: 'teleport_money' }, { key: 'complete' }] }]),
          'outside the pinned snapshot vocabulary'),
        silent: viol(snapshotGateSql([{ id: 'fx-v', published_at: '2026-08-13T00:00:00Z', steps: [{ key: 'instruction' }, { key: 'gap_gate', params: { gap_id: FXD } }, { key: 'complete' }] }])),
      },
      {
        name: 'published-snapshots-respect-the-gate (last_step + double-approval relaxations land as named rows)',
        fires: viol(snapshotGateSql([{ id: 'fx-v', published_at: '2026-08-13T00:00:00Z', steps: [{ key: 'generate_invoice' }, { key: 'human_approval' }, { key: 'human_approval' }, { key: 'instruction' }] }]),
          'not complete'),
        silent: viol(snapshotGateSql([{ id: 'fx-v', published_at: '2026-08-13T00:00:00Z', steps: [{ key: 'generate_invoice' }, { key: 'human_approval' }, { key: 'complete' }] }])),
      },
      {
        name: 'published-snapshots-respect-the-gate (a gap_gate that cannot name its gap fires; pin-date scoping keeps the 14 legacy snapshots as reported debt, not findings)',
        fires: viol(snapshotGateSql([{ id: 'fx-v', published_at: '2026-08-13T00:00:00Z', steps: [{ key: 'gap_gate', params: {} }, { key: 'complete' }] }]),
          'no gap_id'),
        // the SAME violating shape dated before the pin is scoped out — this is
        // the half that proves the date scope works and cannot silently widen
        silent: viol(snapshotGateSql([{ id: 'fx-v', published_at: '2026-07-01T00:00:00Z', steps: [{ key: 'gap_gate', params: {} }, { key: 'instruction' }] }])),
      },
      {
        // mig 713 DRIVING ARM. The 14 legacy rows are excluded by date, so a
        // clean post-pin corpus alone can NEVER fail this probe — a dropped
        // table gate would be invisible. Pointing the pin at a trigger name
        // that does not exist simulates exactly that drop.
        name: 'published-snapshots-respect-the-gate (DRIVING ARM, mig 713: the playbook_versions table gate dropped or disabled is named even with zero bad rows)',
        fires: viol(snapshotGateSql(
          [{ id: 'fx-v', published_at: '2026-08-13T00:00:00Z', steps: [{ key: 'instruction' }, { key: 'complete' }] }],
          { triggerName: 'zz_no_such_trigger_713' }), 'MISSING or DISABLED'),
        silent: viol(snapshotGateSql(
          [{ id: 'fx-v', published_at: '2026-08-13T00:00:00Z', steps: [{ key: 'instruction' }, { key: 'complete' }] }])),
      },
      {
        // mig 713 RATCHET ARM. A snapshot inserted with a BACKDATED
        // published_at is the one route past every post-pin arm; the
        // high-water mark is what notices it. Inverted by lifting the mark
        // over the same rows — the ratchet must go quiet, not the fixture.
        name: 'published-snapshots-respect-the-gate (RATCHET ARM, mig 713: pre-pin failing snapshots rising above the high-water mark fires; the same rows under a raised mark are silent)',
        fires: viol(snapshotGateSql([
          { id: 'fx-old-1', published_at: '2026-07-01T00:00:00Z', steps: [{ key: 'instruction' }] },
          { id: 'fx-old-2', published_at: '2026-07-02T00:00:00Z', steps: [{ key: 'instruction' }] },
        ], { legacyMax: 1 }), 'high-water mark'),
        silent: viol(snapshotGateSql([
          { id: 'fx-old-1', published_at: '2026-07-01T00:00:00Z', steps: [{ key: 'instruction' }] },
          { id: 'fx-old-2', published_at: '2026-07-02T00:00:00Z', steps: [{ key: 'instruction' }] },
        ], { legacyMax: 2 })),
      },
      {
        name: 'playbook-gaps-hold-their-evidence (a RESOLVED knowledge gap with no retrieved doc in its answer is a say-so closure and fires)',
        fires: viol(gapEvidenceSql({
          gaps: [{ ...gapBase, status: 'resolved', answer: { note: 'trust me' }, answered_at: '2026-08-13T10:00:00Z', resolved_at: '2026-08-13T10:00:00Z' }],
          studies: [{ definition_id: FXD, updated_at: '2026-08-13T10:00:00Z', n_gaps: 1, n_validation_errors: 0 }],
        }), 'no doc evidence'),
        silent: viol(gapEvidenceSql({
          gaps: [{ ...gapBase, status: 'resolved', answer: { doc_id: FXD }, answered_at: '2026-08-13T10:00:00Z', resolved_at: '2026-08-13T10:00:00Z' }],
          studies: [{ definition_id: FXD, updated_at: '2026-08-13T10:00:00Z', n_gaps: 1, n_validation_errors: 0 }],
        })),
      },
      {
        name: 'playbook-gaps-hold-their-evidence (resolved-without-timestamp and answered-without-answer are stored markers and fire)',
        fires: viol(gapEvidenceSql({
          gaps: [{ ...gapBase, status: 'resolved', answer: { doc_id: FXD }, answered_at: '2026-08-13T10:00:00Z' }],
          studies: [{ definition_id: FXD, updated_at: '2026-08-13T10:00:00Z', n_gaps: 1, n_validation_errors: 0 }],
        }), 'resolved_at is NULL'),
        silent: viol(gapEvidenceSql({
          gaps: [{ ...gapBase, status: 'answered', answer: { doc_id: FXD }, answered_at: '2026-08-13T10:00:00Z' }],
          studies: [{ definition_id: FXD, updated_at: '2026-08-13T10:00:00Z', n_gaps: 1, n_validation_errors: 0 }],
        })),
      },
      {
        name: 'playbook-gaps-hold-their-evidence (COVERAGE: a study that raised gaps with zero rows behind it means objections are prose again)',
        fires: viol(gapEvidenceSql({
          gaps: [{ ...gapBase, definition_id: '00000000-0000-4000-8000-00000000dead', status: 'open' }],
          studies: [{ definition_id: FXD, updated_at: '2026-08-13T10:00:00Z', n_gaps: 3, n_validation_errors: 0 }],
        }), 'ZERO playbook_gaps rows'),
        silent: viol(gapEvidenceSql({
          gaps: [{ ...gapBase, status: 'open' }],
          studies: [{ definition_id: FXD, updated_at: '2026-08-13T10:00:00Z', n_gaps: 3, n_validation_errors: 0 }],
        })),
      },
      {
        name: 'playbook-gaps-hold-their-evidence (COVERAGE: validator errors recorded with no validator-sourced gaps = errors dropped again, spec §1.2b)',
        fires: viol(gapEvidenceSql({
          gaps: [{ ...gapBase, status: 'open', source: 'study' }],
          studies: [{ definition_id: FXD, updated_at: '2026-08-13T10:00:00Z', n_gaps: 1, n_validation_errors: 2 }],
        }), 'dropped again'),
        silent: viol(gapEvidenceSql({
          gaps: [{ ...gapBase, status: 'open', source: 'validator' }],
          studies: [{ definition_id: FXD, updated_at: '2026-08-13T10:00:00Z', n_gaps: 1, n_validation_errors: 2 }],
        })),
      },
    ];
  })(),
  // ── migs 714/715/716-719: authenticated-write-perimeter ──────────────────
  // Arms 2 and 3 driven through the REAL builder over synthesised catalogue
  // rows. Every source is substitutable precisely so these cases exercise the
  // shipped predicate rather than a paraphrase — and each `fires` filters on
  // the violation TEXT naming the injected break, so a probe that returned
  // some OTHER row would score as a miss, not a catch.
  //
  // The point of the negative cases: arm 2's predicate has four conjuncts
  // (schema, grantee, privilege, base-table). A case that only flips TRUNCATE
  // to SELECT proves one of them. `service_role` and `storage` prove the other
  // two are not vacuous — a probe that fired on every grant in the database
  // would pass a single-conjunct test and be useless.
  ...(() => {
    const viol = (sql, like) => `select 1 from (${sql}) x
       where x.violation is not null${like ? ` and x.violation like '%${like}%'` : ''}`;
    const grant = (grantee, priv, sch = 'public', tbl = 'mutant_tbl') =>
      `select '${tbl}'::text as tbl, '${sch}'::text as sch, '${grantee}'::text as grantee, '${priv}'::text as priv`;
    const NO_DEFACL = `select null::text as grantor, null::text as letters where false`;
    const CLEAN_DEFACL = `select 'postgres'::text as grantor, 'rxtm'::text as letters`;
    // A grant source that yields nothing, for the arm-3 and denominator cases
    // that must isolate their own arm. An empty VALUES list is a syntax error,
    // hence the `where false`.
    const NO_GRANTS = `select null::text as tbl, null::text as sch, null::text as grantee, null::text as priv where false`;
    const SOME_TABLES = `select 'fixture_tbl'::text as tbl`;
    return [
      {
        name: 'authenticated-write-perimeter arm 2 (a synthesised TRUNCATE grant to authenticated is caught, and the violation names the table)',
        fires: viol(writePerimeterSql({ grantSource: grant('authenticated', 'TRUNCATE'), defaclSource: NO_DEFACL }), 'mutant_tbl: TRUNCATE granted to authenticated'),
        silent: viol(writePerimeterSql({ grantSource: grant('authenticated', 'SELECT'), defaclSource: NO_DEFACL })),
      },
      {
        name: 'authenticated-write-perimeter arm 2 (the GRANTEE conjunct is not vacuous — service_role TRUNCATE is legitimate and must stay silent)',
        fires: viol(writePerimeterSql({ grantSource: grant('authenticated', 'TRUNCATE'), defaclSource: NO_DEFACL }), 'mutant_tbl'),
        silent: viol(writePerimeterSql({ grantSource: grant('service_role', 'TRUNCATE'), defaclSource: NO_DEFACL })),
      },
      {
        name: 'authenticated-write-perimeter arm 2 (the SCHEMA conjunct is not vacuous — docs/52 §9 leaves storage out of scope, so a storage grant must stay silent)',
        fires: viol(writePerimeterSql({ grantSource: grant('authenticated', 'TRUNCATE'), defaclSource: NO_DEFACL }), 'mutant_tbl'),
        silent: viol(writePerimeterSql({ grantSource: grant('authenticated', 'TRUNCATE', 'storage'), defaclSource: NO_DEFACL })),
      },
      {
        name: 'authenticated-write-perimeter arm 3a (the postgres default-ACL row regrowing write letters is caught; anon\'s rxtm precedent is clean)',
        fires: viol(writePerimeterSql({ grantSource: NO_GRANTS, defaclSource: `select 'postgres'::text as grantor, 'arwdDxtm'::text as letters` }), 'default privileges REGROWING'),
        silent: viol(writePerimeterSql({ grantSource: NO_GRANTS, defaclSource: CLEAN_DEFACL })),
      },
      {
        name: 'authenticated-write-perimeter arm 3a (a write letter WITHOUT TRUNCATE still fires — the ratchet revoked all four, not just D)',
        fires: viol(writePerimeterSql({ grantSource: NO_GRANTS, defaclSource: `select 'postgres'::text as grantor, 'arwxtm'::text as letters` }), 'a write privilege'),
        silent: viol(writePerimeterSql({ grantSource: NO_GRANTS, defaclSource: CLEAN_DEFACL })),
      },
      {
        name: 'authenticated-write-perimeter DENOMINATOR (examining zero tables is a VIOLATION, not a clean result)',
        fires: viol(writePerimeterSql({ grantSource: NO_GRANTS, tableSource: `select null::text as tbl where false`, defaclSource: NO_DEFACL }), 'no-comparisons'),
        silent: viol(writePerimeterSql({ grantSource: NO_GRANTS, tableSource: SOME_TABLES, defaclSource: NO_DEFACL })),
      },
      {
        // THE ONE A SELECT CANNOT FAKE. docs/52 §6b wrote this case and
        // deliberately did not run it, because it is a DDL write; the applying
        // agent was asked to. It was run, twice, against PRODUCTION inside an
        // explicit transaction that rolled back — once before mig 715 and once
        // after — and the rollback was confirmed to have left no table behind
        // (`select count(*) from pg_class where relname='_mutant_default_acl_check'` = 0
        // both times, and the live TRUNCATE count stayed at 0).
        //
        //   begin;
        //     create table public._mutant_default_acl_check (id int);
        //     select privilege_type from information_schema.role_table_grants
        //      where table_schema='public' and table_name='_mutant_default_acl_check'
        //        and grantee='authenticated';
        //   rollback;
        //
        // BEFORE mig 715 → DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
        // AFTER  mig 715 → REFERENCES, SELECT, TRIGGER
        //
        // This is what turns "pg_default_acl says arwdDxtm" from catalogue
        // inference into an observed new table. The letters are not the claim;
        // the table that came out of the database is.
        name: 'authenticated-write-perimeter ratchet (MANUAL, DDL-in-rollback: a NEW table was born truncatable before mig 715 and is not after)',
        manual: 'RUN against production this session. Before 715: a freshly created public table granted authenticated DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE. After 715: REFERENCES,SELECT,TRIGGER only. Both runs rolled back; pg_class confirmed no stray table and the live TRUNCATE count stayed 0. Regrowth OBSERVED, ratchet OBSERVED to hold.',
      },
    ];
  })(),

  // ── mig 840: evidence-tables-are-sealed ──────────────────────────────────
  // Arms A/B/C and the denominator, driven through the REAL builder.
  //
  // ⚠ THE FIRST FOUR CASES DELIBERATELY DO NOT SYNTHESISE ANYTHING. They vary
  // only the SEALED LIST and let the shipped default grantSource ask
  // has_table_privilege about REAL tables on the REAL database, because the
  // whole predicate of arm A lives in that source — substituting it would test
  // a `select … from held` that cannot be wrong, and score a green for it.
  // That is the mig 661 defect (a pin that could not fail because the check
  // and the thing it checked had drifted apart) and this is the shape of it
  // that a substitutable-source design invites.
  //
  // The two live controls are chosen because they are STABLE in OPPOSITE
  // directions and will stay that way:
  //   de_conversations                — written directly from 10 places in
  //                                     shipped code, so its service_role
  //                                     writes can never be revoked. Arm A
  //                                     MUST fire on it.
  //   discovery_capability_demand_log — write-sealed by mig 744:197 and the
  //                                     only other sealed table here. Arm A
  //                                     MUST stay silent on it.
  // Verified live 2026-08-21: 6 violations and 0 violations respectively.
  //
  // The sealed control is doing double duty. It also proves the FORBIDDEN LIST
  // is not vacuous: that table HOLDS SELECT (service_role=r/postgres), so a
  // probe that treated any grant at all as a violation would fire on it. A
  // silent run there is the only thing separating "sealed" from "mentioned".
  ...(() => {
    const viol = (sql, like) => `select 1 from (${sql}) x
       where x.violation is not null${like ? ` and x.violation like '%${like}%'` : ''}`;
    const UNSEALED = 'de_conversations';                  // arm A must fire
    const SEALED   = 'discovery_capability_demand_log';   // arm A must not
    // Arm C has no live example — no table on this database has had SELECT
    // revoked from service_role — so it is the one arm that must synthesise
    // its input. present = true with can_read = false is the state a
    // `revoke all` with a forgotten `grant select` would leave behind.
    const presence = (tbl, present, canRead) =>
      `select '${tbl}'::text as tbl, ${present} as present, ${canRead} as can_read`;
    const NO_HELD = `select null::text as tbl, null::text as priv where false`;
    return [
      {
        name: 'evidence-tables-are-sealed arm A (REAL predicate, REAL tables: a service_role write grant on an unsealed table is caught, and a genuinely sealed table stays silent)',
        fires: viol(sealedEvidenceSql({ sealed: [UNSEALED] }), `${UNSEALED}.INSERT`),
        silent: viol(sealedEvidenceSql({ sealed: [SEALED] })),
      },
      {
        name: 'evidence-tables-are-sealed arm A (the FORBIDDEN list is not vacuous — the sealed control HOLDS SELECT and must not be reported for it)',
        fires: viol(sealedEvidenceSql({ sealed: [UNSEALED] }), 'TRUNCATE'),
        silent: viol(sealedEvidenceSql({ sealed: [SEALED] }), 'SELECT'),
      },
      {
        name: 'evidence-tables-are-sealed arm B (a sealed table that does not exist is a VIOLATION, not a silent pass — the seal would be guarding nothing)',
        fires: viol(sealedEvidenceSql({ sealed: ['zz_definitely_not_a_table'] }), 'no such table exists'),
        silent: viol(sealedEvidenceSql({ sealed: [SEALED] })),
      },
      {
        name: 'evidence-tables-are-sealed arm C (OVER-revoked: a sealed table whose service_role SELECT is gone is caught — the seal stops writes, not reads)',
        fires: viol(sealedEvidenceSql({ sealed: [SEALED], grantSource: NO_HELD, presenceSource: presence(SEALED, true, false) }), 'has lost SELECT'),
        silent: viol(sealedEvidenceSql({ sealed: [SEALED], grantSource: NO_HELD, presenceSource: presence(SEALED, true, true) })),
      },
      {
        name: 'evidence-tables-are-sealed DENOMINATOR (an empty seal list examines 0 tables, which is a VIOLATION — a probe that read nothing looks exactly like a clean one)',
        fires: viol(sealedEvidenceSql({ sealed: [] }), 'no-comparisons'),
        silent: viol(sealedEvidenceSql({ sealed: [SEALED] }), 'no-comparisons'),
      },
    ];
  })(),

  // ── mig 720: write-grants-can-actually-write ─────────────────────────────
  // The class: a write grant on an RLS-enabled table with NO PERMISSIVE policy
  // for that command. Postgres refuses it before the grant is read, PostgREST
  // returns SUCCESS WITH NO ERROR, and the client reports a write that never
  // happened. The predicate has FIVE conjuncts — grantee, privilege, RLS on,
  // PERMISSIVE, and a role the caller is in — and one case per conjunct is the
  // point: a probe that fired on every grant in the database would pass a
  // single-conjunct test and be worse than nothing.
  //
  // Every case carries a CONTROL pair (ctrl_tbl.UPDATE, RLS on, policy present)
  // so that a `silent` run is silent because the PREDICATE cleared it, never
  // because the denominator arm had nothing left to compare. Without the
  // control, the RLS-off case would "pass" by tripping no-comparisons instead.
  ...(() => {
    const viol = (sql, like) => `select 1 from (${sql}) x
       where x.violation is not null${like ? ` and x.violation like '%${like}%'` : ''}`;
    const rows = (...rs) => rs.join(' union all ');
    const g = (grantee, priv, tbl = 'mutant_tbl', sch = 'public') =>
      `select '${tbl}'::text as tbl, '${sch}'::text as sch, '${grantee}'::text as grantee, '${priv}'::text as priv`;
    const pol = (cmd, permissive, roles, tbl = 'mutant_tbl') =>
      `select '${tbl}'::text as tbl, '${cmd}'::text as cmd, '${permissive}'::text as permissive, ` +
      `array[${roles.map((r) => `'${r}'`).join(',')}]::text[] as roles`;
    const rls = (on, tbl = 'mutant_tbl') => `select '${tbl}'::text as tbl, ${on} as rls_enabled`;
    // The control: a kept grant that is genuinely usable. Present in every case.
    const CG = g('authenticated', 'UPDATE', 'ctrl_tbl');
    const CP = pol('UPDATE', 'PERMISSIVE', ['authenticated'], 'ctrl_tbl');
    const CR = rls(true, 'ctrl_tbl');
    const NO_GRANTS = `select null::text as tbl, null::text as sch, null::text as grantee, null::text as priv where false`;
    const MUT = 'mutant_tbl.UPDATE: authenticated holds this write grant';
    return [
      {
        name: 'write-grants-can-actually-write (a kept grant with NO policy for its command is caught, and the violation names table.PRIVILEGE — the exact de_deployment_stages/UPDATE shape mig 720 closed)',
        fires: viol(silentNoopWriteSql({ grantSource: rows(CG, g('authenticated', 'UPDATE')), policySource: CP, rlsSource: rows(CR, rls(true)) }), MUT),
        silent: viol(silentNoopWriteSql({ grantSource: rows(CG, g('authenticated', 'UPDATE')), policySource: rows(CP, pol('UPDATE', 'PERMISSIVE', ['authenticated'])), rlsSource: rows(CR, rls(true)) })),
      },
      {
        name: 'write-grants-can-actually-write (the COMMAND conjunct is not vacuous — a SELECT policy does not cover UPDATE; a cmd=ALL policy does)',
        fires: viol(silentNoopWriteSql({ grantSource: rows(CG, g('authenticated', 'UPDATE')), policySource: rows(CP, pol('SELECT', 'PERMISSIVE', ['authenticated'])), rlsSource: rows(CR, rls(true)) }), MUT),
        silent: viol(silentNoopWriteSql({ grantSource: rows(CG, g('authenticated', 'UPDATE')), policySource: rows(CP, pol('ALL', 'PERMISSIVE', ['authenticated'])), rlsSource: rows(CR, rls(true)) })),
      },
      {
        name: 'write-grants-can-actually-write (a RESTRICTIVE policy is NOT coverage — docs/52 §1 made exactly this mistake and mis-classified 7 tables as live)',
        fires: viol(silentNoopWriteSql({ grantSource: rows(CG, g('authenticated', 'UPDATE')), policySource: rows(CP, pol('UPDATE', 'RESTRICTIVE', ['authenticated'])), rlsSource: rows(CR, rls(true)) }), MUT),
        silent: viol(silentNoopWriteSql({ grantSource: rows(CG, g('authenticated', 'UPDATE')), policySource: rows(CP, pol('UPDATE', 'PERMISSIVE', ['authenticated'])), rlsSource: rows(CR, rls(true)) })),
      },
      {
        name: 'write-grants-can-actually-write (the ROLE conjunct is not vacuous — a policy naming only service_role leaves authenticated refused; {public} covers it)',
        fires: viol(silentNoopWriteSql({ grantSource: rows(CG, g('authenticated', 'UPDATE')), policySource: rows(CP, pol('UPDATE', 'PERMISSIVE', ['service_role'])), rlsSource: rows(CR, rls(true)) }), MUT),
        silent: viol(silentNoopWriteSql({ grantSource: rows(CG, g('authenticated', 'UPDATE')), policySource: rows(CP, pol('UPDATE', 'PERMISSIVE', ['public'])), rlsSource: rows(CR, rls(true)) })),
      },
      {
        name: 'write-grants-can-actually-write (the RLS conjunct is not vacuous — with RLS OFF the grant works and there is nothing to report; the control keeps the denominator non-zero)',
        fires: viol(silentNoopWriteSql({ grantSource: rows(CG, g('authenticated', 'UPDATE')), policySource: CP, rlsSource: rows(CR, rls(true)) }), MUT),
        silent: viol(silentNoopWriteSql({ grantSource: rows(CG, g('authenticated', 'UPDATE')), policySource: CP, rlsSource: rows(CR, rls(false)) })),
      },
      {
        name: 'write-grants-can-actually-write (the PRIVILEGE conjunct is not vacuous — SELECT is not a write and is never in scope)',
        fires: viol(silentNoopWriteSql({ grantSource: rows(CG, g('authenticated', 'UPDATE')), policySource: CP, rlsSource: rows(CR, rls(true)) }), MUT),
        silent: viol(silentNoopWriteSql({ grantSource: rows(CG, g('authenticated', 'SELECT')), policySource: CP, rlsSource: rows(CR, rls(true)) })),
      },
      {
        name: 'write-grants-can-actually-write (the GRANTEE conjunct is not vacuous — service_role bypasses RLS entirely, so its policy-less grants are legitimate)',
        fires: viol(silentNoopWriteSql({ grantSource: rows(CG, g('authenticated', 'UPDATE')), policySource: CP, rlsSource: rows(CR, rls(true)) }), MUT),
        silent: viol(silentNoopWriteSql({ grantSource: rows(CG, g('service_role', 'UPDATE')), policySource: CP, rlsSource: rows(CR, rls(true)) })),
      },
      {
        name: 'write-grants-can-actually-write DENOMINATOR (comparing zero grant/command pairs is a VIOLATION, not a clean result)',
        fires: viol(silentNoopWriteSql({ grantSource: NO_GRANTS, policySource: CP, rlsSource: CR }), 'no-comparisons'),
        silent: viol(silentNoopWriteSql({ grantSource: CG, policySource: CP, rlsSource: CR })),
      },
      {
        // The one a SELECT cannot fake: real DDL, a real policy, the real
        // catalogue. Run on DEV inside a transaction that rolled back.
        name: 'write-grants-can-actually-write (MANUAL, live DDL-in-rollback on dev: a real granted-but-unpolicied table is caught by the REAL probe, and adding the policy clears it)',
        manual: 'RUN on dev (nmuntxrcdksyhsdywpan) this session, twice, inside begin/rollback: (1) create table public._mutant_noop_write(id int); alter table enable row level security; grant update to authenticated; -- no policy -> the REAL silentNoopWriteSql() returned the violation naming _mutant_noop_write.UPDATE. (2) same, plus `create policy ... for update to authenticated using (true)` -> 0 violations, denominator note printed. Both rolled back; pg_class confirmed no stray table afterwards. See the session report for the exact rows.',
      },
    ];
  })(),

  // ── branch-parity (Debt #0) ────────────────────────────────────────────
  // These five cannot be faked by a SELECT: the probe's live arms drive the
  // DEPLOYED playbook-execute over HTTP and, in ARM 5, create/advance/delete a
  // real run row. So the mutations live in the probe itself behind --mutate,
  // the same shape playbook-gate-parity.mjs uses, and each --mutate run exits
  // 0 ONLY if the injected break was caught AND named in the output. Recorded
  // here so the count is in the suite's denominator rather than in a commit
  // message nobody re-runs.
  //
  // Re-run any of them with:
  //   node scripts/playbook-branch-parity.mjs --mutate=<case>
  ...[
    ['arm-goes-missing',
      'ARM 1 (source). Drops `update_record` from the parsed executor arms. CAUGHT — "ARM 1 MISSING EXECUTOR ARM: validateSteps accepts \\"update_record\\" inside a decision branch and runBranchStep has no case for it". This is literally Debt #0: the pre-fix source scored 10 accepted keys against 6 arms.'],
    ['twin-drift',
      'ARM 2 (twin). Adds `consult_specialist` back to the builder\'s BRANCH_PRIMITIVES. CAUGHT — "ARM 2 TWIN DRIFT: only-in-builder=[consult_specialist] only-in-engine=[] — the palette offers a step the server will refuse". That was the REAL state of the file before this session.'],
    ['live-arm-silently-skips',
      'ARM 3 (live accept). Replaces one live preview result with the old default\'s wording. CAUGHT — "ARM 3 SILENT SKIP IS LIVE: the deployed executor dropped branch step \\"update_record\\" ... and the run reported completed — the exact Debt #0 behaviour".'],
    ['validator-accepts-junk',
      'ARM 4 (live refuse). Pretends the deployed validator accepted a junk key in a branch. CAUGHT — "ARM 4 VALIDATOR TOO LOOSE: the deployed validator ACCEPTS \\"teleport_money\\" inside a decision branch".'],
    ['unhandled-key-completes',
      'ARM 5 (live behaviour — the one that matters). Pretends the advanced run came back `completed`. CAUGHT — "ARM 5 THE SILENT DEFAULT IS ALIVE: a run whose branch holds \\"a_step_this_engine_cannot_run\\" reported COMPLETED ... filed as a success having performed neither requested action". Against the PRE-FIX deployment this arm fired for real, unmutated.'],
  ].map(([mut, evidence]) => ({
    name: `playbook-branch-parity --mutate=${mut} (MANUAL, drives the DEPLOYED edge function: a SELECT cannot fake an HTTP run)`,
    manual: `${evidence} Verified 2026-08-12 against playbook-execute v49; exit 0 = caught and named.`,
  })),

  // ── trigger-functions-hold-no-ambient-execute (mig 722) ────────────────
  // The probe runs against a catalogue that mig 722 just made CLEAN — 0 of 80
  // breached — so every arm returns zero rows and passes trivially. These are
  // the only thing proving it can fire at all. Each case UNIONs ONE synthesised
  // catalogue row into the REAL query and counts ONLY rows naming that fixture,
  // so a real breach arriving later cannot pass a case on the mutation's behalf.
  ...(() => {
    const viol = (sql, like = 'mutant_trigger_fn') => `select 1 from (${sql}) x
       where x.violation like '%${like}%'`;
    // Defaults are the CLEAN shape: nothing ambient, owner intact. Each case
    // flips exactly one field, so `silent` and `fires` differ by the defect
    // alone — the probe discriminating, not the harness choosing.
    const row = (o = {}) => {
      const d = { anon: 'false', authed: 'false', public_x: 'false', owner_x: 'true', ...o };
      return `select 'mutant_trigger_fn'::text as fn_name, ${d.anon} as anon,
                     ${d.authed} as authed, ${d.public_x} as public_x, ${d.owner_x} as owner_x`;
    };
    const withRow = (o) => triggerExecutePerimeterSql({
      fnSource: `${TRIGGER_FN_SOURCE} union all ${row(o)}`,
    });
    const case_ = (name, mutation) => ({
      name: `trigger-execute-perimeter (${name})`,
      fires: viol(withRow(mutation)),
      silent: viol(withRow({})),
    });
    return [
      // The 44 of 49: never granted to anyone, just never revoked from PUBLIC.
      // This is the shape a NEW function is still born with, because there is
      // no default-privileges fix for functions — so it is the one most likely
      // to arrive again.
      case_('the built-in PUBLIC grant left in place — the shape 44 of the 49 had',
            { public_x: 'true' }),
      // playbook_definitions_set_kind's shape: an explicit grant to both.
      case_('an explicit grant to anon', { anon: 'true' }),
      case_('an explicit grant to authenticated — the shape the other 5 had',
            { authed: 'true' }),
      // BOTH HALVES. mig 643's mask: the revoke that took too much. Without
      // this arm the probe would rate a function nobody can attach a trigger to
      // as perfectly healthy, because it is certainly not reachable by anon.
      case_('BOTH HALVES: the owner over-revoked, so CREATE TRIGGER would now fail',
            { owner_x: 'false' }),
      {
        // The arm that stops the whole probe being theatre once the catalogue
        // is clean, which it now is.
        name: 'trigger-execute-perimeter (an empty catalogue is a VIOLATION, not a clean sweep)',
        fires: viol(triggerExecutePerimeterSql({
          fnSource: `select null::text as fn_name, null::boolean as anon, null::boolean as authed,
                            null::boolean as public_x, null::boolean as owner_x where false`,
        }), 'no-comparisons'),
        silent: viol(triggerExecutePerimeterSql(), 'no-comparisons'),
      },
    ];
  })(),

  // ── deferred-register (docs/53) ───────────────────────────────────────
  // The register probe is a JS evaluation over review/deferred-register.json,
  // not a SQL query, so a `fires`/`silent` SELECT pair cannot express any of
  // it. Same situation as branch-parity above: the mutations live inside
  // scripts/deferred-register.mjs behind --mutate, each run exits 0 ONLY if the
  // injected break was CAUGHT and NAMED, and they are recorded here so they sit
  // in this suite's denominator instead of in a commit message nobody re-runs.
  //
  // ⚠⚠ BOTH DIRECTIONS ARE PROVEN, and they are genuinely different failures:
  // the register can be stale-OPEN (a fixed thing still carried as backlog —
  // docs/45's 28 guards) or stale-CLOSED (a live defect recorded as done, which
  // is the direction that misleads a person). A probe proving only one of those
  // would leave the other free to rot, and the second is the dangerous one.
  //
  // Re-run any of them with:
  //   node scripts/deferred-register.mjs --mutate=<case>
  ...[
    ['says-open-but-closed',
      'F1, the stale-OPEN direction. Takes an item the live verification proves CLOSED (B-1, mig 721\'s trigger is present and enabled) and records it as open. CAUGHT — "F1 REGISTER SAYS OPEN, REALITY SAYS CLOSED — B-1 … Its sql verification returned n=0, and the item is open only when n >= 1". This is exactly docs/45\'s residue: a finding that was real, got fixed, and went on being carried.'],
    ['says-closed-but-open',
      'F2, the stale-CLOSED direction — the one that misleads. Takes an item the live verification proves OPEN (A-1, anon and authenticated hold TRUNCATE on storage.objects) and records it closed with a fabricated closed_by. CAUGHT — "F2 REGISTER SAYS CLOSED, REALITY SAYS OPEN — A-1 … Something recorded as fixed is answering back". ⚠ Neither direction-case names its item in the source: both pick off the live verdicts of the unmutated pass, so the harness cannot choose an item that makes itself pass.'],
    ['broken-verification',
      'F3. Replaces a real item\'s SQL with `select this_column_does_not_exist from nowhere_at_all`. CAUGHT — "F3 VERIFICATION ERROR — A-1 (sql) could not be evaluated … relation \\"nowhere_at_all\\" does not exist". ⚠ THIS CASE WAS INCONCLUSIVE ON ITS FIRST RUN AND IS RECORDED AS FIXED, NOT AS A PASS: the probe was firing ~25 concurrent Management-API calls, the API answered 429, the resulting F3 carried the same item id, and the case "passed" off a throttle rather than the injected break. Two changes: the SQL verifications now go over as ONE batched statement (1 call, not 25), and this case requires the failure line to contain BOTH the item id AND the string `nowhere_at_all`, so a transport error can never satisfy it.'],
    ['duplicate-id',
      'F4 (schema). Pushes a copy of an existing item. CAUGHT — "F4 schema — duplicate id A-1: two items sharing an id means one of them can never be addressed, closed or cited".'],
    ['closed-without-evidence',
      'F4 (uncited closure). Marks an item closed and deletes closed_by. CAUGHT — "F4 schema — B-1 is recorded closed with no `closed_by` — closing an item is a claim, and a claim with no citation is what this register replaces". Without this arm, the cheapest way to shrink the backlog would be to type "closed".'],
    ['no-comparisons',
      'F5. Strips every verification, leaving 47 items and nothing to check. CAUGHT — "F5 NO-COMPARISONS — 47 item(s) in the register and ZERO runnable verifications". Every other arm is vacuously quiet in that state, so the section would print PASS having compared nothing.'],
    ['unsupported-claim',
      'F6. Re-anchors an unverifiable item to a sentence that appears in no document. CAUGHT — "F6 UNSUPPORTED CLAIM — A-6 is carried on docs/53-deferred-work-census.md, but the anchor text … is no longer in that file". This is what keeps "unverifiable" from degrading into "unfalsifiable".'],
    ['unverifiable-over-ceiling',
      'F7. Converts one checkable item into a claim-carried one without raising the ceiling. CAUGHT — "F7 UNVERIFIABLE CEILING EXCEEDED — 10 item(s) carry no mechanical verification, ceiling is 9". The ratchet is what stops the register quietly reverting to prose one item at a time.'],
    // ── F8, added 2026-08-20 after the D-12 false closure ──────────────────
    ['subject-method-mismatch',
      'F8, the POSITIVE direction — D-12 reconstructed. Takes a repo-source item checked by grep (B-7) and re-declares its subject as "deployed-edge", leaving the working-tree grep in place. CAUGHT — "F8 METHOD CANNOT ANSWER SUBJECT — B-7 … declares subject \\"deployed-edge\\" … but is verified by kind \\"grep\\", which interrogates something else". This is the defect itself: on 2026-08-18 D-12 was recorded CLOSED off a grep that was perfectly correct about the repo while 60 of 64 DEPLOYED bundles still ran the unpinned build. Before this arm the schema recorded only the METHOD, so nothing could compare it against the claim.'],
    ['subject-method-rematched-stays-silent',
      '⚠ F8, the NEGATIVE direction, and the arm that makes the positive one mean anything. Moves an open production-db/sql item (A-1) to a DIFFERENT subject AND its matching method at the same time — subject "repo-source" with a real grep. The pair stays coherent, so F8 must say NOTHING about A-1. SILENT (correct) — 0 lines containing both "F8" and "A-1"; the run\'s other failures are the two standing reds and are not about A-1. Without this control, an F8 that fired on ANY edit to a subject field would score identically to one that fires on a genuine mismatch, and the register would be back to a check that cannot tell the defect from an ordinary diff.'],
    ['deployed-probe-blind-to-subject',
      'A probe that cannot SEE its subject must ERROR, never return a confident zero. Points B-5\'s deployed-content check at slug "no-such-function-at-all". CAUGHT — "F3 VERIFICATION ERROR — B-5 … is not among the 64 deployed function(s) … a content question about a function that is not running cannot be answered, and must not be answered as zero". "Pattern absent" and "I never looked" both come back as 0 from a naive implementation, and 0 is what CLOSED looks like.'],
  ].map(([mut, evidence]) => ({
    name: `deferred-register --mutate=${mut} (MANUAL, a JS evaluation over a JSON register: a SELECT cannot fake it)`,
    manual: `${evidence} Re-run 2026-08-20 against the live register (68 items, 59 verified, 9 carried on claim); all 11 cases exit 0. ⚠ Scoring is strict in BOTH directions: a "caught" case needs ONE failure line carrying every expected substring, and a "silent" case fails if ANY line carries every forbidden one. An errored or no-op run is INCONCLUSIVE and is fixed and re-run, never counted.`,
  })),

  // ── edge-parity NORMALIZER (B-16) ─────────────────────────────────────────
  // The parity probe compares deno's EMIT against the repo's SOURCE, so both
  // sides go through one normalizer. On 2026-08-20 that normalizer reported 27
  // of 63 deployed functions DRIFTED; all 27 were measured and ALL 27 WERE
  // FALSE — three purely syntactic differences between the two emitters
  // (`(o) =>` vs `o =>`, `if (x) { … }` vs `if (x) …`, and `a ?? (b ?? c)` vs
  // `a ?? b ?? c`). tool-learn/index.ts differed at 3 characters of 5,758;
  // _shared/contentHash.ts at 1 of 427.
  //
  // ⚠⚠ FIXING THAT IS THE DANGEROUS DIRECTION, WHICH IS WHY THESE CASES EXIST.
  // A normalizer that canonicalises too much erases a REAL change and reports
  // a fleet in perfect parity while production runs stale code — D-12 exactly,
  // one layer down and wearing a green tick. "0 drifted" from a broken
  // normalizer is indistinguishable from "0 drifted" from a healthy fleet, so
  // the only evidence that it still works is a mutation that makes it fail.
  //
  // BOTH DIRECTIONS ARE PROVEN and they are opposite failures: TOO LOOSE
  // (erases a real difference) and TOO TIGHT (manufactures the 27 again).
  //
  // Re-run any of them with:
  //   node scripts/edge-deployed-parity.mjs --mutate=<case>
  // and the whole suite offline, with no token and no network, with:
  //   node scripts/edge-deployed-parity.mjs --self-test
  ...[
    ['erase-everything',
      'TOO LOOSE, the catastrophic shape. normalizeModule() returns a constant, so every module equals every other and the probe reports total parity. CAUGHT — "⚠ ERASED A REAL DIFFERENCE — the KNOWN-STALE supabase/functions/de-work/index.ts (a54d5b54^) normalized EQUAL to `main`". ⚠ The known-stale fixture is REAL HISTORY, not a toy: de-work and eval-run as they stood at a54d5b54^, carrying the `bearer === Deno.env.get(\'SUPABASE_SERVICE_ROLE_KEY\')` string-equality check that began 401-ing on 2026-08-18 when Supabase rotated the key, against those same files on `main`, which call serviceCaller(). It is put through cosmeticVariant() first, so the real change has to survive every difference the normalizer now erases.'],
    ['reassociate-across-operators',
      'TOO LOOSE. Drops the operator-EQUALITY test, so `a && (b || c)` and `a && (b && c)` both collapse to `a && b && c`. CAUGHT — "⚠ ERASED A REAL DIFFERENCE — BOUND: regrouping ACROSS operators". ⚠ THIS CASE WAS INCONCLUSIVE ON ITS FIRST RUN AND IS RECORDED AS FIXED, NOT AS A PASS: the bound pair was originally `(a || b) && c` vs `a || (b && c)`, which shares no OUTER operator, so the rebuilt spines stayed different (`a && b && c` vs `a || b || c`) and the case passed with the check removed — scoring exactly like a real catch. The pair now shares an outer `&&`, which is the only shape that can detect this mutation.'],
    ['reassociate-minus',
      'TOO LOOSE. Adds `-` to the associative set. Subtraction is not associative, so `a - (b - c)` would be flattened into `(a - b) - c`. CAUGHT — "⚠ ERASED A REAL DIFFERENCE — BOUND: `-` is not associative and must NOT be re-associated".'],
    ['reassociate-plus',
      'TOO LOOSE. Adds `+`. Not associative once a string is involved: `1 + (2 + "3")` is "123", `(1 + 2) + "3"` is "33". CAUGHT — "⚠ ERASED A REAL DIFFERENCE — BOUND: `+` is not associative once a string is involved". Together with the case above, these two are what keep the associative set at exactly `||`, `&&`, `??`.'],
    ['drop-arrow-canonicalisation',
      'TOO TIGHT — the false positives come back. Reverts the arrow-parameter step, so `.map((o) => …)` vs `.map(o => …)` reads as drift again (4 of the original 27, tool-learn among them). CAUGHT — "FALSE POSITIVE — arrow single parameter".'],
    ['drop-brace-canonicalisation',
      'TOO TIGHT. Reverts the block-wrapping step, so `if (x) { f(); }` vs `if (x) f();` reads as drift again — 24 of the original 27, including every one of the 23 driven by _shared/serviceCaller.ts. CAUGHT — "FALSE POSITIVE — braces around a single-statement body".'],
    ['drop-assoc-canonicalisation',
      'TOO TIGHT. Reverts the re-association step, so playbook-draft/index.ts:459 (`deId ?? ((targetDef.de_id as string | null) ?? null)`) reads as drift again. CAUGHT — "FALSE POSITIVE — nullish chain re-associated".'],
    ['no-perturbation',
      '⚠ THE ARM THAT STOPS THE SUITE BEING THEATRE. Makes cosmeticVariant() a no-op, so every negative arm compares a file with itself and passes having compared nothing — zero findings from zero comparisons, which looks exactly like a clean result. CAUGHT — "NO-COMPARISONS — cosmeticVariant() perturbed NONE of the self-test modules". The suite counts how many real modules the noise generator actually changed (5 of 6; contentHash.ts carries only the arrow form, which the printer cannot re-introduce) and fails at zero.'],
  ].map(([mut, evidence]) => ({
    name: `edge-parity-normalizer --mutate=${mut} (MANUAL, a pure-function comparison over source text: a SELECT cannot fake it)`,
    manual: `${evidence} Run 2026-08-21, offline, no token: the unmutated suite passes 27/27 checks (4 cosmetic-only pairs that must be IN SYNC, 15 behaviourally-different pairs that must be DRIFTED, 2 known-stale real-history fixtures, 6 real modules at full size) and all 8 mutations exit 0. ⚠ Scoring is strict: a case passes ONLY if a failure line carries EVERY expected substring; a silent or errored run is INCONCLUSIVE and is fixed and re-run, never counted. ⚠ LIVE END-TO-END EVIDENCE, same machinery, only the tree changed: against origin/main the 63 deployed bundles are 63/63 IN SYNC over 384 module pairs; against the pre-fix tree a54d5b54^ the same bundles are 62/63 DRIFTED over 360 pairs. A normalizer that had erased real differences could not produce the second number.`,
  })),

  // ── provider-catalog ─────────────────────────────────────────────────────
  // The section's three newest assertions — the connectors_provider_check edge
  // in BOTH directions, field-level drift, and the AMBIGUOUS_ALIASES ratchet —
  // are all silent today because production is clean. That is exactly the shape
  // this file exists to distrust.
  //
  // The original plan proved its assertions by WRITING a broken row to the live
  // catalog and restoring it. That is not available here (the write was
  // refused) and was the wrong shape anyway: an interrupted run leaves the
  // product catalog wrong for real customers. Instead these fetch the live
  // state ONCE, mutate a COPY of it in memory, and run certify's actual
  // comparison function over it — the same providerCatalogFailures() the gate
  // calls, imported, not paraphrased.
  ...(await (async () => {
    const constants = readConnectorConstants();
    const rows = await q(`select provider_key, label, category, auth_kind, credential_hint,
                                 default_base_url, implemented, aliases
                            from public.connector_providers where active`);
    const [chk] = await q(`select pg_get_constraintdef(oid) as def from pg_constraint
                            where conrelid = 'public.connectors'::regclass
                              and conname = 'connectors_provider_check'`);
    const catRows = await q(`select distinct unnest(required_connector_categories) as cat
                               from public.role_archetypes
                              where required_connector_categories is not null`);
    const [priv] = await q(`select has_table_privilege('authenticated','public.connector_providers','select') as can_read,
                                   has_table_privilege('authenticated','public.connector_providers','delete') as can_delete`);
    const base = {
      ...constants,
      rows,
      inCheck: providerCheckValues(chk?.def),
      cats: catRows.map((r) => r.cat),
      priv,
    };
    const clean = () => providerCatalogFailures(base).failures;
    // Every case mutates ONE thing against otherwise-live state, so a finding
    // can only have come from the thing that was broken.
    const withState = (patch) => () => providerCatalogFailures({ ...base, ...patch }).failures;
    const rowsWithout = (key) => rows.filter((r) => r.provider_key !== key);
    const rowsPatched = (key, patch) =>
      rows.map((r) => (r.provider_key === key ? { ...r, ...patch } : r));

    return [
      {
        // Direction A. `dreamteam` is the exempt key; xero is not. Dropping
        // xero from the catalog must be caught BY THE CHECK ARM, proving the
        // exemption is one name and not a category anything can slip into.
        name: 'provider-catalog (a CHECK value missing from the catalog fires — the dreamteam exemption is ONE key)',
        firesJs: withState({ rows: rowsWithout('xero') }),
        silentJs: clean,
      },
      {
        // Direction B, and the one that matters most: the catalog offering a
        // provider connectors.provider would refuse is a runtime INSERT
        // failure the UI cannot see coming.
        name: 'provider-catalog (a catalog row the CHECK would REJECT fires)',
        firesJs: withState({
          rows: [...rows, {
            provider_key: 'zz_not_in_the_check', label: 'ZZ', category: 'other',
            auth_kind: 'basic', credential_hint: null, default_base_url: null,
            implemented: false, aliases: [],
          }],
        }),
        silentJs: clean,
      },
      {
        // The exemption's own ratchet: if dreamteam ever leaves the CHECK, the
        // entry is stale and must go. Without this the exemption would outlive
        // its reason and quietly bless a key nobody uses.
        name: 'provider-catalog (a stale dreamteam exemption is itself a violation)',
        firesJs: withState({ inCheck: new Set([...base.inCheck].filter((k) => k !== 'dreamteam')) }),
        silentJs: clean,
      },
      {
        // Finding 3. auth_kind decides whether the interview tells a customer
        // "sign in" or "paste a key" — xero is oauth, so basic is a real lie.
        name: 'provider-catalog (field-level drift on auth_kind fires)',
        firesJs: withState({ rows: rowsPatched('xero', { auth_kind: 'basic' }) }),
        silentJs: clean,
      },
      {
        // ...and credential_hint, the literal instruction shown to a customer.
        name: 'provider-catalog (field-level drift on credential_hint fires)',
        firesJs: withState({ rows: rowsPatched('zendesk', { credential_hint: 'ask someone' }) }),
        silentJs: clean,
      },
      {
        // A derived alias silently absent is how the seed and PROVIDERS part
        // company without either list changing length.
        name: 'provider-catalog (a missing DERIVED alias fires)',
        firesJs: withState({ rows: rowsPatched('zendesk', { aliases: [] }) }),
        silentJs: clean,
      },
      {
        // mig 729's ratchet. Re-adding "close" is precisely what a regenerated
        // seed would do if AMBIGUOUS_ALIASES were dropped, and it is what made
        // "we close deals on monday" resolve to four systems at 'exact'.
        name: 'provider-catalog (an ordinary-English alias back in the data fires)',
        firesJs: withState({ rows: rowsPatched('close', { aliases: ['close'] }) }),
        silentJs: clean,
      },
      {
        // The pairing rule applied to the stop-list itself: emptying
        // AMBIGUOUS_ALIASES must not be a way to make the run green. It cannot
        // be — the aliases are gone from the DATA — but the derived-alias arm
        // then demands them back, so the two halves hold each other.
        name: 'provider-catalog (emptying AMBIGUOUS_ALIASES does not buy silence)',
        firesJs: withState({ AMBIGUOUS_ALIASES: [] }),
        silentJs: clean,
      },
    ];
  })()),
  // ── discovery-spine ──────────────────────────────────────────────────────
  // The spine (14 well-formed dimensions) and the coverage ledger (0 sessions
  // — the interview engine has not been used in production yet, per
  // task-3-report.md) are both clean today, so every assertion below is
  // silent against real state. These fetch the live state ONCE and run
  // certify's actual discoverySpineFailures() over a mutated COPY of it — the
  // same function the gate calls, imported, not paraphrased. No table is
  // ever written; every violation is SYNTHESISED in memory.
  ...(await (async () => {
    const dims = await q(`select key, ordinal, title, guidance, serves_archetypes, produces, active
                            from public.discovery_dimensions`);
    const archetypeRows = await q(`select key from public.role_archetypes`);
    const sessions = await q(`select id, coverage from public.discovery_sessions`);
    const [privRow] = await q(`select
        has_table_privilege('authenticated','public.discovery_dimensions','select') as dim_select_authenticated,
        has_table_privilege('authenticated','public.discovery_dimensions','insert') as dim_insert_authenticated,
        has_table_privilege('authenticated','public.discovery_dimensions','update') as dim_update_authenticated,
        has_table_privilege('authenticated','public.discovery_dimensions','delete') as dim_delete_authenticated,
        has_table_privilege('authenticated','public.discovery_capability_demand','select') as demand_select_authenticated,
        has_table_privilege('anon','public.discovery_capability_demand','select') as demand_select_anon,
        has_table_privilege('authenticated','public.discovery_sessions','update') as session_update_authenticated,
        has_function_privilege('authenticated','public.end_discovery_session(uuid, uuid, text, text)','execute') as end_session_authenticated,
        has_function_privilege('service_role','public.end_discovery_session(uuid, uuid, text, text)','execute') as end_session_service_role`);

    const base = {
      dims,
      archetypeKeys: new Set(archetypeRows.map((r) => r.key)),
      sessions,
      priv: {
        dimSelectAuthenticated: privRow?.dim_select_authenticated,
        dimInsertAuthenticated: privRow?.dim_insert_authenticated,
        dimUpdateAuthenticated: privRow?.dim_update_authenticated,
        dimDeleteAuthenticated: privRow?.dim_delete_authenticated,
        demandSelectAuthenticated: privRow?.demand_select_authenticated,
        demandSelectAnon: privRow?.demand_select_anon,
        sessionUpdateAuthenticated: privRow?.session_update_authenticated,
        endSessionAuthenticated: privRow?.end_session_authenticated,
        endSessionServiceRole: privRow?.end_session_service_role,
      },
    };
    const clean = () => discoverySpineFailures(base).failures;
    // Every case mutates ONE thing against otherwise-live state, so a finding
    // can only have come from the thing that was broken.
    const withState = (patch) => () => discoverySpineFailures({ ...base, ...patch }).failures;
    const activeKey = dims.find((d) => d.active)?.key;
    const otherActiveKey = dims.find((d) => d.active && d.key !== activeKey)?.key;
    if (!activeKey || !otherActiveKey) {
      throw new Error('discovery-spine mutation fixtures need at least 2 active dimensions in production to mutate — found fewer');
    }
    const dimsPatched = (key, patch) =>
      dims.map((d) => (d.key === key ? { ...d, ...patch } : d));

    return [
      {
        // A dimension pointing at a NON-planned archetype that does not
        // exist. planned_ is the ONE deliberate exemption (migration 734's
        // founder ruling A) — anything else pointing at nothing must fire.
        name: 'discovery-spine (a dimension naming a non-existent, non-planned archetype fires)',
        firesJs: withState({
          dims: dimsPatched(activeKey, { serves_archetypes: ['__no_such_archetype__'] }),
        }),
        silentJs: clean,
      },
      {
        // Thin guidance. < 120 chars is too short to tell a model when a
        // dimension is actually heard versus still vague.
        name: 'discovery-spine (guidance thinner than 120 chars fires)',
        firesJs: withState({
          dims: dimsPatched(activeKey, { guidance: 'too short' }),
        }),
        silentJs: clean,
      },
      {
        // THE CLOSURE BAR, deleted from a guidance string while the string
        // stays long enough to clear the >= 120 check. This is the exact
        // edit that used to pass certify green AND the sidetrack suite
        // green: 200 characters of plausible, undecidable prose replacing
        // the one clause that tells a model a dimension is not covered by a
        // customer who never addressed it. The only other place this clause
        // was asserted (tests/discovery-spine.test.ts:176) sits inside an
        // adminTokenAvailable() describe.skip, so on a machine with no token
        // it reported as skipped rather than failed.
        name: 'discovery-spine (a guidance string that loses "silence is not coverage" fires, even at full length)',
        firesJs: withState({
          dims: dimsPatched(activeKey, {
            guidance: 'Ask the customer about this area of the business and listen carefully to what they say. '
              + 'Capture whatever detail they offer, in their own words, and move on when the conversation '
              + 'feels like it has run its natural course for this topic.',
          }),
        }),
        silentJs: clean,
      },
      {
        // Duplicate ordinal. Two dimensions cannot occupy the same interview
        // slot — this is exactly the collision migration 734's DROP/re-ADD of
        // the UNIQUE constraint exists to make loud rather than silent.
        name: 'discovery-spine (a duplicate ordinal fires)',
        firesJs: withState({
          dims: dimsPatched(otherActiveKey, { ordinal: dims.find((d) => d.key === activeKey).ordinal }),
        }),
        silentJs: clean,
      },
      {
        // A coverage value outside the four states. Synthesised and APPENDED
        // to the real (today: empty) sessions array — never written to
        // discovery_sessions, exactly the "synthesise, never write" contract
        // this file's own header describes.
        name: 'discovery-spine (a session coverage state outside {heard,parked,skipped,not_heard} fires)',
        firesJs: withState({
          sessions: [...sessions, { id: '__probe_session__', coverage: { what_we_do: { state: 'maybe_later' } } }],
        }),
        silentJs: clean,
      },
      {
        // A coverage state of the wrong TYPE (a number, not a string) —
        // migration 738's own headline fix: jsonb_path_exists treated a
        // mismatched JSON type as "unknown", which a `?()` filter excludes
        // exactly like "false" does, so {"state":42} silently passed the
        // FIRST version of the Postgres constraint. Proves this JS mirror
        // does not repeat that exact hole.
        name: 'discovery-spine (a NUMERIC coverage state fires — the exact type hole migration 738 closed)',
        firesJs: withState({
          sessions: [...sessions, { id: '__probe_session_2__', coverage: { what_we_do: { state: 42 } } }],
        }),
        silentJs: clean,
      },
      {
        // Zero dimensions fetched. discovery_dimensions is seeded, standing
        // product data — an empty fetch can only mean the query broke, the
        // table emptied, or the grant that lets this section read it is
        // gone. This is the literal "zero examined must itself be a
        // violation" case the task-4 brief names by name.
        name: 'discovery-spine (zero discovery_dimensions rows examined fires)',
        firesJs: withState({ dims: [] }),
        silentJs: clean,
      },
      {
        // authenticated gaining a write grant on the spine. The spine is
        // read-only from the browser by design (migration 733) — a write
        // grant would let a tenant session edit the platform's own interview
        // definition.
        name: 'discovery-spine (authenticated gaining INSERT on discovery_dimensions fires)',
        firesJs: withState({ priv: { ...base.priv, dimInsertAuthenticated: true } }),
        silentJs: clean,
      },
      {
        // The other two write verbs, so every branch of the "cannot write it"
        // assertion is proven, not just INSERT.
        name: 'discovery-spine (authenticated gaining UPDATE on discovery_dimensions fires)',
        firesJs: withState({ priv: { ...base.priv, dimUpdateAuthenticated: true } }),
        silentJs: clean,
      },
      {
        name: 'discovery-spine (authenticated gaining DELETE on discovery_dimensions fires)',
        firesJs: withState({ priv: { ...base.priv, dimDeleteAuthenticated: true } }),
        silentJs: clean,
      },
      {
        // The read half of "authenticated can SELECT ... and cannot write
        // it" — losing SELECT must fire too, not just gaining a write.
        name: 'discovery-spine (authenticated LOSING SELECT on discovery_dimensions fires — the interview UI could not read the spine)',
        firesJs: withState({ priv: { ...base.priv, dimSelectAuthenticated: false } }),
        silentJs: clean,
      },
      {
        // discovery_capability_demand aggregates DEMAND ACROSS EVERY TENANT
        // by design (migration 737) — it must never be reachable by an
        // ordinary tenant-scoped session, in either direction.
        name: 'discovery-spine (authenticated gaining SELECT on discovery_capability_demand fires — cross-tenant aggregate)',
        firesJs: withState({ priv: { ...base.priv, demandSelectAuthenticated: true } }),
        silentJs: clean,
      },
      {
        name: 'discovery-spine (anon gaining SELECT on discovery_capability_demand fires — cross-tenant aggregate)',
        firesJs: withState({ priv: { ...base.priv, demandSelectAnon: true } }),
        silentJs: clean,
      },
      {
        // The interview's own ledger, writable from the browser. This is the
        // worst grant on this table: `authenticated` with UPDATE could set
        // every dimension to 'heard' directly, without a model, a transcript
        // or a word from the customer — the founder's requirement defeated
        // one level below the gate that enforces it.
        name: 'discovery-spine (authenticated gaining UPDATE on discovery_sessions fires — the coverage ledger must not be browser-writable)',
        firesJs: withState({ priv: { ...base.priv, sessionUpdateAuthenticated: true } }),
        silentJs: clean,
      },
      {
        // end_discovery_session (migration 739) is the ONLY path out of
        // 'running'. Reachable from the browser, it would let a tenant end
        // its own interview from outside the engine, skipping the honest gap
        // report the edge function returns with it.
        name: 'discovery-spine (authenticated gaining EXECUTE on end_discovery_session fires)',
        firesJs: withState({ priv: { ...base.priv, endSessionAuthenticated: true } }),
        silentJs: clean,
      },
      {
        // The other direction, and the one that actually broke before 739
        // existed: with no service_role EXECUTE there is NO caller-stops
        // path, so any interview that parks a dimension is owed something
        // forever and `done` can never go true. A perimeter check that only
        // ever tests the too-permissive direction cannot see that.
        name: 'discovery-spine (service_role LOSING EXECUTE on end_discovery_session fires — no caller-stops path)',
        firesJs: withState({ priv: { ...base.priv, endSessionServiceRole: false } }),
        silentJs: clean,
      },
      {
        // "non-empty produces" — the other half of the guidance/produces
        // assertion. Not named in the task-4 brief's 4-fixture minimum, but
        // this repo's own rule applies to every assertion equally: if the
        // data that turns it red cannot be named AND fired, it is theatre.
        name: 'discovery-spine (an empty produces array fires)',
        firesJs: withState({ dims: dimsPatched(activeKey, { produces: [] }) }),
        silentJs: clean,
      },
    ];
  })()),
  // ── discovery-proposal-decisions ─────────────────────────────────────────
  // Task 5 of the 2026-08-13 discovery-proposals-and-creation plan.
  //
  // ⚠⚠ THIS BLOCK IS THE ONLY EVIDENCE THE SECTION CAN FAIL AT ALL.
  // public.discovery_proposals holds ZERO rows — measured, not assumed, and
  // corroborated by 0 discovery_sessions and 0 audit_events carrying
  // detail->>'kind' = 'discovery_proposal_decision', because in this repo zero
  // rows is never on its own evidence that a feature never ran. Four of the
  // section's assertions are per-ROW assertions, so against real state they
  // compare nothing and return nothing, which renders identically to a clean
  // result. That is the shape this whole file exists to distrust, and it has
  // shipped nine times in five days here.
  //
  // Every case below fetches live state ONCE and mutates a COPY in memory. No
  // proposal is ever decided, no employee is ever created, no dangling uuid is
  // ever written. Four families are worth reading before the rest:
  //
  //   · the two EXEMPTION cases. "adding conversation_type to KIND_ROUTES"
  //     performs the naive edit someone would make to silence a red and shows
  //     it goes red anyway on LIVE to_regclass evidence. "pointing a kind at a
  //     LIVE BUT WRONG table" performs the edit that used to WORK — every arm
  //     was derived from the same map entry, so naming any live table made
  //     them all agree. An un-gameability claim that lives only in a comment
  //     is not a claim.
  //   · the RESOLVER cases, now four directions per kind. The
  //     dangling-created_object_id assertion is only as strong as a SQL
  //     expression: a resolver that answered "yes" to every uuid, or that had
  //     no tenant predicate, or that had lost its is_workforce_assistant
  //     exclusion, would be incapable of firing while every row fixture still
  //     passed. Those cases prove the section notices.
  //   · the I7 cases. An accepted connector the customer later DELETES must
  //     not turn certify permanently red, and a uuid that was NEVER created
  //     must still turn it red. Both directions are pinned, plus the audit
  //     perimeter the distinction rests on.
  //   · the LIVE BASELINE case, which is why the fixtures below are hermetic
  //     on `proposals`/`deciders` without that being a way of not looking.
  ...(await (async () => {
    const proposals = await q(proposalsSql());
    const controls = await q(`select * from (${resolverControlSql()}) _c order by kind, arm`);
    const routeTables = await q(routeTablesSql());
    const constraintDefs = await q(constraintDefsSql());
    const kindChk = constraintDefs.find((c) => c.conname === 'discovery_proposals_kind_check');
    const stateChk = constraintDefs.find((c) => c.conname === 'discovery_proposals_state_check');
    const deciders = await q(deciderSql());
    const [privRow] = await q(privSql());
    // The live half of the exclusion check. Fetched, not synthesised, for the
    // same reason `controls` is: the cases below need to perform the real
    // two-line exemption edit and watch PRODUCTION refuse it, and a hardcoded
    // probe row would just be a third literal moving with the other two.
    const anchorProbes = await q(`select * from (${exclusionAnchorSql()}) _a order by kind`);
    // Asked of production, not hardcoded: the exemption case below rests on
    // conversation_type having no table, and if one is ever created (the
    // follow-up task makes topics real) this fixture must stop claiming that
    // as its reason. `wrongTableLive` is the other half of the same idea — the
    // live-but-WRONG-table case is only an honest fixture while the table it
    // names actually exists.
    const [ct] = await q(`select to_regclass('public.conversation_types') is not null as table_live,
                                 to_regclass('public.de_conversations')  is not null as wrong_table_live`);

    const kindsInCheck = kindCheckValues(kindChk?.def);
    const statesInCheck = kindCheckValues(stateChk?.def);
    const livePriv = mapPriv(privRow);

    // The decision RPC as migration 741 will create it.
    const goodDecider = {
      sig: 'decide_discovery_proposal(uuid,text,text,uuid)',
      authenticated: true, service_role: false, anon: false, pub: false, secdef: true,
    };

    // ⚠⚠ THE BASELINE IS PINNED ON THE TWO DIMENSIONS EVERY CASE SHARES, and
    // this is a defect fix, not a style choice. `proposals` and `deciders` are
    // LIVE state that every helper in this block used to inherit:
    //
    //   · one violating proposal row ANYWHERE in production made `silent !== 0`
    //     for every case in this block at once — the whole block would report "these
    //     assertions cannot be proven to fire" at the exact moment they were
    //     firing correctly, which is the most misleading output this file can
    //     produce;
    //   · `deciders` is [] today only because 741 is unapplied. One case's
    //     firesJs DEPENDED on that emptiness ("terminal rows with NO
    //     decide_discovery_proposal installed"), so the moment the orchestrator
    //     applied 741 that case's state would have become identical to the
    //     silent baseline and it would have failed under a name that reads
    //     "the gate broke" when nothing had.
    //
    // So the fixtures are hermetic on those two, and every case that means
    // something about them says so explicitly. The live values are NOT
    // discarded: the LIVE BASELINE case below feeds them to the real function
    // untouched and requires zero findings, so a dirty production state fails
    // ONE case, by name, instead of collapsing the block.
    const base = {
      proposals: [],
      deciders: [goodDecider],
      controls,
      routeTables,
      anchorProbes,
      kindsInCheck,
      statesInCheck,
      priv: livePriv,
    };
    const liveState = { ...base, proposals, deciders };
    const clean = () => discoveryProposalFailures(base).failures;
    // Every case mutates ONE thing against otherwise-live state, so a finding
    // can only have come from the thing that was broken.
    const withState = (patch) => () => discoveryProposalFailures({ ...base, ...patch }).failures;

    // The shape of a proposal that is RIGHT, so that the row cases below can
    // be paired against it rather than against an empty table. Silent-against-
    // empty proves nothing: it is silent because there is nothing there. Every
    // row case's `silentJs` therefore appends the WELL-FORMED row and its
    // `firesJs` appends the same row with ONE field broken, which is the only
    // pairing that shows the arm reacts to the defect and not to the shape.
    const ok = (over = {}) => ({
      id: '11111111-1111-1111-1111-111111111111',
      kind: 'connector',
      state: 'accepted',
      tenant_id: '33333333-3333-3333-3333-333333333333',
      has_decided_by: true,
      has_decided_at: true,
      created_object_id: '22222222-2222-2222-2222-222222222222',
      has_last_error: false,
      attempts: 0,
      // The four the resolver and the two evidence cross-checks produce. A
      // WELL-FORMED accepted row resolves in its own tenant, exists, has the
      // audit event the governed path writes in the same transaction, and has
      // NO deletion record — because its object is still there. All four,
      // because the row arms read all four and a fixture that omitted one
      // would be firing on the omission.
      object_resolves: true,
      object_exists_anywhere: true,
      has_creation_audit: true,
      has_deletion_record: false,
      ...over,
    });
    // The row cases run against a base that HAS the decider, for a reason that
    // is not convenience: with no decider installed, ANY decided row is a
    // violation on its own ("they were decided by something other than the
    // governed path"), so a row case built on the live empty-decider state
    // would fire for that reason regardless of the field it broke — the case
    // would pass while proving nothing about its own assertion. One mutation
    // per case, always. `base` already pins it; rowBase is kept as a name so
    // the row cases read as a family.
    const rowBase = base;
    const cleanRow = () => discoveryProposalFailures(rowBase).failures;
    // ⚠ FIXTURE ROWS ONLY — never `[...proposals, ok(over)]`. See the pinning
    // note above: inheriting the live array put production state on the SILENT
    // side of every one of these pairs.
    const withRow = (over) => () =>
      discoveryProposalFailures({ ...rowBase, proposals: [ok(over)] }).failures;
    const silentWithGoodRow = () =>
      discoveryProposalFailures({ ...rowBase, proposals: [ok()] }).failures;
    const silentWithRow = (over) => () =>
      discoveryProposalFailures({ ...rowBase, proposals: [ok(over)] }).failures;

    const controlsPatched = (kind, arm, patch) =>
      controls.map((c) => (c.kind === kind && c.arm === arm ? { ...c, ...patch } : c));
    // KIND_ROUTES with ONE kind pointed at a table that is LIVE but WRONG.
    // public.de_conversations exists, carries tenant_id and holds rows, so
    // to_regclass says yes and the route arm's original single question —
    // "does the named table exist" — is fully satisfied by the edit.
    const wrongTableRoutes = {
      ...KIND_ROUTES,
      guardrail: { ...KIND_ROUTES.guardrail, table: 'de_conversations' },
    };

    return [
      {
        // Baseline for every row case: the well-formed accepted row is SILENT.
        // Without this the whole block could be a function that fires on any
        // proposal at all, and every case below would still "pass".
        name: 'discovery-proposal-decisions (a well-formed ACCEPTED row is silent, and a dangling created_object_id is not — the pairing)',
        firesJs: withRow({ object_resolves: false, object_exists_anywhere: false, has_creation_audit: false }),
        silentJs: silentWithGoodRow,
      },
      {
        // ASSERTION 4, THE ONE THIS TASK DESIGNED. `created_object_id` is a
        // uuid stored on a row: reading it back proves only that somebody
        // wrote a uuid. The trap this repo keeps paying for is treating that
        // stored marker as proof the thing exists. Same defect class as
        // bound-onboarding-items-complete-from-evidence.
        name: 'discovery-proposal-decisions (ACCEPTED with a created_object_id that resolves to no live row AND no creation audit fires — the dangling uuid)',
        firesJs: withRow({ object_resolves: false, object_exists_anywhere: false, has_creation_audit: false }),
        silentJs: cleanRow,
      },
      {
        // The divergence case: a row whose kind the RESOLVER has no arm for.
        // Distinct from "dangling" — nothing was checked at all — and it must
        // not be silently folded into a pass.
        name: 'discovery-proposal-decisions (ACCEPTED with an id the resolver has NO ROUTE to check fires — unchecked is not clean)',
        firesJs: withRow({ object_resolves: null }),
        silentJs: silentWithGoodRow,
      },
      {
        // ASSERTION 2.
        name: 'discovery-proposal-decisions (ACCEPTED with no created_object_id fires)',
        firesJs: withRow({ created_object_id: null, object_resolves: null }),
        silentJs: silentWithGoodRow,
      },
      {
        // The INVERSE of assertion 2, and the worse half: the plan's Step-1
        // test is "a declined proposal creates nothing". A row that was
        // refused and still points at an object means something was created
        // for a customer who said no.
        name: 'discovery-proposal-decisions (a DECLINED row still carrying a created_object_id fires — declining must create nothing)',
        firesJs: withRow({ state: 'declined', object_resolves: true }),
        silentJs: silentWithRow({ state: 'declined', created_object_id: null, object_resolves: null }),
      },
      {
        // ASSERTION 1, first half. Under service_role auth.uid() is null, so
        // this is the row a service_role accept would leave behind —
        // task-3-contract.md §1's fourth measured reason for the narrower grant.
        name: 'discovery-proposal-decisions (a terminal ACCEPTED row with no decided_by fires — the service_role accept leaves this)',
        firesJs: withRow({ has_decided_by: false }),
        silentJs: silentWithGoodRow,
      },
      {
        // ASSERTION 1, second half, asserted separately so the message names
        // which of the two is missing.
        name: 'discovery-proposal-decisions (a terminal ACCEPTED row with no decided_at fires)',
        firesJs: withRow({ has_decided_at: false }),
        silentJs: silentWithGoodRow,
      },
      {
        // Terminal is three states, not one. Declining and parking are
        // UNGATED by design (task-3-contract.md §6: "a rule that stops someone
        // saying no is not an authority model") — ungated is not unrecorded,
        // and these two cases are what says so.
        name: 'discovery-proposal-decisions (a DECLINED row with no decided_by fires — ungated is not unrecorded)',
        firesJs: withRow({ state: 'declined', created_object_id: null, object_resolves: null, has_decided_by: false }),
        silentJs: silentWithRow({ state: 'declined', created_object_id: null, object_resolves: null }),
      },
      {
        name: 'discovery-proposal-decisions (a PARKED row with no decided_at fires — park is the pile migration 737 measured)',
        firesJs: withRow({ state: 'parked', created_object_id: null, object_resolves: null, has_decided_at: false }),
        silentJs: silentWithRow({ state: 'parked', created_object_id: null, object_resolves: null }),
      },
      {
        // The revert-to-pending path (task-3-contract.md §3) sets state back
        // to 'pending' AND clears decided_by/decided_at. Leaving the stamp
        // makes the screen and the ledger disagree about whether a human has
        // already answered.
        name: 'discovery-proposal-decisions (a PENDING row still wearing decided_by fires — the revert path left its stamp)',
        firesJs: withRow({ state: 'pending', created_object_id: null, object_resolves: null }),
        silentJs: silentWithRow({
          state: 'pending', created_object_id: null, object_resolves: null,
          has_decided_by: false, has_decided_at: false,
        }),
      },
      {
        // §3's success arm ends `set created_object_id = …, last_error = null`.
        // An accepted row still carrying a refusal reason went through both
        // arms, or through half of one.
        name: 'discovery-proposal-decisions (an ACCEPTED row still carrying last_error fires)',
        firesJs: withRow({ has_last_error: true, attempts: 1 }),
        silentJs: silentWithGoodRow,
      },
      {
        // Plan Task 3 Step 3, the sentence this whole column set exists for:
        // "a proposal that silently fails to become a thing is the worst
        // outcome available here". A pending row whose attempt counter moved
        // and whose reason is gone is that outcome exactly.
        name: 'discovery-proposal-decisions (a PENDING row with attempts>0 and NO last_error fires — the silent failure Step 3 forbids)',
        firesJs: withRow({
          state: 'pending', created_object_id: null, object_resolves: null,
          has_decided_by: false, has_decided_at: false, attempts: 2, has_last_error: false,
        }),
        silentJs: silentWithRow({
          state: 'pending', created_object_id: null, object_resolves: null,
          has_decided_by: false, has_decided_at: false, attempts: 2, has_last_error: true,
        }),
      },
      {
        // The other direction on the same pair. They are written in one
        // statement, so a reason with no attempt behind it means one of the
        // two writes was dropped by a later edit.
        name: 'discovery-proposal-decisions (a last_error with attempts still 0 fires — the reason and the counter are one statement)',
        firesJs: withRow({
          state: 'pending', created_object_id: null, object_resolves: null,
          has_decided_by: false, has_decided_at: false, attempts: 0, has_last_error: true,
        }),
        silentJs: silentWithRow({
          state: 'pending', created_object_id: null, object_resolves: null,
          has_decided_by: false, has_decided_at: false, attempts: 1, has_last_error: true,
        }),
      },
      {
        // ASSERTION 3, and the kind it is actually about. conversation_type is
        // admitted by discovery_proposals_kind_check and IS still emitted by
        // supabase/functions/_shared/discoveryProposals.ts, so this is not a
        // hypothetical row — it is what the first real interview will produce.
        name: 'discovery-proposal-decisions (a conversation_type proposal fires — a kind no writer can route)',
        firesJs: withRow({ kind: 'conversation_type', created_object_id: null, object_resolves: null }),
        silentJs: cleanRow,
      },
      {
        // ⚠ THE UN-GAMEABILITY CASE. The cheapest way to make the case above
        // green is to add conversation_type to KIND_ROUTES. This performs that
        // exact edit and shows the section STILL goes red — because the route
        // arm asks to_regclass, and public.conversation_types does not exist.
        // The `table_live` value below is fetched from production, not
        // asserted here, so on the day Task 3c creates the table this fixture
        // changes its own answer instead of lying.
        name: 'discovery-proposal-decisions (adding conversation_type to KIND_ROUTES to buy silence is REFUSED — its table does not exist)',
        firesJs: () => discoveryProposalFailures({
          ...rowBase,
          routes: { ...KIND_ROUTES, conversation_type: { table: 'conversation_types', writer: 'none — there is none' } },
          routeTables: [...routeTables, { tbl: 'conversation_types', table_live: ct?.table_live === true }],
          // The controls are given to it too, answering correctly, so this
          // case isolates ONE arm: not "you forgot the resolver", but "the
          // table this route names does not exist". to_regclass alone refuses
          // the edit.
          // ⚠ The synthetic negative arm carries the ASKABILITY columns too
          // (a real tenant, and that tenant holding a matchable row). Without
          // them this case would fire a second time for "CONTROL NOT ASKABLE"
          // — a fixture defect, not the thing the case is named after, and
          // `fired >= 1` would have hidden it.
          controls: [...controls,
            { kind: 'conversation_type', arm: 'negative', sample_available: true, resolves: false,
              sample_tenant: '33333333-3333-3333-3333-333333333333',
              handed_tenant: '33333333-3333-3333-3333-333333333333', handed_tenant_holds_row: true },
            { kind: 'conversation_type', arm: 'positive', sample_available: false, resolves: null }],
          // No proposal row is needed and none is added: the refusal is of the
          // MAP, not of a row. The edit is dead on arrival whether or not a
          // conversation_type proposal exists.
        }).failures,
        silentJs: cleanRow,
      },
      {
        // The other direction on the same map: a route the CHECK cannot admit
        // is dead code claiming coverage.
        name: 'discovery-proposal-decisions (a routable kind the kind CHECK does not admit fires — a dead route)',
        firesJs: withState({ kindsInCheck: new Set([...kindsInCheck].filter((k) => k !== 'connector')) }),
        silentJs: clean,
      },
      {
        name: 'discovery-proposal-decisions (a route whose target table to_regclass cannot resolve fires)',
        firesJs: withState({
          routeTables: routeTables.map((r) => (r.tbl === 'connectors' ? { ...r, table_live: false } : r)),
        }),
        silentJs: clean,
      },
      {
        // Liveness on the vocabulary the routable-kind comparison is made
        // against. A parser that stops matching the constraint would leave
        // that comparison with an empty right-hand side — findings would drop
        // to zero and look like a pass.
        name: 'discovery-proposal-decisions (a kind CHECK that yields zero admitted values fires — 0 compared is not 0 findings)',
        firesJs: withState({ kindsInCheck: new Set() }),
        silentJs: clean,
      },
      {
        name: 'discovery-proposal-decisions (zero route target tables fetched fires — the route claim would be unverified)',
        firesJs: withState({ routeTables: [] }),
        silentJs: clean,
      },
      {
        // ⚠ RESOLVER, direction 1. If the resolver says a uuid that exists
        // nowhere resolves, the dangling-uuid assertion above can never fire
        // and every row fixture in this block still passes. This is the case
        // that stops that being invisible.
        name: 'discovery-proposal-decisions (a resolver that says the NIL uuid resolves fires — it could not detect a dangling id)',
        firesJs: withState({ controls: controlsPatched('connector', 'negative', { resolves: true }) }),
        silentJs: clean,
      },
      {
        // RESOLVER, direction 2: a routable kind with no arm at all. The CASE
        // falls through to `else null`, so created_object_id for that kind is
        // compared against nothing.
        name: 'discovery-proposal-decisions (a routable kind with NO resolver arm fires — null is not false)',
        firesJs: withState({ controls: controlsPatched('trust_rule', 'negative', { resolves: null }) }),
        silentJs: clean,
      },
      {
        // RESOLVER, direction 3, the one a negative-only control set cannot
        // see: a resolver joined on the wrong column answers "no" to
        // everything. It passes every negative control and would report every
        // future accepted proposal as dangling.
        name: 'discovery-proposal-decisions (a resolver blind to a row that demonstrably EXISTS fires — the positive direction)',
        firesJs: withState({ controls: controlsPatched('employee', 'positive', { resolves: false }) }),
        silentJs: clean,
      },
      {
        name: 'discovery-proposal-decisions (zero resolver controls fires — an undriven resolver is a check that cannot fail)',
        firesJs: withState({ controls: [] }),
        silentJs: clean,
      },
      {
        // Not the same as zero controls: a control set that quietly stopped
        // covering ONE kind keeps a healthy-looking count.
        name: 'discovery-proposal-decisions (a missing control for ONE routable kind fires — the count alone would still look healthy)',
        firesJs: withState({ controls: controls.filter((c) => !(c.kind === 'procedure' && c.arm === 'positive')) }),
        silentJs: clean,
      },
      {
        // ⚠ THE GRANT THAT MAKES ASSERTION 1 MEAN ANYTHING. If the browser can
        // UPDATE this table, decided_by is whatever the browser chose to write
        // and "no terminal state without decided_by" is a check on a
        // self-report. authenticated holds SELECT only today (measured).
        name: 'discovery-proposal-decisions (authenticated gaining UPDATE on discovery_proposals fires — decided_by would become a self-report)',
        firesJs: withState({ priv: { ...base.priv, tblUpdateAuthenticated: true } }),
        silentJs: clean,
      },
      {
        name: 'discovery-proposal-decisions (authenticated gaining INSERT on discovery_proposals fires)',
        firesJs: withState({ priv: { ...base.priv, tblInsertAuthenticated: true } }),
        silentJs: clean,
      },
      {
        name: 'discovery-proposal-decisions (authenticated gaining DELETE on discovery_proposals fires — a refused proposal could be erased)',
        firesJs: withState({ priv: { ...base.priv, tblDeleteAuthenticated: true } }),
        silentJs: clean,
      },
      {
        // The read half. A perimeter check that only ever tests the
        // too-permissive direction cannot see a revoke that took too much.
        name: 'discovery-proposal-decisions (authenticated LOSING SELECT on discovery_proposals fires — the decision screen would be empty)',
        firesJs: withState({ priv: { ...base.priv, tblSelectAuthenticated: false } }),
        silentJs: clean,
      },
      {
        name: 'discovery-proposal-decisions (anon gaining SELECT on discovery_proposals fires — draft employees and trust caps are not public)',
        firesJs: withState({ priv: { ...base.priv, tblSelectAnon: true } }),
        silentJs: clean,
      },
      {
        // Empty `deciders` is only innocent while NOTHING has been decided —
        // decided rows with no decider means something else decided them.
        //
        // ⚠ `deciders: []` IS THE MUTATION AND MUST BE WRITTEN OUT. It used to
        // be inherited from live state, which was empty only because 741 was
        // unapplied. The moment the orchestrator applies it, the inherited
        // value becomes the real function — identical to the pinned decider
        // the silent baseline uses — and this case's firesJs would return ZERO
        // findings and fail, under a name that reads "the gate broke" when all
        // that changed was the world. A fixture that depends on a migration
        // not having been applied yet is a fixture with an expiry date on it.
        name: 'discovery-proposal-decisions (terminal rows with NO decide_discovery_proposal installed fires — something else decided them)',
        firesJs: withState({ deciders: [], proposals: [ok()] }),
        silentJs: clean,
      },
      // ── I3: KIND_ROUTES was a per-kind exemption switch ─────────────────
      {
        // ⚠ THE OTHER EXEMPTION, and the one the conversation_type case above
        // could not see. The route arm asked ONE question — "does the named
        // table exist" — and every other arm was DERIVED FROM THE SAME MAP
        // ENTRY: routeTablesSql() asked to_regclass about the map's table, the
        // resolver was built from the map's table, and the positive control
        // sampled from the map's table. So pointing a kind at any LIVE table
        // made all of them answer correctly and the section went silent in
        // every channel it had. EXPECTED_KIND_TABLES is the second, independent
        // statement, and this is the case that proves it bites.
        //
        // The wrong table is public.de_conversations, fetched live below so
        // this fixture stops claiming "live" the day it stops being true.
        name: 'discovery-proposal-decisions (pointing a kind at a LIVE BUT WRONG table fires — to_regclass alone cannot tell a route from an exemption)',
        firesJs: () => {
          if (ct?.wrong_table_live !== true) {
            return ['fixture precondition failed: public.de_conversations does not exist, so this case cannot demonstrate a LIVE-but-wrong table. Pick another live table rather than deleting the case.'];
          }
          return discoveryProposalFailures({
            ...rowBase,
            routes: wrongTableRoutes,
            // The route table set is given the wrong table as LIVE, so this
            // case isolates the EXPECTATION arm: to_regclass is satisfied,
            // the kind CHECK is satisfied, and the section must still refuse.
            routeTables: [...routeTables, { tbl: 'de_conversations', table_live: true }],
          }).failures;
        },
        silentJs: cleanRow,
      },
      {
        // The same edit, seen from the LIVE side rather than the literal side.
        // The positive control samples from EXPECTED_KIND_TABLES
        // (guardrail_rules) and hands that id to a resolver built from
        // KIND_ROUTES (de_conversations), so production itself answers false —
        // no second literal required. This is the arm the map genuinely cannot
        // supply both sides of.
        name: 'discovery-proposal-decisions (a kind pointed at the wrong table makes its POSITIVE resolver control answer false — live evidence, not a second literal)',
        firesJs: withState({
          routes: wrongTableRoutes,
          routeTables: [...routeTables, { tbl: 'de_conversations', table_live: true }],
          controls: controlsPatched('guardrail', 'positive', { resolves: false }),
        }),
        silentJs: clean,
      },
      {
        // The other half of the same exemption: DROPPING a kind from the map.
        // A kind nobody routes has no row assertion to fail, so removing it is
        // as effective as pointing it somewhere wrong — and used to be
        // completely silent while no proposal of that kind existed.
        name: 'discovery-proposal-decisions (DROPPING a kind from KIND_ROUTES fires — a kind with no route has no row assertion left to fail)',
        firesJs: () => {
          const { trust_rule: _dropped, ...rest } = KIND_ROUTES;
          return discoveryProposalFailures({
            ...rowBase,
            routes: rest,
            controls: controls.filter((c) => c.kind !== 'trust_rule'),
          }).failures;
        },
        silentJs: cleanRow,
      },
      // ── I9: five of the ten resolver controls could not be false ─────────
      {
        // ⚠ THE TENANT PREDICATE. objectResolvesSql had none and proposalsSql
        // did not even select p.tenant_id, so a created_object_id pointing at
        // ANOTHER WORKSPACE'S connector resolved true and read as clean. This
        // is the only control arm that can see it: negative and positive both
        // answer identically with or without the predicate. Measured live
        // 2026-08-15: all five kinds answer false on this arm today.
        name: 'discovery-proposal-decisions (a resolver with NO TENANT PREDICATE fires — another workspace\'s row would read as a created object)',
        firesJs: withState({ controls: controlsPatched('connector', 'cross_tenant', { resolves: true }) }),
        silentJs: clean,
      },
      {
        name: 'discovery-proposal-decisions (a missing cross_tenant control fires — an undriven direction is an unproven predicate)',
        firesJs: withState({ controls: controls.filter((c) => !(c.kind === 'trust_rule' && c.arm === 'cross_tenant')) }),
        silentJs: clean,
      },
      {
        // ⚠ THE is_workforce_assistant EXCLUSION. The positive control used to
        // apply the SAME `extra` to the SAME table, so both sides of the
        // comparison moved together and deleting `extra` broke nothing. The
        // `excluded` arm samples a row the exclusion is supposed to REJECT
        // (drawn from EXPECTED_KIND_EXCLUSIONS, not from the map) and requires
        // the resolver to say false. Measured live: it does.
        name: 'discovery-proposal-decisions (a resolver that says a Workspace Assistant row RESOLVES fires — the exclusion asks the only question it exists for)',
        firesJs: withState({ controls: controlsPatched('employee', 'excluded', { resolves: true }) }),
        silentJs: clean,
      },
      {
        // The pure-JS half of the same pin, and the reason there are two: the
        // control arm above catches a broken predicate, this one catches a
        // DELETED one. Deleting `extra` from KIND_ROUTES is a one-word edit.
        name: 'discovery-proposal-decisions (deleting the is_workforce_assistant `extra` from KIND_ROUTES fires — the declaration is checked, not trusted)',
        firesJs: () => {
          const { extra: _gone, ...employeeWithoutExtra } = KIND_ROUTES.employee;
          return discoveryProposalFailures({
            ...rowBase,
            routes: { ...KIND_ROUTES, employee: employeeWithoutExtra },
          }).failures;
        },
        silentJs: cleanRow,
      },
      // ── I5: the TWO-LINE exemption the pair above could not see ──────────
      {
        // ⚠⚠ THE EDIT THAT USED TO BE FREE. Deleting `extra` alone goes red in
        // two arms — the case above. Deleting the DECLARATION as well went
        // completely green, and not by defeating a control: the control ceased
        // to exist. resolverControlSql() emits the `excluded` arm only when
        // EXPECTED_KIND_EXCLUSIONS names one, and the arms-required loop
        // demands that arm for the same reason, so both sides of the check
        // disappeared in one stroke and the section reported a clean result
        // over one fewer comparison. Two lines, six words, no red.
        //
        // The fixture therefore performs ALL THREE consequences of the real
        // source edit — no `extra`, no declaration, and no `excluded` control
        // row, because the SQL builder would no longer emit one. Anything less
        // would be testing a state the edit cannot actually produce.
        //
        // What refuses it is EXCLUSION_ANCHORS, answered by production: while
        // public.digital_employees still carries a boolean
        // is_workforce_assistant column, the exclusion is required in both of
        // the other two statements and the `excluded` arm must have been
        // driven. That is the third anchor the tables pair had and this pair
        // did not.
        name: 'discovery-proposal-decisions (deleting BOTH the `extra` predicate AND the EXPECTED_KIND_EXCLUSIONS key — the TWO-LINE exemption — fires against the live anchor)',
        firesJs: () => {
          const { extra: _gone, ...employeeWithoutExtra } = KIND_ROUTES.employee;
          const { employee: _alsoGone, ...exclusionsWithoutEmployee } = EXPECTED_KIND_EXCLUSIONS;
          return discoveryProposalFailures({
            ...rowBase,
            routes: { ...KIND_ROUTES, employee: employeeWithoutExtra },
            exclusions: exclusionsWithoutEmployee,
            controls: controls.filter((c) => !(c.kind === 'employee' && c.arm === 'excluded')),
          }).failures;
        },
        silentJs: cleanRow,
      },
      {
        // The THIRD line, so the honest limit stated in EXCLUSION_ANCHORS'
        // header is itself pinned: a three-line edit still buys silence, but
        // not for free — emptying the anchors is its own named red. Nothing in
        // a checker can stop the checker's author; what it can do is refuse to
        // let the last statement go quietly.
        name: 'discovery-proposal-decisions (emptying EXCLUSION_ANCHORS fires — the third line of a three-line exemption is not free either)',
        firesJs: withState({ anchors: {} }),
        silentJs: clean,
      },
      {
        // The anchor is only worth having while it is DRIVEN. Zero probe rows
        // is the shape this whole file distrusts: the declaration and the
        // implementation would once again be compared only against each other.
        name: 'discovery-proposal-decisions (zero exclusion-anchor probe rows fires — the live half of the exclusion check would not have run)',
        firesJs: withState({ anchorProbes: [] }),
        silentJs: clean,
      },
      {
        // Production disagreeing with the anchor. A stale anchor is worse than
        // no anchor: the two arms it drives would SKIP while looking exactly
        // like arms that ran.
        name: 'discovery-proposal-decisions (an exclusion anchor whose column production no longer carries fires — a stale anchor skips silently)',
        firesJs: withState({
          anchorProbes: anchorProbes.map((a) => (a.kind === 'employee' ? { ...a, column_live: false } : a)),
        }),
        silentJs: clean,
      },
      {
        // The declaration drifting off the column the anchor names. This is
        // the quiet version of the two-line edit: keep a declaration, keep an
        // `extra`, but stop them both being about is_workforce_assistant. The
        // `excluded` control samples BY THE DECLARATION, so it would keep
        // answering false for a reason that has nothing to do with assistants.
        name: 'discovery-proposal-decisions (an exclusion declaration that no longer mentions the anchored column fires — the control would sample the wrong rows)',
        firesJs: withState({ exclusions: { employee: 'coalesce(_s.is_active, false)' } }),
        silentJs: clean,
      },
      {
        // The same drift on the implementation side.
        name: 'discovery-proposal-decisions (an `extra` predicate that no longer mentions the anchored column fires — the resolver would exclude the wrong rows)',
        firesJs: withState({
          routes: { ...KIND_ROUTES, employee: { ...KIND_ROUTES.employee, extra: 'not coalesce(_o.is_active, false)' } },
        }),
        silentJs: clean,
      },
      // ── NEW-1 / NEW-2: THE CONTROLS THAT COULD NOT BE ASKED ──────────────
      // ⚠⚠ THE FIX WAVE THAT CLOSED I9 OPENED THESE TWO, IN THE SAME EDIT, ON
      // THE SAME CONJUNCT. The resolver is `_o.id = <id> and _o.tenant_id =
      // <tenant> [and <extra>]`, and any unsatisfiable conjunct forces the
      // whole thing false — so an arm that must answer FALSE is only a control
      // while every conjunct it is NOT testing can be satisfied.
      //
      //   NEW-1  the `negative` arm was handed the NIL uuid as its TENANT as
      //          well as its id. Measured live: 0 rows across all five target
      //          tables carry tenant_id = nil and no tenants row has that id,
      //          so `_o.tenant_id = <nil>` alone made it false and the id
      //          conjunct it exists to test was never reached.
      //   NEW-2  the `cross_tenant` arm took `tenants order by id limit 1` —
      //          the existence of a second WORKSPACE, not of a second
      //          workspace's ROW. A contrast tenant owning nothing in the
      //          table makes the tenant conjunct unsatisfiable for every row,
      //          so the arm answers false for the same reason the nil tenant
      //          did. It held only by accident: measured 2026-08-15 the
      //          lowest-id tenant happens to own a row in all five tables,
      //          while tenant a0000000-…-0001 owns employees and nothing else.
      //
      // MEASURED, with the real function over live state (mutants of this
      // file, one substitution each): widen the id conjunct to `(_o.id =
      // idExpr or idExpr is not null)` AND point the contrast tenant at
      // a0000000-…-0001, and the version of this checker at git HEAD returned
      // findings for `employee` ONLY — connector, guardrail, procedure and
      // trust_rule were silent about a resolver that answered TRUE for any
      // uuid in the proposal's own tenant. The repaired one returns 11.
      //
      // ⚠ ONE CLAIM IN THE REVIEW DID NOT REPRODUCE and is corrected here: the
      // id-conjunct mis-edit ALONE does not pass all four arms today — with a
      // contrast tenant that holds rows, `cross_tenant` catches it (measured:
      // 6 findings at HEAD). It takes BOTH defects to reach zero, which is why
      // both are pinned rather than one.
      {
        name: 'discovery-proposal-decisions (a NEGATIVE control handed the NIL uuid as its TENANT fires — its own tenant argument forced the false)',
        firesJs: withState({ controls: controlsPatched('connector', 'negative', { sample_tenant: NIL_UUID, handed_tenant: NIL_UUID }) }),
        silentJs: clean,
      },
      {
        // Not the same edit and not the same detector: the tenant can be a
        // real uuid and still own nothing the resolver could match — which is
        // what a hardcoded literal, or a tenant whose rows were deleted, looks
        // like. The re-test is computed from the tenant the arm REPORTS, so a
        // weakened choice changes the answer instead of moving both sides.
        name: 'discovery-proposal-decisions (a NEGATIVE control whose tenant owns NO matchable row fires — the tenant conjunct was unsatisfiable, so false was not the id\'s doing)',
        firesJs: withState({ controls: controlsPatched('guardrail', 'negative', { handed_tenant_holds_row: false }) }),
        silentJs: clean,
      },
      {
        name: 'discovery-proposal-decisions (a NEGATIVE control that does not report WHICH tenant it handed the resolver fires — an arm that cannot say what it was asked is not a control)',
        firesJs: withState({ controls: controlsPatched('procedure', 'negative', { handed_tenant: null }) }),
        silentJs: clean,
      },
      {
        // NEW-2's headline. `resolves` is left at its live `false`, so this
        // case is isolated to the vacuity and does not borrow the tenant-
        // predicate arm's finding.
        name: 'discovery-proposal-decisions (a CROSS_TENANT control whose contrast workspace holds NO row in the target table fires — the arm passed vacuously)',
        firesJs: withState({ controls: controlsPatched('connector', 'cross_tenant', { handed_tenant_holds_row: false }) }),
        silentJs: clean,
      },
      {
        // The other way to make the arm meaningless: contrast with the sample
        // row's OWN workspace. It would answer true and trip the tenant-
        // predicate arm with a message accusing the resolver — a wrong
        // diagnosis at the exact moment someone is reading for one.
        name: 'discovery-proposal-decisions (a CROSS_TENANT control whose contrast tenant IS the sample tenant fires, by name — it would otherwise accuse the resolver)',
        firesJs: () => {
          const live = controls.find((c) => c.kind === 'trust_rule' && c.arm === 'cross_tenant');
          if (!live?.sample_tenant) {
            return ['fixture precondition failed: the live trust_rule/cross_tenant control reports no sample_tenant, so "contrast equals sample" cannot be constructed. Fix the control, not this case.'];
          }
          return discoveryProposalFailures({
            ...base,
            controls: controlsPatched('trust_rule', 'cross_tenant', { handed_tenant: live.sample_tenant }),
          }).failures;
        },
        silentJs: clean,
      },
      {
        name: 'discovery-proposal-decisions (a CROSS_TENANT control that names no contrast tenant at all fires)',
        firesJs: withState({ controls: controlsPatched('employee', 'cross_tenant', { handed_tenant: null }) }),
        silentJs: clean,
      },
      // ── I6: the WIRING arm guarded one of the TWO resolvers ──────────────
      // proposalsSql() computes two columns from two different expressions:
      // `object_resolves` from the TENANT-SCOPED resolver, `object_exists_
      // anywhere` from the deliberately TENANT-BLIND one. The second is what
      // separates two findings that must never be merged — an id naming a LIVE
      // row in ANOTHER workspace is a security event and is never relieved; an
      // id naming nothing anywhere is a customer's own deletion and is printed
      // as a note. Put the tenant-scoped resolver in the blind slot and a
      // cross-tenant pointer reports exists_anywhere = false, falls out of the
      // failure arm into the note arm, and is reported GREEN. No resolver
      // control can see it: the controls drive the other expression.
      //
      // Measured against live state: at git HEAD that swap produced ZERO
      // findings. So did widening the blind resolver in place. Both now fire.
      //
      // Each case supplies all three strings so exactly ONE of the four
      // assertions can fire, and the silent side supplies the REAL three —
      // which is also what proves the override path is the same comparison.
      ...(() => {
        const SCOPED = objectResolvesSql('p.kind', 'p.created_object_id', 'p.tenant_id');
        const BLIND = objectExistsAnyTenantSql('p.kind', 'p.created_object_id');
        const SQL = proposalsSql();
        const silentWiring = () =>
          discoveryProposalFailures({ ...base, wiring: { sql: SQL, scoped: SCOPED, blind: BLIND } }).failures;
        const wire = (w) => () => discoveryProposalFailures({ ...base, wiring: w }).failures;
        // The two in-place widenings, built by substitution on the REAL text
        // so they are the edits themselves rather than descriptions of them.
        const BLIND_WIDE = BLIND.replaceAll('_x.id = p.created_object_id', '_x.id = p.created_object_id and _x.tenant_id = p.tenant_id');
        const SCOPED_BLIND = SCOPED.replaceAll(' and _o.tenant_id = p.tenant_id', '');
        const precondition = () => {
          if (!SQL.includes(SCOPED)) return 'fixture precondition failed: proposalsSql() does not embed the tenant-scoped resolver at all, so these cases cannot isolate a slot.';
          if (!SQL.includes(BLIND)) return 'fixture precondition failed: proposalsSql() does not embed the tenant-blind resolver at all.';
          if (BLIND_WIDE === BLIND) return 'fixture precondition failed: the tenant-widening substitution matched nothing, so the mutant is identical to the original and the case would prove nothing.';
          if (SCOPED_BLIND === SCOPED) return 'fixture precondition failed: the tenant-predicate removal matched nothing, so the mutant is identical to the original.';
          return null;
        };
        const guarded = (w) => () => { const p = precondition(); return p ? [p] : wire(w)(); };
        return [
          {
            // Slot 1. The assertion this block already had — and had no
            // mutation case for, which is its own version of the defect.
            name: 'discovery-proposal-decisions (proposalsSql computing object_resolves with the TENANT-BLIND resolver fires — slot 1)',
            firesJs: guarded({ sql: SQL.replace(SCOPED, BLIND), scoped: SCOPED, blind: BLIND }),
            silentJs: silentWiring,
          },
          {
            // Slot 2 — the one nothing guarded. A security event silently
            // downgraded to a customer decision.
            name: 'discovery-proposal-decisions (proposalsSql computing object_exists_anywhere with the TENANT-SCOPED resolver fires — slot 2, the cross-tenant FAILURE would become a retired NOTE)',
            firesJs: guarded({ sql: SQL.replace(BLIND, SCOPED), scoped: SCOPED, blind: BLIND }),
            silentJs: silentWiring,
          },
          {
            // Neither `includes` comparison can see this one: proposalsSql()
            // is BUILT from objectExistsAnyTenantSql, so widening it in place
            // moves both sides of both comparisons together. Only the defining
            // property is left to state.
            name: 'discovery-proposal-decisions (widening objectExistsAnyTenantSql IN PLACE with a tenant predicate fires — both wiring comparisons still pass)',
            firesJs: guarded({ sql: SQL.replace(BLIND, BLIND_WIDE), scoped: SCOPED, blind: BLIND_WIDE }),
            silentJs: silentWiring,
          },
          {
            // The mirror, for the same reason: the tenant-scoped resolver
            // losing its tenant predicate is invisible to `includes` too.
            name: 'discovery-proposal-decisions (objectResolvesSql losing its tenant predicate IN PLACE fires — the static half of the cross_tenant control)',
            firesJs: guarded({ sql: SQL.replace(SCOPED, SCOPED_BLIND), scoped: SCOPED_BLIND, blind: BLIND }),
            silentJs: silentWiring,
          },
        ];
      })(),
      // ── I7: an accepted object the customer later DELETED ────────────────
      {
        // ⚠ THE JUDGEMENT CALL, PINNED IN BOTH DIRECTIONS. `authenticated`
        // holds DELETE on connectors (measured true; false for the other four
        // target tables) and it is wired to live UI, so the first customer who
        // removes a connector they accepted would have turned certify
        // permanently red with no product-level remedy — the "tick everyone
        // learns to ignore". THIS case is the guard on the relief: with
        // neither record the dangling assertion must STILL go red. The silent
        // side is the same row with BOTH records.
        name: 'discovery-proposal-decisions (an object that is gone AND was never audited as created still fires — the relief is not a blanket amnesty)',
        firesJs: withRow({ object_resolves: false, object_exists_anywhere: false, has_creation_audit: false, has_deletion_record: false }),
        silentJs: silentWithRow({ object_resolves: false, object_exists_anywhere: false, has_creation_audit: true, has_deletion_record: true }),
      },
      {
        // ⚠⚠ THE ARM THAT COULD NOT FIRE, AND THE ONE CASE THAT PROVES IT NOW
        // CAN. This is the exact state migration 741 produces for EVERY
        // governed accept whose object is missing: `created_object_id` and the
        // audit event carrying created_object_id/created_object_table are
        // written from the SAME two variables, unconditionally, in ONE
        // transaction (741:536-549), so has_creation_audit was TRUE BY
        // CONSTRUCTION and the relief was granted by the accept restating
        // itself. Under the old predicate this fixture was SILENT — classified
        // `retired` and printed as a green note — and the demonstration was a
        // single deletion: remove 741:455-461 (the Zone-3 check that the
        // connector belongs to this workspace) and a garbage uuid landed here.
        //
        // The fires side is that garbage uuid. The silent side adds the ONE
        // thing decide_discovery_proposal cannot write: a tenant_activity_log
        // DELETE row, written by the log_tenant_activity trigger on the target
        // table, which can only exist if a row was there to delete. The pair
        // is the whole fix — the arm still relieves a genuine deletion and no
        // longer relieves a uuid that was never created.
        name: 'discovery-proposal-decisions (an object that is GONE, whose creation the accept audited, but whose deletion NOTHING independent recorded, fires — the relief cannot be granted by the accept restating itself)',
        firesJs: withRow({ object_resolves: false, object_exists_anywhere: false, has_creation_audit: true, has_deletion_record: false }),
        silentJs: silentWithRow({ object_resolves: false, object_exists_anywhere: false, has_creation_audit: true, has_deletion_record: true }),
      },
      {
        // The other half of the conjunction, so the relief is not simply
        // re-pointed at a single new field. A deletion record with NO record
        // of the governed path ever creating the thing means something was
        // deleted that this proposal cannot be shown to have made.
        name: 'discovery-proposal-decisions (a deletion record with NO creation audit is still not a relief — the retired verdict needs both records or neither)',
        firesJs: withRow({ object_resolves: false, object_exists_anywhere: false, has_creation_audit: false, has_deletion_record: true }),
        silentJs: silentWithRow({ object_resolves: false, object_exists_anywhere: false, has_creation_audit: true, has_deletion_record: true }),
      },
      {
        // The perimeter of the NEW half. A record anyone can write is not a
        // record: with INSERT on tenant_activity_log, a dangling
        // created_object_id becomes excusable by writing a row that says the
        // object was deleted. Measured 2026-08-15: authenticated holds SELECT
        // on that table and nothing else.
        name: 'discovery-proposal-decisions (authenticated gaining INSERT on tenant_activity_log fires — the deletion record the relief now rests on would become forgeable)',
        firesJs: withState({ priv: { ...livePriv, activityInsertAuthenticated: true } }),
        silentJs: clean,
      },
      {
        name: 'discovery-proposal-decisions (anon gaining INSERT on tenant_activity_log fires — the deletion record would be writable by the internet)',
        firesJs: withState({ priv: { ...livePriv, activityInsertAnon: true } }),
        silentJs: clean,
      },
      {
        // The WRITER of that record. Drop log_tenant_activity from a target
        // table and the relief becomes unreachable for that kind — every
        // genuinely-deleted object then goes red under a message about a uuid
        // that was never created, which would be false. Measured 2026-08-15:
        // all five target tables carry trg_tenant_activity_log firing ON
        // DELETE.
        name: 'discovery-proposal-decisions (a target table losing its ON DELETE activity trigger fires — the relief would silently become ungrantable)',
        firesJs: withState({
          routeTables: routeTables.map((r) => (r.tbl === 'connectors' ? { ...r, delete_logged: false } : r)),
        }),
        silentJs: clean,
      },
      {
        // The inverse, and the reason the audit event is load-bearing in BOTH
        // directions rather than being a one-way valve: an accepted row whose
        // object EXISTS but which no audit event records deciding means the
        // stamp arrived from a second path — one with its own grants, its own
        // authority model and no reconstruction record.
        name: 'discovery-proposal-decisions (an ACCEPTED row whose object resolves but which NO audit event records fires — two paths, one counted)',
        firesJs: withRow({ has_creation_audit: false }),
        silentJs: silentWithGoodRow,
      },
      {
        // Worse than dangling and never relieved: the id names a LIVE row that
        // belongs to a different workspace. 741's Zone-3 guard refuses this for
        // connector ("a created-object id is not its own authorisation"), and
        // this is the row that guard failing would leave behind.
        name: 'discovery-proposal-decisions (an ACCEPTED row pointing at ANOTHER WORKSPACE\'s live row fires, audit event or not)',
        firesJs: withRow({ object_resolves: false, object_exists_anywhere: true, has_creation_audit: true }),
        silentJs: silentWithGoodRow,
      },
      {
        // The perimeter the relief rests on. An audit event is only evidence
        // while nobody outside the governed path can write one.
        name: 'discovery-proposal-decisions (authenticated gaining INSERT on audit_events fires — the "it was created" relief would become forgeable)',
        firesJs: withState({ priv: { ...livePriv, auditInsertAuthenticated: true } }),
        silentJs: clean,
      },
      {
        name: 'discovery-proposal-decisions (anon gaining INSERT on audit_events fires — the reconstruction record would be writable by the internet)',
        firesJs: withState({ priv: { ...livePriv, auditInsertAnon: true } }),
        silentJs: clean,
      },
      // ── The STATE vocabulary, closed the way the KIND vocabulary is ──────
      {
        // TERMINAL_STATES was a JS literal compared against nothing. A future
        // `expired` state would be admitted by discovery_proposals_state_check,
        // written by something, and SKIPPED by every per-row arm here while
        // still counting in the denominator — findings would stay at zero and
        // look exactly like a clean result.
        name: 'discovery-proposal-decisions (a state the CHECK admits that this checker does not classify fires — it would be skipped by every row arm silently)',
        firesJs: withState({ statesInCheck: new Set([...statesInCheck, 'expired']) }),
        silentJs: clean,
      },
      {
        // The other direction: a classification with no state behind it means
        // the assertions keyed on it compare nothing.
        name: 'discovery-proposal-decisions (a classified state the CHECK no longer admits fires — a dead classification compares nothing)',
        firesJs: withState({ statesInCheck: new Set([...statesInCheck].filter((v) => v !== 'parked')) }),
        silentJs: clean,
      },
      {
        name: 'discovery-proposal-decisions (a state CHECK that yields zero admitted values fires — the row arms lost the vocabulary they classify against)',
        firesJs: withState({ statesInCheck: new Set() }),
        silentJs: clean,
      },
      {
        // And the row-level consequence, so the vocabulary arm is not the only
        // thing standing between a new state and total silence.
        name: 'discovery-proposal-decisions (a ROW carrying an unclassified state fires — the denominator counted it and no assertion examined it)',
        firesJs: withRow({ state: 'expired', created_object_id: null, object_resolves: null, object_exists_anywhere: null }),
        silentJs: silentWithGoodRow,
      },
      // ── The live state itself ────────────────────────────────────────────
      {
        // ⚠ THIS CASE IS WHY PINNING THE BASELINE IS NOT A CHEAT. Every case
        // above runs against a hermetic `proposals: []` / `deciders:
        // [goodDecider]` baseline so that one bad production row cannot make
        // `silent !== 0` for the whole block. That would be a fair complaint
        // if the live rows then went unexamined — so they do not: this case
        // feeds the REAL function the REAL live state, untouched, and requires
        // zero findings from it. A dirty production state fails exactly ONE
        // case, by name, instead of collapsing 40 of them under a message that
        // says the opposite of what happened.
        //
        // Its firesJs breaks the same live state one way (authenticated
        // gaining UPDATE), so the pair still proves the function reacts rather
        // than merely staying quiet over an empty table.
        name: 'discovery-proposal-decisions (the LIVE state this block mutates is itself clean — and one break in it still fires)',
        firesJs: () => discoveryProposalFailures({ ...liveState, priv: { ...livePriv, tblUpdateAuthenticated: true } }).failures,
        silentJs: () => discoveryProposalFailures(liveState).failures,
      },
      ...(() => {
        // The RPC's own grants. These synthesise the pg_proc row migration 741
        // will create, so they are provable BEFORE it lands rather than after
        // — which is the whole point of Task 5 shipping with the first kind.
        const good = goodDecider;
        const withDecider = (patch) => withState({ deciders: [{ ...good, ...patch }] });
        const silentDecider = () => discoveryProposalFailures({ ...base, deciders: [good] }).failures;
        return [
          {
            // ⚠ task-3-contract.md §1's headline refusal, and the assertion
            // that goes red if someone later "helpfully" adds the grant.
            // Under service_role auth.uid() is null, and FOUR safety
            // mechanisms then fail OPEN at once — measured, not argued:
            // instantiate_role_archetype and install_role_kit guard with
            // `auth.uid() is not null and not exists(…)`, so they SKIP their
            // authority check rather than fail it.
            name: 'discovery-proposal-decisions (service_role holding EXECUTE on decide_discovery_proposal fires — four guards fail open at once)',
            firesJs: withDecider({ service_role: true }),
            silentJs: silentDecider,
          },
          {
            name: 'discovery-proposal-decisions (authenticated LOSING EXECUTE on decide_discovery_proposal fires — nobody could decide anything)',
            firesJs: withDecider({ authenticated: false }),
            silentJs: silentDecider,
          },
          {
            name: 'discovery-proposal-decisions (anon holding EXECUTE on decide_discovery_proposal fires)',
            firesJs: withDecider({ anon: true }),
            silentJs: silentDecider,
          },
          {
            // Postgres grants EXECUTE to PUBLIC by default — migs 610/630's
            // doctrine, re-shipped twice in this repo.
            name: 'discovery-proposal-decisions (PUBLIC holding EXECUTE on decide_discovery_proposal fires — the default grant was never revoked)',
            firesJs: withDecider({ pub: true }),
            silentJs: silentDecider,
          },
          {
            // authenticated holds no UPDATE on discovery_proposals, so a
            // SECURITY INVOKER decider matches zero rows and PostgREST
            // returns success — the RLS-denied-write shape, one layer down.
            name: 'discovery-proposal-decisions (a decider that is not SECURITY DEFINER fires — it could not write the decision it was called to make)',
            firesJs: withDecider({ secdef: false }),
            silentJs: silentDecider,
          },
          {
            // A second overload is a second decision path with its own
            // grants, and PostgREST picks between them by argument shape.
            name: 'discovery-proposal-decisions (a SECOND decide_discovery_proposal overload fires — two decision paths, two grant surfaces)',
            firesJs: withState({
              deciders: [good, { ...good, sig: 'decide_discovery_proposal(uuid,text)', service_role: true }],
            }),
            silentJs: silentDecider,
          },
        ];
      })(),
    ];
  })()),
  // ── migration-files-match-ledger-checksums ───────────────────────────────
  // Production is clean here — 761 ledger rows match their committed file
  // byte for byte after line-ending normalisation — so every assertion below
  // is silent against real state. That is the same situation the OLD probe
  // was in, and the old probe's silence meant nothing at all, so nothing but
  // a fired mutation is evidence.
  //
  // Live state is fetched ONCE and every case mutates a COPY of it in memory:
  // the ledger is never written, and the mutations that need a "wrong" file
  // change the COMMITTED-CONTENT MAP, not any file on disk or in git.
  ...(await (async () => {
    const ledger = await q('select filename, checksum, provenance from public.schema_migrations');
    const { content: committed } = readCommittedMigrations('HEAD');
    const onDisk = new Set(readdirSync(MIGRATION_DIR).filter((f) => f.endsWith('.sql')));
    const base = { ledger, committed, onDisk };
    const clean = () => committedLedgerFailures(base).failures;
    const withState = (patch) => () => committedLedgerFailures({ ...base, ...patch }).failures;

    // Chosen from live state rather than hardcoded, so a renamed migration
    // makes these cases ERROR rather than quietly stop testing anything.
    const target = [...committed.keys()].sort().pop();
    const targetRow = ledger.find((r) => r.filename === target);
    if (!targetRow) {
      throw new Error(`migration-committed fixtures: ${target} is committed but absent from the ledger — `
        + 'the fixtures below cannot mutate a row that does not exist');
    }
    const ledgerPatched = (name, patch) =>
      ledger.map((r) => (r.filename === name ? { ...r, ...patch } : r));
    const committedWith = (name, text) => new Map(committed).set(name, text);
    const committedWithout = (name) => {
      const m = new Map(committed);
      m.delete(name);
      return m;
    };

    return [
      {
        // THE finding. The ledger records what ran; the commit records what is
        // recoverable. When they disagree, production is running text the
        // repository does not hold — the state migration 737 was actually in
        // on 2026-08-13, with every gate green.
        name: 'migration-committed (committed content that no longer hashes to the ledger checksum fires)',
        firesJs: withState({
          committed: committedWith(target, `${committed.get(target)}\n-- edited after it was applied\n`),
        }),
        silentJs: clean,
      },
      {
        // The SAME row, mutated the other way round: the ledger claiming a
        // checksum nothing produces. Both directions, because asserting one
        // half of a comparison is how a check ends up agreeing with itself.
        name: 'migration-committed (a ledger checksum that matches no committed content fires)',
        firesJs: withState({ ledger: ledgerPatched(target, { checksum: 'f'.repeat(64) }) }),
        silentJs: clean,
      },
      {
        // The hole, exactly. Applied, present on disk, in NO commit —
        // `npm run migrate:status` calls this APPLIED and is green, because
        // disk agrees with the ledger precisely BECAUSE the wrong thing ran.
        name: 'migration-committed (applied + on disk + in no commit fires — the state migrate:status calls APPLIED)',
        firesJs: withState({ committed: committedWithout(target) }),
        // The pairing that proves the orphan decision is a DECISION and not a
        // blanket excuse: the identical "no committed file" row is SILENT here
        // only because the file is not on disk either — an orphan, which the
        // migration-ledger section owns and is red for. Remove the disk half
        // and the case above fires. One bit apart, opposite verdicts.
        silentJs: () => committedLedgerFailures({
          ledger, committed: committedWithout(target),
          onDisk: new Set([...onDisk].filter((f) => f !== target)),
        }).failures,
      },
      {
        // The pre-existing orphans, by name, asserted to be silent HERE and
        // therefore asserted to be somebody's else's red rather than nobody's.
        // If either ever reacquires a file, the case above is what catches a
        // mismatch in it.
        name: 'migration-committed (715/717, the known ORPHANS, are silent here — owned by migration-ledger, not exempted)',
        firesJs: withState({
          onDisk: new Set([...onDisk, '715_the_definition_says_which_engine_owns_it.sql',
            '717_four_roles_get_a_procedure_and_intake.sql']),
        }),
        silentJs: clean,
      },
      {
        // The ORIGINAL assertion, kept and now reachable. It could never fire
        // in production (763 rows, zero nulls); it can fire here.
        name: 'migration-committed (a NULL ledger checksum fires — the old probe\'s only assertion, now provable)',
        firesJs: withState({ ledger: ledgerPatched(target, { checksum: null }) }),
        silentJs: clean,
      },
      {
        // ⚠ The case that keeps this gate USABLE. core.autocrlf=true: git
        // stores LF, Windows checks out CRLF, so raw-byte comparison would be
        // red on all 761 files forever — worse than the hole. A CRLF-only
        // difference must be silent while a REAL edit fires, and both halves
        // are asserted in one case so neither can be dropped.
        name: 'migration-committed (CRLF-only difference stays silent while a real edit fires — the normalisation)',
        firesJs: withState({
          committed: committedWith(target, committed.get(target).replace(/\n/g, '\r\n') + 'select 1;\n'),
        }),
        silentJs: withState({
          committed: committedWith(target, committed.get(target).replace(/\n/g, '\r\n')),
        }),
      },
      {
        // Liveness. Zero comparisons is the way this section failed for its
        // whole previous life, so an empty commit and an empty ledger each
        // have to be a FAILURE and not a reassuring zero.
        name: 'migration-committed (a commit holding no migration files fires — 0 compared is not 0 findings)',
        firesJs: withState({ committed: new Map() }),
        silentJs: clean,
      },
      {
        name: 'migration-committed (an empty ledger fires — 0 compared is not 0 findings)',
        firesJs: withState({ ledger: [] }),
        silentJs: clean,
      },
      {
        // Shape, not content: a row with no filename cannot be joined to
        // anything, and silently skipping it would shrink the denominator
        // without shrinking the reported count.
        name: 'migration-committed (a ledger row with no filename fires)',
        firesJs: withState({ ledger: [...ledger, { filename: null, checksum: 'x', provenance: 'applied_by_runner' }] }),
        silentJs: clean,
      },
      {
        // Provenance is not a pass. The 369 pre-ledger ASSUMED rows are
        // compared on exactly the same terms as the 392 the runner recorded —
        // otherwise half the ledger is decoration.
        name: 'migration-committed (drift in an ASSUMED pre-ledger row fires too — provenance buys no exemption)',
        firesJs: (() => {
          const assumed = ledger.find((r) => r.provenance === 'assumed_pre_ledger' && committed.has(r.filename));
          if (!assumed) throw new Error('migration-committed fixtures: no assumed_pre_ledger row with a committed file');
          return withState({ ledger: ledgerPatched(assumed.filename, { checksum: migrationChecksum('-- not this\n') }) });
        })(),
        silentJs: clean,
      },
    ];
  })()),

  // ══ mig 817: starter-onboarding-template-is-current-or-decided ══════════
  // Production is RED on arm 1 today (four workspaces six items behind), so
  // that one arm is the rare case here that is not silent against real state.
  // Every OTHER arm is silent against a healthy catalog, which is the shape
  // this file exists to distrust — a probe that never fires proves nothing.
  // All cases below drive the REAL probe SQL, imported, with one input
  // replaced; none of them writes.
  ...(() => {
    // The canonical list, shrunk to two items so the fixtures stay readable.
    const CANON2 = `select '[{"key":"a","label":"A"},{"key":"b","label":"B"}]'::jsonb as items`;
    // A population row. tenant_id is null so the drift arm (which re-reads
    // starter_template_state_internal per tenant) correctly skips fixtures.
    const pop = (slug, itemsJson, touched) =>
      `select '${slug}'::text as slug, '${FXT}'::uuid as tenant_id, '${slug}'::text as template_id, `
      + `'${itemsJson}'::jsonb as items, md5('${itemsJson}') as items_md5, ${touched} as touched`;
    // A tenant id that is deliberately NOT in public.tenants, so the drift
    // arm correctly skips these synthetic rows.
    const FXT = '00000000-0000-0000-0000-0000000000f1';
    const ONE_ITEM = '[{"key":"a","label":"A"}]';
    const BEHIND = pop('fx-behind', ONE_ITEM, false);
    const BEHIND_TOUCHED = pop('fx-touched', ONE_ITEM, true);
    const CURRENT = pop('fx-current', '[{"key":"a","label":"A"},{"key":"b","label":"B"}]', false);
    const noAcks = `select null::uuid as tenant_id, null::text as items_md5, null::text as canon_md5 where false`;

    // A healthy catalog of exactly what mig 817 installs. `null` deletes one.
    const BODIES = {
      starter_template_verdict: ['jsonb, jsonb, boolean', 'begin return null; end;'],
      starter_template_state_internal: ['uuid', 'begin return null; end;'],
      starter_onboarding_template_status: ['', 'begin return null; end;'],
      install_starter_onboarding_template: ['', 'begin perform starter_template_state_internal(v_tenant); end;'],
      upgrade_starter_onboarding_template: ['boolean',
        'begin if x then return template_has_local_edits; end if; raise exception the merge would have changed or dropped an item that already existed; end;'],
      acknowledge_starter_template_baseline: ['text', 'begin return null; end;'],
    };
    const catalog = (over = {}) => Object.entries({ ...BODIES, ...over })
      .filter(([, v]) => v !== null)
      .map(([k, v]) => `select '${k}'::text as fname, '${v[0]}'::text as fargs, '${v[1].replace(/'/g, "''")}'::text as body`)
      .join('\n union all ');

    // Symmetric privilege fixture: [args, anon, authenticated].
    const PRIVS = {
      starter_template_verdict: ['jsonb, jsonb, boolean', false, false],
      starter_template_state_internal: ['uuid', false, false],
      starter_onboarding_template_status: ['', false, true],
      install_starter_onboarding_template: ['', false, true],
      upgrade_starter_onboarding_template: ['boolean', false, true],
      acknowledge_starter_template_baseline: ['text', false, true],
    };
    const privs = (over = {}) => Object.entries({ ...PRIVS, ...over })
      .map(([k, v]) => `select '${k}'::text as fname, '${v[0]}'::text as fargs, ${v[1]} as anon_x, ${v[2]} as auth_x, true as svc_x`)
      .join('\n union all ');

    const clean = { templatesSql: CURRENT, canonSql: CANON2, acksSql: noAcks, catalogSql: catalog(), privSql: privs() };
    const S = (o) => 'select violation from (' + starterTemplateBaselineSql({ ...clean, ...o }) + ') z where violation is not null';

    return [
      {
        // The defect itself, in row form.
        name: 'starter-template-baseline (an unedited template short of canon fires; a matching one is silent)',
        fires: S({ templatesSql: BEHIND }),
        silent: S({}),
      },
      {
        // ⚠ THE SAFETY ASYMMETRY, both halves in one case so neither can be
        // dropped. The SAME missing item must be `outdated` on an untouched
        // row and `divergent` (a choice, left alone) on one a person has
        // written to. If this ever flips, a deliberately deleted item becomes
        // something the upgrade silently puts back.
        name: 'starter-template-baseline (an UNTOUCHED subset fires; the identical TOUCHED subset is divergent-by-choice and silent)',
        fires: S({ templatesSql: BEHIND }),
        silent: S({ templatesSql: BEHIND_TOUCHED }),
      },
      {
        // The acknowledgement clears it — and only while it still matches.
        name: 'starter-template-baseline (a LAPSED acknowledgement fires; a live one is silent)',
        fires: S({
          templatesSql: BEHIND,
          acksSql: `select '${FXT}'::uuid as tenant_id, 'stale-hash'::text as items_md5, 'stale-hash'::text as canon_md5`,
        }),
        silent: S({
          templatesSql: BEHIND,
          acksSql: `select '${FXT}'::uuid as tenant_id, md5('${ONE_ITEM}') as items_md5, `
            + `(select md5(items::text) from (${CANON2}) c) as canon_md5`,
        }),
      },
      {
        // ⚠⚠ THE ARM THAT STOPS THE WHOLE PROBE BEING THEATRE. With every
        // workspace current, arm 1 is silent whether mig 817 is installed or
        // deleted. This is the only thing that tells those two states apart.
        name: 'starter-template-baseline (deleting the upgrade path fires mechanism-missing even with every workspace current)',
        fires: S({ catalogSql: catalog({ upgrade_starter_onboarding_template: null }) }),
        silent: S({}),
      },
      {
        name: 'starter-template-baseline (deleting the classifier fires mechanism-missing)',
        fires: S({ catalogSql: catalog({ starter_template_state_internal: null }) }),
        silent: S({}),
      },
      {
        // The fix, pinned. Reverting the installer to the old blind answer is
        // invisible to every other arm here.
        name: 'starter-template-baseline (an installer that stops consulting the classifier fires — the exact pre-817 body)',
        fires: S({ catalogSql: catalog({ install_starter_onboarding_template: ['', 'begin return jsonb_build_object(template_id, v_tpl_id, already_installed, true); end;'] }) }),
        silent: S({}),
      },
      {
        // ⛔ The property that protects outsourcetel-hq's hand-edited draft.
        name: 'starter-template-baseline (an upgrade that stops refusing an EDITED template fires)',
        fires: S({ catalogSql: catalog({ upgrade_starter_onboarding_template: ['boolean', 'begin raise exception the merge would have changed or dropped an item that already existed; end;'] }) }),
        silent: S({}),
      },
      {
        name: 'starter-template-baseline (an upgrade that loses the merge guard fires)',
        fires: S({ catalogSql: catalog({ upgrade_starter_onboarding_template: ['boolean', 'begin return template_has_local_edits; end;'] }) }),
        silent: S({}),
      },
      {
        name: 'starter-template-baseline (anon holding EXECUTE fires)',
        fires: S({ privSql: privs({ install_starter_onboarding_template: ['', true, true] }) }),
        silent: S({}),
      },
      {
        // The OVER-revoke direction. A gate that only watches for new grants
        // calls a broken button green.
        name: 'starter-template-baseline (authenticated LOSING a client RPC fires too — an over-revoke is a defect)',
        fires: S({ privSql: privs({ upgrade_starter_onboarding_template: ['boolean', false, false] }) }),
        silent: S({}),
      },
      {
        // migs 662-664: a tenant-id-taking function reachable by the browser.
        name: 'starter-template-baseline (authenticated GAINING the tenant-id-taking classifier fires)',
        fires: S({ privSql: privs({ starter_template_state_internal: ['uuid', false, true] }) }),
        silent: S({}),
      },
      {
        // Liveness. Zero comparisons is how this class hides.
        name: 'starter-template-baseline (an empty population fires — 0 compared is not 0 findings)',
        fires: S({ templatesSql: `${CURRENT} limit 0` }),
        silent: S({}),
      },
      {
        name: 'starter-template-baseline (a zero-item canonical list fires — everything would trivially be current)',
        fires: S({ canonSql: `select '[]'::jsonb as items`, templatesSql: pop('fx-empty', '[]', false) }),
        silent: S({}),
      },
    ];
  })(),

  // ══ A-8: subprocessor-disclosure ════════════════════════════════════════
  // Every arm of this gate is silent against today's state — the manifest
  // matches the chain, the two configured credentials are both disclosed, the
  // page derives. That is precisely the shape this file exists to distrust.
  //
  // The brief for this work asked for the proof to be "a provider key added
  // in a rolled-back transaction". It is not done that way, for two reasons
  // worth stating rather than quietly working around. First, certify runs in
  // a separate process against the Management API, so a transaction rolled
  // back here is invisible to it — the injection would have had to COMMIT.
  // Second, committing it means setting a real provider credential in
  // production, which this session was explicitly forbidden to do and which
  // is the wrong shape regardless: an interrupted run leaves a live key
  // behind. So the equivalent injected instance is used — the REAL
  // subprocessorDisclosureFailures(), handed a copy of live state with one
  // thing changed, including a SYNTHESISED configured key. No writes.
  //
  // Every case carries `names`: the count proves an assertion fired, only the
  // text proves it fired for the reason the case is named after.
  ...(await (async () => {
    const { SUBPROCESSORS, ARMING_GROUPS } = readManifest();
    const { providers, providerToKey } = readLlmChain();
    const sources = egressSources();
    const resolvedKeyNames = readResolvedKeyNames(sources);
    const repoKeyTokens = readKeyTokens(sources);
    const cfgRows = await q(`select key from public.platform_config where secret_id is not null`);
    const tenantRows = await q(`select distinct provider_key from public.tenant_llm_credentials`);
    const [{ n: tenantCount }] = await q(`select count(*)::int as n from public.tenants`);
    const configuredSecrets = [
      ...cfgRows.map((r) => ({ key: r.key, store: 'platform_config' })),
      ...tenantRows.map((r) => ({ key: r.provider_key, store: 'tenant_llm_credentials' })),
    ];
    const pageSource = readFileSync(PAGE_SRC, 'utf8');
    const base = {
      manifest: SUBPROCESSORS, groups: ARMING_GROUPS,
      llmProviders: providers, llmProviderToKey: providerToKey,
      resolvedKeyNames, repoKeyTokens, configuredSecrets, tenantCount, pageSource,
    };
    const clean = () => subprocessorDisclosureFailures(base).failures;
    const withState = (patch) => () => subprocessorDisclosureFailures({ ...base, ...patch }).failures;
    const manifestWithout = (id) => SUBPROCESSORS.filter((e) => e.id !== id);
    const manifestPatched = (id, patch) => SUBPROCESSORS.map((e) => (e.id === id ? { ...e, ...patch } : e));

    return [
      {
        // THE finding. A provider the chain can reach that nothing discloses.
        // This is what would happen the day a fifth tier is added to llm.ts.
        name: 'subprocessor-disclosure (a model provider the CODE can reach but the manifest omits fires, by name)',
        firesJs: withState({ manifest: manifestWithout('google-gemini') }),
        names: /UNDISCLOSED MODEL PROVIDER: .*'google'/,
        silentJs: clean,
      },
      {
        // The other direction. Only checking "is anything missing" passes a
        // manifest that names every vendor on earth, and a disclosure that
        // names a processor nobody sends to is also a wrong disclosure.
        name: 'subprocessor-disclosure (a manifest tier the CODE CANNOT reach fires — over-claiming is drift too)',
        firesJs: withState({
          manifest: [...SUBPROCESSORS, {
            id: 'fx-mistral', vendor: 'FX Mistral', purpose: 'fixture', arming: 'credential',
            armedBy: ['ANTHROPIC_API_KEY'], anchor: 'supabase/functions/_shared/llm.ts', llmProvider: 'mistral',
          }],
        }),
        names: /OVER-CLAIMED MODEL PROVIDER: .*fx-mistral.*'mistral'/,
        silentJs: clean,
      },
      {
        // Liveness of the chain derivation itself. If llm.ts stops yielding
        // providers the gate must STOP, not report a clean empty chain — an
        // empty `llmProviders` would make arm A vacuously green.
        name: 'subprocessor-disclosure (an EMPTY derived chain cannot buy silence — every tier becomes over-claimed)',
        firesJs: withState({ llmProviders: [] }),
        names: /OVER-CLAIMED MODEL PROVIDER/,
        silentJs: clean,
      },
      {
        // Arm B. A new getAIKey('X_API_KEY') call site anywhere in the edge
        // functions arrives here without anyone remembering this page exists.
        name: 'subprocessor-disclosure (a credential the CODE resolves but nothing claims fires, by key name)',
        firesJs: withState({ resolvedKeyNames: new Set([...resolvedKeyNames, 'COHERE_API_KEY']) }),
        names: /UNCLAIMED CREDENTIAL: the code resolves COHERE_API_KEY/,
        silentJs: clean,
      },
      {
        // ★ Arm C — the one A-8 is actually about. A key APPEARS in the live
        // credential store for a vendor nothing has disclosed. This is the
        // "somebody pasted a key into Settings" event, injected rather than
        // performed: setting a real provider key was prohibited, and would
        // have been the wrong shape anyway.
        name: 'subprocessor-disclosure (a provider key CONFIGURED LIVE for an undisclosed vendor fires, by key and store)',
        firesJs: withState({
          configuredSecrets: [...configuredSecrets, { key: 'MISTRAL_API_KEY', store: 'platform_config' }],
        }),
        names: /CONFIGURED BUT UNDISCLOSED: MISTRAL_API_KEY is set in platform_config/,
        silentJs: clean,
      },
      {
        // Same arm, the OTHER store. tenant_llm_credentials holds zero rows
        // today, so its comparison count is legitimately 0 — and 0 examined
        // looks exactly like 0 findings. This is the only thing proving the
        // tenant half runs at all.
        name: 'subprocessor-disclosure (a TENANT-supplied credential for an undisclosed vendor fires — the 0-row store is live)',
        firesJs: withState({
          configuredSecrets: [...configuredSecrets, { key: 'XAI_API_KEY', store: 'tenant_llm_credentials' }],
        }),
        names: /CONFIGURED BUT UNDISCLOSED: XAI_API_KEY is set in tenant_llm_credentials/,
        silentJs: clean,
      },
      {
        // The exemption list is the obvious way to buy silence, so it has its
        // own ratchet: an exemption matching neither live state nor the code
        // has outlived its reason.
        name: 'subprocessor-disclosure (an exemption that matches nothing anywhere fires as STALE)',
        firesJs: withState({
          resolvedKeyNames: new Set([...resolvedKeyNames].filter((k) => k !== 'INBOUND_EMAIL_MAP')),
          repoKeyTokens: new Set([...repoKeyTokens].filter((k) => k !== 'INBOUND_EMAIL_MAP')),
        }),
        names: /STALE EXEMPTION: NON_EGRESS_CONFIG lists INBOUND_EMAIL_MAP/,
        silentJs: clean,
      },
      {
        // A disclosure citing a module nobody can open is not evidence.
        name: 'subprocessor-disclosure (an anchor pointing at a file that does not exist fires)',
        firesJs: () => subprocessorDisclosureFailures({
          ...base,
          manifest: manifestPatched('deepgram', { anchor: 'supabase/functions/no-such-function/index.ts' }),
          anchorExists: (p) => p !== 'supabase/functions/no-such-function/index.ts',
        }).failures,
        names: /entry deepgram: anchor "supabase\/functions\/no-such-function\/index\.ts" does not exist/,
        silentJs: clean,
      },
      {
        // ...and an armedBy naming a key that exists nowhere is fiction in
        // the other direction: a disclosure describing a control nobody has.
        name: 'subprocessor-disclosure (armedBy naming a key that exists nowhere in the codebase fires)',
        firesJs: withState({ manifest: manifestPatched('sentry', { armedBy: ['MADE_UP_DSN_KEY'] }) }),
        names: /entry sentry: armedBy names MADE_UP_DSN_KEY, which appears nowhere/,
        silentJs: clean,
      },
      {
        // Arm D. The regression this whole item is against: the page going
        // back to a hand-written list, which is accurate exactly until it
        // isn't.
        name: 'subprocessor-disclosure (the page hardcoding a vendor name instead of rendering the list fires)',
        firesJs: withState({
          pageSource: pageSource.replace('{s.vendor}', 'Anthropic (Claude)'),
        }),
        names: /hardcodes the vendor name "Anthropic \(Claude\)"/,
        silentJs: clean,
      },
      {
        // Deleting the iteration is the other way back to prose.
        name: 'subprocessor-disclosure (the page no longer iterating the manifest fires)',
        firesJs: withState({ pageSource: pageSource.replace(/\.map\(/g, '.forEach(') }),
        names: /no longer iterates SUBPROCESSORS/,
        silentJs: clean,
      },
      {
        // ★ The exact sentences that were on the page before this work: true
        // when written, unkeepable by a static document. The ratchet is
        // against the SHAPE, not against these words in these vendors' names.
        name: 'subprocessor-disclosure (a re-introduced live-configuration claim on the page fires)',
        firesJs: withState({
          pageSource: pageSource.replace(
            '{COUNSEL_PLACEHOLDER}',
            '{"it is the only provider currently receiving any customer content"}',
          ),
        }),
        names: /a live-configuration claim/,
        silentJs: clean,
      },
      {
        // Dropping the counsel marker would let a draft read as settled law.
        name: 'subprocessor-disclosure (dropping the counsel placeholder fires)',
        firesJs: withState({ pageSource: pageSource.replace(/COUNSEL_PLACEHOLDER/g, 'SOMETHING_ELSE') }),
        names: /no longer shows COUNSEL_PLACEHOLDER/,
        silentJs: clean,
      },
      {
        // One key, one vendor. Two entries claiming the same credential means
        // the "who receives this" answer is ambiguous in the one place it
        // must not be.
        name: 'subprocessor-disclosure (two entries claiming the same credential fires as ambiguous)',
        firesJs: withState({ manifest: manifestPatched('openai', { armedBy: ['OPENAI_API_KEY', 'DEEPGRAM_API_KEY'] }) }),
        names: /AMBIGUOUS CREDENTIAL: DEEPGRAM_API_KEY is claimed by more than one entry/,
        silentJs: clean,
      },
      {
        // An entry whose arming has no group renders NOWHERE — present in the
        // manifest, absent from the published page. The gate would otherwise
        // count it as disclosed.
        name: 'subprocessor-disclosure (an entry whose arming has no render group fires — it would appear on no page)',
        firesJs: withState({ manifest: manifestPatched('resend', { arming: 'quietly' }) }),
        names: /entry resend: arming "quietly" has no group in ARMING_GROUPS/,
        silentJs: clean,
      },
    ];
  })()),
];

// Optional substring filter, so one probe's cases can be re-run on their own
// after a change without waiting out the whole suite. ⚠ A filtered run proves
// only what it ran: the total printed below is of the SELECTED cases, and the
// line above it says so, because "N pass" over a silently narrowed set is the
// padded number this file exists to stop.
const FILTER = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? null;
const SHOW = process.argv.includes('--show');
const SELECTED = FILTER ? CASES.filter((c) => c.name.includes(FILTER)) : CASES;
if (FILTER) {
  console.log(`FILTERED to "${FILTER}": ${SELECTED.length} of ${CASES.length} case(s). NOT a full suite run.`);
  if (SELECTED.length === 0) {
    console.error('FILTER MATCHED NOTHING — a filter that selects no cases is not a pass.');
    process.exit(1);
  }
}

let pass = 0, fail = 0;
for (const c of SELECTED) {
  if (c.manual) { console.log(`  MANUAL  ${c.name}\n            ${c.manual}`); pass++; continue; }
  // Most probes ARE SQL, so `fires`/`silent` are queries. A few — the
  // provider-catalog comparison — are JavaScript over already-fetched state;
  // those supply `firesJs`/`silentJs`, thunks returning the violation list. The
  // pass condition is identical either way: the mutation must produce at least
  // one finding and the clean state must produce none.
  const firedRows = c.firesJs ? await c.firesJs() : await q(c.fires);
  const fired = firedRows.length;
  const silent = (c.silentJs ? await c.silentJs() : await q(c.silent)).length;
  // STRICT SCORING, where the case asks for it. `fired >= 1` says an
  // assertion went red; it does not say WHICH, and a gate that reds for an
  // unrelated reason scores identically to one that caught the injection.
  // A case carrying `names` is caught only when the output NAMES the thing
  // that was broken. Cases without it keep the original count-only rule, so
  // this is additive — but new cases should carry one.
  const text = firedRows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n');
  const named = c.names ? c.names.test(text) : true;
  const ok = fired >= 1 && silent === 0 && named;
  const why = fired >= 1 && silent === 0 && !named ? `, NAMED→no (wanted ${c.names})` : '';
  console.log(`  ${ok ? 'PASS' : 'FAIL'}    ${c.name}  (violation→${fired} rows, clean→${silent} rows${why})`);
  // --show prints WHAT the mutation made the gate say. A count proves a case
  // fired; only the text proves it fired for the reason the case is named
  // after, and "I saw this assertion go red" is a claim someone has to be
  // able to check. Off by default so the ordinary run stays one line per case.
  if (SHOW) {
    for (const r of firedRows) {
      console.log(`            RED: ${(typeof r === 'string' ? r : JSON.stringify(r)).replace(/\s+/g, ' ')}`);
    }
  }
  ok ? pass++ : fail++;
}
console.log(`\nmutation test${FILTER ? ` (FILTERED — ${SELECTED.length}/${CASES.length} cases)` : ''}: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
